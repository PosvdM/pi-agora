import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as cryptoSign, createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { acquireInstanceLock } from 'pi-hostkit';
import { Store, openStore, schemaMigrations, SCHEMA_VERSION } from '../packages/daemon/dist/store.js';
import { Security, jcs, paramsHash, signingData, SIGNATURE_ALGORITHM } from '../packages/daemon/dist/security.js';
import { offline } from '../packages/daemon/dist/offline.js';
import { AgoraError } from '../packages/daemon/dist/errors.js';

const host = (type = 'host:pane') => ({ type, principalId: type, connectionId: type, token: '不应进入审计的连接凭证', expiresAt: Date.now() + 3_600_000 });
const external = 'agora.request.answer';
const unavailable = () => { throw new Error('安全自身动作不能调用外部回调'); };
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function signer(deviceId, curve = 'prime256v1') {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: curve });
  const encoded = publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  return { deviceId, publicKey: encoded, body(confirmation) {
    const data = Buffer.from(canonical({ domain: 'pi-pane/user-presence/v1', payload: confirmation.challenge }));
    return { deviceId, publicKey: encoded, alg: SIGNATURE_ALGORITHM, signature: cryptoSign('sha256', data, { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url') };
  } };
}
const homes = [];
after(async () => { for (const home of homes) await rm(home, { recursive: true, force: true }); });
async function directory(t) {
  const home = await mkdtemp(join(tmpdir(), 'agora-security-'));
  homes.push(home);
  return home;
}
async function setup(t) {
  const home = await directory(t), store = await openStore(home), security = new Security(store), conn = host();
  let closed = false;
  const close = () => { if (!closed) { closed = true; store.close(); } };
  t.after(close);
  return { home, store, security, conn, close };
}
function pair(f, device = signer('设备一')) {
  const confirmation = f.security.pairChallenge(f.conn, { deviceId: device.deviceId, publicKey: device.publicKey, label: '浏览器' });
  return { device, result: f.security.sign(f.conn, confirmation.confirmationId, device.body(confirmation), unavailable) };
}
function confirm(f, device, action, target, params = {}) {
  const confirmation = f.security.request(f.conn, action, target, params);
  return f.security.sign(f.conn, confirmation.confirmationId, device.body(confirmation), unavailable);
}
function denied(code) { return error => error.code === code; }

test('JCS 使用 UTF-16 键排序、ECMAScript 数值和严格 JSON 输入', () => {
  assert.equal(jcs({ z: -0, a: [1e30, 4.5, 0.002, 1e-27], '\ue000': 1, '😀': 2 }), '{"a":[1e+30,4.5,0.002,1e-27],"z":0,"😀":2,"":1}');
  assert.equal(paramsHash({ b: 2, a: 1 }), createHash('sha256').update('{"a":1,"b":2}').digest('base64url'));
  const cycle = {}; cycle.self = cycle;
  const accessor = {}; Object.defineProperty(accessor, 'x', { enumerable: true, get() { throw new Error('不能读取访问器'); } });
  const array = [1]; array.extra = 2;
  for (const value of [undefined, NaN, Infinity, 1n, () => {}, new Date(), new Map(), { x: undefined }, { x: Symbol() }, '\ud800', '\udc00', { '\ud800': 1 }, [, 1], array, cycle, accessor, { [Symbol()]: 1 }]) assert.throws(() => jcs(value), denied('invalid_params'));
  assert.equal(jcs(Object.assign(Object.create(null), { a: '中文😀' })), '{"a":"中文😀"}');
  const challenge = { action: 'a', target: 't', paramsHash: 'p', nonce: 'n', expiresAt: 'e' };
  assert.equal(signingData(challenge).toString(), canonical({ domain: 'pi-pane/user-presence/v1', payload: challenge }));
});

test('合法自签只配对，用户操作验签后同事务执行且拒绝重放', async t => {
  const f = await setup(t), { device, result } = pair(f);
  assert.equal(result.state, 'paired');
  assert.equal(f.security.state().everPaired, true);
  assert.equal(f.security.state().reTofuArmed, false);
  const confirmation = f.security.request(f.conn, external, 'rq_1', { answers: ['方案一'] });
  let calls = 0;
  const value = f.security.sign(f.conn, confirmation.confirmationId, device.body(confirmation), (action, target, params, proof) => {
    calls++; assert.equal(f.store.db.isTransaction, true); assert.equal(action, external); assert.equal(target, 'rq_1');
    assert.deepEqual(params, { answers: ['方案一'] });
    assert.deepEqual(proof, { deviceId: device.deviceId, confirmationId: confirmation.confirmationId, requestedBy: 'host:pane', confirmedBy: 'device' });
    f.store.transaction(() => f.store.run("INSERT INTO settings VALUES('执行结果','true')"));
    return { answered: true };
  });
  assert.deepEqual(value, { answered: true }); assert.equal(calls, 1);
  assert.equal(f.security.confirmation(confirmation.confirmationId).state, 'confirmed');
  assert.deepEqual(f.security.confirmation(confirmation.confirmationId).result, { answered: true });
  assert.throws(() => f.security.sign(f.conn, confirmation.confirmationId, device.body(confirmation), () => calls++), denied('already_handled'));
  assert.equal(calls, 1); assert.ok(f.security.audit().some(row => row.reason === 'already_handled'));
  assert.ok(f.security.audit().some(row => row.confirmed_by === 'device' && row.outcome === 'confirmed'));
  assert.equal(JSON.stringify(f.security.audit()).includes('方案一'), false);
  assert.equal(JSON.stringify(f.security.audit()).includes(f.conn.token), false);
});

test('签名篡改、错误公钥、错误算法、非配对设备和伪造 proof 全部拒绝', async t => {
  const f = await setup(t), { device } = pair(f), other = signer('设备二');
  const confirmation = f.security.request(f.conn, external, 'rq_1', { answers: ['答复'] });
  const original = device.body(confirmation), badSignature = Buffer.from(original.signature, 'base64url'); badSignature[0] ^= 1;
  for (const [body, code] of [
    [{ ...original, signature: badSignature.toString('base64url') }, 'invalid_signature'],
    [{ ...original, publicKey: other.publicKey }, 'device_mismatch'],
    [{ ...original, alg: 'ECDSA-P384-SHA384' }, 'invalid_signature'],
    [other.body(confirmation), 'device_mismatch'],
    [{ ...original, signature: Buffer.alloc(63).toString('base64url') }, 'invalid_signature'],
  ]) assert.throws(() => f.security.sign(f.conn, confirmation.confirmationId, body, unavailable), denied(code));
  assert.throws(() => f.security.apply(f.conn, 'agora.device.reset', 'devices', {}, { deviceId: device.deviceId, confirmationId: confirmation.confirmationId, requestedBy: 'user', confirmedBy: 'device' }), denied('invalid_proof'));
  assert.equal(f.security.confirmation(confirmation.confirmationId).state, 'pending');
  assert.equal(f.security.audit().filter(row => row.outcome === 'rejected').length, 5);
  const p384 = signer('错误曲线', 'secp384r1');
  assert.throws(() => f.security.pairChallenge(f.conn, p384), denied('invalid_params'));
});

test('参数、目标、nonce、过期时间与挑战绑定，过期签名持久拒绝并审计', async t => {
  const f = await setup(t), { device } = pair(f);
  const scenarios = [
    ["UPDATE pending_confirmations SET params=? WHERE id=?", canonical({ answers: ['篡改'] }), 'challenge_mismatch'],
    ["UPDATE pending_confirmations SET target=? WHERE id=?", 'rq_2', 'challenge_mismatch'],
    ["UPDATE pending_confirmations SET nonce=? WHERE id=?", '另一随机数', 'challenge_mismatch'],
    ["UPDATE pending_confirmations SET expires_at=? WHERE id=?", '2099-01-01T00:00:00.000Z', 'challenge_mismatch'],
    ["UPDATE pending_confirmations SET expires_at=? WHERE id=?", '2000-01-01T00:00:00.000Z', 'confirmation_expired'],
  ];
  for (const [sql, value, code] of scenarios) {
    const confirmation = f.security.request(f.conn, external, 'rq_1', { answers: ['原答复'] });
    f.store.run(sql, value, confirmation.confirmationId);
    assert.throws(() => f.security.sign(f.conn, confirmation.confirmationId, device.body(confirmation), unavailable), denied(code));
    if (code === 'confirmation_expired') {
      assert.equal(f.security.confirmation(confirmation.confirmationId).state, 'expired');
      assert.throws(() => f.security.sign(f.conn, confirmation.confirmationId, device.body(confirmation), unavailable), error => error.status === 410 && error.code === 'confirmation_expired');
    }
  }
  assert.equal(f.security.audit().filter(row => row.outcome === 'rejected').length, scenarios.length + 1);
});

test('同步执行失败回滚业务写入、nonce、确认和成功审计，拒绝审计独立保存', async t => {
  const f = await setup(t), { device } = pair(f);
  const confirmation = f.security.request(f.conn, external, 'rq_1', { answers: ['不应记入审计的答复'] });
  const before = f.security.audit().length;
  assert.throws(() => f.security.sign(f.conn, confirmation.confirmationId, device.body(confirmation), () => {
    f.store.transaction(() => f.store.run("INSERT INTO settings VALUES('应回滚','true')"));
    throw new Error('不应记入审计的答复');
  }), /不应记入审计/);
  assert.equal(f.store.get("SELECT value FROM settings WHERE key='应回滚'"), undefined);
  assert.equal(f.store.get('SELECT consumed_at FROM pending_confirmations WHERE id=?', confirmation.confirmationId).consumed_at, null);
  assert.equal(f.security.confirmation(confirmation.confirmationId).state, 'pending');
  assert.equal(f.security.audit().length, before + 1);
  assert.equal(f.security.audit().at(-1).reason, 'execution_failed');
  assert.equal(JSON.stringify(f.security.audit()).includes('不应记入审计的答复'), false);
  assert.throws(() => f.security.sign(f.conn, confirmation.confirmationId, device.body(confirmation), async () => {}), denied('invalid_params'));
  assert.throws(() => f.security.sign(f.conn, confirmation.confirmationId, device.body(confirmation), () => Promise.resolve()), denied('invalid_params'));
  assert.equal(f.security.sign(f.conn, confirmation.confirmationId, device.body(confirmation), () => 7), 7);
});

test('SAVEPOINT 支持内层失败后继续、外层失败回滚和异步回调拒绝', async t => {
  const f = await setup(t);
  f.store.transaction(() => {
    f.store.run("INSERT INTO settings VALUES('外层','1')");
    assert.throws(() => f.store.transaction(() => { f.store.run("INSERT INTO settings VALUES('内层','1')"); throw new Error('内层失败'); }), /内层失败/);
    f.store.transaction(() => f.store.run("INSERT INTO settings VALUES('内层成功','1')"));
  });
  assert.equal(f.store.get("SELECT value FROM settings WHERE key='内层'"), undefined);
  assert.ok(f.store.get("SELECT value FROM settings WHERE key='内层成功'"));
  assert.throws(() => f.store.transaction(() => { f.store.transaction(() => f.store.run("INSERT INTO settings VALUES('随外层回滚','1')")); throw new Error('外层失败'); }), /外层失败/);
  assert.equal(f.store.get("SELECT value FROM settings WHERE key='随外层回滚'"), undefined);
  let entered = false;
  assert.throws(() => f.store.transaction(async () => { entered = true; }), /异步/); assert.equal(entered, false);
  assert.throws(() => f.store.transaction(() => Promise.resolve()), /异步/);
  assert.equal(f.store.db.isTransaction, false);
});

test('并发 TOFU 只有一台接受，自签待批准设备不能执行或批准用户动作', async t => {
  const f = await setup(t), first = signer('设备一'), second = signer('设备二');
  const a = f.security.pairChallenge(f.conn, first), b = f.security.pairChallenge(f.conn, second);
  const secondStore = await openStore(f.home), secondSecurity = new Security(secondStore);
  t.after(() => secondStore.close());
  const results = await Promise.all([
    Promise.resolve().then(() => f.security.sign(f.conn, a.confirmationId, first.body(a), unavailable)),
    Promise.resolve().then(() => secondSecurity.sign(f.conn, b.confirmationId, second.body(b), unavailable)),
  ]);
  assert.deepEqual(results.map(result => result.state).sort(), ['paired', 'pending']);
  const accepted = results[0].state === 'paired' ? first : second, pending = accepted === first ? second : first;
  const confirmation = f.security.request(f.conn, 'agora.device.approve', pending.deviceId, {});
  assert.throws(() => f.security.sign(f.conn, confirmation.confirmationId, pending.body(confirmation), unavailable), denied('device_mismatch'));
  assert.equal(f.security.sign(f.conn, confirmation.confirmationId, accepted.body(confirmation), unavailable).state, 'paired');
  assert.equal(f.security.devices().filter(device => device.state === 'paired').length, 2);
});

test('在线重置保留签名设备，撤销最后设备不恢复 TOFU，off 不能绕过强制签名', async t => {
  const f = await setup(t), { device } = pair(f), second = signer('设备二');
  pair(f, second); confirm(f, device, 'agora.device.approve', second.deviceId);
  confirm(f, second, 'agora.device.reset', 'devices');
  assert.deepEqual(f.security.devices().map(device => device.deviceId), [second.deviceId]);
  assert.equal(f.security.state().alerts.length, 0);
  confirm(f, second, 'agora.settings.set', 'userConfirmation', { value: 'off' });
  assert.throws(() => f.security.apply(f.conn, 'agora.device.reset', 'devices', {}), denied('confirmation_required'));
  assert.throws(() => f.security.apply(f.conn, 'agora.settings.set', 'userConfirmation', { value: 'off' }), denied('confirmation_required'));
  const alert = f.security.state().alerts.find(alert => alert.kind === 'protection-off');
  assert.throws(() => confirm(f, second, 'agora.security.acknowledge', alert.alertId, { revision: alert.revision }), denied('forbidden'));
  f.security.apply(f.conn, 'agora.settings.set', 'userConfirmation', { value: 'device' });
  assert.equal(f.security.state().alerts.some(alert => alert.kind === 'protection-off'), false);
  const lastRevoke = f.security.request(f.conn, 'agora.device.revoke', second.deviceId, {});
  assert.match(lastRevoke.title, /最后一台设备/);
  f.security.sign(f.conn, lastRevoke.confirmationId, second.body(lastRevoke), unavailable);
  assert.equal(f.security.state().everPaired, true); assert.equal(f.security.state().reTofuArmed, false);
  assert.equal(pair(f, signer('设备三')).result.state, 'pending');
  assert.equal(f.security.state().alerts.length, 0);
});

test('预算配置按实际字段校验，调高须签名，调低无需签名，计数口径受保护', async t => {
  const f = await setup(t), { device } = pair(f);
  assert.ok(f.security.state().config.agentLimitCap.dailyTokens > 0);
  const cap = { perTaskFactor: 2, perMeetingFactor: 2, dailyTokens: 100 };
  confirm(f, device, 'agora.settings.set', 'agentLimitCap', { value: cap });
  f.security.apply(f.conn, 'agora.settings.set', 'agentLimitCap', { value: { ...cap, dailyTokens: 50 } });
  assert.throws(() => f.security.apply(f.conn, 'agora.settings.set', 'agentLimitCap', { value: { ...cap, dailyTokens: 51 } }), denied('confirmation_required'));
  const meeting = { maxTokens: 10, maxModelCalls: 3, maxDurationMinutes: 5, maxCycles: 1, diagnosticReserveTokens: 0 };
  confirm(f, device, 'agora.settings.set', 'meetingLimitDefaults', { value: meeting });
  f.security.apply(f.conn, 'agora.settings.set', 'meetingLimitDefaults', { value: { ...meeting, maxTokens: 5 } });
  assert.throws(() => f.security.apply(f.conn, 'agora.settings.set', 'meetingLimitDefaults', { value: { ...meeting, maxTokens: 6 } }), denied('confirmation_required'));
  for (const value of [{ maxTokens: 5 }, 5, { ...meeting, extra: 1 }]) assert.throws(() => f.security.request(f.conn, 'agora.settings.set', 'meetingLimitDefaults', { value }), denied('invalid_params'));
  assert.throws(() => f.security.apply(f.conn, 'agora.settings.set', 'tokenAccounting', { value: 'uncached' }), denied('confirmation_required'));
  confirm(f, device, 'agora.settings.set', 'tokenAccounting', { value: 'uncached' });
  assert.equal(f.security.state().config.tokenAccounting, 'uncached');
  for (const value of [0, -1, 1.5, { maxTokens: 0 }, { nested: {} }]) assert.throws(() => f.security.request(f.conn, 'agora.settings.set', 'agentLimitCap', { value }), denied('invalid_params'));
  assert.throws(() => f.security.apply(f.conn, 'not.an.action', 'x', {}), denied('invalid_action'));
  assert.throws(() => f.security.apply(f.conn, 'agora.settings.set', 'everPaired', { value: false }), denied('invalid_params'));
});

test('host/main 发起、TTL、取消所有权和 child 身份限制', async t => {
  const f = await setup(t), child = { ...host(), type: 'agent:child' };
  assert.throws(() => f.security.request(child, external, 'rq_1', {}), denied('forbidden'));
  const before = Date.now(), cli = f.security.request(host('host:cli'), external, 'rq_cli', {}), pane = f.security.request(f.conn, external, 'rq_pane', {});
  assert.ok(Math.abs(Date.parse(cli.expiresAt) - before - 86_400_000) < 2000);
  assert.ok(Math.abs(Date.parse(pane.expiresAt) - before - 300_000) < 2000);
  assert.throws(() => f.security.cancel(child, pane.confirmationId), denied('forbidden'));
  assert.equal(f.security.cancel(host('host:cli'), pane.confirmationId).cancelled, true);
  assert.throws(() => f.security.cancel(f.conn, pane.confirmationId), denied('already_handled'));
  assert.equal(f.security.confirmation(pane.confirmationId).state, 'cancelled');
  const main = { ...host(), type: 'agent:main', principalId: 'main', connectionId: 'main-connection' };
  assert.throws(() => f.security.request(main, external, 'rq_1', {}), denied('lease_required'));
  f.store.run("INSERT INTO principals(id,type,lease_connection_id,lease_expires_at,created_at) VALUES('main','agent:main','main-connection',?,?)", Date.now() + 60000, new Date().toISOString());
  const confirmation = f.security.request(main, external, 'rq_1', {});
  assert.equal(confirmation.requestedBy, 'main'); assert.ok(f.security.listConfirmations().length >= 3);
  assert.equal(f.security.listConfirmations(50, 0, 'main').length, 1);
  assert.throws(() => f.security.cancel(main, cli.confirmationId), denied('forbidden'));
  assert.throws(() => f.security.request(f.conn, 'agora.settings.set', 'userConfirmation', { value: 'off', confirmedBy: 'user' }), denied('invalid_params'));
});

test('离线命令与 daemon 共用锁；失败释放锁且保留 discovery 和凭证', async t => {
  const f = await setup(t); f.close();
  const run = join(f.home, 'run'); await mkdir(run, { recursive: true });
  const discovery = join(run, 'daemon.json'), credential = join(f.home, 'secret', 'host.key');
  await mkdir(join(f.home, 'secret'), { recursive: true });
  await writeFile(discovery, '保留发现记录'); await writeFile(credential, '保留凭证');
  const lock = await acquireInstanceLock('daemon', run); assert.ok(lock);
  try { await assert.rejects(offline(f.home, ['pair-reset']), denied('daemon_running')); }
  finally { await lock.release(); }
  await assert.rejects(offline(f.home, ['不支持的命令']), denied('invalid_params'));
  const next = await acquireInstanceLock('daemon', run); assert.ok(next); await next.release();
  await offline(f.home, ['set', 'userConfirmation', 'off']);
  assert.equal(await readFile(discovery, 'utf8'), '保留发现记录'); assert.equal(await readFile(credential, 'utf8'), '保留凭证');
  const store = await openStore(f.home);
  try { const security = new Security(store); assert.equal(security.state().userConfirmation, 'off'); assert.ok(security.state().alerts.some(alert => alert.kind === 'protection-off')); }
  finally { store.close(); }
  const badHome = await directory(t), bad = new DatabaseSync(join(badHome, 'agora.db'));
  bad.exec('CREATE TABLE schema_version(version INTEGER,migrated_at TEXT); INSERT INTO schema_version VALUES(999,\'future\')'); bad.close();
  await assert.rejects(offline(badHome, ['pair-reset']), /数据库版本不兼容/);
  const afterFailure = await acquireInstanceLock('daemon', join(badHome, 'run')); assert.ok(afterFailure); await afterFailure.release();
});

test('离线重置持久告警且只消费一次 reTOFU，旧 revision 签名不能清除新警告', async t => {
  const f = await setup(t); pair(f); f.close();
  await offline(f.home, ['pair-reset']);
  let store = await openStore(f.home), security = new Security(store);
  let fixture = { store, security, conn: f.conn };
  const one = security.state().alerts.find(alert => alert.kind === 'devices-reset');
  assert.equal(security.state().everPaired, true); assert.equal(security.state().reTofuArmed, true);
  const { device } = pair(fixture, signer('恢复设备'));
  assert.equal(security.state().reTofuArmed, false); assert.equal(pair(fixture, signer('竞争设备')).result.state, 'pending');
  const ack = security.request(f.conn, 'agora.security.acknowledge', one.alertId, { revision: one.revision });
  store.close();
  await offline(f.home, ['pair-reset']);
  store = await openStore(f.home); security = new Security(store); fixture = { store, security, conn: f.conn };
  t.after(() => store.close());
  const two = security.state().alerts.find(alert => alert.kind === 'devices-reset');
  assert.equal(two.alertId, one.alertId); assert.ok(two.revision > one.revision);
  pair(fixture, device);
  assert.throws(() => security.sign(f.conn, ack.confirmationId, device.body(ack), unavailable), denied('conflict'));
  assert.equal(security.state().alerts.find(alert => alert.kind === 'devices-reset').revision, two.revision);
  confirm(fixture, device, 'agora.security.acknowledge', two.alertId, { revision: two.revision });
  assert.equal(security.state().alerts.length, 0);
  assert.ok(security.audit().some(row => row.via === 'offline'));
});

test('启动和在线指纹检查发现手工修改，重复启动不增加 revision，再次修改增加', async t => {
  const f = await setup(t), { device } = pair(f);
  f.store.run('UPDATE devices SET label=? WHERE id=?', '离线修改一', device.deviceId);
  const restarted = new Security(f.store), first = restarted.state().alerts[0];
  assert.equal(first.kind, 'devices-reset');
  assert.equal(new Security(f.store).state().alerts[0].revision, first.revision);
  const ack = restarted.request(f.conn, 'agora.security.acknowledge', first.alertId, { revision: first.revision });
  f.store.run('UPDATE devices SET label=? WHERE id=?', '离线修改二', device.deviceId);
  assert.throws(() => restarted.sign(f.conn, ack.confirmationId, device.body(ack), unavailable), denied('conflict'));
  const second = restarted.state().alerts[0]; assert.equal(second.revision, first.revision + 1);
  f.store.run('DELETE FROM devices');
  assert.equal(new Security(f.store).state().alerts[0].revision, second.revision + 1);
  assert.equal(restarted.state().reTofuArmed, false);
});

test('signAsync 消费后在事务外执行，完成保存结果，并发和失败均不可重试', async t => {
  const f = await setup(t), { device } = pair(f);
  const confirmation = f.security.request(f.conn, 'agora.task.spawn', 'new-task', { prompt: '执行异步工作' });
  let release;
  const gate = new Promise(resolve => { release = resolve; }); let calls = 0;
  const pending = f.security.signAsync(f.conn, confirmation.confirmationId, device.body(confirmation), async (action, target, params, proof) => {
    calls++; assert.equal(f.store.db.isTransaction, false); assert.equal(action, 'agora.task.spawn'); assert.equal(target, 'new-task');
    assert.deepEqual(params, { prompt: '执行异步工作' }); assert.equal(proof.confirmedBy, 'device'); await gate; return { taskId: 'task-new', optional: undefined };
  });
  assert.equal(f.security.confirmation(confirmation.confirmationId).state, 'executing');
  await assert.rejects(f.security.signAsync(f.conn, confirmation.confirmationId, device.body(confirmation), () => calls++), denied('already_handled'));
  release(); assert.deepEqual(await pending, { taskId: 'task-new', optional: undefined }); assert.equal(calls, 1);
  assert.equal(f.security.confirmation(confirmation.confirmationId).state, 'confirmed');
  assert.deepEqual(f.security.confirmation(confirmation.confirmationId).result, { taskId: 'task-new' });
  const failed = f.security.request(f.conn, 'agora.task.recover', 'task_1', { mode: 'resume' });
  await assert.rejects(f.security.signAsync(f.conn, failed.confirmationId, device.body(failed), async () => { throw new Error('秘密进程错误'); }), /秘密进程错误/);
  assert.equal(f.security.confirmation(failed.confirmationId).state, 'failed');
  assert.equal(f.security.confirmation(failed.confirmationId).failureReason, 'execution_failed');
  assert.ok(f.store.get('SELECT consumed_at FROM pending_confirmations WHERE id=?', failed.confirmationId).consumed_at);
  await assert.rejects(f.security.signAsync(f.conn, failed.confirmationId, device.body(failed), unavailable), denied('already_handled'));
  assert.equal(JSON.stringify(f.security.audit()).includes('秘密进程错误'), false);
  const internal = f.security.request(f.conn, 'agora.device.reset', 'devices', {});
  await assert.rejects(f.security.signAsync(f.conn, internal.confirmationId, device.body(internal), unavailable), denied('invalid_action'));
  assert.equal(f.security.confirmation(internal.confirmationId).state, 'pending');
});

test('signAsync 与 sign 共用验签，异步执行前拒绝篡改和非配对设备', async t => {
  const f = await setup(t), { device } = pair(f), unknown = signer('非配对');
  const confirmation = f.security.request(f.conn, 'agora.task.spawn', 'new-task', { prompt: '原参数' });
  await assert.rejects(f.security.signAsync(f.conn, confirmation.confirmationId, unknown.body(confirmation), unavailable), denied('device_mismatch'));
  f.store.run('UPDATE pending_confirmations SET params=? WHERE id=?', canonical({ prompt: '篡改参数' }), confirmation.confirmationId);
  await assert.rejects(f.security.signAsync(f.conn, confirmation.confirmationId, device.body(confirmation), unavailable), denied('challenge_mismatch'));
  assert.equal(f.security.confirmation(confirmation.confirmationId).state, 'pending');
});

test('重启将 executing 持久标记为 operation_interrupted，不重放 nonce 或覆盖失败', async t => {
  const f = await setup(t), { device } = pair(f);
  const confirmation = f.security.request(f.conn, 'agora.task.recover', 'task_1', { mode: 'resume' });
  let finish; const gate = new Promise(resolve => { finish = resolve; });
  const operation = f.security.signAsync(f.conn, confirmation.confirmationId, device.body(confirmation), async () => { await gate; return { resumed: true }; });
  const second = await openStore(f.home), restarted = new Security(second); t.after(() => second.close());
  assert.equal(restarted.confirmation(confirmation.confirmationId).state, 'failed');
  assert.equal(restarted.confirmation(confirmation.confirmationId).failureReason, 'operation_interrupted');
  await assert.rejects(restarted.signAsync(f.conn, confirmation.confirmationId, device.body(confirmation), unavailable), denied('already_handled'));
  finish(); await assert.rejects(operation, denied('already_handled'));
  assert.equal(restarted.confirmation(confirmation.confirmationId).state, 'failed');
  assert.ok(restarted.audit().some(row => row.reason === 'operation_interrupted' && row.outcome === 'failed'));
});

test('HTTP 白名单的七个外部动作只交给 execute，设置动作使用统一名称', async t => {
  const f = await setup(t), { device } = pair(f);
  for (const action of ['agora.request.answer', 'agora.request.cancel', 'agora.task.spawn', 'agora.task.limits', 'agora.task.recover', 'agora.task.takeover', 'agora.principal.takeover']) {
    const confirmation = f.security.request(f.conn, action, 'target', { operation: action });
    assert.ok(Object.hasOwn(confirmation, 'confirmationId')); assert.ok(Object.hasOwn(confirmation, 'challenge'));
    assert.ok(Object.hasOwn(confirmation, 'state')); assert.ok(Object.hasOwn(confirmation, 'result'));
    let executed = false;
    const result = f.security.sign(f.conn, confirmation.confirmationId, { ...device.body(confirmation), params: { operation: '未签名替换参数' } }, (received, target, params) => {
      executed = true; assert.equal(received, action); assert.equal(target, 'target'); assert.deepEqual(params, { operation: action }); return received;
    });
    assert.equal(executed, true); assert.equal(result, action);
  }
  for (const action of ['agora.config.set', 'agora.board.post', 'agora.budget.grant']) assert.throws(() => f.security.request(f.conn, action, 'target', {}), denied('invalid_action'));
  const cap = { perTaskFactor: 2, dailyTokens: 123 };
  confirm(f, device, 'agora.settings.set', 'agentLimitCap', { value: cap });
  assert.deepEqual(f.security.state().config.agentLimitCap, cap);
});

test('安全自身动作的审计失败回滚设备和 TOFU 状态，nonce 可重新提交', async t => {
  const f = await setup(t), device = signer('原子配对');
  const confirmation = f.security.pairChallenge(f.conn, device);
  f.store.db.exec("CREATE TRIGGER reject_confirmed BEFORE INSERT ON security_audit WHEN new.outcome='confirmed' BEGIN SELECT RAISE(ABORT,'审计写入失败'); END");
  assert.throws(() => f.security.sign(f.conn, confirmation.confirmationId, device.body(confirmation), unavailable), /审计写入失败/);
  assert.equal(f.security.state().everPaired, false); assert.equal(f.security.devices().length, 0);
  assert.equal(f.security.confirmation(confirmation.confirmationId).state, 'pending');
  assert.equal(f.store.get('SELECT consumed_at FROM pending_confirmations WHERE id=?', confirmation.confirmationId).consumed_at, null);
  assert.equal(f.security.audit().at(-1).outcome, 'rejected');
  f.store.db.exec('DROP TRIGGER reject_confirmed');
  assert.equal(f.security.sign(f.conn, confirmation.confirmationId, device.body(confirmation), unavailable).state, 'paired');
});

test('异步签名不能嵌套事务，回调错误码也不能把秘密写入审计', async t => {
  const f = await setup(t), { device } = pair(f);
  const confirmation = f.security.request(f.conn, 'agora.task.spawn', 'new-task', { prompt: '测试' });
  let attempted;
  f.store.transaction(() => { attempted = f.security.signAsync(f.conn, confirmation.confirmationId, device.body(confirmation), unavailable); });
  await assert.rejects(attempted, denied('transaction_active'));
  assert.equal(f.security.confirmation(confirmation.confirmationId).state, 'pending');
  await assert.rejects(f.security.signAsync(f.conn, confirmation.confirmationId, device.body(confirmation), async () => { throw new AgoraError(500, '不应写入审计的完整答复', '不应写入审计的私钥'); }), denied('不应写入审计的完整答复'));
  assert.equal(f.security.confirmation(confirmation.confirmationId).failureReason, 'execution_failed');
  assert.equal(JSON.stringify(f.security.audit()).includes('不应写入审计'), false);
});

test('恢复旧设备指纹也刷新未知悉警告，旧签名不能确认新的状态变化', async t => {
  const f = await setup(t), { device } = pair(f);
  f.store.run('UPDATE devices SET label=? WHERE id=?', '手动修改', device.deviceId);
  const first = f.security.state().alerts[0];
  const ack = f.security.request(f.conn, 'agora.security.acknowledge', first.alertId, { revision: first.revision });
  f.store.run('UPDATE devices SET label=? WHERE id=?', '浏览器', device.deviceId);
  assert.throws(() => f.security.sign(f.conn, ack.confirmationId, device.body(ack), unavailable), denied('conflict'));
  assert.equal(f.security.state().alerts[0].revision, first.revision + 1);
});

test('v4→v5 先一致性备份 WAL，保留原数据并预留预算、答复证明列', async t => {
  const home = await directory(t), original = new DatabaseSync(join(home, 'agora.db'));
  for (const migration of schemaMigrations.slice(0, 4)) original.exec(migration);
  original.exec("CREATE TABLE schema_version(version INTEGER,migrated_at TEXT); INSERT INTO schema_version VALUES(4,'v4'); PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; INSERT INTO principals(id,type,created_at) VALUES('main','agent:main','time');");
  const migrated = await openStore(home);
  try {
    assert.equal(SCHEMA_VERSION, 5); assert.equal(migrated.get('SELECT version FROM schema_version').version, 5);
    assert.equal(migrated.principal('main').type, 'agent:main'); assert.deepEqual(migrated.all('PRAGMA foreign_key_check'), []);
    assert.equal(migrated.all('PRAGMA table_info(tasks)').find(column => column.name === 'max_tokens').dflt_value, '50000000');
    assert.equal(migrated.all('PRAGMA table_info(requests)').find(column => column.name === 'answer_proof').notnull, 0);
    assert.deepEqual(migrated.all('PRAGMA table_info(budget_grants)').map(column => column.name), ['id', 'resource_id', 'principal_id', 'day', 'tokens', 'confirmed_by', 'created_at']);
  } finally { migrated.close(); original.close(); }
  const files = (await readdir(join(home, 'backups'))).filter(file => file.endsWith('.db')); assert.equal(files.length, 1);
  const backup = new DatabaseSync(join(home, 'backups', files[0]), { readOnly: true });
  try {
    assert.equal(backup.prepare('SELECT version FROM schema_version').get().version, 4);
    assert.equal(backup.prepare('SELECT type FROM principals WHERE id=?').get('main').type, 'agent:main');
    assert.equal(backup.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(backup.prepare('PRAGMA table_info(tasks)').all().some(column => column.name === 'max_tokens'), false);
  } finally { backup.close(); }
});

test('v5 DDL 冲突回滚所有列、表和版本，备份与旧数据保持一致', async t => {
  const home = await directory(t), db = new DatabaseSync(join(home, 'agora.db'));
  for (const migration of schemaMigrations.slice(0, 4)) db.exec(migration);
  db.exec("CREATE TABLE schema_version(version INTEGER,migrated_at TEXT); INSERT INTO schema_version VALUES(4,'v4'); CREATE TABLE security_alerts(sentinel TEXT); INSERT INTO security_alerts VALUES('原数据');"); db.close();
  await assert.rejects(openStore(home), /already exists/);
  const original = new DatabaseSync(join(home, 'agora.db'));
  try {
    assert.equal(original.prepare('SELECT version FROM schema_version').get().version, 4);
    assert.equal(original.prepare('SELECT sentinel FROM security_alerts').get().sentinel, '原数据');
    assert.equal(original.prepare('PRAGMA table_info(tasks)').all().some(column => column.name === 'max_tokens'), false);
    assert.equal(original.prepare('PRAGMA table_info(requests)').all().some(column => column.name === 'answer_proof'), false);
    for (const table of ['budget_grants', 'devices', 'pending_confirmations']) assert.equal(original.prepare("SELECT name FROM sqlite_master WHERE name=?").get(table), undefined);
  } finally { original.close(); }
  const files = (await readdir(join(home, 'backups'))).filter(file => file.endsWith('.db')); assert.equal(files.length, 1);
  const backup = new DatabaseSync(join(home, 'backups', files[0]), { readOnly: true });
  try { assert.equal(backup.prepare('SELECT sentinel FROM security_alerts').get().sentinel, '原数据'); assert.equal(backup.prepare('PRAGMA integrity_check').get().integrity_check, 'ok'); }
  finally { backup.close(); }
});
