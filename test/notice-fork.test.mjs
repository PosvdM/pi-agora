import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnManaged } from 'pi-hostkit';
import { startDaemon, RpcSubprocessDriver } from '../packages/daemon/dist/index.js';
import { createClient } from '../packages/protocol/dist/index.js';
import { piFixture, providerPath, containment, until } from './fixtures/driver-helpers.mjs';

const extensionPath = fileURLToPath(new URL('../packages/extension/dist/index.js', import.meta.url));
test('真实 fork 继承父通知后仍收取自己的乱序完成通知，模型正文可定位任务', { timeout: 90_000 }, async () => {
  const f = await piFixture({ fallback: { segments: [{ type: 'text', text: '相同摘要' }] }, routes: [
    { when: { includes: '后完成' }, reply: { segments: [{ type: 'text', text: '相同摘要', delayMs: 800 }] } },
  ] });
  const home = path.join(f.root, 'agora');
  const driver = new RpcSubprocessDriver({ home, piPath: f.install.packageDir, extensionPath, env: f.env, extraExtensions: [providerPath], containment });
  const daemon = await startDaemon({ home, driver });
  const acked = [];
  const ack = daemon.auth.ack.bind(daemon.auth);
  const spy = mock.method(daemon.auth, 'ack', (conn, body) => { acked.push({ principalId: conn.principalId, noticeId: body.noticeId }); return ack(conn, body); });
  let main;
  const clients = [];
  try {
    main = await spawnManaged({ argv: [f.install.cliEntry, '--mode', 'rpc', '--offline', '--session', f.sessionPath('main'),
      '--model', 'p0-fake/scripted', '--thinking', 'off', '--tools', 'agora_task', '-ne', '-ns', '-np', '--no-approve',
      '-e', extensionPath, '-e', providerPath], cwd: f.cwd, env: { ...f.env, AGORA_HOME: home }, runId: 'fork-main', instanceId: 'fork-test', containment });
    const entries = async () => (await main.rpc.send({ type: 'get_entries' })).data.entries;
    const principal = async () => (await entries()).findLast(e => e.type === 'custom' && e.customType === 'agora-principal').data.principalId;
    const prompt = async text => {
      await main.rpc.send({ type: 'prompt', message: text });
      await until(async () => !(await main.rpc.send({ type: 'get_state' })).data.isStreaming);
    };
    const clientFor = id => {
      const conn = [...daemon.auth.connections.values()].find(c => c.type === 'agent:main' && c.principalId === id);
      assert.ok(conn);
      const client = createClient({ url: daemon.url, token: conn.token });
      clients.push(client);
      return client;
    };
    const spawn = (client, title, prompt) => client.request('POST', '/v1/tasks', { model: 'p0-fake/scripted', thinking: 'off', profile: 'explore', cwd: f.cwd, title, prompt });
    await main.rpc.send({ type: 'get_state' });
    await prompt('父会话初始对话');
    const parent = await principal();
    const parentTask = await spawn(clientFor(parent), '父任务', '父任务');
    const noticeFor = task => daemon.store.get('SELECT * FROM outbox WHERE dedupe_key=?', `task:${task.taskId}:1:completed`);
    await until(() => noticeFor(parentTask)?.acked_at, 25_000);
    const parentNoticeId = noticeFor(parentTask).id;
    await prompt('分叉边界');
    const forkPoint = (await entries()).findLast(e => e.type === 'message' && e.message.role === 'user');
    assert.equal((await main.rpc.send({ type: 'fork', entryId: forkPoint.id }, { timeoutMs: 30_000 })).data.cancelled, false);
    const child = await principal();
    assert.notEqual(child, parent);
    assert.ok((await entries()).some(e => e.customType === 'agora:notice' && e.details.noticeId === parentNoticeId));
    const client = clientFor(child);
    const slow = await spawn(client, '后完成标题', '后完成');
    const fast = await spawn(client, '先完成标题', '先完成');
    await until(() => noticeFor(slow)?.acked_at && noticeFor(fast)?.acked_at, 30_000);
    assert.equal(acked.filter(a => a.noticeId === parentNoticeId && a.principalId !== parent).length, 0, '新 principal 不能尝试确认父通知');
    for (const task of [slow, fast]) {
      assert.equal(noticeFor(task).recipient_id, child);
      assert.ok(acked.some(a => a.principalId === child && a.noticeId === noticeFor(task).id));
    }
    assert.ok(noticeFor(fast).created_at < noticeFor(slow).created_at, '相同摘要的两任务必须乱序完成');
    const received = await until(async () => {
      const rows = (await readFile(f.env.FAKE_REQUEST_LOG, 'utf8')).trim().split('\n').map(JSON.parse)
        .filter(r => r.kind === 'request' && r.lastUser?.includes('【agora 子代理事件】')).map(r => r.lastUser);
      return [slow, fast].every(task => rows.some(text => text.includes(task.taskId))) ? rows : undefined;
    }, 15_000);
    for (const task of [slow, fast]) {
      const text = received.find(text => text.includes(task.taskId));
      assert.ok(text.includes(task.title));
      assert.match(text, /generation：1/);
      assert.match(text, /状态：completed/);
      assert.ok(text.includes(JSON.stringify({ action: 'result', taskId: task.taskId, generation: 1 })));
      assert.match(text, /相同摘要/);
    }
  } finally {
    for (const client of clients) client.close();
    if (main) await main.stop({ abortTimeoutMs: 1000, graceMs: 500, termGraceMs: 500 });
    spy.mock.restore();
    await daemon.close({ force: true, timeoutMs: 1000 });
    await f.cleanup();
  }
});
