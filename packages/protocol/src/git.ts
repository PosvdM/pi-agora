import { execFile } from 'node:child_process';

export function gitEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...source };
  for (const key of Object.keys(env)) if (/^GIT_/i.test(key)) delete env[key];
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_PAGER: 'cat', PAGER: 'cat', GIT_EXTERNAL_DIFF: '', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
}
const prefix = ['--no-pager', '--no-optional-locks', '-c', 'core.fsmonitor=', '-c', 'core.pager=cat',
  '-c', 'color.ui=never', '-c', 'log.showSignature=false', '-c', 'core.hooksPath=/dev/null'];
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
export async function gitRead(cwd: string, command: string, options: string[] = [], refs: string[] = [], paths: string[] = [], signal?: AbortSignal): Promise<string> {
  if (!['status', 'diff', 'log', 'show'].includes(command)) throw new Error('git 子命令不在允许列表中');
  if (![options, refs, paths].every(v => Array.isArray(v) && v.length <= 100 && v.every(x => typeof x === 'string' && !x.includes('\0')))) throw new Error('git 参数无效');
  for (const value of options) {
    const allowed = command === 'status' ? false : /^(--stat|--name-only|--name-status|--oneline|-p|--format=(oneline|short|medium|fuller)|-n[1-9][0-9]{0,3}|-U[0-9]{1,4})$/.test(value) || command === 'diff' && value === '--cached';
    if (!allowed) throw new Error('git 选项不在允许列表中');
  }
  if (command === 'status' && refs.length || command === 'show' && refs.length !== 1 || refs.length > (command === 'diff' ? 2 : 1)) throw new Error('git 提交参数无效');
  if (refs.some(ref => !/^[A-Za-z0-9_][A-Za-z0-9_./~^{}-]*$/.test(ref) || ref.includes('@{') || ref.includes('.../') || ref.includes(':'))) throw new Error('git 提交或范围无效');
  if (paths.some(p => p.startsWith(':'))) throw new Error('不允许 git pathspec 魔术参数');
  const args = command === 'status'
    ? ['status', '--porcelain=v1', '--ignore-submodules=all', '--untracked-files=normal']
    : [command, '--no-ext-diff', '--no-textconv', '--no-color', ...(command === 'log' || command === 'show' ? ['--no-show-signature'] : []), ...(command === 'log' ? ['-n50'] : []), ...options, ...refs];
  return gitExec(cwd, ['--literal-pathspecs', ...args, '--', ...(paths.length ? paths : ['.'])], signal);
}
export async function gitExec(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
  let config = '';
  try { config = await gitRaw(cwd, ['config', '--null', '--get-regexp', '^filter\\.'], signal); }
  catch {
    // --get-regexp 无匹配返回 1，独立读取全部配置区分无匹配与查询故障。
    config = await gitRaw(cwd, ['config', '--null', '--list'], signal);
  }
  const drivers = new Set<string>();
  for (const item of config.split('\0')) {
    const name = item.split('\n', 1)[0]!;
    const match = /^filter\.(.+)\.(clean|smudge|process|required)$/i.exec(name);
    if (match) drivers.add(match[1]!);
  }
  const filters = [...drivers].flatMap(driver => ['clean', 'smudge', 'process'].flatMap(key => ['-c', `filter.${driver}.${key}=`]).concat(['-c', `filter.${driver}.required=false`]));
  return gitRaw(cwd, [...filters, ...args], signal);
}
