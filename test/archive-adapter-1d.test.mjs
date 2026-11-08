import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openArchive, projectUserView, verifySessionFile } from "../packages/archive/dist/index.js";

const parserAvailable = await import("@pi-agora/harness-pi").then(() => true, error => {
  if (error.code === "ERR_MODULE_NOT_FOUND" && error.message.includes("@pi-agora/harness-pi")) return false;
  throw error;
});
const needsParser = { skip: parserAvailable ? false : "待整合 @pi-agora/harness-pi 解析器包" };
const at = "2026-11-08T08:00:00.000Z";
const digest = value => createHash("sha256").update(value).digest("hex");
const jsonl = values => values.map(value => JSON.stringify(value)).join("\n") + "\n";
const header = version => ({ type: "session", version, id: "pi-fixture", timestamp: at, cwd: "/fixture" });
const message = (id, parentId, text, timestamp = 1) => ({
  type: "message", id, parentId, timestamp: at,
  message: { role: "user", content: text, timestamp },
});
const fragment = (messageSeq, delta = "未完成") => ({
  t: at, messageSeq, contentIndex: 0, blockType: "text", delta,
});

async function fixture(t, version = 4) {
  const root = await mkdtemp(path.join(tmpdir(), "agora-archive-1d-"));
  const home = path.join(root, "home");
  await mkdir(home);
  const db = new DatabaseSync(path.join(home, "agora.db"));
  db.exec(`CREATE TABLE schema_version(version INTEGER); INSERT INTO schema_version VALUES(${version});
    CREATE TABLE principals(id TEXT PRIMARY KEY,pi_session_id TEXT,type TEXT);
    CREATE TABLE tasks(id TEXT PRIMARY KEY,title TEXT,parent_task_id TEXT,agora_session_id TEXT);
    CREATE TABLE agora_sessions(
      id TEXT PRIMARY KEY,kind TEXT,title TEXT,model TEXT,profile TEXT,convener_id TEXT,
      parent_principal_id TEXT,task_id TEXT,meeting_id TEXT,status TEXT,archive_state TEXT,
      inherits_from TEXT,inherit_reason TEXT,created_at TEXT,ended_at TEXT,session_file TEXT,pi_session_id TEXT,
      thinking TEXT,cwd TEXT);
    CREATE TABLE process_runs(id TEXT PRIMARY KEY,agora_session_id TEXT,diagnostics_path TEXT);
    CREATE TABLE usage_records(seq INTEGER,agora_session_id TEXT,input_tokens INTEGER,cache_read_tokens INTEGER,cache_write_tokens INTEGER,output_tokens INTEGER,reasoning_tokens INTEGER,context_tokens INTEGER);
    INSERT INTO principals VALUES('convener','pi-parent','agent:main');
    INSERT INTO tasks VALUES('task-1','存档任务',NULL,'as-1');`);
  let reader;
  t.after(async () => { reader?.close(); db.close(); await rm(root, { recursive: true, force: true }); });
  const add = (id = "as-1", extra = {}) => {
    const file = extra.file ?? path.join(home, "sessions", id, "session.jsonl");
    db.prepare(`INSERT INTO agora_sessions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, "task", "不应暴露的内部标题", "test-model", "explore", extra.convener ?? "convener",
      "convener", extra.task ?? "task-1", extra.meeting ?? null, "completed", extra.state ?? "live",
      extra.inherits ?? null, extra.inheritReason ?? null, extra.createdAt ?? at, null, file, "pi-fixture", "medium", "/fixture");
    return file;
  };
  const open = async () => (reader = await openArchive({ home, apiVersion: 1 }));
  const write = async (file, contents) => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, contents); };
  return { root, home, db, add, open, write };
}

test("用户投影沿父链包含压缩前条目并排除废弃分支", () => {
  const root = message("root", null, "任务");
  const old = message("old", "root", "旧分支");
  const before = message("before", "root", "压缩前");
  const compact = { type: "compaction", id: "compact", parentId: "before", summary: "摘要" };
  const leaf = message("leaf", "compact", "继续");
  const entries = [root, old, before, compact, leaf];
  assert.deepEqual(projectUserView(entries, "leaf"), [root, before, compact, leaf]);
  assert.equal(projectUserView(entries, "leaf")[2], compact);
  assert.deepEqual(projectUserView(entries, null), []);
  assert.deepEqual(projectUserView(entries, "missing"), []);
  assert.throws(() => projectUserView([{ ...root, parentId: "root" }], "root"), { code: "invalid_branch" });
});

for (const version of [4, 5, 6]) {
  test(`数据库 v${version} 使用共用旧列，只读打开且不迁移`, async t => {
    const f = await fixture(t, version);
    const file = f.add();
    await f.write(file, "会话内容不应被读取或修改");
    const beforeDb = digest(await readFile(path.join(f.home, "agora.db")));
    const beforeFile = digest(await readFile(file));
    const reader = await f.open();
    assert.equal(reader.apiVersion, 1);
    assert.equal(reader.schemaVersion, version);
    const page = await reader.listSessions();
    assert.equal(page.items[0].title, "存档任务");
    assert.equal(page.items[0].parentPiSessionId, "pi-parent");
    assert.deepEqual(page.items[0].parent, { kind: "main", piSessionId: "pi-parent" });
    assert.equal(page.items[0].archiveState, "partial");
    assert.equal(page.items[0].messageCount, undefined);
    const detail = await reader.getSession("as-1");
    assert.equal(detail.availability, "available");
    assert.equal(detail.sessionFile, await realpath(file));
    assert.equal(await reader.getSession("不存在"), undefined);
    assert.throws(() => reader.db.exec("DELETE FROM agora_sessions"), /readonly|read.only/i);
    reader.close();
    reader.close();
    await assert.rejects(reader.listSessions(), { code: "closed" });
    assert.equal(digest(await readFile(path.join(f.home, "agora.db"))), beforeDb);
    assert.equal(digest(await readFile(file)), beforeFile);
  });
}

test("会话分页默认 50、上限 200，游标绑定筛选且无重复", async t => {
  const f = await fixture(t);
  for (let i = 0; i < 225; i++) f.add(`as-${String(i).padStart(3, "0")}`, { convener: i < 210 ? "convener" : "other", meeting: "meeting-1" });
  const reader = await f.open();
  assert.equal((await reader.listSessions()).items.length, 50);
  assert.equal((await reader.listSessions({ limit: 999 })).items.length, 200);
  const one = await reader.listSessions({ convenerId: "convener", meetingId: "meeting-1", taskId: "task-1", limit: 200 });
  const two = await reader.listSessions({ convenerId: "convener", meetingId: "meeting-1", taskId: "task-1", limit: 200, cursor: one.nextCursor });
  assert.equal(one.items.length, 200);
  assert.equal(two.items.length, 10);
  assert.equal(two.nextCursor, undefined);
  assert.equal(new Set([...one.items, ...two.items].map(s => s.agoraSessionId)).size, 210);
  await assert.rejects(reader.listSessions({ cursor: one.nextCursor }), { code: "invalid_cursor" });
  for (const limit of [0, -1, 1.5, NaN, Infinity]) await assert.rejects(reader.listSessions({ limit }), { code: "invalid_limit" });
  await assert.rejects(reader.listSessions({ cursor: "not-json" }), { code: "invalid_cursor" });
});

test("中立 parent 使用父任务当前会话、主 pi 会话或用户，不包含查看器节点标识", async t => {
  const f = await fixture(t);
  f.db.exec(`INSERT INTO principals VALUES
    ('child-convener','pi-child','agent:child'),('user-convener',NULL,'user'),
    ('pane-convener','pane:internal-node','host:pane'),('cli-convener',NULL,'host:cli');
    INSERT INTO tasks VALUES('parent-task','父任务',NULL,'parent-current'),
      ('child-task','子任务','parent-task','child-session');`);
  f.add("parent-old", { task: "parent-task" });
  f.add("parent-current", { task: "parent-task" });
  f.add("child-session", { task: "child-task", convener: "child-convener" });
  f.add("main-session");
  f.add("user-session", { convener: "user-convener" });
  f.add("pane-session", { convener: "pane-convener" });
  f.add("cli-session", { convener: "cli-convener" });
  const reader = await f.open();
  assert.deepEqual((await reader.getSession("child-session")).parent,
    { kind: "task", taskId: "parent-task", sessionId: "parent-current" });
  assert.deepEqual((await reader.getSession("main-session")).parent, { kind: "main", piSessionId: "pi-parent" });
  for (const id of ["user-session", "pane-session", "cli-session"]) {
    const session = await reader.getSession(id);
    assert.deepEqual(session.parent, { kind: "user" });
    assert.equal(session.parentPiSessionId, undefined);
    assert.equal(session.parentDiagnostics, undefined);
  }
  f.add("parent-next", { task: "parent-task" });
  f.db.exec("UPDATE tasks SET agora_session_id='parent-next' WHERE id='parent-task'");
  const list = await reader.listSessions();
  const child = list.items.find(item => item.agoraSessionId === "child-session");
  assert.deepEqual(child.parent, { kind: "task", taskId: "parent-task", sessionId: "parent-next" });
  for (const item of list.items) {
    const detail = await reader.getSession(item.agoraSessionId);
    assert.deepEqual(item.parent, detail.parent);
    assert.equal(item.usage, undefined);
    assert.ok(!JSON.stringify(item.parent).includes("pane:"));
  }
});

test("缺失主 pi 标识或父任务关联时省略 parent 并提供诊断", async t => {
  const f = await fixture(t);
  f.db.exec(`INSERT INTO principals VALUES('main-no-pi',NULL,'agent:main');
    INSERT INTO tasks VALUES('orphan-task','缺父任务','parent-not-found','orphan-session');`);
  f.add("missing-main", { convener: "main-no-pi" });
  f.add("orphan-session", { task: "orphan-task" });
  f.add("unknown-convener", { convener: "not-found" });
  const reader = await f.open();
  const kinds = new Map([
    ["missing-main", "main_session_id_missing"], ["orphan-session", "parent_task_missing"],
    ["unknown-convener", "session_parent_unknown"],
  ]);
  for (const item of (await reader.listSessions()).items) {
    const detail = await reader.getSession(item.agoraSessionId);
    assert.equal(item.parent, undefined);
    assert.equal(detail.parent, undefined);
    assert.equal(item.parentDiagnostics[0].kind, kinds.get(item.agoraSessionId));
    assert.deepEqual(item.parentDiagnostics, detail.parentDiagnostics);
    assert.equal(typeof item.parentDiagnostics[0].message, "string");
  }
});

test("不存在的 home 或数据库不会建目录；未知版本和未支持功能明确失败", async t => {
  const f = await fixture(t);
  const missingHome = path.join(f.root, "不存在");
  await assert.rejects(openArchive({ home: missingHome, apiVersion: 1 }), { code: "ENOENT" });
  assert.ok(!(await readdir(f.root)).includes("不存在"));
  const emptyHome = path.join(f.root, "empty");
  await mkdir(emptyHome);
  await assert.rejects(openArchive({ home: emptyHome, apiVersion: 1 }), { code: "database_missing" });
  assert.deepEqual(await readdir(emptyHome), []);
  await assert.rejects(openArchive({ home: f.home, apiVersion: 2 }), { code: "unsupported_api" });
  const previousHome = process.env.AGORA_HOME;
  const savedUserHome = new Map(["HOME", "USERPROFILE"].map(key => [key, process.env[key]]));
  try {
    delete process.env.AGORA_HOME;
    process.env.HOME = process.env.USERPROFILE = f.root;
    await assert.rejects(openArchive({ apiVersion: 1 }), { code: "ENOENT" });
    process.env.AGORA_HOME = f.home;
    const fromEnvironment = await openArchive({ apiVersion: 1 });
    fromEnvironment.close();
  } finally {
    for (const [key, value] of savedUserHome) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    if (previousHome === undefined) delete process.env.AGORA_HOME;
    else process.env.AGORA_HOME = previousHome;
  }
  const reader = await f.open();
  await assert.rejects(reader.listBoardEntries("sealed"), { code: "unsupported" });
  await assert.rejects(reader.getMeeting("meeting"), { code: "unsupported" });
  reader.close();
  f.db.exec("UPDATE schema_version SET version=99");
  await assert.rejects(f.open(), { code: "unsupported_schema" });
});

test("读取不存在会话有明确错误，缺失文件仍返回未关闭 partial", async t => {
  const f = await fixture(t);
  const file = f.add();
  await f.write(path.join(path.dirname(file), "partials", "run-1.jsonl"), jsonl([
    fragment(1), fragment(2, "已关闭"), { messageSeq: 2, closed: true, entryId: "written" },
    { messageSeq: 1, ended: true, message: { role: "assistant", timestamp: 1, content: [] } },
  ]));
  const reader = await f.open();
  assert.equal((await reader.getSession("as-1")).availability, "missing");
  assert.equal((await reader.getSession("as-1")).archiveState, "missing");
  const partials = await reader.readPartials("as-1");
  assert.deepEqual(partials, [{ ...fragment(1), runId: "run-1" }]);
  assert.equal((await verifySessionFile(file)).state, "missing");
  for (const method of ["readUserView", "readRawEntries", "readPartials", "readDiagnostics"]) {
    await assert.rejects(reader[method]("missing"), { code: "session_not_found" });
  }
  await assert.rejects(reader.readUserView("as-1"), { code: "session_file_missing" });
  await assert.rejects(reader.readRawEntries("as-1"), { code: "session_file_missing" });
});

test("partial 保留块元数据、完整末行，忽略截断末行", async t => {
  const f = await fixture(t);
  const file = f.add();
  const partialFile = path.join(path.dirname(file), "partials", "run-2.jsonl");
  const tool = { ...fragment(1, '{"command":"npm'), blockType: "toolCall", toolName: "bash", toolCallId: "call-1" };
  await f.write(partialFile, jsonl([tool]) + JSON.stringify(fragment(2, "末行")));
  const reader = await f.open();
  assert.deepEqual(await reader.readPartials("as-1"), [{ ...tool, runId: "run-2" }, { ...fragment(2, "末行"), runId: "run-2" }]);
  await f.write(partialFile, jsonl([tool]) + '{"messageSeq":2,"delta":"未写完');
  assert.deepEqual(await reader.readPartials("as-1"), [{ ...tool, runId: "run-2" }]);
  await f.write(partialFile, "{bad json}\n");
  await assert.rejects(reader.readPartials("as-1"), { code: "invalid_json" });
});

test("诊断兼容 runs/<runId>.json 和旧 diagnostics.json，并保留未知字段", async t => {
  const f = await fixture(t);
  const file = f.add();
  f.db.exec("INSERT INTO process_runs VALUES('run-1','as-1',NULL),('run-2','as-1',NULL),('run-3','as-1',NULL)");
  await f.write(path.join(path.dirname(file), "runs", "run-1.json"), JSON.stringify({ reason: "stopped", stderrTail: "诊断", extra: 1 }));
  await f.write(path.join(path.dirname(file), "runs", "run-2.diagnostics.json"), JSON.stringify({ reason: "crashed" }));
  const reader = await f.open();
  assert.deepEqual(await reader.readDiagnostics("as-1"), [
    { runId: "run-1", reason: "stopped", stderrTail: "诊断", extra: 1 }, { runId: "run-2", reason: "crashed" },
  ]);
});

test("数据库会话及诊断路径越界拒绝读取", async t => {
  const f = await fixture(t);
  const outside = path.join(f.root, "outside.jsonl");
  await f.write(outside, "敏感内容");
  f.add("outside", { file: outside });
  const file = f.add("inside");
  const reader = await f.open();
  await assert.rejects(reader.getSession("outside"), { code: "unsafe_path" });
  f.db.prepare("INSERT INTO process_runs VALUES(?,?,?)").run("run-1", "inside", outside);
  await assert.rejects(reader.readDiagnostics("inside"), { code: "unsafe_path" });
  assert.equal((await reader.getSession("inside")).sessionFile, path.resolve(await realpath(f.home), path.relative(f.home, file)));
});

test("session、partials 和诊断目录的符号链接越界拒绝读取", async t => {
  const f = await fixture(t);
  const outside = path.join(f.root, "outside");
  await mkdir(outside);
  await writeFile(path.join(outside, "session.jsonl"), "外部会话");
  await mkdir(path.join(f.home, "sessions"));
  try { await symlink(outside, path.join(f.home, "sessions", "linked"), process.platform === "win32" ? "junction" : "dir"); }
  catch (error) { if (["EPERM", "EACCES"].includes(error.code)) return t.skip("当前系统不允许创建目录链接"); throw error; }
  f.add("linked");
  f.add("linked-missing", { file: path.join(f.home, "sessions", "linked", "missing.jsonl") });
  const local = f.add("local");
  await mkdir(path.dirname(local), { recursive: true });
  await symlink(outside, path.join(path.dirname(local), "partials"), process.platform === "win32" ? "junction" : "dir");
  const reader = await f.open();
  await assert.rejects(reader.getSession("linked"), { code: "unsafe_path" });
  await assert.rejects(reader.getSession("linked-missing"), { code: "unsafe_path" });
  await assert.rejects(reader.readPartials("local"), { code: "unsafe_path" });
  f.db.prepare("INSERT INTO process_runs VALUES(?,?,?)").run("run-1", "local", path.join(f.home, "sessions", "linked", "session.jsonl"));
  await assert.rejects(reader.readDiagnostics("local"), { code: "unsafe_path" });
});

test("原始分页保留废弃分支，用户分页排除 before 水位", needsParser, async t => {
  const f = await fixture(t);
  const file = f.add();
  const entries = [message("a", null, "根"), message("old", "a", "废弃"), message("b", "a", "活动"),
    { type: "compaction", id: "c", parentId: "b", timestamp: at, summary: "压缩", firstKeptEntryId: "b", tokensBefore: 10 }, message("d", "c", "末条")];
  await f.write(file, jsonl([header(3), ...entries]));
  const before = digest(await readFile(file));
  const reader = await f.open();
  const latest = await reader.readUserView("as-1", { limit: 2 });
  assert.equal(latest.leafId, "d");
  assert.deepEqual(latest.entries.map(e => e.id), ["c", "d"]);
  assert.equal(latest.historyBefore, "c");
  const history = await reader.readUserView("as-1", { before: latest.historyBefore, limit: 2 });
  assert.deepEqual(history.entries.map(e => e.id), ["a", "b"]);
  assert.equal(history.historyBefore, null);
  await assert.rejects(reader.readUserView("as-1", { before: "old" }), { code: "invalid_before" });
  const raw = await reader.readRawEntries("as-1", { limit: 2 });
  const remaining = await reader.readRawEntries("as-1", { cursor: raw.nextCursor, limit: 200 });
  assert.deepEqual([...raw.items, ...remaining.items], entries);
  assert.equal(digest(await readFile(file)), before);
});

test("v1 内容不变时同一 reader 保留派生键并可连续 before 分页", needsParser, async t => {
  const f = await fixture(t);
  const file = f.add();
  const entries = Array.from({ length: 8 }, (_, i) => ({ type: "message", timestamp: at,
    message: { role: "user", content: `消息-${i}`, timestamp: i } }));
  await f.write(file, jsonl([header(1), ...entries]));
  const before = digest(await readFile(file));
  const reader = await f.open();
  const first = await reader.readUserView("as-1", { limit: 3 });
  const again = await reader.readUserView("as-1", { limit: 3 });
  assert.deepEqual(again, first);
  const second = await reader.readUserView("as-1", { before: first.historyBefore, limit: 3 });
  const third = await reader.readUserView("as-1", { before: second.historyBefore, limit: 3 });
  assert.equal(new Set([...third.entries, ...second.entries, ...first.entries].map(e => e.id)).size, 8);
  assert.equal(third.historyBefore, null);
  assert.equal(digest(await readFile(file)), before);
  await appendFile(file, jsonl([{ type: "message", timestamp: at,
    message: { role: "user", content: "内容指纹改变", timestamp: 9 } }]));
  const changed = await reader.readUserView("as-1", { limit: 1 });
  assert.equal(changed.entries[0].message.content, "内容指纹改变");
});

test("ended 完整消息匹配避免重复展示，角色时间相同但内容不同仍保留", needsParser, async t => {
  const f = await fixture(t);
  const file = f.add();
  const final = message("final", null, "已写入", 9);
  await f.write(file, jsonl([header(3), final]));
  await f.write(path.join(path.dirname(file), "partials", "run.jsonl"), jsonl([
    fragment(1, "已写入"), { messageSeq: 1, ended: true, message: final.message },
    fragment(2, "未写入"), { messageSeq: 2, ended: true, message: { ...final.message, content: "未写入" } },
    fragment(3, "已关闭"), { messageSeq: 3, closed: true, entryId: "final" },
  ]));
  const reader = await f.open();
  assert.deepEqual(await reader.readPartials("as-1"), [{ ...fragment(2, "未写入"), runId: "run" }]);
});

test("校验追加前缀、消息数和末条消息，真正损坏判 suspect", needsParser, async t => {
  const f = await fixture(t);
  const file = f.add();
  const first = jsonl([header(3), message("a", null, "根", 1)]);
  await f.write(file, first);
  const initial = await verifySessionFile(file, { messageEndCount: 1, lastMessage: { role: "user", timestamp: 1 } });
  assert.equal(initial.state, "ok");
  assert.equal(initial.hash, digest(first));
  await appendFile(file, jsonl([message("b", "a", "追加", 2)]));
  const next = await verifySessionFile(file, { previous: { hash: initial.hash, bytes: initial.bytes }, messageEndCount: 2 });
  assert.equal(next.state, "ok");
  assert.equal(next.messageCount, 2);
  assert.equal((await verifySessionFile(file, { hasUnfinishedPartials: true })).state, "partial");
  assert.equal((await verifySessionFile(file, { messageEndCount: 3 })).state, "suspect");
  assert.equal((await verifySessionFile(file, { lastMessage: { role: "assistant", timestamp: 99 } })).state, "suspect");
  await f.write(file, first.replace("根", "改"));
  assert.equal((await verifySessionFile(file, { previous: { hash: initial.hash, bytes: initial.bytes } })).state, "suspect");
  await appendFile(file, "{bad json}\n");
  assert.equal((await verifySessionFile(file)).state, "suspect");
});

test("解析器 empty 状态保守返回 partial，invalid 状态返回 suspect", needsParser, async t => {
  const f = await fixture(t);
  const file = f.add();
  await f.write(file, "");
  const empty = await verifySessionFile(file);
  assert.equal(empty.state, "partial");
  assert.equal(empty.messageCount, 0);
  assert.ok(empty.diagnostics.some(diagnostic => diagnostic.kind === "empty_session"));
  await f.write(file, jsonl([{ type: "session", version: 999, id: "unsupported", timestamp: at, cwd: "/fixture" }]));
  assert.equal((await verifySessionFile(file)).state, "suspect");
});

test("尾部和中间截断不直接判 suspect；大文件解析让出事件循环", needsParser, async t => {
  const f = await fixture(t);
  const file = f.add();
  const first = jsonl([header(3), message("a", null, "根")]);
  await f.write(file, first + '{"type":"message","id":"cut"');
  assert.notEqual((await verifySessionFile(file)).state, "suspect");
  await f.write(file, first + '{"type":"message","id":"cut"\n' + jsonl([message("b", "a", "恢复", 2)]));
  assert.notEqual((await verifySessionFile(file)).state, "suspect");
  const many = Array.from({ length: 12000 }, (_, i) => message(`m-${i}`, i === 0 ? null : `m-${i - 1}`, "消息".repeat(20), i));
  await f.write(file, jsonl([header(3), ...many]));
  let ticks = 0;
  const interval = setInterval(() => ticks++, 1);
  try { assert.equal((await verifySessionFile(file)).messageCount, many.length); }
  finally { clearInterval(interval); }
  assert.ok(ticks > 0, "大文件读取期间计时器应继续运行");
});
