import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createExperiment } from '../harness/index.mjs';

const extension = fileURLToPath(new URL('./notice-extension.ts', import.meta.url));
const observations = [];
const allChildren = [];
const retainedFixtures = [];
const repeat = Number(process.env.P0_REPEAT ?? 3);
const plain = { fallback: { segments: [{ type: 'text', text: 'P0 done' }] } };
function track(rpc) {
  const killGroup = rpc.killGroup.bind(rpc);
  rpc.killGroup = (signal) => {
    if (rpc.child.exitCode !== null || rpc.child.signalCode !== null) return;
    if (process.platform === 'win32') rpc.child.kill(signal);
    else killGroup(signal);
  };
  allChildren.push(rpc.child);
  return rpc;
}
const output = fileURLToPath(new URL('./observations.json', import.meta.url));
async function until(fn, timeout = 12000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await fn();
    if (result) return result;
    await delay(20);
  }
  throw new Error('P0 condition timed out');
}
async function records(file) {
  if (!existsSync(file)) return [];
  return (await readFile(file, 'utf8')).split('\n').slice(0, -1).map(line => JSON.parse(line));
}
async function launchDaemon(e, port = 0) {
  const child = fork(fileURLToPath(new URL('./daemon.mjs', import.meta.url)), [], {
    cwd: e.cwd, env: { PATH: process.env.PATH, HOME: e.home, PI_CODING_AGENT_DIR: e.agentDir,
      P0_NOTIFY_ROOT: e.root, P0_NOTIFY_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  allChildren.push(child);
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  const exit = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Daemon startup timeout: ${stderr}`)), 10000);
    child.once('message', message => { clearTimeout(timer); resolve(message); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error(`Daemon startup exit: ${stderr}`)); });
  });
  return { child, exit, ...ready, url: `http://127.0.0.1:${ready.port}` };
}
async function fixture(t) {
  const e = await createExperiment({ script: plain });
  const daemons = [];
  const drivers = [];
  let config = { auto: false, fault: null };
  let sessionFile;
  const api = async (path, body) => {
    const res = await fetch(config.url + path, { method: body ? 'POST' : 'GET', body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(3000) });
    assert.equal(res.status, 200);
    return res.json();
  };
  const control = async (patch) => {
    config = { ...config, ...patch };
    await writeFile(join(e.root, 'control.next'), JSON.stringify(config));
    await rename(join(e.root, 'control.next'), join(e.root, 'control.json'));
  };
  const daemon = await launchDaemon(e);
  daemons.push(daemon);
  await control({ url: daemon.url });
  const start = async (resume = false) => {
    const rpc = await e.start({ args: ['-e', extension, '--no-approve', ...(resume ? ['--session', sessionFile] : [])], env: { P0_NOTIFY_ROOT: e.root } });
    drivers.push(rpc); track(rpc);
    const reportedFile = (await rpc.command({ type: 'get_state' })).data.sessionFile;
    if (resume) assert.equal(reportedFile, sessionFile);
    sessionFile = reportedFile;
    return rpc;
  };
  const f = {
    e, daemon, api, control, start, drivers, daemons, preserve: false,
    get sessionFile() { return sessionFile; },
    async restartDaemon() {
      const d = await launchDaemon(e, daemon.port); daemons.push(d); return d;
    },
    async notices() { return (await records(sessionFile)).filter(e => e.type === 'custom_message' && e.customType === 'agora:notice'); },
    async ext() { return records(join(e.root, 'extension.jsonl')); },
    async daemonLog() { return records(join(e.root, 'daemon.jsonl')); },
    async poll(rpc) {
      const result = await rpc.command({ type: 'prompt', message: '/p0-poll' });
      assert.equal(result.success, true, JSON.stringify(result));
    },
    async create(key, silent = false) { await api('/create', { dedupeKey: key, silent }); },
    async acked(key) { return (await api('/state')).find(row => row.dedupeKey === key)?.ackedAt; },
    async capture(name, details = {}) {
      const snapshot = await drivers.at(-1).command({ type: 'prompt', message: '/p0-snapshot' });
      assert.equal(snapshot.success, true);
      const daemonLog = await f.daemonLog();
      assert.ok(daemonLog.filter(e => e.kind === 'ack').every(e => e.onDisk), 'No ack before complete JSONL record');
      observations.push({ name, ...details,
        notices: (await f.notices()).map(e => ({ id: e.id, dedupeKey: e.details.dedupeKey })),
        extension: (await f.ext()).filter(e => e.kind !== 'session_start'),
        daemon: daemonLog,
        outbox: await api('/state'),
        requests: (await e.requests()).map(r => ({ request: r.request, lastUser: r.lastUser })),
        exits: drivers.map(d => d.exitInfo).filter(Boolean),
      });
    },
  };
  t.after(async () => {
    await e.stop();
    for (const d of daemons) {
      if (d.child.exitCode === null && d.child.signalCode === null) d.child.kill('SIGKILL');
      await d.exit;
    }
    if (t.passed && !f.preserve) await e.cleanup();
    else { retainedFixtures.push({ test: t.name, root: e.root }); console.error(`retained fixture: ${e.root}`); }
  });
  return f;
}
async function seed(f, rpc) {
  const { response } = await rpc.promptAndWait('P0 seed');
  assert.equal(response.success, true);
}
async function complete(f, rpc, key) {
  await until(async () => {
    await f.poll(rpc);
    return f.acked(key);
  });
  await until(async () => !(await rpc.command({ type: 'get_state' })).data.isStreaming);
  assert.equal((await f.notices()).filter(e => e.details.dedupeKey === key).length, 1);
}

for (const mode of ['idle', 'busy', 'tool', 'silent', 'silent-new', 'silent-busy', 'clear_queue']) {
  test(`#7 ${mode}`, { timeout: 40000 }, async t => {
    const f = await fixture(t);
    const rpc = await f.start();
    if (mode !== 'silent-new') await seed(f, rpc);
    const key = `notice:${mode}`;
    const before = (await f.e.requests()).length;
    let from = rpc.cursor;
    if (mode === 'busy' || mode === 'clear_queue' || mode === 'silent-busy') {
      await f.e.setScript({ fallback: plain.fallback, routes: [{ when: { lastUser: 'P0 busy' }, reply: { segments: [mode === 'busy' ? { type: 'text', text: 'P0 busy done', delayMs: 900 } : { type: 'hang' }] } }] });
      assert.equal((await rpc.command({ type: 'prompt', message: 'P0 busy' })).success, true);
      await f.e.waitForProvider(e => mode === 'busy' ? e.kind === 'request' && e.lastUser === 'P0 busy' : e.kind === 'hang');
    }
    if (mode === 'tool') {
      await f.e.write('tool-input.txt', 'local P0 input\n');
      await f.e.setScript({ fallback: plain.fallback, routes: [{ when: { request: before + 1 }, reply: { segments: [{ type: 'toolCall', name: 'p0_gate', arguments: {} }] } }] });
      const gate = await f.e.write('tool-gate.ts', `import { existsSync, writeFileSync, readFileSync } from 'node:fs';\nimport { setTimeout as delay } from 'node:timers/promises';\nexport default function(pi) { pi.registerTool({ name:'p0_gate', label:'P0 gate', description:'Read a local fixture after a barrier', parameters:{type:'object',properties:{},required:[]}, async execute() { writeFileSync(${JSON.stringify(join(f.e.root, 'entered-tool'))}, '1'); while(!existsSync(${JSON.stringify(join(f.e.root, 'release-tool'))})) await delay(10); return {content:[{type:'text',text:readFileSync('tool-input.txt','utf8')}],details:{}}; } }); }`);
      // Reloading is unnecessary: restart the same session with the tool barrier extension.
      await rpc.stop();
      const next = await f.e.start({ args: ['--session', f.sessionFile, '-e', extension, '-e', gate, '--no-approve'], env: { P0_NOTIFY_ROOT: f.e.root } });
      f.drivers.push(next); track(next);
      from = next.cursor;
      await next.command({ type: 'prompt', message: 'P0 tool' });
      await next.waitFor('tool_execution_start', { from });
      await until(() => existsSync(join(f.e.root, 'entered-tool')));
      await f.create(key);
      await f.poll(next);
      assert.equal((await f.notices()).length, 0);
      await writeFile(join(f.e.root, 'release-tool'), '1');
      await next.waitFor('agent_settled', { from });
      await complete(f, next, key);
      const reqs = await f.e.requests();
      assert.ok(reqs.at(-1).context.messages.some(m => JSON.stringify(m).includes(key)));
      await f.capture(`#7 ${mode}`, { beforeDeliveryDiskCount: 0 });
      return;
    }
    await f.create(key, mode.startsWith('silent'));
    await f.create(key, mode.startsWith('silent'));
    assert.equal((await f.api('/state')).length, 1);
    await f.poll(rpc);
    if (mode === 'busy' || mode === 'clear_queue') {
      assert.equal((await f.notices()).length, 0);
      assert.equal(await f.acked(key), null);
      // Expire the lease and redeliver while still queued to exercise the in-flight set.
      await delay(300);
      await f.poll(rpc);
      assert.ok((await f.ext()).some(e => e.kind === 'deduped' && e.inFlight));
      if (mode === 'clear_queue') {
        const clear = await rpc.command({ type: 'clear_queue' });
        assert.equal(clear.success, true);
        observations.push({ name: '#7 clear_queue response', response: clear });
        await f.e.setScript(plain);
        await rpc.command({ type: 'abort' });
        assert.ok((await f.ext()).some(e => e.kind === 'reset_inflight' && e.dedupeKey === key));
        await f.control({ auto: true });
      } else {
        await rpc.waitFor('agent_settled', { from });
      }
    }
    if (mode === 'silent-busy') {
      assert.equal((await f.notices()).length, 0);
      assert.equal(await f.acked(key), null);
      await f.e.setScript(plain);
      await rpc.command({ type: 'abort' });
      assert.equal((await f.e.requests()).length, before + 1);
      assert.equal((await f.ext()).filter(e => e.kind === 'extension_message_end').length, 0);
    }
    if (mode === 'silent-new') {
      assert.equal((await f.notices()).length, 0);
      assert.equal(await f.acked(key), null);
      assert.equal(existsSync(f.sessionFile), false);
      await seed(f, rpc);
    } else if (mode === 'silent') {
      assert.equal((await f.e.requests()).length, before);
      assert.equal(rpc.events.slice(from).filter(r => r.event.type === 'message_end' && r.event.message.customType === 'agora:notice').length, 1);
      assert.equal((await f.ext()).filter(e => e.kind === 'extension_message_end').length, 0);
    }
    await complete(f, rpc, key);
    assert.ok((await f.daemonLog()).some(e => e.kind === 'ack' && e.onDisk));
    if (mode === 'clear_queue') assert.ok((await f.ext()).filter(e => e.kind === 'inject' && e.dedupeKey === key).length === 2);
    if (mode === 'idle') assert.ok((await f.e.requests()).length > before);
    await f.capture(`#7 ${mode}`);
  });
}

for (const point of ['extension-message-end', 'public-before-persist', 'silent-after-send', 'silent-new-after-send', 'daemon-before-ack']) {
  for (let attempt = 1; attempt <= repeat; attempt++) {
    test(`#8 ${point} ${attempt}/${repeat}`, { timeout: 40000 }, async t => {
      const f = await fixture(t);
      const rpc = await f.start();
      if (point !== 'silent-new-after-send') await seed(f, rpc);
      const key = `fault:${point}:${attempt}`;
      await f.control({ fault: point === 'silent-new-after-send' ? 'silent-after-send' : point });
      await f.create(key, point.includes('silent'));
      const command = rpc.command({ type: 'prompt', message: '/p0-poll' }).catch(error => ({ transportClosed: String(error) }));
      let beforeDisk, beforeMemory;
      if (point === 'daemon-before-ack') {
        await until(async () => (await f.ext()).some(e => e.kind === 'before_ack'));
        beforeDisk = (await f.notices()).length;
        assert.equal(beforeDisk, 1);
        assert.equal(await f.acked(key), null);
        f.daemon.child.kill('SIGKILL');
        assert.equal((await f.daemon.exit).signal, 'SIGKILL');
        await writeFile(join(f.e.root, 'release-ack'), '1');
        await until(async () => (await f.ext()).some(e => e.kind === 'transport_error'));
        // Match architecture.md: stop the old run before resuming the same session.
        rpc.killGroup('SIGKILL');
        await rpc.exit;
        await f.restartDaemon();
        assert.equal(await f.acked(key), null);
      } else {
        const exit = await rpc.exit;
        assert.equal(exit.signal, 'SIGKILL');
        const logs = await f.ext();
        assert.ok(logs.some(e => e.kind === 'fault'));
        beforeDisk = (await f.notices()).length;
        beforeMemory = logs.find(e => e.kind === 'silent_returned')?.memoryCount;
        assert.equal(beforeDisk, point === 'silent-after-send' ? 1 : 0);
        assert.equal(await f.acked(key), null);
        if (point === 'public-before-persist') {
          assert.ok(logs.some(e => e.kind === 'public_dispatched' && e.dedupeKey === key), 'Real public listeners were dispatched before persistence');
        }
        if (point === 'extension-message-end') {
          const event = logs.find(e => e.kind === 'extension_message_end');
          assert.equal(event.diskCount, 0); assert.equal(event.memoryCount, 0);
        }
      }
      await command;
      await f.control({ fault: null, auto: true });
      const recovered = await f.start(true);
      // A new silent-only session needs a real conversation before pi first creates its file.
      if (point === 'silent-new-after-send') await seed(f, recovered);
      await complete(f, recovered, key);
      const state = (await f.api('/state'))[0];
      assert.ok(state.attempts >= (beforeDisk === 1 ? 1 : 2));
      const ext = await f.ext();
      const injectCount = ext.filter(e => e.kind === 'inject' && e.dedupeKey === key).length;
      assert.equal(injectCount, beforeDisk === 1 ? 1 : 2);
      await f.capture(`#8 ${point}`, { attempt, beforeDisk, beforeMemory, injectCount, recoveredExactlyOnce: true, daemonKilled: point === 'daemon-before-ack', rpcMessageEndObservedBeforeKill: rpc.events.some(r => r.event.type === 'message_end' && r.event.message.details?.dedupeKey === key) });
    });
  }
}

for (let attempt = 1; attempt <= repeat; attempt++) {
  test(`#7 abort without clear_queue deviation ${attempt}/${repeat}`, { timeout: 40000 }, async t => {
    const f = await fixture(t);
    const rpc = await f.start();
    await seed(f, rpc);
    const key = `notice:abort-queue:${attempt}`;
    await f.e.setScript({ fallback: plain.fallback, routes: [{ when: { lastUser: 'P0 abort queue' }, reply: { segments: [{ type: 'hang' }] } }] });
    await rpc.command({ type: 'prompt', message: 'P0 abort queue' });
    await f.e.waitForProvider(e => e.kind === 'hang');
    await f.create(key);
    await f.poll(rpc);
    await delay(300);
    await f.poll(rpc);
    await f.e.setScript(plain);
    await rpc.command({ type: 'abort' });
    assert.ok((await f.ext()).some(e => e.kind === 'reset_inflight' && e.dedupeKey === key));
    await until(async () => { await f.poll(rpc); return f.acked(key); });
    await until(async () => !(await rpc.command({ type: 'get_state' })).data.isStreaming);
    const count = (await f.notices()).filter(e => e.details.dedupeKey === key).length;
    // This asserts the observed deviation, not the design's exactly-once acceptance criterion.
    assert.equal(count, 2);
    f.preserve = true;
    await f.capture('#7 abort without clear_queue deviation', { attempt, expectedExactlyOnce: 1, actualCount: count, designPass: false });
  });
}

after(async () => {
  const lingering = allChildren.filter(child => child.exitCode === null && child.signalCode === null).map(child => child.pid);
  await writeFile(output, JSON.stringify({ platform: process.platform, node: process.version, repeat, lingering, retainedFixtures, observations }, null, 2) + '\n');
  assert.deepEqual(lingering, [], 'No live owned child processes');
});
