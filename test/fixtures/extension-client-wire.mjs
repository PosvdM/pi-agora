import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hmacProof } from '../../packages/protocol/dist/client.js';

export async function extensionWire(root) {
  const key = randomBytes(32);
  const instanceId = 'instance-one';
  let sequence = 0;
  const challenges = new Map();
  const tokens = new Map();
  const calls = [];
  const state = { calls, invalidProof: false, refreshCount: 0, protocol: { min: 1, max: 1 } };
  await mkdir(join(root, 'secret'), { recursive: true });
  await mkdir(join(root, 'run'), { recursive: true });
  await writeFile(join(root, 'secret', 'host.key'), key);
  const server = createServer(async (req, res) => {
    try {
      let text = '';
      for await (const chunk of req) text += chunk;
      const body = text ? JSON.parse(text) : undefined;
      const call = { method: req.method, path: req.url, body, authorization: req.headers.authorization,
        idempotencyKey: req.headers['idempotency-key'], protocol: req.headers['agora-protocol'] };
      calls.push(call);
      await state.beforeRequest?.(call);
      let result;
      const path = req.url.split('?')[0];
      const fail = (status, code) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { code, message: `测试拒绝 ${req.headers.authorization ?? ''}` } })); };
      if (path === '/v1/health') {
        result = { daemonVersion: '0.1.0', instanceId, protocol: state.protocol };
      } else if (!Number.isInteger(Number(call.protocol)) || Number(call.protocol) < state.protocol.min || Number(call.protocol) > state.protocol.max) {
        return fail(426, 'protocol_unsupported');
      } else if (path === '/v1/auth/challenge') {
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
        result = { token: 'child-token', runId: 'run-one', principalId: 'child-one' };
      } else {
        if (!tokens.has(req.headers.authorization?.replace('Bearer ', ''))) return fail(401, 'invalid_token');
        if (path === '/v1/auth/refresh') {
          state.refreshCount++;
          result = { token: req.headers.authorization.replace('Bearer ', ''), expiresAt: new Date(Date.now() + 7200000).toISOString() };
        } else if (path === '/v1/failure') return fail(403, 'forbidden');
        else if (path === '/v1/redirect') { res.writeHead(302, { Location: state.redirectUrl }); res.end(); return; }
        else if (path === '/v1/test/shutdown') { result = {}; res.once('finish', () => { server.closeAllConnections(); server.close(); }); }
        else result = { taskId: 'task-one', status: 'completed', resultText: '测试结果' };
      }
      if (state.transformResponse) result = state.transformResponse(path, result);
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result));
    } catch { res.writeHead(500); res.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await writeFile(join(root, 'run', 'daemon.json'), JSON.stringify({ port, instanceId, pid: process.pid, protocol: state.protocol }));
  return { calls, get invalidProof() { return state.invalidProof; }, set invalidProof(v) { state.invalidProof = v; },
    state, url: `http://127.0.0.1:${port}`, server,
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}
