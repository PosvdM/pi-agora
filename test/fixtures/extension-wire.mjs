import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { hmacProof } from '../../packages/protocol/dist/client.js';

export async function extensionWire(root) {
  const key = randomBytes(32);
  const recovery = randomBytes(32);
  let instanceId = 'instance-one';
  let sequence = 0;
  const challenges = new Map();
  const tokens = new Map();
  const calls = [];
  const state = { calls, key, recovery, invalidProof: false, registerCount: 0, reclaimCount: 0, readyCount: 0,
    fatalCount: 0, refreshCount: 0, leaseHeld: false, expectedModel: 'fake/model', readyReject: false };
  await mkdir(join(root, 'secret', 'principals'), { recursive: true });
  await mkdir(join(root, 'run'), { recursive: true });
  await writeFile(join(root, 'secret', 'host.key'), key);
  await writeFile(join(root, 'secret', 'principals', 'principal-one.key'), recovery);
  const server = createServer(async (req, res) => {
    // 假HTTP服务之间不继承连接池状态，重启/退避屏障仍由业务条件控制。
    res.setHeader('Connection', 'close');
    try {
      let text = '';
      for await (const chunk of req) text += chunk;
      const body = text ? JSON.parse(text) : undefined;
      const call = { method: req.method, path: req.url, body, authorization: req.headers.authorization, idempotencyKey: req.headers['idempotency-key'] };
      calls.push(call);
      await state.beforeRequest?.(call);
      let result;
      const path = req.url.split('?')[0];
      const fail = (status, code) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { code, message: '测试拒绝' } })); };
      if (path === '/v1/health') result = { daemonVersion: '0.1.0', instanceId, protocol: { min: 1, max: 1 } };
      else if (path === '/v1/auth/challenge') {
        const challengeId = `challenge-${++sequence}`;
        challenges.set(challengeId, 'server-nonce');
        result = { challengeId, serverNonce: 'server-nonce', instanceId,
          serverProof: state.invalidProof ? 'invalid' : hmacProof(key, ['server', body.clientNonce, instanceId]) };
      } else if (path === '/v1/auth/token') {
        if (body.clientProof !== hmacProof(key, ['client', challenges.get(body.challengeId), instanceId])) return fail(401, 'bad_proof');
        const token = `token-${++sequence}`;
        const connectionId = `connection-${sequence}`;
        tokens.set(token, { connectionId });
        result = { token, connectionId, expiresAt: new Date(Date.now() + 3600000).toISOString() };
      } else if (path === '/v1/auth/launch') {
        if (body.ticket !== 'one-use-ticket') return fail(401, 'bad_ticket');
        tokens.set('child-token', {});
        result = { token: 'child-token', expiresAt: new Date(Date.now() + 3600000).toISOString(), runId: 'run-one', principalId: 'child-one', policy: {
          profile: 'explore', tools: ['read', 'grep', 'find', 'ls'], allowedRoots: [root], protectedPaths: [join(root, 'secret')],
          model: state.expectedModel, thinking: 'off', extensionVersion: '0.1.0',
        } };
      } else {
        const conn = tokens.get(req.headers.authorization?.replace('Bearer ', ''));
        if (!conn) return fail(401, 'invalid_token');
        if (path === '/v1/principals/register') { state.registerCount++; state.leaseHeld = true; conn.bound = true; result = { principalId: state.registerPrincipalId ?? 'principal-one' }; }
        else if (path === '/v1/principals/reclaim') {
          if (body.proof !== hmacProof(recovery, ['reclaim', body.principalId, body.sessionId, conn.connectionId, instanceId])) return fail(403, 'bad_proof');
          state.reclaimCount++;
          if (state.reclaimCode) return fail(state.reclaimCode === 'session_mismatch' ? 403 : 410, state.reclaimCode);
          if (state.leaseHeld) return fail(409, 'lease_held');
          state.leaseHeld = true; conn.bound = true; result = {};
        } else if (path === '/v1/lease/release') { if (conn.bound) state.leaseHeld = false; conn.bound = false; result = {}; }
        else if (path === '/v1/lease/renew') result = {};
        else if (path === '/v1/auth/refresh') {
          state.refreshCount++;
          if (state.refreshTransportFailure) { req.socket.destroy(); return; }
          if (state.refreshReject) return fail(401, state.refreshReject);
          result = { token: req.headers.authorization.replace('Bearer ', ''), expiresAt: new Date(Date.now() + 7200000).toISOString() };
        } else if (path === '/v1/inbox') {
          if (state.enforceLease && !state.leaseHeld) return fail(409, 'lease_required');
          result = { items: state.inboxItems?.splice(0, 200) ?? [] };
        }
        else if (path.endsWith('/authorized')) result = { ready: !state.finalReadyBlocked };
        else if (path.endsWith('/ready')) { state.readyCount++; if (state.readyReject) return fail(403, 'ready_mismatch'); result = { ready: true }; }
        else if (path.endsWith('/fatal')) { state.fatalCount++; result = {}; }
        else if (path === '/v1/failure') return fail(403, 'forbidden');
        else if (path === '/v1/test/shutdown') { result = {}; res.once('finish', () => { server.closeAllConnections(); server.close(); }); }
        else result = { taskId: 'task-one', status: 'completed', resultText: '测试结果' };
      }
      if (state.transformResponse) result = state.transformResponse(path, result);
      await state.beforeResponse?.(call, result);
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result));
    } catch { res.writeHead(500); res.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  let publication = 0;
  const discovery = async () => {
    const temporary = join(root, 'run', `daemon-${++publication}.tmp`);
    await writeFile(temporary, JSON.stringify({ port, instanceId, pid: process.pid, protocol: { min: 1, max: 1 } }));
    for (let attempt = 0; ; attempt++) {
      try { await rename(temporary, join(root, 'run', 'daemon.json')); break; }
      catch (error) {
        // Windows 的读取或扫描共享冲突可能暂时拒绝替换；只重试改名，不回退到原位写入。
        if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 9) throw error;
        await delay(25 * (attempt + 1));
      }
    }
  };
  await discovery();
  return { ...state, get invalidProof() { return state.invalidProof; }, set invalidProof(v) { state.invalidProof = v; },
    state, url: `http://127.0.0.1:${port}`, server,
    async restart({ beforePublish } = {}) {
      instanceId = 'instance-two'; tokens.clear(); state.leaseHeld = false;
      await beforePublish?.();
      await discovery();
    },
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}
