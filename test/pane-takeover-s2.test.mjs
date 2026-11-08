import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDaemon } from '../packages/daemon/dist/index.js';
import { signingData } from '../packages/daemon/dist/security.js';
import { changesCursor, readChanges } from '../packages/daemon/dist/changes.js';
import { listSessions, sessionDetail } from '../packages/daemon/dist/session-list.js';
import { connectHost } from '../packages/protocol/dist/client.js';
import { createViews } from '../packages/pane-plugin/dist/views.js';

const USER_ROOT = 'agora:root:user-tasks';
const nodeId = id => `agora:session:${id}`;
const options = { timeout: 20_000 };

function deviceSigner() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const deviceId = randomUUID(), spki = publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  return { deviceId, publicKey: spki, label: '树接管测试设备',
    sign(challenge) { return { deviceId, publicKey: spki, alg: 'ECDSA-P256-SHA256',
      signature: sign('sha256', signingData(challenge), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url') }; } };
}

// 模拟模型进程；启动票据、就绪核对、ACL 和用户签名均使用生产实现。
class Driver {
  handles = [];
  async start(spec) {
    const launched = this.daemon.auth.launch({ ticket: spec.env.AGORA_LAUNCH_TICKET });
    const conn = this.daemon.auth.authenticate(`Bearer ${launched.token}`);
    const events = new Set(), exits = new Set();
    let resolveExit;
    const h = { spec, conn, stopped: false, ready: false, commands: [],
      identity: { pid: 89000 + this.handles.length, startTime: 'fixture', runId: spec.runId, instanceId: spec.instanceId },
      exited: new Promise(resolve => { resolveExit = resolve; }),
      onEvent(fn) { events.add(fn); return () => events.delete(fn); },
      onExit(fn) { exits.add(fn); return () => exits.delete(fn); },
      emit(event) { for (const fn of events) fn(event); },
      markReady() { this.ready = true; }, diagnostics() { return {}; }, respondUi() {},
      async send(command) {
        this.commands.push(command);
        const data = command.type === 'get_available_models' ? { models: ['test/model'] }
          : command.type === 'get_state' ? { model: 'test/model', thinkingLevel: spec.thinking, sessionFile: spec.sessionFile, sessionId: `pi-${spec.agoraSessionId}` }
          : command.type === 'get_last_assistant_text' ? { text: '测试结果' } : {};
        return { success: true, data };
      },
      async stop() {
        if (this.stopped) return this.report;
        this.stopped = true;
        this.report = { coverage: 'snapshot_visible', steps: [], leftovers: [] };
        const exit = { identity: this.identity, code: 0, signal: null, cleanupConfirmed: true, stopReport: this.report };
        resolveExit(exit);
        for (const fn of exits) fn(exit);
        return this.report;
      },
    };
    this.handles.push(h);
    queueMicrotask(() => this.daemon.tasks.ready(conn, { ...launched.policy, tools: spec.tools }, spec.runId).catch(() => {}));
    return h;
  }
  async recoverOldRun() { return { coverage: 'snapshot_visible', steps: [], leftovers: [] }; }
}

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'agora-pane-takeover-'));
  const driver = new Driver(), clients = [];
  const daemon = await startDaemon({ home, driver, maxTaskDepth: 4, maxConcurrentRuns: 12, taskLimitDefaults: { maxTokens: 1000 } });
  driver.daemon = daemon;
  t.after(async () => { clients.forEach(client => client.close()); await daemon.close({ force: true, timeoutMs: 1000 }); await rm(home, { recursive: true, force: true }); });
  async function connect(as) {
    const client = await connectHost({ home, as, autoStart: false });
    clients.push(client);
    if (as === 'agent:main') await client.request('POST', '/v1/principals/register', { sessionId: randomUUID(), ephemeral: true, cwd: home });
    return client;
  }
  const pane = await connect('host:pane'), main = await connect('agent:main');
  async function http(client, method, path, body) {
    const response = await fetch(daemon.url + path, { method,
      headers: { 'Agora-Protocol': '1', Authorization: `Bearer ${client.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    return { status: response.status, body: await response.json() };
  }
  async function ok(client, method, path, body, expected = 200) {
    const result = await http(client, method, path, body);
    assert.equal(result.status, expected, `${method} ${path}: ${JSON.stringify(result.body)}`);
    return result.body;
  }
  const device = deviceSigner();
  const pairing = await ok(pane, 'POST', '/v1/devices/pair', { deviceId: device.deviceId, publicKey: device.publicKey, label: device.label }, 202);
  async function signConfirmation(cf) { return http(pane, 'POST', `/v1/confirmations/${cf.confirmationId}/sign`, device.sign(cf.challenge)); }
  assert.equal((await signConfirmation(pairing.confirmation)).status, 200);
  async function pending(task, action = 'takeover', body = {}) {
    const result = await ok(pane, 'POST', `/v1/tasks/${task.taskId}/${action}`, body, 202);
    assert.ok(result.confirmation?.challenge);
    return result.confirmation;
  }
  async function confirmed(task, action, body = {}) {
    const result = await signConfirmation(await pending(task, action, body));
    assert.equal(result.status, 200, JSON.stringify(result.body));
    await daemon.tasks.flush();
    return result.body;
  }
  function handle(task) {
    const h = driver.handles.findLast(h => h.spec.agoraSessionId === task.agoraSessionId && !h.stopped);
    assert.ok(h?.ready, '运行必须通过真实就绪核对');
    return h;
  }
  async function spawn(actor = main, title = '任务') {
    const task = await ok(actor, 'POST', '/v1/tasks', { title, prompt: title, model: 'test/model', profile: 'explore', cwd: home, notify: 'silent' }, 201);
    await daemon.tasks.flush();
    handle(task);
    return task;
  }
  async function reopen(actor, task) {
    await handle(task).stop();
    await daemon.tasks.flush();
    assert.equal(daemon.store.task(task.taskId).status, 'interrupted');
    const reopened = await ok(actor, 'POST', `/v1/tasks/${task.taskId}/recover`, { mode: 'reopen' });
    await daemon.tasks.flush();
    handle(reopened);
    return reopened;
  }
  return { home, daemon, store: daemon.store, tasks: daemon.tasks, driver, pane, main, http, ok, spawn, handle, reopen, pending, signConfirmation, confirmed };
}

function pluginFixture(t, f) {
  let receive, stopped = 0;
  const events = [], requests = [];
  const views = createViews({ online: () => false,
    context: { log: { warn(error) { assert.fail(String(error)); } },
      mainSessions: { onChange: () => () => {}, get: () => undefined }, panelChanged() {} },
    api: {
      async request(method, path, body) { requests.push(path); return f.http(f.pane, method, path, body); },
      subscribe(path, callback) { receive = callback; return () => { stopped++; }; },
    },
  });
  t.after(() => views.dispose());
  return { views, events, requests, stopped: () => stopped,
    subscribe(cursor) { views.tree.subscribe({ epoch: cursor.epoch, revision: cursor.seq }, event => events.push(event)); },
    async replay(cursor) {
      const batch = readChanges(f.store, cursor.epoch, cursor.seq);
      assert.equal(batch.reset, false);
      for (const row of batch.rows) receive({ type: 'change', data: {
        cursor: { epoch: row.epoch, seq: row.seq }, objectType: row.object_type, objectId: row.object_id, tombstone: !!row.tombstone,
      } });
      await new Promise(resolve => setImmediate(resolve));
      return batch.rows;
    },
  };
}

function projection(item) {
  return { id: item.agoraSessionId, parentId: item.parentId, childCount: item.childCount, hasChildren: item.hasChildren, revision: item.revision };
}
async function snapshotMatchesSql(plugin, f, ids) {
  const req = { openNodeIds: ids.map(nodeId), recentSince: '2999-01-01T00:00:00.000Z' };
  const snapshot = await plugin.views.tree.snapshot(req);
  const params = new URLSearchParams({ snapshot: '1', recentSince: req.recentSince });
  req.openNodeIds.forEach(id => params.append('openNodeId', id));
  const conn = f.daemon.auth.authenticate(`Bearer ${f.pane.token}`);
  const sql = listSessions(f.store, conn, params, 50);
  assert.equal(snapshot.epoch, sql.changesCursor.epoch);
  assert.equal(snapshot.revision, sql.changesCursor.seq);
  assert.deepEqual(snapshot.nodes.filter(node => node.kind === 'session').map(node => ({
    id: node.sessionRef.id, parentId: node.parentId, childCount: node.childCount, hasChildren: node.hasChildren, revision: node.revision,
  })), sql.items.map(projection));
  return { snapshot, items: sql.items };
}

function usage(handle, inputTokens) {
  handle.emit({ type: 'usage_record', requestId: randomUUID(), inputTokens, outputTokens: 2,
    cacheReadTokens: 3, cacheWriteTokens: 4, reasoningTokens: 0, contextTokens: 20 });
}
const markersSince = (store, cursor) => readChanges(store, cursor.epoch, cursor.seq).rows.filter(row => row.object_type === 'tree' && row.object_id === 'all');

test('签名接管嵌套任务移动全部历史及下属投影，保留预算链并撤销原召集人读取与管理权限', options, async t => {
  const f = await fixture(t);
  const outer = await f.spawn(f.main, '外层任务'), outerActor = f.handle(outer).conn;
  const branch = await f.spawn(outerActor, '接管分支'), branchActor = f.handle(branch).conn;
  const leaf = await f.spawn(branchActor, '分支下属');
  usage(f.handle(leaf), 11);
  const leaf2 = await f.reopen(branchActor, leaf);
  const branch2 = await f.reopen(outerActor, branch);
  const sibling = await f.spawn(outerActor, '保留分支');
  const own = await f.spawn(f.pane, '普通用户任务');
  usage(f.handle(branch2), 7); usage(f.handle(leaf2), 13);
  const ids = [outer, branch, leaf, leaf2, branch2, sibling, own].map(task => task.agoraSessionId);
  const before = new Map(ids.map(id => [id, sessionDetail(f.store, id)]));
  const budget = f.tasks.budgets.view(f.store.task(branch.taskId));
  const treeUsage = f.store.usage(outer.taskId, true);
  assert.ok(treeUsage.inputTokens > 0);
  assert.equal(before.get(outer.agoraSessionId).childCount, 3);
  assert.equal(before.get(branch2.agoraSessionId).childCount, 2);
  assert.equal(before.get(branch.agoraSessionId).isCurrent, false);
  assert.equal(before.get(branch2.agoraSessionId).isCurrent, true);
  assert.equal(before.get(leaf.agoraSessionId).takenOver, false);
  const oldSnapshot = await f.ok(f.main, 'GET', '/v1/sessions?snapshot=1');
  assert.ok(oldSnapshot.items.some(item => item.taskId === leaf.taskId));
  assert.equal((await f.ok(f.main, 'GET', `/v1/sessions/${leaf.agoraSessionId}`)).parentId, nodeId(branch2.agoraSessionId));

  const cf = await f.pending(branch2);
  assert.equal(f.store.task(branch.taskId).convener_id, outerActor.principalId, '仅发起待确认不能接管');
  const plugin = pluginFixture(t, f);
  await snapshotMatchesSql(plugin, f, ids);
  const cursor = changesCursor(f.store);
  plugin.subscribe(cursor); plugin.requests.length = 0;
  const result = await f.signConfirmation(cf);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  await f.tasks.flush();
  const rows = await plugin.replay(cursor), markers = markersSince(f.store, cursor);
  assert.equal(markers.length, 1);
  assert.ok(rows.some(row => row.object_type === 'task' && row.object_id === branch.taskId));
  assert.equal(changesCursor(f.store).epoch, cursor.epoch);
  assert.deepEqual(plugin.events, [{ type: 'reset', epoch: cursor.epoch }]);
  assert.equal(plugin.stopped(), 1);
  assert.deepEqual(plugin.requests, [], 'marker 后不再处理 task 和 confirmation 事件');

  const { snapshot, items } = await snapshotMatchesSql(plugin, f, ids);
  const after = new Map(items.map(item => [item.agoraSessionId, item]));
  assert.equal(after.get(outer.agoraSessionId).childCount, 1);
  assert.equal(after.get(branch.agoraSessionId).childCount, 0);
  assert.equal(after.get(branch2.agoraSessionId).childCount, 2);
  for (const id of [branch.agoraSessionId, branch2.agoraSessionId]) {
    assert.equal(after.get(id).parentId, USER_ROOT);
    assert.deepEqual(after.get(id).parent, { kind: 'user' });
    assert.equal(after.get(id).takenOver, true);
    assert.equal(after.get(id).isCurrent, id === branch2.agoraSessionId);
    assert.equal(snapshot.nodes.find(node => node.id === nodeId(id)).statusDetail, '已由用户接管');
  }
  assert.notEqual(f.store.session(branch.agoraSessionId).convener_id, 'user', '历史行保留旧召集人时仍按任务当前归属投影');
  for (const id of [leaf.agoraSessionId, leaf2.agoraSessionId]) {
    assert.equal(after.get(id).parentId, nodeId(branch2.agoraSessionId));
    assert.deepEqual(after.get(id).parent, { kind: 'task', taskId: branch.taskId, sessionId: branch2.agoraSessionId });
    assert.equal(after.get(id).takenOver, false, '下属沿树移动，不冒充直接接管节点');
    assert.equal(after.get(id).isCurrent, id === leaf2.agoraSessionId);
  }
  assert.equal(after.get(own.agoraSessionId).takenOver, false);
  assert.equal(after.get(own.agoraSessionId).parentId, USER_ROOT);
  assert.equal(f.store.task(branch.taskId).parent_task_id, outer.taskId);
  assert.equal(f.store.task(leaf.taskId).parent_task_id, branch.taskId);
  assert.deepEqual(f.tasks.budgets.view(f.store.task(branch.taskId)), budget);
  assert.deepEqual(f.store.usage(outer.taskId, true), treeUsage);
  assert.deepEqual(f.tasks.budgets.view(f.store.task(leaf.taskId)).ancestors.map(row => row.taskId), [branch.taskId, outer.taskId]);
  for (const id of ids) {
    assert.ok(after.get(id).revision >= markers[0].seq, id);
    assert.ok(after.get(id).revision > before.get(id).revision, id);
    assert.deepEqual(after.get(id), await f.ok(f.pane, 'GET', `/v1/sessions/${id}`));
    assert.deepEqual(after.get(id), sessionDetail(f.store, id));
  }
  const rootChildren = await f.ok(f.pane, 'GET', `/v1/sessions?parent=${encodeURIComponent(USER_ROOT)}`);
  assert.deepEqual(rootChildren.items.map(item => item.agoraSessionId).sort(), [branch.agoraSessionId, branch2.agoraSessionId, own.agoraSessionId].sort());
  const remaining = await f.ok(f.main, 'GET', `/v1/sessions?snapshot=1&openNodeId=${nodeId(leaf.agoraSessionId)}&openNodeId=${nodeId(branch.agoraSessionId)}`);
  assert.deepEqual(remaining.items.map(item => item.agoraSessionId).sort(), [outer.agoraSessionId, sibling.agoraSessionId].sort());
  assert.equal(remaining.items.find(item => item.agoraSessionId === outer.agoraSessionId).childCount, 1);
  assert.deepEqual((await f.ok(f.main, 'GET', `/v1/sessions?parent=${nodeId(branch2.agoraSessionId)}`)).items, []);
  assert.equal((await f.ok(f.main, 'GET', '/v1/sessions')).items.some(item => item.taskId === branch.taskId || item.taskId === leaf.taskId), false);
  for (const task of [branch, branch2, leaf, leaf2]) {
    for (const actor of [f.main, outerActor]) {
      const detail = await f.http(actor, 'GET', `/v1/sessions/${task.agoraSessionId}`);
      assert.equal(detail.status, 403);
      assert.equal(detail.body.error.code, 'task_taken_over');
      assert.equal((await f.http(actor, 'GET', `/v1/tasks/${task.taskId}`)).status, 403);
      assert.equal((await f.http(actor, 'POST', `/v1/tasks/${task.taskId}/stop`, {})).status, 403);
    }
  }
  assert.equal((await f.http(f.main, 'POST', `/v1/tasks/${outer.taskId}/stop`, {})).status, 403, '祖先整树停止也不能跨越接管边界');
  assert.equal(f.store.task(branch.taskId).status, 'running');
  assert.equal(f.store.task(leaf.taskId).status, 'running');
});

test('真实签名执行失败时 marker、归属、提问和通知同事务回滚，重试仅提交一条 marker', options, async t => {
  const f = await fixture(t);
  const outer = await f.spawn(), actor = f.handle(outer).conn;
  const branch = await f.spawn(actor), child = f.handle(branch).conn;
  const question = await f.ok(child, 'POST', '/v1/requests', { questions: [{ id: 'q', question: '是否继续？' }] }, 201);
  const cf = await f.pending(branch);
  const beforeTask = f.store.task(branch.taskId), beforeSession = f.store.session(branch.agoraSessionId);
  const notices = f.store.all('SELECT * FROM outbox ORDER BY id');
  const beforeQuestion = await f.ok(f.pane, 'GET', `/v1/requests/${question.id}`);
  const cursor = changesCursor(f.store);
  const helper = f.store.changeTreeStructure.bind(f.store);
  let calls = 0;
  f.store.changeTreeStructure = () => {
    calls++;
    assert.equal(f.store.db.isTransaction, true);
    assert.equal(f.store.task(branch.taskId).convener_id, 'user');
    assert.equal(f.store.get('SELECT target_id FROM requests WHERE id=?', question.id).target_id, 'user');
    helper();
    throw new Error('接管事务故障注入');
  };
  try {
    const failed = await f.signConfirmation(cf);
    assert.equal(failed.status, 500, JSON.stringify(failed.body));
    assert.equal(calls, 1, '真实 takeOver 必须调用统一 helper');
    assert.deepEqual(changesCursor(f.store), cursor);
    assert.deepEqual(f.store.task(branch.taskId), beforeTask);
    assert.deepEqual(f.store.session(branch.agoraSessionId), beforeSession);
    assert.deepEqual(f.store.all('SELECT * FROM outbox ORDER BY id'), notices);
    assert.deepEqual(await f.ok(f.pane, 'GET', `/v1/requests/${question.id}`), beforeQuestion);
    assert.equal(markersSince(f.store, cursor).length, 0);
    const pending = f.store.get('SELECT state,consumed_at FROM pending_confirmations WHERE id=?', cf.confirmationId);
    assert.equal(pending.state, 'pending'); assert.equal(pending.consumed_at, null);
  } finally { f.store.changeTreeStructure = helper; }
  const succeeded = await f.signConfirmation(cf);
  assert.equal(succeeded.status, 200, JSON.stringify(succeeded.body));
  assert.equal(markersSince(f.store, cursor).length, 1);
  assert.equal(f.store.task(branch.taskId).convener_id, 'user');
  const moved = await f.ok(f.pane, 'GET', `/v1/requests/${question.id}`);
  assert.equal(moved.targetId, 'user'); assert.equal(moved.state, 'escalated');
  assert.equal(f.store.get("SELECT COUNT(*) AS n FROM outbox WHERE kind='task:taken_over' AND json_extract(payload,'$.taskId')=?", branch.taskId).n, 1);
  assert.equal((await f.signConfirmation(cf)).status, 409, '签名不可重放');
  assert.equal(markersSince(f.store, cursor).length, 1);
});

test('普通用户任务及其历史会话不标接管，同归属接管不产生结构 marker', options, async t => {
  const f = await fixture(t);
  const task = await f.spawn(f.pane);
  await f.handle(task).stop(); await f.tasks.flush();
  const reopened = await f.confirmed(task, 'recover', { mode: 'reopen' });
  f.handle(reopened);
  for (const id of [task.agoraSessionId, reopened.agoraSessionId]) {
    const item = await f.ok(f.pane, 'GET', `/v1/sessions/${id}`);
    assert.equal(item.takenOver, false);
    assert.equal(item.parentId, USER_ROOT);
    assert.deepEqual(item.parent, { kind: 'user' });
    assert.equal(item.isCurrent, id === reopened.agoraSessionId);
  }
  const cf = await f.pending(reopened), cursor = changesCursor(f.store);
  const before = f.store.task(task.taskId);
  const signed = await f.signConfirmation(cf);
  assert.equal(signed.status, 200, JSON.stringify(signed.body));
  assert.equal(markersSince(f.store, cursor).length, 0);
  assert.deepEqual(f.store.task(task.taskId), before);
  assert.equal((await f.ok(f.pane, 'GET', `/v1/sessions/${task.agoraSessionId}`)).takenOver, false);
});
