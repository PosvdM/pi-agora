// 模拟 archive adapter：以 readOnly 打开数据库，在写者运行期间反复读取并检查事务原子性。
// 用法：node reader.mjs <db> <durationMs> [busyTimeoutMs]
// 结束时向 stdout 输出一行 JSON 摘要。
import { writeSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const [dbPath, durationArg, timeoutArg] = process.argv.slice(2);
const duration = Number(durationArg);
const summary = { reads: 0, txReads: 0, violations: [], errors: {}, openError: null, maxTx: 0 };
let db;
try {
  db = new DatabaseSync(dbPath, { readOnly: true, timeout: Number(timeoutArg ?? 0) });
} catch (error) {
  summary.openError = `${error.code} ${error.errcode} ${error.message}`;
  writeSync(1, `${JSON.stringify(summary)}\n`);
  process.exit(0);
}
// 单条语句：一个快照内比较三个计数。
const one = db.prepare(`SELECT (SELECT count(*) FROM outbox) AS o, (SELECT count(*) FROM changes) AS c,
  (SELECT revision FROM tasks WHERE id = 1) AS r, (SELECT coalesce(max(tx), 0) FROM outbox) AS m`);
// 显式读事务：多条语句共享同一快照。
const cOut = db.prepare('SELECT count(*) AS n, coalesce(max(tx), 0) AS m FROM outbox');
const cChg = db.prepare('SELECT count(*) AS n, coalesce(max(tx), 0) AS m FROM changes');
const cRev = db.prepare('SELECT revision AS r FROM tasks WHERE id = 1');
const note = (error) => {
  const key = `${error.code ?? 'ERR'}:${error.errcode ?? ''}:${error.message}`;
  summary.errors[key] = (summary.errors[key] ?? 0) + 1;
};
const end = Date.now() + duration;
while (Date.now() < end) {
  try {
    const row = one.get();
    summary.reads++;
    summary.maxTx = Math.max(summary.maxTx, row.m);
    // 写者每个事务 tasks.revision +1，outbox 和 changes 各加 rows 行，比例固定。
    if (row.o !== row.c || (row.r > 0 && row.o % row.r !== 0)) summary.violations.push({ kind: 'single', ...row });
  } catch (error) { note(error); }
  try {
    db.exec('BEGIN');
    const o = cOut.get();
    const c = cChg.get();
    const r = cRev.get().r;
    db.exec('COMMIT');
    summary.txReads++;
    if (o.n !== c.n || o.m !== c.m || o.m !== r) summary.violations.push({ kind: 'tx', o, c, r });
  } catch (error) {
    note(error);
    try { db.exec('ROLLBACK'); } catch { /* 没有活动事务 */ }
  }
}
db.close();
summary.violations = summary.violations.slice(0, 5);
writeSync(1, `${JSON.stringify(summary)}\n`);
