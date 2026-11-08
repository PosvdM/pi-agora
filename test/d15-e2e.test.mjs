import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { startDaemon, RpcSubprocessDriver } from '../packages/daemon/dist/index.js';
import { connectHost } from '../packages/protocol/dist/index.js';
import { piFixture, containment, providerPath, until } from './fixtures/driver-helpers.mjs';
import { confirmUser } from './fixtures/security-signer.mjs';

const extensionPath = fileURLToPath(new URL('../packages/extension/dist/index.js', import.meta.url));
async function start(f, options = {}) {
  const home = path.join(f.root, 'agora');
  const driver = new RpcSubprocessDriver({ home, piPath: f.install.packageDir, extensionPath, env: f.env, extraExtensions: [providerPath], containment });
  const daemon = await startDaemon({ home, driver, ...options });
  const client = await connectHost({ home, as: 'host:cli', autoStart: false });
  return { daemon, client };
}
const spawn = (f, client, body = {}) => client.request('POST', '/v1/tasks', { model: 'p0-fake/scripted', profile: 'explore', cwd: f.cwd, prompt: 'D15 窄任务', ...body });
const logs = async f => (await readFile(f.env.FAKE_REQUEST_LOG, 'utf8')).trim().split('\n').map(JSON.parse);

test('D15 真实 pi：假 provider 返回 429 后暂停、到期通知、原会话续跑及请求用量持久化', { timeout: 60000 }, async () => {
  const reset = new Date(Date.now() + 3000).toISOString();
  const f = await piFixture({ turns: [{ usage: { input: 10, cacheRead: 20, cacheWrite: 3, output: 1 }, error: `429: ${JSON.stringify({ error: { type: 'usage_limit_reached', reset_at: reset } })}` }] });
  let daemon, client;
  try {
    ({ daemon, client } = await start(f));
    const task = await spawn(f, client);
    await until(() => daemon.store.task(task.taskId).status === 'quota_paused', 30000);
    await until(() => daemon.store.get('SELECT exited_at FROM process_runs WHERE agora_session_id=?', task.agoraSessionId)?.exited_at, 15000);
    assert.equal(daemon.tasks.activeCount(), 0);
    assert.equal(daemon.store.task(task.taskId).quota_resume_at, reset);
    await until(() => daemon.store.get("SELECT id FROM outbox WHERE kind='task:quota_ready'"), 15000);
    const notice = (await client.request('GET', '/v1/inbox')).items.find(n => n.kind === 'task:quota_ready');
    assert.equal(notice.payload.tasks[0].contextTokens, 33);
    await f.setScript({ fallback: { usage: { input: 40, cacheRead: 5, output: 7 }, segments: [{ type: 'text', text: '额度恢复后的结果' }] } });
    await confirmUser(client, await client.request('POST', `/v1/tasks/${task.taskId}/recover`, { mode: 'resume' }));
    await until(() => daemon.store.task(task.taskId).status === 'completed', 30000);
    const result = await client.request('GET', `/v1/tasks/${task.taskId}/result`);
    assert.equal(result.agoraSessionId, task.agoraSessionId); assert.equal(result.generation, 1);
    assert.equal(result.resultText, '额度恢复后的结果'); assert.equal(result.usage.requests, 2);
    assert.equal(result.usage.inputTokens, 50); assert.equal(result.usage.cacheReadTokens, 25); assert.equal(result.usage.cacheWriteTokens, 3); assert.equal(result.usage.outputTokens, 8); assert.equal(result.usage.contextTokens, 45);
    assert.match((await logs(f)).find(e => e.kind === 'request').lastUser, /^你是子代理。/);
  } finally { client?.close(); if (daemon) await daemon.close({ force: true }); await f.cleanup(); }
});

test('D15 真实 pi：仅加载名单内用户 skill，explore 可读其 SKILL.md，名单外拒绝，项目 skill 不加载', { timeout: 60000 }, async () => {
  const f = await piFixture(); let daemon, client;
  try {
    const allowed = path.join(f.agentDir, 'skills', 'd15-allowed'), other = path.join(f.agentDir, 'skills', 'd15-other'), project = path.join(f.cwd, '.pi', 'skills', 'd15-project');
    for (const [dir, name] of [[allowed, 'd15-allowed'], [other, 'd15-other'], [project, 'd15-project']]) {
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name}-unique-description\n---\n${name}-body\n`);
    }
    await f.setScript({ turns: [
      { segments: [{ type: 'toolCall', name: 'read', arguments: { path: path.join(allowed, 'SKILL.md') } }] },
      { segments: [{ type: 'toolCall', name: 'read', arguments: { path: path.join(other, 'SKILL.md') } }] },
      { segments: [{ type: 'text', text: 'skill 权限核对完成' }] },
    ] });
    ({ daemon, client } = await start(f));
    const task = await spawn(f, client, { skills: ['d15-allowed'] });
    await until(() => ['completed', 'failed'].includes(daemon.store.task(task.taskId).status), 30000);
    assert.equal(daemon.store.task(task.taskId).status, 'completed');
    const requests = (await logs(f)).filter(e => e.kind === 'request');
    assert.match(requests[0].systemPrompt, /d15-allowed-unique-description/);
    assert.doesNotMatch(requests[0].systemPrompt, /d15-other-unique-description|d15-project-unique-description/);
    const entries = (await readFile(daemon.store.session(task.agoraSessionId).session_file, 'utf8')).trim().split('\n').map(JSON.parse);
    const results = entries.filter(e => e.message?.role === 'toolResult').map(e => e.message);
    assert.equal(results[0].isError, false); assert.match(JSON.stringify(results[0]), /d15-allowed-body/);
    assert.equal(results[1].isError, true); assert.match(JSON.stringify(results[1]), /允许的目录/);
    await assert.rejects(spawn(f, client, { skills: ['d15-project'] }), e => e.code === 'skill_not_found');
    await f.setScript({ fallback: { segments: [{ type: 'text', text: '默认无 skill' }] } });
    const empty = await spawn(f, client); await until(() => daemon.store.task(empty.taskId).status === 'completed', 30000);
    const last = (await logs(f)).filter(e => e.kind === 'request').at(-1);
    assert.doesNotMatch(last.systemPrompt, /d15-allowed-unique-description|d15-other-unique-description|d15-project-unique-description/);
  } finally { client?.close(); if (daemon) await daemon.close({ force: true }); await f.cleanup(); }
});
