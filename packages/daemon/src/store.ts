import { DatabaseSync, backup, type SQLInputValue } from "node:sqlite";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AgoraError } from "./errors.js";

export const SCHEMA_VERSION = 4;
export const schemaMigrations: readonly string[] = [String.raw`
CREATE TABLE principals (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, label TEXT NOT NULL DEFAULT '',
  pi_session_id TEXT, session_file TEXT, cwd TEXT, ephemeral INTEGER NOT NULL DEFAULT 0,
  forked_from TEXT, lease_connection_id TEXT, lease_expires_at INTEGER,
  created_at TEXT NOT NULL
);
CREATE TABLE agora_sessions (
  id TEXT PRIMARY KEY, task_id TEXT UNIQUE, principal_id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL DEFAULT 'task', convener_id TEXT, parent_principal_id TEXT, meeting_id TEXT,
  inherits_from TEXT, inherit_reason TEXT, control_state TEXT, archive_state TEXT NOT NULL DEFAULT 'live', ended_at TEXT,
  session_file TEXT NOT NULL UNIQUE, pi_session_id TEXT, profile TEXT NOT NULL,
  model TEXT NOT NULL, thinking TEXT NOT NULL, cwd TEXT NOT NULL,
  status TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
CREATE TABLE tasks (
  id TEXT PRIMARY KEY, agora_session_id TEXT NOT NULL UNIQUE, convener_id TEXT NOT NULL,
  requested_by TEXT NOT NULL, title TEXT NOT NULL, prompt TEXT NOT NULL,
  model TEXT NOT NULL, thinking TEXT NOT NULL, profile TEXT NOT NULL,
  cwd TEXT NOT NULL, notify TEXT NOT NULL, status TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 1, revision INTEGER NOT NULL DEFAULT 1,
  status_detail TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX tasks_convener ON tasks(convener_id, created_at);
CREATE TABLE task_generations (
  task_id TEXT NOT NULL REFERENCES tasks(id), generation INTEGER NOT NULL,
  status TEXT NOT NULL, result_text TEXT, usage TEXT, started_at TEXT, settled_at TEXT,
  PRIMARY KEY (task_id, generation)
);
CREATE TABLE process_runs (
  id TEXT PRIMARY KEY, agora_session_id TEXT NOT NULL REFERENCES agora_sessions(id),
  daemon_instance_id TEXT NOT NULL, identity TEXT, pid INTEGER, process_start_time TEXT, state TEXT NOT NULL,
  started_at TEXT NOT NULL, exited_at TEXT, exit_code INTEGER, signal TEXT,
  diagnostics_path TEXT, cleanup_error TEXT
);
CREATE INDEX runs_session ON process_runs(agora_session_id, started_at);
CREATE TABLE outbox (
  id TEXT PRIMARY KEY, recipient_id TEXT NOT NULL, dedupe_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL,
  visible_after INTEGER NOT NULL DEFAULT 0, delivered_at TEXT, persisted_at TEXT,
  acked_at TEXT, processed_at TEXT, entry_id TEXT, persisted INTEGER, attempts INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX outbox_recipient ON outbox(recipient_id, acked_at, visible_after);
CREATE TABLE operations (
  principal_id TEXT NOT NULL, key TEXT NOT NULL, fingerprint TEXT NOT NULL,
  id TEXT NOT NULL, state TEXT NOT NULL, status INTEGER, result TEXT,
  created_at INTEGER NOT NULL, PRIMARY KEY (principal_id, key)
);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, epoch TEXT NOT NULL, object_type TEXT NOT NULL,
  object_id TEXT NOT NULL, tombstone INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
INSERT INTO settings VALUES ('epoch', lower(hex(randomblob(16))));
`, String.raw`
CREATE TABLE agora_sessions_v2 (
  id TEXT PRIMARY KEY, task_id TEXT, principal_id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL DEFAULT 'task', convener_id TEXT, parent_principal_id TEXT, meeting_id TEXT,
  inherits_from TEXT, inherit_reason TEXT, control_state TEXT, archive_state TEXT NOT NULL DEFAULT 'live', ended_at TEXT,
  session_file TEXT NOT NULL UNIQUE, pi_session_id TEXT, profile TEXT NOT NULL,
  model TEXT NOT NULL, thinking TEXT NOT NULL, cwd TEXT NOT NULL,
  status TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
INSERT INTO agora_sessions_v2 SELECT * FROM agora_sessions;
DROP TABLE agora_sessions;
ALTER TABLE agora_sessions_v2 RENAME TO agora_sessions;
ALTER TABLE task_generations ADD COLUMN agora_session_id TEXT REFERENCES agora_sessions(id);
UPDATE task_generations SET agora_session_id=(SELECT agora_session_id FROM tasks WHERE tasks.id=task_generations.task_id);
`, String.raw`
ALTER TABLE tasks ADD COLUMN parent_task_id TEXT REFERENCES tasks(id);
ALTER TABLE tasks ADD COLUMN depth INTEGER NOT NULL DEFAULT 1;
ALTER TABLE tasks ADD COLUMN depth_limit INTEGER NOT NULL DEFAULT 2;
ALTER TABLE tasks ADD COLUMN child_limit INTEGER;
ALTER TABLE tasks ADD COLUMN recovery_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN pending_message TEXT;
CREATE INDEX tasks_parent ON tasks(parent_task_id);
CREATE TABLE steer_messages (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), generation INTEGER NOT NULL,
  message TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX steers_task ON steer_messages(task_id,generation);
CREATE TABLE requests (
  id TEXT PRIMARY KEY, asker_id TEXT NOT NULL, target_id TEXT NOT NULL, task_id TEXT,
  questions TEXT NOT NULL, context TEXT, state TEXT NOT NULL DEFAULT 'open',
  route TEXT NOT NULL DEFAULT '[]', answers TEXT, answered_by TEXT,
  expires_at TEXT, revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX requests_target ON requests(target_id,state);
CREATE INDEX requests_task ON requests(task_id,state);
CREATE TABLE worktrees (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id), repo_root TEXT NOT NULL, base_commit TEXT NOT NULL,
  branch TEXT NOT NULL, path TEXT NOT NULL UNIQUE, owner_id TEXT NOT NULL, state TEXT NOT NULL
);
`, String.raw`
ALTER TABLE tasks ADD COLUMN skills TEXT NOT NULL DEFAULT '[]';
ALTER TABLE tasks ADD COLUMN skill_paths TEXT NOT NULL DEFAULT '[]';
ALTER TABLE tasks ADD COLUMN quota_resume_at TEXT;
ALTER TABLE tasks ADD COLUMN quota_notified_at TEXT;
CREATE TABLE usage_records (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id),
  generation INTEGER NOT NULL, agora_session_id TEXT NOT NULL REFERENCES agora_sessions(id),
  run_id TEXT NOT NULL REFERENCES process_runs(id), request_id TEXT NOT NULL,
  input_tokens INTEGER NOT NULL, cache_read_tokens INTEGER NOT NULL, cache_write_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL, reasoning_tokens INTEGER NOT NULL, context_tokens INTEGER NOT NULL,
  created_at TEXT NOT NULL, UNIQUE(run_id,request_id)
);
CREATE INDEX usage_task ON usage_records(task_id,generation,seq);
`];

export interface PrincipalRow {
  id: string; type: string; label: string; pi_session_id: string | null;
  session_file: string | null; cwd: string | null; ephemeral: number;
  forked_from: string | null; lease_connection_id: string | null;
  lease_expires_at: number | null; created_at: string;
}
export interface TaskRow {
  id: string; agora_session_id: string; convener_id: string; requested_by: string;
  title: string; prompt: string; model: string; thinking: string; profile: string;
  cwd: string; notify: string; status: string; generation: number; revision: number;
  status_detail: string | null; created_at: string; updated_at: string;
  parent_task_id: string | null; depth: number; depth_limit: number; child_limit: number | null;
  recovery_attempts: number; pending_message: string | null;
  skills: string; skill_paths: string; quota_resume_at: string | null; quota_notified_at: string | null;
}
export interface SessionRow {
  id: string; task_id: string; principal_id: string; session_file: string;
  pi_session_id: string | null; profile: string; model: string; thinking: string;
  cwd: string; status: string; revision: number; created_at: string;
  convener_id: string; parent_principal_id: string; control_state: string | null;
}
export interface RunRow {
  id: string; agora_session_id: string; daemon_instance_id: string;
  identity: string | null; state: string; started_at: string; exited_at: string | null;
  exit_code: number | null; signal: string | null; diagnostics_path: string | null;
  cleanup_error: string | null;
}
export interface NoticeRow {
  id: string; recipient_id: string; dedupe_key: string; kind: string; payload: string;
  created_at: string; visible_after: number; acked_at: string | null;
}

export interface UsageSummary {
  requests: number; inputTokens: number; cacheReadTokens: number; cacheWriteTokens: number;
  outputTokens: number; reasoningTokens: number; contextTokens: number;
}

export function id(prefix: string): string { return `${prefix}_${randomUUID()}`; }
export function now(): string { return new Date().toISOString(); }

export class Store {
  constructor(readonly db: DatabaseSync, readonly home: string) {}
  get<T>(sql: string, ...args: SQLInputValue[]): T | undefined {
    return this.db.prepare(sql).get(...args) as T | undefined;
  }
  all<T>(sql: string, ...args: SQLInputValue[]): T[] {
    return this.db.prepare(sql).all(...args) as T[];
  }
  run(sql: string, ...args: SQLInputValue[]) { return this.db.prepare(sql).run(...args); }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      if (result && typeof (result as { then?: unknown }).then === "function") throw new Error("数据库事务不能包含异步操作");
      this.db.exec("COMMIT");
      return result;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  principal(principalId: string): PrincipalRow | undefined {
    return this.get<PrincipalRow>("SELECT * FROM principals WHERE id=?", principalId);
  }
  task(taskId: string): TaskRow {
    const row = this.get<TaskRow>("SELECT * FROM tasks WHERE id=?", taskId);
    if (!row) throw new AgoraError(404, "not_found", "任务不存在");
    return row;
  }
  session(sessionId: string): SessionRow {
    const row = this.get<SessionRow>("SELECT * FROM agora_sessions WHERE id=?", sessionId);
    if (!row) throw new AgoraError(404, "not_found", "会话不存在");
    return row;
  }
  notice(recipientId: string, dedupeKey: string, kind: string, payload: unknown): void {
    this.run("INSERT OR IGNORE INTO outbox(id,recipient_id,dedupe_key,kind,payload,created_at) VALUES(?,?,?,?,?,?)", id("nt"), recipientId, dedupeKey, kind, JSON.stringify(payload), now());
  }
  change(kind: string, objectId: string): void {
    this.run("INSERT INTO changes(epoch,object_type,object_id,created_at) VALUES((SELECT value FROM settings WHERE key='epoch'),?,?,?)", kind, objectId, now());
  }
  transition(task: TaskRow, status: string, resultText?: string, runId?: string, usage?: unknown, quota?: { resumeAt: string | null }): TaskRow {
    return this.transaction(() => {
      const at = now();
      const changed = this.run("UPDATE tasks SET status=?,revision=revision+1,status_detail=NULL,updated_at=? WHERE id=? AND generation=? AND revision=?", status, at, task.id, task.generation, task.revision);
      if (!changed.changes) throw new AgoraError(409, "conflict", "任务状态已变化，请重新读取");
      if (quota) this.run("UPDATE tasks SET quota_resume_at=?,quota_notified_at=NULL WHERE id=?", quota.resumeAt, task.id);
      this.run("UPDATE agora_sessions SET status=?,revision=revision+1 WHERE id=?", status, task.agora_session_id);
      if (["completed", "failed", "stopped", "interrupted"].includes(status)) this.run("UPDATE agora_sessions SET ended_at=? WHERE id=?", at, task.agora_session_id);
      this.run("UPDATE task_generations SET status=?,result_text=COALESCE(?,result_text),settled_at=CASE WHEN ? IN ('completed','failed','stopped','interrupted') THEN ? ELSE settled_at END,started_at=CASE WHEN ?='running' THEN COALESCE(started_at,?) ELSE started_at END WHERE task_id=? AND generation=?", status, resultText ?? null, status, at, status, at, task.id, task.generation);
      if (usage !== undefined) this.run("UPDATE task_generations SET usage=? WHERE task_id=? AND generation=?", JSON.stringify(usage), task.id, task.generation);
      if (["completed", "failed", "interrupted", "stopped"].includes(status)) {
        this.notice(task.convener_id, `task:${task.id}:${task.generation}:${status}${status === "interrupted" ? `:${runId ?? "unknown"}` : ""}`, `task:${status}`, {
          taskId: task.id, agoraSessionId: task.agora_session_id, nodeId: `agora:session:${task.agora_session_id}`,
          generation: task.generation, status, title: task.title, summary: (resultText ?? "").slice(0, 2000), notify: task.notify,
        });
      }
      this.change("task", task.id);
      return this.task(task.id);
    });
  }
  usage(taskId: string, tree = false, generation?: number): UsageSummary {
    const ids = tree ? "WITH RECURSIVE subtree(id) AS (SELECT ? UNION ALL SELECT t.id FROM tasks t JOIN subtree s ON t.parent_task_id=s.id) SELECT id FROM subtree" : "SELECT ?";
    const totals = this.get<UsageSummary>(`SELECT COUNT(*) AS requests,
      COALESCE(SUM(input_tokens),0) AS inputTokens, COALESCE(SUM(cache_read_tokens),0) AS cacheReadTokens,
      COALESCE(SUM(cache_write_tokens),0) AS cacheWriteTokens, COALESCE(SUM(output_tokens),0) AS outputTokens,
      COALESCE(SUM(reasoning_tokens),0) AS reasoningTokens, 0 AS contextTokens
      FROM usage_records WHERE task_id IN (${ids}) AND (? IS NULL OR generation=?)`, taskId, generation ?? null, generation ?? null)!;
    totals.contextTokens = this.get<{ n: number }>(`SELECT COALESCE(SUM(context_tokens),0) AS n FROM usage_records WHERE seq IN (
      SELECT MAX(seq) FROM usage_records WHERE task_id IN (${ids}) AND context_tokens>0 AND (? IS NULL OR generation=?) GROUP BY task_id
    )`, taskId, generation ?? null, generation ?? null)!.n;
    return totals;
  }
  takeInbox(recipient: string, visibilityMs = 120_000): NoticeRow[] {
    return this.transaction(() => {
      const rows = this.all<NoticeRow>("SELECT * FROM outbox WHERE recipient_id=? AND acked_at IS NULL AND visible_after<=? ORDER BY created_at,id LIMIT 200", recipient, Date.now());
      for (const row of rows) this.run("UPDATE outbox SET visible_after=?,delivered_at=?,attempts=attempts+1 WHERE id=?", Date.now() + visibilityMs, now(), row.id);
      return rows;
    });
  }
  close(): void { this.db.close(); }
}

export async function consistentBackup(db: DatabaseSync, destination: string): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true });
  await backup(db, destination, { rate: 2_147_483_647 });
  const copy = new DatabaseSync(destination, { readOnly: true });
  try {
    const rows = copy.prepare("PRAGMA integrity_check").all();
    if (rows.length !== 1 || Object.values(rows[0]!)[0] !== "ok") throw new Error("数据库备份完整性检查失败");
  } finally { copy.close(); }
}

export async function openStore(home: string): Promise<Store> {
  await mkdir(home, { recursive: true });
  const file = path.join(home, "agora.db");
  const existed = await stat(file).then(value => value.size > 0, error => { if (error.code === "ENOENT") return false; throw error; });
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
    const hasVersion = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'").get();
    const version = hasVersion ? Number((db.prepare("SELECT version FROM schema_version LIMIT 1").get() as { version: number } | undefined)?.version ?? 0) : 0;
    if (!Number.isInteger(version) || version < 0 || version > SCHEMA_VERSION) throw new Error("数据库版本不兼容，请使用匹配版本的 daemon");
    if (version < SCHEMA_VERSION) {
      if (existed) await consistentBackup(db, path.join(home, "backups", `agora-${version}-${Date.now()}-${randomUUID()}.db`));
      // 重建被引用的会话表时关闭外键执行，提交前核验全部引用。
      db.exec("PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE");
      try {
        db.exec("CREATE TABLE IF NOT EXISTS schema_version(version INTEGER NOT NULL,migrated_at TEXT NOT NULL)");
        for (let next = version; next < SCHEMA_VERSION; next++) {
          const sessionObjects = next === 1 ? db.prepare("SELECT sql FROM sqlite_master WHERE tbl_name='agora_sessions' AND type IN ('index','trigger') AND sql IS NOT NULL").all() as { sql: string }[] : [];
          db.exec(schemaMigrations[next]!);
          for (const object of sessionObjects) db.exec(object.sql);
        }
        if (db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("数据库迁移外键检查失败");
        db.prepare("DELETE FROM schema_version").run();
        db.prepare("INSERT INTO schema_version VALUES(?,?)").run(SCHEMA_VERSION, now());
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
      finally { db.exec("PRAGMA foreign_keys=ON"); }
    }
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
    return new Store(db, home);
  } catch (error) { db.close(); throw error; }
}
