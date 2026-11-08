import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import * as compatibility from "../packages/daemon/dist/driver.js";
import * as pi from "../packages/daemon/dist/harness/pi/driver.js";
import { buildPiArgv } from "../packages/daemon/dist/harness/pi/launch.js";
import { normalizePiEvent } from "../packages/daemon/dist/harness/pi/events.js";

const spec = {
  agoraSessionId: "session", runId: "run", instanceId: "instance", cwd: path.resolve("project"),
  model: "provider/model", thinking: "high", profile: "explore",
  sessionFile: path.resolve("session with spaces", "session.jsonl"), env: {},
};

test("Harness：既有 driver 导出与 pi 适配实现保持一致", () => {
  assert.deepEqual(Object.keys(compatibility).sort(), Object.keys(pi).sort());
  assert.equal(compatibility.RpcSubprocessDriver, pi.RpcSubprocessDriver);
  assert.equal(compatibility.normalizePiEvent, normalizePiEvent);
  assert.equal(compatibility.DEFAULT_CHILD_UI_TIMEOUT_MS, 600_000);
});

test("Harness：pi 参数保持顺序、隔离开关与原始路径，不修改启动规格", () => {
  const input = { ...spec, tools: ["read", "agora_task"], skillPaths: ["skill with spaces", "第二个技能"] };
  const snapshot = structuredClone(input);
  assert.deepEqual(buildPiArgv("pi cli.js", input, "managed extension.ts", ["fake provider.ts"]), [
    "pi cli.js", "--mode", "rpc", "--session-dir", path.dirname(spec.sessionFile),
    "--session", spec.sessionFile, "--model", "provider/model", "--thinking", "high",
    "--tools", "read,agora_task", "-ne", "--no-mcp", "-ns", "-np", "--no-approve",
    "-e", "managed extension.ts", "-e", "fake provider.ts", "--skill", "skill with spaces", "--skill", "第二个技能",
  ]);
  assert.deepEqual(input, snapshot);
  const defaults = buildPiArgv("cli.js", spec, "extension.ts");
  assert.equal(defaults[defaults.indexOf("--tools") + 1], "read,grep,find,ls,agora_*");
  assert.equal(defaults.includes("--skill"), false);
  const empty = buildPiArgv("cli.js", { ...spec, tools: [] }, "extension.ts");
  assert.equal(empty[empty.indexOf("--tools") + 1], "");
});

test("Harness：pi 事件输出中立的逐请求用量和额度事件，顺序不变", () => {
  const message = { type: "message_end", message: { role: "assistant", id: "request-id", stopReason: "error",
    usage: { input: 10, cacheRead: 3, cacheWrite: 2, output: 4, reasoning: 1 },
    errorMessage: '429 {"error":{"code":"quota_exceeded","retry_after":60}}' } };
  const snapshot = structuredClone(message);
  assert.deepEqual(normalizePiEvent(message, "fallback", Date.parse("2026-11-08T00:00:00Z")), [
    { type: "usage_record", requestId: "request-id", inputTokens: 10, cacheReadTokens: 3, cacheWriteTokens: 2,
      outputTokens: 4, reasoningTokens: 1, contextTokens: 15 },
    { type: "quota_exhausted", reason: "quota_exceeded", resumeAt: "2026-11-08T00:01:00.000Z" },
  ]);
  assert.deepEqual(message, snapshot);
});

test("Harness：中立类型不依赖 pi、hostkit 或旧驱动入口", async () => {
  const source = await readFile(new URL("../packages/daemon/src/harness/types.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\b(?:import|export)\s+(?:type\s+)?[^;]*\bfrom\s*["']/);
  assert.doesNotMatch(source, /Rpc(?:Command|Event|Response)|pi-hostkit|piSessionId/);
});
