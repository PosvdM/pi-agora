import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store, openStore, consistentBackup, SCHEMA_VERSION, schemaMigrations } from '../packages/daemon/dist/store.js';

const homes = [];
after(async () => { for (const home of homes) await rm(home, { recursive: true, force: true }); });
async function directory(t) {
  const home = await mkdtemp(join(tmpdir(), 'agora-store-'));
  homes.push(home);
  return home;
}
function seedTask(store, legacy = false) {
  const at = new Date().toISOString();
  store.run("INSERT INTO principals(id,type,label,created_at) VALUES('main','agent:main','主会话',?)", at);
  store.run("INSERT INTO principals(id,type,label,created_at) VALUES('child','agent:child','子会话',?)", at);
  store.run("INSERT INTO agora_sessions(id,task_id,principal_id,session_file,profile,model,thinking,cwd,status,created_at) VALUES('session','task','child',?,'explore','test/model','high',?,'running',?)", join(store.home, 'session.jsonl'), store.home, at);
  store.run("INSERT INTO tasks(id,agora_session_id,convener_id,requested_by,title,prompt,model,thinking,profile,cwd,notify,status,created_at,updated_at) VALUES('task','session','main','main','标题','任务书','test/model','high','explore',?,'wake','running',?,?)", store.home, at, at);
  store.run(legacy
    ? "INSERT INTO task_generations(task_id,generation,status) VALUES('task',1,'running')"
    : "INSERT INTO task_generations(task_id,generation,status,agora_session_id) VALUES('task',1,'running','session')");
}

test('新库使用 WAL/FULL，schema 与后续领域字段完整，重复打开不重复迁移', async t => {
  const home = await directory(t);
  let store = await openStore(home);
  assert.equal(store.get('PRAGMA journal_mode').journal_mode, 'wal');
  assert.equal(store.get('PRAGMA synchronous').synchronous, 2);
  assert.equal(SCHEMA_VERSION, 3);
  assert.equal(store.get('SELECT version FROM schema_version').version, 3);
  assert.equal(store.get('PRAGMA foreign_keys').foreign_keys, 1);
  assert.ok(store.all('PRAGMA foreign_key_list(task_generations)').some(fk => fk.from === 'agora_session_id' && fk.table === 'agora_sessions'));
  assert.equal(store.all('PRAGMA table_info(task_generations)').find(column => column.name === 'agora_session_id').notnull, 0);
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

function addInheritedSessions(store) {
  for (const [generation, reason] of [[2, 'reopen'], [3, 'replace']]) {
    const sessionId = `session-${generation}`;
    const previous = store.task('task').agora_session_id;
    store.transaction(() => {
      store.run("INSERT INTO agora_sessions(id,task_id,principal_id,session_file,profile,model,thinking,cwd,status,created_at,inherits_from,inherit_reason) SELECT ?,task_id,?,?,profile,model,thinking,cwd,'running',created_at,?,? FROM agora_sessions WHERE id=?",
        sessionId, `child-${generation}`, join(store.home, `${sessionId}.jsonl`), previous, reason, previous);
      store.run('UPDATE tasks SET agora_session_id=?,generation=? WHERE id=?', sessionId, generation, 'task');
      store.run("INSERT INTO task_generations(task_id,generation,status,agora_session_id) VALUES('task',?,'running',?)", generation, sessionId);
    });
  }
  assert.equal(store.task('task').agora_session_id, 'session-3');
  assert.deepEqual(store.all("SELECT id,inherits_from,inherit_reason FROM agora_sessions WHERE task_id='task' ORDER BY id").map(row => ({ ...row })), [
    { id: 'session', inherits_from: null, inherit_reason: null },
    { id: 'session-2', inherits_from: 'session', inherit_reason: 'reopen' },
    { id: 'session-3', inherits_from: 'session-2', inherit_reason: 'replace' },
  ]);
  assert.deepEqual(store.all("SELECT agora_session_id FROM task_generations WHERE task_id='task' ORDER BY generation").map(row => row.agora_session_id), ['session', 'session-2', 'session-3']);
  assert.throws(() => store.run("INSERT INTO task_generations(task_id,generation,status,agora_session_id) VALUES('task',4,'running','missing')"), /FOREIGN KEY/);
  assert.throws(() => store.run("DELETE FROM agora_sessions WHERE id='session'"), /FOREIGN KEY/);
  assert.deepEqual(store.all('PRAGMA foreign_key_check'), []);
}

test('全新 v2 允许同任务 reopen/replace，会话继承与每代关联独立保留', async t => {
  const store = await openStore(await directory(t));
  t.after(() => store.close());
  seedTask(store);
  addInheritedSessions(store);
});

test('真实 v1 升级保留数据、外键和索引，回填每代会话且备份仍为 v1', async t => {
  const home = await directory(t);
  const old = new Store(new DatabaseSync(join(home, 'agora.db')), home);
  old.db.exec(schemaMigrations[0]);
  old.db.exec("CREATE TABLE schema_version(version INTEGER NOT NULL,migrated_at TEXT NOT NULL); INSERT INTO schema_version VALUES(1,'v1'); PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;");
  seedTask(old, true);
  old.run("INSERT INTO task_generations(task_id,generation,status,result_text,usage) VALUES('task',2,'completed','历史结果','{}')");
  old.run("INSERT INTO process_runs(id,agora_session_id,daemon_instance_id,state,started_at) VALUES('run','session','daemon','exited','time')");
  old.db.exec("CREATE INDEX session_status ON agora_sessions(status); CREATE TRIGGER session_audit AFTER UPDATE OF status ON agora_sessions BEGIN INSERT INTO retained VALUES(new.status); END; CREATE TABLE retained(value TEXT)");
  old.notice('main', 'migration', 'task:completed', { summary: '保留通知' });
  const tables = ['principals', 'agora_sessions', 'tasks', 'process_runs', 'outbox', 'settings'];
  const data = Object.fromEntries(tables.map(table => [table, old.all(`SELECT * FROM ${table}`)]));
  const generations = old.all('SELECT * FROM task_generations ORDER BY generation');
  old.close();
  const store = await openStore(home);
  t.after(() => store.close());
  assert.equal(store.get('SELECT version FROM schema_version').version, 3);
  for (const table of tables) assert.deepEqual(store.all(`SELECT ${Object.keys(data[table][0]).join(',')} FROM ${table}`), data[table], table);
  assert.deepEqual(store.all('SELECT * FROM task_generations ORDER BY generation'), generations.map(row => Object.assign(Object.create(null), row, { agora_session_id: 'session' })));
  for (const index of ['session_status', 'tasks_convener', 'runs_session', 'outbox_recipient']) assert.ok(store.get("SELECT name FROM sqlite_master WHERE type='index' AND name=?", index));
  assert.equal(store.get('PRAGMA foreign_keys').foreign_keys, 1);
  assert.equal(store.all('PRAGMA foreign_key_list(process_runs)')[0].table, 'agora_sessions');
  store.run("UPDATE agora_sessions SET status='completed' WHERE id='session'");
  assert.equal(store.get('SELECT value FROM retained').value, 'completed');
  store.run("DELETE FROM task_generations WHERE generation=2");
  addInheritedSessions(store);
  assert.throws(() => store.run("UPDATE agora_sessions SET principal_id='child' WHERE id='session-2'"), /UNIQUE/);
  assert.throws(() => store.run("UPDATE agora_sessions SET session_file=? WHERE id='session-2'", join(home, 'session.jsonl')), /UNIQUE/);
  const names = (await readdir(join(home, 'backups'))).filter(name => name.endsWith('.db'));
  assert.equal(names.length, 1);
  assert.match(names[0], /^agora-1-/);
  const copy = new DatabaseSync(join(home, 'backups', names[0]), { readOnly: true });
  try {
    assert.equal(copy.prepare('SELECT version FROM schema_version').get().version, 1);
    assert.equal(copy.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.deepEqual(copy.prepare('SELECT * FROM task_generations ORDER BY generation').all(), generations);
    for (const table of tables) assert.deepEqual(copy.prepare(`SELECT * FROM ${table}`).all(), data[table], table);
    assert.equal(copy.prepare('PRAGMA table_info(task_generations)').all().some(column => column.name === 'agora_session_id'), false);
    assert.ok(copy.prepare('PRAGMA index_list(agora_sessions)').all().some(index => index.unique && copy.prepare(`PRAGMA index_info(${index.name})`).all().some(column => column.name === 'task_id')));
  } finally { copy.close(); }
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
