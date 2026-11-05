// 模拟 daemon 的唯一写者：每个事务同时更新 tasks、写 outbox 和 changes。
// 用法：node writer.mjs <db> [--rows K] [--checkpoint N] [--max T] [--prefill BYTES] [--sleep MS]
// BEGIN 前输出 "begin <tx>"，COMMIT 返回后输出 "committed <tx>"，都用同步写，
// 父进程据此判断强杀时是否处在事务中、哪些事务已确认提交。
import { writeSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const [dbPath, ...rest] = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = rest.indexOf(`--${name}`);
  return i === -1 ? fallback : Number(rest[i + 1]);
};
const rows = opt('rows', 1);
const checkpointEvery = opt('checkpoint', 0);
const maxTx = opt('max', Infinity);
const prefill = opt('prefill', 0);
const sleepMs = opt('sleep', 0);
const sleeper = new Int32Array(new SharedArrayBuffer(4));

const db = new DatabaseSync(dbPath, { timeout: 5000 });
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY, revision INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS outbox (
    id INTEGER PRIMARY KEY, tx INTEGER NOT NULL, recipient_id TEXT, dedupe_key TEXT UNIQUE NOT NULL,
    kind TEXT, payload TEXT, created_at TEXT);
  CREATE TABLE IF NOT EXISTS changes (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, tx INTEGER NOT NULL, epoch INTEGER, object_type TEXT,
    object_id TEXT, tombstone INTEGER, created_at TEXT);
  CREATE TABLE IF NOT EXISTS filler (id INTEGER PRIMARY KEY, blob BLOB);
  INSERT OR IGNORE INTO tasks (id, revision) VALUES (1, 0);
`);
if (prefill > 0) {
  const have = db.prepare('SELECT count(*) AS c FROM filler').get().c;
  if (have === 0) {
    const ins = db.prepare('INSERT INTO filler (blob) VALUES (?)');
    db.exec('BEGIN');
    for (let i = 0; i < prefill / 4096; i++) ins.run(Buffer.alloc(4000, i % 251));
    db.exec('COMMIT');
  }
}
const startTx = db.prepare('SELECT coalesce(max(tx), 0) AS m FROM outbox').get().m;
const bump = db.prepare('UPDATE tasks SET revision = revision + 1 WHERE id = 1');
const out = db.prepare('INSERT INTO outbox (tx, recipient_id, dedupe_key, kind, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)');
const chg = db.prepare('INSERT INTO changes (tx, epoch, object_type, object_id, tombstone, created_at) VALUES (?, 1, ?, ?, 0, ?)');
const payload = 'x'.repeat(200);

writeSync(1, `ready ${process.pid} ${startTx}\n`);
for (let tx = startTx + 1; tx <= startTx + maxTx; tx++) {
  const now = new Date().toISOString();
  writeSync(1, `begin ${tx}\n`);
  db.exec('BEGIN IMMEDIATE');
  bump.run();
  for (let r = 0; r < rows; r++) {
    out.run(tx, 'main', `tx-${tx}-${r}`, 'task_done', payload, now);
    chg.run(tx, 'task', `${tx}-${r}`, now);
  }
  db.exec('COMMIT');
  writeSync(1, `committed ${tx}\n`);
  if (checkpointEvery && tx % checkpointEvery === 0) db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  if (sleepMs) Atomics.wait(sleeper, 0, 0, sleepMs);
}
db.close();
writeSync(1, 'done\n');
