import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { isSameProcess, linuxCgroupSupport, probeSessionWriterLock, stopByIdentity } from "pi-hostkit";
import { DEFAULT_CHILD_UI_TIMEOUT_MS, RpcSubprocessDriver } from "../packages/daemon/dist/driver.js";
import { containment, delay, extensionPath, here, isWin, piFixture, providerPath, until, waitForEvent } from "./fixtures/driver-helpers.mjs";

const FAST_STOP = { abortTimeoutMs: 150, graceMs: 150, termGraceMs: 150 };
const records = (file) => existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
async function setup(t, script, extra = {}) {
  const f = await piFixture(script);
  t.diagnostic(`隔离现场：${f.root}`);
  const options = { home: path.join(f.root, "agora"), piPath: f.install.packageDir,
    extensionPath, extraExtensions: [providerPath], containment, snapshotIntervalMs: 50,
    stopOptions: FAST_STOP, ...extra };
  const driver = new RpcSubprocessDriver(options);
  const handles = [];
  const spec = { agoraSessionId: "session", runId: "run", instanceId: "driver-test", cwd: f.cwd,
    model: "p0-fake/scripted", thinking: "off", profile: "explore", sessionFile: f.sessionPath("driver"), env: f.env };
  t.after(async () => {
    for (const handle of handles) await handle.stop(FAST_STOP);
    await f.cleanup();
  });
  return { f, options, driver, spec, handles,
    async start(overrides = {}, ready = true) {
      const handle = await driver.start({ ...spec, ...overrides });
      handles.push(handle);
      assert.equal((await handle.send({ type: "get_state" })).success, true);
      if (ready) handle.markReady();
      return handle;
    },
  };
}
async function assertCoverage(report) {
  const scope = process.platform === "linux" && containment === "auto" && await linuxCgroupSupport();
  assert.equal(report.coverage, isWin ? "job_object" : scope ? "cgroup" : "snapshot_visible");
  assert.deepEqual(report.leftovers, []);
  assert.equal(report.steps.find((step) => step.step === "verify")?.ok, true);
}

test("真实 pi：写锁竞争、就绪门槛、会话替换禁用和幂等停止", { timeout: 45_000 }, async (t) => {
  const s = await setup(t);
  const handle = await s.start({}, false);
  await assert.rejects(handle.send({ type: "prompt", message: "禁止提前发送" }), { code: "EAGORA_NOT_READY" });
  await assert.rejects(handle.send({ type: "switch_session", sessionPath: "其他会话" }), { code: "EAGORA_RPC_FORBIDDEN" });
  await assert.rejects(handle.stop({ graceMs: Infinity }), { code: "EINVAL" });
  assert.equal((await handle.send({ type: "get_state" })).success, true);
  await assert.rejects(s.driver.start({ ...s.spec, runId: "competitor" }), { code: "EAGORA_SESSION_BUSY" });
  handle.markReady();
  const [a, b] = await Promise.all([handle.stop(FAST_STOP), handle.stop(FAST_STOP)]);
  assert.equal(a, b);
  await assertCoverage(a);
  assert.equal((await probeSessionWriterLock(s.spec.sessionFile)).held, false);
  const next = await s.start({ runId: "next" });
  assert.notEqual(next.identity.pid, handle.identity.pid);
});

test("真实 pi：忽略 abort 的工具仍被停止，并记录工具现场和覆盖范围", { timeout: 45_000 }, async (t) => {
  const s = await setup(t, { turns: [{ segments: [{ type: "toolCall", name: "agora_test_hang", arguments: {} }] }] });
  const handle = await s.start();
  const tool = waitForEvent(handle, (event) => event.type === "tool_execution_start");
  await handle.send({ type: "prompt", message: "运行受控阻塞工具" });
  await tool;
  await until(() => records(path.join(s.f.root, "extension.jsonl")).some((entry) => entry.type === "hang_started"));
  const report = await handle.stop(FAST_STOP);
  await assertCoverage(report);
  assert.equal(report.steps.find((step) => step.step === "abort").ok, false);
  assert.equal(await isSameProcess(handle.identity), "gone");
  const diagnostic = JSON.parse(readFileSync((await handle.exited).diagnosticsPath, "utf8"));
  assert.equal(diagnostic.activeTools[0].toolName, "agora_test_hang");
  assert.ok(diagnostic.activeTools[0].startedAt);
  assert.equal(diagnostic.possibleSideEffects.length, 1);
  assert.deepEqual(diagnostic.stopReport, report);
  if (report.coverage === "snapshot_visible") assert.equal(diagnostic.warnings.length, 1);
});

test("真实 pi：shell 与脱离进程组的孙进程都退出，独立核对身份", { timeout: 45_000 }, async (t) => {
  const s = await setup(t);
  const oracle = path.join(s.f.root, "descendants.jsonl");
  const slash = (file) => file.replaceAll("\\", "/");
  const command = `"${slash(process.execPath)}" "${slash(path.join(here, "driver-descendant.mjs"))}" "${slash(oracle)}" & wait`;
  await s.f.setScript({ turns: [{ segments: [{ type: "toolCall", name: "agora_test_shell", arguments: { command } }] }] });
  const handle = await s.start();
  let identities = [];
  try {
    await handle.send({ type: "prompt", message: "运行受控 shell 树" });
    identities = await until(() => { const rows = records(oracle); return rows.length >= 2 ? rows : undefined; }, 20_000);
    // 让快照模式至少经历两个采样周期；独立 oracle 不参与驱动的清理算法。
    await delay(200);
    assert.equal((await handle.send({ type: "get_state" })).data.isStreaming, true);
    const report = await handle.stop(FAST_STOP);
    await assertCoverage(report);
    assert.equal(report.steps.find((step) => step.step === "abort").ok, false);
    for (const identity of identities) assert.equal(await isSameProcess(identity), "gone");
  } finally {
    await handle.stop(FAST_STOP);
    for (const identity of identities) if (await isSameProcess(identity) === "alive") await stopByIdentity(identity, FAST_STOP);
  }
});

test("真实 pi：忽略 abort 的 provider 在清队列后终止，排队文字未执行", { timeout: 45_000 }, async (t) => {
  const s = await setup(t, { turns: [{ ignoreAbort: true, segments: [{ type: "hang" }] }] });
  const handle = await s.start();
  await handle.send({ type: "prompt", message: "阻塞模型" });
  const log = path.join(s.f.root, "requests.jsonl");
  await until(() => records(log).some((entry) => entry.kind === "hang"));
  await handle.send({ type: "steer", message: "不能运行的 steer" });
  await handle.send({ type: "follow_up", message: "不能运行的 follow_up" });
  await assertCoverage(await handle.stop(FAST_STOP));
  assert.equal(records(log).filter((entry) => entry.kind === "request").length, 1);
  assert.equal(await isSameProcess(handle.identity), "gone");
});

for (const policy of ["cancel", "pending"]) test(`真实 pi：扩展 UI ${policy} 不会无限等待`, { timeout: 45_000 }, async (t) => {
  assert.equal(DEFAULT_CHILD_UI_TIMEOUT_MS, 600_000);
  const s = await setup(t, undefined, { childUiPolicy: policy, childUiTimeoutMs: 40 });
  const handle = await s.start();
  const observed = [];
  handle.onEvent((event) => { if (event.type === "extension_ui_request") observed.push(event); });
  const response = await handle.send({ type: "prompt", message: "/driver-ui" });
  assert.equal(response.success, true);
  const result = records(path.join(s.f.root, "extension.jsonl")).find((entry) => entry.type === "ui_result");
  assert.deepEqual(result, { type: "ui_result", select: null, confirm: false, input: null, editor: null });
  assert.deepEqual(observed.map((event) => event.method), ["select", "confirm", "input", "editor"]);
  assert.throws(() => handle.respondUi({ id: observed[0].id, confirmed: true }), { code: "EAGORA_UI_EXPIRED" });
});

test("真实 pi：pending UI 可手动回应；就绪前 UI 固定取消", { timeout: 45_000 }, async (t) => {
  const s = await setup(t, undefined, { childUiPolicy: "pending" });
  const handle = await s.start({ env: { ...s.f.env, DRIVER_TEST_PRE_READY_UI: "1" } }, false);
  await until(() => existsSync(path.join(s.f.root, "pre-ready-ui.json")));
  assert.deepEqual(JSON.parse(readFileSync(path.join(s.f.root, "pre-ready-ui.json"), "utf8")), { value: false });
  handle.markReady();
  handle.onEvent((event) => {
    if (event.type !== "extension_ui_request") return;
    const fields = { select: { value: "乙" }, confirm: { confirmed: true }, input: { value: "输入值" }, editor: { value: "编辑值" } }[event.method];
    if (fields) handle.respondUi({ id: event.id, ...fields });
  });
  assert.equal((await handle.send({ type: "prompt", message: "/driver-ui" })).success, true);
  assert.deepEqual(records(path.join(s.f.root, "extension.jsonl")).at(-1), {
    type: "ui_result", select: "乙", confirm: true, input: "输入值", editor: "编辑值",
  });
});

test("真实 pi：ready 超时禁止任务书并留下诊断", { timeout: 45_000 }, async (t) => {
  const s = await setup(t, undefined, { readyTimeoutMs: 2_000 });
  const handle = await s.start({}, false);
  const exit = await handle.exited;
  assert.equal(exit.reason, "就绪超时");
  assert.equal(await isSameProcess(handle.identity), "gone");
  assert.equal((await probeSessionWriterLock(s.spec.sessionFile)).held, false);
  assert.equal(records(path.join(s.f.root, "requests.jsonl")).filter((entry) => entry.kind === "request").length, 0);
  assert.equal(JSON.parse(readFileSync(exit.diagnosticsPath, "utf8")).reason, "就绪超时");
});

test("真实 pi：意外退出记录最后50事件、stderr与StopReport，订阅只通知一次", { timeout: 45_000 }, async (t) => {
  const s = await setup(t);
  const handle = await s.start();
  let exits = 0;
  handle.onExit(() => { exits++; });
  await handle.send({ type: "prompt", message: "/driver-events" });
  await handle.send({ type: "prompt", message: "/driver-crash" }).catch(() => {});
  const exit = await handle.exited;
  assert.equal(exits, 1);
  assert.equal(exit.code, 17);
  const data = JSON.parse(readFileSync(exit.diagnosticsPath, "utf8"));
  assert.equal(data.events.length, 50);
  assert.match(data.stderr, /驱动崩溃诊断标记/);
  assert.ok(data.stopReport);
  assert.equal(await isSameProcess(handle.identity), "gone");
});

test("真实 pi：心跳超时会停止失去 RPC 响应的进程", { timeout: 45_000 }, async (t) => {
  const s = await setup(t, undefined, { heartbeatIntervalMs: 100, heartbeatTimeoutMs: 150 });
  const handle = await s.start();
  const prompt = handle.send({ type: "prompt", message: "/driver-block" }).catch(() => undefined);
  await until(() => existsSync(path.join(s.f.root, "rpc-blocked")));
  const exit = await handle.exited;
  await prompt;
  assert.match(exit.reason, /心跳超时或失败/);
  assert.equal(exit.cleanupConfirmed, true);
  assert.equal(await isSameProcess(handle.identity), "gone");
  await assertCoverage(exit.stopReport);
});

test("真实 pi：扩展加载失败不发送任务书并清理写者", { timeout: 45_000 }, async (t) => {
  const s = await setup(t, undefined, { extensionPath: path.join(here, "driver-failed-extension.ts") });
  const handle = await s.driver.start(s.spec);
  s.handles.push(handle);
  await assert.rejects(handle.send({ type: "get_state" }));
  const exit = await handle.exited;
  assert.equal(exit.code, 1);
  assert.equal(exit.cleanupConfirmed, true);
  assert.match(handle.diagnostics().stderr, /受控扩展加载失败/);
  assert.equal(records(path.join(s.f.root, "requests.jsonl")).filter((entry) => entry.kind === "request").length, 0);
  assert.equal((await probeSessionWriterLock(s.spec.sessionFile)).held, false);
});

test("真实 pi：扩展运行故障会停止写者并保存错误事件", { timeout: 45_000 }, async (t) => {
  const s = await setup(t);
  const handle = await s.start();
  await handle.send({ type: "prompt", message: "/driver-extension-error" }).catch(() => undefined);
  const exit = await handle.exited;
  assert.equal(exit.reason, "扩展故障");
  assert.equal(exit.cleanupConfirmed, true);
  assert.ok(handle.diagnostics().events.some((event) => event.type === "extension_error"));
});

test("真实 pi：宿主强杀后，旧身份确认停止之前不能 resume", { timeout: 60_000 }, async (t) => {
  const s = await setup(t);
  const args = { options: s.options, spec: s.spec };
  const child = spawn(process.execPath, [path.join(here, "driver-host.mjs")], {
    env: { ...s.f.env, DRIVER_HOST_ARGS: JSON.stringify(args) }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  });
  let output = "", stderr = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const childExit = new Promise((resolve) => child.once("exit", resolve));
  let identity;
  try {
    identity = await until(() => {
      if (child.exitCode !== null) throw new Error(`测试宿主提前退出：${stderr}`);
      return output.includes("\n") ? JSON.parse(output.split("\n")[0]).identity : undefined;
    }, 30_000);
    await assert.rejects(s.driver.start({ ...s.spec, runId: "contender" }), { code: "EAGORA_SESSION_BUSY" });
    child.kill("SIGKILL"); await childExit;
    if (isWin) await until(async () => await isSameProcess(identity) === "gone");
    else assert.equal(await isSameProcess(identity), "alive");
    const recovery = s.driver.recoverOldRun(identity, s.spec.sessionFile);
    await assert.rejects(s.driver.start({ ...s.spec, runId: "tooearly" }), { code: "EAGORA_RECOVERY_PENDING" });
    const report = await recovery;
    assert.deepEqual(report.leftovers, []);
    assert.equal(report.coverage, identity.cgroup ? "cgroup" : "snapshot_visible");
    assert.equal(await isSameProcess(identity), "gone");
    const resumed = await s.start({ runId: "resumed" });
    assert.notEqual(resumed.identity.pid, identity.pid);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await childExit; }
    if (identity && await isSameProcess(identity) === "alive") await stopByIdentity(identity, FAST_STOP);
  }
});
