import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { startDaemon } from '../packages/daemon/dist/index.js';
import { connectHost, createClient, gitExec } from '../packages/protocol/dist/index.js';
import { DatabaseSync } from 'node:sqlite';
import { Store, openStore, schemaMigrations } from '../packages/daemon/dist/store.js';

async function until(fn, ms = 4000) {
  const deadline = Date.now() + ms;
  do { const value = await fn(); if (value) return value; await delay(5); } while (Date.now() < deadline);
  assert.fail('等待状态超时');
}
class Driver {
  handles = [];
  async start(spec) {
    const listeners = new Set(), exits = new Set(); let resolve;
    const launch = await fetch(spec.env.AGORA_URL + '/v1/auth/launch', { method: 'POST', headers: { 'Agora-Protocol': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket: spec.env.AGORA_LAUNCH_TICKET }) }).then(r => r.json());
    const client = createClient({ url: spec.env.AGORA_URL, token: launch.token });
    const h = { spec, client, commands: [], result: '初次结果', stopCount: 0,
      identity: { pid: 90000 + this.handles.length, startTime: '模拟身份', runId: spec.runId, instanceId: spec.instanceId },
      exited: new Promise(r => { resolve = r; }),
      onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      onExit(fn) { exits.add(fn); return () => exits.delete(fn); },
      emit(ev) { for (const fn of listeners) fn(ev); },
      markReady() { this.ready = true; }, diagnostics() { return {}; }, respondUi() {},
      async send(cmd) {
        this.commands.push(cmd);
        if (this.barrier?.type === cmd.type) await this.barrier.promise;
        if (cmd.type === 'abort') queueMicrotask(() => this.emit({ type: 'agent_settled', aborted: true }));
        if (cmd.type === 'clear_queue') return { success: true, data: { steering: this.commands.filter(c => c.type === 'steer').map(c => c.message) } };
        const data = cmd.type === 'get_available_models' ? { models: [{ provider: 'test', id: 'model' }] }
          : cmd.type === 'get_state' ? { model: { provider: 'test', id: 'model' }, thinkingLevel: spec.thinking, sessionFile: spec.sessionFile }
          : cmd.type === 'get_last_assistant_text' ? { text: this.result } : {};
        return { success: true, data };
      },
      async stop() {
        this.stopCount++;
        if (this.stopFailure) throw new Error('受控停止失败');
        const report = { coverage: process.platform === 'win32' ? 'job_object' : 'snapshot_visible', steps: [{ step: 'verify', ok: true }], leftovers: [] };
        const exit = { identity: this.identity, code: 0, signal: null, cleanupConfirmed: true, stopReport: report };
        resolve(exit); for (const fn of exits) fn(exit); client.close(); return report;
      },
    };
    this.handles.push(h);
    h.boot = client.request('POST', `/v1/runs/${spec.runId}/ready`, { ...launch.policy, tools: spec.tools });
    void h.boot.catch(e => { h.bootError = e; });
    return h;
  }
  async recoverOldRun() { return { coverage: 'snapshot_visible', steps: [], leftovers: [] }; }
}
async function setup(t, options = {}) {
  const home = await mkdtemp(join(tmpdir(), 'agora-1b-')), driver = new Driver(), clients = [];
  const daemon = await startDaemon({ home, driver, readyTimeoutMs: 500, maxConcurrentRuns: 4, worktreeRoot: join(home, 'worktrees'), ...options });
  t.after(async () => { clients.forEach(c => c.close()); await daemon.close({ force: true }); await rm(home, { recursive: true, force: true }); });
  async function main(as = 'agent:main') {
    const c = await connectHost({ home, as, autoStart: false }); clients.push(c);
    if (as === 'agent:main') await c.request('POST', '/v1/principals/register', { sessionId: randomUUID(), sessionFile: join(home, randomUUID() + '.jsonl'), cwd: home });
    return c;
  }
  async function spawn(c, extra = {}, key) { return c.request('POST', '/v1/tasks', { model: 'test/model', profile: 'explore', prompt: '核对任务', cwd: home, ...extra }, { idempotencyKey: key ?? randomUUID() }); }
  async function handle(task) { return until(() => driver.handles.findLast(h => h.spec.agoraSessionId === task.agoraSessionId && h.ready && !h.stopCount)); }
  async function settled(task, result) { const h = await handle(task); if (result) h.result = result; h.emit({ type: 'agent_settled', aborted: false }); await daemon.tasks.flush(); return daemon.store.task(task.taskId); }
  return { home, driver, daemon, main, spawn, handle, settled };
}

test('返工保留旧代结果，每代通知唯一；同 key steer 只执行一次且追踪 queued/delivered/dropped', async t => {
  const f = await setup(t), main = await f.main(), task = await f.spawn(main), h = await f.handle(task);
  await f.settled(task, '第一代');
  const key = randomUUID(), body = { message: '第二代返工' };
  const second = await main.request('POST', `/v1/tasks/${task.taskId}/steer`, body, { idempotencyKey: key });
  const replay = await main.request('POST', `/v1/tasks/${task.taskId}/steer`, body, { idempotencyKey: key });
  assert.equal(second.steerId, replay.steerId); assert.equal(second.generation, 2);
  await until(() => h.commands.filter(c => c.type === 'prompt').length === 2);
  assert.match(h.commands.at(-1).message, new RegExp(second.steerId));
  h.emit({ type: 'message_end', message: { role: 'user', content: h.commands.at(-1).message } });
  assert.equal(f.daemon.store.get('SELECT state FROM steer_messages WHERE id=?', second.steerId).state, 'delivered');
  const added = await main.request('POST', `/v1/tasks/${task.taskId}/steer`, { message: '同代追加' }, { idempotencyKey: randomUUID() });
  const sent = h.commands.at(-1).message;
  h.emit({ type: 'queue_update', steering: [sent] });
  assert.equal(f.daemon.store.get('SELECT state FROM steer_messages WHERE id=?', added.steerId).state, 'queued');
  await f.settled(task, '第二代');
  assert.equal((await main.request('GET', `/v1/tasks/${task.taskId}/result?generation=1`)).resultText, '第一代');
  assert.equal((await main.request('GET', `/v1/tasks/${task.taskId}/result?generation=2`)).resultText, '第二代');
  assert.equal(f.daemon.store.get("SELECT COUNT(*) AS n FROM outbox WHERE kind='task:completed'").n, 2);
  await main.request('POST', `/v1/tasks/${task.taskId}/stop`, {});
  assert.equal(f.daemon.store.get('SELECT state FROM steer_messages WHERE id=?', added.steerId).state, 'dropped');
});

test('D14：父任务 settled 等待下级不完成且不占名额；回收父进程后下级完成会重新拉起，最终答复才完成', async t => {
  const f = await setup(t, { maxConcurrentRuns: 1, idleReclaimMs: 30 }), main = await f.main(), parent = await f.spawn(main), p = await f.handle(parent);
  const child = await f.spawn(p.client);
  assert.equal(f.driver.handles.length, 1);
  assert.equal((await f.settled(parent, '等待下级')).status, 'waiting_children');
  const c = await f.handle(child);
  assert.equal(f.daemon.tasks.activeCount(), 1);
  await until(() => p.stopCount === 1);
  await f.settled(child, '下级完成');
  const p2 = await until(() => f.driver.handles.find(h => h !== p && h.spec.agoraSessionId === parent.agoraSessionId && h.ready));
  assert.equal(p2.commands.some(c => c.type === 'prompt'), false, '重新拉起不能重放原任务书');
  assert.equal(f.daemon.store.task(parent.taskId).status, 'running');
  const inbox = await p2.client.request('GET', '/v1/inbox');
  assert.equal(inbox.items.length, 1); assert.equal(inbox.items[0].payload.taskId, child.taskId);
  p2.result = '核对下级后的最终结果'; p2.emit({ type: 'agent_settled', aborted: false }); await f.daemon.tasks.flush();
  assert.equal(f.daemon.store.task(parent.taskId).status, 'completed');
  assert.equal((await main.request('GET', `/v1/tasks/${parent.taskId}/result`)).resultText, p2.result);
});

test('D14：深度、下级数、档位及子树上限不能放宽，所有拒绝有明确错误码', async t => {
  const f = await setup(t, { maxTaskDepth: 2, maxChildren: 1 }), main = await f.main();
  await assert.rejects(f.spawn(main, { maxDepth: 3 }), e => e.code === 'depth_limit_exceeded');
  await assert.rejects(f.spawn(main, { maxChildren: 2 }), e => e.code === 'child_limit_exceeded');
  const parent = await f.spawn(main), p = await f.handle(parent);
  await assert.rejects(f.spawn(p.client, { profile: 'implement' }), e => e.code === 'profile_upgrade');
  await assert.rejects(f.spawn(p.client, { maxDepth: 2 }), e => e.code === 'depth_limit_exceeded');
  await assert.rejects(f.spawn(p.client, { maxChildren: null }), e => e.code === 'child_limit_exceeded');
  const child = await f.spawn(p.client), c = await f.handle(child);
  await assert.rejects(f.spawn(p.client), e => e.code === 'children_exceeded');
  await assert.rejects(f.spawn(c.client), e => e.code === 'depth_exceeded');
});

test('D14：停止整棵子树逐层核对 StopReport；子代理不能操作别人的任务，主代理不能返工孙代理但能停止', async t => {
  const f = await setup(t, { maxTaskDepth: 3 }), main = await f.main(), parent = await f.spawn(main), p = await f.handle(parent);
  const child = await f.spawn(p.client), c = await f.handle(child), grand = await f.spawn(c.client), g = await f.handle(grand);
  const stranger = await f.spawn(main), s = await f.handle(stranger);
  for (const [method, suffix, body] of [['GET', '', undefined], ['GET', '/result', undefined], ['POST', '/steer', { message: '越权' }], ['POST', '/stop', {}]]) await assert.rejects(p.client.request(method, `/v1/tasks/${stranger.taskId}${suffix}`, body), e => e.code === 'forbidden');
  assert.equal((await main.request('GET', `/v1/tasks/${grand.taskId}`)).taskId, grand.taskId);
  await assert.rejects(main.request('POST', `/v1/tasks/${grand.taskId}/steer`, { message: '跳级返工' }), e => e.code === 'forbidden');
  const stopped = await main.request('POST', `/v1/tasks/${parent.taskId}/stop`, {});
  assert.equal(stopped.subtreeReports.length, 1); assert.equal(stopped.subtreeReports[0].subtreeReports.length, 1);
  for (const result of [stopped, stopped.subtreeReports[0], stopped.subtreeReports[0].subtreeReports[0]]) {
    assert.equal(result.status, 'stopped'); assert.equal(result.stopReport.leftovers.length, 0);
    assert.equal(result.stopReport.coverage, process.platform === 'win32' ? 'job_object' : 'snapshot_visible');
  }
  assert.equal(p.stopCount, 1); assert.equal(c.stopCount, 1); assert.equal(g.stopCount, 1); assert.equal(s.stopCount, 0);
});

test('主代理与子代理同时提问不互相阻塞；孙代理提问逐级上交，主代理答复送回原孙代理，同 key answer 一次生效', async t => {
  const f = await setup(t), main = await f.main(), parent = await f.spawn(main), p = await f.handle(parent), child = await f.spawn(p.client), c = await f.handle(child);
  const questions = [{ id: 'q', question: '请选择', options: [{ label: '继续' }, { label: '停止' }], allowCustom: false }];
  const [rootQ, leafQ] = await Promise.all([main.request('POST', '/v1/requests', { questions }), c.client.request('POST', '/v1/requests', { questions })]);
  assert.equal(rootQ.targetId, 'user'); assert.notEqual(rootQ.id, leafQ.id);
  await assert.rejects(c.client.request('POST', `/v1/requests/${rootQ.id}/answer`, { answers: [{ id: 'q', selected: ['继续'] }] }), e => e.code === 'forbidden');
  const forwarded = await p.client.request('POST', `/v1/requests/${leafQ.id}/escalate`, {});
  assert.equal(forwarded.targetId, f.daemon.store.task(parent.taskId).convener_id);
  const key = randomUUID(), answer = { answers: [{ id: 'q', selected: ['继续'] }] };
  const result = await main.request('POST', `/v1/requests/${leafQ.id}/answer`, answer, { idempotencyKey: key });
  assert.equal(result.state, 'answered');
  assert.deepEqual(await main.request('POST', `/v1/requests/${leafQ.id}/answer`, answer, { idempotencyKey: key }), result);
  assert.equal(f.daemon.store.get("SELECT COUNT(*) AS n FROM outbox WHERE dedupe_key=?", `request:${leafQ.id}:answered`).n, 1);
  assert.equal((await c.client.request('GET', '/v1/inbox')).items.some(n => n.payload.requestId === leafQ.id && n.kind === 'request:answered'), true);
  assert.equal(rootQ.targetId, 'user', '主代理的提问直接交给用户');
  const another = await c.client.request('POST', '/v1/requests', { questions });
  await p.client.request('POST', `/v1/requests/${another.id}/escalate`, {});
  assert.equal((await main.request('POST', `/v1/requests/${another.id}/escalate`, {})).targetId, 'user');
  const cli = await f.main('host:cli');
  assert.equal((await cli.request('POST', `/v1/requests/${rootQ.id}/answer`, answer)).answeredVia.confirmedBy, 'none');
});

test('提问校验依赖与自定义答复；取消不算同意；等待答复可回收并由答案重新排队', async t => {
  const f = await setup(t, { idleReclaimMs: 20 }), main = await f.main(), parent = await f.spawn(main), p = await f.handle(parent);
  await assert.rejects(p.client.request('POST', '/v1/requests', { questions: [{ id: 'q', question: '错误依赖', dependsOn: { questionId: 'missing' } }] }), e => e.code === 'invalid_params');
  const q = await p.client.request('POST', '/v1/requests', { questions: [{ id: 'q', question: '继续？', options: [{ label: '是' }, { label: '否' }], allowCustom: false }] });
  await f.settled(parent); assert.equal(f.daemon.store.task(parent.taskId).status, 'waiting_decision'); await until(() => p.stopCount);
  await assert.rejects(main.request('POST', `/v1/requests/${q.id}/answer`, { answers: [{ id: 'q', selected: [], custom: '假定同意' }] }), e => e.code === 'invalid_params');
  const result = await main.request('POST', `/v1/requests/${q.id}/cancel`, {}); assert.equal(result.state, 'cancelled');
  await until(() => f.driver.handles.length === 2 && f.driver.handles[1].ready);
  assert.match((await f.driver.handles[1].client.request('GET', '/v1/inbox')).items[0].payload.summary, /取消不代表批准/);
});

test('worktree 从父目录当前提交创建，不带未提交修改，worktree 提问只核对 principal；脏目录拒绝清理', async t => {
  const f = await setup(t), main = await f.main(), repo = join(f.home, 'repo'); await mkdir(repo);
  await gitExec(repo, ['init']); await gitExec(repo, ['config', 'user.name', '测试']); await gitExec(repo, ['config', 'user.email', 'test@example.invalid']);
  await writeFile(join(repo, 'source.txt'), '已提交'); await gitExec(repo, ['add', '.']); await gitExec(repo, ['commit', '-m', '初始测试提交']);
  const base = (await gitExec(repo, ['rev-parse', 'HEAD'])).trim(); await writeFile(join(repo, 'source.txt'), '未提交');
  const task = await f.spawn(main, { cwd: repo, isolation: 'worktree', profile: 'implement' }), h = await f.handle(task);
  assert.equal(task.worktree.base_commit, base); assert.match(task.warnings[0], /未提交/);
  assert.equal(await readFile(join(task.worktree.path, 'source.txt'), 'utf8'), '已提交');
  const q = await h.client.request('POST', '/v1/requests', { questions: [{ id: 'q', question: 'worktree 里提问' }] }); assert.equal(q.taskId, task.taskId);
  await writeFile(join(task.worktree.path, 'dirty.txt'), '保留'); await main.request('POST', `/v1/tasks/${task.taskId}/stop`, {});
  await assert.rejects(main.request('POST', `/v1/tasks/${task.taskId}/cleanup`, {}), e => e.code === 'worktree_dirty');
  await main.request('POST', `/v1/tasks/${task.taskId}/cleanup`, { discard: true });
  assert.equal(f.daemon.tasks.worktrees.get(task.taskId).state, 'removed');
});

test('同目录 implement 冲突被拒绝，review 与只读任务不受影响', async t => {
  const f = await setup(t), main = await f.main(); await f.spawn(main, { profile: 'implement' });
  await assert.rejects(f.spawn(main, { profile: 'implement' }), e => e.code === 'implement_conflict');
  await f.spawn(main, { profile: 'review' });
});

test('无进展看门狗只通知不停止，周期通知去重且工具结束后不再提醒', async t => {
  const f = await setup(t, { toolStallMinutes: 0.0005 }), main = await f.main(), task = await f.spawn(main), h = await f.handle(task);
  h.emit({ type: 'tool_execution_start', toolCallId: 'call', toolName: 'read' });
  await until(() => f.daemon.store.get("SELECT COUNT(*) AS n FROM outbox WHERE kind='task:stall'").n > 0);
  assert.equal(h.stopCount, 0); h.emit({ type: 'tool_execution_end', toolCallId: 'call' });
  const count = f.daemon.store.get("SELECT COUNT(*) AS n FROM outbox WHERE kind='task:stall'").n; await delay(80);
  assert.equal(f.daemon.store.get("SELECT COUNT(*) AS n FROM outbox WHERE kind='task:stall'").n, count);
});

test('中断任务 resume 不增加代数，reopen/replace 保留历史会话与结果，abandon 停止', async t => {
  const f = await setup(t), main = await f.main(), task = await f.spawn(main), h = await f.handle(task);
  h.emit({ type: 'agent_settled', aborted: true }); await f.daemon.tasks.flush();
  const resumed = await main.request('POST', `/v1/tasks/${task.taskId}/recover`, { mode: 'resume' });
  assert.equal(resumed.generation, 1); assert.equal(resumed.agoraSessionId, task.agoraSessionId);
  const resumedHandle = await until(() => f.driver.handles.findLast(x => x !== h && x.ready));
  assert.match(resumedHandle.commands.find(c => c.type === 'prompt').message, /不得自动重放/);
  resumedHandle.emit({ type: 'agent_settled', aborted: true }); await f.daemon.tasks.flush();
  const reopened = await main.request('POST', `/v1/tasks/${task.taskId}/recover`, { mode: 'reopen' });
  assert.equal(reopened.generation, 2); assert.notEqual(reopened.agoraSessionId, task.agoraSessionId);
  const h2 = await f.handle(reopened); assert.match(h2.commands.find(c => c.type === 'prompt').message, /不得自动重放/);
  assert.equal(f.daemon.store.session(reopened.agoraSessionId).inherits_from, task.agoraSessionId);
  assert.equal((await main.request('GET', `/v1/tasks/${task.taskId}/result?generation=1`)).agoraSessionId, task.agoraSessionId);
  h2.emit({ type: 'agent_settled', aborted: true }); await f.daemon.tasks.flush();
  const replaced = await main.request('POST', `/v1/tasks/${task.taskId}/recover`, { mode: 'replace', profile: 'review', model: 'test/model' });
  assert.equal(replaced.generation, 3); assert.equal(replaced.profile, 'review'); await f.handle(replaced);
  f.daemon.store.run("UPDATE tasks SET status='interrupted' WHERE id=?", task.taskId);
  const abandoned = await main.request('POST', `/v1/tasks/${task.taskId}/recover`, { mode: 'abandon' });
  assert.equal(abandoned.status, 'stopped');
});

test('v2 到 v3 迁移有一致性备份并保留旧任务，新树与提问表在同一迁移事务中创建', async t => {
  const home = await mkdtemp(join(tmpdir(), 'agora-v3-')); t.after(() => rm(home, { recursive: true, force: true }));
  const db = new DatabaseSync(join(home, 'agora.db')); db.exec(schemaMigrations[0]); db.exec(schemaMigrations[1]);
  db.exec("CREATE TABLE schema_version(version INTEGER,migrated_at TEXT); INSERT INTO schema_version VALUES(2,'v2'); PRAGMA journal_mode=WAL;");
  db.prepare("INSERT INTO principals(id,type,created_at) VALUES('main','agent:main','time')").run(); db.close();
  const store = await openStore(home); assert.equal(store.principal('main').type, 'agent:main');
  assert.equal(store.get('SELECT version FROM schema_version').version, 3); assert.deepEqual(store.all('PRAGMA foreign_key_check'), []);
  for (const name of ['requests', 'steer_messages', 'worktrees']) assert.ok(store.get('SELECT name FROM sqlite_master WHERE name=?', name));
  store.close(); const backup = (await readdir(join(home, 'backups'))).find(f => f.endsWith('.db'));
  const old = new DatabaseSync(join(home, 'backups', backup), { readOnly: true });
  try { assert.equal(old.prepare('SELECT version FROM schema_version').get().version, 2); assert.equal(old.prepare('SELECT id FROM principals').get().id, 'main'); } finally { old.close(); }
});

test('interrupt 先清队列再 abort，以新代 prompt 返工且旧 steer 标为 dropped；过期 CAS 不产生副作用', async t => {
  const f = await setup(t), main = await f.main(), task = await f.spawn(main), h = await f.handle(task);
  const queued = await main.request('POST', `/v1/tasks/${task.taskId}/steer`, { message: '将被中断' });
  const before = f.daemon.store.task(task.taskId), count = h.commands.length;
  await assert.rejects(main.request('POST', `/v1/tasks/${task.taskId}/steer`, { message: '过期返工', interrupt: true, expectedRevision: before.revision - 1 }), e => e.code === 'conflict');
  assert.equal(h.commands.length, count);
  const result = await main.request('POST', `/v1/tasks/${task.taskId}/steer`, { message: '中断返工', interrupt: true, expectedRevision: before.revision });
  assert.equal(result.generation, 2); await until(() => h.commands.filter(c => c.type === 'prompt').length === 2);
  const names = h.commands.map(c => c.type); assert.ok(names.indexOf('clear_queue') < names.indexOf('abort'));
  assert.equal(f.daemon.store.get('SELECT state FROM steer_messages WHERE id=?', queued.steerId).state, 'dropped');
});

test('带期限的提问过期不表示同意；转给用户后不再计时；CLI pending/answer 实际走通', async t => {
  const f = await setup(t), main = await f.main(), task = await f.spawn(main), h = await f.handle(task);
  const q = await h.client.request('POST', '/v1/requests', { questions: [{ id: 'q', question: '带期限的问题' }], expiresAt: new Date(Date.now() + 80).toISOString() });
  await until(() => f.daemon.store.get('SELECT state FROM requests WHERE id=?', q.id).state === 'expired');
  await assert.rejects(main.request('POST', `/v1/requests/${q.id}/answer`, { answers: [{ id: 'q', selected: [], custom: '迟到同意' }] }), e => e.code === 'already_handled');
  const q2 = await h.client.request('POST', '/v1/requests', { questions: [{ id: 'q', question: '转给用户' }], expiresAt: new Date(Date.now() + 200).toISOString() });
  await main.request('POST', `/v1/requests/${q2.id}/escalate`, {}); await delay(220);
  assert.equal(f.daemon.store.get('SELECT state FROM requests WHERE id=?', q2.id).state, 'escalated');
  const { runCli } = await import('../packages/cli/dist/index.js');
  const out = [], errors = [], io = { out: text => out.push(text), error: text => errors.push(text) };
  assert.equal(await runCli(['pending', '--home', f.home], io), 0);
  assert.ok(JSON.parse(out.at(-1)).items.some(row => row.id === q2.id));
  assert.equal(await runCli(['answer', q2.id, '--home', f.home, '--answers', JSON.stringify([{ id: 'q', selected: [], custom: '用户答复' }])], io), 0, errors.join('\n'));
  assert.equal(JSON.parse(out.at(-1)).state, 'answered');
});

test('配置文件约束子树与名额，非法配置拒绝启动；v3 迁移失败回滚全部树字段并保留 v2 备份', async t => {
  const home = await mkdtemp(join(tmpdir(), 'agora-config-')); t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(home, 'config.json'), JSON.stringify({ maxTaskDepth: 1, maxChildren: 0, maxConcurrentRuns: 1, powershell: false }));
  const daemon = await startDaemon({ home, driver: new Driver() }); let cli;
  try {
    cli = await connectHost({ home, as: 'host:cli', autoStart: false });
    await assert.rejects(cli.request('POST', '/v1/tasks', { model: 'test/model', profile: 'explore', prompt: '超出配置', cwd: home, maxDepth: 2 }), e => e.code === 'depth_limit_exceeded');
  } finally { cli?.close(); await daemon.close({ force: true }); }
  await writeFile(join(home, 'config.json'), '{"maxTaskDepth":0}');
  await assert.rejects(startDaemon({ home, driver: new Driver() }), /配置/);
  const migration = await mkdtemp(join(tmpdir(), 'agora-rollback-')); t.after(() => rm(migration, { recursive: true, force: true }));
  const db = new DatabaseSync(join(migration, 'agora.db')); db.exec(schemaMigrations[0]); db.exec(schemaMigrations[1]);
  db.exec("CREATE TABLE schema_version(version INTEGER,migrated_at TEXT); INSERT INTO schema_version VALUES(2,'v2'); CREATE TABLE requests(sentinel TEXT); INSERT INTO requests VALUES('原现场');"); db.close();
  await assert.rejects(openStore(migration), /already exists/);
  const oldDb = new DatabaseSync(join(migration, 'agora.db'));
  try {
    assert.equal(oldDb.prepare('SELECT version FROM schema_version').get().version, 2);
    assert.equal(oldDb.prepare('SELECT sentinel FROM requests').get().sentinel, '原现场');
    assert.equal(oldDb.prepare('PRAGMA table_info(tasks)').all().some(c => c.name === 'parent_task_id'), false);
  } finally { oldDb.close(); }
  assert.ok((await readdir(join(migration, 'backups'))).some(name => name.endsWith('.db')));
});
