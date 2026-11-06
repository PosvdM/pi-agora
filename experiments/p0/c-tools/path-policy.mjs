import { realpath, lstat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

export function resolveInput(input, cwd) {
  let value = input.replace(/^@/, '').replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, ' ');
  if (value.startsWith('file://')) value = fileURLToPath(value);
  if (value === '~' || value.startsWith('~/') || value.startsWith('~\\')) value = homedir() + value.slice(1);
  if (process.platform === 'win32') value = value.replace(/^\/(?:mnt\/)?([a-z])\//i, '$1:/');
  return path.resolve(cwd, value);
}

export function resolveRead(input, cwd) {
  const resolved = resolveInput(input, cwd);
  const nfd = resolved.normalize('NFD');
  return [resolved, resolved.replace(/ (AM|PM)\./gi, '\u202f$1.'), nfd,
    resolved.replace(/'/g, '\u2019'), nfd.replace(/'/g, '\u2019')].find(existsSync) ?? resolved;
}

export async function canonicalPath(input, cwd, mode = 'read') {
  const resolved = mode === 'read' ? resolveRead(input, cwd) : resolveInput(input, cwd);
  let ancestor = resolved;
  const suffix = [];
  for (;;) {
    try { return path.join(await realpath(ancestor), ...suffix); }
    catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
      // A dangling symlink must fail closed, not become a nonexistent ordinary path.
      try { if ((await lstat(ancestor)).isSymbolicLink()) throw new Error('dangling symlink'); }
      catch (inner) { if (inner.code !== 'ENOENT') throw inner; }
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      suffix.unshift(path.basename(ancestor));
      ancestor = parent;
    }
  }
}

export function comparisonKey(value) {
  if (process.platform === 'win32') return value.replace(/^\\\\\?\\/, '').replaceAll('/', '\\').toLowerCase();
  return process.platform === 'darwin' ? value.normalize('NFC').toLowerCase() : value;
}

export function isWithin(root, target) {
  const r = comparisonKey(root), t = comparisonKey(target);
  return t === r || t.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}

export async function checkPath(tool, input, cwd, config) {
  const readLike = tool === 'read';
  const target = await canonicalPath(input.path ?? '.', cwd, readLike ? 'read' : 'write');
  const protectedPaths = await Promise.all(config.protectedPaths.map(p => canonicalPath(p, cwd, 'write')));
  if (protectedPaths.some(root => isWithin(root, target))) throw new Error('protected path');
  if (['grep', 'find', 'ls'].includes(tool) && protectedPaths.some(p => isWithin(target, p))) {
    throw new Error('search root contains protected path');
  }
  if (config.profile !== 'implement') {
    const roots = await Promise.all([cwd, ...(config.readRoots ?? [])].map(p => canonicalPath(p, cwd, 'write')));
    if (!roots.some(root => isWithin(root, target))) throw new Error('outside allowed roots');
  }
  return target;
}
