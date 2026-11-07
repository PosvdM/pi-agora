import test, { mock } from 'node:test';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { AgoraHttpError, connectHost, connectLaunch, loopbackUrl } from '../packages/protocol/dist/client.js';
import { PROTOCOL_RANGE, negotiateProtocol } from '../packages/protocol/dist/index.js';
import { extensionWire } from './fixtures/extension-client-wire.mjs';

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'agora-extension-client-'));
  const wire = await extensionWire(home);
  const clients = [];
  t.after(async () => { clients.forEach(c => c.close()); await wire.close(); await rm(home, { recursive: true, force: true }); });
  return { home, wire, clients, async connect() { const client = await connectHost({ home, as: 'host:cli', autoStart: false }); clients.push(client); return client; } };
}

test('发现记录短暂半写时重试完整发布，持续畸形时不发送任何凭证', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const file = join(f.home, 'run', 'daemon.json');
  const original = await readFile(file, 'utf8');
  await writeFile(file, '{"port":');
  let observed;
  const readStarted = new Promise(resolve => { observed = resolve; });
  const read = fsPromises.readFile;
  const spy = mock.method(fsPromises, 'readFile', async (...args) => {
    const data = await read(...args);
    if (String(args[0]) === file && data === '{"port":') observed();
    return data;
  });
  syncBuiltinESMExports();
  const connection = f.connect();
  void connection.catch(() => {});
  try {
    await readStarted;
    assert.equal(f.wire.calls.length, 0, '半写内容不能触发网络或证明发送');
    await writeFile(`${file}.next`, original);
    await rename(`${file}.next`, file);
    assert.ok((await connection).token);
  } finally { spy.mock.restore(); syncBuiltinESMExports(); }
  f.wire.calls.length = 0;
  await writeFile(file, '{"port":');
  await assert.rejects(connectHost({ home: f.home, as: 'host:cli' }), /无法读取.*发现信息/);
  assert.equal(f.wire.calls.length, 0);
  await assert.rejects(access(join(f.home, 'logs')), '持续畸形不能自动拉起另一daemon');
});

test('主机双向握手、请求凭证、幂等键与refresh续期', async t => {
  const f = await fixture(t);
  const client = await f.connect();
  const previousExpiry = Date.parse(client.expiresAt);
  await client.request('POST', '/v1/tasks', { profile: 'explore' }, { idempotencyKey: 'once' });
  const call = f.wire.calls.find(c => c.path === '/v1/tasks');
  assert.equal(call.authorization, `Bearer ${client.token}`);
  assert.equal(call.idempotencyKey, 'once');
  assert.equal(call.protocol, '1');
  assert.deepEqual(f.wire.calls.slice(0, 3).map(call => call.path), ['/v1/health', '/v1/auth/challenge', '/v1/auth/token']);
  assert.equal(f.wire.calls[0].authorization, undefined);
  assert.equal(f.wire.calls[0].protocol, undefined);
  await client.refresh();
  assert.equal(f.wire.state.refreshCount, 1);
  assert.ok(Date.parse(client.expiresAt) > previousExpiry);
  await assert.rejects(client.request('GET', '/v1/failure'), error => error instanceof AgoraHttpError && error.status === 403 && error.code === 'forbidden');
  client.close();
  const before = f.wire.calls.length;
  await assert.rejects(client.request('GET', '/v1/tasks'));
  assert.equal(f.wire.calls.length, before);
});

test('协议协商选择交集最高值，host/launch 每个连接固定所选 header', async t => {
  const f = await fixture(t);
  const originalRange = { ...PROTOCOL_RANGE };
  t.after(() => Object.assign(PROTOCOL_RANGE, originalRange));
  Object.assign(PROTOCOL_RANGE, { min: 1, max: 3 });
  f.wire.state.protocol = { min: 2, max: 4 };
  assert.equal(negotiateProtocol(f.wire.state.protocol), 3);
  const host = await f.connect();
  const { client: child } = await connectLaunch(f.wire.url, 'one-use-ticket');
  f.clients.push(child);
  Object.assign(PROTOCOL_RANGE, originalRange);
  await host.request('GET', '/v1/tasks');
  await host.refresh();
  await child.request('GET', '/v1/tasks');
  await child.refresh();
  assert.equal(child.instanceId, 'instance-one');
  const healthCalls = f.wire.calls.filter(call => call.path === '/v1/health');
  assert.equal(healthCalls.length, 2);
  assert.ok(healthCalls.every(call => call.protocol === undefined && call.authorization === undefined));
  assert.ok(f.wire.calls.filter(call => call.path !== '/v1/health').every(call => call.protocol === '3'));
  assert.ok(f.wire.calls.filter(call => call.path.startsWith('/v1/auth/') && call.path !== '/v1/auth/refresh').every(call => call.authorization === undefined));
});

test('远端范围兼容时选择本地支持版本，不兼容时不发 proof/ticket 或自动启动', async t => {
  const f = await fixture(t);
  f.wire.state.protocol = { min: 1, max: 4 };
  const client = await f.connect();
  await client.request('GET', '/v1/tasks');
  assert.ok(f.wire.calls.filter(call => call.path !== '/v1/health').every(call => call.protocol === '1'));
  f.wire.calls.length = 0;
  f.wire.state.protocol = { min: 2, max: 4 };
  await assert.rejects(connectHost({ home: f.home, as: 'host:cli' }), /协议版本不兼容/);
  await assert.rejects(connectLaunch(f.wire.url, 'secret-ticket'), /协议版本不兼容/);
  assert.deepEqual(f.wire.calls.map(call => call.path), ['/v1/health', '/v1/health']);
  assert.ok(f.wire.calls.every(call => call.body === undefined && call.authorization === undefined));
  await assert.rejects(access(join(f.home, 'logs')));
});

test('health 畸形范围和实例不匹配拒绝登录，challenge 不能替换已核验实例', async t => {
  const f = await fixture(t);
  for (const value of [null, [], {}, { daemonVersion: '0.1.0', instanceId: 'instance-one', protocol: null }]) {
    f.wire.state.transformResponse = (path, result) => path === '/v1/health' ? value : result;
    await assert.rejects(f.connect(), /健康检查响应无效/);
    await assert.rejects(connectLaunch(f.wire.url, 'secret-ticket'), /健康检查响应无效/);
  }
  for (const protocol of [{ min: 0, max: 1 }, { min: 2, max: 1 }, { min: 1.5, max: 2 }, { min: 1, max: 2.5 }]) {
    f.wire.state.transformResponse = (path, result) => path === '/v1/health' ? { ...result, protocol } : result;
    await assert.rejects(f.connect(), /协议版本不兼容/);
  }
  f.wire.state.transformResponse = (path, result) => path === '/v1/health' ? { ...result, instanceId: 'impostor' } : result;
  await assert.rejects(f.connect(), /身份核验失败/);
  assert.ok(f.wire.calls.every(call => call.path === '/v1/health'));
  f.wire.state.transformResponse = (path, result) => path === '/v1/auth/challenge' ? { ...result, instanceId: 'impostor' } : result;
  await assert.rejects(f.connect(), /身份核验失败/);
  assert.equal(f.wire.calls.some(call => call.path === '/v1/auth/token'), false);
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
  await assert.rejects(client.request('GET', '/v1/failure'), error => error instanceof AgoraHttpError && !error.message.includes(token));
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

test('登录响应的额外字段不能改写已核验地址或协议并转发 token', async t => {
  const f = await fixture(t), target = await fixture(t);
  f.wire.state.transformResponse = (path, result) => path === '/v1/auth/token'
    ? { ...result, url: target.wire.url, protocolVersion: 99, instanceId: 'impostor' } : result;
  const client = await f.connect();
  assert.equal(client.url, f.wire.url);
  assert.equal(client.instanceId, 'instance-one');
  await client.request('GET', '/v1/tasks');
  assert.equal(f.wire.calls.at(-1).protocol, '1');
  assert.equal(target.wire.calls.length, 0);
});

test('重定向拒绝转发 token，launch 同样拒绝外部地址', async t => {
  const f = await fixture(t), target = await fixture(t);
  const client = await f.connect();
  f.wire.state.redirectUrl = `${target.wire.url}/v1/tasks`;
  await assert.rejects(client.request('GET', '/v1/redirect'), /无法连接 agora/);
  assert.equal(target.wire.calls.length, 0);
  for (const url of ['https://127.0.0.1:1234', 'http://localhost:1234', 'http://example.com:1234']) {
    await assert.rejects(connectLaunch(url, 'secret-ticket'), /IPv4 本机 HTTP 地址/);
  }
  assert.equal(target.wire.calls.length, 0);
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
