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
async function until(fn) {
  const deadline = Date.now() + 5000;
  while (!fn()) { if (Date.now() >= deadline) throw new Error('测试等待超时'); await delay(20); }
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
  await assert.rejects(tool.execute('bad', { action: 'spawn', profile: 'implement', model: 'fake/model', prompt: '越权' }, undefined, undefined, f.ctx), /explore/);
});

test('daemon重启后重新发现握手并凭恢复证明认领原principal', async t => {
  const f = await setup(t);
  await f.handlers.get('session_start')({}, f.ctx);
  await f.wire.restart();
  await until(() => f.wire.state.reclaimCount === 1);
  const result = await f.registered[0].execute('after-restart', { action: 'status', taskId: 'task-one' }, undefined, undefined, f.ctx);
  assert.equal(result.details.taskId, 'task-one');
  assert.equal(f.wire.state.registerCount, 1);
});

test('child就绪前拒绝全部工具，启动凭证不进入工具结果及会话', async t => {
  const f = await setup(t, { managed: true });
  const hook = f.handlers.get('tool_call');
  assert.equal((await hook({ toolName: 'read', input: { path: 'public.txt' } }, f.ctx)).block, true);
  assert.equal(f.registered.length, 0);
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

test('child路径解析异常由钩子自己捕获并阻断', async t => {
  const f = await setup(t, { managed: true });
  await f.handlers.get('session_start')({}, f.ctx);
  const result = await f.handlers.get('tool_call')({ toolName: 'read', input: { path: '\0' } }, f.ctx);
  assert.equal(result.block, true);
  assert.match(result.reason, /权限检查失败/);
  assert.equal(f.shutdown, true);
});
