import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openStore, consistentBackup, SCHEMA_VERSION } from '../packages/daemon/dist/store.js';

const homes = [];
after(async () => { for (const home of homes) await rm(home, { recursive: true, force: true }); });
async function directory(t) {
  const home = await mkdtemp(join(tmpdir(), 'agora-store-'));
  homes.push(home);
  return home;
}
function seedTask(store) {
  const at = new Date().toISOString();
  store.run("INSERT INTO principals(id,type,label,created_at) VALUES('main','agent:main','主会话',?)", at);
  store.run("INSERT INTO principals(id,type,label,created_at) VALUES('child','agent:child','子会话',?)", at);
  store.run("INSERT INTO agora_sessions(id,task_id,principal_id,session_file,profile,model,thinking,cwd,status,created_at) VALUES('session','task','child',?,'explore','test/model','high',?,'running',?)", join(store.home, 'session.jsonl'), store.home, at);
  store.run("INSERT INTO tasks(id,agora_session_id,convener_id,requested_by,title,prompt,model,thinking,profile,cwd,notify,status,created_at,updated_at) VALUES('task','session','main','main','标题','任务书','test/model','high','explore',?,'wake','running',?,?)", store.home, at, at);
  store.run("INSERT INTO task_generations(task_id,generation,status) VALUES('task',1,'running')");
}

test('新库使用 WAL/FULL，schema 与后续领域字段完整，重复打开不重复迁移', async t => {
  const home = await directory(t);
  let store = await openStore(home);
  assert.equal(store.get('PRAGMA journal_mode').journal_mode, 'wal');
  assert.equal(store.get('PRAGMA synchronous').synchronous, 2);
  assert.equal(store.get('SELECT version FROM schema_version').version, SCHEMA_VERSION);
  const columns = store.all('PRAGMA table_info(agora_sessions)');
  for (const name of ['kind', 'convener_id', 'parent_principal_id', 'meeting_id', 'inherits_from', 'inherit_reason', 'control_state', 'archive_state', 'ended_at']) assert.ok(columns.some(column => column.name === name), name);
  assert.equal(columns.find(column => column.name === 'task_id').notnull, 0);
  const epoch = store.get("SELECT value FROM settings WHERE key='epoch'").value;
  store.close();
  store = await openStore(home);
  assert.equal(store.get("SELECT value FROM settings WHERE key='epoch'").value, epoch);
  store.close();
  assert.ok(!(await readdir(home)).includes('backups'));
});

test('完成状态、代数结果、outbox 与 changes 同事务，通知失败全部回滚', async t => {
  const store = await openStore(await directory(t));
  t.after(() => store.close());
  seedTask(store);
  store.db.exec("CREATE TRIGGER reject_notice BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT,'通知写入失败'); END");
  const original = store.task('task');
  assert.throws(() => store.transition(original, 'completed', '结果', 'run', { tokens: 17 }), /通知写入失败/);
  assert.equal(store.task('task').status, 'running');
  assert.equal(store.task('task').revision, original.revision);
  assert.equal(store.get("SELECT result_text FROM task_generations WHERE task_id='task'").result_text, null);
  assert.equal(store.get("SELECT usage FROM task_generations WHERE task_id='task'").usage, null);
  assert.equal(store.get("SELECT status FROM agora_sessions WHERE id='session'").status, 'running');
  assert.equal(store.get('SELECT COUNT(*) AS n FROM changes').n, 0);
  store.db.exec('DROP TRIGGER reject_notice');
  const completed = store.transition(original, 'completed', '结果', 'run', { tokens: 17 });
  assert.equal(completed.revision, original.revision + 1);
  assert.equal(store.get('SELECT COUNT(*) AS n FROM outbox').n, 1);
  assert.equal(store.get("SELECT result_text FROM task_generations WHERE task_id='task'").result_text, '结果');
  assert.deepEqual(JSON.parse(store.get("SELECT usage FROM task_generations WHERE task_id='task'").usage), { tokens: 17 });
  assert.equal(store.get('SELECT epoch FROM changes').epoch, store.get("SELECT value FROM settings WHERE key='epoch'").value);
  assert.throws(() => store.transition(original, 'failed', '不能覆盖'), error => error.code === 'conflict');
  assert.equal(store.get('SELECT COUNT(*) AS n FROM outbox').n, 1);
});

test('通知去重、可见性超时、确认过滤与读取批量上限', async t => {
  const store = await openStore(await directory(t));
  t.after(() => store.close());
  store.notice('main', 'same', 'task:completed', { summary: '一' });
  store.notice('main', 'same', 'task:completed', { summary: '二' });
  store.notice('other', 'other', 'task:completed', {});
  const first = store.takeInbox('main');
  assert.equal(first.length, 1);
  assert.equal(JSON.parse(first[0].payload).summary, '一');
  assert.equal(store.takeInbox('main').length, 0);
  store.run('UPDATE outbox SET visible_after=0 WHERE id=?', first[0].id);
  assert.equal(store.takeInbox('main')[0].id, first[0].id);
  assert.equal(store.get('SELECT attempts FROM outbox WHERE id=?', first[0].id).attempts, 2);
  store.run('UPDATE outbox SET acked_at=? WHERE id=?', new Date().toISOString(), first[0].id);
  assert.equal(store.takeInbox('main').length, 0);
  store.transaction(() => { for (let i = 0; i < 205; i++) store.notice('batch', `batch:${i}`, '测试', {}); });
  assert.equal(store.takeInbox('batch').length, 200);
  assert.equal(store.takeInbox('batch').length, 5);
});

test('在线备份包含仍在 WAL 中的写入并通过 integrity_check', async t => {
  const home = await directory(t), store = await openStore(home);
  t.after(() => store.close());
  store.db.exec('PRAGMA wal_autocheckpoint=0');
  store.transaction(() => { for (let i = 0; i < 300; i++) store.notice('main', `wal:${i}`, '测试', { text: '通知内容'.repeat(30) }); });
  const destination = join(home, 'backups', '一致性.db');
  await consistentBackup(store.db, destination);
  const backup = new DatabaseSync(destination, { readOnly: true });
  try {
    assert.equal(backup.prepare('SELECT COUNT(*) AS n FROM outbox').get().n, 300);
    assert.equal(backup.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally { backup.close(); }
});

test('旧库升级先备份；迁移失败回滚原库且备份可读取', async t => {
  const home = await directory(t), file = join(home, 'agora.db');
  const old = new DatabaseSync(file);
  old.exec("PRAGMA journal_mode=WAL; CREATE TABLE schema_version(version INTEGER,migrated_at TEXT); INSERT INTO schema_version VALUES(0,'旧版本'); CREATE TABLE tasks(sentinel TEXT); INSERT INTO tasks VALUES('原数据');");
  old.close();
  await assert.rejects(openStore(home), /already exists/);
  const original = new DatabaseSync(file);
  try {
    assert.equal(original.prepare('SELECT version FROM schema_version').get().version, 0);
    assert.equal(original.prepare('SELECT sentinel FROM tasks').get().sentinel, '原数据');
    assert.equal(original.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='principals'").get().n, 0);
  } finally { original.close(); }
  const names = await readdir(join(home, 'backups'));
  assert.equal(names.filter(name => name.endsWith('.db')).length, 1);
  const copy = new DatabaseSync(join(home, 'backups', names.find(name => name.endsWith('.db'))), { readOnly: true });
  try { assert.equal(copy.prepare('SELECT sentinel FROM tasks').get().sentinel, '原数据'); }
  finally { copy.close(); }
});

test('可升级旧库保留原表、记录版本，未来 schema 拒绝且不改库', async t => {
  const home = await directory(t), file = join(home, 'agora.db');
  let old = new DatabaseSync(file);
  old.exec("CREATE TABLE retained(value TEXT); INSERT INTO retained VALUES('保留');");
  old.close();
  const store = await openStore(home);
  assert.equal(store.get('SELECT value FROM retained').value, '保留');
  store.run('UPDATE schema_version SET version=?', SCHEMA_VERSION + 1);
  store.close();
  await assert.rejects(openStore(home), /数据库版本不兼容/);
  old = new DatabaseSync(file);
  try { assert.equal(old.prepare('SELECT version FROM schema_version').get().version, SCHEMA_VERSION + 1); }
  finally { old.close(); }
});
