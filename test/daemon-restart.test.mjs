import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { isSameProcess, stopByIdentity } from 'pi-hostkit';
import { connectHost } from '../packages/protocol/dist/client.js';
import { piFixture, providerPath, containment, until, delay } from './fixtures/driver-helpers.mjs';

const hostFile = fileURLToPath(new URL('./fixtures/daemon-restart-host.mjs', import.meta.url));
const extensionPath = fileURLToPath(new URL('../packages/extension/dist/index.js', import.meta.url));
const blockerPath = fileURLToPath(new URL('./fixtures/daemon-restart-blocker.ts', import.meta.url));
const FAST_STOP = { abortTimeoutMs: 150, graceMs: 150, termGraceMs: 150 };
function message(child, type, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`等待后台进程消息超时：${type}`)); }, timeoutMs);
    const listener = value => {
      if (value?.type === 'failure') { cleanup(); reject(new Error(value.message)); }
      else if (value?.type === type) { cleanup(); resolve(value); }
    };
    const exited = () => { cleanup(); reject(new Error('测试后台进程提前退出')); };
    function cleanup() { clearTimeout(timer); child.off('message', listener); child.off('exit', exited); }
    child.on('message', listener); child.once('exit', exited);
  });
}
function start(config, env) {
  const child = spawn(process.execPath, [hostFile, JSON.stringify(config)], { env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  child.stdout.resume();
  child.stderr.resume();
  child.done = new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  return child;
}
function query(home, sql, ...args) {
  const db = new DatabaseSync(join(home, 'agora.db'), { readOnly: true });
  try { return db.prepare(sql).all(...args); }
  finally { db.close(); }
}
async function records(file) {
  try { return (await readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

for (const forgetIdentity of [false, true]) test(`真实 daemon 强杀并重启扫描：${forgetIdentity ? 'identity 尚未写库时从会话锁恢复' : '按 process_runs 身份清理旧 pi'}`, { timeout: 90_000 }, async t => {
  const f = await piFixture({ turns: [{ ignoreAbort: true, segments: [{ type: 'text', text: '受控流开始' }, { type: 'hang' }] }] });
  const home = join(f.root, 'agora');
  const config = { home, piPath: f.install.packageDir, extensionPath, providerPath, blockerPath, containment };
  let first, second, client, nextClient, identity;
  try {
    first = start(config, f.env);
    const started = await message(first, 'ready');
    client = await connectHost({ home, as: 'host:cli', autoStart: false });
    const task = await client.request('POST', '/v1/tasks', { model: 'p0-fake/scripted', thinking: 'off', profile: 'explore', prompt: '保持受控挂起，不能自动重放', cwd: f.cwd });
    const requestLog = f.env.FAKE_REQUEST_LOG;
    await until(async () => stat(join(f.root, 'daemon-rpc-blocked')).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; }), 25_000);
    assert.equal((await records(requestLog)).filter(row => row.kind === 'request').length, 1);
    const before = query(home, 'SELECT * FROM process_runs WHERE agora_session_id=?', task.agoraSessionId)[0];
    assert.equal(before.state, 'ready');
    identity = JSON.parse(before.identity);
    if (process.env.HOSTKIT_TEST_REQUIRE_CGROUP === '1') assert.ok(identity.cgroup, 'Linux auto CI 必须实际使用 cgroup，不得静默回退');
    assert.equal(await isSameProcess(identity), 'alive');
    if (forgetIdentity) {
      const forgot = message(first, 'identityForgotten');
      first.send({ type: 'forgetIdentity' });
      await forgot;
      assert.equal(query(home, 'SELECT identity FROM process_runs WHERE id=?', before.id)[0].identity, null);
    }
    const requestCount = (await records(requestLog)).filter(row => row.kind === 'request').length;
    first.kill('SIGKILL');
    await first.done;
    if (process.platform === 'win32') await until(async () => await isSameProcess(identity) === 'gone', 10_000);
    else assert.equal(await isSameProcess(identity), 'alive', 'POSIX 旧 pi 保持存活，验证重启确实清理而非仅改数据库');
    second = start(config, f.env);
    const restarted = await message(second, 'ready', 30_000);
    assert.notEqual(restarted.instanceId, started.instanceId);
    assert.equal(await isSameProcess(identity), 'gone');
    nextClient = await connectHost({ home, as: 'host:cli', autoStart: false });
    assert.equal((await nextClient.request('GET', `/v1/tasks/${task.taskId}`)).status, 'interrupted');
    const run = query(home, 'SELECT * FROM process_runs WHERE id=?', before.id)[0];
    assert.ok(run.exited_at, '只有旧进程清理完成后才记 exited_at');
    assert.equal(run.state, 'exited');
    assert.equal(run.daemon_instance_id, started.instanceId);
    assert.ok(run.diagnostics_path, '重启清理必须落盘退出诊断');
    const diagnostic = JSON.parse(await readFile(run.diagnostics_path, 'utf8'));
    assert.equal(diagnostic.cleanupConfirmed, true);
    assert.equal(diagnostic.previousDaemonInstanceId, started.instanceId);
    assert.equal(diagnostic.daemonInstanceId, restarted.instanceId);
    assert.equal(diagnostic.runId, before.id);
    assert.ok(Array.isArray(diagnostic.stopReports));
    assert.match(diagnostic.warnings[0], /内存事件.*不可用/);
    for (const report of diagnostic.stopReports) {
      assert.ok(['job_object', 'cgroup', 'snapshot_visible'].includes(report.coverage));
      assert.deepEqual(report.leftovers, []);
    }
    if (!forgetIdentity) assert.equal(diagnostic.stopReports.length, 1);
    assert.equal(query(home, 'SELECT COUNT(*) AS n FROM process_runs')[0].n, 1, '不会自动新建 run');
    const notices = query(home, "SELECT * FROM outbox WHERE recipient_id='user' AND kind='task:interrupted'");
    assert.equal(notices.length, 1);
    assert.equal(JSON.parse(notices[0].payload).taskId, task.taskId);
    assert.equal(notices[0].visible_after, 0);
    await delay(150);
    assert.equal((await records(requestLog)).filter(row => row.kind === 'request').length, requestCount, '没有自动重放任务书或副作用');
    const rejected = await fetch(`${restarted.url}/v1/status`, { headers: { Authorization: `Bearer ${client.token}`, 'Agora-Protocol': '1' }, signal: AbortSignal.timeout(3000) });
    assert.equal(rejected.status, 401, '重启后旧token失效');
    const closed = message(second, 'closed');
    second.send({ type: 'close' });
    await closed;
    await second.done;
    t.diagnostic(`已独立核对 ${process.platform} 的旧进程身份与 ${forgetIdentity ? '锁记录' : 'process_runs'} 恢复路径`);
  } finally {
    client?.close(); nextClient?.close();
    for (const child of [first, second]) if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await child.done; }
    if (identity && await isSameProcess(identity) !== 'gone') await stopByIdentity(identity, FAST_STOP);
    await f.cleanup();
  }
});

test('真实旧pi在重启清理失败后，stop/shutdown保持未确认直到安全重试成功', { timeout: 90_000 }, async () => {
  const f = await piFixture({ turns: [{ ignoreAbort: true, segments: [{ type: 'text', text: '受控流开始' }, { type: 'hang' }] }] });
  const home = join(f.root, 'agora');
  const config = { home, piPath: f.install.packageDir, extensionPath, providerPath, blockerPath, containment };
  let first, second, client, nextClient, identity;
  try {
    first = start(config, f.env);
    await message(first, 'ready');
    client = await connectHost({ home, as: 'host:cli', autoStart: false });
    const task = await client.request('POST', '/v1/tasks', { model: 'p0-fake/scripted', thinking: 'off', profile: 'explore', prompt: '不可自动重放', cwd: f.cwd });
    await until(() => stat(join(f.root, 'daemon-rpc-blocked')).then(() => true, () => false), 25_000);
    const run = query(home, 'SELECT * FROM process_runs WHERE agora_session_id=?', task.agoraSessionId)[0];
    identity = JSON.parse(run.identity);
    first.kill('SIGKILL'); await first.done;
    second = start({ ...config, failRecovery: true }, f.env);
    await message(second, 'ready');
    nextClient = await connectHost({ home, as: 'host:cli', autoStart: false });
    if (process.platform === 'win32') await until(async () => await isSameProcess(identity) === 'gone');
    else assert.equal(await isSameProcess(identity), 'alive');
    await assert.rejects(nextClient.request('POST', `/v1/tasks/${task.taskId}/stop`, {}), error => error.code === 'stop_incomplete');
    assert.equal((await nextClient.request('GET', `/v1/tasks/${task.taskId}`)).status, 'interrupted');
    await assert.rejects(nextClient.request('POST', '/v1/admin/shutdown', { force: true, timeoutMs: 1000 }), error => error.code === 'stop_incomplete');
    assert.equal((await nextClient.request('GET', '/v1/status')).draining, true, '停止不完整时daemon仍提供诊断，不报告关闭成功');
    assert.equal(query(home, 'SELECT exited_at FROM process_runs WHERE id=?', run.id)[0].exited_at, null);
    assert.equal(query(home, 'SELECT COUNT(*) AS n FROM process_runs')[0].n, 1, '原会话不能被自动重新打开');
    if (process.platform !== 'win32') assert.equal(await isSameProcess(identity), 'alive', '失败的stop/shutdown不能伪称旧pi已退出');
    const allowed = message(second, 'recoveryAllowed'); second.send({ type: 'allowRecovery' }); await allowed;
    const stopped = await nextClient.request('POST', `/v1/tasks/${task.taskId}/stop`, {});
    assert.equal(stopped.status, 'stopped');
    assert.ok(stopped.stopReport);
    assert.equal(await isSameProcess(identity), 'gone');
    assert.ok(query(home, 'SELECT exited_at FROM process_runs WHERE id=?', run.id)[0].exited_at);
    const closed = message(second, 'closed'); second.send({ type: 'close' }); await closed; await second.done;
  } finally {
    client?.close(); nextClient?.close();
    for (const child of [first, second]) if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await child.done; }
    if (identity && await isSameProcess(identity) !== 'gone') await stopByIdentity(identity, FAST_STOP);
    await f.cleanup();
  }
});
