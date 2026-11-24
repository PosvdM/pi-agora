import test from "node:test";
import assert from "node:assert/strict";
import { createForms } from "../packages/pane-plugin/dist/forms.js";

const AT = "2026-01-01T00:00:00Z";
const origin = { client: "browser", connectionId: "tab", receivedAt: AT };
function fixture(kind) {
  const objects = {
    request: { id: "rq_one", state: "escalated", targetId: "user", revision: 1, createdAt: AT, questions: [{ id: "q", question: "选择" }] },
    confirmation: { confirmationId: "cf_one", state: "pending", createdAt: AT, title: "待确认", summary: "操作参数", challenge: { action: "agora.request.answer" } },
    device: { deviceId: "device_one", state: "pending", createdAt: AT, label: "Chrome", fingerprint: "hash" },
    decision: { taskId: "tk_one", status: "interrupted", createdAt: AT, revision: 1, title: "中断任务", agoraSessionId: "as_one" },
  };
  let online = true, confirms = 0;
  const removed = [], added = [];
  const collections = { requests: "request", confirmations: "confirmation", devices: "device", tasks: "decision" };
  const runtime = { online: () => online, context: { formAdded: value => added.push(value), formRemoved: (...value) => removed.push(value) },
    api: { async request(_method, path) {
      const parts = new URL(path, "http://agora").pathname.split("/").filter(Boolean);
      const requested = collections[parts[1]];
      if (requested !== kind) return { status: 200, body: { items: [] } };
      return { status: 200, body: parts.length === 2 ? { items: [objects[kind]] } : objects[kind] };
    } } };
  const security = { async execute() { return { status: 200, body: {} }; }, async confirm() { confirms++; return { status: 200, body: {} }; } };
  const controller = createForms(runtime, security);
  return { controller, object: objects[kind], removed, added, setOffline: () => { online = false; }, get confirms() { return confirms; } };
}
for (const kind of ["request", "confirmation", "device", "decision"]) {
  test(`${kind} 的未知非空状态不能清除已缓存持久表单`, async () => {
    const f = fixture(kind);
    const first = await f.controller.forms.pending();
    assert.equal(first.length, 1);
    f.object[kind === "decision" ? "status" : "state"] = "unknown";
    await assert.rejects(f.controller.forms.pending(), /无法识别事项状态/);
    assert.equal(f.removed.length, 0);
    f.setOffline();
    assert.deepEqual(await f.controller.forms.pending(), first);
    f.controller.dispose();
  });
}

test("活动确认过滤避免五千条历史记录挤满待处理区，终态通过详情核实", async () => {
  const historical = Array.from({ length: 5_000 }, (_, index) => ({ confirmationId: `old-${index}`, state: 'confirmed', title: '历史确认', summary: '历史操作', createdAt: AT }));
  const active = { confirmationId: 'active', state: 'pending', title: '新确认', summary: '待处理操作', createdAt: AT };
  const removed = [];
  let lists = 0;
  const runtime = { online: () => true, context: { formAdded() {}, formRemoved: (...args) => removed.push(args) }, api: {
    async request(_method, path) {
      const url = new URL(path, 'http://agora');
      if (url.pathname === '/v1/confirmations/active') return { status: 200, body: active };
      if (url.pathname !== '/v1/confirmations') return { status: 200, body: { items: [] } };
      lists++;
      const states = url.searchParams.getAll('state');
      assert.deepEqual(states, ['pending', 'executing']);
      const items = [...historical, active].filter(item => states.includes(item.state));
      return { status: 200, body: { items, nextCursor: null } };
    },
  } };
  const controller = createForms(runtime, {});
  assert.equal((await controller.forms.pending()).length, 1);
  active.state = 'executing';
  assert.equal((await controller.forms.pending()).length, 1);
  active.state = 'confirmed';
  assert.deepEqual(await controller.forms.pending(), []);
  assert.deepEqual(removed, [['agora:confirmation:active', 'handled']]);
  assert.equal(lists, 3);
  controller.dispose();
});

test("已签名执行中的 confirmation 保留在待处理区，重复提交返回 pending", async () => {
  const f = fixture("confirmation");
  await f.controller.forms.pending();
  f.object.state = "executing";
  const forms = await f.controller.forms.pending();
  assert.equal(forms.length, 1); assert.equal(f.removed.length, 0);
  const result = await f.controller.forms.submit({ formId: "agora:confirmation:cf_one", revision: 1, idempotencyKey: "same", outcome: { status: "submitted", values: { answers: [] } } }, origin);
  assert.equal(result.status, "pending"); assert.equal(f.confirms, 0);
  f.object.state = "confirmed";
  assert.deepEqual(await f.controller.forms.pending(), []);
  assert.deepEqual(f.removed, [["agora:confirmation:cf_one", "handled"]]);
  f.controller.dispose();
});

test("提问的接收方缺失不能被误认为已转离用户", async () => {
  const f = fixture("request");
  const previous = await f.controller.forms.pending();
  delete f.object.targetId;
  await assert.rejects(f.controller.forms.pending(), /提问接收方无效/);
  assert.equal(f.removed.length, 0);
  f.setOffline();
  assert.deepEqual(await f.controller.forms.pending(), previous);
  f.controller.dispose();
});

test("提问合法转离用户待处理区时使用 withdrawn，而非伪称已答复", async () => {
  const f = fixture("request");
  await f.controller.forms.pending();
  f.object.targetId = "another-agent";
  assert.deepEqual(await f.controller.forms.pending(), []);
  assert.deepEqual(f.removed, [["agora:request:rq_one", "withdrawn"]]);
  f.controller.dispose();
});
