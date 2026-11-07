import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';
import { startDaemon, RpcSubprocessDriver } from '../packages/daemon/dist/index.js';
import { connectHost } from '../packages/protocol/dist/index.js';
import { piFixture, containment, providerPath, until } from './fixtures/driver-helpers.mjs';

const extensionPath = fileURLToPath(new URL('../packages/extension/dist/index.js', import.meta.url));
const treeProvider = fileURLToPath(new URL('./fixtures/tree-provider.ts', import.meta.url));
test('真实 pi 多层派活：单名额不死锁，空闲父进程回收后下级通知重新拉起并落盘，父代理最终回复才完成', { timeout: 90_000 }, async () => {
  const f = await piFixture(), home = path.join(f.root, 'agora'); let daemon, client;
  try {
    const driver = new RpcSubprocessDriver({ home, piPath: f.install.packageDir, extensionPath, env: f.env, extraExtensions: [treeProvider], containment });
    daemon = await startDaemon({ home, driver, maxConcurrentRuns: 1, idleReclaimMs: 100 });
    client = await connectHost({ home, as: 'host:cli', autoStart: false });
    const parent = await client.request('POST', '/v1/tasks', { model: 'agora-tree/scripted', profile: 'explore', cwd: f.cwd, prompt: 'TREE_PARENT' }, { idempotencyKey: 'tree-parent' });
    await until(() => daemon.store.task(parent.taskId).status === 'waiting_children', 30_000);
    assert.equal(daemon.store.get("SELECT COUNT(*) AS n FROM outbox WHERE dedupe_key=?", `task:${parent.taskId}:1:completed`).n, 0);
    const child = daemon.store.get('SELECT * FROM tasks WHERE parent_task_id=?', parent.taskId);
    assert.ok(child); assert.equal(child.depth, 2);
    await until(() => daemon.store.task(parent.taskId).status === 'completed', 45_000);
    assert.equal((await client.request('GET', `/v1/tasks/${parent.taskId}/result`)).resultText, '父任务核对下级后的最终结果');
    assert.equal(daemon.store.get('SELECT COUNT(*) AS n FROM process_runs WHERE agora_session_id=?', parent.agoraSessionId).n, 2);
    const notice = daemon.store.get('SELECT * FROM outbox WHERE dedupe_key=?', `task:${child.id}:1:completed`);
    await until(() => daemon.store.get('SELECT acked_at FROM outbox WHERE id=?', notice.id).acked_at, 10_000);
    const session = daemon.store.session(parent.agoraSessionId);
    const entries = (await readFile(session.session_file, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(entries.filter(e => e.customType === 'agora:notice' && e.details?.dedupeKey === notice.dedupe_key).length, 1);
    assert.equal(daemon.store.task(parent.taskId).generation, 1);
  } finally { client?.close(); if (daemon) await daemon.close({ force: true }); await f.cleanup(); }
});

test('原生 Windows implement 的 PowerShell 工具实际运行；配置未开启时工具不暴露', { timeout: 90_000, skip: process.platform !== 'win32' }, async () => {
  const f = await piFixture({ turns: [
    { segments: [{ type: 'toolCall', name: 'powershell', arguments: { command: "Write-Output ('native-powershell-' + $PSVersionTable.PSEdition); Set-Content -LiteralPath proof.txt -Value '原生 PowerShell 验证' -Encoding UTF8", timeout: 5 } }] },
    { segments: [{ type: 'text', text: 'PowerShell 工具运行结束' }] },
  ] });
  const home = path.join(f.root, 'agora'); let daemon, client;
  try {
    const driver = new RpcSubprocessDriver({ home, piPath: f.install.packageDir, extensionPath, env: f.env, extraExtensions: [providerPath], containment });
    daemon = await startDaemon({ home, driver, powershell: true });
    client = await connectHost({ home, as: 'host:cli', autoStart: false });
    const task = await client.request('POST', '/v1/tasks', { model: 'p0-fake/scripted', profile: 'implement', cwd: f.cwd, prompt: '在原生 Windows 调用 PowerShell 工具完成验证' });
    await until(() => ['completed', 'failed', 'interrupted'].includes(daemon.store.task(task.taskId).status), 45_000);
    assert.equal(daemon.store.task(task.taskId).status, 'completed', JSON.stringify(await client.request('GET', `/v1/tasks/${task.taskId}`)));
    assert.match(await readFile(path.join(f.cwd, 'proof.txt'), 'utf8'), /原生 PowerShell 验证/);
    const entries = (await readFile(daemon.store.session(task.agoraSessionId).session_file, 'utf8')).trim().split('\n').map(JSON.parse);
    const result = entries.find(e => e.message?.role === 'toolResult' && e.message.toolName === 'powershell');
    assert.ok(result); assert.equal(result.message.isError, false); assert.match(JSON.stringify(result), /native-powershell-(Desktop|Core)/);
    const requests = (await readFile(f.env.FAKE_REQUEST_LOG, 'utf8')).trim().split('\n').map(JSON.parse).filter(e => e.kind === 'request');
    assert.equal(requests[0].tools.some(t => t.name === 'powershell'), true);
  } finally { client?.close(); if (daemon) await daemon.close({ force: true }); await f.cleanup(); }
});
