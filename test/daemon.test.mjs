import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { startDaemon, childEnvironment } from '../packages/daemon/dist/index.js';
import { connectHost } from '../packages/protocol/dist/client.js';

const MODEL = 'test/model';
const spawnBody = { profile: 'explore', model: MODEL, thinking: 'high', prompt: '只读核对任务书', title: '隔离测试' };
async function until(fn, timeout = 4000) {
  const end = Date.now() + timeout;
  do { const result = await fn(); if (result) return result; await delay(5); } while (Date.now() < end);
  assert.fail('等待测试状态超时');
}
async function http(url, token, method, route, body, headers = {}) {
  const response = await fetch(url + route, { method, headers: { 'Agora-Protocol': '1', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  return { status: response.status, body: await response.json() };
}
class MockDriver {
  handles = []; recovered = []; options = {};
  constructor(options = {}) { this.options = options; }
  async start(spec) {
    if (this.options.startFailure) {
      const failure = new AggregateError([Object.assign(new Error(`受控启动错误 ${spec.env.AGORA_LAUNCH_TICKET}`), { code: 'TEST_START_FAILURE' })], '启动清理未确认');
      failure.identity = { pid: 99999, startTime: '未确认', runId: spec.runId, instanceId: spec.instanceId };
      failure.stopReport = { coverage: 'snapshot_visible', steps: [{ step: 'snapshot', ok: false }], leftovers: [] };
      this.failedTicket = spec.env.AGORA_LAUNCH_TICKET;
      throw failure;
    }
    const events = new Set(), exits = new Set();
    const identity = { pid: 90000 + this.handles.length, startTime: '模拟进程身份', runId: spec.runId, instanceId: spec.instanceId };
    let resolveExit;
    const handle = {
      spec, identity, commands: [], ready: false, stopped: false, token: undefined,
      exited: new Promise(resolve => { resolveExit = resolve; }),
      onEvent(fn) { events.add(fn); return () => events.delete(fn); },
      onExit(fn) { exits.add(fn); return () => exits.delete(fn); },
      emit(event) { for (const fn of events) fn(event); },
      exit(cleanupConfirmed = true) {
        const exit = { identity, code: 0, signal: null, reason: '测试退出', cleanupConfirmed, stopReport: { coverage: 'snapshot_visible', steps: [], leftovers: [] } };
        if (!cleanupConfirmed) exit.error = '清理未确认';
        for (const fn of exits) fn(exit);
        resolveExit(exit);
      },
      markReady() { this.ready = true; },
      respondUi() {}, diagnostics() { return {}; },
      async send(command) {
        this.commands.push(command.type);
        if (command.type === 'prompt') { assert.equal(this.ready, true, '只有最终 RPC 检查通过才发送任务书'); return { type: 'response', command: command.type, success: true }; }
        // 模拟真实 pi：session_start 收到 HTTP ready 回包之后才读取 RPC。
        await this.boot;
        let data = {};
        if (command.type === 'get_available_models') data = { models: this.availableModels ?? [{ provider: 'test', id: 'model' }] };
        if (command.type === 'get_state') data = { model: { provider: 'test', id: 'model' }, thinkingLevel: spec.thinking, sessionFile: spec.sessionFile, sessionId: 'mock-pi', ...(this.stateOverride ?? {}) };
        if (command.type === 'get_last_assistant_text') data = { text: '只读测试结果' };
        if (command.type === 'get_session_stats') data = { tokens: { input: 12, output: 5, cacheRead: 0, cacheWrite: 0, total: 17 }, cost: 0.3 };
        return { type: 'response', command: command.type, success: true, data };
      },
      async stop() { if (!this.stopped) { this.stopped = true; this.exit(true); } return { coverage: 'snapshot_visible', steps: [], leftovers: [] }; },
    };
    handle.stateOverride = this.options.stateOverride;
    handle.availableModels = this.options.availableModels;
    this.handles.push(handle);
    handle.boot = (async () => {
      const launched = await http(spec.env.AGORA_URL, undefined, 'POST', '/v1/auth/launch', { ticket: spec.env.AGORA_LAUNCH_TICKET });
      assert.equal(launched.status, 200);
      handle.token = launched.body.token;
      if (this.options.noReady) return;
      const ready = await http(spec.env.AGORA_URL, handle.token, 'POST', `/v1/runs/${spec.runId}/ready`, { tools: ['read', 'grep', 'find', 'ls'], model: spec.model, thinking: spec.thinking, extensionVersion: '0.1.0', ...(this.options.readyOverride ?? {}) });
      handle.readyStatus = ready.status;
    })();
    void handle.boot.catch(error => { handle.bootError = error; });
    return handle;
  }
  async recoverOldRun(identity, sessionFile) {
    this.recovered.push({ identity, sessionFile });
    if (this.options.failRecovery) throw new Error('旧进程仍有残留');
    return { coverage: 'snapshot_visible', steps: [], leftovers: [] };
  }
}
async function setup(t, options = {}) {
  const home = await mkdtemp(join(tmpdir(), 'agora-daemon-'));
  const driver = new MockDriver(options.driverOptions);
  const daemon = await startDaemon({ home, driver, readyTimeoutMs: options.readyTimeoutMs ?? 500, maxConcurrentRuns: options.maxConcurrentRuns ?? 1 });
  const clients = [];
  t.after(async () => {
    for (const client of clients) client.close();
    await daemon.close({ force: true, timeoutMs: 1000 });
    await rm(home, { recursive: true, force: true });
  });
  async function client(as = 'agent:main', label = randomUUID()) {
    const conn = await connectHost({ home, as, autoStart: false });
    clients.push(conn);
    if (as === 'agent:main') await conn.request('POST', '/v1/principals/register', { sessionId: label, sessionFile: join(home, `${label}.jsonl`), cwd: home });
    return conn;
  }
  return { home, driver, daemon, client, async spawn(conn, extra = {}, key) { return conn.request('POST', '/v1/tasks', { ...spawnBody, cwd: home, ...extra }, key ? { idempotencyKey: key } : undefined); } };
}

for (const expiredLease of [false, true]) test(`settle屏障后的stop在队列内核对${expiredLease ? '租约' : '版本'}，失败不修改运行标志`, async t => {
  const f = await setup(t), main = await f.client();
  const task = await f.spawn(main);
  await until(() => f.driver.handles[0]?.commands.includes('prompt'));
  const handle = f.driver.handles[0];
  const before = f.daemon.store.task(task.taskId);
  let release, entered;
  const barrier = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const send = handle.send.bind(handle);
  handle.send = async command => {
    if (command.type === 'get_last_assistant_text') { entered(); await barrier; }
    return send(command);
  };
  handle.emit({ type: 'agent_settled', aborted: false });
  await started;
  // 直接进入任务控制队列，避免用时间等待推测 HTTP 是否已入队。
  const conn = f.daemon.auth.authenticate(`Bearer ${main.token}`);
  const stop = f.daemon.tasks.stop(conn, task.taskId, { expectedGeneration: before.generation, expectedRevision: before.revision });
  if (expiredLease) f.daemon.store.run('UPDATE principals SET lease_expires_at=0 WHERE id=?', conn.principalId);
  const conflict = assert.rejects(stop, error => error.code === (expiredLease ? 'lease_required' : 'conflict'));
  release();
  await conflict;
  assert.equal(f.daemon.store.task(task.taskId).status, 'completed');
  assert.equal(handle.stopped, false);
  const runtime = f.daemon.tasks.runtimes.get(task.taskId);
  assert.equal(runtime.stopped, false);
  assert.ok(runtime.idleTimer);
  assert.equal(f.daemon.store.session(task.agoraSessionId).control_state, null);
});

test('stop清理终态的空闲进程，但不把完成结果改成取消', async t => {
  const f = await setup(t), main = await f.client();
  const task = await f.spawn(main);
  await until(() => f.driver.handles[0]?.commands.includes('prompt'));
  f.driver.handles[0].emit({ type: 'agent_settled', aborted: false });
  await until(() => f.daemon.store.task(task.taskId).status === 'completed');
  const before = f.daemon.store.task(task.taskId);
  const result = await main.request('POST', `/v1/tasks/${task.taskId}/stop`, { expectedRevision: before.revision });
  assert.equal(result.status, 'completed');
  assert.equal(f.driver.handles[0].stopped, true);
  assert.equal(f.daemon.store.task(task.taskId).revision, before.revision);
  assert.equal((await main.request('GET', `/v1/tasks/${task.taskId}/result`)).resultText, '只读测试结果');
});

test('HTTP 边界拒绝 Origin、错误协议、匿名、伪造用户身份与未实现权限', async t => {
  const f = await setup(t), cli = await f.client('host:cli');
  assert.equal((await http(f.daemon.url, undefined, 'GET', '/v1/health', undefined, { Origin: 'https://untrusted.example' })).status, 403);
  assert.equal((await http(f.daemon.url, undefined, 'GET', '/v1/health')).status, 200);
  assert.equal((await http(f.daemon.url, undefined, 'GET', '/v1/status')).status, 401);
  assert.equal((await http(f.daemon.url, cli.token, 'GET', '/v1/status', undefined, { 'Agora-Protocol': '999' })).status, 426);
  assert.equal((await http(f.daemon.url, cli.token, 'GET', '/v1/status', undefined, { 'Agora-Act-As': 'user' })).status, 403);
  assert.equal((await http(f.daemon.url, cli.token, 'POST', '/v1/tasks', { ...spawnBody, profile: 'implement', cwd: f.home })).status, 400);
  assert.equal((await http(f.daemon.url, cli.token, 'POST', '/v1/tasks', { ...spawnBody, isolation: 'worktree', cwd: f.home })).status, 400);
  assert.equal((await http(f.daemon.url, cli.token, 'POST', '/v1/tasks', { ...spawnBody, boardId: '伪造', cwd: f.home })).status, 400);
  assert.equal((await http(f.daemon.url, cli.token, 'GET', '/v1/tasks?limit=201')).status, 400);
  assert.equal(f.daemon.store.get('SELECT COUNT(*) AS n FROM tasks').n, 0);
});

test('幂等 spawn 并发只执行一次，参数冲突不泄漏旧结果，租约失效不能重放缓存', async t => {
  const f = await setup(t), main = await f.client();
  const key = randomUUID();
  const responses = await Promise.all(Array.from({ length: 6 }, () => http(f.daemon.url, main.token, 'POST', '/v1/tasks', { ...spawnBody, cwd: f.home }, { 'Idempotency-Key': key })));
  assert.ok(responses.every(result => [201, 202].includes(result.status)));
  const first = responses.find(result => result.status === 201).body;
  await until(() => f.driver.handles[0]?.commands.includes('prompt'));
  const replay = await f.spawn(main, {}, key);
  assert.equal(replay.taskId, first.taskId);
  assert.equal(f.driver.handles.length, 1);
  assert.equal(f.daemon.store.get('SELECT COUNT(*) AS n FROM tasks').n, 1);
  const mismatch = await http(f.daemon.url, main.token, 'POST', '/v1/tasks', { ...spawnBody, cwd: f.home, prompt: '不同参数' }, { 'Idempotency-Key': key });
  assert.equal(mismatch.status, 409);
  assert.equal(mismatch.body.error.code, 'idempotency_mismatch');
  assert.equal(mismatch.body.taskId, undefined);
  const principal = [...f.daemon.auth.connections.values()].find(conn => conn.token === main.token).principalId;
  f.daemon.store.run('UPDATE principals SET lease_expires_at=0 WHERE id=?', principal);
  assert.equal((await http(f.daemon.url, main.token, 'POST', '/v1/tasks', { ...spawnBody, cwd: f.home }, { 'Idempotency-Key': key })).status, 409);
  assert.equal(f.daemon.store.get('SELECT COUNT(*) AS n FROM tasks').n, 1);
});

test('ready 两阶段先 HTTP 再 RPC；完整工具/模型/thinking 核对后才 prompt', async t => {
  const f = await setup(t), main = await f.client();
  const spawned = await f.spawn(main, { thinking: 'max' });
  await until(() => f.driver.handles[0]?.commands.includes('prompt'));
  const handle = f.driver.handles[0];
  assert.equal(handle.readyStatus, 200);
  assert.deepEqual(handle.commands.slice(0, 3), ['get_available_models', 'get_state', 'prompt']);
  assert.equal((await main.request('GET', `/v1/tasks/${spawned.taskId}`)).status, 'running');
  assert.equal(handle.spec.env.AGORA_HOME, undefined);
  assert.equal(handle.spec.env.PI_PANE_HOME, undefined);
  const launched = await http(f.daemon.url, undefined, 'POST', '/v1/auth/launch', { ticket: handle.spec.env.AGORA_LAUNCH_TICKET });
  assert.equal(launched.status, 401);
});

for (const [name, driverOptions] of [
  ['活动工具不符', { readyOverride: { tools: ['read', 'grep', 'find', 'ls', 'bash'] } }],
  ['报告模型不符', { readyOverride: { model: '伪造/模型' } }],
  ['RPC thinking不符', { stateOverride: { thinkingLevel: 'low' } }],
  ['模型不可用', { availableModels: [] }],
  ['RPC会话路径不符', { stateOverride: { sessionFile: '/其他会话' } }],
  ['就绪超时', { noReady: true }],
]) test(`就绪失败关闭：${name}，无任务书且 ticket/token 失效`, async t => {
  const f = await setup(t, { driverOptions, readyTimeoutMs: 100 }), main = await f.client();
  const spawned = await f.spawn(main);
  await until(() => f.daemon.store.task(spawned.taskId).status === 'failed');
  const handle = f.driver.handles[0];
  assert.equal(handle.commands.includes('prompt'), false);
  assert.equal(handle.stopped, true);
  if (name === '模型不可用') assert.match((await main.request('GET', `/v1/tasks/${spawned.taskId}/result`)).resultText, /指定模型不在可用列表中/);
  assert.equal((await http(f.daemon.url, handle.token, 'GET', '/v1/inbox')).status, 401);
  assert.equal(f.daemon.store.get('SELECT COUNT(*) AS n FROM outbox').n, 1);
});

test('settled 而非 agent_end 完成；结果、通知与业务已处理不抑制未ack重投', async t => {
  const f = await setup(t), main = await f.client();
  const task = await f.spawn(main);
  await until(() => f.driver.handles[0]?.commands.includes('prompt'));
  const handle = f.driver.handles[0];
  handle.emit({ type: 'agent_end' });
  await f.daemon.tasks.flush();
  assert.equal(f.daemon.store.task(task.taskId).status, 'running');
  handle.emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } });
  handle.emit({ type: 'agent_settled', aborted: false });
  handle.emit({ type: 'agent_settled', aborted: false });
  await until(() => f.daemon.store.task(task.taskId).status === 'completed');
  const result = await main.request('GET', `/v1/tasks/${task.taskId}/result`);
  assert.equal(result.resultText, '只读测试结果');
  assert.equal(result.usage.tokens.total, 17);
  assert.equal(result.usage.cost, 0.3);
  const row = f.daemon.store.get('SELECT * FROM outbox');
  assert.ok(row.processed_at);
  assert.equal(row.acked_at, null);
  assert.equal(row.persisted_at, null);
  const inbox = await main.request('GET', '/v1/inbox');
  assert.equal(inbox.items.length, 1);
  assert.equal(inbox.items[0].payload.taskId, task.taskId);
  assert.equal((await main.request('GET', '/v1/inbox')).items.length, 0);
  f.daemon.store.run('UPDATE outbox SET visible_after=0');
  assert.equal((await main.request('GET', '/v1/inbox')).items[0].noticeId, row.id);
  await main.request('POST', '/v1/inbox/ack', { noticeId: row.id, entryId: 'disk-entry', persisted: true });
  assert.equal((await main.request('GET', '/v1/inbox')).items.length, 0);
  assert.equal(f.daemon.store.get('SELECT COUNT(*) AS n FROM outbox').n, 1);
});

test('assistant 错误不能误判 completed；非召集人、child ACL 与用户召集规则', async t => {
  const f = await setup(t), main = await f.client(), other = await f.client(), cli = await f.client('host:cli');
  const task = await f.spawn(main);
  await until(() => f.driver.handles[0]?.commands.includes('prompt'));
  const handle = f.driver.handles[0];
  assert.equal((await http(f.daemon.url, other.token, 'GET', `/v1/tasks/${task.taskId}`)).status, 403);
  const all = await other.request('GET', '/v1/tasks?scope=all');
  assert.equal(all.items[0].taskId, task.taskId);
  assert.equal(all.items[0].prompt, undefined);
  assert.equal(all.items[0].model, undefined);
  assert.equal((await http(f.daemon.url, handle.token, 'GET', `/v1/tasks/${task.taskId}`)).status, 200);
  assert.equal((await http(f.daemon.url, handle.token, 'GET', `/v1/tasks/${task.taskId}/result`)).status, 403);
  assert.equal((await http(f.daemon.url, handle.token, 'POST', '/v1/tasks', { ...spawnBody, cwd: f.home, principalId: 'user' })).status, 403);
  assert.equal((await http(f.daemon.url, handle.token, 'POST', `/v1/tasks/${task.taskId}/stop`, {})).status, 403);
  handle.emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: '受控模型错误' } });
  handle.emit({ type: 'agent_settled', aborted: false });
  await until(() => f.daemon.store.task(task.taskId).status === 'failed');
  assert.equal(f.daemon.store.get('SELECT kind FROM outbox').kind, 'task:failed');
  const userTask = await f.spawn(cli, { principalId: main.principalId, convenerId: main.principalId });
  assert.equal(f.daemon.store.task(userTask.taskId).convener_id, 'user');
  assert.equal((await cli.request('GET', '/v1/tasks?scope=all')).items.length, 2);
});

test('并发队列占用到settled、停止排队任务不启动、CAS冲突无停止副作用', async t => {
  const f = await setup(t), main = await f.client();
  const first = await f.spawn(main), queued = await f.spawn(main), third = await f.spawn(main);
  await until(() => f.driver.handles[0]?.commands.includes('prompt'));
  assert.equal(f.driver.handles.length, 1);
  const conflict = await http(f.daemon.url, main.token, 'POST', `/v1/tasks/${first.taskId}/stop`, { expectedRevision: 999 });
  assert.equal(conflict.status, 409);
  assert.equal(f.driver.handles[0].stopped, false);
  assert.equal((await main.request('POST', `/v1/tasks/${queued.taskId}/stop`, {})).status, 'stopped');
  f.driver.handles[0].emit({ type: 'agent_settled', aborted: false });
  await until(() => f.driver.handles.length === 2 && f.driver.handles[1].commands.includes('prompt'));
  assert.equal(f.driver.handles[1].spec.agoraSessionId, third.agoraSessionId);
  const stopped = await main.request('POST', `/v1/tasks/${third.taskId}/stop`, {});
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.stopReport.coverage, 'snapshot_visible');
  assert.equal(f.daemon.tasks.activeCount(), 0);
});

test('排空等待已接受任务与队列；超时保持daemon可查，拒绝新spawn，之后强制关闭', async t => {
  const f = await setup(t), main = await f.client();
  const task = await f.spawn(main);
  await until(() => f.driver.handles[0]?.commands.includes('prompt'));
  await assert.rejects(f.daemon.close({ timeoutMs: 30 }), { code: 'drain_timeout' });
  assert.equal((await main.request('GET', '/v1/status')).draining, true);
  assert.equal((await http(f.daemon.url, main.token, 'POST', '/v1/tasks', { ...spawnBody, cwd: f.home })).status, 503);
  assert.equal(f.daemon.store.task(task.taskId).status, 'running');
  await f.daemon.close({ force: true, timeoutMs: 500 });
  await assert.rejects(stat(join(f.home, 'run', 'daemon.json')), { code: 'ENOENT' });
  const db = new DatabaseSync(join(f.home, 'agora.db'), { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT status FROM tasks WHERE id=?').get(task.taskId).status, 'interrupted');
    assert.ok(db.prepare('SELECT exited_at FROM process_runs').get().exited_at);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE kind='task:interrupted'").get().n, 1);
  } finally { db.close(); }
});

test('优雅排空会继续已排队任务且关闭完成/空闲run，不将已完成任务中断', async t => {
  const f = await setup(t), main = await f.client();
  const first = await f.spawn(main), second = await f.spawn(main);
  await until(() => f.driver.handles[0]?.commands.includes('prompt'));
  const closing = f.daemon.close({ timeoutMs: 2000 });
  f.driver.handles[0].emit({ type: 'agent_settled', aborted: false });
  await until(() => f.driver.handles[1]?.commands.includes('prompt'));
  f.driver.handles[1].emit({ type: 'agent_settled', aborted: false });
  await closing;
  const db = new DatabaseSync(join(f.home, 'agora.db'), { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT status FROM tasks WHERE id=?').get(first.taskId).status, 'completed');
    assert.equal(db.prepare('SELECT status FROM tasks WHERE id=?').get(second.taskId).status, 'completed');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM process_runs WHERE exited_at IS NULL').get().n, 0);
  } finally { db.close(); }
});

test('单实例认证既有daemon，正常关闭删除发现记录并允许新instance', async t => {
  const f = await setup(t);
  await assert.rejects(startDaemon({ home: f.home, driver: new MockDriver() }), error => error.code === 'daemon_running' && error.details.instanceId === f.daemon.instanceId);
  await f.daemon.close();
  const next = await startDaemon({ home: f.home, driver: new MockDriver() });
  try { assert.notEqual(next.instanceId, f.daemon.instanceId); }
  finally { await next.close(); }
});

test('child环境删除大小写变体的home和旧ticket，不接受生产故障注入参数', () => {
  const env = childEnvironment({ PATH: '正常', Agora_Home: '隐藏', PI_PANE_HOME: '隐藏', agora_launch_ticket: '旧票据', AGORA_URL: '旧地址', OTHER: undefined });
  assert.deepEqual(env, { PATH: '正常' });
});

test('HTTP inbox 分页450条，不漏不重复；可见租约到期后重投未确认记录', async t => {
  const f = await setup(t), main = await f.client();
  const principal = [...f.daemon.auth.connections.values()].find(conn => conn.token === main.token).principalId;
  f.daemon.store.transaction(() => { for (let index = 0; index < 450; index++) f.daemon.store.notice(principal, `bulk:${index}`, 'task:completed', { index }); });
  const deliveries = [];
  for (const count of [200, 200, 50, 0]) {
    const page = await main.request('GET', '/v1/inbox');
    assert.equal(page.items.length, count);
    deliveries.push(...page.items);
  }
  assert.equal(new Set(deliveries.map(row => row.noticeId)).size, 450);
  assert.deepEqual(deliveries.map(row => row.payload.index).sort((a, b) => a - b), Array.from({ length: 450 }, (_, index) => index));
  for (const notice of deliveries.slice(0, 200)) await main.request('POST', '/v1/inbox/ack', { noticeId: notice.noticeId, entryId: `entry-${notice.noticeId}`, persisted: true });
  f.daemon.store.run('UPDATE outbox SET visible_after=0 WHERE acked_at IS NULL');
  const retry = [...(await main.request('GET', '/v1/inbox')).items, ...(await main.request('GET', '/v1/inbox')).items];
  assert.equal(retry.length, 250);
  assert.equal(new Set(retry.map(row => row.noticeId)).size, 250);
  assert.deepEqual(new Set(retry.map(row => row.noticeId)), new Set(deliveries.slice(200).map(row => row.noticeId)));
});

test('child fatal 立即撤销token并停止run；cleanupConfirmed=false保留重启扫描和runtime', async t => {
  const f = await setup(t), main = await f.client();
  const task = await f.spawn(main);
  await until(() => f.driver.handles[0]?.commands.includes('prompt'));
  const handle = f.driver.handles[0];
  handle.exit(false);
  await until(() => f.daemon.store.task(task.taskId).status === 'interrupted');
  const run = f.daemon.store.get('SELECT * FROM process_runs WHERE id=?', handle.spec.runId);
  assert.equal(run.exited_at, null);
  assert.equal(run.state, 'stopping');
  assert.ok(run.cleanup_error);
  assert.equal(f.daemon.tasks.runtimes.size, 1, '未确认退出的handle不能丢失');
  handle.stop = async () => { throw new Error('受控清理失败，不能发出成功退出事件'); };
  await assert.rejects(main.request('POST', `/v1/tasks/${task.taskId}/stop`, {}), error => error.code === 'stop_incomplete');
  assert.equal(f.daemon.tasks.runtimes.size, 1, '失败的清理结果不能被stop覆盖');
  handle.exit(true);
  await f.daemon.tasks.flush();
  assert.equal(f.daemon.tasks.runtimes.size, 0, '独立确认退出后才释放handle引用');
  assert.ok(f.daemon.store.get('SELECT exited_at FROM process_runs WHERE id=?', handle.spec.runId).exited_at);
  const next = await f.spawn(main);
  await until(() => f.driver.handles[1]?.commands.includes('prompt'));
  const active = f.driver.handles[1];
  const denied = await http(f.daemon.url, main.token, 'POST', `/v1/runs/${active.spec.runId}/fatal`, {});
  assert.equal(denied.status, 403);
  const fatal = await http(f.daemon.url, active.token, 'POST', `/v1/runs/${active.spec.runId}/fatal`, { message: '不能回显的凭证和路径' });
  assert.equal(fatal.status, 200);
  await until(() => f.daemon.store.task(next.taskId).status === 'interrupted');
  assert.equal((await http(f.daemon.url, active.token, 'GET', '/v1/inbox')).status, 401);
  assert.equal(active.stopped, true);
});

test('driver.start 抛错但未返回handle时保留退出待查run和聚合诊断，不能假定未启动', async t => {
  const f = await setup(t, { driverOptions: { startFailure: true } }), main = await f.client();
  const task = await f.spawn(main);
  await until(() => f.daemon.store.task(task.taskId).status === 'failed');
  const run = f.daemon.store.get('SELECT * FROM process_runs');
  assert.equal(run.exited_at, null);
  assert.ok(run.identity);
  assert.ok(run.cleanup_error);
  assert.equal(run.cleanup_error.includes(f.driver.failedTicket), false, '诊断不得保存启动凭证');
  const diagnostic = JSON.parse(run.cleanup_error).diagnostic;
  assert.equal(diagnostic.stopReport.steps[0].ok, false);
  assert.equal(diagnostic.errors[0].code, 'TEST_START_FAILURE');
  await f.daemon.close({ force: true });
  const driver = new MockDriver();
  const next = await startDaemon({ home: f.home, driver });
  try {
    assert.equal(f.driver.recovered.length, 1, 'shutdown重试无handle的持久化运行');
    assert.equal(f.driver.recovered[0].identity.runId, run.id);
    assert.equal(driver.recovered.length, 0, '关闭前已安全清理的run无需重复恢复');
    assert.ok(next.store.get('SELECT exited_at FROM process_runs WHERE id=?', run.id).exited_at);
    assert.equal(driver.handles.length, 0);
  } finally { await next.close(); }
});

test('重启扫描失败的持久run阻止stop/shutdown虚假成功，并允许安全重试', async t => {
  const f = await setup(t), main = await f.client();
  const task = await f.spawn(main, {}, 'crash-operation');
  await until(() => f.driver.handles[0]?.commands.includes('prompt'));
  const runId = f.driver.handles[0].spec.runId;
  await f.daemon.close({ force: true });
  const db = new DatabaseSync(join(f.home, 'agora.db'));
  try {
    db.prepare("UPDATE tasks SET status='running' WHERE id=?").run(task.taskId);
    db.prepare("UPDATE task_generations SET status='running' WHERE task_id=?").run(task.taskId);
    db.prepare("UPDATE process_runs SET exited_at=NULL,state='ready',cleanup_error=NULL WHERE id=?").run(runId);
    db.prepare("UPDATE operations SET state='in_progress',status=NULL,result=NULL WHERE key='crash-operation'").run();
  } finally { db.close(); }
  const failedDriver = new MockDriver({ failRecovery: true });
  const next = await startDaemon({ home: f.home, driver: failedDriver });
  let resumed;
  try {
    assert.equal(failedDriver.recovered.length, 1);
    assert.equal(failedDriver.recovered[0].identity.runId, runId);
    assert.equal(failedDriver.handles.length, 0);
    assert.equal(next.store.task(task.taskId).status, 'interrupted');
    assert.equal(next.store.get('SELECT exited_at FROM process_runs WHERE id=?', runId).exited_at, null);
    assert.ok(next.store.get('SELECT cleanup_error FROM process_runs WHERE id=?', runId).cleanup_error);
    assert.equal(next.store.get("SELECT state FROM operations WHERE key='crash-operation'").state, 'failed');
    const cli = await connectHost({ home: f.home, as: 'host:cli', autoStart: false });
    try {
      // 主会话恢复后使用同principal的原幂等键才命中原操作；此处直接验证存储的固定结果。
      assert.equal(JSON.parse(next.store.get("SELECT result FROM operations WHERE key='crash-operation'").result).error.code, 'operation_interrupted');
      assert.equal((await cli.request('GET', `/v1/tasks/${task.taskId}`)).status, 'interrupted');
      await assert.rejects(cli.request('POST', `/v1/tasks/${task.taskId}/stop`, {}), error => error.code === 'stop_incomplete');
      assert.equal(next.store.task(task.taskId).status, 'interrupted');
      await assert.rejects(next.close({ force: true }), error => error.code === 'stop_incomplete');
      assert.equal(next.store.get('SELECT exited_at FROM process_runs WHERE id=?', runId).exited_at, null);
      assert.ok(failedDriver.recovered.length >= 3, 'stop/shutdown 都须重试持久化旧run');
    } finally { cli.close(); }
  } finally { failedDriver.options.failRecovery = false; await next.close({ force: true }); }
  const recoveredDriver = new MockDriver();
  resumed = await startDaemon({ home: f.home, driver: recoveredDriver });
  try {
    assert.equal(recoveredDriver.recovered.length, 0, '关闭重试已确认清理的run不再扫描');
    assert.ok(resumed.store.get('SELECT exited_at FROM process_runs WHERE id=?', runId).exited_at);
    assert.equal(recoveredDriver.handles.length, 0);
  } finally { await resumed.close(); }
});
