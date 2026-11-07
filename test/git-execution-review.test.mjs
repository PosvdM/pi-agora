import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { gitExec, gitRead } from '../packages/protocol/dist/git.js';
import { fixture, quote } from './fixtures/git-security.mjs';

async function noExecution(f, action) {
  try { await action(); } catch { /* 被禁用的入口可以失败关闭。 */ }
  assert.deepEqual(await f.markers(), []);
}

test('Git 传输：SSH 环境、remote helper、ext、file、凭据及 askpass 的正负控', { timeout: 120_000 }, async t => {
  const f = await fixture(t), ssh = await f.program('ssh-probe', 'ssh-env');
  const oldPath = process.env.PATH; process.env.PATH = f.env.PATH;
  t.after(() => { process.env.PATH = oldPath; });
  for (const variable of ['GIT_SSH', 'GIT_SSH_COMMAND']) {
    const value = variable === 'GIT_SSH' ? ssh : quote(ssh);
    await f.positive('ssh-env', () => f.raw(['ls-remote', 'ssh://unreachable.invalid/repo'], undefined, { [variable]: value }));
    const previous = process.env[variable]; process.env[variable] = value;
    try { await noExecution(f, () => gitExec(f.cwd, ['ls-remote', 'ssh://unreachable.invalid/repo'])); }
    finally { if (previous === undefined) delete process.env[variable]; else process.env[variable] = previous; }
  }
  await f.program('git-remote-agoraprobe', 'helper');
  await f.positive('helper', () => f.raw(['ls-remote', 'agoraprobe::fixture']));
  await noExecution(f, () => gitExec(f.cwd, ['ls-remote', 'agoraprobe::fixture']));
  const ext = (await f.program('ext-probe', 'ext')).replaceAll('%', '%%').replaceAll(' ', '% ');
  await f.positive('ext', () => f.raw(['-c', 'protocol.ext.allow=always', 'ls-remote', `ext::${ext}`]));
  f.raw(['config', 'protocol.ext.allow', 'always']);
  await noExecution(f, () => gitExec(f.cwd, ['ls-remote', `ext::${ext}`]));
  const proxy = await f.program('proxy-probe', 'proxy');
  f.raw(['config', 'core.gitProxy', proxy]);
  await f.positive('proxy', () => f.raw(['ls-remote', 'git://unreachable.invalid/repo']));
  await noExecution(f, () => gitExec(f.cwd, ['ls-remote', 'git://unreachable.invalid/repo']));
  f.raw(['config', '--unset-all', 'core.gitProxy']);
  await f.positive('proxy', () => f.raw(['ls-remote', 'git://unreachable.invalid/repo'], undefined, { GIT_PROXY_COMMAND: proxy }));
  const previousProxy = process.env.GIT_PROXY_COMMAND; process.env.GIT_PROXY_COMMAND = proxy;
  try { await noExecution(f, () => gitExec(f.cwd, ['ls-remote', 'git://unreachable.invalid/repo'])); }
  finally { if (previousProxy === undefined) delete process.env.GIT_PROXY_COMMAND; else process.env.GIT_PROXY_COMMAND = previousProxy; }
  assert.match(f.raw(['ls-remote', f.cwd]), /HEAD/);
  await assert.rejects(gitExec(f.cwd, ['ls-remote', f.cwd]));
  f.raw(['config', 'credential.helper', `!${f.probe('credential')}`]);
  await f.positive('credential', () => f.raw(['credential', 'fill'], 'protocol=https\nhost=unreachable.invalid\n\n'));
  await noExecution(f, () => gitExec(f.cwd, ['ls-remote', 'https://unreachable.invalid/repo']));
  await gitRead(f.cwd, 'show', [], ['HEAD']); assert.deepEqual(await f.markers(), []);
  f.raw(['config', '--unset-all', 'credential.helper']);
  const askpass = await f.program('askpass-probe', 'askpass');
  for (const variable of ['core.askPass', 'GIT_ASKPASS', 'SSH_ASKPASS']) {
    const extra = variable === 'core.askPass' ? {} : { [variable]: askpass };
    if (variable === 'core.askPass') f.raw(['config', variable, askpass]);
    await f.positive('askpass', () => f.raw(['credential', 'fill'], 'protocol=https\nhost=unreachable.invalid\n\n', extra));
    const previous = process.env[variable];
    if (variable !== 'core.askPass') process.env[variable] = askpass;
    try { await noExecution(f, () => gitRead(f.cwd, 'show', [], ['HEAD'])); }
    finally {
      if (variable === 'core.askPass') f.raw(['config', '--unset-all', variable]);
      else if (previous === undefined) delete process.env[variable]; else process.env[variable] = previous;
    }
  }
});

test('Git 执行入口：editor、sequence、alias、merge、trailer、alternate refs 和 pack hook 在允许命令中不可达', { timeout: 120_000 }, async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.cwd, 'public/file.txt'), 'NEXT\n'); f.raw(['commit', '-am', 'next']);
  const editor = await f.program('editor-probe', 'editor');
  f.raw(['config', 'core.editor', editor]);
  await f.positive('editor', () => f.raw(['commit', '--allow-empty']));
  await assert.rejects(gitRead(f.cwd, 'commit'), /允许列表/);
  for (const variable of ['GIT_EDITOR', 'GIT_SEQUENCE_EDITOR']) {
    const args = variable === 'GIT_EDITOR' ? ['commit', '--allow-empty'] : ['rebase', '-i', 'HEAD~1'];
    await f.positive('editor', () => f.raw(args, undefined, { [variable]: editor }));
    const previous = process.env[variable]; process.env[variable] = editor;
    try { await gitRead(f.cwd, 'show', [], ['HEAD']); assert.deepEqual(await f.markers(), []); }
    finally { if (previous === undefined) delete process.env[variable]; else process.env[variable] = previous; }
  }
  await f.positive('default-key', () => f.raw(['-c', 'gpg.format=ssh', '-c', `gpg.ssh.defaultKeyCommand=${f.probe('default-key')}`, 'commit', '--allow-empty', '-S', '-m', 'signature']));
  await gitRead(f.cwd, 'show', [], ['HEAD']); assert.deepEqual(await f.markers(), []);
  f.raw(['config', 'sequence.editor', editor]);
  await f.positive('editor', () => f.raw(['rebase', '-i', 'HEAD~1']));
  await assert.rejects(gitRead(f.cwd, 'rebase'), /允许列表/);
  f.raw(['config', 'alias.agoraprobe', `!${f.probe('alias')}`]);
  await f.positive('alias', () => f.raw(['agoraprobe']));
  await assert.rejects(gitRead(f.cwd, 'agoraprobe'), /允许列表/);
  f.raw(['config', 'alias.log', `!${f.probe('alias')}`]);
  f.raw(['log', '-1']); await gitRead(f.cwd, 'log'); assert.deepEqual(await f.markers(), []);

  await writeFile(path.join(f.cwd, '.gitattributes'), '*.txt merge=trap\n'); f.raw(['add', '.']); f.raw(['commit', '-m', 'attributes']);
  f.raw(['branch', 'side']);
  await writeFile(path.join(f.cwd, 'public/file.txt'), 'MAIN\n'); f.raw(['commit', '-am', 'main']);
  f.raw(['checkout', 'side']); await writeFile(path.join(f.cwd, 'public/file.txt'), 'SIDE\n'); f.raw(['commit', '-am', 'side']); f.raw(['checkout', 'main']);
  f.raw(['config', 'merge.trap.driver', f.probe('merge')]);
  await f.positive('merge', () => f.raw(['merge', 'side']));
  await assert.rejects(gitRead(f.cwd, 'merge'), /允许列表/);
  await gitRead(f.cwd, 'status'); await gitRead(f.cwd, 'diff'); assert.deepEqual(await f.markers(), []);
  f.raw(['merge', '--abort']);

  f.raw(['config', 'trailer.probe.command', f.probe('trailer')]);
  await f.positive('trailer', () => f.raw(['interpret-trailers', '--trailer', 'probe=x'], 'message\n'));
  await assert.rejects(gitRead(f.cwd, 'interpret-trailers'), /允许列表/);
  const alternate = path.join(f.root, 'alternate'); await mkdir(alternate);
  f.raw(['init', '--bare', alternate]);
  await writeFile(path.join(f.cwd, '.git/objects/info/alternates'), `${alternate.replaceAll('\\', '/')}/objects\n`);
  f.raw(['config', 'core.alternateRefsCommand', f.probe('alternate')]);
  await f.positive('alternate', () => f.raw(['log', '--alternate-refs', '-1']));
  await assert.rejects(gitRead(f.cwd, 'log', ['--alternate-refs']), /选项/);
  await gitRead(f.cwd, 'log'); assert.deepEqual(await f.markers(), []);
  // packObjectsHook 只从受保护的配置来源读取；命令行配置作为正控。
  const want = `want ${f.raw(['rev-parse', 'HEAD']).trim()}\n`;
  const request = `${(Buffer.byteLength(want) + 4).toString(16).padStart(4, '0')}${want}00000009done\n`;
  await f.positive('pack-hook', () => f.raw(['-c', `uploadpack.packObjectsHook=${f.probe('pack-hook')}`, 'upload-pack', '--stateless-rpc', f.cwd], request));
  await assert.rejects(gitRead(f.cwd, 'upload-pack'), /允许列表/);
  await assert.rejects(gitRead(f.cwd, 'clone'), /允许列表/);
  await gitRead(f.cwd, 'show', [], ['HEAD']); assert.deepEqual(await f.markers(), []);
  const version = /git version (\d+)\.(\d+)/.exec(f.raw(['--version']));
  await t.test('gc.recentObjectsHook 功能正控', async sub => {
    if (Number(version[1]) === 2 && Number(version[2]) < 42) {
      sub.skip('Git <2.42 没有 gc.recentObjectsHook；gc/repack 拒绝断言仍执行。'); return;
    }
    f.raw(['hash-object', '-w', '--stdin'], 'unreachable\n');
    await f.positive('recent-hook', () => f.raw(['-c', `gc.recentObjectsHook=${f.probe('recent-hook')}`, 'repack', '-ad', '--cruft', '--cruft-expiration=now']));
  });
  for (const command of ['gc', 'repack', 'maintenance', 'difftool', 'mergetool', 'add', 'help', 'web--browse', 'gui', 'instaweb', 'send-email', 'imap-send', 'archive']) {
    await assert.rejects(gitRead(f.cwd, command), /允许列表/);
  }
  await gitRead(f.cwd, 'log'); assert.deepEqual(await f.markers(), []);
});

test('Git 外部 diff 环境：普通 Git 执行 GIT_EXTERNAL_DIFF，加固层移除注入', { timeout: 60_000 }, async t => {
  const f = await fixture(t); await writeFile(path.join(f.cwd, 'public/file.txt'), 'CHANGED\n');
  await writeFile(path.join(f.cwd, '.gitattributes'), '*.txt diff=trap\n');
  f.raw(['config', 'diff.trap.command', f.probe('driver-command')]);
  await f.positive('driver-command', () => f.raw(['diff', '--ext-diff']));
  assert.match(await gitRead(f.cwd, 'diff'), /CHANGED/); assert.deepEqual(await f.markers(), []);
  f.raw(['config', '--unset-all', 'diff.trap.command']);
  await f.positive('external-env', () => f.raw(['diff'], undefined, { GIT_EXTERNAL_DIFF: f.probe('external-env') }));
  const previous = process.env.GIT_EXTERNAL_DIFF; process.env.GIT_EXTERNAL_DIFF = f.probe('external-env');
  try { assert.match(await gitRead(f.cwd, 'diff'), /CHANGED/); assert.deepEqual(await f.markers(), []); }
  finally { if (previous === undefined) delete process.env.GIT_EXTERNAL_DIFF; else process.env.GIT_EXTERNAL_DIFF = previous; }
});

test('Git 辅助程序：difftool、browser、archive 和 IMAP 命令的真实正控与查询拒绝', { timeout: 90_000 }, async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.cwd, 'public/file.txt'), 'CHANGED\n');
  f.raw(['config', 'diff.tool', 'agoraprobe']); f.raw(['config', 'difftool.agoraprobe.cmd', f.probe('difftool')]);
  await f.positive('difftool', () => f.raw(['difftool', '--no-prompt']));
  await assert.rejects(gitRead(f.cwd, 'difftool'), /允许列表/);
  await gitRead(f.cwd, 'diff'); assert.deepEqual(await f.markers(), []);
  f.raw(['config', 'browser.agoraprobe.cmd', f.probe('browser')]);
  await f.positive('browser', () => f.raw(['web--browse', '--browser=agoraprobe', 'https://example.invalid/']));
  await assert.rejects(gitRead(f.cwd, 'web--browse'), /允许列表/);
  f.raw(['config', 'tar.probe.command', f.probe('archive')]);
  await f.positive('archive', () => f.raw(['archive', '--format=probe', 'HEAD']));
  await assert.rejects(gitRead(f.cwd, 'archive'), /允许列表/);
  f.raw(['config', 'imap.folder', 'Drafts']); f.raw(['config', 'imap.tunnel', f.probe('imap')]);
  await f.positive('imap', () => f.raw(['imap-send'], f.raw(['format-patch', '-1', '--stdout'])));
  await assert.rejects(gitRead(f.cwd, 'imap-send'), /允许列表/);
  await t.test('send-email 本地 sendmail 程序正控', async sub => {
    const execPath = f.raw(['--exec-path']).trim();
    if (!existsSync(path.join(execPath, 'git-send-email'))) { sub.skip('此 Git 安装未提供可选的 git-send-email；命令拒绝仍有断言。'); return; }
    const sendmail = await f.program('sendmail-probe', 'sendmail'), patch = path.join(f.root, 'message.patch');
    await writeFile(patch, f.raw(['format-patch', '-1', '--stdout']));
    f.raw(['config', 'sendemail.smtpServer', sendmail]);
    await f.positive('sendmail', () => f.raw(['send-email', '--confirm=never', '--no-validate', '--from=visible@example.invalid', '--to=visible@example.invalid', patch]));
  });
  await assert.rejects(gitRead(f.cwd, 'send-email'), /允许列表/);
  await gitRead(f.cwd, 'show', [], ['HEAD']); assert.deepEqual(await f.markers(), []);
});

test('Git pager：真实 TTY 正控与 --no-pager 负控', { timeout: 60_000 }, async t => {
  const f = await fixture(t);
  if (process.platform === 'win32') { t.skip('Windows 无 POSIX PTY；TTY 正负控由 Linux/macOS CI 执行，Windows 固定 argv 另有断言。'); return; }
  const pager = await f.program('pager-probe', 'pager');
  f.raw(['config', 'core.pager', pager]); f.raw(['config', 'pager.log', pager]);
  const python = `import os,pty,sys\npid,fd=pty.fork()\nif pid==0: os.execvpe('git',sys.argv[1:],os.environ)\nwhile True:\n try:\n  if not os.read(fd,65536): break\n except OSError: break\nos.waitpid(pid,0)\n`;
  f.env.TERM = 'xterm';
  const run = args => execFileSync('python3', ['-c', python, 'git', ...args], { cwd: f.cwd, env: f.env, timeout: 15_000, stdio: 'pipe' });
  await f.positive('pager', () => run(['--paginate', 'log', '-1']));
  const { gitEnvironment } = await import('../packages/protocol/dist/git.js');
  execFileSync('python3', ['-c', python, 'git', '--no-pager', 'log', '-1'], { cwd: f.cwd, env: gitEnvironment(f.env), timeout: 15_000, stdio: 'pipe' });
  assert.deepEqual(await f.markers(), []);
});
