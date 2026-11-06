// G 组实验共用的小工具：受控子进程、临时目录、文件哈希。
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PI_ROOT = process.env.P0_PI_ROOT ?? '/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent';

/** 本组拉起的所有子进程，按进程组终止。 */
const children = new Set();

/**
 * 以独立进程组拉起子进程并逐行收集 stdout。
 * 返回 { child, lines, waitLine(predicate, timeoutMs), exit }。
 */
export function spawnTracked(command, args, options = {}) {
  const child = spawn(command, args, { ...options, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  const lines = [];
  const waiters = new Set();
  let buffer = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let i;
    while ((i = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      lines.push(line);
      for (const w of waiters) w();
    }
  });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  const exit = new Promise((resolve) => child.once('close', (code, signal) => {
    children.delete(child);
    for (const w of waiters) w();
    resolve({ code, signal });
  }));
  const waitLine = (predicate, timeoutMs = 10_000) => new Promise((resolve, reject) => {
    const check = () => {
      const found = lines.find(predicate);
      if (found !== undefined) { cleanup(); resolve(found); return; }
      if (child.exitCode !== null || child.signalCode !== null) { cleanup(); reject(new Error(`child exited; stderr=${stderr}`)); }
    };
    const timer = setTimeout(() => { cleanup(); reject(new Error(`waitLine timeout; stderr=${stderr}`)); }, timeoutMs);
    const cleanup = () => { clearTimeout(timer); waiters.delete(check); };
    waiters.add(check);
    check();
  });
  return { child, lines, waitLine, exit, get stderr() { return stderr; } };
}

/**
 * 向子进程所在进程组发信号（POSIX）；Windows 上只能对单个进程发。
 * 子进程已退出时不发信号：它的 PID 可能已被回收并复用。
 */
export function signalGroup(child, signal) {
  if (child.exitCode !== null || child.signalCode !== null) return false;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

/** 终止仍在运行的本组子进程，返回被强制终止的 PID 列表。 */
export async function killAllTracked() {
  const killed = [];
  for (const child of [...children]) {
    if (signalGroup(child, 'SIGKILL')) killed.push(child.pid);
  }
  // 已退出但 close 尚未触发的子进程也等到 close，保证 stdout 已读完。
  await Promise.all([...children].map((child) => new Promise((resolve) => {
    child.once('close', resolve);
  })));
  return killed;
}

export function makeTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function removeDir(path) {
  rmSync(path, { recursive: true, force: true });
}

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 共用 harness 的现场收尾。harness 的 RpcDriver.stop() 先向负 PID 发 SIGTERM 再判断是否已退出，
 * e.stop()/e.cleanup() 会对所有曾经启动的 driver 再发一次；这里只停止仍在运行的 driver，
 * 然后自己删除现场目录，不调用 e.stop()/e.cleanup()。
 */
export function driverRunning(driver) {
  return driver.exitInfo === undefined && driver.child.exitCode === null && driver.child.signalCode === null;
}

export async function stopDriver(driver) {
  if (driver && driverRunning(driver)) await driver.stop();
}

export async function teardownExperiment(experiment, drivers, { remove }) {
  for (const driver of drivers) await stopDriver(driver);
  if (remove) rmSync(experiment.root, { recursive: true, force: true });
}

/**
 * 证据输出目录。默认在系统临时目录下为每次运行新建一个目录；设置 P0_RECORD=1 时写入
 * 仓库里的 experiments/p0/g-store/evidence/，刷新已提交的证据。
 */
let evidenceRoot;
export function evidenceDir() {
  if (!evidenceRoot) {
    if (process.env.P0_RECORD === '1') {
      evidenceRoot = fileURLToPath(new URL('./evidence/', import.meta.url));
      mkdirSync(evidenceRoot, { recursive: true });
    } else {
      evidenceRoot = mkdtempSync(join(tmpdir(), `g-store-evidence-${new Date().toISOString().replace(/[:.]/g, '-')}-`));
    }
  }
  return evidenceRoot;
}

export function writeEvidence(name, data) {
  const path = join(evidenceDir(), `${name}.json`);
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
  return path;
}
