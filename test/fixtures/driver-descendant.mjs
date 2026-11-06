// 受控 shell 后代独立记录身份，停止测试不把这些记录注入被测驱动。
import { appendFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { currentProcessIdentity } from "pi-hostkit";
const [oracle, mode] = process.argv.slice(2);
appendFileSync(oracle, `${JSON.stringify(currentProcessIdentity("driver-descendant", mode ?? "parent"))}\n`);
if (mode !== "leaf") spawn(process.execPath, [fileURLToPath(import.meta.url), oracle, "leaf"], {
  detached: process.platform !== "win32", stdio: "ignore", env: process.env,
});
setInterval(() => {}, 1_000);
