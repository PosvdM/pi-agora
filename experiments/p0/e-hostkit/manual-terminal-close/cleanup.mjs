// Terminates this test's processes by PID + creation time and removes the fixture. Safe to repeat.
import { existsSync, rmSync } from 'node:fs';
import { FixtureCleanup } from '../test-cleanup.mjs';
import { files, readPointer, readJson, openNative, liveProcess, statePath } from './lib.mjs';

const say = text => process.stdout.write(`${text}\n`);
const pointer = readPointer();
if (!pointer) {
  say('没有需要清理的现场。');
  process.exit(0);
}
const root = pointer.fixtureRoot;
const f = files(root);
if (existsSync(root)) {
  const native = openNative(pointer);
  if (native) {
    // FixtureCleanup reads oracle.jsonl, cleanup-oracle.jsonl and daemon.json, adds their descendants,
    // SIGKILLs only matching PID + creation-time identities, and requires 250 ms of quiet before success.
    const cleanup = new FixtureCleanup(native, root);
    const ready = readJson(f.ready);
    for (const id of [ready?.terminalPi, ready?.daemon, ready?.child]) if (id) cleanup.remember(id);
    let report;
    try { report = await cleanup.run(); }
    catch (error) {
      say(`清理不完整，现场已保留：${root}`);
      say(error.message);
      process.exit(1);
    }
    const still = report.identities.filter(id => liveProcess(native, id));
    if (still.length) {
      say(`仍有进程存活，现场已保留：${root}`);
      say(JSON.stringify(still));
      process.exit(1);
    }
    say(`已按身份确认 ${report.identities.length} 个进程全部退出（${report.identities.map(id => id.pid).join(', ') || '无'}）。`);
  } else {
    say('现场没有原生模块，start.sh 没有执行到启动 pi 的步骤，没有需要终止的进程。');
  }
  rmSync(root, { recursive: true, force: true });
  say(`已删除现场：${root}`);
} else {
  say(`现场目录已不存在：${root}`);
}
rmSync(statePath(), { force: true });
say('清理完成。');
