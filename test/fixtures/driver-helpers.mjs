// 基于 pi-hostkit/test/helpers.mjs 的隔离现场和定位逻辑；不读取使用者的 agent 配置。
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { locatePi } from "pi-hostkit";
export const here = path.dirname(fileURLToPath(import.meta.url));
export const providerPath = path.join(here, "driver-fake-provider.ts");
export const extensionPath = path.join(here, "driver-extension.ts");
export const isWin = process.platform === "win32";
export const containment = process.env.HOSTKIT_TEST_CONTAINMENT || "auto";
export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function until(fn, ms = 10_000, interval = 25) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error(`等待条件超过 ${ms} 毫秒：${fn}`);
    await delay(interval);
  }
}
let pi;
export async function piInstall() {
  pi ??= await locatePi(process.env.PI_PACKAGE ? { piPath: process.env.PI_PACKAGE } : {});
  if (pi.version !== "1.5.0") throw new Error(`驱动集成测试要求 pi 1.5.0，当前为 ${pi.version}`);
  return pi;
}
export async function piFixture(script = { turns: [] }) {
  // 必须在修改 HOME 前定位 pi，避免隔离目录遮住官方安装。
  const install = await piInstall();
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "agora-driver-")));
  const cwd = path.join(root, "cwd");
  const home = path.join(root, "home");
  const agentDir = path.join(root, "agent");
  const scriptPath = path.join(root, "script.json");
  const requestLog = path.join(root, "requests.jsonl");
  await Promise.all([cwd, home, agentDir, path.join(root, "tmp"), path.join(agentDir, "sessions")].map((dir) => mkdir(dir, { recursive: true })));
  await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({
    defaultProvider: "p0-fake", defaultModel: "scripted", compaction: { enabled: false },
    retry: { enabled: false }, cacheWarming: "off", enableInstallTelemetry: false,
    enableAnalytics: false, packages: [],
  }));
  await writeFile(scriptPath, JSON.stringify(script));
  const env = {
    PATH: process.env.PATH ?? "", LANG: "en_US.UTF-8", TERM: "dumb", HOME: home, USERPROFILE: home,
    TMPDIR: path.join(root, "tmp"), TEMP: path.join(root, "tmp"), TMP: path.join(root, "tmp"),
    PI_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_SESSION_DIR: path.join(agentDir, "sessions"),
    PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
    FAKE_SCRIPT_PATH: scriptPath, FAKE_REQUEST_LOG: requestLog, DRIVER_TEST_ROOT: root,
  };
  for (const name of ["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"]) {
    if (process.env[name]) env[name] = process.env[name];
  }
  if (isWin) for (const name of ["SystemRoot", "SYSTEMROOT", "windir", "ComSpec", "PATHEXT", "ProgramFiles", "ProgramFiles(x86)"]) {
    if (process.env[name]) env[name] = process.env[name];
  }
  // pi 的锁目录和操作系统目录也必须位于测试现场。
  env.APPDATA = path.join(home, "AppData", "Roaming");
  env.LOCALAPPDATA = path.join(home, "AppData", "Local");
  const saved = new Map(["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA"].map((name) => [name, process.env[name]]));
  for (const name of saved.keys()) process.env[name] = env[name];
  return { root, cwd, home, agentDir, env, install,
    sessionPath: (name) => path.join(agentDir, "sessions", `${name}.jsonl`),
    async setScript(value) { await writeFile(scriptPath, JSON.stringify(value)); },
    async cleanup() {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
      }
      if (!process.env.KEEP_FIXTURES) await rm(root, { recursive: true, force: true, maxRetries: 5 });
    },
  };
}
export function waitForEvent(handle, predicate, ms = 20_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(new Error(`等待事件超过 ${ms} 毫秒`)); }, ms);
    const off = handle.onEvent((event) => { if (predicate(event)) { clearTimeout(timer); off(); resolve(event); } });
  });
}
