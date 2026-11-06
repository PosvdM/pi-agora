// 用 node:sqlite 的 backup() 在线备份。
// 用法：node backup-run.mjs <src> <dest> <rate> <mode> [writeEveryMs]
//   mode = own：用独立连接备份，写入由另一个进程（writer.mjs）进行；
//   mode = same：备份和写入用同一个连接，写入由本进程的定时器在备份进行中执行（daemon 自己备份时的情形）。
// 输出一行 JSON 摘要。
import { writeSync } from 'node:fs';
import { backup, DatabaseSync } from 'node:sqlite';

const [src, dest, rateArg, mode, everyArg] = process.argv.slice(2);
const rate = Number(rateArg);
const db = new DatabaseSync(src, { timeout: 5000 });
const summary = { mode, rate, progressCalls: 0, writesDuringBackup: 0, pages: null, ms: 0, error: null };

let timer;
if (mode === 'same') {
  const bump = db.prepare('UPDATE tasks SET revision = revision + 1 WHERE id = 1');
  const out = db.prepare('INSERT INTO outbox (tx, recipient_id, dedupe_key, kind, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  const chg = db.prepare('INSERT INTO changes (tx, epoch, object_type, object_id, tombstone, created_at) VALUES (?, 1, ?, ?, 0, ?)');
  let tx = db.prepare('SELECT coalesce(max(tx), 0) AS m FROM outbox').get().m;
  timer = setInterval(() => {
    tx++;
    const now = new Date().toISOString();
    db.exec('BEGIN IMMEDIATE');
    bump.run();
    out.run(tx, 'main', `tx-${tx}-0`, 'task_done', 'same-conn', now);
    chg.run(tx, 'task', `${tx}-0`, now);
    db.exec('COMMIT');
    summary.writesDuringBackup++;
  }, Number(everyArg ?? 1));
}

const started = performance.now();
summary.startedAt = Date.now(); // 与 writer.mjs 的 committed 时间戳比较，统计备份期间另一进程的提交
// 父进程在超时后发 SIGTERM：输出当时的进度再退出，用来判断备份是否在反复重新开始。
process.once('SIGTERM', () => {
  summary.ms = Math.round(performance.now() - started);
  summary.endedAt = Date.now();
  summary.error = 'terminated before completion';
  summary.lastProgress = lastProgress;
  writeSync(1, `${JSON.stringify(summary)}\n`);
  process.exit(0);
});
let lastProgress = null;
let restarts = 0;
try {
  summary.pages = await backup(db, dest, {
    rate,
    progress: (p) => {
      summary.progressCalls++;
      // remainingPages 变大说明备份从头重新开始。
      if (lastProgress && p.remainingPages > lastProgress.remainingPages) summary.restarts = ++restarts;
      lastProgress = p;
    },
  });
} catch (error) {
  summary.error = `${error.code ?? ''} ${error.message}`;
}
summary.ms = Math.round(performance.now() - started);
summary.endedAt = Date.now();
clearInterval(timer);
db.close();
writeSync(1, `${JSON.stringify(summary)}\n`);
