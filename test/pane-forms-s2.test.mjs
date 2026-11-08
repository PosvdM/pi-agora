import test from "node:test";
import assert from "node:assert/strict";
import { createForms } from "../packages/pane-plugin/dist/forms.js";

const origin = { client: "browser", connectionId: "tab-a", receivedAt: new Date().toISOString() };
const request = { id: "rq-one", targetId: "user", state: "escalated", revision: 1, createdAt: "2026-01-01T00:00:00.000Z", questions: [{ id: "q", question: "选择方案", options: [{ label: "甲" }, { label: "乙" }] }] };
function fixture() {
  const added = [], removed = [], calls = [];
  let online = true, broken = false, requests = [structuredClone(request)], confirmations = [], devices = [], decisions = [];
  const api = { async request(method, path, body) {
    if (broken) throw new Error("断线");
    if (path.startsWith("/v1/requests?")) return { status: 200, body: { items: structuredClone(requests) } };
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
  const runtime = { api, online: () => online, context: { formAdded: form => added.push(form), formRemoved: (id, reason) => removed.push({ id, reason }) } };
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
