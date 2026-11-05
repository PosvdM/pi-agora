// 打开数据库，执行 PRAGMA integrity_check 并检查 writer.mjs 的事务不变量。
import { DatabaseSync } from 'node:sqlite';

/**
 * 不变量：tasks.revision 等于已提交事务数；每个 tx 在 outbox 和 changes 里的行数相同且等于 rows；
 * tx 编号从 1 连续到 max(tx)。任何一项不成立说明有事务被部分写入或丢失。
 */
export function checkDatabase(path, { readOnly = false, rows } = {}) {
  const db = new DatabaseSync(path, { readOnly, timeout: 5000 });
  try {
    const integrity = db.prepare('PRAGMA integrity_check').all().map((row) => row.integrity_check);
    const journalMode = db.prepare('PRAGMA journal_mode').get().journal_mode;
    const revision = db.prepare('SELECT revision AS r FROM tasks WHERE id = 1').get()?.r ?? 0;
    const perTx = db.prepare(`
      SELECT o.tx AS tx, o.n AS outboxRows, coalesce(c.n, 0) AS changeRows FROM
        (SELECT tx, count(*) AS n FROM outbox GROUP BY tx) o
        LEFT JOIN (SELECT tx, count(*) AS n FROM changes GROUP BY tx) c ON c.tx = o.tx
      UNION ALL
      SELECT c.tx, 0, c.n FROM (SELECT tx, count(*) AS n FROM changes GROUP BY tx) c
        WHERE c.tx NOT IN (SELECT tx FROM outbox)
      ORDER BY tx`).all();
    const maxTx = perTx.length ? perTx[perTx.length - 1].tx : 0;
    const problems = [];
    if (integrity.length !== 1 || integrity[0] !== 'ok') problems.push(`integrity_check: ${integrity.join('; ')}`);
    if (revision !== maxTx) problems.push(`revision ${revision} != max(tx) ${maxTx}`);
    if (perTx.length !== maxTx) problems.push(`tx 不连续：${perTx.length} 个 tx，max ${maxTx}`);
    for (const row of perTx) {
      if (row.outboxRows !== row.changeRows || (rows !== undefined && row.outboxRows !== rows)) {
        problems.push(`tx ${row.tx}: outbox ${row.outboxRows} 行, changes ${row.changeRows} 行`);
        if (problems.length > 10) break;
      }
    }
    return { integrity, journalMode, revision, maxTx, problems };
  } finally {
    db.close();
  }
}
