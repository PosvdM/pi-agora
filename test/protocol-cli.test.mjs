import test from "node:test";
import assert from "node:assert/strict";
import { negotiateProtocol, PROTOCOL_RANGE, spawnTaskSchema, agoraTaskSchema, loopbackUrl } from "../packages/protocol/dist/index.js";
import { runCli } from "../packages/cli/dist/index.js";

test("协议选择交集最高版本，不兼容时拒绝", () => {
  assert.equal(negotiateProtocol({ min: 1, max: 2 }), 1);
  assert.deepEqual(PROTOCOL_RANGE, { min: 1, max: 1 });
  assert.throws(() => negotiateProtocol({ min: 2, max: 3 }), /协议版本不兼容/);
  assert.throws(() => negotiateProtocol({ min: 1, max: Number.NaN }), /协议版本不兼容/);
  assert.deepEqual(spawnTaskSchema.required, ["model", "profile", "prompt"]);
  assert.deepEqual(agoraTaskSchema.properties.action.enum, ["spawn", "list", "status", "result", "steer", "stop", "cleanup", "recover"]);
});

test("客户端地址只接受不带凭证的 IPv4 loopback HTTP", () => {
  assert.equal(loopbackUrl("http://127.0.0.1:1234"), "http://127.0.0.1:1234");
  for (const value of ["https://127.0.0.1:1234", "http://localhost:1234", "http://127.0.0.1:1234/path", "http://x:secret@127.0.0.1:1234", "http://0.0.0.0:1234"]) assert.throws(() => loopbackUrl(value));
});

test("CLI 帮助与参数错误不启动 daemon", async () => {
  const out = [], errors = [];
  const io = { out: (value) => out.push(value), error: (value) => errors.push(value) };
  assert.equal(await runCli(["--help"], io), 0);
  assert.match(out[0], /agora daemon start/);
  for (const args of [["unknown"], ["show"], ["status", "extra"], ["ls", "--unknown"], ["daemon", "start", "--home"]]) {
    assert.equal(await runCli(args, io), 1);
  }
  assert.equal(errors.length, 5);
  assert.ok(errors.every((value) => typeof value === "string" && value.length));
});
