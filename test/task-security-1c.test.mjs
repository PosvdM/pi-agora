import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { openStore } from '../packages/daemon/dist/store.js';
import { Auth, proof as hostProof } from '../packages/daemon/dist/auth.js';
import { TaskManager } from '../packages/daemon/dist/tasks.js';
import { Requests } from '../packages/daemon/dist/requests.js';
import { Budgets, budgetConfig, countTokens, localBudgetDay } from '../packages/daemon/dist/budgets.js';

const signed = { deviceId: 'device-test', confirmationId: 'confirm-test', requestedBy: 'host:pane', confirmedBy: 'device' };
const unsigned = { ...signed, confirmedBy: 'none' };
const errorCode = code => error => error.code === code;
const usage = (requestId, n = 1) => ({ type: 'usage_record', requestId, inputTokens: 10 * n, cacheReadTokens: 20 * n, cacheWriteTokens: 3 * n, outputTokens: 4 * n, reasoningTokens: 2 * n, contextTokens: 33 * n });
async function until(fn) {
  const deadline = Date.now() + 4000;
  do { const value = fn(); if (value) return value; await delay(2); } while (Date.now() < deadline);
  assert.fail('等待模拟运行超时');
}
// 生产迁移由 schema 任务提供；这里只为尚处于 v4 的工作树建立测试兼容列。
function fixtureSchema(store) {
  if (!store.all('PRAGMA table_info(tasks)').some(c => c.name === 'max_tokens')) store.db.exec('ALTER TABLE tasks ADD COLUMN max_tokens INTEGER NOT NULL DEFAULT 2000000');
  if (!store.all('PRAGMA table_info(requests)').some(c => c.name === 'answer_proof')) store.db.exec('ALTER TABLE requests ADD COLUMN answer_proof TEXT');
  store.db.exec('CREATE TABLE IF NOT EXISTS budget_grants(id TEXT PRIMARY KEY,resource_id TEXT NOT NULL,principal_id TEXT NOT NULL,day TEXT NOT NULL,tokens INTEGER NOT NULL,confirmed_by TEXT NOT NULL,created_at TEXT NOT NULL)');
}
class Driver {
  handles = [];
  async start(spec) {
    const auth = this.auth;
    const launched = auth.launch({ ticket: spec.env.AGORA_LAUNCH_TICKET });
    const conn = auth.authenticate(`Bearer ${launched.token}`);
    const events = new Set(), exits = new Set(); let resolveExit;
    const h = { spec, conn, commands: [], ready: false, stopped: false,
      identity: { pid: 88000 + this.handles.length, startTime: 'fake', runId: spec.runId, instanceId: spec.instanceId },
      exited: new Promise(resolve => { resolveExit = resolve; }),
      onEvent(fn) { events.add(fn); return () => events.delete(fn); }, onExit(fn) { exits.add(fn); return () => exits.delete(fn); },
      emit(event) { for (const fn of events) fn(event); }, markReady() { this.ready = true; }, diagnostics() { return {}; }, respondUi() {},
      async send(command) {
        this.commands.push(command);
        if (this.barrier?.type === command.type) await this.barrier.promise;
        if (command.type === 'abort') { this.onAbort?.(); this.emit({ type: 'agent_settled', aborted: true }); }
        const data = command.type === 'get_available_models' ? { models: ['test/model'] }
          : command.type === 'get_state' ? { model: 'test/model', thinkingLevel: spec.thinking, sessionFile: spec.sessionFile }
          : command.type === 'get_last_assistant_text' ? { text: '私有结果' } : {};
        return { success: true, data };
      },
      async stop() {
        if (this.failStop) throw new Error('模拟退出未确认');
        if (this.stopped) return this.report;
        this.onStop?.(); this.stopped = true;
        this.report = { coverage: 'snapshot_visible', steps: [{ step: 'verify', ok: true }], leftovers: [] };
        const exit = { identity: this.identity, code: 0, signal: null, cleanupConfirmed: true, stopReport: this.report };
        resolveExit(exit); for (const fn of exits) fn(exit); return this.report;
      },
    };
    this.handles.push(h);
    queueMicrotask(() => this.tasks.ready(conn, { ...launched.policy, tools: spec.tools }, spec.runId).catch(() => {}));
    return h;
  }
  async recoverOldRun() { return { coverage: 'snapshot_visible', steps: [], leftovers: [] }; }
}
async function setup(t, options = {}) {
  const home = await mkdtemp(join(tmpdir(), 'agora-security-1c-'));
  const store = await openStore(home); fixtureSchema(store);
  const auth = await Auth.create(store, 'test-instance'), driver = new Driver();
  const tasks = new TaskManager(store, auth, driver, { home, instanceId: 'test-instance', url: 'http://test', maxTaskDepth: 4, maxConcurrentRuns: 8, taskLimitDefaults: { maxTokens: 1000 }, agentLimitCap: { perTaskFactor: 2, dailyTokens: 10000 }, ...options });
  driver.auth = auth; driver.tasks = tasks; tasks.startQueue();
  const requests = new Requests(store, auth, tasks);
  t.after(async () => { requests.close(); for (const h of driver.handles) h.failStop = false; await tasks.shutdown(true, 1000); store.close(); await rm(home, { recursive: true, force: true }); });
  // 真实读取 host.key 完成挑战认证，以验证主机凭证不等于用户签名。
  async function connect(type) {
    const key = await readFile(join(home, 'secret', 'host.key'));
    const challenge = auth.challenge({ clientNonce: randomUUID() });
    const response = auth.exchange({ challengeId: challenge.challengeId, clientProof: hostProof(key, ['client', challenge.serverNonce, 'test-instance']), as: type });
    const conn = auth.authenticate(`Bearer ${response.token}`);
    if (type === 'agent:main') await auth.register(conn, { sessionId: randomUUID(), ephemeral: true, cwd: home });
    return conn;
  }
  const main = () => connect('agent:main'), host = await connect('host:cli');
  const spawn = (conn, body = {}, proof) => tasks.spawn(conn, { model: 'test/model', profile: 'explore', prompt: '私有任务书', cwd: home, ...body }, proof);
  const handle = task => until(() => driver.handles.findLast(h => h.spec.agoraSessionId === task.agoraSessionId && h.ready && !h.stopped && h.commands.some(c => c.type === 'prompt')));
  const settle = async h => { h.emit({ type: 'agent_settled', aborted: false }); await tasks.flush(); };
  return { home, store, auth, driver, tasks, requests, main, host, spawn, handle, settle };
}

test('1c main、child、host 资源矩阵与跨级操作保护', async t => {
  const f = await setup(t), m1 = await f.main(), m2 = await f.main();
  const root = await f.spawn(m1), p = await f.handle(root), child = await f.spawn(p.conn), c = await f.handle(child), sibling = await f.spawn(p.conn);
  await f.handle(sibling);
  assert.equal(f.tasks.status(m1, child.taskId).prompt, '私有任务书');
  assert.equal(f.tasks.status(f.host, child.taskId).prompt, '私有任务书');
  assert.throws(() => f.tasks.status(m2, root.taskId), errorCode('forbidden'));
  assert.throws(() => f.tasks.result(m2, root.taskId), errorCode('forbidden'));
  const summary = f.tasks.list(m2, 'all', 50, 0).items[0];
  assert.deepEqual(Object.keys(summary).sort(), ['convener', 'status', 'taskId', 'title']);
  assert.equal(f.tasks.status(c.conn, child.taskId).prompt, undefined);
  assert.throws(() => f.tasks.result(c.conn, child.taskId), errorCode('forbidden'));
  assert.throws(() => f.tasks.result(c.conn, sibling.taskId), errorCode('forbidden'));
  assert.throws(() => f.tasks.status(c.conn, root.taskId), errorCode('forbidden'));
  assert.throws(() => f.tasks.list(c.conn, 'all', 50, 0), errorCode('forbidden'));
  assert.deepEqual(f.tasks.list(p.conn, 'mine', 50, 0).items.map(x => x.taskId).sort(), [child.taskId, sibling.taskId].sort());
  for (const action of ['steer', 'cleanup', 'recover']) await assert.rejects(f.tasks[action](m1, child.taskId, { message: '越级', mode: 'resume' }), errorCode('forbidden'));
  await assert.rejects(f.tasks.steer(f.host, root.taskId, { message: '主机越权' }), errorCode('forbidden'));
  await assert.rejects(f.tasks.stop(c.conn, sibling.taskId, {}), errorCode('forbidden'));
  await f.tasks.stop(m1, root.taskId, {});
  assert.equal(f.store.task(child.taskId).status, 'stopped');
  assert.equal(f.store.task(sibling.taskId).status, 'stopped');
  await f.tasks.cleanup(f.host, root.taskId, {});
});

test('1c host.key 不能直接答复，可信答复保留证明与签名前后 revision', async t => {
  const f = await setup(t), m = await f.main();
  const q = f.requests.ask(m, { questions: [{ id: 'q', question: '继续？' }] });
  const body = { answers: [{ id: 'q', selected: [], custom: '同意' }], expectedRevision: q.revision, user: true, proof: signed };
  assert.throws(() => f.requests.update(f.host, q.id, 'answer', body), e => e.code === 'confirmation_required' && e.details.action === 'agora.request.answer' && e.details.target === q.id && e.details.params === body);
  assert.throws(() => f.requests.update(f.host, q.id, 'cancel', body), e => e.code === 'confirmation_required' && e.details.action === 'agora.request.cancel');
  assert.throws(() => f.requests.updateUser(f.host, q.id, 'answer', { ...body, expectedRevision: 0 }, signed), errorCode('conflict'));
  const answered = f.requests.updateUser(f.host, q.id, 'answer', body, signed);
  assert.equal(answered.answeredBy, 'user'); assert.deepEqual(answered.answeredVia, signed);
  assert.deepEqual(JSON.parse(f.store.get('SELECT answer_proof FROM requests WHERE id=?', q.id).answer_proof), signed);
  assert.throws(() => f.requests.updateUser(f.host, q.id, 'answer', body, signed), errorCode('already_handled'));
  const off = f.requests.ask(m, { questions: [{ id: 'q', question: '关闭保护后的来源？' }] });
  assert.deepEqual(f.requests.updateUser(f.host, off.id, 'cancel', {}, unsigned).answeredVia, unsigned);
});

test('1c 提问只允许 asker/target 访问，逐级转交后不能撤销用户问题', async t => {
  const f = await setup(t), m = await f.main(), other = await f.main(), root = await f.spawn(m), p = await f.handle(root), child = await f.spawn(p.conn), c = await f.handle(child);
  assert.throws(() => f.requests.ask(f.host, { questions: [{ id: 'q', question: '主机' }] }), errorCode('forbidden'));
  const q = f.requests.ask(c.conn, { questions: [{ id: 'q', question: '子级问题' }] });
  assert.equal(q.targetId, p.conn.principalId);
  assert.throws(() => f.requests.detail(m, q.id), errorCode('forbidden'));
  assert.equal(f.requests.detail(f.host, q.id).id, q.id);
  assert.equal(f.requests.list(other).items.length, 0);
  assert.throws(() => f.requests.update(c.conn, q.id, 'answer', { answers: [] }), errorCode('forbidden'));
  const escalated = f.requests.update(p.conn, q.id, 'escalate', { expectedRevision: q.revision });
  assert.equal(escalated.targetId, m.principalId);
  assert.throws(() => f.requests.update(c.conn, q.id, 'cancel', {}), errorCode('forbidden'));
  f.requests.update(m, q.id, 'escalate', {});
  assert.equal(f.requests.detail(f.host, q.id).targetId, 'user');
  for (const actor of [c.conn, p.conn, m]) assert.throws(() => f.requests.update(actor, q.id, 'cancel', {}), errorCode('forbidden'));
  f.requests.updateUser(f.host, q.id, 'cancel', {}, signed);
  const open = f.requests.ask(c.conn, { questions: [{ id: 'q', question: '仍由父级接收' }] });
  const answered = f.requests.updateUser(f.host, open.id, 'answer', { answers: [{ id: 'q', selected: [], custom: '用户代答' }] }, signed);
  assert.equal(answered.answeredBy, 'user');
});

test('1c host 不得恢复可达 agent，不可达资源先签名接管', async t => {
  const f = await setup(t), m = await f.main(), root = await f.spawn(m), p = await f.handle(root);
  await p.stop(); await f.tasks.flush();
  assert.equal(f.store.task(root.taskId).status, 'interrupted');
  await assert.rejects(f.tasks.recover(f.host, root.taskId, { mode: 'resume' }, signed), errorCode('convener_reachable'));
  assert.throws(() => f.tasks.takeOver(f.host, root.taskId, {}, signed), errorCode('convener_reachable'));
  f.auth.release(m);
  await assert.rejects(f.tasks.recover(f.host, root.taskId, { mode: 'resume' }, signed), errorCode('takeover_required'));
  assert.throws(() => f.tasks.takeOver(f.host, root.taskId, {}, unsigned), errorCode('confirmation_required'));
  await f.tasks.takeOver(f.host, root.taskId, {}, signed);
  await assert.rejects(f.tasks.recover(f.host, root.taskId, { mode: 'resume' }), e => e.code === 'confirmation_required' && e.details.action === 'agora.task.recover');
  await f.tasks.recover(f.host, root.taskId, { mode: 'resume' }, signed);
  await f.handle(root);
});

test('1c 活跃 ready child 的直接任务不能被 host 接管或恢复', async t => {
  const f = await setup(t), m = await f.main(), root = await f.spawn(m), p = await f.handle(root), child = await f.spawn(p.conn), c = await f.handle(child);
  await c.stop(); await f.tasks.flush();
  await assert.rejects(f.tasks.recover(f.host, child.taskId, { mode: 'resume' }, signed), errorCode('convener_reachable'));
  assert.throws(() => f.tasks.takeOver(f.host, child.taskId, {}, signed), errorCode('convener_reachable'));
});

test('1c 多 principal 并发授予共用日账本，none proof 不能绕过封顶', async t => {
  const f = await setup(t, { taskLimitDefaults: { maxTokens: 100 }, agentLimitCap: { perTaskFactor: 2, dailyTokens: 150 } }), m1 = await f.main(), m2 = await f.main();
  const results = await Promise.allSettled([f.spawn(m1, { maxTokens: 80 }), f.spawn(m2, { maxTokens: 80 })]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'confirmation_required');
  assert.equal(f.store.get('SELECT SUM(tokens) AS n FROM budget_grants').n, 80);
  await assert.rejects(f.spawn(f.host, { maxTokens: 101 }, unsigned), errorCode('confirmation_required'));
  await assert.rejects(f.spawn(f.host, { maxTokens: 101, user: true, proof: signed, principalId: m1.principalId }), errorCode('confirmation_required'));
  await assert.rejects(f.spawn(m2, { maxTokens: 201 }, unsigned), errorCode('confirmation_required'));
  await assert.rejects(f.spawn(f.host, { maxTokens: 71 }, unsigned), e => e.code === 'confirmation_required' && e.details.target === 'new');
  const privileged = await f.spawn(f.host, { maxTokens: 900 }, signed); await f.handle(privileged);
  assert.equal(f.store.get("SELECT SUM(tokens) AS n FROM budget_grants WHERE confirmed_by!='device'").n, 80);
  assert.equal(f.store.get("SELECT tokens FROM budget_grants WHERE resource_id=?", privileged.taskId).tokens, 900);
});

test('1c 增额仅记差额，调低不退款，用户任务增额需可信入口', async t => {
  const f = await setup(t, { taskLimitDefaults: { maxTokens: 100 }, agentLimitCap: { perTaskFactor: 2, dailyTokens: 150 } }), m = await f.main();
  const root = await f.spawn(m, { maxTokens: 50 });
  await f.tasks.limits(m, root.taskId, { maxTokens: 100 });
  await f.tasks.limits(m, root.taskId, { maxTokens: 40 });
  assert.equal(f.store.get('SELECT SUM(tokens) AS n FROM budget_grants').n, 100);
  await f.tasks.limits(m, root.taskId, { maxTokens: 90 });
  assert.equal(f.store.get('SELECT SUM(tokens) AS n FROM budget_grants').n, 150);
  assert.throws(() => f.tasks.limits(m, root.taskId, { maxTokens: 91 }, unsigned), errorCode('confirmation_required'));
  await f.tasks.limits(m, root.taskId, { maxTokens: 1000 }, signed);
  const user = await f.spawn(f.host, { maxTokens: 300 }, signed);
  await f.tasks.limits(f.host, user.taskId, { maxTokens: 200 });
  assert.throws(() => f.tasks.limits(f.host, user.taskId, { maxTokens: 201 }), e => e.code === 'confirmation_required' && e.details.action === 'agora.task.limits');
  assert.throws(() => f.tasks.limits(f.host, user.taskId, { maxTokens: 201 }, unsigned), errorCode('confirmation_required'));
  await f.tasks.limits(f.host, user.taskId, { maxTokens: 1000 }, signed);
});

test('1c 预算配置优先读取 settings，计数包含缓存但不重复 reasoning', async t => {
  const f = await setup(t);
  f.store.run('INSERT INTO settings(key,value) VALUES(?,?)', 'taskLimitDefaults', JSON.stringify({ maxTokens: 73 }));
  f.store.run('INSERT INTO settings(key,value) VALUES(?,?)', 'agentLimitCap', JSON.stringify({ perTaskFactor: 3, dailyTokens: 222 }));
  f.store.run('INSERT INTO settings(key,value) VALUES(?,?)', 'tokenAccounting', JSON.stringify('uncached'));
  const config = budgetConfig(f.store, { taskLimitDefaults: { maxTokens: 1 } });
  assert.equal(config.defaults.maxTokens, 73); assert.equal(config.cap.dailyTokens, 222); assert.equal(config.accounting, 'uncached');
  const tokens = usage('q');
  assert.equal(countTokens(tokens, 'all'), 37); assert.equal(countTokens(tokens, 'uncached'), 17);
  const task = await f.spawn(await f.main()), h = await f.handle(task);
  h.emit(usage('one')); h.emit(usage('one')); h.emit(usage('two'));
  assert.equal(f.tasks.status(f.host, task.taskId).budget.usedTokens, 34);
  assert.equal(f.store.usage(task.taskId).requests, 2);
  f.store.run('UPDATE settings SET value=? WHERE key=?', JSON.stringify('all'), 'tokenAccounting');
  assert.equal(f.tasks.result(f.host, task.taskId).budget.usedTokens, 74);
});

test('1c 祖先预算暂停整树，停止尾量去重，增额与恢复不隐式恢复下级', async t => {
  const f = await setup(t), m = await f.main(), root = await f.spawn(m, { maxTokens: 100 }), p = await f.handle(root);
  const child = await f.spawn(p.conn), c = await f.handle(child), sibling = await f.spawn(p.conn), s = await f.handle(sibling);
  p.emit(usage('parent')); c.emit(usage('child'));
  c.onAbort = () => { c.emit(usage('abort-tail')); c.emit(usage('abort-tail')); };
  s.emit(usage('sibling'));
  assert.equal(f.store.task(root.taskId).status, 'budget_paused');
  assert.equal(f.store.task(child.taskId).status, 'budget_paused');
  assert.equal(f.store.task(sibling.taskId).status, 'budget_paused');
  await f.tasks.flush();
  assert.equal(f.tasks.activeCount(), 0);
  for (const h of [p, c, s]) assert.deepEqual(h.commands.filter(c => ['clear_queue', 'abort'].includes(c.type)).map(c => c.type), ['clear_queue', 'abort']);
  assert.equal(f.tasks.status(m, root.taskId).budget.usedTokens, 148);
  assert.equal(f.store.usage(child.taskId).requests, 2);
  c.emit(usage('after-exit')); assert.equal(f.store.usage(child.taskId).requests, 2);
  assert.ok(JSON.parse(f.store.task(root.taskId).status_detail).stopReport);
  const diagnosticPath = f.store.get('SELECT diagnostics_path FROM process_runs WHERE id=?', p.spec.runId).diagnostics_path;
  assert.equal(JSON.parse(await readFile(diagnosticPath, 'utf8')).cleanupConfirmed, true);
  await assert.rejects(f.tasks.recover(m, root.taskId, { mode: 'resume' }), errorCode('budget_exhausted'));
  await assert.rejects(f.tasks.steer(m, root.taskId, { message: '不能返工绕过' }), errorCode('budget_exhausted'));
  f.tasks.wake(p.conn.principalId); assert.equal(f.driver.handles.length, 3);
  await f.tasks.limits(m, root.taskId, { maxTokens: 300 });
  assert.equal(f.store.task(root.taskId).status, 'budget_paused');
  await f.tasks.recover(m, root.taskId, { mode: 'resume' });
  const p2 = await f.handle(root);
  assert.ok(JSON.parse(await readFile(diagnosticPath, 'utf8')).stopReport);
  assert.equal(f.store.task(child.taskId).status, 'budget_paused'); assert.equal(f.driver.handles.length, 4);
  await f.tasks.recover(p2.conn, child.taskId, { mode: 'resume' }); await f.handle(child);
  assert.equal(f.store.task(sibling.taskId).status, 'budget_paused');
});

test('1c 祖先预算暂停取消 quota 自动恢复，增额不会唤醒下级', async t => {
  const f = await setup(t, { quotaRecovery: 'auto' }), m = await f.main(), root = await f.spawn(m, { maxTokens: 50 }), p = await f.handle(root), child = await f.spawn(p.conn), c = await f.handle(child);
  c.emit({ type: 'quota_exhausted', resumeAt: new Date(Date.now() + 100).toISOString(), reason: '模拟额度' });
  await f.settle(c);
  assert.equal(f.store.task(child.taskId).status, 'quota_paused');
  p.emit(usage('ancestor-cap', 2)); await f.tasks.flush();
  assert.equal(f.store.task(child.taskId).status, 'budget_paused');
  f.tasks.limits(m, root.taskId, { maxTokens: 150 });
  await delay(130); await f.tasks.flush();
  assert.equal(f.driver.handles.length, 2);
  assert.equal(f.store.task(child.taskId).status, 'budget_paused');
});

test('1c child 不能用 proof 放宽祖先预算、权限或跨级恢复', async t => {
  const f = await setup(t), m = await f.main(), root = await f.spawn(m, { maxTokens: 60 }), p = await f.handle(root), child = await f.spawn(p.conn), c = await f.handle(child);
  await assert.rejects(f.spawn(p.conn, { maxTokens: 61 }, signed), errorCode('budget_limit_exceeded'));
  await assert.rejects(f.spawn(p.conn, { profile: 'implement' }, signed), errorCode('profile_upgrade'));
  assert.throws(() => f.tasks.limits(p.conn, child.taskId, { maxTokens: 61 }, signed), errorCode('budget_limit_exceeded'));
  assert.throws(() => f.tasks.limits(c.conn, root.taskId, { maxTokens: 500 }, signed), errorCode('forbidden'));
  const grandchild = await f.spawn(c.conn); await f.handle(grandchild);
  await assert.rejects(f.tasks.recover(p.conn, grandchild.taskId, { mode: 'resume' }, signed), errorCode('forbidden'));
});

test('1c 异步 settled 期间越额不得改成 completed 或 failed', async t => {
  const f = await setup(t), m = await f.main(), root = await f.spawn(m, { maxTokens: 30 }), h = await f.handle(root);
  let release;
  h.barrier = { type: 'get_last_assistant_text', promise: new Promise(resolve => { release = resolve; }) };
  h.emit({ type: 'agent_settled' });
  await until(() => h.commands.some(c => c.type === 'get_last_assistant_text'));
  h.emit(usage('concurrent'));
  assert.equal(f.store.task(root.taskId).status, 'budget_paused');
  release(); await f.tasks.flush();
  assert.equal(f.store.task(root.taskId).status, 'budget_paused');
});

test('1c 停止中晚到用量保留账本，不重写终态或自动恢复', async t => {
  const f = await setup(t), m = await f.main(), root = await f.spawn(m, { maxTokens: 30 }), h = await f.handle(root);
  await f.settle(h); assert.equal(f.store.task(root.taskId).status, 'completed');
  h.onStop = () => { h.emit(usage('stop-tail')); h.emit(usage('stop-tail')); };
  await f.tasks.stop(m, root.taskId, {}); await f.tasks.flush();
  assert.equal(f.store.task(root.taskId).status, 'completed');
  assert.equal(f.tasks.status(m, root.taskId).budget.usedTokens, 37);
  await assert.rejects(f.tasks.steer(m, root.taskId, { message: '预算不能重置' }), errorCode('budget_exhausted'));
});

test('1c 同步 limits 与用户答复复用签名事务，回滚不停止运行', async t => {
  const f = await setup(t), m = await f.main(), root = await f.spawn(m, { maxTokens: 100 }), h = await f.handle(root);
  h.emit(usage('before-sign'));
  const revision = f.store.task(root.taskId).revision;
  const updated = f.store.transaction(() => f.tasks.limits(m, root.taskId, { maxTokens: 110, expectedRevision: revision }, signed));
  assert.equal(typeof updated.then, 'undefined'); assert.equal(updated.budget.maxTokens, 110);
  const grants = f.store.get('SELECT SUM(tokens) AS n FROM budget_grants').n;
  assert.throws(() => f.store.transaction(() => {
    f.tasks.limits(m, root.taskId, { maxTokens: 10 }, signed);
    assert.equal(f.store.task(root.taskId).status, 'budget_paused');
    throw new Error('模拟签名审计事务回滚');
  }), /模拟签名/);
  await delay(0); await f.tasks.flush();
  assert.equal(f.store.task(root.taskId).status, 'running'); assert.equal(h.stopped, false);
  assert.equal(f.tasks.status(m, root.taskId).budget.maxTokens, 110);
  assert.throws(() => f.store.transaction(() => {
    f.tasks.limits(m, root.taskId, { maxTokens: 120 }, signed);
    throw new Error('模拟增额回滚');
  }), /模拟增额/);
  assert.equal(f.store.get('SELECT SUM(tokens) AS n FROM budget_grants').n, grants);
  const q = f.requests.ask(m, { questions: [{ id: 'q', question: '签名事务答复' }] });
  assert.throws(() => f.store.transaction(() => {
    const answer = f.requests.updateUser(f.host, q.id, 'answer', { answers: [{ id: 'q', selected: [], custom: '同意' }] }, signed);
    assert.equal(typeof answer.then, 'undefined');
    throw new Error('模拟答复回滚');
  }), /模拟答复/);
  await delay(0);
  assert.equal(f.requests.detail(f.host, q.id).state, 'open');
  const answered = f.store.transaction(() => f.requests.updateUser(f.host, q.id, 'answer', { expectedRevision: q.revision, answers: [{ id: 'q', selected: [], custom: '同意' }] }, signed));
  assert.deepEqual(answered.answeredVia, signed);
});

test('1c 尚未启动的预算暂停任务恢复仍发送原任务书', async t => {
  const f = await setup(t, { maxConcurrentRuns: 1 }), m = await f.main(), root = await f.spawn(m, { maxTokens: 30 }), p = await f.handle(root), child = await f.spawn(p.conn);
  assert.equal(f.store.task(child.taskId).status, 'created');
  p.emit(usage('cap')); await f.tasks.flush();
  assert.equal(f.store.task(child.taskId).status, 'budget_paused');
  await f.tasks.limits(m, root.taskId, { maxTokens: 100 });
  await f.tasks.recover(m, root.taskId, { mode: 'resume' }); const resumed = await f.handle(root);
  f.tasks.limits(resumed.conn, child.taskId, { maxTokens: 60 });
  await f.tasks.recover(resumed.conn, child.taskId, { mode: 'resume' });
  await f.settle(resumed);
  const c = await f.handle(child);
  assert.match(c.commands.find(c => c.type === 'prompt').message, /私有任务书/);
});

test('1c 重启读取持久日账本，日键使用本地日历日', async t => {
  const home = await mkdtemp(join(tmpdir(), 'agora-budget-restart-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  let store = await openStore(home); fixtureSchema(store);
  const options = { taskLimitDefaults: { maxTokens: 100 }, agentLimitCap: { perTaskFactor: 2, dailyTokens: 100 } };
  const conn = { type: 'agent:main', principalId: 'main-one' };
  store.transaction(() => new Budgets(store, options).grant(conn, 'first', 70, 70, {}, 'spawn'));
  store.close(); store = await openStore(home);
  try {
    assert.throws(() => store.transaction(() => new Budgets(store, options).grant({ ...conn, principalId: 'main-two' }, 'second', 40, 40, {}, 'spawn', unsigned)), errorCode('confirmation_required'));
    assert.equal(store.get('SELECT SUM(tokens) AS n FROM budget_grants').n, 70);
    assert.equal(localBudgetDay(new Date(2025, 0, 2, 23, 59)), '2025-01-02');
  } finally { store.close(); }
});
