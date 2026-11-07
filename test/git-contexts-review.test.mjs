import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, utimes } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { gitEnvironment, gitExec, gitRead } from '../packages/protocol/dist/git.js';
import { Worktrees } from '../packages/daemon/dist/worktrees.js';

const quote = value => `'${value.replaceAll('\\', '/').replaceAll("'", "'\\''")}'`;
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'agora-git-contexts-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'repo'); await mkdir(cwd);
  const env = gitEnvironment();
  for (const key of ['GIT_ALLOW_PROTOCOL', 'GIT_NO_LAZY_FETCH', 'GIT_NO_REPLACE_OBJECTS', 'GIT_GRAFT_FILE']) delete env[key];
  const raw = (args, directory = cwd) => execFileSync('git', args, { cwd: directory, env,
    encoding: 'utf8', timeout: 10_000, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  raw(['init', '--initial-branch=main']);
  raw(['config', 'user.name', 'Git contexts']); raw(['config', 'user.email', 'contexts@example.invalid']);
  raw(['config', 'core.autocrlf', 'false']); raw(['config', 'commit.gpgsign', 'false']);
  await writeFile(path.join(cwd, '.gitattributes'), '*.txt filter=target\n');
  await writeFile(path.join(cwd, 'file.txt'), 'base\n');
  raw(['add', '.']); raw(['commit', '-m', 'base']);
  const oracle = path.join(root, 'markers.jsonl'), script = path.join(root, 'probe.mjs');
  await writeFile(script, `import { appendFileSync, readFileSync } from 'node:fs';
appendFileSync(process.argv[2], JSON.stringify({ kind: process.argv[3], pid: process.pid }) + '\\n');
if (process.argv[3].endsWith('clean')) process.stdout.write(readFileSync(0));
`);
  const probe = kind => `${quote(process.execPath)} ${quote(script)} ${quote(oracle)} ${quote(kind)}`;
  const markers = async () => existsSync(oracle) ? (await readFile(oracle, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const clear = () => rm(oracle, { force: true });
  const rows = new Map();
  const manager = new Worktrees({
    get: (_sql, id) => rows.get(id),
    run: (_sql, id) => { rows.get(id).state = 'removed'; },
  }, path.join(root, 'worktrees'));
  const create = async id => {
    const { worktree } = await manager.create(cwd, id);
    rows.set(id, worktree); return worktree;
  };
  return { root, cwd, raw, probe, markers, clear, manager, create };
}
async function expired(directory) {
  // 改变 mtime，强制 Git 比较相同内容，不能依赖 stat 缓存跳过 filter。
  const time = new Date(Date.now() + 60_000);
  await utimes(path.join(directory, 'file.txt'), time, time);
}
async function exited(markers) {
  for (const { pid } of markers) {
    let alive = true;
    for (let attempt = 0; attempt < 40 && alive; attempt++) {
      try { process.kill(pid, 0); await new Promise(resolve => setTimeout(resolve, 50)); }
      catch (error) { if (error.code === 'ESRCH') alive = false; else throw error; }
    }
    assert.equal(alive, false, `正控进程 ${pid} 必须退出`);
  }
}

test('N2：worktree remove 覆盖 onbranch/gitdir 的 clean/process，保留非 force 脏内容保护', { timeout: 120_000 }, async t => {
  const f = await fixture(t);
  for (const condition of ['onbranch', 'gitdir']) {
    for (const kind of ['clean', 'process']) {
      const label = `${condition}-${kind}`, config = path.join(f.root, `${label}.config`);
      f.raw(['config', '--file', config, `filter.target.${kind}`, f.probe(label)]);
      f.raw(['config', '--file', config, 'filter.target.required', 'true']);
      f.raw(['config', '--file', config, 'core.fsmonitor', f.probe(`${label}-fsmonitor`)]);
      const key = condition === 'onbranch' ? 'includeIf.onbranch:agora/**.path'
        : `includeIf.gitdir:${(await realpath(path.join(f.cwd, '.git'))).replaceAll('\\', '/')}/worktrees/**.path`;
      f.raw(['config', key, config.replaceAll('\\', '/')]);
      assert.throws(() => f.raw(['config', '--get', `filter.target.${kind}`]));
      const positive = await f.create(`positive-${label}`);
      assert.deepEqual(await f.markers(), []);
      await expired(positive.path);
      let code = 0;
      try { f.raw(['worktree', 'remove', positive.path]); } catch (error) { code = error.status; }
      assert.equal(kind === 'clean' ? code === 0 : code !== 0, true, `${label} 正控退出码 ${code}`);
      const controls = await f.markers();
      assert.ok(controls.some(marker => marker.kind === label), `${label} 正控必须执行 filter`);
      await exited(controls); await f.clear();

      const negative = await f.create(`negative-${label}`);
      await expired(negative.path);
      await f.manager.remove(negative.task_id, false);
      assert.equal(negative.state, 'removed'); assert.equal(existsSync(negative.path), false);
      assert.deepEqual(await f.markers(), [], `${label} 加固清理不能执行程序`);

      const dirty = await f.create(`dirty-${label}`);
      await writeFile(path.join(dirty.path, 'file.txt'), 'DIRTY-CONTENT\n'); await expired(dirty.path);
      await assert.rejects(f.manager.remove(dirty.task_id, false), error => error.code === 'worktree_dirty');
      assert.equal(dirty.state, 'active'); assert.equal(await readFile(path.join(dirty.path, 'file.txt'), 'utf8'), 'DIRTY-CONTENT\n');
      assert.deepEqual(await f.markers(), []);
      await f.manager.remove(dirty.task_id, true);
      assert.equal(dirty.state, 'removed'); assert.deepEqual(await f.markers(), []);
      f.raw(['config', '--unset-all', key]);
    }
  }
});

test('N2：子模块不递归查询或检出，含 gitlink 的 worktree 拒绝自动清理', { timeout: 90_000 }, async t => {
  const f = await fixture(t), source = path.join(f.root, 'child-source'); await mkdir(source);
  f.raw(['init', '--initial-branch=main'], source);
  f.raw(['config', 'user.name', 'Child'], source); f.raw(['config', 'user.email', 'child@example.invalid'], source);
  await writeFile(path.join(source, '.gitattributes'), '*.txt filter=child\n');
  await writeFile(path.join(source, 'file.txt'), 'child\n');
  f.raw(['add', '.'], source); f.raw(['-c', 'commit.gpgsign=false', 'commit', '-m', 'child'], source);
  f.raw(['-c', 'protocol.file.allow=always', 'submodule', 'add', source, 'modules/lib']);
  f.raw(['commit', '-am', 'submodule']);
  const row = await f.create('with-submodule');
  await assert.rejects(f.manager.remove(row.task_id, false), error => error.code === 'worktree_submodules');
  assert.equal(row.state, 'active');
  f.raw(['-C', row.path, '-c', 'protocol.file.allow=always', 'submodule', 'update', '--init']);
  const child = path.join(row.path, 'modules/lib');
  f.raw(['config', 'filter.child.clean', f.probe('child-clean')], child);
  f.raw(['config', 'filter.child.required', 'true'], child);
  await expired(child);
  f.raw(['status', '--porcelain', '--ignore-submodules=none'], row.path);
  const controls = await f.markers(); assert.ok(controls.some(marker => marker.kind === 'child-clean'));
  await exited(controls); await f.clear();
  f.raw(['config', 'submodule.recurse', 'true']);
  f.raw(['config', 'diff.submodule', 'diff']);
  f.raw(['config', 'status.submoduleSummary', 'true']);
  for (const command of ['status', 'diff', 'log', 'show']) {
    const refs = command === 'show' || command === 'log' ? ['HEAD'] : [];
    await expired(child); await gitRead(row.path, command, [], refs);
    assert.deepEqual(await f.markers(), [], `${command} 不能进入子模块`);
  }
  await expired(child); await gitExec(row.path, ['reset', '--hard', 'HEAD']);
  assert.deepEqual(await f.markers(), []);
  for (const discard of [false, true]) {
    await assert.rejects(f.manager.remove(row.task_id, discard), error => error.code === 'worktree_submodules');
    assert.equal(row.state, 'active'); assert.equal(existsSync(row.path), true);
    assert.deepEqual(await f.markers(), []);
  }
});
