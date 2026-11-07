import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { gitHasGitlinks } from '../packages/protocol/dist/git.js';
import { Worktrees } from '../packages/daemon/dist/worktrees.js';
import { fixture } from './fixtures/git-security.mjs';

test('R5：超过 1 MiB 的无子模块干净索引可以流式检查并清理 worktree', { timeout: 180_000 }, async t => {
  const f = await fixture(t), rows = new Map();
  const manager = new Worktrees({
    get: (_sql, id) => rows.get(id), run: (_sql, id) => { rows.get(id).state = 'removed'; },
  }, path.join(f.root, 'worktrees'));
  const { worktree } = await manager.create(f.cwd, 'large-index'); rows.set(worktree.task_id, worktree);
  const files = Array.from({ length: 9000 }, (_, i) => `file-${String(i).padStart(5, '0')}-${'x'.repeat(80)}.txt`);
  for (let i = 0; i < files.length; i += 32) {
    await Promise.all(files.slice(i, i + 32).map(file => writeFile(path.join(worktree.path, file), 'same\n')));
  }
  f.raw(['add', '.'], undefined, {}, worktree.path); f.raw(['commit', '-m', 'large index'], undefined, {}, worktree.path);
  const bytes = Buffer.byteLength(f.raw(['ls-files', '--stage', '-z'], undefined, {}, worktree.path));
  t.diagnostic(`ls-files 索引输出 ${bytes} bytes`); assert.ok(bytes > 1024 * 1024);
  assert.equal(f.raw(['status', '--porcelain'], undefined, {}, worktree.path), '');
  assert.equal(await gitHasGitlinks(worktree.path), false);
  await manager.remove(worktree.task_id, false);
  assert.equal(worktree.state, 'removed'); assert.equal(existsSync(worktree.path), false);
  // 同一流式入口仍能识别 gitlink；未初始化的子模块同样失败关闭。
  const { worktree: linked } = await manager.create(f.cwd, 'with-gitlink'); rows.set(linked.task_id, linked);
  const head = f.raw(['rev-parse', 'HEAD']).trim();
  f.raw(['update-index', '--add', '--cacheinfo', `160000,${head},linked`], undefined, {}, linked.path);
  assert.equal(await gitHasGitlinks(linked.path), true);
  for (const discard of [false, true]) {
    await assert.rejects(manager.remove(linked.task_id, discard), error => error.code === 'worktree_submodules');
  }
});
