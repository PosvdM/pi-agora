// agora P0 #9：node:sqlite 的 WAL 读写并发、事务、强杀后一致性和在线备份。
// 运行：node --test experiments/p0/g-store/sqlite.test.mjs
import assert from 'node:assert/strict';
import { chmodSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkDatabase } from './sqlite/check.mjs';
import { killAllTracked, makeTempDir, removeDir, signalGroup, sleep, spawnTracked } from './lib.mjs';

const here = (name) => fileURLToPath(new URL(`./sqlite/${name}`, import.meta.url));
const node = process.execPath;

function workdir(t) {
  const dir = makeTempDir('g-sqlite-');
  t.diagnostic(`fixture: ${dir}`);
  t.after(async () => {
    const killed = await killAllTracked();
    if (killed.length) t.diagnostic(`强制终止遗留子进程: ${killed.join(', ')}`);
    try { chmodSync(dir, 0o755); } catch { /* 已删除 */ }
    if (t.passed && !process.env.P0_KEEP) removeDir(dir);
  });
  return dir;
}

const files = (dir) => readdirSync(dir).sort();

function runToEnd(args) {
  const p = spawnTracked(node, args);
  return p.exit.then((exit) => ({ ...exit, lines: p.lines, stderr: p.stderr }));
}

test('node:sqlite 基本能力：版本、WAL、默认 synchronous、readOnly 拒绝写入', (t) => {
  const dir = workdir(t);
  const path = join(dir, 'a.db');
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; CREATE TABLE t (x); INSERT INTO t VALUES (1);');
  const info = {
    node: process.version,
    sqlite: db.prepare('SELECT sqlite_version() AS v').get().v,
    journalMode: db.prepare('PRAGMA journal_mode').get().journal_mode,
    synchronous: db.prepare('PRAGMA synchronous').get().synchronous,
    busyTimeout: db.prepare('PRAGMA busy_timeout').get().timeout,
  };
  const ro = new DatabaseSync(path, { readOnly: true });
  let writeError;
  try { ro.exec('INSERT INTO t VALUES (2)'); } catch (error) { writeError = `${error.code} errcode=${error.errcode} ${error.message}`; }
  ro.close();
  db.close();
  t.diagnostic(`环境: ${JSON.stringify(info)}`);
  t.diagnostic(`readOnly 写入: ${writeError}`);
  assert.equal(info.journalMode, 'wal');
  assert.match(writeError, /readonly/);
});

for (const variant of [
  { name: '读者 busy timeout 0，写者每 20 个事务 TRUNCATE 检查点', readerTimeout: 0, checkpoint: 20, rows: 5 },
  { name: '读者 busy timeout 0，无手动检查点（自动检查点）', readerTimeout: 0, checkpoint: 0, rows: 5 },
  { name: '读者 busy timeout 5000，写者每 20 个事务 TRUNCATE 检查点', readerTimeout: 5000, checkpoint: 20, rows: 5 },
]) {
  test(`WAL 并发：1 个写者 + 2 个 readOnly 读者，${variant.name}`, async (t) => {
    const dir = workdir(t);
    const path = join(dir, 'agora.db');
    const writer = spawnTracked(node, [here('writer.mjs'), path, '--rows', String(variant.rows), '--checkpoint', String(variant.checkpoint)]);
    await writer.waitLine((l) => l.startsWith('committed'));
    const durationMs = 3000;
    const readers = [1, 2].map(() => runToEnd([here('reader.mjs'), path, String(durationMs), String(variant.readerTimeout)]));
    const results = await Promise.all(readers);
    signalGroup(writer.child, 'SIGTERM');
    await writer.exit;
    const committed = writer.lines.filter((l) => l.startsWith('committed')).length;
    const summaries = results.map((r) => JSON.parse(r.lines.at(-1)));
    t.diagnostic(`写者提交事务数: ${committed}; 写者 stderr: ${JSON.stringify(writer.stderr.trim())}`);
    for (const s of summaries) t.diagnostic(`读者: ${JSON.stringify(s)}`);
    const final = checkDatabase(path, { rows: variant.rows });
    t.diagnostic(`结束后校验: ${JSON.stringify(final)}`);
    for (const s of summaries) {
      assert.equal(s.openError, null);
      assert.ok(s.reads > 100 && s.txReads > 100, '读者应完成大量读取');
      assert.deepEqual(s.violations, []);
      assert.deepEqual(s.errors, {});
    }
    assert.deepEqual(final.problems, []);
  });
}

test('daemon 未运行时 adapter 以 readOnly 打开（写者已干净关闭）', async (t) => {
  const dir = workdir(t);
  const path = join(dir, 'agora.db');
  const w = await runToEnd([here('writer.mjs'), path, '--max', '10']);
  assert.equal(w.code, 0, w.stderr);
  const afterClose = files(dir);
  const result = checkDatabase(path, { readOnly: true, rows: 1 });
  const afterReadOnly = files(dir);
  t.diagnostic(`写者关闭后目录: ${afterClose.join(', ')}`);
  t.diagnostic(`readOnly 打开读取后目录: ${afterReadOnly.join(', ')}`);
  t.diagnostic(`readOnly 校验: ${JSON.stringify(result)}`);
  assert.deepEqual(result.problems, []);

  // 目录不可写时（-wal/-shm 无法创建），记录 readOnly 打开的实际表现。
  const roDir = join(dir, 'ro');
  const w2 = await runToEnd([here('writer.mjs'), join(dir, 'ro.db'), '--max', '3']);
  assert.equal(w2.code, 0, w2.stderr);
  const { mkdirSync, renameSync } = await import('node:fs');
  mkdirSync(roDir);
  renameSync(join(dir, 'ro.db'), join(roDir, 'agora.db'));
  for (const f of files(dir).filter((f) => f.startsWith('ro.db-'))) renameSync(join(dir, f), join(roDir, f.replace('ro.db', 'agora.db')));
  chmodSync(roDir, 0o555);
  let roOutcome;
  try {
    const r = checkDatabase(join(roDir, 'agora.db'), { readOnly: true });
    roOutcome = `可读：${JSON.stringify(r)}`;
  } catch (error) {
    roOutcome = `打开或读取失败：${error.code} errcode=${error.errcode} ${error.message}`;
  }
  chmodSync(roDir, 0o755);
  t.diagnostic(`目录只读时（目录内文件: ${files(roDir).join(', ')}）: ${roOutcome}`);
});

test('强杀写者（SIGKILL）后数据一致：含事务进行中被杀、检查点进行中被杀', async (t) => {
  const dir = workdir(t);
  const iterations = Number(process.env.P0_CRASH_ITERATIONS ?? 24);
  const modes = [
    { rows: 1, checkpoint: 0 },
    { rows: 1, checkpoint: 5 },
    { rows: 20000, checkpoint: 0 }, // 单个事务约几十毫秒，强杀大概率落在事务中
    { rows: 20000, checkpoint: 1 }, // 每个事务后 TRUNCATE 检查点
  ];
  const stats = { midTx: 0, betweenTx: 0, beforeFirstBegin: 0, ackedLost: 0, uncommittedVisible: 0 };
  for (let i = 0; i < iterations; i++) {
    const mode = modes[i % modes.length];
    const path = join(dir, `crash-${i % modes.length}.db`); // 同一个库被多次强杀、反复恢复
    const p = spawnTracked(node, [here('writer.mjs'), path, '--rows', String(mode.rows), '--checkpoint', String(mode.checkpoint)]);
    await p.waitLine((l) => l.startsWith('ready'));
    await sleep(30 + Math.floor(Math.random() * 250));
    signalGroup(p.child, 'SIGKILL');
    const exit = await p.exit;
    assert.equal(exit.signal, 'SIGKILL');
    const begins = p.lines.filter((l) => l.startsWith('begin')).map((l) => Number(l.split(' ')[1]));
    const acked = p.lines.filter((l) => l.startsWith('committed')).map((l) => Number(l.split(' ')[1]));
    const lastBegin = begins.at(-1) ?? 0;
    const lastAcked = acked.at(-1) ?? Number(p.lines[0].split(' ')[2]);
    if (!begins.length) stats.beforeFirstBegin++;
    else if (lastBegin > lastAcked) stats.midTx++;
    else stats.betweenTx++;

    // 先模拟 daemon 未重启时 adapter 只读打开，再模拟 daemon 重启后以读写方式打开。
    const ro = checkDatabase(path, { readOnly: true, rows: mode.rows });
    const rw = checkDatabase(path, { rows: mode.rows });
    if (rw.maxTx < lastAcked) stats.ackedLost++;
    if (rw.maxTx > lastBegin) stats.uncommittedVisible++;
    const line = `#${i} rows=${mode.rows} ckpt=${mode.checkpoint} lastBegin=${lastBegin} lastAcked=${lastAcked} ` +
      `ro.maxTx=${ro.maxTx} rw.maxTx=${rw.maxTx} ro.problems=${ro.problems.length} rw.problems=${rw.problems.length}`;
    t.diagnostic(line);
    assert.deepEqual(ro.problems, [], line);
    assert.deepEqual(rw.problems, [], line);
    assert.equal(ro.maxTx, rw.maxTx, line);
    assert.ok(rw.maxTx >= lastAcked && rw.maxTx <= lastBegin, line);
  }
  t.diagnostic(`汇总: ${JSON.stringify(stats)}`);
  assert.ok(stats.midTx > 0, '至少一次强杀落在 BEGIN 与 COMMIT 之间');
});

// 独立连接的备份在源库被其他连接修改后会从头重新开始（SQLite 在线备份的规则），
// 所以这里只断言“完成的备份一定一致”，是否完成和重新开始的次数作为观察结果记录。
const BACKUP_TIMEOUT_MS = Number(process.env.P0_BACKUP_TIMEOUT_MS ?? 20_000);
for (const variant of [
  { name: '独立连接，另一进程每 2 ms 写一个事务，rate 100', mode: 'own', rate: 100, writerSleep: 2 },
  { name: '独立连接，另一进程每 50 ms 写一个事务，rate 100', mode: 'own', rate: 100, writerSleep: 50 },
  { name: '独立连接，另一进程不停顿连续写，rate 1000000（一步复制全部页）', mode: 'own', rate: 1_000_000, writerSleep: 0 },
  { name: '同一连接，备份期间本进程每 1 ms 写一个事务，rate 50', mode: 'same', rate: 50 },
]) {
  test(`backup() 在写入进行中：${variant.name}`, async (t) => {
    const dir = workdir(t);
    const src = join(dir, 'agora.db');
    const dest = join(dir, 'backup.db');
    const init = await runToEnd([here('writer.mjs'), src, '--max', '10', '--prefill', String(32 * 1024 * 1024)]);
    assert.equal(init.code, 0, init.stderr);
    let writer;
    if (variant.mode === 'own') {
      writer = spawnTracked(node, [here('writer.mjs'), src, '--sleep', String(variant.writerSleep)]);
      await writer.waitLine((l) => l.startsWith('committed'));
    }
    const backupProc = spawnTracked(node, [here('backup-run.mjs'), src, dest, String(variant.rate), variant.mode, '1']);
    const timer = setTimeout(() => signalGroup(backupProc.child, 'SIGTERM'), BACKUP_TIMEOUT_MS);
    await backupProc.exit;
    clearTimeout(timer);
    let committedDuring = null;
    if (writer) {
      signalGroup(writer.child, 'SIGTERM');
      await writer.exit;
      committedDuring = writer.lines.filter((l) => l.startsWith('committed')).length;
    }
    const summary = JSON.parse(backupProc.lines.at(-1));
    t.diagnostic(`backup: ${JSON.stringify(summary)}; 另一进程在此期间提交: ${committedDuring}`);
    if (summary.error === 'terminated before completion') {
      t.diagnostic(`观察结果：${BACKUP_TIMEOUT_MS} ms 内未完成，重新开始 ${summary.restarts ?? 0} 次`);
      assert.equal(variant.mode, 'own', '同一连接的备份应当完成');
      return;
    }
    assert.equal(summary.error, null);
    const before = files(dir).filter((f) => f.startsWith('backup'));
    const check = checkDatabase(dest, { readOnly: true });
    const after = files(dir).filter((f) => f.startsWith('backup'));
    t.diagnostic(`备份文件: 打开前 ${before.join(', ')}；readOnly 打开后 ${after.join(', ')}`);
    t.diagnostic(`备份校验: ${JSON.stringify(check)}`);
    assert.deepEqual(check.problems, []);
    assert.ok(existsSync(dest));
  });
}
