import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireInstanceLock } from 'pi-hostkit';
import { startDaemon } from '../packages/daemon/dist/index.js';
import { openStore } from '../packages/daemon/dist/store.js';
import { Security, signingData, SIGNATURE_ALGORITHM } from '../packages/daemon/dist/security.js';
import { Budgets, budgetConfig, countTokens } from '../packages/daemon/dist/budgets.js';

const factory = { taskLimitDefaults: { maxTokens: 50_000_000 }, agentLimitCap: { perTaskFactor: 2, dailyTokens: 2_500_000_000 } };
const driver = { async start() { throw new Error('预算配置测试不启动模型'); }, async recoverOldRun() { throw new Error('不应恢复进程'); } };
const host = () => ({ type: 'host:pane', principalId: 'host:pane', connectionId: 'host:pane', expiresAt: Date.now() + 3_600_000 });
const unavailable = () => { throw new Error('安全动作不能调用外部回调'); };
const denied = code => error => error.code === code;
const homes = [];
after(async () => { for (const home of homes) await rm(home, { recursive: true, force: true }); });
async function directory(t) {
  const home = await mkdtemp(join(tmpdir(), 'agora-budget-config-'));
  homes.push(home);
  return home;
}
async function setup(t) {
  const home = await directory(t);
  let store, security;
  const reopen = async () => { store = await openStore(home); security = new Security(store); };
  await reopen();
  t.after(() => store.close());
  return { home, get store() { return store; }, get security() { return security; }, async restart() { store.close(); await reopen(); } };
}
function setting(f, key) { const row = f.store.get('SELECT value FROM settings WHERE key=?', key); return row ? JSON.parse(row.value) : undefined; }
function warnings(f) { return f.security.state().alerts.filter(alert => alert.kind === 'budget-config-changed'); }
function imports(f) { return f.security.audit(1000).filter(row => row.via === 'offline' && row.action === 'agora.settings.set'); }
function signer() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const deviceId = '预算测试设备', encoded = publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  return { deviceId, publicKey: encoded, body(confirmation) {
    return { deviceId, publicKey: encoded, alg: SIGNATURE_ALGORITHM, signature: sign('sha256', signingData(confirmation.challenge), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url') };
  } };
}
function pair(f) {
  const device = signer(), confirmation = f.security.pairChallenge(host(), device);
  f.security.sign(host(), confirmation.confirmationId, device.body(confirmation), unavailable);
  return device;
}
function signedSet(f, device, target, value) {
  const confirmation = f.security.request(host(), 'agora.settings.set', target, { value });
  f.security.sign(host(), confirmation.confirmationId, device.body(confirmation), unavailable);
}
function protectedState(f) {
  return Object.fromEntries(['everPaired', 'reTofuArmed', 'devicesFingerprint', 'devicesObservedFingerprint'].map(key => [key, setting(f, key)]));
}

test('出厂任务预算、v5 列默认与含缓存计数一致，reasoning 不重复累加', async t => {
  const f = await setup(t), config = budgetConfig(f.store);
  assert.deepEqual(config, { defaults: factory.taskLimitDefaults, cap: factory.agentLimitCap, accounting: 'all' });
  assert.equal(f.store.all('PRAGMA table_info(tasks)').find(column => column.name === 'max_tokens').dflt_value, '50000000');
  const usage = { requests: 1, inputTokens: 11, cacheReadTokens: 23, cacheWriteTokens: 31, outputTokens: 47, reasoningTokens: 19, contextTokens: 100 };
  assert.equal(countTokens(usage, config.accounting), 112);
  assert.equal(countTokens(usage, 'uncached'), 89);
  const budgets = new Budgets(f.store, {}), main = { type: 'agent:main', principalId: 'main' };
  assert.doesNotThrow(() => budgets.checkGrant(main, 'task', 100_000_000, 100_000_000, {}, 'spawn'));
  assert.throws(() => budgets.checkGrant(main, 'task', 100_000_001, 1, {}, 'spawn'), denied('confirmation_required'));
  f.store.run('INSERT INTO budget_grants VALUES(?,?,?,?,?,?,?)', 'grant', 'task', 'main', new Date().getFullYear() + '-' + String(new Date().getMonth() + 1).padStart(2, '0') + '-' + String(new Date().getDate()).padStart(2, '0'), 2_500_000_000, 'none', new Date().toISOString());
  assert.throws(() => budgets.checkGrant(main, 'task', 1, 1, {}, 'spawn'), denied('confirmation_required'));
});

test('首次导入文件任务字段，保留会议字段、设备状态，并按真实变化审计', async t => {
  const f = await setup(t), device = pair(f);
  signedSet(f, device, 'agentLimitCap', { ...factory.agentLimitCap, perMeetingFactor: 7 });
  const before = protectedState(f);
  f.security.importBudgetConfig({ taskLimitDefaults: { maxTokens: 40_000_000 }, agentLimitCap: { perTaskFactor: 1, dailyTokens: 2_000_000_000 } });
  assert.deepEqual(setting(f, 'agentLimitCap'), { perTaskFactor: 1, dailyTokens: 2_000_000_000, perMeetingFactor: 7 });
  assert.equal(budgetConfig(f.store).defaults.maxTokens, 40_000_000);
  assert.deepEqual(protectedState(f), before);
  assert.equal(imports(f).length, 3);
  assert.equal(warnings(f).length, 0);
  assert.deepEqual(setting(f, 'budgetFileSource'), { 'taskLimitDefaults.maxTokens': 40_000_000, 'agentLimitCap.perTaskFactor': 1, 'agentLimitCap.dailyTokens': 2_000_000_000 });
});

test('首次没有明确文件字段时保留数据库中的在线签名配置并记录默认来源', async t => {
  const f = await setup(t), device = pair(f);
  signedSet(f, device, 'taskLimitDefaults', { maxTokens: 70_000_000 });
  signedSet(f, device, 'agentLimitCap', { perTaskFactor: 4, dailyTokens: 3_000_000_000, perMeetingFactor: 5 });
  f.security.importBudgetConfig({});
  assert.equal(budgetConfig(f.store).defaults.maxTokens, 70_000_000);
  assert.equal(budgetConfig(f.store).cap.perTaskFactor, 4);
  assert.deepEqual(setting(f, 'budgetFileSource'), { 'taskLimitDefaults.maxTokens': null, 'agentLimitCap.perTaskFactor': null, 'agentLimitCap.dailyTokens': null });
  await f.restart(); f.security.importBudgetConfig({});
  assert.equal(budgetConfig(f.store).cap.dailyTokens, 3_000_000_000);
  assert.equal(imports(f).length, 0); assert.equal(warnings(f).length, 0);
});

test('重复导入与重启保留在线签名值，逐字段修改和删除只影响对应字段', async t => {
  const f = await setup(t), device = pair(f);
  f.security.importBudgetConfig(factory);
  assert.equal(warnings(f).length, 0); assert.equal(imports(f).length, 0);
  signedSet(f, device, 'taskLimitDefaults', { maxTokens: 80_000_000 });
  signedSet(f, device, 'agentLimitCap', { perTaskFactor: 4, dailyTokens: 3_000_000_000, perMeetingFactor: 9 });
  await f.restart(); f.security.importBudgetConfig(factory);
  assert.equal(budgetConfig(f.store).defaults.maxTokens, 80_000_000);
  f.security.importBudgetConfig({ taskLimitDefaults: factory.taskLimitDefaults, agentLimitCap: { perTaskFactor: 3, dailyTokens: factory.agentLimitCap.dailyTokens } });
  assert.deepEqual(setting(f, 'agentLimitCap'), { perTaskFactor: 3, dailyTokens: 3_000_000_000, perMeetingFactor: 9 });
  assert.equal(budgetConfig(f.store).defaults.maxTokens, 80_000_000);
  f.security.importBudgetConfig({ taskLimitDefaults: factory.taskLimitDefaults, agentLimitCap: { perTaskFactor: 3 } });
  assert.equal(budgetConfig(f.store).cap.dailyTokens, factory.agentLimitCap.dailyTokens);
  f.security.importBudgetConfig({ agentLimitCap: { perTaskFactor: 3 } });
  assert.equal(budgetConfig(f.store).defaults.maxTokens, factory.taskLimitDefaults.maxTokens);
  f.security.importBudgetConfig({});
  assert.deepEqual(setting(f, 'agentLimitCap'), { ...factory.agentLimitCap, perMeetingFactor: 9 });
  assert.equal(imports(f).length, 4); assert.equal(warnings(f).length, 0);
});

test('删除文件字段回默认导致放宽时产生持久警告，重启和文件回滚不清除', async t => {
  const f = await setup(t), file = { taskLimitDefaults: { maxTokens: 20_000_000 }, agentLimitCap: { perTaskFactor: 1, dailyTokens: 1_000_000_000 } };
  f.security.importBudgetConfig(file); assert.equal(warnings(f).length, 0);
  f.security.importBudgetConfig({});
  const warning = warnings(f)[0]; assert.equal(warning.revision, 1);
  assert.deepEqual(warning.details.changes, [
    { field: 'taskLimitDefaults.maxTokens', from: 20_000_000, to: 50_000_000 },
    { field: 'agentLimitCap.perTaskFactor', from: 1, to: 2 },
    { field: 'agentLimitCap.dailyTokens', from: 1_000_000_000, to: 2_500_000_000 },
  ]);
  assert.equal(JSON.stringify(warning).includes(f.home), false);
  await f.restart(); f.security.importBudgetConfig({});
  assert.deepEqual(warnings(f), [warning]);
  f.security.importBudgetConfig(file);
  assert.deepEqual(warnings(f), [warning]);
  f.security.importBudgetConfig({});
  assert.equal(warnings(f)[0].revision, 2);
});

test('根默认、factor、日封顶分别放宽均产生告警；比较当前在线值而非上次文件值', async t => {
  for (const [group, field, value] of [['taskLimitDefaults', 'maxTokens', 60_000_000], ['agentLimitCap', 'perTaskFactor', 3], ['agentLimitCap', 'dailyTokens', 3_000_000_000]]) {
    const f = await setup(t); f.security.importBudgetConfig({});
    f.security.importBudgetConfig({ [group]: { [field]: value } });
    assert.deepEqual(warnings(f)[0].details.changes, [{ field: `${group}.${field}`, from: factory[group][field], to: value }]);
  }
  const f = await setup(t), device = pair(f);
  f.security.importBudgetConfig({ taskLimitDefaults: { maxTokens: 40_000_000 } });
  signedSet(f, device, 'taskLimitDefaults', { maxTokens: 20_000_000 });
  f.security.importBudgetConfig({ taskLimitDefaults: { maxTokens: 30_000_000 } });
  assert.deepEqual(warnings(f)[0].details.changes, [{ field: 'taskLimitDefaults.maxTokens', from: 20_000_000, to: 30_000_000 }]);
});

test('预算告警知悉强制签名，off 无法旁路，旧 revision 拒绝且 protection-off 不能知悉', async t => {
  const f = await setup(t), device = pair(f), before = protectedState(f);
  f.security.importBudgetConfig({ taskLimitDefaults: { maxTokens: 60_000_000 } });
  const first = warnings(f)[0];
  const old = f.security.request(host(), 'agora.security.acknowledge', first.alertId, { revision: first.revision });
  f.security.importBudgetConfig({ taskLimitDefaults: { maxTokens: 70_000_000 } });
  assert.throws(() => f.security.sign(host(), old.confirmationId, device.body(old), unavailable), denied('conflict'));
  signedSet(f, device, 'userConfirmation', 'off');
  const current = warnings(f)[0];
  assert.throws(() => f.security.apply(host(), 'agora.security.acknowledge', current.alertId, { revision: current.revision }), denied('confirmation_required'));
  const protection = f.security.state().alerts.find(alert => alert.kind === 'protection-off');
  const blocked = f.security.request(host(), 'agora.security.acknowledge', protection.alertId, { revision: protection.revision });
  assert.throws(() => f.security.sign(host(), blocked.confirmationId, device.body(blocked), unavailable), denied('forbidden'));
  const ack = f.security.request(host(), 'agora.security.acknowledge', current.alertId, { revision: current.revision });
  f.security.sign(host(), ack.confirmationId, device.body(ack), unavailable);
  assert.equal(warnings(f).length, 0);
  await f.restart(); f.security.importBudgetConfig({ taskLimitDefaults: { maxTokens: 70_000_000 } });
  assert.equal(warnings(f).length, 0);
  assert.equal(f.store.get("SELECT revision FROM security_alerts WHERE kind='budget-config-changed'").revision, 2);
  assert.deepEqual(protectedState(f), before);
  f.security.importBudgetConfig({ taskLimitDefaults: { maxTokens: 80_000_000 } });
  assert.equal(warnings(f)[0].revision, 3);
});

test('配置、来源快照、审计、告警、变更游标在事务故障时一起回滚', async t => {
  const f = await setup(t); f.security.importBudgetConfig(factory);
  const snapshot = () => Object.fromEntries(['settings', 'security_audit', 'security_alerts', 'changes'].map(table => [table, f.store.all(`SELECT * FROM ${table}`)]));
  for (const table of ['security_audit', 'security_alerts', 'changes']) {
    const before = snapshot();
    f.store.db.exec(`CREATE TRIGGER budget_failure BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'预算事务测试故障'); END`);
    assert.throws(() => f.security.importBudgetConfig({ taskLimitDefaults: { maxTokens: 60_000_000 }, agentLimitCap: { perTaskFactor: 3, dailyTokens: 3_000_000_000 } }), /预算事务测试故障/);
    assert.deepEqual(snapshot(), before);
    f.store.db.exec('DROP TRIGGER budget_failure');
  }
  f.security.importBudgetConfig({ taskLimitDefaults: { maxTokens: 60_000_000 } });
  assert.equal(warnings(f)[0].revision, 1);
});

test('导入方法拒绝非安全整数和未知嵌套字段且不产生副作用', async t => {
  const f = await setup(t);
  for (const value of [null, [], 1, { unknown: 1 }, { maxTokens: 0 }, { maxTokens: 1.5 }, { maxTokens: Number.MAX_SAFE_INTEGER + 1 }]) {
    assert.throws(() => f.security.importBudgetConfig({ taskLimitDefaults: value }), denied('invalid_params'));
  }
  assert.equal(setting(f, 'budgetFileSource'), undefined);
  assert.equal(imports(f).length, 0); assert.equal(warnings(f).length, 0);
});

test('config.json 严格校验预算嵌套对象和值，并接受大于 int32 的日封顶', async t => {
  const home = await directory(t);
  const invalid = [
    { taskLimitDefaults: null }, { taskLimitDefaults: [] }, { taskLimitDefaults: 1 },
    { taskLimitDefaults: { maxTokens: '50000000' } }, { taskLimitDefaults: { maxTokens: 0 } },
    { taskLimitDefaults: { maxTokens: Number.MAX_SAFE_INTEGER + 1 } }, { taskLimitDefaults: { maxTokens: 1, extra: 2 } },
    { agentLimitCap: { perTaskFactor: 0 } }, { agentLimitCap: { perTaskFactor: 1.2 } },
    { agentLimitCap: { dailyTokens: -1 } }, { agentLimitCap: { dailyTokens: 1.5 } },
    { agentLimitCap: { extra: 1 } },
  ];
  for (const config of invalid) {
    await writeFile(join(home, 'config.json'), JSON.stringify(config));
    await assert.rejects(startDaemon({ home, driver }), /配置/);
  }
  await writeFile(join(home, 'config.json'), JSON.stringify(factory));
  const daemon = await startDaemon({ home, driver });
  try { assert.deepEqual(daemon.security.state().config.taskLimitDefaults, factory.taskLimitDefaults); assert.equal(daemon.security.state().config.agentLimitCap.dailyTokens, 2_500_000_000); }
  finally { await daemon.close({ force: true, timeoutMs: 1000 }); }
});

test('daemon 文件只在重启导入，无关配置变动不覆盖签名在线预算', async t => {
  const home = await directory(t), file = { ...factory, maxChildren: 2 };
  await writeFile(join(home, 'config.json'), JSON.stringify(file));
  let daemon = await startDaemon({ home, driver });
  t.after(async () => { if (daemon) await daemon.close({ force: true, timeoutMs: 1000 }); });
  const device = pair(daemon);
  signedSet(daemon, device, 'taskLimitDefaults', { maxTokens: 70_000_000 });
  signedSet(daemon, device, 'agentLimitCap', { perTaskFactor: 3, dailyTokens: 3_000_000_000, perMeetingFactor: 8 });
  await writeFile(join(home, 'config.json'), JSON.stringify({ ...file, taskLimitDefaults: { maxTokens: 40_000_000 } }));
  assert.equal(daemon.security.state().config.taskLimitDefaults.maxTokens, 70_000_000);
  await writeFile(join(home, 'config.json'), JSON.stringify({ ...file, maxChildren: 3 }));
  await daemon.close({ force: true, timeoutMs: 1000 }); daemon = undefined;
  daemon = await startDaemon({ home, driver });
  assert.equal(daemon.security.state().config.taskLimitDefaults.maxTokens, 70_000_000);
  assert.deepEqual(daemon.security.state().config.agentLimitCap, { perTaskFactor: 3, dailyTokens: 3_000_000_000, perMeetingFactor: 8 });
  assert.equal(imports(daemon).length, 0);
  await writeFile(join(home, 'config.json'), JSON.stringify({ ...file, taskLimitDefaults: { maxTokens: 80_000_000 } }));
  await daemon.close({ force: true, timeoutMs: 1000 }); daemon = undefined;
  daemon = await startDaemon({ home, driver });
  assert.equal(daemon.security.state().config.taskLimitDefaults.maxTokens, 80_000_000);
  assert.equal(warnings(daemon)[0].revision, 1);
});

test('daemon 取得独占锁之前不得导入文件或修改来源、审计与告警', async t => {
  const home = await directory(t), store = await openStore(home), security = new Security(store);
  security.importBudgetConfig(factory);
  const snapshot = () => ['settings', 'security_audit', 'security_alerts', 'changes'].map(table => store.all(`SELECT * FROM ${table}`));
  const before = snapshot();
  await mkdir(join(home, 'run'), { recursive: true });
  const lock = await acquireInstanceLock('daemon', join(home, 'run'));
  assert.ok(lock);
  try {
    await writeFile(join(home, 'config.json'), JSON.stringify({ taskLimitDefaults: { maxTokens: 80_000_000 } }));
    await assert.rejects(startDaemon({ home, driver }), denied('daemon_busy'));
    assert.deepEqual(snapshot(), before);
  } finally { await lock.release(); store.close(); }
});
