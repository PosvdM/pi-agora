import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { openStore } from '../packages/daemon/dist/store.js';
import { TaskManager } from '../packages/daemon/dist/tasks.js';
import { changesCursor, readChanges, pruneChanges, streamChanges } from '../packages/daemon/dist/changes.js';
import { listSessions, sessionDetail } from '../packages/daemon/dist/session-list.js';
import { createViews } from '../packages/pane-plugin/dist/views.js';

const host = { type: 'host:pane', principalId: 'user' };
const OLD = '2020-01-01T00:00:00.000Z';
const nodeId = id => `agora:session:${id}`;

// 队列不启动；状态通过 Store.transition 推进，结构通过真实 TaskManager 迁移。
async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'agora-tree-projection-'));
  const store = await openStore(home);
  store.run("INSERT INTO principals(id,type,pi_session_id,cwd,created_at) VALUES('main','agent:main','pi-main',?,?)", home, OLD);
  const main = { type: 'agent:main', principalId: 'main' };
  const auth = { requireAgent(conn) { return store.principal(conn.principalId); } };
  const driver = { async start() { throw new Error('此 fixture 不启动进程'); } };
  const tasks = new TaskManager(store, auth, driver, { home, instanceId: 'tree-test', url: 'http://unused', maxTaskDepth: 3 });
  t.after(async () => { await tasks.shutdown(true, 1000); store.close(); await rm(home, { recursive: true, force: true }); });
  async function spawn(parent) {
    const conn = parent ? { type: 'agent:child', principalId: store.session(parent.agoraSessionId).principal_id } : main;
    return tasks.spawn(conn, { model: 'test/model', profile: 'explore', prompt: '树投影测试', cwd: home, notify: 'silent' });
  }
  function state(task, status) { return store.transition(store.task(task.taskId), status); }
  function actor(task) {
    const principalId = store.task(task.taskId).convener_id;
    return { type: store.principal(principalId).type, principalId };
  }
  return { store, tasks, spawn, state, actor };
}

function viewsFixture(t, store) {
  let receive, stopped = 0;
  const requests = [], events = [];
  const views = createViews({
    online: () => false,
    context: {
      log: { warn(error) { assert.fail(String(error)); } },
      mainSessions: { onChange: () => () => {}, get: () => undefined },
      panelChanged() {},
    },
    api: {
      async request(method, path) {
        requests.push(path);
        const url = new URL(path, 'http://fixture');
        let body;
        if (url.pathname === '/v1/sessions') body = listSessions(store, host, url.searchParams, Number(url.searchParams.get('limit') ?? 50));
        else if (url.pathname.startsWith('/v1/sessions/')) body = sessionDetail(store, decodeURIComponent(url.pathname.slice('/v1/sessions/'.length)));
        else if (url.pathname.startsWith('/v1/tasks/')) body = { agoraSessionId: store.task(decodeURIComponent(url.pathname.slice('/v1/tasks/'.length))).agora_session_id };
        else assert.fail(path);
        return { status: 200, body };
      },
      subscribe(path, callback) { receive = callback; return () => { stopped++; }; },
    },
  });
  t.after(() => views.dispose());
  function subscribe(cursor) { return views.tree.subscribe({ epoch: cursor.epoch, revision: cursor.seq }, event => events.push(event)); }
  async function replay(cursor) {
    const batch = readChanges(store, cursor.epoch, cursor.seq);
    assert.equal(batch.reset, false);
    for (const row of batch.rows) receive({ type: 'change', data: {
      cursor: { epoch: row.epoch, seq: row.seq }, objectType: row.object_type, objectId: row.object_id, tombstone: !!row.tombstone,
    } });
    // 订阅按 Promise 队列处理；让整批有界事件完成后再断言。
    await new Promise(resolve => setImmediate(resolve));
    return batch.rows;
  }
  return { views, subscribe, replay, events, requests, stopped: () => stopped };
}

function projection(item) {
  return { id: item.agoraSessionId, parentId: item.parentId, childCount: item.childCount, hasChildren: item.hasChildren, revision: item.revision };
}
async function snapshotMatchesSql(views, store, ids) {
  const request = { openNodeIds: ids.map(nodeId), recentSince: '2999-01-01T00:00:00.000Z' };
  const snapshot = await views.tree.snapshot(request);
  const params = new URLSearchParams({ snapshot: '1', recentSince: request.recentSince });
  ids.forEach(id => params.append('openNodeId', nodeId(id)));
  const sql = listSessions(store, host, params, 50);
  assert.equal(snapshot.epoch, sql.changesCursor.epoch);
  assert.equal(snapshot.revision, sql.changesCursor.seq);
  assert.deepEqual(snapshot.nodes.filter(node => node.kind === 'session').map(node => ({
    id: node.sessionRef.id, parentId: node.parentId, childCount: node.childCount, hasChildren: node.hasChildren, revision: node.revision,
  })), sql.items.map(projection));
  return sql.items;
}

for (const mode of ['reopen', 'replace']) test(`父任务 ${mode} 使全部历史子会话改挂，订阅 reset 后投影与 SQL 一致`, async t => {
  const f = await fixture(t);
  const outer = await f.spawn(); f.state(outer, 'running');
  const parent = await f.spawn(outer); f.state(parent, 'running');
  const child = await f.spawn(parent); f.state(child, 'interrupted');
  const child2 = await f.tasks.recover(f.actor(child), child.taskId, { mode: 'reopen' });
  f.state(child2, 'completed');
  f.state(parent, 'interrupted');
  const ids = [outer.agoraSessionId, parent.agoraSessionId, child.agoraSessionId, child2.agoraSessionId];
  const before = new Map(ids.map(id => [id, sessionDetail(f.store, id)]));
  assert.equal(before.get(parent.agoraSessionId).childCount, 2);
  assert.equal(before.get(parent.agoraSessionId).isCurrent, true);
  assert.equal(before.get(child.agoraSessionId).isCurrent, false);
  assert.equal(before.get(child2.agoraSessionId).isCurrent, true);
  const plugin = viewsFixture(t, f.store);
  await snapshotMatchesSql(plugin.views, f.store, ids);
  const cursor = changesCursor(f.store);
  plugin.subscribe(cursor);
  plugin.requests.length = 0;
  const reopened = await f.tasks.recover(f.actor(parent), parent.taskId, { mode });
  ids.push(reopened.agoraSessionId);
  const rows = await plugin.replay(cursor);
  const markers = rows.filter(row => row.object_type === 'tree' && row.object_id === 'all');
  assert.equal(markers.length, 1);
  assert.equal(changesCursor(f.store).epoch, cursor.epoch, '结构迁移不更换数据库 epoch');
  assert.deepEqual(plugin.events, [{ type: 'reset', epoch: cursor.epoch }]);
  assert.equal(plugin.stopped(), 1, 'marker 后停止订阅，不继续 upsert 或 root-noop');
  assert.deepEqual(plugin.requests, [], 'marker 后不处理队列中的后续 task change');
  const items = await snapshotMatchesSql(plugin.views, f.store, ids);
  const after = new Map(items.map(item => [item.agoraSessionId, item]));
  assert.equal(after.get(parent.agoraSessionId).isCurrent, false);
  assert.equal(after.get(reopened.agoraSessionId).isCurrent, true);
  assert.equal(after.get(child.agoraSessionId).isCurrent, false);
  assert.equal(after.get(child2.agoraSessionId).isCurrent, true);
  assert.equal(after.get(parent.agoraSessionId).childCount, 0);
  assert.equal(after.get(parent.agoraSessionId).hasChildren, false);
  assert.equal(after.get(reopened.agoraSessionId).childCount, 2);
  assert.equal(after.get(outer.agoraSessionId).childCount, 2, '外层父同时包含旧父和新父会话');
  for (const id of [child.agoraSessionId, child2.agoraSessionId]) {
    assert.equal(after.get(id).parentId, nodeId(reopened.agoraSessionId));
    assert.deepEqual(after.get(id).parent, { kind: 'task', taskId: parent.taskId, sessionId: reopened.agoraSessionId });
    assert.equal(after.get(id).status, before.get(id).status);
  }
  for (const id of ids) {
    assert.ok(after.get(id).revision >= markers[0].seq, id);
    if (before.has(id)) assert.ok(after.get(id).revision > before.get(id).revision, id);
    assert.deepEqual(after.get(id), sessionDetail(f.store, id));
  }
});

test('已完成子任务中断重开推进外父计数及 revision；普通状态/同会话返工不写 marker', async t => {
  const f = await fixture(t);
  const parent = await f.spawn(); f.state(parent, 'running');
  const child = await f.spawn(parent); f.state(child, 'completed');
  const markerCount = () => f.store.get("SELECT COUNT(*) AS n FROM changes WHERE object_type='tree'").n;
  assert.equal(markerCount(), 0);
  await f.tasks.steer(f.actor(child), child.taskId, { message: '同一会话返工' });
  assert.equal(markerCount(), 0);
  f.state(child, 'interrupted');
  const before = sessionDetail(f.store, parent.agoraSessionId);
  const cursor = changesCursor(f.store);
  const plugin = viewsFixture(t, f.store); plugin.subscribe(cursor);
  const reopened = await f.tasks.recover(f.actor(child), child.taskId, { mode: 'reopen' });
  await plugin.replay(cursor);
  assert.deepEqual(plugin.events, [{ type: 'reset', epoch: cursor.epoch }]);
  const items = await snapshotMatchesSql(plugin.views, f.store, [parent.agoraSessionId, child.agoraSessionId, reopened.agoraSessionId]);
  const after = items.find(item => item.agoraSessionId === parent.agoraSessionId);
  assert.equal(before.childCount, 1);
  assert.equal(after.childCount, 2);
  assert.ok(after.revision > before.revision);
  for (const id of [child.agoraSessionId, reopened.agoraSessionId]) {
    const item = sessionDetail(f.store, id);
    assert.equal(item.parentId, nodeId(parent.agoraSessionId));
    assert.equal(item.isCurrent, id === reopened.agoraSessionId);
  }
});

test('结构 marker 与迁移一同回滚；prune 及重启保留结构 revision，不改变活动时间', { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  const parent = await f.spawn(); f.state(parent, 'running');
  const child = await f.spawn(parent); f.state(child, 'completed');
  const cursor = changesCursor(f.store);
  assert.throws(() => f.store.changeTreeStructure(), /同一事务/);
  assert.throws(() => f.store.transaction(() => { f.store.changeTreeStructure(); throw new Error('rollback'); }), /rollback/);
  assert.deepEqual(changesCursor(f.store), cursor);
  f.state(parent, 'interrupted');
  const migrationCursor = changesCursor(f.store);
  const changeTreeStructure = f.store.changeTreeStructure.bind(f.store);
  f.store.changeTreeStructure = () => { changeTreeStructure(); throw new Error('migration rollback'); };
  try {
    await assert.rejects(f.tasks.recover(f.actor(parent), parent.taskId, { mode: 'reopen' }), /migration rollback/);
    assert.deepEqual(changesCursor(f.store), migrationCursor);
    assert.equal(f.store.task(parent.taskId).agora_session_id, parent.agoraSessionId);
    assert.equal(f.store.get('SELECT COUNT(*) AS n FROM agora_sessions WHERE task_id=?', parent.taskId).n, 1);
    assert.equal(sessionDetail(f.store, child.agoraSessionId).parentId, nodeId(parent.agoraSessionId));
  } finally { f.store.changeTreeStructure = changeTreeStructure; }
  const reopened = await f.tasks.recover(f.actor(parent), parent.taskId, { mode: 'reopen' });
  const ids = [parent.agoraSessionId, child.agoraSessionId, reopened.agoraSessionId];
  f.store.run('UPDATE changes SET created_at=?', OLD);
  const before = ids.map(id => sessionDetail(f.store, id));
  const head = changesCursor(f.store);
  f.store.run(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<100000)
    INSERT INTO changes(epoch,object_type,object_id,created_at) SELECT (SELECT value FROM settings WHERE key='epoch'),'noise',CAST(i AS TEXT),? FROM n`, new Date().toISOString());
  assert.equal(pruneChanges(f.store), head.seq);
  const saved = JSON.parse(f.store.get("SELECT value FROM settings WHERE key='changes:object:tree:all'").value);
  assert.ok(saved.seq > cursor.seq);
  assert.equal(f.store.get("SELECT seq FROM changes WHERE object_type='tree' LIMIT 1"), undefined);
  assert.deepEqual(ids.map(id => sessionDetail(f.store, id)), before);
  assert.equal(readChanges(f.store, head.epoch, cursor.seq).reset, true);
  const reopenedStore = await openStore(f.store.home);
  try {
    assert.deepEqual(ids.map(id => sessionDetail(reopenedStore, id)), before);
    assert.equal(changesCursor(reopenedStore).epoch, head.epoch);
  } finally { reopenedStore.close(); }
  f.store.transaction(() => f.store.changeTreeStructure());
  const latest = changesCursor(f.store).seq;
  assert.ok(latest > saved.seq);
  for (let i = 0; i < ids.length; i++) {
    const item = sessionDetail(f.store, ids[i]);
    assert.equal(item.revision, latest, '同时取保留 head 与最新 marker 的最大值');
    assert.equal(item.lastActivityAt, before[i].lastActivityAt, '全树失效不把冷节点变成近期节点');
  }
});

test('SSE 将结构 marker 作为一条 change 发送，树 reset 由插件解释', async t => {
  const f = await fixture(t);
  const cursor = changesCursor(f.store);
  f.store.transaction(() => f.store.changeTreeStructure());
  const conn = { token: 'token', type: 'host:pane' };
  const auth = { authenticate: () => conn, connections: new Map([['token', conn]]) };
  class Response extends EventEmitter {
    destroyed = false; writableEnded = false; frames = [];
    writeHead() {} flushHeaders() {}
    write(frame) { this.frames.push(frame); this.destroy(); return true; }
    destroy() { this.destroyed = true; this.emit('close'); }
    end() { this.writableEnded = true; }
  }
  const response = new Response();
  await streamChanges(f.store, auth, conn, new URL(`http://fixture/v1/changes?epoch=${cursor.epoch}&afterSeq=${cursor.seq}`), { headers: {} }, response, new AbortController().signal);
  assert.deepEqual(response.frames, [`event: change\ndata: ${JSON.stringify({ cursor: changesCursor(f.store), objectType: 'tree', objectId: 'all', tombstone: false })}\n\n`]);
});
