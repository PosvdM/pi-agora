// 模块替换只在显式启用 Node 测试 mock 的独立子进程中生效，不增加生产注入入口。
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, beforeEach, mock, test } from "node:test";

const root = await mkdtemp(path.join(tmpdir(), "agora-driver-faults-"));
for (const key of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA"]) process.env[key] = path.join(root, key);
const hostkit = await import("pi-hostkit");
const identity = { pid: 12345, startTime: "测试创建时间", runId: "run", instanceId: "instance" };
const report = (patch = {}) => ({ coverage: "snapshot_visible", leftovers: [], steps: [{ step: "verify", ok: true, at: "测试时间" }], ...patch });
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
let state;

function fakeLock() {
  return {
    recoveryReports: state.recoveryReports,
    async recoverPreviousWriter(options) {
      state.calls.push("recoverPreviousWriter");
      state.recoveryOptions = options;
      if (state.recoveryBarrier) await state.recoveryBarrier.promise;
      return state.recoveryResult;
    },
    async spawnWriter(spec) {
      state.calls.push("spawnWriter");
      state.spawnSpec = spec;
      if (state.spawnError) throw state.spawnError;
      return {
        identity, rpc: {
          onEvent(fn) { state.event = fn; return () => { state.event = undefined; }; },
          onUiRequest(fn) { state.ui = fn; return () => { state.ui = undefined; }; },
          onError(fn) { state.rpcError = fn; return () => { state.rpcError = undefined; }; },
          closed: new Promise(() => {}),
          async send(command) {
            state.calls.push(command.type);
            if (command.type === "clear_queue" && state.clearError) throw state.clearError;
            return { type: "response", command: command.type, success: true, data: {} };
          },
          respondUi(response) { state.uiResponses.push(response); },
        },
        exited: state.processExit.promise,
        stderrTail() { return "故障测试 stderr"; },
        async stop() {
          state.calls.push("stop");
          if (state.stopError) throw state.stopError;
          if (!state.noExit) state.processExit.resolve({ code: 0, signal: null });
          return state.report;
        },
      };
    },
    async update(patch) {
      state.calls.push(`update:${patch.state}`);
      if (state.updateError) throw state.updateError;
    },
    async release() {
      state.calls.push("release");
      if (state.releaseError) throw state.releaseError;
    },
  };
}
mock.module("pi-hostkit", { namedExports: {
  ...hostkit,
  locatePi: async () => {
    if (state.locateBarrier) await state.locateBarrier.promise;
    return { supported: true, version: "1.5.0", packageDir: root, cliEntry: path.join(root, "pi.js") };
  },
  acquireSessionWriterLock: async () => { state.calls.push("acquire"); return fakeLock(); },
  currentProcessIdentity: () => ({ ...identity, pid: 45678 }),
  isSameProcess: async () => {
    state.calls.push("isSameProcess");
    if (state.identityError) throw state.identityError;
    return state.identityAlive ? "alive" : "gone";
  },
  stopByIdentity: async (target) => {
    state.calls.push(`stopByIdentity:${target.pid}`);
    const barrier = state.oldBarriers.get(target.pid);
    if (barrier) await barrier.promise;
    return state.oldReports.get(target.pid) ?? state.report;
  },
} });
const { RpcSubprocessDriver } = await import("../../packages/daemon/dist/driver.js");
const spec = { agoraSessionId: "session", runId: "run", instanceId: "instance", cwd: root,
  model: "测试/模型", thinking: "off", profile: "explore", sessionFile: path.join(root, "session.jsonl"), env: {} };
let index = 0;
let driver;
beforeEach(async () => {
  state = { calls: [], report: report(), recoveryReports: [], recoveryResult: "none", oldReports: new Map(),
    oldBarriers: new Map(), uiResponses: [], processExit: deferred() };
  const home = path.join(root, `case-${++index}`);
  await mkdir(home, { recursive: true });
  driver = new RpcSubprocessDriver({ home, extensionPath: path.join(root, "extension.ts"),
    stopOptions: { abortTimeoutMs: 0, graceMs: 0, termGraceMs: 0 } });
});
after(async () => { await rm(root, { recursive: true, force: true, maxRetries: 5 }); });

for (const step of ["snapshot", "snapshot cleanup", "verify"]) test(`故障：${step} 失败且空残留仍保留锁和报告`, async () => {
  state.report.steps.push({ step, ok: false, at: "测试时间", detail: "受控进程表查询失败" });
  const handle = await driver.start(spec);
  let notified = 0;
  handle.onExit(() => { notified++; });
  await assert.rejects(handle.stop(), (error) => {
    assert.equal(error.code, "EAGORA_STOP_INCOMPLETE");
    assert.equal(error.stopReport, state.report);
    return true;
  });
  const exit = await handle.exited;
  assert.equal(exit.cleanupConfirmed, false);
  assert.equal(notified, 1);
  assert.equal(state.calls.includes("release"), false);
  assert.equal(exit.stopReport, state.report);
  const data = JSON.parse(await readFile(exit.diagnosticsPath, "utf8"));
  assert.equal(data.cleanupConfirmed, false);
  assert.deepEqual(data.stopReport, state.report);
});

test("对照：正常 snapshot 空残留可释放，记录覆盖边界和清理确认", async () => {
  const handle = await driver.start(spec);
  assert.equal(await handle.stop(), state.report);
  assert.equal((await handle.exited).cleanupConfirmed, true);
  assert.deepEqual(state.calls.slice(-5), ["update:stopping", "clear_queue", "stop", "isSameProcess", "release"]);
  assert.equal(handle.diagnostics().cleanupConfirmed, true);
  assert.match(handle.diagnostics().warnings[0], /快照见过的进程/);
});

test("故障：未知 coverage 不能释放锁", async () => {
  state.report.coverage = "未知覆盖范围";
  const handle = await driver.start(spec);
  await assert.rejects(handle.stop(), { code: "EAGORA_STOP_COVERAGE" });
  assert.equal(state.calls.includes("release"), false);
  assert.equal((await handle.exited).cleanupConfirmed, false);
});

test("故障：写者仍存活时不等待永不结束的 exited，也不释放锁", async () => {
  state.report.leftovers.push({ pid: identity.pid, startTime: identity.startTime });
  state.noExit = true;
  const handle = await driver.start(spec);
  await assert.rejects(handle.stop(), { code: "EAGORA_STOP_INCOMPLETE" });
  const exit = await handle.exited;
  assert.equal(exit.cleanupConfirmed, false);
  assert.equal(state.calls.includes("release"), false);
});

for (const mode of ["identityAlive", "identityError"]) test(`故障：${mode} 不能释放锁`, async () => {
  state[mode] = mode === "identityError" ? new Error("受控身份查询错误") : true;
  const handle = await driver.start(spec);
  await assert.rejects(handle.stop(), (error) => {
    assert.equal(error.code, "EAGORA_STOP_INCOMPLETE");
    assert.equal(error.stopReport, state.report);
    if (mode === "identityError") assert.equal(error.cause, state.identityError);
    return true;
  });
  assert.equal(state.calls.includes("release"), false);
  assert.equal((await handle.exited).cleanupConfirmed, false);
});

for (const key of ["updateError", "releaseError", "stopError"]) test(`故障：${key} 返回未确认退出且保留错误`, async () => {
  state[key] = new Error(`受控 ${key}`);
  const handle = await driver.start(spec);
  await assert.rejects(handle.stop(), state[key]);
  const exit = await handle.exited;
  assert.equal(exit.cleanupConfirmed, false);
  assert.match(exit.error, new RegExp(key));
  assert.ok(state.calls.includes("stop"), "写停止状态失败仍须尝试进程清理");
  if (key !== "releaseError") assert.equal(state.calls.includes("release"), false);
});

test("故障：clear_queue 失败仍继续 stop 和核对身份，不单独否决清理", async () => {
  state.clearError = new Error("受控 RPC 关闭");
  const handle = await driver.start(spec);
  await handle.stop();
  assert.equal((await handle.exited).cleanupConfirmed, true);
  assert.ok(state.calls.includes("stop"));
  assert.ok(handle.diagnostics().events.some((event) => event.type === "driver_clear_queue_failed"));
});

for (const step of ["snapshot", "snapshot cleanup", "verify"]) test(`恢复：${step} 失败的 recoveryReports 不得放行新写者`, async () => {
  state.recoveryResult = "stopped";
  state.recoveryReports.push(report({ steps: [{ step, ok: false, at: "测试时间", detail: "受控恢复探测错误" }] }));
  await assert.rejects(driver.start(spec), (error) => {
    assert.equal(error.code, "EAGORA_RECOVERY_FAILED");
    assert.equal(error.stopReport, state.recoveryReports[0]);
    return true;
  });
  assert.equal(state.calls.includes("spawnWriter"), false);
  assert.equal(state.calls.includes("release"), false);
  await assert.rejects(driver.start(spec), { code: "EAGORA_RECOVERY_PENDING" });
});

test("恢复：失败报告附具体coverage与steps，原身份重试成功后才允许启动", async () => {
  state.report.steps.push({ step: "snapshot", ok: false, at: "测试时间", detail: "受控恢复失败" });
  await assert.rejects(driver.recoverOldRun(identity, spec.sessionFile), (error) => {
    assert.equal(error.stopReport, state.report);
    assert.equal(error.identity, identity);
    return true;
  });
  await assert.rejects(driver.start(spec), { code: "EAGORA_RECOVERY_PENDING" });
  state.report = report();
  await driver.recoverOldRun(identity, spec.sessionFile);
  const handle = await driver.start(spec);
  await handle.stop();
});

test("恢复：同一身份并发调用共享清理，多个旧身份全部确认后才放行", async () => {
  const first = deferred(), second = deferred();
  const other = { ...identity, pid: identity.pid + 1 };
  state.oldBarriers.set(identity.pid, first);
  state.oldBarriers.set(other.pid, second);
  const one = driver.recoverOldRun(identity, spec.sessionFile);
  const duplicate = driver.recoverOldRun(identity, spec.sessionFile);
  const two = driver.recoverOldRun(other, spec.sessionFile);
  assert.equal(state.calls.filter((call) => call === `stopByIdentity:${identity.pid}`).length, 1);
  first.resolve();
  await Promise.all([one, duplicate]);
  await assert.rejects(driver.start(spec), { code: "EAGORA_RECOVERY_PENDING" });
  second.resolve(); await two;
  const handle = await driver.start(spec);
  await handle.stop();
});

test("恢复：另一个旧身份失败后不能被成功的身份提前清除屏障", async () => {
  const other = { ...identity, pid: identity.pid + 1 };
  const barrier = deferred();
  state.oldBarriers.set(identity.pid, barrier);
  state.oldReports.set(other.pid, report({ leftovers: [{ pid: other.pid, startTime: other.startTime }] }));
  const one = driver.recoverOldRun(identity, spec.sessionFile);
  await assert.rejects(driver.recoverOldRun(other, spec.sessionFile), { code: "EAGORA_STOP_INCOMPLETE" });
  barrier.resolve(); await one;
  await assert.rejects(driver.start(spec), { code: "EAGORA_RECOVERY_PENDING" });
  state.oldReports.delete(other.pid);
  await driver.recoverOldRun(other, spec.sessionFile);
  const handle = await driver.start(spec);
  await handle.stop();
});

test("恢复：start 等待定位 pi 时启动的旧身份清理也会阻止 spawnWriter", async () => {
  state.locateBarrier = deferred();
  const starting = driver.start(spec);
  const barrier = deferred();
  state.oldBarriers.set(identity.pid, barrier);
  const recovering = driver.recoverOldRun(identity, spec.sessionFile);
  state.locateBarrier.resolve();
  await assert.rejects(starting, { code: "EAGORA_RECOVERY_PENDING" });
  assert.equal(state.calls.includes("spawnWriter"), false);
  assert.ok(state.calls.includes("release"), "已取得且没有写者的锁应释放");
  barrier.resolve(); await recovering;
});

for (const [name, patch] of [["未知覆盖范围", { coverage: "未知覆盖范围" }], ["遗留后代", { leftovers: [{ pid: 23456, startTime: "测试创建时间" }] }]]) {
  test(`恢复：${name} 的 recoveryReports 保留锁并拒绝 spawnWriter`, async () => {
    state.recoveryReports.push(report(patch));
    await assert.rejects(driver.start(spec), { code: "EAGORA_RECOVERY_FAILED" });
    assert.equal(state.calls.includes("spawnWriter"), false);
    assert.equal(state.calls.includes("release"), false);
  });
}

test("停止：清理所有待处理 UI，调用顺序为 clear_queue、stop、身份核对、release", async () => {
  driver = new RpcSubprocessDriver({ home: path.join(root, "pending-ui"), extensionPath: path.join(root, "extension.ts"), childUiPolicy: "pending" });
  const handle = await driver.start(spec);
  handle.markReady();
  state.ui({ type: "extension_ui_request", id: "待回应的 editor", method: "editor" });
  assert.deepEqual(state.uiResponses, []);
  await handle.stop();
  assert.deepEqual(state.uiResponses, [{ id: "待回应的 editor", cancelled: true }]);
  assert.equal((await handle.exited).cleanupConfirmed, true);
});

test("启动：spawn 与 release 同时失败时保留两份原因", async () => {
  state.spawnError = new Error("受控启动失败");
  state.releaseError = new Error("受控释放失败");
  await assert.rejects(driver.start(spec), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [state.spawnError, state.releaseError]);
    return true;
  });
});

test("启动：参数只有只读内置工具，子进程环境不包含 AGORA_HOME", async () => {
  const handle = await driver.start({ ...spec, env: { AGORA_HOME: "不能传给子进程", agora_home: "不能传给子进程", AGORA_URL: "http://127.0.0.1:1234", AGORA_LAUNCH_TICKET: "测试 ticket" } });
  const argv = state.spawnSpec.argv;
  assert.equal(argv[argv.indexOf("--tools") + 1], "read,grep,find,ls,agora_*");
  for (const flag of ["--no-approve", "-ne", "-ns", "-np"]) assert.ok(argv.includes(flag));
  assert.equal(state.spawnSpec.env.AGORA_HOME, undefined);
  assert.equal(state.spawnSpec.env.agora_home, undefined);
  assert.equal(state.spawnSpec.env.AGORA_LAUNCH_TICKET, "测试 ticket");
  await handle.stop();
});

test("启动：spawnWriter 失败时核对释放，不向 daemon 返回可用 handle", async () => {
  state.spawnError = new Error("受控门闩写入失败");
  await assert.rejects(driver.start(spec), state.spawnError);
  assert.ok(state.calls.includes("release"));
  assert.deepEqual(state.recoveryOptions, { abortTimeoutMs: 0, graceMs: 0, termGraceMs: 0 });
});
