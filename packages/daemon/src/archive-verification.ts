import { readdir, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { openArchive, verifySessionFile } from "@pi-agora/archive";
import { Store, now } from "./store.js";
import { AgoraError } from "./errors.js";
import type { MessageObservation } from "./harness/types.js";

interface VerifiedSession {
  id: string;
  convener_id: string | null;
  archive_state: string;
  archive_hash: string | null;
  archive_bytes: number;
  session_file: string;
}

export class ArchiveVerifier {
  private readonly pending = new Map<string, Promise<unknown>>();
  constructor(readonly store: Store) {}

  observe(sessionId: string, runId: string, observation: MessageObservation): void {
    this.store.run("INSERT OR IGNORE INTO archive_observed_messages(agora_session_id,run_id,signature,role,timestamp,observed_at) VALUES(?,?,?,?,?,?)",
      sessionId, runId, observation.signature, observation.role, observation.timestamp === undefined ? null : JSON.stringify(observation.timestamp), now());
  }

  verify(sessionId: string): Promise<unknown> {
    const previous = this.pending.get(sessionId) ?? Promise.resolve();
    const work = previous.catch(() => {}).then(() => this.perform(sessionId));
    this.pending.set(sessionId, work);
    void work.finally(() => { if (this.pending.get(sessionId) === work) this.pending.delete(sessionId); }).catch(() => {});
    return work;
  }

  private async perform(sessionId: string) {
    const session = this.store.get<VerifiedSession>("SELECT id,convener_id,archive_state,archive_hash,archive_bytes,session_file FROM agora_sessions WHERE id=?", sessionId);
    if (!session) throw new AgoraError(404, "not_found", "会话不存在");
    // 元数据指向的文件同样必须处在数据目录内；缺失路径仍检查最近存在的祖先。
    const home = await realpath(this.store.home);
    let ancestor = path.resolve(session.session_file);
    const unresolved: string[] = [];
    while (true) {
      try { ancestor = path.join(await realpath(ancestor), ...unresolved.reverse()); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const parent = path.dirname(ancestor);
        if (parent === ancestor) throw error;
        unresolved.push(path.basename(ancestor)); ancestor = parent;
      }
    }
    const relative = path.relative(home, ancestor);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new AgoraError(403, "archive_path_outside_home", "存档路径不在数据目录内");
    const observed = this.store.get<{ count: number }>("SELECT COUNT(*) AS count FROM archive_observed_messages WHERE agora_session_id=?", sessionId)!.count;
    const last = this.store.get<{ role: string; timestamp: string | null }>("SELECT role,timestamp FROM archive_observed_messages WHERE agora_session_id=? ORDER BY seq DESC LIMIT 1", sessionId);
    const reader = await openArchive({ home: this.store.home, apiVersion: 1 });
    let hasUnfinishedPartials: boolean;
    try { hasUnfinishedPartials = (await reader.readPartials(sessionId)).length > 0; }
    finally { reader.close(); }
    const result = await verifySessionFile(ancestor, {
      messageEndCount: observed,
      ...(last?.timestamp !== null && last?.timestamp !== undefined ? { lastMessage: { role: last.role, timestamp: JSON.parse(last.timestamp) } } : {}),
      ...(session.archive_hash ? { previous: { hash: session.archive_hash, bytes: session.archive_bytes } } : {}),
      hasUnfinishedPartials,
    });
    const verifiedAt = now();
    this.store.transaction(() => {
      // 可疑文件不能覆盖最后一次可信基线，否则重复校验会把改动洗成正常。
      if (result.state === "ok" || result.state === "partial") {
        this.store.run("UPDATE agora_sessions SET archive_state=?,archive_hash=?,archive_bytes=?,archive_verified_at=?,archive_error=NULL,revision=revision+1 WHERE id=?", result.state, result.hash, result.bytes, verifiedAt, sessionId);
      } else {
        this.store.run("UPDATE agora_sessions SET archive_state=?,archive_verified_at=?,archive_error=NULL,revision=revision+1 WHERE id=?", result.state, verifiedAt, sessionId);
      }
      this.store.change("session", sessionId);
      if (["suspect", "missing"].includes(result.state)) {
        const payload = { agoraSessionId: sessionId, nodeId: `agora:session:${sessionId}`, archiveState: result.state, summary: result.state === "missing" ? "会话存档缺失，请核对存储目录" : "会话存档未通过完整性校验，请核对诊断", diagnostics: result.diagnostics };
        const dedupe = `archive:${sessionId}:${result.state}:${result.hash ?? "missing"}`;
        for (const recipient of new Set([session.convener_id, "user"])) if (recipient) this.store.notice(recipient, `${dedupe}:${recipient}`, "archive:warning", payload);
      }
    });
    return { agoraSessionId: sessionId, ...result, verifiedAt };
  }

  async verifyAll(): Promise<{ items: unknown[] }> {
    const items: unknown[] = [];
    let cursor = "";
    while (true) {
      const rows = this.store.all<{ id: string }>("SELECT id FROM agora_sessions WHERE id>? ORDER BY id LIMIT 200", cursor);
      if (!rows.length) break;
      for (const row of rows) { items.push(await this.verify(row.id)); cursor = row.id; }
    }
    return { items };
  }

  async flush(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending.values()]);
  }
}

/** 不跟随会话目录中的符号链接，磁盘统计也不能越出存档树。 */
export async function archiveStorageBytes(home: string): Promise<number> {
  let bytes = 0;
  const directories = [path.join(home, "sessions")];
  while (directories.length) {
    const directory = directories.pop()!;
    const own = await lstat(directory).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
    if (!own || own.isSymbolicLink()) continue;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) directories.push(file);
      else if (entry.isFile()) {
        const info = await lstat(file);
        if (info.isFile() && !info.isSymbolicLink()) bytes += info.size;
      }
    }
  }
  return bytes;
}
