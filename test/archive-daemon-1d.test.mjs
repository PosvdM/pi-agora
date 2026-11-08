import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, appendFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startDaemon } from '../packages/daemon/dist/index.js';
import { connectHost } from '../packages/protocol/dist/client.js';
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
  const keys = ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA'];
  const saved = new Map(keys.map(key => [key, process.env[key]]));
  for (const key of keys) process.env[key] = path.join(home, key.toLowerCase());
  let daemon, client;
  t.after(async () => {
    try {
      client?.close();
      await daemon?.close({ force: true, timeoutMs: 3000 });
      await rm(home, { recursive: true, force: true });
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });
  await assertIsolatedTestHome(home);
  const driver = new ArchiveDriver();
  daemon = await startDaemon({ home, driver, readyTimeoutMs: 3000, idleReclaimMs: 60_000 });
  client = await connectHost({ home, as: 'host:cli', autoStart: false });
  const task = await client.request('POST', '/v1/tasks', { profile: 'explore', model: 'test/model', thinking: 'high', prompt: '只读测试', cwd: home }, { idempotencyKey: randomUUID() });
  const handle = await until(() => driver.handles[0]?.ready && driver.handles[0]);
  await until(async () => (await client.request('GET', `/v1/tasks/${task.taskId}`)).status === 'running');
  return { home, daemon, client, task, handle, base: `/v1/sessions/${task.agoraSessionId}` };
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
