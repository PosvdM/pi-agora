import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Auth, type Connection } from "./auth.js";
import { AgoraError, invalid, object, optionalBoolean, stableJson } from "./errors.js";
import { Store, id, type SessionRow } from "./store.js";
import { TaskManager } from "./tasks.js";

export const VERSION = "0.1.0";
export const PROTOCOL_RANGE = { min: 1, max: 1 };
export interface ServerContext {
  store: Store; auth: Auth; tasks: TaskManager; instanceId: string;
  close(options?: { force?: boolean; timeoutMs?: number }): Promise<void>;
  closing: AbortSignal;
}
interface Reply { status: number; body: unknown }
interface Operation { id: string; state: string; fingerprint: string; status: number | null; result: string | null }
function reply(response: ServerResponse, status: number, body: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  response.end(JSON.stringify(body));
}
function asError(error: unknown): Reply {
  if (error instanceof AgoraError) return { status: error.status, body: { error: { code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) } } };
  return { status: 500, body: { error: { code: "internal_error", message: "后台处理失败，请查看诊断" } } };
}
async function bodyOf(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (request.headers["content-type"] && !/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"])) throw new AgoraError(415, "unsupported_media_type", "请求体必须使用 JSON");
  let length = 0;
  const chunks: Buffer[] = [];
  for await (const part of request) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
    length += chunk.length;
    if (length > 1_100_000) throw new AgoraError(413, "request_too_large", "请求体超过大小限制");
    chunks.push(chunk);
  }
  if (!length) return {};
  try { return object(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
  catch (error) { if (error instanceof AgoraError) throw error; invalid("JSON 请求体无效"); }
}
function positive(value: string | null, fallback: number, max: number, zero = false): number {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value)) invalid("分页或等待参数无效");
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < (zero ? 0 : 1) || n > max) invalid("分页或等待参数超出范围");
  return n;
}
function hostOnly(conn: Connection): void {
  if (conn.type !== "host:cli") throw new AgoraError(403, "forbidden", "此操作仅允许 CLI 执行");
}
function sessionView(session: SessionRow) {
  return { agoraSessionId: session.id, taskId: session.task_id, piSessionId: session.pi_session_id,
    profile: session.profile, model: session.model, thinking: session.thinking, cwd: session.cwd,
    status: session.status, revision: session.revision, createdAt: session.created_at };
}

export function createHttpServer(context: ServerContext) {
  const server = createServer(async (request, response) => {
    try {
      if (request.headers.origin !== undefined) throw new AgoraError(403, "forbidden", "不接受浏览器来源请求");
      // Host 必须与监听的 loopback 端口相符，拒绝 DNS rebinding 和绝对 URL。
      const address = server.address();
      const host = address && typeof address !== "string" ? `127.0.0.1:${address.port}` : "";
      if (request.headers.host !== host || !request.url?.startsWith("/") || request.url.startsWith("//")) throw new AgoraError(400, "invalid_host", "请求地址无效");
      const url = new URL(request.url, `http://${host}`);
      const method = request.method ?? "GET";
      if (url.pathname === "/v1/health" && method === "GET") {
        reply(response, 200, { daemonVersion: VERSION, instanceId: context.instanceId, protocol: PROTOCOL_RANGE });
        return;
      }
      if (request.headers["agora-protocol"] !== "1") throw new AgoraError(426, "protocol_unsupported", "协议版本不兼容，请升级客户端或重启 daemon", { protocol: PROTOCOL_RANGE });
      const authRoute = url.pathname.startsWith("/v1/auth/");
      let conn: Connection | undefined;
      if (!authRoute || url.pathname === "/v1/auth/refresh") conn = context.auth.authenticate(request.headers.authorization);
      const body = method === "POST" ? await bodyOf(request) : {};
      if (request.headers["agora-act-as"] !== undefined) throw new AgoraError(403, "forbidden", "此切片不提供用户级操作");
      const perform = () => route(context, method, url, conn, body, request, response);
      const key = request.headers["idempotency-key"];
      let result: Reply;
      const idempotent = method === "POST" && conn?.principalId && !authRoute && !url.pathname.endsWith("/ready") && !url.pathname.endsWith("/fatal") && !url.pathname.startsWith("/v1/lease/");
      if (key !== undefined && idempotent) {
        if (conn!.type === "agent:main") context.auth.requireMain(conn!);
        if (typeof key !== "string" || !key.length || key.length > 256) invalid("幂等键无效");
        context.store.run("DELETE FROM operations WHERE created_at<?", Date.now() - 86_400_000);
        const fingerprint = createHash("sha256").update(stableJson([method, url.pathname + url.search, body])).digest("hex");
        const old = context.store.get<Operation>("SELECT * FROM operations WHERE principal_id=? AND key=?", conn!.principalId!, key);
        if (old) {
          if (old.fingerprint !== fingerprint) throw new AgoraError(409, "idempotency_mismatch", "同一幂等键的请求参数不同");
          result = old.result ? { status: old.status!, body: JSON.parse(old.result) } : { status: 202, body: { operation: { id: old.id, state: old.state } } };
        } else {
          context.store.run("INSERT INTO operations(principal_id,key,fingerprint,id,state,created_at) VALUES(?,?,?,?,'in_progress',?)", conn!.principalId!, key, fingerprint, id("op"), Date.now());
          try { result = await perform(); } catch (error) { result = asError(error); }
          context.store.run("UPDATE operations SET state=?,status=?,result=? WHERE principal_id=? AND key=?", result.status < 400 ? "succeeded" : "failed", result.status, JSON.stringify(result.body), conn!.principalId!, key);
        }
      } else result = await perform();
      reply(response, result.status, result.body);
    } catch (error) { const result = asError(error); reply(response, result.status, result.body); }
  });
  server.requestTimeout = 35_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 1000;
  return server;
}

async function route(context: ServerContext, method: string, url: URL, conn: Connection | undefined, body: Record<string, unknown>, request: IncomingMessage, response: ServerResponse): Promise<Reply> {
  const { auth, store, tasks } = context;
  const pathname = url.pathname;
  const ok = (value: unknown): Reply => ({ status: 200, body: value });
  if (method === "POST") {
    if (pathname === "/v1/auth/challenge") return ok(auth.challenge(body));
    if (pathname === "/v1/auth/token") return ok(auth.exchange(body));
    if (pathname === "/v1/auth/launch") return ok(auth.launch(body));
    if (pathname === "/v1/auth/refresh") return ok(auth.refresh(conn!));
  }
  if (!conn) throw new AgoraError(404, "not_found", "接口不存在");
  if (method === "POST" && pathname === "/v1/principals/register") return ok(await auth.register(conn, body));
  if (method === "POST" && pathname === "/v1/principals/reclaim") return ok(await auth.reclaim(conn, body));
  if (method === "POST" && pathname === "/v1/lease/renew") { const result = auth.renew(conn); auth.refresh(conn); return ok(result); }
  if (method === "POST" && pathname === "/v1/lease/release") return ok(auth.release(conn));
  const run = pathname.match(/^\/v1\/runs\/([^/]+)\/(ready|fatal)$/);
  if (method === "POST" && run) return ok(run[2] === "ready" ? await tasks.ready(conn, body, run[1]!) : tasks.fatal(conn, run[1]!));
  if (pathname === "/v1/tasks") {
    if (method === "POST") return { status: 201, body: await tasks.spawn(conn, body) };
    if (method === "GET") return ok(tasks.list(conn, url.searchParams.get("scope") ?? "mine", positive(url.searchParams.get("limit"), 50, 200), positive(url.searchParams.get("cursor"), 0, Number.MAX_SAFE_INTEGER, true), url.searchParams.getAll("status")));
  }
  const task = pathname.match(/^\/v1\/tasks\/([^/]+)(?:\/(result|stop))?$/);
  if (task) {
    if (method === "GET" && !task[2]) return ok(tasks.status(conn, task[1]!));
    if (method === "GET" && task[2] === "result") return ok(tasks.result(conn, task[1]!, url.searchParams.has("generation") ? positive(url.searchParams.get("generation"), 1, Number.MAX_SAFE_INTEGER) : undefined));
    if (method === "POST" && task[2] === "stop") return ok(await tasks.stop(conn, task[1]!, body));
  }
  if (pathname === "/v1/inbox" && method === "GET") {
    const recipient = auth.inboxRecipient(conn);
    const wait = positive(url.searchParams.get("wait"), 0, 25, true);
    const deadline = Date.now() + wait * 1000;
    let rows = store.takeInbox(recipient);
    while (!rows.length && Date.now() < deadline && !context.closing.aborted && !response.destroyed) {
      await delay(Math.min(200, Math.max(1, deadline - Date.now())), undefined, { signal: context.closing }).catch(() => {});
      if (!context.closing.aborted && !response.destroyed) {
        auth.inboxRecipient(conn);
        rows = store.takeInbox(recipient);
      }
    }
    return ok({ items: rows.map(row => ({ noticeId: row.id, dedupeKey: row.dedupe_key, kind: row.kind, payload: JSON.parse(row.payload), createdAt: row.created_at })) });
  }
  if (pathname === "/v1/inbox/ack" && method === "POST") return ok(auth.ack(conn, body));
  if (pathname === "/v1/status" && method === "GET") {
    auth.requireMain(conn);
    return ok({ daemonVersion: VERSION, instanceId: context.instanceId, protocol: PROTOCOL_RANGE, draining: tasks.draining, activeRuns: tasks.activeCount(), taskCounts: store.all("SELECT status,COUNT(*) AS count FROM tasks GROUP BY status LIMIT 20") });
  }
  if (pathname === "/v1/sessions" && method === "GET") {
    auth.requireMain(conn);
    const limit = positive(url.searchParams.get("limit"), 50, 200), cursor = positive(url.searchParams.get("cursor"), 0, Number.MAX_SAFE_INTEGER, true);
    const owner = conn.type === "agent:main" ? conn.principalId! : null;
    const rows = store.all<SessionRow & { cursor: number }>("SELECT s.rowid AS cursor,s.* FROM agora_sessions s JOIN tasks t ON t.id=s.task_id WHERE s.rowid>? AND (? IS NULL OR t.convener_id=?) ORDER BY s.rowid LIMIT ?", cursor, owner, owner, limit + 1);
    return ok({ items: rows.slice(0, limit).map(sessionView), nextCursor: rows.length > limit ? String(rows[limit - 1]!.cursor) : null,
      changesCursor: { epoch: store.get<{ value: string }>("SELECT value FROM settings WHERE key='epoch'")!.value, seq: store.get<{ seq: number }>("SELECT COALESCE(MAX(seq),0) AS seq FROM changes")!.seq } });
  }
  const session = pathname.match(/^\/v1\/sessions\/([^/]+)$/);
  if (method === "GET" && session) {
    const row = store.session(session[1]!);
    tasks.status(conn, row.task_id);
    return ok(sessionView(row));
  }
  if (pathname === "/v1/admin/shutdown" && method === "POST") {
    hostOnly(conn);
    const force = optionalBoolean(body.force, "force") ?? false;
    const timeoutMs = body.timeoutMs === undefined ? 600_000 : body.timeoutMs;
    if (typeof timeoutMs !== "number" || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) invalid("关闭超时无效");
    await tasks.shutdown(force, timeoutMs);
    response.once("finish", () => { void context.close({ force, timeoutMs }).catch(() => {}); });
    return ok({ stopped: true });
  }
  throw new AgoraError(404, "not_found", "接口不存在");
}
