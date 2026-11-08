import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSameProcess } from 'pi-hostkit';
import { startDaemon, RpcSubprocessDriver, deleteArchiveOffline, offline } from '../packages/daemon/dist/index.js';
import { connectHost } from '../packages/protocol/dist/index.js';
import { openArchive, projectPartials } from '../packages/archive/dist/index.js';
import { containment, piFixture, providerPath, until } from './fixtures/driver-helpers.mjs';

const extensionPath = fileURLToPath(new URL('../packages/extension/dist/index.js', import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

test('真实 pi 中途强杀：delta-only 三类块归档、退出诊断和原始文件哈希保持完整', { timeout: 60_000 }, async () => {
  const f = await piFixture({ turns: [{ ignoreAbort: true, segments: [
    { type: 'thinking', text: '中断前的思考' },
    { type: 'text', chunks: ['尚未', '完成的文字'] },
    { type: 'toolCall', id: 'archive-call', name: 'read', arguments: { path: 'proof.txt' } },
    { type: 'hang' },
  ] }] });
  const home = path.join(f.root, 'agora');
  let daemon, client, reader;
  try {
    const driver = new RpcSubprocessDriver({ home, piPath: f.install.packageDir, extensionPath, env: f.env, extraExtensions: [providerPath], containment });
    await offline(home, ['set', 'userConfirmation', 'off']);
    daemon = await startDaemon({ home, driver, idleReclaimMs: 60_000 });
    client = await connectHost({ home, as: 'host:cli', autoStart: false });
    const task = await client.request('POST', '/v1/tasks', { model: 'p0-fake/scripted', thinking: 'high', profile: 'explore', cwd: f.cwd, prompt: '验证完整流片段存档' });
    const snapshot = await until(async () => {
      const value = await client.request('GET', `/v1/sessions/${task.agoraSessionId}/snapshot`);
      return value.inFlight.assistant?.blocks.length === 3 && value.inFlight.assistant.blocks[2].done && value;
    }, 20_000);
    assert.deepEqual(snapshot.inFlight.assistant.blocks.map(block => block.type), ['thinking', 'text', 'toolCall']);
    assert.equal(snapshot.inFlight.assistant.blocks[2].id, 'archive-call');
    assert.equal(snapshot.inFlight.assistant.blocks[2].toolName, 'read');
    assert.deepEqual(snapshot.unfinishedPartials, []);
    const session = daemon.store.session(task.agoraSessionId);
    const before = digest(await readFile(session.session_file));
    const run = daemon.store.get('SELECT * FROM process_runs WHERE agora_session_id=? ORDER BY started_at DESC LIMIT 1', task.agoraSessionId);
    const identity = JSON.parse(run.identity);
    assert.equal(await isSameProcess(identity), 'alive');
    // 目标是此测试独占、在受控 provider 中永久等待的子进程，不使用生产会话或猜测 PID。
    process.kill(identity.pid, 'SIGKILL');
    await until(() => daemon.store.task(task.taskId).status === 'interrupted', 15_000);
    await daemon.tasks.flush();
    assert.equal(digest(await readFile(session.session_file)), before);
    assert.equal(daemon.store.session(task.agoraSessionId).archive_state, 'partial');
    reader = await openArchive({ home, apiVersion: 1 });
    const partials = projectPartials(await reader.readPartials(task.agoraSessionId));
    assert.equal(partials.length, 1);
    assert.equal(partials[0].blocks[0].text, '中断前的思考');
    assert.equal(partials[0].blocks[1].text, '尚未完成的文字');
    assert.equal(partials[0].blocks[2].id, 'archive-call');
    assert.equal(partials[0].blocks[2].toolName, 'read');
    assert.deepEqual(partials[0].blocks[2].args, { path: 'proof.txt' });
    const diagnostics = await reader.readDiagnostics(task.agoraSessionId);
    assert.equal(diagnostics[0].runId, run.id);
    assert.equal(diagnostics[0].agoraSessionId, task.agoraSessionId);
    assert.equal(diagnostics[0].pid, identity.pid);
    assert.equal(diagnostics[0].startedAt, run.started_at);
    assert.ok(diagnostics[0].exitedAt);
    assert.ok(Array.isArray(diagnostics[0].lastEvents));
    assert.ok(Array.isArray(diagnostics[0].inFlightTools));
    assert.equal(typeof diagnostics[0].stderrTail, 'string');
    assert.equal(digest(await readFile(session.session_file)), before);
  } finally {
    reader?.close(); client?.close();
    try { if (daemon) await daemon.close({ force: true }); }
    finally { await f.cleanup(); }
  }
});

test('真实 pi 正常完成：最终内容只展示一次，离线删除识别真实 schema 与已释放写锁', { timeout: 60_000 }, async () => {
  const f = await piFixture({ turns: [{ usage: { input: 21, output: 3 }, segments: [{ type: 'text', text: '归档完成' }] }] });
  const home = path.join(f.root, 'agora');
  let daemon, client, reader;
  try {
    const driver = new RpcSubprocessDriver({ home, piPath: f.install.packageDir, extensionPath, env: f.env, extraExtensions: [providerPath], containment });
    await offline(home, ['set', 'userConfirmation', 'off']);
    daemon = await startDaemon({ home, driver, idleReclaimMs: 60_000 });
    client = await connectHost({ home, as: 'host:cli', autoStart: false });
    const task = await client.request('POST', '/v1/tasks', { model: 'p0-fake/scripted', thinking: 'off', profile: 'explore', cwd: f.cwd, prompt: '验证最终消息归档' });
    await until(() => daemon.store.task(task.taskId).status === 'completed', 20_000);
    await daemon.tasks.flush();
    const snapshot = await client.request('GET', `/v1/sessions/${task.agoraSessionId}/snapshot`);
    assert.equal(snapshot.entries.filter(entry => entry.message?.role === 'assistant').length, 1);
    assert.deepEqual(snapshot.unfinishedPartials, []);
    assert.equal(snapshot.usage.requests, 1);
    assert.equal(snapshot.usage.inputTokens, 21);
    assert.equal(snapshot.usage.contextTokens, 21);
    const metadata = await client.request('GET', `/v1/sessions/${task.agoraSessionId}`);
    assert.equal(metadata.archiveState, 'ok');
    await daemon.close({ force: true }); client.close(); client = undefined;
    reader = await openArchive({ home, apiVersion: 1 });
    const archived = await reader.readUserView(task.agoraSessionId);
    assert.deepEqual(archived.entries, snapshot.entries);
    assert.deepEqual(await reader.readPartials(task.agoraSessionId), []);
    reader.close(); reader = undefined;
    assert.deepEqual(await deleteArchiveOffline({ home, sessionId: task.agoraSessionId }), { sessionId: task.agoraSessionId, archiveState: 'missing', deleted: true });
    reader = await openArchive({ home, apiVersion: 1 });
    assert.equal((await reader.getSession(task.agoraSessionId)).archiveState, 'missing');
  } finally {
    reader?.close(); client?.close();
    try { if (daemon) await daemon.close({ force: true }); }
    finally { await f.cleanup(); }
  }
});
