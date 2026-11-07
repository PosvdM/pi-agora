import { execFile, spawn } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

export function gitEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...source };
  for (const key of Object.keys(env)) if (/^(?:GIT_|SSH_ASKPASS$|EDITOR$|VISUAL$)/i.test(key)) delete env[key];
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_PAGER: 'cat', PAGER: 'cat', GIT_EXTERNAL_DIFF: '', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0',
    GIT_ALLOW_PROTOCOL: '', GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1',
    GIT_GRAFT_FILE: process.platform === 'win32' ? 'NUL' : '/dev/null' };
}
const prefix = ['--no-pager', '--no-optional-locks', '-c', 'core.fsmonitor=', '-c', 'core.pager=cat',
  '-c', 'color.ui=never', '-c', 'log.showSignature=false', '-c', 'core.hooksPath=/dev/null',
  '-c', 'submodule.recurse=false', '-c', 'diff.submodule=short', '-c', 'diff.ignoreSubmodules=all', '-c', 'status.submoduleSummary=false',
  '-c', 'protocol.allow=never', '-c', 'core.sshCommand=false', '-c', 'core.gitProxy=false',
  '-c', 'core.askPass=', '-c', 'credential.helper=', '-c', 'credential.interactive=false',
  '-c', 'core.editor=false', '-c', 'sequence.editor=false', '-c', 'core.useReplaceRefs=false',
  '-c', 'mailmap.blob=', '-c', 'mailmap.file=', '-c', 'log.mailmap=false', '-c', 'format.pretty=medium',
  '-c', 'log.follow=false', '-c', 'diff.renames=false', '-c', 'status.renames=false',
  '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '-c', 'core.unsetenvvars=', '-c', 'advice.graftFileDeprecated=false'];
// 配置探测只读取配置，不运行工作区转换器；所有实际命令由 gitExec 加固。
async function gitRaw(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', [...prefix, ...args], { cwd, env: gitEnvironment(), timeout: 30_000,
      maxBuffer: 1024 * 1024, windowsHide: true, encoding: 'utf8', signal }, (error, stdout) => {
      if (error) reject(new Error('git 命令失败，请检查仓库状态或参数'));
      else resolve(stdout);
    });
  });
}
/** 从文件系统确定工作树边界；Git 的 show-toplevel 仅用于核验，不能作为授权根。 */
async function verifyWorktree(cwd: string, signal?: AbortSignal): Promise<void> {
  let root = await realpath(cwd);
  while (true) {
    try { await lstat(path.join(root, '.git')); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(root);
      if (parent === root) throw Object.assign(new Error('无法确定任务目录的 Git 工作树'), { code: 'EAGORA_GIT_WORKTREE_LAYOUT' });
      root = parent;
    }
  }
  const actual = await realpath((await gitRaw(cwd, ['rev-parse', '--show-toplevel'], signal)).trim());
  const normalize = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
  if (normalize(actual) !== normalize(root)) {
    throw Object.assign(new Error('Git 工作树与任务目录的仓库根不一致，请检查 core.worktree 配置'), { code: 'EAGORA_GIT_WORKTREE_MISMATCH' });
  }
}
export async function gitRead(cwd: string, command: string, options: string[] = [], refs: string[] = [], paths: string[] = [], signal?: AbortSignal): Promise<string> {
  if (!['status', 'diff', 'log', 'show'].includes(command)) throw new Error('git 子命令不在允许列表中');
  if (![options, refs, paths].every(v => Array.isArray(v) && v.length <= 100 && v.every(x => typeof x === 'string' && !x.includes('\0')))) throw new Error('git 参数无效');
  for (const value of options) {
    const allowed = command === 'status' ? false : /^(--stat|--name-only|--name-status|--oneline|-p|--format=(oneline|short|medium|fuller)|-n[1-9][0-9]{0,3}|-U[0-9]{1,4})$/.test(value) || command === 'diff' && value === '--cached';
    if (!allowed) throw new Error('git 选项不在允许列表中');
  }
  if (command === 'status' && refs.length || command === 'show' && refs.length !== 1 || refs.length > (command === 'diff' ? 2 : 1)) throw new Error('git 提交参数无效');
  const endpoints = refs.map(ref => {
    const parts = ref.split(/(\.\.\.?)/);
    if (parts.length !== 1 && parts.length !== 3) throw new Error('git 提交或范围无效');
    const values = parts.length === 3 ? [parts[0] || 'HEAD', parts[2] || 'HEAD'] : [ref];
    if (values.some(value => !/^[A-Za-z0-9_][A-Za-z0-9_./~^{}-]*$/.test(value) || value.includes('@{') || value.includes('..') || value.includes(':'))) throw new Error('git 提交或范围无效');
    return { values, separator: parts.length === 3 ? parts[1]! : '' };
  });
  if (paths.some(p => p.startsWith(':'))) throw new Error('不允许 git pathspec 魔术参数');
  const commits = new Map<string, string>();
  const resolved: string[] = [];
  for (const { values, separator } of endpoints) {
    const oids: string[] = [];
    for (const ref of values) {
      let oid = commits.get(ref);
      if (!oid) {
        oid = (await gitExec(cwd, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], signal)).trim();
        if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid)) throw new Error('git 提交对象无效');
        commits.set(ref, oid);
      }
      oids.push(oid);
    }
    resolved.push(oids.join(separator));
  }
  const args = command === 'status'
    ? ['status', '--porcelain=v1', '--ignore-submodules=all', '--untracked-files=normal']
    : [command, '--no-ext-diff', '--no-textconv', '--no-color', ...(command === 'log' || command === 'show' ? ['--no-show-signature', '--no-notes', '--no-mailmap'] : []), ...(command === 'log' ? ['-n50'] : []), ...options, ...resolved];
  return gitExec(cwd, ['--literal-pathspecs', ...args, '--', ...(paths.length ? paths : ['.'])], signal);
}
async function filterOverrides(cwd: string, signal?: AbortSignal, configContexts: string[] = []): Promise<string[]> {
  const drivers = new Set<string>();
  for (const context of new Set([cwd, ...configContexts])) {
    await verifyWorktree(context, signal);
    let config = '';
    try { config = await gitRaw(context, ['config', '--null', '--get-regexp', '^filter\\.'], signal); }
    catch {
      // --get-regexp 无匹配返回 1，独立读取全部配置区分无匹配与查询故障。
      config = await gitRaw(context, ['config', '--null', '--list'], signal);
    }
    for (const item of config.split('\0')) {
      const name = item.split('\n', 1)[0]!;
      const match = /^filter\.(.+)\.(clean|smudge|process|required)$/i.exec(name);
      if (match) drivers.add(match[1]!);
    }
  }
  const filters = [...drivers].flatMap(driver => ['clean', 'smudge', 'process'].flatMap(key => ['-c', `filter.${driver}.${key}=`]).concat(['-c', `filter.${driver}.required=false`]));
  return filters;
}
export async function gitExec(cwd: string, args: string[], signal?: AbortSignal, configContexts: string[] = []): Promise<string> {
  return gitRaw(cwd, [...await filterOverrides(cwd, signal, configContexts), ...args], signal);
}
/** 流式检查索引的 gitlink；每条记录只保留固定长度的 mode 前缀。 */
export async function gitHasGitlinks(cwd: string, signal?: AbortSignal): Promise<boolean> {
  const filters = await filterOverrides(cwd, signal);
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...prefix, ...filters, 'ls-files', '--stage', '-z'], {
      cwd, env: gitEnvironment(), windowsHide: true, signal, stdio: ['ignore', 'pipe', 'ignore'], timeout: 30_000,
    });
    let mode = '', found = false, failed = false;
    child.stdout.on('data', (chunk: Buffer) => {
      for (const byte of chunk) {
        if (byte === 0) { mode = ''; continue; }
        if (mode.length < 7) {
          mode += String.fromCharCode(byte);
          if (mode === '160000 ') found = true;
        }
      }
    });
    child.on('error', () => { failed = true; reject(new Error('git 索引检查失败')); });
    child.on('close', (code) => {
      if (failed) return;
      if (code !== 0 || signal?.aborted) reject(new Error('git 索引检查失败'));
      else resolve(found);
    });
  });
}
