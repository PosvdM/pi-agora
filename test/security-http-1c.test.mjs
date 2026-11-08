import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startDaemon, offline } from '../packages/daemon/dist/index.js';
import { connectHost } from '../packages/protocol/dist/client.js';
import { runCli } from '../packages/cli/dist/index.js';

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function signer(label = '测试设备') {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const deviceId = randomUUID(), spki = publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  return { deviceId, publicKey: spki, label,
    sign(challenge) { return { deviceId, publicKey: spki, alg: 'ECDSA-P256-SHA256', signature: sign('sha256', Buffer.from(canonical({ domain: 'pi-pane/user-presence/v1', payload: challenge })), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url') }; } };
}
async function setup(t) {
  const home = await mkdtemp(join(tmpdir(), 'agora-security-http-'));
  const driver = { async start() { throw new Error('安全接口测试不启动模型'); }, async recoverOldRun() { throw new Error('不应恢复进程'); } };
  const daemon = await startDaemon({ home, driver });
  const cli = await connectHost({ home, as: 'host:cli', autoStart: false });
  const pane = await connectHost({ home, as: 'host:pane', autoStart: false });
  const main = await connectHost({ home, as: 'agent:main', autoStart: false });
  await main.request('POST', '/v1/principals/register', { sessionId: randomUUID(), ephemeral: true, cwd: home });
  t.after(async () => { cli.close(); pane.close(); main.close(); await daemon.close({ force: true, timeoutMs: 1000 }); await rm(home, { recursive: true, force: true }); });
  const http = async (client, method, route, body, extra = {}) => {
    const response = await fetch(daemon.url + route, { method, headers: { 'Agora-Protocol': '1', Authorization: `Bearer ${client.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    return { status: response.status, body: await response.json() };
  };
  const pair = async device => {
    const response = await http(pane, 'POST', '/v1/devices/pair', { deviceId: device.deviceId, publicKey: device.publicKey, label: device.label });
    assert.equal(response.status, 202);
    const cf = response.body.confirmation;
    const result = await http(pane, 'POST', `/v1/confirmations/${cf.confirmationId}/sign`, device.sign(cf.challenge));
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result.body;
  };
  return { home, daemon, cli, pane, main, http, pair };
}

test('终端离线关闭保护、重启保留警告、直接答复与重新开启保护形成闭环', async t => {
  const home = await mkdtemp(join(tmpdir(), 'agora-security-terminal-'));
  let daemon;
  const clients = [];
  t.after(async () => { clients.forEach(client => client.close()); if (daemon) await daemon.close({ force: true, timeoutMs: 1000 }); await rm(home, { recursive: true, force: true }); });
  const output = [], errors = [], io = { out: value => output.push(value), error: value => errors.push(value) };
  assert.equal(await runCli(['offline', 'set', 'userConfirmation', 'off', '--home', home], io), 0, errors.join('\n'));
  const driver = { async start() { throw new Error('不启动模型'); }, async recoverOldRun() { throw new Error('不恢复进程'); } };
  daemon = await startDaemon({ home, driver });
  assert.equal(daemon.security.state().userConfirmation, 'off');
  await daemon.close({ force: true, timeoutMs: 1000 });
  daemon = await startDaemon({ home, driver });
  assert.ok(daemon.security.state().alerts.some(alert => alert.type === 'protection-off' || alert.kind === 'protection-off'));
  const main = await connectHost({ home, as: 'agent:main', autoStart: false }); clients.push(main);
  await main.request('POST', '/v1/principals/register', { sessionId: randomUUID(), ephemeral: true, cwd: home });
  const question = await main.request('POST', '/v1/requests', { questions: [{ id: 'q', question: '终端答复' }] });
  assert.equal(await runCli(['answer', question.id, '--answers', JSON.stringify([{ id: 'q', selected: [], custom: '终端确认' }]), '--home', home], io), 0, errors.join('\n'));
  assert.equal(JSON.parse(output.at(-1)).answeredVia.confirmedBy, 'none');
  assert.ok(errors.some(value => value.includes('protection-off')));
  assert.equal(await runCli(['config', 'set', 'userConfirmation', 'device', '--home', home], io), 0, errors.join('\n'));
  assert.equal(daemon.security.state().userConfirmation, 'device');
  assert.equal(daemon.security.state().alerts.some(alert => alert.type === 'protection-off' || alert.kind === 'protection-off'), false);
});

const questions = [{ id: 'q', question: '允许继续吗？', options: [{ label: '允许' }, { label: '拒绝' }] }];
const answers = [{ id: 'q', selected: ['允许'] }];

test('读取 host.key 的身份只能发起待确认，伪造 user 字段不能直接答复；合法设备签名才执行并更新幂等结果', async t => {
  const f = await setup(t);
  assert.equal((await readFile(join(f.home, 'secret', 'host.key'))).length, 32);
  const question = await f.main.request('POST', '/v1/requests', { questions });
  const key = randomUUID(), payload = { answers, expectedRevision: question.revision, user: true, principalId: 'user', confirmedBy: 'device' };
  const pending = await f.http(f.cli, 'POST', `/v1/requests/${question.id}/answer`, payload, { 'Idempotency-Key': key, 'Agora-Act-As': 'user' });
  assert.equal(pending.status, 202);
  const cf = pending.body.confirmation;
  assert.equal((await f.cli.request('GET', `/v1/requests/${question.id}`)).state, 'open');
  const attacker = signer('未配对设备');
  const rejected = await f.http(f.pane, 'POST', `/v1/confirmations/${cf.confirmationId}/sign`, attacker.sign(cf.challenge));
  assert.ok([401, 403].includes(rejected.status));
  assert.equal((await f.cli.request('GET', `/v1/requests/${question.id}`)).state, 'open');
  const device = signer();
  await f.pair(device);
  const signed = await f.http(f.pane, 'POST', `/v1/confirmations/${cf.confirmationId}/sign`, device.sign(cf.challenge));
  assert.equal(signed.status, 200, JSON.stringify(signed.body));
  const detail = await f.cli.request('GET', `/v1/requests/${question.id}`);
  assert.equal(detail.state, 'answered');
  assert.equal(detail.answeredBy, 'user');
  assert.equal(detail.answeredVia.confirmedBy, 'device');
  const again = await f.http(f.cli, 'POST', `/v1/requests/${question.id}/answer`, payload, { 'Idempotency-Key': key, 'Agora-Act-As': 'user' });
  assert.equal(again.status, 200);
  assert.equal(again.body.state, 'answered');
  assert.equal((await f.http(f.pane, 'POST', `/v1/confirmations/${cf.confirmationId}/sign`, device.sign(cf.challenge))).status, 409);
});

test('参数篡改、过期、跨确认签名和公钥替换均失败；确认后必须重新核对目标 revision', async t => {
  const f = await setup(t), device = signer();
  await f.pair(device);
  const question = await f.main.request('POST', '/v1/requests', { questions });
  const first = (await f.http(f.cli, 'POST', `/v1/requests/${question.id}/answer`, { answers, expectedRevision: question.revision })).body.confirmation;
  const second = (await f.http(f.cli, 'POST', `/v1/requests/${question.id}/answer`, { answers, expectedRevision: question.revision })).body.confirmation;
  const badHash = device.sign({ ...first.challenge, paramsHash: '被篡改' });
  assert.equal((await f.http(f.pane, 'POST', `/v1/confirmations/${first.confirmationId}/sign`, badHash)).status, 403);
  assert.equal((await f.http(f.pane, 'POST', `/v1/confirmations/${second.confirmationId}/sign`, device.sign(first.challenge))).status, 403);
  assert.equal((await f.http(f.pane, 'POST', `/v1/confirmations/${first.confirmationId}/sign`, { ...device.sign(first.challenge), publicKey: signer().publicKey })).status, 403);
  // 合法签名不能清除签名生成后出现的目标状态变化。
  f.daemon.store.run('UPDATE requests SET revision=revision+1 WHERE id=?', question.id);
  assert.equal((await f.http(f.pane, 'POST', `/v1/confirmations/${first.confirmationId}/sign`, device.sign(first.challenge))).status, 409);
  assert.equal((await f.cli.request('GET', `/v1/requests/${question.id}`)).state, 'open');
});

test('待确认按发起主会话隔离，host 可拒绝 CLI 的待确认且不执行原动作', async t => {
  const f = await setup(t);
  const other = await connectHost({ home: f.home, as: 'agent:main', autoStart: false });
  t.after(() => other.close());
  await other.request('POST', '/v1/principals/register', { sessionId: randomUUID(), ephemeral: true, cwd: f.home });
  const own = await f.main.request('POST', '/v1/tasks', { model: 'test/model', profile: 'explore', prompt: '仅对发起方可见的任务书', cwd: f.home, maxTokens: Number.MAX_SAFE_INTEGER });
  const cf = own.confirmation;
  assert.ok((await f.main.request('GET', '/v1/confirmations')).items.some(item => item.confirmationId === cf.confirmationId));
  assert.equal((await other.request('GET', '/v1/confirmations')).items.length, 0);
  assert.equal((await f.http(other, 'GET', `/v1/confirmations/${cf.confirmationId}`)).status, 403);
  assert.equal((await f.http(other, 'POST', `/v1/confirmations/${cf.confirmationId}/cancel`, {})).status, 403);
  const question = await f.main.request('POST', '/v1/requests', { questions });
  const pending = await f.cli.request('POST', `/v1/requests/${question.id}/answer`, { answers });
  assert.equal((await f.http(f.pane, 'POST', `/v1/confirmations/${pending.confirmation.confirmationId}/cancel`, {})).status, 200);
  assert.equal((await f.cli.request('GET', `/v1/requests/${question.id}`)).state, 'open');
  const audit = await f.cli.request('GET', '/v1/audit');
  assert.ok(audit.items.some(row => row.outcome === 'requested'));
  assert.ok(audit.items.some(row => row.outcome === 'cancelled'));
});

test('主会话租约接管必须先确认，旧签名不能覆盖已变化的租约', async t => {
  const f = await setup(t), device = signer();
  await f.pair(device);
  const mainConn = f.daemon.auth.authenticate(`Bearer ${f.main.token}`);
  const principalId = mainConn.principalId;
  const pending = await f.http(f.cli, 'POST', `/v1/principals/${principalId}/takeover`, { expectedConnectionId: mainConn.connectionId });
  assert.equal(pending.status, 202);
  assert.equal(f.daemon.store.principal(principalId).lease_connection_id, mainConn.connectionId);
  const cf = pending.body.confirmation;
  const stale = (await f.http(f.cli, 'POST', `/v1/principals/${principalId}/takeover`, { expectedConnectionId: mainConn.connectionId })).body.confirmation;
  const signed = await f.http(f.pane, 'POST', `/v1/confirmations/${cf.confirmationId}/sign`, device.sign(cf.challenge));
  assert.equal(signed.status, 200, JSON.stringify(signed.body));
  assert.equal(f.daemon.store.principal(principalId).lease_connection_id, null);
  assert.equal((await f.http(f.pane, 'POST', `/v1/confirmations/${stale.confirmationId}/sign`, device.sign(stale.challenge))).status, 409);
  await assert.rejects(f.main.request('POST', '/v1/requests', { questions }), error => error.code === 'lease_required');
});

test('在线关闭保护需要签名，离线命令锁拒绝运行中的 daemon；CLI 可查询待确认与安全状态', async t => {
  const f = await setup(t), device = signer();
  await f.pair(device);
  const io = { output: [], errors: [], out(value) { this.output.push(value); }, error(value) { this.errors.push(value); } };
  const disabled = await f.http(f.cli, 'POST', '/v1/settings/userConfirmation', { value: 'off' });
  assert.equal(disabled.status, 202);
  assert.equal((await f.cli.request('GET', '/v1/security/state')).userConfirmation, 'device');
  await assert.rejects(offline(f.home, ['set', 'userConfirmation', 'off']));
  const code = await runCli(['confirmations', '--home', f.home], { out: value => io.out(value), error: value => io.error(value) });
  assert.equal(code, 0, io.errors.join('\n'));
  assert.match(io.output.join('\n'), new RegExp(disabled.body.confirmation.confirmationId));
  const signed = await f.http(f.pane, 'POST', `/v1/confirmations/${disabled.body.confirmation.confirmationId}/sign`, device.sign(disabled.body.confirmation.challenge));
  assert.equal(signed.status, 200, JSON.stringify(signed.body));
  const state = await f.cli.request('GET', '/v1/security/state');
  assert.equal(state.userConfirmation, 'off');
  assert.ok(state.alerts.some(alert => alert.type === 'protection-off' || alert.kind === 'protection-off'));
  const question = await f.main.request('POST', '/v1/requests', { questions });
  assert.equal((await f.http(f.cli, 'POST', `/v1/requests/${question.id}/answer`, { answers })).status, 200);
  assert.equal((await f.cli.request('GET', `/v1/requests/${question.id}`)).answeredVia.confirmedBy, 'none');
  // 曾配对过以后关闭保护也不能把在线配对重置变成磁盘凭证旁路。
  assert.equal((await f.http(f.cli, 'POST', '/v1/devices/reset', {})).status, 202);
});
