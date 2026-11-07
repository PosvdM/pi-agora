import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
for (const platform of ["win32", "linux"]) test(`驱动故障：${platform} 独立进程验证清理确认、保留锁和恢复屏障`, { timeout: 45_000 }, async (t) => {
  const env = { ...process.env, AGORA_DRIVER_TEST_PLATFORM: platform };
  // 嵌套测试进程必须独立运行测试调度器，不能继承父 worker 的内部模式。
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, ["--experimental-test-module-mocks", "--test-reporter=tap", "--test",
    path.join(here, "fixtures", "driver-fault-worker.mjs")], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 40_000);
  try {
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    assert.equal(code, 0, `${stdout}\n${stderr}`);
    assert.match(stdout, /# tests [1-9][0-9]*/u, "子进程必须真正执行故障用例，不能静默跳过");
    assert.match(stdout, /# fail 0/u);
    t.diagnostic(stdout);
  } finally { clearTimeout(timer); }
});
