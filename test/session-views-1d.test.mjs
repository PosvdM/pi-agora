import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, appendFile, rm, readdir, link } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';

// 这里只测试 daemon 服务；尚未合入的 archive/parser 以约定接口注入，不代替它们的独立测试。
const temporary = await mkdtemp(path.join(tmpdir(), 'agora-session-modules-'));
after(() => rm(temporary, { recursive: true, force: true }));
const fixtureKey = `agora-session-test-${temporary}`;
const fixtures = globalThis[fixtureKey] = new Map();
after(() => { delete globalThis[fixtureKey]; });
const parserFile = path.join(temporary, 'parser.mjs');
await writeFile(parserFile, `
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
export async function parseSessionFile(file) {
  const raw = await readFile(file), entries = [], diagnostics = [];
  let version = 3;
  const lines = raw.toString('utf8').split('\\n');
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    try { const value = JSON.parse(lines[i]); if (value.type === 'session') version = value.version; else if (value.id) entries.push(value); }
    catch { diagnostics.push({ line: i + 1, kind: 'truncated', message: '测试文件包含不完整行' }); }
  }
  return { entries, leafId: entries.at(-1)?.id ?? null, version, idsStable: version !== 1, diagnostics,
    hash: createHash('sha256').update(raw).digest('hex'), bytes: raw.length };
}
`);
const archiveFile = path.join(temporary, 'archive.mjs');
await writeFile(archiveFile, `
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parseSessionFile } from './parser.mjs';
const fixtures = globalThis[${JSON.stringify(fixtureKey)}];
export function projectUserView(entries, leafId) {
  const byId = new Map(entries.map(entry => [entry.id, entry])), seen = new Set(), result = [];
  while (leafId && !seen.has(leafId)) {
    seen.add(leafId); const entry = byId.get(leafId); if (!entry) break;
    result.push(entry); leafId = entry.parentId;
  }
  return result.reverse();
}
export async function verifySessionFile(file, expected = {}) {
  const fixture = [...fixtures.values()].find(value => value.file === file);
  fixture?.verifications.push(structuredClone(expected));
  try {
    const parsed = await parseSessionFile(file), raw = await readFile(file);
    const prefix = expected.previous && createHash('sha256').update(raw.subarray(0, expected.previous.bytes)).digest('hex');
    const messageCount = parsed.entries.filter(entry => entry.type === 'message').length;
    return { state: expected.previous && prefix !== expected.previous.hash ? 'suspect' :
      expected.hasUnfinishedPartials || messageCount < (expected.messageEndCount ?? 0) ? 'partial' : 'ok',
      hash: parsed.hash, bytes: parsed.bytes, messageCount, diagnostics: [] };
  } catch (error) { if (error.code !== 'ENOENT') throw error;
    return { state: 'missing', hash: null, bytes: 0, messageCount: 0, diagnostics: [] }; }
}
export async function openArchive({ home, apiVersion }) {
  if (apiVersion !== 1) throw new Error('归档 API 版本不匹配');
  const fixture = fixtures.get(home);
  return { apiVersion: 1,
    async readPartials() { return structuredClone(fixture.archivedPartials); },
    async readDiagnostics() { return structuredClone(fixture.archivedDiagnostics); },
    close() { fixture.readerCloses++; }
  };
}
`);
async function compile(sourcePath, output, replacements = {}) {
  let source = await readFile(new URL(sourcePath, import.meta.url), 'utf8');
  for (const [from, to] of Object.entries(replacements)) source = source.replaceAll(JSON.stringify(from), JSON.stringify(to));
  await writeFile(path.join(temporary, output), stripTypeScriptTypes(source, { mode: 'transform', sourceUrl: sourcePath }));
  return pathToFileURL(path.join(temporary, output)).href;
}
const eventsUrl = await compile('../packages/daemon/src/harness/pi/archive-events.ts', 'events.mjs');
const errorsUrl = await compile('../packages/daemon/src/errors.ts', 'errors.mjs');
const sessionsUrl = await compile('../packages/daemon/src/sessions.ts', 'sessions.mjs', {
  '@pi-agora/archive': pathToFileURL(archiveFile).href,
  '@pi-agora/harness-pi': pathToFileURL(parserFile).href,
  './errors.js': errorsUrl,
  './harness/pi/archive-events.js': eventsUrl,
});
const { SessionViews } = await import(sessionsUrl);
const { PiArchiveEvents, entriesFromResponse } = await import(eventsUrl);

function message(text, timestamp = 1, role = 'assistant') {
  return { role, timestamp, content: [{ type: 'text', text }] };
}
function entry(id, parentId, value = message(id)) { return { type: 'message', id, parentId, timestamp: '2026-11-08T00:00:00Z', message: value }; }
function handle(initial = [], leafId = initial.at(-1)?.id ?? null) {
  const events = new Set(), exits = new Set();
  return {
    entries: structuredClone(initial), leafId, events, exits, commands: [], fail: false,
    identity: { pid: 1, startTime: '测试', runId: 'r1', instanceId: 'daemon' },
    async send(command) {
      this.commands.push(command.type);
      if (this.sendHook) return this.sendHook(command);
      if (this.fail) throw new Error('测试 RPC 关闭');
      return { type: 'response', command: command.type, success: true, data: { entries: this.entries, leafId: this.leafId } };
    },
    onEvent(fn) { events.add(fn); return () => events.delete(fn); },
    onExit(fn) { exits.add(fn); return () => exits.delete(fn); },
    emit(event) { for (const fn of [...events]) fn(event); },
    exit(reason = '测试退出') { for (const fn of [...exits]) fn({ reason }); },
    diagnostics() { return { reason: '驱动默认理由', cleanupConfirmed: true, activeTools: [{ toolName: 'read' }], stderr: '测试诊断' }; },
  };
}
class Response extends EventEmitter {
  chunks = []; writableEnded = false; destroyed = false; writableLength = 0; blocked = false;
  writeHead(status, headers) { this.status = status; this.headers = headers; }
  write(data) { this.chunks.push(data); return !this.blocked; }
  end() { this.writableEnded = true; this.emit('close'); }
  destroy() { this.destroyed = true; this.emit('close'); }
  values() { return this.chunks.join('').split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6))); }
}
function stream(views, cursor) {
  const request = new EventEmitter(), response = new Response();
  views.stream('s1', request, response, { epoch: cursor.epoch, afterSeq: cursor.seq });
  return { request, response };
}
async function setup(t, entries = []) {
  const home = await mkdtemp(path.join(tmpdir(), 'agora-session-view-'));
  const directory = path.join(home, 'sessions', 's1');
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, 'session.jsonl');
  const row = { id: 's1', task_id: 't1', session_file: file, status: 'running', control_state: null };
  const fixture = { home, directory, file, row, verifications: [], readerCloses: 0, archivedPartials: [], archivedDiagnostics: [] };
  fixtures.set(home, fixture);
  const store = {
    home,
    session(id) { if (id !== 's1') throw new Error('会话不存在'); return row; },
    get(sql) { return sql.includes('process_runs') ? undefined : { status_detail: '模型生成中' }; },
  };
  const views = new SessionViews(store, 'daemon');
  t.after(async () => { await views.close().catch(() => {}); fixtures.delete(home); await rm(home, { recursive: true, force: true }); });
  async function disk(values, newline = true, version = 3) {
    await writeFile(file, [JSON.stringify({ type: 'session', version, id: 'pi' }), ...values.map(value => JSON.stringify(value))].join('\n') + (newline ? '\n' : ''));
  }
  await disk(entries);
  const driver = handle(entries);
  async function partialRows(run = 'r1') {
    try { return (await readFile(path.join(directory, 'partials', `${run}.jsonl`), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
  return { ...fixture, views, driver, disk, partialRows };
}
function emitText(driver, text = '回复', timestamp = 2, end = true) {
  const value = message(text, timestamp);
  driver.emit({ type: 'message_start', message: message('', timestamp) });
  driver.emit({ type: 'message_update', message: value, assistantMessageEvent: { type: 'text_start', contentIndex: 0, partial: value } });
  driver.emit({ type: 'message_update', message: value, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: text, partial: value } });
  if (end) driver.emit({ type: 'message_end', message: value });
  return value;
}

test('会话视图：首次 begin 取得 RPC 条目，历史沿当前分支且排除 before', async t => {
  const values = [entry('a', null), entry('abandoned', 'a'), entry('b', 'a'), entry('c', 'b')];
  const f = await setup(t, values);
  await f.views.begin('s1', 'r1', f.driver);
  const snapshot = await f.views.snapshot('s1', 2);
  assert.deepEqual(f.driver.commands, ['get_entries']);
  assert.deepEqual(snapshot.entries.map(item => item.id), ['b', 'c']);
  assert.equal(snapshot.historyBefore, 'b');
  assert.deepEqual((await f.views.history('s1', { before: 'b' })).entries.map(item => item.id), ['a']);
  assert.equal(snapshot.cursor.epoch, 'daemon:r1');
  assert.equal(snapshot.statusDetail, '模型生成中');
  await assert.rejects(f.views.history('s1', { before: 'abandoned' }), error => error.code === 'invalid_cursor');
  await assert.rejects(f.views.snapshot('s1', 201), error => error.code === 'invalid_params');
});

test('会话视图：默认快照保留末 100 条，返回值与内部状态分离', async t => {
  const values = Array.from({ length: 120 }, (_, index) => entry(`m${index}`, index ? `m${index - 1}` : null));
  const f = await setup(t, values);
  await f.views.begin('s1', 'r1', f.driver);
  const first = await f.views.snapshot('s1');
  assert.equal(first.entries.length, 100);
  first.entries[0].message.content[0].text = '外部修改';
  assert.notEqual((await f.views.snapshot('s1')).entries[0].message.content[0].text, '外部修改');
});

test('会话视图：RPC 失败和假驱动缺少字段时只读回退，并明确诊断', async t => {
  const values = [entry('a', null)];
  const f = await setup(t, values);
  f.driver.sendHook = async () => ({ type: 'response', success: true, data: {} });
  const before = await readFile(f.file);
  await f.views.begin('s1', 'r1', f.driver);
  assert.deepEqual((await f.views.snapshot('s1')).entries, values);
  const [diagnostic] = await f.views.diagnostics('s1');
  assert.ok(diagnostic.diagnostics.some(item => item.kind === 'get_entries_fallback'));
  assert.deepEqual(await readFile(f.file), before);
});

test('会话视图：首次和后续异步刷新期间仍捕获新 inFlight，快照到 SSE 无丢失窗口', async t => {
  const f = await setup(t);
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  f.driver.sendHook = async () => { entered(); return new Promise(resolve => { release = resolve; }); };
  const begin = f.views.begin('s1', 'r1', f.driver);
  await started;
  const first = emitText(f.driver, '首次刷新期间', 2, false);
  release({ success: true, data: { entries: [], leafId: null } });
  await begin;
  assert.equal((await f.views.snapshot('s1')).inFlight[0].message.content[0].text, first.content[0].text);
  f.driver.sendHook = undefined;
  const cut = await f.views.snapshot('s1');
  const second = emitText(f.driver, '水位之后', 3, false);
  const { response } = stream(f.views, cut.cursor);
  const replay = response.values();
  assert.ok(replay.some(event => event.type === 'fragment' && event.change.fragment.delta === second.content[0].text));
  assert.ok(replay.every(event => event.cursor.seq > cut.cursor.seq));
  const later = await f.views.snapshot('s1');
  assert.equal(later.inFlight.length, 2);
  assert.ok(later.cursor.seq > cut.cursor.seq);
});

test('会话视图：后续 get_entries 阻塞时快照立即返回，旧刷新不能清掉较新的 inFlight', async t => {
  const f = await setup(t);
  await f.views.begin('s1', 'r1', f.driver);
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  f.driver.sendHook = async () => { entered(); return new Promise(resolve => { release = resolve; }); };
  emitText(f.driver, '旧回复', 2);
  await started;
  emitText(f.driver, '较新回复', 3, false);
  const snapshot = await Promise.race([
    f.views.snapshot('s1'),
    new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('快照被异步刷新阻塞')), 1000); timer.unref(); }),
  ]);
  assert.equal(snapshot.inFlight.at(-1).message.content[0].text, '较新回复');
  release({ success: true, data: { entries: [], leafId: null } });
  f.driver.sendHook = undefined;
  await f.views.flush();
  assert.equal((await f.views.snapshot('s1')).inFlight.at(-1).message.content[0].text, '较新回复');
});

test('会话视图：message_end 不闭片段，RPC 和磁盘完整行均匹配才写 closed', async t => {
  const f = await setup(t);
  await f.views.begin('s1', 'r1', f.driver);
  const value = emitText(f.driver);
  await f.views.settled('s1');
  assert.equal((await f.partialRows()).some(row => row.closed), false);
  const final = entry('final', null, value);
  f.driver.entries = [final]; f.driver.leafId = 'final';
  await f.disk([final], false);
  await f.views.settled('s1');
  assert.equal((await f.partialRows()).some(row => row.closed), false, '未换行条目不作闭片段证据');
  await appendFile(f.file, '\n');
  await f.views.settled('s1');
  const rows = await f.partialRows();
  assert.equal(rows.filter(row => row.closed).length, 1);
  assert.equal(rows.find(row => row.closed).entryId, 'final');
  assert.ok(rows.some(row => row.ended && row.message.content[0].text === '回复'));
  assert.deepEqual((await f.views.snapshot('s1')).unfinishedPartials, []);
  assert.deepEqual((await f.views.snapshot('s1')).inFlight, []);
});

test('会话视图：只有磁盘消息无 RPC entryId 时保留 ended 匹配行，不冒写 closed', async t => {
  const f = await setup(t);
  await f.views.begin('s1', 'r1', f.driver);
  const value = emitText(f.driver);
  await f.disk([entry('disk-only', null, value)]);
  f.driver.fail = true;
  await f.views.settled('s1');
  const rows = await f.partialRows();
  assert.equal(rows.some(row => row.closed), false);
  assert.ok(rows.some(row => row.ended));
  assert.deepEqual((await f.views.snapshot('s1')).unfinishedPartials, [], '完整磁盘消息应避免片段重复展示');
});

test('会话视图：idsStable 为 false 时禁止持久 closed，完整消息仍可去重', async t => {
  const f = await setup(t);
  await f.views.begin('s1', 'r1', f.driver);
  const value = emitText(f.driver, '旧格式消息', 2);
  const final = entry('temporary-id', null, value);
  f.driver.entries = [final]; f.driver.leafId = final.id;
  // 故意让测试临时 ID 与 RPC 相同，确保规则不依赖随机 ID 恰好不同。
  await f.disk([final], true, 1);
  await f.views.settled('s1');
  assert.equal((await f.partialRows()).some(row => row.closed), false);
  assert.deepEqual((await f.views.snapshot('s1')).unfinishedPartials, []);
});

test('会话视图：相同角色与时间戳但不同完整消息不能闭片段或误去重', async t => {
  const f = await setup(t);
  await f.views.begin('s1', 'r1', f.driver);
  emitText(f.driver, '真正回复', 2);
  const unrelated = entry('different', null, message('不同内容', 2));
  f.driver.entries = [unrelated]; f.driver.leafId = unrelated.id;
  await f.disk([unrelated]);
  await f.views.settled('s1');
  assert.equal((await f.partialRows()).some(row => row.closed), false);
  assert.ok((await f.views.snapshot('s1')).unfinishedPartials.length > 0);
});

test('会话视图：退出时落盘中断片段，归档理由和现成诊断，session 文件 hash 不变', async t => {
  const f = await setup(t, [entry('a', null)]);
  const before = await readFile(f.file);
  await f.views.begin('s1', 'r1', f.driver);
  emitText(f.driver, '未完成', 3, false);
  const { response } = stream(f.views, (await f.views.snapshot('s1')).cursor);
  await f.views.ended('s1', 'r1', 'idle_reclaim');
  const snapshot = await f.views.snapshot('s1');
  assert.equal(snapshot.cursor.epoch, 'daemon:r1');
  assert.ok((await f.partialRows()).some(row => row.delta === '未完成'));
  assert.equal(response.writableEnded, true);
  assert.equal(f.driver.events.size, 0); assert.equal(f.driver.exits.size, 0);
  const diagnostic = JSON.parse(await readFile(path.join(f.directory, 'runs', 'r1.json'), 'utf8'));
  assert.equal(diagnostic.reason, 'idle_reclaim');
  assert.equal(diagnostic.activeTools[0].toolName, 'read');
  assert.equal(diagnostic.verification.state, 'partial');
  const after = await readFile(f.file);
  assert.equal(createHash('sha256').update(before).digest('hex'), createHash('sha256').update(after).digest('hex'));
  await f.views.ended('s1', 'r1', 'stopped');
  assert.equal(JSON.parse(await readFile(path.join(f.directory, 'runs', 'r1.json'), 'utf8')).reason, 'stopped');
});

test('会话视图：退出时允许用已取得 RPC entryId 与最后落盘内容闭片段', async t => {
  const f = await setup(t);
  await f.views.begin('s1', 'r1', f.driver);
  const value = emitText(f.driver);
  const final = entry('last', null, value);
  f.driver.entries = [final]; f.driver.leafId = final.id;
  await f.views.settled('s1');
  assert.equal((await f.partialRows()).some(row => row.closed), false);
  await f.disk([final]);
  await f.views.ended('s1', 'r1', 'stopped');
  assert.equal((await f.partialRows()).find(row => row.closed)?.entryId, final.id);
});

test('会话视图：文件校验携带启动基线、消息结束数和末条消息，纯追加不改基线', async t => {
  const a = entry('a', null, message('用户', 1, 'user'));
  const f = await setup(t, [a]);
  await f.views.begin('s1', 'r1', f.driver);
  const original = await readFile(f.file);
  const value = emitText(f.driver, '完成', 2);
  const b = entry('b', 'a', value);
  f.driver.entries = [a, b]; f.driver.leafId = 'b';
  await f.disk([a, b]);
  await f.views.settled('s1');
  const expected = f.verifications.at(-1);
  assert.equal(expected.messageEndCount, 2);
  assert.deepEqual(expected.lastMessage, { role: 'assistant', timestamp: 2 });
  assert.deepEqual(expected.previous, { hash: createHash('sha256').update(original).digest('hex'), bytes: original.length });
  assert.equal((await f.views.verify('s1')).state, 'ok');
  await f.disk([entry('a', null, message('被改写', 1, 'user')), b]);
  assert.equal((await f.views.verify('s1')).state, 'suspect');
});

test('会话视图：过期、不连续、未来及旧 epoch 游标仅返回 resync', async t => {
  const f = await setup(t);
  await f.views.begin('s1', 'r1', f.driver);
  for (let index = 0; index < 2005; index++) f.views.status('s1');
  const current = (await f.views.snapshot('s1')).cursor;
  for (const cursor of [{ ...current, seq: 0 }, { ...current, seq: current.seq + 1 }, { ...current, seq: -1 }, { ...current, seq: 1.5 }, { ...current, epoch: 'other' }]) {
    const { response } = stream(f.views, cursor);
    assert.deepEqual(response.values().map(event => event.type), ['resync']);
    assert.equal(response.writableEnded, true);
    assert.equal(response.listenerCount('close'), 0);
  }
});

test('会话视图：新运行通知旧 stream resync，旧退出不能修改新 epoch', async t => {
  const f = await setup(t);
  await f.views.begin('s1', 'r1', f.driver);
  const { response } = stream(f.views, (await f.views.snapshot('s1')).cursor);
  const next = handle();
  await f.views.begin('s1', 'r2', next);
  assert.deepEqual(response.values().map(value => value.type), ['resync']);
  assert.equal(response.writableEnded, true);
  await f.views.ended('s1', 'r1', '旧退出');
  assert.equal((await f.views.snapshot('s1')).cursor.epoch, 'daemon:r2');
  assert.equal(next.events.size, 1);
});

test('会话视图：旧运行收尾期间的重同步快照等待新 epoch，不能重新订阅旧运行', async t => {
  const f = await setup(t);
  await f.views.begin('s1', 'r1', f.driver);
  const original = f.views.disk.bind(f.views);
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const barrier = new Promise(resolve => { release = resolve; });
  f.views.disk = async state => {
    if (state.runId === 'r1' && state.closing) { entered(); await barrier; }
    return original(state);
  };
  const previous = (await f.views.snapshot('s1')).cursor;
  const switching = f.views.begin('s1', 'r2', handle());
  await started;
  const pending = f.views.snapshot('s1');
  const { response } = stream(f.views, previous);
  assert.deepEqual(response.values().map(event => event.type), ['resync']);
  release();
  await switching;
  assert.equal((await pending).cursor.epoch, 'daemon:r2');
});

test('会话视图：SSE 慢客户端和主动断开清理监听，关闭服务清理驱动监听', async t => {
  const f = await setup(t);
  await f.views.begin('s1', 'r1', f.driver);
  const cut = (await f.views.snapshot('s1')).cursor;
  const slow = stream(f.views, cut);
  slow.response.blocked = true;
  f.views.status('s1');
  assert.equal(slow.response.writableEnded, true);
  assert.equal(slow.request.listenerCount('aborted'), 0);
  const normal = stream(f.views, (await f.views.snapshot('s1')).cursor);
  normal.request.emit('aborted');
  assert.equal(normal.response.listenerCount('close'), 0);
  const live = stream(f.views, (await f.views.snapshot('s1')).cursor);
  await f.views.close();
  assert.equal(live.response.writableEnded, true);
  assert.equal(f.driver.events.size, 0); assert.equal(f.driver.exits.size, 0);
  assert.equal(JSON.parse(await readFile(path.join(f.directory, 'runs', 'r1.json'), 'utf8')).reason, 'daemon_shutdown');
});

test('会话视图：片段写入失败可见且不伪装为 flush 成功', async t => {
  const f = await setup(t);
  await f.views.begin('s1', 'r1', f.driver);
  await writeFile(path.join(f.directory, 'partials'), '阻止创建片段目录');
  emitText(f.driver, '必须保存', 2, false);
  await assert.rejects(f.views.flush(), error => error instanceof AggregateError);
  const [diagnostic] = await f.views.diagnostics('s1');
  assert.ok(diagnostic.diagnostics.some(item => item.kind === 'archive_io'));
  await rm(path.join(f.directory, 'partials'));
  await f.views.flush();
  assert.equal((await f.partialRows()).filter(row => row.delta === '必须保存').length, 1);
});

test('会话视图：普通片段按秒合批，显式退出屏障保存间隔内的最终增量', async t => {
  const f = await setup(t);
  await f.views.begin('s1', 'r1', f.driver);
  emitText(f.driver, '第一批', 2, false);
  await f.views.flush();
  emitText(f.driver, '第二批', 3, false);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await f.partialRows()).some(row => row.delta === '第二批'), false);
  await f.views.ended('s1', 'r1', 'stopped');
  assert.equal((await f.partialRows()).filter(row => row.delta === '第二批').length, 1);
});

test('会话视图：上一批 I/O 期间排队的定时写入仍遵守一秒间隔', async t => {
  const f = await setup(t);
  await f.views.begin('s1', 'r1', f.driver);
  const original = f.views.sidecar.bind(f.views);
  let release, entered, blocked = false;
  const started = new Promise(resolve => { entered = resolve; });
  const barrier = new Promise(resolve => { release = resolve; });
  // 仅注入慢 I/O 切点，生产接口和磁盘追加仍走真实实现。
  f.views.sidecar = async (...args) => {
    if (args[1] === 'partials' && !blocked) { blocked = true; entered(); await barrier; }
    return original(...args);
  };
  emitText(f.driver, '慢写第一批', 2, false);
  f.views.states.get('s1').timer.ref();
  await started;
  emitText(f.driver, 'I/O 期间新片段', 3, false);
  await new Promise(resolve => setTimeout(resolve, 10));
  const queued = f.views.states.get('s1').work;
  release();
  await queued;
  assert.equal((await f.partialRows()).some(row => row.delta === 'I/O 期间新片段'), false);
  await f.views.ended('s1', 'r1', 'stopped');
  assert.equal((await f.partialRows()).filter(row => row.delta === 'I/O 期间新片段').length, 1);
});

test('会话视图：驱动退出监听使用 exit.reason，退出后 epoch 保持不变', async t => {
  const f = await setup(t);
  await f.views.begin('s1', 'r1', f.driver);
  emitText(f.driver, '退出前', 2, false);
  f.driver.exit('进程意外退出');
  await f.views.flush();
  const saved = JSON.parse(await readFile(path.join(f.directory, 'runs', 'r1.json'), 'utf8'));
  assert.equal(saved.reason, '进程意外退出');
  assert.equal((await f.views.snapshot('s1')).cursor.epoch, 'daemon:r1');
  assert.equal(f.driver.events.size, 0);
});

test('会话视图：拒绝会话越界路径及指向 session 的硬链接旁车', async t => {
  const f = await setup(t);
  await f.views.begin('s1', 'r1', f.driver);
  await mkdir(path.join(f.directory, 'partials'));
  await link(f.file, path.join(f.directory, 'partials', 'r1.jsonl'));
  const before = await readFile(f.file);
  emitText(f.driver, '禁止写入 session', 2, false);
  await assert.rejects(f.views.flush());
  assert.deepEqual(await readFile(f.file), before);
  f.row.session_file = path.join(temporary, 'outside.jsonl');
  await writeFile(f.row.session_file, JSON.stringify(entry('outside', null)) + '\n');
  await assert.rejects(f.views.verify('s1'), error => error.code === 'archive_path');
});

test('会话视图：离线快照读取归档未闭片段，reader 使用后关闭且不写会话文件', async t => {
  const f = await setup(t, [entry('a', null)]);
  const before = await readFile(f.file);
  f.archivedPartials.push({ runId: 'older', delta: '残留', messageSeq: 1, contentIndex: 0, blockType: 'text', t: '测试' });
  const snapshot = await f.views.snapshot('s1');
  assert.equal(snapshot.unfinishedPartials[0].delta, '残留');
  assert.equal(fixtures.get(f.home).readerCloses, 1);
  assert.deepEqual(await readFile(f.file), before);
  assert.deepEqual(await readdir(f.directory), ['session.jsonl']);
});

test('会话视图：在线快照保留历史运行未闭片段，并排除当前运行已持久化副本', async t => {
  const f = await setup(t);
  f.archivedPartials.push({ runId: 'older', delta: '历史中断', messageSeq: 1, contentIndex: 0, blockType: 'text', t: '测试' });
  f.archivedPartials.push({ runId: 'r1', delta: '当前副本', messageSeq: 1, contentIndex: 0, blockType: 'text', t: '测试' });
  await f.views.begin('s1', 'r1', f.driver);
  assert.deepEqual((await f.views.snapshot('s1')).unfinishedPartials.map(row => row.delta), ['历史中断']);
});

test('会话视图：归档写入失败的退出仍关闭 SSE，缺少会话文件不创建假会话', async t => {
  const f = await setup(t);
  await rm(f.file);
  await f.views.begin('s1', 'r1', f.driver);
  const { response } = stream(f.views, (await f.views.snapshot('s1')).cursor);
  await writeFile(path.join(f.directory, 'partials'), '阻止归档');
  emitText(f.driver, '最终片段', 2, false);
  await assert.rejects(f.views.ended('s1', 'r1', 'stopped'));
  assert.equal(response.writableEnded, true);
  assert.equal(f.driver.events.size, 0);
  await assert.rejects(readFile(f.file), error => error.code === 'ENOENT');
});

test('pi 归档事件：thinking、text 和 toolCall 块保留增量与工具开始元数据', () => {
  const events = new PiArchiveEvents('r1');
  const value = { role: 'assistant', timestamp: 1, content: [
    { type: 'thinking', thinking: '思考' }, { type: 'text', text: '文字' }, { type: 'toolCall', id: 'call1', name: 'read', arguments: {} },
  ] };
  events.receive({ type: 'message_start', message: value });
  const fragments = [];
  for (const [index, type, delta] of [[0, 'thinking', '思考'], [1, 'text', '文字'], [2, 'toolcall', '{"path":"a"}']]) {
    fragments.push(...events.receive({ type: 'message_update', message: value, assistantMessageEvent: { type: `${type}_start`, contentIndex: index } }).rows);
    fragments.push(...events.receive({ type: 'message_update', message: value, assistantMessageEvent: { type: `${type}_delta`, contentIndex: index, delta } }).rows);
  }
  assert.deepEqual(fragments.filter(row => row.delta).map(row => row.blockType), ['thinking', 'text', 'toolCall']);
  assert.equal(fragments.find(row => row.blockType === 'toolCall').toolCallId, 'call1');
  assert.equal(fragments.find(row => row.blockType === 'toolCall').toolName, 'read');
  const end = events.receive({ type: 'message_end', message: value });
  assert.equal(end.rows[0].ended, true);
  assert.equal(end.rows.some(row => row.closed), false);
  assert.throws(() => entriesFromResponse({ success: false, error: '测试' }));
});

test('会话视图：按并行接口声明执行严格类型检查，不依赖尚未合入的包', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const parserTypes = path.join(temporary, 'parser.d.ts');
  const archiveTypes = path.join(temporary, 'archive.d.ts');
  await writeFile(parserTypes, `
export interface SessionEntry { type: string; id: string; parentId: string | null; [key: string]: unknown }
export interface ParsedSession { entries: SessionEntry[]; leafId: string | null; version: number | null;
  idsStable: boolean; status: 'ok' | 'empty' | 'invalid'; header: unknown;
  diagnostics: { line: number; kind: string; message: string }[]; hash: string; bytes: number }
export function parseSessionFile(file: string): Promise<ParsedSession>;
`);
  await writeFile(archiveTypes, `
import type { SessionEntry } from '@pi-agora/harness-pi';
export function projectUserView(entries: SessionEntry[], leafId: string | null): SessionEntry[];
export function verifySessionFile(file: string, expected?: { messageEndCount?: number;
  lastMessage?: { role: string; timestamp: unknown }; previous?: { hash: string; bytes: number };
  hasUnfinishedPartials?: boolean }): Promise<{ state: 'ok' | 'partial' | 'suspect' | 'missing';
  hash: string | null; bytes: number; messageCount: number; diagnostics: unknown[] }>;
export interface Fragment { runId: string; t: string; messageSeq: number; contentIndex: number;
  blockType: 'thinking' | 'text' | 'toolCall'; delta: string; toolCallId?: string; toolName?: string;
  messageRole?: string; messageTimestamp?: unknown; [key: string]: unknown }
export function openArchive(options: { home?: string; apiVersion: 1 }): Promise<{
  readPartials(id: string): Promise<Fragment[]>; readDiagnostics(id: string): Promise<unknown[]>; close(): void }>;
`);
  const config = path.join(temporary, 'tsconfig.json');
  await writeFile(config, JSON.stringify({ compilerOptions: {
    target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, skipLibCheck: true,
    noEmit: true, types: ['node'], typeRoots: [path.join(root, 'node_modules', '@types')],
    paths: { '@pi-agora/harness-pi': [parserTypes], '@pi-agora/archive': [archiveTypes] },
  }, files: [path.join(root, 'packages/daemon/src/sessions.ts'), path.join(root, 'packages/daemon/src/harness/pi/archive-events.ts')] }));
  execFileSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '--project', config], {
    cwd: root, timeout: 60_000, encoding: 'utf8', stdio: 'pipe',
  });
});
