import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { startDaemon, offline } from '../packages/daemon/dist/index.js';
import { connectHost } from '../packages/protocol/dist/index.js';
import { openArchive, projectPartials } from '../packages/archive/dist/index.js';
import { runArchiveCli } from '../packages/cli/dist/archive.js';
import { assertIsolatedTestHome } from './fixtures/test-home.mjs';

async function until(read, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await read(); if (value) return value; await delay(10); }
  assert.fail('等待回归切点超时');
}

// RPC 只替换进程传输；任务调度、鉴权、HTTP、SSE、旁车和归档 reader 均使用生产实现。
class QueueDriver {
  handles = [];
  async start(spec) {
    const events = new Set(), exits = new Set();
    let finish;
    const identity = { pid: 87000 + this.handles.length, startTime: '测试身份', runId: spec.runId, instanceId: spec.instanceId };
    const handle = {
      spec, identity, ready: false, stopped: false,
      exited: new Promise(resolve => { finish = resolve; }),
      onEvent(fn) { events.add(fn); return () => events.delete(fn); },
      onExit(fn) { exits.add(fn); return () => exits.delete(fn); },
      emit(event) { for (const fn of events) fn(event); },
      markReady() { this.ready = true; }, respondUi() {},
      diagnostics() { return { identity, cleanupConfirmed: true, events: [], activeTools: [], stderr: '' }; },
      async send(command) {
        await this.boot;
        let data = {};
        if (command.type === 'get_available_models') data = { models: [{ provider: 'test', id: 'model' }] };
        if (command.type === 'get_state') data = { model: 'test/model', thinkingLevel: spec.thinking, sessionFile: spec.sessionFile, sessionId: 'pi_test' };
        if (command.type === 'get_entries') data = { entries: [], leafId: null };
        return { type: 'response', command: command.type, success: true, data };
      },
      async stop() {
        if (!this.stopped) {
          this.stopped = true;
          const exit = { identity, code: 0, signal: null, reason: '测试退出', cleanupConfirmed: true };
          for (const fn of exits) fn(exit);
          finish(exit);
        }
        return { coverage: 'snapshot_visible', steps: [], leftovers: [] };
      },
    };
    this.handles.push(handle);
    handle.boot = (async () => {
      const post = async (route, body, token) => {
        const response = await fetch(spec.env.AGORA_URL + route, {
          method: 'POST', headers: { 'Agora-Protocol': '1', 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify(body), signal: AbortSignal.timeout(3000),
        });
        assert.equal(response.status, 200);
        return response.json();
      };
      const launch = await post('/v1/auth/launch', { ticket: spec.env.AGORA_LAUNCH_TICKET });
      await post(`/v1/runs/${spec.runId}/ready`, { tools: spec.tools, model: spec.model, thinking: spec.thinking, extensionVersion: '0.1.0' }, launch.token);
      await mkdir(path.dirname(spec.sessionFile), { recursive: true });
      await writeFile(spec.sessionFile, JSON.stringify({ type: 'session', version: 3, id: 'pi_test', timestamp: new Date().toISOString(), cwd: spec.cwd }) + '\n');
    })();
    return handle;
  }
  async recoverOldRun() { return { coverage: 'snapshot_visible', steps: [], leftovers: [] }; }
}

async function setup(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'agora-persistence-http-'));
  const saved = new Map(['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA'].map(key => [key, process.env[key]]));
  for (const key of saved.keys()) process.env[key] = path.join(home, 'user', key.toLowerCase());
  let daemon, client;
  t.after(async () => {
    try { client?.close(); await daemon?.close({ force: true, timeoutMs: 3000 }); }
    finally {
      await rm(home, { recursive: true, force: true });
      for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
  });
  await assertIsolatedTestHome(home);
  await offline(home, ['set', 'userConfirmation', 'off']);
  const driver = new QueueDriver();
  daemon = await startDaemon({ home, driver, maxConcurrentRuns: 1, readyTimeoutMs: 3000, idleReclaimMs: 60_000 });
  client = await connectHost({ home, as: 'host:cli', autoStart: false });
  const create = () => client.request('POST', '/v1/tasks', { profile: 'explore', model: 'test/model', thinking: 'off', prompt: '持久化回归', cwd: home }, { idempotencyKey: randomUUID() });
  const stop = task => client.request('POST', `/v1/tasks/${task.taskId}/stop`, {}, { idempotencyKey: randomUUID() });
  return { home, daemon, client, driver, create, stop };
}

function emitText(handle, text, timestamp) {
  handle.emit({ type: 'message_start', message: { role: 'assistant', timestamp, content: [] } });
  handle.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_start', contentIndex: 0 } });
  handle.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: text } });
}

for (const previousRun of [false, true]) test(`真实单槽队列：tail 等待 ${previousRun ? '历史 run 已退出的' : '无 run 的'} created 任务，启动后重同步`, { timeout: 20_000 }, async t => {
  const f = await setup(t);
  const first = await f.create();
  await until(() => f.driver.handles[0]?.ready);
  const second = await f.create();
  const id = second.agoraSessionId;
  assert.equal(f.daemon.store.task(second.taskId).status, 'created');
  assert.equal(f.driver.handles.length, 1);
  assert.equal(f.daemon.store.get('SELECT COUNT(*) AS n FROM process_runs WHERE agora_session_id=?', id).n, 0);
  if (previousRun) {
    // 已退出的历史记录不能把仍在真实队列里的会话判为终态。
    f.daemon.store.run(`INSERT INTO process_runs(id,agora_session_id,daemon_instance_id,state,started_at,exited_at)
      SELECT 'previous',?,daemon_instance_id,'exited','2000-01-01','2000-01-02' FROM process_runs LIMIT 1`, id);
  }
  const output = [];
  let finished = false, streams = 0;
  const controller = new AbortController();
  t.after(() => controller.abort());
  const tailClient = await connectHost({ home: f.home, as: 'host:cli', autoStart: false });
  const tail = runArchiveCli({ command: 'tail', operand: id, rest: [], options: new Map(), home: f.home, io: { out: value => output.push(JSON.parse(value)) } }, {
    available: async () => true, connect: async () => tailClient, signal: controller.signal,
    open: async () => assert.fail('在线排队不能降级到离线读取'),
    fetch: (url, options) => { streams++; return fetch(url, { ...options, signal: AbortSignal.any([options.signal, AbortSignal.timeout(10_000)]) }); },
  }).finally(() => { finished = true; });
  // 立即注册 rejection 处理器，断言仍检查原始 promise 的结果。
  tail.catch(() => {});
  const state = await until(() => f.daemon.tasks.sessions.states.get(id)?.clients.size && f.daemon.tasks.sessions.states.get(id));
  assert.equal(output[0].status, 'created');
  assert.equal(output[0].inFlight.phase, 'idle');
  await delay(100);
  assert.equal(finished, false);
  assert.equal(state.clients.size, 1);
  await f.stop(first);
  await until(() => f.driver.handles[1]?.ready);
  await until(() => streams >= 2 && output.some(value => value.cursor?.epoch !== output[0].cursor.epoch && value.status === 'running'));
  const next = f.driver.handles[1];
  emitText(next, '排队后仍收到增量', 1);
  await until(() => output.some(value => value.data?.event.assistantMessageEvent?.delta === '排队后仍收到增量'));
  await f.stop(second);
  assert.equal(await tail, true);
  assert.ok(streams >= 2);
});

test('原子片段批次：写入中进程退出只留下未提交临时文件，新 reader 仍可读取及继续提交', { timeout: 20_000 }, async t => {
  const f = await setup(t);
  const task = await f.create();
  const handle = await until(() => f.driver.handles[0]?.ready && f.driver.handles[0]);
  const views = f.daemon.tasks.sessions;
  await until(() => views.states.get(task.agoraSessionId)?.handle);
  const state = views.states.get(task.agoraSessionId);
  emitText(handle, '中断前基线', 1);
  await views.flush();
  const partialDirectory = path.join(path.dirname(handle.spec.sessionFile), 'partials');
  const partialFile = path.join(partialDirectory, `${state.runId}.jsonl`);
  const before = await readFile(partialFile);
  const probe = path.join(f.home, 'crash-probe.mjs');
  await writeFile(probe, `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { SessionViews } from ${JSON.stringify(new URL('../packages/daemon/dist/sessions.js', import.meta.url).href)};
    const original = fs.promises.appendFile;
    fs.promises.appendFile = async (file, data, options) => {
      const bytes = Buffer.from(data);
      await original(file, bytes.subarray(0, bytes.indexOf(10) + 7), options);
      process.exit(86);
    };
    syncBuiltinESMExports();
    await new SessionViews(undefined, 'crash-probe').commitPartials(${JSON.stringify(partialFile)}, '{"complete":true}\\n{"half":true}\\n');
  `);
  await assertIsolatedTestHome(f.home);
  // 不创建 Store 或第二个主写者，仅在父进程无待写批次时执行生产提交函数的中断切点。
  const result = spawnSync(process.execPath, [probe], { env: { ...process.env }, encoding: 'utf8', timeout: 5000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 86, result.stderr);
  assert.deepEqual(await readFile(partialFile), before);
  assert.equal((await readdir(partialDirectory)).filter(file => file.endsWith('.tmp')).length, 1);
  const reader = await openArchive({ home: f.home, apiVersion: 1 });
  try { assert.deepEqual(projectPartials(await reader.readPartials(task.agoraSessionId)).map(value => value.blocks[0].text), ['中断前基线']); }
  finally { reader.close(); }
  emitText(handle, '中断后提交', 2);
  await views.flush();
  const nextReader = await openArchive({ home: f.home, apiVersion: 1 });
  try { assert.deepEqual(projectPartials(await nextReader.readPartials(task.agoraSessionId)).map(value => value.blocks[0].text), ['中断前基线', '中断后提交']); }
  finally { nextReader.close(); }
});

for (const code of ['ENOSPC', 'EIO']) test(`原子片段批次：完整前缀和半行写入后 ${code}，重试及全新 reader 不丢失或重复`, { timeout: 20_000 }, async t => {
  const f = await setup(t);
  const task = await f.create();
  const handle = await until(() => f.driver.handles[0]?.ready && f.driver.handles[0]);
  const views = f.daemon.tasks.sessions;
  await until(() => views.states.get(task.agoraSessionId)?.handle);
  const state = views.states.get(task.agoraSessionId);
  const before = await readFile(handle.spec.sessionFile);
  emitText(handle, '已提交基线', 1);
  await views.flush();
  const partialDirectory = path.join(path.dirname(handle.spec.sessionFile), 'partials');
  const partialFile = path.join(partialDirectory, `${state.runId}.jsonl`);
  const baseline = await readFile(partialFile);
  const original = fs.promises.appendFile;
  let injected = 0, prefix;
  fs.promises.appendFile = async (file, data, options) => {
    if (typeof file === 'object' && Number.isInteger(file.fd) && !injected) {
      injected++;
      const bytes = Buffer.from(data);
      const firstLine = bytes.indexOf(10) + 1;
      prefix = bytes.subarray(0, firstLine + Math.max(1, Math.floor((bytes.length - firstLine) / 2)));
      await original(file, prefix, options);
      const temporary = (await readdir(partialDirectory)).find(name => name.endsWith('.tmp'));
      assert.ok(temporary);
      const written = await readFile(path.join(partialDirectory, temporary));
      assert.ok(written.subarray(baseline.length).equals(prefix));
      assert.ok(prefix.includes(10));
      assert.notEqual(prefix.at(-1), 10);
      throw Object.assign(new Error(`受控部分写入 ${code}`), { code });
    }
    return original(file, data, options);
  };
  syncBuiltinESMExports();
  try {
    emitText(handle, '完整批次必须精确一次', 2);
    await assert.rejects(views.flush(), error => error instanceof AggregateError && error.errors.some(item => item.code === code));
    assert.equal(injected, 1);
    assert.deepEqual(await readFile(partialFile), baseline);
    assert.ok(state.pending.length > 0);
    const reader = await openArchive({ home: f.home, apiVersion: 1 });
    try { assert.deepEqual(projectPartials(await reader.readPartials(task.agoraSessionId)).map(value => value.blocks[0].text), ['已提交基线']); }
    finally { reader.close(); }
  } finally { fs.promises.appendFile = original; syncBuiltinESMExports(); }
  await views.flush();
  assert.equal(state.pending.length, 0);
  assert.equal((await readFile(partialFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line)).filter(row => row.delta === '完整批次必须精确一次').length, 1);
  const reader = await openArchive({ home: f.home, apiVersion: 1 });
  try { assert.deepEqual(projectPartials(await reader.readPartials(task.agoraSessionId)).map(value => value.blocks[0].text), ['已提交基线', '完整批次必须精确一次']); }
  finally { reader.close(); }
  assert.deepEqual(await readFile(handle.spec.sessionFile), before);
  assert.deepEqual(await readdir(partialDirectory), [`${state.runId}.jsonl`]);
});
