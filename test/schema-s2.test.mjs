import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openStore, SCHEMA_VERSION, schemaMigrations } from '../packages/daemon/dist/store.js';
import { openArchive } from '../packages/archive/dist/index.js';

async function fixture(t, version) {
  const home = await mkdtemp(join(tmpdir(), 'agora-schema-s2-'));
  const db = new DatabaseSync(join(home, 'agora.db'));
  t.after(async () => {
    db.close();
    await rm(home, { recursive: true, force: true });
  });
  for (const migration of schemaMigrations.slice(0, version)) db.exec(migration);
  db.exec(`CREATE TABLE schema_version(version INTEGER NOT NULL,migrated_at TEXT NOT NULL);
    INSERT INTO schema_version VALUES(${version},'legacy');
    PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
    INSERT INTO principals(id,type,created_at) VALUES('main','agent:main','time');
    INSERT INTO changes(epoch,object_type,object_id,created_at)
      SELECT value,'session','session','time' FROM settings WHERE key='epoch';
    INSERT INTO agora_sessions(id,principal_id,session_file,profile,model,thinking,cwd,status,created_at)
      VALUES('session','main','sessions/session.jsonl','explore','test/model','high','.','completed','time');
    INSERT INTO process_runs(id,agora_session_id,daemon_instance_id,state,started_at)
      VALUES('run','session','daemon','exited','time');`);
  if (version >= 6) db.exec(`UPDATE agora_sessions SET archive_hash='retained-hash',archive_bytes=42,
    archive_verified_at='verified',archive_error='retained-error';
    INSERT INTO archive_observed_messages(agora_session_id,run_id,signature,role,timestamp,observed_at)
      VALUES('session','run','signature','user','123','time');`);
  return { home, db };
}

function snapshot(db) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name<>'schema_version' ORDER BY name").all();
  return Object.fromEntries(tables.map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}"`).all()]));
}

async function backups(home) {
  return (await readdir(join(home, 'backups'))).filter(name => name.endsWith('.db'));
}

function assertIndex(db) {
  const indexes = db.prepare('PRAGMA index_list(changes)').all();
  assert.equal(indexes.filter(index => index.name === 'changes_object').length, 1);
  assert.equal(indexes.find(index => index.name === 'changes_object').unique, 0);
  assert.deepEqual(db.prepare('PRAGMA index_info(changes_object)').all().map(column => column.name),
    ['object_type', 'object_id', 'seq']);
}

test('v7 只追加 changes 三列索引，v6 保持在 v5 之后', () => {
  assert.equal(SCHEMA_VERSION, 7);
  assert.equal(schemaMigrations.length, 7);
  assert.match(schemaMigrations[4], /CREATE TABLE pending_confirmations/);
  assert.match(schemaMigrations[5], /CREATE TABLE archive_observed_messages/);
  assert.equal(schemaMigrations[6].trim(),
    'CREATE INDEX IF NOT EXISTS changes_object ON changes(object_type,object_id,seq);');
});

for (const existingIndex of [false, true]) {
  test(`v6→v7 保留数据和 WAL 备份，重开不重复迁移（已有索引：${existingIndex}）`, async t => {
    const { home, db } = await fixture(t, 6);
    if (existingIndex) db.exec('CREATE INDEX changes_object ON changes(object_type,object_id,seq)');
    const before = snapshot(db);
    const store = await openStore(home);
    try {
      assert.equal(store.get('SELECT version FROM schema_version').version, 7);
      assert.deepEqual(snapshot(store.db), before);
      assertIndex(store.db);
      assert.deepEqual(store.all('PRAGMA foreign_key_check'), []);
    } finally { store.close(); }
    const files = await backups(home);
    assert.equal(files.length, 1);
    assert.match(files[0], /^agora-6-/);
    const copy = new DatabaseSync(join(home, 'backups', files[0]), { readOnly: true });
    try {
      assert.equal(copy.prepare('SELECT version FROM schema_version').get().version, 6);
      assert.deepEqual(snapshot(copy), before);
      assert.equal(copy.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      assert.equal(copy.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='changes_object'").get().n,
        existingIndex ? 1 : 0);
    } finally { copy.close(); }
    const reopened = await openStore(home);
    try {
      assert.deepEqual(snapshot(reopened.db), before);
      assert.equal(reopened.get('SELECT COUNT(*) AS n FROM schema_version').n, 1);
      assertIndex(reopened.db);
    } finally { reopened.close(); }
    assert.deepEqual(await backups(home), files);
  });
}

test('v5 依次迁移 v6 和 v7，保留旧数据与 v5 备份', async t => {
  const { home, db } = await fixture(t, 5);
  const changes = db.prepare('SELECT * FROM changes').all();
  const store = await openStore(home);
  try {
    assert.equal(store.get('SELECT version FROM schema_version').version, 7);
    assert.deepEqual(store.all('SELECT * FROM changes'), changes);
    assert.equal(store.get("SELECT archive_bytes FROM agora_sessions WHERE id='session'").archive_bytes, 0);
    assert.deepEqual(store.all('SELECT * FROM archive_observed_messages'), []);
    assertIndex(store.db);
  } finally { store.close(); }
  const files = await backups(home);
  assert.equal(files.length, 1);
  const copy = new DatabaseSync(join(home, 'backups', files[0]), { readOnly: true });
  try {
    assert.equal(copy.prepare('SELECT version FROM schema_version').get().version, 5);
    assert.deepEqual(copy.prepare('SELECT * FROM changes').all(), changes);
    assert.equal(copy.prepare('PRAGMA table_info(agora_sessions)').all().some(column => column.name === 'archive_hash'), false);
  } finally { copy.close(); }
});

test('v7 索引 DDL 失败回滚 v5→v6→v7 整个事务', async t => {
  const { home, db } = await fixture(t, 5);
  db.exec("CREATE TABLE changes_object(sentinel TEXT); INSERT INTO changes_object VALUES('retained')");
  const before = snapshot(db);
  await assert.rejects(openStore(home), /already.*changes_object/i);
  assert.equal(db.prepare('SELECT version FROM schema_version').get().version, 5);
  assert.deepEqual(snapshot(db), before);
  assert.equal(db.prepare('PRAGMA table_info(agora_sessions)').all().some(column => column.name === 'archive_hash'), false);
  assert.equal((await backups(home)).length, 1);
});

test('archive 只读打开真实 v7 且不改库，拒绝未知更高版本', async t => {
  const home = await mkdtemp(join(tmpdir(), 'agora-archive-schema-s2-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const store = await openStore(home);
  store.close();
  const file = join(home, 'agora.db');
  const before = await readFile(file);
  const reader = await openArchive({ home, apiVersion: 1 });
  try {
    assert.equal(reader.schemaVersion, 7);
    assert.deepEqual((await reader.listSessions()).items, []);
    assert.throws(() => reader.db.exec('DELETE FROM schema_version'), /readonly|read.only/i);
  } finally { reader.close(); }
  assert.deepEqual(await readFile(file), before);
  assert.equal((await readdir(home)).includes('backups'), false);
  const db = new DatabaseSync(file);
  db.exec('UPDATE schema_version SET version=8');
  db.close();
  const future = await readFile(file);
  await assert.rejects(openArchive({ home, apiVersion: 1 }), { code: 'unsupported_schema' });
  assert.deepEqual(await readFile(file), future);
});
