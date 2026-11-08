import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, appendFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { request as httpRequest } from 'node:http';
import { startDaemon } from '../packages/daemon/dist/index.js';
import { connectHost } from '../packages/protocol/dist/client.js';
import { runArchiveCli, readSse } from '../packages/cli/dist/archive.js';
import { SessionViews } from '../packages/daemon/dist/sessions.js';
import { openArchive } from '../packages/archive/dist/index.js';
import { assertIsolatedTestHome } from './fixtures/test-home.mjs';

async function until(read, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await read(); if (value) return value; await delay(10); }
  assert.fail('等待存档状态超时');
}
async function http(url, token, method, route, body) {
  const response = await fetch(url + route, { method, headers: { 'Agora-Protocol': '1', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  return { status: response.status, body: await response.json() };
}
class ArchiveDriver {
  handles = [];
  async start(spec) {
    const listeners = new Set(), exits = new Set();
    let finish;
    const identity = { pid: 88000 + this.handles.length, startTime: '模拟身份', runId: spec.runId, instanceId: spec.instanceId };
    const handle = {
      spec, identity, entries: [], leafId: null, ready: false, stopped: false,
      exited: new Promise(resolve => { finish = resolve; }),
      onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      onExit(listener) { exits.add(listener); return () => exits.delete(listener); },
      emit(event) { for (const listener of listeners) listener(event); },
      markReady() { this.ready = true; }, respondUi() {},
      diagnostics() { return { identity, reason: '测试退出', code: 0, signal: null, cleanupConfirmed: true, events: [], activeTools: [], possibleSideEffects: [], stderr: '', stopTrace: [], warnings: [] }; },
      async send(command) {
        await this.boot;
        let data = {};
        if (command.type === 'get_available_models') data = { models: [{ provider: 'test', id: 'model' }] };
        if (command.type === 'get_state') data = { model: 'test/model', thinkingLevel: spec.thinking, sessionFile: spec.sessionFile, sessionId: 'pi_test' };
        if (command.type === 'get_entries') {
          const since = command.since ? this.entries.findIndex(entry => entry.id === command.since) + 1 : 0;
          data = { entries: this.entries.slice(since), leafId: this.leafId };
        }
        if (command.type === 'get_last_assistant_text') data = { text: '归档完成' };
        if (command.type === 'get_session_stats') data = {};
        return { type: 'response', command: command.type, success: true, data };
      },
      async stop() {
        if (!this.stopped) {
          this.stopped = true;
          const exit = { identity, code: 0, signal: null, reason: '测试退出', cleanupConfirmed: true };
          for (const listener of exits) listener(exit);
          finish(exit);
        }
        return { coverage: 'snapshot_visible', steps: [], leftovers: [] };
      },
    };
    this.handles.push(handle);
    handle.boot = (async () => {
      const launch = await http(spec.env.AGORA_URL, undefined, 'POST', '/v1/auth/launch', { ticket: spec.env.AGORA_LAUNCH_TICKET });
      assert.equal(launch.status, 200); handle.token = launch.body.token;
      const ready = await http(spec.env.AGORA_URL, handle.token, 'POST', `/v1/runs/${spec.runId}/ready`, { tools: spec.tools, model: spec.model, thinking: spec.thinking, extensionVersion: '0.1.0' });
      assert.equal(ready.status, 200);
    })();
    return handle;
  }
  async recoverOldRun() { return { coverage: 'snapshot_visible', steps: [], leftovers: [] }; }
}
async function setup(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'agora-archive-http-'));
  const saved = new Map(['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA'].map(key => [key, process.env[key]]));
  process.env.HOME = process.env.USERPROFILE = path.join(home, 'user');
  process.env.APPDATA = path.join(home, 'user', 'AppData', 'Roaming');
  process.env.LOCALAPPDATA = path.join(home, 'user', 'AppData', 'Local');
  let daemon, client;
  const extra = [];
  t.after(async () => {
    try {
      client?.close();
      for (const cleanup of extra.reverse()) await cleanup();
      await daemon?.close({ force: true, timeoutMs: 3000 });
      await rm(home, { recursive: true, force: true });
    } finally { for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
  });
  await assertIsolatedTestHome(home);
  const driver = new ArchiveDriver();
  daemon = await startDaemon({ home, driver, readyTimeoutMs: 3000, idleReclaimMs: 60_000 });
  client = await connectHost({ home, as: 'host:cli', autoStart: false });
  const task = await client.request('POST', '/v1/tasks', { profile: 'explore', model: 'test/model', thinking: 'high', prompt: '只读测试', cwd: home }, { idempotencyKey: randomUUID() });
  const handle = await until(() => driver.handles[0]?.ready && driver.handles[0]);
  await until(async () => (await client.request('GET', `/v1/tasks/${task.taskId}`)).status === 'running');
  return { home, daemon, client, task, handle, extra, base: `/v1/sessions/${task.agoraSessionId}` };
}
async function writeEntries(f, entries) {
  f.handle.entries = entries;
  f.handle.leafId = entries.at(-1)?.id ?? null;
  await mkdir(path.dirname(f.handle.spec.sessionFile), { recursive: true });
  await writeFile(f.handle.spec.sessionFile, [{ type: 'session', version: 3, id: 'pi_test', timestamp: new Date().toISOString(), cwd: f.home }, ...entries].map(value => JSON.stringify(value)).join('\n') + '\n');
  f.handle.emit({ type: 'entry_appended' });
}
function entry(id, parentId, timestamp = 12345) {
  return { type: 'message', id, parentId, timestamp: new Date(timestamp).toISOString(), message: { role: 'assistant', timestamp, content: [{ type: 'text', text: id }] } };
}

test('会话 HTTP 快照、历史分页、诊断、校验与占用，子代理不能读全量会话', { timeout: 20_000 }, async t => {
  const f = await setup(t);
  const entries = [entry('one', null), entry('two', 'one', 12346), entry('three', 'two', 12347)];
  await writeEntries(f, entries);
  await until(async () => (await f.client.request('GET', f.base + '/snapshot')).entries.length === 3);
  const snapshot = await f.client.request('GET', f.base + '/snapshot?limit=2');
  assert.deepEqual(snapshot.entries.map(value => value.id), ['two', 'three']);
  assert.equal(snapshot.leafId, 'three');
  assert.equal(snapshot.historyBefore, 'two');
  const history = await f.client.request('GET', f.base + '/history?before=two&limit=2');
  assert.deepEqual(history.entries.map(value => value.id), ['one']);
  assert.equal(history.historyBefore, null);
  const blocked = await http(f.daemon.url, f.handle.token, 'GET', f.base + '/snapshot');
  assert.equal(blocked.status, 403);
  const before = createHash('sha256').update(await readFile(f.handle.spec.sessionFile)).digest('hex');
  const verified = await f.client.request('POST', '/v1/archive/verify', { sessionId: f.task.agoraSessionId }, { idempotencyKey: randomUUID() });
  assert.equal(verified.state, 'ok');
  assert.equal(createHash('sha256').update(await readFile(f.handle.spec.sessionFile)).digest('hex'), before);
  const status = await f.client.request('GET', '/v1/status');
  assert.ok(status.archiveBytes >= Buffer.byteLength(await readFile(f.handle.spec.sessionFile)));
  await f.client.request('POST', `/v1/tasks/${f.task.taskId}/stop`, {}, { idempotencyKey: randomUUID() });
  await f.daemon.tasks.flush();
  const diagnostic = await f.client.request('GET', f.base + '/diagnostics');
  assert.ok(Array.isArray(diagnostic) ? diagnostic.length >= 1 : diagnostic.items?.length >= 1);
});

test('daemon 重启后的历史终态快照能够订阅并完成 SSE，旧水位回放后 EOF', { timeout: 20_000 }, async t => {
  const f = await setup(t);
  await writeEntries(f, [entry('persisted', null)]);
  const original = await f.client.request('GET', f.base + '/snapshot');
  await f.client.request('POST', `/v1/tasks/${f.task.taskId}/stop`, {}, { idempotencyKey: randomUUID() });
  await f.daemon.tasks.flush();
  f.client.close();
  await f.daemon.close({ force: true, timeoutMs: 3000 });
  await assertIsolatedTestHome(f.home);
  const restarted = await startDaemon({ home: f.home, driver: new ArchiveDriver(), readyTimeoutMs: 3000 });
  let client = await connectHost({ home: f.home, as: 'host:cli', autoStart: false });
  f.extra.push(async () => { client.close(); await restarted.close({ force: true, timeoutMs: 3000 }); });
  for (const status of ['completed', 'stopped']) {
    restarted.store.run('UPDATE agora_sessions SET status=? WHERE id=?', status, f.task.agoraSessionId);
    const snapshot = await client.request('GET', f.base + '/snapshot');
    assert.notEqual(snapshot.cursor.epoch, original.cursor.epoch);
    assert.deepEqual(snapshot.entries.map(value => value.id), ['persisted']);
    assert.equal(snapshot.inFlight.phase, 'idle');
    const replay = await fetch(restarted.url + f.base + `/stream?epoch=${encodeURIComponent(snapshot.cursor.epoch)}&afterSeq=0`, {
      headers: { 'Agora-Protocol': '1', Authorization: `Bearer ${client.token}` }, signal: AbortSignal.timeout(2000),
    });
    const text = await replay.text();
    assert.match(text, /agora_entries/); assert.doesNotMatch(text, /resync/);
    const output = [];
    await runArchiveCli({ command: 'tail', operand: f.task.agoraSessionId, rest: [], options: new Map(), home: f.home, io: { out: value => output.push(JSON.parse(value)) } }, {
      available: async () => true, connect: async () => client,
      fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.any([options.signal, AbortSignal.timeout(2000)]) }),
      open: async () => { assert.fail('历史在线 tail 不能离线降级'); },
    });
    assert.equal(output[0].status, status);
    assert.equal(output[0].entries[0].id, 'persisted');
    // runArchiveCli 拥有连接并关闭它；下一轮创建新的已认证连接。
    if (status === 'completed') {
      client = await connectHost({ home: f.home, as: 'host:cli', autoStart: false });
    }
  }
  // 较新的已退出 run 不能掩盖较旧、仍未确认清理的写者。
  restarted.store.run(`INSERT INTO process_runs(id,agora_session_id,daemon_instance_id,state,started_at,exited_at,cleanup_error)
    SELECT 'uncertain',agora_session_id,daemon_instance_id,'exited','2000-01-01','2000-01-02','清理待确认'
    FROM process_runs WHERE agora_session_id=? LIMIT 1`, f.task.agoraSessionId);
  const fresh = new SessionViews(restarted.store, 'fresh-check');
  try {
    const pending = await fresh.snapshot(f.task.agoraSessionId);
    assert.equal(pending.cursor.epoch, 'fresh-check:uncertain');
    assert.equal(pending.inFlight.phase, 'stopping');
  } finally { await fresh.close(); }
});

test('tail 以短有效期跨越真实鉴权检查并持续续期，无小时级等待', { timeout: 20_000 }, async t => {
  const f = await setup(t);
  const conn = f.daemon.auth.connections.get(f.client.token);
  const originalRefresh = f.daemon.auth.refresh.bind(f.daemon.auth);
  let renewals = 0, streams = 0;
  f.daemon.auth.refresh = connection => {
    const response = originalRefresh(connection);
    connection.expiresAt = Date.now() + 3000;
    renewals++;
    return { ...response, expiresAt: new Date(connection.expiresAt).toISOString() };
  };
  conn.expiresAt = Date.now() + 3000;
  // 客户端读到短期限；认证和 SSE 的每秒守卫仍由真实 daemon 执行。
  const client = {
    ...f.client,
    get token() { return f.client.token; },
    get expiresAt() { return new Date(conn.expiresAt).toISOString(); },
  };
  const initialDeadline = conn.expiresAt;
  const output = [];
  await runArchiveCli({ command: 'tail', operand: f.task.agoraSessionId, rest: [], options: new Map(), home: f.home, io: { out: value => output.push(JSON.parse(value)) } }, {
    available: async () => true, connect: async () => client,
    open: async () => { assert.fail('续期不应离线降级'); },
    fetch: async (url, options) => {
      streams++;
      const response = fetch(url, { ...options, signal: AbortSignal.any([options.signal, AbortSignal.timeout(12_000)]) });
      f.handle.emit({ type: 'thinking_level_changed', level: 'high' });
      if (streams === 4) await f.client.request('POST', `/v1/tasks/${f.task.taskId}/stop`, {}, { idempotencyKey: randomUUID() });
      return response;
    },
  });
  assert.ok(Date.now() > initialDeadline);
  assert.ok(renewals >= 4); assert.equal(streams, 4);
  const events = output.slice(1).map(value => value.data);
  assert.ok(events.some(value => value.event.type === 'agora_run' && value.event.phase === 'exited'));
  assert.deepEqual(events.map(value => value.cursor.seq), [...new Set(events.map(value => value.cursor.seq))].sort((a, b) => a - b));
});

test('真实 HTTP 正常消费 128KiB message_end，write(false) 后继续送达后继事件', { timeout: 20_000 }, async t => {
  const f = await setup(t);
  const snapshot = await f.client.request('GET', f.base + '/snapshot');
  const controller = new AbortController();
  t.after(() => controller.abort());
  const pending = fetch(f.daemon.url + f.base + `/stream?epoch=${encodeURIComponent(snapshot.cursor.epoch)}&afterSeq=${snapshot.cursor.seq}`, {
    headers: { 'Agora-Protocol': '1', Authorization: `Bearer ${f.client.token}` }, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
  });
  f.handle.emit({ type: 'thinking_level_changed', level: 'high' });
  const response = await pending;
  const state = f.daemon.tasks.sessions.states.get(f.task.agoraSessionId);
  const serverResponse = [...state.clients][0].response;
  const original = serverResponse.write;
  let backpressure = 0;
  serverResponse.write = function (...args) {
    const writable = original.apply(this, args);
    if (!writable && Buffer.byteLength(args[0]) >= 128 * 1024) backpressure++;
    return writable;
  };
  const payload = 'x'.repeat(128 * 1024);
  const messages = [];
  const reading = (async () => {
    for await (const event of readSse(response.body)) {
      messages.push(event.data);
      if (event.data.event.type === 'thinking_level_changed' && event.data.event.level === 'low') break;
    }
  })();
  f.handle.emit({ type: 'message_end', message: { role: 'assistant', timestamp: 100, content: [{ type: 'text', text: payload }] } });
  f.handle.emit({ type: 'thinking_level_changed', level: 'low' });
  await reading;
  assert.ok(backpressure > 0);
  assert.equal(messages.find(value => value.event.type === 'message_end').event.message.content[0].text, payload);
  assert.equal(messages.at(-1).event.level, 'low');
  await until(() => state.clients.size === 0);
  assert.equal(serverResponse.listenerCount('drain'), 0);
});

test('真实 HTTP 多 MiB 历史终态回放按序排空，所有大帧之后返回 EOF', { timeout: 20_000 }, async t => {
  const f = await setup(t);
  const snapshot = await f.client.request('GET', f.base + '/snapshot');
  const payload = 'x'.repeat(128 * 1024);
  for (let index = 0; index < 32; index++) f.handle.emit({ type: 'thinking_level_changed', level: 'high', index, payload });
  await f.client.request('POST', `/v1/tasks/${f.task.taskId}/stop`, {}, { idempotencyKey: randomUUID() });
  await f.daemon.tasks.flush();
  const response = await fetch(f.daemon.url + f.base + `/stream?epoch=${encodeURIComponent(snapshot.cursor.epoch)}&afterSeq=${snapshot.cursor.seq}`, {
    headers: { 'Agora-Protocol': '1', Authorization: `Bearer ${f.client.token}` }, signal: AbortSignal.timeout(5000),
  });
  const events = [];
  for await (const event of readSse(response.body)) events.push(event.data);
  const frames = events.filter(value => value.event.payload);
  assert.deepEqual(frames.map(value => value.event.index), Array.from({ length: 32 }, (_, index) => index));
  assert.ok(frames.every(value => value.event.payload === payload));
  assert.ok(events.some(value => value.event.type === 'agora_run' && value.event.phase === 'exited'));
  assert.equal(events.at(-1).event.type, 'agora_status');
  assert.deepEqual(events.map(value => value.cursor.seq), [...new Set(events.map(value => value.cursor.seq))].sort((a, b) => a - b));
});

test('真实 HTTP 暂停读者的实时队列有界，主动取消移除 drain 和会话监听', { timeout: 20_000 }, async t => {
  const f = await setup(t);
  const payload = 'x'.repeat(128 * 1024);
  for (const overflow of [false, true]) {
    const snapshot = await f.client.request('GET', f.base + '/snapshot');
    let request;
    const pending = new Promise((resolve, reject) => {
      request = httpRequest(f.daemon.url + f.base + `/stream?epoch=${encodeURIComponent(snapshot.cursor.epoch)}&afterSeq=${snapshot.cursor.seq}`, {
        headers: { 'Agora-Protocol': '1', Authorization: `Bearer ${f.client.token}` },
      }, response => { response.pause(); response.on('error', () => {}); resolve(response); });
      request.on('error', reject);
      request.end();
    });
    t.after(() => request.destroy());
    f.handle.emit({ type: 'thinking_level_changed', level: 'high' });
    const incoming = await pending;
    const state = f.daemon.tasks.sessions.states.get(f.task.agoraSessionId);
    const serverResponse = [...state.clients][0].response;
    f.handle.emit({ type: 'thinking_level_changed', level: 'high', payload });
    assert.equal(serverResponse.writableEnded, false);
    assert.equal(serverResponse.listenerCount('drain'), 1);
    for (let index = 0; index < (overflow ? 12 : 2); index++) f.handle.emit({ type: 'thinking_level_changed', level: 'high', payload, index });
    if (overflow) assert.equal(serverResponse.destroyed, true);
    else incoming.destroy();
    await until(() => state.clients.size === 0);
    assert.equal(serverResponse.listenerCount('drain'), 0);
    assert.equal(serverResponse.listenerCount('error'), 0);
    incoming.destroy(); request.destroy();
  }

});

test('被接管子任务以 user 为会话父节点，在线离线 get/list 使用同形元数据', { timeout: 20_000 }, async t => {
  const f = await setup(t);
  await writeEntries(f, [entry('taken-message', null)]);
  const ordinary = await f.client.request('GET', f.base);
  assert.equal(ordinary.takenOver, false);
  const parent = await f.client.request('POST', '/v1/tasks', { profile: 'explore', model: 'test/model', prompt: '父任务', cwd: f.home }, { idempotencyKey: randomUUID() });
  f.daemon.store.run("UPDATE tasks SET parent_task_id=?,taken_over_from='original-agent',convener_id='user' WHERE id=?", parent.taskId, f.task.taskId);
  f.daemon.store.run("UPDATE agora_sessions SET convener_id='user' WHERE id=?", f.task.agoraSessionId);
  const detail = await f.client.request('GET', f.base);
  const list = await f.client.request('GET', '/v1/sessions');
  const online = list.items.find(item => item.agoraSessionId === f.task.agoraSessionId);
  assert.deepEqual(detail.parent, { kind: 'user' });
  assert.equal(detail.takenOver, true);
  assert.equal(detail.isCurrent, true);
  assert.equal(f.daemon.store.task(f.task.taskId).parent_task_id, parent.taskId);
  const reader = await openArchive({ home: f.home, apiVersion: 1 });
  try {
    const offline = await reader.getSession(f.task.agoraSessionId);
    const offlineList = (await reader.listSessions()).items.find(item => item.agoraSessionId === f.task.agoraSessionId);
    for (const key of ['parent', 'parentDiagnostics', 'parentPiSessionId', 'inheritsFrom', 'inheritReason', 'isCurrent', 'takenOver', 'usage']) {
      for (const item of [online, offline, offlineList]) assert.deepEqual(item[key], detail[key], key);
    }
    const parentDetail = await reader.getSession(parent.agoraSessionId);
    assert.equal(parentDetail.takenOver, false);
  } finally { reader.close(); }
});

test('会话尾行截断的全量校验只读，并保留完整行', { timeout: 20_000 }, async t => {
  const f = await setup(t);
  await writeEntries(f, [entry('complete', null)]);
  await appendFile(f.handle.spec.sessionFile, '{"type":"message","id":"cut"');
  const bytes = await readFile(f.handle.spec.sessionFile);
  const result = await f.client.request('POST', '/v1/archive/verify', { sessionId: f.task.agoraSessionId }, { idempotencyKey: randomUUID() });
  assert.equal(result.state, 'partial');
  assert.ok(result.diagnostics.length > 0);
  assert.deepEqual(await readFile(f.handle.spec.sessionFile), bytes);
  const snapshot = await f.client.request('GET', f.base + '/snapshot');
  assert.deepEqual(snapshot.entries.map(value => value.id), ['complete']);
});

test('会话 SSE 过期或未来游标返回 resync，不接受未授权连接', { timeout: 20_000 }, async t => {
  const f = await setup(t);
  const snapshot = await f.client.request('GET', f.base + '/snapshot');
  const response = await fetch(f.daemon.url + f.base + `/stream?epoch=${encodeURIComponent(snapshot.cursor.epoch)}&afterSeq=${snapshot.cursor.seq + 1}`, { headers: { 'Agora-Protocol': '1', Authorization: `Bearer ${f.client.token}` }, signal: AbortSignal.timeout(3000) });
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.match(text, /event: resync/);
  assert.doesNotMatch(text, /event: session/);
  const denied = await http(f.daemon.url, f.handle.token, 'GET', f.base + '/stream');
  assert.equal(denied.status, 403);
});
