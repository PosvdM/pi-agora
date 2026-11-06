import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadNative, snapshot } from '../prototype.mjs';

export const toolDir = dirname(fileURLToPath(import.meta.url));
// The pointer lives next to the tools so a new terminal window finds it regardless of its environment.
export const statePath = () => process.env.MANUAL_CLOSE_STATE ?? join(toolDir, '.state', 'current.json');
export const recordsDir = () => process.env.MANUAL_CLOSE_RECORDS ?? join(tmpdir(), 'e-hostkit-manual-close-records');
export const evidencePath = join(toolDir, 'evidence.jsonl');

export const files = root => ({
  addon: join(root, 'build', 'hostkit.node'),
  daemonInfo: join(root, 'daemon.json'),
  heartbeat: join(root, 'heartbeat'),
  cleanupOracle: join(root, 'cleanup-oracle.jsonl'),
  terminalOracle: join(root, 'oracle.jsonl'),
  ready: join(root, 'manual-state.json'),
  meta: join(root, 'manual-meta.json'),
});

export function readJson(path) {
  if (!existsSync(path)) return undefined;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return undefined; }
}
export function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const staging = `${path}.${process.pid}.next`;
  writeFileSync(staging, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(staging, path);
}
export function readPointer() { return readJson(statePath()); }

export function openNative(pointer) {
  return existsSync(pointer.addonPath) ? loadNative(pointer.addonPath) : undefined;
}
// Same rule as prototype.isSameProcess: PID and creation time must both match, zombies count as gone.
export function liveProcess(native, id) {
  if (!id) return undefined;
  return snapshot(native).find(p => p.pid === id.pid && p.startTime === id.startTime && p.status !== 5);
}
export function fileSize(path) { try { return statSync(path).size; } catch { return undefined; } }
export const yesNo = value => value === true ? '是' : value === false ? '否' : '未知';
