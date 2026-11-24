import test from "node:test";
import assert from "node:assert/strict";
import { createForms } from "../packages/pane-plugin/dist/forms.js";
import createPlugin from "../packages/pane-plugin/dist/plugin.js";
import { AgoraConnectionError } from "@pi-agora/protocol";
import { FORM_CACHE_FILE, MAX_FORM_CACHE_BYTES, MAX_FORM_CACHE_ITEMS } from "../packages/pane-plugin/dist/form-cache.js";
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

async function directory(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "agora-form-cache-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const origin = { client: "browser", connectionId: "tab-a", receivedAt: new Date().toISOString() };
const request = { id: "rq-one", targetId: "user", state: "escalated", revision: 1, createdAt: "2026-01-01T00:00:00.000Z", questions: [{ id: "q", question: "选择方案", options: [{ label: "甲" }, { label: "乙" }] }] };
function fixture(dataDir) {
  const added = [], removed = [], calls = [];
  let online = true, broken = false, requests = [structuredClone(request)], confirmations = [], devices = [], decisions = [];
  const api = { async request(method, path, body) {
    if (broken) throw new Error("断线");
    if (path.startsWith("/v1/requests?")) return { status: 200, body: { items: structuredClone(requests.filter(item => ["open", "escalated"].includes(item.state))) } };
    if (path === "/v1/requests/rq-one") return requests.length ? { status: 200, body: structuredClone(requests[0]) } : { status: 404, body: {} };
    if (path.startsWith("/v1/confirmations?")) return { status: 200, body: { items: confirmations } };
    if (path.startsWith("/v1/devices?")) return { status: 200, body: { items: devices } };
    if (path.startsWith("/v1/tasks?")) return { status: 200, body: { items: decisions } };
    calls.push({ method, path, body });
    return { status: 200, body: {} };
  } };
  const security = { async execute(method, path, body, options) {
    calls.push({ method, path, body, options });
    const current = requests[0];
    if (!current || !["open", "escalated"].includes(current.state)) return { status: 409, body: { error: { code: "already_handled" } } };
    if (body.expectedRevision !== current.revision) return { status: 409, body: { error: { code: "conflict" } } };
    current.state = path.endsWith("/cancel") ? "cancelled" : "answered";
    return { status: 200, body: {} };
  }, async confirm() { return { status: 202, body: {} }; } };
  const runtime = { api, online: () => online, context: { dataDir, formAdded: form => added.push(form), formRemoved: (id, reason) => removed.push({ id, reason }) } };
  return { runtime, security, added, removed, calls, setOnline: value => { online = value; }, setBroken: value => { broken = value; }, setRequests: value => { requests = value; }, setConfirmations: value => { confirmations = value; }, setDevices: value => { devices = value; }, setDecisions: value => { decisions = value; } };
}
const submission = (key = "key", outcome = { status: "submitted", values: { answers: [{ id: "q", selected: ["甲"] }] } }) => ({ formId: "agora:request:rq-one", revision: 1, outcome, idempotencyKey: key });

test("待处理区按创建时间和 id 排序，失败或离线不会静默移除已有表单", async () => {
  const f = fixture();
  f.setDevices([{ deviceId: "device", state: "pending", label: "新设备", fingerprint: "fingerprint", createdAt: "2025-01-01T00:00:00Z" }]);
  const controller = createForms(f.runtime, f.security);
  const first = await controller.forms.pending();
  assert.deepEqual(first.map(item => item.id), ["agora:device:device", "agora:request:rq-one"]);
  assert.equal(f.added.length, 2);
  f.setBroken(true); await assert.rejects(controller.forms.pending()); assert.equal(f.removed.length, 0);
  f.setOnline(false); assert.deepEqual((await controller.forms.pending()).map(item => item.id), first.map(item => item.id));
  assert.equal((await controller.forms.submit(submission(), origin)).status, "failed");
  assert.equal(f.removed.length, 0); controller.dispose();
});

test("两个标签页提交同一持久提问，只有一个操作生效", async () => {
  const f = fixture(), controller = createForms(f.runtime, f.security);
  await controller.forms.pending();
  const results = await Promise.all([controller.forms.submit(submission("first"), origin), controller.forms.submit(submission("second"), { ...origin, connectionId: "tab-b" })]);
  assert.deepEqual(results.map(item => item.status), ["accepted", "alreadyHandled"]);
  assert.equal(f.calls[0].body.expectedRevision, 1);
  assert.equal(f.calls[0].options.idempotencyKey, "first"); assert.equal(f.calls[0].options.actAsUser, true);
  assert.equal(f.removed.length, 1); controller.dispose();
});

test("取消持久提问走 cancel 并要求用户确认，不会被当作答案", async () => {
  const f = fixture(), controller = createForms(f.runtime, f.security);
  await controller.forms.pending();
  const result = await controller.forms.submit(submission("cancel", { status: "cancelled" }), origin);
  assert.equal(result.status, "accepted"); assert.ok(f.calls[0].path.endsWith("/cancel"));
  assert.equal(f.calls[0].body.answers, undefined); assert.equal(f.calls[0].options.actAsUser, true);
  assert.equal(f.removed[0].reason, "cancelled");
  controller.dispose();
});

test("旧 revision 返回 stale 和 daemon 的新表单；过期由 daemon 的列表裁定", async () => {
  const f = fixture(), controller = createForms(f.runtime, f.security);
  await controller.forms.pending();
  f.setRequests([{ ...request, revision: 2, questions: [{ id: "q", question: "更新的题目" }] }]);
  const result = await controller.forms.submit(submission(), origin);
  assert.equal(result.status, "stale"); assert.equal(result.form.revision, 2);
  assert.equal(f.removed.length, 0);
  f.setRequests([]); await controller.forms.pending(); assert.equal(f.removed.length, 1); controller.dispose();
});

test("等待确认与结果未知均保持 pending，不缓存中间状态", async () => {
  const f = fixture(); let count = 0;
  f.security.execute = async () => { count++; return count === 1 ? { status: 202, body: {} } : { status: 200, body: {} }; };
  const controller = createForms(f.runtime, f.security); await controller.forms.pending();
  assert.equal((await controller.forms.submit(submission(), origin)).status, "pending");
  assert.equal((await controller.forms.submit(submission(), origin)).status, "accepted");
  assert.equal(count, 2);
  f.security.execute = async () => { throw new Error("结果未知"); };
  assert.equal((await controller.forms.submit(submission("other"), origin)).status, "pending"); controller.dispose();
});

test("在线缓存先写盘再通知，插件重启离线仍按稳定顺序显示，缓存不保存凭据", async t => {
  const dir = await directory(t), f = fixture(dir);
  f.setRequests([{ ...request, token: "不可保存的令牌", privateKey: "不可保存的私钥", questions: [{ id: "q", question: "题目", token: "题目额外令牌", options: [{ label: "甲", privateKey: "选项私钥" }] }] }]);
  f.setDevices([{ deviceId: "a", state: "pending", label: "设备", fingerprint: "指纹", createdAt: request.createdAt, privateKey: "设备私钥" }]);
  f.setDecisions([{ taskId: "b", status: "interrupted", title: "中断任务", agoraSessionId: "session", revision: 1, createdAt: "2025-01-01T00:00:00Z" }]);
  const notify = f.runtime.context.formAdded;
  f.runtime.context.formAdded = form => {
    const stored = JSON.parse(readFileSync(path.join(dir, FORM_CACHE_FILE), "utf8"));
    assert.ok(stored.records.some(item => item.form.id === form.id));
    notify(form);
  };
  const first = createForms(f.runtime, f.security);
  const expected = await first.forms.pending(); first.dispose();
  assert.equal(f.added.length, 3);
  const raw = await readFile(path.join(dir, FORM_CACHE_FILE), "utf8");
  assert.doesNotMatch(raw, /token|privateKey|不可保存|私钥/);
  assert.ok(JSON.parse(raw).records.every(item => Object.keys(item).sort().join() === "form,id,kind"));
  const second = fixture(dir); second.setOnline(false);
  second.runtime.api.request = async () => { assert.fail("离线不能请求 daemon"); };
  const restarted = createForms(second.runtime, second.security);
  assert.deepEqual(await restarted.forms.pending(), expected);
  const mutable = await restarted.refresh(); mutable[0].title = "外部修改";
  assert.deepEqual(await restarted.forms.pending(), expected);
  assert.deepEqual(expected.map(item => item.id), ["agora:decision:b", "agora:device:a", "agora:request:rq-one"]);
  assert.equal(second.added.length, 0); assert.equal(second.removed.length, 0);
  restarted.dispose();
});

for (const [label, content] of [
  ["损坏 JSON", "{"],
  ["结构无效", JSON.stringify({ version: 1, records: [{}] })],
  ["版本失效", JSON.stringify({ version: 2, records: [] })],
  ["事项超限", JSON.stringify({ version: 1, records: Array(MAX_FORM_CACHE_ITEMS + 1).fill({}) })],
  ["字节超限", " ".repeat(MAX_FORM_CACHE_BYTES + 1)],
]) {
  test(`${label}缓存拒绝读取，不以空数组清除宿主已有表单`, async t => {
    const dir = await directory(t);
    await writeFile(path.join(dir, FORM_CACHE_FILE), content);
    const f = fixture(dir); f.setOnline(false);
    const existing = new Map([["agora:request:rq-one", { title: "宿主持久事项" }]]);
    const controller = createForms(f.runtime, f.security);
    // 模拟宿主只在 pending 成功后替换整个待处理区。
    await assert.rejects(controller.forms.pending().then(items => { existing.clear(); for (const item of items) existing.set(item.id, item); }));
    f.setOnline(true);
    f.runtime.api.request = async () => { assert.fail("非法缓存不能继续开始权威刷新"); };
    await assert.rejects(controller.refresh());
    assert.equal(existing.size, 1); assert.equal(f.added.length, 0); assert.equal(f.removed.length, 0);
    assert.equal(await readFile(path.join(dir, FORM_CACHE_FILE), "utf8"), content);
    controller.dispose();
  });
}

test("缓存中的 expiresAt 只用于显示，不自行移除或授权；在线提交仍经 daemon", async t => {
  const dir = await directory(t), first = fixture(dir);
  first.setRequests([{ ...request, expiresAt: "2000-01-01T00:00:00Z" }]);
  const controller = createForms(first.runtime, first.security);
  const expected = await controller.forms.pending(); controller.dispose();
  const f = fixture(dir); f.setOnline(false);
  const restarted = createForms(f.runtime, f.security);
  assert.deepEqual(await restarted.forms.pending(), expected);
  assert.deepEqual(await restarted.refresh(), expected);
  assert.equal((await restarted.forms.submit(submission(), origin)).status, "failed");
  assert.equal(f.calls.length, 0); assert.equal(f.removed.length, 0);
  f.setOnline(true);
  let executed = 0;
  f.security.execute = async (method, endpoint, body, options) => {
    executed++;
    assert.equal(endpoint, "/v1/requests/rq-one/answer"); assert.equal(body.expectedRevision, 1); assert.equal(options.actAsUser, true);
    return { status: 202, body: {} };
  };
  assert.equal((await restarted.forms.submit(submission(), origin)).status, "pending");
  assert.equal(executed, 1); assert.equal(f.removed.length, 0);
  restarted.dispose();
});

for (const [state, reason] of [["answered", "handled"], ["cancelled", "cancelled"], ["expired", "expired"], [null, "withdrawn"]]) {
  test(`重启后在线核实提问终态 ${state ?? "404"}，写盘后以 ${reason} 移除`, async t => {
    const dir = await directory(t), f = fixture(dir);
    const first = createForms(f.runtime, f.security); await first.refresh(); first.dispose();
    const second = fixture(dir); second.setRequests(state ? [{ ...request, state }] : []);
    second.runtime.context.formRemoved = (id, actual) => {
      assert.deepEqual(JSON.parse(readFileSync(path.join(dir, FORM_CACHE_FILE), "utf8")).records, []);
      second.removed.push({ id, reason: actual });
    };
    const controller = createForms(second.runtime, second.security);
    assert.deepEqual(await controller.forms.pending(), []);
    assert.deepEqual(second.removed, [{ id: "agora:request:rq-one", reason }]);
    controller.dispose();
  });
}

test("缺失事项的详情无法核实或与列表矛盾，不写盘也不移除", async t => {
  const dir = await directory(t), f = fixture(dir), controller = createForms(f.runtime, f.security);
  await controller.refresh();
  const before = await readFile(path.join(dir, FORM_CACHE_FILE), "utf8");
  const api = f.runtime.api.request;
  f.setRequests([]);
  for (const reply of [{ status: 503, body: {} }, { status: 200, body: {} }, { status: 200, body: request }]) {
    f.runtime.api.request = (method, endpoint, ...rest) => endpoint === "/v1/requests/rq-one" ? Promise.resolve(reply) : api(method, endpoint, ...rest);
    await assert.rejects(controller.refresh());
    assert.equal(await readFile(path.join(dir, FORM_CACHE_FILE), "utf8"), before);
    assert.equal(f.removed.length, 0);
  }
  f.setOnline(false); assert.equal((await controller.forms.pending()).length, 1); controller.dispose();
});

test("缓存原子替换失败，不通知新增或移除，离线仍保留上次成功状态", async t => {
  const dir = await directory(t), f = fixture(dir), controller = createForms(f.runtime, f.security);
  await controller.refresh();
  const cachePath = path.join(dir, FORM_CACHE_FILE), backup = `${cachePath}.backup`;
  const before = await readFile(cachePath, "utf8");
  await rename(cachePath, backup); await mkdir(cachePath);
  f.setRequests([]);
  f.setDevices([{ deviceId: "new", state: "pending", label: "设备", fingerprint: "指纹", createdAt: request.createdAt }]);
  await assert.rejects(controller.refresh());
  assert.equal(f.removed.length, 0); assert.equal(f.added.length, 1);
  assert.equal(await readFile(backup, "utf8"), before);
  f.setOnline(false); assert.deepEqual((await controller.forms.pending()).map(item => item.id), ["agora:request:rq-one"]);
  await rm(cachePath, { recursive: true }); await rename(backup, cachePath);
  f.setOnline(true); await controller.refresh();
  assert.equal(f.removed[0].reason, "withdrawn"); assert.equal(f.added.length, 2);
  controller.dispose();
});

test("扫描 pages 在累计 4096 条内设限，超过限制不继续读取其他列表或更新缓存", async t => {
  const dir = await directory(t), f = fixture(dir), controller = createForms(f.runtime, f.security);
  await controller.refresh(); const before = await readFile(path.join(dir, FORM_CACHE_FILE), "utf8");
  let reads = 0;
  f.runtime.api.request = async (method, endpoint) => {
    reads++; assert.ok(endpoint.startsWith("/v1/requests?"));
    return { status: 200, body: { items: Array.from({ length: 200 }, (_, i) => ({ ...request, id: `${reads}-${i}` })), nextCursor: String(reads) } };
  };
  await assert.rejects(controller.refresh(), /读取限制/);
  assert.equal(reads, 21); assert.equal(f.added.length, 1); assert.equal(f.removed.length, 0);
  assert.equal(await readFile(path.join(dir, FORM_CACHE_FILE), "utf8"), before);
  controller.dispose();
});

test("不同列表共享扫描上限，单页字节和空页游标扫描也有界", async () => {
  for (const mode of ["总数", "字节", "空页"]) {
    const f = fixture(), controller = createForms(f.runtime, f.security);
    let reads = 0;
    f.runtime.api.request = async () => {
      reads++;
      if (mode === "字节") return { status: 200, body: { items: [{ ...request, context: "文".repeat(Math.ceil(MAX_FORM_CACHE_BYTES / 3)) }] } };
      if (mode === "空页") return { status: 200, body: { items: [], nextCursor: String(reads) } };
      return { status: 200, body: { items: Array.from({ length: 2100 }, (_, i) => ({ ...request, id: `${reads}-${i}` })) } };
    };
    await assert.rejects(controller.refresh(), /限制/);
    assert.equal(reads, mode === "总数" ? 2 : mode === "字节" ? 1 : MAX_FORM_CACHE_ITEMS);
    assert.equal(f.added.length, 0); assert.equal(f.removed.length, 0); controller.dispose();
  }
});

test("异步缓存加载后已停用，不请求 daemon、不写宿主、不返回空数组", async t => {
  const dir = await directory(t), f = fixture(dir);
  const first = createForms(f.runtime, f.security); await first.refresh(); first.dispose();
  const before = await readFile(path.join(dir, FORM_CACHE_FILE), "utf8");
  const second = fixture(dir); let reads = 0;
  second.runtime.api.request = async () => { reads++; throw new Error("停用后不应请求"); };
  const controller = createForms(second.runtime, second.security);
  const pending = controller.forms.pending(); controller.dispose();
  await assert.rejects(pending, /停用/); await assert.rejects(controller.refresh(), /停用/);
  assert.equal(reads, 0); assert.equal(second.added.length, 0); assert.equal(second.removed.length, 0);
  assert.equal(await readFile(path.join(dir, FORM_CACHE_FILE), "utf8"), before);
});

test("分页响应迟到时停用，不继续分页或开始其他列表请求", async () => {
  const f = fixture(), controller = createForms(f.runtime, f.security);
  let resolve, started;
  const ready = new Promise(yes => { started = yes; });
  let reads = 0;
  f.runtime.api.request = () => { reads++; started(); return new Promise(yes => { resolve = yes; }); };
  const pending = controller.refresh(); await ready; controller.dispose();
  resolve({ status: 200, body: { items: [request], nextCursor: "more" } });
  await assert.rejects(pending, /停用/);
  assert.equal(reads, 1); assert.equal(f.added.length, 0); assert.equal(f.removed.length, 0);
});

test("移除核实响应迟到时停用，不核实后续事项或写宿主", async () => {
  const f = fixture(), controller = createForms(f.runtime, f.security);
  f.setRequests([request, { ...request, id: "rq-two" }]); await controller.refresh();
  const api = f.runtime.api.request;
  let resolve, started, reads = 0;
  const ready = new Promise(yes => { started = yes; });
  f.setRequests([]);
  f.runtime.api.request = (method, endpoint, ...rest) => {
    if (!endpoint.includes("?")) { reads++; started(); return new Promise(yes => { resolve = yes; }); }
    return api(method, endpoint, ...rest);
  };
  const pending = controller.refresh(); await ready; controller.dispose();
  resolve({ status: 404, body: {} }); await assert.rejects(pending, /停用/);
  assert.equal(reads, 1); assert.equal(f.removed.length, 0); assert.equal(f.added.length, 2);
});

test("确认详情读取期间停用，不使用迟到内容继续请求用户在场确认", async () => {
  const f = fixture(), controller = createForms(f.runtime, f.security);
  let resolve;
  f.runtime.api.request = () => new Promise(yes => { resolve = yes; });
  f.security.confirm = async () => { assert.fail("停用后不能请求用户在场确认"); };
  const pending = controller.forms.submit({ ...submission(), formId: "agora:confirmation:cf" }, origin);
  controller.dispose(); resolve({ status: 200, body: { state: "pending", revision: 1, id: "cf", title: "确认", summary: "摘要", challenge: {} } });
  assert.equal((await pending).status, "pending"); assert.equal(f.added.length, 0); assert.equal(f.removed.length, 0);
});

test("真实插件在线落盘后重启离线，宿主 pending 对齐仍保留已有事项", async t => {
  const dir = await directory(t), f = fixture(dir), warnings = [];
  const hostForms = new Map();
  Object.assign(f.runtime.context, {
    paneProtocol: 1,
    log: { info() {}, warn(...args) { warnings.push(args); }, error() {} },
    notify() {}, panelChanged() {}, setBanner() {}, clearBanner() {}, listBanners: () => [],
    mainSessions: { list: () => [], get: () => undefined, onChange: () => () => {}, hold: () => () => {} },
    userPresence: { devices: () => [], onDevicesChange: () => () => {}, confirm: async () => { assert.fail("不能从缓存请求授权"); } },
    formAdded(form) { hostForms.set(form.id, structuredClone(form)); },
    formRemoved(id) { hostForms.delete(id); },
  });
  const api = f.runtime.api.request;
  let endPoll;
  const onlineApi = {
    async request(method, endpoint, ...rest) {
      if (endpoint.startsWith("/v1/sessions?")) return { status: 200, body: { items: [], changesCursor: { epoch: "test", seq: 0 } } };
      if (endpoint === "/v1/security/alerts") return { status: 200, body: { items: [] } };
      if (endpoint.startsWith("/v1/inbox?")) return new Promise((_, reject) => { endPoll = reject; });
      return api(method, endpoint, ...rest);
    },
    subscribe: () => () => {},
    close() { endPoll?.(new AgoraConnectionError()); },
  };
  const first = createPlugin({ connect: async () => onlineApi, retryMs: 60_000 });
  t.after(() => first.deactivate());
  await first.activate(f.runtime.context);
  const expected = await first.forms.pending(); assert.equal(hostForms.size, 1);
  await first.deactivate();
  let connects = 0;
  const second = createPlugin({ connect: async () => { connects++; throw new AgoraConnectionError(); }, retryMs: 60_000 });
  t.after(() => second.deactivate());
  await second.activate(f.runtime.context);
  const offline = await second.forms.pending();
  hostForms.clear(); for (const form of offline) hostForms.set(form.id, form);
  assert.deepEqual(offline, expected); assert.equal(hostForms.size, 1);
  assert.equal((await second.forms.submit(submission(), origin)).status, "failed");
  assert.deepEqual(await second.forms.pending(), expected);
  assert.equal(connects, 1); assert.deepEqual(warnings, []);
  await second.deactivate();
});

for (const [kind, seed, state, expected] of [
  ["confirmation", { confirmationId: "cf", state: "pending", title: "确认", summary: "摘要", createdAt: request.createdAt }, "expired", "expired"],
  ["confirmation", { confirmationId: "cf", state: "pending", title: "确认", summary: "摘要", createdAt: request.createdAt }, "cancelled", "cancelled"],
  ["device", { deviceId: "dv", state: "pending", label: "设备", fingerprint: "指纹", createdAt: request.createdAt }, "revoked", "withdrawn"],
]) {
  test(`权威列表中的 ${kind} ${state} 按 ${expected} 移除，不依赖缓存业务对象`, async t => {
    const dir = await directory(t), f = fixture(dir);
    const set = kind === "confirmation" ? f.setConfirmations : f.setDevices;
    f.setRequests([]); set([seed]);
    const first = createForms(f.runtime, f.security); await first.refresh(); first.dispose();
    set([{ ...seed, state }]);
    const second = createForms(f.runtime, f.security); assert.deepEqual(await second.refresh(), []);
    assert.equal(f.removed.length, 1); assert.equal(f.removed[0].reason, expected);
    second.dispose();
  });
}

test("权威列表中旧事项缺少状态时不静默移除", async () => {
  const f = fixture(); f.setRequests([]);
  const confirmation = { confirmationId: "cf", state: "pending", title: "确认", summary: "摘要", createdAt: request.createdAt };
  f.setConfirmations([confirmation]);
  const controller = createForms(f.runtime, f.security); await controller.refresh();
  f.setConfirmations([{ ...confirmation, state: undefined }]);
  await assert.rejects(controller.refresh(), /终态/); assert.equal(f.removed.length, 0);
  controller.dispose();
});
