import { createHash, randomUUID } from "node:crypto";
import { mkdir, open as openFile, rename, unlink } from "node:fs/promises";
import path from "node:path";

const RETAIN_MS = 24 * 60 * 60_000;
const MAX_ENTRIES = 4096;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_RESULT_BYTES = 64 * 1024;
const MAX_MESSAGE_BYTES = 4096;
type Entry = { fingerprint: string; at: number; result?: unknown };
const invalid = () => new Error("插件幂等记录无效，已拒绝执行写入");
const capacity = () => new Error("插件幂等记录容量不足（4096 条 / 32 MiB，未完成记录预留 64 KiB 结果），新操作未执行；请使用原幂等键查询已有操作或等待记录过期");
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const result = JSON.stringify(value);
    if (result === undefined) throw new Error("操作参数必须是 JSON 值");
    return result;
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().filter(key => (value as Record<string, unknown>)[key] !== undefined).map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
}
function validKey(key: unknown): key is string { return typeof key === "string" && key.length > 0 && key.length <= 512; }
function bytes(value: unknown): number { return Buffer.byteLength(JSON.stringify(value)); }
function normalize<T extends { status: string }>(result: T): T {
  let value = { ...result } as T & { message?: unknown };
  if (typeof value.message === "string" && bytes(value.message) > MAX_MESSAGE_BYTES) {
    // JSON 转义最多占每个 UTF-16 单元 6 字节；只缩短提示，不改变状态或表单。
    value.message = `${value.message.slice(0, 512).replace(/[\uD800-\uDBFF]$/, "")}…（信息过长，已截断）`;
  }
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized) > MAX_RESULT_BYTES) throw new Error("操作结果超过 64 KiB，结果未保存，操作可能已执行；请使用原幂等键核对");
  value = JSON.parse(serialized);
  return value;
}
function assertCapacity(entries: Map<string, Entry>): void {
  if (entries.size > MAX_ENTRIES) throw capacity();
  let size = 2;
  for (const [key, entry] of entries) {
    // 未完成身份为最终结果和最长时间戳预留空间，完成时不会挤占其他身份。
    size += 1 + (entry.result === undefined
      ? bytes({ key, fingerprint: entry.fingerprint, at: Number.MAX_SAFE_INTEGER, result: null }) - 4 + MAX_RESULT_BYTES
      : bytes({ key, ...entry }));
    if (size > MAX_FILE_BYTES) throw capacity();
  }
}
async function readBounded(file: string): Promise<string | undefined> {
  let handle;
  try { handle = await openFile(file, "r"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw invalid();
    if (stat.size > MAX_FILE_BYTES) throw new Error("插件幂等记录超过 32 MiB 读取上限，已拒绝加载");
    const chunks: Buffer[] = [];
    let size = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_FILE_BYTES + 1 - size));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > MAX_FILE_BYTES) throw new Error("插件幂等记录超过 32 MiB 读取上限，已拒绝加载");
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size));
  } finally { await handle.close(); }
}
export class OperationIdentities {
  private entries = new Map<string, Entry>();
  private queue: Promise<unknown> = Promise.resolve();
  private file?: string;
  private available = true;
  async open(dataDir: string): Promise<void> {
    this.available = false;
    const file = path.join(dataDir, "operation-identities.json");
    await mkdir(dataDir, { recursive: true });
    const contents = await readBounded(file);
    const data = contents === undefined ? [] : JSON.parse(contents);
    if (!Array.isArray(data)) throw invalid();
    if (data.length > MAX_ENTRIES) throw new Error("插件幂等记录超过 4096 条读取上限，已拒绝加载");
    const next = new Map<string, Entry>(), seen = new Set<string>();
    const now = Date.now();
    for (const entry of data) {
      if (!entry || !validKey(entry.key) || seen.has(entry.key) || typeof entry.fingerprint !== "string" ||
          !/^[a-f0-9]{64}$/.test(entry.fingerprint) || !Number.isSafeInteger(entry.at) || entry.at < 0) throw invalid();
      seen.add(entry.key);
      if (entry.result !== undefined && (!entry.result || typeof entry.result !== "object" || Array.isArray(entry.result) ||
          typeof entry.result.status !== "string" || !entry.result.status || entry.result.status === "pending" || bytes(entry.result) > MAX_RESULT_BYTES)) throw invalid();
      if (entry.at + RETAIN_MS > now) next.set(entry.key, { fingerprint: entry.fingerprint, at: entry.at, ...(entry.result === undefined ? {} : { result: entry.result }) });
    }
    assertCapacity(next);
    this.entries = next;
    this.file = file;
    this.available = true;
  }
  private ready(): void { if (!this.available) throw new Error("插件幂等记录尚未安全加载，已拒绝执行写入"); }
  result<T>(key: string): T | undefined {
    this.ready();
    const entry = this.entries.get(key);
    return entry && entry.at + RETAIN_MS > Date.now() ? structuredClone(entry.result) as T | undefined : undefined;
  }
  finish<T extends { status: string }>(key: string, result: T): Promise<T> {
    const operation = this.queue.then(async () => {
      this.ready();
      const entry = this.entries.get(key);
      if (!entry) throw new Error("操作身份尚未登记；结果未保存，操作可能已执行，请使用原幂等键核对");
      if (entry.result !== undefined) return structuredClone(entry.result) as T;
      const normalized = normalize(result);
      if (normalized.status === "pending") return normalized;
      const next = new Map(this.entries);
      next.set(key, { fingerprint: entry.fingerprint, at: Date.now(), result: normalized });
      assertCapacity(next);
      await this.persist(next);
      this.entries = next;
      return structuredClone(normalized);
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
  private async persist(entries: Map<string, Entry>): Promise<void> {
    if (!this.file) return;
    const contents = JSON.stringify([...entries].map(([key, value]) => ({ key, ...value })));
    if (Buffer.byteLength(contents) > MAX_FILE_BYTES) throw capacity();
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      const handle = await openFile(temporary, "wx", 0o600);
      try { await handle.writeFile(contents, "utf8"); await handle.sync(); }
      finally { await handle.close(); }
      await rename(temporary, this.file);
    } finally { await unlink(temporary).catch(() => {}); }
  }
  check(key: string, identity: unknown): Promise<boolean> {
    const operation = this.queue.then(async () => {
      this.ready();
      if (!validKey(key)) throw new Error("幂等键无效");
      const fingerprint = createHash("sha256").update(canonical(identity)).digest("hex");
      const previous = this.entries.get(key), now = Date.now();
      if (previous && previous.at + RETAIN_MS > now) return previous.fingerprint === fingerprint;
      const next = new Map([...this.entries].filter(([, value]) => value.at + RETAIN_MS > now));
      next.set(key, { fingerprint, at: now });
      assertCapacity(next);
      await this.persist(next);
      this.entries = next;
      return true;
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}
