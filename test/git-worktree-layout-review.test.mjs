import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import childProcess, { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { existsSync, realpathSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import agoraExtension from '../packages/extension/dist/index.js';
import { gitEnvironment, gitExec, gitRead, gitHasGitlinks } from '../packages/protocol/dist/git.js';
import { Worktrees } from '../packages/daemon/dist/worktrees.js';
import { extensionWire } from './fixtures/extension-wire.mjs';

async function fixture(t) {
  // Windows runner 的 TEMP 可能含 8.3 短名，先规范化再与 Git 的真实根比较。
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'agora-git-layout-')));
  const repo = path.join(root, 'repo'), other = path.join(root, 'protected');
  for (const directory of [repo, other]) await mkdir(path.join(directory, 'public'), { recursive: true });
  const env = gitEnvironment();
  delete env.GIT_EXTERNAL_DIFF;
  const raw = (args, cwd = repo) => execFileSync('git', args, { cwd, env, timeout: 10_000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  raw(['init', '--initial-branch=main']);
  raw(['config', 'user.name', 'Layout']); raw(['config', 'user.email', 'layout@example.invalid']);
  raw(['config', 'core.autocrlf', 'false']);
  await writeFile(path.join(repo, 'public/file.txt'), 'BASE\n');
  raw(['add', '.']); raw(['-c', 'commit.gpgsign=false', 'commit', '-m', 'base']);
  await writeFile(path.join(repo, 'public/file.txt'), 'AUTHORIZED-LOCAL\n');
  await writeFile(path.join(other, 'public/file.txt'), 'SECRET-OTHER\n');
  const wire = await extensionWire(root);
  const tools = ['read', 'grep', 'find', 'ls', 'agora_task', 'agora_request', 'agora_git'];
  wire.state.transformResponse = (route, value) => route === '/v1/auth/launch' ? { ...value, policy: {
    ...value.policy, profile: 'review', tools, allowedRoots: [root], protectedPaths: [other],
  } } : value;
  const handlers = new Map(), registered = [];
  const previous = { AGORA_URL: process.env.AGORA_URL, AGORA_LAUNCH_TICKET: process.env.AGORA_LAUNCH_TICKET };
  process.env.AGORA_URL = wire.url; process.env.AGORA_LAUNCH_TICKET = 'one-use-ticket';
  try {
    agoraExtension({ on: (name, handler) => handlers.set(name, handler), registerTool: tool => registered.push(tool),
      appendEntry() {}, getActiveTools: () => tools, getThinkingLevel: () => 'off', sendMessage() {} });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
  const ctx = { cwd: repo, model: { provider: 'fake', id: 'model' }, shutdown() {},
    sessionManager: { getSessionId: () => 'git-layout', getSessionFile: () => path.join(root, 'session.jsonl'), getEntries: () => [], getBranch: () => [] } };
  t.after(async () => { await handlers.get('session_shutdown')?.({}, ctx); await wire.close(); await rm(root, { recursive: true, force: true }); });
  await handlers.get('session_start')({}, ctx);
  const tool = registered.find(tool => tool.name === 'agora_git');
  const run = async (cwd = repo, paths = ['public/file.txt']) => (await tool.execute('git', { command: 'diff', paths }, undefined, undefined, { ...ctx, cwd })).details.output;
  const rows = new Map();
  const manager = new Worktrees({ get: (_sql, id) => rows.get(id), run: (_sql, id) => { rows.get(id).state = 'removed'; } }, path.join(root, 'managed'));
  const create = async (id, cwd = repo) => { const { worktree } = await manager.create(cwd, id); rows.set(id, worktree); return worktree; };
  t.diagnostic(raw(['--version']).trim());
  return { root, repo, other, raw, run, manager, create };
}
const mismatch = { code: 'EAGORA_GIT_WORKTREE_MISMATCH' };

// 只替换进程边界以注入配置变更；核验、探测和最终命令仍由真实 Git 执行。
async function redirectAfterVerification(f, { scope, command, afterVerify, accept = () => true, target }, action) {
  const execFile = childProcess.execFile, spawn = childProcess.spawn;
  const calls = [], probes = [];
  let injected = false, configCwd;
  const configArgs = scope === 'worktree' ? ['--worktree'] : ['--local'];
  const inject = cwd => {
    if (injected) return;
    configCwd = target ?? cwd;
    f.raw(['config', ...configArgs, 'core.worktree', f.other], configCwd);
    injected = true;
    assert.equal(realpathSync(f.raw(['rev-parse', '--show-toplevel'], configCwd).trim()), realpathSync(f.other));
  };
  const capture = (args, options) => {
    if (args.includes(command) && accept(options.cwd)) {
      if (!afterVerify) inject(options.cwd);
      const globals = args.slice(0, args.indexOf(command));
      calls.push({ cwd: options.cwd, root: f.raw([...globals, 'rev-parse', '--show-toplevel'], options.cwd).trim() });
    }
    if (injected && args.includes('config') && accept(options.cwd)) {
      const globals = args.slice(0, args.indexOf('config'));
      probes.push({ cwd: options.cwd, root: f.raw([...globals, 'rev-parse', '--show-toplevel'], options.cwd).trim() });
    }
  };
  mock.method(childProcess, 'execFile', (file, args, options, callback) => {
    capture(args, options);
    return execFile(file, args, options, (error, stdout, stderr) => {
      try {
        if (!error && afterVerify && args.includes('--show-toplevel') && accept(options.cwd)) inject(options.cwd);
      } catch (cause) { return callback(cause, '', stderr); }
      callback(error, stdout, stderr);
    });
  });
  mock.method(childProcess, 'spawn', (file, args, options) => {
    capture(args, options);
    return spawn(file, args, options);
  });
  syncBuiltinESMExports();
  try {
    const value = await action();
    assert.equal(injected, true, '必须在已核验布局和最终执行之间注入配置变更');
    assert.equal(calls.length, 1, '必须执行一次真实的目标命令');
    return { value, calls, probes };
  } finally {
    mock.restoreAll(); syncBuiltinESMExports();
    if (injected && (scope !== 'worktree' || existsSync(configCwd))) {
      f.raw(['config', ...configArgs, '--unset', 'core.worktree'], scope === 'worktree' ? configCwd : f.repo);
    }
  }
}

async function assertRoots(records, expected) {
  for (const record of records) assert.equal(await realpath(record.root), await realpath(expected));
}

test('N1：core.worktree 重定向的真实 agora_git 正负控，查询、创建和流式索引拒绝越界布局', async t => {
  const f = await fixture(t);
  f.raw(['config', 'core.worktree', f.other]);
  const positive = f.raw(['diff', '--', 'public/file.txt']);
  assert.match(positive, /SECRET-OTHER/);
  t.diagnostic(`普通 Git 正控：${positive.split('\n').find(line => line === '+SECRET-OTHER')}`);
  assert.equal(await realpath(f.raw(['rev-parse', '--show-toplevel']).trim()), await realpath(f.other));
  await assert.rejects(f.run(), mismatch);
  await assert.rejects(f.run(path.join(f.repo, 'public'), ['file.txt']), mismatch);
  await assert.rejects(gitExec(f.repo, ['config', '--list']), mismatch);
  await assert.rejects(gitHasGitlinks(f.repo), mismatch);
  await assert.rejects(f.create('rejected'), mismatch);
  t.diagnostic('agora_git 负控：EAGORA_GIT_WORKTREE_MISMATCH，未返回受保护内容');
  f.raw(['config', '--unset', 'core.worktree']);
  assert.match(await f.run(), /AUTHORIZED-LOCAL/);
  assert.match(await f.run(path.join(f.repo, 'public'), ['file.txt']), /AUTHORIZED-LOCAL/);
});

test('N1：linked worktree/gitfile/commondir 保留子目录语义，config.worktree 重定向拒绝检出与清理', async t => {
  const f = await fixture(t);
  const linked = await f.create('linked', path.join(f.repo, 'public'));
  const directory = linked.path;
  await writeFile(path.join(directory, 'public/file.txt'), 'AUTHORIZED-LINKED\n');
  assert.match(await f.run(directory), /AUTHORIZED-LINKED/);
  assert.match(await f.run(path.join(directory, 'public'), ['file.txt']), /AUTHORIZED-LINKED/);
  for (const command of ['status', 'diff', 'log', 'show']) {
    assert.equal(typeof await gitRead(path.join(directory, 'public'), command, [], command === 'show' ? ['HEAD'] : [], ['file.txt']), 'string');
  }
  assert.equal(await gitHasGitlinks(directory), false);
  f.raw(['config', 'extensions.worktreeConfig', 'true']);
  // 主工作树的合法绝对 core.worktree 不应传播到 linked worktree 的内部操作。
  f.raw(['config', '--worktree', 'core.worktree', f.repo]);
  assert.match(await f.run(directory), /AUTHORIZED-LINKED/);
  f.raw(['config', '--worktree', 'core.worktree', f.other], directory);
  const positive = f.raw(['diff', '--', 'public/file.txt'], directory);
  assert.match(positive, /SECRET-OTHER/);
  t.diagnostic(`config.worktree 普通 Git 正控：${positive.split('\n').find(line => line === '+SECRET-OTHER')}`);
  await assert.rejects(f.run(directory), mismatch);
  await assert.rejects(gitHasGitlinks(directory), mismatch);
  await assert.rejects(gitExec(directory, ['reset', '--hard', 'HEAD']), mismatch);
  await assert.rejects(gitExec(f.repo, ['worktree', 'remove', '--force', directory], undefined, [directory]), mismatch);
  await assert.rejects(f.manager.remove(linked.task_id, true), mismatch);
  assert.equal(linked.state, 'active');
  f.raw(['config', '--worktree', '--unset', 'core.worktree'], directory);
  f.raw(['config', '--worktree', 'core.worktree', f.other]);
  await assert.rejects(f.manager.remove(linked.task_id, true), mismatch);
  assert.equal(linked.state, 'active');
  f.raw(['config', '--worktree', 'core.worktree', f.repo]);
  await f.manager.remove(linked.task_id, true);
  assert.equal(linked.state, 'removed');
  const clean = await f.create('clean');
  await f.manager.remove(clean.task_id, false);
  assert.equal(clean.state, 'removed');
});

test('N1 TOCTOU：直接查询在核验后或执行前重定向配置时仍读取已核验树', async t => {
  for (const scope of ['local', 'worktree']) for (const afterVerify of [true, false]) {
    await t.test(`${scope}/${afterVerify ? '核验后' : '查询前'}`, async t => {
      const f = await fixture(t);
      let directory = f.repo;
      if (scope === 'worktree') {
        directory = (await f.create('query')).path;
        f.raw(['config', 'extensions.worktreeConfig', 'true']);
        await writeFile(path.join(directory, 'public/file.txt'), 'AUTHORIZED-LOCAL\n');
      }
      const cwd = path.join(directory, 'public');
      const result = await redirectAfterVerification(f, { scope, command: 'diff', afterVerify }, () => f.run(cwd, ['file.txt']));
      assert.match(result.value, /AUTHORIZED-LOCAL/);
      assert.doesNotMatch(result.value, /SECRET-OTHER/);
      await assertRoots(result.calls, directory);
      if (afterVerify) { assert.ok(result.probes.length > 0); await assertRoots(result.probes, directory); }
    });
  }
});

test('N1 TOCTOU：流式索引检查固定已核验树，覆盖 config.worktree 和子目录', async t => {
  for (const scope of ['local', 'worktree']) for (const afterVerify of [true, false]) {
    await t.test(`${scope}/${afterVerify ? '核验后' : '索引检查前'}`, async t => {
      const f = await fixture(t);
      let directory = f.repo;
      if (scope === 'worktree') {
        directory = (await f.create('index')).path;
        f.raw(['config', 'extensions.worktreeConfig', 'true']);
      }
      const oid = f.raw(['rev-parse', 'HEAD'], directory).trim();
      f.raw(['update-index', '--add', '--cacheinfo', `160000,${oid},public/module`], directory);
      const cwd = path.join(directory, 'public');
      const result = await redirectAfterVerification(f, { scope, command: 'ls-files', afterVerify }, () => gitHasGitlinks(cwd));
      assert.equal(result.value, true);
      await assertRoots(result.calls, directory);
      if (afterVerify) { assert.ok(result.probes.length > 0); await assertRoots(result.probes, directory); }
      assert.equal(await readFile(path.join(f.other, 'public/file.txt'), 'utf8'), 'SECRET-OTHER\n');
    });
  }
});

test('N1 TOCTOU：主工作树和 linked worktree 的检出固定目标树，不覆盖受保护树', async t => {
  for (const scope of ['local', 'worktree']) for (const afterVerify of [true, false]) {
    await t.test(`${scope}/${afterVerify ? '核验后' : '检出前'}`, async t => {
      const f = await fixture(t);
      if (scope === 'worktree') f.raw(['config', 'extensions.worktreeConfig', 'true']);
      const result = await redirectAfterVerification(f, {
        scope, command: 'reset', afterVerify, accept: cwd => scope === 'local' || cwd !== f.repo,
      }, scope === 'local' ? async () => { await gitExec(f.repo, ['reset', '--hard', 'HEAD']); return { path: f.repo }; } : () => f.create('checkout'));
      assert.equal(await readFile(path.join(result.value.path, 'public/file.txt'), 'utf8'), 'BASE\n');
      assert.equal(await readFile(path.join(f.other, 'public/file.txt'), 'utf8'), 'SECRET-OTHER\n');
      if (scope === 'worktree') assert.equal(await readFile(path.join(f.repo, 'public/file.txt'), 'utf8'), 'AUTHORIZED-LOCAL\n');
      await assertRoots(result.calls, result.value.path);
      if (afterVerify) { assert.ok(result.probes.length > 0); await assertRoots(result.probes, result.value.path); }
    });
  }
});

test('N1 TOCTOU：worktree remove 的内部 status 固定目标树，不继承父树根', async t => {
  const f = await fixture(t), linked = await f.create('remove');
  f.raw(['config', 'extensions.worktreeConfig', 'true']);
  f.raw(['config', '--worktree', 'core.worktree', f.repo]);
  const expected = await realpath(linked.path);
  const result = await redirectAfterVerification(f, {
    scope: 'worktree', command: 'worktree', afterVerify: false, target: linked.path,
  }, () => f.manager.remove(linked.task_id, false));
  assert.equal(linked.state, 'removed');
  assert.equal(path.resolve(result.calls[0].root), expected);
  assert.equal(await readFile(path.join(f.repo, 'public/file.txt'), 'utf8'), 'AUTHORIZED-LOCAL\n');
  assert.equal(await readFile(path.join(f.other, 'public/file.txt'), 'utf8'), 'SECRET-OTHER\n');
});
