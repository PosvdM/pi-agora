import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Auth, proof } from '../packages/daemon/dist/auth.js';
import { openStore } from '../packages/daemon/dist/store.js';

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'agora-claim-fork-1b-'));
  const store = await openStore(home);
  t.after(async () => { store.close(); await rm(home, { recursive: true, force: true, maxRetries: 5 }); });
  const auth = await Auth.create(store, 'claim-fork-instance');
  const hostKey = await readFile(join(home, 'secret', 'host.key'));
  const sessionId = 'original-pi-session';
  const sessionFile = join(home, 'original.jsonl');
  function connect() {
    const clientNonce = randomBytes(32).toString('base64url');
    const challenge = auth.challenge({ clientNonce });
    assert.equal(challenge.serverProof, proof(hostKey, ['server', clientNonce, auth.instanceId]));
    const token = auth.exchange({ challengeId: challenge.challengeId,
      clientProof: proof(hostKey, ['client', challenge.serverNonce, auth.instanceId]), as: 'agent:main' });
    return auth.authenticate(`Bearer ${token.token}`);
  }
  const old = connect();
  const { principalId } = await auth.register(old, { sessionId, sessionFile, cwd: home });
  const recovery = await readFile(join(home, 'secret', 'principals', `${principalId}.key`));
  // 过期接管与正常释放共用reclaim的原子租约检查；旧连接保留用于验证迟到release。
  store.run('UPDATE principals SET lease_expires_at=0 WHERE id=?', principalId);
  const body = (conn, id = sessionId) => ({ principalId, sessionId: id,
    proof: proof(recovery, ['reclaim', principalId, id, conn.connectionId, auth.instanceId]) });
  return { home, store, auth, old, connect, body, principalId, sessionId };
}

async function concurrently(operations) {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const pending = operations.map(operation => gate.then(operation));
  release();
  return Promise.allSettled(pending);
}

test('fork新sessionId与原会话并发认领：合法恢复证明不能跨session继承principal', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const fork = f.connect(), resumed = f.connect();
  const results = await concurrently([
    () => f.auth.reclaim(fork, f.body(fork, 'forked-pi-session')),
    () => f.auth.reclaim(resumed, f.body(resumed)),
  ]);
  assert.equal(results[0].status, 'rejected');
  assert.equal(results[0].reason.code, 'session_mismatch');
  assert.equal(results[1].status, 'fulfilled');
  assert.equal(results[1].value.principalId, f.principalId);
  assert.equal(fork.principalId, undefined);
  assert.throws(() => f.auth.requireMain(fork), { code: 'lease_required' });
  assert.equal(f.auth.requireMain(resumed).id, f.principalId);
  const registered = await f.auth.register(fork, { sessionId: 'forked-pi-session',
    sessionFile: join(f.home, 'fork.jsonl'), cwd: f.home, forkedFrom: f.principalId });
  assert.notEqual(registered.principalId, f.principalId);
  const forkRow = f.store.principal(registered.principalId);
  assert.equal(forkRow.pi_session_id, 'forked-pi-session');
  assert.equal(forkRow.forked_from, f.principalId);
  assert.equal(f.store.principal(f.principalId).lease_connection_id, resumed.connectionId);
  assert.equal(f.store.get("SELECT COUNT(*) AS n FROM principals WHERE type='agent:main'").n, 2);
});

test('相同原sessionId的独立连接并发reclaim仅一个获得租约，旧连接不能释放获胜租约', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const contenders = [f.connect(), f.connect()];
  assert.notEqual(contenders[0].connectionId, contenders[1].connectionId);
  const results = await concurrently(contenders.map(conn => () => f.auth.reclaim(conn, f.body(conn))));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  const winnerIndex = results.findIndex(result => result.status === 'fulfilled');
  const winner = contenders[winnerIndex], loser = contenders[1 - winnerIndex];
  assert.equal(results[1 - winnerIndex].reason.code, 'lease_held');
  assert.equal(f.store.principal(f.principalId).lease_connection_id, winner.connectionId);
  assert.equal(f.auth.requireMain(winner).id, f.principalId);
  assert.equal(loser.principalId, undefined);
  assert.throws(() => f.auth.requireMain(loser), { code: 'lease_required' });
  f.auth.release(f.old);
  f.auth.release(loser);
  assert.equal(f.auth.requireMain(winner).id, f.principalId);
  assert.equal(f.store.get("SELECT COUNT(*) AS n FROM principals WHERE type='agent:main'").n, 1);
  f.auth.release(winner);
  await f.auth.reclaim(loser, f.body(loser));
  assert.equal(f.auth.requireMain(loser).id, f.principalId, '获胜连接释放后，另一连接才能接管');
});
