import assert from "node:assert/strict";
import { test } from "node:test";
import { createOfflineViews, OFFLINE_LIMITS } from "../packages/pane-plugin/src/offline.ts";

const OLD = "2024-01-01T00:00:00.000Z";
const RECENT = "2026-01-02T00:00:00.000Z";
const request = (openNodeIds = []) => ({ openNodeIds, recentSince: "2026-01-01T00:00:00.000Z" });
const ref = id => ({ source: "agora", id });
const nodeId = id => `agora:session:${id}`;
const summary = (id, extra = {}) => ({
  agoraSessionId: id, kind: "task", title: id, model: "test", profile: "implement",
  convenerId: "user", status: "completed", archiveState: "ok", createdAt: OLD, ...extra,
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
  // No offline view is permitted to discover or call a write API on the reader.
  for (const name of ["send", "abort", "write", "request", "openSession", "readRawEntries"]) {
    Object.defineProperty(reader, name, { get() { throw new Error(`Unexpected write/raw API access: ${name}`); } });
  }
  return { reader, calls };
}

test("snapshot includes exactly hot sessions and ancestors, not cold siblings", async () => {
  const items = [
    summary("parent"),
    summary("child", { convenerId: "parent-convener", parentPiSessionId: "main", status: "running" }),
    summary("cold", { convenerId: "parent-convener", parentId: nodeId("parent") }),
    summary("recent", { lastActivityAt: RECENT }),
    summary("open"), summary("unrelated"),
    summary("paused", { status: "quota_paused" }), summary("waiting", { status: "waiting_children" }),
  ];
  const { reader, calls } = mock(items, { details: new Map([
    ["child", { ...items[1], parentId: nodeId("parent") }],
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

test("empty hot set has no virtual groups; open group does not load all its descendants", async () => {
  const { reader } = mock([summary("cold")]);
  const views = createOfflineViews(reader);
  assert.deepEqual((await views.tree.snapshot(request())).nodes, []);
  const open = await views.tree.snapshot(request(["agora:root:user-tasks"]));
  assert.deepEqual(open.nodes.map(node => node.id), ["agora:root:user-tasks"]);
  views.dispose();
});

test("nested parent gap remains unassigned instead of attaching to parentPiSessionId", async () => {
  const { reader } = mock([
    summary("unknown", { convenerId: "task-convener", parentPiSessionId: "main", status: "running" }),
    summary("main-child", { convenerId: "main", parentId: "pane:session:main" }),
  ]);
  const views = createOfflineViews(reader);
  const snapshot = await views.tree.snapshot(request());
  assert.equal(snapshot.nodes.find(node => node.id === nodeId("unknown")).parentId, null);
  const children = await views.tree.children("pane:session:main", { epoch: snapshot.epoch, limit: 10 });
  assert.deepEqual(children.nodes.map(node => node.id), [nodeId("main-child")]);
  views.dispose();
});

test("user meetings and user tasks use separate virtual roots with read-only meeting groups", async () => {
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
  assert.equal(views.panels, undefined);
  views.dispose();
});

test("children filter by direct parent and paginate a stable metadata cut", async () => {
  const { reader, calls } = mock([
    summary("b"), summary("a"), summary("c"), summary("nested", { parentId: nodeId("a") }),
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
  await assert.rejects(views.tree.children(nodeId("a"), { epoch: "pagination", cursor: first.nextCursor, limit: 2 }), /cursor/);
  await assert.rejects(views.tree.children(nodeId("a"), { epoch: "pagination", cursor: "broken", limit: 2 }), /cursor/);
  await assert.rejects(views.tree.children(nodeId("a"), { epoch: "pagination", cursor: "a".repeat(4097), limit: 2 }), /cursor/);
  views.dispose();
});

test("every opening has a new epoch; stale epochs reset without scanning", async () => {
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

test("revision is deterministic across metadata order, and changes with projected metadata", async () => {
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

test("readonly snapshots and history forward opaque entries and partials without reconstruction", async () => {
  const entries = [{ arbitrary: "opaque pi entry", nested: { value: 42 } }];
  const partials = [{ runId: "run", at: RECENT, blocks: [{ type: "text", contentIndex: 0, text: "unfinished", done: false }] }];
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

test("missing files remain visible but snapshots reject clearly; adapter failures are not empty content", async () => {
  const { reader, calls } = mock([summary("missing", { archiveState: "missing", status: "interrupted" })]);
  const views = createOfflineViews(reader);
  const tree = await views.tree.snapshot(request([nodeId("missing")]));
  assert.equal(tree.nodes.find(node => node.id === nodeId("missing")).availability, "missing");
  await assert.rejects(views.sessions.snapshot(ref("missing")), /file is missing: missing/);
  await assert.rejects(views.sessions.history(ref("missing"), { before: "b", limit: 1 }), /file is missing/);
  await assert.rejects(views.sessions.snapshot(ref("unknown")), /metadata is unavailable/);
  assert(!calls.some(([method]) => method === "readUserView"));
  views.dispose();
  const broken = mock([summary("broken")]);
  broken.reader.readUserView = async () => { throw new Error("ENOENT archive.jsonl"); };
  const failed = createOfflineViews(broken.reader);
  await assert.rejects(failed.sessions.snapshot(ref("broken")), /ENOENT/);
  failed.dispose();
});

test("metadata scanning yields and rejects explicit limits, adapter loops and oversized pages", async () => {
  const items = Array.from({ length: OFFLINE_LIMITS.sessions + 1 }, (_, i) => summary(String(i)));
  const many = mock(items, { pageSize: OFFLINE_LIMITS.scanPageSize });
  const views = createOfflineViews(many.reader);
  let yielded = false;
  const pending = views.tree.snapshot(request());
  setImmediate(() => { yielded = true; });
  await assert.rejects(pending, /exceeds 4096 sessions/);
  assert.equal(yielded, true);
  views.dispose();

  const loop = mock([]);
  loop.reader.listSessions = async () => ({ items: [], nextCursor: "repeat" });
  const loopViews = createOfflineViews(loop.reader);
  await assert.rejects(loopViews.tree.snapshot(request()), /repeated metadata cursor/);
  loopViews.dispose();

  const empty = mock([]);
  let page = 0;
  empty.reader.listSessions = async () => ({ items: [], nextCursor: String(++page) });
  const emptyViews = createOfflineViews(empty.reader);
  await assert.rejects(emptyViews.tree.snapshot(request()), /exceeds 64 pages/);
  emptyViews.dispose();

  const oversized = mock([]);
  oversized.reader.listSessions = async () => ({ items: items.slice(0, OFFLINE_LIMITS.scanPageSize + 1) });
  const oversizedViews = createOfflineViews(oversized.reader);
  await assert.rejects(oversizedViews.tree.snapshot(request()), /exceeded.*page size/);
  oversizedViews.dispose();
});

test("invalid paging, foreign refs and oversized history are rejected", async () => {
  const { reader } = mock([summary("a")], { entries: [1, 2] });
  const views = createOfflineViews(reader, "validation");
  for (const limit of [0, -1, 1.5, Infinity, OFFLINE_LIMITS.pageSize + 1]) {
    await assert.rejects(views.tree.children("parent", { epoch: "validation", limit }), /page limit/);
    await assert.rejects(views.sessions.history(ref("a"), { before: "b", limit }), /page limit/);
  }
  await assert.rejects(views.sessions.snapshot({ source: "pane", id: "a" }), /agora session reference/);
  await assert.rejects(views.sessions.history(ref("a"), { before: "b", limit: 1 }), /exceeded.*page size/);
  await assert.rejects(views.tree.snapshot({ openNodeIds: [], recentSince: "invalid" }), /recentSince/);
  views.dispose();
});

test("dispose cancels pending snapshot and closes once without starting subsequent reads", async () => {
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

test("dispose cancels metadata pagination at its asynchronous boundary", async () => {
  const { reader, calls } = mock([summary("a"), summary("b")], { pageSize: 1 });
  const views = createOfflineViews(reader);
  const snapshot = views.tree.snapshot(request());
  const rejected = assert.rejects(snapshot, { name: "AbortError" });
  setImmediate(() => views.dispose());
  await rejected;
  await new Promise(resolve => setImmediate(resolve));
  assert(calls.filter(([method]) => method === "listSessions").length <= 1);
});
