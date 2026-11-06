// Self-test for the manual tools without a graphical terminal. `script` provides a real PTY with an
// interactive zsh (job control on); the test types the start command, waits for the TUI notice,
// then closes the PTY master (SIGKILL to `script`), optionally after SIGHUP to pi's foreground group.
// On an unexpected result the fixture and its processes are kept and the run exits 1.
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { until, delay, snapshot, signalIdentity } from '../prototype.mjs';
import { providerPath } from '../../harness/index.mjs';
import { toolDir, files, readJson, openNative, liveProcess } from './lib.mjs';

const stateDir = mkdtempSync(join(tmpdir(), 'e-hostkit-manual-selftest-'));
const env = { ...process.env, MANUAL_CLOSE_STATE: join(stateDir, 'current.json'), MANUAL_CLOSE_RECORDS: join(stateDir, 'records'), TERM: 'xterm-256color', PS1: '$ ' };
for (const k of ['P0_RECORD', 'TERM_PROGRAM_VERSION', 'LC_TERMINAL', 'LC_TERMINAL_VERSION', 'COLORTERM']) delete env[k];
env.TERM_PROGRAM = 'selftest-script-pty';
const quote = s => `'${s.replaceAll("'", "'\\''")}'`;
const stripAnsi = s => s.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, '').replace(/\x1b[@-_]/g, '');
const run = (name, extra = {}) => {
  const r = spawnSync(process.execPath, [join(toolDir, name)], { env: { ...env, ...extra }, encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr };
};
const fail = message => { console.log(`SELFTEST FAIL: ${message}`); console.log(`state: ${env.MANUAL_CLOSE_STATE}`); process.exit(1); };
const expect = (cond, message) => { if (!cond) fail(message); };
const psLines = needles => execFileSync('ps', ['-axww', '-o', 'pid=,ppid=,pgid=,command='], { encoding: 'utf8' })
  .split('\n').filter(line => needles.some(n => line.includes(n)) && !line.includes('selftest.mjs') && !line.includes(' ps -axww'));

console.log(`state dir: ${stateDir}`);
const variants = [
  { name: 'sighup-then-close', hup: true, killChildAfter: false },
  { name: 'close-only', hup: false, killChildAfter: true },
];
for (const v of variants) {
  console.log(`\n=== ${v.name} ===`);
  // `script` accepts a pipe or tty on stdin but exits on sockets (Node 'pipe' stdio, macOS FIFOs),
  // so `cat` relays keystrokes into a real pipe.
  const term = spawn('/bin/sh', ['-c', 'cat | script -q /dev/null /bin/zsh -fi'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  term.on('error', () => {});
  let screen = '';
  term.stdout.on('data', c => { screen += c; });
  term.stderr.on('data', c => { screen += c; });
  await delay(500);
  term.stdin.write(`stty rows 40 cols 140; sh ${quote(join(toolDir, 'start.sh'))}\n`);
  const pointer = await until(() => readJson(env.MANUAL_CLOSE_STATE), 30000).catch(() => fail(`no pointer; screen:\n${stripAnsi(screen).slice(-2000)}`));
  const f = files(pointer.fixtureRoot);
  console.log(`fixture: ${pointer.fixtureRoot}`);
  const ready = await until(() => readJson(f.ready), 90000).catch(() => fail(`no ready state; screen:\n${stripAnsi(screen).slice(-2000)}`));
  expect(ready.readyAt, `daemon not ready: ${JSON.stringify(ready)}`);
  await until(() => stripAnsi(screen).includes('现在可以关闭这个窗口'), 10000).catch(() => fail(`TUI notice missing; screen:\n${stripAnsi(screen).slice(-2000)}`));
  writeFileSync(join(stateDir, `${v.name}-screen.txt`), stripAnsi(screen));
  console.log(`TUI shows: 现在可以关闭这个窗口 (screen text: ${join(stateDir, `${v.name}-screen.txt`)})`);
  const native = openNative(pointer);
  const table = snapshot(native);
  const scriptProc = table.find(p => p.ppid === term.pid && table.some(c => c.ppid === p.pid && c.pid === ready.terminalPi.ppid));
  const zsh = table.find(p => p.pid === ready.terminalPi.ppid);
  expect(scriptProc && zsh, 'could not identify script and zsh processes');
  const tpi = liveProcess(native, ready.terminalPi);
  expect(tpi, 'terminal pi not alive before close');
  console.log(`terminal pi pid=${tpi.pid} pgid=${tpi.pgid} ppid=${tpi.ppid} (zsh pid=${zsh?.pid} pgid=${zsh?.pgid}); daemon pid=${ready.daemon.pid} pgid=${ready.daemon.pgid}; child pid=${ready.child.pid}`);
  expect(zsh && tpi.ppid === zsh.pid && tpi.pgid !== zsh.pgid, 'pi is not a separate foreground job of the interactive zsh');
  expect(ready.daemon.pgid !== tpi.pgid, 'daemon shares the terminal pi process group');

  const before = run('check.mjs');
  console.log(`check before close: exit ${before.code}\n${before.out.trimEnd()}`);
  expect(before.code === 3 && before.out.includes('结论：无效'), 'check before close should report terminal still running');

  if (v.hup) expect(signalIdentity(native, tpi, 'SIGHUP', true), 'SIGHUP to terminal pi group failed');
  // Closing the PTY master is what a terminal does when its window closes.
  expect(signalIdentity(native, scriptProc, 'SIGKILL'), 'could not kill script');
  term.stdin.end();
  await until(() => !liveProcess(native, ready.terminalPi), 15000).catch(() => fail('terminal pi survived PTY close'));
  if (zsh) await until(() => !liveProcess(native, zsh), 5000).catch(() => fail('interactive zsh survived PTY close'));
  console.log('PTY closed; terminal pi and zsh are gone');
  await delay(300);

  const after = run('check.mjs');
  console.log(`check after close: exit ${after.code}\n${after.out.trimEnd()}`);
  expect(after.code === 0 && after.out.includes('daemon 存活：是') && after.out.includes('pi 子进程存活：是') && after.out.includes('心跳增长：是'), 'check after close should pass');

  if (v.killChildAfter) {
    expect(signalIdentity(native, ready.child, 'SIGKILL'), 'could not kill child for negative check');
    await until(() => !liveProcess(native, ready.child), 5000);
    const negative = run('check.mjs');
    console.log(`check after killing child: exit ${negative.code}\n${negative.out.trimEnd()}`);
    expect(negative.code === 1 && negative.out.includes('pi 子进程存活：否') && negative.out.includes('结论：不通过'), 'check should fail once child is gone');
  }

  const cleanup = run('cleanup.mjs');
  console.log(`cleanup: exit ${cleanup.code}\n${cleanup.out.trimEnd()}`);
  expect(cleanup.code === 0 && !existsSync(pointer.fixtureRoot) && !existsSync(env.MANUAL_CLOSE_STATE), 'cleanup did not remove fixture and pointer');
  const again = run('cleanup.mjs');
  console.log(`cleanup again: exit ${again.code} ${again.out.trim()}`);
  expect(again.code === 0 && again.out.includes('没有需要清理的现场'), 'second cleanup not idempotent');
  await until(() => term.exitCode !== null || term.signalCode !== null, 5000).catch(() => fail('relay shell did not exit'));
  const leftovers = [ready.terminalPi, ready.daemon, ready.child, zsh, scriptProc].filter(id => id && liveProcess(native, id));
  const ps = psLines([pointer.fixtureRoot, join(toolDir, '..', 'worker.mjs'), providerPath]);
  console.log(`identity leftovers: ${leftovers.length}; ps matches: ${ps.length}${ps.length ? `\n${ps.join('\n')}` : ''}`);
  expect(!leftovers.length && !ps.length, 'leftover processes after cleanup');
}
console.log('\nSELFTEST PASS');
