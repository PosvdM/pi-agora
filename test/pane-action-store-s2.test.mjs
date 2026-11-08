import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActionStore, ActionStoreError, ACTION_STORE_LIMIT } from "../packages/pane-plugin/dist/action-store.js";

async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), "pane-action-store-s2-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test("存储按需初始化，快照原子替换且没有遗留临时文件", async t => {
  const root = await directory(t);
  const dir = join(root, "nested");
  const store = new ActionStore(dir);
  assert.equal(await store.load(), undefined);
  await store.save({ value: "第一份" });
  assert.deepEqual(await new ActionStore(dir).load(), { value: "第一份" });
  await store.save({ value: "第二份", array: [1, 2] });
  assert.deepEqual(await new ActionStore(dir).load(), { value: "第二份", array: [1, 2] });
  assert.deepEqual(await readdir(dir), ["actions.json"]);
});

test("损坏 JSON、版本和结构不兼容时关闭存储，不覆盖原文件", async t => {
  for (const content of ["{", "null", "{}", '{"version":2,"data":{}}', '{"version":1,"data":{},"unknown":true}']) {
    const dir = await directory(t);
    await writeFile(join(dir, "actions.json"), content);
    const store = new ActionStore(dir);
    await assert.rejects(store.load(), ActionStoreError);
    await assert.rejects(store.save({}), ActionStoreError);
    assert.equal(await readFile(join(dir, "actions.json"), "utf8"), content);
  }
});

test("超过 16 MiB 的读写均被拒绝，容量不足不丢弃原快照", async t => {
  const dir = await directory(t);
  const store = new ActionStore(dir);
  await store.save({ value: "保留" });
  const original = await readFile(join(dir, "actions.json"), "utf8");
  await assert.rejects(store.save({ value: "x".repeat(ACTION_STORE_LIMIT) }), ActionStoreError);
  assert.equal(await readFile(join(dir, "actions.json"), "utf8"), original);
  await assert.rejects(store.save({ value: "缩小后仍需重启" }), ActionStoreError);
  await writeFile(join(dir, "actions.json"), " ".repeat(ACTION_STORE_LIMIT + 1));
  await assert.rejects(new ActionStore(dir).load(), ActionStoreError);
});

test("非法 UTF-8 即使替换后是合法 JSON 也不能恢复快照", async t => {
  const dir = await directory(t);
  const path = join(dir, "actions.json");
  const data = Buffer.concat([Buffer.from('{"version":1,"data":{"value":"'), Buffer.from([0xff]), Buffer.from('"}}')]);
  await writeFile(path, data);
  await assert.rejects(new ActionStore(dir).load(), ActionStoreError);
  assert.deepEqual(await readFile(path), data);
});

test("无绝对数据目录时不回退用户目录", async () => {
  for (const path of [undefined, "", "relative-directory"]) {
    const store = new ActionStore(path);
    await assert.rejects(store.load(), ActionStoreError);
    await assert.rejects(store.save({}), ActionStoreError);
  }
});

test("替换失败保留目标并清理临时文件，当前实例始终关闭", async t => {
  const dir = await directory(t);
  await mkdir(join(dir, "actions.json"));
  const store = new ActionStore(dir);
  await assert.rejects(store.save({ value: "不能覆盖目录" }), ActionStoreError);
  assert.deepEqual(await readdir(dir), ["actions.json"]);
  await assert.rejects(store.save({}), ActionStoreError);
  await assert.rejects(store.load(), ActionStoreError);
});
