import assert from 'node:assert/strict';
import { fork, spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioRpcTransport } from 'pi-hostkit';
import { connectHost } from '../../packages/protocol/dist/index.js';
import { piFixture, providerPath, until, containment } from './driver-helpers.mjs';
export { until };

const here = path.dirname(fileURLToPath(import.meta.url));
const productionExtension = fileURLToPath(new URL('../../packages/extension/dist/index.js', import.meta.url));
const fixtureExtension = path.join(here, 'notify-extension.ts');
const fixtureDaemon = path.join(here, 'notify-daemon.mjs');
export const spawnPrompt = 'Start the isolated notification task';
export const childResult = 'notification child completed';
const script = {
  fallback: { segments: [{ type: 'text', text: childResult }] },
  routes: [{ when: { request: 2, lastUser: spawnPrompt }, reply: { segments: [{ type: 'toolCall', name: 'agora_task', arguments: {
    action: 'spawn', title: 'Notification crash recovery', prompt: 'Return the isolated child result',
    profile: 'explore', model: 'p0-fake/scripted', thinking: 'off', isolation: 'none', notify: 'wake',
  } }] } }],
};

export async function records(file) {
  let text;
  try { text = await readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return text.split('\n').slice(0, -1).map((line) => JSON.parse(line));
}
function track(child, stderrFile) {
  let stderr = '';
  child.stderr?.on('data', (data) => { stderr += data; appendFileSync(stderrFile, data); });
  const exit = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  return { child, exit, get stderr() { return stderr; } };
}
export async function forceKill(handle) {
  assert.equal(handle.child.exitCode, null, 'The owned process must still be running before SIGKILL');
  assert.equal(handle.child.signalCode, null);
  assert.equal(handle.child.kill('SIGKILL'), true, 'SIGKILL must be delivered to the owned child PID');
  const result = await Promise.race([
    handle.exit,
    new Promise((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`SIGKILL timeout for PID ${handle.child.pid}`)), 10000);
      timer.unref();
    }),
  ]);
  assert.equal(result.signal, 'SIGKILL', `Expected force termination, got ${JSON.stringify(result)}`);
  return result;
}

export async function notificationFixture(t) {
  const base = await piFixture(script);
  const env = { ...base.env, AGORA_HOME: path.join(base.root, 'agora'), NOTIFY_TEST_ROOT: base.root };
  const children = [];
  const clients = [];
  let daemon;
  let currentPi;
  let sessionFile = base.sessionPath('principal');
  let config = { fault: null, key: null };
  let sequence = 0;
  async function control(patch) {
    config = { ...config, ...patch };
    const temporary = path.join(base.root, 'control.next');
    await writeFile(temporary, JSON.stringify(config));
    await rename(temporary, path.join(base.root, 'control.json'));
  }
  const ext = () => records(path.join(base.root, 'extension.jsonl'));
  const daemonLog = () => records(path.join(base.root, 'daemon.jsonl'));
  async function startDaemon() {
    const options = { home: env.AGORA_HOME, driverOptions: {
      home: env.AGORA_HOME, piPath: base.install.packageDir, extensionPath: productionExtension,
      env: base.env, extraExtensions: [providerPath], readyTimeoutMs: 20000, containment,
    } };
    const child = fork(fixtureDaemon, [], {
      cwd: base.cwd, env: { ...env, NOTIFY_DAEMON_OPTIONS: JSON.stringify(options) },
      execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true,
    });
    const handle = track(child, path.join(base.root, `daemon-${++sequence}.stderr.log`));
    children.push(handle);
    let next = 0;
    const pending = new Map();
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`daemon startup timed out: ${handle.stderr}`)), 25000);
      child.on('message', (message) => {
        if (message.ready) { clearTimeout(timer); resolve(message); return; }
        const request = pending.get(message.seq);
        if (!request) return;
        pending.delete(message.seq);
        clearTimeout(request.timer);
        if (message.error) request.reject(new Error(message.error)); else request.resolve(message.result);
      });
      handle.exit.then((result) => {
        clearTimeout(timer);
        reject(new Error(`daemon exited ${JSON.stringify(result)}: ${handle.stderr}`));
        for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('daemon exited')); }
        pending.clear();
      }, reject);
    });
    handle.call = (op, body = {}) => new Promise((resolve, reject) => {
      const seq = ++next;
      const timer = setTimeout(() => { pending.delete(seq); reject(new Error(`daemon fixture IPC timed out: ${op}`)); }, 15000);
      pending.set(seq, { resolve, reject, timer });
      child.send({ seq, op, body });
    });
    Object.assign(handle, await ready);
    daemon = handle;
    return handle;
  }
  async function startPi() {
    const from = (await ext()).length;
    const child = spawn(process.execPath, [base.install.cliEntry,
      '--mode', 'rpc', '--offline', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes',
      '--no-approve', '--extension', providerPath, '--extension', fixtureExtension, '--session', sessionFile,
    ], { cwd: base.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false });
    const handle = track(child, path.join(base.root, `pi-${++sequence}.stderr.log`));
    children.push(handle);
    handle.rpc = new StdioRpcTransport(child.stdin, child.stdout);
    handle.events = [];
    handle.rpc.onEvent((event) => handle.events.push(event));
    const response = await handle.rpc.send({ type: 'get_state' }, { timeoutMs: 30000 });
    assert.equal(response.success, true, `${JSON.stringify(response)}\n${handle.stderr}`);
    sessionFile = response.data.sessionFile;
    assert.equal(sessionFile, base.sessionPath('principal'), 'Restart uses the original session path');
    handle.ready = await until(async () => (await ext()).slice(from).find((entry) => entry.kind === 'ready'), 10000);
    assert.equal(handle.ready.principalEntries.length, 1, `Production principal binding failed: ${handle.stderr}`);
    currentPi = handle;
    return handle;
  }
  async function prompt(handle, message) {
    const from = handle.events.length;
    const response = await handle.rpc.send({ type: 'prompt', message });
    assert.equal(response.success, true, JSON.stringify(response));
    await until(() => handle.events.slice(from).some((event) => event.type === 'agent_end'), 20000);
    await until(async () => !(await handle.rpc.send({ type: 'get_state' })).data.isStreaming, 10000);
    return response;
  }
  t.after(async () => {
    for (const client of clients) client.close();
    for (const handle of children.toReversed()) {
      if (handle.child.exitCode === null && handle.child.signalCode === null) {
        if (handle.call) await handle.call('close').catch(() => {});
        // 不按名称终止进程；每个 fixture 只持有自己的 PID。daemon 先回收真实 child。
        if (handle.child.exitCode === null && handle.child.signalCode === null) handle.child.kill('SIGKILL');
      }
      await handle.exit;
    }
    if (!t.passed) console.error(`Notification fault fixture retained: ${base.root}`);
    // piFixture 负责恢复父进程 HOME；失败现场保留便于检查。
    const keep = process.env.KEEP_FIXTURES;
    if (!t.passed) process.env.KEEP_FIXTURES = '1';
    try { await base.cleanup(); }
    finally { if (keep === undefined) delete process.env.KEEP_FIXTURES; else process.env.KEEP_FIXTURES = keep; }
  });
  await control({});
  await startDaemon();
  return {
    ...base, env, ext, daemonLog, control, startDaemon, startPi, prompt,
    get daemon() { return daemon; }, get pi() { return currentPi; }, get sessionFile() { return sessionFile; },
    async notices(key) { return (await records(sessionFile)).filter((entry) => entry.type === 'custom_message' &&
      entry.customType === 'agora:notice' && entry.details?.dedupeKey === key); },
    async state() { return daemon.call('state'); },
    async host() { const client = await connectHost({ home: env.AGORA_HOME, as: 'host:cli', autoStart: false }); clients.push(client); return client; },
  };
}
