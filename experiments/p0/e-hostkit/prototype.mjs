import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, renameSync, existsSync, realpathSync, chmodSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative, sep, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { JsonlDecoder, providerPath } from '../harness/index.mjs';

export const here = dirname(fileURLToPath(import.meta.url));
export const delay = ms => new Promise(r => setTimeout(r, ms));
export async function until(fn, ms = 10000) {
  const end = Date.now() + ms;
  do { const value = await fn(); if (value) return value; await delay(20); } while (Date.now() < end);
  throw new Error(`Deadline ${ms}ms: ${fn}`);
}
export function build(dir) {
  const helper = join(dir, 'hostkit-helper');
  const addonPath = join(dir, 'hostkit.node');
  const headers = process.env.NODE_HEADERS ?? resolve(dirname(process.execPath), '../include/node');
  for (const args of [
    ['-O2', '-Wall', '-Wextra', join(here, 'native.c'), '-o', helper],
    ['-O2', '-Wall', '-Wextra', '-DADDON', '-DNAPI_VERSION=8', '-bundle', '-undefined', 'dynamic_lookup', '-I', headers, join(here, 'native.c'), '-o', addonPath],
  ]) execFileSync('clang', args, { stdio: 'pipe' });
  return { helper, addonPath, native: createRequire(import.meta.url)(addonPath) };
}
export function loadNative(path) { return createRequire(import.meta.url)(path); }
export function requireLocalDisk(helper, path) {
  const result = JSON.parse(execFileSync(helper, ['fs', path]));
  if (result.local !== true) throw new Error('Local filesystem required');
  return result;
}
export const snapshot = native => JSON.parse(native.snapshot());
export function identity(native, pid, runId = randomUUID(), instanceId = randomUUID()) {
  const p = snapshot(native).find(p => p.pid === pid);
  if (!p) throw new Error(`Missing process ${pid}`);
  return { ...p, runId, instanceId };
}
export function isSameProcess(native, id) {
  return snapshot(native).some(p => p.pid === id.pid && p.startTime === id.startTime && p.status !== 5) ? 'alive' : 'gone';
}
export function signalIdentity(native, id, signal, group = false) {
  const p = snapshot(native).find(p => p.pid === id.pid && p.startTime === id.startTime && p.status !== 5);
  if (!p || (group && p.pgid !== id.pgid)) return false;
  try { process.kill(group ? -p.pgid : p.pid, signal); return true; }
  catch (e) { if (e.code === 'ESRCH') return false; throw e; }
}
export class ProcessTracker {
  records = new Map();
  constructor(native, root) { this.native = native; this.root = root; this.remember(root); }
  remember(p) { this.records.set(`${p.pid}:${p.startTime}`, p); }
  capture() {
    const table = snapshot(this.native);
    const rootAlive = table.some(p => p.pid === this.root.pid && p.startTime === this.root.startTime);
    const reachable = new Set(rootAlive ? [this.root.pid] : []);
    let changed;
    do {
      changed = false;
      for (const p of table) if (reachable.has(p.ppid) && !reachable.has(p.pid)) { reachable.add(p.pid); changed = true; }
    } while (changed);
    for (const p of table) if (reachable.has(p.pid)) this.remember(p);
    return table;
  }
  start(interval = 5000) { this.capture(); this.timer = setInterval(() => this.capture(), interval); this.timer.unref(); }
  pause() { clearInterval(this.timer); }
  alive() { const t = snapshot(this.native); return [...this.records.values()].filter(id => t.some(p => p.pid === id.pid && p.startTime === id.startTime && p.status !== 5)); }
  async stop(rpc, { abortTimeoutMs = 10000, graceMs = 5000, termGraceMs = 3000 } = {}) {
    this.pause(); const steps = [];
    const record = (step, ok, detail) => steps.push({ step, at: new Date().toISOString(), ok, detail });
    if (rpc) {
      try { const r = await rpc.command({ type: 'abort' }, abortTimeoutMs); record('abort', r.success); }
      catch (e) { record('abort', false, e.message); }
      rpc.child.stdin.end(); record('closeInput', true);
    } else { record('abort', false, 'RPC unavailable after crash/restart'); record('closeInput', false, 'No inherited stdin'); }
    await delay(graceMs);
    record('SIGTERM', signalIdentity(this.native, this.root, 'SIGTERM'));
    await delay(termGraceMs);
    this.capture();
    const groups = new Set();
    for (const id of this.records.values()) {
      if (id.pgid === this.root.pgid || groups.has(id.pgid)) continue;
      if (signalIdentity(this.native, id, 'SIGKILL', true)) groups.add(id.pgid);
    }
    record('SIGKILL descendants', true, [...groups]);
    let rootGroup = false;
    for (const id of this.records.values()) if (id.pgid === this.root.pgid && signalIdentity(this.native, id, 'SIGKILL', true)) { rootGroup = true; break; }
    record('SIGKILL pi group', true, rootGroup);
    await delay(150);
    return { steps, leftovers: this.alive() };
  }
}

export class BoundedDecoder {
  constructor(onRecord, maxBytes = 64 * 1024 * 1024) { this.decoder = new JsonlDecoder(onRecord); this.maxBytes = maxBytes; this.bytes = 0; }
  push(chunk) {
    let start = 0;
    for (let i = 0; i < chunk.length; i++) if (chunk[i] === 10) {
      this.bytes += i - start;
      if (this.bytes > this.maxBytes) throw new Error('Record exceeds byte limit');
      this.bytes = 0; start = i + 1;
    }
    this.bytes += chunk.length - start;
    if (this.bytes > this.maxBytes) throw new Error('Record exceeds byte limit');
    this.decoder.push(chunk);
  }
  end() { this.decoder.end(); }
}
export class RpcTransport extends EventEmitter {
  pending = new Map(); events = []; late = []; nextId = 0; queue = Promise.resolve();
  constructor(child, logPath) {
    super(); this.child = child; this.logPath = logPath;
    const fail = err => { this.failure = err; for (const p of this.pending.values()) p.reject(err); };
    const decoder = new BoundedDecoder(event => {
      this.events.push(event);
      if (logPath) appendFileSync(logPath, `${JSON.stringify(event)}\n`);
      if (event.type === 'response') { const p = this.pending.get(event.id); if (p) p.resolve(event); else this.late.push(event); }
      this.emit('record', event);
    });
    child.stdout.on('data', c => { try { decoder.push(c); } catch (e) { fail(e); } });
    child.stdout.on('end', () => { try { decoder.end(); } catch (e) { fail(e); } });
    child.stdin.on('error', fail); child.on('error', fail);
    child.stderr?.on('data', c => { this.stderr = (this.stderr ?? '') + c; });
    this.exit = new Promise(r => child.once('exit', (code, signal) => { this.exited = { code, signal }; fail(new Error(`pi exit ${code}/${signal}`)); r(this.exited); }));
  }
  send(obj) {
    const write = this.queue.then(() => new Promise((resolve, reject) => {
      if (this.failure) return reject(this.failure);
      this.child.stdin.write(`${JSON.stringify(obj)}\n`, e => e ? reject(e) : resolve());
    })); this.queue = write.catch(() => {}); return write;
  }
  command(cmd, timeout = 10000) {
    const id = `e-${++this.nextId}`;
    return new Promise((resolve, reject) => {
      const finish = (fn, v) => { clearTimeout(timer); this.pending.delete(id); fn(v); };
      const timer = setTimeout(() => finish(reject, new Error(`${cmd.type} timeout ${timeout}ms`)), timeout);
      this.pending.set(id, { resolve: v => finish(resolve, v), reject: e => finish(reject, e) });
      this.send({ ...cmd, id }).catch(e => this.pending.get(id)?.reject(e));
    });
  }
  async prompt(message) {
    const from = this.events.length;
    const response = await this.command({ type: 'prompt', message });
    if (!response.success) throw new Error(JSON.stringify(response));
    await until(() => this.events.slice(from).find(e => e.type === 'agent_settled'));
  }
}
export function piInstall() {
  const packageDir = realpathSync(process.env.PI_PACKAGE ?? '/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent');
  const pkg = JSON.parse(readFileSync(join(packageDir, 'package.json')));
  if (!/^1\.5\./.test(pkg.version)) throw new Error(`Unsupported pi ${pkg.version}`);
  return { packageDir, cliEntry: join(packageDir, pkg.bin.pi), version: pkg.version };
}
export function fixtureEnv(e, extra = {}) {
  return { PATH: process.env.PATH, LANG: 'en_US.UTF-8', TERM: 'dumb', ...extra,
    HOME: e.home, XDG_CONFIG_HOME: join(e.home, '.config'), XDG_CACHE_HOME: join(e.home, '.cache'),
    TMPDIR: join(e.root, 'tmp'), PI_CODING_AGENT_DIR: e.agentDir, PI_CODING_AGENT_SESSION_DIR: join(e.agentDir, 'sessions'),
    PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0', P0_SCRIPT_PATH: e.scriptPath, P0_REQUEST_LOG: e.requestLog };
}
export function piArgs(extra = []) { return [piInstall().cliEntry, '--mode', 'rpc', '--offline', '-ne', '-ns', '-np', '--no-themes', '-e', providerPath, ...extra]; }
export function spawnPi(e, extra = [], env = {}, options = {}) {
  const child = spawn(process.execPath, piArgs(extra), { cwd: e.cwd, env: fixtureEnv(e, env), detached: true, stdio: ['pipe', 'pipe', 'pipe'], ...options });
  return new RpcTransport(child, join(e.root, `rpc-e-${child.pid}.jsonl`));
}
export function atomicJson(path, value) {
  const tmp = `${path}.${process.pid}.next`; writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 }); renameSync(tmp, path);
}
export function sessionPaths(file, home) {
  const key = createHash('sha256').update(comparisonKey(canonicalPath(file, dirname(file), 'write', home))).digest('hex');
  const dir = join(home, '.pi', 'hostkit', 'locks'); mkdirSync(dir, { recursive: true, mode: 0o700 });
  return { lock: join(dir, `session-${key}.lock`), record: join(dir, `session-${key}.json`) };
}
export function normalizePath(input, cwd, home) {
  let p = input.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, ' ').replace(/^@/, '');
  if (p === '~' || p.startsWith('~/')) p = join(home, p.slice(2));
  else if (p.startsWith('file://')) p = fileURLToPath(p);
  return resolve(cwd, p);
}
export function canonicalPath(input, cwd, mode = 'read', home) {
  let path = normalizePath(input, cwd, home);
  if (mode === 'read') {
    const variants = [path, path.replace(/ (AM|PM)\./gi, '\u202f$1.'), path.normalize('NFD'), path.replace(/'/g, '\u2019'), path.normalize('NFD').replace(/'/g, '\u2019')];
    path = variants.find(existsSync) ?? path;
  }
  const missing = [];
  while (!existsSync(path)) { const parent = dirname(path); if (parent === path) throw new Error('No existing ancestor'); missing.unshift(path.slice(parent.length + (parent.endsWith(sep) ? 0 : 1))); path = parent; }
  return join(realpathSync.native(path), ...missing);
}
export function comparisonKey(p) { return process.platform === 'darwin' ? p.toLowerCase().normalize('NFC') : p; }
export function isWithin(root, target) { const rel = relative(comparisonKey(root), comparisonKey(target)); return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)); }
export function checkPrivate(path, directory = false) { const s = statSync(path); return s.uid === process.getuid() && (s.mode & 0o777 & ~(directory ? 0o700 : 0o600)) === 0; }
export function ensurePrivateDir(path) { mkdirSync(path, { recursive: true, mode: 0o700 }); if (statSync(path).uid !== process.getuid()) throw new Error('Wrong owner'); chmodSync(path, 0o700); }
export function writePrivateFile(path, data) { writeFileSync(path, data, { flag: 'wx', mode: 0o600 }); }
