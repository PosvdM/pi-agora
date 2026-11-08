import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { opendir, realpath } from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import type { ParsedSession, SessionEntry } from "@pi-agora/harness-pi";
import { agoraHome, type PermissionProfile, type SessionKind } from "@pi-agora/protocol";
import type {
  ArchiveReaderV1, ArchivedSession, ArchivedSessionSummary, ArchiveState,
  Page, PartialFragment, RunDiagnostics, SessionQuery,
} from "./types.js";
import { ArchiveError } from "./errors.js";
import { archiveDirectory, archivePath, jsonDocument, jsonLines } from "./io.js";
import { projectUserViewAsync } from "./projection.js";
import { verifySessionFile } from "./verify.js";

interface SessionRow {
  id: string; kind: SessionKind; title: string; model: string; profile: PermissionProfile;
  convener_id: string | null; convener_type: string | null; parent_pi_session_id: string | null;
  parent_task_id: string | null; parent_task_session_id: string | null; task_id: string | null;
  meeting_id: string | null; status: string; archive_state: ArchiveState | "live"; inherits_from: string | null;
  created_at: string; ended_at: string | null; session_file: string; pi_session_id: string | null;
  thinking: string; cwd: string; inherit_reason: string | null; task_current_session_id: string | null;
}

const SELECT_SESSION = `SELECT s.id,s.kind,COALESCE(t.title,'') AS title,s.model,s.profile,
  s.convener_id,p.type AS convener_type,p.pi_session_id AS parent_pi_session_id,
  t.parent_task_id,pt.agora_session_id AS parent_task_session_id,s.task_id,s.meeting_id,s.status,
  s.archive_state,s.inherits_from,s.inherit_reason,t.agora_session_id AS task_current_session_id,s.created_at,s.ended_at,s.session_file,s.pi_session_id,s.thinking,s.cwd
  FROM agora_sessions s LEFT JOIN tasks t ON t.id=s.task_id
  LEFT JOIN tasks pt ON pt.id=t.parent_task_id
  LEFT JOIN principals p ON p.id=s.convener_id`;

function limitOf(value?: number): number {
  if (value === undefined) return 50;
  if (!Number.isSafeInteger(value) || value < 1) throw new ArchiveError("invalid_limit", "分页条数必须为正整数");
  return Math.min(value, 200);
}

function encode(value: unknown): string { return Buffer.from(JSON.stringify(value)).toString("base64url"); }
function decode(value: string): unknown {
  if (value.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new ArchiveError("invalid_cursor", "分页游标无效");
  try { return JSON.parse(Buffer.from(value, "base64url").toString("utf8")); }
  catch { throw new ArchiveError("invalid_cursor", "分页游标无效"); }
}
function messageKey(message: Record<string, unknown>): string {
  return JSON.stringify([message.role, typeof message.timestamp === "object" ? null : message.timestamp]);
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function parentOf(row: SessionRow): Pick<ArchivedSessionSummary, "parent" | "parentDiagnostics"> {
  const diagnostic = (kind: string, message: string) => ({ parentDiagnostics: [{ kind, message }] });
  if (row.parent_task_id) {
    return row.parent_task_session_id ? {
      parent: { kind: "task", taskId: row.parent_task_id, sessionId: row.parent_task_session_id },
    } : diagnostic("parent_task_missing", "父任务缺少当前会话，无法确定会话父关系");
  }
  if (row.convener_id === "user" || row.convener_type && ["user", "host:cli", "host:pane"].includes(row.convener_type)) {
    return { parent: { kind: "user" } };
  }
  if (row.convener_type === "agent:main") {
    return row.parent_pi_session_id ? { parent: { kind: "main", piSessionId: row.parent_pi_session_id } } :
      diagnostic("main_session_id_missing", "主 Agent 召集人的 pi 会话标识缺失");
  }
  return diagnostic("session_parent_unknown", "召集人或父任务关联缺失，无法确定会话父关系");
}
function summary(row: SessionRow, missing: boolean): ArchivedSessionSummary {
  return {
    agoraSessionId: row.id, kind: row.kind, title: row.title, model: row.model,
    profile: row.profile, convenerId: row.convener_id ?? "", status: row.status,
    archiveState: missing ? "missing" : row.archive_state === "live" ? "partial" :
      ["ok", "partial", "suspect", "missing"].includes(row.archive_state) ? row.archive_state : "suspect",
    createdAt: row.created_at,
    ...parentOf(row),
    ...(row.convener_type === "agent:main" && row.parent_pi_session_id ? { parentPiSessionId: row.parent_pi_session_id } : {}),
    ...(row.task_id ? { taskId: row.task_id } : {}),
    ...(row.meeting_id ? { meetingId: row.meeting_id } : {}),
    ...(row.inherits_from ? { inheritsFrom: row.inherits_from } : {}),
    ...(row.inherit_reason ? { inheritReason: row.inherit_reason } : {}),
    ...(row.task_id ? { isCurrent: row.task_current_session_id === row.id } : {}),
    ...(row.ended_at ? { endedAt: row.ended_at } : {}),
  };
}

class ArchiveReader implements ArchiveReaderV1 {
  readonly apiVersion = 1 as const;
  private closed = false;
  // 内容指纹不变时复用快照，使 v1 的非持久派生键支持读取器内分页。
  private snapshots = new Map<string, ParsedSession>();
  constructor(private db: DatabaseSync, private home: string, readonly schemaVersion: number) {}

  private active(): void {
    if (this.closed) throw new ArchiveError("closed", "存档读取器已关闭");
  }
  private row(id: string): SessionRow | undefined {
    this.active();
    return this.db.prepare(`${SELECT_SESSION} WHERE s.id=? LIMIT 1`).get(id) as unknown as SessionRow | undefined;
  }
  private usage(id: string): import("@pi-agora/protocol").UsageSummary | undefined {
    const totals = this.db.prepare(`SELECT COUNT(*) AS requests,
      COALESCE(SUM(input_tokens),0) AS inputTokens,COALESCE(SUM(cache_read_tokens),0) AS cacheReadTokens,
      COALESCE(SUM(cache_write_tokens),0) AS cacheWriteTokens,COALESCE(SUM(output_tokens),0) AS outputTokens,
      COALESCE(SUM(reasoning_tokens),0) AS reasoningTokens FROM usage_records WHERE agora_session_id=? LIMIT 1`).get(id) as unknown as Omit<import("@pi-agora/protocol").UsageSummary, "contextTokens">;
    if (!totals.requests) return undefined;
    const context = this.db.prepare("SELECT context_tokens FROM usage_records WHERE agora_session_id=? AND context_tokens>0 ORDER BY seq DESC LIMIT 1").get(id) as { context_tokens: number } | undefined;
    return { ...totals, contextTokens: context?.context_tokens ?? 0 };
  }
  private async required(id: string): Promise<ArchivedSession> {
    const session = await this.getSession(id);
    if (!session) throw new ArchiveError("session_not_found", "会话不存在");
    return session;
  }
  private async parsed(session: ArchivedSession): Promise<ParsedSession> {
    this.active();
    const checked = await archivePath(this.home, session.sessionFile);
    if (checked.missing) throw new ArchiveError("session_file_missing", "会话文件不存在");
    const { parseSessionFile } = await import("@pi-agora/harness-pi");
    try {
      const parsed = await parseSessionFile(checked.file);
      this.active();
      const previous = this.snapshots.get(session.agoraSessionId);
      if (previous && previous.hash === parsed.hash && previous.bytes === parsed.bytes) return previous;
      this.snapshots.set(session.agoraSessionId, parsed);
      return parsed;
    }
    catch (error) {
      if (record(error) && error.code === "ENOENT") throw new ArchiveError("session_file_missing", "会话文件不存在");
      throw error;
    }
  }

  async listSessions(q: SessionQuery = {}): Promise<Page<ArchivedSessionSummary>> {
    this.active();
    const limit = limitOf(q.limit);
    const where: string[] = [];
    const args: SQLInputValue[] = [];
    for (const [key, value] of [["convener_id", q.convenerId], ["meeting_id", q.meetingId], ["task_id", q.taskId]] as const) {
      if (value !== undefined) { where.push(`s.${key}=?`); args.push(value); }
    }
    const scope = [q.convenerId ?? null, q.meetingId ?? null, q.taskId ?? null];
    if (q.cursor !== undefined) {
      const cursor = decode(q.cursor);
      if (!record(cursor) || cursor.kind !== "sessions" || cursor.v !== 1 ||
          typeof cursor.at !== "string" || typeof cursor.id !== "string" || !isDeepStrictEqual(cursor.scope, scope)) {
        throw new ArchiveError("invalid_cursor", "会话分页游标与查询不匹配");
      }
      where.push("(s.created_at<? OR (s.created_at=? AND s.id<?))");
      args.push(cursor.at, cursor.at, cursor.id);
    }
    const rows = this.db.prepare(`${SELECT_SESSION}${where.length ? ` WHERE ${where.join(" AND ")}` : ""}
      ORDER BY s.created_at DESC,s.id DESC LIMIT ?`).all(...args, limit + 1) as unknown as SessionRow[];
    const items: ArchivedSessionSummary[] = [];
    for (const row of rows.slice(0, limit)) {
      const checked = await archivePath(this.home, row.session_file);
      items.push({ ...summary(row, checked.missing), usage: this.usage(row.id) });
    }
    const last = rows[limit - 1];
    return { items, ...(rows.length > limit ? { nextCursor: encode({ v: 1, kind: "sessions", at: last.created_at, id: last.id, scope }) } : {}) };
  }

  async getSession(id: string): Promise<ArchivedSession | undefined> {
    const row = this.row(id);
    if (!row) return undefined;
    const checked = await archivePath(this.home, row.session_file);
    return { ...summary(row, checked.missing), usage: this.usage(row.id), sessionFile: checked.file, thinking: row.thinking, cwd: row.cwd,
      availability: checked.missing ? "missing" : "available",
      ...(row.pi_session_id ? { piSessionId: row.pi_session_id } : {}) };
  }

  async readUserView(id: string, q: { before?: string; limit?: number } = {}): Promise<{
    leafId: string | null; entries: SessionEntry[]; historyBefore: string | null;
  }> {
    const limit = limitOf(q.limit);
    const parsed = await this.parsed(await this.required(id));
    const entries = await projectUserViewAsync(parsed.entries, parsed.leafId);
    let end = entries.length;
    if (q.before !== undefined) {
      end = -1;
      for (let i = 0; i < entries.length; i++) {
        if (entries[i].id === q.before) { end = i; break; }
        if (i % 1000 === 999) await setImmediate();
      }
      if (end < 0) throw new ArchiveError("invalid_before", "历史水位不在当前活动分支中");
    }
    const start = Math.max(0, end - limit);
    return { leafId: parsed.leafId, entries: entries.slice(start, end),
      historyBefore: start > 0 ? entries[start].id : null };
  }

  async readRawEntries(id: string, q: { cursor?: string; limit?: number } = {}): Promise<Page<SessionEntry>> {
    const limit = limitOf(q.limit);
    let start = 0;
    if (q.cursor !== undefined) {
      const cursor = decode(q.cursor);
      if (!record(cursor) || cursor.kind !== "raw" || cursor.v !== 1 || cursor.id !== id ||
          !Number.isSafeInteger(cursor.offset) || (cursor.offset as number) < 0) {
        throw new ArchiveError("invalid_cursor", "原始条目分页游标无效");
      }
      start = cursor.offset as number;
    }
    const parsed = await this.parsed(await this.required(id));
    if (start > parsed.entries.length) throw new ArchiveError("invalid_cursor", "原始条目分页游标超出文件范围");
    const end = Math.min(parsed.entries.length, start + limit);
    return { items: parsed.entries.slice(start, end), ...(end < parsed.entries.length ? {
      nextCursor: encode({ v: 1, kind: "raw", id, offset: end }),
    } : {}) };
  }

  async readPartials(id: string): Promise<PartialFragment[]> {
    const session = await this.required(id);
    const entries = session.availability === "missing" ? [] : (await this.parsed(session)).entries;
    const messages = new Map<string, unknown[]>();
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (entry.type === "message" && record(entry.message)) {
        const key = messageKey(entry.message);
        const candidates = messages.get(key) ?? [];
        candidates.push(entry.message);
        messages.set(key, candidates);
      }
      if (i % 1000 === 999) await setImmediate();
    }
    const directory = await archiveDirectory(this.home, path.join(path.dirname(session.sessionFile), "partials"));
    if (!directory) return [];
    const fragments: PartialFragment[] = [];
    for await (const child of await opendir(directory)) {
      if (!child.name.endsWith(".jsonl")) continue;
      const runId = child.name.slice(0, -6);
      const checked = await archivePath(this.home, path.join(directory, child.name));
      if (checked.missing) continue;
      const pending: PartialFragment[] = [];
      const finalized = new Set<number>();
      for await (const value of jsonLines(checked.file)) {
        if (!record(value) || !Number.isSafeInteger(value.messageSeq) || (value.messageSeq as number) < 0) {
          throw new ArchiveError("invalid_partial", "流片段缺少有效的 messageSeq");
        }
        const seq = value.messageSeq as number;
        if (value.closed === true) {
          finalized.add(seq);
        } else if (value.ended === true) {
          if (record(value.message)) {
            const key = messageKey(value.message);
            const candidates = messages.get(key) ?? [];
            for (let i = 0; i < candidates.length; i++) {
              if (isDeepStrictEqual(candidates[i], value.message)) { finalized.add(seq); break; }
              if (i % 1000 === 999) await setImmediate();
            }
          }
        } else if (typeof value.t === "string" && Number.isSafeInteger(value.contentIndex) &&
            (value.contentIndex as number) >= 0 && typeof value.delta === "string" &&
            ["thinking", "text", "toolCall"].includes(value.blockType as string)) {
          pending.push({ ...value, runId } as PartialFragment);
        } else throw new ArchiveError("invalid_partial", "流片段字段无效");
      }
      for (let i = 0; i < pending.length; i++) {
        if (!finalized.has(pending[i].messageSeq)) fragments.push(pending[i]);
        if (i % 1000 === 999) await setImmediate();
      }
    }
    // 文件名顺序由文件系统决定；消息内部保持持久化顺序。
    return fragments;
  }

  async readDiagnostics(id: string): Promise<RunDiagnostics[]> {
    const session = await this.required(id);
    const results: RunDiagnostics[] = [];
    let after = "";
    for (;;) {
      this.active();
      const rows = this.db.prepare(`SELECT id,diagnostics_path FROM process_runs
        WHERE agora_session_id=? AND id>? ORDER BY id LIMIT 200`).all(id, after) as unknown as {
          id: string; diagnostics_path: string | null;
        }[];
      for (const row of rows) {
        if (path.basename(row.id) !== row.id || row.id === "." || row.id === "..") {
          throw new ArchiveError("unsafe_path", "进程标识不能作为存档文件名");
        }
        const directory = path.dirname(session.sessionFile);
        const candidates = [path.join(directory, "runs", `${row.id}.json`),
          ...(row.diagnostics_path ? [row.diagnostics_path] : []),
          path.join(directory, "runs", `${row.id}.diagnostics.json`),
          path.join(directory, `${row.id}.diagnostics.json`)];
        for (const file of candidates) {
          const checked = await archivePath(this.home, file);
          if (checked.missing) continue;
          const value = await jsonDocument(checked.file);
          if (!record(value)) throw new ArchiveError("invalid_diagnostics", "进程诊断必须为对象");
          results.push({ ...value, runId: row.id });
          break;
        }
      }
      if (rows.length < 200) return results;
      after = rows[rows.length - 1].id;
      await setImmediate();
    }
  }

  async verifySession(id: string) {
    const session = await this.required(id);
    let expected: import("./types.js").VerifyExpected = { hasUnfinishedPartials: (await this.readPartials(id)).length > 0 };
    if (this.schemaVersion >= 6) {
      const baseline = this.db.prepare("SELECT archive_hash,archive_bytes FROM agora_sessions WHERE id=? LIMIT 1").get(id) as { archive_hash: string | null; archive_bytes: number };
      const count = this.db.prepare("SELECT COUNT(*) AS count FROM archive_observed_messages WHERE agora_session_id=? LIMIT 1").get(id) as { count: number };
      const last = this.db.prepare("SELECT role,timestamp FROM archive_observed_messages WHERE agora_session_id=? ORDER BY seq DESC LIMIT 1").get(id) as { role: string; timestamp: string | null } | undefined;
      expected = { ...expected, messageEndCount: count.count,
        ...(baseline.archive_hash ? { previous: { hash: baseline.archive_hash, bytes: baseline.archive_bytes } } : {}),
        ...(last?.timestamp != null ? { lastMessage: { role: last.role, timestamp: JSON.parse(last.timestamp) } } : {}) };
    }
    return verifySessionFile(session.sessionFile, expected);
  }

  async listBoardEntries(_boardId: string, _q?: { afterSeq?: number; limit?: number }): Promise<Page<never>> {
    this.active();
    throw new ArchiveError("unsupported", "存档读取器尚不支持 board，不读取密封草稿");
  }
  async getMeeting(_meetingId: string): Promise<never> {
    this.active();
    throw new ArchiveError("unsupported", "存档读取器尚不支持 meeting");
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.snapshots.clear();
    this.db.close();
  }
}

export async function openArchive(opts: { home?: string; apiVersion: 1 }): Promise<ArchiveReaderV1> {
  if (opts.apiVersion !== 1) throw new ArchiveError("unsupported_api", "存档 API 版本不支持");
  const home = await realpath(agoraHome(opts.home));
  const file = await archivePath(home, path.join(home, "agora.db"));
  if (file.missing) throw new ArchiveError("database_missing", "存档数据库不存在");
  const db = new DatabaseSync(file.file, { readOnly: true });
  try {
    const version = Number((db.prepare("SELECT version FROM schema_version LIMIT 1").get() as { version?: number } | undefined)?.version);
    if (!Number.isInteger(version) || version < 4 || version > 6) {
      throw new ArchiveError("unsupported_schema", "存档数据库版本不支持；支持 v4、v5 和 v6 的共用列");
    }
    return new ArchiveReader(db, home, version);
  } catch (error) { db.close(); throw error; }
}
