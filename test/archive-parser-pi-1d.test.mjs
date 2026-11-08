import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { RpcSubprocessDriver } from '../packages/daemon/dist/driver.js';
import { parseSessionFile } from '../packages/harness-pi/dist/index.js';
import { containment, extensionPath, piFixture, providerPath, waitForEvent } from './fixtures/driver-helpers.mjs';

const stopOptions = { abortTimeoutMs: 150, graceMs: 150, termGraceMs: 150 };
const jsonl = values => values.map(value => JSON.stringify(value)).join('\n') + '\n';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function normalize(entries, leafId) {
  const positions = new Map(entries.map((entry, index) => [entry.id, `#${index}`]));
  const id = value => value == null ? value : positions.get(value) ?? value;
  return { entries: entries.map(entry => ({ ...entry, id: id(entry.id), parentId: id(entry.parentId), ...('firstKeptEntryId' in entry ? { firstKeptEntryId: id(entry.firstKeptEntryId) } : {}) })), leafId: id(leafId) };
}

test('真实 pi 1.5.0：v1/v2/v3 与截断文件的只读解析对齐重新打开语义', { timeout: 150_000 }, async t => {
  const f = await piFixture({ turns: [{ segments: [{ type: 'text', text: '真实会话解析测试' }] }] });
  const driver = new RpcSubprocessDriver({ home: path.join(f.root, 'agora'), piPath: f.install.packageDir, extensionPath, extraExtensions: [providerPath], containment, stopOptions });
  const handles = [];
  const base = { agoraSessionId: 'archive-parser', instanceId: 'archive-parser-test', cwd: f.cwd, model: 'p0-fake/scripted', thinking: 'off', profile: 'explore', env: f.env };
  t.after(async () => {
    try { for (const handle of handles) await handle.stop(stopOptions); }
    finally { await f.cleanup(); }
  });
  async function start(file, runId) {
    const handle = await driver.start({ ...base, runId, sessionFile: file });
    handles.push(handle);
    assert.equal((await handle.send({ type: 'get_state' })).success, true);
    handle.markReady();
    return handle;
  }
  const source = f.sessionPath('generated');
  const initial = await start(source, 'generate');
  const settled = waitForEvent(initial, event => event.type === 'agent_settled');
  await initial.send({ type: 'prompt', message: '生成用于只读对比的会话' });
  await settled;
  await initial.stop(stopOptions);
  const original = (await readFile(source, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(original[0].version, 3);
  const v3 = jsonl(original);
  const v2 = structuredClone(original);
  v2[0].version = 2;
  v2.push({ type: 'message', id: 'legacy-hook', parentId: v2.at(-1).id, timestamp: new Date().toISOString(), message: { role: 'hookMessage', customType: 'legacy', content: '旧格式扩展消息', display: true, timestamp: Date.now() } });
  const v1 = structuredClone(v2);
  delete v1[0].version;
  for (const entry of v1.slice(1)) { delete entry.id; delete entry.parentId; }
  const lastId = original.at(-1).id;
  const branch = [...original, { type: 'message', id: 'other-branch', parentId: original[1]?.id ?? null, timestamp: new Date().toISOString(), message: { role: 'user', content: '另一分支', timestamp: Date.now() } }];
  const variants = [
    ['v3', v3], ['v3-no-newline', v3.slice(0, -1)], ['v2', jsonl(v2)], ['v1', jsonl(v1)],
    ['v1-explicit', jsonl([{ ...v1[0], version: 1 }, ...v1.slice(1)])],
    ['middle-cut', jsonl(original.slice(0, 2)) + '{"type":"message","id":\n' + jsonl(original.slice(2))],
    ['tail-cut', v3 + `{"type":"message","id":"incomplete","parentId":"${lastId}"`],
    ['branch', jsonl(branch)],
  ];
  for (const [name, contents] of variants) await t.test(name, async () => {
    const file = f.sessionPath(name), copy = f.sessionPath(name + '-pi-copy');
    await writeFile(file, contents);
    const before = hash(await readFile(file));
    const parsed = await parseSessionFile(file);
    assert.equal(parsed.status, 'ok');
    assert.equal(hash(await readFile(file)), before);
    await copyFile(file, copy);
    const live = await start(copy, `open-${name}`);
    const response = await live.send({ type: 'get_entries' });
    assert.equal(response.success, true);
    const entries = response.data.entries.slice(0, parsed.entries.length);
    assert.equal(entries.length, parsed.entries.length);
    assert.deepEqual(normalize(parsed.entries, parsed.leafId), normalize(entries, entries.at(-1)?.id ?? null));
    await live.stop(stopOptions);
    assert.equal(hash(await readFile(file)), before);
  });
});
