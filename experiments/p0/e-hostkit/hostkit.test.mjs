import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync, symlinkSync, unlinkSync, statSync, chmodSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AsyncLocalStorage } from 'node:async_hooks';
import { FixtureCleanup, createSafeFixture, withCleanup, withTracker, writeEvidence, daemonExtensionSource } from './test-cleanup.mjs';
import { here, build, requireLocalDisk, snapshot, identity, isSameProcess, signalIdentity, BoundedDecoder, RpcTransport, piInstall, fixtureEnv, piArgs, spawnPi, sessionPaths, canonicalPath, comparisonKey, isWithin, checkPrivate, ensurePrivateDir, writePrivateFile, until, delay } from './prototype.mjs';

const mac = process.platform === 'darwin';
const root = mkdtempSync(join(tmpdir(), 'e-hostkit-'));
const observations = [];
const owned = new Map();
const contexts = new AsyncLocalStorage();
const fixtures = [];
let built, failed = false;
function note(name, value) { observations.push({ name, ...value }); appendFileSync(join(root, 'observations.jsonl'), JSON.stringify({ name, ...value }) + '\n'); console.log('OBS', name, JSON.stringify(value)); }
function remember(id) { owned.set(`${id.pid}:${id.startTime}`, id); return id; }
function trackChild(child) {
  child.on('error', () => {});
  const context = contexts.getStore();
  const id = context.emergency.remember(identity(built.native, child.pid));
  context.fixture?.emergency.remember(id);
  return id;
}
function messages(child) { const list = []; child.on('message', m => list.push(m)); return state => until(() => list.find(m => m.state === state || m[state] === true)); }
function jsonFile(file) { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined; }
function jsonLines(file) { return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []; }
const quote = s => `'${s.replaceAll("'", "'\\''")}'`;
const textReply = { segments: [{ type: 'text', text: 'fake-only' }] };
const fastStop = { abortTimeoutMs: 200, graceMs: 150, termGraceMs: 150 };
async function fixture(script = { fallback: textReply }) {
  const context = contexts.getStore();
  const e = await createSafeFixture(context.t, built.native, { script }, remember);
  fixtures.push(e); context.fixtures.push(e); context.fixture = e;
  appendFileSync(join(root, 'fixtures.txt'), `${e.root}\n`);
  return e;
}
async function start(e, args = [], env = {}) {
  const rpc = spawnPi(e, args, env); trackChild(rpc.child);
  await rpc.command({ type: 'get_state' }); return rpc;
}
async function finish(rpc) {
  return withTracker(contexts.getStore().fixture, built.native, identity(built.native, rpc.child.pid), async tracker => {
    tracker.capture();
    const result = await tracker.stop(rpc, fastStop); assert.equal(result.leftovers.length, 0); return result;
  });
}
before(() => {
  console.log('E_HOSTKIT_FIXTURE', root);
  if (mac) { built = build(root); note('environment', { platform: process.platform, arch: process.arch, node: process.version, pi: piInstall().version }); }
});
after(async () => {
  if (!mac || !built) return;
  const recovery = await Promise.allSettled(fixtures.map(e => e.emergency.run()));
  const recoveryErrors = recovery.filter(r => r.status === 'rejected').map(r => String(r.reason));
  const beforeCleanup = [...owned.values()].filter(id => isSameProcess(built.native, id) === 'alive');
  for (const id of beforeCleanup) signalIdentity(built.native, id, 'SIGKILL');
  await delay(300);
  const leftovers = [...owned.values()].filter(id => isSameProcess(built.native, id) === 'alive');
  const zombies = snapshot(built.native).filter(p => p.status === 5 && owned.has(`${p.pid}:${p.startTime}`));
  writeFileSync(join(root, 'owned-identities.json'), JSON.stringify([...owned.values()], null, 2));
  note('cleanup', { recorded: owned.size, beforeCleanup: beforeCleanup.map(p => p.pid), leftovers, zombies, recoveryErrors });
  writeEvidence(root, join(here, 'evidence.jsonl'), observations, process.env.P0_RECORD === '1' && !failed && !leftovers.length && !zombies.length && !recoveryErrors.length);
  assert.equal(leftovers.length, 0);
  assert.equal(zombies.length, 0);
  assert.deepEqual(recoveryErrors, []);
});

const mt = (name, fn) => test(name, { skip: !mac }, async t => {
  // Even cases without a pi fixture own a cleanup scope before spawning anything.
  const emergency = new FixtureCleanup(built.native, mkdtempSync(join(root, 'case-')), remember);
  fixtures.push({ emergency });
  t.after(() => emergency.run());
  return contexts.run({ t, emergency, fixtures: [] }, async () => {
    try {
      return await withCleanup(() => [...contexts.getStore().fixtures.map(e => e.emergency), emergency], () => fn(t));
    } catch (error) { failed = true; throw error; }
  });
});
mt('native: helper and N-API identity, snapshot, invalid paths, local filesystem', async () => {
  const id = identity(built.native, process.pid);
  const helperId = JSON.parse(execFileSync(built.helper, ['identity', String(process.pid)]));
  assert.equal(id.startTime, helperId.startTime);
  assert.ok(JSON.parse(execFileSync(built.helper, ['snapshot'])).some(p => p.pid === process.pid));
  assert.throws(() => built.native.lock(join(root, 'missing', 'lock')));
  assert.throws(() => execFileSync(built.helper, ['lock', join(root, 'missing', 'lock')], { stdio: 'pipe' }));
  assert.throws(() => execFileSync(join(root, 'missing-helper'), []));
  assert.throws(() => { new BoundedDecoder(() => {}, 10).push(Buffer.alloc(11, 32)); });
  const fs = requireLocalDisk(built.helper, root); assert.equal(fs.local, true);
  assert.throws(() => requireLocalDisk(built.helper, join(root, 'missing-filesystem')), /Command failed/);
  const ps = execFileSync('/bin/ps', ['-p', String(process.pid), '-o', 'lstart='], { encoding: 'utf8' }).trim();
  note('native', { identity: id, psStart: ps, filesystem: fs, helperBytes: statSync(built.helper).size, addonBytes: statSync(built.addonPath).size });
});

mt('identity: mismatched creation time is gone; runId/instanceId are bookkeeping', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  const id = trackChild(child);
  const forged = { ...id, startTime: '0.000001', runId: 'old-run', instanceId: 'old-host' };
  assert.equal(isSameProcess(built.native, forged), 'gone');
  assert.equal(signalIdentity(built.native, forged, 'SIGKILL'), false);
  assert.equal(isSameProcess(built.native, id), 'alive');
  assert.equal(isSameProcess(built.native, { ...id, runId: 'different', instanceId: 'different' }), 'alive');
  signalIdentity(built.native, id, 'SIGKILL'); await until(() => isSameProcess(built.native, id) === 'gone');
  note('pid-reuse', { simulatedMismatchRejected: true, realPidReuse: 'not forced', timestampResolution: 'microsecond fields', metadataNotKernelIdentity: true });
});

for (const purpose of ['instance', 'session']) mt(`locks: ${purpose} contention and SIGKILL release (3 rounds)`, async () => {
  for (let round = 1; round <= 3; round++) {
    const path = join(root, `${purpose}-${round}.lock`);
    const workers = [0, 1].map(() => {
      const child = spawn(process.execPath, [join(here, 'worker.mjs'), 'lock', built.addonPath, '-', path], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      const id = trackChild(child); const wait = messages(child); return { child, id, wait };
    });
    await Promise.all(workers.map(w => w.wait('ready')));
    const results = workers.map(w => new Promise(resolve => w.child.once('message', resolve)));
    workers.forEach(w => w.child.send('go'));
    const values = await Promise.all(results); assert.equal(values.filter(v => v.held).length, 1);
    const winner = workers[values.findIndex(v => v.held)];
    const inode = statSync(path).ino;
    signalIdentity(built.native, winner.id, 'SIGKILL');
    const t = performance.now();
    const fd = await until(() => { const fd = built.native.lock(path); return fd < 0 ? undefined : { fd }; });
    built.native.unlock(fd.fd); assert.equal(statSync(path).ino, inode);
    note(`lock-${purpose}`, { round, winners: 1, releaseMs: +(performance.now() - t).toFixed(2), sameInode: true });
  }
});

mt('helper locks: host-pipe EOF releases; helper death releases while host lives', async () => {
  const path = join(root, 'helper.lock');
  for (const action of ['EOF', 'SIGKILL']) {
    const child = spawn(built.helper, ['lock', path], { stdio: ['pipe', 'pipe', 'pipe'] }); const id = trackChild(child);
    await new Promise(r => child.stdout.once('data', r));
    assert.equal(built.native.lock(path), -1);
    if (action === 'EOF') child.stdin.end(); else signalIdentity(built.native, id, 'SIGKILL');
    const holder = await until(() => { const fd = built.native.lock(path); return fd >= 0 ? { fd } : undefined; }); built.native.unlock(holder.fd);
    note('helper-lock-lifetime', { action, hostAlive: true, lockReleased: true });
  }
});

mt('RPC: UTF-8 boundaries, Unicode separators, CRLF, size limit and late response', async () => {
  const rows = []; const decoder = new BoundedDecoder(r => rows.push(r));
  const value = { text: '中\u2028间\u2029🙂' };
  const bytes = Buffer.from(JSON.stringify(value) + '\r\n');
  for (const byte of bytes) decoder.push(Buffer.from([byte])); decoder.end(); assert.deepEqual(rows, [value]);
  const large = Buffer.from(JSON.stringify({ x: 'a'.repeat(64 * 1024 * 1024) }) + '\n');
  assert.throws(() => new BoundedDecoder(() => {}).push(large), /limit/);
  const child = spawn(process.execPath, ['-e', `let b='';process.stdin.on('data',c=>{b+=c;let i;while((i=b.indexOf('\\n'))>=0){const x=JSON.parse(b.slice(0,i));b=b.slice(i+1);setTimeout(()=>process.stdout.write(JSON.stringify({type:'response',id:x.id,success:true})+'\\n'),x.delay)}})`], { stdio: ['pipe', 'pipe', 'pipe'] });
  trackChild(child); const rpc = new RpcTransport(child);
  await assert.rejects(rpc.command({ type: 'slow', delay: 100 }, 20), /timeout/);
  const both = await Promise.all([rpc.command({ type: 'first', delay: 60 }), rpc.command({ type: 'second', delay: 10 })]);
  assert.equal(both[0].id, 'e-2'); assert.equal(both[1].id, 'e-3'); await until(() => rpc.late.length === 1);
  child.stdin.end(); await rpc.exit;
  note('rpc', { unicodePreserved: true, over64MiBRejected: true, lateDiscarded: rpc.late.length, correlated: both.map(r => r.id) });
});

for (const scenario of ['independent', 'nohup', 'parent-exit', 'pi-SIGKILL', 'escape-between-snapshots', 'nohup-before-first-snapshot']) mt(`process: ${scenario} (3 rounds, 5s snapshots)`, async () => {
  for (let round = 1; round <= 3; round++) {
    const e = await fixture(); const oracle = join(e.root, 'oracle.jsonl'); const release = join(e.root, 'release'); const trigger = join(e.root, 'trigger');
    const worker = `${quote(process.execPath)} ${quote(join(here, 'worker.mjs'))} stubborn ${quote(built.addonPath)} ${quote(oracle)}`;
    let command = worker;
    if (scenario === 'nohup') command = `nohup ${worker} >/dev/null 2>&1 & wait`;
    if (scenario === 'nohup-before-first-snapshot') command = `nohup ${worker} >/dev/null 2>&1 & exit 0`;
    if (scenario === 'parent-exit') command = `nohup ${worker} >/dev/null 2>&1 & while [ ! -f ${quote(release)} ]; do sleep 0.05; done; exit 0`;
    if (scenario === 'escape-between-snapshots') command = `while [ ! -f ${quote(trigger)} ]; do sleep 0.05; done; ${quote(built.helper)} escape ${quote(oracle)} ${quote(release)}; sleep 1000`;
    await e.setScript({ turns: [{ segments: [{ type: 'toolCall', name: 'bash', arguments: { command } }] }], fallback: textReply });
    const rpc = await start(e, ['--tools', 'bash']); const rootId = identity(built.native, rpc.child.pid);
    await withTracker(e, built.native, rootId, async tracker => {
      tracker.start();
      await rpc.command({ type: 'prompt', message: 'run fixture command' });
      await until(() => rpc.events.find(x => x.type === 'tool_execution_start'));
      if (scenario !== 'escape-between-snapshots') await until(() => jsonLines(oracle).length);
      await delay(5150);
      if (scenario === 'parent-exit') { writeFileSync(release, 'go'); await until(() => rpc.events.find(x => x.type === 'tool_execution_end')); }
      if (scenario === 'escape-between-snapshots') { writeFileSync(trigger, 'go'); await until(() => jsonLines(oracle).length); }
      const oracleIds = jsonLines(oracle); oracleIds.forEach(id => e.emergency.remember(id));
      assert.ok(oracleIds.every(p => p.pgid !== rootId.pgid));
      for (const p of tracker.records.values()) remember(p);
      if (scenario === 'pi-SIGKILL' || scenario === 'escape-between-snapshots') { signalIdentity(built.native, rootId, 'SIGKILL'); await rpc.exit; }
      const report = await tracker.stop(rpc.exited ? undefined : rpc, fastStop);
      const actual = oracleIds.filter(id => isSameProcess(built.native, id) === 'alive');
      note(`process-${scenario}`, { round, fixture: e.root, snapshotMs: 5000, recorded: tracker.records.size, reportLeftovers: report.leftovers.length, oracleLeftovers: actual.map(x => x.pid), steps: report.steps });
      if (['escape-between-snapshots', 'nohup-before-first-snapshot'].includes(scenario)) assert.equal(actual.length, 1, 'Fault injection must demonstrate the snapshot blind window');
      else assert.equal(actual.length, 0);
      assert.equal(report.leftovers.length, 0);
      // Keep the fixture and record the observation before cleaning only oracle-owned survivors.
      for (const id of actual) signalIdentity(built.native, id, 'SIGKILL');
      await until(() => oracleIds.every(id => isSameProcess(built.native, id) === 'gone'));
    });
  }
});

for (const scenario of ['nohup', 'native-escape']) mt(`cleanup failure: ${scenario} throws before oracle registration`, async () => {
  const e = await fixture(); const oracle = join(e.root, 'oracle.jsonl');
  const command = scenario === 'nohup'
    ? `nohup ${quote(process.execPath)} ${quote(join(here, 'worker.mjs'))} stubborn ${quote(built.addonPath)} ${quote(oracle)} >/dev/null 2>&1 & exit 0`
    : `${quote(built.helper)} escape ${quote(oracle)} ${quote(join(e.root, 'release'))}`;
  await e.setScript({ turns: [{ segments: [{ type: 'toolCall', name: 'bash', arguments: { command } }] }], fallback: textReply });
  let rootId, tracker, timer, identitiesBefore;
  const injected = new Error('Injected failure before oracle registration');
  await assert.rejects(withCleanup(() => [e.emergency], async () => {
    const rpc = await start(e, ['--tools', 'bash']); rootId = identity(built.native, rpc.child.pid);
    await withTracker(e, built.native, rootId, async measured => {
      tracker = measured; tracker.start(); timer = tracker.timer;
      await rpc.command({ type: 'prompt', message: 'run cleanup fault' });
      await until(() => existsSync(oracle) && statSync(oracle).size > 0);
      await until(() => rpc.events.some(event => event.type === 'tool_execution_end'));
      // No oracle identities have been read or registered by the test at this point.
      identitiesBefore = new Set(e.emergency.identities.keys());
      throw injected;
    });
  }), error => error === injected);
  const ids = jsonLines(oracle);
  assert.equal(ids.length, 1);
  assert.notEqual(ids[0].pgid, rootId.pgid);
  assert.ok(ids.every(id => !identitiesBefore.has(`${id.pid}:${id.startTime}`)));
  assert.ok(ids.every(id => !tracker.records.has(`${id.pid}:${id.startTime}`)));
  assert.equal(timer._destroyed, true);
  const report = await e.emergency.run();
  assert.ok(ids.every(id => e.emergency.identities.has(`${id.pid}:${id.startTime}`)));
  assert.deepEqual(report.remaining, []);
  assert.ok(ids.every(id => isSameProcess(built.native, id) === 'gone'));
  note('cleanup-before-oracle', { scenario, fixture: e.root, injectedBeforeRegistration: true, independentGroup: true, trackerPaused: true, oracleIdentities: ids.length, remaining: report.remaining });
});

mt('cleanup failure: daemon throws before daemon.json and oracle registration', async () => {
  const e = await fixture(); const info = join(e.root, 'daemon.json'); const oracle = join(e.root, 'cleanup-oracle.jsonl');
  const gate = join(e.root, 'daemon-ready');
  const ext = await e.write('daemon.ts', daemonExtensionSource({ addonPath: built.addonPath, worker: join(here, 'worker.mjs'), log: join(e.root, 'heartbeat'), info, oracle }));
  let rootId, identitiesBefore;
  const injected = new Error('Injected failure before daemon ready');
  await assert.rejects(withCleanup(() => [e.emergency], async () => {
    const child = spawn(built.helper, ['pty', process.execPath, ...piArgs(['-e', ext])], { cwd: e.cwd, env: fixtureEnv(e, { E_DAEMON_READY_GATE: gate }), stdio: ['pipe', 'pipe', 'pipe'] });
    rootId = trackChild(child);
    child.stdout.resume(); child.stderr.resume();
    // The worker creates this marker only after journaling itself and its pi child.
    await until(() => existsSync(`${gate}.waiting`));
    assert.equal(existsSync(info), false);
    identitiesBefore = new Set(e.emergency.identities.keys());
    throw injected;
  }), error => error === injected);
  const ids = [...new Map(jsonLines(oracle).map(id => [`${id.pid}:${id.startTime}`, id])).values()];
  assert.equal(ids.length, 2);
  assert.ok(ids.every(id => !identitiesBefore.has(`${id.pid}:${id.startTime}`)));
  assert.ok(ids.every(id => id.pgid !== rootId.pgid));
  assert.equal(existsSync(info), false);
  const report = await e.emergency.run();
  assert.ok(ids.every(id => e.emergency.identities.has(`${id.pid}:${id.startTime}`)));
  assert.deepEqual(report.remaining, []);
  assert.ok(ids.every(id => isSameProcess(built.native, id) === 'gone'));
  note('cleanup-before-daemon-ready', { fixture: e.root, injectedBeforeRegistration: true, daemonInfoAbsent: true, independentGroup: true, oracleIdentities: ids.length, remaining: report.remaining });
});

mt('process: unresponsive abort times out, then stdin/TERM/KILL sequence completes', async () => {
  const e = await fixture({ fallback: { ignoreAbort: true, segments: [{ type: 'hang' }] } });
  const rpc = await start(e); await rpc.command({ type: 'prompt', message: 'hang' }); await e.waitForProvider(r => r.kind === 'hang');
  const report = await finish(rpc);
  assert.match(report.steps[0].detail, /timeout/); assert.deepEqual(report.steps.map(s => s.step), ['abort', 'closeInput', 'SIGTERM', 'SIGKILL descendants', 'SIGKILL pi group']);
  note('abort-timeout', report);
});

mt('session lock timing: preallocated path, cancel, new/fork/clone shutdown targets', async () => {
  const e = await fixture(); const file = join(e.cwd, 'preallocated.jsonl'); const log = join(e.root, 'hooks.jsonl');
  const ext = await e.write('hooks.ts', `import {appendFileSync,existsSync} from 'node:fs';\nexport default function(pi){ for(const name of ['session_before_switch','session_before_fork','session_shutdown','session_start']) pi.on(name,(event,ctx)=>{appendFileSync(${JSON.stringify(log)},JSON.stringify({event,file:ctx.sessionManager.getSessionFile(),exists:event.targetSessionFile?existsSync(event.targetSessionFile):null})+'\\n');if(name==='session_before_switch'&&event.reason==='resume')return {cancel:true};}); }`);
  const paths = sessionPaths(file, e.home); const fd = built.native.lock(paths.lock); assert.ok(fd >= 0);
  const rpc = await start(e, ['--session', file, '-e', ext]);
  assert.equal((await rpc.command({ type: 'get_state' })).data.sessionFile, file);
  const existsAtStart = existsSync(file); await rpc.prompt('one'); assert.ok(existsSync(file));
  const cancelled = [];
  for (const name of ['empty.jsonl', 'old.jsonl', 'missing.jsonl']) {
    const target = join(e.cwd, name);
    if (name === 'empty.jsonl') writeFileSync(target, '');
    if (name === 'old.jsonl') writeFileSync(target, JSON.stringify({ type: 'session', version: 1, id: 'old', timestamp: new Date().toISOString(), cwd: e.cwd }) + '\n');
    const before = existsSync(target) ? readFileSync(target, 'utf8') : undefined;
    const response = await rpc.command({ type: 'switch_session', sessionPath: target }); assert.equal(response.data.cancelled, true);
    assert.equal(existsSync(target) ? readFileSync(target, 'utf8') : undefined, before); cancelled.push(name);
  }
  const results = [];
  const replacement = async cmd => {
    const before = jsonLines(log).length; const res = await rpc.command(cmd); assert.equal(res.success, true, JSON.stringify(res));
    const state = (await rpc.command({ type: 'get_state' })).data;
    const hooks = jsonLines(log).slice(before); const shutdown = hooks.find(h => h.event.type === 'session_shutdown');
    assert.equal(shutdown.event.targetSessionFile, state.sessionFile);
    results.push({ command: cmd.type, atShutdownExists: shutdown.exists, targetMatches: true, beforeHasTarget: hooks.find(h => h.event.type.startsWith('session_before'))?.event.targetSessionFile !== undefined });
    await rpc.prompt(`after-${cmd.type}`); assert.ok(existsSync(state.sessionFile));
  };
  await replacement({ type: 'new_session' });
  await rpc.prompt('second');
  let entries = (await rpc.command({ type: 'get_entries' })).data.entries;
  const users = entries.filter(x => x.type === 'message' && x.message.role === 'user');
  await replacement({ type: 'fork', entryId: users.at(-1).id });
  await replacement({ type: 'clone' });
  // The first user can have non-conversation ancestors; record the actual on-disk outcome.
  entries = (await rpc.command({ type: 'get_entries' })).data.entries;
  await replacement({ type: 'fork', entryId: entries.find(x => x.type === 'message' && x.message.role === 'user').id });
  await finish(rpc); built.native.unlock(fd);
  note('session-timing', { fixture: e.root, existsAtStart, cancelled, replacements: results });
});

for (const [from, to] of [['pi-pane', 'pi-agora'], ['pi-agora', 'pi-pane']]) for (const window of [false, true]) mt(`cross-host: ${from} -> ${to}, spawn window=${window}`, async () => {
  const e = await fixture({ routes: [{ when: { lastUser: 'hang' }, reply: { ignoreAbort: true, segments: [{ type: 'hang' }] } }], fallback: textReply });
  const session = join(e.cwd, 'shared.jsonl');
  const extension = await e.write('writer.ts', `export default function(pi){let timer;pi.on('session_start',()=>{timer=setInterval(()=>pi.appendEntry('host-writer',{host:process.env.E_HOST_APP}),40)});pi.on('session_shutdown',()=>new Promise(()=>{}));}`);
  function host(app, window = false) {
    const config = { app, window, addonPath: built.addonPath, session, extension, fixture: { root: e.root, cwd: e.cwd, home: e.home, agentDir: e.agentDir, scriptPath: e.scriptPath, requestLog: e.requestLog } };
    const child = spawn(process.execPath, [join(here, 'host.mjs'), JSON.stringify(config)], { env: fixtureEnv(e), cwd: e.cwd, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const id = trackChild(child); const wait = messages(child); return { child, id, wait };
  }
  const old = host(from, window); const ready = await old.wait(window ? 'spawn-window' : 'ready'); remember(ready.writer);
  if (!window) {
    await e.waitForProvider(r => r.kind === 'hang');
    const contender = host(to); await contender.wait('busy');
    assert.equal(isSameProcess(built.native, ready.writer), 'alive');
  }
  signalIdentity(built.native, old.id, 'SIGKILL'); await until(() => isSameProcess(built.native, old.id) === 'gone');
  const next = host(to);
  if (window) {
    await next.wait('failed'); const record = jsonFile(sessionPaths(session, e.home).record); assert.equal(record.writer, undefined); assert.equal(record.host.app, from);
    note('cross-host-window', { from, to, fixture: e.root, result: 'failed', newWriterStarted: false });
    signalIdentity(built.native, ready.writer, 'SIGKILL');
  } else {
    const recovered = await next.wait('recovered'); const nextReady = await next.wait('ready'); remember(nextReady.writer);
    assert.equal(isSameProcess(built.native, ready.writer), 'gone');
    await delay(120); next.child.send('stop'); const stopped = await next.wait('stopped'); assert.equal(stopped.report.leftovers.length, 0);
    const entries = jsonLines(session).filter(e => e.customType === 'host-writer').map(e => e.data.host);
    assert.ok(entries.includes(from)); assert.ok(entries.includes(to)); const switchIndex = entries.indexOf(to); assert.ok(entries.slice(switchIndex).every(app => app === to));
    note('cross-host', { from, to, fixture: e.root, oldStoppedBeforeNew: true, markerCount: entries.length, interleaved: false, report: recovered.report });
  }
});

mt('spawn gate: persisted identity survives exec; pipe EOF prevents execution', async () => {
  for (const release of [false, true]) {
    const marker = join(root, `gate-${release}`);
    const child = spawn(built.helper, ['gate', process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000)`], { detached: true, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
    const before = trackChild(child); await delay(100); assert.equal(existsSync(marker), false);
    writeFileSync(`${marker}.identity`, JSON.stringify(before));
    if (release) child.stdio[3].end('G'); else child.stdio[3].end();
    if (release) { await until(() => existsSync(marker)); assert.equal(identity(built.native, child.pid).startTime, before.startTime); signalIdentity(built.native, before, 'SIGKILL'); }
    else { await until(() => isSameProcess(built.native, before) === 'gone'); assert.equal(existsSync(marker), false); }
    note('spawn-gate', { release, executed: existsSync(marker), samePidAcrossExec: release ? Number(readFileSync(marker)) === before.pid : null });
  }
});

mt('daemon: pi extension in a real PTY launches detached daemon; HUP and master close (3 rounds)', async () => {
  for (let round = 1; round <= 3; round++) {
    const e = await fixture(); const info = join(e.root, 'daemon.json'); const heartbeat = join(e.root, 'heartbeat');
    const ext = await e.write('daemon.ts', daemonExtensionSource({ addonPath: built.addonPath, worker: join(here, 'worker.mjs'), log: heartbeat, info, oracle: join(e.root, 'cleanup-oracle.jsonl') }));
    const child = spawn(built.helper, ['pty', process.execPath, ...piArgs(['-e', ext])], { cwd: e.cwd, env: fixtureEnv(e), stdio: ['pipe', 'pipe', 'pipe'] }); const supervisor = trackChild(child);
    let out = ''; child.stdout.on('data', c => out += c);
    const terminalPid = await until(() => { try { return JSON.parse(out.split('\n')[0]).terminalPid; } catch {} });
    const terminal = e.emergency.remember(identity(built.native, terminalPid));
    const data = await until(() => jsonFile(info)); e.emergency.remember(data.daemon); e.emergency.remember(data.child);
    assert.notEqual(data.daemon.pgid, terminal.pgid);
    await until(() => existsSync(heartbeat)); const size = statSync(heartbeat).size;
    if (round % 2) signalIdentity(built.native, terminal, 'SIGHUP');
    child.stdin.end();
    await until(() => isSameProcess(built.native, terminal) === 'gone');
    await delay(200);
    assert.equal(isSameProcess(built.native, data.daemon), 'alive'); assert.equal(isSameProcess(built.native, data.child), 'alive'); assert.ok(statSync(heartbeat).size > size);
    assert.equal(data.childIsPiRpc, true);
    note('daemon-pty', { round, explicitHup: !!(round % 2), terminalGone: true, daemonAlive: true, childAlive: true, childIsPiRpc: true, fixture: e.root });
    signalIdentity(built.native, data.child, 'SIGKILL'); signalIdentity(built.native, data.daemon, 'SIGKILL');
    await until(() => isSameProcess(built.native, supervisor) === 'gone');
  }
});

mt('paths and secrets: symlink, case, Unicode, new ancestors, TOCTOU, 0700/0600', async () => {
  const e = await fixture(); const base = join(e.cwd, 'Data'); mkdirSync(base); writeFileSync(join(base, 'Café.txt'), 'inside'); writeFileSync(join(base, 'space name.txt'), 'space');
  writeFileSync(join(base, 'Capture d’écran.png'), 'curly'); writeFileSync(join(base, 'Screen 1\u202fPM.png'), 'screen');
  const link = join(e.cwd, 'alias'); symlinkSync(base, link);
  const cases = ['@alias/Café.txt', 'alias/../Data/Café.txt', 'alias/Cafe\u0301.txt', 'alias/cAFÉ.TxT', 'alias/space\u00a0name.txt', pathToFileURL(join(base, 'Café.txt')).href];
  const results = cases.map(p => ({ input: p, canonical: canonicalPath(p, e.cwd, 'read', e.home) }));
  assert.equal(new Set(results.filter((_, i) => i !== 4).map(r => comparisonKey(r.canonical))).size, 1);
  assert.equal(canonicalPath('~/new/a.jsonl', e.cwd, 'write', e.home), join(realpathSync(e.home), 'new/a.jsonl'));
  assert.equal(canonicalPath('alias/new/deep.jsonl', e.cwd, 'write', e.home), join(realpathSync(base), 'new/deep.jsonl'));
  assert.ok(canonicalPath("alias/Capture d'écran.png", e.cwd, 'read', e.home).includes('d’écran'));
  assert.ok(canonicalPath('alias/Screen 1 PM.png', e.cwd, 'read', e.home).includes('\u202f'));
  assert.equal(isWithin(base, `${base}Else/file`), false);
  const before = canonicalPath('alias/Café.txt', e.cwd, 'read', e.home);
  const outside = join(e.root, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'Café.txt'), 'outside'); unlinkSync(link); symlinkSync(outside, link);
  assert.equal(readFileSync(join(link, 'Café.txt'), 'utf8'), 'outside');
  const secretDir = join(e.root, 'secret'); mkdirSync(secretDir, { mode: 0o755 }); assert.equal(checkPrivate(secretDir, true), false); ensurePrivateDir(secretDir);
  const key = join(secretDir, 'key'); writePrivateFile(key, 'fixture-key'); assert.equal(checkPrivate(key), true); assert.throws(() => writePrivateFile(key, 'overwrite'), /EEXIST/); chmodSync(key, 0o644); assert.equal(checkPrivate(key), false); chmodSync(key, 0o600);
  note('paths-secrets', { fixture: e.root, cases: results, realpathCase: realpathSync.native(join(base, 'cAFÉ.TxT')), toctou: { checked: before, opened: 'outside' }, dirMode: (statSync(secretDir).mode & 0o777).toString(8), fileMode: (statSync(key).mode & 0o777).toString(8), owner: statSync(key).uid === process.getuid() });
});

mt('identity precision: 12 creations within one second have distinct microsecond timestamps', async () => {
  const children = Array.from({ length: 12 }, () => spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' }));
  const ids = children.map(trackChild);
  assert.equal(new Set(ids.map(id => id.startTime)).size, ids.length);
  const stamps = ids.map(id => BigInt(id.startTime.replace('.', ''))).sort((a, b) => a < b ? -1 : 1);
  const deltas = stamps.slice(1).map((s, i) => Number(s - stamps[i]));
  assert.ok(deltas.some(d => d < 1000000));
  for (const id of ids) signalIdentity(built.native, id, 'SIGKILL');
  note('identity-precision', { count: ids.length, unique: ids.length, minimumObservedDeltaUs: Math.min(...deltas), timestamps: ids.map(id => id.startTime) });
});

mt('process escalation: SIGSTOP prevents abort/stdin/TERM handling; SIGKILL finishes', async () => {
  const e = await fixture(); const rpc = await start(e); const id = identity(built.native, rpc.child.pid);
  signalIdentity(built.native, id, 'SIGSTOP');
  const report = await finish(rpc);
  assert.equal(report.steps[0].ok, false); assert.equal(report.steps[2].ok, true); assert.equal(report.steps.at(-1).detail, true);
  note('stopped-pi-escalation', report);
});

mt('RPC extension UI: host answers a real pi confirm request', async () => {
  const e = await fixture();
  const ext = await e.write('ui.ts', `export default function(pi){pi.registerCommand('confirm-fixture',{handler:async(_a,ctx)=>{const answer=await ctx.ui.confirm('fixture','answer false');ctx.ui.notify(JSON.stringify({answer}),'info');}});}`);
  const rpc = await start(e, ['-e', ext]);
  rpc.on('record', ev => { if (ev.type === 'extension_ui_request' && ev.method === 'confirm') void rpc.send({ type: 'extension_ui_response', id: ev.id, confirmed: false }); });
  const response = await rpc.command({ type: 'prompt', message: '/confirm-fixture' });
  assert.equal(response.data.disposition, 'handled');
  assert.ok(rpc.events.some(ev => ev.method === 'notify' && ev.message === '{"answer":false}'));
  await finish(rpc); note('rpc-ui', { requestSeen: true, confirmed: false, commandDisposition: response.data.disposition });
});

mt('startup barriers: native gate blocks pi file open; extension handshake follows file open', async () => {
  const e = await fixture(); const gatedFile = join(e.cwd, 'gated.jsonl'); writeFileSync(gatedFile, '');
  const child = spawn(built.helper, ['gate', process.execPath, ...piArgs(['--session', gatedFile])], { cwd: e.cwd, env: fixtureEnv(e), detached: true, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
  const id = trackChild(child); const rpc = new RpcTransport(child); await delay(150); assert.equal(statSync(gatedFile).size, 0);
  writeFileSync(join(e.root, 'persisted-writer.json'), JSON.stringify(id)); child.stdio[3].end('G');
  await rpc.command({ type: 'get_state' }); assert.equal(isSameProcess(built.native, id), 'alive'); assert.ok(statSync(gatedFile).size > 0); await finish(rpc);
  const handshakeFile = join(e.cwd, 'handshake.jsonl'); writeFileSync(handshakeFile, ''); const marker = join(e.root, 'handshake'); const release = join(e.root, 'handshake-release');
  const ext = await e.write('handshake.ts', `import {writeFileSync,existsSync} from 'node:fs';export default function(pi){pi.on('session_start',async()=>{writeFileSync(${JSON.stringify(marker)},'ready');while(!existsSync(${JSON.stringify(release)}))await new Promise(r=>setTimeout(r,10));});}`);
  const handshake = spawnPi(e, ['--session', handshakeFile, '-e', ext]); trackChild(handshake.child);
  await until(() => existsSync(marker)); assert.ok(statSync(handshakeFile).size > 0);
  writeFileSync(release, 'go'); await handshake.command({ type: 'get_state' }); await finish(handshake);
  note('startup-barriers', { fixture: e.root, gatedEmptyFileUnchangedBeforeGo: true, identityStableAfterPiExec: true, handshakeObservedAfterEmptyFileRewrite: true });
});

mt('paths: compare native prototype resolution with actual pi 1.5.0 functions', async () => {
  const e = await fixture(); const target = join(e.cwd, 'A café.txt'); writeFileSync(target, 'fixture');
  const source = `import {resolveToCwd,resolveReadPath} from ${JSON.stringify(pathToFileURL(join(piInstall().packageDir, 'dist/core/tools/path-utils.js')).href)};console.log(JSON.stringify(JSON.parse(process.argv[1]).map(p=>({input:p,read:resolveReadPath(p,process.cwd()),write:resolveToCwd(p,process.cwd())}))));`;
  const inputs = ['@A café.txt', 'A\u00a0café.txt', 'A\u2000café.txt', 'A\u200acafé.txt', 'A\u202fcafé.txt', 'A\u205fcafé.txt', 'A\u3000café.txt', 'A cafe\u0301.txt', './sub/../A café.txt', pathToFileURL(target).href, '~/new.txt', 'new/deep/file.txt'];
  const resolved = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', source, JSON.stringify(inputs)], { cwd: e.cwd, env: fixtureEnv(e) }));
  for (const r of resolved) for (const mode of ['read', 'write']) assert.equal(canonicalPath(r.input, e.cwd, mode, e.home), canonicalPath(r[mode], e.cwd, mode, e.home));
  const alias = join(e.cwd, 'alias'); symlinkSync(e.cwd, alias);
  assert.equal(sessionPaths(join(alias, 'A CAFÉ.TXT'), e.home).lock, sessionPaths(target, e.home).lock);
  assert.equal(sessionPaths(join(e.cwd, 'new', 'A Café.jsonl'), e.home).lock, sessionPaths(join(alias, 'new', 'a cafe\u0301.JSONL'), e.home).lock);
  note('pi-path-parity', { cases: inputs.length, modes: ['read', 'write'], mismatches: 0, existingAndMissingAliasLockKeysEqual: true });
});

test('Windows: Job Object, suspended launch, mutex, abandoned ownership, icacls and junction — 待测', { skip: 'macOS 上无法验证' }, () => {});
test('Linux: /proc identity, flock, cgroup/subreaper and terminal survival — 待测', { skip: 'macOS 上无法验证' }, () => {});
test('GUI terminal window closure — 需主人手动', { skip: 'No GUI terminal automation' }, () => {});
test('Network filesystem rejection against a mounted remote filesystem — 待测', { skip: 'No remote mount or system setting changes' }, () => {});
