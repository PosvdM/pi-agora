import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { gitEnvironment } from '../../packages/protocol/dist/git.js';

export const quote = value => `'${value.replaceAll('\\', '/').replaceAll("'", "'\\''")}'`;
export async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'agora-git-security-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'repo'), bin = path.join(root, 'bin');
  await mkdir(path.join(cwd, 'public'), { recursive: true }); await mkdir(bin);
  const env = gitEnvironment();
  for (const key of ['GIT_ALLOW_PROTOCOL', 'GIT_NO_LAZY_FETCH', 'GIT_NO_REPLACE_OBJECTS', 'GIT_GRAFT_FILE', 'GIT_EXTERNAL_DIFF', 'GIT_PAGER']) delete env[key];
  delete env.PAGER;
  env.PATH = `${bin}${path.delimiter}${env.PATH}`;
  const raw = (args, input, extraEnv = {}, directory = cwd) => execFileSync('git', args, {
    cwd: directory, env: { ...env, ...extraEnv }, input, timeout: 15_000, maxBuffer: 8 * 1024 * 1024,
    windowsHide: true, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.diagnostic(raw(['--version']).trim());
  raw(['init', '--initial-branch=main']); raw(['config', 'user.name', 'Visible']);
  raw(['config', 'user.email', 'visible@example.invalid']); raw(['config', 'core.autocrlf', 'false']);
  raw(['config', 'commit.gpgsign', 'false']);
  await writeFile(path.join(cwd, 'public/file.txt'), 'PUBLIC-CONTENT\n');
  raw(['add', '.']); raw(['commit', '-m', 'public']);
  const oracle = path.join(root, 'markers.jsonl'), script = path.join(root, 'probe.mjs');
  await writeFile(script, `import { appendFileSync } from 'node:fs';
appendFileSync(process.argv[2], JSON.stringify({ kind: process.argv[3], pid: process.pid }) + '\\n');
process.exitCode = 1;
`);
  const probe = kind => `${quote(process.execPath)} ${quote(script)} ${quote(oracle)} ${quote(kind)}`;
  const program = async (name, kind = name) => {
    const file = path.join(bin, name);
    await writeFile(file, `#!/bin/sh\nexec ${probe(kind)} "$@"\n`); await chmod(file, 0o755);
    return file.replaceAll('\\', '/');
  };
  const markers = async () => existsSync(oracle) ? (await readFile(oracle, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const clear = () => rm(oracle, { force: true });
  const positive = async (kind, action) => {
    let failure;
    try { await action(); } catch (error) { failure = error; }
    const records = await markers();
    assert.ok(records.some(record => record.kind === kind), `${kind} 正控必须执行：${failure?.stderr ?? failure ?? ''}`);
    for (const { pid } of records) {
      // 等待短命探针的退出状态在 Windows 进程表中可见。
      let alive = true;
      for (let attempt = 0; attempt < 40 && alive; attempt++) {
        try { process.kill(pid, 0); await new Promise(resolve => setTimeout(resolve, 25)); }
        catch (error) { if (error.code === 'ESRCH') alive = false; else throw error; }
      }
      assert.equal(alive, false, `探针 ${pid} 不得遗留运行进程`);
    }
    await clear();
  };
  return { root, cwd, bin, env, raw, probe, program, markers, clear, positive };
}
