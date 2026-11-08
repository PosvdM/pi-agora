import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

test("pane API 只读副本与固定来源哈希一致", async () => {
  await promisify(execFile)(process.execPath, ["scripts/vendor-pane-api.mjs", "verify"], { timeout: 30_000 });
});
