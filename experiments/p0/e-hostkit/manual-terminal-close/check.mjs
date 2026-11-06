// Checks whether the daemon and its pi child survived closing the terminal window.
// Exit codes: 0 pass, 1 fail, 2 no usable fixture or daemon never became ready, 3 terminal-side pi still running.
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { delay } from '../prototype.mjs';
import { files, readPointer, readJson, openNative, liveProcess, fileSize, yesNo, recordsDir, evidencePath, statePath } from './lib.mjs';

const say = text => process.stdout.write(`${text}\n`);
const checkedAt = new Date();
say(`pi-agora #15 关窗口测试检查（${checkedAt.toISOString()}）`);

const pointer = readPointer();
if (!pointer) {
  say(`没有找到测试现场（${statePath()}）。请先运行 start.sh。`);
  say('daemon 存活：未知');
  process.exit(2);
}
const f = files(pointer.fixtureRoot);
const native = openNative(pointer);
const ready = readJson(f.ready);
const info = readJson(f.daemonInfo);
const terminalOracle = (() => { try { return JSON.parse(readFileSync(f.terminalOracle, 'utf8').split('\n')[0]); } catch { return undefined; } })();
const ids = { terminalPi: ready?.terminalPi ?? terminalOracle, daemon: ready?.daemon ?? info?.daemon, child: ready?.child ?? info?.child };

const result = {
  name: 'manual-terminal-close', checkedAt: checkedAt.toISOString(), fixture: pointer.fixtureRoot,
  preparedAt: pointer.preparedAt, readyAt: ready?.readyAt, terminal: pointer.terminal, macos: pointer.macos,
  arch: pointer.arch, node: pointer.node, pi: pointer.pi, identities: ids, childIsPiRpc: ready?.childIsPiRpc ?? info?.childIsPiRpc,
};
let verdict, exitCode;
if (!native || !ids.daemon || !ids.child) {
  say(`现场：${pointer.fixtureRoot}`);
  say(native ? 'daemon 没有记录身份，可能没有启动成功。' : '现场缺少原生模块，start.sh 可能没有执行完。');
  say('daemon 存活：未知');
  say('结论：无法判断——daemon 没有就绪。请把 start.sh 那个窗口的截图发给姐姐。');
  verdict = 'not-ready'; exitCode = 2;
  result.daemonAlive = null; result.childAlive = null;
} else {
  const terminalProc = liveProcess(native, ids.terminalPi);
  const size0 = fileSize(f.heartbeat);
  await delay(1500);
  const size1 = fileSize(f.heartbeat);
  const daemonProc = liveProcess(native, ids.daemon);
  const childProc = liveProcess(native, ids.child);
  const lastBeat = (() => {
    try { const lines = readFileSync(f.heartbeat, 'utf8').trimEnd().split('\n'); return Number(lines.at(-1).split(' ')[1]); } catch { return undefined; }
  })();
  const growing = size0 !== undefined && size1 !== undefined && size1 > size0;
  Object.assign(result, {
    terminalPiAlive: !!terminalProc, daemonAlive: !!daemonProc, childAlive: !!childProc,
    heartbeat: { sizeBefore: size0, sizeAfter: size1, windowMs: 1500, growing, lastBeatAgeMs: lastBeat ? Date.now() - lastBeat : null },
    daemonNow: daemonProc ?? null, childNow: childProc ?? null,
    childParentIsDaemon: childProc && daemonProc ? childProc.ppid === daemonProc.pid : null,
  });
  if (!ready) say('提示：界面里可能还没显示「现在可以关闭这个窗口」，下面按 daemon.json 的身份检查。');
  say(`终端程序：${pointer.terminal?.TERM_PROGRAM ?? '未知'} ${pointer.terminal?.TERM_PROGRAM_VERSION ?? ''}`.trimEnd());
  say(`终端侧 pi（PID ${ids.terminalPi?.pid ?? '?'}）已退出：${ids.terminalPi ? yesNo(!terminalProc) : '未知'}`);
  say(`daemon 存活：${yesNo(!!daemonProc)}（PID ${ids.daemon.pid}，创建时间 ${ids.daemon.startTime}${daemonProc ? `，当前父进程 ${daemonProc.ppid}` : ''}）`);
  say(`pi 子进程存活：${yesNo(!!childProc)}（PID ${ids.child.pid}，创建时间 ${ids.child.startTime}）`);
  say(`心跳增长：${yesNo(growing)}（1.5 秒内 ${size0 ?? '?'} → ${size1 ?? '?'} 字节${lastBeat ? `，最后一次心跳在 ${Date.now() - lastBeat} 毫秒前` : ''}）`);
  if (terminalProc) {
    verdict = 'terminal-still-running'; exitCode = 3;
    say(`结论：无效——终端侧 pi 仍在运行（PID ${terminalProc.pid}），窗口可能还没关闭。关闭那个窗口后再运行一次检查。`);
  } else if (daemonProc && childProc && growing) {
    verdict = 'pass'; exitCode = 0;
    say('结论：通过——关闭窗口后 daemon 和 pi 子进程都存活，心跳在增长。');
  } else {
    verdict = 'fail'; exitCode = 1;
    say('结论：不通过——关闭窗口后 daemon 或 pi 子进程已退出，或心跳停止。现场已保留，请先不要清理。');
  }
}
result.verdict = verdict;

const dir = recordsDir(); mkdirSync(dir, { recursive: true });
const recordFile = join(dir, `check-${checkedAt.toISOString().replaceAll(':', '-')}.json`);
appendFileSync(recordFile, `${JSON.stringify(result, null, 2)}\n`);
say(`记录：${recordFile}`);
if (process.env.P0_RECORD === '1') {
  appendFileSync(evidencePath, `${JSON.stringify(result)}\n`);
  say(`已追加到仓库证据：${evidencePath}`);
}
process.exit(exitCode);
