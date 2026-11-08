import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { startDaemon, RpcSubprocessDriver } from '../packages/daemon/dist/index.js';
import { connectHost } from '../packages/protocol/dist/index.js';
import { piFixture, containment, until } from './fixtures/driver-helpers.mjs';

const extensionPath = fileURLToPath(new URL('../packages/extension/dist/index.js', import.meta.url));
const budgetProvider = fileURLToPath(new URL('./fixtures/budget-provider.ts', import.meta.url));
for (const idleReclaimMs of [100, 60_000]) test(`真实 pi 静默预算事件：单名额父回合增额恢复并处理同代第二次暂停（idleReclaimMs=${idleReclaimMs}）`, { timeout: 120_000 }, async () => {
  const f = await piFixture(), home = path.join(f.root, 'agora'); let daemon, client;
  try {
    const driver = new RpcSubprocessDriver({ home, piPath: f.install.packageDir, extensionPath, env: f.env, extraExtensions: [budgetProvider], containment });
    daemon = await startDaemon({ home, driver, maxConcurrentRuns: 1, idleReclaimMs });
    client = await connectHost({ home, as: 'host:cli', autoStart: false });
    const parent = await client.request('POST', '/v1/tasks', { model: 'agora-budget/scripted', profile: 'explore', cwd: f.cwd, prompt: 'BUDGET_PARENT', maxTokens: 1000 }, { idempotencyKey: 'budget-parent' });
    await until(() => daemon.store.task(parent.taskId).status === 'waiting_children', 30_000);
    const child = daemon.store.get('SELECT * FROM tasks WHERE parent_task_id=?', parent.taskId);
    assert.ok(child); assert.equal(child.notify, 'silent'); assert.equal(child.max_tokens, 30);
    await until(() => daemon.store.task(parent.taskId).status === 'completed', 60_000);
    assert.equal((await client.request('GET', `/v1/tasks/${parent.taskId}/result`)).resultText, '父任务已处理两次预算暂停并停止下级');
    assert.equal(daemon.store.task(parent.taskId).generation, 1);
    assert.equal(daemon.store.task(child.id).generation, 1);
    assert.equal(daemon.store.task(child.id).status, 'stopped');
    assert.equal(daemon.store.task(child.id).max_tokens, 60);
    assert.equal(daemon.store.usage(child.id).requests, 2);
    assert.equal(daemon.store.get('SELECT COUNT(*) AS n FROM process_runs WHERE agora_session_id=?', parent.agoraSessionId).n, idleReclaimMs === 100 ? 3 : 1);
    const notices = daemon.store.all("SELECT * FROM outbox WHERE kind='task:budget_paused' AND json_extract(payload,'$.taskId')=? ORDER BY json_extract(payload,'$.revision')", child.id);
    assert.equal(notices.length, 2); assert.notEqual(notices[0].dedupe_key, notices[1].dedupe_key);
    assert.ok(JSON.parse(notices[1].payload).revision > JSON.parse(notices[0].payload).revision);
    await until(() => daemon.store.get("SELECT COUNT(*) AS n FROM outbox WHERE kind='task:budget_paused' AND acked_at IS NOT NULL").n === 2, 10_000);
    const entries = (await readFile(daemon.store.session(parent.agoraSessionId).session_file, 'utf8')).trim().split('\n').map(JSON.parse);
    for (const notice of notices) {
      const payload = JSON.parse(notice.payload);
      assert.equal(payload.generation, 1); assert.equal(payload.triggerTurn, true); assert.equal(payload.notify, 'wake');
      assert.equal(entries.filter(e => e.customType === 'agora:notice' && e.details?.dedupeKey === notice.dedupe_key).length, 1);
    }
    for (const toolCallId of ['budget-limits', 'budget-resume', 'budget-stop']) {
      const result = entries.find(e => e.message?.role === 'toolResult' && e.message.toolCallId === toolCallId);
      assert.ok(result, toolCallId); assert.equal(result.message.isError, false, JSON.stringify(result));
    }
    const rounds = (await readFile(f.env.FAKE_REQUEST_LOG, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(rounds.filter(r => r.leaf).length, 2);
    assert.ok(rounds.some(r => !r.leaf && r.notices === 1 && !r.raised));
    assert.ok(rounds.some(r => !r.leaf && r.notices >= 2 && !r.stopped));
  } finally { client?.close(); if (daemon) await daemon.close({ force: true }); await f.cleanup(); }
});
