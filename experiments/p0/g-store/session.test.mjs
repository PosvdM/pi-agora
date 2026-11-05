// agora P0 #10 + pane P0 #8：会话文件只读解析。
// 用 pi 1.5.0 + 假 provider 生成真实 v3 会话，按 pi 迁移逻辑反向构造 v2、v1，再做截断、空文件等变体。
// 每个变体：只读解析两次（结果相同、文件哈希/大小/mtime 不变）→ 复制一份让 pi 以 --session 打开，
// 用 RPC get_entries 取条目和 leafId → 与解析结果比较条目、叶子和活动分支。
// 运行：node --test experiments/p0/g-store/session.test.mjs
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { activeBranch, fingerprint, parseAndVerifyUnchanged, parseSessionFile } from './session/parser.mjs';
import { generateSession, genExtPath } from './session/generate.mjs';

let allPassed = true;
// 顶层 await：先生成会话，再按样本定义测试。
const gen = await generateSession();
const fixturesDir = join(gen.experiment.root, 'g-fixtures'); // 只读解析的样本
const piDir = join(gen.experiment.root, 'g-pi-copies');      // 交给 pi 打开的副本
mkdirSync(fixturesDir);
mkdirSync(piDir);
const source = join(fixturesDir, 'v3.jsonl');                // pi 生成的 v3 文件快照
let sourceLines;
let liveLeaf;                                                // 导航后 pi 内存中的 leafId
{
  // 导航回旧分支的叶子但不追加条目：pi 内存中的叶子与文件最后一个条目不同。
  const beforeNav = fingerprint(gen.sessionFile);
  const nav = await gen.rpc.command({ type: 'prompt', message: `/g-nav ${gen.oldBranchLeaf}` }, { timeoutMs: 20_000 });
  assert.equal(nav.success, true);
  const live = (await gen.rpc.command({ type: 'get_entries' })).data;
  liveLeaf = live.leafId;
  const afterNav = fingerprint(gen.sessionFile);
  gen.log.push(`navigate(no summary) 后 live leafId=${live.leafId}，文件最后一个条目=${live.entries.at(-1).id}，文件变化=${beforeNav.sha256 !== afterNav.sha256}`);
  await gen.rpc.stop();
  copyFileSync(gen.sessionFile, source);
  sourceLines = readFileSync(source, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

after(async () => {
  await gen.experiment.stop();
  if (allPassed && !process.env.P0_KEEP) await gen.experiment.cleanup();
  else console.log(`# 保留现场: ${gen.experiment.root}`);
});

// ---------- 样本构造 ----------

const jsonl = (entries) => entries.map((e) => `${JSON.stringify(e)}\n`).join('');

function write(name, content) {
  const path = join(fixturesDir, name);
  writeFileSync(path, content);
  return path;
}

/** v2：pi 的 v2→v3 迁移只把 message.role 从 hookMessage 改成 custom。追加一条 hookMessage 消息。 */
function buildV2() {
  const [header, ...entries] = structuredClone(sourceLines);
  header.version = 2;
  const hook = {
    type: 'message', id: 'aa000002', parentId: entries.at(-1).id, timestamp: new Date().toISOString(),
    message: { role: 'hookMessage', customType: 'legacy-hook', content: 'legacy hook message 旧扩展消息', display: true, timestamp: Date.now() },
  };
  return jsonl([header, ...entries, hook]);
}

/**
 * v1：线性条目、没有 id/parentId；compaction 用 firstKeptEntryIndex（包含 session 头在内的数组下标）。
 * 取 pi 文件中“旧分支”（含压缩）那条路径，去掉 label（它按 id 引用别的条目），再追加一条 hookMessage 消息。
 */
function buildV1({ explicitVersion = false } = {}) {
  const [header, ...entries] = structuredClone(sourceLines);
  const byId = new Map(entries.map((e) => [e.id, e]));
  const path = [];
  for (let cur = byId.get(gen.oldBranchLeaf); cur; cur = cur.parentId ? byId.get(cur.parentId) : undefined) path.unshift(cur);
  const kept = path.filter((e) => e.type !== 'label');
  const v1Header = { ...header };
  if (explicitVersion) v1Header.version = 1; else delete v1Header.version;
  const all = [v1Header, ...kept];
  for (const e of kept) {
    if (e.type === 'compaction') {
      e.firstKeptEntryIndex = all.findIndex((x) => x.id === e.firstKeptEntryId);
      assert.ok(e.firstKeptEntryIndex > 0, 'firstKeptEntryId 应在 v1 路径上');
      delete e.firstKeptEntryId;
    }
  }
  for (const e of kept) { delete e.id; delete e.parentId; }
  all.push({ type: 'message', timestamp: new Date().toISOString(), message: { role: 'hookMessage', customType: 'legacy-hook', content: 'v1 hook', display: true, timestamp: Date.now() } });
  return jsonl(all);
}

/** 模拟追加新条目时进程中途退出：已有内容完整，最后一行只写了一部分（切在多字节字符中间）。 */
function partialAppend(base, parentId) {
  const line = JSON.stringify({ type: 'message', id: 'bb000001', parentId, timestamp: new Date().toISOString(), message: { role: 'user', content: '写到一半的消息', timestamp: Date.now() } });
  const bytes = Buffer.from(line);
  const cut = bytes.indexOf(Buffer.from('一半')) + 1; // 落在“一”的 UTF-8 编码中间
  return Buffer.concat([Buffer.from(base), bytes.subarray(0, cut)]);
}

function variants() {
  const v3 = readFileSync(source, 'utf8');
  const lastId = sourceLines.at(-1).id;
  const v3Lines = v3.split('\n').filter(Boolean);
  const v1 = buildV1();
  const v1Last = v1.trimEnd().split('\n');
  return [
    { name: 'v3（pi 生成，含压缩、分支摘要、label、custom 等）', file: 'v3.jsonl', expect: 'ok' },
    { name: 'v3，最后一行没有换行符（内容完整）', file: write('v3-no-newline.jsonl', v3.slice(0, -1)), expect: 'ok' },
    { name: 'v3，追加中途截断（切在多字节字符中间）', file: write('v3-partial-append.jsonl', partialAppend(v3, lastId)), expect: 'ok' },
    { name: 'v3，最后一个条目被截去一半', file: write('v3-cut-last.jsonl', v3Lines.slice(0, -1).join('\n') + '\n' + v3Lines.at(-1).slice(0, 40)), expect: 'ok' },
    { name: 'v3，中间有一行损坏', file: write('v3-malformed-middle.jsonl', [...v3Lines.slice(0, 6), '{"type":"message","id":', ...v3Lines.slice(6)].join('\n') + '\n'), expect: 'ok' },
    { name: 'v3，只有 session 头', file: write('v3-header-only.jsonl', `${v3Lines[0]}\n`), expect: 'ok' },
    { name: 'v2（构造：version 2 + hookMessage）', file: write('v2.jsonl', buildV2()), expect: 'ok' },
    { name: 'v1（构造：无 version、线性、firstKeptEntryIndex、hookMessage）', file: write('v1.jsonl', v1), expect: 'ok' },
    { name: 'v1（构造：version 1）', file: write('v1-version1.jsonl', buildV1({ explicitVersion: true })), expect: 'ok' },
    { name: 'v1，最后一行被截断', file: write('v1-cut-last.jsonl', v1Last.slice(0, -1).join('\n') + '\n' + v1Last.at(-1).slice(0, 30)), expect: 'ok' },
    { name: '空文件（0 字节）', file: write('empty.jsonl', ''), expect: 'empty' },
    { name: '只有空行', file: write('blank.jsonl', '\n\n'), expect: 'invalid' },
    { name: '第一行不是 session 头', file: write('no-header.jsonl', v3Lines.slice(1).join('\n') + '\n'), expect: 'invalid' },
  ].map((v) => ({ ...v, file: v.file.includes('/') ? v.file : join(fixturesDir, v.file) }));
}

// ---------- 比较 ----------

/** v1 的 id 由 pi 随机生成，比较时把 id 换成条目在列表中的位置。 */
function normalizeIds(entries, leafId) {
  const pos = new Map(entries.map((e, i) => [e.id, `#${i}`]));
  const map = (id) => (id == null ? id : pos.get(id) ?? `?${id}`);
  return {
    entries: entries.map((e) => {
      const copy = { ...e, id: map(e.id), parentId: map(e.parentId) };
      if ('firstKeptEntryId' in e) copy.firstKeptEntryId = map(e.firstKeptEntryId);
      return copy;
    }),
    leafId: map(leafId),
  };
}

function classifyChange(before, after, beforeBytes, afterBytes) {
  if (!after) return '文件被删除';
  if (before.sha256 === after.sha256) return '未改动';
  if (afterBytes.length > beforeBytes.length && afterBytes.subarray(0, beforeBytes.length).equals(beforeBytes)) {
    return `在末尾追加 ${JSON.stringify(afterBytes.subarray(beforeBytes.length).toString('utf8').slice(0, 80))}`;
  }
  return `被重写（${before.size} → ${after.size} 字节）`;
}

const variantList = variants();
test('生成会话', (t) => {
  for (const line of gen.log) t.diagnostic(line);
  t.diagnostic(`样本 ${variantList.length} 个，目录 ${fixturesDir}`);
});

test('pi 进程内导航后的叶子与文件推导的叶子', async (t) => {
  const parsed = parseSessionFile(source);
  const copy = join(piDir, 'nav-check.jsonl');
  copyFileSync(source, copy);
  const rpc = await gen.experiment.start({ args: ['--session', copy] });
  const reopened = (await rpc.command({ type: 'get_entries' })).data;
  await rpc.stop();
  t.diagnostic(`导航后 pi 内存中的 leafId=${liveLeaf}；只读解析 leafId=${parsed.leafId}；pi 重新打开后 leafId=${reopened.leafId}`);
  assert.equal(parsed.leafId, reopened.leafId);
});

for (const v of variantList) {
  test(`只读解析：${v.name}`, async (t) => {
    t.diagnostic(`样本: ${v.name} (${v.file})`);
    try {
      // 1. 只读解析：两次结果相同，文件不变。
      const first = parseAndVerifyUnchanged(v.file);
      const second = parseSessionFile(v.file);
      assert.deepEqual(first.before, first.after, '解析前后文件指纹应相同');
      assert.deepEqual(second, first.parsed, '同一文件两次解析结果应相同');
      const p = first.parsed;
      t.diagnostic(`解析: status=${p.status} version=${p.version} entries=${p.entries.length} leaf=${p.leafId} branch=${p.branch.length} diagnostics=${JSON.stringify(p.diagnostics)}`);
      t.diagnostic(`解析前后 sha256=${first.before.sha256.slice(0, 16)}… 相同=${first.before.sha256 === first.after.sha256} mtime 相同=${first.before.mtimeMs === first.after.mtimeMs}`);
      assert.equal(p.status, v.expect);

      // 2. 交给 pi 打开副本。
      const copy = join(piDir, v.file.split('/').at(-1));
      copyFileSync(v.file, copy);
      const beforeBytes = readFileSync(copy);
      const beforePi = fingerprint(copy);
      let rpc;
      let startError = null;
      try {
        rpc = await gen.experiment.start({ args: ['--session', copy, '-e', genExtPath] });
      } catch (error) {
        startError = error.message.split('\n')[0].slice(0, 300);
      }
      if (startError) {
        const afterPi = fingerprint(copy);
        t.diagnostic(`pi 无法打开: ${startError}`);
        t.diagnostic(`pi 对副本的改动: ${classifyChange(beforePi, afterPi, beforeBytes, readFileSync(copy))}`);
        assert.equal(p.status, 'invalid', '只有解析器判为 invalid 的文件才应被 pi 拒绝');
        return;
      }
      const r = (await rpc.command({ type: 'get_entries' })).data;
      const state = (await rpc.command({ type: 'get_state' })).data;
      await rpc.stop();
      const afterPi = fingerprint(copy);
      t.diagnostic(`pi get_entries: entries=${r.entries.length} leafId=${r.leafId} sessionFile 相同=${state.sessionFile === copy}`);
      t.diagnostic(`pi 对副本的改动: ${classifyChange(beforePi, afterPi, beforeBytes, readFileSync(copy))}`);
      assert.notEqual(p.status, 'invalid', 'pi 能打开的文件不应被解析器判为 invalid');

      // 3. 比较条目、叶子、活动分支（投影②）。
      // pi 打开没有模型信息的会话时会先追加 model_change 等条目；这部分不在原文件里，
      // 只比较原文件对应的前缀，并另外解析 pi 退出后的副本与 get_entries 做完整比较。
      const appended = r.entries.length - p.entries.length;
      if (appended > 0) {
        t.diagnostic(`pi 打开时追加了 ${appended} 个条目: ${r.entries.slice(p.entries.length).map((e) => e.type).join(', ')}`);
      }
      assert.ok(appended >= 0, 'get_entries 不应少于文件中的条目');
      const rPrefix = r.entries.slice(0, p.entries.length);
      const rLeaf = appended > 0 ? (rPrefix.at(-1)?.id ?? null) : r.leafId;
      const piBranch = activeBranch(rPrefix, rLeaf);
      if (p.diagnostics?.migratedFrom === 1) {
        const a = normalizeIds(p.entries, p.leafId);
        const b = normalizeIds(rPrefix, rLeaf);
        assert.deepEqual(a.entries, b.entries, 'v1 条目（id 换成位置后）应一致');
        assert.equal(a.leafId, b.leafId);
        const pa = normalizeIds(p.branch, p.leafId).entries.map((e) => e.type + (e.message?.role ?? ''));
        const pb = normalizeIds(piBranch, rLeaf).entries.map((e) => e.type + (e.message?.role ?? ''));
        assert.deepEqual(pa, pb);
        const sameIds = p.entries.filter((e, i) => e.id === rPrefix[i]?.id).length;
        t.diagnostic(`v1：id 与 pi 迁移时生成的相同的条目 ${sameIds}/${p.entries.length}`);
      } else {
        assert.deepEqual(p.entries, rPrefix, '条目应与 get_entries 完全相同');
        assert.equal(p.leafId, rLeaf, 'leafId 应相同');
        assert.deepEqual(p.branch, piBranch, '活动分支应相同');
      }
      t.diagnostic(`原文件一致：条目 ${p.entries.length} 个，leaf ${p.leafId}，活动分支 ${p.branch.length} 个（${p.branch.map((e) => e.type === 'message' ? e.message.role : e.type).join(' → ')}）`);

      // 4. pi 退出后的副本（已被 pi 迁移、补换行或追加条目）与 get_entries 完全一致。
      const post = parseAndVerifyUnchanged(copy);
      assert.deepEqual(post.before, post.after);
      assert.deepEqual(post.parsed.entries, r.entries, 'pi 写回后的文件应与 get_entries 一致');
      assert.equal(post.parsed.leafId, r.leafId);
      assert.deepEqual(post.parsed.branch, activeBranch(r.entries, r.leafId));
      t.diagnostic(`pi 写回后的副本：version=${post.parsed.header?.version} 条目 ${post.parsed.entries.length} 个，leaf ${post.parsed.leafId}，与 get_entries 完全一致；diagnostics=${JSON.stringify(post.parsed.diagnostics)}`);
    } catch (error) {
      allPassed = false;
      throw error;
    }
  });
}
