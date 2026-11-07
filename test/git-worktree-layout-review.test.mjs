import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import agoraExtension from '../packages/extension/dist/index.js';
import { gitEnvironment, gitExec, gitRead, gitHasGitlinks } from '../packages/protocol/dist/git.js';
import { Worktrees } from '../packages/daemon/dist/worktrees.js';
import { extensionWire } from './fixtures/extension-wire.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'agora-git-layout-'));
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
  await f.manager.remove(linked.task_id, true);
  assert.equal(linked.state, 'removed');
  const clean = await f.create('clean');
  await f.manager.remove(clean.task_id, false);
  assert.equal(clean.state, 'removed');
});
