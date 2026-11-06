// Prepares an isolated fixture and prints the path of a launch script that start.sh execs into.
// Messages go to stderr; stdout carries only the launch script path.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createExperiment, providerPath } from '../../harness/index.mjs';
import { build, piInstall, fixtureEnv, here as hostkitDir } from '../prototype.mjs';
import { daemonExtensionSource } from '../test-cleanup.mjs';
import { files, statePath, readPointer, writeJsonAtomic, toolDir } from './lib.mjs';

const say = text => process.stderr.write(`${text}\n`);
const quote = s => `'${String(s).replaceAll("'", "'\\''")}'`;

if (process.platform !== 'darwin') { say('本工具只支持 macOS。'); process.exit(1); }
if (!process.stdin.isTTY || !process.stderr.isTTY) { say('请在终端窗口里直接运行 start.sh，不要重定向输入输出。'); process.exit(1); }
const previous = readPointer();
if (previous) {
  say(`上一次测试的现场还在：${previous.fixtureRoot}`);
  say(`请先运行清理，再重新开始：node ${quote(join(toolDir, 'cleanup.mjs'))}`);
  process.exit(1);
}

const pi = piInstall();
const e = await createExperiment({ script: { fallback: { segments: [{ type: 'text', text: 'fake-only' }] } } });
const f = files(e.root);
const terminal = Object.fromEntries(['TERM', 'COLORTERM', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'LC_TERMINAL', 'LC_TERMINAL_VERSION']
  .filter(k => process.env[k]).map(k => [k, process.env[k]]));
const macos = execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim();
const meta = {
  version: 1, fixtureRoot: e.root, addonPath: f.addon, preparedAt: new Date().toISOString(),
  terminal, macos, arch: process.arch, node: process.version, pi: pi.version,
};
// Write the pointer before building or launching anything so cleanup can always find the fixture.
writeJsonAtomic(statePath(), meta);
writeJsonAtomic(f.meta, meta);

mkdirSync(join(e.root, 'build'), { recursive: true });
build(join(e.root, 'build'));
const extDir = join(e.root, 'ext'); mkdirSync(extDir);
const daemonExt = join(extDir, 'daemon.ts');
writeFileSync(daemonExt, daemonExtensionSource({
  addonPath: f.addon, worker: join(hostkitDir, 'worker.mjs'), log: f.heartbeat, info: f.daemonInfo, oracle: f.cleanupOracle,
}));
const noticeExt = join(extDir, 'notice.ts');
writeFileSync(noticeExt, noticeSource(f));

const env = fixtureEnv(e, terminal);
const argv = [process.execPath, pi.cliEntry, '--offline', '-ne', '-ns', '-np', '--no-themes', '-na', '-e', providerPath, '-e', daemonExt, '-e', noticeExt];
const launch = join(e.root, 'launch.sh');
writeFileSync(launch, [
  '#!/bin/sh',
  `cd ${quote(e.cwd)} || exit 1`,
  `exec /usr/bin/env -i ${Object.entries(env).map(([k, v]) => quote(`${k}=${v}`)).join(' ')} ${argv.map(quote).join(' ')}`,
  '',
].join('\n'), { mode: 0o700 });

say('');
say('==================== pi-agora #15 关窗口测试 ====================');
say(`现场目录：${e.root}`);
say('马上会在这个窗口里打开 pi 界面（使用假模型，不联网）。');
say('等界面里出现「现在可以关闭这个窗口」后，直接关闭整个窗口。');
say('关闭时如果弹出「终止进程？」之类的确认框，请点「终止」。');
say('关闭前不要在 pi 里输入任何内容。');
say('=================================================================');
say('');
process.stdout.write(`${launch}\n`);

function noticeSource(f) {
  const c = JSON.stringify;
  return `import {appendFileSync, readFileSync, statSync, writeFileSync, renameSync} from 'node:fs';
import {createRequire} from 'node:module';
const native = createRequire(import.meta.url)(${c(f.addon)});
const me = () => JSON.parse(native.snapshot()).find(p => p.pid === process.pid);
const read = path => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return undefined; } };
const size = path => { try { return statSync(path).size; } catch { return undefined; } };
const save = value => { const tmp = ${c(f.ready)} + '.next'; writeFileSync(tmp, JSON.stringify(value, null, 2)); renameSync(tmp, ${c(f.ready)}); };
let started = false;
// Only displays progress and records identities; it does not handle SIGHUP or touch the daemon on exit.
export default function (pi) {
  pi.on('session_start', (_event, ctx) => {
    if (started) return;
    started = true;
    const terminalPi = me();
    appendFileSync(${c(f.terminalOracle)}, JSON.stringify(terminalPi) + '\\n');
    const show = (color, lines) => ctx.ui.setWidget('manual-close', lines.map(l => ctx.ui.theme ? ctx.ui.theme.fg(color, l) : l));
    show('warning', ['[关窗口测试] 正在启动 daemon，请稍候，先不要关闭窗口……']);
    const begin = Date.now();
    let firstSize;
    const timer = setInterval(() => {
      const info = read(${c(f.daemonInfo)});
      const current = size(${c(f.heartbeat)});
      if (info && current !== undefined) {
        if (firstSize === undefined) { firstSize = current; return; }
        if (current > firstSize) {
          clearInterval(timer);
          save({ version: 1, readyAt: new Date().toISOString(), terminalPi, daemon: info.daemon, child: info.child, childIsPiRpc: info.childIsPiRpc, heartbeatSizeAtReady: current });
          show('success', [
            '[关窗口测试] daemon 已就绪：daemon PID ' + info.daemon.pid + '，pi 子进程 PID ' + info.child.pid + '，心跳在增长。',
            '>>> 现在可以关闭这个窗口 <<<',
            '关闭整个窗口；如弹出「终止进程？」请点「终止」。然后打开新窗口运行检查命令。',
          ]);
          ctx.ui.notify('现在可以关闭这个窗口', 'info');
          return;
        }
      }
      if (Date.now() - begin > 60000) {
        clearInterval(timer);
        save({ version: 1, failedAt: new Date().toISOString(), terminalPi, daemon: info?.daemon, child: info?.child, error: 'daemon not ready within 60s' });
        show('error', ['[关窗口测试] 60 秒内 daemon 没有就绪。不要关窗口，请把这个窗口的截图发给姐姐。']);
      }
    }, 250);
  });
}
`;
}
