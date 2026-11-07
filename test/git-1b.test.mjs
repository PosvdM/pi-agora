import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import childProcess, { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { gitRead, gitExec, gitEnvironment } from '../packages/protocol/dist/git.js';
import { Worktrees } from '../packages/daemon/dist/worktrees.js';

const prefix = ['--no-pager', '--no-optional-locks', '-c', 'core.fsmonitor=', '-c', 'core.pager=cat',
  '-c', 'color.ui=never', '-c', 'log.showSignature=false', '-c', 'core.hooksPath=/dev/null'];
const quote = value => `'${value.replaceAll('\\', '/').replaceAll("'", "'\\''")}'`;
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'agora-git-1b-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'repo');
  await mkdir(cwd);
  const env = gitEnvironment();
  delete env.GIT_EXTERNAL_DIFF;
  delete env.GIT_PAGER;
  delete env.PAGER;
  const raw = (args, input) => execFileSync('git', args, { cwd, env, input, encoding: 'utf8',
    timeout: 10_000, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  raw(['init', '--initial-branch=main']);
  raw(['config', 'user.name', 'Git safety test']);
  raw(['config', 'user.email', 'git-safety@example.invalid']);
  raw(['config', 'core.autocrlf', 'false']);
  raw(['config', 'commit.gpgsign', 'false']);
  await writeFile(path.join(cwd, '.gitattributes'), '*.txt diff=trap filter=trap\n');
  await writeFile(path.join(cwd, 'file.txt'), 'base\n');
  raw(['add', '.']);
  raw(['commit', '-m', 'base']);
  await writeFile(path.join(cwd, 'file.txt'), 'committed\n');
  raw(['add', '.']);
  raw(['commit', '-m', 'committed']);
  await writeFile(path.join(cwd, 'file.txt'), 'staged\n');
  raw(['add', '.']);
  await writeFile(path.join(cwd, 'file.txt'), 'working\n');
  const oracle = path.join(root, 'markers.jsonl');
  const script = path.join(root, 'probe.mjs');
  await writeFile(script, `import { appendFileSync } from 'node:fs';\nappendFileSync(process.argv[2], JSON.stringify({ kind: process.argv[3], pid: process.pid, argv: process.argv.slice(4) }) + '\\n');\n`);
  const probe = kind => `${quote(process.execPath)} ${quote(script)} ${quote(oracle)} ${quote(kind)}`;
  const markers = async () => existsSync(oracle) ? (await readFile(oracle, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  const clear = () => rm(oracle, { force: true });
  return { root, cwd, raw, probe, markers, clear };
}

test('1b git argv：固定安全前缀、filter 覆盖和 -- 分隔，不依赖 Git >2.34 的选项', async () => {
  const calls = [];
  const signal = new AbortController().signal;
  mock.method(childProcess, 'execFile', (file, args, options, callback) => {
    calls.push({ file, args, options });
    callback(null, args.includes('--get-regexp') ? 'filter.trap.clean\nunsafe\0filter.trap.required\ntrue\0' : args.includes('--verify') ? `${'a'.repeat(40)}\n` : 'output');
  });
  syncBuiltinESMExports();
  try {
    const filters = ['-c', 'filter.trap.clean=', '-c', 'filter.trap.smudge=', '-c', 'filter.trap.process=', '-c', 'filter.trap.required=false'];
    for (const [command, options, refs, paths, expected] of [
      ['status', [], [], ['-leading.txt'], ['status', '--porcelain=v1', '--ignore-submodules=all', '--untracked-files=normal', '--', '-leading.txt']],
      ['diff', ['--cached', '-U3'], ['HEAD'], ['file.txt'], ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--cached', '-U3', 'HEAD', '--', 'file.txt']],
      ['log', ['-p', '-n2'], ['HEAD~1..HEAD'], [], ['log', '--no-ext-diff', '--no-textconv', '--no-color', '--no-show-signature', '-n50', '-p', '-n2', 'HEAD~1..HEAD', '--', '.']],
      ['show', ['--stat'], ['HEAD'], [], ['show', '--no-ext-diff', '--no-textconv', '--no-color', '--no-show-signature', '--stat', 'HEAD', '--', '.']],
    ]) {
      calls.length = 0;
      assert.equal(await gitRead('/repo', command, options, refs, paths, signal), 'output');
      assert.deepEqual(calls[0].args, [...prefix, 'config', '--null', '--get-regexp', '^filter\\.']);
      const oid = 'a'.repeat(40);
      const resolved = expected.map(arg => arg === 'HEAD' ? oid : arg === 'HEAD~1..HEAD' ? `${oid}..${oid}` : arg);
      assert.deepEqual(calls.at(-1).args, [...prefix, ...filters, '--literal-pathspecs', ...resolved]);
      const endpoints = refs.flatMap(ref => ref.split('..'));
      assert.deepEqual(calls.filter(call => call.args.includes('--verify')).map(call => call.args),
        [...new Set(endpoints)].map(ref => [...prefix, ...filters, 'rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]));
      for (const call of calls) {
        assert.equal(call.file, 'git');
        assert.equal(call.options.signal, signal);
        assert.equal(call.options.cwd, '/repo');
        assert.equal(call.options.timeout, 30_000);
        assert.equal(call.options.shell, undefined);
        assert.equal(call.options.env.GIT_OPTIONAL_LOCKS, '0');
      }
    }
    calls.length = 0;
    await gitExec('/repo', ['rev-parse', '--show-toplevel'], signal);
    assert.deepEqual(calls[0].args, [...prefix, 'config', '--null', '--get-regexp', '^filter\\.']);
    assert.deepEqual(calls[1].args, [...prefix, ...filters, 'rev-parse', '--show-toplevel']);
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test('N1：只接受完整提交 OID，解析失败不执行读取命令', async () => {
  const calls = [];
  let output = '';
  mock.method(childProcess, 'execFile', (file, args, options, callback) => {
    calls.push(args);
    callback(null, args.includes('--get-regexp') ? '' : args.includes('--verify') ? output : 'read');
  });
  syncBuiltinESMExports();
  try {
    for (const invalid of ['', 'a'.repeat(39), 'a'.repeat(41), 'a'.repeat(63), 'z'.repeat(40), `${'a'.repeat(40)}\n${'b'.repeat(40)}`]) {
      calls.length = 0; output = invalid;
      await assert.rejects(gitRead('/repo', 'show', [], ['HEAD']), /提交对象无效/);
      assert.equal(calls.some(args => args.includes('show')), false);
    }
    for (const length of [40, 64]) {
      calls.length = 0; output = `${'a'.repeat(length)}\n`;
      assert.equal(await gitRead('/repo', 'show', [], ['HEAD']), 'read');
      assert.ok(calls.at(-1).includes('a'.repeat(length)));
      assert.equal(calls.at(-1).includes('HEAD'), false);
    }
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test('1b git 参数：拒绝命令、白名单外选项、危险 refs 和魔术 pathspec，拒绝前不启动 Git', async () => {
  let calls = 0;
  mock.method(childProcess, 'execFile', () => { calls++; throw new Error('must not execute'); });
  syncBuiltinESMExports();
  try {
    await assert.rejects(gitRead('/missing', 'config'), /允许列表/);
    for (const command of ['status', 'diff', 'log', 'show']) {
      const refs = command === 'show' ? ['HEAD'] : [];
      for (const option of ['--output=marker', '--ext-diff', '--textconv', '--exec=probe', '--paginate',
        '-c', '--no-index', '--submodule=diff', '--show-signature', '--format=%x00', '--', '-n0', '-n10000']) {
        await assert.rejects(gitRead('/missing', command, [option], refs), /选项/);
      }
      for (const target of [':(top)file', ':!file', ':(attr:filter)file', ':file']) {
        await assert.rejects(gitRead('/missing', command, [], refs, [target]), /pathspec/);
      }
    }
    for (const ref of ['--output=marker', '-HEAD', 'HEAD:file', 'HEAD@{1}', 'HEAD;probe', 'HEAD\nprobe', '', 'HEAD\0', ':(top)file']) {
      await assert.rejects(gitRead('/missing', 'show', [], [ref]), /无效/);
    }
    await assert.rejects(gitRead('/missing', 'status', [], ['HEAD']), /提交参数/);
    await assert.rejects(gitRead('/missing', 'show'), /提交参数/);
    await assert.rejects(gitRead('/missing', 'log', [], ['HEAD', 'HEAD~1']), /提交参数/);
    await assert.rejects(gitRead('/missing', 'diff', [], ['HEAD', 'HEAD~1', 'HEAD~2']), /提交参数/);
    for (const args of [[null], [[], {}], [[], [], [null]], [Array(101).fill('-p')], [[], [], ['bad\0path']]]) {
      await assert.rejects(gitRead('/missing', 'diff', ...args), /参数无效/);
    }
    assert.equal(calls, 0);
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test('1b git environment：移除所有大小写的 GIT_* 注入并固定非交互设置', () => {
  const source = { PATH: 'path', HOME: 'home', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.fsmonitor',
    GIT_CONFIG_VALUE_0: 'probe', GIT_CONFIG_PARAMETERS: "'core.fsmonitor=probe'", GIT_DIR: '/hostile',
    git_work_tree: '/hostile', Git_External_Diff: 'probe', GIT_SSH_COMMAND: 'probe', GIT_PAGER: 'probe', PAGER: 'probe' };
  const env = gitEnvironment(source);
  assert.equal(source.GIT_PAGER, 'probe');
  assert.equal(env.PATH, 'path');
  for (const key of ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_CONFIG_PARAMETERS', 'GIT_DIR', 'git_work_tree', 'Git_External_Diff', 'GIT_SSH_COMMAND']) assert.equal(env[key], undefined);
  assert.equal(env.GIT_CONFIG_GLOBAL, process.platform === 'win32' ? 'NUL' : '/dev/null');
  assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(env.GIT_PAGER, 'cat');
  assert.equal(env.PAGER, 'cat');
  assert.equal(env.GIT_EXTERNAL_DIFF, '');
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
});

test('1b 真实 Git：textconv/external/fsmonitor/pager/required filters/gpg 配置不执行', { timeout: 90_000 }, async t => {
  const f = await fixture(t);
  t.diagnostic(f.raw(['--version']).trim());
  const signed = `tree ${f.raw(['rev-parse', 'HEAD^{tree}']).trim()}\nparent ${f.raw(['rev-parse', 'HEAD~1']).trim()}\nauthor Safety <safety@example.invalid> 1700000000 +0000\ncommitter Safety <safety@example.invalid> 1700000000 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n dGVzdA==\n -----END PGP SIGNATURE-----\n\nSigned fixture\n`;
  const signedOid = f.raw(['hash-object', '-t', 'commit', '-w', '--stdin'], signed).trim();
  f.raw(['update-ref', 'refs/heads/signed', signedOid]);
  const gpgProgram = path.join(f.root, 'gpg-probe.sh');
  await writeFile(gpgProgram, `#!/bin/sh\nexec ${f.probe('gpg')} "$@"\n`);
  await chmod(gpgProgram, 0o755);
  const configs = [
    ['diff.trap.textconv', f.probe('textconv')], ['diff.external', f.probe('external')],
    ['core.fsmonitor', f.probe('fsmonitor')], ['core.pager', f.probe('pager')],
    ['pager.log', f.probe('pager')], ['filter.trap.clean', f.probe('clean')],
    ['filter.trap.smudge', f.probe('smudge')], ['filter.trap.process', f.probe('process')],
    ['filter.trap.required', 'true'], ['gpg.program', gpgProgram.replaceAll('\\', '/')], ['log.showSignature', 'true'],
  ];
  // 可在管道中执行的危险配置先由未加固 Git 独立触发，核实 oracle。
  const controls = [
    ['textconv', ['diff.trap.textconv'], ['diff', '--no-ext-diff', '--textconv']],
    ['external', ['diff.external'], ['diff', '--ext-diff', '--no-textconv']],
    ['fsmonitor', ['core.fsmonitor'], ['status', '--porcelain=v1']],
    ['clean', ['filter.trap.clean', 'filter.trap.required'], ['diff', '--no-ext-diff', '--no-textconv']],
    ['smudge', ['filter.trap.smudge', 'filter.trap.required'], ['cat-file', '--filters', 'HEAD:file.txt']],
    ['process', ['filter.trap.process', 'filter.trap.required'], ['diff', '--no-ext-diff', '--no-textconv']],
    ['gpg', ['gpg.program'], ['log', '-1', '--show-signature', 'signed']],
  ];
  for (const [kind, keys, args] of controls) {
    for (const [key, value] of configs.filter(([key]) => keys.includes(key))) f.raw(['config', key, value]);
    try { f.raw(args); } catch { /* 恶意转换器可以使未加固命令失败。 */ }
    assert.ok((await f.markers()).some(marker => marker.kind === kind), `${kind} positive control must execute`);
    for (const key of keys) f.raw(['config', '--unset-all', key]);
    await f.clear();
  }
  for (const [key, value] of configs) f.raw(['config', key, value]);
  assert.equal(f.raw(['var', 'GIT_PAGER']).trim(), f.probe('pager'));
  t.diagnostic('pager 配置经 git var 验证；stdout 为管道，未声称触发真实 TTY pager；禁用由固定 --no-pager argv 覆盖。');
  const reads = [
    ['status', [], [], [], /file\.txt/],
    ['diff', [], [], [], /staged[\s\S]*working/],
    ['diff', ['--cached'], [], [], /committed[\s\S]*staged/],
    ['diff', [], ['HEAD~1..HEAD'], [], /base[\s\S]*committed/],
    ['diff', ['--name-only'], ['HEAD~1', 'HEAD'], ['file.txt'], /file\.txt/],
    ['log', ['-p', '-n2'], ['HEAD'], [], /committed/],
    ['show', ['-p'], ['HEAD'], [], /committed/],
    ['log', ['-p'], ['signed'], [], /committed/],
    ['show', ['-p'], ['signed'], [], /Signed fixture/],
  ];
  for (const [command, options, refs, paths, expected] of reads) {
    const output = await gitRead(f.cwd, command, options, refs, paths);
    assert.match(output, expected, JSON.stringify({ command, options, refs }));
    assert.deepEqual(await f.markers(), [], `${command} must not execute configured programs`);
  }
  // 无 filter 配置时，--get-regexp 的退出码 1 必须正常退回读取配置。
  for (const key of ['filter.trap.clean', 'filter.trap.smudge', 'filter.trap.process', 'filter.trap.required']) f.raw(['config', '--unset-all', key]);
  assert.match(await gitRead(f.cwd, 'status'), /file\.txt/);
  assert.deepEqual(await f.markers(), []);
});

test('F2：worktree 检出禁用恶意 smudge/process 与 hooks，正控执行且无遗留进程', { timeout: 90_000 }, async t => {
  const f = await fixture(t);
  const manager = new Worktrees({ home: f.root }, path.join(f.root, 'worktrees'));
  const dead = async markers => {
    for (const marker of markers) {
      // Git 等待 filter 退出后才返回；短暂等待兼容 Windows 退出可见性延迟。
      let alive = true;
      for (let attempt = 0; attempt < 40 && alive; attempt++) {
        try { process.kill(marker.pid, 0); await new Promise(resolve => setTimeout(resolve, 50)); }
        catch (error) { if (error.code === 'ESRCH') alive = false; else throw error; }
      }
      assert.equal(alive, false, `filter 进程 ${marker.pid} 必须退出`);
    }
  };
  for (const kind of ['smudge', 'process']) {
    f.raw(['config', `filter.trap.${kind}`, f.probe(kind)]);
    f.raw(['config', 'filter.trap.required', 'true']);
    const positive = path.join(f.root, `positive-${kind}`);
    try { f.raw(['worktree', 'add', '--detach', positive, 'HEAD']); } catch { /* process 协议故意不实现。 */ }
    const executed = await f.markers();
    assert.ok(executed.some(marker => marker.kind === kind), `${kind} 正控必须执行`);
    await dead(executed); await f.clear();
    const result = await manager.create(f.cwd, `negative-${kind}`);
    assert.equal(await readFile(path.join(result.worktree.path, 'file.txt'), 'utf8'), 'committed\n');
    assert.deepEqual(await f.markers(), [], `${kind} 不能在加固的 worktree add 中执行`);
    f.raw(['config', '--unset-all', `filter.trap.${kind}`]);
    f.raw(['config', '--unset-all', 'filter.trap.required']);
  }
  const hooks = path.join(f.root, 'hooks'); await mkdir(hooks);
  const hook = path.join(hooks, 'post-checkout');
  await writeFile(hook, `#!/bin/sh\nexec ${f.probe('hook')} "$@"\n`); await chmod(hook, 0o755);
  f.raw(['config', 'core.hooksPath', hooks.replaceAll('\\', '/')]);
  f.raw(['worktree', 'add', '--detach', path.join(f.root, 'positive-hook'), 'HEAD']);
  const hooksRun = await f.markers(); assert.ok(hooksRun.some(marker => marker.kind === 'hook'));
  await dead(hooksRun); await f.clear();
  await manager.create(f.cwd, 'negative-hook'); assert.deepEqual(await f.markers(), []);
  // 新分支和新 gitdir 的条件 include 在父工作目录中不可见。
  for (const condition of ['onbranch', 'gitdir']) {
    const conditional = path.join(f.root, `${condition}-programs.config`);
    f.raw(['config', '--file', conditional, 'filter.trap.smudge', f.probe(`${condition}-smudge`)]);
    f.raw(['config', '--file', conditional, 'core.fsmonitor', f.probe(`${condition}-fsmonitor`)]);
    f.raw(['config', '--file', conditional, 'core.hooksPath', hooks.replaceAll('\\', '/')]);
    const key = condition === 'onbranch' ? 'includeIf.onbranch:agora/**.path'
      : `includeIf.gitdir:${(await realpath(path.join(f.cwd, '.git'))).replaceAll('\\', '/')}/worktrees/**.path`;
    f.raw(['config', key, conditional.replaceAll('\\', '/')]);
    const positive = path.join(f.root, `agora-positive-${condition}`);
    f.raw(['worktree', 'add', '-b', `agora/positive-${condition}`, positive, 'HEAD']);
    f.raw(['-C', positive, 'status', '--porcelain=v1']);
    const controls = await f.markers();
    for (const kind of [`${condition}-smudge`, `${condition}-fsmonitor`, 'hook']) {
      assert.ok(controls.some(marker => marker.kind === kind), `${condition} 条件配置正控必须执行 ${kind}`);
    }
    await dead(controls); await f.clear();
    const result = await manager.create(f.cwd, `negative-${condition}`);
    assert.equal(await readFile(path.join(result.worktree.path, 'file.txt'), 'utf8'), 'committed\n');
    assert.deepEqual(await f.markers(), [], `${condition} 条件配置不能在检出期间执行程序`);
    f.raw(['config', '--unset-all', key]);
  }
});
