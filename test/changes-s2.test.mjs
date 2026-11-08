import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { openStore } from '../packages/daemon/dist/store.js';
import { Auth } from '../packages/daemon/dist/auth.js';
import { createHttpServer } from '../packages/daemon/dist/server.js';
import { changesCursor, readChanges, pruneChanges, streamChanges } from '../packages/daemon/dist/changes.js';
import { listSessions, sessionDetail } from '../packages/daemon/dist/session-list.js';

const OLD = '2020-01-01T00:00:00.000Z';
async function database(t) {
  const home = await mkdtemp(join(tmpdir(), 'agora-changes-'));
  const store = await openStore(home);
  t.after(async () => { store.close(); await rm(home, { recursive: true, force: true }); });
  return store;
}
function main(store, id = 'main') {
  store.run('INSERT INTO principals(id,type,pi_session_id,lease_connection_id,lease_expires_at,created_at) VALUES(?,?,?,?,?,?)', id, 'agent:main', `pi-${id}`, `cn-${id}`, Date.now() + 60_000, OLD);
}
function seed(store, id, options = {}) {
  const parent = options.parent ?? null;
  const convener = options.convener ?? (parent ? `child-${parent}` : 'main');
  const status = options.status ?? 'completed';
  store.transaction(() => {
    store.run("INSERT INTO principals(id,type,created_at) VALUES(?,'agent:child',?)", `child-${id}`, OLD);
    store.run("INSERT INTO agora_sessions(id,task_id,principal_id,session_file,convener_id,profile,model,thinking,cwd,status,created_at) VALUES(?,?,?,?,?,'explore','test/model','high',?,?,?)", id, `task-${id}`, `child-${id}`, join(store.home, `${id}.jsonl`), convener, store.home, status, OLD);
    store.run("INSERT INTO tasks(id,agora_session_id,convener_id,requested_by,title,prompt,model,thinking,profile,cwd,notify,status,parent_task_id,created_at,updated_at) VALUES(?,?,?,?,?,'任务书','test/model','high','explore',?,'silent',?,?,?,?)", `task-${id}`, id, convener, convener, `标题 ${id}`, store.home, status, parent ? `task-${parent}` : null, OLD, options.at ?? OLD);
    store.change('task', `task-${id}`);
    store.run('UPDATE changes SET created_at=? WHERE seq=(SELECT MAX(seq) FROM changes)', options.at ?? OLD);
  });
}
const host = { type: 'host:pane' };
const params = value => new URLSearchParams(value);
async function httpFixture(t) {
  const store = await database(t);
  main(store);
  main(store, 'other');
  const auth = await Auth.create(store, 'instance');
  store.run("UPDATE principals SET lease_connection_id='cn-main',lease_expires_at=? WHERE id='main'", Date.now() + 60_000);
  const closing = new AbortController();
  const tasks = { status(conn, taskId) { auth.requireAgent(conn); return store.task(taskId); } };
  const context = { store, auth, tasks, requests: { close() {} }, instanceId: 'instance', closing: closing.signal, async close() { closing.abort(); } };
  const server = createHttpServer(context);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { closing.abort(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  function connection(type) {
    const conn = { token: randomBytes(32).toString('base64url'), type, principalId: type === 'agent:main' ? 'main' : type, connectionId: type === 'agent:main' ? 'cn-main' : `cn-${type}`, expiresAt: Date.now() + 60_000 };
    auth.connections.set(conn.token, conn);
    return conn;
  }
  const pane = connection('host:pane');
  async function get(path, conn = pane) {
    return fetch(url + path, { headers: { 'Agora-Protocol': '1', Authorization: `Bearer ${conn.token}` }, signal: AbortSignal.timeout(5000) });
  }
  return { store, auth, closing, pane, connection, get };
}
function streamPath(store, seq = 0, epoch = changesCursor(store).epoch) { return `/v1/changes?epoch=${epoch}&afterSeq=${seq}`; }
async function firstEvent(response) {
  const reader = response.body.getReader();
  let text = '';
  while (!text.includes('\n\n')) {
    const part = await reader.read();
    if (part.done) break;
    text += new TextDecoder().decode(part.value);
  }
  return { reader, text };
}
async function closed(reader) {
  try { while (!(await reader.read()).done) {} } catch (error) { assert.match(String(error), /terminated|abort/i); }
}

test('数据库重启保留 epoch/head，epoch 不符、过期、future 和中间缺口均 reset', { timeout: 10_000 }, async t => {
  const store = await database(t);
  main(store);
  seed(store, 'one');
  const before = changesCursor(store);
  const reopened = await openStore(store.home);
  assert.deepEqual(changesCursor(reopened), before);
  reopened.close();
  assert.equal(readChanges(store, 'wrong', 0).reset, true);
  assert.equal(readChanges(store, before.epoch, 2).reset, true);
  assert.equal(readChanges(store, before.epoch, 0).rows[0].object_id, 'task-one');
  store.change('task', 'second');
  store.change('task', 'third');
  store.run('DELETE FROM changes WHERE seq=2');
  assert.equal(readChanges(store, before.epoch, 0).reset, true);
  store.run('DELETE FROM changes WHERE seq=1');
  assert.equal(readChanges(store, before.epoch, 0).reset, true);
  assert.equal(readChanges(store, before.epoch, 2).reset, false);
});

test('清理同时满足七天与十万条，冷节点修订号在清理及重启后保留', { timeout: 15_000 }, async t => {
  const store = await database(t);
  main(store);
  seed(store, 'cold');
  store.run(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<100000)
    INSERT INTO changes(epoch,object_type,object_id,created_at) SELECT (SELECT value FROM settings WHERE key='epoch'),'noise',CAST(i AS TEXT),? FROM n`, new Date().toISOString());
  const original = sessionDetail(store, 'cold');
  assert.equal(original.revision, 1);
  assert.equal(pruneChanges(store), 1);
  assert.equal(store.get('SELECT COUNT(*) AS n FROM changes').n, 100000);
  assert.equal(pruneChanges(store), 0);
  store.change('noise', 'fresh');
  assert.equal(pruneChanges(store), 0, '七天以内的记录不能清理');
  store.run('UPDATE changes SET created_at=? WHERE seq=2', OLD);
  assert.equal(pruneChanges(store), 1);
  assert.equal(readChanges(store, changesCursor(store).epoch, 0).reset, true);
  assert.equal(readChanges(store, changesCursor(store).epoch, 2).reset, false);
  assert.deepEqual(sessionDetail(store, 'cold'), original);
  const reopened = await openStore(store.home);
  try { assert.deepEqual(sessionDetail(reopened, 'cold'), original); assert.deepEqual(changesCursor(reopened), changesCursor(store)); }
  finally { reopened.close(); }
});

test('按父节点分页绑定 parent、snapshot、openNodeId、recentSince 和调用者', async t => {
  const store = await database(t);
  main(store);
  seed(store, 'a'); seed(store, 'b'); seed(store, 'user', { convener: 'user' });
  seed(store, 'child', { parent: 'a' });
  const page = listSessions(store, host, params('parent=pane:session:pi-main'), 1);
  assert.equal(page.items[0].agoraSessionId, 'a');
  assert.ok(page.nextCursor);
  const second = listSessions(store, host, params({ parent: 'pane:session:pi-main', cursor: page.nextCursor }), 1);
  assert.deepEqual(second.items.map(item => item.agoraSessionId), ['b']);
  for (const filter of ['parent=agora:root:user-tasks', 'parent=agora:session:a', 'snapshot=1&openNodeId=agora:session:a', '']) {
    assert.throws(() => listSessions(store, host, params(`${filter}&cursor=${page.nextCursor}`), 1), error => error.code === 'invalid_params');
  }
  assert.throws(() => listSessions(store, { type: 'agent:main', principalId: 'main' }, params({ parent: 'pane:session:pi-main', cursor: page.nextCursor }), 1), /游标/);
  assert.throws(() => listSessions(store, host, params('parent=agora:session:a&cursor=1'), 1), /游标/);
  assert.deepEqual(listSessions(store, host, params('parent=agora:session:a'), 50).items.map(item => item.agoraSessionId), ['child']);
  assert.equal(listSessions(store, host, params('parent=agora:root:user-tasks'), 50).items[0].agoraSessionId, 'user');
  const own = listSessions(store, { type: 'agent:main', principalId: 'main' }, params(''), 50);
  assert.deepEqual(own.items.map(item => item.agoraSessionId), ['a', 'b']);
  assert.equal(own.items[0].hasChildren, true);
  assert.equal(own.items[0].childCount, 1);
  const hot = listSessions(store, host, params('snapshot=1&openNodeId=agora:session:a&openNodeId=agora:session:b'), 1);
  assert.ok(hot.nextCursor);
  assert.throws(() => listSessions(store, host, params({ snapshot: '1', openNodeId: 'agora:session:a', cursor: hot.nextCursor }), 1), /游标/);
  assert.throws(() => listSessions(store, host, params({ snapshot: '1', recentSince: OLD, cursor: hot.nextCursor }), 1), /游标/);
});

test('热快照包含祖先与状态映射，继承会话保留召集关系，冷节点不混入', async t => {
  const store = await database(t);
  main(store);
  seed(store, 'ancestor'); seed(store, 'middle', { parent: 'ancestor' });
  seed(store, 'hot', { parent: 'middle', status: 'quota_paused' });
  seed(store, 'cold'); seed(store, 'open'); seed(store, 'recent', { at: '2025-01-01T00:00:00.000Z' });
  const snapshot = listSessions(store, host, params('snapshot=1&openNodeId=agora:session:open&recentSince=2024-01-01T00:00:00Z'), 50);
  assert.deepEqual(snapshot.items.map(item => item.agoraSessionId), ['ancestor', 'middle', 'hot', 'open', 'recent']);
  assert.equal(snapshot.items[0].childCount, 1);
  assert.equal(snapshot.items[0].hasChildren, true);
  assert.equal(snapshot.items[2].parentId, 'agora:session:middle');
  store.transaction(() => {
    store.run("INSERT INTO agora_sessions(id,task_id,principal_id,session_file,convener_id,profile,model,thinking,cwd,status,created_at,inherits_from) SELECT 'replacement',task_id,'new-child',?,'main',profile,model,thinking,cwd,status,created_at,id FROM agora_sessions WHERE id='ancestor'", join(store.home, 'replacement.jsonl'));
    store.run("UPDATE tasks SET agora_session_id='replacement' WHERE id='task-ancestor'");
    store.change('task', 'task-ancestor');
    store.change('session', 'replacement');
  });
  assert.equal(sessionDetail(store, 'ancestor').parentId, 'pane:session:pi-main');
  assert.equal(sessionDetail(store, 'replacement').parentId, 'pane:session:pi-main');
  assert.equal(sessionDetail(store, 'middle').parentId, 'agora:session:replacement');
  assert.equal(sessionDetail(store, 'ancestor').hasChildren, false);
  assert.equal(sessionDetail(store, 'replacement').hasChildren, true);
  assert.equal(sessionDetail(store, 'replacement').revision, changesCursor(store).seq);
  assert.deepEqual(listSessions(store, host, params('snapshot=1'), 50).items.map(item => item.agoraSessionId), ['middle', 'hot', 'replacement']);
});

test('每页内容和 changesCursor 使用同一 WAL 事务切点', async t => {
  const store = await database(t);
  main(store); seed(store, 'before');
  const writer = await openStore(store.home);
  const get = store.get.bind(store);
  let injected = false;
  store.get = (sql, ...args) => {
    const result = get(sql, ...args);
    if (!injected && sql === "SELECT value FROM settings WHERE key='epoch'") {
      injected = true;
      seed(writer, 'after');
    }
    return result;
  };
  try {
    const page = listSessions(store, host, params(''), 50);
    assert.equal(page.changesCursor.seq, 1);
    assert.deepEqual(page.items.map(item => item.agoraSessionId), ['before']);
    assert.equal(changesCursor(writer).seq, 2);
    assert.deepEqual(readChanges(writer, page.changesCursor.epoch, page.changesCursor.seq).rows.map(row => row.object_id), ['task-after']);
  } finally { store.get = get; writer.close(); }
});

test('HTTP 列表兼容无 parent、默认 50/max200、主会话权限及丰富详情', { timeout: 10_000 }, async t => {
  const f = await httpFixture(t);
  for (let n = 0; n < 52; n++) seed(f.store, `session-${n}`);
  seed(f.store, 'private', { convener: 'other' });
  const response = await f.get('/v1/sessions');
  assert.equal(response.status, 200);
  const page = await response.json();
  assert.equal(page.items.length, 50);
  assert.ok(page.nextCursor);
  const detail = await (await f.get('/v1/sessions/session-0')).json();
  for (const key of ['parentId', 'title', 'kind', 'hasChildren', 'childCount', 'lastActivityAt', 'statusDetail', 'archiveState', 'revision']) assert.ok(key in detail, key);
  assert.equal(detail.revision, 1);
  assert.equal((await f.get('/v1/sessions?limit=201')).status, 400);
  const mainConn = f.connection('agent:main');
  const mine = await (await f.get('/v1/sessions?limit=200', mainConn)).json();
  assert.equal(mine.items.length, 52);
  assert.ok(!mine.items.some(item => item.agoraSessionId === 'private'));
  const scoped = await (await f.get('/v1/sessions?snapshot=1&openNodeId=agora:session:private', mainConn)).json();
  assert.deepEqual(scoped.items, []);
  assert.equal((await f.get('/v1/sessions', f.connection('agent:child'))).status, 403);
});

test('SSE 仅 host 可读；事件字段、reset 关闭、实时追加和 shutdown', { timeout: 10_000 }, async t => {
  const f = await httpFixture(t);
  seed(f.store, 'one');
  assert.equal((await f.get(streamPath(f.store), f.connection('agent:main'))).status, 403);
  assert.equal((await f.get(streamPath(f.store), f.connection('agent:child'))).status, 403);
  assert.equal((await f.get('/v1/changes?afterSeq=0')).status, 400);
  for (const path of [streamPath(f.store, 0, 'wrong'), streamPath(f.store, 2)]) {
    const response = await f.get(path);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), `event: reset\ndata: ${JSON.stringify({ epoch: changesCursor(f.store).epoch })}\n\n`);
  }
  const response = await f.get(streamPath(f.store), f.connection('host:cli'));
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const { reader, text } = await firstEvent(response);
  assert.match(text, /^event: change\ndata: /);
  assert.deepEqual(JSON.parse(text.split('data: ')[1].trim()), { cursor: changesCursor(f.store), objectType: 'task', objectId: 'task-one', tombstone: false });
  f.store.change('session', 'gone', true);
  const next = new TextDecoder().decode((await reader.read()).value);
  assert.match(next, /"objectId":"gone","tombstone":true/);
  f.closing.abort();
  await closed(reader);
});

for (const reason of ['expire', 'revoke']) test(`SSE 空闲期间连接 ${reason} 后终止`, { timeout: 5000 }, async t => {
  const f = await httpFixture(t);
  seed(f.store, 'one');
  const response = await f.get(streamPath(f.store));
  const { reader } = await firstEvent(response);
  if (reason === 'expire') f.pane.expiresAt = 0;
  else f.auth.connections.delete(f.pane.token);
  await closed(reader);
});

test('过期 SSE 只发送 reset 并关闭，数据库读取批次不超过 256', { timeout: 5000 }, async t => {
  const f = await httpFixture(t);
  for (let n = 0; n < 300; n++) f.store.change('task', `task-${n}`);
  const cursor = changesCursor(f.store);
  assert.equal(readChanges(f.store, cursor.epoch, 0).rows.length, 256);
  f.store.run('DELETE FROM changes WHERE seq<=10');
  const response = await f.get(streamPath(f.store));
  assert.equal(await response.text(), `event: reset\ndata: ${JSON.stringify({ epoch: cursor.epoch })}\n\n`);
  assert.equal(readChanges(f.store, cursor.epoch, 10).reset, false);
});

test('SSE backpressure 等待时持续检查鉴权且仅缓存一个批次', { timeout: 5000 }, async t => {
  const store = await database(t);
  store.change('task', 'first');
  store.change('task', 'second');
  const conn = { token: 'token', type: 'host:pane' };
  let active = true;
  const auth = { connections: new Map([['token', conn]]), authenticate() { if (!active) throw new Error('expired'); return conn; } };
  class SlowResponse extends EventEmitter {
    destroyed = false; writableEnded = false; writableNeedDrain = true; frames = [];
    writeHead() {} flushHeaders() {}
    write(frame) { this.frames.push(frame); active = false; return false; }
    destroy() { this.destroyed = true; this.emit('close'); }
    end() { this.writableEnded = true; }
  }
  const response = new SlowResponse();
  await streamChanges(store, auth, conn, new URL(`http://localhost${streamPath(store)}`), { headers: { authorization: 'Bearer token' } }, response, new AbortController().signal);
  assert.equal(response.destroyed, true);
  assert.equal(response.frames.length, 1);
  await delay(1);
});
