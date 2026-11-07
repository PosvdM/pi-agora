import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import agoraExtension from '../packages/extension/dist/index.js';
import { gitRead, gitEnvironment } from '../packages/protocol/dist/git.js';
import { extensionWire } from './fixtures/extension-wire.mjs';

test('F1：真实 Git 的 glob 按字面处理，省略路径只读 cwd，安全路径可正常查询', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agora-git-paths-'));
  const wire = await extensionWire(root);
  const repo = join(root, 'repo'), safe = join(repo, 'public'), secret = join(repo, 'secret');
  await mkdir(safe, { recursive: true }); await mkdir(secret);
  const raw = args => execFileSync('git', args, { cwd: repo, env: gitEnvironment(), timeout: 10_000, encoding: 'utf8' });
  raw(['init']); raw(['config', 'user.name', '测试']); raw(['config', 'user.email', 'test@example.invalid']);
  await writeFile(join(safe, 'file.txt'), 'SAFE-CONTENT\n');
  await writeFile(join(secret, 'key.txt'), 'PROTECTED-CONTENT\n');
  raw(['add', '.']); raw(['-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture']);
  const tools = ['read', 'grep', 'find', 'ls', 'agora_task', 'agora_request', 'agora_git'];
  wire.state.transformResponse = (route, value) => route === '/v1/auth/launch' ? { ...value, policy: {
    ...value.policy, profile: 'review', tools, allowedRoots: [repo], protectedPaths: [secret],
  } } : value;
  const handlers = new Map(), registered = [];
  const original = { url: process.env.AGORA_URL, ticket: process.env.AGORA_LAUNCH_TICKET };
  process.env.AGORA_URL = wire.url; process.env.AGORA_LAUNCH_TICKET = 'one-use-ticket';
  try {
    agoraExtension({ on: (name, handler) => handlers.set(name, handler), registerTool: tool => registered.push(tool),
      appendEntry() {}, getActiveTools: () => tools, getThinkingLevel: () => 'off', sendMessage() {} });
  } finally {
    for (const [key, value] of [['AGORA_URL', original.url], ['AGORA_LAUNCH_TICKET', original.ticket]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
  const ctx = { cwd: repo, model: { provider: 'fake', id: 'model' }, shutdown() {},
    sessionManager: { getSessionId: () => 'git-paths', getSessionFile: () => join(root, 'session.jsonl'), getEntries: () => [], getBranch: () => [] } };
  t.after(async () => { await handlers.get('session_shutdown')?.({}, ctx); await wire.close(); await rm(root, { recursive: true, force: true }); });
  await handlers.get('session_start')({}, ctx);
  const tool = registered.find(tool => tool.name === 'agora_git');
  const run = async (params, cwd = repo) => (await tool.execute('git', params, undefined, undefined, { ...ctx, cwd })).details.output;
  // 未加固 Git 的 glob 正控必须能读取受保护内容。
  assert.match(raw(['show', 'HEAD', '--', '[s]ecret/*']), /PROTECTED-CONTENT/);
  for (const command of ['show', 'log']) {
    const args = { command, options: ['-p'], refs: ['HEAD'] };
    assert.doesNotMatch(await run({ ...args, paths: ['[s]ecret/*'] }), /PROTECTED-CONTENT/);
    const scoped = await run(args, safe);
    assert.match(scoped, /SAFE-CONTENT/); assert.doesNotMatch(scoped, /PROTECTED-CONTENT/);
    assert.match(await run({ ...args, paths: ['public/file.txt'] }), /SAFE-CONTENT/);
    await assert.rejects(run({ ...args, paths: ['secret/key.txt'] }), /受保护/);
    assert.doesNotMatch(await gitRead(safe, command, ['-p'], ['HEAD']), /PROTECTED-CONTENT/);
  }
});
