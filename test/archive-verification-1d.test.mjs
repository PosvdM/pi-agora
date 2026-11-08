import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { openStore } from '../packages/daemon/dist/store.js';
import { archiveSchemaV6 } from '../packages/daemon/dist/archive-schema.js';
import { ArchiveVerifier, archiveStorageBytes } from '../packages/daemon/dist/archive-verification.js';
import { observePiMessage } from '../packages/daemon/dist/harness/pi/archive-observation.js';

async function setup(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'agora-archive-verify-'));
  const store = await openStore(home);
  if (!store.all('PRAGMA table_info(agora_sessions)').some(column => column.name === 'archive_hash')) store.db.exec(archiveSchemaV6);
  t.after(async () => { store.close(); await rm(home, { recursive: true, force: true }); });
  const at = new Date().toISOString(), file = path.join(home, 'sessions', 'as_test', 'session.jsonl');
  await mkdir(path.dirname(file), { recursive: true });
  store.run("INSERT INTO principals(id,type,label,created_at) VALUES('main','agent:main','主会话',?),('child','agent:child','子会话',?)", at, at);
  store.run("INSERT INTO agora_sessions(id,task_id,principal_id,convener_id,session_file,profile,model,thinking,cwd,status,created_at) VALUES('as_test','tk_test','child','main',?,'explore','test/model','high',?,'completed',?)", file, home, at);
  store.run("INSERT INTO tasks(id,agora_session_id,convener_id,requested_by,title,prompt,model,thinking,profile,cwd,notify,status,created_at,updated_at) VALUES('tk_test','as_test','main','main','标题','任务','test/model','high','explore',?,'wake','completed',?,?)", home, at, at);
  store.run("INSERT INTO process_runs(id,agora_session_id,daemon_instance_id,state,started_at,exited_at) VALUES('pr_test','as_test','in_test','exited',?,?)", at, at);
  const verifier = new ArchiveVerifier(store);
  const header = { type: 'session', version: 3, id: 'pi_test', timestamp: at, cwd: home };
  const message = { role: 'assistant', content: [{ type: 'text', text: '归档测试' }], timestamp: 12345 };
  const entry = { type: 'message', id: 'first', parentId: null, timestamp: at, message };
  const content = [header, entry].map(value => JSON.stringify(value)).join('\n') + '\n';
  return { home, store, verifier, file, header, entry, message, content };
}
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

test('校验保留可信哈希、接受追加，文件内容和重复通知保持不变', async t => {
  const f = await setup(t);
  await writeFile(f.file, f.content);
  const observation = observePiMessage({ type: 'message_end', message: f.message });
  f.verifier.observe('as_test', 'pr_test', observation);
  f.verifier.observe('as_test', 'pr_test', observation);
  assert.equal(f.store.get('SELECT COUNT(*) AS count FROM archive_observed_messages').count, 1);
  let result = await f.verifier.verify('as_test');
  assert.equal(result.state, 'ok');
  assert.equal(result.hash, hash(Buffer.from(f.content)));
  const additional = { ...f.entry, id: 'second', parentId: 'first', message: { ...f.message, timestamp: 12346 } };
  await appendFile(f.file, JSON.stringify(additional) + '\n');
  result = await f.verifier.verify('as_test');
  assert.equal(result.state, 'ok');
  const baseline = f.store.session('as_test').archive_hash;
  await writeFile(f.file, (await readFile(f.file, 'utf8')).replace('归档测试', '改动测试'));
  const before = hash(await readFile(f.file));
  assert.equal((await f.verifier.verify('as_test')).state, 'suspect');
  assert.equal((await f.verifier.verify('as_test')).state, 'suspect');
  assert.equal(f.store.session('as_test').archive_hash, baseline);
  assert.equal(hash(await readFile(f.file)), before);
  assert.equal(f.store.all("SELECT recipient_id FROM outbox WHERE kind='archive:warning'").length, 2);
  assert.deepEqual(new Set(f.store.all('SELECT recipient_id FROM outbox').map(row => row.recipient_id)), new Set(['main', 'user']));
});

test('丢失文件通知召集人与用户，条数或最终消息证据不足均为可疑', async t => {
  const f = await setup(t);
  assert.equal((await f.verifier.verify('as_test')).state, 'missing');
  await writeFile(f.file, JSON.stringify(f.header) + '\n');
  f.verifier.observe('as_test', 'pr_test', observePiMessage({ type: 'message_end', message: f.message }));
  assert.equal((await f.verifier.verify('as_test')).state, 'suspect');
  await writeFile(f.file, [f.header, { ...f.entry, message: { ...f.message, timestamp: 999 } }].map(JSON.stringify).join('\n') + '\n');
  assert.equal((await f.verifier.verify('as_test')).state, 'suspect');
});

test('尾行截断和中间残留截断不改文件，也不会仅因截断判为可疑', async t => {
  const f = await setup(t);
  const bytes = f.content + '{"type":"message","id":"cut"\n' + JSON.stringify({ ...f.entry, id: 'third', parentId: 'first' }) + '\n{"type":"message"';
  await writeFile(f.file, bytes);
  const before = hash(await readFile(f.file));
  const result = await f.verifier.verify('as_test');
  assert.equal(result.state, 'partial');
  assert.ok(result.diagnostics.length >= 2);
  assert.equal(hash(await readFile(f.file)), before);
});

test('校验拒绝数据目录外路径，存档占用不跟随目录链接', async t => {
  const f = await setup(t), outside = await mkdtemp(path.join(tmpdir(), 'agora-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const external = path.join(outside, 'session.jsonl');
  await writeFile(external, f.content);
  f.store.run('UPDATE agora_sessions SET session_file=? WHERE id=?', external, 'as_test');
  await assert.rejects(f.verifier.verify('as_test'), error => error.code === 'archive_path_outside_home');
  await writeFile(f.file, f.content);
  await symlink(outside, path.join(f.home, 'sessions', 'external'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(await archiveStorageBytes(f.home), Buffer.byteLength(f.content));
});
