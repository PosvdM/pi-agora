import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { parseSessionFile } from '../packages/harness-pi/dist/index.js';

const root = await mkdtemp(join(tmpdir(), 'agora-parser-1d-'));
after(() => rm(root, { recursive: true, force: true }));
let sequence = 0;
const header = (version = 3) => ({ type: 'session', version, id: 'session-1', timestamp: '2026-11-08T00:00:00Z', cwd: '/project' });
const message = (id, parentId, role = 'user') => ({
  type: 'message', id, parentId, timestamp: '2026-11-08T00:00:01Z',
  message: { role, content: [{ type: 'text', text: '中文内容' }], timestamp: 1794096001000 },
});
const jsonl = (rows, newline = '\n') => rows.map((row) => JSON.stringify(row)).join(newline) + newline;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function fixture(content) {
  const file = join(root, `${++sequence}.jsonl`);
  await writeFile(file, content);
  return file;
}

async function parse(content) {
  return parseSessionFile(await fixture(content));
}

function normalizeIds(parsed) {
  const index = new Map(parsed.entries.map((entry, i) => [entry.id, i]));
  return {
    entries: parsed.entries.map((entry) => {
      const normalized = { ...entry, id: index.get(entry.id), parentId: entry.parentId === null ? null : index.get(entry.parentId) };
      if ('firstKeptEntryId' in entry) normalized.firstKeptEntryId = index.get(entry.firstKeptEntryId);
      return normalized;
    }),
    leafId: index.get(parsed.leafId),
  };
}

test('v3 保留原形、压缩前条目、废弃分支及未知条目类型', async () => {
  const entries = [
    message('root', null),
    message('abandoned', 'root', 'assistant'),
    { type: 'compaction', id: 'compacted', parentId: 'abandoned', firstKeptEntryId: 'abandoned', summary: '压缩摘要', tokensBefore: 123, extensionData: { untouched: true } },
    { type: 'branch_summary', id: 'branch', parentId: 'root', fromId: 'compacted', summary: '分支摘要' },
    { type: 'custom', id: 'custom', parentId: 'branch', data: { array: [1, null, { nested: '保留' }] } },
    { type: 'label', id: 'label', parentId: 'custom', targetId: 'abandoned', label: '旧分支' },
    { type: 'context_edit', id: 'edit', parentId: 'label', targetId: 'root', replacement: null },
    { type: 'usage', id: 'usage', parentId: 'edit', usage: { input: 0, output: 1 } },
    { type: 'future-entry', id: 'future', parentId: 'usage', fields: ['未知类型原样保留'] },
  ];
  const parsed = await parse(jsonl([header(), ...entries]));
  assert.equal(parsed.status, 'ok');
  assert.equal(parsed.version, 3);
  assert.equal(parsed.idsStable, true);
  assert.equal(parsed.leafId, 'future');
  assert.deepEqual(parsed.entries, entries);
  assert.deepEqual(parsed.header, header());
  assert.deepEqual(parsed.diagnostics, []);
});

test('叶子采用文件重开规则，取最后条目而非最后消息或推测的分支叶子', async () => {
  const rows = [header(), message('a', null), message('b', 'a'), message('c', 'a'),
    { type: 'label', id: 'last', parentId: 'b', targetId: 'c', label: '名称' },
    { type: 'session', id: 'ignored-extra-header', version: 3 }];
  const parsed = await parse(jsonl(rows));
  assert.equal(parsed.leafId, 'last');
  assert.deepEqual(parsed.entries.map((entry) => entry.id), ['a', 'b', 'c', 'last']);
});

test('v2 只迁移 hookMessage 角色，保留 ID、parentId 和扩展字段', async () => {
  const hook = message('hook', 'root', 'hookMessage');
  hook.message.customType = 'legacy';
  hook.message.display = true;
  const parsed = await parse(jsonl([header(2), message('root', null), hook]));
  assert.equal(parsed.version, 2);
  assert.equal(parsed.header.version, 3);
  assert.equal(parsed.idsStable, true);
  assert.equal(parsed.leafId, 'hook');
  assert.deepEqual(parsed.entries, [message('root', null), { ...hook, message: { ...hook.message, role: 'custom' } }]);
  const v3 = await parse(jsonl([header(), { ...hook, parentId: null }]));
  assert.equal(v3.entries[0].message.role, 'hookMessage');
});

for (const explicitVersion of [false, true]) {
  test(`v1 内存迁移及临时 ID：${explicitVersion ? '显式版本' : '省略版本'}`, async () => {
    const v1Header = header(1);
    if (!explicitVersion) delete v1Header.version;
    const first = { type: 'message', timestamp: 't1', message: { role: 'user', content: '旧消息' } };
    const kept = { type: 'message', timestamp: 't2', message: { role: 'assistant', content: '保留消息' } };
    const compaction = { type: 'compaction', firstKeptEntryIndex: 2, summary: '摘要', retained: { value: 1 } };
    const hook = { type: 'message', message: { role: 'hookMessage', customType: 'legacy', content: '扩展消息' } };
    const file = await fixture(jsonl([v1Header, first, kept, compaction, hook]));
    const before = await readFile(file);
    const parsed = await parseSessionFile(file);
    const again = await parseSessionFile(file);
    assert.equal(parsed.status, 'ok');
    assert.equal(parsed.version, 1);
    assert.equal(parsed.header.version, 3);
    assert.equal(parsed.idsStable, false);
    assert.equal(parsed.entries.length, 4);
    assert.equal(new Set(parsed.entries.map((entry) => entry.id)).size, 4);
    assert.equal(parsed.entries[0].parentId, null);
    for (let i = 1; i < parsed.entries.length; i++) assert.equal(parsed.entries[i].parentId, parsed.entries[i - 1].id);
    assert.equal(parsed.entries[2].firstKeptEntryId, parsed.entries[1].id);
    assert.equal('firstKeptEntryIndex' in parsed.entries[2], false);
    assert.deepEqual(parsed.entries[2].retained, { value: 1 });
    assert.equal(parsed.entries[3].message.role, 'custom');
    assert.equal(parsed.leafId, parsed.entries.at(-1).id);
    assert.notEqual(again.entries[0].id, parsed.entries[0].id);
    assert.deepEqual(normalizeIds(again), normalizeIds(parsed));
    assert.deepEqual(await readFile(file), before);
  });
}

test('v1 压缩索引按可解析条目计数，包含头部但不包含跳过的坏行', async () => {
  const content = [JSON.stringify(header(1)), '{"cut":', JSON.stringify({ type: 'custom', data: '目标' }),
    JSON.stringify({ type: 'compaction', firstKeptEntryIndex: 1, summary: '摘要' })].join('\n');
  const parsed = await parse(content);
  assert.equal(parsed.entries[1].firstKeptEntryId, parsed.entries[0].id);
  assert.deepEqual(parsed.diagnostics.map(({ line, kind }) => ({ line, kind })), [{ line: 2, kind: 'incomplete-json' }]);
});

test('完整尾行没有换行、CRLF 和空行均可读取', async () => {
  const rows = [header(), message('last', null)];
  for (const content of [jsonl(rows).slice(0, -1), jsonl(rows, '\r\n'), `\n  \n${jsonl(rows)}\n`]) {
    const parsed = await parse(content);
    assert.equal(parsed.status, 'ok');
    assert.equal(parsed.leafId, 'last');
    assert.deepEqual(parsed.entries, rows.slice(1));
    assert.deepEqual(parsed.diagnostics, []);
  }
});

test('中间补换行的截断残留和尾部截断均诊断为 incomplete-json，保留后续完整条目', async () => {
  const content = `${jsonl([header(), message('first', null)])}{"type":"message","id":\n${JSON.stringify(message('last', 'first'))}\n{"type":"message","id":"tail`;
  const parsed = await parse(content);
  assert.deepEqual(parsed.entries.map((entry) => entry.id), ['first', 'last']);
  assert.equal(parsed.leafId, 'last');
  assert.deepEqual(parsed.diagnostics.map(({ line, kind }) => ({ line, kind })), [
    { line: 3, kind: 'incomplete-json' }, { line: 5, kind: 'incomplete-json' },
  ]);
});

test('真正损坏的 JSON 不因位于尾部而被当作截断', async () => {
  const content = `${jsonl([header()])}{"x":!}\n${JSON.stringify(message('last', null))}\n{"x":1,}`;
  const parsed = await parse(content);
  assert.equal(parsed.leafId, 'last');
  assert.deepEqual(parsed.diagnostics.map(({ line, kind }) => ({ line, kind })), [
    { line: 2, kind: 'invalid-json' }, { line: 4, kind: 'invalid-json' },
  ]);
});

test('JSON 前缀分类涵盖字符串、转义、数字、字面值和容器', async (t) => {
  const incomplete = [
    '{', '{"', '{"a"', '{"a":', '{"a":"正文', '{"a":"\\', '{"a":"\\u12',
    '{"a":t', '{"a":tru', '{"a":fal', '{"a":nul', '{"a":-', '{"a":1.', '{"a":1e', '{"a":1e+',
    '{"a":[', '{"a":[1,', '{"a":{"b":true},', '{"a":0 ', '{"a":[]',
  ];
  const corrupt = [
    'garbage', '{"a":!}', '{"a":truth', '{"a":"\\q', '{"a":"\\uQ', '{"a":"控制\t',
    '{"a":01', '{"a":-.', '{"a":1.e', '{"a":1e+!', '{"a":1,}', '{"a":[1,]}',
    '{"a":{} ]', '{"a":true false', '{}{}', '{"a" "b"', '{"a":undefined',
  ];
  for (const [kind, cases] of [['incomplete-json', incomplete], ['invalid-json', corrupt]]) {
    for (const value of cases) {
      await t.test(`${kind}: ${JSON.stringify(value)}`, async () => {
        const parsed = await parse(jsonl([header()]) + value);
        assert.equal(parsed.diagnostics.length, 1);
        assert.equal(parsed.diagnostics[0].kind, kind);
        assert.equal(parsed.diagnostics[0].line, 2);
        assert.deepEqual(parsed.entries, []);
      });
    }
  }
});

test('截断落在 UTF-8 多字节字符中，哈希和字节数仍覆盖原始文件', async () => {
  const base = Buffer.from(jsonl([header(), message('first', null)]));
  const tail = Buffer.from('{"type":"message","id":"tail","parentId":"first","message":{"content":"截断字符"}}');
  const cut = tail.indexOf(Buffer.from('断')) + 1;
  const content = Buffer.concat([base, tail.subarray(0, cut)]);
  const parsed = await parse(content);
  assert.equal(parsed.entries.length, 1);
  assert.equal(parsed.diagnostics[0].kind, 'incomplete-json');
  assert.equal(parsed.hash, sha256(content));
  assert.equal(parsed.bytes, content.length);
});

test('二至四字节 UTF-8 字符的未完成前缀可位于尾部或补换行后的中间行', async () => {
  for (const character of ['é', '中', '😀']) {
    const encoded = Buffer.from(character);
    for (let cut = 1; cut < encoded.length; cut++) {
      for (const resumed of [false, true]) {
        const content = Buffer.concat([
          Buffer.from(jsonl([header()])), Buffer.from('{"type":"message","message":{"content":"'),
          encoded.subarray(0, cut), Buffer.from(resumed ? `\n${jsonl([message('last', null)])}` : ''),
        ]);
        const parsed = await parse(content);
        assert.equal(parsed.diagnostics[0].kind, 'incomplete-json');
        assert.equal(parsed.entries.length, resumed ? 1 : 0);
        assert.equal(parsed.hash, sha256(content));
      }
    }
  }
});

test('完整 JSON 中的无效 UTF-8 字节单独诊断，不静默替换为有效内容', async () => {
  const content = Buffer.concat([Buffer.from(jsonl([header()])), Buffer.from('{"type":"custom","id":"bad","parentId":null,"data":"'), Buffer.from([0xff]), Buffer.from('"}\n')]);
  const parsed = await parse(content);
  assert.equal(parsed.entries.length, 0);
  assert.equal(parsed.diagnostics[0].kind, 'invalid-encoding');
  assert.equal(parsed.hash, sha256(content));
});

test('无效 UTF-8 字节和不合法的码点前缀不能伪装成截断行', async () => {
  for (const invalid of [[0xff], [0x80], [0xe0, 0x80], [0xed, 0xa0], [0xf0, 0x80], [0xf4, 0x90], [0xf5]]) {
    const content = Buffer.concat([Buffer.from(jsonl([header()])), Buffer.from('{"content":"'), Buffer.from(invalid)]);
    const parsed = await parse(content);
    assert.equal(parsed.diagnostics[0].kind, 'invalid-encoding');
    assert.deepEqual(parsed.entries, []);
  }
});

test('读取不会修改内容、mtime 或大小，v3 多次读取结果相同', async () => {
  const content = jsonl([header(), message('last', null)]).slice(0, -1);
  const file = await fixture(content);
  const before = await stat(file);
  const parsed = await parseSessionFile(file);
  const again = await parseSessionFile(file);
  const after = await stat(file);
  assert.deepEqual(again, parsed);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(after.size, before.size);
  assert.equal((await readFile(file)).toString(), content);
  assert.equal(parsed.hash, sha256(Buffer.from(content)));
  assert.equal(parsed.bytes, Buffer.byteLength(content));
});

test('空文件、空白文件、头部单行及无效头部可区分', async () => {
  const empty = await parse('');
  assert.equal(empty.status, 'empty');
  assert.equal(empty.version, null);
  assert.equal(empty.hash, sha256(Buffer.alloc(0)));
  assert.equal(empty.bytes, 0);
  assert.deepEqual(empty.diagnostics, []);
  const blank = await parse('\n  \r\n');
  assert.equal(blank.status, 'invalid');
  assert.equal(blank.diagnostics[0].kind, 'invalid-header');
  const onlyHeader = await parse(jsonl([header()]));
  assert.equal(onlyHeader.status, 'ok');
  assert.equal(onlyHeader.leafId, null);
  assert.deepEqual(onlyHeader.entries, []);
  for (const first of [message('wrong', null), null, [], 1, { type: 'session', id: 123 }]) {
    const invalid = await parse(jsonl([first, header(), message('last', null)]));
    assert.equal(invalid.status, 'invalid');
    assert.equal(invalid.diagnostics[0].kind, 'invalid-header');
    assert.deepEqual(invalid.entries, []);
  }
});

test('头部之前的不可解析行跳过并诊断，与 pi 的头部发现规则一致', async () => {
  const parsed = await parse(`损坏行\n{"truncated":\n${jsonl([header(), message('last', null)])}`);
  assert.equal(parsed.status, 'ok');
  assert.equal(parsed.leafId, 'last');
  assert.deepEqual(parsed.diagnostics.map(({ line, kind }) => ({ line, kind })), [
    { line: 1, kind: 'invalid-json' }, { line: 2, kind: 'incomplete-json' },
  ]);
});

test('未知版本保守拒绝，不将未来格式当作 v3 处理', async () => {
  for (const version of [0, 4, '3', -1]) {
    const parsed = await parse(jsonl([header(version), message('last', null)]));
    assert.equal(parsed.status, 'invalid');
    assert.equal(parsed.diagnostics[0].kind, 'unsupported-version');
    assert.equal(parsed.header, null);
    assert.deepEqual(parsed.entries, []);
  }
});

test('基础字段无效的条目被诊断，其他完整条目保留', async () => {
  const parsed = await parse(jsonl([header(), null, [], { type: 'custom', parentId: null },
    { type: 'custom', id: 'bad-parent', parentId: 1 }, message('last', null)]));
  assert.deepEqual(parsed.entries, [message('last', null)]);
  assert.equal(parsed.leafId, 'last');
  assert.equal(parsed.diagnostics.length, 4);
  assert.ok(parsed.diagnostics.every((item) => item.kind === 'invalid-entry'));
});

test('缺文件保留 ENOENT，由上层决定 missing 状态', async () => {
  await assert.rejects(parseSessionFile(join(root, 'missing.jsonl')), { code: 'ENOENT' });
});

test('64 KiB 读取边界上的 UTF-8 字符保持完整', async () => {
  const h = jsonl([header()]);
  const start = '{"type":"custom","id":"boundary","parentId":null,"data":"';
  const padding = 'x'.repeat(65536 - Buffer.byteLength(h + start) - 1);
  const content = h + start + padding + '中文跨界"}\n';
  const parsed = await parse(content);
  assert.equal(parsed.entries[0].data, padding + '中文跨界');
  assert.deepEqual(parsed.diagnostics, []);
  assert.equal(parsed.hash, sha256(Buffer.from(content)));
});

test('大文件读取及迁移阶段让出事件循环，条目和哈希完整', async () => {
  const count = 12000;
  const rows = [header(1)];
  for (let i = 0; i < count; i++) rows.push({ type: 'custom', data: { index: i, text: '内容'.repeat(40) } });
  const content = jsonl(rows);
  const file = await fixture(content);
  let turns = 0;
  let active = true;
  const tick = () => { if (active) { turns++; setImmediate(tick); } };
  setImmediate(tick);
  let parsed;
  try {
    parsed = await parseSessionFile(file);
  } finally {
    active = false;
  }
  assert.ok(turns > 2, `读取期间事件循环只执行了 ${turns} 次`);
  assert.equal(parsed.entries.length, count);
  assert.equal(parsed.entries.at(-1).data.index, count - 1);
  assert.equal(parsed.leafId, parsed.entries.at(-1).id);
  assert.equal(parsed.hash, sha256(Buffer.from(content)));
  assert.equal(parsed.bytes, Buffer.byteLength(content));
});

test('单行跨多个读取块时保留完整内容', async () => {
  const entry = { type: 'custom', id: 'large', parentId: null, data: '大段内容'.repeat(180000) };
  const parsed = await parse(jsonl([header(), entry]));
  assert.deepEqual(parsed.entries, [entry]);
  assert.deepEqual(parsed.diagnostics, []);
});
