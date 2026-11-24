import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startDaemon } from "../packages/daemon/dist/index.js";
import createPlugin from "../packages/pane-plugin/dist/plugin.js";
import { connectDaemonApi } from "../packages/pane-plugin/dist/transport.js";

async function until(work, timeout = 10_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { const result = await work(); if (result) return result; } catch {}
    await delay(20);
  }
  assert.fail("等待 daemon 与插件对齐超时");
}
function seed(store, id) {
  const at = new Date().toISOString();
  store.transaction(() => {
    store.run("INSERT INTO principals(id,type,created_at) VALUES(?,'agent:child',?)", `child-${id}`, at);
    store.run("INSERT INTO agora_sessions(id,task_id,principal_id,session_file,convener_id,profile,model,thinking,cwd,status,created_at) VALUES(?,?,?,?,?,'explore','test/model','high',?,'completed',?)", id, `task-${id}`, `child-${id}`, path.join(store.home, `${id}.jsonl`), "user", store.home, at);
    store.run("INSERT INTO tasks(id,agora_session_id,convener_id,requested_by,title,prompt,model,thinking,profile,cwd,notify,status,created_at,updated_at) VALUES(?,?,'user','host:pane',?,'任务书','test/model','high','explore',?,'silent','completed',?,?)", `task-${id}`, id, `标题 ${id}`, store.home, at, at);
    store.change("task", `task-${id}`);
  });
}
function host(dataDir) {
  const banners = new Map([["agora:security:devices-reset", { id: "agora:security:devices-reset", title: "必须保留的安全警告", persistent: true, level: "error" }]]);
  return { paneProtocol: 1, dataDir, log: { info() {}, warn() {}, error() {} }, notify() {}, panelChanged() {}, formAdded() {}, formRemoved() {},
    setBanner: value => banners.set(value.id, value), clearBanner: id => banners.delete(id), listBanners: () => [...banners.values()],
    mainSessions: { list: () => [], get: () => undefined, onChange: () => () => {}, hold: () => () => {} },
    userPresence: { devices: () => [], onDevicesChange: () => () => {}, async confirm() { throw Object.assign(new Error("没有设备"), { code: "noDevice" }); } } };
}

test("真实 daemon 变更流驱动插件树，daemon 重启后 reset 并重新收敛", { timeout: 30_000 }, async () => {
  const home = await mkdtemp(path.join(tmpdir(), "agora-pane-daemon-"));
  const driver = { async start() { throw new Error("此用例不能拉起 pi"); }, async recoverOldRun() { throw new Error("此用例没有历史运行"); } };
  let daemon, plugin;
  try {
    daemon = await startDaemon({ home, driver });
    seed(daemon.store, "one");
    const ctx = host(path.join(home, "pane-plugin"));
    plugin = createPlugin({ home, retryMs: 50, connect: () => connectDaemonApi(home) });
    await plugin.activate(ctx);
    const request = { openNodeIds: [], recentSince: "2020-01-01T00:00:00Z" };
    const initial = await plugin.tree.snapshot(request);
    assert.ok(initial.nodes.some(node => node.id === "agora:session:one"));
    const changes = [];
    plugin.tree.subscribe({ epoch: initial.epoch, revision: initial.revision }, change => changes.push(change));
    seed(daemon.store, "two");
    await until(() => changes.find(change => change.type === "upsert" && change.node.id === "agora:session:two"));
    const epoch = initial.epoch;
    await daemon.close({ force: true, timeoutMs: 1_000 }); daemon = undefined;
    await until(() => changes.some(change => change.type === "reset"));
    daemon = await startDaemon({ home, driver });
    const recovered = await until(async () => {
      if (!plugin.actions.list().length) return;
      const snapshot = await plugin.tree.snapshot(request);
      return snapshot.nodes.some(node => node.id === "agora:session:two") ? snapshot : undefined;
    });
    assert.equal(recovered.epoch, epoch, "数据库级 epoch 不因 daemon 进程重启变化");
    assert.deepEqual(recovered.nodes.filter(node => node.kind === "session").map(node => node.id).sort(), ["agora:session:one", "agora:session:two"]);
    assert.ok(recovered.revision >= initial.revision);
  } finally {
    await plugin?.deactivate();
    await daemon?.close({ force: true, timeoutMs: 1_000 });
    await rm(home, { recursive: true, force: true });
  }
});
