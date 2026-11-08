import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setImmediate as turn, setTimeout as delay } from "node:timers/promises";
import { AgoraConnectionError } from "@pi-agora/protocol";
import createPlugin from "../packages/pane-plugin/dist/plugin.js";

const AT = "2026-01-01T00:00:00.000Z";
const RETRY_MS = 100;
const origin = { client: "browser", connectionId: "tab-a", deviceId: "device-a", receivedAt: AT };
const ref = { source: "agora", id: "as_lifecycle" };
const treeRequest = { openNodeIds: [], recentSince: "2025-01-01T00:00:00.000Z" };
const treeCursor = { epoch: "db-lifecycle", revision: 10 };
const sessionCursor = { epoch: "run-lifecycle", seq: 0 };
const alert = { alertId: "alert-one", kind: "devices-reset", revision: 1, createdAt: AT, details: { reason: "测试" } };
const question = { id: "rq-one", targetId: "user", state: "escalated", revision: 1, createdAt: AT,
  questions: [{ id: "q", question: "选择方案", options: [{ label: "甲" }, { label: "乙" }] }] };
const session = { agoraSessionId: ref.id, taskId: "tk_lifecycle", kind: "task", parentId: "pane:session:main",
  title: "生命周期任务", status: "running", revision: 1, createdAt: AT, hasChildren: false };
const submission = key => ({ formId: "agora:request:rq-one", revision: 1, idempotencyKey: key,
  outcome: { status: "submitted", values: { answers: [{ id: "q", selected: ["甲"] }] } } });
const ok = body => ({ status: 200, body });

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function eventually(predicate, message) {
  const deadline = Date.now() + 2_000;
  while (!predicate() && Date.now() < deadline) await delay(5);
  assert.ok(predicate(), message);
}
async function settle() { await turn(); await turn(); await turn(); }

async function host(t) {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const dataDir = await mkdtemp(path.join(tmpdir(), "agora-pane-lifecycle-"));
  const events = [], banners = new Map(), pendingForms = new Map(), holds = [];
  const mainListeners = new Set(), deviceListeners = new Set();
  const main = { ref: { source: "pane", id: "main" }, nodeId: "pane:session:main", cwd: dataDir,
    sessionFile: path.join(dataDir, "main.jsonl"), title: "主会话", hosted: true, status: "idle" };
  const context = {
    paneProtocol: 1, dataDir,
    log: {
      info(...args) { events.push({ type: "info", args }); },
      warn(...args) { events.push({ type: "warn", args }); },
      error(...args) { events.push({ type: "error", args }); },
    },
    notify(value) { events.push({ type: "notify", value: structuredClone(value) }); },
    panelChanged(value) { events.push({ type: "panelChanged", value: structuredClone(value) }); },
    formAdded(value) { pendingForms.set(value.id, structuredClone(value)); events.push({ type: "formAdded", value }); },
    formRemoved(id, reason) { pendingForms.delete(id); events.push({ type: "formRemoved", id, reason }); },
    setBanner(value) { banners.set(value.id, structuredClone(value)); events.push({ type: "setBanner", value }); },
    clearBanner(id) { banners.delete(id); events.push({ type: "clearBanner", id }); },
    listBanners() { return structuredClone([...banners.values()]); },
    mainSessions: {
      list: () => [structuredClone(main)],
      get: id => id === main.ref.id ? structuredClone(main) : undefined,
      onChange(listener) { mainListeners.add(listener); return () => mainListeners.delete(listener); },
      hold(value, reason) {
        const hold = { ref: structuredClone(value), reason, releases: 0 };
        holds.push(hold);
        return () => { hold.releases++; };
      },
    },
    userPresence: {
      devices: () => [{ deviceId: "device-a", publicKey: "test-key", alg: "ECDSA-P256-SHA256", label: "测试浏览器", connected: true }],
      onDevicesChange(listener) { deviceListeners.add(listener); return () => deviceListeners.delete(listener); },
      async confirm(request) {
        events.push({ type: "confirm", value: request });
        return { deviceId: "device-a", publicKey: "test-key", alg: "ECDSA-P256-SHA256", signature: "test-signature" };
      },
    },
  };
  const plugins = [];
  t.after(async () => {
    for (const plugin of plugins.toReversed()) await plugin.deactivate();
    await rm(dataDir, { recursive: true, force: true });
  });
  return { context, events, banners, pendingForms, holds, mainListeners, deviceListeners,
    plugin(options) { const value = createPlugin({ retryMs: RETRY_MS, ...options }); plugins.push(value); return value; } };
}

function seedBanner(h, kind = "devices-reset") {
  const value = { id: `agora:security:${kind}`, title: "持久安全警告", level: "error", persistent: true };
  h.banners.set(value.id, value);
  return structuredClone(value);
}

function mockApi(h, handler = () => undefined) {
  const calls = [], streams = [], polls = new Set(), unexpected = [];
  const state = { alerts: [structuredClone(alert)], requests: [structuredClone(question)], sessions: [structuredClone(session)],
    confirmations: [], devices: [], tasks: [], health: 200, authorization: 200, closed: 0 };
  const api = {
    async request(method, requestPath, body, options = {}) {
      const call = { method, path: requestPath, body: structuredClone(body), options,
        url: new URL(requestPath, "http://agora.invalid") };
      calls.push(call);
      h.events.push({ type: "request", method, path: requestPath, body: call.body });
      if (state.closed) throw new AgoraConnectionError();
      const handled = await handler(call, state);
      if (handled !== undefined) return handled;
      const pathname = call.url.pathname;
      if (method === "GET") {
        if (pathname === "/v1/health") return { status: state.health, body: {} };
        if (pathname === "/v1/status") return { status: state.authorization, body: {} };
        if (pathname === "/v1/security/alerts") return ok({ items: structuredClone(state.alerts) });
        for (const [endpoint, key] of [["requests", "requests"], ["confirmations", "confirmations"], ["devices", "devices"], ["tasks", "tasks"]]) {
          if (pathname === `/v1/${endpoint}`) return ok({ items: structuredClone(state[key]) });
        }
        if (pathname === "/v1/sessions") return ok({ items: structuredClone(state.sessions), nextCursor: null,
          changesCursor: { epoch: treeCursor.epoch, seq: treeCursor.revision } });
        if (pathname === `/v1/sessions/${ref.id}`) return ok(structuredClone(state.sessions[0]));
        if (pathname === `/v1/sessions/${ref.id}/snapshot`) return ok({ cursor: sessionCursor, leafId: null,
          entries: [], historyBefore: null, status: "running", unfinishedPartials: [] });
        if (pathname === "/v1/inbox") {
          const wait = call.url.searchParams.get("wait");
          assert.ok(wait === "0" || wait === "25", "通知轮询只使用约定的等待值");
          if (wait === "0") return ok({ items: [] });
          // 空的长轮询保持挂起，由通知、取消或 API 关闭结束，不能立刻返回并形成忙循环。
          const pending = deferred();
          const poll = { ...pending, options };
          polls.add(poll);
          const abort = () => pending.reject(new DOMException("通知轮询已取消", "AbortError"));
          if (options.signal?.aborted) abort();
          else options.signal?.addEventListener("abort", abort, { once: true });
          return pending.promise.finally(() => { polls.delete(poll); options.signal?.removeEventListener("abort", abort); });
        }
      }
      if (method === "POST" && pathname === "/v1/inbox/ack") return ok({});
      unexpected.push(`${method} ${requestPath}`);
      throw new Error(`模拟 API 未定义：${method} ${requestPath}`);
    },
    subscribe(requestPath, emit, failed) {
      const stream = { path: requestPath, emit, failed, stops: 0 };
      streams.push(stream);
      return () => { stream.stops++; };
    },
    close() {
      state.closed++;
      for (const poll of polls) poll.reject(new AgoraConnectionError());
    },
  };
  return { api, state, calls, streams, polls, unexpected,
    deliver(items) {
      assert.equal(polls.size, 1, "通知必须交给已挂起的长轮询");
      [...polls][0].resolve(ok({ items: structuredClone(items) }));
    },
    domainChange(seq = 11) {
      const stream = streams.find(value => value.path.startsWith("/v1/changes?") && value.stops === 0);
      assert.ok(stream, "领域变更流应已订阅");
      stream.emit({ type: "change", data: { cursor: { epoch: treeCursor.epoch, seq }, objectType: "security_alert", objectId: alert.alertId } });
    },
  };
}

function archiveReader() {
  const calls = [];
  let closed = 0;
  const metadata = { agoraSessionId: ref.id, kind: "task", title: "归档任务", model: "provider/model", profile: "review",
    convenerId: "user", status: "completed", archiveState: "ok", createdAt: AT, endedAt: AT, messageCount: 1 };
  const entries = [{ id: "entry-one", type: "message", message: { role: "assistant", content: "归档结果" } }];
  const reader = {
    async listSessions(query) { calls.push({ method: "listSessions", query }); return { items: [structuredClone(metadata)] }; },
    async getSession(id) { calls.push({ method: "getSession", id }); return id === ref.id ? structuredClone(metadata) : undefined; },
    async readUserView(id, query) { calls.push({ method: "readUserView", id, query }); return { leafId: "entry-one", entries: structuredClone(entries), historyBefore: null }; },
    async readPartials(id) { calls.push({ method: "readPartials", id }); return []; },
    close() { closed++; },
  };
  return { reader, calls, entries, get closed() { return closed; } };
}

async function activated(t, handler) {
  const h = await host(t), a = mockApi(h, handler);
  const plugin = h.plugin({ connect: async () => a.api, openArchive: async () => { throw new Error("在线测试不能打开存档"); } });
  await plugin.activate(h.context);
  await eventually(() => a.polls.size === 1, "启用后应有一个挂起的通知轮询");
  t.after(() => assert.deepEqual(a.unexpected, [], "模拟 API 必须显式处理所有请求"));
  return { h, a, plugin };
}

test("在线启用拉取安全警告、持久表单与保活，并从 changes 游标订阅领域变更", { timeout: 5_000 }, async t => {
  const { h, a, plugin } = await activated(t);
  assert.equal(plugin.id, "agora");
  assert.deepEqual(plugin.paneProtocol, [1, 1]);
  for (const endpoint of ["security/alerts", "requests", "confirmations", "devices", "tasks", "sessions"]) {
    assert.ok(a.calls.some(call => call.method === "GET" && call.url.pathname === `/v1/${endpoint}`), `启用时应读取 ${endpoint}`);
  }
  assert.equal(a.streams[0].path, "/v1/changes?epoch=db-lifecycle&afterSeq=10");
  assert.equal(h.banners.get("agora:security:devices-reset").persistent, true);
  assert.equal(h.pendingForms.get("agora:request:rq-one").revision, 1);
  assert.deepEqual(h.holds.map(hold => ({ ref: hold.ref, reason: hold.reason })), [
    { ref: { source: "pane", id: "main" }, reason: "等待子代理（1 个）" },
  ]);
  assert.ok(plugin.actions.list().some(action => action.id === "agora.device.pair"));
  assert.ok(plugin.renderers.customMessages.length > 0);
  const reads = a.calls.filter(call => call.url.pathname === "/v1/security/alerts").length;
  a.state.alerts[0].revision = 2;
  a.state.requests[0].revision = 2;
  a.state.sessions[0].status = "completed";
  a.domainChange();
  await eventually(() => h.pendingForms.get("agora:request:rq-one")?.revision === 2 && h.holds[0].releases === 1,
    "领域变更应刷新表单版本并释放结束任务的保活");
  assert.ok(a.calls.filter(call => call.url.pathname === "/v1/security/alerts").length > reads);
  assert.match(h.banners.get("agora:security:devices-reset").body, /警告版本：2/);
  assert.equal(a.streams.length, 1);
});

test("通知先交给宿主展示再 ack，空收件箱保持单个可取消的 wait25 长轮询", { timeout: 5_000 }, async t => {
  const { h, a, plugin } = await activated(t);
  await settle();
  assert.equal(a.calls.filter(call => call.url.pathname === "/v1/inbox").length, 1);
  a.deliver([{ noticeId: "notice-one", dedupeKey: "task:tk_lifecycle:done", kind: "task.completed",
    payload: { title: "任务完成", summary: "结果已归档", nodeId: `agora:session:${ref.id}` } }]);
  await eventually(() => a.calls.some(call => call.path === "/v1/inbox/ack") && a.polls.size === 1,
    "通知确认后应重新挂起长轮询");
  const displayed = h.events.findIndex(event => event.type === "notify");
  const acknowledged = h.events.findIndex(event => event.type === "request" && event.path === "/v1/inbox/ack");
  assert.ok(displayed >= 0 && acknowledged > displayed, "展示回调必须早于确认请求");
  assert.deepEqual(h.events[displayed].value, { id: "agora:task:tk_lifecycle:done", source: "agora", level: "info",
    title: "任务完成", body: "结果已归档", nodeId: `agora:session:${ref.id}` });
  assert.deepEqual(a.calls.find(call => call.path === "/v1/inbox/ack").body, { noticeId: "notice-one", persisted: false });
  assert.deepEqual(a.calls.filter(call => call.url.pathname === "/v1/inbox").map(call => call.url.searchParams.get("wait")), ["25", "0", "25"]);
  await plugin.deactivate(); await settle();
  assert.equal(a.polls.size, 0);
  assert.equal(a.state.closed, 1);
});

test("存档校验与预算暂停通知映射为 warning，完成通知保持 info", async t => {
  const { h, a } = await activated(t);
  const kinds = ["archive:warning", "task:budget_paused", "task:quota_paused", "task:completed"];
  a.deliver(kinds.map((kind, index) => ({ noticeId: `severity-${index}`, dedupeKey: `severity-${index}`, kind, payload: { summary: kind } })));
  await eventually(() => h.events.filter(event => event.type === "notify").length === 4, "通知应全部交给宿主");
  assert.deepEqual(h.events.filter(event => event.type === "notify").map(event => event.value.level), ["warning", "warning", "warning", "info"]);
  await eventually(() => a.calls.filter(call => call.path === "/v1/inbox/ack").length === 4, "展示后应确认全部通知");
});

test("通知展示失败不发送 ack，通知领取失败不会形成空转轮询", { timeout: 5_000 }, async t => {
  const { h, a } = await activated(t);
  h.context.notify = () => { throw new Error("宿主未展示通知"); };
  a.deliver([{ noticeId: "notice-failed", dedupeKey: "unshown", kind: "task.failed", payload: {} }]);
  await eventually(() => h.events.some(event => event.type === "warn" && event.args[0] === "agora 通知暂时无法领取"),
    "展示失败应记录通知领取错误");
  await settle();
  assert.equal(a.calls.filter(call => call.path === "/v1/inbox/ack").length, 0);
  assert.equal(a.calls.filter(call => call.url.pathname === "/v1/inbox").length, 1);
});

test("连接错误切到存档只读视图，隐藏动作并保留宿主已有安全横幅", { timeout: 5_000 }, async t => {
  const h = await host(t), archive = archiveReader();
  const previous = seedBanner(h);
  let opened = 0;
  const plugin = h.plugin({ connect: async () => { throw new AgoraConnectionError(); }, openArchive: async () => { opened++; return archive.reader; } });
  await plugin.activate(h.context);
  assert.equal(opened, 0, "存档只在读取时打开");
  const snapshot = await plugin.tree.snapshot(treeRequest);
  assert.match(snapshot.epoch, /^offline:/);
  assert.ok(snapshot.nodes.length > 0);
  assert.ok(snapshot.nodes.every(node => node.availability === "archived" && node.capabilities.every(capability => capability === "open")));
  const view = await plugin.sessions.snapshot(ref);
  assert.equal(view.readonly, true); assert.equal(view.readonlyReason, "archived");
  assert.deepEqual(view.entries, archive.entries);
  assert.deepEqual(await plugin.sessions.history(ref, { before: "entry-one", limit: 1 }), { entries: archive.entries, historyBefore: null });
  assert.deepEqual(plugin.actions.list(), []);
  assert.equal(await plugin.actions.resolveForm("agora.task.spawn", { type: "global" }), null);
  assert.equal((await plugin.actions.invoke({ actionId: "agora.task.stop", idempotencyKey: "offline-action" }, origin)).status, "failed");
  assert.equal((await plugin.sessions.send(ref, { text: "不能写入" }, { idempotencyKey: "offline-send", origin })).status, "rejected");
  await assert.rejects(plugin.sessions.abort(ref, { clearQueue: true, origin }), /只能读取存档/);
  assert.equal((await plugin.panels.content("agora.task", `agora:session:${ref.id}`)).type, "keyValue");
  assert.equal((await plugin.forms.submit(submission("offline-form"), origin)).status, "failed");
  assert.equal(opened, 1);
  assert.deepEqual(h.banners.get(previous.id), previous);
  assert.equal(h.events.filter(event => event.type === "clearBanner").length, 0);
  assert.equal(h.holds.length, 0);
  await plugin.deactivate(); await plugin.deactivate();
  assert.equal(archive.closed, 1);
});

test("未知连接错误拒绝启用，不冒充可读存档或清除持久横幅", { timeout: 5_000 }, async t => {
  const h = await host(t), failure = new Error("API 协议版本失效");
  const previous = seedBanner(h, "protection-off");
  let opened = 0;
  const plugin = h.plugin({ connect: async () => { throw failure; }, openArchive: async () => { opened++; return archiveReader().reader; } });
  await assert.rejects(plugin.activate(h.context), error => error === failure);
  assert.equal(opened, 0);
  assert.deepEqual(plugin.actions.list(), []);
  assert.deepEqual(h.banners.get(previous.id), previous);
  assert.equal(h.events.filter(event => event.type === "clearBanner").length, 0);
  assert.equal(h.mainListeners.size, 0);
  await assert.rejects(plugin.tree.snapshot(treeRequest), /尚未启用/);
});

test("周期健康检测断线触发离线 reset，恢复在线再次 reset 并关闭存档 reader", { timeout: 5_000 }, async t => {
  const h = await host(t), first = mockApi(h), second = mockApi(h), archive = archiveReader();
  let current = first.api, connects = 0;
  const plugin = h.plugin({ connect: async () => { connects++; if (!current) throw new AgoraConnectionError(); return current; },
    openArchive: async () => archive.reader });
  await plugin.activate(h.context);
  await eventually(() => first.polls.size === 1, "首次在线启用应挂起通知轮询");
  const treeEvents = [], sessionEvents = [];
  plugin.tree.subscribe(treeCursor, event => treeEvents.push(event));
  plugin.sessions.subscribe(ref, sessionCursor, event => sessionEvents.push(event));
  first.state.health = 503; current = undefined;
  t.mock.timers.tick(RETRY_MS);
  await eventually(() => treeEvents.length === 1 && sessionEvents.length === 1, "健康失败应使树和会话游标同时失效");
  assert.equal(treeEvents[0].type, "reset");
  assert.equal(sessionEvents[0].event.type, "resync");
  assert.equal(sessionEvents[0].cursor.epoch, treeEvents[0].epoch);
  assert.deepEqual(sessionEvents[0].ref, ref);
  assert.ok(first.streams.every(stream => stream.stops > 0));
  assert.equal(first.state.closed, 1);
  assert.equal(first.calls.find(call => call.path === "/v1/health").options.timeoutMs, 5_000);
  assert.deepEqual(plugin.actions.list(), []);
  const offline = await plugin.tree.snapshot(treeRequest);
  assert.match(offline.epoch, /^offline:/);
  assert.equal((await plugin.sessions.snapshot(ref)).readonly, true);
  const offlineTreeEvents = [], offlineSessionEvents = [];
  plugin.tree.subscribe({ epoch: offline.epoch, revision: offline.revision }, event => offlineTreeEvents.push(event));
  plugin.sessions.subscribe(ref, { epoch: offline.epoch, seq: 0 }, event => offlineSessionEvents.push(event));
  second.state.sessions[0].parent = { kind: "user" };
  current = second.api;
  t.mock.timers.tick(RETRY_MS);
  await eventually(() => offlineTreeEvents.length === 1 && offlineSessionEvents.length === 1 && archive.closed === 1 && second.polls.size === 1,
    "恢复应通知离线订阅者重新同步，并释放归档读取器");
  assert.equal(offlineTreeEvents[0].type, "reset");
  assert.equal(offlineSessionEvents[0].event.type, "resync");
  assert.notEqual(offlineTreeEvents[0].epoch, treeEvents[0].epoch);
  assert.equal(treeEvents.length, 1, "已 reset 的旧订阅不能重复收到恢复事件");
  assert.equal(sessionEvents.length, 1);
  assert.ok(plugin.actions.list().length > 0);
  assert.equal((await plugin.sessions.snapshot(ref)).readonly, false);
  const connected = connects;
  t.mock.timers.tick(RETRY_MS);
  await eventually(() => second.calls.some(call => call.path === "/v1/health"), "在线阶段应继续周期检查健康");
  await settle();
  assert.equal(connects, connected, "健康连接不重复调用 connect");
  await plugin.deactivate();
  assert.equal(second.state.closed, 1); assert.equal(archive.closed, 1);
  assert.deepEqual(first.unexpected, []); assert.deepEqual(second.unexpected, []);
});

test("sessions.send 复用 composer 的固定请求机制，历史切换不污染 pending 查询", async t => {
  let writes = 0;
  const { a, plugin } = await activated(t, call => {
    if (call.method === "GET" && call.path === `/v1/tasks/${session.taskId}`) return ok({ taskId: session.taskId, agoraSessionId: ref.id, status: "running", generation: 1, revision: 7 });
    if (call.method === "POST" && call.path === `/v1/tasks/${session.taskId}/steer`) {
      writes++;
      assert.deepEqual(call.body, { message: "固定返工", interrupt: false, expectedGeneration: 1, expectedRevision: 7 });
      return writes === 1 ? { status: 202, body: { operation: { state: "in_progress" } } } : ok({});
    }
  });
  a.state.sessions[0].parent = { kind: "user" };
  const req = { idempotencyKey: "send-pending", origin };
  assert.equal((await plugin.sessions.send(ref, { text: "固定返工" }, req)).status, "pending");
  a.state.sessions[0].isCurrent = false;
  a.state.sessions[0].status = "interrupted";
  assert.equal((await plugin.sessions.send(ref, { text: "固定返工" }, req)).status, "accepted");
  assert.equal(writes, 2);
  assert.equal(a.calls.filter(call => call.method === "GET" && call.path === `/v1/tasks/${session.taskId}`).length, 1);
  assert.equal((await plugin.sessions.send(ref, { text: "固定返工" }, { ...req, idempotencyKey: "new-history-send" })).status, "rejected");
  assert.equal(writes, 2);
});

test("sessions.send 两读之间重开会话时拒绝向新运行返工", async t => {
  const { a, plugin } = await activated(t, (call, state) => {
    if (call.method === "GET" && call.path === `/v1/tasks/${session.taskId}`) {
      state.sessions[0].isCurrent = false;
      return ok({ taskId: session.taskId, agoraSessionId: "as_reopened", status: "running", generation: 2, revision: 8 });
    }
  });
  a.state.sessions[0].parent = { kind: "user" };
  const result = await plugin.sessions.send(ref, { text: "不能误控新运行" }, { idempotencyKey: "send-race", origin });
  assert.equal(result.status, "rejected");
  assert.match(result.message, /任务状态与目标不匹配/);
  assert.equal(a.calls.filter(call => call.method === "POST" && call.path.endsWith("/steer")).length, 0);
});

test("sessions.abort 的任务条件在写入处理前 revision 变化时返回 stale", async t => {
  let revision = 7, stopped = false;
  const { a, plugin } = await activated(t, call => {
    if (call.method === "GET" && call.path === `/v1/tasks/${session.taskId}`) {
      return ok({ taskId: session.taskId, agoraSessionId: ref.id, status: "running", generation: 2, revision });
    }
    if (call.method === "POST" && call.path === `/v1/tasks/${session.taskId}/stop`) {
      assert.deepEqual(call.body, { expectedGeneration: 2, expectedRevision: 7 });
      revision++;
      if (call.body.expectedRevision !== revision) return { status: 409, body: { error: { code: "stale", message: "stale task revision" } } };
      stopped = true;
      return ok({ droppedSteers: [] });
    }
  });
  a.state.sessions[0].parent = { kind: "user" };
  assert.equal((await plugin.sessions.snapshot(ref)).readonly, false);
  await assert.rejects(plugin.sessions.abort(ref, { clearQueue: true, origin }), /stale task revision/);
  assert.equal(stopped, false);
  assert.equal(a.calls.filter(call => call.method === "GET" && call.path === `/v1/tasks/${session.taskId}`).length, 1);
});

test("接管结构 marker 使打开的会话重取权限，重入订阅不会被旧集合清理", async t => {
  const { a, plugin } = await activated(t);
  assert.equal((await plugin.sessions.snapshot(ref)).readonly, true);
  const first = [], second = [];
  plugin.sessions.subscribe(ref, sessionCursor, event => {
    first.push(event);
    if (event.event.type === 'resync') plugin.sessions.subscribe(ref, sessionCursor, next => second.push(next));
  });
  a.state.sessions[0].parent = { kind: 'user' };
  const domain = a.streams.find(stream => stream.path.startsWith('/v1/changes?') && stream.stops === 0);
  const marker = seq => ({ type: 'change', data: { cursor: { epoch: treeCursor.epoch, seq }, objectType: 'tree', objectId: 'all' } });
  domain.emit(marker(11));
  assert.equal(first.length, 1); assert.equal(first[0].event.type, 'resync');
  assert.equal((await plugin.sessions.snapshot(ref)).readonly, false);
  domain.emit(marker(12));
  assert.equal(first.length, 1);
  assert.equal(second.length, 1, '同步重新登记的订阅必须保留到下一次结构变化');
  assert.equal(second[0].event.type, 'resync');
});

test("仅领域流断开后从新水位重订阅，已打开会话必须重新取权限", async t => {
  const { a, plugin } = await activated(t);
  const events = [];
  plugin.sessions.subscribe(ref, sessionCursor, event => events.push(event));
  const domain = a.streams.find(stream => stream.path.startsWith('/v1/changes?') && stream.stops === 0);
  domain.failed(new Error('仅领域流断开'));
  assert.equal(events.length, 0, '会话流本身仍健康');
  a.state.sessions[0].parent = { kind: 'user' };
  t.mock.timers.tick(RETRY_MS);
  await eventually(() => events.length === 1, '重订阅的新 head 之前可能跳过接管 marker，必须主动 resync');
  assert.equal(events[0].event.type, 'resync');
  assert.equal((await plugin.sessions.snapshot(ref)).readonly, false);
  assert.ok(a.streams.filter(stream => stream.path.startsWith('/v1/changes?')).length >= 2);
});

test("领域变更流过期必发树 reset，宿主据此重新对齐持久表单", async t => {
  const { h, a, plugin } = await activated(t, call => call.path === `/v1/requests/${question.id}` ? ok({ ...question, state: "answered" }) : undefined);
  const events = [];
  let alignment;
  plugin.tree.subscribe(treeCursor, event => {
    events.push(event);
    if (event.type === "reset") alignment = plugin.forms.pending();
  });
  a.state.requests = [{ ...question, id: "rq-new", revision: 1 }];
  const domain = a.streams.find(stream => stream.path.startsWith("/v1/changes?") && stream.stops === 0);
  domain.emit({ type: "reset", data: { epoch: "reset-database" } });
  await eventually(() => events.length === 1 && alignment, "领域流 reset 应立即送达树订阅者");
  assert.equal(events[0].type, "reset");
  const forms = await alignment;
  assert.ok(forms.some(form => form.id === "agora:request:rq-new"));
  assert.ok(domain.stops > 0);
});

test("停用取消领域流和会话流、终止通知轮询、释放保活但保留持久横幅与表单", { timeout: 5_000 }, async t => {
  const { h, a, plugin } = await activated(t);
  const treeEvents = [], sessionEvents = [];
  const stopTree = plugin.tree.subscribe(treeCursor, event => treeEvents.push(event));
  const stopSession = plugin.sessions.subscribe(ref, sessionCursor, event => sessionEvents.push(event));
  const before = structuredClone([...h.banners.values()]);
  const forms = structuredClone([...h.pendingForms.values()]);
  assert.equal(h.holds[0].releases, 0);
  const streams = [...a.streams];
  await plugin.deactivate(); await settle();
  assert.ok(streams.length >= 3 && streams.every(stream => stream.stops > 0));
  assert.equal(a.polls.size, 0); assert.equal(a.state.closed, 1);
  assert.ok(h.holds.every(hold => hold.releases === 1));
  assert.equal(h.mainListeners.size, 0); assert.equal(h.deviceListeners.size, 0);
  assert.deepEqual([...h.banners.values()], before);
  assert.deepEqual([...h.pendingForms.values()], forms);
  assert.equal(h.events.filter(event => event.type === "clearBanner" || event.type === "formRemoved").length, 0);
  const requestCount = a.calls.length;
  for (const stream of streams) {
    stream.emit({ type: "change", data: { cursor: { epoch: treeCursor.epoch, seq: 11 }, objectType: "session", objectId: ref.id } });
    stream.emit({ type: "session", data: { cursor: { epoch: sessionCursor.epoch, seq: 1 }, event: { type: "message_end" } } });
  }
  t.mock.timers.tick(RETRY_MS * 10); await settle();
  assert.equal(a.calls.length, requestCount);
  assert.deepEqual(treeEvents, []); assert.deepEqual(sessionEvents, []);
  await plugin.deactivate();
  assert.equal(a.state.closed, 1); assert.ok(h.holds.every(hold => hold.releases === 1));
  stopTree(); stopSession();
  await assert.rejects(plugin.sessions.snapshot(ref), /尚未启用/);
});

test("停用期间到达的用户在场确认不能继续签名、发送结果通知或解除横幅", { timeout: 5_000 }, async t => {
  const proof = deferred(), confirmations = [];
  const confirmation = { id: "cf-lifecycle", title: "答复提问", summary: "确认此次答复", challenge: { action: "request.answer", nonce: "test-nonce" } };
  const { h, a, plugin } = await activated(t, call => call.method === "POST" && call.path === "/v1/requests/rq-one/answer"
    ? { status: 202, body: { confirmation } } : undefined);
  h.context.userPresence.confirm = request => { confirmations.push(request); return proof.promise; };
  const operation = plugin.forms.submit(submission("confirmation-during-stop"), origin);
  await eventually(() => confirmations.length === 1, "提交持久表单应向宿主请求用户在场确认");
  assert.deepEqual(confirmations[0].payload, confirmation.challenge);
  assert.deepEqual(confirmations[0].origin, origin);
  const banners = structuredClone([...h.banners.values()]);
  await plugin.deactivate();
  proof.resolve({ deviceId: "device-a", publicKey: "test-key", alg: "ECDSA-P256-SHA256", signature: "test-signature" });
  assert.equal((await operation).status, "pending");
  await settle();
  assert.equal(a.calls.some(call => call.path.endsWith("/sign")), false);
  assert.equal(h.events.some(event => event.type === "notify"), false);
  assert.deepEqual([...h.banners.values()], banners);
  assert.equal(h.events.filter(event => event.type === "clearBanner" || event.type === "formRemoved").length, 0);
});

test("停用中止树流正在读取的请求，迟到响应不能更新宿主", { timeout: 5_000 }, async t => {
  const pending = deferred();
  let read;
  const { h, a, plugin } = await activated(t, call => {
    if (call.path === `/v1/sessions/${ref.id}`) { read = call; return pending.promise; }
  });
  const emitted = [];
  plugin.tree.subscribe(treeCursor, event => emitted.push(event));
  const stream = a.streams.at(-1);
  stream.emit({ type: "change", data: { cursor: { epoch: treeCursor.epoch, seq: 11 }, objectType: "session", objectId: ref.id } });
  await eventually(() => read !== undefined, "树变更应开始读取对应会话");
  assert.equal(read.options.signal.aborted, false);
  await plugin.deactivate();
  assert.equal(read.options.signal.aborted, true);
  const after = h.events.length;
  pending.resolve(ok(structuredClone(session)));
  await settle();
  assert.deepEqual(emitted, []);
  assert.equal(h.events.length, after, "停用后的迟到响应不能更新横幅、表单、面板或通知");
});

test("停用期间迟到的健康响应不能触发重连或重复关闭 API", { timeout: 5_000 }, async t => {
  const h = await host(t), health = deferred();
  const a = mockApi(h, call => call.path === "/v1/health" ? health.promise : undefined);
  let connects = 0;
  const plugin = h.plugin({ connect: async () => { connects++; return a.api; } });
  await plugin.activate(h.context);
  t.mock.timers.tick(RETRY_MS);
  await eventually(() => a.calls.some(call => call.path === "/v1/health"), "健康请求应已开始且保持挂起");
  await plugin.deactivate();
  health.resolve(ok({}));
  await settle();
  assert.equal(connects, 1, "插件停用后，迟到的健康响应不能再次调用 connect");
  assert.equal(a.state.closed, 1, "同一个 API 只能关闭一次");
  assert.deepEqual(a.unexpected, []);
});

test("启用尚在连接时停用，迟到连接关闭后不能安装重连定时器", { timeout: 5_000 }, async t => {
  const h = await host(t), connection = deferred(), a = mockApi(h);
  let connects = 0;
  const plugin = h.plugin({ connect: () => { connects++; return connection.promise; } });
  const activation = plugin.activate(h.context);
  await eventually(() => connects === 1, "启用应已等待连接结果");
  await plugin.deactivate();
  connection.resolve(a.api);
  await activation;
  assert.equal(a.state.closed, 1, "停用后的迟到连接必须关闭");
  assert.deepEqual(a.calls, [], "迟到连接不能开始读取领域状态");
  t.mock.timers.tick(RETRY_MS * 3);
  await settle();
  assert.equal(connects, 1, "已停用的启用流程不能留下重连定时器");
  assert.equal(a.state.closed, 1);
});

test("完整动作调用身份跨插件重启仍冲突，相同调用与新 origin 复用持久最终结果", { timeout: 5_000 }, async t => {
  const h = await host(t);
  const first = mockApi(h, call => call.method === "POST" && call.path === "/v1/tasks" ? ok({ agoraSessionId: "as_created" }) : undefined);
  const plugin = h.plugin({ connect: async () => first.api });
  await plugin.activate(h.context);
  const form = await plugin.actions.resolveForm("agora.task.spawn", { type: "global" });
  assert.ok(form);
  const inv = { actionId: "agora.task.spawn", target: { type: "global" }, formId: form.id, formRevision: form.revision,
    input: { answers: [], fields: { model: "provider/model", profile: "review", prompt: "检查生命周期", cwd: h.context.dataDir } }, idempotencyKey: "persistent-action" };
  const result = await plugin.actions.invoke(inv, origin);
  assert.deepEqual(result, { status: "ok", openNodeId: "agora:session:as_created" });
  assert.equal(first.calls.filter(call => call.method === "POST" && call.path === "/v1/tasks").length, 1);
  await plugin.deactivate();
  const second = mockApi(h);
  const restarted = h.plugin({ connect: async () => second.api });
  await restarted.activate(h.context);
  const reordered = structuredClone(inv);
  reordered.input.fields = { cwd: h.context.dataDir, prompt: "检查生命周期", profile: "review", model: "provider/model" };
  assert.deepEqual(await restarted.actions.invoke(reordered, { ...origin, connectionId: "tab-b", receivedAt: "2026-01-02T00:00:00.000Z" }), result);
  const mutations = [
    value => { delete value.target; },
    value => { value.target = { type: "node", nodeId: `agora:session:${ref.id}` }; },
    value => { value.input.fields.prompt = "不同任务"; },
    value => { value.input.fields.unknown = "不同的完整输入"; },
    value => { value.input.answers = [{ id: "unused", selected: ["甲"] }]; },
    value => { value.formId += "-other"; },
    value => { value.formRevision++; },
    value => { value.actionId = "agora.task.recover"; },
    value => { value.extra = "完整调用中的额外字段"; },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(inv); mutate(changed);
    assert.equal((await restarted.actions.invoke(changed, origin)).status, "idempotencyConflict", JSON.stringify(changed));
  }
  assert.equal((await restarted.forms.submit(submission(inv.idempotencyKey), origin)).status, "idempotencyConflict");
  assert.equal(second.calls.filter(call => call.method === "POST").length, 0, "重启后的重试或冲突都不能再次写入 API");
  assert.deepEqual(first.unexpected, []); assert.deepEqual(second.unexpected, []);
});

for (const restart of [false, true]) {
  test(`持久表单 pending 使用原 key 查询当前结果${restart ? "，插件重启不固化中间状态" : "，终态可复用"}`, { timeout: 5_000 }, async t => {
    const h = await host(t);
    const writes = [];
    const handler = (call, state) => {
      if (call.method !== "POST" || call.path !== "/v1/requests/rq-one/answer") return undefined;
      writes.push(call);
      if (writes.length === 1) return { status: 202, body: { state: "pending" } };
      state.requests[0].state = "answered";
      return ok({});
    };
    const first = mockApi(h, handler);
    let plugin = h.plugin({ connect: async () => first.api });
    await plugin.activate(h.context);
    const request = submission(`pending-form-${restart}`);
    assert.equal((await plugin.forms.submit(request, origin)).status, "pending");
    assert.equal(h.pendingForms.has(request.formId), true);
    assert.equal(h.events.filter(event => event.type === "formRemoved").length, 0);
    let second;
    if (restart) {
      await plugin.deactivate();
      second = mockApi(h, handler);
      plugin = h.plugin({ connect: async () => second.api });
      await plugin.activate(h.context);
    }
    assert.equal((await plugin.forms.submit(request, { ...origin, connectionId: "tab-retry" })).status, "accepted");
    assert.equal(writes.length, 2, "pending 不能成为最终缓存，必须再查询 daemon");
    assert.deepEqual(writes[1].body, writes[0].body);
    assert.equal(writes[1].body.expectedRevision, 1);
    assert.equal(writes[1].options.idempotencyKey, request.idempotencyKey);
    assert.equal(writes[1].options.actAsUser, true);
    assert.equal(h.events.filter(event => event.type === "formRemoved" && event.id === request.formId && event.reason === "handled").length, 1);
    assert.equal((await plugin.forms.submit(request, origin)).status, "accepted");
    assert.equal(writes.length, 2, "已确认终态不重复提交");
    const changed = structuredClone(request); changed.outcome.values.answers[0].selected = ["乙"];
    assert.equal((await plugin.forms.submit(changed, origin)).status, "idempotencyConflict");
    assert.deepEqual(first.unexpected, []); if (second) assert.deepEqual(second.unexpected, []);
  });
}

for (const [name, reply] of [
  ["接口不存在", { status: 404, body: { error: { code: "not_found" } } }],
  ["服务暂不可用", { status: 503, body: {} }],
  ["空响应", { status: 204, body: null }],
  ["缺少列表", ok({})],
  ["列表类型失效", ok({ items: null })],
  ["警告缺少修订号", ok({ items: [{ alertId: "alert-one", kind: "devices-reset" }] })],
  ["警告修订号无效", ok({ items: [{ ...alert, revision: 0 }] })],
  ["知悉时间类型失效", ok({ items: [{ ...alert, acknowledgedAt: true }] })],
]) {
  test(`安全 API ${name}不能在启用或健康刷新时伪称解除已有横幅`, { timeout: 5_000 }, async t => {
    const h = await host(t), previous = seedBanner(h), protection = seedBanner(h, "protection-off");
    const a = mockApi(h, call => call.path === "/v1/security/alerts" ? structuredClone(reply) : undefined);
    const plugin = h.plugin({ connect: async () => a.api });
    await plugin.activate(h.context);
    assert.deepEqual(h.banners.get(previous.id), previous);
    assert.deepEqual(h.banners.get(protection.id), protection);
    const before = a.calls.filter(call => call.path === "/v1/security/alerts").length;
    t.mock.timers.tick(RETRY_MS);
    await eventually(() => a.calls.filter(call => call.path === "/v1/security/alerts").length > before,
      "周期健康检测应再次尝试安全状态对齐");
    await settle();
    assert.deepEqual(h.banners.get(previous.id), previous);
    assert.deepEqual(h.banners.get(protection.id), protection);
    assert.equal(h.events.filter(event => event.type === "clearBanner").length, 0);
    assert.ok(h.events.some(event => event.type === "warn" && event.args[0] === "agora 领域状态暂时无法对齐"));
    assert.deepEqual(a.unexpected, []);
  });
}

for (const [status, expected] of [[404, "failed"], [409, "failed"], [503, "failed"], [202, "pending"], [200, "ok"]]) {
  test(`确认警告返回 ${status} 不直接清横幅，只有权威列表对齐才解除`, { timeout: 5_000 }, async t => {
    const { h, a, plugin } = await activated(t, call => call.method === "POST" && call.path === "/v1/security/alerts/alert-one/acknowledge"
      ? { status, body: status >= 400 ? { error: { code: "not_available", message: "警告状态尚未核实" } } : {} } : undefined);
    const form = await plugin.actions.resolveForm("agora.security.acknowledge", { type: "global" });
    assert.ok(form);
    const result = await plugin.actions.invoke({ actionId: "agora.security.acknowledge", target: { type: "global" },
      formId: form.id, formRevision: form.revision, idempotencyKey: `ack-${status}` }, origin);
    assert.equal(result.status, expected);
    const acknowledged = a.calls.find(call => call.path === "/v1/security/alerts/alert-one/acknowledge");
    assert.deepEqual(acknowledged.body, { revision: 1 });
    assert.equal(acknowledged.options.actAsUser, true);
    assert.equal(h.banners.has("agora:security:devices-reset"), true);
    assert.equal(h.events.filter(event => event.type === "clearBanner").length, 0);
    if (status === 200) {
      a.state.alerts = []; a.domainChange();
      await eventually(() => !h.banners.has("agora:security:devices-reset"), "权威安全列表移除警告后应清除横幅");
      assert.equal(h.events.filter(event => event.type === "clearBanner").length, 1);
    }
  });
}
