import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, readdir, access, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireSessionWriterLock, isSessionWriterLock, currentProcessIdentity, sessionLocksDir } from 'pi-hostkit';
import { startDaemon } from '../packages/daemon/dist/index.js';
import { connectHost, AgoraHttpError } from '../packages/protocol/dist/client.js';
import { runCli } from '../packages/cli/dist/index.js';
import { assertIsolatedTestHome } from './fixtures/test-home.mjs';

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function device() {
  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const deviceId = randomUUID(), publicKey = keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  return { deviceId, publicKey, sign(challenge) { return { deviceId, publicKey, alg: 'ECDSA-P256-SHA256', signature: sign('sha256', Buffer.from(canonical({ domain: 'pi-pane/user-presence/v1', payload: challenge })), { key: keys.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url') }; } };
}
async function until(fn) {
  const end = Date.now() + 5000;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await delay(5); }
  assert.fail('等待测试运行超时');
}
class Driver {
  handles = [];
  async start(spec) {
    await mkdir(path.dirname(spec.sessionFile), { recursive: true });
    const entries = [{ type: 'message', id: 'secret', parentId: null, timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: '不能泄露的存档内容' }], timestamp: Date.now() } }];
    await writeFile(spec.sessionFile, [{ type: 'session', version: 3, id: 'pi_test', cwd: spec.cwd, timestamp: new Date().toISOString() }, ...entries].map(JSON.stringify).join('\n') + '\n');
    await assertIsolatedTestHome(this.home);
    const writer = await acquireSessionWriterLock(spec.sessionFile, { app: 'pi-agora', identity: currentProcessIdentity(spec.runId) });
    assert.ok(isSessionWriterLock(writer));
    assert.equal(await writer.recoverPreviousWriter(), 'none');
    const launched = this.daemon.auth.launch({ ticket: spec.env.AGORA_LAUNCH_TICKET });
    const conn = this.daemon.auth.authenticate(`Bearer ${launched.token}`);
    const events = new Set(), exits = new Set(); let finish;
    const handle = { spec, conn, token: launched.token, entries, ready: false, stopped: false,
      identity: { pid: 88000 + this.handles.length, startTime: 'fake', runId: spec.runId, instanceId: spec.instanceId },
      exited: new Promise(resolve => { finish = resolve; }),
      onEvent(fn) { events.add(fn); return () => events.delete(fn); }, onExit(fn) { exits.add(fn); return () => exits.delete(fn); },
      emit(event) { for (const fn of events) fn(event); }, markReady() { this.ready = true; }, diagnostics() { return {}; }, respondUi() {},
      async send(command) {
        const data = command.type === 'get_available_models' ? { models: [{ provider: 'test', id: 'model' }] }
          : command.type === 'get_state' ? { model: spec.model, thinkingLevel: spec.thinking, sessionFile: spec.sessionFile }
          : command.type === 'get_entries' ? { entries: this.entries, leafId: 'secret' }
          : command.type === 'get_last_assistant_text' ? { text: '完成' } : {};
        return { type: 'response', command: command.type, success: true, data };
      },
      async stop() {
        if (!this.stopped) {
          this.stopped = true; await writer.release();
          const exit = { identity: this.identity, code: 0, signal: null, cleanupConfirmed: true };
          finish(exit); for (const fn of exits) fn(exit);
        }
        return { coverage: 'snapshot_visible', steps: [], leftovers: [] };
      },
    };
    this.handles.push(handle);
    queueMicrotask(() => this.daemon.tasks.ready(conn, { tools: spec.tools, model: spec.model, thinking: spec.thinking, extensionVersion: '0.1.0' }, spec.runId).catch(() => {}));
    return handle;
  }
  async recoverOldRun() { throw new Error('测试不能恢复未知进程'); }
}
async function setup(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'agora-archive-security-'));
  const keys = ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'AGORA_HOME'];
  const saved = new Map(keys.map(key => [key, process.env[key]]));
  process.env.HOME = process.env.USERPROFILE = path.join(home, 'user');
  process.env.APPDATA = path.join(home, 'user', 'AppData', 'Roaming');
  process.env.LOCALAPPDATA = path.join(home, 'user', 'AppData', 'Local');
  process.env.AGORA_HOME = home;
  await assertIsolatedTestHome(home);
  const driver = new Driver(); driver.home = home;
  const daemon = await startDaemon({ home, driver, readyTimeoutMs: 2000, maxTaskDepth: 4, maxConcurrentRuns: 8, idleReclaimMs: 60000 }); driver.daemon = daemon;
  const clients = [];
  t.after(async () => {
    try { clients.forEach(client => client.close()); await daemon.close({ force: true, timeoutMs: 2000 }); await rm(home, { recursive: true, force: true }); }
    finally { for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
  });
  const connect = async type => {
    const client = await connectHost({ home, as: type, autoStart: false }); clients.push(client);
    if (type === 'agent:main') await client.request('POST', '/v1/principals/register', { sessionId: randomUUID(), ephemeral: true, cwd: home });
    return client;
  };
  const host = await connect('host:cli'), pane = await connect('host:pane'), main = await connect('agent:main');
  const http = async (client, method, route, body, extra = {}) => {
    const response = await fetch(daemon.url + route, { method, headers: { 'Agora-Protocol': '1', Authorization: `Bearer ${client.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(8000) });
    return { status: response.status, body: await response.json() };
  };
  const signer = device();
  const pair = await host.request('POST', '/v1/devices/pair', { deviceId: signer.deviceId, publicKey: signer.publicKey });
  assert.equal((await http(pane, 'POST', `/v1/confirmations/${pair.confirmation.confirmationId}/sign`, signer.sign(pair.confirmation.challenge))).status, 200);
  const spawn = async (owner = main) => {
    const task = await owner.request('POST', '/v1/tasks', { model: 'test/model', thinking: 'high', profile: 'explore', prompt: '归档安全测试', cwd: home });
    const handle = await until(() => driver.handles.find(value => value.spec.agoraSessionId === task.agoraSessionId && value.ready && daemon.store.get("SELECT id FROM process_runs WHERE id=? AND state='ready'", value.spec.runId)));
    return { task, handle, base: `/v1/sessions/${task.agoraSessionId}` };
  };
  const stop = async item => { await host.request('POST', `/v1/tasks/${item.task.taskId}/stop`, {}); await daemon.tasks.flush(); };
  const pending = async (item, owner = host, extra = {}) => http(owner, 'POST', item.base + '/archive/delete', {}, extra);
  const confirm = async cf => http(pane, 'POST', `/v1/confirmations/${cf.confirmationId}/sign`, signer.sign(cf.challenge));
  return { home, daemon, driver, host, pane, main, connect, http, signer, spawn, stop, pending, confirm };
}

test('在线删除必须真 P-256 签名，保护 off 仍需签名，幂等跟随结果且缓存清空', { timeout: 20000 }, async t => {
  const f = await setup(t), item = await f.spawn();
  const before = await f.host.request('GET', item.base + '/snapshot'); assert.equal(before.entries[0].id, 'secret');
  await f.stop(item);
  f.daemon.store.run("UPDATE settings SET value='\"off\"' WHERE key='userConfirmation'");
  const key = randomUUID();
  const pending = await f.pending(item, f.main, { 'Idempotency-Key': key }); assert.equal(pending.status, 202);
  await access(item.handle.spec.sessionFile);
  assert.equal((await f.http(f.host, 'POST', item.base + '/archive/delete', { expectedRevision: null })).status, 400);
  assert.equal((await f.http(f.host, 'POST', item.base + '/archive/delete', { confirmedBy: 'device' })).status, 400);
  const cf = pending.body.confirmation;
  assert.equal((await f.http(f.pane, 'POST', `/v1/confirmations/${cf.confirmationId}/sign`, {})).status, 403);
  const changed = f.signer.sign({ ...cf.challenge, paramsHash: 'tampered' });
  assert.equal((await f.http(f.pane, 'POST', `/v1/confirmations/${cf.confirmationId}/sign`, changed)).status, 403);
  const transactionSamples = [];
  const sampling = setInterval(() => transactionSamples.push(f.daemon.store.db.isTransaction), 1);
  let result;
  try { result = await f.confirm(cf); } finally { clearInterval(sampling); }
  assert.ok(transactionSamples.length > 0); assert.equal(transactionSamples.some(Boolean), false);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.archiveState, 'missing'); await assert.rejects(access(item.handle.spec.sessionFile));
  assert.equal((await f.confirm(cf)).status, 409);
  const again = await f.pending(item, f.main, { 'Idempotency-Key': key }); assert.equal(again.status, 200); assert.equal(again.body.deleted, true);
  const row = await f.host.request('GET', item.base); assert.equal(row.archiveState, 'missing');
  const snapshot = await f.host.request('GET', item.base + '/snapshot'); assert.deepEqual(snapshot.entries, []); assert.deepEqual(snapshot.unfinishedPartials, []);
  assert.equal(f.daemon.store.get("SELECT tombstone FROM changes WHERE object_type='session' AND object_id=? ORDER BY seq DESC LIMIT 1", item.task.agoraSessionId).tombstone, 0);
  assert.equal(f.daemon.store.db.isTransaction, false);
  await f.daemon.tasks.sessions.flush(); await assert.rejects(access(path.dirname(item.handle.spec.sessionFile)));
  const audit = await f.host.request('GET', '/v1/audit'); assert.ok(audit.items.some(row => row.action === 'agora.archive.delete' && row.outcome === 'confirmed'));
});

test('签名绑定目标、参数与 revision；过期与旧版本失败且 nonce 不重放', { timeout: 20000 }, async t => {
  const f = await setup(t), first = await f.spawn(), second = await f.spawn(); await f.stop(first); await f.stop(second);
  const a = (await f.pending(first)).body.confirmation, b = (await f.pending(second)).body.confirmation;
  assert.equal((await f.http(f.pane, 'POST', `/v1/confirmations/${b.confirmationId}/sign`, f.signer.sign(a.challenge))).status, 403);
  f.daemon.store.run('UPDATE agora_sessions SET revision=revision+1 WHERE id=?', first.task.agoraSessionId);
  assert.equal((await f.confirm(a)).status, 409);
  assert.equal((await f.host.request('GET', `/v1/confirmations/${a.confirmationId}`)).state, 'failed');
  assert.equal((await f.confirm(a)).status, 409);
  const expiry = (await f.pending(first)).body.confirmation;
  f.daemon.store.run("UPDATE pending_confirmations SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?", expiry.confirmationId);
  assert.equal((await f.confirm(expiry)).status, 410);
  await access(first.handle.spec.sessionFile); await access(second.handle.spec.sessionFile);
});

test('在线删除拒绝活跃/清理不明 run、未知写锁、链接与越界路径', { timeout: 25000 }, async t => {
  const f = await setup(t), active = await f.spawn();
  assert.equal((await f.confirm((await f.pending(active)).body.confirmation)).status, 409);
  await f.stop(active);
  f.daemon.store.run("UPDATE process_runs SET cleanup_error='unknown' WHERE agora_session_id=?", active.task.agoraSessionId);
  assert.equal((await f.confirm((await f.pending(active)).body.confirmation)).status, 409);
  f.daemon.store.run('UPDATE process_runs SET cleanup_error=NULL WHERE agora_session_id=?', active.task.agoraSessionId);
  const wrong = path.join(f.home, 'outside.jsonl'); await writeFile(wrong, '{}\n');
  f.daemon.store.run('UPDATE agora_sessions SET session_file=? WHERE id=?', wrong, active.task.agoraSessionId);
  assert.ok((await f.confirm((await f.pending(active)).body.confirmation)).status >= 400);
  f.daemon.store.run('UPDATE agora_sessions SET session_file=? WHERE id=?', active.handle.spec.sessionFile, active.task.agoraSessionId);
  const linked = path.join(path.dirname(active.handle.spec.sessionFile), 'outside');
  try { await symlink(path.join(f.home, 'user'), linked, 'junction'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOENT'].includes(error.code)) { await mkdir(path.join(f.home, 'user'), { recursive: true }); await symlink(path.join(f.home, 'user'), linked, 'junction'); } else throw error; }
  assert.ok((await f.confirm((await f.pending(active)).body.confirmation)).status >= 400); await rm(linked, { force: true });
  const held = await acquireSessionWriterLock(active.handle.spec.sessionFile, { app: 'pi-agora', identity: currentProcessIdentity('held-test') }); assert.ok(isSessionWriterLock(held));
  assert.equal(await held.recoverPreviousWriter(), 'none');
  try { assert.ok((await f.confirm((await f.pending(active)).body.confirmation)).status >= 400); } finally { await held.release(); }
  await access(active.handle.spec.sessionFile);
  await assertIsolatedTestHome(f.home);
  let removedProof = false;
  for (const entry of await readdir(sessionLocksDir())) {
    if (!entry.endsWith('.json')) continue;
    const recordFile = path.join(sessionLocksDir(), entry), record = JSON.parse(await readFile(recordFile, 'utf8'));
    if (path.resolve(record.sessionFile) === path.resolve(active.handle.spec.sessionFile)) { await rm(recordFile); removedProof = true; }
  }
  assert.equal(removedProof, true);
  const unproven = await f.confirm((await f.pending(active)).body.confirmation);
  assert.equal(unproven.status, 409); assert.match(unproven.body.error.message, /旧写者/);
  await access(active.handle.spec.sessionFile);
});

test('主树、外树、child 与接管边界统一覆盖元数据/快照/历史/诊断/stream/verify', { timeout: 20000 }, async t => {
  const f = await setup(t), root = await f.spawn(), other = await f.connect('agent:main');
  const child = await f.spawn({ request: (method, route, body) => f.http(root.handle, method, route, body).then(result => { assert.equal(result.status, 201, JSON.stringify(result.body)); return result.body; }) });
  for (const suffix of ['', '/snapshot', '/history', '/diagnostics', '/stream']) {
    assert.equal((await f.http(other, 'GET', root.base + suffix)).status, 403);
    assert.equal((await f.http(root.handle, 'GET', root.base + suffix)).status, 403);
  }
  assert.equal((await f.http(root.handle, 'POST', root.base + '/archive/delete', {})).status, 403);
  assert.equal((await f.http(other, 'POST', '/v1/archive/verify', { sessionId: child.task.agoraSessionId })).status, 403);
  const own = await f.main.request('GET', child.base + '/snapshot'); assert.equal(own.entries[0].id, 'secret');
  const list = await f.main.request('GET', '/v1/sessions?limit=1'); assert.equal(list.items.length, 1); assert.ok(list.nextCursor);
  const verifiedPage = await f.main.request('POST', '/v1/archive/verify?limit=1', {}); assert.equal(verifiedPage.items.length, 1); assert.ok(verifiedPage.nextCursor);
  const outside = await other.request('GET', '/v1/sessions'); assert.equal(outside.items.length, 0);
  assert.equal((await other.request('POST', '/v1/archive/verify', {})).items.length, 0);
  const snap = await f.main.request('GET', child.base + '/snapshot');
  const stream = await fetch(f.daemon.url + child.base + `/stream?epoch=${encodeURIComponent(snap.cursor.epoch)}&afterSeq=0`, { headers: { 'Agora-Protocol': '1', Authorization: `Bearer ${f.main.token}` }, signal: AbortSignal.timeout(6000) });
  assert.equal(stream.status, 200);
  const reader = stream.body.getReader();
  const taken = await f.host.request('POST', `/v1/tasks/${root.task.taskId}/takeover`, {});
  assert.equal((await f.confirm(taken.confirmation)).status, 200);
  const end = Date.now() + 3500;
  let done = false;
  while (!done && Date.now() < end) done = (await reader.read()).done;
  assert.equal(done, true);
  for (const suffix of ['', '/snapshot', '/history', '/diagnostics', '/stream']) {
    const blocked = await f.http(f.main, 'GET', child.base + suffix); assert.equal(blocked.status, 403); assert.equal(blocked.body.error.code, 'task_taken_over');
  }
  assert.equal((await f.main.request('GET', '/v1/sessions')).items.some(row => row.agoraSessionId === child.task.agoraSessionId), false);
  assert.equal((await f.main.request('POST', '/v1/archive/verify', {})).items.some(row => row.agoraSessionId === child.task.agoraSessionId), false);
  assert.equal((await f.http(f.host, 'GET', child.base)).status, 200);
});

test('archiveControl 与真实 recover/steer 共用队列，删除等待旧归档收尾且跨 await 无 SQLite 事务', { timeout: 20000 }, async t => {
  const f = await setup(t), item = await f.spawn(); await f.stop(item);
  let release, entered;
  const enteredPromise = new Promise(resolve => { entered = resolve; });
  const barrier = new Promise(resolve => { release = resolve; });
  const held = f.daemon.tasks.archiveControl(item.task.agoraSessionId, async () => { entered(); await barrier; }); await enteredPromise;
  const cf = (await f.pending(item)).body.confirmation;
  let finished = false;
  const operation = f.confirm(cf).then(value => { finished = true; return value; });
  let recovered = false, steered = false;
  const recover = f.http(f.main, 'POST', `/v1/tasks/${item.task.taskId}/recover`, { mode: 'reopen' }).then(result => { recovered = true; return result; });
  const steer = f.http(f.main, 'POST', `/v1/tasks/${item.task.taskId}/steer`, { message: '不能与删除并发重开' }).then(result => { steered = true; return result; });
  await delay(50); assert.equal(finished, false); assert.equal(recovered, false); assert.equal(steered, false); assert.equal(f.daemon.store.db.isTransaction, false);
  await access(item.handle.spec.sessionFile); release(); await held;
  const result = await operation; assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal((await recover).status, 409); assert.equal((await steer).status, 409);
});

test('历史会话删除与任务当前会话分离，重开后的活动归档保持可读', { timeout: 20000 }, async t => {
  const f = await setup(t), item = await f.spawn();
  await item.handle.stop(); await f.daemon.tasks.flush();
  assert.equal(f.daemon.store.task(item.task.taskId).status, 'interrupted');
  const reopened = await f.main.request('POST', `/v1/tasks/${item.task.taskId}/recover`, { mode: 'reopen' });
  assert.notEqual(reopened.agoraSessionId, item.task.agoraSessionId);
  await until(() => f.driver.handles.find(value => value.spec.agoraSessionId === reopened.agoraSessionId && f.daemon.store.get("SELECT id FROM process_runs WHERE id=? AND state='ready'", value.spec.runId)));
  await f.daemon.tasks.flush();
  const cf = (await f.pending(item)).body.confirmation;
  const deleted = await f.confirm(cf); assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  assert.equal(f.daemon.store.task(item.task.taskId).agora_session_id, reopened.agoraSessionId);
  assert.deepEqual((await f.main.request('GET', item.base + '/snapshot')).entries, []);
  const current = await f.main.request('GET', `/v1/sessions/${reopened.agoraSessionId}/snapshot`); assert.equal(current.entries[0].id, 'secret');
});

test('CLI 在线请求等待签名完成；401/403/业务错误不能降级离线', { timeout: 20000 }, async t => {
  const f = await setup(t), item = await f.spawn(); await f.stop(item);
  const output = [], errors = [];
  const running = runCli(['archive', 'delete', item.task.agoraSessionId, '--wait', '--timeout', '8', '--home', f.home], { out: value => output.push(JSON.parse(value)), error: value => errors.push(value) });
  const cf = await until(async () => (await f.host.request('GET', '/v1/confirmations')).items.find(row => row.challenge.action === 'agora.archive.delete'));
  const confirmed = await f.confirm(cf); assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  assert.equal(await running, 0, errors.join('\n')); assert.equal(output.at(-1).state, 'confirmed');
  let offline = 0;
  const denied = await runCli(['archive', 'delete', 'as_missing', '--home', f.home], { out() {}, error() {} }, { deleteOffline: async () => { offline++; } });
  assert.equal(denied, 1); assert.equal(offline, 0);
  for (const status of [401, 403, 409, 500]) {
    let closed = 0;
    const failed = await runCli(['archive', 'delete', 'as_denied', '--home', f.home], { out() {}, error() {} }, {
      connect: async () => ({ request: async () => { throw new AgoraHttpError(status, 'test_denied'); }, close: () => closed++ }),
      deleteOffline: async () => { offline++; },
    });
    assert.equal(failed, 1); assert.equal(offline, 0); assert.equal(closed, 1);
  }
});
