import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createExperiment, readJsonl, DeadlineError } from './experiment.mjs';
import { SessionModel, reduce } from './session-model.mjs';

const observations = {};
const children = [];
const fixtures = [];
const text = value => ({ segments: [{ type: 'text', text: value }] });
const fallback = { fallback: text('fallback answer') };
const messageText = m => typeof m.content === 'string' ? m.content : m.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
const entries = async rpc => (await rpc.command({ type: 'get_entries' })).data.entries;
const state = async rpc => (await rpc.command({ type: 'get_state' })).data;
const extLog = e => readJsonl(join(e.root, 'extension.jsonl'));
const control = (e, data) => writeFile(join(e.root, 'control.json'), JSON.stringify(data));
async function fixture(t, options = {}) {
  const e = await createExperiment(options);
  fixtures.push(e);
  await control(e, {});
  const extension = await e.write('probe.ts', await readFile(new URL('./probe-extension.ts', import.meta.url), 'utf8'));
  const start = e.start;
  e.start = async (overrides = {}) => {
    const rpc = await start({ ...overrides, env: { ...overrides.env, P0_A_ROOT: e.root }, args: ['-e', extension, ...(overrides.args ?? [])] });
    children.push(rpc);
    return rpc;
  };
  t.diagnostic('fixture: ' + e.root);
  t.after(async () => {
    await e.stop();
    if (t.passed && !e.preserve) await e.cleanup();
    else t.diagnostic('retained fixture: ' + e.root);
  });
  return e;
}
function observe(t, name, value) {
  const clean = JSON.parse(JSON.stringify(value, (key, val) => {
    if (typeof val !== 'string') return val;
    for (const e of fixtures) val = val.replaceAll(e.root, '<fixture>');
    return val;
  }));
  observations[name] = clean; t.diagnostic(name + ': ' + JSON.stringify(clean));
}

after(async () => {
  await Promise.all(fixtures.map(e => e.stop()));
  const live = children.filter(rpc => { try { process.kill(rpc.child.pid, 0); return true; } catch { return false; } }).map(rpc => rpc.child.pid);
  observations.cleanup = { processes: children.map(rpc => ({ pid: rpc.child.pid, exit: rpc.exitInfo })), live, retained: fixtures.filter(e => existsSync(e.root)).map(e => e.root) };
  await writeFile(new URL('./evidence.json', import.meta.url), JSON.stringify({ platform: process.platform, node: process.version, pi: '1.5.0', observations }, null, 2) + '\n');
  assert.deepEqual(live, []);
});

test('A1 lifecycle, tool-boundary steering, follow-up, extension commands and steerId', async t => {
  const e = await fixture(t, { script: { turns: [{ segments: [{ type: 'toolCall', name: 'p0_gate', arguments: {} }] }], ...fallback } });
  const rpc = await e.start();
  const model = new SessionModel(rpc); await model.refresh();
  const from = rpc.cursor;
  const response = await rpc.command({ type: 'prompt', message: 'start gate' });
  assert.equal(response.data.disposition, 'started');
  await rpc.waitFor(event => event.type === 'tool_execution_start' && event.toolName === 'p0_gate', { from });
  assert.equal((await state(rpc)).isStreaming, true);
  const commands = (await rpc.command({ type: 'get_commands' })).data.commands;
  assert.ok(commands.some(c => c.name === 'p0-ping' && c.source === 'extension'));
  assert.ok(!commands.some(c => c.name === 'compact'));
  const ping = await rpc.command({ type: 'prompt', message: '/p0-ping' });
  assert.equal(ping.data.disposition, 'handled');
  assert.equal((await entries(rpc)).find(e => e.customType === 'p0-ping').data.idle, false);
  const statuses = { st_delivered: ['accepted'], st_dropped: ['accepted'] };
  const steer = '【agora 返工 st_delivered，第 2 代】\nfix';
  const dropped = '【agora 返工 st_dropped，第 3 代】\nfix';
  const handled = await rpc.command({ type: 'steer', message: 'HANDLE_STEER' });
  assert.equal(handled.data.disposition, 'handled');
  await rpc.command({ type: 'steer', message: dropped });
  await rpc.command({ type: 'follow_up', message: 'drop follow-up' });
  assert.ok(rpc.events.some(r => r.event.type === 'queue_update' && r.event.steering.includes(dropped)));
  statuses.st_dropped.push('queued');
  const cleared = await rpc.command({ type: 'clear_queue' });
  assert.deepEqual(cleared.data, { steering: [dropped], followUp: ['drop follow-up'] });
  statuses.st_dropped.push('dropped');
  await rpc.command({ type: 'steer', message: steer });
  await rpc.command({ type: 'follow_up', message: 'follow-up delivered' });
  assert.ok(rpc.events.some(r => r.event.type === 'queue_update' && r.event.steering.includes(steer)));
  statuses.st_delivered.push('queued');
  assert.equal(rpc.events.slice(from).some(r => r.event.type === 'message_end' && r.event.message.role === 'user' && messageText(r.event.message).includes('st_delivered')), false);
  await writeFile(join(e.root, 'release'), 'go');
  await rpc.waitFor('agent_settled', { from });
  const records = rpc.events.slice(from);
  const toolEnd = records.find(r => r.event.type === 'tool_execution_end');
  const delivered = records.find(r => r.event.type === 'message_end' && r.event.message.role === 'user' && messageText(r.event.message) === steer);
  assert.ok(toolEnd.seq < delivered.seq);
  statuses.st_delivered.push('delivered');
  const ends = records.filter(r => r.event.type === 'agent_end').map(r => r.seq);
  const settled = records.find(r => r.event.type === 'agent_settled').seq;
  assert.ok(ends.every(seq => seq < settled));
  assert.equal((await state(rpc)).isStreaming, false);
  assert.equal((await rpc.command({ type: 'get_last_assistant_text' })).data.text, 'fallback answer');
  const users = (await entries(rpc)).filter(e => e.message?.role === 'user').map(e => messageText(e.message));
  assert.deepEqual(users, ['start gate', steer, 'follow-up delivered']);
  await model.flush();
  assert.deepEqual(model.failures, []);
  const finalModel = model.snapshot();
  for (const snapshot of model.snapshots) {
    const replay = structuredClone(snapshot); delete replay.cursor;
    for (const record of model.subscribe(snapshot.cursor)) reduce(replay, record.event);
    const expected = structuredClone(finalModel); delete expected.cursor;
    assert.deepEqual(replay, expected);
  }
  assert.deepEqual(finalModel.entries, (await readJsonl((await state(rpc)).sessionFile)).filter(e => e.type !== 'session'));
  model.dispose();
  observe(t, 'lifecycle', { toolSnapshotCuts: model.snapshots.length, statuses, prompt: response.data, ping: ping.data, commands, clearQueue: cleared.data, handled: handled.data, users, toolEnd: toolEnd.seq, delivered: delivered.seq, agentEnd: ends, agentSettled: settled, requests: (await e.requests()).length,
    trace: records.filter(r => ['agent_start', 'agent_end', 'agent_settled', 'queue_update', 'tool_execution_end'].includes(r.event.type)).map(r => ({ seq: r.seq, type: r.event.type, steering: r.event.steering, followUp: r.event.followUp, willRetry: r.event.willRetry, aborted: r.event.aborted })) });
});

test('A2 clear_queue then abort preserves text and executes no queued message', async t => {
  const e = await fixture(t, { script: { turns: [{ segments: [{ type: 'hang' }] }], ...fallback } });
  const rpc = await e.start();
  const from = rpc.cursor;
  await rpc.command({ type: 'prompt', message: 'stop test' });
  await e.waitForProvider(x => x.kind === 'hang');
  await rpc.command({ type: 'steer', message: 'steer one' });
  await rpc.command({ type: 'steer', message: 'steer two' });
  await rpc.command({ type: 'follow_up', message: 'follow one' });
  const cleared = await rpc.command({ type: 'clear_queue' });
  assert.deepEqual(cleared.data, { steering: ['steer one', 'steer two'], followUp: ['follow one'] });
  await rpc.command({ type: 'abort' });
  assert.equal((await rpc.waitFor('agent_settled', { from })).aborted, true);
  assert.equal((await e.requests()).length, 1);
  const users = (await entries(rpc)).filter(e => e.message?.role === 'user').map(e => messageText(e.message));
  assert.deepEqual(users, ['stop test']);
  observe(t, 'stop', { clearQueue: cleared.data, requests: 1, users, state: await state(rpc) });
});

test('A3 ignored tool abort times out, owned process terminates, same session resumes', async t => {
  const e = await fixture(t, { script: { turns: [{ segments: [{ type: 'toolCall', name: 'p0_gate', arguments: {} }] }], ...fallback } });
  const file = join(e.root, 'preallocated.jsonl');
  const rpc = await e.start({ args: ['--session', file] });
  const from = rpc.cursor;
  await rpc.command({ type: 'prompt', message: 'unresponsive tool' });
  await rpc.waitFor(event => event.type === 'tool_execution_start', { from });
  await assert.rejects(rpc.command({ type: 'abort' }, { timeoutMs: 180 }), DeadlineError);
  assert.equal((await state(rpc)).isStreaming, true);
  assert.equal(rpc.events.slice(from).some(r => r.event.type === 'agent_settled'), false);
  rpc.killGroup('SIGKILL');
  await rpc.exit;
  const recovered = await e.start({ args: ['--session', file] });
  await recovered.promptAndWait('recover without replaying tool');
  const req = (await e.requests()).at(-1);
  assert.match(JSON.stringify(req.context.messages), /unresponsive tool/);
  observe(t, 'abortTimeout', { timeoutMs: 180, exit: rpc.exitInfo, recoveredFileMatches: (await state(recovered)).sessionFile === file, priorUserRestored: true, toolStarts: (await extLog(e)).filter(x => x.type === 'gate_start').length });
});

test('A4 preallocated session, since/leafId, message_end cut, compaction history and restart', async t => {
  const e = await fixture(t, { script: fallback, settings: { compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 128 } } });
  await control(e, { customCompact: true });
  const file = join(e.root, 'preallocated.jsonl');
  await writeFile(join(e.root, 'preallocated.lock'), 'held before spawn', { flag: 'wx' });
  const rpc = await e.start({ args: ['--session', file] });
  assert.equal((await state(rpc)).sessionFile, file);
  assert.equal(existsSync(file), false);
  let last;
  const cuts = [];
  const pending = [];
  rpc.onEvent((event, record) => {
    if (event.type !== 'message_end') return;
    pending.push((async () => {
      const result = await rpc.command({ type: 'get_entries', ...(last ? { since: last } : {}) });
      const found = result.data.entries.some(e => e.message && JSON.stringify(e.message) === JSON.stringify(event.message));
      cuts.push({ rawSeq: record.seq, role: event.message.role, found, count: result.data.entries.length });
      last = result.data.entries.at(-1)?.id ?? last;
    })());
  });
  await rpc.promptAndWait('history one');
  await rpc.promptAndWait('history two');
  await Promise.all(pending);
  assert.ok(cuts.every(c => c.found));
  const before = await entries(rpc);
  const since = before.at(-1).id;
  assert.deepEqual((await rpc.command({ type: 'get_entries', since })).data, { entries: [], leafId: since });
  assert.equal((await rpc.command({ type: 'get_entries', since: 'missing-id' })).success, false);
  const compact = await rpc.command({ type: 'compact' });
  assert.equal(compact.success, true);
  const all = await entries(rpc);
  assert.ok(before.every(e => all.some(x => x.id === e.id)));
  assert.ok(all.some(e => e.type === 'compaction'));
  assert.deepEqual((await rpc.command({ type: 'get_entries', since })).data.entries.map(e => e.type), ['compaction']);
  assert.deepEqual((await readJsonl(file)).filter(e => e.type !== 'session'), all);
  await rpc.stop();
  const recovered = await e.start({ args: ['--session', file] });
  assert.deepEqual(await entries(recovered), all);
  await recovered.promptAndWait('after restart');
  const context = (await e.requests()).at(-1).context.messages;
  assert.match(JSON.stringify(context), /history two/);
  assert.match(JSON.stringify(context), /P0 compact summary/);
  const target = before.find(e => e.message?.role === 'assistant').id;
  await recovered.command({ type: 'prompt', message: '/p0-navigate ' + target });
  const leafChanged = (await recovered.command({ type: 'get_entries', since: (await entries(recovered)).at(-1).id })).data;
  assert.equal(leafChanged.leafId, target);
  assert.deepEqual(leafChanged.entries, []);
  observe(t, 'persistence', { leafMovedWithoutAppend: true, leafRebuildRequired: true, explicitFile: true, initialFileAbsent: true, cuts, extensionBeforePersist: (await extLog(e)).filter(e => e.type === 'message_end_before_persist'), preCompactionMessages: before.filter(e => e.type === 'message').length, afterCompactionEntries: all.length, compaction: compact.data, restartEntriesIdentical: true, restoredContext: context.filter(m => m.role !== 'system') });
});

test('A5 snapshot cuts, delta blocks, discarded model reconnect, server restart and epochs', async t => {
  const e = await fixture(t, { script: { fallback: { segments: [{ type: 'thinking', chunks: ['plan', { text: ' two', delayMs: 50 }] }, { type: 'text', chunks: ['alpha', { text: ' beta', delayMs: 120 }, { text: ' gamma', delayMs: 120 }] }] } } });
  let rpc = await e.start();
  let model = new SessionModel(rpc);
  await model.refresh();
  const from = rpc.cursor;
  await rpc.command({ type: 'prompt', message: 'snapshot stream' });
  await rpc.waitFor(event => event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta', { from });
  const disconnected = model.snapshot();
  const oldSnapshots = model.snapshots;
  const oldBuffer = model.buffer;
  const oldFinal = structuredClone(disconnected); delete oldFinal.cursor;
  for (const snapshot of oldSnapshots) {
    const replay = structuredClone(snapshot); delete replay.cursor;
    for (const record of oldBuffer.filter(r => r.cursor.seq > snapshot.cursor.seq)) reduce(replay, record.event);
    assert.deepEqual(replay, oldFinal);
  }
  assert.deepEqual(disconnected.inFlight.active.content, [{ type: 'thinking', thinking: 'plan two' }, { type: 'text', text: 'alpha' }]);
  model.dispose();
  model = new SessionModel(rpc);
  await model.refresh();
  assert.deepEqual(model.subscribe(disconnected.cursor), { type: 'resync' });
  await rpc.waitFor('agent_settled', { from });
  await model.flush();
  assert.deepEqual(model.failures, []);
  const final = model.snapshot();
  const cuts = model.snapshots;
  for (const snapshot of cuts) {
    const replay = structuredClone(snapshot);
    for (const record of model.subscribe(snapshot.cursor)) reduce(replay, record.event);
    delete replay.cursor;
    const expected = structuredClone(final); delete expected.cursor;
    assert.deepEqual(replay, expected);
  }
  const file = (await state(rpc)).sessionFile;
  assert.deepEqual(final.entries, (await readJsonl(file)).filter(e => e.type !== 'session'));
  assert.equal(final.inFlight.active, null);
  assert.deepEqual(final.inFlight.completed, []);
  assert.deepEqual(model.subscribe({ epoch: model.epoch, seq: model.seq + 1 }), { type: 'resync' });
  const first = model.buffer.shift();
  assert.deepEqual(model.subscribe({ epoch: model.epoch, seq: 0 }), { type: 'resync' });
  model.buffer.unshift(first);
  const beforeRestart = model.snapshot();
  model.dispose();
  await rpc.stop();
  rpc = await e.start({ args: ['--session', file] });
  model = new SessionModel(rpc); await model.refresh();
  assert.deepEqual(model.subscribe(beforeRestart.cursor), { type: 'resync' });
  assert.deepEqual(model.snapshot().entries, beforeRestart.entries);
  const runFrom = rpc.cursor;
  await rpc.command({ type: 'prompt', message: 'restart during stream' });
  await rpc.waitFor(event => event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta', { from: runFrom });
  const streamingCursor = model.snapshot().cursor;
  model.dispose(); await rpc.stop({ graceMs: 100 });
  rpc = await e.start({ args: ['--session', file] });
  model = new SessionModel(rpc); await model.refresh();
  assert.deepEqual(model.subscribe(streamingCursor), { type: 'resync' });
  assert.deepEqual(model.snapshot().entries, (await readJsonl(file)).filter(e => e.type !== 'session'));
  observe(t, 'snapshots', { snapshotsBeforeDiscard: oldSnapshots.length, replayedCuts: cuts.length, finalMessages: final.entries.filter(e => e.type === 'message').map(e => ({ role: e.message.role, content: e.message.content })), pendingCompleted: final.inFlight.completed.length, epochResync: true, futureResync: true, expiredResync: true, serverRestartFromDisk: true, interruptedRestartFromDisk: true });
  model.dispose();
});

test('A6 UI values, pi timeouts, immediate child cancellation and host pending deadline', async t => {
  const e = await fixture(t);
  const rpc = await e.start({ ui: request => request.method === 'confirm' ? { confirmed: true } : { value: { select: 'B', input: 'typed', editor: 'edited\nlines' }[request.method] } });
  assert.equal((await rpc.command({ type: 'prompt', message: '/p0-ui' })).data.disposition, 'handled');
  const value = (await entries(rpc)).findLast(e => e.customType === 'p0-ui').data;
  assert.deepEqual({ ...value, elapsed: 0 }, { select: 'B', confirm: true, input: 'typed', editor: 'edited\nlines', elapsed: 0 });
  rpc.ui = undefined;
  await rpc.command({ type: 'prompt', message: '/p0-ui timeout' });
  const timed = (await entries(rpc)).findLast(e => e.customType === 'p0-ui').data;
  assert.ok(timed.elapsed >= 150);
  assert.deepEqual({ ...timed, elapsed: 0 }, { select: null, confirm: false, input: null, editor: null, elapsed: 0 });
  rpc.ui = () => ({ cancelled: true });
  await rpc.command({ type: 'prompt', message: '/p0-ui' });
  const cancelled = (await entries(rpc)).findLast(e => e.customType === 'p0-ui').data;
  assert.deepEqual({ ...cancelled, elapsed: 0 }, { select: null, confirm: false, input: null, editor: null, elapsed: 0 });
  rpc.ui = async () => { await new Promise(resolve => setTimeout(resolve, 40)); return { cancelled: true }; };
  await rpc.command({ type: 'prompt', message: '/p0-ui' });
  const pending = (await entries(rpc)).findLast(e => e.customType === 'p0-ui').data;
  assert.ok(pending.elapsed >= 140);
  assert.deepEqual({ ...pending, elapsed: 0 }, { select: null, confirm: false, input: null, editor: null, elapsed: 0 });
  observe(t, 'ui', { value, timed, cancelled, pending, editorTimeoutSupported: false, requests: rpc.events.filter(r => r.event.type === 'extension_ui_request' && ['select', 'confirm', 'input', 'editor'].includes(r.event.method)).map(r => ({ method: r.event.method, timeout: r.event.timeout })) });
});

test('A7 RPC and extension new/resume/fork/clone, forkFrom source hash and lock timing', async t => {
  const e = await fixture(t, { script: fallback });
  await control(e, { lockProbe: true });
  let rpc = await e.start();
  await rpc.promptAndWait('seed one'); await rpc.promptAndWait('seed two');
  const source = (await state(rpc)).sessionFile;
  const original = await readFile(source);
  await rpc.command({ type: 'prompt', message: '/p0-fork-file' });
  const staticFork = (await extLog(e)).find(x => x.type === 'forkFrom');
  assert.ok(existsSync(staticFork.target));
  assert.deepEqual(await readFile(source), original);
  const cases = [];
  for (const via of ['rpc', 'extension']) {
    for (const action of ['new', 'resume', 'fork', 'clone']) {
      if ((await state(rpc)).sessionFile !== source) await rpc.command({ type: 'switch_session', sessionPath: source });
      const before = (await extLog(e)).length;
      const users = (await entries(rpc)).filter(e => e.message?.role === 'user');
      const entryId = users.at(-1).id;
      const target = staticFork.target;
      const command = via === 'rpc' ? { new: { type: 'new_session' }, resume: { type: 'switch_session', sessionPath: target }, fork: { type: 'fork', entryId }, clone: { type: 'clone' } }[action] : { type: 'prompt', message: '/p0-replace ' + action + (action === 'resume' ? ' ' + target : action === 'fork' ? ' ' + entryId : '') };
      const result = await rpc.command(command);
      assert.equal(result.success, true);
      const current = await state(rpc);
      assert.notEqual(current.sessionFile, source);
      const events = (await extLog(e)).slice(before).filter(x => ['session_before_switch', 'session_before_fork', 'session_shutdown', 'session_start', 'lock_result'].includes(x.type));
      const shutdown = events.find(x => x.type === 'session_shutdown');
      const start = events.find(x => x.type === 'session_start');
      assert.equal(shutdown.targetSessionFile, current.sessionFile);
      assert.equal(start.previousSessionFile, source);
      assert.ok(events.indexOf(shutdown) < events.indexOf(start));
      const lock = events.find(x => x.type === 'lock_result');
      assert.equal(lock.at, action === 'resume' ? 'session_before_switch' : 'session_shutdown');
      assert.equal(lock.acquired, true);
      if (events.filter(x => x.type === 'session_start').length > 1) e.preserve = true;
      cases.push({ via, action, targetMatches: true, previousMatches: true, targetExistedAtShutdown: shutdown.targetExists, sequence: events.map(x => x.type), before: events[0] });
    }
  }
  await rpc.command({ type: 'switch_session', sessionPath: source });
  await control(e, { cancelResume: true });
  const cancelled = await rpc.command({ type: 'switch_session', sessionPath: staticFork.target });
  assert.equal(cancelled.data.cancelled, true);
  assert.equal((await state(rpc)).sessionFile, source);
  const targetBeforeCancel = await readFile(staticFork.target);
  await writeFile(join(e.root, 'lock-' + basename(staticFork.target)), 'external owner');
  await control(e, { lockProbe: true });
  const lockCancelled = await rpc.command({ type: 'switch_session', sessionPath: staticFork.target });
  assert.equal(lockCancelled.data.cancelled, true);
  assert.equal((await state(rpc)).sessionFile, source);
  assert.deepEqual(await readFile(staticFork.target), targetBeforeCancel);
  // The following lock name is unknowable before session_shutdown; force EEXIST in the probe there.
  await control(e, { lockProbe: true, forceLockFailure: true });
  let stopAfterStart;
  let blocked = false;
  let stoppedAfterStart = false;
  const sent = [];
  const controlledSend = async command => {
    if (blocked) return { rejected: 'blocked-after-lock-failure' };
    sent.push(command); return rpc.command(command);
  };
  rpc.onEvent(event => {
    if (event.type !== 'extension_ui_request' || !event.message?.startsWith('P0_LIFECYCLE:')) return;
    const life = JSON.parse(event.message.slice('P0_LIFECYCLE:'.length));
    if (life.type === 'session_shutdown' && life.targetSessionFile) {
      blocked = true;
      void controlledSend({ type: 'prompt', message: 'must not enter replacement session' });
    }
    if (life.type === 'session_start' && blocked) {
      stoppedAfterStart = true;
      stopAfterStart = rpc.stop({ graceMs: 100 });
    }
  });
  try { await rpc.command({ type: 'new_session' }); } catch (error) { assert.match(String(error), /closed/); }
  if (stopAfterStart) await stopAfterStart;
  assert.equal(stoppedAfterStart, true);
  assert.deepEqual(sent, []);
  assert.ok((await extLog(e)).some(x => x.type === 'lock_result' && x.acquired === false && x.error === 'EEXIST'));
  observe(t, 'sessionSwitch', { forkFromSourceUnchanged: true, cases, cancelResume: cancelled.data, occupiedResumeCancelled: lockCancelled.data, cancelledTargetUnchanged: true, failedLock: { blocked, stoppedAfterStart, furtherInputs: sent, exit: rpc.exitInfo }, events: (await extLog(e)).slice(-8) });
});

test('A8 collaboration replacement guards cancel RPC and extension paths; watchdog stops unexpected shutdown', async t => {
  const e = await fixture(t, { script: fallback });
  const caller = await e.write('caller.ts', `import { appendFileSync } from 'node:fs';
    import { join } from 'node:path';
    export default function(pi) {
      const record = value => appendFileSync(join(process.env.P0_A_ROOT, 'extension.jsonl'), JSON.stringify(value) + '\\n');
      for (const event of ['session_before_switch', 'session_before_fork']) pi.on(event, () => {
        record({ type: 'late_before_hook' }); return { cancel: false };
      });
      pi.registerCommand('p0-attempt', { description: 'Separate whitelist caller', handler: async (args, ctx) => {
        const [action, ...rest] = args.split(' ');
        let result;
        if (action === 'new') result = await ctx.newSession();
        if (action === 'resume') result = await ctx.switchSession(rest.join(' '));
        if (action === 'fork') result = await ctx.fork(rest[0]);
        if (action === 'clone') result = await ctx.fork(ctx.sessionManager.getLeafId(), { position: 'at' });
        record({ type: 'replacement_result', source: 'caller-extension', action, result });
      }});
    }`);
  const rpc = await e.start({ args: ['-e', caller] });
  await rpc.promptAndWait('guard seed');
  const file = (await state(rpc)).sessionFile;
  const bytes = await readFile(file);
  const userId = (await entries(rpc)).find(e => e.message?.role === 'user').id;
  const target = join(e.root, 'resume-copy.jsonl'); await copyFile(file, target);
  await control(e, { cancelAll: true });
  const results = [];
  for (const command of [{ type: 'new_session' }, { type: 'switch_session', sessionPath: target }, { type: 'fork', entryId: userId }, { type: 'clone' }, ...['new', 'resume ' + target, 'fork ' + userId, 'clone'].map(action => ({ type: 'prompt', message: '/p0-attempt ' + action }))]) {
    const result = await rpc.command(command);
    assert.equal(result.success, true);
    if (command.type !== 'prompt') assert.equal(result.data.cancelled, true);
    assert.equal((await state(rpc)).sessionFile, file);
    assert.deepEqual(await readFile(file), bytes);
    results.push({ command: command.type === 'prompt' ? command.message.split(' ').slice(0, 2).join(' ') : command.type, data: result.data });
  }
  const replacements = (await extLog(e)).filter(x => x.type === 'replacement_result');
  assert.equal(replacements.length, 4);
  assert.ok(replacements.every(x => x.result.cancelled && x.source === 'caller-extension'));
  assert.equal((await extLog(e)).some(x => x.type === 'late_before_hook'), false);
  assert.equal((await extLog(e)).some(x => x.type === 'session_shutdown'), false);
  await control(e, {});
  let shutdownSeen = false;
  let stop;
  rpc.onEvent(event => {
    if (event.type === 'extension_ui_request' && event.message?.startsWith('P0_LIFECYCLE:')) {
      const life = JSON.parse(event.message.slice('P0_LIFECYCLE:'.length));
      if (life.type === 'session_shutdown' && life.reason === 'new') { shutdownSeen = true; stop = rpc.stop({ graceMs: 100 }); }
    }
  });
  try { await rpc.command({ type: 'new_session' }); } catch (error) { assert.match(String(error), /closed/); }
  await stop;
  assert.equal(shutdownSeen, true);
  observe(t, 'replacementGuards', { results, extensionResults: replacements, fileUnchangedForCancelledPaths: true, unexpectedShutdown: shutdownSeen, exit: rpc.exitInfo });
});
