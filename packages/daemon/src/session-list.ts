import { createHash } from "node:crypto";
import type { Connection } from "./auth.js";
import { AgoraError, invalid } from "./errors.js";
import type { Store, SessionRow } from "./store.js";
import { changesCursor } from "./changes.js";

interface ListedSession extends SessionRow {
  cursor: number; parent_id: string | null; title: string; kind: string;
  child_count: number; last_activity_at: string; status_detail: string | null;
  archive_state: string; tree_revision: number; effective_status: string;
}
interface Filter { owner: string | null; parent: string | null; snapshot: boolean; open: string[]; recent: string | null; legacy: boolean }

function filterOf(conn: Connection, params: URLSearchParams): Filter {
  const parent = params.get("parent"), snapshotValue = params.get("snapshot");
  if (snapshotValue !== null && snapshotValue !== "1") invalid("snapshot 必须为 1");
  const snapshot = snapshotValue === "1";
  if (parent !== null && (!parent || parent.length > 1024 || snapshot)) invalid("parent 参数无效或与 snapshot 冲突");
  const open = [...new Set(params.getAll("openNodeId"))].sort();
  if (open.length > 1000 || open.some(node => !node || node.length > 1024)) invalid("打开节点参数超出范围");
  const rawRecent = params.get("recentSince");
  let recent: string | null = null;
  if (rawRecent !== null) {
    if (!/^\d{4}-\d{2}-\d{2}T/.test(rawRecent) || !Number.isFinite(Date.parse(rawRecent))) invalid("recentSince 必须为 ISO 时间");
    recent = new Date(rawRecent).toISOString();
  }
  if (!snapshot && (open.length || recent !== null)) invalid("热节点过滤必须指定 snapshot=1");
  return { owner: conn.type === "agent:main" ? conn.principalId! : null, parent, snapshot, open, recent, legacy: parent === null && !snapshot };
}

// 原列表只列直接召集的任务；树查询允许读取同一召集人的任务子树。
function treeSql(): string {
  return `WITH RECURSIVE allowed(id) AS (
    SELECT id FROM tasks WHERE $owner IS NULL OR convener_id=$owner
    UNION SELECT t.id FROM tasks t JOIN allowed a ON t.parent_task_id=a.id
  ), base AS (
    SELECT s.*,s.rowid AS cursor,t.title,t.status_detail,t.convener_id AS task_convener_id,
      CASE WHEN t.agora_session_id=s.id THEN t.status ELSE s.status END AS effective_status,
      CASE WHEN t.parent_task_id IS NOT NULL THEN 'agora:session:' || pt.agora_session_id
        WHEN COALESCE(s.convener_id,t.convener_id) IN ('user','host:cli','host:pane') OR p.type LIKE 'host:%' THEN 'agora:root:user-tasks'
        WHEN p.pi_session_id IS NOT NULL THEN 'pane:session:' || p.pi_session_id ELSE NULL END AS parent_id,
      MAX(s.created_at,t.updated_at,
        COALESCE((SELECT created_at FROM changes WHERE object_type='session' AND object_id=s.id ORDER BY seq DESC LIMIT 1),s.created_at),
        COALESCE((SELECT created_at FROM changes WHERE object_type='task' AND object_id=t.id ORDER BY seq DESC LIMIT 1),s.created_at),
        COALESCE(json_extract(sm.value,'$.at'),s.created_at),COALESCE(json_extract(tm.value,'$.at'),s.created_at)) AS last_activity_at,
      MAX(COALESCE((SELECT seq FROM changes WHERE object_type='session' AND object_id=s.id ORDER BY seq DESC LIMIT 1),0),
        COALESCE((SELECT seq FROM changes WHERE object_type='task' AND object_id=t.id ORDER BY seq DESC LIMIT 1),0),
        COALESCE(json_extract(sm.value,'$.seq'),0),COALESCE(json_extract(tm.value,'$.seq'),0)) AS tree_revision
    FROM agora_sessions s JOIN tasks t ON t.id=s.task_id JOIN allowed a ON a.id=t.id
    LEFT JOIN tasks pt ON pt.id=t.parent_task_id
    LEFT JOIN principals p ON p.id=COALESCE(s.convener_id,t.convener_id)
    LEFT JOIN settings sm ON sm.key='changes:object:session:' || s.id
    LEFT JOIN settings tm ON tm.key='changes:object:task:' || t.id
  )`;
}

export function sessionView(session: ListedSession) {
  return { agoraSessionId: session.id, taskId: session.task_id, piSessionId: session.pi_session_id,
    profile: session.profile, model: session.model, thinking: session.thinking, cwd: session.cwd,
    status: session.effective_status ?? session.status, revision: session.tree_revision, createdAt: session.created_at,
    parentId: session.parent_id, title: session.title, kind: session.kind,
    hasChildren: session.child_count > 0, childCount: session.child_count,
    lastActivityAt: session.last_activity_at, statusDetail: session.status_detail, archiveState: session.archive_state };
}

export function listSessions(store: Store, conn: Connection, params: URLSearchParams, limit: number) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) invalid("分页大小超出范围");
  const filter = filterOf(conn, params);
  return store.readTransaction(() => {
    const cursor = changesCursor(store);
    const fingerprint = createHash("sha256").update(JSON.stringify([cursor.epoch, filter])).digest("base64url");
    const raw = params.get("cursor");
    let after = 0;
    if (raw && raw !== "0") {
      if (/^\d+$/.test(raw) && filter.legacy) after = Number(raw);
      else {
        try {
          if (raw.length > 2048 || !/^[\w-]+$/.test(raw)) throw new Error();
          const page = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
          if (page.v !== 1 || page.filter !== fingerprint) throw new Error();
          after = page.after;
        } catch { invalid("分页游标与查询条件不符"); }
      }
      if (!Number.isSafeInteger(after) || after < 0) invalid("分页游标无效");
    }
    if (filter.snapshot && raw) invalid("树快照不接受分页游标");
    const resultLimit = filter.snapshot ? 10_000 : limit;
    const args = { $owner: filter.owner, $legacy: filter.legacy ? 1 : 0, $after: after, $limit: resultLimit + 1, $parent: filter.parent };
    let sql = treeSql();
    if (filter.snapshot) {
      sql += `, hot(id) AS (SELECT id FROM base WHERE effective_status IN ('created','running','waiting','paused','waiting_decision','waiting_children','quota_paused')
        OR 'agora:session:' || id IN (SELECT value FROM json_each($open)) OR ($recent IS NOT NULL AND last_activity_at>$recent)),
        wanted(id) AS (SELECT id FROM hot UNION SELECT b.id FROM base b JOIN wanted w JOIN base child ON child.id=w.id AND child.parent_id='agora:session:' || b.id)`;
    }
    sql += ` SELECT b.*,(SELECT COUNT(*) FROM base child WHERE child.parent_id='agora:session:' || b.id) AS child_count FROM base b
      WHERE b.cursor>$after AND ($parent IS NULL OR b.parent_id=$parent)
        AND ($legacy=0 OR $owner IS NULL OR b.task_convener_id=$owner)
        ${filter.snapshot ? "AND b.id IN (SELECT id FROM wanted)" : ""} ORDER BY b.cursor LIMIT $limit`;
    const rows = store.db.prepare(sql).all({ ...args, ...(filter.snapshot ? { $open: JSON.stringify(filter.open), $recent: filter.recent } : {}) }) as unknown as ListedSession[];
    if (filter.snapshot && rows.length > resultLimit) throw new AgoraError(413, "snapshot_too_large", "热节点及祖先超过一万条，请减少打开的会话和最近时间范围");
    const items = rows.slice(0, resultLimit).map(sessionView);
    const nextCursor = rows.length > resultLimit ? Buffer.from(JSON.stringify({ v: 1, after: rows[resultLimit - 1]!.cursor, filter: fingerprint })).toString("base64url") : null;
    return { items, nextCursor, changesCursor: cursor };
  });
}

export function sessionDetail(store: Store, sessionId: string) {
  return store.readTransaction(() => {
    const row = store.db.prepare(`${treeSql()} SELECT b.*,(SELECT COUNT(*) FROM base child WHERE child.parent_id='agora:session:' || b.id) AS child_count FROM base b WHERE b.id=$id`)
      .get({ $owner: null, $id: sessionId }) as unknown as ListedSession | undefined;
    if (!row) throw new AgoraError(404, "not_found", "会话不存在");
    return sessionView(row);
  });
}
