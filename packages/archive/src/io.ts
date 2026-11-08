import { createReadStream } from "node:fs";
import { realpath, stat, lstat, readlink } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { setImmediate } from "node:timers/promises";
import { ArchiveError, isMissing } from "./errors.js";

const MAX_JSON_BYTES = 8 * 1024 * 1024;

function contained(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(".." + path.sep));
}

/** 先解析真实祖先与悬空链接，再判断边界；允许 /var 等系统别名指向同一数据目录。 */
async function canonicalArchivePath(root: string, file: string): Promise<{ file: string; missing: boolean }> {
  const canonicalRoot = await realpath(root);
  let current = path.resolve(root, file);
  let remaining: string[] = [];
  let links = 0;
  for (;;) {
    try {
      const ancestor = await realpath(current);
      const target = path.join(ancestor, ...remaining.reverse());
      if (!contained(canonicalRoot, target)) throw new ArchiveError("unsafe_path", "存档真实路径位于 AGORA_HOME 之外");
      if (remaining.length && !(await stat(ancestor)).isDirectory()) throw new ArchiveError("invalid_file", "存档路径的祖先不是目录");
      return { file: target, missing: remaining.length > 0 };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOTDIR") throw new ArchiveError("invalid_file", "存档路径的祖先不是目录");
      if (!isMissing(error)) throw error;
      const info = await lstat(current).catch((failure: NodeJS.ErrnoException) => {
        if (failure.code === "ENOENT") return undefined;
        throw failure;
      });
      if (info?.isSymbolicLink()) {
        if (++links > 40) throw new ArchiveError("unsafe_path", "存档链接层数过多");
        current = path.resolve(path.dirname(current), await readlink(current), ...remaining.reverse());
        remaining = [];
        continue;
      }
      const parent = path.dirname(current);
      if (parent === current) throw error;
      remaining.push(path.basename(current));
      current = parent;
    }
  }
}

export async function archivePath(root: string, file: string): Promise<{ file: string; missing: boolean }> {
  const checked = await canonicalArchivePath(root, file);
  if (!checked.missing && !(await stat(checked.file)).isFile()) throw new ArchiveError("invalid_file", "存档路径不是普通文件");
  return checked;
}

export async function archiveDirectory(root: string, directory: string): Promise<string | undefined> {
  const checked = await canonicalArchivePath(root, directory);
  if (checked.missing) return undefined;
  if (!(await stat(checked.file)).isDirectory()) throw new ArchiveError("invalid_file", "存档目录不是目录");
  return checked.file;
}

export async function* jsonLines(file: string): AsyncGenerator<unknown> {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let line = 0;
  const parse = (text: string): unknown => {
    try { return JSON.parse(text); }
    catch { throw new ArchiveError("invalid_json", `存档附属文件第 ${line} 行不是有效 JSON`); }
  };
  for await (const chunk of createReadStream(file, { highWaterMark: 64 * 1024 })) {
    pending += decoder.write(chunk as Buffer);
    let boundary: number;
    while ((boundary = pending.indexOf("\n")) !== -1) {
      const text = pending.slice(0, boundary).trim();
      pending = pending.slice(boundary + 1);
      line++;
      if (Buffer.byteLength(text) > MAX_JSON_BYTES) throw new ArchiveError("file_too_large", "存档附属文件单行超过 8 MiB");
      if (text) yield parse(text);
      if (line % 1000 === 0) await setImmediate();
    }
    if (Buffer.byteLength(pending) > MAX_JSON_BYTES) throw new ArchiveError("file_too_large", "存档附属文件单行超过 8 MiB");
    await setImmediate();
  }
  pending += decoder.end();
  if (pending.trim()) {
    line++;
    try { yield JSON.parse(pending); }
    catch (error) {
      // 流片段追加写入可能停在 JSON 字符串或对象中间。
      if (!(error instanceof SyntaxError) || !/end of JSON|unterminated/i.test(error.message)) {
        throw new ArchiveError("invalid_json", `存档附属文件第 ${line} 行不是有效 JSON`);
      }
    }
  }
}

export async function jsonDocument(file: string): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of createReadStream(file, { highWaterMark: 64 * 1024 })) {
    bytes += (chunk as Buffer).length;
    if (bytes > MAX_JSON_BYTES) throw new ArchiveError("file_too_large", "诊断文件超过 8 MiB");
    chunks.push(chunk as Buffer);
    await setImmediate();
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new ArchiveError("invalid_json", "诊断文件不是有效 JSON"); }
}
