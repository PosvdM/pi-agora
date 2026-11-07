import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { gitExec, gitRead, gitEnvironment } from '../packages/protocol/dist/git.js';
import { Worktrees } from '../packages/daemon/dist/worktrees.js';
import { fixture } from './fixtures/git-security.mjs';

const protectedText = 'PROTECTED-OBJECT-CONTENT';

test('R1：notes 的 core.notesRef/notes.displayRef 不能输出受保护 blob', { timeout: 90_000 }, async t => {
  const f = await fixture(t), blob = f.raw(['hash-object', '-w', '--stdin'], `${protectedText}\n`).trim();
  for (const key of ['core.notesRef', 'notes.displayRef']) {
    f.raw(['notes', '--ref=hidden', 'add', '-C', blob, 'HEAD']);
    f.raw(['config', key, 'refs/notes/hidden']);
    for (const command of ['log', 'show']) {
      assert.match(f.raw([command, '-p', 'HEAD', '--', 'public/file.txt']), new RegExp(protectedText));
      const output = await gitRead(f.cwd, command, ['-p'], ['HEAD'], ['public/file.txt']);
      assert.match(output, /PUBLIC-CONTENT/); assert.doesNotMatch(output, new RegExp(protectedText));
    }
    f.raw(['config', '--unset-all', key]); f.raw(['update-ref', '-d', 'refs/notes/hidden']);
  }
});

test('Git 对象读取：replace、grafts、mailmap.blob/file 与自定义默认格式均不能带入对象内容', { timeout: 90_000 }, async t => {
  const f = await fixture(t), head = f.raw(['rev-parse', 'HEAD']).trim();
  const leak = f.raw(['commit-tree', `${head}^{tree}`, '-m', protectedText]).trim();
  f.raw(['replace', head, leak]);
  assert.match(f.raw(['show', 'HEAD', '--', 'public/file.txt']), new RegExp(protectedText));
  for (const command of ['log', 'show']) {
    assert.doesNotMatch(await gitRead(f.cwd, command, ['-p'], ['HEAD'], ['public/file.txt']), new RegExp(protectedText));
  }
  f.raw(['replace', '-d', head]);
  await writeFile(path.join(f.cwd, '.git/info/grafts'), `${head} ${leak}\n`);
  assert.match(f.raw(['log', 'HEAD']), new RegExp(protectedText));
  assert.doesNotMatch(await gitRead(f.cwd, 'log', [], ['HEAD']), new RegExp(protectedText));
  await rm(path.join(f.cwd, '.git/info/grafts'));
  const map = `${protectedText} <visible@example.invalid> Visible <visible@example.invalid>\n`;
  const blob = f.raw(['hash-object', '-w', '--stdin'], map).trim();
  const file = path.join(f.root, 'protected-mailmap'); await writeFile(file, map);
  for (const [key, value] of [['mailmap.blob', blob], ['mailmap.file', file]]) {
    f.raw(['config', key, value]); f.raw(['config', 'log.mailmap', 'true']);
    assert.match(f.raw(['show', '--use-mailmap', 'HEAD', '--', 'public/file.txt']), new RegExp(protectedText));
    for (const command of ['log', 'show']) {
      assert.doesNotMatch(await gitRead(f.cwd, command, [], ['HEAD'], ['public/file.txt']), new RegExp(protectedText));
    }
    f.raw(['config', '--unset-all', key]);
  }
  f.raw(['notes', 'add', '-C', blob, 'HEAD']); f.raw(['config', 'format.pretty', 'format:%N']);
  assert.match(f.raw(['log', '-1']), new RegExp(protectedText));
  assert.doesNotMatch(await gitRead(f.cwd, 'log', [], ['HEAD']), new RegExp(protectedText));
});

test('Git 历史路径：follow/rename 与 shallow 不扩大字面 pathspec', { timeout: 90_000 }, async t => {
  const f = await fixture(t); await mkdir(path.join(f.cwd, 'private'));
  await writeFile(path.join(f.cwd, 'private/old.txt'), `${protectedText}\n`);
  f.raw(['add', '.']); f.raw(['commit', '-m', 'private']);
  f.raw(['mv', 'private/old.txt', 'public/moved.txt']); f.raw(['commit', '-m', 'move']);
  f.raw(['config', 'log.follow', 'true']); f.raw(['config', 'diff.renames', 'true']);
  const normal = f.raw(['log', '-p', '--follow', '--', 'public/moved.txt']);
  assert.match(normal, /private\/old.txt/);
  const restricted = await gitRead(f.cwd, 'log', ['-p'], ['HEAD'], ['public/moved.txt']);
  assert.doesNotMatch(restricted, /private\/old.txt/);
  await assert.rejects(gitRead(f.cwd, 'log', ['--follow'], ['HEAD'], ['public/moved.txt']), /选项/);
  const head = f.raw(['rev-parse', 'HEAD']).trim(); await writeFile(path.join(f.cwd, '.git/shallow'), `${head}\n`);
  assert.doesNotMatch(await gitRead(f.cwd, 'log', ['-p'], ['HEAD'], ['public/file.txt']), /private\/old.txt/);
  // shallow 仅截断祖先，不能将 private 的 patch 加入 public/file.txt。
  assert.doesNotMatch(f.raw(['log', '-p', 'HEAD', '--', 'public/file.txt']), new RegExp(protectedText));
});

test('R2：缺失 promisor 对象触发 SSH/helper 正控，查询及检出零执行；旧 Git 防线不依赖 NO_LAZY_FETCH', { timeout: 120_000 }, async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.cwd, 'public/file.txt'), 'CHANGED-CONTENT\n');
  f.raw(['add', '.']); f.raw(['commit', '-m', 'changed']);
  const head = f.raw(['rev-parse', 'HEAD']).trim();
  const blob = f.raw(['rev-parse', 'HEAD:public/file.txt']).trim();
  f.raw(['tag', 'missing', blob]);
  await rm(path.join(f.cwd, '.git/objects', blob.slice(0, 2), blob.slice(2)));
  f.raw(['config', 'remote.origin.promisor', 'true']); f.raw(['config', 'remote.origin.partialclonefilter', 'blob:none']);
  f.raw(['config', 'core.sshCommand', f.probe('ssh')]);
  await f.program('git-remote-agoraprobe', 'helper');
  const oldPath = process.env.PATH; process.env.PATH = f.env.PATH;
  t.after(() => { process.env.PATH = oldPath; });
  for (const [kind, url, protocol] of [['ssh', 'ssh://unreachable.invalid/repo', 'ssh'], ['helper', 'agoraprobe::fixture', 'agoraprobe']]) {
    f.raw(['config', 'core.unsetenvvars', '']);
    f.raw(['config', 'remote.origin.url', url]);
    f.raw(['config', `protocol.${protocol}.allow`, 'always']);
    await f.positive(kind, () => f.raw(['show', 'HEAD:public/file.txt']));
    // 仅 protocol.allow 是 fallback；显式 per-protocol 配置必须由空 allowlist 覆盖。
    await f.positive(kind, () => f.raw(['-c', 'protocol.allow=never', 'show', 'HEAD:public/file.txt']));
    assert.throws(() => f.raw(['-c', 'protocol.allow=never', 'show', 'HEAD:public/file.txt'], undefined, { GIT_ALLOW_PROTOCOL: '' }));
    assert.deepEqual(await f.markers(), [], '不使用 NO_LAZY_FETCH 仍必须阻止传输程序');
    f.raw(['config', 'core.unsetenvvars', 'GIT_ALLOW_PROTOCOL,GIT_NO_LAZY_FETCH,GIT_CONFIG_PARAMETERS']);
    if (process.platform === 'win32') {
      await f.positive(kind, () => f.raw(['-c', 'protocol.allow=never', 'show', 'HEAD:public/file.txt'], undefined, { GIT_ALLOW_PROTOCOL: '' }));
    } else t.diagnostic('core.unsetenvvars 为 Windows 专属；其它平台仍覆盖相同安全前缀。');
    assert.throws(() => f.raw(['-c', 'protocol.allow=never', '-c', 'core.unsetenvvars=', 'show', 'HEAD:public/file.txt'], undefined, { GIT_ALLOW_PROTOCOL: '' }));
    assert.deepEqual(await f.markers(), [], '固定 unsetenvvars 防止子 Git 丢失传输限制');
    for (const command of ['log', 'show', 'diff']) {
      await assert.rejects(gitRead(f.cwd, command, ['-p'], command === 'diff' ? ['HEAD~1', 'HEAD'] : ['HEAD'], ['public/file.txt']));
      assert.deepEqual(await f.markers(), [], `${kind}/${command}`);
    }
    // rev-parse 的 commit 类型解引用遇到缺失对象也必须失败关闭。
    await assert.rejects(gitRead(f.cwd, 'show', [], ['missing']));
    assert.deepEqual(await f.markers(), []);
    const target = path.join(f.root, `checkout-${kind}`);
    await gitExec(f.cwd, ['worktree', 'add', '--no-checkout', '--detach', target, head]);
    await assert.rejects(gitExec(target, ['reset', '--hard', head]));
    assert.deepEqual(await f.markers(), [], `${kind}/reset`);
    await assert.rejects(new Worktrees({}, path.join(f.root, `managed-${kind}`)).create(f.cwd, `missing-${kind}`));
    assert.deepEqual(await f.markers(), [], `${kind}/worktree`);
    f.raw(['config', '--unset-all', `protocol.${protocol}.allow`]);
  }
  const env = gitEnvironment(); assert.equal(env.GIT_NO_LAZY_FETCH, '1'); assert.equal(env.GIT_ALLOW_PROTOCOL, '');
});
