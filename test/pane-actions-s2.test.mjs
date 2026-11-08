import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createActions } from "../packages/pane-plugin/dist/actions.js";

const origin = { client: "browser", connectionId: "tab-one", receivedAt: "2026-01-01T00:00:00.000Z" };
const target = { type: "node", nodeId: "agora:session:as_original" };
const id = name => `agora.task.${name}`;
const directories = [];
function temporaryDirectory() {
  const path = mkdtempSync(join(tmpdir(), "pane-actions-s2-"));
  directories.push(path);
  return path;
}
after(() => { for (const path of directories) rmSync(path, { recursive: true, force: true }); });
function setup(status = "running", dataDir = temporaryDirectory()) {
  const state = {
    taskId: "tk_actual", agoraSessionId: "as_original", status, generation: 2, revision: 7,
    model: "provider/model", profile: "explore", cwd: "D:/workspace",
  };
  const reads = [], calls = [], replies = [];
  let online = true;
  let readFailure;
  let beforeRead;
  let session = { agoraSessionId: "as_original", taskId: "tk_actual", kind: "task" };
  const runtime = {
    context: { dataDir, token: "此凭据不可写入快照" }, online: () => online,
    api: {
      async request(method, path) {
        reads.push({ method, path });
        await beforeRead?.(method, path);
        if (readFailure instanceof Error) throw readFailure;
        if (readFailure) return structuredClone(readFailure);
        if (method === "GET" && path === "/sessions/as_original") return { status: 200, body: structuredClone(session) };
        if (method === "GET" && path === "/tasks/tk_actual") return { status: 200, body: structuredClone(state) };
        throw new Error(`测试不支持的请求：${method} ${path}`);
      },
    },
  };
  const actions = createActions(runtime, async (method, path, body, options) => {
    calls.push({ method, path, body, options });
    const reply = replies.shift();
    if (reply instanceof Error) throw reply;
    if (typeof reply === "function") return reply(body);
    return reply ?? { status: 200, body: { ...state, agoraSessionId: "as_created" } };
  });
  return {
    actions, state, reads, calls, replies, dataDir,
    setOnline: value => { online = value; },
    setReadFailure: value => { readFailure = value; },
    setBeforeRead: value => { beforeRead = value; },
    setSession: value => { session = value; },
  };
}
async function invocation(s, action, fields, key = `${action}-key`, selectedTarget = target) {
  const form = await s.actions.resolveForm(id(action), selectedTarget);
  assert.ok(form, "动作应提供表单");
  return {
    actionId: id(action), target: selectedTarget, idempotencyKey: key,
    input: { answers: [], fields }, formId: form.id, formRevision: form.revision,
  };
}
const spawn = { model: "provider/model", profile: "explore", prompt: "检查任务" };
const stop = key => ({ actionId: id("stop"), target, idempotencyKey: key });

test("静态目录仅开放五个任务动作，返回副本且文案为中文", () => {
  const s = setup();
  const list = s.actions.list();
  assert.deepEqual(list.map(item => item.id), ["spawn", "steer", "stop", "cleanup", "recover"].map(id));
  assert.ok(list.every(item => /[\u4e00-\u9fff]/.test(item.title)));
  assert.equal(list.find(item => item.id === id("recover")).timeoutMs, 60000);
  assert.ok(list.find(item => item.id === id("stop")).confirm);
  list.length = 0;
  assert.equal(s.actions.list().length, 5);
  assert.equal(s.reads.length, 0);
});

test("global spawn 使用白名单字段并打开新会话", async () => {
  const s = setup();
  const inv = await invocation(s, "spawn", { ...spawn, thinking: "high", isolation: "worktree", cwd: "D:/project", title: "只读检查" }, " key-preserved ", { type: "global" });
  assert.deepEqual(await s.actions.invoke(inv, origin), { status: "ok", openNodeId: "agora:session:as_created" });
  assert.equal(s.reads.length, 0);
  assert.deepEqual(s.calls[0], {
    method: "POST", path: "/tasks", body: { ...spawn, thinking: "high", isolation: "worktree", cwd: "D:/project", title: "只读检查" },
    options: { idempotencyKey: " key-preserved ", origin },
  });
});

test("省略 global 目标可创建任务，节点 spawn 先解析任务", async () => {
  const s = setup();
  const form = await s.actions.resolveForm(id("spawn"));
  assert.ok(form);
  const result = await s.actions.invoke({ actionId: id("spawn"), formId: form.id, formRevision: form.revision, input: { answers: [], fields: spawn }, idempotencyKey: "global" }, origin);
  assert.equal(result.status, "ok");
  const inv = await invocation(s, "spawn", spawn, "node");
  assert.equal((await s.actions.invoke(inv, origin)).status, "ok");
  assert.equal(s.reads[0].path, "/sessions/as_original");
  assert.equal(s.reads[1].path, "/tasks/tk_actual");
});

test("返工、停止、清理映射 taskId 并保留状态条件", async () => {
  for (const [action, status, fields, body] of [
    ["steer", "running", { message: "补充测试", interrupt: "true" }, { message: "补充测试", interrupt: true }],
    ["stop", "running", undefined, {}],
    ["cleanup", "completed", { discard: "false" }, { discard: false }],
  ]) {
    const s = setup(status);
    const inv = action === "stop" ? stop("stop") : await invocation(s, action, fields);
    assert.equal((await s.actions.invoke(inv, origin)).status, "ok");
    assert.deepEqual(s.calls[0], {
      method: "POST", path: `/tasks/tk_actual/${action}`, body: { ...body, expectedGeneration: 2, expectedRevision: 7 },
      options: { idempotencyKey: inv.idempotencyKey, origin },
    });
    assert.ok(s.reads.some(read => read.path === "/sessions/as_original"));
    assert.ok(!s.calls.some(call => call.path.includes("as_original")));
  }
});

test("recover 的 resume、reopen、abandon 均使用用户级执行器", async () => {
  for (const mode of ["resume", "reopen", "abandon"]) {
    const s = setup("interrupted");
    const inv = await invocation(s, "recover", { mode });
    assert.equal((await s.actions.invoke(inv, origin)).status, "ok");
    assert.deepEqual(s.calls[0].body, { mode, expectedGeneration: 2, expectedRevision: 7 });
    assert.equal(s.calls[0].options.actAsUser, true);
    assert.equal(s.calls[0].options.origin, origin);
  }
});

test("recover replace 分步表单包含 model/profile，同 key 改输入冲突，新 key 执行", async () => {
  const s = setup("interrupted");
  const inv = await invocation(s, "recover", { mode: "replace" }, "choose-replace");
  const first = await s.actions.invoke(inv, origin);
  assert.equal(first.status, "needsInput");
  assert.deepEqual(first.followUpForm.fields.map(field => field.id), ["model", "profile"]);
  assert.equal(first.followUpForm.fields[0].default, "provider/model");
  assert.deepEqual(await s.actions.invoke(inv, origin), first);
  assert.equal(s.calls.length, 0);
  const follow = {
    ...inv, formId: first.followUpForm.id, formRevision: first.followUpForm.revision,
    input: { answers: [], fields: { model: "other/new", profile: "review" } },
  };
  assert.equal((await s.actions.invoke(follow, origin)).status, "idempotencyConflict");
  follow.idempotencyKey = "execute-replace";
  assert.equal((await s.actions.invoke(follow, origin)).status, "ok");
  assert.deepEqual(s.calls[0].body, { mode: "replace", model: "other/new", profile: "review", expectedGeneration: 2, expectedRevision: 7 });
  assert.equal(s.calls[0].options.actAsUser, true);
});

test("resolveForm 按当前状态取允许项，ID 和 createdAt 稳定，修订号递增", async () => {
  const s = setup("interrupted");
  const first = await s.actions.resolveForm(id("recover"), target);
  assert.deepEqual(first.fields[0].options, ["resume", "reopen", "replace", "abandon"]);
  const untouched = structuredClone(first);
  first.fields[0].options.length = 0;
  assert.deepEqual(await s.actions.resolveForm(id("recover"), target), untouched);
  s.state.status = "quota_paused";
  s.state.revision++;
  const quota = await s.actions.resolveForm(id("recover"), target);
  assert.equal(quota.id, untouched.id);
  assert.equal(quota.createdAt, untouched.createdAt);
  assert.equal(quota.revision, untouched.revision + 1);
  assert.deepEqual(quota.fields[0].options, ["resume"]);
  const stale = { actionId: id("recover"), target, formId: untouched.id, formRevision: untouched.revision, idempotencyKey: "stale", input: { answers: [], fields: { mode: "resume" } } };
  assert.equal((await s.actions.invoke(stale, origin)).status, "failed");
  const current = { ...stale, formRevision: quota.revision, idempotencyKey: "quota" };
  assert.equal((await s.actions.invoke(current, origin)).status, "ok");
  s.state.status = "running";
  s.state.revision++;
  assert.equal(await s.actions.resolveForm(id("recover"), target), null);
  assert.equal(s.calls.length, 1);
});

test("quota 暂停只允许 resume，replace 旧分步表单不能越过新状态", async () => {
  const q = setup("quota_paused");
  for (const mode of ["replace", "reopen", "abandon"]) {
    const inv = await invocation(q, "recover", { mode }, mode);
    assert.equal((await q.actions.invoke(inv, origin)).status, "failed");
  }
  assert.equal(q.calls.length, 0);
  const s = setup("interrupted");
  const inv = await invocation(s, "recover", { mode: "replace" });
  const next = await s.actions.invoke(inv, origin);
  s.state.revision++;
  const result = await s.actions.invoke({ ...inv, idempotencyKey: "follow-stale", formId: next.followUpForm.id, formRevision: next.followUpForm.revision, input: { answers: [], fields: { model: "new/model", profile: "explore" } } }, origin);
  assert.equal(result.status, "failed");
  assert.equal(s.calls.length, 0);
});

test("pending 重试再次到执行器，body 与条件字段不随当前状态变化", async () => {
  const s = setup();
  const inv = await invocation(s, "steer", { message: "返工", interrupt: "false" });
  s.replies.push({ status: 202, body: { status: "awaiting_confirmation" } }, { status: 200, body: {} });
  assert.equal((await s.actions.invoke(inv, origin)).status, "pending");
  const reads = s.reads.length;
  s.state.revision = 100;
  s.state.generation = 9;
  s.state.status = "stopped";
  const retryOrigin = { ...origin, connectionId: "retry-tab", receivedAt: "2026-01-02T00:00:00.000Z" };
  assert.equal((await s.actions.invoke(inv, retryOrigin)).status, "ok");
  assert.equal(s.calls.length, 2);
  assert.equal(s.reads.length, reads);
  assert.deepEqual(s.calls[0].body, s.calls[1].body);
  assert.equal(s.calls[1].options.origin, retryOrigin);
  assert.equal(s.calls[1].options.idempotencyKey, inv.idempotencyKey);
});

test("五个动作均能从 pending 使用原 key 查询到成功", async () => {
  for (const [action, status, fields, selectedTarget] of [
    ["spawn", "running", spawn, { type: "global" }],
    ["steer", "running", { message: "补充验证" }, target],
    ["stop", "running", undefined, target],
    ["cleanup", "completed", { discard: "true" }, target],
    ["recover", "interrupted", { mode: "resume" }, target],
  ]) {
    const s = setup(status);
    const inv = action === "stop" ? stop("retry-all") : await invocation(s, action, fields, "retry-all", selectedTarget);
    s.replies.push({ status: 202, body: {} }, { status: 200, body: { agoraSessionId: "as_after" } });
    assert.equal((await s.actions.invoke(inv, origin)).status, "pending");
    s.state.revision++;
    const result = await s.actions.invoke(inv, origin);
    assert.equal(result.status, "ok");
    if (action === "spawn") assert.equal(result.openNodeId, "agora:session:as_after");
    assert.equal(s.calls.length, 2);
    assert.deepEqual(s.calls[0].body, s.calls[1].body);
    assert.equal(s.calls[1].options.idempotencyKey, inv.idempotencyKey);
  }
});

test("执行器或调用者修改参数不会污染保存的请求快照", async () => {
  const s = setup();
  const inv = await invocation(s, "steer", { message: "原指令" });
  s.replies.push(body => { body.expectedRevision = 99; return { status: 202, body: {} }; });
  await s.actions.invoke(inv, origin);
  inv.input.fields.message = "其他指令";
  assert.equal((await s.actions.invoke(inv, origin)).status, "idempotencyConflict");
  inv.input.fields.message = "原指令";
  await s.actions.invoke(inv, origin);
  assert.equal(s.calls[1].body.expectedRevision, 7);
});

test("同 key 完整调用不同即冲突，包括映射成相同 body 的字段", async () => {
  for (const change of [
    inv => { inv.input.fields.interrupt = "false"; },
    inv => { inv.input.answers = []; inv.input.fields.unknown = "值"; },
    inv => { inv.formId += "-other"; },
    inv => { inv.formRevision++; },
    inv => { inv.target = { type: "global" }; },
    inv => { inv.actionId = id("cleanup"); },
  ]) {
    const s = setup();
    const inv = await invocation(s, "steer", { message: "指令" }, "same");
    assert.equal((await s.actions.invoke(inv, origin)).status, "ok");
    const changed = structuredClone(inv);
    change(changed);
    assert.equal((await s.actions.invoke(changed, origin)).status, "idempotencyConflict");
    assert.equal(s.calls.length, 1);
  }
  const s = setup();
  const inv = await invocation(s, "spawn", spawn, "global-key", { type: "global" });
  await s.actions.invoke(inv, origin);
  const noTarget = { ...inv }; delete noTarget.target;
  assert.equal((await s.actions.invoke(noTarget, origin)).status, "idempotencyConflict");
});

test("对象键顺序不同保持身份相同，结果不缓存", async () => {
  const s = setup();
  const inv = await invocation(s, "steer", { interrupt: "false", message: "指令" });
  await s.actions.invoke(inv, origin);
  inv.input.fields = { message: "指令", interrupt: "false" };
  assert.equal((await s.actions.invoke(inv, origin)).status, "ok");
  assert.equal(s.calls.length, 2);
});

test("并发重试共享固定参数准备，但每次查询执行器", async () => {
  const s = setup();
  const inv = await invocation(s, "steer", { message: "并发指令" });
  const before = s.reads.length;
  const results = await Promise.all([s.actions.invoke(inv, origin), s.actions.invoke(structuredClone(inv), origin)]);
  assert.ok(results.every(result => result.status === "ok"));
  assert.equal(s.reads.length - before, 2);
  assert.equal(s.calls.length, 2);
  assert.deepEqual(s.calls[0].body, s.calls[1].body);
});

test("目标严格校验，panelRow、外部来源和无 taskId 会话不能执行", async () => {
  for (const bad of [
    undefined, { type: "global" }, { type: "panelRow", panelId: "p", rowId: "r", nodeId: target.nodeId },
    { type: "node", nodeId: "pane:session:as_original" }, { type: "node", nodeId: "agora:session:tk_actual" },
    { type: "node", nodeId: "agora:session:as_../x" }, { type: "node", nodeId: "agora:meeting:mt_one" },
    { type: "node", nodeId: "agora:session:as_" },
  ]) {
    const s = setup();
    assert.equal((await s.actions.invoke({ ...stop("bad"), target: bad }, origin)).status, "failed");
    assert.equal(s.calls.length, 0);
    assert.equal(s.reads.length, 0);
  }
  for (const session of [
    { kind: "meeting-seat", taskId: "tk_actual" }, { kind: "task" }, { kind: "task", taskId: "as_original" },
  ]) {
    const s = setup(); s.setSession(session);
    assert.equal((await s.actions.invoke(stop("no-task"), origin)).status, "failed");
    assert.equal(s.calls.length, 0);
  }
});

test("白名单、必填、类型和值域验证阻止任意字段传入 daemon", async () => {
  const badSpawn = [
    {}, { ...spawn, model: "short" }, { ...spawn, model: "a/model bad" }, { ...spawn, model: 4 },
    { ...spawn, profile: "admin" }, { ...spawn, prompt: " " }, { ...spawn, prompt: false },
    { ...spawn, thinking: "extreme" }, { ...spawn, isolation: "shared" }, { ...spawn, cwd: 12 },
    { ...spawn, title: [] }, { ...spawn, actAsUser: "true" }, { ...spawn, boardId: "board" },
  ];
  for (const fields of badSpawn) {
    const s = setup();
    const inv = await invocation(s, "spawn", fields, "bad", { type: "global" });
    assert.equal((await s.actions.invoke(inv, origin)).status, "failed", JSON.stringify(fields));
    assert.equal(s.calls.length, 0);
  }
  for (const [action, fields] of [
    ["steer", { message: "" }], ["steer", { message: ["x"] }], ["steer", { message: "m", interrupt: true }],
    ["steer", { message: "m", interrupt: "yes" }], ["cleanup", { discard: false }], ["cleanup", { arbitrary: "body" }],
  ]) {
    const s = setup(action === "cleanup" ? "completed" : "running");
    const inv = await invocation(s, action, fields);
    assert.equal((await s.actions.invoke(inv, origin)).status, "failed");
    assert.equal(s.calls.length, 0);
  }
});

test("输入结构、表单身份、停止动作参数与未实现动作均校验", async () => {
  for (const change of [
    inv => { delete inv.formId; }, inv => { inv.formRevision = "1"; },
    inv => { inv.input.answers = [{ id: "unknown", selected: ["anything"] }]; },
    inv => { inv.input.fields = null; }, inv => { inv.input.extra = "bad"; },
  ]) {
    const s = setup();
    const inv = await invocation(s, "steer", { message: "m" }); change(inv);
    assert.equal((await s.actions.invoke(inv, origin)).status, "failed");
    assert.equal(s.calls.length, 0);
  }
  const s = setup();
  assert.equal((await s.actions.invoke({ ...stop("stop-input"), input: { answers: [] } }, origin)).status, "failed");
  assert.equal((await s.actions.invoke({ actionId: "agora.meeting.convene", idempotencyKey: "meeting" }, origin)).status, "failed");
  assert.equal(await s.actions.resolveForm("agora.meeting.convene", { type: "global" }), null);
  assert.equal((await s.actions.invoke({ ...stop("wrong"), extra: "unsupported" }, origin)).status, "failed");
});

test("无输入时提供表单，失效或其他动作表单不能直接执行", async () => {
  const s = setup();
  const first = await s.actions.invoke({ actionId: id("steer"), target, idempotencyKey: "needs-input" }, origin);
  assert.equal(first.status, "needsInput");
  const inv = await invocation(s, "spawn", spawn, "wrong-form", { type: "global" });
  inv.actionId = id("steer"); inv.target = target;
  assert.equal((await s.actions.invoke(inv, origin)).status, "failed");
  assert.equal(s.calls.length, 0);
  assert.equal(await s.actions.resolveForm(id("stop"), target), null);
});

test("HTTP 错误按响应体映射，传输异常和未知服务端结果保持 pending", async () => {
  for (const [reply, expected] of [
    [{ status: 400, body: { error: { code: "invalid", message: "参数无效" } } }, "failed"],
    [{ status: 403, body: { error: { code: "forbidden", message: "无权操作" } } }, "failed"],
    [{ status: 409, body: { error: { code: "conflict", message: "状态已变化" } } }, "failed"],
    [{ status: 409, body: { error: { code: "idempotency_mismatch", message: "请求标识冲突" } } }, "idempotencyConflict"],
    [{ status: 202, body: {} }, "pending"], [{ status: 503, body: {} }, "pending"],
    [new Error("网络断开"), "pending"], [{ status: 204, body: null }, "ok"],
  ]) {
    const s = setup(); s.replies.push(reply);
    assert.equal((await s.actions.invoke(stop("reply"), origin)).status, expected);
  }
});

test("断线后原 key 可继续查询成功，读状态断线不会固化 pending", async () => {
  const s = setup(); s.replies.push(new Error("写入后断线"), { status: 200, body: {} });
  const inv = stop("network");
  assert.equal((await s.actions.invoke(inv, origin)).status, "pending");
  s.state.revision++;
  assert.equal((await s.actions.invoke(inv, origin)).status, "ok");
  assert.deepEqual(s.calls[0].body, s.calls[1].body);
  const r = setup(); r.setReadFailure(new Error("读取断线"));
  assert.equal((await r.actions.invoke(stop("read-network"), origin)).status, "pending");
  r.setReadFailure(undefined);
  assert.equal((await r.actions.invoke(stop("read-network"), origin)).status, "ok");
  const h = setup(); h.setReadFailure({ status: 404, body: { error: { code: "not_found", message: "未找到会话" } } });
  assert.deepEqual(await h.actions.invoke(stop("missing"), origin), { status: "failed", message: "未找到会话" });
});

test("身份与表单保留 24 小时，过期不重用旧表单", async t => {
  const originalNow = Date.now();
  let now = originalNow;
  t.mock.method(Date, "now", () => now);
  const s = setup();
  const inv = await invocation(s, "steer", { message: "原始指令" }, "expires");
  await s.actions.invoke(inv, origin);
  now += 24 * 60 * 60 * 1000 - 1;
  assert.equal((await s.actions.invoke({ ...inv, input: { answers: [], fields: { message: "其他指令" } } }, origin)).status, "idempotencyConflict");
  now += 2;
  assert.equal((await s.actions.invoke(inv, origin)).status, "failed");
  const current = await invocation(s, "steer", { message: "其他指令" }, "new-after-expiry");
  assert.equal((await s.actions.invoke(current, origin)).status, "ok");
  assert.equal(s.calls.length, 2);
});

test("离线隐藏表单且动作 pending，恢复连接后同 key 执行", async () => {
  const s = setup(); s.setOnline(false);
  assert.equal(await s.actions.resolveForm(id("steer"), target), null);
  assert.equal((await s.actions.invoke(stop("offline"), origin)).status, "pending");
  assert.equal(s.reads.length, 0);
  s.setOnline(true);
  assert.equal((await s.actions.invoke(stop("offline"), origin)).status, "ok");
});

test("五个动作跨重启使用落盘的 HTTP 快照，不查表单和当前状态", async () => {
  for (const [action, status, fields, selectedTarget] of [
    ["spawn", "running", spawn, { type: "global" }],
    ["steer", "running", { message: "跨重启返工" }, target],
    ["stop", "running", undefined, target],
    ["cleanup", "completed", { discard: "true" }, target],
    ["recover", "interrupted", { mode: "resume" }, target],
  ]) {
    const s = setup(status);
    const inv = action === "stop" ? stop("restart") : await invocation(s, action, fields, "restart", selectedTarget);
    let durableBeforeExecute = false;
    s.replies.push(async () => {
      const saved = JSON.parse(await readFile(join(s.dataDir, "actions.json"), "utf8"));
      const entry = saved.data.identities.find(([key]) => key === inv.idempotencyKey)[1];
      assert.equal(entry.fingerprint.length, 64);
      assert.equal(entry.operation.method, "POST");
      assert.deepEqual(entry.operation.body, s.calls[0].body);
      assert.equal(entry.result, undefined);
      durableBeforeExecute = true;
      return { status: 202, body: {} };
    });
    assert.equal((await s.actions.invoke(inv, origin)).status, "pending");
    assert.equal(durableBeforeExecute, true, "execute 前必须完成快照写入");
    const recovered = setup("stopped", s.dataDir);
    recovered.state.generation = 99;
    recovered.state.revision = 999;
    recovered.setReadFailure(new Error("重试不能预检"));
    const retryOrigin = { ...origin, connectionId: "重启后的连接" };
    assert.equal((await recovered.actions.invoke(inv, retryOrigin)).status, "ok");
    assert.deepEqual(recovered.calls[0].body, s.calls[0].body);
    assert.equal(recovered.calls[0].method, s.calls[0].method);
    assert.equal(recovered.calls[0].path, s.calls[0].path);
    assert.equal(recovered.calls[0].options.actAsUser, s.calls[0].options.actAsUser);
    assert.equal(recovered.calls[0].options.origin, retryOrigin);
    assert.equal(recovered.reads.length, 0);
    recovered.replies.push({ status: 403, body: { error: { message: "再次查询的 daemon 结果" } } });
    assert.equal((await recovered.actions.invoke(inv, origin)).status, "failed");
    assert.equal(recovered.calls.length, 2);
    const disk = await readFile(join(s.dataDir, "actions.json"), "utf8");
    assert.ok(!disk.includes("此凭据不可写入快照"));
    assert.ok(!disk.includes("connectionId"));
    assert.ok(!disk.includes("再次查询的 daemon 结果"));
  }
});

test("执行写入后断线也能跨重启查询，已完成结果同样重新转发", async () => {
  const s = setup();
  const inv = stop("transport-restart");
  s.replies.push(new Error("daemon 已收到请求"));
  assert.equal((await s.actions.invoke(inv, origin)).status, "pending");
  const next = setup("stopped", s.dataDir);
  next.setReadFailure(new Error("禁止预检"));
  assert.equal((await next.actions.invoke(inv, origin)).status, "ok");
  const last = setup("stopped", s.dataDir);
  last.replies.push({ status: 202, body: {} });
  assert.equal((await last.actions.invoke(inv, origin)).status, "pending");
  assert.equal(last.reads.length, 0);
  assert.deepEqual(last.calls[0].body, s.calls[0].body);
});

test("完整调用指纹跨重启保留，等价 HTTP 输入也不能更改同 key", async () => {
  const s = setup();
  const inv = await invocation(s, "steer", { message: "原指令" }, "durable-identity");
  s.replies.push({ status: 202, body: {} });
  await s.actions.invoke(inv, origin);
  const next = setup("running", s.dataDir);
  for (const change of [
    value => { value.input.fields.interrupt = "false"; },
    value => { value.formRevision++; },
    value => { value.formId += "-other"; },
    value => { value.target = { type: "global" }; },
    value => { value.extra = "unknown"; },
  ]) {
    const changed = structuredClone(inv);
    change(changed);
    assert.equal((await next.actions.invoke(changed, origin)).status, "idempotencyConflict");
  }
  assert.equal(next.calls.length, 0);
  assert.equal(next.reads.length, 0);
});

test("动态表单跨重启可直接新 key 提交，状态变化后旧版本仍被拒绝", async () => {
  for (const [action, status, fields, selectedTarget] of [
    ["spawn", "running", spawn, { type: "global" }],
    ["steer", "running", { message: "提交保留的表单" }, target],
    ["cleanup", "completed", { discard: "false" }, target],
    ["recover", "interrupted", { mode: "reopen" }, target],
  ]) {
    const s = setup(status);
    const inv = await invocation(s, action, fields, "submit-after-restart", selectedTarget);
    const next = setup(status, s.dataDir);
    assert.equal((await next.actions.invoke(inv, origin)).status, "ok");
    const old = await next.actions.resolveForm(id(action), selectedTarget);
    const another = setup(status, s.dataDir);
    const stable = await another.actions.resolveForm(id(action), selectedTarget);
    assert.deepEqual(stable, old);
    if (selectedTarget.type === "node") {
      another.state.revision++;
      const changed = await another.actions.resolveForm(id(action), selectedTarget);
      assert.equal(changed.id, stable.id);
      assert.equal(changed.createdAt, stable.createdAt);
      assert.equal(changed.revision, stable.revision + 1);
      const final = setup(status, s.dataDir);
      final.state.revision++;
      assert.equal((await final.actions.invoke({ ...inv, idempotencyKey: "stale-version" }, origin)).status, "failed");
      assert.equal(final.calls.length, 0);
    }
  }
});

test("needsInput 与 replace 分步表单跨重启稳定，新 key 校验后执行", async () => {
  const s = setup("interrupted");
  const request = { actionId: id("recover"), target, idempotencyKey: "need-recover" };
  const first = await s.actions.invoke(request, origin);
  const next = setup("interrupted", s.dataDir);
  next.setReadFailure(new Error("表单结果重放不读取状态"));
  assert.deepEqual(await next.actions.invoke(request, origin), first);
  next.setReadFailure(undefined);
  const choose = {
    ...request, idempotencyKey: "choose-after-restart", formId: first.followUpForm.id,
    formRevision: first.followUpForm.revision, input: { answers: [], fields: { mode: "replace" } },
  };
  const replacement = await next.actions.invoke(choose, origin);
  assert.equal(replacement.status, "needsInput");
  const last = setup("interrupted", s.dataDir);
  last.state.revision++;
  assert.deepEqual(await last.actions.invoke(choose, origin), replacement);
  const follow = {
    ...choose, idempotencyKey: "replace-after-restart", formId: replacement.followUpForm.id,
    formRevision: replacement.followUpForm.revision, input: { answers: [], fields: { model: "new/model", profile: "review" } },
  };
  assert.equal((await last.actions.invoke(follow, origin)).status, "failed");
  last.state.revision--;
  assert.equal((await last.actions.invoke(follow, origin)).status, "ok");
  assert.deepEqual(last.calls[0].body, { mode: "replace", model: "new/model", profile: "review", expectedGeneration: 2, expectedRevision: 7 });
});

test("离线与预检失败的身份也落盘，pending 不阻止恢复后再次准备", async () => {
  for (const failure of ["offline", "read"]) {
    const s = setup();
    if (failure === "offline") s.setOnline(false);
    else s.setReadFailure(new Error("预检断线"));
    const inv = stop(`before-prepare-${failure}`);
    assert.equal((await s.actions.invoke(inv, origin)).status, "pending");
    const next = setup("running", s.dataDir);
    assert.equal((await next.actions.invoke({ ...inv, actionId: id("cleanup") }, origin)).status, "idempotencyConflict");
    assert.equal((await next.actions.invoke(inv, origin)).status, "ok");
    assert.equal(next.calls.length, 1);
    assert.equal(next.reads.length, 2);
  }
});

test("损坏快照或写入失败均阻止 HTTP 执行，并且不自行覆盖损坏文件", async () => {
  for (const content of ["{", "{}", '{"version":1,"data":{}}', '{"version":1,"data":{"identities":[],"forms":[],"versions":[["bad",{}]]}}']) {
    const s = setup();
    const path = join(s.dataDir, "actions.json");
    await writeFile(path, content);
    assert.equal((await s.actions.invoke(stop("corrupt"), origin)).status, "failed");
    assert.equal(await s.actions.resolveForm(id("steer"), target), null);
    assert.equal(s.calls.length, 0);
    assert.equal(s.reads.length, 0);
    assert.equal(await readFile(path, "utf8"), content);
  }
  const s = setup();
  const inv = stop("save-failure");
  // 身份文件可以写入，但预检后最终快照的原子替换必须失败。
  const path = join(s.dataDir, "actions.json");
  s.setBeforeRead(async (_method, requestPath) => {
    if (requestPath !== "/tasks/tk_actual") return;
    rmSync(path);
    await mkdir(path);
  });
  assert.equal((await s.actions.invoke(inv, origin)).status, "failed");
  rmSync(path, { recursive: true });
  assert.equal((await s.actions.invoke(inv, origin)).status, "failed");
  assert.equal(s.calls.length, 0);
});

test("合法 JSON 中的无效 HTTP 或表单结构同样关闭执行", async () => {
  for (const mutate of [
    saved => { saved.data.identities[0][1].operation.method = "DELETE"; },
    saved => { saved.data.identities[0][1].operation.path = "/auth/token"; },
    saved => { saved.data.identities[0][1].operation.body.expectedRevision = "7"; },
    saved => { saved.data.identities[0][1].operation.body.token = "不能恢复凭据"; },
  ]) {
    const s = setup();
    const inv = stop("invalid-snapshot");
    await s.actions.invoke(inv, origin);
    const path = join(s.dataDir, "actions.json");
    const saved = JSON.parse(await readFile(path, "utf8"));
    mutate(saved);
    await writeFile(path, JSON.stringify(saved));
    const next = setup("running", s.dataDir);
    assert.equal((await next.actions.invoke(inv, origin)).status, "failed");
    assert.equal(next.calls.length, 0);
    assert.equal(next.reads.length, 0);
  }
  const s = setup();
  await s.actions.resolveForm(id("steer"), target);
  const path = join(s.dataDir, "actions.json");
  const saved = JSON.parse(await readFile(path, "utf8"));
  saved.data.forms[0][1].record.form.fields = [null];
  await writeFile(path, JSON.stringify(saved));
  const next = setup("running", s.dataDir);
  assert.equal((await next.actions.invoke(stop("bad-form-storage"), origin)).status, "failed");
  assert.equal(next.calls.length, 0);
});

test("未过期身份达到容量后拒绝新请求，不驱逐已有快照", async () => {
  const s = setup();
  await s.actions.invoke(stop("retained"), origin);
  const path = join(s.dataDir, "actions.json");
  const saved = JSON.parse(await readFile(path, "utf8"));
  while (saved.data.identities.length < 4096) {
    saved.data.identities.push([`reserved-${saved.data.identities.length}`, { fingerprint: "0".repeat(64), expiresAt: Date.now() + 24 * 60 * 60 * 1000 }]);
  }
  const content = JSON.stringify(saved);
  await writeFile(path, content);
  const next = setup("running", s.dataDir);
  assert.equal((await next.actions.invoke(stop("over-capacity"), origin)).status, "failed");
  assert.equal(next.calls.length, 0);
  assert.equal(next.reads.length, 0);
  assert.equal(await readFile(path, "utf8"), content);
});

test("持久化身份与快照在重启后仍保留至少 24 小时", async t => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const s = setup();
  s.setOnline(false);
  const inv = stop("long-offline");
  await s.actions.invoke(inv, origin);
  now += 23 * 60 * 60 * 1000;
  const prepared = setup("running", s.dataDir);
  prepared.replies.push({ status: 202, body: {} });
  await prepared.actions.invoke(inv, origin);
  now += 24 * 60 * 60 * 1000 - 1;
  const next = setup("stopped", s.dataDir);
  next.setReadFailure(new Error("禁止重读"));
  assert.equal((await next.actions.invoke(inv, origin)).status, "ok");
  assert.deepEqual(next.calls[0].body, prepared.calls[0].body);
  assert.equal((await next.actions.invoke({ ...inv, target: { type: "global" } }, origin)).status, "idempotencyConflict");
});
