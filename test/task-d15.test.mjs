import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { startDaemon } from '../packages/daemon/dist/index.js';
import { createClient, connectHost } from '../packages/protocol/dist/index.js';
import { openStore, schemaMigrations } from '../packages/daemon/dist/store.js';
import { checkToolPath } from '../packages/extension/dist/permissions.js';

async function until(fn) {
  const deadline = Date.now() + 5000;
  do { const result = await fn(); if (result) return result; await delay(5); } while (Date.now() < deadline);
  assert.fail('等待 D15 状态超时');
}
class Driver {
  handles = [];
  async resolveSkills(names) {
    return names.map(name => { if (!['allowed', 'other'].includes(name)) throw new Error('unknown'); return { name, path: join(tmpdir(), 'agora-skills', name) }; });
  }
  async start(spec) {
    const launch = await fetch(spec.env.AGORA_URL + '/v1/auth/launch', { method: 'POST', headers: { 'Agora-Protocol': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket: spec.env.AGORA_LAUNCH_TICKET }) }).then(r => r.json());
    const client = createClient({ url: spec.env.AGORA_URL, token: launch.token });
    const listeners = new Set(), exits = new Set(); let resolveExit;
    const h = { spec, client, commands: [], identity: { pid: 99000 + this.handles.length, startTime: 'fake', runId: spec.runId, instanceId: spec.instanceId },
      exited: new Promise(resolve => { resolveExit = resolve; }),
      onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); }, onExit(fn) { exits.add(fn); return () => exits.delete(fn); },
      emit(event) { for (const fn of listeners) fn(event); }, emitExit(exit) { for (const fn of exits) fn(exit); }, markReady() { this.ready = true; }, diagnostics() { return {}; }, respondUi() {},
      async send(cmd) {
        this.commands.push(cmd);
        if (cmd.type === 'abort') { this.onAbort?.(); this.emit({ type: 'agent_settled', aborted: true }); }
        const data = cmd.type === 'get_available_models' ? { models: [{ provider: 'test', id: 'model' }] }
          : cmd.type === 'get_state' ? { model: { provider: 'test', id: 'model' }, thinkingLevel: spec.thinking, sessionFile: spec.sessionFile }
          : cmd.type === 'get_last_assistant_text' ? { text: '结果' } : {};
        return { success: true, data };
      },
      async stop() {
        this.stopped = true;
        if (this.failStop) throw new Error('unconfirmed');
        this.onStop?.();
        const report = { coverage: process.platform === 'win32' ? 'job_object' : 'snapshot_visible', steps: [], leftovers: [] };
        const exit = { identity: this.identity, code: 0, signal: null, cleanupConfirmed: true, stopReport: report };
        resolveExit(exit); for (const fn of exits) fn(exit); client.close(); return report;
      },
    };
    this.handles.push(h);
    void client.request('POST', `/v1/runs/${spec.runId}/ready`, { ...launch.policy, tools: spec.tools }).catch(() => {});
    return h;
  }
  async recoverOldRun() { return { coverage: 'snapshot_visible', steps: [], leftovers: [] }; }
}
async function setup(t, options = {}, config) {
  const home = await mkdtemp(join(tmpdir(), 'agora-d15-')), driver = new Driver(), clients = [];
  if (config) await writeFile(join(home, 'config.json'), JSON.stringify(config));
  const daemon = await startDaemon({ home, driver, maxTaskDepth: 4, maxConcurrentRuns: 8, ...options });
  t.after(async () => { clients.forEach(client => client.close()); await daemon.close({ force: true }); await rm(home, { recursive: true, force: true }); });
  const main = async () => {
    const client = await connectHost({ home, as: 'agent:main', autoStart: false }); clients.push(client);
    await client.request('POST', '/v1/principals/register', { sessionId: randomUUID(), sessionFile: join(home, randomUUID() + '.jsonl'), cwd: home });
    return client;
  };
  const spawn = (client, body = {}) => client.request('POST', '/v1/tasks', { model: 'test/model', profile: 'explore', prompt: '窄任务', cwd: home, ...body });
  const handle = task => until(() => driver.handles.findLast(h => h.spec.agoraSessionId === task.agoraSessionId && h.ready && !h.stopped && h.commands.some(c => c.type === 'prompt')));
  const settle = async h => { h.emit({ type: 'agent_settled', aborted: false }); await daemon.tasks.flush(); };
  return { home, driver, daemon, main, spawn, handle, settle };
}
const usage = (id, multiplier = 1) => ({ type: 'usage_record', requestId: id, inputTokens: 10 * multiplier, cacheReadTokens: 20 * multiplier, cacheWriteTokens: 3 * multiplier, outputTokens: 4 * multiplier, reasoningTokens: 2 * multiplier, contextTokens: 33 * multiplier });
const pause = async (f, h, resumeAt = new Date(Date.now() + 100).toISOString()) => { h.emit({ type: 'quota_exhausted', resumeAt, reason: '429 usage_limit_reached' }); await f.settle(h); };

test('D15 任务书标记、skills 默认空、指定覆盖档位默认值、下级只能取子集', async t => {
  const f = await setup(t), main = await f.main(), empty = await f.spawn(main), e = await f.handle(empty);
  assert.deepEqual(empty.skills, []); assert.deepEqual(e.spec.skillPaths, []);
  assert.match(e.commands.find(c => c.type === 'prompt').message, /^你是子代理。\n/);
  const parent = await f.spawn(main, { skills: ['allowed'] }), p = await f.handle(parent);
  assert.deepEqual(p.spec.skillPaths, [join(tmpdir(), 'agora-skills', 'allowed')]);
  await assert.rejects(f.spawn(main, { skills: ['missing'] }), err => err.code === 'skill_not_found');
  await assert.rejects(f.spawn(p.client, { skills: ['other'] }), err => err.code === 'skill_upgrade');
  await assert.rejects(f.spawn(main, { skills: ['../allowed'] }), err => err.code === 'invalid_params');
  const child = await f.spawn(p.client, { skills: ['allowed'] }); assert.deepEqual(child.skills, ['allowed']);
  const none = await f.spawn(p.client); assert.deepEqual(none.skills, []);
  const configured = await setup(t, {}, { defaultSkills: { explore: ['allowed'] } }), m = await configured.main();
  assert.deepEqual((await configured.spawn(m)).skills, ['allowed']);
  const disabled = await configured.spawn(m, { skills: [] }); assert.deepEqual(disabled.skills, []);
  const disabledHandle = await configured.handle(disabled);
  await assert.rejects(configured.spawn(disabledHandle.client), err => err.code === 'skill_upgrade');
  assert.deepEqual((await configured.spawn(disabledHandle.client, { skills: [] })).skills, []);
  await assert.rejects(f.spawn(main, { skills: null }), err => err.code === 'invalid_params');
});

test('D15 skill 根目录对文件工具只读放行，名单外仍拒绝', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agora-skill-gate-')); t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'project'), allowed = join(root, 'allowed'), other = join(root, 'other'), secret = join(root, 'secret');
  for (const dir of [cwd, allowed, other, secret]) { await mkdir(dir); await writeFile(join(dir, 'SKILL.md'), 'skill'); }
  const p = { profile: 'explore', tools: ['read', 'grep', 'find', 'ls', 'agora_task', 'agora_request'], allowedRoots: [cwd], protectedPaths: [secret], readOnlyRoots: [allowed] };
  const check = (policy, toolName, path) => checkToolPath({ toolName, input: { path } }, { cwd }, policy);
  assert.equal(await check(p, 'read', join(allowed, 'SKILL.md')), undefined);
  assert.match(await check(p, 'read', join(other, 'SKILL.md')), /允许的目录/);
  assert.equal(await check(p, 'find', allowed), undefined);
  assert.match(await check(p, 'find', root), /受保护/);
  const imp = { ...p, profile: 'implement', tools: [...p.tools, 'agora_git', 'bash', 'edit', 'write'] };
  assert.match(await check(imp, 'write', join(allowed, 'new.txt')), /只允许读取/);
  assert.match(await check(imp, 'edit', join(allowed, 'SKILL.md')), /只允许读取/);
  assert.equal(await check(imp, 'bash', allowed), undefined);
});

test('D15 同项目两个主会话时孙代理提问只投递直接上级', async t => {
  const f = await setup(t), m1 = await f.main(), m2 = await f.main();
  const parent = await f.spawn(m1), p = await f.handle(parent), child = await f.spawn(p.client), c = await f.handle(child);
  const question = await c.client.request('POST', '/v1/requests', { questions: [{ id: 'q', question: '是否继续？' }] });
  const inbox = await p.client.request('GET', '/v1/inbox'); assert.equal(inbox.items.length, 1);
  assert.equal(inbox.items[0].payload.requestId, question.id);
  for (const client of [m1, m2, c.client]) assert.equal((await client.request('GET', '/v1/inbox')).items.length, 0);
  await assert.rejects(m2.request('GET', `/v1/requests/${question.id}`), err => err.code === 'forbidden');
});

test('D15 逐请求记账关联任务/代/会话，用量去重并按任务树汇总', async t => {
  const f = await setup(t), main = await f.main(), parent = await f.spawn(main), p = await f.handle(parent), child = await f.spawn(p.client), c = await f.handle(child);
  p.emit(usage('p1')); p.emit(usage('p1')); p.emit(usage('p2', 2)); c.emit(usage('c1', 3));
  const status = await main.request('GET', `/v1/tasks/${parent.taskId}`);
  assert.equal(status.usage.requests, 2); assert.equal(status.usage.inputTokens, 30); assert.equal(status.usage.contextTokens, 66);
  assert.equal(status.treeUsage.inputTokens, 60); assert.equal(status.treeUsage.cacheReadTokens, 120); assert.equal(status.treeUsage.cacheWriteTokens, 18);
  assert.equal(status.treeUsage.outputTokens, 24); assert.equal(status.treeUsage.reasoningTokens, 12); assert.equal(status.treeUsage.contextTokens, 165);
  await f.settle(c); await f.settle(p);
  const result = await main.request('GET', `/v1/tasks/${parent.taskId}/result`); assert.equal(result.usage.requests, 2); assert.deepEqual(result.treeUsage, status.treeUsage);
  assert.equal(f.daemon.store.get('SELECT agora_session_id FROM usage_records WHERE task_id=?', parent.taskId).agora_session_id, parent.agoraSessionId);
  await main.request('POST', `/v1/tasks/${parent.taskId}/steer`, { message: '核对遗漏' }); await until(() => p.commands.filter(c => c.type === 'prompt').length === 2);
  p.emit(usage('p3', 4)); await f.settle(p);
  const old = await main.request('GET', `/v1/tasks/${parent.taskId}/result?generation=1`);
  assert.equal(old.generationUsage.inputTokens, 30); assert.equal(old.usage.inputTokens, 70);
  const current = await main.request('GET', `/v1/tasks/${parent.taskId}/result`); assert.equal(current.generationUsage.inputTokens, 40);
});

test('N4 stop 收尾仍记录原代用量，确认退出后拒收，重复请求只记一次', async t => {
  const f = await setup(t), main = await f.main(), task = await f.spawn(main), h = await f.handle(task);
  h.onStop = () => { h.emit(usage('abort-tail')); h.emit(usage('abort-tail')); };
  await main.request('POST', `/v1/tasks/${task.taskId}/stop`, {});
  h.emit(usage('after-exit'));
  const rows = f.daemon.store.all('SELECT * FROM usage_records WHERE task_id=?', task.taskId);
  assert.equal(rows.length, 1); assert.equal(rows[0].request_id, 'abort-tail'); assert.equal(rows[0].generation, 1);
  assert.equal(rows[0].agora_session_id, task.agoraSessionId); assert.equal(rows[0].run_id, h.spec.runId);
});

test('N4 清理未确认的退出报告不提前关闭记账', async t => {
  const f = await setup(t), main = await f.main(), task = await f.spawn(main), h = await f.handle(task);
  h.emitExit({ identity: h.identity, code: null, signal: null, cleanupConfirmed: false }); await f.daemon.tasks.flush();
  h.emit(usage('unconfirmed-tail'));
  assert.equal(f.daemon.store.usage(task.taskId, false, 1).requests, 1);
  await main.request('POST', `/v1/tasks/${task.taskId}/stop`, {});
  h.emit(usage('confirmed-late')); assert.equal(f.daemon.store.usage(task.taskId).requests, 1);
});

test('N4 interrupt abort 收尾归旧代，复用运行的新代不重复、不误记', async t => {
  const f = await setup(t), main = await f.main(), task = await f.spawn(main), h = await f.handle(task);
  h.onAbort = () => { h.emit(usage('old-tail')); h.emit(usage('old-tail')); };
  await main.request('POST', `/v1/tasks/${task.taskId}/steer`, { message: '新代', interrupt: true });
  await until(() => h.commands.filter(c => c.type === 'prompt').length === 2);
  h.emit(usage('old-tail')); h.emit(usage('new-turn', 2)); await f.settle(h);
  const old = f.daemon.store.usage(task.taskId, false, 1), current = f.daemon.store.usage(task.taskId, false, 2);
  assert.equal(old.requests, 1); assert.equal(old.inputTokens, 10); assert.equal(current.requests, 1); assert.equal(current.inputTokens, 20);
  for (const row of f.daemon.store.all('SELECT * FROM usage_records WHERE task_id=?', task.taskId)) {
    assert.equal(row.agora_session_id, task.agoraSessionId); assert.equal(row.run_id, h.spec.runId);
  }
});

test('D15 额度暂停不失败、不占名额，到期通知上级并附上下文，续跑父任务不续跑下级', async t => {
  const f = await setup(t), main = await f.main(), parent = await f.spawn(main), p = await f.handle(parent), child = await f.spawn(p.client), c = await f.handle(child);
  p.emit(usage('p')); c.emit(usage('c', 2));
  const reset = new Date(Date.now() + 200).toISOString(); await pause(f, c, reset); await pause(f, p, reset);
  assert.equal(f.daemon.store.task(parent.taskId).status, 'quota_paused'); assert.equal(f.daemon.store.task(child.taskId).status, 'quota_paused'); assert.equal(f.daemon.tasks.activeCount(), 0);
  // 两次 HTTP 暂停在慢 runner 上可能超过 200ms；边界断言固定业务时钟，不放宽生产等待。
  const clock = t.mock.method(Date, 'now', () => Date.parse(reset) - 1);
  try { await assert.rejects(main.request('POST', `/v1/tasks/${parent.taskId}/recover`, { mode: 'resume' }), err => err.code === 'quota_not_reset'); }
  finally { clock.mock.restore(); }
  await until(() => f.daemon.store.get("SELECT id FROM outbox WHERE recipient_id=? AND kind='task:quota_ready'", f.daemon.store.task(parent.taskId).convener_id));
  const notices = await main.request('GET', '/v1/inbox'); assert.equal(notices.items[0].kind, 'task:quota_ready'); assert.equal(notices.items[0].payload.tasks[0].contextTokens, 33);
  assert.equal(f.driver.handles.length, 2);
  await main.request('POST', `/v1/tasks/${parent.taskId}/recover`, { mode: 'resume' });
  const resumed = await f.handle(parent); assert.notEqual(resumed, p); assert.equal(f.daemon.store.task(child.taskId).status, 'quota_paused'); assert.equal(f.driver.handles.length, 3);
  await main.request('POST', `/v1/tasks/${parent.taskId}/stop`, {}); assert.equal(f.daemon.store.task(child.taskId).status, 'stopped');
});

test('D15 同代相同重置时间再次暂停产生新通知，已确认的旧事件不吞掉新事件', async t => {
  const f = await setup(t), main = await f.main(), task = await f.spawn(main), h = await f.handle(task);
  const reset = new Date(Date.now() - 1000).toISOString();
  await pause(f, h, reset);
  const first = await until(() => f.daemon.store.get("SELECT * FROM outbox WHERE kind='task:quota_ready'"));
  f.daemon.store.run('UPDATE outbox SET acked_at=? WHERE id=?', new Date().toISOString(), first.id);
  await main.request('POST', `/v1/tasks/${task.taskId}/recover`, { mode: 'resume' });
  const resumed = await f.handle(task);
  assert.notEqual(resumed, h);
  await pause(f, resumed, reset);
  await until(() => f.daemon.store.task(task.taskId).quota_notified_at);
  const notices = f.daemon.store.all("SELECT * FROM outbox WHERE kind='task:quota_ready' ORDER BY rowid");
  assert.equal(notices.length, 2);
  assert.notEqual(notices[0].dedupe_key, notices[1].dedupe_key);
  assert.ok(notices[0].acked_at); assert.equal(notices[1].acked_at, null);
  assert.equal(f.daemon.store.task(task.taskId).generation, 1);
  const inbox = await main.request('GET', '/v1/inbox');
  assert.deepEqual(inbox.items.filter(item => item.kind === 'task:quota_ready').map(item => item.noticeId), [notices[1].id]);
  f.daemon.tasks.armQuotaTimer(f.daemon.store.task(task.taskId));
  await delay(20); await f.daemon.tasks.flush();
  assert.equal(f.daemon.store.get("SELECT COUNT(*) AS n FROM outbox WHERE kind='task:quota_ready'").n, 2);
});

test('R4 未知额度停止失败仍立即唤醒 waiting_children 父任务，未确认运行禁止恢复', async t => {
  const f = await setup(t), main = await f.main(), parent = await f.spawn(main), p = await f.handle(parent);
  const child = await f.spawn(p.client, { notify: 'silent' }), c = await f.handle(child);
  await f.settle(p);
  assert.equal(f.daemon.store.task(parent.taskId).status, 'waiting_children');
  assert.equal(p.commands.filter(cmd => cmd.type === 'prompt').length, 1);
  c.failStop = true;
  try {
    await pause(f, c, null);
    await until(() => f.daemon.store.task(parent.taskId).status === 'running');
    assert.equal(f.daemon.tasks.activeCount(), 1);
    assert.equal(f.daemon.store.task(child.taskId).status, 'quota_paused');
    assert.equal(c.stopped, true);
    assert.equal(f.daemon.store.get('SELECT exited_at FROM process_runs WHERE id=?', c.spec.runId).exited_at, null);
    const inbox = await p.client.request('GET', '/v1/inbox');
    const notice = inbox.items.find(item => item.kind === 'task:quota_unknown' && item.payload.taskId === child.taskId);
    assert.ok(notice);
    assert.equal(notice.payload.triggerTurn, true);
    assert.equal(notice.payload.generation, 1);
    await assert.rejects(p.client.request('POST', `/v1/tasks/${child.taskId}/recover`, { mode: 'resume' }), err => err.code === 'stop_incomplete');
    assert.equal(f.driver.handles.length, 2);
    assert.equal(f.daemon.store.task(child.taskId).generation, 1);
  } finally { c.failStop = false; }
});

test('D15 配置 auto 到期只续跑该任务，未知重置时间不编造定时器，普通错误仍失败', async t => {
  const f = await setup(t, {}, { quotaRecovery: 'auto' }), main = await f.main(), task = await f.spawn(main), h = await f.handle(task);
  await pause(f, h); const resumed = await until(() => f.driver.handles.find(item => item !== h && item.ready));
  assert.equal(f.daemon.store.task(task.taskId).status, 'running'); assert.equal(resumed.spec.agoraSessionId, task.agoraSessionId);
  const unknown = await f.spawn(main), u = await f.handle(unknown); await pause(f, u, null);
  assert.equal(f.daemon.store.task(unknown.taskId).quota_resume_at, null); assert.equal(f.daemon.store.task(unknown.taskId).status, 'quota_paused');
  const errorTask = await f.spawn(main), e = await f.handle(errorTask); e.emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: '429 rate_limit_exceeded' } }); await f.settle(e);
  assert.equal(f.daemon.store.task(errorTask.taskId).status, 'failed');
});

test('D15 schema v3 到当前版本迁移前一致性备份，保留数据和默认空名单', async t => {
  const home = await mkdtemp(join(tmpdir(), 'agora-d15-migrate-')); t.after(() => rm(home, { recursive: true, force: true }));
  const db = new DatabaseSync(join(home, 'agora.db')); for (const migration of schemaMigrations.slice(0, 3)) db.exec(migration);
  db.exec("CREATE TABLE schema_version(version INTEGER,migrated_at TEXT); INSERT INTO schema_version VALUES(3,'v3'); INSERT INTO principals(id,type,created_at) VALUES('main','agent:main','time'); PRAGMA journal_mode=WAL;"); db.close();
  const store = await openStore(home); assert.equal(store.get('SELECT version FROM schema_version').version, 5); assert.equal(store.principal('main').type, 'agent:main'); assert.deepEqual(store.all('PRAGMA foreign_key_check'), []);
  assert.equal(store.all('PRAGMA table_info(tasks)').find(column => column.name === 'skills').dflt_value, "'[]'");
  assert.equal(store.all('PRAGMA table_info(tasks)').find(column => column.name === 'skill_paths').dflt_value, "'[]'");
  store.close();
  const files = (await readdir(join(home, 'backups'))).filter(file => file.endsWith('.db')); assert.equal(files.length, 1);
  const backup = new DatabaseSync(join(home, 'backups', files[0]), { readOnly: true }); try { assert.equal(backup.prepare('SELECT version FROM schema_version').get().version, 3); assert.equal(backup.prepare('PRAGMA integrity_check').get().integrity_check, 'ok'); } finally { backup.close(); }
});

test('D15 v4 迁移冲突回滚，原库版本与旧数据保持不变', async t => {
  const home = await mkdtemp(join(tmpdir(), 'agora-d15-rollback-')); t.after(() => rm(home, { recursive: true, force: true }));
  const db = new DatabaseSync(join(home, 'agora.db')); for (const migration of schemaMigrations.slice(0, 3)) db.exec(migration);
  db.exec("CREATE TABLE schema_version(version INTEGER,migrated_at TEXT); INSERT INTO schema_version VALUES(3,'v3'); CREATE TABLE usage_records(sentinel TEXT); INSERT INTO usage_records VALUES('旧数据');"); db.close();
  await assert.rejects(openStore(home), /already exists/);
  const original = new DatabaseSync(join(home, 'agora.db')); try {
    assert.equal(original.prepare('SELECT version FROM schema_version').get().version, 3);
    assert.equal(original.prepare('SELECT sentinel FROM usage_records').get().sentinel, '旧数据');
    assert.equal(original.prepare('PRAGMA table_info(tasks)').all().some(column => column.name === 'skills'), false);
  } finally { original.close(); }
});

test('D15 daemon 重启保留额度暂停与定时通知，旧通知不会重复生成', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agora-d15-restart-')); let daemon, client;
  const driver = new Driver();
  try {
    daemon = await startDaemon({ home, driver }); client = await connectHost({ home, as: 'host:cli', autoStart: false });
    const task = await client.request('POST', '/v1/tasks', { model: 'test/model', profile: 'explore', prompt: '暂停后恢复', cwd: home });
    const h = await until(() => driver.handles.find(h => h.ready && h.commands.some(c => c.type === 'prompt')));
    const reset = new Date(Date.now() + 350).toISOString();
    h.emit({ type: 'quota_exhausted', reason: 'usage_limit_reached', resumeAt: reset }); h.emit({ type: 'agent_settled' }); await daemon.tasks.flush();
    client.close(); await daemon.close({ force: true });
    daemon = await startDaemon({ home, driver });
    assert.equal(daemon.store.task(task.taskId).status, 'quota_paused'); assert.equal(daemon.store.task(task.taskId).quota_resume_at, reset);
    await until(() => daemon.store.get("SELECT COUNT(*) AS n FROM outbox WHERE kind='task:quota_ready'").n === 1);
    await daemon.close({ force: true }); daemon = await startDaemon({ home, driver });
    assert.equal(daemon.store.get("SELECT COUNT(*) AS n FROM outbox WHERE kind='task:quota_ready'").n, 1);
    assert.equal(driver.handles.length, 1);
  } finally { client?.close(); await daemon?.close({ force: true }); await rm(home, { recursive: true, force: true }); }
});

for (const boundary of ['stopping', 'before-notify', 'legacy-pending']) test(`N5 未知重置时间在 ${boundary} 退出后仍投递一次提示`, async () => {
  const home = await mkdtemp(join(tmpdir(), 'agora-quota-crash-')), driver = new Driver(); let daemon, client;
  try {
    daemon = await startDaemon({ home, driver }); client = await connectHost({ home, as: 'host:cli', autoStart: false });
    const task = await client.request('POST', '/v1/tasks', { model: 'test/model', profile: 'explore', prompt: '未知额度恢复', cwd: home });
    const h = await until(() => driver.handles.find(h => h.ready && h.commands.some(c => c.type === 'prompt')));
    const notify = daemon.tasks.notifyConvener;
    if (boundary === 'stopping') h.failStop = true;
    else if (boundary === 'before-notify') daemon.tasks.notifyConvener = () => { throw new Error('模拟内存通知前退出'); };
    h.emit({ type: 'quota_exhausted', resumeAt: null, reason: 'usage_limit_reached' }); h.emit({ type: 'agent_settled' }); await daemon.tasks.flush();
    assert.equal(daemon.store.task(task.taskId).status, 'quota_paused');
    assert.equal(daemon.store.get("SELECT COUNT(*) AS n FROM outbox WHERE kind='task:quota_unknown'").n, 1);
    h.failStop = false; daemon.tasks.notifyConvener = notify;
    client.close(); await daemon.close({ force: true }); daemon = undefined;
    if (boundary === 'legacy-pending') {
      const store = await openStore(home);
      store.run("DELETE FROM outbox WHERE kind='task:quota_unknown'");
      store.run('UPDATE tasks SET quota_notified_at=NULL WHERE id=?', task.taskId); store.close();
    }
    daemon = await startDaemon({ home, driver });
    client = await connectHost({ home, as: 'host:cli', autoStart: false });
    const inbox = await client.request('GET', '/v1/inbox'), notices = inbox.items.filter(n => n.kind === 'task:quota_unknown');
    assert.equal(notices.length, 1); assert.equal(notices[0].payload.taskId, task.taskId); assert.equal(notices[0].payload.triggerTurn, true);
    await client.request('POST', '/v1/inbox/ack', { noticeId: notices[0].noticeId, entryId: 'quota-crash-notice', persisted: true });
    client.close(); await daemon.close({ force: true }); daemon = await startDaemon({ home, driver });
    client = await connectHost({ home, as: 'host:cli', autoStart: false });
    assert.equal((await client.request('GET', '/v1/inbox')).items.filter(n => n.kind === 'task:quota_unknown').length, 0);
    assert.equal(daemon.store.get("SELECT COUNT(*) AS n FROM outbox WHERE kind='task:quota_unknown'").n, 1);
    assert.equal(driver.handles.length, 1);
  } finally { client?.close(); await daemon?.close({ force: true }); await rm(home, { recursive: true, force: true }); }
});

test('D15 auto 续跑父任务不隐式恢复无重置时间的下级；停止暂停任务取消到期恢复', async t => {
  const f = await setup(t, {}, { quotaRecovery: 'auto' }), main = await f.main(), parent = await f.spawn(main), p = await f.handle(parent), child = await f.spawn(p.client), c = await f.handle(child);
  await pause(f, c, null); await pause(f, p);
  await until(() => f.driver.handles.length === 3);
  assert.equal(f.daemon.store.task(child.taskId).status, 'quota_paused');
  const stopTask = await f.spawn(main), s = await f.handle(stopTask); await pause(f, s, new Date(Date.now() + 100).toISOString());
  await main.request('POST', `/v1/tasks/${stopTask.taskId}/stop`, {});
  await delay(150); assert.equal(f.daemon.store.task(stopTask.taskId).status, 'stopped'); assert.equal(f.driver.handles.filter(h => h.spec.agoraSessionId === stopTask.agoraSessionId).length, 1);
});

test('N3 静默终态和强制唤醒同事务提交，调度前退出后重启仍唤醒等待父任务', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agora-terminal-crash-')), driver = new Driver(); let daemon, main;
  try {
    daemon = await startDaemon({ home, driver }); main = await connectHost({ home, as: 'host:cli', autoStart: false });
    const spawn = (client, body = {}) => client.request('POST', '/v1/tasks', { model: 'test/model', profile: 'explore', prompt: '恢复测试', cwd: home, ...body });
    const parent = await spawn(main), p = await until(() => driver.handles.find(h => h.ready && h.commands.some(c => c.type === 'prompt')));
    const child = await spawn(p.client, { notify: 'silent' }); await until(() => driver.handles.length === 2 && driver.handles[1].ready);
    p.emit({ type: 'agent_settled' }); await daemon.tasks.flush();
    assert.equal(daemon.store.task(parent.taskId).status, 'waiting_children');
    main.close(); await daemon.close({ force: true }); daemon = undefined;
    // 直接提交终态，故意不执行 TaskManager 的内存通知/调度，模拟持久化后的退出边界。
    const store = await openStore(home);
    store.run('DELETE FROM outbox WHERE json_extract(payload,\'$.taskId\')=?', child.taskId);
    store.transition(store.task(child.taskId), 'completed', '完成');
    const notice = store.get('SELECT payload FROM outbox WHERE kind=\'task:completed\'');
    assert.equal(JSON.parse(notice.payload).triggerTurn, true); store.close();
    daemon = await startDaemon({ home, driver });
    await until(() => daemon.store.task(parent.taskId).status === 'running');
    assert.equal(driver.handles.length, 3);
  } finally { main?.close(); await daemon?.close({ force: true }); await rm(home, { recursive: true, force: true }); }
});
