import { DatabaseSync, backup, type SQLInputValue } from "node:sqlite";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AgoraError } from "./errors.js";
import { archiveSchemaV6 } from "./archive-schema.js";
import type { SessionMetadata, SessionParent } from "@pi-agora/protocol";

export const SCHEMA_VERSION = 6;
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
`, String.raw`
ALTER TABLE tasks ADD COLUMN max_tokens INTEGER NOT NULL DEFAULT 50000000;
ALTER TABLE tasks ADD COLUMN taken_over_from TEXT;
ALTER TABLE requests ADD COLUMN answer_proof TEXT;
CREATE TABLE budget_grants (
  id TEXT PRIMARY KEY, resource_id TEXT NOT NULL, principal_id TEXT NOT NULL,
  day TEXT NOT NULL, tokens INTEGER NOT NULL, confirmed_by TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE devices (
  id TEXT PRIMARY KEY, public_key TEXT NOT NULL UNIQUE, label TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','paired')), created_at TEXT NOT NULL
);
CREATE TABLE pending_confirmations (
  id TEXT PRIMARY KEY, action TEXT NOT NULL, target TEXT NOT NULL, params TEXT NOT NULL,
  challenge TEXT NOT NULL, nonce TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL,
  requested_by TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending'
    CHECK(state IN ('pending','executing','confirmed','failed','cancelled','expired')),
  consumed_at TEXT, confirmed_by TEXT, result TEXT, failure_reason TEXT, created_at TEXT NOT NULL
);
CREATE TABLE security_alerts (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL UNIQUE, revision INTEGER NOT NULL,
  details TEXT NOT NULL, acknowledged_at TEXT, acknowledged_by TEXT, created_at TEXT NOT NULL
);
CREATE TABLE security_audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL, target TEXT NOT NULL,
  requested_by TEXT NOT NULL, confirmed_by TEXT NOT NULL, device_id TEXT,
  confirmation_id TEXT, outcome TEXT NOT NULL, reason TEXT, via TEXT NOT NULL,
  details TEXT, created_at TEXT NOT NULL
);
`, archiveSchemaV6];

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
  max_tokens: number; taken_over_from: string | null;
}
export interface SessionRow {
  id: string; task_id: string; principal_id: string; session_file: string;
  pi_session_id: string | null; profile: string; model: string; thinking: string;
  cwd: string; status: string; revision: number; created_at: string;
  convener_id: string; parent_principal_id: string; control_state: string | null;
  kind: string; meeting_id: string | null; inherits_from: string | null; inherit_reason: string | null;
  archive_state: string; archive_hash: string | null; archive_bytes: number; archive_verified_at: string | null;
  archive_error: string | null; ended_at: string | null;
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
  private savepointSequence = 0;
  constructor(readonly db: DatabaseSync, readonly home: string) {}
  get<T>(sql: string, ...args: SQLInputValue[]): T | undefined {
    return this.db.prepare(sql).get(...args) as T | undefined;
  }
  all<T>(sql: string, ...args: SQLInputValue[]): T[] {
    return this.db.prepare(sql).all(...args) as T[];
  }
  run(sql: string, ...args: SQLInputValue[]) { return this.db.prepare(sql).run(...args); }
  transaction<T>(fn: () => T): T {
    if (fn.constructor.name === "AsyncFunction") throw new Error("数据库事务不能包含异步操作");
    const savepoint = this.db.isTransaction ? `agora_sp_${++this.savepointSequence}` : undefined;
    this.db.exec(savepoint ? `SAVEPOINT ${savepoint}` : "BEGIN IMMEDIATE");
    try {
      const result = fn();
      if (result && typeof (result as { then?: unknown }).then === "function") throw new Error("数据库事务不能包含异步操作");
      this.db.exec(savepoint ? `RELEASE SAVEPOINT ${savepoint}` : "COMMIT");
      return result;
    } catch (error) {
      this.db.exec(savepoint ? `ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}` : "ROLLBACK");
      throw error;
    }
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
  quotaUnknownNotice(task: TaskRow, runId: string, at = now()): void {
    const key = `task:${task.id}:${task.generation}:quota_unknown:${runId}`;
    this.notice(task.convener_id, key, "task:quota_unknown", {
      taskId: task.id, generation: task.generation, title: task.title, status: "quota_paused", notify: "wake", triggerTurn: true,
      contextTokens: this.usage(task.id).contextTokens,
      summary: "模型额度用完，但服务未提供可识别的重置时间。请核对额度后手动 recover resume 续跑，或停止后改派。",
    });
    this.run("UPDATE outbox SET payload=json_set(payload,'$.triggerTurn',json('true')) WHERE dedupe_key=?", key);
    this.run("UPDATE tasks SET quota_notified_at=? WHERE id=?", at, task.id);
  }
  change(kind: string, objectId: string): void {
    this.run("INSERT INTO changes(epoch,object_type,object_id,created_at) VALUES((SELECT value FROM settings WHERE key='epoch'),?,?,?)", kind, objectId, now());
  }
  transition(task: TaskRow, status: string, resultText?: string, runId?: string, usage?: unknown, quota?: { resumeAt: string | null }): TaskRow {
    return this.transaction(() => {
      const at = now();
      const changed = this.run("UPDATE tasks SET status=?,revision=revision+1,status_detail=NULL,updated_at=? WHERE id=? AND generation=? AND revision=?", status, at, task.id, task.generation, task.revision);
      if (!changed.changes) throw new AgoraError(409, "conflict", "任务状态已变化，请重新读取");
      if (quota) {
        this.run("UPDATE tasks SET quota_resume_at=?,quota_notified_at=NULL WHERE id=?", quota.resumeAt, task.id);
        if (status === "quota_paused" && !quota.resumeAt) this.quotaUnknownNotice(task, runId ?? "unknown", at);
      }
      this.run("UPDATE agora_sessions SET status=?,revision=revision+1 WHERE id=?", status, task.agora_session_id);
      if (["completed", "failed", "stopped", "interrupted"].includes(status)) this.run("UPDATE agora_sessions SET ended_at=? WHERE id=?", at, task.agora_session_id);
      this.run("UPDATE task_generations SET status=?,result_text=COALESCE(?,result_text),settled_at=CASE WHEN ? IN ('completed','failed','stopped','interrupted') THEN ? ELSE settled_at END,started_at=CASE WHEN ?='running' THEN COALESCE(started_at,?) ELSE started_at END WHERE task_id=? AND generation=?", status, resultText ?? null, status, at, status, at, task.id, task.generation);
      if (usage !== undefined) this.run("UPDATE task_generations SET usage=? WHERE task_id=? AND generation=?", JSON.stringify(usage), task.id, task.generation);
      if (["completed", "failed", "interrupted", "stopped"].includes(status)) {
        const parent = this.get<TaskRow>("SELECT t.* FROM tasks t JOIN agora_sessions s ON s.id=t.agora_session_id WHERE s.principal_id=?", task.convener_id);
        const triggerTurn = task.notify !== "silent" || parent?.status === "waiting_children";
        this.notice(task.convener_id, `task:${task.id}:${task.generation}:${status}${status === "interrupted" ? `:${runId ?? "unknown"}` : ""}`, `task:${status}`, {
          taskId: task.id, agoraSessionId: task.agora_session_id, nodeId: `agora:session:${task.agora_session_id}`,
          generation: task.generation, status, title: task.title, summary: (resultText ?? "").slice(0, 2000), notify: task.notify, triggerTurn,
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
  sessionParent(sessionId: string): SessionParent | undefined {
    const row = this.get<{ parent_task_id: string | null; parent_session_id: string | null; owner: string | null; type: string | null; pi_session_id: string | null }>(`SELECT t.parent_task_id, parent.agora_session_id AS parent_session_id,
      s.convener_id AS owner,p.type,p.pi_session_id FROM agora_sessions s
      LEFT JOIN tasks t ON t.id=s.task_id LEFT JOIN tasks parent ON parent.id=t.parent_task_id
      LEFT JOIN principals p ON p.id=s.convener_id WHERE s.id=? LIMIT 1`, sessionId);
    if (row?.owner === "user" || row?.type === "user") return { kind: "user" };
    if (row?.parent_task_id) return row.parent_session_id ? { kind: "task", taskId: row.parent_task_id, sessionId: row.parent_session_id } : undefined;
    if (row?.type === "host:cli" || row?.type === "host:pane") return { kind: "user" };
    if (row?.type === "agent:main" && row.pi_session_id) return { kind: "main", piSessionId: row.pi_session_id };
    return undefined;
  }
  sessionMetadata(sessionId: string): SessionMetadata {
    const session = this.session(sessionId);
    const task = session.task_id ? this.get<{ agora_session_id: string; taken_over_from: string | null; parent_task_id: string | null }>(
      "SELECT agora_session_id,taken_over_from,parent_task_id FROM tasks WHERE id=?", session.task_id) : undefined;
    const principal = session.convener_id ? this.principal(session.convener_id) : undefined;
    const parent = this.sessionParent(sessionId);
    const diagnostic = task?.parent_task_id ? { kind: "parent_task_missing", message: "父任务缺少当前会话，无法确定会话父关系" } :
      principal?.type === "agent:main" ? { kind: "main_session_id_missing", message: "主 Agent 召集人的 pi 会话标识缺失" } :
        { kind: "session_parent_unknown", message: "召集人或父任务关联缺失，无法确定会话父关系" };
    return {
      ...(parent ? { parent } : { parentDiagnostics: [diagnostic] }),
      ...(principal?.type === "agent:main" && principal.pi_session_id ? { parentPiSessionId: principal.pi_session_id } : {}),
      ...(session.inherits_from ? { inheritsFrom: session.inherits_from } : {}),
      ...(session.inherit_reason ? { inheritReason: session.inherit_reason } : {}),
      ...(session.task_id ? { isCurrent: task?.agora_session_id === session.id } : {}),
      ...(task ? { takenOver: task.taken_over_from !== null } : {}),
      usage: this.sessionUsage(sessionId),
    };
  }
  sessionUsage(sessionId: string): UsageSummary | undefined {
    const totals = this.get<UsageSummary>(`SELECT COUNT(*) AS requests,
      COALESCE(SUM(input_tokens),0) AS inputTokens, COALESCE(SUM(cache_read_tokens),0) AS cacheReadTokens,
      COALESCE(SUM(cache_write_tokens),0) AS cacheWriteTokens, COALESCE(SUM(output_tokens),0) AS outputTokens,
      COALESCE(SUM(reasoning_tokens),0) AS reasoningTokens, 0 AS contextTokens
      FROM usage_records WHERE agora_session_id=?`, sessionId)!;
    if (!totals.requests) return undefined;
    totals.contextTokens = this.get<{ context_tokens: number }>("SELECT context_tokens FROM usage_records WHERE agora_session_id=? AND context_tokens>0 ORDER BY seq DESC LIMIT 1", sessionId)?.context_tokens ?? 0;
    return totals;
  }
  takeInbox(recipient: string, visibilityMs = 120_000, silentOnly = false): NoticeRow[] {
    return this.transaction(() => {
      const rows = this.all<NoticeRow>("SELECT * FROM outbox WHERE recipient_id=? AND acked_at IS NULL AND visible_after<=? AND (?=0 OR ((json_extract(payload,\'$.notify\')=\'silent\' OR json_extract(payload,\'$.silent\')=1) AND COALESCE(json_extract(payload,\'$.triggerTurn\'),0)<>1)) ORDER BY created_at,id LIMIT 200", recipient, Date.now(), silentOnly ? 1 : 0);
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
