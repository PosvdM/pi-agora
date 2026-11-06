import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { spawnManaged } from "pi-hostkit";
import { startDaemon, RpcSubprocessDriver } from "../packages/daemon/dist/index.js";
import { piFixture, providerPath, containment, until } from "./fixtures/driver-helpers.mjs";

const extensionPath = fileURLToPath(new URL("../packages/extension/dist/index.js", import.meta.url));
const mainProvider = fileURLToPath(new URL("./fixtures/e2e-main-provider.ts", import.meta.url));

test("真实 pi 1.5.0 主会话派出只读子代理，收到持久通知后自动取回结果", { timeout: 120_000 }, async () => {
  const f = await piFixture({ turns: [
    { segments: [{ type: "toolCall", name: "read", arguments: { path: "evidence.txt" } }] },
    { segments: [{ type: "text", text: "子代理结果：只读检查通过" }] },
  ] });
  const home = path.join(f.root, "agora");
  const mainSession = f.sessionPath("main");
  const mainLog = path.join(f.root, "main-requests.jsonl");
  await writeFile(path.join(f.cwd, "evidence.txt"), "待核对的只读内容\n");
  let daemon, main;
  try {
    const driver = new RpcSubprocessDriver({ home, piPath: f.install.packageDir, extensionPath,
      env: f.env, extraExtensions: [providerPath], containment });
    daemon = await startDaemon({ home, driver });
    main = await spawnManaged({ argv: [f.install.cliEntry, "--mode", "rpc", "--offline", "--session", mainSession,
      "--model", "agora-e2e/scripted", "--thinking", "high", "--tools", "agora_task", "-ne", "-ns", "-np", "--no-themes", "--no-approve",
      "-e", extensionPath, "-e", mainProvider], cwd: f.cwd,
      env: { ...f.env, AGORA_HOME: home, E2E_MAIN_REQUEST_LOG: mainLog }, runId: "e2e-main", instanceId: "e2e-host", containment });
    main.rpc.onUiRequest((request) => { if (request.id) main.rpc.respondUi({ id: request.id, cancelled: true }); });
    await main.rpc.send({ type: "get_state" }, { timeoutMs: 30_000 });
    await main.rpc.send({ type: "prompt", message: "请派一个只读子代理检查 evidence.txt，完成后取得结果。" });
    let lastText;
    await until(async () => {
      const response = await main.rpc.send({ type: "get_last_assistant_text" }, { timeoutMs: 10_000 });
      lastText = response.data?.text ?? "";
      return lastText.includes("主会话已获取结果") && lastText.includes("只读检查通过");
    }, 80_000, 100);
    assert.match(lastText, /只读检查通过/);
    const entries = (await main.rpc.send({ type: "get_entries" })).data.entries;
    const principal = entries.find((entry) => entry.type === "custom" && entry.customType === "agora-principal");
    assert.ok(principal?.data?.principalId, "主会话必须持久记录 principal 引用");
    const notices = entries.filter((entry) => entry.type === "custom_message" && entry.customType === "agora:notice");
    assert.equal(notices.length, 1);
    const key = notices[0].details.dedupeKey;
    await until(async () => {
      const db = new DatabaseSync(path.join(home, "agora.db"), { readOnly: true });
      try { return db.prepare("SELECT acked_at FROM outbox WHERE dedupe_key=?").get(key)?.acked_at; }
      finally { db.close(); }
    });
    const onDisk = (await readFile(mainSession, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(onDisk.filter((entry) => entry.type === "custom_message" && entry.details?.dedupeKey === key).length, 1);
    assert.equal(await readFile(path.join(f.cwd, "evidence.txt"), "utf8"), "待核对的只读内容\n");
    const requests = (await readFile(mainLog, "utf8")).trim().split("\n").map(JSON.parse);
    assert.ok(requests.some(({ content }) => content.some((block) => block.type === "toolCall" && block.arguments.action === "result")), "完成通知必须触发主会话调用 result");
    const childRequests = (await readFile(f.env.FAKE_REQUEST_LOG, "utf8")).trim().split("\n").map(JSON.parse).filter((entry) => entry.kind === "request");
    assert.ok(childRequests.length >= 2);
    const tools = childRequests[0].tools.map((tool) => tool.name).sort();
    assert.deepEqual(tools, ["find", "grep", "ls", "read"]);
  } finally {
    if (main) { await main.rpc.send({ type: "clear_queue" }, { timeoutMs: 1000 }).catch(() => {}); await main.stop({ abortTimeoutMs: 1000, graceMs: 500, termGraceMs: 500 }); }
    if (daemon) await daemon.close({ force: true, timeoutMs: 1000 });
    await f.cleanup();
  }
});
