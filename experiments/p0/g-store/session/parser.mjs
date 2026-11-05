// pi 会话 JSONL 的只读解析器原型（archive adapter 与 pi-pane 只读视图共用的逻辑）。
//
// 只用 readFileSync 读取，不创建、不写入、不重命名任何文件。解析规则按 pi 1.5.0 的
// dist/core/session-manager.js（loadEntriesFromFile、migrateToCurrentVersion、_buildIndex、getBranch）：
// - 空行和无法解析的行跳过；最后一行没有换行符时照样尝试解析，能解析就保留（与 pi 相同），
//   解析失败视为写入中途中断的截断行，记入 diagnostics；
// - 第一个能解析的条目必须是带字符串 id 的 session 头，否则视为无效文件；
// - 旧版本在内存中迁移到 v3：v1 补 id/parentId（线性链），compaction 的 firstKeptEntryIndex 换成
//   firstKeptEntryId；v2 把 message.role 为 hookMessage 的改成 custom；
// - 条目列表不含 type 为 session 的行，叶子是文件中最后一个条目，活动分支从叶子沿 parentId 回到根。
//
// v1 文件没有 id，pi 迁移时用随机 id。只读解析无法重现这些 id，这里改用由会话 id 和行序号
// 派生的确定性 id，保证同一文件多次解析结果相同。
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

export const CURRENT_SESSION_VERSION = 3;

function deterministicId(sessionId, index, used) {
  for (let salt = 0; ; salt++) {
    const id = createHash('sha256').update(`${sessionId}:${index}:${salt}`).digest('hex').slice(0, 8);
    if (!used.has(id)) { used.add(id); return id; }
  }
}

function migrateV1ToV2(all, sessionId) {
  const used = new Set();
  let prevId = null;
  for (const entry of all) {
    if (entry.type === 'session') { entry.version = 2; continue; }
    entry.id = deterministicId(sessionId, all.indexOf(entry), used);
    entry.parentId = prevId;
    prevId = entry.id;
    if (entry.type === 'compaction' && typeof entry.firstKeptEntryIndex === 'number') {
      // 与 pi 相同：索引指向包含 session 头在内的条目数组。
      const target = all[entry.firstKeptEntryIndex];
      if (target && target.type !== 'session') entry.firstKeptEntryId = target.id;
      delete entry.firstKeptEntryIndex;
    }
  }
}

function migrateV2ToV3(all) {
  for (const entry of all) {
    if (entry.type === 'session') { entry.version = 3; continue; }
    if (entry.type === 'message' && entry.message?.role === 'hookMessage') entry.message.role = 'custom';
  }
}

/** 从叶子沿 parentId 回到根，返回根在前的条目数组（archive.md 的投影②）。 */
export function activeBranch(entries, leafId) {
  if (leafId == null) return [];
  const byId = new Map();
  for (const entry of entries) byId.set(entry.id, entry);
  const path = [];
  const seen = new Set();
  let current = byId.get(leafId);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    path.push(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return path.reverse();
}

/**
 * 解析会话文件。返回：
 * { status: 'ok' | 'empty' | 'invalid' | 'missing', header, version, entries, leafId, branch, diagnostics }
 */
export function parseSessionFile(path) {
  let bytes;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    if (error.code === 'ENOENT') return result('missing');
    throw error;
  }
  const diagnostics = { size: bytes.length, malformedLines: [], tailWithoutNewline: false, truncatedTail: false, migratedFrom: null };
  if (bytes.length === 0) return result('empty', { diagnostics });

  const text = bytes.toString('utf8');
  const segments = text.split('\n');
  const tail = segments.pop(); // 最后一个换行之后的内容；文件以换行结尾时为空串
  const all = [];
  const parseLine = (line, lineNo, isTail) => {
    if (!line.trim()) return;
    try {
      all.push(JSON.parse(line));
    } catch {
      if (isTail) diagnostics.truncatedTail = true;
      else diagnostics.malformedLines.push(lineNo);
    }
  };
  segments.forEach((line, i) => parseLine(line, i + 1, false));
  if (tail) {
    diagnostics.tailWithoutNewline = true;
    parseLine(tail, segments.length + 1, true);
  }

  const header = all[0];
  if (!header || header.type !== 'session' || typeof header.id !== 'string') {
    return result('invalid', { diagnostics });
  }
  const version = header.version ?? 1;
  if (version < CURRENT_SESSION_VERSION) {
    diagnostics.migratedFrom = version;
    if (version < 2) migrateV1ToV2(all, header.id);
    migrateV2ToV3(all);
  }
  const entries = all.filter((entry) => entry.type !== 'session');
  const leafId = entries.length ? entries[entries.length - 1].id : null;
  return result('ok', { header, version, entries, leafId, branch: activeBranch(entries, leafId), diagnostics });

  function result(status, extra = {}) {
    return { status, header: null, version: null, entries: [], leafId: null, branch: [], diagnostics: null, ...extra };
  }
}

/** 解析并核对文件在解析前后未被改动（内容哈希、大小、mtime）。 */
export function parseAndVerifyUnchanged(path) {
  const before = fingerprint(path);
  const parsed = parseSessionFile(path);
  const after = fingerprint(path);
  return { parsed, before, after };
}

export function fingerprint(path) {
  try {
    const stat = statSync(path);
    return { sha256: createHash('sha256').update(readFileSync(path)).digest('hex'), size: stat.size, mtimeMs: stat.mtimeMs };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
