import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, appendFile, rm, readdir, link, realpath } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';

// 依赖注入覆盖并发与故障边界；真实共享包由 HTTP 联测和包构建验证。
const temporary = await mkdtemp(path.join(tmpdir(), 'agora-session-modules-'));
after(() => rm(temporary, { recursive: true, force: true }));
const fixtureKey = `agora-session-test-${temporary}`;
const fixtures = globalThis[fixtureKey] = new Map();
after(() => { delete globalThis[fixtureKey]; });
const parserFile = path.join(temporary, 'parser.mjs');
await writeFile(parserFile, `
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
export { sessionMessages } from ${JSON.stringify(new URL('../packages/harness-pi/dist/session-messages.js', import.meta.url).href)};
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
export { archivePath as resolveArchivePath } from ${JSON.stringify(new URL('../packages/archive/dist/io.js', import.meta.url).href)};
const fixtures = globalThis[${JSON.stringify(fixtureKey)}];
export function projectUserView(entries, leafId) {
  const byId = new Map(entries.map(entry => [entry.id, entry])), seen = new Set(), result = [];
  while (leafId && !seen.has(leafId)) {
    seen.add(leafId); const entry = byId.get(leafId); if (!entry) break;
    result.push(entry); leafId = entry.parentId;
  }
  return result.reverse();
}
export function projectPartials(fragments) {
  const messages = new Map();
  for (const fragment of fragments) {
    const key = fragment.runId + ':' + fragment.messageSeq;
    if (!messages.has(key)) messages.set(key, { runId: fragment.runId, at: fragment.t, blocks: [] });
    const partial = messages.get(key);
    let block = partial.blocks.find(value => value.contentIndex === fragment.contentIndex);
    if (!block) {
      block = fragment.blockType === 'toolCall'
        ? { type: 'toolCall', contentIndex: fragment.contentIndex, id: '', toolName: '', argsText: '', done: false }
        : { type: fragment.blockType, contentIndex: fragment.contentIndex, text: '', done: false };
      partial.blocks.push(block);
    }
    const field = block.type === 'toolCall' ? 'argsText' : 'text';
    block[field] = fragment.replace ? fragment.delta : block[field] + fragment.delta;
    if (fragment.done !== undefined) block.done = fragment.done;
    if (fragment.toolCallId !== undefined) block.id = fragment.toolCallId;
    if (fragment.toolName !== undefined) block.toolName = fragment.toolName;
    if (fragment.args !== undefined) block.args = fragment.args;
  }
  return [...messages.values()].map(value => ({ ...value, blocks: value.blocks.sort((a, b) => a.contentIndex - b.contentIndex) }));
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
const { PiArchiveEvents, entriesFromResponse, readPiEntries } = await import(eventsUrl);

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
  const home = await realpath(await mkdtemp(path.join(tmpdir(), 'agora-session-view-')));
  const directory = path.join(home, 'sessions', 's1');
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, 'session.jsonl');
  const row = { id: 's1', task_id: 't1', session_file: file, status: 'running', control_state: null };
  const fixture = { home, directory, file, row, verifications: [], readerCloses: 0, archivedPartials: [], archivedDiagnostics: [] };
  fixtures.set(home, fixture);
  const store = {
    home,
    session(id) { if (id !== 's1') throw new Error('会话不存在'); return row; },
    sessionUsage() { return undefined; },
    get(sql) { return sql.includes('process_runs') ? fixture.run : { status_detail: '模型生成中' }; },
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
  driver.emit({ type: 'message_start', message: { role: 'assistant', timestamp, content: [] } });
  driver.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_start', contentIndex: 0 } });
  driver.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: text } });
  if (end) driver.emit({ type: 'message_end', message: value });
  return value;
}

test('会话视图：全新实例读取历史快照，回放后 EOF；未确认 run 保留 stopping 流', async t => {
  for (const [status, run, ended] of [
    ['created', undefined, false],
    ['running', { id: 'old', state: 'exited', exited_at: '2026-01-01', cleanup_error: null }, false],
    ['completed', undefined, true],
    ['stopped', { id: 'old', state: 'exited', exited_at: '2026-01-01', cleanup_error: null }, true],
    ['completed', { id: 'old', state: 'ready', exited_at: null, cleanup_error: null }, false],
    ['stopped', { id: 'old', state: 'stopping', exited_at: null, cleanup_error: '退出未确认' }, false],
    ['stopped', { id: 'old', state: 'exited', exited_at: '2026-01-01', cleanup_error: '清理未确认' }, false],
  ]) {
    await t.test(`${status}/${run?.state ?? '无 run'}/${run?.cleanup_error ?? '无清理错误'}`, async t => {
      const f = await setup(t, [entry('history', null)]);
      f.row.status = status;
      // fixture 与 store 使用同一条运行记录，实例未调用 begin，也没有 DriverHandle。
      fixtures.get(f.home).run = run;
      const snapshot = await f.views.snapshot('s1');
      assert.deepEqual(snapshot.entries.map(value => value.id), ['history']);
      const unconfirmed = run && (run.state !== 'exited' || !run.exited_at || run.cleanup_error);
      assert.equal(snapshot.inFlight.phase, unconfirmed ? 'stopping' : 'idle');
      const { response } = stream(f.views, { ...snapshot.cursor, seq: 0 });
      assert.deepEqual(response.values().map(value => value.event.type), ['agora_entries']);
      assert.equal(response.writableEnded, ended);
      assert.equal(stream(f.views, snapshot.cursor).response.writableEnded, ended);
      if (!ended) {
        await f.views.begin('s1', run?.id ?? 'r1', f.driver);
        assert.equal(response.writableEnded, true);
        const live = stream(f.views, (await f.views.snapshot('s1')).cursor).response;
        emitText(f.driver, '迟到数据', 2, false);
        assert.equal(live.writableEnded, false);
        assert.ok(live.values().some(value => value.event.assistantMessageEvent?.delta === '迟到数据'));
      }
    });
  }
});

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
  assert.equal((await f.views.snapshot('s1')).inFlight.assistant.blocks[0].text, first.content[0].text);
  f.driver.sendHook = undefined;
  const cut = await f.views.snapshot('s1');
  const second = emitText(f.driver, '水位之后', 3, false);
  const { response } = stream(f.views, cut.cursor);
  const replay = response.values();
  assert.ok(replay.some(value => value.event.type === 'message_update' && value.event.assistantMessageEvent.delta === second.content[0].text));
  assert.ok(replay.every(event => event.cursor.seq > cut.cursor.seq));
  const later = await f.views.snapshot('s1');
  assert.equal(later.inFlight.assistant.blocks[0].text, '水位之后');
  assert.ok(later.cursor.seq > cut.cursor.seq);
});

test('会话视图：后续 get_entries 阻塞时快照立即返回，旧刷新不能清掉较新的 inFlight', async t => {
  const f = await setup(t);
  await f.views.begin('s1', 'r1', f.driver);
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  f.driver.sendHook = async () => { entered(); return new Promise(resolve => { release = resolve; }); };
  const older = emitText(f.driver, '旧回复', 2);
  await started;
  const before = await f.views.snapshot('s1');
  const replay = stream(f.views, before.cursor);
  emitText(f.driver, '较新回复', 3, false);
  const snapshot = await Promise.race([
    f.views.snapshot('s1'),
    new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('快照被异步刷新阻塞')), 1000); timer.unref(); }),
  ]);
  assert.equal(snapshot.inFlight.assistant.blocks[0].text, '较新回复');
  assert.equal(snapshot.inFlight.completed[0].content[0].text, '旧回复');
  assert.deepEqual(snapshot.entries, []);
  assert.equal(snapshot.cursor.seq, before.cursor.seq + 3);
  const final = entry('older', null, older);
  release({ success: true, data: { entries: [final], leafId: final.id } });
  f.driver.sendHook = undefined;
  await f.views.flush();
  const after = await f.views.snapshot('s1');
  assert.equal(after.inFlight.assistant.blocks[0].text, '较新回复');
  assert.equal(after.inFlight.completed, undefined);
  assert.deepEqual(after.entries, [final]);
  assert.deepEqual(before.entries, []);
  assert.equal(after.cursor.seq, snapshot.cursor.seq + 1);
  assert.deepEqual(replay.response.values().map(value => value.event.type), ['message_start', 'message_update', 'message_update', 'agora_entries']);
  assert.deepEqual(replay.response.values().map(value => value.cursor.seq), [1, 2, 3, 4].map(offset => before.cursor.seq + offset));
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
  assert.deepEqual((await f.views.snapshot('s1')).inFlight, { phase: 'streaming', tools: [], queue: { steering: [], followUp: [] } });
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
  assert.ok((await f.views.snapshot('s1')).inFlight.completed.length > 0);
  await f.views.ended('s1', 'r1');
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
    assert.deepEqual(response.values().map(value => value.event.type), ['resync']);
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
  assert.deepEqual(response.values().map(value => value.event.type), ['agora_run', 'resync']);
  assert.deepEqual(response.values()[0].event, { type: 'agora_run', runId: 'r2', phase: 'started' });
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
  assert.deepEqual(response.values().map(value => value.event.type), ['resync']);
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
  assert.equal(slow.response.writableEnded, false);
  assert.equal(slow.response.listenerCount('drain'), 1);
  f.views.status('s1');
  assert.equal(slow.response.values().length, 1);
  slow.response.blocked = false;
  slow.response.emit('drain');
  assert.equal(slow.response.values().length, 2);
  assert.equal(slow.response.listenerCount('drain'), 0);
  slow.response.blocked = true;
  f.views.status('s1');
  slow.request.emit('aborted');
  assert.equal(slow.response.writableEnded, true);
  assert.equal(slow.request.listenerCount('aborted'), 0);
  assert.equal(slow.response.listenerCount('drain'), 0);
  const normal = stream(f.views, (await f.views.snapshot('s1')).cursor);
  normal.request.emit('aborted');
  assert.equal(normal.response.listenerCount('close'), 0);
  const live = stream(f.views, (await f.views.snapshot('s1')).cursor);
  await f.views.close();
  assert.equal(live.response.writableEnded, true);
  assert.equal(f.driver.events.size, 0); assert.equal(f.driver.exits.size, 0);
  assert.equal(JSON.parse(await readFile(path.join(f.directory, 'runs', 'r1.json'), 'utf8')).reason, 'daemon_shutdown');
});

test('会话视图：大批历史回放遇背压逐帧暂停，终态排空后才 EOF，实时帧保持次序', async t => {
  const f = await setup(t);
  await f.views.begin('s1', 'r1', f.driver);
  const cut = (await f.views.snapshot('s1')).cursor;
  const payload = 'x'.repeat(128 * 1024);
  for (let index = 0; index < 24; index++) f.driver.emit({ type: 'large_frame', index, payload });
  const request = new EventEmitter(), response = new Response();
  response.blocked = true;
  f.views.stream('s1', request, response, { epoch: cut.epoch, afterSeq: cut.seq });
  assert.equal(response.chunks.length, 1);
  assert.equal(response.destroyed, false);
  assert.equal(response.listenerCount('drain'), 1);
  f.driver.emit({ type: 'large_frame', index: 24, payload });
  await f.views.ended('s1', 'r1', 'stopped');
  assert.equal(response.chunks.length, 1);
  assert.equal(response.writableEnded, false);
  response.blocked = false;
  response.emit('drain');
  assert.deepEqual(response.values().filter(value => value.event.type === 'large_frame').map(value => value.event.index), Array.from({ length: 25 }, (_, index) => index));
  assert.deepEqual(response.values().slice(-2).map(value => value.event.type), ['agora_run', 'agora_status']);
  assert.equal(response.writableEnded, true);
  assert.equal(response.listenerCount('drain'), 0);
  assert.equal(request.listenerCount('aborted'), 0);
});

test('会话视图：背压中的 resync 最后送达并结束，慢读实时队列超限才断开', async t => {
  const f = await setup(t);
  await f.views.begin('s1', 'r1', f.driver);
  const cut = (await f.views.snapshot('s1')).cursor;
  const paused = stream(f.views, cut);
  paused.response.blocked = true;
  f.driver.emit({ type: 'large_frame', payload: 'x'.repeat(128 * 1024) });
  await f.views.begin('s1', 'r2', handle());
  assert.equal(paused.response.writableEnded, false);
  paused.response.blocked = false;
  paused.response.emit('drain');
  assert.deepEqual(paused.response.values().map(value => value.event.type), ['large_frame', 'agora_run', 'resync']);
  assert.equal(paused.response.writableEnded, true);
  assert.equal(paused.response.listenerCount('drain'), 0);
  const slow = stream(f.views, (await f.views.snapshot('s1')).cursor);
  slow.response.blocked = true;
  const state = f.views.states.get('s1');
  for (let index = 0; index < 12; index++) f.views.publish(state, 'large_frame', { payload: 'x'.repeat(128 * 1024), index });
  assert.equal(slow.response.chunks.length, 1);
  assert.equal(slow.response.destroyed, true);
  assert.equal(slow.response.listenerCount('drain'), 0);
  assert.equal(slow.request.listenerCount('aborted'), 0);
});

test('会话视图：心跳背压等待 drain，不堆积心跳且取消后移除监听', async t => {
  const f = await setup(t);
  await f.views.begin('s1', 'r1', f.driver);
  t.mock.timers.enable({ apis: ['setInterval'] });
  const paused = stream(f.views, (await f.views.snapshot('s1')).cursor);
  paused.response.blocked = true;
  t.mock.timers.tick(15_000);
  assert.deepEqual(paused.response.chunks, [': keepalive\n\n']);
  assert.equal(paused.response.writableEnded, false);
  t.mock.timers.tick(30_000);
  assert.equal(paused.response.chunks.length, 1);
  f.views.status('s1');
  paused.response.blocked = false;
  paused.response.emit('drain');
  assert.equal(paused.response.values()[0].event.type, 'agora_status');
  assert.equal(paused.response.listenerCount('drain'), 0);
  paused.response.blocked = true;
  t.mock.timers.tick(15_000);
  assert.equal(paused.response.listenerCount('drain'), 1);
  paused.request.emit('aborted');
  assert.equal(paused.response.listenerCount('drain'), 0);
  const sent = paused.response.chunks.length;
  t.mock.timers.tick(60_000);
  assert.equal(paused.response.chunks.length, sent);
});

for (const finish of ['resume', 'close']) test(`会话视图：退出写入失败后的片段在 ${finish} 前重试落盘，不丢弃旧运行`, async t => {
  const f = await setup(t);
  await f.views.begin('s1', 'r1', f.driver);
  const blocked = path.join(f.directory, 'partials');
  await writeFile(blocked, '阻挡片段目录');
  emitText(f.driver, '旧运行必须保存的内容', 2, false);
  await assert.rejects(f.views.ended('s1', 'r1', '测试退出'));
  const previous = f.views.states.get('s1');
  assert.equal(previous.ended, true);
  assert.ok(previous.pending.length > 0);
  const next = handle();
  if (finish === 'resume') {
    await assert.rejects(f.views.begin('s1', 'r2', next));
    assert.equal(f.views.states.get('s1'), previous);
    assert.equal(next.events.size, 0);
    assert.ok(previous.pending.length > 0);
  }
  await rm(blocked);
  if (finish === 'resume') await f.views.begin('s1', 'r2', next);
  else await f.views.close();
  assert.equal(previous.pending.length, 0);
  assert.ok((await f.partialRows()).some(row => row.delta === '旧运行必须保存的内容'));
  assert.equal(JSON.parse(await readFile(path.join(f.directory, 'runs', 'r1.json'), 'utf8')).runId, 'r1');
});
test('会话视图：删除准备重试旧运行片段，失败保留状态，删除后关闭不重建目录', async t => {
  const f = await setup(t);
  await f.views.begin('s1', 'r1', f.driver);
  const blocked = path.join(f.directory, 'partials');
  await writeFile(blocked, '阻挡片段目录');
  emitText(f.driver, '删除前必须保存', 2, false);
  await assert.rejects(f.views.ended('s1', 'r1', '测试退出'));
  const previous = f.views.states.get('s1');
  await assert.rejects(f.views.prepareArchiveDeletion('s1'));
  assert.equal(f.views.states.get('s1'), previous);
  assert.ok(previous.pending.length > 0);
  assert.equal(f.views.deleting.has('s1'), false);
  await rm(blocked);
  const release = await f.views.prepareArchiveDeletion('s1');
  try {
    assert.equal(previous.pending.length, 0);
    assert.ok((await f.partialRows()).some(row => row.delta === '删除前必须保存'));
    assert.equal(f.views.states.has('s1'), false);
    await assert.rejects(f.views.begin('s1', 'r2', handle()), error => error.code === 'archive_busy');
    await assert.rejects(f.views.snapshot('s1'), error => error.code === 'archive_busy');
    await rm(f.directory, { recursive: true });
    await f.views.flush();
    await f.views.close();
    await assert.rejects(readdir(f.directory), error => error.code === 'ENOENT');
  } finally { release(); }
});
for (const finish of ['flush', 'resume', 'close', 'delete']) test(`会话视图：仅诊断失败时 ${finish} 屏障可恢复，无需新片段清除旧错误`, async t => {
  const f = await setup(t);
  await f.views.begin('s1', 'r1', f.driver);
  const blocked = path.join(f.directory, 'runs');
  await writeFile(blocked, '阻挡诊断目录');
  await assert.rejects(f.views.ended('s1', 'r1', '测试退出'));
  const previous = f.views.states.get('s1');
  assert.equal(previous.pending.length, 0);
  assert.equal(previous.diagnosticsDirty, true);
  const barrier = async () => {
    if (finish === 'resume') return f.views.begin('s1', 'r2', handle());
    if (finish === 'delete') return f.views.prepareArchiveDeletion('s1');
    return f.views[finish]();
  };
  await assert.rejects(barrier());
  await rm(blocked);
  const release = await barrier();
  try {
    assert.equal(previous.diagnosticsDirty, false);
    const saved = JSON.parse(await readFile(path.join(blocked, 'r1.json'), 'utf8'));
    assert.equal(saved.ended, true);
    assert.ok(saved.diagnostics.some(issue => issue.kind === 'archive_io'));
  } finally { if (typeof release === 'function') release(); }
});

test('会话视图：无 run 的排队任务停止后发送终态再 EOF', async t => {
  const f = await setup(t);
  f.row.status = 'created';
  const snapshot = await f.views.snapshot('s1');
  const { response } = stream(f.views, snapshot.cursor);
  assert.equal(response.writableEnded, false);
  f.row.status = 'stopped';
  f.views.status('s1');
  assert.equal(response.values().at(-1).event.status, 'stopped');
  assert.equal(response.writableEnded, true);
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
  assert.equal(snapshot.unfinishedPartials[0].blocks[0].text, '残留');
  assert.deepEqual(snapshot.inFlight, { phase: 'idle', tools: [], queue: { steering: [], followUp: [] } });
  assert.equal(fixtures.get(f.home).readerCloses, 1);
  assert.deepEqual(await readFile(f.file), before);
  assert.deepEqual(await readdir(f.directory), ['session.jsonl']);
});

test('会话视图：在线快照保留历史运行未闭片段，并排除当前运行已持久化副本', async t => {
  const f = await setup(t);
  f.archivedPartials.push({ runId: 'older', delta: '历史中断', messageSeq: 1, contentIndex: 0, blockType: 'text', t: '测试' });
  f.archivedPartials.push({ runId: 'r1', delta: '当前副本', messageSeq: 1, contentIndex: 0, blockType: 'text', t: '测试' });
  await f.views.begin('s1', 'r1', f.driver);
  assert.deepEqual((await f.views.snapshot('s1')).unfinishedPartials.map(row => row.blocks[0].text), ['历史中断']);
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
  assert.deepEqual(response.values().slice(-2).map(value => value.event.type), ['agora_run', 'agora_status']);
  assert.equal(response.values().at(-1).event.phase, 'idle');
  assert.deepEqual((await f.views.snapshot('s1')).inFlight, { phase: 'idle', tools: [], queue: { steering: [], followUp: [] } });
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
    fragments.push(...events.receive({ type: 'message_update', assistantMessageEvent: { type: `${type}_start`, contentIndex: index,
      ...(type === 'toolcall' ? { id: 'call1', toolName: 'read' } : {}) } }).rows);
    fragments.push(...events.receive({ type: 'message_update', assistantMessageEvent: { type: `${type}_delta`, contentIndex: index, delta } }).rows);
  }
  assert.deepEqual(fragments.filter(row => row.delta).map(row => row.blockType), ['thinking', 'text', 'toolCall']);
  assert.equal(fragments.find(row => row.blockType === 'toolCall').toolCallId, 'call1');
  assert.equal(fragments.find(row => row.blockType === 'toolCall').toolName, 'read');
  const end = events.receive({ type: 'message_end', message: value });
  assert.equal(end.rows.at(-1).ended, true);
  assert.equal(end.rows.some(row => row.closed), false);
  assert.throws(() => entriesFromResponse({ success: false, error: '测试' }));
});

test('会话视图：delta-only 块按索引重建，块结束和最终消息覆盖拼接内容并落旁车', async t => {
  const f = await setup(t);
  await f.views.begin('s1', 'r1', f.driver);
  const update = (assistantMessageEvent, usage) => f.driver.emit({ type: 'message_update', assistantMessageEvent,
    ...(usage === undefined ? {} : { usage }) });
  f.driver.emit({ type: 'message_start', message: { role: 'assistant', timestamp: 8, content: [] } });
  update({ type: 'toolcall_start', contentIndex: 2, id: 'c1', toolName: 'read' });
  update({ type: 'toolcall_delta', contentIndex: 2, delta: '{"path":"wrong' });
  update({ type: 'text_delta', contentIndex: 1, delta: '拼接文字' }, { output: 9 });
  update({ type: 'thinking_start', contentIndex: 0 });
  update({ type: 'thinking_delta', contentIndex: 0, delta: '拼接思考' });
  const live = (await f.views.snapshot('s1')).inFlight.assistant;
  assert.deepEqual(live.blocks.map(block => block.contentIndex), [0, 1, 2]);
  assert.deepEqual(live.blocks[2], { type: 'toolCall', contentIndex: 2, id: 'c1', toolName: 'read', argsText: '{"path":"wrong', done: false });
  assert.deepEqual(live.usage, { output: 9 });
  update({ type: 'text_end', contentIndex: 1, content: '权威文字' });
  update({ type: 'thinking_end', contentIndex: 0, content: '权威思考' });
  update({ type: 'toolcall_end', contentIndex: 2, toolCall: { type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'right' } } });
  const ended = (await f.views.snapshot('s1')).inFlight.assistant.blocks;
  assert.deepEqual(ended.map(block => block.done), [true, true, true]);
  assert.deepEqual(ended.map(block => block.text ?? block.argsText), ['权威思考', '权威文字', '{"path":"right"}']);
  assert.deepEqual(ended[2].args, { path: 'right' });
  const final = { role: 'assistant', timestamp: 8, content: [
    { type: 'thinking', thinking: '最终思考' }, { type: 'text', text: '最终文字' },
    { type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'final' } },
  ], usage: { output: 10 } };
  f.driver.emit({ type: 'message_end', message: final });
  await f.views.flush();
  const snapshot = await f.views.snapshot('s1');
  assert.equal(snapshot.inFlight.assistant, undefined);
  assert.deepEqual(snapshot.inFlight.completed, [final]);
  assert.deepEqual(snapshot.unfinishedPartials, []);
  await f.views.ended('s1', 'r1');
  const interrupted = await f.views.snapshot('s1');
  assert.deepEqual(interrupted.unfinishedPartials[0].blocks.map(block => block.text ?? block.argsText), ['最终思考', '最终文字', '{"path":"final"}']);
  const rows = await f.partialRows();
  assert.ok(rows.some(row => row.blockType === 'toolCall' && row.toolCallId === 'c1' && row.toolName === 'read' && row.delta === ''));
  assert.ok(rows.some(row => row.replace && row.done && row.delta === '权威文字'));
  assert.ok(rows.some(row => row.replace && row.done && row.args?.path === 'final'));
  assert.ok(rows.some(row => row.ended && row.message.usage.output === 10));
  assert.equal(rows.some(row => row.closed), false);
});

test('会话视图：用户和工具消息不作为 assistant，队列、活动工具、重试和压缩维护中立状态', async t => {
  const f = await setup(t);
  await f.views.begin('s1', 'r1', f.driver);
  for (const role of ['user', 'toolResult']) {
    const value = message('非助手消息', 1, role);
    f.driver.emit({ type: 'message_start', message: value });
    assert.equal((await f.views.snapshot('s1')).inFlight.assistant, undefined);
    f.driver.emit({ type: 'message_end', message: value });
  }
  f.driver.emit({ type: 'queue_update', steering: ['s1', 's2'], followUp: ['f1'] });
  f.driver.emit({ type: 'queue_update', steering: ['s2'], followUp: [] });
  f.driver.emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'read', args: { path: 'a' } });
  f.driver.emit({ type: 'tool_execution_start', toolCallId: 't2', toolName: 'bash', args: { command: 'pwd' } });
  f.driver.emit({ type: 'tool_execution_update', toolCallId: 't1', toolName: 'read', args: { path: 'a' }, partialResult: { content: '旧结果' } });
  f.driver.emit({ type: 'tool_execution_update', toolCallId: 't1', toolName: 'read', args: { path: 'a' }, partialResult: { content: '最新结果' } });
  let state = (await f.views.snapshot('s1')).inFlight;
  assert.equal(state.phase, 'tools');
  assert.deepEqual(state.queue, { steering: ['s2'], followUp: [] });
  assert.equal(state.tools.length, 2);
  assert.equal(state.tools[0].toolCallId, 't1');
  assert.deepEqual(state.tools[0].args, { path: 'a' });
  assert.deepEqual(state.tools[0].partialResult, { content: '最新结果' });
  assert.equal(typeof state.tools[0].startedAt, 'number');
  state.queue.steering.push('不应写回'); state.tools[0].args.path = '不应写回';
  f.driver.emit({ type: 'tool_execution_end', toolCallId: 't1', toolName: 'read', result: {}, isError: false });
  assert.deepEqual((await f.views.snapshot('s1')).inFlight.tools.map(tool => tool.toolCallId), ['t2']);
  f.driver.emit({ type: 'tool_execution_end', toolCallId: 't2', toolName: 'bash', result: {}, isError: false });
  const retry = { attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: 'overloaded' };
  f.driver.emit({ type: 'auto_retry_start', ...retry });
  state = (await f.views.snapshot('s1')).inFlight;
  assert.equal(state.phase, 'retrying'); assert.deepEqual(state.retry, retry);
  f.driver.emit({ type: 'auto_retry_end', success: true, attempt: 2 });
  state = (await f.views.snapshot('s1')).inFlight;
  assert.equal(state.phase, 'streaming'); assert.equal(state.retry, undefined);
  f.driver.emit({ type: 'compaction_start', reason: 'manual' });
  assert.equal((await f.views.snapshot('s1')).inFlight.phase, 'compacting');
  f.driver.emit({ type: 'compaction_end', reason: 'manual', aborted: false, willRetry: true });
  assert.equal((await f.views.snapshot('s1')).inFlight.phase, 'retrying');
  f.driver.emit({ type: 'agent_settled', aborted: false });
  state = (await f.views.snapshot('s1')).inFlight;
  assert.equal(state.phase, 'idle'); assert.equal(state.assistant, undefined);
  assert.deepEqual(state.tools, []); assert.deepEqual(state.queue, { steering: [], followUp: [] });
  f.row.control_state = 'stopping';
  assert.equal((await f.views.snapshot('s1')).inFlight.phase, 'stopping');
  await f.views.ended('s1', 'r1', 'stopped');
  assert.deepEqual((await f.views.snapshot('s1')).inFlight, { phase: 'idle', tools: [], queue: { steering: [], followUp: [] } });
});

test('会话视图：SSE 使用完整 envelope 和 epoch:seq id，原始事件不改形且诊断不入流', async t => {
  const f = await setup(t);
  await f.views.begin('s1', 'r1', f.driver);
  const cut = (await f.views.snapshot('s1')).cursor;
  const { response } = stream(f.views, cut);
  const originals = [
    { type: 'agent_start' },
    { type: 'message_update', usage: { output: 1 }, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'wire' } },
    { type: 'queue_update', steering: ['s'], followUp: ['f'] },
    { type: 'extension_ui_request', id: 'ui1', method: 'notify', message: '提示', notifyType: 'info' },
    { type: 'bash_execution_update', id: 'bash1', delta: 'output' },
    { type: 'thinking_level_changed', level: 'high' },
  ];
  for (const event of originals) f.driver.emit(event);
  for (const type of ['usage_record', 'quota_exhausted', 'driver_diagnostic']) f.driver.emit({ type, diagnostic: '内部事件' });
  const values = response.values();
  assert.equal(values.length, originals.length);
  assert.deepEqual(values.map(value => value.event), originals);
  assert.deepEqual(values.map(value => value.cursor.seq), originals.map((_, i) => cut.seq + i + 1));
  assert.ok(values.every(value => value.sessionId === 's1' && value.type === undefined));
  const frames = response.chunks.join('').trimEnd().split('\n\n');
  frames.forEach((frame, i) => assert.equal(frame, `event: session\nid: daemon:r1:${cut.seq + i + 1}\ndata: ${JSON.stringify(values[i])}`));
  f.driver.fail = true;
  await f.views.settled('s1');
  const diagnostic = (await f.views.diagnostics('s1'))[0];
  assert.ok(diagnostic.diagnostics.some(issue => issue.kind === 'get_entries_fallback'));
  assert.deepEqual(response.values().slice(values.length).map(value => value.event.type), ['agora_status']);
  assert.deepEqual(response.values().at(-1).event, { type: 'agora_status', status: 'running', statusDetail: '模型生成中', phase: 'streaming', revision: 0 });
});

test('会话视图：entry_appended、compaction_end、turn_end 先发原始事件再刷新条目', async t => {
  const f = await setup(t);
  await f.views.begin('s1', 'r1', f.driver);
  let parentId = null;
  for (const type of ['entry_appended', 'compaction_end', 'turn_end']) {
    const cut = (await f.views.snapshot('s1')).cursor;
    const { response } = stream(f.views, cut);
    const appended = { type: 'custom', id: type, parentId, customType: '扩展' };
    f.driver.entries.push(appended); f.driver.leafId = appended.id;
    const raw = type === 'entry_appended' ? { type, entry: appended }
      : type === 'compaction_end' ? { type, reason: 'manual', result: { summary: '摘要' }, aborted: false, willRetry: false }
      : { type, message: message('结束'), toolResults: [] };
    f.driver.emit(raw);
    assert.deepEqual(response.values().map(value => value.event), [raw]);
    await f.views.flush();
    const values = response.values();
    assert.deepEqual(values.map(value => value.event.type), [type, 'agora_entries']);
    assert.deepEqual(values[1].event, { type: 'agora_entries', entries: [appended], leafId: appended.id });
    assert.deepEqual(values.map(value => value.cursor.seq), [cut.seq + 1, cut.seq + 2]);
    const snapshot = await f.views.snapshot('s1');
    assert.equal(snapshot.cursor.seq, values[1].cursor.seq);
    assert.equal(snapshot.leafId, appended.id);
    assert.deepEqual(snapshot.entries.at(-1), appended);
    assert.equal(f.driver.commands.filter(command => command === 'get_entries').length, 2 + ['entry_appended', 'compaction_end', 'turn_end'].indexOf(type));
    parentId = appended.id;
  }
});

test('会话视图：分支切换通知在线与断线客户端 resync，后继追加可连续回放', async t => {
  const a = entry('a', null), b = entry('b', 'a'), c = entry('c', 'a');
  const f = await setup(t, [a, b]);
  await f.views.begin('s1', 'r1', f.driver);
  const cut = (await f.views.snapshot('s1')).cursor;
  const { response } = stream(f.views, cut);
  f.driver.entries = [a, b, c]; f.driver.leafId = 'c';
  f.driver.emit({ type: 'entry_appended', entry: c });
  await f.views.flush();
  assert.deepEqual(response.values().map(value => value.event.type), ['entry_appended', 'resync']);
  assert.equal(response.writableEnded, true);
  assert.match(response.chunks.at(-1), /^event: resync\n/);
  const switched = await f.views.snapshot('s1');
  assert.equal(switched.cursor.epoch, cut.epoch);
  assert.deepEqual(switched.entries.map(value => value.id), ['a', 'c']);
  assert.deepEqual(stream(f.views, cut).response.values().map(value => value.event.type), ['resync']);
  const next = stream(f.views, switched.cursor);
  const d = entry('d', 'c');
  f.driver.entries.push(d); f.driver.leafId = 'd';
  f.driver.emit({ type: 'turn_end', message: d.message, toolResults: [] });
  await f.views.flush();
  assert.deepEqual(next.response.values().map(value => value.event.type), ['turn_end', 'agora_entries']);
  assert.equal(next.response.writableEnded, false);
});

test('会话视图：退出归档屏障期间标记 stopping，完成后恢复离线 idle', async t => {
  const f = await setup(t);
  await f.views.begin('s1', 'r1', f.driver);
  emitText(f.driver, '待退出', 2, false);
  const original = f.views.disk.bind(f.views);
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const barrier = new Promise(resolve => { release = resolve; });
  f.views.disk = async state => { entered(); await barrier; return original(state); };
  const ending = f.views.ended('s1', 'r1', 'stopped');
  await started;
  try { assert.equal((await f.views.snapshot('s1')).inFlight.phase, 'stopping'); }
  finally { release(); }
  await ending;
  assert.equal((await f.views.snapshot('s1')).inFlight.phase, 'idle');
});

test('会话视图：退出按运行和消息分组历史与当前片段，保留块终态且退出状态离线', async t => {
  const f = await setup(t);
  f.archivedPartials.push(
    { runId: 'older', t: '2026-11-08T00:00:00Z', messageSeq: 1, contentIndex: 0, blockType: 'text', delta: '旧' },
    { runId: 'older', t: '2026-11-08T00:00:01Z', messageSeq: 1, contentIndex: 0, blockType: 'text', delta: '运行' },
  );
  await f.views.begin('s1', 'r1', f.driver);
  emitText(f.driver, '第一条', 2);
  emitText(f.driver, '过时拼接', 3, false);
  f.driver.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: '第二条权威文字' } });
  f.driver.emit({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_start', contentIndex: 1, id: 'tool1', toolName: 'read' } });
  f.driver.emit({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 1, delta: '{"path":' } });
  f.driver.emit({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_end', contentIndex: 1,
    toolCall: { type: 'toolCall', id: 'tool1', name: 'read', arguments: { path: 'a' } } } });
  f.driver.emit({ type: 'tool_execution_start', toolCallId: 'tool1', toolName: 'read', args: { path: 'a' } });
  const cut = (await f.views.snapshot('s1')).cursor;
  const { response } = stream(f.views, cut);
  await f.views.ended('s1', 'r1', 'stopped');
  const snapshot = await f.views.snapshot('s1');
  assert.equal(snapshot.cursor.epoch, cut.epoch);
  assert.deepEqual(snapshot.inFlight, { phase: 'idle', tools: [], queue: { steering: [], followUp: [] } });
  assert.deepEqual(snapshot.unfinishedPartials.map(value => [value.runId, value.blocks[0].text]), [['older', '旧运行'], ['r1', '第一条'], ['r1', '第二条权威文字']]);
  assert.deepEqual(snapshot.unfinishedPartials[2].blocks[1], { type: 'toolCall', contentIndex: 1, id: 'tool1', toolName: 'read', argsText: '{"path":"a"}', args: { path: 'a' }, done: true });
  assert.equal(snapshot.unfinishedPartials[2].blocks[0].done, true);
  assert.ok(snapshot.unfinishedPartials.every(value => typeof value.at === 'string' && value.delta === undefined));
  assert.deepEqual(response.values().map(value => value.event.type), ['agora_run', 'agora_status']);
  assert.deepEqual(response.values()[0].event, { type: 'agora_run', runId: 'r1', phase: 'exited', reason: 'stopped' });
  assert.equal(response.values()[1].event.phase, 'idle');
  const rows = await f.partialRows();
  assert.ok(rows.some(row => row.done && row.replace && row.toolName === 'read' && row.args?.path === 'a'));
});

test('会话视图：停止未确认时继续接收迟到流，活跃助手与中断片段不重复显示', async t => {
  const f = await setup(t);
  await f.views.begin('s1', 'r1', f.driver);
  emitText(f.driver, '第一段', 2, false);
  const initial = await f.views.snapshot('s1');
  assert.equal(initial.inFlight.assistant.blocks[0].text, '第一段');
  assert.deepEqual(initial.unfinishedPartials, []);
  const { response } = stream(f.views, initial.cursor);
  for (const listener of [...f.driver.exits]) listener({ reason: '停止未确认', cleanupConfirmed: false });
  await f.views.flush();
  assert.equal(f.driver.events.size, 1);
  assert.equal(response.writableEnded, false);
  f.driver.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '第二段' } });
  await f.views.flush();
  const pending = await f.views.snapshot('s1');
  assert.equal(pending.inFlight.phase, 'stopping');
  assert.equal(pending.inFlight.assistant.blocks[0].text, '第一段第二段');
  assert.deepEqual(pending.unfinishedPartials, []);
  assert.ok(response.values().some(value => value.event.assistantMessageEvent?.delta === '第二段'));
  for (const listener of [...f.driver.exits]) listener({ reason: '确认退出', cleanupConfirmed: true });
  await f.views.flush();
  const exited = await f.views.snapshot('s1');
  assert.equal(exited.inFlight.assistant, undefined);
  assert.equal(exited.unfinishedPartials[0].blocks[0].text, '第一段第二段');
  assert.equal(f.driver.events.size, 0);
});

test('pi 条目刷新使用追加游标，游标失效只重新读取一次全量', async () => {
  const first = entry('first', null), second = entry('second', 'first');
  const commands = [];
  let result = await readPiEntries(async command => {
    commands.push(command);
    return { success: true, data: { entries: [second], leafId: 'second' } };
  }, [first]);
  assert.deepEqual(commands, [{ type: 'get_entries', since: 'first' }]);
  assert.deepEqual(result.entries, [first, second]);
  commands.length = 0;
  result = await readPiEntries(async command => {
    commands.push(command);
    return command.since ? { success: false } : { success: true, data: { entries: [second], leafId: 'second' } };
  }, [first]);
  assert.deepEqual(commands, [{ type: 'get_entries', since: 'first' }, { type: 'get_entries' }]);
  assert.deepEqual(result.entries, [second]);
});

test('会话视图：使用真实共享包执行严格类型检查', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  execFileSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'),
    '--build', path.join(root, 'packages/daemon'), '--pretty', 'false'], {
    cwd: root, timeout: 60_000, encoding: 'utf8', stdio: 'pipe',
  });
});
