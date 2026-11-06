import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { AgoraHttpError, connectHost, connectLaunch, loopbackUrl } from '../packages/protocol/dist/client.js';
import { extensionWire } from './fixtures/extension-wire.mjs';

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'agora-extension-client-'));
  const wire = await extensionWire(home);
  const clients = [];
  t.after(async () => { clients.forEach(c => c.close()); await wire.close(); await rm(home, { recursive: true, force: true }); });
  return { home, wire, clients, async connect() { const client = await connectHost({ home, as: 'host:cli', autoStart: false }); clients.push(client); return client; } };
}

test('主机双向握手、请求凭证、幂等键与refresh续期', async t => {
  const f = await fixture(t);
  const client = await f.connect();
  const previousExpiry = Date.parse(client.expiresAt);
  await client.request('POST', '/v1/tasks', { profile: 'explore' }, { idempotencyKey: 'once' });
  const call = f.wire.calls.find(c => c.path === '/v1/tasks');
  assert.equal(call.authorization, `Bearer ${client.token}`);
  assert.equal(call.idempotencyKey, 'once');
  await client.refresh();
  assert.equal(f.wire.state.refreshCount, 1);
  assert.ok(Date.parse(client.expiresAt) > previousExpiry);
  await assert.rejects(client.request('GET', '/v1/failure'), error => error instanceof AgoraHttpError && error.status === 403 && error.code === 'forbidden');
  client.close();
  const before = f.wire.calls.length;
  await assert.rejects(client.request('GET', '/v1/tasks'));
  assert.equal(f.wire.calls.length, before);
});

test('伪造serverProof时不发送clientProof且不尝试自动启动', async t => {
  const f = await fixture(t);
  f.wire.invalidProof = true;
  await assert.rejects(connectHost({ home: f.home, as: 'agent:main' }), /身份核验失败/);
  assert.equal(f.wire.calls.filter(c => c.path === '/v1/auth/token').length, 0);
  await assert.rejects(access(join(f.home, 'logs')));
});

test('畸形challenge、token和launch响应返回中文错误而非类型异常', async t => {
  const f = await fixture(t);
  for (const value of [null, [], { challengeId: 'id', serverNonce: 42, instanceId: 'instance-one', serverProof: {} }]) {
    f.wire.state.transformResponse = (path, result) => path === '/v1/auth/challenge' ? value : result;
    await assert.rejects(f.connect(), /握手响应无效/);
  }
  assert.equal(f.wire.calls.some(c => c.path === '/v1/auth/token'), false);
  f.wire.state.transformResponse = (path, result) => path === '/v1/auth/token' ? { ...result, token: {} } : result;
  await assert.rejects(f.connect(), /登录响应无效/);
  f.wire.state.transformResponse = (path, result) => path === '/v1/auth/launch' ? null : result;
  await assert.rejects(connectLaunch(f.wire.url, 'one-use-ticket'), /子会话登录响应无效/);
});

test('refresh畸形响应不能替换当前token，失败响应不回显服务器正文', async t => {
  const f = await fixture(t);
  const client = await f.connect();
  const token = client.token;
  f.wire.state.transformResponse = (path, result) => path === '/v1/auth/refresh' ? { token: 'replacement', expiresAt: 'not-a-date' } : result;
  await assert.rejects(client.refresh(), /续期响应无效/);
  assert.equal(client.token, token);
});

test('地址、路径和请求取消不能绕过loopback或向外发送token', async t => {
  const f = await fixture(t);
  const client = await f.connect();
  for (const url of ['https://127.0.0.1:1234', 'http://localhost:1234', 'http://example.com:1234', 'http://user:pass@127.0.0.1:1234', 'invalid']) {
    assert.throws(() => loopbackUrl(url), /agora/);
  }
  for (const path of ['https://example.com/v1/tasks', '//example.com/v1/tasks', '/v1/../../external', '/v1/tasks#hidden', '/v1/\\external']) {
    await assert.rejects(client.request('GET', path), /路径无效/);
  }
  const before = f.wire.calls.length;
  await assert.rejects(client.request('GET', '/v1/tasks', undefined, { signal: AbortSignal.abort() }), /请求已取消/);
  assert.equal(f.wire.calls.length, before);
});

test('已经取消的connectHost不创建日志或启动进程', async t => {
  const home = await mkdtemp(join(tmpdir(), 'agora-extension-cancelled-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await assert.rejects(connectHost({ home, as: 'host:cli', signal: AbortSignal.abort() }), /请求已取消/);
  await assert.rejects(access(join(home, 'logs')));
});

test('stale daemon.json只在连接失败时自动拉起，fixture使用隔离HOME', { timeout: 15000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'agora-extension-autostart-'));
  const wire = await extensionWire(home);
  await wire.close();
  const previousEnv = { ...process.env };
  process.env.HOME = home; process.env.USERPROFILE = home; process.env.PI_CODING_AGENT_DIR = join(home, 'agent');
  let client;
  t.after(async () => {
    try {
      client ??= await connectHost({ home, as: 'host:cli', autoStart: false }).catch(() => undefined);
      if (client) await client.request('POST', '/v1/test/shutdown', {}, { timeoutMs: 2000 }).catch(() => {});
      client?.close();
      const deadline = Date.now() + 3000;
      for (;;) {
        try { await access(join(home, 'client-fixture-exited')); break; }
        catch { if (Date.now() >= deadline) throw new Error('测试后台进程没有退出，保留现场'); await delay(20); }
      }
      await rm(home, { recursive: true, force: true });
    } catch (error) {
      // 仅终止本测试目录中记录的单进程 fixture，失败现场保留以供检查。
      const owned = JSON.parse(await readFile(join(home, 'client-fixture-pid.json'), 'utf8').catch(() => '{}'));
      if (Number.isInteger(owned.pid) && owned.pid > 0 && owned.pid !== process.pid) {
        try { process.kill(owned.pid, 'SIGKILL'); } catch (killError) { if (killError.code !== 'ESRCH') throw killError; }
      }
      throw error;
    } finally {
      for (const name of Object.keys(process.env)) if (!(name in previousEnv)) delete process.env[name];
      Object.assign(process.env, previousEnv);
    }
  });
  client = await connectHost({ home, as: 'host:cli', daemonEntry: fileURLToPath(new URL('./fixtures/extension-client-daemon.mjs', import.meta.url)) });
  const discovery = JSON.parse(await readFile(join(home, 'run', 'daemon.json'), 'utf8'));
  assert.notEqual(discovery.pid, process.pid);
  assert.equal((await client.request('GET', '/v1/tasks')).taskId, 'task-one');
});
