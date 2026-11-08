import { isUtf8 } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { setImmediate as yieldToLoop } from "node:timers/promises";
import { isIncompleteJson } from "./json-prefix.js";

import type { SessionEntry } from "@pi-agora/protocol";
export type { SessionEntry } from "@pi-agora/protocol";

export interface SessionHeader {
  type: "session";
  id: string;
  version?: number;
  [key: string]: unknown;
}

export interface SessionDiagnostic {
  /** 物理行号从 1 开始；0 表示文件级诊断。 */
  line: number;
  kind: string;
  message: string;
}

export interface ParsedSession {
  entries: SessionEntry[];
  /** pi 重新打开文件时的叶子，不代表运行中未落盘的导航位置。 */
  leafId: string | null;
  /** 文件中的原版本；省略版本的合法头部视为 v1。 */
  version: number | null;
  diagnostics: SessionDiagnostic[];
  /** SHA-256 覆盖读取的原始字节，包括损坏行和未完成的 UTF-8 字符。 */
  hash: string;
  bytes: number;
  header: SessionHeader | null;
  status: "ok" | "empty" | "invalid";
  /** v1 的 ID 仅在本次读取结果中有效，不能用作持久游标。 */
  idsStable: boolean;
}

type RawEntry = Record<string, unknown>;
type LocatedEntry = { entry: RawEntry; line: number };

function isRecord(value: unknown): value is RawEntry {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const READ_BYTES = 64 * 1024;
const ENTRY_BATCH = 256;

/** 只允许行末 UTF-8 码点未写完；非法字节和过长编码仍属于损坏。 */
function isIncompleteUtf8(raw: Buffer): boolean {
  let start = raw.length - 1;
  while (start >= 0 && raw.length - start <= 3 && (raw[start] & 0xc0) === 0x80) start--;
  if (start < 0 || raw.length - start > 3) return false;
  const lead = raw[start];
  const width = lead >= 0xc2 && lead <= 0xdf ? 2
    : lead >= 0xe0 && lead <= 0xef ? 3 : lead >= 0xf0 && lead <= 0xf4 ? 4 : 0;
  if (width <= raw.length - start || !isUtf8(raw.subarray(0, start))) return false;
  const second = raw[start + 1];
  if (second !== undefined && ((lead === 0xe0 && second < 0xa0) || (lead === 0xed && second > 0x9f)
    || (lead === 0xf0 && second < 0x90) || (lead === 0xf4 && second > 0x8f))) return false;
  return true;
}

/**
 * 流式读取 pi v1/v2/v3 JSONL，仅在内存中迁移，不调用 SessionManager。
 * 文件系统错误（包括 ENOENT）原样抛出，由上层区分缺文件和访问失败。
 * incomplete-json 表示合法 JSON 前缀，invalid-json 表示已发现语法损坏；
 * 两者都跳过，位置在文件中间时也使用同一分类。
 */
export async function parseSessionFile(file: string): Promise<ParsedSession> {
  const digest = createHash("sha256");
  const diagnostics: SessionDiagnostic[] = [];
  const all: LocatedEntry[] = [];
  let bytes = 0;
  let lineNo = 0;
  let firstParsed = false;
  let invalidHeader = false;
  let header: SessionHeader | null = null;
  let version: number | null = null;
  let parts: Buffer[] = [];
  let partBytes = 0;

  const diagnose = (line: number, kind: string, message: string) => {
    diagnostics.push({ line, kind, message });
  };

  const parseLine = async (raw: Buffer) => {
    lineNo++;
    const text = raw.toString("utf8");
    if (!text.trim()) return;
    const validUtf8 = isUtf8(raw);
    if (!validUtf8 && !isIncompleteUtf8(raw)) {
      diagnose(lineNo, "invalid-encoding", "JSON 行包含无效 UTF-8 字节，已跳过。");
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      const incomplete = await isIncompleteJson(text);
      diagnose(lineNo, incomplete ? "incomplete-json" : "invalid-json",
        incomplete ? "JSON 行尚未写入完整，已跳过。" : "JSON 行存在语法损坏，已跳过。");
      return;
    }
    if (!validUtf8) {
      diagnose(lineNo, "invalid-encoding", "JSON 行包含无效 UTF-8 字节，已跳过。");
      return;
    }
    if (!firstParsed) {
      firstParsed = true;
      if (!isRecord(value) || value.type !== "session" || typeof value.id !== "string") {
        invalidHeader = true;
        diagnose(lineNo, "invalid-header", "首个可解析的 JSON 值不是带字符串 id 的 session 头部。");
        return;
      }
      const sourceVersion = value.version ?? 1;
      if (sourceVersion !== 1 && sourceVersion !== 2 && sourceVersion !== 3) {
        invalidHeader = true;
        diagnose(lineNo, "unsupported-version", "会话版本不受支持，仅支持 v1、v2 和 v3。");
        return;
      }
      header = value as SessionHeader;
      version = sourceVersion;
    }
    if (invalidHeader) return;
    if (!isRecord(value) || typeof value.type !== "string") {
      diagnose(lineNo, "invalid-entry", "会话条目必须是带字符串 type 的对象，已跳过。");
      return;
    }
    all.push({ entry: value, line: lineNo });
  };

  const stream = createReadStream(file, { highWaterMark: READ_BYTES });
  for await (const chunk of stream) {
    const raw = chunk as Buffer;
    bytes += raw.length;
    digest.update(raw);
    let start = 0;
    let end = raw.indexOf(10);
    while (end !== -1) {
      const segment = raw.subarray(start, end);
      const line = partBytes === 0 ? segment : Buffer.concat([...parts, segment], partBytes + segment.length);
      parts = [];
      partBytes = 0;
      await parseLine(line);
      if (lineNo % ENTRY_BATCH === 0) await yieldToLoop();
      start = end + 1;
      end = raw.indexOf(10, start);
    }
    if (start < raw.length) {
      const rest = raw.subarray(start);
      parts.push(rest);
      partBytes += rest.length;
    }
    // 即使单行跨越多个读取块，也定期让出事件循环。
    await yieldToLoop();
  }
  if (partBytes > 0) await parseLine(Buffer.concat(parts, partBytes));

  const result: ParsedSession = {
    entries: [], leafId: null, version, diagnostics, hash: digest.digest("hex"), bytes,
    header, status: bytes === 0 ? "empty" : "invalid", idsStable: version !== 1,
  };
  if (!header || invalidHeader) {
    if (bytes > 0 && !firstParsed) diagnose(0, "invalid-header", "文件中没有可解析的 session 头部。");
    return result;
  }

  const temporaryScope = version === 1 ? randomUUID() : "";
  let previous: string | null = null;
  for (let i = 0; i < all.length; i++) {
    if (i % ENTRY_BATCH === 0) await yieldToLoop();
    const { entry, line } = all[i];
    if (entry.type === "session") {
      if (version !== null && version < 3) entry.version = 3;
      continue;
    }
    if (version === 1) {
      entry.id = `v1:${temporaryScope}:${i}`;
      entry.parentId = previous;
      previous = entry.id as string;
      if (entry.type === "compaction" && typeof entry.firstKeptEntryIndex === "number") {
        // pi 的索引包含 session 头部及此前所有可解析条目。
        const target = all[entry.firstKeptEntryIndex]?.entry;
        if (target && target.type !== "session") entry.firstKeptEntryId = target.id;
        delete entry.firstKeptEntryIndex;
      }
    }
    if (version !== null && version < 3 && entry.type === "message"
      && isRecord(entry.message) && entry.message.role === "hookMessage") {
      entry.message.role = "custom";
    }
    if (typeof entry.id !== "string" || !(entry.parentId === null || typeof entry.parentId === "string")) {
      diagnose(line, "invalid-entry", "会话条目的 id 或 parentId 无效，已跳过。");
      continue;
    }
    const typed = entry as SessionEntry;
    result.entries.push(typed);
    result.leafId = typed.id;
  }
  result.status = "ok";
  return result;
}
