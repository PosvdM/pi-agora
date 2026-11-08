import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const RETAIN_MS = 24 * 60 * 60_000;
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const result = JSON.stringify(value);
    if (result === undefined) throw new Error("操作参数必须是 JSON 值");
    return result;
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().filter(key => (value as Record<string, unknown>)[key] !== undefined).map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
}
export class OperationIdentities {
  private readonly entries = new Map<string, { fingerprint: string; at: number; result?: unknown }>();
  private queue: Promise<unknown> = Promise.resolve();
  private file?: string;
  async open(dataDir: string): Promise<void> {
    this.file = path.join(dataDir, "operation-identities.json");
    await mkdir(dataDir, { recursive: true });
    let contents: string;
    try { contents = await readFile(this.file, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    const data = JSON.parse(contents);
    if (!Array.isArray(data)) throw new Error("插件幂等记录无效，已拒绝执行写入");
    for (const entry of data) {
      if (!entry || typeof entry.key !== "string" || typeof entry.fingerprint !== "string" || typeof entry.at !== "number") throw new Error("插件幂等记录无效，已拒绝执行写入");
      if (entry.at + RETAIN_MS > Date.now()) this.entries.set(entry.key, { fingerprint: entry.fingerprint, at: entry.at, ...(entry.result === undefined ? {} : { result: entry.result }) });
    }
  }
  result<T>(key: string): T | undefined { return this.entries.get(key)?.result as T | undefined; }
  finish(key: string, result: unknown): Promise<void> {
    const operation = this.queue.then(async () => {
      const entry = this.entries.get(key);
      if (!entry) throw new Error("操作身份尚未登记");
      const previous = { result: entry.result, at: entry.at };
      entry.result = result;
      entry.at = Date.now();
      try { await this.persist(); }
      catch (error) { entry.result = previous.result; entry.at = previous.at; throw error; }
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
  private async persist(): Promise<void> {
    if (!this.file) return;
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify([...this.entries].map(([storedKey, value]) => ({ key: storedKey, ...value }))), { mode: 0o600 });
    await rename(temporary, this.file);
  }
  check(key: string, identity: unknown): Promise<boolean> {
    const operation = this.queue.then(async () => {
      if (typeof key !== "string" || !key || key.length > 512) throw new Error("幂等键无效");
      const fingerprint = createHash("sha256").update(canonical(identity)).digest("hex");
      const previous = this.entries.get(key);
      if (previous && previous.at + RETAIN_MS > Date.now()) return previous.fingerprint === fingerprint;
      for (const [storedKey, value] of this.entries) if (value.at + RETAIN_MS <= Date.now()) this.entries.delete(storedKey);
      this.entries.set(key, { fingerprint, at: Date.now() });
      try {
        await this.persist();
      } catch (error) { this.entries.delete(key); throw error; }
      return true;
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}
