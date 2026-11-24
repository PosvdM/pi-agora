import type { IncomingMessage, ServerResponse } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import type { Auth, Connection } from "./auth.js";
import { AgoraError, invalid } from "./errors.js";
import type { Store } from "./store.js";

export interface ChangesCursor { epoch: string; seq: number }
interface ChangeRow { seq: number; epoch: string; object_type: string; object_id: string; tombstone: number; created_at: string }
const BATCH = 256;
const KEEP = 100_000;
const MAX_AGE = 7 * 86_400_000;

export function changesCursor(store: Store): ChangesCursor {
  return {
    epoch: store.get<{ value: string }>("SELECT value FROM settings WHERE key='epoch'")!.value,
    seq: store.get<{ seq: number }>("SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='changes'),0) AS seq")!.seq,
  };
}

export function readChanges(store: Store, epoch: string, afterSeq: number) {
  return store.readTransaction(() => {
    const cursor = changesCursor(store);
    const floor = store.get<{ seq: number }>(`SELECT MAX(
      COALESCE((SELECT CAST(value AS INTEGER) FROM settings WHERE key='changes:floor'),0),
      COALESCE((SELECT MIN(seq)-1 FROM changes),0)) AS seq`)!.seq;
    if (epoch !== cursor.epoch || afterSeq < floor || afterSeq > cursor.seq) return { cursor, reset: true, rows: [] };
    const rows = store.all<ChangeRow>("SELECT * FROM changes WHERE seq>? ORDER BY seq LIMIT ?", afterSeq, BATCH);
    let expected = afterSeq + 1;
    for (const row of rows) if (row.epoch !== epoch || row.seq !== expected++) return { cursor, reset: true, rows: [] };
    if (rows.length < BATCH && (rows[rows.length - 1]?.seq ?? afterSeq) < cursor.seq) return { cursor, reset: true, rows: [] };
    return { cursor, reset: false, rows };
  });
}

// 清理连续前缀，保留对象的修订号和活动时间，供冷节点列表使用。
export function pruneChanges(store: Store, at = Date.now()): number {
  return store.transaction(() => {
    const cutoff = store.get<{ seq: number }>("SELECT seq FROM changes ORDER BY seq DESC LIMIT 1 OFFSET ?", KEEP);
    if (!cutoff) return 0;
    const candidates = store.all<ChangeRow>("SELECT * FROM changes WHERE seq<=? ORDER BY seq LIMIT 1000", cutoff.seq);
    const expired: ChangeRow[] = [];
    for (const row of candidates) {
      if (!(Date.parse(row.created_at) < at - MAX_AGE)) break;
      expired.push(row);
    }
    if (!expired.length) return 0;
    const latest = new Map<string, ChangeRow>();
    for (const row of expired) latest.set(`changes:object:${row.object_type}:${row.object_id}`, row);
    for (const [key, row] of latest) store.run("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", key, JSON.stringify({ seq: row.seq, at: row.created_at }));
    const last = expired[expired.length - 1]!.seq;
    store.run("INSERT INTO settings(key,value) VALUES('changes:floor',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", String(last));
    return Number(store.run("DELETE FROM changes WHERE seq<=?", last).changes);
  });
}

export function requireChangesHost(conn: Connection): void {
  if (conn.type !== "host:cli" && conn.type !== "host:pane") throw new AgoraError(403, "forbidden", "变更流仅允许主机客户端订阅");
}

export async function streamChanges(store: Store, auth: Auth, conn: Connection, url: URL, request: IncomingMessage, response: ServerResponse, closing: AbortSignal): Promise<void> {
  requireChangesHost(conn);
  const epoch = url.searchParams.get("epoch");
  const value = url.searchParams.get("afterSeq");
  if (!epoch || epoch.length > 256 || value === null || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) invalid("变更游标无效");
  let afterSeq = Number(value);
  let batch = readChanges(store, epoch, afterSeq);
  const stopped = new AbortController();
  const stop = () => { stopped.abort(); response.destroy(); };
  response.once("close", stop);
  closing.addEventListener("abort", stop, { once: true });
  const valid = () => {
    if (closing.aborted || response.destroyed || response.writableEnded) return false;
    requireChangesHost(auth.authenticate(request.headers.authorization));
    return auth.connections.get(conn.token) === conn;
  };
  const write = async (text: string) => {
    if (!valid()) return false;
    if (!response.write(text)) {
      while (response.writableNeedDrain) {
        await delay(50, undefined, { signal: stopped.signal });
        if (!valid()) return false;
      }
    }
    return true;
  };
  try {
    if (!valid()) return;
    response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    response.flushHeaders();
    let heartbeat = Date.now();
    while (valid()) {
      if (batch.reset) {
        if (await write(`event: reset\ndata: ${JSON.stringify({ epoch: batch.cursor.epoch })}\n\n`)) response.end();
        return;
      }
      for (const row of batch.rows) {
        const data = { cursor: { epoch: row.epoch, seq: row.seq }, objectType: row.object_type, objectId: row.object_id, tombstone: !!row.tombstone };
        if (!await write(`event: change\ndata: ${JSON.stringify(data)}\n\n`)) return;
        afterSeq = row.seq;
      }
      if (Date.now() - heartbeat >= 15_000) {
        if (!await write(": keepalive\n\n")) return;
        heartbeat = Date.now();
      }
      // 每批让出事件循环；慢连接只保留一个有界批次。
      await delay(batch.rows.length === BATCH ? 0 : 200, undefined, { signal: stopped.signal });
      if (!valid()) return;
      batch = readChanges(store, epoch, afterSeq);
    }
  } catch {
    response.destroy();
  } finally {
    closing.removeEventListener("abort", stop);
    response.removeListener("close", stop);
    stopped.abort();
    if (!response.writableEnded) response.destroy();
  }
}
