import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { OperationIdentities } from "../packages/pane-plugin/dist/identity.js";
import createPlugin from "../packages/pane-plugin/dist/plugin.js";

const DAY = 24 * 60 * 60_000;
const FILE_BYTES = 32 * 1024 * 1024;
const RESULT_BYTES = 64 * 1024;
const fingerprint = createHash("sha256").update('{"a":1}').digest("hex");
const row = (key, at = Date.now(), result = { status: "accepted" }) => ({ key, fingerprint, at, ...(result === undefined ? {} : { result }) });
async function directory(t) {
  const value = await mkdtemp(path.join(tmpdir(), "agora-pane-id-limit-"));
  t.after(() => rm(value, { recursive: true, force: true }));
  return value;
}
async function seed(t, rows) {
  const dir = await directory(t), file = path.join(dir, "operation-identities.json");
  await writeFile(file, JSON.stringify(rows));
  const store = new OperationIdentities();
  await store.open(dir);
  return { dir, file, store };
}

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

test("最终结果从完成时间起至少保留二十四小时", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-01-01T00:00:00Z") });
  const store = new OperationIdentities();
  assert.equal(await store.check("long-operation", { a: 1 }), true);
  t.mock.timers.tick(23 * 60 * 60_000);
  await store.finish("long-operation", { status: "accepted" });
  t.mock.timers.tick(2 * 60 * 60_000);
  assert.equal(await store.check("long-operation", { a: 2 }), false);
  assert.deepEqual(store.result("long-operation"), { status: "accepted" });
  t.mock.timers.tick(23 * 60 * 60_000);
  assert.equal(await store.check("long-operation", { a: 2 }), true);
});

test("并发登记在写盘前串行，不能让同 key 的两个不同身份通过", async () => {
  const store = new OperationIdentities();
  const result = await Promise.all([store.check("same-key", { a: 1 }), store.check("same-key", { a: 2 })]);
  assert.deepEqual(result, [true, false]);
});

test("独立读取上限拒绝大于 32 MiB 的文件，失败实例不能当作空库继续写入", async t => {
  const dir = await directory(t), file = path.join(dir, "operation-identities.json");
  const handle = await open(file, "w");
  try { await handle.truncate(FILE_BYTES + 1); } finally { await handle.close(); }
  const store = new OperationIdentities();
  await assert.rejects(store.open(dir), /32 MiB/);
  await assert.rejects(store.check("new", { a: 1 }), /尚未安全加载/);
  assert.throws(() => store.result("old"), /尚未安全加载/);
  assert.equal((await open(file, "r").then(async handle => { try { return await handle.stat(); } finally { await handle.close(); } })).size, FILE_BYTES + 1);
});

test("超过 4096 条的数组即使全部过期也拒绝加载，不截断为可写空库", async t => {
  const dir = await directory(t), file = path.join(dir, "operation-identities.json");
  await writeFile(file, JSON.stringify(Array.from({ length: 4097 }, (_, i) => row(`old-${i}`, 0))));
  const store = new OperationIdentities();
  await assert.rejects(store.open(dir), /4096 条/);
  await assert.rejects(store.check("new", { a: 1 }), /尚未安全加载/);
});

test("损坏、重复键和非法时间戳不加载为部分身份列表", async t => {
  const dir = await directory(t), file = path.join(dir, "operation-identities.json");
  for (const contents of ["[", "{}", JSON.stringify([row("same"), row("same")]), JSON.stringify([row("valid"), { ...row("bad"), at: null }]), JSON.stringify([row("bad", Date.now(), { status: "pending" })])]) {
    await writeFile(file, contents);
    const store = new OperationIdentities();
    await assert.rejects(store.open(dir));
    await assert.rejects(store.check("new", { a: 1 }), /尚未安全加载/);
    assert.equal(await readFile(file, "utf8"), contents);
  }
});

test("4096 个未过期终态阻挡新 key，已有身份的重放和冲突查询始终有效", async t => {
  const { store, file } = await seed(t, Array.from({ length: 4096 }, (_, i) => row(`final-${i}`)));
  const before = await readFile(file, "utf8");
  await assert.rejects(store.check("new-key", { a: 1 }), /4096 条 \/ 32 MiB/);
  for (const key of ["final-0", "final-4095"]) {
    assert.equal(await store.check(key, { a: 1 }), true);
    assert.equal(await store.check(key, { a: 2 }), false);
    assert.deepEqual(store.result(key), { status: "accepted" });
  }
  assert.equal(await readFile(file, "utf8"), before);
});

test("满载后只回收已过期记录，不逐出未过期终态，完成时间决定保留期", async t => {
  const now = Date.parse("2026-02-01T00:00:00Z");
  t.mock.timers.enable({ apis: ["Date"], now });
  const { store, file } = await seed(t, Array.from({ length: 4096 }, (_, i) => row(`final-${i}`, i === 0 ? now - DAY + 1 : now)));
  await assert.rejects(store.check("new", { a: 1 }), /容量不足/);
  t.mock.timers.tick(1);
  assert.equal(store.result("final-0"), undefined);
  assert.equal(await store.check("new", { a: 1 }), true);
  const saved = JSON.parse(await readFile(file, "utf8"));
  assert.equal(saved.length, 4096);
  assert.ok(!saved.some(item => item.key === "final-0"));
  for (let i = 1; i < 4096; i++) assert.deepEqual(store.result(`final-${i}`), { status: "accepted" });
  await store.finish("new", { status: "accepted" });
  t.mock.timers.tick(DAY - 1);
  assert.equal(await store.check("new", { a: 2 }), false);
  t.mock.timers.tick(1);
  assert.equal(await store.check("new", { a: 2 }), true);
});

test("未完成身份为完整结果预留字节，容量不足时先拒绝新 key，终态释放未用预留", async () => {
  const store = new OperationIdentities();
  let count = 0;
  for (; count < 4096; count++) {
    try { await store.check(`pending-${count}`, { a: 1 }); }
    catch (error) { assert.match(error.message, /容量不足/); break; }
  }
  assert.ok(count > 0 && count < 4096, "字节预留必须独立于条数上限生效");
  assert.equal(await store.check("pending-0", { a: 1 }), true);
  const result = { status: "needsInput", followUpForm: { id: "form", source: "agora", revision: 1, title: "输入", createdAt: new Date().toISOString(), description: "x".repeat(64_000) } };
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < RESULT_BYTES);
  assert.deepEqual(await store.finish("pending-0", result), result);
  assert.deepEqual(store.result("pending-0"), result);
  await assert.rejects(store.check("still-full", { a: 1 }), /容量不足/);
  await store.finish("pending-1", { status: "accepted" });
  assert.equal(await store.check("space-released", { a: 1 }), true);
});

test("大文件按字节上限加载，保留完整终态并为新操作预留结果空间", async t => {
  const result = { status: "needsInput", followUpForm: { id: "form", source: "agora", revision: 1, title: "输入", createdAt: new Date().toISOString(), description: "x".repeat(65_000) } };
  const { dir, store, file } = await seed(t, Array.from({ length: 512 }, (_, i) => row(`large-${i}`, Date.now(), result)));
  assert.ok((await readFile(file)).length > 16 * 1024 * 1024);
  const pending = [];
  for (let i = 0; i < 16; i++) {
    try { await store.check(`reserved-${i}`, { a: 1 }); pending.push(`reserved-${i}`); }
    catch (error) { assert.match(error.message, /容量不足/); break; }
  }
  assert.ok(pending.length > 0 && pending.length < 16);
  for (const key of pending) assert.deepEqual(await store.finish(key, result), result);
  assert.ok((await readFile(file)).length <= FILE_BYTES);
  const reopened = new OperationIdentities(); await reopened.open(dir);
  assert.deepEqual(reopened.result("large-0"), result);
  for (const key of pending) assert.deepEqual(reopened.result(key), result);
});

test("顶层超大 message 有界裁剪，首次返回、内存重放和重启重放一致", async t => {
  const dir = await directory(t), store = new OperationIdentities(); await store.open(dir);
  await store.check("long-message", { a: 1 });
  const input = { status: "failed", message: "\u0000测试😀".repeat(100_000) };
  const first = await store.finish("long-message", input);
  assert.equal(first.status, "failed");
  assert.match(first.message, /已截断/);
  assert.ok(Buffer.byteLength(JSON.stringify(first.message)) <= 4096);
  assert.deepEqual(store.result("long-message"), first);
  first.message = "外部修改";
  assert.notEqual(store.result("long-message").message, first.message);
  const second = new OperationIdentities(); await second.open(dir);
  assert.deepEqual(second.result("long-message"), store.result("long-message"));
});

test("needsInput 保留合法 FormSpec，超大结构不能伪造成功或覆盖未完成身份", async t => {
  const dir = await directory(t), store = new OperationIdentities(); await store.open(dir);
  await store.check("form", { a: 1 });
  const result = { status: "needsInput", followUpForm: { id: "form", source: "agora", revision: 1, title: "表单", createdAt: new Date().toISOString(),
    fields: [{ id: "cwd", label: "路径", type: "text", default: "x".repeat(32768) }] } };
  assert.deepEqual(await store.finish("form", result), result);
  const second = new OperationIdentities(); await second.open(dir);
  assert.deepEqual(second.result("form"), result);
  await second.check("oversize", { a: 1 });
  const before = await readFile(path.join(dir, "operation-identities.json"), "utf8");
  await assert.rejects(second.finish("oversize", { ...result, followUpForm: { ...result.followUpForm, description: "x".repeat(RESULT_BYTES) } }), /超过 64 KiB.*可能已执行.*原幂等键/);
  assert.equal(second.result("oversize"), undefined);
  assert.equal(await second.check("oversize", { a: 2 }), false);
  assert.equal(await second.check("oversize", { a: 1 }), true);
  assert.equal(await readFile(path.join(dir, "operation-identities.json"), "utf8"), before);
  assert.deepEqual(await second.finish("oversize", { status: "accepted" }), { status: "accepted" });
});

test("pending 不缓存为最终结果，重启后原 key 可以继续查询且不能改变身份", async t => {
  const dir = await directory(t), first = new OperationIdentities(); await first.open(dir);
  await first.check("pending", { a: 1 });
  assert.equal((await first.finish("pending", { status: "pending" })).status, "pending");
  assert.equal(first.result("pending"), undefined);
  const second = new OperationIdentities(); await second.open(dir);
  assert.equal(second.result("pending"), undefined);
  assert.equal(await second.check("pending", { a: 2 }), false);
  assert.equal(await second.check("pending", { a: 1 }), true);
  await second.finish("pending", { status: "accepted" });
  assert.deepEqual(second.result("pending"), { status: "accepted" });
});

test("登记及完成写盘失败不发布 Map 改动、不删除过期记录，原子替换失败清理临时文件", async t => {
  const now = Date.parse("2026-02-01T00:00:00Z");
  t.mock.timers.enable({ apis: ["Date"], now });
  const { dir, file, store } = await seed(t, [row("expired", now - DAY + 1), row("live", now)]);
  await store.check("pending", { a: 1 });
  t.mock.timers.tick(1);
  const before = structuredClone([...store.entries]);
  const disk = await readFile(file, "utf8"), backup = `${file}.backup`;
  await rename(file, backup); await mkdir(file);
  await assert.rejects(store.check("new", { a: 1 }));
  assert.deepEqual([...store.entries], before);
  await assert.rejects(store.finish("pending", { status: "accepted" }));
  assert.deepEqual([...store.entries], before);
  assert.equal(store.result("pending"), undefined);
  assert.deepEqual(store.result("live"), { status: "accepted" });
  assert.equal(await readFile(backup, "utf8"), disk);
  assert.ok((await readdir(dir)).every(name => !name.endsWith(".tmp")));
  await rm(file, { recursive: true }); await rename(backup, file);
  assert.equal(await store.check("new", { a: 2 }), true, "失败登记没有锁定新 key 的身份");
  assert.deepEqual(await store.finish("pending", { status: "accepted" }), { status: "accepted" });
  const reopened = new OperationIdentities(); await reopened.open(dir);
  assert.deepEqual(reopened.result("pending"), { status: "accepted" });
  assert.equal((await readdir(dir)).length, 1);
});

const origin = { client: "browser", connectionId: "tab", deviceId: "device", receivedAt: "2026-01-01T00:00:00Z" };
const submission = key => ({ formId: "agora:request:rq-one", revision: 1, idempotencyKey: key,
  outcome: { status: "submitted", values: { answers: [{ id: "q", selected: ["甲"] }] } } });
const pairing = key => ({ actionId: "agora.device.pair", target: { type: "global" }, idempotencyKey: key });
async function pluginFixture(t, dir, handler = () => undefined) {
  const calls = [], polls = new Set();
  let confirmations = 0;
  const context = {
    paneProtocol: 1, dataDir: dir, log: { info() {}, warn() {}, error() {} },
    notify() {}, panelChanged() {}, formAdded() {}, formRemoved() {}, setBanner() {}, clearBanner() {}, listBanners: () => [],
    mainSessions: { list: () => [], get: () => undefined, onChange: () => () => {}, hold: () => () => {} },
    userPresence: { devices: () => [{ deviceId: "device", publicKey: "key", label: "设备", connected: true }],
      onDevicesChange: () => () => {}, async confirm() { confirmations++; throw new Error("不应在此请求用户确认"); } },
  };
  const api = {
    async request(method, requestPath, body, options) {
      calls.push({ method, path: requestPath, body, options });
      const handled = await handler(method, requestPath, body, options);
      if (handled !== undefined) return handled;
      if (requestPath.startsWith("/v1/inbox?")) return new Promise((resolve, reject) => { polls.add(reject); });
      if (method === "GET") return { status: 200, body: { items: [], changesCursor: { epoch: "test", seq: 0 } } };
      throw new Error(`未定义业务请求：${method} ${requestPath}`);
    },
    subscribe: () => () => {},
    close() { for (const reject of polls) reject(new Error("closed")); polls.clear(); },
  };
  const plugin = createPlugin({ connect: async () => api, retryMs: 600_000 });
  await plugin.activate(context);
  t.after(() => plugin.deactivate());
  return { plugin, calls, get confirmations() { return confirmations; } };
}

test("forms 和安全动作绕过 ActionStore 仍受身份条数上限保护，业务前拒绝且旧终态可重放", async t => {
  const dir = await directory(t), file = path.join(dir, "operation-identities.json");
  const identities = new OperationIdentities(); await identities.open(dir);
  const oldForm = submission("old-form"), oldPair = pairing("old-pair");
  await identities.check(oldForm.idempotencyKey, { type: "form", ...oldForm });
  await identities.finish(oldForm.idempotencyKey, { status: "accepted" });
  await identities.check(oldPair.idempotencyKey, { type: "action", ...oldPair });
  await identities.finish(oldPair.idempotencyKey, { status: "ok" });
  const saved = JSON.parse(await readFile(file, "utf8"));
  await writeFile(file, JSON.stringify([...saved, ...Array.from({ length: 4094 }, (_, i) => row(`final-${i}`))]));
  const f = await pluginFixture(t, dir);
  await assert.rejects(f.plugin.forms.submit(submission("new-form"), origin), /容量不足/);
  await assert.rejects(f.plugin.actions.invoke(pairing("new-pair"), origin), /容量不足/);
  await assert.rejects(f.plugin.actions.invoke({ actionId: "agora.security.acknowledge", idempotencyKey: "new-ack", formId: "agora:ack:alert:1", formRevision: 1 }, origin), /容量不足/);
  assert.deepEqual(await f.plugin.forms.submit(oldForm, origin), { status: "accepted" });
  assert.deepEqual(await f.plugin.actions.invoke(oldPair, origin), { status: "ok" });
  assert.equal((await f.plugin.forms.submit({ ...oldForm, revision: 2 }, origin)).status, "idempotencyConflict");
  assert.equal(f.calls.filter(call => call.method === "POST").length, 0);
  assert.equal(f.confirmations, 0);
  assert.ok(!(await readdir(dir)).includes("actions.json"), "业务没有进入 ActionStore");
});

test("forms 和安全动作的字节预留在业务前生效，旧 pending 在满载重启后继续用原 key 查询", async t => {
  const dir = await directory(t), file = path.join(dir, "operation-identities.json");
  const identities = new OperationIdentities(); await identities.open(dir);
  const request = submission("old-pending");
  await identities.check(request.idempotencyKey, { type: "form", ...request });
  const rows = JSON.parse(await readFile(file, "utf8"));
  const full = new OperationIdentities();
  for (let i = 0; ; i++) {
    try { await full.check(`reserved-${i}`, { a: 1 }); }
    catch (error) { assert.match(error.message, /容量不足/); break; }
  }
  for (const [key, value] of [...full.entries].slice(1)) rows.push({ key, ...value });
  await writeFile(file, JSON.stringify(rows));
  let writes = 0;
  const f = await pluginFixture(t, dir, (method, requestPath) => {
    if (method === "POST" && requestPath === "/v1/requests/rq-one/answer") { writes++; return { status: 200, body: {} }; }
  });
  await assert.rejects(f.plugin.forms.submit(submission("new-form"), origin), /容量不足/);
  await assert.rejects(f.plugin.actions.invoke(pairing("new-pair"), origin), /容量不足/);
  assert.equal(writes, 0);
  assert.deepEqual(await f.plugin.forms.submit(request, origin), { status: "accepted" });
  assert.deepEqual(await f.plugin.forms.submit(request, origin), { status: "accepted" });
  assert.equal(writes, 1);
  assert.equal(JSON.parse(await readFile(file, "utf8")).find(item => item.key === request.idempotencyKey).result.status, "accepted");
});

test("guard 首次返回规范化 message，与重放及重启结果一致", async t => {
  const dir = await directory(t);
  let writes = 0;
  const first = await pluginFixture(t, dir, method => {
    if (method === "POST") { writes++; return { status: 503, body: { error: { message: "后台错误😀".repeat(100_000) } } }; }
  });
  const inv = pairing("large-error");
  const result = await first.plugin.actions.invoke(inv, origin);
  assert.equal(result.status, "failed");
  assert.ok(Buffer.byteLength(JSON.stringify(result.message)) <= 4096);
  assert.match(result.message, /已截断/);
  assert.deepEqual(await first.plugin.actions.invoke(inv, origin), result);
  assert.equal(writes, 1);
  await first.plugin.deactivate();
  const second = await pluginFixture(t, dir);
  assert.deepEqual(await second.plugin.actions.invoke(inv, origin), result);
  assert.equal(second.calls.filter(call => call.method === "POST").length, 0);
});

test("guard 的完成落盘失败返回明确 pending，保留身份并允许同 key 核对", async t => {
  const dir = await directory(t), file = path.join(dir, "operation-identities.json"), backup = `${file}.backup`;
  let writes = 0;
  const f = await pluginFixture(t, dir, async method => {
    if (method !== "POST") return;
    writes++;
    if (writes === 1) { await rename(file, backup); await mkdir(file); }
    return { status: 200, body: {} };
  });
  const inv = pairing("finish-io-error");
  const result = await f.plugin.actions.invoke(inv, origin);
  assert.equal(result.status, "pending");
  assert.match(result.message, /可能已执行.*结果未能保存.*原幂等键/);
  assert.equal(JSON.parse(await readFile(backup, "utf8"))[0].result, undefined);
  assert.equal((await f.plugin.actions.invoke({ ...inv, target: { type: "node", nodeId: "different" } }, origin)).status, "idempotencyConflict");
  assert.equal(writes, 1);
  await rm(file, { recursive: true }); await rename(backup, file);
  assert.deepEqual(await f.plugin.actions.invoke(inv, origin), { status: "ok" });
  assert.equal(writes, 2);
  assert.deepEqual(await f.plugin.actions.invoke(inv, origin), { status: "ok" });
  assert.equal(writes, 2);
});
