import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createActions } from "../packages/pane-plugin/dist/actions.js";

const origin = { client: "browser", connectionId: "takeover-tab", receivedAt: "2026-01-01T00:00:00.000Z" };
const target = { type: "node", nodeId: "agora:session:as_current" };
const actionId = name => `agora.task.${name}`;
const directories = [];
after(() => { for (const path of directories) rmSync(path, { recursive: true, force: true }); });
function setup({ dataDir, parent = { kind: "main", piSessionId: "main-one" }, status = "running" } = {}) {
  if (!dataDir) {
    dataDir = mkdtempSync(join(tmpdir(), "pane-takeover-s2-"));
    directories.push(dataDir);
  }
  const session = { kind: "task", taskId: "tk_current", agoraSessionId: "as_current", isCurrent: true, parent };
  const task = { taskId: "tk_current", status, generation: 2, revision: 7, model: "provider/model", profile: "explore", cwd: "D:/workspace" };
  const calls = [], reads = [], replies = [];
  let readFailure = false;
  const actions = createActions({
    context: { dataDir }, online: () => true,
    api: { async request(method, path) {
      reads.push({ method, path });
      if (readFailure) throw new Error("不允许重新读取状态");
      assert.equal(method, "GET");
      if (path === "/v1/sessions/as_current") return { status: 200, body: structuredClone(session) };
      assert.equal(path, "/v1/tasks/tk_current");
      return { status: 200, body: structuredClone(task) };
    } },
  }, async (method, path, body, options) => {
    calls.push({ method, path, body, options });
    const reply = replies.shift();
    if (reply instanceof Error) throw reply;
    if (typeof reply === "function") return reply();
    return reply ?? { status: 200, body: {} };
  });
  return { actions, dataDir, session, task, calls, reads, replies, failReads: () => { readFailure = true; } };
}
async function invocation(s, action = "takeover", fields = {}, idempotencyKey = "takeover") {
  const form = await s.actions.resolveForm(actionId(action), target);
  assert.ok(form);
  return { actionId: actionId(action), target, formId: form.id, formRevision: form.revision, input: { answers: [], fields }, idempotencyKey };
}
const composer = key => ({ actionId: actionId("steer"), target, input: { answers: [], fields: { message: "检查边界" } }, idempotencyKey: key });
const disk = s => join(s.dataDir, "actions.json");
const load = async s => JSON.parse(await readFile(disk(s), "utf8"));
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
const hash = value => createHash("sha256").update(canonical(value)).digest("hex");

// 旧记录的所有权字段缺失时，原始签名仍须保持有效。
async function legacyForms(s) {
  const saved = await load(s);
  for (const [, item] of saved.data.forms) {
    delete item.record.state.task.userOwned;
    const { action, target, state, replace } = item.record;
    item.signature = hash({ action, target, state, replace });
  }
  for (const [, record] of saved.data.versions) delete record.state.task.userOwned;
  await writeFile(disk(s), JSON.stringify(saved));
}

test("接管目录和空表单明确说明确认及权限后果，重读和重启保持稳定", async () => {
  const s = setup();
  const spec = s.actions.list().find(item => item.id === actionId("takeover"));
  assert.deepEqual(spec.scope, ["node"]);
  assert.equal(spec.hasForm, true);
  assert.equal(spec.danger, true);
  assert.equal(spec.timeoutMs, 60000);
  assert.match(spec.confirm, /确定接管/);
  assert.match(spec.confirm, /原 Agent 将不能再管理该任务及子树/);
  const form = await s.actions.resolveForm(spec.id, target);
  assert.match(form.title, /接管任务/);
  assert.match(form.description, /接管后原 Agent 将不能再管理该任务及子树/);
  assert.match(form.description, /用户确认或设备签名/);
  assert.deepEqual(form.fields, []);
  assert.deepEqual(await s.actions.resolveForm(spec.id, target), form);
  const next = setup({ dataDir: s.dataDir });
  assert.deepEqual(await next.actions.resolveForm(spec.id, target), form);
  next.task.revision++;
  const changed = await next.actions.resolveForm(spec.id, target);
  assert.equal(changed.id, form.id);
  assert.equal(changed.createdAt, form.createdAt);
  assert.equal(changed.revision, form.revision + 1);
});

test("Agent 任务只允许接管、停止和清理，不提供 steer/recover 或 composer 旁路", async () => {
  for (const parent of [{ kind: "main", piSessionId: "main-one" }, { kind: "task", taskId: "tk_parent", sessionId: "as_parent" }]) {
    for (const status of ["running", "interrupted", "completed"]) {
      const s = setup({ parent, status });
      assert.equal(await s.actions.resolveForm(actionId("steer"), target), null);
      assert.equal(await s.actions.resolveForm(actionId("recover"), target), null);
      assert.equal((await s.actions.invoke(composer(`composer-${status}`), origin)).status, "failed");
      const take = await invocation(s);
      assert.equal((await s.actions.invoke(take, origin)).status, "ok");
      assert.deepEqual(s.calls[0], {
        method: "POST", path: "/v1/tasks/tk_current/takeover",
        body: { expectedGeneration: 2, expectedRevision: 7 },
        options: { idempotencyKey: take.idempotencyKey, origin, actAsUser: true },
      });
      const saved = await load(s);
      assert.equal(saved.data.forms[0][1].record.state.task.userOwned, false);
      assert.equal((await s.actions.invoke({ actionId: actionId("stop"), target, idempotencyKey: "stop" }, origin)).status, "ok");
      assert.equal(s.calls.at(-1).options.actAsUser, undefined);
      if (status !== "running") {
        const clean = await invocation(s, "cleanup", { discard: "false" }, "cleanup");
        assert.equal((await s.actions.invoke(clean, origin)).status, "ok");
        assert.equal(s.calls.at(-1).options.actAsUser, undefined);
      }
    }
  }
});

test("用户拥有的任务不提供接管，parent 和 parentId 均能确定用户所有权", async () => {
  for (const session of [{ parent: { kind: "user" } }, { parent: undefined, parentId: "agora:root:user-tasks" }]) {
    const s = setup({ status: "interrupted" });
    Object.assign(s.session, session);
    assert.equal(await s.actions.resolveForm(actionId("takeover"), target), null);
    assert.equal((await s.actions.invoke({ actionId: actionId("takeover"), target, idempotencyKey: "user-owned" }, origin)).status, "failed");
    const recover = await invocation(s, "recover", { mode: "resume" }, "recover");
    assert.equal((await s.actions.invoke(recover, origin)).status, "ok");
    assert.equal(s.calls[0].options.actAsUser, true);
    const saved = await load(s);
    assert.equal(saved.data.forms[0][1].record.state.task.userOwned, true);
    s.task.status = "running";
    assert.equal((await s.actions.invoke(composer("user-composer"), origin)).status, "ok");
    assert.equal(s.calls[1].options.actAsUser, undefined);
  }
});

test("所有权未知或历史目标关闭动作，接管拒绝 global、缺失表单及额外输入", async () => {
  for (const patch of [
    { parent: undefined }, { parent: null }, { parent: true }, { parent: { kind: "unknown" } },
    { parent: { kind: "user" }, isCurrent: false }, { isCurrent: false },
  ]) {
    const s = setup();
    Object.assign(s.session, patch);
    for (const action of ["steer", "recover", "takeover"]) {
      assert.equal(await s.actions.resolveForm(actionId(action), target), null);
      assert.equal((await s.actions.invoke({ actionId: actionId(action), target, idempotencyKey: action }, origin)).status, "failed");
    }
    assert.equal((await s.actions.invoke(composer("unknown-composer"), origin)).status, "failed");
    assert.equal(s.calls.length, 0);
  }
  const s = setup();
  const base = await invocation(s);
  for (const [index, mutate] of [
    inv => { delete inv.formId; }, inv => { delete inv.formRevision; },
    inv => { delete inv.formId; delete inv.formRevision; },
    inv => { inv.input.fields.confirm = "true"; }, inv => { inv.input.fields.actAsUser = true; },
    inv => { inv.input.answers = [{ id: "confirm", selected: ["yes"] }]; },
    inv => { inv.target = { type: "global" }; }, inv => { inv.actAsUser = true; },
  ].entries()) {
    const inv = structuredClone(base);
    inv.idempotencyKey = `invalid-${index}`;
    mutate(inv);
    assert.equal((await s.actions.invoke(inv, origin)).status, "failed");
  }
  assert.equal(s.calls.length, 0);
  const request = { actionId: actionId("takeover"), target, idempotencyKey: "needs-input" };
  const result = await s.actions.invoke(request, origin);
  assert.equal(result.status, "needsInput");
  assert.deepEqual(result.followUpForm.fields, []);
  assert.equal(s.calls.length, 0);
});

test("接管先持久化请求，pending 重启保留条件和完整调用身份且不固化结果", async () => {
  const s = setup();
  const inv = await invocation(s);
  s.replies.push(async () => {
    const saved = await load(s);
    const entry = saved.data.identities[0][1];
    assert.deepEqual(entry.operation, {
      method: "POST", path: "/tasks/tk_current/takeover", actAsUser: true,
      body: { expectedGeneration: 2, expectedRevision: 7 },
    });
    assert.equal(entry.result, undefined);
    assert.equal(entry.fingerprint.length, 64);
    return { status: 202, body: {} };
  });
  assert.equal((await s.actions.invoke(inv, origin)).status, "pending");
  const next = setup({ dataDir: s.dataDir, parent: { kind: "user" } });
  next.task.generation = 9;
  next.task.revision = 99;
  next.failReads();
  for (const [index, mutate] of [
    value => { value.input.fields.extra = "changed"; }, value => { value.formRevision++; },
    value => { value.formId += "changed"; }, value => { value.actionId = actionId("recover"); },
    value => { value.input.fields = undefined; }, value => { value.extra = "changed"; },
  ].entries()) {
    const changed = structuredClone(inv);
    mutate(changed);
    assert.equal((await next.actions.invoke(changed, origin)).status, "idempotencyConflict", `身份变更 ${index}`);
  }
  next.replies.push(new Error("连接断开"), { status: 200, body: {} }, { status: 202, body: {} });
  const reconnect = { ...origin, connectionId: "reconnected" };
  assert.equal((await next.actions.invoke(inv, reconnect)).status, "pending");
  assert.equal((await next.actions.invoke(inv, reconnect)).status, "ok");
  assert.equal((await next.actions.invoke(inv, reconnect)).status, "pending");
  assert.equal(next.reads.length, 0);
  for (const call of next.calls) {
    assert.deepEqual(call.body, s.calls[0].body);
    assert.equal(call.options.actAsUser, true);
    assert.equal(call.options.origin, reconnect);
  }
  assert.equal((await load(next)).data.identities[0][1].result, undefined);
});

test("所有权变化使旧表单新 key 失效，取得用户所有权后可 steer/recover", async () => {
  const s = setup({ status: "interrupted" });
  const inv = await invocation(s);
  s.session.parent = { kind: "user" };
  assert.equal((await s.actions.invoke(inv, origin)).status, "failed");
  assert.equal(s.calls.length, 0);
  assert.equal(await s.actions.resolveForm(actionId("takeover"), target), null);
  const recover = await invocation(s, "recover", { mode: "resume" }, "recover-after-takeover");
  assert.equal((await s.actions.invoke(recover, origin)).status, "ok");
  const user = setup({ parent: { kind: "user" } });
  const steer = await invocation(user, "steer", { message: "旧用户表单" }, "old-user");
  user.session.parent = { kind: "main", piSessionId: "main-one" };
  assert.equal((await user.actions.invoke(steer, origin)).status, "failed");
  assert.equal((await user.actions.invoke(composer("agent-again"), origin)).status, "failed");
  assert.equal(user.calls.length, 0);
});

test("旧版 pending 快照缺少所有权仍可查询，旧表单不能用于新 key", async () => {
  const s = setup({ parent: { kind: "user" } });
  const inv = await invocation(s, "steer", { message: "旧版本请求" }, "legacy-pending");
  s.replies.push({ status: 202, body: {} });
  assert.equal((await s.actions.invoke(inv, origin)).status, "pending");
  await legacyForms(s);
  const retry = setup({ dataDir: s.dataDir });
  retry.failReads();
  assert.equal((await retry.actions.invoke(inv, origin)).status, "ok");
  assert.deepEqual(retry.calls[0].body, s.calls[0].body);
  assert.equal(retry.reads.length, 0);
  const next = setup({ dataDir: s.dataDir, parent: { kind: "user" } });
  assert.equal((await next.actions.invoke({ ...inv, idempotencyKey: "legacy-new-key" }, origin)).status, "failed");
  assert.equal(next.calls.length, 0);
  const fresh = await next.actions.resolveForm(actionId("steer"), target);
  assert.equal(fresh.id, inv.formId);
  assert.equal(fresh.revision, inv.formRevision + 1);
  assert.equal((await next.actions.invoke({ ...inv, formRevision: fresh.revision, idempotencyKey: "fresh-user-form" }, origin)).status, "ok");
});

test("接管预检断线的 pending 不固化，重启准备必须重新校验所有权", async () => {
  const s = setup();
  const inv = await invocation(s);
  s.failReads();
  assert.equal((await s.actions.invoke(inv, origin)).status, "pending");
  assert.equal((await load(s)).data.identities[0][1].operation, undefined);
  const next = setup({ dataDir: s.dataDir });
  assert.equal((await next.actions.invoke(inv, origin)).status, "ok");
  assert.equal(next.reads.length, 2);
});

test("落盘的用户级标记与 HTTP 参数白名单不能用于其他动作", async () => {
  for (const mutate of [
    operation => { delete operation.actAsUser; }, operation => { operation.actAsUser = false; },
    operation => { operation.path = "/tasks/tk_current/stop"; },
    operation => { operation.body.mode = "resume"; },
    operation => { operation.body.expectedRevision = "7"; },
    operation => { operation.body.confirm = true; },
  ]) {
    const s = setup();
    const inv = await invocation(s);
    s.replies.push({ status: 202, body: {} });
    await s.actions.invoke(inv, origin);
    const saved = await load(s);
    mutate(saved.data.identities[0][1].operation);
    await writeFile(disk(s), JSON.stringify(saved));
    const next = setup({ dataDir: s.dataDir });
    assert.equal((await next.actions.invoke(inv, origin)).status, "failed");
    assert.equal(next.calls.length, 0);
    assert.equal(next.reads.length, 0);
  }
});
