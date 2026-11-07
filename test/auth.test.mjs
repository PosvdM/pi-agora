import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Auth, proof } from '../packages/daemon/dist/auth.js';
import { openStore } from '../packages/daemon/dist/store.js';

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'agora-auth-'));
  const store = await openStore(home);
  const auth = await Auth.create(store, 'instance-one');
  const key = await readFile(join(home, 'secret', 'host.key'));
  t.after(async () => { store.close(); await rm(home, { recursive: true, force: true }); });
  function handshake(as = 'agent:main', target = auth) {
    const clientNonce = randomBytes(32).toString('base64url');
    const challenge = target.challenge({ clientNonce });
    assert.equal(challenge.serverProof, proof(key, ['server', clientNonce, target.instanceId]));
    const result = target.exchange({ challengeId: challenge.challengeId, clientProof: proof(key, ['client', challenge.serverNonce, target.instanceId]), as });
    return target.authenticate(`Bearer ${result.token}`);
  }
  async function register(conn, overrides = {}) {
    return auth.register(conn, { sessionId: 'pi-one', sessionFile: join(home, 'main.jsonl'), cwd: home, ...overrides });
  }
  async function reclaimBody(conn, principalId, sessionId = 'pi-one', target = auth) {
    const key = await readFile(join(home, 'secret', 'principals', `${principalId}.key`));
    return { principalId, sessionId, proof: proof(key, ['reclaim', principalId, sessionId, conn.connectionId, target.instanceId]) };
  }
  return { home, store, auth, key, handshake, register, reclaimBody };
}

test('host.key 双向握手校验实例、单次挑战、防伪造用户身份和 token 过期续期', async t => {
  const f = await fixture(t);
  assert.equal(f.key.length, 32);
  const challenge = f.auth.challenge({ clientNonce: '客户端随机数至少十六字符0123456789' });
  assert.throws(() => f.auth.exchange({ challengeId: challenge.challengeId, clientProof: '伪造', as: 'host:cli' }), { code: 'unauthenticated' });
  assert.throws(() => f.auth.exchange({ challengeId: challenge.challengeId, clientProof: proof(f.key, ['client', challenge.serverNonce, 'instance-one']), as: 'host:cli' }), { code: 'unauthenticated' });
  const wrongInstance = f.auth.challenge({ clientNonce: '0123456789abcdef' });
  assert.throws(() => f.auth.exchange({ challengeId: wrongInstance.challengeId, clientProof: proof(f.key, ['client', wrongInstance.serverNonce, 'other-instance']), as: 'host:cli' }), { code: 'unauthenticated' });
  const user = f.auth.challenge({ clientNonce: '0123456789abcdef' });
  assert.throws(() => f.auth.exchange({ challengeId: user.challengeId, clientProof: proof(f.key, ['client', user.serverNonce, 'instance-one']), as: 'user' }), { code: 'invalid_params' });
  const conn = f.handshake('host:cli');
  assert.equal(conn.principalId, 'host:cli');
  const previous = conn.expiresAt;
  conn.expiresAt -= 1000;
  assert.ok(Date.parse(f.auth.refresh(conn).expiresAt) >= previous);
  conn.expiresAt = Date.now() - 1;
  assert.throws(() => f.auth.authenticate(`Bearer ${conn.token}`), { code: 'token_expired' });
  assert.throws(() => f.auth.authenticate(`Bearer ${conn.token}`), { code: 'unauthenticated' });
});

test('main 注册/恢复证明、排他租约、过期接管、fork 与租约续期', async t => {
  const f = await fixture(t), a = f.handshake(), b = f.handshake();
  assert.throws(() => f.auth.requireMain(a), { code: 'lease_required' });
  const { principalId } = await f.register(a);
  assert.equal(a.principalId, principalId);
  assert.equal(f.auth.requireMain(a).pi_session_id, 'pi-one');
  const body = await f.reclaimBody(b, principalId);
  await assert.rejects(f.auth.reclaim(b, body), { code: 'lease_held' });
  await assert.rejects(f.auth.reclaim(b, { ...body, proof: '伪造' }), { code: 'forbidden' });
  await assert.rejects(f.auth.reclaim(b, { ...body, sessionId: 'fork-new-id' }), { code: 'session_mismatch' });
  const renewed = f.auth.renew(a);
  assert.ok(Date.parse(renewed.leaseExpiresAt) > Date.now());
  f.store.run('UPDATE principals SET lease_expires_at=0 WHERE id=?', principalId);
  assert.throws(() => f.auth.requireMain(a), { code: 'lease_required' });
  await f.auth.reclaim(b, body);
  assert.equal(f.auth.requireMain(b).id, principalId);
  f.auth.release(a);
  assert.equal(f.auth.requireMain(b).id, principalId, '旧连接不能释放新连接租约');
  f.auth.release(b);
  const c = f.handshake();
  await f.auth.reclaim(c, await f.reclaimBody(c, principalId));
  assert.equal(c.principalId, principalId);
  const fork = f.handshake();
  const registered = await f.register(fork, { sessionId: 'fork-new-id', forkedFrom: principalId });
  assert.notEqual(registered.principalId, principalId);
  assert.equal(f.store.principal(registered.principalId).forked_from, principalId);
});

test('同一 bootstrap token 并发注册只允许一个 principal，失败不泄漏恢复文件', async t => {
  const f = await fixture(t), conn = f.handshake();
  const results = await Promise.allSettled([f.register(conn), f.register(conn, { sessionId: 'second' })]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(f.store.get("SELECT COUNT(*) AS n FROM principals WHERE type='agent:main'").n, 1);
  const { readdir } = await import('node:fs/promises');
  assert.equal((await readdir(join(f.home, 'secret', 'principals'))).length, 1);
});

test('daemon 重启清空连接/租约但保留 host.key，旧证明不能绑定新连接', async t => {
  const f = await fixture(t), old = f.handshake();
  const { principalId } = await f.register(old);
  const oldBody = await f.reclaimBody(old, principalId);
  const next = await Auth.create(f.store, 'instance-two');
  assert.throws(() => next.authenticate(`Bearer ${old.token}`), { code: 'unauthenticated' });
  const conn = f.handshake('agent:main', next);
  await assert.rejects(next.reclaim(conn, oldBody), { code: 'forbidden' });
  await next.reclaim(conn, await f.reclaimBody(conn, principalId, 'pi-one', next));
  assert.equal(next.requireMain(conn).id, principalId);
  assert.deepEqual(await readFile(join(f.home, 'secret', 'host.key')), f.key);
});

test('launch ticket 单次且绑定 run，child 不提升权限，退出同步撤销 token 和未兑 ticket', async t => {
  const f = await fixture(t);
  const policy = { profile: 'explore', allowedRoots: [f.home], protectedPaths: [join(f.home, 'secret')], tools: ['read', 'grep', 'find', 'ls'], model: 'test/model', thinking: 'high', extensionVersion: '0.1.0' };
  const ticket = f.auth.ticket('child-one', 'run-one', policy);
  const launched = f.auth.launch({ ticket, as: 'user', principalId: 'user', runId: '伪造' });
  assert.equal(launched.runId, 'run-one');
  assert.deepEqual(launched.policy, policy);
  const child = f.auth.authenticate(`Bearer ${launched.token}`);
  assert.equal(child.type, 'agent:child');
  assert.throws(() => f.auth.requireMain(child), { code: 'forbidden' });
  await assert.rejects(f.auth.register(child, { sessionId: 'x' }), { code: 'forbidden' });
  assert.throws(() => f.auth.launch({ ticket }), { code: 'unauthenticated' });
  const pendingTicket = f.auth.ticket('child-one', 'run-one', policy);
  f.auth.revokeRun('run-one');
  assert.throws(() => f.auth.authenticate(`Bearer ${launched.token}`), { code: 'unauthenticated' });
  assert.throws(() => f.auth.launch({ ticket: pendingTicket }), { code: 'unauthenticated' });
});

test('挑战与launch ticket 超过60秒不能兑换，主机认证洪水有上限', async t => {
  const f = await fixture(t);
  const challenge = f.auth.challenge({ clientNonce: '0123456789abcdef' });
  const ticket = f.auth.ticket('child', 'run', { profile: 'explore', allowedRoots: [f.home], protectedPaths: [join(f.home, 'secret')], tools: ['read', 'grep', 'find', 'ls'], model: 'test/model', thinking: 'high', extensionVersion: '0.1.0' });
  const at = Date.now();
  t.mock.method(Date, 'now', () => at + 60_001);
  assert.throws(() => f.auth.exchange({ challengeId: challenge.challengeId, clientProof: proof(f.key, ['client', challenge.serverNonce, 'instance-one']), as: 'host:cli' }), { code: 'unauthenticated' });
  assert.throws(() => f.auth.launch({ ticket }), { code: 'unauthenticated' });
  for (let index = 0; index < 1024; index++) f.auth.challenge({ clientNonce: `0123456789abcdef-${index}` });
  assert.throws(() => f.auth.challenge({ clientNonce: '0123456789abcdef' }), { code: 'rate_limited' });
});

test('持久/ephemeral inbox ack 严格区分归属与持久化语义，ephemeral 不能恢复', async t => {
  const f = await fixture(t), main = f.handshake(), other = f.handshake(), ephemeral = f.handshake();
  await f.register(main);
  await f.register(other, { sessionId: 'other' });
  const memory = await f.register(ephemeral, { sessionId: 'memory', ephemeral: true, sessionFile: undefined });
  f.store.notice(main.principalId, 'disk', '测试', {});
  const noticeId = f.store.takeInbox(main.principalId)[0].id;
  assert.throws(() => f.auth.ack(other, { noticeId, entryId: 'e', persisted: true }), { code: 'not_found' });
  assert.throws(() => f.auth.ack(main, { noticeId, entryId: 'e', persisted: false }), { code: 'invalid_params' });
  assert.throws(() => f.auth.ack(main, { noticeId, persisted: true }), { code: 'invalid_params' });
  f.auth.ack(main, { noticeId, entryId: 'disk-entry', persisted: true });
  const disk = f.store.get('SELECT * FROM outbox WHERE id=?', noticeId);
  assert.ok(disk.acked_at && disk.persisted_at);
  assert.equal(disk.entry_id, 'disk-entry');
  f.store.notice(ephemeral.principalId, 'memory', '测试', {});
  const memoryNotice = f.store.takeInbox(ephemeral.principalId)[0].id;
  assert.throws(() => f.auth.ack(ephemeral, { noticeId: memoryNotice, entryId: 'e', persisted: true }), { code: 'invalid_params' });
  f.auth.ack(ephemeral, { noticeId: memoryNotice, entryId: 'e', persisted: false });
  const row = f.store.get('SELECT * FROM outbox WHERE id=?', memoryNotice);
  assert.ok(row.acked_at);
  assert.equal(row.persisted_at, null);
  assert.equal(row.persisted, 0);
  await assert.rejects(f.auth.reclaim(f.handshake(), { principalId: memory.principalId, sessionId: 'memory', proof: 'x' }), { code: 'principal_ephemeral' });
});
