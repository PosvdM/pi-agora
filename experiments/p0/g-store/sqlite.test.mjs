// agora P0 #9：node:sqlite 的 WAL 读写并发、事务、强杀后一致性和在线备份。
// 运行：node --test experiments/p0/g-store/sqlite.test.mjs
import assert from 'node:assert/strict';
import { chmodSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkDatabase } from './sqlite/check.mjs';
import { killAllTracked, makeTempDir, removeDir, signalGroup, spawnTracked, writeEvidence } from './lib.mjs';

const here = (name) => fileURLToPath(new URL(`./sqlite/${name}`, import.meta.url));
const node = process.execPath;

// 本文件的观察结果；默认写到每次运行新建的临时目录，P0_RECORD=1 时写入仓库的 evidence/。
const evidence = { node: process.version, platform: process.platform, startedAt: new Date().toISOString() };
after(() => { console.log(`# 证据: ${writeEvidence('sqlite', evidence)}`); });

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
  evidence.basics = { ...info, readOnlyWrite: writeError };
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
    (evidence.walConcurrency ??= []).push({ variant: variant.name, durationMs, committed, readers: summaries, final });
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
  evidence.readOnlyOffline = { afterClose, afterReadOnly, result, readOnlyDirectory: roOutcome };
});

// 随机时刻强杀：父进程等写者输出第 k 个事务的 begin 行（k 随机，条件等待），随即发 SIGKILL。
// begin 行在 BEGIN 之前输出、committed 行在 COMMIT 返回之后输出，所以“有 begin、没有 committed”
// 只能说明强杀落在“尚未收到提交确认”的窗口里，不能证明当时事务一定处于打开状态；
// 事务确实打开时的强杀由下一个测试用 barrier 确定性地覆盖。
test('随机时刻强杀写者（SIGKILL）后数据一致：小事务、大事务、启用检查点的压力场景', async (t) => {
  const dir = workdir(t);
  const iterations = Number(process.env.P0_CRASH_ITERATIONS ?? 24);
  const modes = [
    { rows: 1, checkpoint: 0, kMax: 3000 },
    { rows: 1, checkpoint: 5, kMax: 3000 },
    { rows: 20000, checkpoint: 0, kMax: 6 },
    { rows: 20000, checkpoint: 1, kMax: 6 }, // 每个事务后 TRUNCATE 检查点；检查点本身没有单独的边界记录
  ];
  const stats = { unackedWindow: 0, afterAck: 0, ackedLost: 0, beyondLastBegin: 0 };
  const runs = [];
  for (let i = 0; i < iterations; i++) {
    const mode = modes[i % modes.length];
    const path = join(dir, `crash-${i % modes.length}.db`); // 同一个库被多次强杀、反复恢复
    const p = spawnTracked(node, [here('writer.mjs'), path, '--rows', String(mode.rows), '--checkpoint', String(mode.checkpoint)]);
    const ready = await p.waitLine((l) => l.startsWith('ready'), 20_000);
    const startTx = Number(ready.split(' ')[2]);
    const k = 1 + Math.floor(Math.random() * mode.kMax);
    await p.waitLine((l) => l === `begin ${startTx + k}`, 30_000);
    signalGroup(p.child, 'SIGKILL');
    const exit = await p.exit;
    assert.equal(exit.signal, 'SIGKILL');
    const begins = p.lines.filter((l) => l.startsWith('begin')).map((l) => Number(l.split(' ')[1]));
    const acked = p.lines.filter((l) => l.startsWith('committed')).map((l) => Number(l.split(' ')[1]));
    const lastBegin = begins.at(-1);
    const lastAcked = acked.at(-1) ?? startTx;
    if (lastBegin > lastAcked) stats.unackedWindow++; else stats.afterAck++;

    // 先模拟 daemon 未重启时 adapter 只读打开，再模拟 daemon 重启后以读写方式打开。
    const ro = checkDatabase(path, { readOnly: true, rows: mode.rows });
    const rw = checkDatabase(path, { rows: mode.rows });
    if (rw.maxTx < lastAcked) stats.ackedLost++;
    if (rw.maxTx > lastBegin) stats.beyondLastBegin++;
    const line = `#${i} rows=${mode.rows} ckpt=${mode.checkpoint} k=${k} lastBegin=${lastBegin} lastAcked=${lastAcked} ` +
      `ro.maxTx=${ro.maxTx} rw.maxTx=${rw.maxTx} ro.problems=${ro.problems.length} rw.problems=${rw.problems.length}`;
    runs.push(line);
    t.diagnostic(line);
    assert.deepEqual(ro.problems, [], line);
    assert.deepEqual(rw.problems, [], line);
    assert.equal(ro.maxTx, rw.maxTx, line);
    assert.ok(rw.maxTx >= lastAcked && rw.maxTx <= lastBegin, line);
  }
  t.diagnostic(`汇总: ${JSON.stringify(stats)}`);
  evidence.randomKill = { iterations, stats, runs };
});

// 确定性用例：写者在事务内完成部分写入后输出 barrier 并保持事务打开，父进程收到 barrier 后才强杀。
for (const variant of [
  { name: '新库的第一个业务事务，写入 10 行 outbox、5 行 changes 后', prior: 0, holdRows: 10, args: [] },
  { name: '已提交 200 个事务（每 20 个 TRUNCATE 检查点）之后的事务', prior: 200, holdRows: 10, args: ['--checkpoint', '20'] },
  { name: '大事务、页缓存 50 页（未提交的页提前写进 WAL），写入 20000 行 outbox、10000 行 changes 后', prior: 3, holdRows: 20000, args: ['--cache-pages', '50'] },
]) {
  test(`事务打开时强杀（barrier）：${variant.name}`, async (t) => {
    const dir = workdir(t);
    const path = join(dir, 'agora.db');
    const p = spawnTracked(node, [here('writer.mjs'), path, '--hold-tx', String(variant.prior + 1), '--hold-rows', String(variant.holdRows), ...variant.args]);
    const barrier = await p.waitLine((l) => l.startsWith('barrier'), 30_000);
    const [, txArg, outRows, chgRows] = barrier.split(' ');
    const heldTx = Number(txArg);
    const walAtBarrier = existsSync(`${path}-wal`) ? statSync(`${path}-wal`).size : 0;
    signalGroup(p.child, 'SIGKILL');
    const exit = await p.exit;
    assert.equal(exit.signal, 'SIGKILL');
    const ro = checkDatabase(path, { readOnly: true, rows: 1 });
    const rw = checkDatabase(path, { rows: 1 });
    const record = { variant: variant.name, barrier, heldTx, walBytesAtBarrier: walAtBarrier, ro, rw };
    (evidence.barrierKill ??= []).push(record);
    t.diagnostic(`barrier: "${barrier}"（outbox ${outRows} 行、changes ${chgRows} 行未提交）；强杀前 WAL ${walAtBarrier} 字节`);
    t.diagnostic(`恢复后 readOnly: ${JSON.stringify(ro)}`);
    t.diagnostic(`恢复后读写: ${JSON.stringify(rw)}`);
    assert.deepEqual(ro.problems, []);
    assert.deepEqual(rw.problems, []);
    assert.equal(ro.maxTx, heldTx - 1, '打开中的事务不可见（readOnly）');
    assert.equal(rw.maxTx, heldTx - 1, '打开中的事务不可见（读写）');
    assert.equal(rw.revision, heldTx - 1, 'tasks 的更新同样回滚');
  });
}

// 备份策略：每个变体声明期望。
//   expect = 'complete'：必须在期限内完成，备份打开后校验通过；requireWritesDuring 时还要求备份期间确有写入，
//     防止退化成静态备份测试。
//   expect = 'observe'：用于观察另一连接频繁写入时的饥饿，允许超时，但超时时必须看到备份重新开始过。
// 独立连接的备份在源库被其他连接修改后会从头重新开始（SQLite 在线备份的规则）。
const BACKUP_TIMEOUT_MS = Number(process.env.P0_BACKUP_TIMEOUT_MS ?? 20_000);
for (const variant of [
  { name: '独立连接，另一进程每 2 ms 写一个事务，rate 100', mode: 'own', rate: 100, writerSleep: 2, expect: 'observe' },
  { name: '独立连接，另一进程每 50 ms 写一个事务，rate 100', mode: 'own', rate: 100, writerSleep: 50, expect: 'complete', requireWritesDuring: false },
  { name: '独立连接，另一进程不停顿连续写，rate 1000000（一步复制全部页）', mode: 'own', rate: 1_000_000, writerSleep: 0, expect: 'complete', requireWritesDuring: true },
  { name: '同一连接，备份期间本进程每 1 ms 写一个事务，rate 50', mode: 'same', rate: 50, expect: 'complete', requireWritesDuring: true },
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
    const summary = JSON.parse(backupProc.lines.at(-1));
    let writesDuring = summary.writesDuringBackup;
    if (writer) {
      signalGroup(writer.child, 'SIGTERM');
      await writer.exit;
      // 另一进程在 [startedAt, endedAt] 内确认的提交数（两边都是 Date.now()，毫秒精度）。
      writesDuring = writer.lines.filter((l) => l.startsWith('committed'))
        .map((l) => Number(l.split(' ')[2]))
        .filter((at) => at >= summary.startedAt && at <= summary.endedAt).length;
    }
    const timedOut = summary.error === 'terminated before completion';
    const record = { variant: variant.name, expect: variant.expect, summary, writesDuring, timedOut };
    (evidence.backup ??= []).push(record);
    t.diagnostic(`backup: ${JSON.stringify(summary)}；备份期间的写入: ${writesDuring}`);
    if (timedOut) {
      t.diagnostic(`${BACKUP_TIMEOUT_MS} ms 内未完成，重新开始 ${summary.restarts ?? 0} 次`);
      assert.equal(variant.expect, 'observe', `该策略必须完成：${variant.name}`);
      assert.ok((summary.restarts ?? 0) > 0, '超时时应观察到备份重新开始');
      return;
    }
    assert.equal(summary.error, null);
    if (variant.requireWritesDuring) assert.ok(writesDuring > 0, '备份期间应确有写入');
    const before = files(dir).filter((f) => f.startsWith('backup'));
    const check = checkDatabase(dest, { readOnly: true });
    const after = files(dir).filter((f) => f.startsWith('backup'));
    record.check = check;
    record.filesBeforeOpen = before;
    record.filesAfterReadOnlyOpen = after;
    t.diagnostic(`备份文件: 打开前 ${before.join(', ')}；readOnly 打开后 ${after.join(', ')}`);
    t.diagnostic(`备份校验: ${JSON.stringify(check)}`);
    assert.deepEqual(check.problems, []);
  });
}
