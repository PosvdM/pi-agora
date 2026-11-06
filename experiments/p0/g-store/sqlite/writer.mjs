// 模拟 daemon 的唯一写者：每个事务同时更新 tasks、写 outbox 和 changes。
// 用法：node writer.mjs <db> [--rows K] [--checkpoint N] [--max T] [--prefill BYTES] [--sleep MS]
//                          [--hold-tx T --hold-rows N] [--cache-pages P]
// BEGIN 之前输出 "begin <tx>"，COMMIT 返回之后输出 "committed <tx> <Date.now()>"，都用同步写。
// 两行之间的窗口包含 BEGIN 之前和 COMMIT 已返回、确认尚未输出的瞬间，所以只能说明“尚未收到提交确认”。
// --hold-tx T：本次运行的第 T 个事务在 BEGIN IMMEDIATE、更新 tasks、写入 N 行 outbox 和 N/2 行 changes
// 之后输出 "barrier <tx> <outboxRows> <changeRows>"，然后保持事务打开、永久阻塞，等父进程强杀。
// --cache-pages P：PRAGMA cache_size = P；页缓存很小时，大事务未提交的页会提前写进 WAL 文件。
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
const holdTx = opt('hold-tx', 0);
const holdRows = opt('hold-rows', 10);
const cachePages = opt('cache-pages', 0);
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
if (cachePages) db.exec(`PRAGMA cache_size = ${cachePages}`);
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
  if (holdTx && tx === startTx + holdTx) {
    const half = Math.floor(holdRows / 2);
    for (let r = 0; r < holdRows; r++) out.run(tx, 'main', `tx-${tx}-${r}`, 'task_done', payload, now);
    for (let r = 0; r < half; r++) chg.run(tx, 'task', `${tx}-${r}`, now);
    writeSync(1, `barrier ${tx} ${holdRows} ${half}\n`);
    Atomics.wait(sleeper, 0, 0); // 事务保持打开，直到进程被杀
  }
  for (let r = 0; r < rows; r++) {
    out.run(tx, 'main', `tx-${tx}-${r}`, 'task_done', payload, now);
    chg.run(tx, 'task', `${tx}-${r}`, now);
  }
  db.exec('COMMIT');
  writeSync(1, `committed ${tx} ${Date.now()}\n`);
  if (checkpointEvery && tx % checkpointEvery === 0) db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  if (sleepMs) Atomics.wait(sleeper, 0, 0, sleepMs);
}
db.close();
writeSync(1, 'done\n');
