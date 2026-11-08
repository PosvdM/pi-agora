import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { setImmediate } from "node:timers/promises";
import { ArchiveError, isMissing } from "./errors.js";

const MAX_JSON_BYTES = 8 * 1024 * 1024;

function contained(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(".." + path.sep));
}

/** 缺失路径也检查现存祖先，避免目录链接绕过数据目录边界。 */
export async function archivePath(root: string, file: string): Promise<{ file: string; missing: boolean }> {
  const absolute = path.resolve(root, file);
  if (!contained(root, absolute)) throw new ArchiveError("unsafe_path", "存档路径位于 AGORA_HOME 之外");
  let current = absolute;
  for (;;) {
    try {
      const resolved = await realpath(current);
      if (!contained(root, resolved)) throw new ArchiveError("unsafe_path", "存档符号链接指向 AGORA_HOME 之外");
      if (current === absolute) {
        if (!(await stat(resolved)).isFile()) throw new ArchiveError("invalid_file", "存档路径不是普通文件");
        return { file: resolved, missing: false };
      }
      return { file: absolute, missing: true };
    } catch (error) {
      if (!isMissing(error)) throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

export async function archiveDirectory(root: string, directory: string): Promise<string | undefined> {
  const absolute = path.resolve(directory);
  if (!contained(root, absolute)) throw new ArchiveError("unsafe_path", "存档目录位于 AGORA_HOME 之外");
  try {
    const resolved = await realpath(absolute);
    if (!contained(root, resolved)) throw new ArchiveError("unsafe_path", "存档目录链接指向 AGORA_HOME 之外");
    if (!(await stat(resolved)).isDirectory()) throw new ArchiveError("invalid_file", "存档目录不是目录");
    return resolved;
  } catch (error) {
    if (!isMissing(error)) throw error;
    // 即使末级目录缺失，也必须检查其父目录的真实路径。
    await archivePath(root, path.join(absolute, ".archive-missing-check"));
    return undefined;
  }
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
