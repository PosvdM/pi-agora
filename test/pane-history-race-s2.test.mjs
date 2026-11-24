import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createActions } from "../packages/pane-plugin/dist/actions.js";
import { createViews } from "../packages/pane-plugin/dist/views.js";

const ref = { source: "agora", id: "as_old" };
const target = { type: "node", nodeId: "agora:session:as_old" };
const origin = { client: "browser", connectionId: "race-tab", receivedAt: "2026-01-01T00:00:00Z" };
const fields = {
  spawn: { model: "provider/model", profile: "explore", prompt: "检查边界", cwd: "D:/workspace" },
  steer: { message: "补充指令" }, cleanup: { discard: "false" }, recover: { mode: "reopen" }, takeover: {},
};
const actions = ["spawn", "steer", "stop", "cleanup", "recover", "takeover"];
async function setup(t, action = "stop") {
  const dataDir = await mkdtemp(join(tmpdir(), "pane-history-race-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const task = { taskId: "tk_same", agoraSessionId: ref.id, status: action === "recover" ? "interrupted" : action === "cleanup" ? "completed" : "running",
    generation: 2, revision: 7, model: "provider/model", profile: "explore", cwd: "D:/workspace" };
  const session = { agoraSessionId: ref.id, taskId: task.taskId, kind: "task", isCurrent: true,
    status: task.status, revision: 999, parent: action === "takeover" ? { kind: "main", piSessionId: "main" } : { kind: "user" } };
  const reads = [], writes = [];
  const h = { task, session, reads, writes, stopped: 0, beforeTaskRead: undefined, beforeWrite: undefined, failReads: false };
  const runtime = {
    context: { dataDir, log: { warn() {} }, mainSessions: { get() {}, onChange() { return () => {}; } } },
    online: () => true,
    api: { async request(method, path, body, options) {
      if (method === "GET") {
        assert.equal(h.failReads, false, "prepared 重试不能重新读取状态");
        reads.push(path);
        if (path === "/v1/sessions/as_old") return { status: 200, body: structuredClone(session) };
        if (path === "/v1/tasks/tk_same") {
          await h.beforeTaskRead?.();
          return { status: 200, body: structuredClone(task) };
        }
        if (path === "/v1/sessions/as_old/snapshot") return { status: 200, body: {
          cursor: { epoch: "run", seq: 0 }, leafId: null, entries: [], historyBefore: null, status: session.status,
        } };
        if (path.startsWith("/v1/sessions?")) return { status: 200, body: { items: [], changesCursor: { epoch: "db", seq: 1 } } };
        assert.fail(`Unexpected GET ${path}`);
      }
      assert.equal(method, "POST");
      writes.push({ method, path, body: structuredClone(body), options });
      const reply = await h.beforeWrite?.(body);
      if (reply) return reply;
      if (body.expectedGeneration !== task.generation || body.expectedRevision !== task.revision) {
        return { status: 409, body: { error: { code: "stale", message: "stale task revision" } } };
      }
      h.stopped++;
      return { status: 200, body: { droppedSteers: [] } };
    } },
  };
  const execute = (...args) => runtime.api.request(...args);
  h.actions = createActions(runtime, execute);
  h.restart = () => { h.actions = createActions(runtime, execute); };
  h.views = createViews(runtime);
  t.after(() => h.views.dispose());
  return h;
}
function invocation(action, key = action) {
  return { actionId: `agora.task.${action}`, target, idempotencyKey: key };
}
async function withForm(h, action, key = action) {
  const form = await h.actions.resolveForm(`agora.task.${action}`, target);
  assert.ok(form, `${action} 应提供表单`);
  return { ...invocation(action, key), formId: form.id, formRevision: form.revision, input: { answers: [], fields: fields[action] } };
}
function reopen(h, mode) {
  h.session.isCurrent = false;
  h.task.agoraSessionId = "as_new";
  h.task.generation++;
  h.task.revision++;
  if (mode === "replace") h.task.model = "provider/replacement";
}

test("所有任务目标动作在 session 与 task 两读之间重开或替换时拒绝准备", async t => {
  for (const mode of ["reopen", "replace"]) for (const action of actions) {
    await t.test(`${mode}: ${action}`, async t => {
      const h = await setup(t, action);
      h.beforeTaskRead = () => reopen(h, mode);
      const result = await h.actions.invoke(invocation(action), origin);
      assert.equal(result.status, "failed");
      assert.deepEqual(h.reads, ["/v1/sessions/as_old", "/v1/tasks/tk_same"]);
      assert.equal(h.writes.length, 0);
    });
  }
});

test("旧动态表单与 composer 在两读之间切换会话时不能绑定新运行", async t => {
  for (const mode of ["reopen", "replace"]) for (const action of [...actions.filter(action => action !== "stop"), "composer"]) {
    await t.test(`${mode}: ${action}`, async t => {
      const h = await setup(t, action);
      const inv = action === "composer" ? { ...invocation("steer"), input: { answers: [], fields: fields.steer } } : await withForm(h, action);
      h.reads.length = 0;
      h.beforeTaskRead = () => reopen(h, mode);
      assert.equal((await h.actions.invoke(inv, origin)).status, "failed");
      assert.deepEqual(h.reads, ["/v1/sessions/as_old", "/v1/tasks/tk_same"]);
      assert.equal(h.writes.length, 0);
    });
  }
});

test("任务响应缺少会话归属或 taskId 不符时拒绝所有新动作", async t => {
  for (const action of actions) for (const invalid of ["missingSession", "wrongTask"]) {
    await t.test(`${action}: ${invalid}`, async t => {
      const h = await setup(t, action);
      if (invalid === "missingSession") delete h.task.agoraSessionId;
      else h.task.taskId = "tk_other";
      assert.equal((await h.actions.invoke(invocation(action), origin)).status, "failed");
      assert.equal(await h.actions.resolveForm(`agora.task.${action}`, target), null);
      assert.equal(h.writes.length, 0);
    });
  }
});

test("同会话任务状态变化使旧 ActionForm 失败，新表单使用新版本", async t => {
  for (const action of actions.filter(action => action !== "stop")) {
    await t.test(action, async t => {
      const h = await setup(t, action);
      const inv = await withForm(h, action);
      h.task.revision++;
      assert.equal((await h.actions.invoke(inv, origin)).status, "failed");
      assert.equal(h.writes.length, 0);
      const current = await h.actions.resolveForm(inv.actionId, target);
      assert.equal(current.id, inv.formId);
      assert.equal(current.revision, inv.formRevision + 1);
    });
  }
});

test("任务快照后 revision 变化由条件写入返回 stale，不停止新运行", async t => {
  for (const action of ["stop", "composer", "steer", "cleanup", "recover", "takeover"]) {
    await t.test(action, async t => {
      const h = await setup(t, action);
      const inv = action === "stop" ? invocation(action) : action === "composer"
        ? { ...invocation("steer"), input: { answers: [], fields: fields.steer } } : await withForm(h, action);
      h.beforeWrite = () => { h.task.revision++; };
      const result = await h.actions.invoke(inv, origin);
      assert.equal(result.status, "failed");
      assert.match(result.message, /stale/);
      assert.equal(h.writes[0].body.expectedGeneration, 2);
      assert.equal(h.writes[0].body.expectedRevision, 7);
      assert.equal(h.stopped, 0);
    });
  }
});

test("prepared pending 跨重启仍只查询旧固定请求，不重读或重定向新会话", async t => {
  for (const action of [...actions, "composer"]) {
    await t.test(action, async t => {
      const h = await setup(t, action);
      const inv = action === "stop" ? invocation(action) : action === "composer"
        ? { ...invocation("steer"), input: { answers: [], fields: fields.steer } } : await withForm(h, action);
      h.beforeWrite = () => ({ status: 202, body: {} });
      assert.equal((await h.actions.invoke(inv, origin)).status, "pending");
      const fixed = structuredClone(h.writes[0]);
      reopen(h, "replace");
      h.reads.length = 0;
      h.failReads = true;
      h.beforeWrite = () => ({ status: 200, body: {} });
      h.restart();
      assert.equal((await h.actions.invoke(inv, origin)).status, "ok");
      assert.deepEqual(h.writes[1], fixed);
      assert.equal(h.reads.length, 0);
      assert.equal(h.stopped, 0);
    });
  }
});

test("abort 两读之间重开、替换或缺失归属时拒绝 stop 写入", async t => {
  for (const mode of ["reopen", "replace", "missingSession", "wrongTask"]) {
    await t.test(mode, async t => {
      const h = await setup(t);
      h.beforeTaskRead = () => {
        if (["reopen", "replace"].includes(mode)) reopen(h, mode);
        else if (mode === "missingSession") delete h.task.agoraSessionId;
        else h.task.taskId = "tk_other";
      };
      await assert.rejects(h.views.sessions.abort(ref, { clearQueue: true, origin }), /任务状态与目标不匹配/);
      assert.deepEqual(h.reads, ["/v1/sessions/as_old", "/v1/tasks/tk_same"]);
      assert.equal(h.writes.length, 0);
    });
  }
});

test("abort 使用 GET task 的精确版本，snapshot 后排队改变 revision 返回 stale", async t => {
  const h = await setup(t);
  assert.equal((await h.views.sessions.snapshot(ref)).readonly, false);
  h.reads.length = 0;
  h.beforeWrite = () => { h.task.revision++; };
  await assert.rejects(h.views.sessions.abort(ref, { clearQueue: true, origin }), /stale/);
  assert.deepEqual(h.reads, ["/v1/sessions/as_old", "/v1/tasks/tk_same"]);
  assert.deepEqual(h.writes[0].body, { expectedGeneration: 2, expectedRevision: 7 });
  assert.equal(h.stopped, 0);
});

test("abort 版本不变可停止，缺少或无效版本拒绝写入", async t => {
  const h = await setup(t);
  assert.deepEqual(await h.views.sessions.abort(ref, { clearQueue: true, origin }), { status: "done", clearedText: [] });
  assert.deepEqual(h.writes[0].body, { expectedGeneration: 2, expectedRevision: 7 });
  assert.equal(h.stopped, 1);
  for (const field of ["generation", "revision"]) for (const value of [undefined, 0, -1, 1.5, "7"]) {
    await t.test(`${field}=${value}`, async t => {
      const h = await setup(t);
      h.task[field] = value;
      await assert.rejects(h.views.sessions.abort(ref, { clearQueue: false, origin }), /任务版本无效/);
      assert.equal(h.writes.length, 0);
    });
  }
});

test("历史会话在准备前已非当前时不读取任务或写入", async t => {
  const h = await setup(t);
  h.session.isCurrent = false;
  assert.equal((await h.actions.invoke(invocation("stop"), origin)).status, "failed");
  assert.deepEqual(await h.views.sessions.abort(ref, { clearQueue: true, origin }), { status: "nothingToStop" });
  assert.deepEqual(h.reads, ["/v1/sessions/as_old", "/v1/sessions/as_old"]);
  assert.equal(h.writes.length, 0);
});
