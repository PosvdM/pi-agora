import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AgoraConnectionError, AgoraHttpError, connectHost, connectLaunch, createClient, hmacProof } from '../packages/protocol/dist/client.js';

function json(response, data, status = 200) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(data));
}

async function fixture(t, handler) {
  const calls = [];
  const errors = [];
  const timers = new Set();
  const server = createServer((request, response) => {
    void (async () => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const call = { path: request.url, method: request.method, headers: request.headers,
        body: Buffer.concat(chunks).toString(), socket: request.socket };
      calls.push(call);
      if (call.path === '/v1/health') {
        json(response, { daemonVersion: 'test', instanceId: 'retry-instance', protocol: { min: 1, max: 1 } });
        return;
      }
      await handler(call, response);
    })().catch(error => { errors.push(error); response.destroy(); });
  });
  // 使用真实的持久连接，不用 Connection: close 绕过连接池中的故障。
  server.keepAliveTimeout = 5000;
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  const client = createClient({ url, token: 'token-before', connectionId: 'principal-one' });
  t.after(async () => {
    for (const timer of timers) clearTimeout(timer);
    client.close();
    const closed = new Promise(resolve => server.close(resolve));
    server.closeAllConnections();
    await closed;
    assert.deepEqual(errors, []);
  });
  await client.request('GET', '/v1/health');
  assert.equal(calls[0].headers.connection, 'keep-alive');
  calls.length = 0;
  return { client, calls, url, later(ms, action) {
    const timer = setTimeout(() => { timers.delete(timer); action(); }, ms);
    timers.add(timer);
  } };
}

test('副作用已发生且响应正文中断时，重试保留原凭证、参数和幂等键', { timeout: 5000 }, async t => {
  let effects = 0;
  const receipts = new Map();
  const body = { prompt: '原始参数' };
  const options = { idempotencyKey: 'original-key', timeoutMs: 2000 };
  let f;
  f = await fixture(t, async (call, response) => {
    if (call.path === '/v1/auth/refresh') {
      json(response, { token: 'token-after', expiresAt: '2099-01-01T00:00:00.000Z' });
      return;
    }
    const key = call.headers['idempotency-key'];
    if (!receipts.has(key)) {
      const receipt = { taskId: `task-${++effects}` };
      receipts.set(key, receipt);
      body.prompt = '修改后的参数';
      options.idempotencyKey = 'replacement-key';
      await f.client.refresh();
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.write('{"taskId":');
      f.later(10, () => call.socket.destroy());
      return;
    }
    json(response, receipts.get(key));
  });
  assert.deepEqual(await f.client.request('POST', '/v1/tasks', body, options), { taskId: 'task-1' });
  assert.equal(effects, 1);
  assert.equal(f.client.token, 'token-after');
  assert.equal(f.client.connectionId, 'principal-one');
  const writes = f.calls.filter(call => call.path === '/v1/tasks');
  assert.equal(writes.length, 2);
  for (const call of writes) {
    assert.equal(call.headers.connection, 'keep-alive');
    assert.equal(call.headers.authorization, 'Bearer token-before');
    assert.equal(call.headers['idempotency-key'], 'original-key');
    assert.equal(call.headers['agora-protocol'], '1');
    assert.deepEqual(JSON.parse(call.body), { prompt: '原始参数' });
  }
});

test('安全 GET 的 socket 故障至多发送三次', { timeout: 5000 }, async t => {
  const f = await fixture(t, call => call.socket.destroy());
  await assert.rejects(f.client.request('GET', '/v1/tasks', undefined, { timeoutMs: 2000 }), AgoraConnectionError);
  assert.equal(f.calls.length, 3);
  assert.ok(f.calls.every(call => call.headers.connection === 'keep-alive'));
});

test('业务写入的结果持续未知时，有限重试始终使用同一个幂等键', { timeout: 5000 }, async t => {
  const receipts = new Set();
  const f = await fixture(t, call => {
    receipts.add(call.headers['idempotency-key']);
    call.socket.destroy();
  });
  await assert.rejects(f.client.request('POST', '/v1/tasks', { prompt: '结果未知' },
    { idempotencyKey: 'unknown-outcome-key', timeoutMs: 2000 }), AgoraConnectionError);
  assert.equal(f.calls.length, 3);
  assert.deepEqual([...receipts], ['unknown-outcome-key']);
});

test('无幂等键的业务写入不重试', { timeout: 5000 }, async t => {
  const f = await fixture(t, call => call.socket.destroy());
  await assert.rejects(f.client.request('POST', '/v1/tasks', { prompt: '一次写入' }), AgoraConnectionError);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].headers['idempotency-key'], undefined);
});

test('refresh 与 lease 续期在响应丢失时可以使用原凭证重试', { timeout: 5000 }, async t => {
  const attempts = new Map();
  const f = await fixture(t, (call, response) => {
    const count = (attempts.get(call.path) ?? 0) + 1;
    attempts.set(call.path, count);
    if (count === 1) { call.socket.destroy(); return; }
    json(response, call.path === '/v1/auth/refresh'
      ? { token: 'renewed', expiresAt: '2099-01-01T00:00:00.000Z' } : { expiresAt: '2099-01-01T00:00:00.000Z' });
  });
  await f.client.refresh();
  await f.client.request('POST', '/v1/lease/renew', { leaseId: 'lease-one' });
  assert.deepEqual([...attempts.values()], [2, 2]);
  const refresh = f.calls.filter(call => call.path === '/v1/auth/refresh');
  assert.ok(refresh.every(call => call.headers.authorization === 'Bearer token-before'));
  const renew = f.calls.filter(call => call.path === '/v1/lease/renew');
  assert.ok(renew.every(call => call.headers.authorization === 'Bearer renewed'));
  assert.deepEqual(renew.map(call => JSON.parse(call.body)), [{ leaseId: 'lease-one' }, { leaseId: 'lease-one' }]);
});

test('连续 socket 故障与等待响应共用一个总期限', { timeout: 5000 }, async t => {
  let f;
  f = await fixture(t, call => {
    if (f.calls.length === 1) f.later(250, () => call.socket.destroy());
  });
  const start = performance.now();
  await assert.rejects(f.client.request('GET', '/v1/tasks', undefined, { timeoutMs: 500 }), AgoraConnectionError);
  const elapsed = performance.now() - start;
  assert.equal(f.calls.length, 2);
  assert.ok(elapsed >= 430 && elapsed < 725, `总期限耗时 ${elapsed}ms`);
});

test('第一次响应等待到总期限后不另发重试', { timeout: 5000 }, async t => {
  const f = await fixture(t, () => {});
  await assert.rejects(f.client.request('GET', '/v1/tasks', undefined, { timeoutMs: 100 }), AgoraConnectionError);
  assert.equal(f.calls.length, 1);
});

for (const phase of ['等待响应', '重试间隔']) {
  for (const action of ['取消', '关闭']) {
    test(`${phase}时${action}会停止请求且不重试`, { timeout: 5000 }, async t => {
      const controller = new AbortController();
      let f;
      f = await fixture(t, call => {
        if (phase === '重试间隔') call.socket.destroy();
        f.later(20, () => action === '取消' ? controller.abort() : f.client.close());
      });
      await assert.rejects(f.client.request('GET', '/v1/tasks', undefined, { signal: controller.signal, timeoutMs: 1000 }),
        action === '取消' ? /请求已取消/ : AgoraConnectionError);
      await delay(100);
      assert.equal(f.calls.length, 1);
      await assert.rejects(f.client.request('GET', '/v1/tasks', undefined,
        { signal: action === '取消' ? controller.signal : undefined }));
      assert.equal(f.calls.length, 1);
    });
  }
}

for (const status of [401, 403, 426, 503]) {
  test(`HTTP ${status} 拒绝不触发传输重试`, { timeout: 5000 }, async t => {
    const f = await fixture(t, (_call, response) => json(response, { error: { code: 'request_denied' } }, status));
    await assert.rejects(f.client.request('POST', '/v1/tasks', {}, { idempotencyKey: 'denied-key' }),
      error => error instanceof AgoraHttpError && error.status === status);
    assert.equal(f.calls.length, 1);
  });
}

for (const status of [401, 426]) {
  test(`HTTP ${status} 正文被截断也不重试`, { timeout: 5000 }, async t => {
    let f;
    f = await fixture(t, (call, response) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.write('{"error":');
      f.later(10, () => call.socket.destroy());
    });
    await assert.rejects(f.client.request('GET', '/v1/tasks'), AgoraConnectionError);
    assert.equal(f.calls.length, 1);
  });
}

test('完整但无效的 JSON 不重试', { timeout: 5000 }, async t => {
  const f = await fixture(t, (_call, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end('{invalid');
  });
  await assert.rejects(f.client.request('GET', '/v1/tasks'), /返回了无效响应/);
  assert.equal(f.calls.length, 1);
});

test('一次性 launch ticket 的响应丢失不能重放', { timeout: 5000 }, async t => {
  const f = await fixture(t, call => call.socket.destroy());
  await assert.rejects(connectLaunch(f.url, 'one-use-ticket'), AgoraConnectionError);
  assert.equal(f.calls.filter(call => call.path === '/v1/auth/launch').length, 1);
});

for (const path of ['/v1/auth/launch', '/v1/auth/token', '/v1/auth/challenge']) {
  test(`${path} 即使带幂等键也不能重放`, { timeout: 5000 }, async t => {
    const f = await fixture(t, call => call.socket.destroy());
    await assert.rejects(f.client.request('POST', path, { ticket: 'one-use-ticket' }, { idempotencyKey: 'must-not-replay' }), AgoraConnectionError);
    assert.equal(f.calls.length, 1);
  });
}

test('主机握手的一次性 token 兑换在响应丢失后不重放', { timeout: 5000 }, async t => {
  const key = Buffer.alloc(32, 7);
  const f = await fixture(t, (call, response) => {
    if (call.path === '/v1/auth/challenge') {
      const { clientNonce } = JSON.parse(call.body);
      json(response, { challengeId: 'challenge-one', serverNonce: 'server-nonce', instanceId: 'retry-instance',
        serverProof: hmacProof(key, ['server', clientNonce, 'retry-instance']) });
    } else call.socket.destroy();
  });
  const home = await mkdtemp(join(tmpdir(), 'agora-client-retry-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, 'secret'));
  await mkdir(join(home, 'run'));
  await writeFile(join(home, 'secret', 'host.key'), key);
  await writeFile(join(home, 'run', 'daemon.json'), JSON.stringify({ port: Number(new URL(f.url).port), instanceId: 'retry-instance' }));
  await assert.rejects(connectHost({ home, as: 'host:cli', autoStart: false }), AgoraConnectionError);
  assert.equal(f.calls.filter(call => call.path === '/v1/auth/challenge').length, 1);
  assert.equal(f.calls.filter(call => call.path === '/v1/auth/token').length, 1);
});
