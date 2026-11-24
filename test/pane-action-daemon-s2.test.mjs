import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startDaemon } from "../packages/daemon/dist/index.js";
import createPlugin from "../packages/pane-plugin/dist/plugin.js";
import { connectDaemonApi } from "../packages/pane-plugin/dist/transport.js";

function host(dataDir) {
  const banners = new Map();
  return { paneProtocol: 1, dataDir, log: { info() {}, warn() {}, error() {} }, notify() {}, panelChanged() {}, formAdded() {}, formRemoved() {},
    setBanner: value => banners.set(value.id, value), clearBanner: id => banners.delete(id), listBanners: () => [...banners.values()],
    mainSessions: { list: () => [], get: () => undefined, onChange: () => () => {}, hold: () => () => {} },
    userPresence: { devices: () => [], onDevicesChange: () => () => {}, async confirm() { throw Object.assign(new Error("没有设备"), { code: "noDevice" }); } } };
}

test("插件任务动作使用真实 daemon API 路径，创建与重复查询只执行一次", { timeout: 20_000 }, async () => {
  const home = await mkdtemp(path.join(tmpdir(), "agora-pane-action-wire-"));
  let daemon, plugin;
  let starts = 0;
  const driver = { async start() { starts++; throw new Error("模拟启动失败，不拉起 pi"); }, async recoverOldRun() { throw new Error("没有历史运行"); } };
  try {
    daemon = await startDaemon({ home, driver });
    plugin = createPlugin({ home, connect: () => connectDaemonApi(home) });
    await plugin.activate(host(path.join(home, "pane-plugin")));
    const form = await plugin.actions.resolveForm("agora.task.spawn", { type: "global" });
    assert.equal(form.fields.find(field => field.id === "cwd").required, true);
    const origin = { client: "browser", connectionId: "tab", receivedAt: new Date().toISOString() };
    const inv = { actionId: "agora.task.spawn", target: { type: "global" }, formId: form.id, formRevision: form.revision, idempotencyKey: "create-once",
      input: { answers: [], fields: { model: "test/model", profile: "explore", prompt: "验证服务端动作通路", cwd: home } } };
    const result = await plugin.actions.invoke(inv, origin);
    assert.equal(result.status, "ok");
    assert.match(result.openNodeId, /^agora:session:as_/);
    assert.deepEqual(await plugin.actions.invoke(inv, origin), result);
    assert.equal(daemon.store.get("SELECT COUNT(*) AS n FROM tasks").n, 1);
    const sessionId = result.openNodeId.slice("agora:session:".length);
    const task = daemon.store.get("SELECT * FROM tasks WHERE agora_session_id=?", sessionId);
    const end = Date.now() + 5_000;
    while (daemon.store.task(task.id).status !== "failed" && Date.now() < end) await delay(10);
    assert.equal(daemon.store.task(task.id).status, "failed");
    assert.equal(starts, 1);
    const target = { type: "node", nodeId: result.openNodeId };
    const cleanup = await plugin.actions.resolveForm("agora.task.cleanup", target);
    assert.ok(cleanup, "节点动作能通过真实会话与任务详情接口解析目标");
    const stopped = await plugin.actions.invoke({ actionId: "agora.task.stop", target, idempotencyKey: "stop-once" }, origin);
    assert.equal(stopped.status, "ok");
  } finally {
    await plugin?.deactivate();
    await daemon?.close({ force: true, timeoutMs: 1_000 });
    await rm(home, { recursive: true, force: true });
  }
});
