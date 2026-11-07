import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import agoraExtension from '../packages/extension/dist/index.js';
import { extensionWire } from './fixtures/extension-wire.mjs';

async function setup(t, { managed = false, tools = ['read', 'grep', 'find', 'ls'], model = 'model' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'agora-extension-hooks-'));
  const wire = await extensionWire(root);
  const originalEnv = { ...process.env };
  if (managed) { process.env.AGORA_URL = wire.url; process.env.AGORA_LAUNCH_TICKET = 'one-use-ticket'; }
  else { delete process.env.AGORA_URL; delete process.env.AGORA_LAUNCH_TICKET; process.env.AGORA_HOME = root; }
  const entries = [];
  const handlers = new Map();
  const registered = [];
  const errors = [];
  let activeTools = tools;
  let thinking = 'off';
  let shutdown = false;
  const ctx = { cwd: root, model: { provider: 'fake', id: model }, hasUI: true,
    ui: { notify: message => errors.push(message) },
    shutdown() { shutdown = true; },
    sessionManager: { getSessionId: () => 'session-one', getSessionFile: () => join(root, 'session.jsonl'),
      getEntries: () => entries, getBranch: () => entries },
  };
  const pi = {
    on(name, handler) { handlers.set(name, handler); },
    registerTool(tool) { registered.push(tool); },
    appendEntry(customType, data) { entries.push({ id: `custom-${entries.length}`, type: 'custom', customType, data }); },
    sendMessage() { throw new Error('测试未预期通知'); },
    getActiveTools: () => activeTools, getThinkingLevel: () => thinking,
  };
  agoraExtension(pi);
  if (managed) assert.equal(process.env.AGORA_LAUNCH_TICKET, undefined, '工厂同步删除凭证');
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  t.after(async () => {
    await handlers.get('session_shutdown')?.({ reason: 'quit' }, ctx);
    await wire.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, wire, entries, handlers, registered, ctx, errors, pi,
    get shutdown() { return shutdown; }, setTools(value) { activeTools = value; }, setThinking(value) { thinking = value; },
  };
}
async function until(fn, timeoutMs = 5000) {
  const deadline = performance.now() + timeoutMs;
  while (!fn()) { if (performance.now() >= deadline) throw new Error('测试等待超时'); await delay(20); }
}

test('主会话初始化幂等，租约绑定并正确分发四个任务动作', async t => {
  const f = await setup(t);
  const start = f.handlers.get('session_start');
  const first = start({}, f.ctx);
  assert.equal(start({}, f.ctx), first);
  await first;
  await start({}, f.ctx);
  assert.equal(f.wire.state.registerCount, 1);
  assert.equal(f.wire.state.reclaimCount, 0);
  assert.equal(f.entries.filter(e => e.customType === 'agora-principal').length, 1);
  const tool = f.registered.find(t => t.name === 'agora_task');
  for (const [action, args, route] of [
    ['spawn', { profile: 'explore', prompt: '查看公开文件', model: 'fake/model' }, '/v1/tasks'],
    ['status', { taskId: 'task-one' }, '/v1/tasks/task-one'],
    ['result', { taskId: 'task-one', generation: 1 }, '/v1/tasks/task-one/result?generation=1'],
    ['stop', { taskId: 'task-one' }, '/v1/tasks/task-one/stop'],
  ]) {
    const result = await tool.execute(`call-${action}`, { action, ...args }, undefined, undefined, f.ctx);
    assert.equal(result.details.taskId, 'task-one');
    const call = f.wire.calls.find(c => c.idempotencyKey === `call-${action}`);
    assert.equal(call.path, route);
    if (action === 'spawn') assert.equal(call.body.originToolCall.toolCallId, 'call-spawn');
  }
  await assert.rejects(tool.execute('bad', { action: 'spawn', profile: 'invalid', model: 'fake/model', prompt: '越权' }, undefined, undefined, f.ctx), /有效权限档位/);
});

test('daemon重启后重新发现握手并凭恢复证明认领原principal', async t => {
  const f = await setup(t);
  await f.handlers.get('session_start')({}, f.ctx);
  let releasePublish, publicationBlocked = false, probeSeen = false;
  const gate = new Promise(resolve => { releasePublish = resolve; });
  f.wire.state.beforeRequest = async call => {
    if (publicationBlocked && call.path === '/v1/health') probeSeen = true;
  };
  const restart = f.wire.restart({ beforePublish: () => { publicationBlocked = true; return gate; } });
  try {
    // 确定首次重连读到旧发现记录而健康检查已是新实例，必然需要下一次合法退避重试。
    await until(() => probeSeen, 10000);
  } finally { releasePublish(); }
  await restart;
  await until(() => f.wire.state.reclaimCount === 1, 15000);
  assert.ok(f.wire.calls.filter(c => c.path === '/v1/health').length >= 3, '初始化、发布前失败和发布后重试都须执行');
  const result = await f.registered[0].execute('after-restart', { action: 'status', taskId: 'task-one' }, undefined, undefined, f.ctx);
  assert.equal(result.details.taskId, 'task-one');
  assert.equal(f.wire.state.registerCount, 1);
});

test('休眠导致租约过期后重新握手认领，不重复注册principal', async t => {
  const f = await setup(t);
  await f.handlers.get('session_start')({}, f.ctx);
  f.wire.state.enforceLease = true;
  f.wire.state.leaseHeld = false;
  await until(() => f.wire.state.reclaimCount === 1, 15000);
  assert.equal(f.wire.state.leaseHeld, true);
  assert.equal(f.wire.state.registerCount, 1);
});

test('child就绪前拒绝全部工具，启动凭证不进入工具结果及会话', async t => {
  const f = await setup(t, { managed: true });
  const hook = f.handlers.get('tool_call');
  assert.equal((await hook({ toolName: 'read', input: { path: 'public.txt' } }, f.ctx)).block, true);
  assert.deepEqual(f.registered.map(t => t.name), ['agora_task', 'agora_request', 'agora_git']);
  await f.handlers.get('session_start')({}, f.ctx);
  assert.equal(f.wire.state.readyCount, 1);
  const report = f.wire.calls.find(c => c.path.endsWith('/ready')).body;
  assert.deepEqual(report, { tools: ['read', 'grep', 'find', 'ls'], model: 'fake/model', thinking: 'off', extensionVersion: '0.1.0' });
  await writeFile(join(f.root, 'public.txt'), '公开文件');
  assert.equal(await hook({ toolName: 'read', input: { path: 'public.txt' } }, f.ctx), undefined);
  assert.equal((await hook({ toolName: 'bash', input: {} }, f.ctx)).block, true);
  for (const name of ['session_before_switch', 'session_before_fork', 'session_before_tree']) assert.deepEqual(f.handlers.get(name)({}, f.ctx), { cancel: true });
  assert.equal(f.handlers.get('user_bash')({}, f.ctx).result.exitCode, 1);
  assert.doesNotMatch(JSON.stringify(f.entries), /one-use-ticket|child-token/);
});

test('child模型/工具/思考级别任意不符均fail closed且上报fatal', async t => {
  const f = await setup(t, { managed: true });
  await f.handlers.get('session_start')({}, f.ctx);
  f.setThinking('high');
  const result = await f.handlers.get('tool_call')({ toolName: 'read', input: { path: 'anything' } }, f.ctx);
  assert.equal(result.block, true);
  assert.equal(f.shutdown, true);
  await until(() => f.wire.state.fatalCount === 1);
  assert.match(f.entries.find(e => e.customType === 'agora-fatal').data.message, /权限检查失败/);
  assert.doesNotMatch(JSON.stringify(f.entries), /secret|host\.key/);
  f.setThinking('off');
  assert.equal((await f.handlers.get('tool_call')({ toolName: 'read', input: { path: 'anything' } }, f.ctx)).block, true);
});

test('child初始化完整工具集合不符时不发送ready', async t => {
  const f = await setup(t, { managed: true, tools: ['read', 'grep', 'find', 'ls', 'bash'] });
  await assert.rejects(f.handlers.get('session_start')({}, f.ctx), /初始化失败/);
  assert.equal(f.wire.state.readyCount, 0);
  assert.equal(f.shutdown, true);
});

test('主会话导航到不含引用的分支后仍认领原principal', async t => {
  const f = await setup(t);
  f.entries.push({ id: 'principal-ref', type: 'custom', customType: 'agora-principal', data: { principalId: 'principal-one' } });
  f.ctx.sessionManager.getBranch = () => [];
  await f.handlers.get('session_start')({}, f.ctx);
  assert.equal(f.wire.state.reclaimCount, 1);
  assert.equal(f.wire.state.registerCount, 0);
});

test('fork只在session_mismatch时注册新principal，租约占用不能降级注册', async t => {
  const f = await setup(t);
  f.entries.push({ id: 'parent-ref', type: 'custom', customType: 'agora-principal', data: { principalId: 'principal-one' } });
  f.wire.state.reclaimCode = 'session_mismatch';
  await f.handlers.get('session_start')({}, f.ctx);
  assert.equal(f.wire.state.registerCount, 1);
  assert.equal(f.wire.calls.find(c => c.path === '/v1/principals/register').body.forkedFrom, 'principal-one');
  await f.handlers.get('session_shutdown')({}, f.ctx);
  f.wire.state.reclaimCode = undefined;
  f.wire.state.leaseHeld = true;
  await assert.rejects(f.handlers.get('session_start')({}, f.ctx), /初始化失败/);
  assert.equal(f.wire.state.registerCount, 1);
});

function barrier() {
  let entered, release;
  const entering = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  return { entering, release, async wait() { entered(); await gate; } };
}

test('shutdown遇到迟到注册时释放租约，不追加引用或启动poll', { timeout: 10000 }, async t => {
  const f = await setup(t);
  const gate = barrier();
  f.wire.state.beforeRequest = call => call.path === '/v1/principals/register' ? gate.wait() : undefined;
  const starting = f.handlers.get('session_start')({}, f.ctx);
  await gate.entering;
  await f.handlers.get('session_shutdown')({}, f.ctx);
  gate.release();
  await starting;
  assert.equal(f.wire.state.registerCount, 1);
  assert.equal(f.wire.state.leaseHeld, false);
  assert.equal(f.wire.calls.filter(c => c.path === '/v1/lease/release').length, 1);
  assert.equal(f.entries.length, 0);
  assert.equal(f.wire.calls.some(c => c.path.startsWith('/v1/inbox')), false);
});

test('shutdown遇到迟到reclaim时同样释放租约且旧poll不复活', { timeout: 10000 }, async t => {
  const f = await setup(t);
  await f.handlers.get('session_start')({}, f.ctx);
  const gate = barrier();
  f.wire.state.beforeRequest = call => call.path === '/v1/principals/reclaim' ? gate.wait() : undefined;
  await f.wire.restart();
  await gate.entering;
  await f.handlers.get('session_shutdown')({}, f.ctx);
  gate.release();
  await until(() => f.wire.state.reclaimCount === 1 && f.wire.calls.filter(c => c.path === '/v1/lease/release').length === 2);
  assert.equal(f.wire.state.leaseHeld, false);
  assert.equal(f.wire.state.registerCount, 1);
});

test('child路径检查等待期间关闭会话不能迟到放行', async t => {
  const f = await setup(t, { managed: true });
  await f.handlers.get('session_start')({}, f.ctx);
  const checking = f.handlers.get('tool_call')({ toolName: 'read', input: { path: 'public.txt' } }, f.ctx);
  await f.handlers.get('session_shutdown')({}, f.ctx);
  assert.equal((await checking).block, true);
});

test('child等待ready期间模型改变时不能进入ready', { timeout: 10000 }, async t => {
  const f = await setup(t, { managed: true });
  const gate = barrier();
  f.wire.state.beforeRequest = call => call.path.endsWith('/ready') ? gate.wait() : undefined;
  const starting = f.handlers.get('session_start')({}, f.ctx);
  await gate.entering;
  f.ctx.model = { provider: 'fake', id: 'changed-model' };
  gate.release();
  await assert.rejects(starting, /初始化失败/);
  assert.equal(f.shutdown, true);
  assert.equal((await f.handlers.get('tool_call')({ toolName: 'read', input: { path: 'public.txt' } }, f.ctx)).block, true);
});

test('450条通知分批排空，复投相同key不重复注入或叫醒', async t => {
  const f = await setup(t);
  const notices = Array.from({ length: 450 }, (_, index) => ({
    noticeId: `notice-${index}`, dedupeKey: `task:${index}:completed`, kind: 'task',
    payload: { content: `任务${index}已完成` },
  }));
  f.wire.state.inboxItems = [...notices, ...notices];
  const sends = [];
  f.pi.sendMessage = (message, options) => {
    sends.push({ message, options });
    f.entries.push({ id: `notice-entry-${sends.length}`, type: 'custom_message', ...message });
  };
  await f.handlers.get('session_start')({}, f.ctx);
  assert.equal(f.wire.state.inboxItems.length, 0);
  assert.equal(sends.length, 450);
  assert.equal(sends.filter(send => send.options.triggerTurn).length, 450);
  assert.equal(new Set(sends.map(send => send.message.details.dedupeKey)).size, 450);
  const inboxCalls = f.wire.calls.filter(call => call.path.startsWith('/v1/inbox'));
  assert.ok(inboxCalls.length >= 6, '非空批次后继续获取，直至空批');
  f.wire.state.inboxItems.push(...notices);
  await f.handlers.get('agent_settled')({}, f.ctx);
  assert.equal(f.wire.state.inboxItems.length, 0);
  assert.equal(sends.length, 450);
});

test('fatal诊断、界面或shutdown抛错时tool_call仍返回block', async t => {
  const f = await setup(t, { managed: true });
  await f.handlers.get('session_start')({}, f.ctx);
  f.pi.appendEntry = () => { throw new Error('诊断不可写'); };
  f.ctx.ui.notify = () => { throw new Error('界面已关闭'); };
  f.ctx.shutdown = () => { throw new Error('关闭失败'); };
  f.setThinking('high');
  assert.equal((await f.handlers.get('tool_call')({ toolName: 'read', input: { path: 'public.txt' } }, f.ctx)).block, true);
  f.setThinking('off');
  assert.equal((await f.handlers.get('tool_call')({ toolName: 'read', input: { path: 'public.txt' } }, f.ctx)).block, true);
});

test('switch遇到旧principal的迟到完成通知时不能注入新会话', { timeout: 10000 }, async t => {
  const f = await setup(t);
  const gate = barrier();
  t.after(() => gate.release());
  const oldNotice = { noticeId: 'old-notice', dedupeKey: 'task:old:1:completed', kind: 'task:completed',
    payload: { taskId: 'old-task', generation: 1, content: '旧子代理完成', notify: 'wake' } };
  f.wire.state.inboxItems = [oldNotice];
  let blocked = false;
  f.wire.state.beforeResponse = async (call, result) => {
    if (!blocked && call.path.startsWith('/v1/inbox?') && result.items.length) {
      blocked = true;
      assert.equal(result.items[0].noticeId, oldNotice.noticeId);
      await gate.wait();
    }
  };
  const sends = [];
  const nextEntries = [];
  let activeSession = 'session-one';
  f.pi.sendMessage = (message, options) => {
    sends.push({ sessionId: activeSession, message, options });
    nextEntries.push({ id: `next-notice-${sends.length}`, type: 'custom_message', ...message });
  };
  const starting = f.handlers.get('session_start')({}, f.ctx);
  await gate.entering;
  assert.equal(f.handlers.get('session_before_switch')({}, f.ctx), undefined);
  await f.handlers.get('session_shutdown')({ reason: 'switch' }, f.ctx);
  await starting;
  activeSession = 'session-two';
  const nextCtx = { ...f.ctx, sessionManager: {
    getSessionId: () => activeSession, getSessionFile: () => join(f.root, 'next.jsonl'),
    getEntries: () => nextEntries, getBranch: () => nextEntries,
  } };
  f.pi.appendEntry = (customType, data) => nextEntries.push({ id: `next-${nextEntries.length}`, type: 'custom', customType, data });
  f.wire.state.registerPrincipalId = 'principal-two';
  f.wire.state.inboxItems = [{ ...oldNotice, noticeId: 'next-notice', dedupeKey: 'task:next:1:completed',
    payload: { taskId: 'next-task', generation: 1, content: '新会话任务完成', notify: 'wake' } }];
  await f.handlers.get('session_start')({}, nextCtx);
  assert.equal(nextEntries.find(e => e.customType === 'agora-principal').data.principalId, 'principal-two');
  gate.release();
  await f.handlers.get('agent_settled')({}, nextCtx);
  assert.deepEqual(sends.map(s => [s.sessionId, s.message.details.noticeId]), [['session-two', 'next-notice']]);
  assert.equal(nextEntries.some(e => e.details?.noticeId === oldNotice.noticeId), false);
  assert.equal(f.wire.calls.some(c => c.path === '/v1/inbox/ack' && c.body.noticeId === oldNotice.noticeId), false);
});

function refreshClock(t) {
  const timers = [];
  const interval = globalThis.setInterval;
  t.mock.method(globalThis, 'setInterval', (callback, ms, ...args) => {
    if (ms === 30000) timers.push(callback);
    return interval(callback, ms, ...args);
  });
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  return { timers, advance(ms) { now += ms; } };
}

for (const failure of ['transport', 'authentication']) {
  test(`managed refresh：${failure === 'transport' ? '三次传输失败不fatal，下次定时检查可续期' : '认证拒绝不重试且fatal'}`, { timeout: 10000 }, async t => {
    const clock = refreshClock(t);
    const f = await setup(t, { managed: true });
    await writeFile(join(f.root, 'public.txt'), '公开文件');
    await f.handlers.get('session_start')({}, f.ctx);
    const read = () => f.handlers.get('tool_call')({ toolName: 'read', input: { path: 'public.txt' } }, f.ctx);
    assert.equal(await read(), undefined);
    assert.equal(clock.timers.length, 1, 'managed只有refresh定时器');
    const tick = clock.timers[0];
    tick();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.wire.state.refreshCount, 0, '距过期超过30分钟时不续期');
    clock.advance(31 * 60 * 1000);
    const fetch = globalThis.fetch;
    const attempts = [], bodies = [];
    t.mock.method(globalThis, 'fetch', (...args) => {
      const request = fetch(...args);
      if (!String(args[0]).endsWith('/v1/auth/refresh')) return request;
      const tracked = request.then(response => {
        const text = response.text.bind(response);
        response.text = () => { const body = text(); bodies.push(body); return body; };
        return response;
      });
      attempts.push(tracked);
      return tracked;
    });
    const flushRefresh = async () => {
      await Promise.allSettled(attempts);
      await Promise.allSettled(bodies);
      await new Promise(resolve => setImmediate(resolve));
    };
    if (failure === 'transport') f.wire.state.refreshTransportFailure = true;
    else f.wire.state.refreshReject = 'token_expired';
    tick();
    await until(() => f.wire.state.refreshCount > 0, 1500).catch(() => {
      assert.fail('managed到期后必须触发refresh；检查connectLaunch是否将launch.expiresAt传给client');
    });
    if (failure === 'authentication') {
      await until(() => f.shutdown && f.wire.state.fatalCount === 1);
      assert.equal(f.wire.state.refreshCount, 1);
      assert.equal((await read()).block, true);
      assert.equal(f.entries.filter(e => e.customType === 'agora-fatal').length, 1);
      return;
    }
    await until(() => f.wire.state.refreshCount === 3);
    // 等待第三次真实socket失败被client处理；第四次只能来自后续定时检查。
    await flushRefresh();
    assert.equal(attempts.length, 3);
    assert.equal(f.wire.state.refreshCount, 3);
    assert.equal(f.shutdown, false);
    assert.equal(f.wire.state.fatalCount, 0);
    assert.equal(f.entries.some(e => e.customType === 'agora-fatal'), false);
    assert.equal(await read(), undefined, '暂时传输失败后工具仍可使用');
    f.wire.state.refreshTransportFailure = false;
    tick();
    await until(() => f.wire.state.refreshCount === 4);
    await flushRefresh();
    assert.equal(attempts.length, 4);
    assert.equal(attempts.length - bodies.length, 3, '前三次传输失败，第四次收到完整响应');
    tick();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.wire.state.refreshCount, 4, '续期成功后expiresAt更新，下一次检查不再续期');
    assert.equal(f.shutdown, false);
    assert.equal(await read(), undefined);
  });
}

test('child路径解析异常由钩子自己捕获并阻断', async t => {
  const f = await setup(t, { managed: true });
  await f.handlers.get('session_start')({}, f.ctx);
  const result = await f.handlers.get('tool_call')({ toolName: 'read', input: { path: '\0' } }, f.ctx);
  assert.equal(result.block, true);
  assert.match(result.reason, /权限检查失败/);
  assert.equal(f.shutdown, true);
});
