import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';
import { startDaemon, RpcSubprocessDriver } from '../packages/daemon/dist/index.js';
import { connectHost } from '../packages/protocol/dist/index.js';
import { piFixture, containment, until, delay } from './fixtures/driver-helpers.mjs';

const extensionPath = fileURLToPath(new URL('../packages/extension/dist/index.js', import.meta.url));
const warmProvider = fileURLToPath(new URL('./fixtures/warm-provider.ts', import.meta.url));
const requests = async f => (await readFile(f.env.FAKE_REQUEST_LOG, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse);

test('真实 pi 缓存预热：运行期间的预热计入逐请求用量和预算，受管会话空闲后不再预热', { timeout: 90_000 }, async () => {
  const f = await piFixture(), home = path.join(f.root, 'agora'); let daemon, client;
  try {
    // 夹具默认关闭预热；这里显式使用 pi 1.5.1 起的默认值 idle，让 CI 中的 pi 1.5.0 也覆盖空闲预热。
    const settingsPath = path.join(f.agentDir, 'settings.json');
    await writeFile(settingsPath, JSON.stringify({ ...JSON.parse(await readFile(settingsPath, 'utf8')), cacheWarming: 'idle' }));
    const driver = new RpcSubprocessDriver({ home, piPath: f.install.packageDir, extensionPath, env: f.env, extraExtensions: [warmProvider], containment });
    daemon = await startDaemon({ home, driver, idleReclaimMs: 60_000 });
    client = await connectHost({ home, as: 'host:cli', autoStart: false });
    const task = await client.request('POST', '/v1/tasks', { model: 'agora-warm/cached', profile: 'explore', cwd: f.cwd, prompt: '列出目录' }, { idempotencyKey: 'warm-task' });
    await until(() => daemon.store.task(task.taskId).status === 'completed', 60_000);
    const settled = await requests(f);
    const warms = settled.filter(r => r.warm);
    assert.equal(settled.filter(r => !r.warm).length, 2);
    assert.ok(warms.length >= 1, `运行期间应有预热请求：${JSON.stringify(settled)}`);
    // 空闲后 pi 原本每 1 秒刷新一次；等待多个周期，确认受管扩展停止了空闲预热。
    await delay(3500);
    assert.deepEqual(await requests(f), settled);
    const rows = daemon.store.all("SELECT request_id, cache_read_tokens, output_tokens, context_tokens FROM usage_records WHERE task_id=? AND request_id LIKE 'cache-warm:%'", task.taskId);
    assert.equal(rows.length, warms.length);
    for (const row of rows) assert.deepEqual([row.cache_read_tokens, row.output_tokens, row.context_tokens], [500, 1, 0]);
    const status = await client.request('GET', `/v1/tasks/${task.taskId}`);
    assert.equal(status.usage.requests, 2 + warms.length);
    assert.equal(status.usage.cacheReadTokens, 500 + 500 * warms.length);
    assert.equal(status.usage.contextTokens, 530, '预热不覆盖最近一次真实请求的上下文大小');
    assert.equal(status.budget.usedTokens, 30 + 8 + 500 + 510 + 501 * warms.length);
  } finally { client?.close(); if (daemon) await daemon.close({ force: true }); await f.cleanup(); }
});
