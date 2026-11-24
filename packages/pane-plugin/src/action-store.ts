import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { TextDecoder } from "node:util";

export const ACTION_STORE_LIMIT = 16 * 1024 * 1024;
export class ActionStoreError extends Error {
  constructor() { super("动作请求存储不可用，请检查数据目录后重启插件"); }
}
// 候选快照超过上限时不写盘，存储保持可用；已落盘的快照和调用方的内存状态都不变。
export class ActionStoreCapacityError extends Error {
  constructor() { super("动作请求存储容量不足（16 MiB），新操作未执行；请使用原请求标识查询已有操作或等待记录过期"); }
}

// 一个插件实例独占数据目录。读取或写入失败后存储关闭，必须重启插件；
// 容量拒绝发生在写入之前，不关闭存储。
export class ActionStore {
  private failed = false;
  private readonly path: string;
  constructor(private readonly dataDir: string) {
    this.path = typeof dataDir === "string" && isAbsolute(dataDir) ? join(dataDir, "actions.json") : "";
  }
  private check(): void {
    if (this.failed || !this.path) throw new ActionStoreError();
  }
  async load(): Promise<unknown | undefined> {
    this.check();
    try {
      let file;
      try { file = await open(this.path, "r"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
      try {
        const size = (await file.stat()).size;
        if (size > ACTION_STORE_LIMIT) throw new ActionStoreError();
        // 多读一个字节可拒绝读取期间增长到上限之外的文件。
        const buffer = Buffer.alloc(Math.min(size + 1, ACTION_STORE_LIMIT + 1));
        let offset = 0;
        while (offset < buffer.length) {
          const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, null);
          if (bytesRead === 0) break;
          offset += bytesRead;
        }
        if (offset !== size) throw new ActionStoreError();
        const envelope = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, offset)));
        if (!envelope || envelope.version !== 1 || !Object.hasOwn(envelope, "data") || Object.keys(envelope).length !== 2) throw new ActionStoreError();
        return envelope.data;
      } finally { await file.close(); }
    } catch {
      this.failed = true;
      throw new ActionStoreError();
    }
  }
  async save(data: unknown): Promise<void> {
    this.check();
    const json = JSON.stringify({ version: 1, data });
    if (Buffer.byteLength(json, "utf8") > ACTION_STORE_LIMIT) throw new ActionStoreCapacityError();
    let temporary: string | undefined;
    try {
      await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
      temporary = `${this.path}.${randomUUID()}.tmp`;
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(json, "utf8"); await file.sync(); }
      finally { await file.close(); }
      await rename(temporary, this.path);
    } catch {
      this.failed = true;
      throw new ActionStoreError();
    } finally {
      if (temporary) await rm(temporary, { force: true }).catch(() => {});
    }
  }
}
