import test from 'node:test';
import assert from 'node:assert/strict';
import { Server } from 'node:http';
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDaemon } from '../packages/daemon/dist/index.js';
import { MAX_PORT_ATTEMPTS } from '../packages/daemon/dist/ports.js';
import { Requests } from '../packages/daemon/dist/requests.js';
import { TaskManager } from '../packages/daemon/dist/tasks.js';
import { AgoraConnectionError, connectHost, connectLaunch, createClient, FETCH_FORBIDDEN_PORTS, isFetchForbiddenPort } from '../packages/protocol/dist/index.js';

const ALLOWED_PORT = 41000;
const FORBIDDEN_PORT = 6667;

async function homeFixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'agora-fetch-port-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

// 使用 HTTP server 的真实 close 事件契约注入端口，不绑定 socket，也不依赖操作系统随机分配。
function injectListeners(t, ports, options = {}) {
  const listeners = [], active = new Set(), requests = [], queueStarts = [];
  const address = new WeakMap();
  const arm = Requests.prototype.arm;
  t.mock.method(Requests.prototype, 'arm', function () {
    requests.push(this);
    return arm.call(this);
  });
  t.mock.method(Server.prototype, 'listen', function (port, host, callback) {
    assert.equal(port, 0);
    assert.equal(host, '127.0.0.1');
    const index = listeners.length;
    listeners.push(this);
    queueMicrotask(() => {
      if (options.error) { this.emit('error', options.error); return; }
      address.set(this, { address: host, family: 'IPv4', port: ports[Math.min(index, ports.length - 1)] });
      active.add(this);
      this.emit('listening');
      callback();
    });
    return this;
  });
  t.mock.method(Server.prototype, 'address', function () { return address.get(this) ?? null; });
  t.mock.method(Server.prototype, 'close', function (callback) {
    active.delete(this);
    address.delete(this);
    queueMicrotask(() => { this.emit('close'); callback?.(); });
    return this;
  });
  const startQueue = TaskManager.prototype.startQueue;
  t.mock.method(TaskManager.prototype, 'startQueue', function () {
    queueStarts.push({ active: active.size, port: address.get(listeners.at(-1))?.port });
    return startQueue.call(this);
  });
  return { listeners, active, requests, queueStarts };
}

const driver = { async start() { assert.fail('端口选择测试不得启动会话'); }, async recoverOldRun() { assert.fail('没有旧运行'); } };

test('Fetch 禁止端口集中判定，覆盖高位端口并保持名单只读', () => {
  assert.equal(Object.isFrozen(FETCH_FORBIDDEN_PORTS), true);
  assert.equal(new Set(FETCH_FORBIDDEN_PORTS).size, FETCH_FORBIDDEN_PORTS.length);
  for (const port of FETCH_FORBIDDEN_PORTS) assert.equal(isFetchForbiddenPort(port), true);
  for (const port of [0, 1, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697, 10080]) assert.equal(isFetchForbiddenPort(port), true);
  for (const port of [80, 443, 4096, 41000, 65535, -1, 65536, NaN]) assert.equal(isFetchForbiddenPort(port), false);
});

test('先禁止后允许：关闭旧 listener 和 Requests，确认允许后才公布 discovery 并启动队列', async t => {
  const home = await homeFixture(t);
  const f = injectListeners(t, [FORBIDDEN_PORT, ALLOWED_PORT]);
  const daemon = await startDaemon({ home, driver });
  try {
    assert.equal(f.listeners.length, 2);
    assert.equal(f.active.size, 1);
    assert.notEqual(f.requests[0], f.requests[1]);
    assert.equal(f.requests[0].closed, true);
    assert.equal(f.requests[1].closed, false, '重选不能永久关闭最终实例的请求定时器');
    assert.deepEqual(f.queueStarts, [{ active: 1, port: ALLOWED_PORT }]);
    assert.equal(daemon.url, `http://127.0.0.1:${ALLOWED_PORT}`);
    const discovery = JSON.parse(await readFile(join(home, 'run', 'daemon.json'), 'utf8'));
    assert.equal(discovery.port, ALLOWED_PORT);
    assert.equal(discovery.instanceId, daemon.instanceId);
  } finally { await daemon.close({ force: true, timeoutMs: 1000 }); }
  assert.equal(f.active.size, 0);
  assert.ok(f.requests.every(request => request.closed));
  await assert.rejects(access(join(home, 'run', 'daemon.json')), { code: 'ENOENT' });
});

test('全部禁止：达到有界上限，无 discovery/临时文件，关闭资源且释放锁后可再次启动', async t => {
  const home = await homeFixture(t);
  const ports = [FORBIDDEN_PORT];
  const f = injectListeners(t, ports);
  await assert.rejects(startDaemon({ home, driver }), new RegExp(`连续 ${MAX_PORT_ATTEMPTS} 次.*Fetch 禁止`));
  assert.equal(f.listeners.length, MAX_PORT_ATTEMPTS);
  assert.equal(f.active.size, 0);
  assert.ok(f.requests.every(request => request.closed));
  assert.deepEqual(f.queueStarts, []);
  assert.deepEqual((await readdir(join(home, 'run'))).filter(name => name.startsWith('daemon.json')), []);
  ports[0] = ALLOWED_PORT;
  const daemon = await startDaemon({ home, driver });
  try {
    assert.equal(f.listeners.length, MAX_PORT_ATTEMPTS + 1, '重新启动必须取得已释放的锁');
    assert.equal(daemon.url, `http://127.0.0.1:${ALLOWED_PORT}`);
  } finally { await daemon.close({ force: true, timeoutMs: 1000 }); }
});

test('listen 错误关闭未监听的 Requests，不公布 discovery 并释放锁', async t => {
  const home = await homeFixture(t);
  const failure = Object.assign(new Error('受控 bind 错误'), { code: 'EADDRINUSE' });
  const options = { error: failure };
  const f = injectListeners(t, [ALLOWED_PORT], options);
  await assert.rejects(startDaemon({ home, driver }), error => error === failure);
  assert.equal(f.listeners.length, 1, '普通监听错误不走禁止端口重试');
  assert.equal(f.requests[0].closed, true);
  assert.deepEqual(f.queueStarts, []);
  await assert.rejects(access(join(home, 'run', 'daemon.json')), { code: 'ENOENT' });
  delete options.error;
  const daemon = await startDaemon({ home, driver });
  await daemon.close({ force: true, timeoutMs: 1000 });
});

function badPortFailure() {
  return new TypeError('fetch failed', { cause: new Error('bad port') });
}

for (const [port, cause] of [
  [FORBIDDEN_PORT, new TypeError('fetch failed')],
  [FORBIDDEN_PORT, badPortFailure()],
  [ALLOWED_PORT, new AggregateError([badPortFailure()], '任意底层内容不回显')],
]) test(`客户端明确提示禁止端口 ${port}，保留原始 cause，不重试`, async t => {
  const spy = t.mock.method(globalThis, 'fetch', async () => { throw cause; });
  const client = createClient({ url: `http://127.0.0.1:${port}`, token: 'secret-token' });
  try {
    await assert.rejects(client.request('GET', '/v1/health'), error => {
      assert.ok(error instanceof AgoraConnectionError);
      assert.match(error.message, new RegExp(`端口 ${port} 被 Fetch 禁止`));
      assert.equal(error.fetchForbidden, true);
      assert.equal(error.cause, cause);
      assert.doesNotMatch(error.message, /任意底层|secret-token|fetch failed/);
      return true;
    });
    assert.equal(spy.mock.calls.length, 1);
  } finally { client.close(); }
});

test('普通连接错误文案与 cause 链不变，不回显任意底层 message', async t => {
  const cause = new TypeError('敏感底层内容', { cause: Object.assign(new Error('私密路径'), { code: 'ECONNREFUSED' }) });
  t.mock.method(globalThis, 'fetch', async () => { throw cause; });
  const client = createClient({ url: `http://127.0.0.1:${ALLOWED_PORT}`, token: 'token' });
  try {
    await assert.rejects(client.request('POST', '/v1/auth/challenge'), error => {
      assert.equal(error.message, '无法连接 agora，请检查后台进程（ECONNREFUSED）');
      assert.equal(error.fetchForbidden, false);
      assert.equal(error.cause, cause);
      return true;
    });
  } finally { client.close(); }
});

for (const autoStart of [false, true]) test(`connectHost 的 bad port 不被自动启动掩盖（autoStart=${autoStart}）`, async t => {
  const home = await homeFixture(t);
  await mkdir(join(home, 'run'));
  await mkdir(join(home, 'secret'));
  await writeFile(join(home, 'run', 'daemon.json'), JSON.stringify({ port: FORBIDDEN_PORT, instanceId: 'test-instance' }));
  await writeFile(join(home, 'secret', 'host.key'), Buffer.alloc(32));
  const cause = badPortFailure();
  const spy = t.mock.method(globalThis, 'fetch', async () => { throw cause; });
  await assert.rejects(connectHost({ home, as: 'host:cli', autoStart, daemonEntry: join(home, 'must-not-spawn.mjs') }), error => {
    assert.match(error.message, /端口 6667 被 Fetch 禁止/);
    assert.equal(error.cause, cause);
    return true;
  });
  assert.equal(spy.mock.calls.length, 1);
  await assert.rejects(access(join(home, 'logs')), { code: 'ENOENT' });
});

test('connectLaunch 的 health bad port 保留 cause，拒绝发送一次性 ticket', async t => {
  const cause = badPortFailure();
  const spy = t.mock.method(globalThis, 'fetch', async () => { throw cause; });
  await assert.rejects(connectLaunch(`http://127.0.0.1:${FORBIDDEN_PORT}`, 'one-use-ticket'), error => {
    assert.match(error.message, /端口 6667 被 Fetch 禁止/);
    assert.equal(error.cause.cause.message, 'bad port');
    return true;
  });
  assert.equal(spy.mock.calls.length, 1);
  assert.equal(new URL(spy.mock.calls[0].arguments[0]).pathname, '/v1/health');
  assert.equal(spy.mock.calls[0].arguments[1].body, undefined);
});
