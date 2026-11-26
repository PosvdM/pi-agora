import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { startDaemon, RpcSubprocessDriver } from '../packages/daemon/dist/index.js';
import { schemaMigrations } from '../packages/daemon/dist/store.js';
import { openArchive } from '../packages/archive/dist/index.js';
import createPlugin from '../packages/pane-plugin/dist/plugin.js';
import { connectDaemonApi } from '../packages/pane-plugin/dist/transport.js';
import { containment, piFixture, providerPath, until } from './fixtures/driver-helpers.mjs';

// 真实 daemon、真实 pi 和假 provider；插件只通过 transport 与 daemon 通信，离线时使用默认的真实 archive 接线。
const extensionPath = fileURLToPath(new URL('../packages/extension/dist/index.js', import.meta.url));
const origin = { client: 'browser', connectionId: 'tab-online', receivedAt: '2026-01-01T00:00:00.000Z' };
const treeRequest = { openNodeIds: [], recentSince: '2000-01-01T00:00:00Z' };
function host(dataDir) {
  const banners = new Map(), warnings = [];
  return { warnings, paneProtocol: 1, dataDir, log: { info() {}, warn(...args) { warnings.push(args); }, error() {} }, notify() {}, panelChanged() {}, formAdded() {}, formRemoved() {},
    setBanner: value => banners.set(value.id, value), clearBanner: id => banners.delete(id), listBanners: () => [...banners.values()],
    mainSessions: { list: () => [], get: () => undefined, onChange: () => () => {}, hold: () => () => {} },
    userPresence: { devices: () => [], onDevicesChange: () => () => {}, async confirm() { throw Object.assign(new Error('没有设备'), { code: 'noDevice' }); } } };
}
// 按宿主协议跟随会话：收到 resync 后重新取快照，再从新切点订阅；取快照失败（如 daemon 正在关闭）时稍后重试。
function follow(plugin, ref) {
  const events = [], snapshots = [], failures = [];
  let stop = () => {}, closed = false;
  const open = async () => {
    while (!closed) {
      try {
        const snapshot = await plugin.sessions.snapshot(ref);
        snapshots.push(snapshot);
        if (closed) return;
        stop = plugin.sessions.subscribe(ref, snapshot.cursor, event => {
          events.push(event);
          if (event.event.type === 'resync') void open();
        });
        return;
      } catch (error) {
        failures.push(error);
        await delay(50);
      }
    }
  };
  void open();
  return { events, snapshots, failures, close() { closed = true; stop(); } };
}
// 树同理：reset 后重新取快照并订阅，离线和在线切换各产生一次 reset。
function followTree(plugin) {
  const changes = [], snapshots = [];
  let stop = () => {}, closed = false;
  const open = async () => {
    while (!closed) {
      try {
        const snapshot = await plugin.tree.snapshot(treeRequest);
        snapshots.push(snapshot);
        if (closed) return;
        stop = plugin.tree.subscribe({ epoch: snapshot.epoch, revision: snapshot.revision }, change => {
          changes.push(change);
          if (change.type === 'reset') void open();
        });
        return;
      } catch { await delay(50); }
    }
  };
  const ready = open();
  return { changes, snapshots, ready, close() { closed = true; stop(); } };
}
const deltas = events => events.filter(e => e.event.type === 'message_update' && e.event.assistantMessageEvent?.type === 'text_delta')
  .map(e => e.event.assistantMessageEvent.delta).join('');
const assistantTexts = entries => entries.filter(entry => entry.message?.role === 'assistant')
  .map(entry => entry.message.content.filter(block => block.type === 'text').map(block => block.text).join(''));
const rows = content => Object.fromEntries(content.rows.map(row => [row.key, row.value]));

test('真实 pi 在线往返：插件创建任务，读取快照、历史、实时流和用量，返工后离线读存档，daemon 重启后回到在线', { timeout: 120_000 }, async () => {
  const f = await piFixture({ turns: [
    { usage: { input: 21, output: 3 }, segments: [{ type: 'text', chunks: [{ text: '第一段', delayMs: 1500 }, { text: '输出', delayMs: 200 }] }] },
    { usage: { input: 34, output: 5 }, segments: [{ type: 'text', chunks: [{ text: '返工', delayMs: 800 }, { text: '完成', delayMs: 200 }] }] },
  ] });
  const home = path.join(f.root, 'agora');
  const driver = () => new RpcSubprocessDriver({ home, piPath: f.install.packageDir, extensionPath, env: f.env, extraExtensions: [providerPath], containment });
  let daemon, plugin, follower, tree, reader;
  try {
    daemon = await startDaemon({ home, driver: driver(), idleReclaimMs: 60_000 });
    const ctx = host(path.join(home, 'pane-plugin'));
    plugin = createPlugin({ home, retryMs: 50, connect: () => connectDaemonApi(home) });
    await plugin.activate(ctx);
    tree = followTree(plugin);
    await tree.ready;
    const treeChanges = tree.changes, initialTree = tree.snapshots[0];

    // 在线：创建任务并在首段输出前开始跟随会话。
    const form = await plugin.actions.resolveForm('agora.task.spawn', { type: 'global' });
    const created = await plugin.actions.invoke({ actionId: 'agora.task.spawn', target: { type: 'global' }, formId: form.id, formRevision: form.revision,
      idempotencyKey: 'online-spawn', input: { answers: [], fields: { model: 'p0-fake/scripted', profile: 'explore', thinking: 'off', prompt: '在线往返验证', cwd: f.cwd } } }, origin);
    assert.equal(created.status, 'ok');
    const nodeId = created.openNodeId, ref = { source: 'agora', id: nodeId.slice('agora:session:'.length) };
    follower = follow(plugin, ref);
    const taskId = daemon.store.session(ref.id).task_id;
    await until(() => daemon.store.task(taskId).status === 'completed', 30_000);
    await daemon.tasks.flush();
    await until(() => treeChanges.some(change => change.type === 'upsert' && change.node.id === nodeId && change.node.status === 'done'), 10_000);
    assert.equal(deltas(follower.events), '第一段输出', '实时流按序送达文本增量');
    assert.ok(follower.events.some(e => e.event.type === 'pane_entries'), '条目变化映射为 pane_entries');
    assert.ok(follower.events.some(e => e.event.type === 'pane_status'), '状态变化映射为 pane_status');
    for (let index = 1; index < follower.events.length; index++) {
      const [before, after] = [follower.events[index - 1], follower.events[index]];
      if (before.cursor.epoch === after.cursor.epoch && after.event.type !== 'resync') assert.ok(after.cursor.seq > before.cursor.seq, '同一 epoch 内游标递增');
    }
    const done = await plugin.sessions.snapshot(ref);
    assert.deepEqual(assistantTexts(done.entries), ['第一段输出']);
    assert.equal(done.status, 'done'); assert.equal(done.readonly, false);
    assert.deepEqual(done.unfinishedPartials, []);
    const last = await plugin.sessions.history(ref, { limit: 1 });
    assert.deepEqual(last.entries, done.entries.slice(-1));
    const earlier = await plugin.sessions.history(ref, { before: last.historyBefore, limit: 100 });
    assert.deepEqual([...earlier.entries, ...last.entries], done.entries, '历史分页拼接等于快照');
    assert.equal(earlier.historyBefore, null);
    let panel = rows(await plugin.panels.content('agora.task', nodeId));
    assert.equal(JSON.parse(panel['任务用量']).inputTokens, 21);
    assert.equal(panel['上下文 token'], '21');
    assert.equal(panel['第 1 代结果'], '第一段输出');

    // 在线：composer 返工复用固定请求机制，实时流继续送达新一代输出。
    const sent = await plugin.sessions.send(ref, { text: '请返工' }, { idempotencyKey: 'online-steer', origin });
    assert.equal(sent.status, 'accepted');
    assert.deepEqual(await plugin.sessions.send(ref, { text: '请返工' }, { idempotencyKey: 'online-steer', origin: { ...origin, connectionId: 'tab-retry' } }), sent);
    await until(() => daemon.store.task(taskId).generation === 2 && daemon.store.task(taskId).status === 'completed', 30_000);
    await daemon.tasks.flush();
    await until(() => deltas(follower.events).endsWith('返工完成'), 10_000);
    const online = await plugin.sessions.snapshot(ref);
    assert.deepEqual(assistantTexts(online.entries), ['第一段输出', '返工完成']);
    panel = rows(await plugin.panels.content('agora.task', nodeId));
    assert.equal(panel['第 2 代结果'], '返工完成');
    assert.equal(JSON.parse(panel['任务用量']).requests, 2);
    assert.equal(JSON.parse(panel['第 2 代用量']).inputTokens, 34);

    // 离线：daemon 关闭后插件切到真实 archive，会话跟随收到 resync 并改读只读存档。
    const beforeOffline = treeChanges.length, eventsBeforeOffline = follower.events.length;
    await daemon.close({ force: true }); daemon = undefined;
    await until(() => plugin.actions.list().length === 0, 10_000);
    await until(() => treeChanges.slice(beforeOffline).some(change => change.type === 'reset'), 10_000);
    await until(() => follower.snapshots.at(-1)?.readonly === true && follower.snapshots.at(-1)?.readonlyReason === 'archived', 10_000);
    assert.ok(follower.events.slice(eventsBeforeOffline).some(e => e.event.type === 'resync'));
    const archived = await plugin.sessions.snapshot(ref);
    assert.equal(archived.readonly, true); assert.equal(archived.readonlyReason, 'archived');
    assert.deepEqual(archived.entries, online.entries, '存档条目与在线快照一致');
    assert.deepEqual((await plugin.sessions.history(ref, { limit: 1 })).entries, online.entries.slice(-1));
    const offlineTree = await plugin.tree.snapshot(treeRequest);
    const offlineNode = offlineTree.nodes.find(node => node.id === nodeId);
    assert.equal(offlineNode.parentId, 'agora:root:user-tasks');
    assert.deepEqual(offlineNode.capabilities, ['open']);
    panel = rows(await plugin.panels.content('agora.task', nodeId));
    assert.equal(JSON.parse(panel['会话用量']).inputTokens, 55);
    assert.equal(JSON.parse(panel['会话用量']).requests, 2);
    assert.equal((await plugin.sessions.send(ref, { text: '离线不能返工' }, { idempotencyKey: 'offline-steer', origin })).status, 'rejected');
    assert.equal(await plugin.actions.resolveForm('agora.task.steer', { type: 'node', nodeId }), null);
    reader = await openArchive({ home, apiVersion: 1 });
    assert.equal(reader.schemaVersion, 7, '真实 daemon 写出的库为 schema v7');
    assert.equal((await reader.getSession(ref.id)).archiveState, 'ok');
    reader.close(); reader = undefined;

    // 回到在线：daemon 重启后插件重连，树 reset，会话跟随重新读取可返工的在线快照。
    const beforeOnline = treeChanges.length, snapshotsBeforeOnline = follower.snapshots.length;
    daemon = await startDaemon({ home, driver: driver(), idleReclaimMs: 60_000 });
    await until(() => plugin.actions.list().length > 0, 10_000);
    await until(() => treeChanges.slice(beforeOnline).some(change => change.type === 'reset'), 10_000);
    await until(() => follower.snapshots.slice(snapshotsBeforeOnline).some(snapshot => snapshot.readonly === false), 10_000);
    const restored = await plugin.sessions.snapshot(ref);
    assert.equal(restored.readonly, false);
    assert.deepEqual(restored.entries, online.entries);
    const onlineTree = tree.snapshots.at(-1);
    assert.equal(onlineTree.nodes.find(node => node.id === nodeId).availability, 'online');
    // 复合 epoch 为 <daemon epoch>.<实例随机标识>：数据库 epoch 跨 daemon 重启保持不变，重连后修订号序列换新实例。
    const source = value => value.slice(0, value.lastIndexOf('.'));
    assert.equal(source(onlineTree.epoch), source(initialTree.epoch), '数据库 epoch 跨 daemon 重启保持不变');
    assert.notEqual(onlineTree.epoch, initialTree.epoch, '重连后换新的修订号序列');
    assert.ok(onlineTree.nodes.find(node => node.id === nodeId).capabilities.includes('send'));
    assert.equal(JSON.parse(rows(await plugin.panels.content('agora.task', nodeId))['任务用量']).requests, 2);
    assert.deepEqual(await plugin.sessions.send(ref, { text: '请返工' }, { idempotencyKey: 'online-steer', origin }), sent, '重启后同 key 复用最终结果');
    assert.equal(daemon.store.task(taskId).generation, 2);
    // 快照失败只能来自 daemon 关闭和断线：draining、连接错误或插件取消的在途请求。
    assert.ok(follower.failures.every(error => error.name === 'AbortError' || /会话服务已关闭|agora|连接|ECONNREFUSED|fetch|terminated/.test(error.message)), follower.failures.map(String).join('\n'));
  } finally {
    follower?.close(); tree?.close(); reader?.close();
    await plugin?.deactivate();
    try { if (daemon) await daemon.close({ force: true }); }
    finally { await f.cleanup(); }
  }
});

test('v6 库由真实 daemon 迁移到 v7 后，插件在线、离线（真实 archive）和重新在线读到同一会话', { timeout: 60_000 }, async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'agora-pane-v7-'));
  const driver = { async start() { throw new Error('此用例不能拉起 pi'); }, async recoverOldRun() { throw new Error('此用例没有历史运行'); } };
  let daemon, plugin, tree, reader;
  t.after(async () => {
    tree?.close(); reader?.close();
    await plugin?.deactivate();
    try { if (daemon) await daemon.close({ force: true, timeoutMs: 1_000 }); }
    finally { await rm(home, { recursive: true, force: true }); }
  });
  // 按 v6 结构建库，写入一个已完成、带真实 pi 会话文件的用户任务。
  const id = 'as_legacy', file = path.join(home, 'sessions', id, 'session.jsonl'), at = '2026-11-01T00:00:00.000Z';
  const usage = { input: 13, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const rowsOnDisk = [
    { type: 'session', version: 3, id: 'pi-legacy', timestamp: at, cwd: home },
    { type: 'message', id: 'e1', parentId: null, timestamp: at, message: { role: 'user', content: [{ type: 'text', text: '旧版本任务书' }], timestamp: 1 } },
    { type: 'message', id: 'e2', parentId: 'e1', timestamp: at, message: { role: 'assistant', content: [{ type: 'text', text: '旧版本结果' }], api: 'p0-scripted', provider: 'p0-fake', model: 'scripted', usage, stopReason: 'stop', timestamp: 2 } },
  ];
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, rowsOnDisk.map(row => JSON.stringify(row)).join('\n') + '\n');
  const db = new DatabaseSync(path.join(home, 'agora.db'));
  for (const migration of schemaMigrations.slice(0, 6)) db.exec(migration);
  db.exec(`CREATE TABLE schema_version(version INTEGER NOT NULL,migrated_at TEXT NOT NULL); INSERT INTO schema_version VALUES(6,'legacy');`);
  db.prepare("INSERT INTO principals(id,type,created_at) VALUES('child_legacy','agent:child',?)").run(at);
  db.prepare("INSERT INTO agora_sessions(id,task_id,principal_id,convener_id,session_file,profile,model,thinking,cwd,status,created_at) VALUES(?,'tk_legacy','child_legacy','user',?,'explore','p0-fake/scripted','off',?,'completed',?)").run(id, file, home, at);
  db.prepare("INSERT INTO tasks(id,agora_session_id,convener_id,requested_by,title,prompt,model,thinking,profile,cwd,notify,status,created_at,updated_at) VALUES('tk_legacy',?,'user','host:pane','旧版本任务','旧版本任务书','p0-fake/scripted','off','explore',?,'silent','completed',?,?)").run(id, home, at, at);
  db.close();

  daemon = await startDaemon({ home, driver });
  assert.equal(daemon.store.get('SELECT version FROM schema_version').version, 7);
  assert.ok(daemon.store.all('PRAGMA index_list(changes)').some(index => index.name === 'changes_object'));
  const backups = (await readdir(path.join(home, 'backups'))).filter(name => name.endsWith('.db'));
  assert.equal(backups.length, 1, 'v6 迁移前留有备份');

  plugin = createPlugin({ home, retryMs: 50, connect: () => connectDaemonApi(home) });
  await plugin.activate(host(path.join(home, 'pane-plugin')));
  tree = followTree(plugin);
  await tree.ready;
  const nodeId = `agora:session:${id}`, ref = { source: 'agora', id };
  const node = tree.snapshots[0].nodes.find(value => value.id === nodeId);
  assert.equal(node.parentId, 'agora:root:user-tasks');
  assert.equal(node.availability, 'online');
  const online = await plugin.sessions.snapshot(ref);
  assert.deepEqual(online.entries.map(entry => entry.id), ['e1', 'e2']);
  assert.deepEqual(assistantTexts(online.entries), ['旧版本结果']);
  assert.equal(online.readonly, false);
  assert.deepEqual((await plugin.sessions.history(ref, { limit: 1 })).entries, online.entries.slice(-1));

  const resets = tree.changes.length;
  await daemon.close({ force: true, timeoutMs: 1_000 }); daemon = undefined;
  await until(() => plugin.actions.list().length === 0, 10_000);
  await until(() => tree.changes.slice(resets).some(change => change.type === 'reset') && tree.snapshots.at(-1).nodes.find(value => value.id === nodeId)?.availability === 'archived', 10_000);
  const archived = await plugin.sessions.snapshot(ref);
  assert.equal(archived.readonly, true); assert.equal(archived.readonlyReason, 'archived');
  assert.deepEqual(archived.entries, online.entries);
  assert.deepEqual((await plugin.sessions.history(ref, { limit: 1 })).entries, online.entries.slice(-1));
  reader = await openArchive({ home, apiVersion: 1 });
  assert.equal(reader.schemaVersion, 7);
  assert.deepEqual((await reader.getSession(id)).parent, { kind: 'user' });
  reader.close(); reader = undefined;

  daemon = await startDaemon({ home, driver });
  await until(() => plugin.actions.list().length > 0, 10_000);
  await until(() => tree.snapshots.at(-1).nodes.find(value => value.id === nodeId)?.availability === 'online', 10_000);
  assert.deepEqual((await plugin.sessions.snapshot(ref)).entries, online.entries);
  assert.equal((await readdir(path.join(home, 'backups'))).filter(name => name.endsWith('.db')).length, 1, 'v7 重启不再迁移');
});
