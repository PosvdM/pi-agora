import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import * as hostkit from "pi-hostkit";

// 在内存中加载源文件，不生成 dist，也不启动 provider 或子进程。
const pi = await hostkit.locatePi(process.env.D15_PI_PATH ? { piPath: process.env.D15_PI_PATH } : {});
assert.equal(pi.supported, true);
const launches = [];
let current;
const bridge = {
  ...hostkit,
  locatePi: async () => pi,
  isSameProcess: async () => "gone",
  acquireSessionWriterLock: async () => ({
    recoveryReports: [],
    recoverPreviousWriter: async () => "clean",
    update: async () => {},
    release: async () => {},
    spawnWriter: async (options) => {
      launches.push(options);
      const listeners = new Set();
      let exit;
      const exited = new Promise((resolve) => { exit = resolve; });
      const proc = {
        identity: { pid: 123, startTime: "fake", instanceId: options.instanceId },
        exited,
        rpc: {
          onEvent: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
          onUiRequest: () => () => {},
          onError: () => () => {},
          closed: new Promise(() => {}),
          send: async () => ({ type: "response", success: true }),
          respondUi: () => {},
        },
        stderrTail: () => "",
        stop: async () => {
          exit({ code: 0, signal: null });
          return { coverage: "snapshot_visible", steps: [], leftovers: [] };
        },
      };
      current = { push: (event) => { for (const listener of listeners) listener(event); } };
      return proc;
    },
  }),
  isSessionWriterLock: () => true,
};
const globalKey = `__driver_d15_${process.pid}`;
globalThis[globalKey] = bridge;
const mockSource = Object.keys(bridge).map((name) => `export const ${name} = globalThis[${JSON.stringify(globalKey)}][${JSON.stringify(name)}];`).join("\n");
const mockUrl = `data:text/javascript;base64,${Buffer.from(mockSource).toString("base64")}`;
const driverSource = await readFile(new URL("../packages/daemon/src/driver.ts", import.meta.url), "utf8");
const compiled = stripTypeScriptTypes(driverSource, { mode: "transform" }).replace('from "pi-hostkit"', `from ${JSON.stringify(mockUrl)}`);
const { RpcSubprocessDriver, normalizePiEvent } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
delete globalThis[globalKey];

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "agora-driver-d15-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "project");
  await mkdir(agentDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  const options = { home: path.join(root, "home"), extensionPath: "managed-extension.ts", env: { PI_CODING_AGENT_DIR: agentDir } };
  return {
    root, agentDir, cwd, options,
    driver: new RpcSubprocessDriver(options),
    skill: async (directory, name) => {
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: Offline fixture.\n---\nFixture instructions.\n`);
      return realpath(directory);
    },
    start: async (extra = {}) => {
      const driver = new RpcSubprocessDriver(options);
      const handle = await driver.start({ agoraSessionId: "session", runId: "run", instanceId: "d15", cwd,
        model: "fake/offline", thinking: "off", profile: "explore", sessionFile: path.join(root, "session.jsonl"), env: {}, ...extra });
      t.after(() => handle.stop());
      handle.markReady();
      return handle;
    },
  };
}
const now = Date.parse("2026-10-20T12:00:00.000Z");
const assistant = (fields = {}) => ({ type: "message_end", message: { role: "assistant", timestamp: now, stopReason: "stop", ...fields } });
const quota = (errorMessage, fields = {}) => normalizePiEvent(assistant({ stopReason: "error", errorMessage, ...fields }), "fallback", now).find((event) => event.type === "quota_exhausted");

test("D15：CLI 保留 -ns，仅为显式名单增加 --skill 目录参数", async (t) => {
  const f = await fixture(t);
  const a = await f.skill(path.join(f.root, "skill with spaces"), "alpha");
  const b = await f.skill(path.join(f.root, "beta"), "beta");
  await f.start({ skillPaths: [a, b] });
  const argv = launches.at(-1).argv;
  assert.ok(argv.includes("-ns"));
  assert.deepEqual(argv.slice(argv.indexOf("--skill")), ["--skill", a, "--skill", b]);
  await f.start({ runId: "empty" });
  assert.ok(launches.at(-1).argv.includes("-ns"));
  assert.equal(launches.at(-1).argv.includes("--skill"), false);
});

test("D15：默认仅查用户全局 skills，忽略项目 skills 和项目 settings", async (t) => {
  const f = await fixture(t);
  const user = await f.skill(path.join(f.agentDir, "skills", "alpha"), "alpha");
  await f.skill(path.join(f.cwd, ".pi", "skills", "alpha"), "alpha");
  await f.skill(path.join(f.cwd, ".pi", "skills", "project-only"), "project-only");
  await writeFile(path.join(f.cwd, ".pi", "settings.json"), JSON.stringify({ skills: [path.join(f.cwd, ".pi", "skills")] }));
  assert.deepEqual(await f.driver.resolveSkills(["alpha"]), [{ name: "alpha", path: user }]);
  await assert.rejects(f.driver.resolveSkills(["project-only"]), { code: "EAGORA_SKILL_NOT_FOUND" });
  await assert.rejects(f.driver.resolveSkills(["missing"]), { code: "EAGORA_SKILL_NOT_FOUND" });
});

test("D15：用户 settings 支持相对 agentDir 的目录与 SKILL.md，返回 canonical 目录", async (t) => {
  const f = await fixture(t);
  const alpha = await f.skill(path.join(f.agentDir, "configured", "alpha"), "alpha");
  const beta = await f.skill(path.join(f.agentDir, "single"), "beta");
  const alias = path.join(f.agentDir, "alias");
  await symlink(alpha, alias, process.platform === "win32" ? "junction" : "dir");
  await writeFile(path.join(f.agentDir, "settings.json"), JSON.stringify({ skills: ["configured", "single/SKILL.md", "alias"] }));
  assert.deepEqual(await f.driver.resolveSkills(["beta", "alpha"]), [{ name: "beta", path: beta }, { name: "alpha", path: alpha }]);
});

test("D15：显式 skillDirectories 排除全局目录和 settings；空列表不加载技能", async (t) => {
  const f = await fixture(t);
  const selected = await f.skill(path.join(f.agentDir, "chosen", "alpha"), "alpha");
  await f.skill(path.join(f.agentDir, "skills", "alpha"), "alpha");
  await f.skill(path.join(f.agentDir, "settings-only"), "settings-only");
  await writeFile(path.join(f.agentDir, "settings.json"), JSON.stringify({ skills: ["settings-only"] }));
  const driver = new RpcSubprocessDriver({ ...f.options, skillDirectories: ["chosen"] });
  assert.deepEqual(await driver.resolveSkills(["alpha"]), [{ name: "alpha", path: selected }]);
  await assert.rejects(driver.resolveSkills(["settings-only"]), { code: "EAGORA_SKILL_NOT_FOUND" });
  const empty = new RpcSubprocessDriver({ ...f.options, skillDirectories: [] });
  await assert.rejects(empty.resolveSkills(["alpha"]), { code: "EAGORA_SKILL_NOT_FOUND" });
  assert.deepEqual(await empty.resolveSkills([]), []);
});

test("D15：PI_CODING_AGENT_DIR 环境覆盖用户 agentDir", async (t) => {
  const f = await fixture(t);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = f.agentDir;
  t.after(() => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; });
  const alpha = await f.skill(path.join(f.agentDir, "skills", "alpha"), "alpha");
  const driver = new RpcSubprocessDriver({ home: f.options.home });
  assert.deepEqual(await driver.resolveSkills(["alpha"]), [{ name: "alpha", path: alpha }]);
});

test("D15：不同 canonical 目录的同名技能报歧义；拒绝非法名", async (t) => {
  const f = await fixture(t);
  await f.skill(path.join(f.agentDir, "skills", "one"), "alpha");
  await f.skill(path.join(f.agentDir, "skills", "two"), "alpha");
  await assert.rejects(f.driver.resolveSkills(["alpha"]), { code: "EAGORA_SKILL_AMBIGUOUS" });
  for (const name of ["", "../alpha", "Alpha", "a/b", "a\\b", "-alpha", "alpha-", "a--b", "a_b", "a".repeat(65), "alpha\0"]) {
    await assert.rejects(f.driver.resolveSkills([name]), { code: "EINVAL" });
  }
});

test("D15：规范化真实 pi usage 字段，reasoning 不重复计入 output/context", () => {
  const input = assistant({ id: "provider-message", usage: { input: 10, output: 25, cacheRead: 30, cacheWrite: 40, reasoning: 5, totalTokens: 105 } });
  const snapshot = structuredClone(input);
  assert.deepEqual(normalizePiEvent(input, "fallback", now), [{ type: "usage_record", requestId: "provider-message",
    inputTokens: 10, cacheReadTokens: 30, cacheWriteTokens: 40, outputTokens: 25, reasoningTokens: 5, contextTokens: 80 }]);
  assert.deepEqual(input, snapshot);
  const [empty] = normalizePiEvent(assistant({ usage: { input: -1, output: Infinity, cacheRead: "20", cacheWrite: NaN } }), "message-2", now);
  assert.deepEqual(empty, { type: "usage_record", requestId: "message-2", inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0, contextTokens: 0 });
  assert.deepEqual(normalizePiEvent({ type: "message_end", message: { role: "user" } }, "unused", now), []);
  assert.deepEqual(normalizePiEvent({ type: "message_update", message: { role: "assistant" } }, "unused", now), []);
});

test("D15：429 兼容 pi status+JSON 字符串、结构错误和纯字符串额度码", () => {
  for (const reason of ["usage_limit_reached", "quota_exceeded", "insufficient_quota"]) {
    assert.deepEqual(quota(`429: ${JSON.stringify({ error: { type: reason, resets_at: 1792498500 } })}`), {
      type: "quota_exhausted", reason, resumeAt: new Date(1792498500000).toISOString(),
    });
    assert.deepEqual(quota({ status: 429, error: reason }), { type: "quota_exhausted", reason, resumeAt: null });
    assert.deepEqual(quota(`HTTP 429 ${reason}`), { type: "quota_exhausted", reason, resumeAt: null });
    assert.deepEqual(quota(`Provider error (429): ${reason}`), { type: "quota_exhausted", reason, resumeAt: null });
  }
  assert.equal(quota(undefined, { error: { statusCode: 429, body: { code: "quota_exceeded", reset_at: "2026-10-21T12:00:00Z" } } }).resumeAt, "2026-10-21T12:00:00.000Z");
  assert.equal(quota("usage_limit_reached", { status: 429 }).resumeAt, null);
});

test("D15：重置时间支持 ISO、epoch 秒/毫秒和相对 retry_after", () => {
  for (const [key, value, expected] of [
    ["resets_at", 1792498500, new Date(1792498500000).toISOString()],
    ["reset_at", "1792498500000", new Date(1792498500000).toISOString()],
    ["resetAt", "2026-10-21T14:00:00+02:00", "2026-10-21T12:00:00.000Z"],
    ["retry_after", 60, "2026-10-20T12:01:00.000Z"],
    ["retry_after", "2026-10-21T12:00:00Z", "2026-10-21T12:00:00.000Z"],
    ["resets_at", "unknown", null],
    ["retry_after", -10, null],
  ]) {
    assert.equal(quota(JSON.stringify({ status: 429, error: { code: "quota_exceeded", [key]: value } })).resumeAt, expected);
  }
  assert.equal(quota("429 quota_exceeded resets at 2026-10-21T12:00:00Z").resumeAt, "2026-10-21T12:00:00.000Z");
  assert.equal(quota("429 quota_exceeded reset_at=1792498500").resumeAt, new Date(1792498500000).toISOString());
  assert.equal(quota("429 quota_exceeded Try again in ~20 min.").resumeAt, null);
});

test("D15：普通 429、非 429、非 error 和信息丢失的 Codex 友好提示不推断额度", () => {
  for (const text of ["429 Too Many Requests", '429: {"error":{"code":"rate_limit_exceeded","retry_after":60}}',
    "403 insufficient_quota", '403: {"error":{"code":"quota_exceeded","retry_after":429}}',
    "usage_limit_reached", "You have hit your ChatGPT usage limit. Try again in ~20 min.", "429 not_quota_exceeded"]) {
    assert.equal(quota(text), undefined);
  }
  assert.equal(quota("429 quota_exceeded", { stopReason: "aborted" }), undefined);
});

test("D15：handle 先发送 normalized events，再发送原 message_end；重复消息只计量一次", async (t) => {
  const f = await fixture(t);
  const handle = await f.start();
  const observed = [];
  handle.onEvent((event) => observed.push(event));
  const original = assistant({ id: "same-id", stopReason: "error", errorMessage: "429 usage_limit_reached" });
  current.push(original);
  current.push(structuredClone(original));
  const noId = assistant({ timestamp: now + 1 });
  current.push(noId);
  current.push(structuredClone(noId));
  current.push(assistant({ timestamp: now + 2 }));
  assert.deepEqual(observed.map((event) => event.type), ["usage_record", "quota_exhausted", "message_end", "message_end",
    "usage_record", "message_end", "message_end", "usage_record", "message_end"]);
  assert.equal(observed[2], original);
  assert.deepEqual(observed.filter((event) => event.type === "usage_record").map((event) => event.requestId), ["same-id", "message-2", "message-3"]);
  assert.equal(handle.diagnostics().events.filter((event) => event.type === "usage_record").length, 3);
});
