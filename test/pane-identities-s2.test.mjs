import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { OperationIdentities } from "../packages/pane-plugin/dist/identity.js";

test("操作身份在插件重启后仍拒绝同 key 不同内容，并保留最终结果", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "agora-pane-id-"));
  try {
    const first = new OperationIdentities(); await first.open(directory);
    assert.equal(await first.check("key", { method: "action", target: "node", input: { a: 1, b: 2 } }), true);
    assert.equal(await first.check("key", { input: { b: 2, a: 1 }, target: "node", method: "action" }), true);
    assert.equal(await first.check("key", { method: "form", target: "node" }), false);
    await first.finish("key", { status: "accepted" });
    const second = new OperationIdentities(); await second.open(directory);
    assert.equal(await second.check("key", { method: "action", target: "node", input: { a: 1, b: 2 } }), true);
    assert.deepEqual(second.result("key"), { status: "accepted" });
    assert.equal(await second.check("key", { method: "action", target: "node", input: { a: 1, b: 3 } }), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("并发登记在写盘前串行，不能让同 key 的两个不同身份通过", async () => {
  const store = new OperationIdentities();
  const result = await Promise.all([store.check("same-key", { a: 1 }), store.check("same-key", { a: 2 })]);
  assert.deepEqual(result, [true, false]);
});
