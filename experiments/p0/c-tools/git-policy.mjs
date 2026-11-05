import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { canonicalPath, isWithin } from './path-policy.mjs';
const exec = promisify(execFile);

export function gitEnv(input = process.env) {
  const env = { ...input, GIT_CONFIG_NOSYSTEM: '1', GIT_PAGER: 'cat', PAGER: 'cat', GIT_EXTERNAL_DIFF: '', GIT_TERMINAL_PROMPT: '0' };
  for (const key of Object.keys(env)) {
    if (['GIT_DIR', 'GIT_WORK_TREE', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT'].includes(key) || /^GIT_CONFIG_(KEY|VALUE)_/.test(key)) delete env[key];
  }
  return env;
}

function validate({ command, options = [], revision, paths = [] }) {
  if (!['status', 'diff', 'log', 'show'].includes(command)) throw new Error('command not allowed');
  for (let i = 0; i < options.length; i++) {
    const option = options[i];
    if (command === 'status') throw new Error('status options not allowed');
    if (['--stat', '--name-only', '--name-status', '--oneline'].includes(option)) continue;
    if (option === '-p' && ['log', 'show'].includes(command)) continue;
    if (option === '--cached' && command === 'diff') continue;
    if (/^-U\d{1,4}$/.test(option)) continue;
    if (['--format=oneline', '--format=short', '--format=medium', '--format=full'].includes(option)) continue;
    if (option === '-n' && ['log', 'show'].includes(command) && /^\d{1,4}$/.test(options[i + 1] ?? '')) { i++; continue; }
    throw new Error(`option not allowed: ${option}`);
  }
  if (revision !== undefined && (!/^[A-Za-z0-9_][A-Za-z0-9_./~^\-]*$/.test(revision) || revision.includes('...') || revision.includes('//'))) throw new Error('revision not allowed');
  if (command === 'status' && revision !== undefined) throw new Error('status revision not allowed');
  if (command === 'show' && !revision) throw new Error('show requires revision');
  if (!paths.every(p => typeof p === 'string' && p.length && !p.startsWith(':'))) throw new Error('path not allowed');
}

export async function hardenedGit(cwd, input, { env = process.env, protectedPaths = [] } = {}) {
  validate(input);
  const runEnv = gitEnv(env);
  const prefix = ['--no-pager', '--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.pager=cat', '-c', 'color.ui=never', '-c', 'log.showSignature=false'];
  const config = await exec('git', ['config', '--get-regexp', '^filter\\.'], { cwd, env: runEnv, timeout: 30_000, maxBuffer: 1_048_576 }).catch(error => {
    if (error.code === 1 && !error.stdout) return { stdout: '' };
    throw error;
  });
  const drivers = new Set(config.stdout.split('\n').map(line => /^filter\.(.*)\.(?:clean|smudge|process|required)\s/i.exec(line)?.[1]).filter(Boolean));
  for (const driver of drivers) for (const attr of ['clean', 'smudge', 'process']) prefix.push('-c', `filter.${driver}.${attr}=`);
  for (const p of input.paths ?? []) {
    const real = await canonicalPath(p, cwd, 'write');
    if (!isWithin(await canonicalPath(cwd, cwd, 'write'), real)) throw new Error('git path outside root');
    for (const denied of protectedPaths) if (isWithin(await canonicalPath(denied, cwd, 'write'), real)) throw new Error('git protected path');
  }
  const command = input.command;
  let flags;
  if (command === 'status') flags = ['--porcelain=v1', '--ignore-submodules=all', '--untracked-files=normal'];
  else flags = ['--no-ext-diff', '--no-textconv', '--no-color', ...(['log', 'show'].includes(command) ? ['--no-show-signature'] : []), ...(input.options ?? [])];
  const argv = [...prefix, command, ...flags, ...(input.revision ? [input.revision] : []), '--', ...(input.paths ?? [])];
  const result = await exec('git', argv, { cwd, env: runEnv, timeout: 30_000, maxBuffer: 1_048_576 });
  return { argv, stdout: result.stdout, stderr: result.stderr };
}
