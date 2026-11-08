import assert from "node:assert/strict";
import { test } from "node:test";
import { createOfflineViews, OFFLINE_LIMITS } from "../packages/pane-plugin/dist/offline.js";

const OLD = "2024-01-01T00:00:00.000Z";
const RECENT = "2026-01-02T00:00:00.000Z";
const request = (openNodeIds = []) => ({ openNodeIds, recentSince: "2026-01-01T00:00:00.000Z" });
const ref = id => ({ source: "agora", id });
const nodeId = id => `agora:session:${id}`;
const summary = (id, extra = {}) => ({
  agoraSessionId: id, kind: "task", title: id, model: "test", profile: "implement",
  convenerId: "user", parent: { kind: "user" }, status: "completed", archiveState: "ok", createdAt: OLD, ...extra,
});

function mock(items, { pageSize = 2, details = new Map(), entries = [], partials = [] } = {}) {
  const calls = [];
  const reader = {
    async listSessions(q = {}) {
      calls.push(["listSessions", q]);
      const start = Number(q.cursor ?? 0);
      const count = Math.min(pageSize, q.limit ?? pageSize);
      return { items: items.slice(start, start + count),
        ...(start + count < items.length ? { nextCursor: String(start + count) } : {}) };
    },
    async getSession(id) {
      calls.push(["getSession", id]);
      return details.has(id) ? details.get(id) : items.find(item => item.agoraSessionId === id);
    },
    async readUserView(id, q) {
      calls.push(["readUserView", id, q]);
      return { leafId: "leaf", entries, historyBefore: q?.before ? null : "before-leaf" };
    },
    async readPartials(id) { calls.push(["readPartials", id]); return partials; },
    close() { calls.push(["close"]); },
  };
  // 离线视图不能探查或调用读取器上的写入接口和原始条目接口。
  for (const name of ["send", "abort", "write", "request", "openSession", "readRawEntries"]) {
    Object.defineProperty(reader, name, { get() { throw new Error(`意外访问写入或原始条目接口：${name}`); } });
  }
  return { reader, calls };
}

test("离线任务面板显示中立用量与当前会话标记", async () => {
  const { reader } = mock([summary("one", { isCurrent: false, usage: { inputTokens: 10, outputTokens: 2, contextTokens: 12 } })]);
  const views = createOfflineViews(reader);
  const content = await views.panels.content("agora.task", nodeId("one"));
  assert.equal(content.type, "keyValue");
  assert.ok(content.rows.some(row => row.key === "上下文 token" && row.value === "12"));
  assert.ok(content.rows.some(row => row.key === "当前会话" && row.value === "否（历史会话）"));
  assert.ok(content.rows.some(row => row.key === "任务用量" && row.value.includes('"inputTokens":10')));
  views.dispose();
});

test("快照仅包含热会话及其祖先，不包含冷兄弟节点", async () => {
  const items = [
    summary("parent"),
    summary("child", { convenerId: "parent-convener", parent: undefined, parentPiSessionId: "main", status: "running" }),
    summary("cold", { convenerId: "parent-convener", parent: { kind: "task", taskId: "parent-task", sessionId: "parent" } }),
    summary("recent", { lastActivityAt: RECENT }),
    summary("open"), summary("unrelated"),
    summary("paused", { status: "quota_paused" }), summary("waiting", { status: "waiting_children" }),
  ];
  const { reader, calls } = mock(items, { details: new Map([
    ["child", { ...items[1], parent: { kind: "task", taskId: "parent-task", sessionId: "parent" } }],
  ]) });
  const views = createOfflineViews(reader, "e1");
  const snapshot = await views.tree.snapshot(request([nodeId("open")]));
  assert.equal(snapshot.epoch, "e1");
  assert.deepEqual(new Set(snapshot.nodes.map(node => node.id)), new Set([
    "agora:root:user-tasks", ...["parent", "child", "recent", "open", "paused", "waiting"].map(nodeId),
  ]));
  const parent = snapshot.nodes.find(node => node.id === nodeId("parent"));
  assert.equal(parent.childCount, 2);
  assert.equal(parent.hasChildren, true);
  assert.equal(snapshot.nodes.find(node => node.id === nodeId("child")).parentId, nodeId("parent"));
  assert.equal(snapshot.nodes.find(node => node.id === nodeId("paused")).status, "paused");
  for (const node of snapshot.nodes) {
    assert.equal(node.availability, "archived");
    assert.equal(node.revision, snapshot.revision);
    assert.deepEqual(node.capabilities, node.kind === "session" ? ["open"] : []);
  }
  assert(calls.some(([method, id]) => method === "getSession" && id === "child"));
  assert(!calls.some(([method]) => method === "readUserView" || method === "readPartials"));
  const cold = await views.tree.snapshot(request());
  assert(!cold.nodes.some(node => node.id === nodeId("open")));
  views.dispose();
});

test("没有热节点时不返回虚拟分组，打开分组不会加载全部后代", async () => {
  const { reader } = mock([summary("cold")]);
  const views = createOfflineViews(reader);
  assert.deepEqual((await views.tree.snapshot(request())).nodes, []);
  const open = await views.tree.snapshot(request(["agora:root:user-tasks"]));
  assert.deepEqual(open.nodes.map(node => node.id), ["agora:root:user-tasks"]);
  views.dispose();
});

test("缺少直接父级的嵌套任务保持未归属，不使用 parentPiSessionId 推断", async () => {
  const { reader } = mock([
    summary("unknown", { convenerId: "task-convener", parent: undefined, parentPiSessionId: "main", status: "running" }),
    summary("main-child", { convenerId: "main", parent: { kind: "main", piSessionId: "main" } }),
  ]);
  const views = createOfflineViews(reader);
  const snapshot = await views.tree.snapshot(request());
  assert.equal(snapshot.nodes.find(node => node.id === nodeId("unknown")).parentId, null);
  const children = await views.tree.children("pane:session:main", { epoch: snapshot.epoch, limit: 10 });
  assert.deepEqual(children.nodes.map(node => node.id), [nodeId("main-child")]);
  views.dispose();
});

test("用户会议和任务使用独立虚拟根节点，会议分组为只读", async () => {
  const { reader } = mock([
    summary("task", { status: "running" }),
    summary("seat", { kind: "meeting-seat", meetingId: "mt_1", status: "running" }),
    summary("secretary", { kind: "secretary", meetingId: "mt_1", status: "completed", createdAt: "2023-01-01T00:00:00.000Z" }),
    summary("other-seat", { kind: "meeting-seat", meetingId: "mt_2", status: "completed" }),
  ]);
  const views = createOfflineViews(reader, "meetings");
  const snapshot = await views.tree.snapshot(request());
  const nodes = new Map(snapshot.nodes.map(node => [node.id, node]));
  assert.equal(nodes.get("agora:meeting:mt_1").parentId, "agora:root:user-meetings");
  assert.equal(nodes.get(nodeId("seat")).parentId, "agora:meeting:mt_1");
  assert.equal(nodes.get(nodeId("task")).parentId, "agora:root:user-tasks");
  assert(!nodes.has(nodeId("secretary")));
  assert(!nodes.has("agora:meeting:mt_2"));
  assert.deepEqual(nodes.get("agora:meeting:mt_1").capabilities, []);
  const seats = await views.tree.children("agora:meeting:mt_1", { epoch: "meetings", limit: 10 });
  assert.deepEqual(seats.nodes.map(node => node.id), [nodeId("seat"), nodeId("secretary")]);
  assert.deepEqual(views.panels.list().map(panel => panel.id), ["agora.task"]);
  views.dispose();
});

test("子节点按直接父级筛选，并基于固定元数据快照分页", async () => {
  const { reader, calls } = mock([
    summary("b"), summary("a"), summary("c"), summary("nested", { parent: { kind: "task", taskId: "task-a", sessionId: "a" } }),
  ], { pageSize: 1 });
  const views = createOfflineViews(reader, "pagination");
  const first = await views.tree.children("agora:root:user-tasks", { epoch: "pagination", limit: 2 });
  assert.deepEqual(first.nodes.map(node => node.id), [nodeId("a"), nodeId("b")]);
  assert(first.nextCursor);
  const second = await views.tree.children("agora:root:user-tasks", { epoch: "pagination", cursor: first.nextCursor, limit: 2 });
  assert.deepEqual(second.nodes.map(node => node.id), [nodeId("c")]);
  assert.equal(second.nextCursor, undefined);
  assert.equal(second.revision, first.revision);
  assert.equal(calls.filter(([method]) => method === "listSessions").length, 4);
  const nested = await views.tree.children(nodeId("a"), { epoch: "pagination", limit: 2 });
  assert.deepEqual(nested.nodes.map(node => node.id), [nodeId("nested")]);
  first.nodes[0].capabilities.push("send");
  const again = await views.tree.children("agora:root:user-tasks", { epoch: "pagination", limit: 2 });
  assert.deepEqual(again.nodes[0].capabilities, ["open"]);
  await assert.rejects(views.tree.children(nodeId("a"), { epoch: "pagination", cursor: first.nextCursor, limit: 2 }), /子节点分页游标无效/);
  await assert.rejects(views.tree.children(nodeId("a"), { epoch: "pagination", cursor: "broken", limit: 2 }), /子节点分页游标无效/);
  await assert.rejects(views.tree.children(nodeId("a"), { epoch: "pagination", cursor: "a".repeat(4097), limit: 2 }), /子节点分页游标无效/);
  views.dispose();
});

test("每次打开生成独立周期，过期周期直接重置且不扫描", async () => {
  const one = mock([summary("one")]);
  const two = mock([summary("one")]);
  const a = createOfflineViews(one.reader);
  const b = createOfflineViews(two.reader);
  const sa = await a.tree.snapshot(request([nodeId("one")]));
  const sb = await b.tree.snapshot(request([nodeId("one")]));
  assert.notEqual(sa.epoch, sb.epoch);
  assert.equal(sa.revision, sb.revision);
  assert.deepEqual(await b.tree.children("agora:root:user-tasks", { epoch: sa.epoch, limit: 1 }), { reset: true, epoch: sb.epoch });
  const fresh = mock([]);
  const c = createOfflineViews(fresh.reader, "fresh");
  assert.deepEqual(await c.tree.children("anything", { epoch: "expired", limit: 1 }), { reset: true, epoch: "fresh" });
  assert.deepEqual(fresh.calls, []);
  a.dispose(); b.dispose(); c.dispose();
});

test("修订号不受元数据顺序影响，并随投影内容变化", async () => {
  const items = [summary("a"), summary("b")];
  const views = [
    createOfflineViews(mock(items).reader),
    createOfflineViews(mock([...items].reverse()).reader),
    createOfflineViews(mock([summary("a", { archiveState: "missing" }), items[1]]).reader),
  ];
  const snapshots = await Promise.all(views.map(view => view.tree.snapshot(request())));
  assert.equal(snapshots[0].revision, snapshots[1].revision);
  assert.notEqual(snapshots[0].revision, snapshots[2].revision);
  for (const view of views) view.dispose();
});

test("只读快照和历史记录原样传递条目与未完成片段", async () => {
  const entries = [{ arbitrary: "不透明的 pi 条目", nested: { value: 42 } }];
  const partials = [{ runId: "run", at: RECENT, blocks: [{ type: "text", contentIndex: 0, text: "未完成的内容", done: false }] }];
  const { reader, calls } = mock([summary("running", { status: "running" })], { entries, partials });
  const views = createOfflineViews(reader, "session-epoch");
  const snapshot = await views.sessions.snapshot(ref("running"));
  assert.equal(snapshot.status, "running");
  assert.equal(snapshot.readonly, true);
  assert.equal(snapshot.readonlyReason, "archived");
  assert.deepEqual(snapshot.cursor, { epoch: "session-epoch", seq: 0 });
  assert.equal(snapshot.leafId, "leaf");
  assert.equal(snapshot.historyBefore, "before-leaf");
  assert.strictEqual(snapshot.entries, entries);
  assert.strictEqual(snapshot.unfinishedPartials, partials);
  assert.equal(snapshot.inFlight, undefined);
  const history = await views.sessions.history(ref("running"), { before: "opaque-before", limit: 7 });
  assert.strictEqual(history.entries, entries);
  assert.equal(history.historyBefore, null);
  assert(calls.some(([method, id, q]) => method === "readUserView" && id === "running" && q.before === "opaque-before" && q.limit === 7));
  assert.equal(calls.filter(([method]) => method === "readPartials").length, 1);
  assert.equal(views.sessions.send, undefined);
  assert.equal(views.sessions.abort, undefined);
  const emissions = [];
  const offTree = views.tree.subscribe({ epoch: "old", revision: 0 }, event => emissions.push(event));
  const offSession = views.sessions.subscribe(ref("running"), { epoch: "old", seq: 0 }, event => emissions.push(event));
  offTree(); offTree(); offSession();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(emissions, []);
  assert(!calls.some(([method]) => method === "listSessions"));
  views.dispose(); views.dispose();
  assert.equal(calls.filter(([method]) => method === "close").length, 1);
});

test("缺失文件的节点仍可见且读取快照明确报错，适配器失败不返回空内容", async () => {
  const { reader, calls } = mock([summary("missing", { archiveState: "missing", status: "interrupted" })]);
  const views = createOfflineViews(reader);
  const tree = await views.tree.snapshot(request([nodeId("missing")]));
  assert.equal(tree.nodes.find(node => node.id === nodeId("missing")).availability, "missing");
  await assert.rejects(views.sessions.snapshot(ref("missing")), /归档会话文件缺失：missing/);
  await assert.rejects(views.sessions.history(ref("missing"), { before: "b", limit: 1 }), /归档会话文件缺失/);
  await assert.rejects(views.sessions.snapshot(ref("unknown")), /归档会话元数据不可用/);
  assert(!calls.some(([method]) => method === "readUserView"));
  views.dispose();
  const broken = mock([summary("broken")]);
  broken.reader.readUserView = async () => { throw new Error("归档读取失败：ENOENT archive.jsonl"); };
  const failed = createOfflineViews(broken.reader);
  await assert.rejects(failed.sessions.snapshot(ref("broken")), /ENOENT/);
  failed.dispose();
});

test("元数据扫描让出事件循环，并拒绝超限、重复游标和超大分页", async () => {
  const items = Array.from({ length: OFFLINE_LIMITS.sessions + 1 }, (_, i) => summary(String(i)));
  const many = mock(items, { pageSize: OFFLINE_LIMITS.scanPageSize });
  const views = createOfflineViews(many.reader);
  let yielded = false;
  const pending = views.tree.snapshot(request());
  setImmediate(() => { yielded = true; });
  await assert.rejects(pending, /超过 4096 个会话/);
  assert.equal(yielded, true);
  views.dispose();

  const loop = mock([]);
  loop.reader.listSessions = async () => ({ items: [], nextCursor: "repeat" });
  const loopViews = createOfflineViews(loop.reader);
  await assert.rejects(loopViews.tree.snapshot(request()), /重复的元数据游标/);
  loopViews.dispose();

  const empty = mock([]);
  let page = 0;
  empty.reader.listSessions = async () => ({ items: [], nextCursor: String(++page) });
  const emptyViews = createOfflineViews(empty.reader);
  await assert.rejects(emptyViews.tree.snapshot(request()), /超过 64 页/);
  emptyViews.dispose();

  const oversized = mock([]);
  oversized.reader.listSessions = async () => ({ items: items.slice(0, OFFLINE_LIMITS.scanPageSize + 1) });
  const oversizedViews = createOfflineViews(oversized.reader);
  await assert.rejects(oversizedViews.tree.snapshot(request()), /超过请求的分页条数/);
  oversizedViews.dispose();
});

test("拒绝无效分页、其他来源的会话引用和超大历史分页", async () => {
  const { reader } = mock([summary("a")], { entries: [1, 2] });
  const views = createOfflineViews(reader, "validation");
  for (const limit of [0, -1, 1.5, Infinity, OFFLINE_LIMITS.pageSize + 1]) {
    await assert.rejects(views.tree.children("parent", { epoch: "validation", limit }), /离线分页条数/);
    await assert.rejects(views.sessions.history(ref("a"), { before: "b", limit }), /离线分页条数/);
  }
  await assert.rejects(views.sessions.snapshot({ source: "pane", id: "a" }), /agora 会话引用/);
  await assert.rejects(views.sessions.history(ref("a"), { before: "b", limit: 1 }), /超过请求的分页条数/);
  await assert.rejects(views.tree.snapshot({ openNodeIds: [], recentSince: "invalid" }), /recentSince/);
  views.dispose();
});

test("释放时取消待完成快照且仅关闭一次，不再发起后续读取", async () => {
  const { reader, calls } = mock([summary("a")]);
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  let finish;
  reader.getSession = async id => {
    calls.push(["getSession", id]);
    entered();
    return new Promise(resolve => { finish = resolve; });
  };
  const views = createOfflineViews(reader);
  const snapshot = views.sessions.snapshot(ref("a"));
  await started;
  views.dispose();
  await assert.rejects(snapshot, { name: "AbortError" });
  finish(summary("a"));
  await new Promise(resolve => setImmediate(resolve));
  assert(!calls.some(([method]) => method === "readUserView" || method === "readPartials"));
  assert.equal(calls.filter(([method]) => method === "close").length, 1);
  assert.throws(() => views.tree.snapshot(request()), { name: "AbortError" });
  views.dispose();
});

test("释放时在异步边界取消元数据分页", async () => {
  const { reader, calls } = mock([summary("a"), summary("b")], { pageSize: 1 });
  const views = createOfflineViews(reader);
  const snapshot = views.tree.snapshot(request());
  const rejected = assert.rejects(snapshot, { name: "AbortError" });
  setImmediate(() => views.dispose());
  await rejected;
  await new Promise(resolve => setImmediate(resolve));
  assert(calls.filter(([method]) => method === "listSessions").length <= 1);
});

test("列表提供的三种中立父级直接映射，且优先于召集方和详情", async () => {
  const items = [
    summary("parent"),
    summary("task-child", { parent: { kind: "task", taskId: "different-task-id", sessionId: "parent" },
      convenerId: "user", parentPiSessionId: "wrong-main", status: "running" }),
    summary("main-child", { parent: { kind: "main", piSessionId: "actual-main" },
      convenerId: "user", parentPiSessionId: "wrong-main", status: "running" }),
    summary("user-child", { parent: { kind: "user" }, convenerId: "task-convener", status: "running" }),
  ];
  const { reader, calls } = mock(items, { details: new Map(items.map(item => [
    item.agoraSessionId, { ...item, parent: { kind: "main", piSessionId: "wrong-detail" } },
  ])) });
  const views = createOfflineViews(reader, "neutral-list");
  const snapshot = await views.tree.snapshot(request());
  const nodes = new Map(snapshot.nodes.map(node => [node.id, node]));
  assert.equal(nodes.get(nodeId("task-child")).parentId, nodeId("parent"));
  assert.equal(nodes.get(nodeId("main-child")).parentId, "pane:session:actual-main");
  assert.equal(nodes.get(nodeId("user-child")).parentId, "agora:root:user-tasks");
  assert(!nodes.has("pane:session:actual-main"));
  assert(!calls.some(([method]) => method === "getSession"));
  views.dispose();
});

test("列表缺少父级时逐一查询详情，三种中立父级均可补全", async () => {
  const items = [
    summary("task-child", { parent: undefined, status: "running", parentPiSessionId: "wrong-main" }),
    summary("main-child", { parent: undefined, status: "running", convenerId: "task-convener" }),
    summary("user-child", { parent: undefined, status: "running", convenerId: "task-convener" }),
  ];
  const parents = [
    { kind: "task", taskId: "parent-task", sessionId: "parent-session" },
    { kind: "main", piSessionId: "actual-main" },
    { kind: "user" },
  ];
  const { reader, calls } = mock(items, { details: new Map(items.map((item, i) => [
    item.agoraSessionId, { ...item, title: "详情中的其他字段", parent: parents[i] },
  ])) });
  const views = createOfflineViews(reader);
  const snapshot = await views.tree.snapshot(request());
  const nodes = new Map(snapshot.nodes.map(node => [node.id, node]));
  assert.equal(nodes.get(nodeId("task-child")).parentId, nodeId("parent-session"));
  assert.equal(nodes.get(nodeId("main-child")).parentId, "pane:session:actual-main");
  assert.equal(nodes.get(nodeId("user-child")).parentId, "agora:root:user-tasks");
  for (const item of items) {
    assert.equal(nodes.get(nodeId(item.agoraSessionId)).title, item.title);
    assert.equal(calls.filter(([method, id]) => method === "getSession" && id === item.agoraSessionId).length, 1);
  }
  views.dispose();
});

test("详情没有可靠父级时保持未归属，不从召集方或 parentPiSessionId 猜测", async () => {
  const items = [
    summary("user-unknown", { parent: undefined, status: "running", parentPiSessionId: "wrong-main" }),
    summary("task-unknown", { parent: undefined, convenerId: "task-convener", status: "running",
      parentPiSessionId: "wrong-main" }),
  ];
  const { reader, calls } = mock(items, { details: new Map([["task-unknown", undefined]]) });
  const views = createOfflineViews(reader);
  const snapshot = await views.tree.snapshot(request());
  assert.equal(snapshot.nodes.length, 2);
  for (const node of snapshot.nodes) assert.equal(node.parentId, null);
  assert.deepEqual(calls.filter(([method]) => method === "getSession").map(([, id]) => id),
    ["user-unknown", "task-unknown"]);
  const wrong = await views.tree.children("pane:session:wrong-main", { epoch: snapshot.epoch, limit: 10 });
  assert.deepEqual(wrong.nodes, []);
  views.dispose();
});

test("嵌套热子任务保留完整冷祖先链，并排除各层冷兄弟节点", async () => {
  const { reader } = mock([
    summary("top", { parent: { kind: "main", piSessionId: "main" } }),
    summary("middle", { parent: { kind: "task", taskId: "top-task", sessionId: "top" } }),
    summary("leaf", { parent: { kind: "task", taskId: "middle-task", sessionId: "middle" }, status: "running" }),
    summary("top-cold", { parent: { kind: "main", piSessionId: "main" } }),
    summary("middle-cold", { parent: { kind: "task", taskId: "top-task", sessionId: "top" } }),
    summary("leaf-cold", { parent: { kind: "task", taskId: "middle-task", sessionId: "middle" } }),
  ], { pageSize: 1 });
  const views = createOfflineViews(reader);
  const snapshot = await views.tree.snapshot(request());
  const nodes = new Map(snapshot.nodes.map(node => [node.id, node]));
  assert.deepEqual(new Set(nodes.keys()), new Set(["top", "middle", "leaf"].map(nodeId)));
  assert.equal(nodes.get(nodeId("top")).parentId, "pane:session:main");
  assert.equal(nodes.get(nodeId("middle")).parentId, nodeId("top"));
  assert.equal(nodes.get(nodeId("leaf")).parentId, nodeId("middle"));
  assert.equal(nodes.get(nodeId("top")).childCount, 2);
  assert.equal(nodes.get(nodeId("middle")).childCount, 2);
  views.dispose();
});

test("子任务跨元数据页补全父级后按直接关系分页，不混入孙任务或根任务", async () => {
  const items = [
    summary("parent"),
    summary("c", { parent: { kind: "task", taskId: "parent-task", sessionId: "parent" } }),
    summary("grandchild", { parent: { kind: "task", taskId: "task-a", sessionId: "a" } }),
    summary("b", { parent: undefined }),
    summary("a", { parent: { kind: "task", taskId: "parent-task", sessionId: "parent" } }),
    summary("other-root"),
  ];
  const { reader, calls } = mock(items, { pageSize: 1, details: new Map([
    ["b", { ...items[3], parent: { kind: "task", taskId: "parent-task", sessionId: "parent" } }],
  ]) });
  const views = createOfflineViews(reader, "nested-pages");
  const first = await views.tree.children(nodeId("parent"), { epoch: "nested-pages", limit: 2 });
  assert.deepEqual(first.nodes.map(node => node.id), ["a", "b"].map(nodeId));
  assert(first.nodes.every(node => node.parentId === nodeId("parent")));
  assert(first.nextCursor);
  const second = await views.tree.children(nodeId("parent"),
    { epoch: "nested-pages", cursor: first.nextCursor, limit: 2 });
  assert.deepEqual(second.nodes.map(node => node.id), [nodeId("c")]);
  assert.equal(second.nodes[0].parentId, nodeId("parent"));
  assert.equal(second.nextCursor, undefined);
  assert.equal(second.revision, first.revision);
  const grandchildren = await views.tree.children(nodeId("a"), { epoch: "nested-pages", limit: 2 });
  assert.deepEqual(grandchildren.nodes.map(node => node.id), [nodeId("grandchild")]);
  const roots = await views.tree.children("agora:root:user-tasks", { epoch: "nested-pages", limit: 10 });
  assert.deepEqual(roots.nodes.map(node => node.id), ["other-root", "parent"].map(nodeId));
  assert.equal(roots.nodes.find(node => node.id === nodeId("parent")).childCount, 3);
  assert.equal(calls.filter(([method]) => method === "listSessions").length, items.length);
  assert.deepEqual(calls.filter(([method]) => method === "getSession").map(([, id]) => id), ["b"]);
  views.dispose();
});

test("budget_paused 映射为暂停状态，并将自身及祖先保留为热节点", async () => {
  const { reader } = mock([
    summary("parent"),
    summary("budget", { status: "budget_paused",
      parent: { kind: "task", taskId: "parent-task", sessionId: "parent" } }),
    summary("cold"),
  ]);
  const views = createOfflineViews(reader);
  const snapshot = await views.tree.snapshot(request());
  assert.deepEqual(new Set(snapshot.nodes.map(node => node.id)),
    new Set(["agora:root:user-tasks", nodeId("parent"), nodeId("budget")]));
  assert.equal(snapshot.nodes.find(node => node.id === nodeId("budget")).status, "paused");
  assert.equal((await views.sessions.snapshot(ref("budget"))).status, "paused");
  views.dispose();
});
