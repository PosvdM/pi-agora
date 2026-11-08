import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, access, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { stripTypeScriptTypes } from "node:module";
import { acquireInstanceLock, acquireSessionWriterLock, currentProcessIdentity, isSessionWriterLock } from "pi-hostkit";
import { assertIsolatedTestHome } from "./fixtures/test-home.mjs";

// 独立转译允许 CLI 在并行 archive 包合入前验证接口，不修改任何生产依赖。
const root = fileURLToPath(new URL("../", import.meta.url));
const compiled = await mkdtemp(path.join(tmpdir(), "agora-cli-1d-code-"));
for (const [source, target] of [["packages/protocol/src/client.ts", "protocol.mjs"], ["packages/cli/src/archive.ts", "archive.js"], ["packages/cli/src/index.ts", "index.js"], ["packages/daemon/src/archive-maintenance.ts", "maintenance.mjs"]]) {
  let text = await readFile(path.join(root, source), "utf8");
  text = text.replaceAll('"@pi-agora/protocol"', JSON.stringify(pathToFileURL(path.join(compiled, "protocol.mjs")).href))
    .replaceAll('"pi-hostkit"', JSON.stringify(pathToFileURL(path.join(root, "node_modules/pi-hostkit/dist/index.js")).href))
    .replaceAll('"@pi-agora/archive"', JSON.stringify(pathToFileURL(path.join(root, "packages/archive/dist/index.js")).href));
  await writeFile(path.join(compiled, target), stripTypeScriptTypes(text, { mode: "transform" }));
}
await writeFile(path.join(compiled, "package.json"), '{"type":"module"}');
after(() => rm(compiled, { recursive: true, force: true }));
const { runCli } = await import(pathToFileURL(path.join(compiled, "index.js")));
const { daemonAvailable, readSse, sessionTree } = await import(pathToFileURL(path.join(compiled, "archive.js")));
const { AgoraConnectionError, AgoraHttpError } = await import(pathToFileURL(path.join(compiled, "protocol.mjs")));
const { deleteArchiveOffline } = await import(pathToFileURL(path.join(compiled, "maintenance.mjs")));

function harness(overrides = {}) {
  const output = [], errors = [], calls = [];
  let readerClosed = 0, clientClosed = 0, opened = 0;
  const reader = {
    listSessions: async q => { calls.push(["list", q]); return { items: [{ agoraSessionId: "as_one", taskId: "tk_one", createdAt: "2026-01-01" }] }; },
    getSession: async () => ({ agoraSessionId: "as_one", status: "completed" }),
    readUserView: async (id, q) => { calls.push(["view", id, q]); return { leafId: "e2", entries: [{ id: "e1" }], historyBefore: "e1" }; },
    readPartials: async () => [{ runId: "pr_one", t: "2026-01-01", messageSeq: 1, contentIndex: 0, blockType: "text", delta: "未完成" }],
    close: () => readerClosed++,
  };
  const client = { url: "http://127.0.0.1:1234", token: "test", expiresAt: "", request: async (...args) => { calls.push(args); return { agoraSessionId: "as_one" }; }, close: () => clientClosed++, refresh: async () => {} };
  const deps = { available: async () => false, open: async () => { opened++; return reader; }, connect: async options => { calls.push(["connect", options]); return client; }, verify: async () => ({ state: "ok" }), deleteOffline: async () => { throw new Error("没有安全删除证明"); }, ...overrides };
  return { output, errors, calls, reader, client, deps, get readerClosed() { return readerClosed; }, get clientClosed() { return clientClosed; }, get opened() { return opened; }, run: args => runCli(args, { out: value => output.push(JSON.parse(value)), error: value => errors.push(value) }, deps) };
}

test("log 离线解析任务 ID、传递分页并关闭 reader", async () => {
  const h = harness();
  assert.equal(await h.run(["log", "tk_one", "--limit", "2", "--before", "e2"]), 0);
  assert.deepEqual(h.calls[1], ["view", "as_one", { limit: 2, before: "e2" }]);
  assert.equal(h.readerClosed, 1);
});
test("show 会话返回快照；离线 tail 明确无实时流", async () => {
  for (const command of ["show", "tail"]) {
    const h = harness();
    assert.equal(await h.run([command, "as_one"]), 0);
    assert.equal(h.output[0].leafId, "e2");
    assert.equal(h.output[0].unfinishedPartials[0].blocks[0].text, "未完成");
    if (command === "tail") assert.equal(h.output[0].streaming, false);
  }
});
test("认证、403、协议错误和业务连接错误不触发离线降级", async () => {
  for (const failure of [new AgoraHttpError(401, "unauthenticated"), new AgoraHttpError(403, "forbidden"), new Error("协议版本不兼容"), new AgoraConnectionError()]) {
    const h = harness({ available: async () => true, connect: async () => { throw failure; } });
    assert.equal(await h.run(["log", "as_one"]), 1);
    assert.equal(h.opened, 0);
  }
  const h = harness({ available: async () => true });
  h.client.request = async () => { throw new AgoraConnectionError(); };
  assert.equal(await h.run(["log", "as_one"]), 1);
  assert.equal(h.opened, 0);
  assert.equal(h.clientClosed, 1);
});
test("在线 show/log 与 verify 路由、身份及幂等键", async () => {
  for (const [args, method, route] of [
    [["show", "as_one"], "GET", "/v1/sessions/as_one/snapshot?limit=100"],
    [["log", "as_one", "--before", "e1"], "GET", "/v1/sessions/as_one/history?limit=100&before=e1"],
    [["verify-archive", "as_one"], "POST", "/v1/archive/verify"],
  ]) {
    const h = harness({ available: async () => true });
    assert.equal(await h.run(args), 0);
    assert.deepEqual(h.calls[0], ["connect", { home: path.resolve(process.env.AGORA_HOME ?? path.join((await import("node:os")).homedir(), ".pi/agora")), as: "host:cli", autoStart: false }]);
    assert.equal(h.calls[1][0], method); assert.equal(h.calls[1][1], route);
    if (method === "POST") { assert.deepEqual(h.calls[1][2], { sessionId: "as_one" }); assert.ok(h.calls[1][3].idempotencyKey); }
    assert.equal(h.clientClosed, 1);
  }
});
test("在线删除与 takeover 未开放；离线删除只调用维护入口", async () => {
  const h = harness();
  assert.equal(await h.run(["archive", "delete", "as_one"]), 1);
  assert.match(h.errors[0], /在线删除尚未开放/);
  assert.equal(await h.run(["takeover", "pr_one"]), 1);
  assert.match(h.errors[1], /签名/);
  let called;
  h.deps.deleteOffline = async (...args) => { called = args; return { archiveState: "missing" }; };
  assert.equal(await h.run(["archive", "delete", "as_one", "--offline", "--home", compiled]), 0);
  assert.deepEqual(called, [path.resolve(compiled), "as_one"]);
  assert.equal(h.opened, 0);
  assert.equal(await h.run(["archive", "delete", "../escape", "--offline"]), 1);
});
test("ls --tree 保留分页及循环节点；未知用量不补零", async () => {
  const h = harness();
  h.reader.listSessions = async () => ({ items: [{ agoraSessionId: "a" }, { agoraSessionId: "b", inheritsFrom: "a" }], nextCursor: "next" });
  assert.equal(await h.run(["ls", "--tree"]), 0);
  assert.equal(h.output[0].items[0].children[0].agoraSessionId, "b");
  assert.equal(h.output[0].nextCursor, "next");
  assert.equal("usage" in h.output[0].items[0], false);
  assert.equal(sessionTree([{ id: "a", inheritsFrom: "b" }, { id: "b", inheritsFrom: "a" }]).length, 2);
});
test("中立 parent 将继承会话列为同级，子任务挂在父任务当前会话下", () => {
  const tree = sessionTree([
    { agoraSessionId: "old", parent: { kind: "user" } },
    { agoraSessionId: "current", inheritsFrom: "old", parent: { kind: "user" } },
    { agoraSessionId: "child", parent: { kind: "task", taskId: "parent-task", sessionId: "current" } },
  ]);
  assert.equal(tree.length, 2);
  assert.deepEqual(tree.find(item => item.agoraSessionId === "old").children, []);
  assert.equal(tree.find(item => item.agoraSessionId === "current").children[0].agoraSessionId, "child");
});
test("离线任务 ID 优先使用当前会话标记，不依据创建时间猜测", async () => {
  const h = harness();
  h.reader.listSessions = async () => ({ items: [
    { agoraSessionId: "old", createdAt: "2099", isCurrent: false },
    { agoraSessionId: "current", createdAt: "2000", isCurrent: true },
  ] });
  assert.equal(await h.run(["log", "tk_one"]), 0);
  assert.equal(h.calls.find(call => call[0] === "view")[1], "current");
});
test("离线 verify 只计算、不连接或写 DB，拒绝越界路径", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "agora-cli-verify-"));
  try {
    const file = path.join(home, "session.jsonl"); await writeFile(file, "{}\n");
    const h = harness({ available: async () => { throw new Error("不应检查在线状态"); } });
    h.reader.getSession = async () => ({ sessionFile: file });
    assert.equal(await h.run(["verify-archive", "as_one", "--offline", "--home", home]), 0);
    assert.deepEqual(h.output[0], { offline: true, persisted: false, results: [{ sessionId: "as_one", state: "ok" }] });
    h.reader.getSession = async () => ({ sessionFile: path.join(compiled, "index.js") });
    assert.equal(await h.run(["verify-archive", "as_one", "--offline", "--home", home]), 1);
    assert.match(h.errors[0], /超出/);
  } finally { await rm(home, { recursive: true, force: true }); }
});
test("参数校验在读取归档之前完成", async () => {
  const h = harness();
  for (const args of [["log"], ["log", "as_one", "--limit", "201"], ["ls", "--limit", "NaN"], ["show", "as_one", "extra"], ["log", "as_one", "--offline"]]) assert.equal(await h.run(args), 1);
  assert.equal(h.opened, 0);
});
function sse(text) { return new Response(text, { headers: { "content-type": "text/event-stream" } }); }
test("SSE 支持分段中文、CRLF、多行及帧上限", async () => {
  const bytes = new TextEncoder().encode('event: status\r\ndata: {"text":\r\ndata: "中文"}\r\n\r\n');
  const stream = new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close(); } });
  const events = [];
  for await (const event of readSse(stream)) events.push(event);
  assert.deepEqual(events, [{ event: "status", data: { text: "中文" } }]);
  await assert.rejects(async () => { for await (const event of readSse(sse(`data: ${"x".repeat(1_048_577)}`).body)) void event; }, /大小限制/);
});
test("tail 快照后订阅 SSE，resync 重新快照，取消后释放连接", async () => {
  const controller = new AbortController();
  let snapshots = 0, streams = 0;
  const h = harness({ available: async () => true, signal: controller.signal, fetch: async (url, options) => {
    streams++; assert.match(url, /epoch=epoch&afterSeq=/); assert.equal(options.headers.Authorization, "Bearer test");
    if (streams === 1) return sse('event: resync\ndata: {}\n\n');
    controller.abort(); return sse('event: status\ndata: {"status":"completed"}\n\n');
  } });
  h.client.request = async (_method, route) => { assert.match(route, /snapshot/); return { cursor: { epoch: "epoch", seq: ++snapshots }, entries: [] }; };
  assert.equal(await h.run(["tail", "as_one"]), 0);
  assert.equal(snapshots, 2); assert.equal(streams, 2); assert.equal(h.clientClosed, 1);
});
test("tail 正常运行退出或终态快照后的 EOF 不误报连接故障", async () => {
  for (const frame of ['', 'event: session\ndata: {"event":{"type":"agora_run","phase":"exited"}}\n\n']) {
    const h = harness({ available: async () => true, fetch: async () => sse(frame) });
    h.client.request = async () => ({ cursor: { epoch: 'epoch', seq: 1 }, entries: [], status: frame ? 'running' : 'completed' });
    assert.equal(await h.run(['tail', 'as_one']), 0);
    assert.deepEqual(h.errors, []);
    assert.equal(h.clientClosed, 1);
  }
});
test("健康检查只在缺少发现或传输不可达时返回离线", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "agora-cli-health-"));
  let status = 403, protocol = { min: 1, max: 1 };
  const server = createServer((_request, response) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify({ instanceId: "in_test", daemonVersion: "1", protocol })); });
  try {
    assert.equal(await daemonAvailable(home), false);
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    await mkdir(path.join(home, "run"));
    await writeFile(path.join(home, "run/daemon.json"), JSON.stringify({ port: server.address().port, instanceId: "in_test" }));
    await assert.rejects(daemonAvailable(home), error => error.status === 403);
    status = 200; protocol = { min: 2, max: 2 };
    await assert.rejects(daemonAvailable(home), /协议版本/);
    protocol = { min: 1, max: 1 }; assert.equal(await daemonAvailable(home), true);
    await new Promise(resolve => server.close(resolve));
    assert.equal(await daemonAvailable(home), false);
  } finally { server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve)); await rm(home, { recursive: true, force: true }); }
});

async function maintenanceFixture() {
  const home = await mkdtemp(path.join(tmpdir(), "agora-cli-delete-")), id = "as_safe", directory = path.join(home, "sessions", id);
  await mkdir(directory, { recursive: true }); await mkdir(path.join(home, "run"));
  const file = path.join(directory, "session.jsonl"); await writeFile(file, "{}\n");
  const savedEnvironment = new Map(["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA"].map(key => [key, process.env[key]]));
  process.env.HOME = process.env.USERPROFILE = path.join(home, "isolated-home");
  process.env.APPDATA = path.join(home, "isolated-home", "AppData", "Roaming");
  process.env.LOCALAPPDATA = path.join(home, "isolated-home", "AppData", "Local");
  try { await assertIsolatedTestHome(home); }
  catch (error) {
    for (const [key, value] of savedEnvironment) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(home, { recursive: true, force: true });
    throw error;
  }
  const db = new DatabaseSync(path.join(home, "agora.db"));
  db.exec("CREATE TABLE schema_version(version INTEGER,migrated_at TEXT); INSERT INTO schema_version VALUES(6,'测试'); CREATE TABLE agora_sessions(id TEXT PRIMARY KEY,session_file TEXT,status TEXT,control_state TEXT,archive_state TEXT,revision INTEGER); CREATE TABLE process_runs(id TEXT,agora_session_id TEXT,state TEXT,exited_at TEXT,cleanup_error TEXT); CREATE TABLE settings(key TEXT,value TEXT); INSERT INTO settings VALUES('epoch','test'); CREATE TABLE changes(seq INTEGER PRIMARY KEY,epoch TEXT,object_type TEXT,object_id TEXT,tombstone INTEGER,created_at TEXT);");
  db.prepare("INSERT INTO agora_sessions VALUES(?,?,'completed',NULL,'ok',1)").run(id, file);
  return { home, id, directory, file, db, cleanup: async () => {
    try { db.close(); await rm(home, { recursive: true, force: true }); }
    finally { for (const [key, value] of savedEnvironment) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
  } };
}
async function releasedWriter(file) {
  const lock = await acquireSessionWriterLock(file, { app: "pi-agora", identity: currentProcessIdentity("cli-test") });
  assert.ok(isSessionWriterLock(lock)); assert.equal(await lock.recoverPreviousWriter(), "none"); await lock.release();
}
test("离线删除持有两类锁、保留元数据并发布 upsert", async () => {
  const f = await maintenanceFixture();
  try {
    await releasedWriter(f.file);
    assert.deepEqual(await deleteArchiveOffline({ home: f.home, sessionId: f.id }), { sessionId: f.id, archiveState: "missing", deleted: true });
    await assert.rejects(access(f.directory));
    assert.equal(f.db.prepare("SELECT archive_state FROM agora_sessions").get().archive_state, "missing");
    assert.equal(f.db.prepare("SELECT tombstone FROM changes").get().tombstone, 0);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM agora_sessions").get().n, 1);
  } finally { await f.cleanup(); }
});
test("离线删除规范化数据库中的父目录别名，不误拒绝同一会话文件", async t => {
  const f = await maintenanceFixture();
  try {
    const alias = path.join(f.home, "session-alias");
    try { await symlink(path.join(f.home, "sessions"), alias, "junction"); }
    catch (error) { if (["EPERM", "EACCES"].includes(error.code)) { t.skip("本机不允许创建链接"); return; } throw error; }
    f.db.prepare("UPDATE agora_sessions SET session_file=?").run(path.join(alias, f.id, "session.jsonl"));
    await releasedWriter(f.file);
    assert.equal((await deleteArchiveOffline({ home: f.home, sessionId: f.id })).deleted, true);
    await assert.rejects(access(f.directory));
  } finally { await f.cleanup(); }
});
test("离线删除拒绝 daemon 锁、未确认 run、缺失写者证明", async () => {
  const f = await maintenanceFixture();
  try {
    const lock = await acquireInstanceLock("daemon", path.join(f.home, "run"));
    try { await assert.rejects(deleteArchiveOffline({ home: f.home, sessionId: f.id }), /实例锁/); } finally { await lock.release(); }
    f.db.prepare("INSERT INTO process_runs VALUES('run',?,'starting',NULL,NULL)").run(f.id);
    await assert.rejects(deleteArchiveOffline({ home: f.home, sessionId: f.id }), /run/);
    f.db.exec("DELETE FROM process_runs");
    f.db.prepare("INSERT INTO process_runs VALUES('run',?,'exited','2026-01-01','清理失败')").run(f.id);
    await assert.rejects(deleteArchiveOffline({ home: f.home, sessionId: f.id }), /run/);
    f.db.exec("DELETE FROM process_runs");
    const writer = await acquireSessionWriterLock(f.file, { app: "pi-agora", identity: currentProcessIdentity("cli-busy") });
    assert.ok(isSessionWriterLock(writer));
    try { await assert.rejects(deleteArchiveOffline({ home: f.home, sessionId: f.id }), /写锁/); }
    finally { await writer.release(); }
    await assert.rejects(deleteArchiveOffline({ home: f.home, sessionId: f.id }), /证明/);
    await access(f.file);
    assert.equal(f.db.prepare("SELECT archive_state FROM agora_sessions").get().archive_state, "ok");
  } finally { await f.cleanup(); }
});
test("离线删除拒绝活跃会话和越界数据库路径", async () => {
  const f = await maintenanceFixture();
  try {
    f.db.exec("UPDATE agora_sessions SET status='running'");
    await assert.rejects(deleteArchiveOffline({ home: f.home, sessionId: f.id }), /仍可运行/);
    f.db.exec("UPDATE agora_sessions SET status='completed'");
    f.db.prepare("UPDATE agora_sessions SET session_file=?").run(path.join(compiled, "index.js"));
    await assert.rejects(deleteArchiveOffline({ home: f.home, sessionId: f.id }), /指定会话目录/);
    await access(f.file);
  } finally { await f.cleanup(); }
});
test("离线删除拒绝路径穿越和目录内符号链接", async t => {
  const f = await maintenanceFixture();
  try {
    await assert.rejects(deleteArchiveOffline({ home: f.home, sessionId: "../escape" }), /ID/);
    await releasedWriter(f.file);
    try { await symlink(compiled, path.join(f.directory, "outside"), "junction"); }
    catch (error) { if (["EPERM", "EACCES"].includes(error.code)) { t.skip("本机不允许创建链接"); return; } throw error; }
    await assert.rejects(deleteArchiveOffline({ home: f.home, sessionId: f.id }), /链接/);
    await access(f.file);
  } finally { await f.cleanup(); }
});
