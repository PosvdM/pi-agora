import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Auth, type Connection } from "./auth.js";
import { AgoraError, invalid, object, optionalBoolean, stableJson, text } from "./errors.js";
import { Store, id } from "./store.js";
import { pruneChanges, streamChanges } from "./changes.js";
import { listSessions, sessionDetail } from "./session-list.js";
import { archiveStorageBytes } from "./archive-verification.js";
import { deleteArchiveOnline } from "./archive-maintenance.js";
import { confirmationRequired } from "./acl.js";

import { TaskManager } from "./tasks.js";
import { Requests } from "./requests.js";
import { Security, type SignatureBody } from "./security.js";
import type { UserExecutionProof } from "./budgets.js";

export const VERSION = "0.1.0";
export const PROTOCOL_RANGE = { min: 1, max: 1 };
export interface ServerContext {
  store: Store; auth: Auth; tasks: TaskManager; requests: Requests; security: Security; instanceId: string;
  close(options?: { force?: boolean; timeoutMs?: number }): Promise<void>;
  closing: AbortSignal;
}
interface Reply { status: number; body: unknown }
interface Operation { id: string; state: string; fingerprint: string; status: number | null; result: string | null }
function reply(response: ServerResponse, status: number, body: unknown): void {
  if (response.destroyed || response.writableEnded || response.headersSent) return;
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


function hostClient(auth: Auth, conn: Connection): void {
  auth.requireMain(conn);
  if (!conn.type.startsWith("host:")) throw new AgoraError(403, "forbidden", "设备和安全设置仅供用户界面发起");
}
function userOperation(pathname: string, method: string, conn: Connection): { action: string; target: string } | undefined {
  if (!["POST", "PUT"].includes(method)) return;
  const paths: [RegExp, string][] = [
    [/^\/v1\/settings\/([^/]+)$/, "agora.settings.set"],
    [/^\/v1\/sessions\/([^/]+)\/archive\/delete$/, "agora.archive.delete"],
    [/^\/v1\/devices\/(pair|reset)$/, "agora.device"],
    [/^\/v1\/devices\/([^/]+)\/(approve|revoke)$/, "agora.device"],
    [/^\/v1\/security\/alerts\/([^/]+)\/acknowledge$/, "agora.security.acknowledge"],
    [/^\/v1\/principals\/([^/]+)\/takeover$/, "agora.principal.takeover"],
    [/^\/v1\/tasks\/([^/]+)\/takeover$/, "agora.task.takeover"],
    [/^\/v1\/confirmations\/([^/]+)\/cancel$/, "confirmation.cancel"],
  ];
  if (conn.type.startsWith("host:")) paths.push([/^\/v1\/requests\/([^/]+)\/(answer|cancel)$/, "agora.request"], [/^\/v1\/tasks\/([^/]+)\/(recover|limits)$/, "agora.task"]);
  for (const [pattern, action] of paths) {
    const match = pathname.match(pattern);
    if (match) return { action: action === "agora.device" || action === "agora.request" || action === "agora.task" ? `${action}.${match[2] ?? match[1]}` : action, target: match[1]! };
  }
}
function forceSignature(action: string): boolean {
  return action.startsWith("agora.device.") || action === "agora.settings.set" || action === "agora.security.acknowledge" || action === "agora.archive.delete";
}
function confirmationReply(value: unknown): Reply {
  return { status: 202, body: { code: "confirmation_required", confirmation: value } };
}
function visibleConfirmation(context: ServerContext, conn: Connection, confirmationId: string) {
  const value = context.security.confirmation(confirmationId);
  if (!conn.type.startsWith("host:") && value.requestedBy !== conn.principalId) {
    context.security.recordExecution("confirmation.read", confirmationId, conn.principalId!, "none", "rejected", "forbidden");
    throw new AgoraError(403, "forbidden", "主会话只能访问自己发起的待确认");
  }
  return value;
}
function currentOperation(context: ServerContext, old: Operation): Reply {
  const body = JSON.parse(old.result!) as { confirmation?: { confirmationId?: string } };
  if (old.state !== "awaiting_confirmation" || !body.confirmation?.confirmationId) return { status: old.status!, body };
  const confirmation = context.security.confirmation(body.confirmation.confirmationId);
  if (["confirmed", "failed", "cancelled", "expired"].includes(confirmation.state)) {
    const succeeded = confirmation.state === "confirmed";
    const status = succeeded ? 200 : confirmation.state === "expired" ? 410 : 409;
    const result = succeeded ? confirmation.result : { error: { code: `confirmation_${confirmation.state}`, message: "待确认未执行，请重新核对操作" } };
    context.store.run("UPDATE operations SET state=?,status=?,result=? WHERE id=?", succeeded ? "succeeded" : "failed", status, JSON.stringify(result), old.id);
    return { status, body: result };
  }
  return { status: 202, body };
}
function executeUser(context: ServerContext, conn: Connection, action: string, target: string, params: Record<string, unknown>, proof: UserExecutionProof): unknown {
  const execute = () => executeUserAction(context, conn, action, target, params, proof);
  if (proof.confirmedBy === "device") return execute();
  if (["agora.task.spawn", "agora.task.recover"].includes(action)) return (async () => {
    try {
      const value = await execute();
      context.security.recordExecution(action, target, proof.requestedBy, "none", "applied");
      return value;
    } catch (error) {
      context.security.recordExecution(action, target, proof.requestedBy, "none", "rejected", error instanceof AgoraError ? error.code : "execution_failed");
      throw error;
    }
  })();
  try { return context.store.transaction(() => {
    const value = execute();
    context.security.recordExecution(action, target, proof.requestedBy, "none", "applied");
    return value;
  }); } catch (error) {
    context.security.recordExecution(action, target, proof.requestedBy, "none", "rejected", error instanceof AgoraError ? error.code : "execution_failed");
    throw error;
  }
}
function executeUserAction(context: ServerContext, conn: Connection, action: string, target: string, params: Record<string, unknown>, proof: UserExecutionProof): unknown {
  // 此入口仅接收安全服务验证过的上下文，不从 HTTP 参数构造授权。
  const requester = context.store.principal(proof.requestedBy);
  if (requester?.type === "agent:main") {
    const original = [...context.auth.connections.values()].find(value => value.principalId === proof.requestedBy && value.connectionId === requester.lease_connection_id && value.expiresAt > Date.now());
    if (!original) throw new AgoraError(409, "lease_required", "发起确认的主会话已失去控制租约，请重新发起");
    context.auth.requireAgent(original);
    conn = original;
  }
  if (action === "agora.request.answer" || action === "agora.request.cancel") return context.requests.updateUser(conn, target, action.slice("agora.request.".length), params, proof);
  if (action === "agora.principal.takeover") return context.auth.takeOver(conn, target, params);
  if (action === "agora.task.spawn") return context.tasks.spawn(conn, params, proof);
  if (action === "agora.task.limits") return context.tasks.limits(conn, target, params, proof);
  if (action === "agora.task.recover") return context.tasks.recover(conn, target, params, proof);
  if (action === "agora.task.takeover") return context.tasks.takeOver(conn, target, params, proof);
  if (action === "agora.archive.delete") return context.tasks.archiveControl(target, async () => {
    await context.tasks.archives.flush();
    return deleteArchiveOnline({ store: context.store, sessions: context.tasks.sessions, sessionId: target,
      expectedRevision: Number(params.expectedRevision), authorize: () => context.tasks.acl.session(conn, context.store.session(target)) });
  });
  throw new AgoraError(400, "invalid_params", "不支持此用户级动作");
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
      const body = ["POST", "PUT"].includes(method) ? await bodyOf(request) : {};
      const actAs = request.headers["agora-act-as"];
      if (actAs !== undefined && (actAs !== "user" || !conn || conn.type === "agent:child" || !["POST", "PUT"].includes(method))) throw new AgoraError(403, "forbidden", "此请求不能以用户身份发起");
      const perform = async (): Promise<Reply> => {
        try { return await route(context, method, url, conn, body, request, response); }
        catch (error) {
          if (!(error instanceof AgoraError) || error.code !== "confirmation_required" || !conn) {
            const operation = conn ? userOperation(url.pathname, method, conn) : undefined;
            if (operation) context.security.recordExecution(operation.action, operation.target, conn!.principalId ?? conn!.type, "none", "rejected", error instanceof AgoraError ? error.code : "execution_failed");
            throw error;
          }
          const pending = object(error.details);
          const action = String(pending.action), target = String(pending.target), params = object(pending.params);
          if (context.security.state().userConfirmation === "off" && conn.type === "host:cli" && !forceSignature(action)) {
            const proof: UserExecutionProof = { confirmedBy: "none", requestedBy: conn.principalId!, deviceId: "", confirmationId: "" };
            try {
              const value = await executeUser(context, conn, action, target, params, proof);
              return { status: 200, body: value };
            } catch (executionError) {
              if (!(executionError instanceof AgoraError) || executionError.code !== "confirmation_required") throw executionError;
              // 关闭保护也不能绕过未签名预算封顶，仍须设备签名。
            }
          }
          return confirmationReply(context.security.request(conn, action, target, params));
        }
      };
      const key = request.headers["idempotency-key"];
      let result: Reply;
      const idempotent = ["POST", "PUT"].includes(method) && conn?.principalId && !authRoute && !url.pathname.endsWith("/ready") && !url.pathname.endsWith("/fatal") && !url.pathname.startsWith("/v1/lease/");
      if (key !== undefined && idempotent) {
        context.auth.requireAgent(conn!);
        if (typeof key !== "string" || !key.length || key.length > 256) invalid("幂等键无效");
        context.store.run("DELETE FROM operations WHERE created_at<?", Date.now() - 86_400_000);
        const fingerprint = createHash("sha256").update(stableJson([method, url.pathname + url.search, body])).digest("hex");
        const old = context.store.get<Operation>("SELECT * FROM operations WHERE principal_id=? AND key=?", conn!.principalId!, key);
        if (old) {
          if (old.fingerprint !== fingerprint) throw new AgoraError(409, "idempotency_mismatch", "同一幂等键的请求参数不同");
          result = old.result ? currentOperation(context, old) : { status: 202, body: { operation: { id: old.id, state: old.state } } };
        } else {
          context.store.run("INSERT INTO operations(principal_id,key,fingerprint,id,state,created_at) VALUES(?,?,?,?,'in_progress',?)", conn!.principalId!, key, fingerprint, id("op"), Date.now());
          try { result = await perform(); } catch (error) { result = asError(error); }
          context.store.run("UPDATE operations SET state=?,status=?,result=? WHERE principal_id=? AND key=?", result.status === 202 ? "awaiting_confirmation" : result.status < 400 ? "succeeded" : "failed", result.status, JSON.stringify(result.body), conn!.principalId!, key);
        }
      } else result = await perform();
      reply(response, result.status, result.body);
    } catch (error) { const result = asError(error); reply(response, result.status, result.body); }
  });
  pruneChanges(context.store);
  const retention = setInterval(() => {
    if (context.closing.aborted) return;
    try { pruneChanges(context.store); }
    catch { console.error("变更记录清理失败，将在下一周期重试"); }
  }, 60_000);
  retention.unref();
  const stopRetention = () => clearInterval(retention);
  context.closing.addEventListener("abort", stopRetention, { once: true });
  server.once('close', () => {
    stopRetention();
    context.closing.removeEventListener("abort", stopRetention);
    context.requests.close();
  });
  server.requestTimeout = 35_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 1000;
  return server;
}

async function route(context: ServerContext, method: string, url: URL, conn: Connection | undefined, body: Record<string, unknown>, request: IncomingMessage, response: ServerResponse): Promise<Reply> {
  const { auth, store, tasks, security } = context;
  const pathname = url.pathname;
  const ok = (value: unknown): Reply => ({ status: 200, body: value });
  if (method === "POST") {
    if (pathname === "/v1/auth/challenge") return ok(auth.challenge(body));
    if (pathname === "/v1/auth/token") return ok(auth.exchange(body));
    if (pathname === "/v1/auth/launch") return ok(auth.launch(body));
    if (pathname === "/v1/auth/refresh") return ok(auth.refresh(conn!));
  }
  if (!conn) throw new AgoraError(404, "not_found", "接口不存在");
  if (pathname === "/v1/security/state" && method === "GET") { auth.requireMain(conn); return ok(security.state()); }
  if (pathname === "/v1/security/alerts" && method === "GET") { auth.requireMain(conn); return ok({ items: security.state().alerts }); }
  if (pathname === "/v1/confirmations" && method === "GET") {
    auth.requireMain(conn);
    const limit = positive(url.searchParams.get("limit"), 50, 200), cursor = positive(url.searchParams.get("cursor"), 0, Number.MAX_SAFE_INTEGER, true);
    const states = url.searchParams.getAll("state");
    const rows = security.listConfirmations(limit + 1, cursor, conn.type.startsWith("host:") ? undefined : conn.principalId, states.length ? states : undefined);
    return ok({ items: rows.slice(0, limit), nextCursor: rows.length > limit ? String(rows[limit - 1]!.cursor) : null });
  }
  const confirmation = pathname.match(/^\/v1\/confirmations\/([^/]+)(?:\/(sign|cancel))?$/);
  if (confirmation) {
    auth.requireMain(conn);
    if (method === "GET" && !confirmation[2]) return ok(visibleConfirmation(context, conn, confirmation[1]!));
    if (method === "POST" && confirmation[2] === "cancel") return ok(security.cancel(conn, confirmation[1]!));
    if (method === "POST" && confirmation[2] === "sign") {
      const saved = visibleConfirmation(context, conn, confirmation[1]!);
      const execute = (action: string, target: string, params: Record<string, unknown>, proof: UserExecutionProof) => executeUser(context, conn!, action, target, params, proof);
      const asynchronous = ["agora.task.spawn", "agora.task.recover", "agora.archive.delete"].includes(saved.challenge.action);
      // 安全服务统一校验签名字段，并记录包括缺失字段在内的拒绝尝试。
      const signature = body as unknown as SignatureBody;
      const value = asynchronous ? await security.signAsync(conn, confirmation[1]!, signature, execute) : security.sign(conn, confirmation[1]!, signature, execute);
      if (saved.challenge.action === "agora.settings.set") tasks.reconcileBudgets();
      return ok(value);
    }
  }
  if (pathname === "/v1/devices" && method === "GET") { auth.requireMain(conn); return ok({ items: security.devices() }); }
  if (pathname === "/v1/devices/pair" && method === "POST") { hostClient(auth, conn); return confirmationReply(security.pairChallenge(conn, { deviceId: text(body.deviceId, "deviceId", 128), publicKey: text(body.publicKey, "publicKey", 1024), ...(body.label === undefined ? {} : { label: text(body.label, "label", 200) }) })); }
  const device = pathname.match(/^\/v1\/devices\/([^/]+)\/(approve|revoke)$/);
  if (device && method === "POST") { hostClient(auth, conn); return confirmationReply(security.request(conn, `agora.device.${device[2]}`, device[1]!, body)); }
  if (pathname === "/v1/devices/reset" && method === "POST") { hostClient(auth, conn); return confirmationReply(security.request(conn, "agora.device.reset", "devices", {})); }
  const alert = pathname.match(/^\/v1\/security\/alerts\/([^/]+)\/acknowledge$/);
  if (alert && method === "POST") { hostClient(auth, conn); return confirmationReply(security.request(conn, "agora.security.acknowledge", alert[1]!, body)); }
  if (pathname === "/v1/audit" && method === "GET") {
    hostClient(auth, conn);
    const limit = positive(url.searchParams.get("limit"), 50, 200), cursor = positive(url.searchParams.get("cursor"), 0, Number.MAX_SAFE_INTEGER, true);
    const rows = security.audit(limit + 1, cursor, url.searchParams.get("target") ?? undefined) as { seq: number }[];
    return ok({ items: rows.slice(0, limit), nextCursor: rows.length > limit ? String(rows[limit - 1]!.seq) : null });
  }
  if (pathname === "/v1/settings" && method === "GET") { hostClient(auth, conn); return ok(security.state().config); }
  const setting = pathname.match(/^\/v1\/settings\/([^/]+)$/);
  if (setting && ["POST", "PUT"].includes(method)) {
    hostClient(auth, conn);
    try {
      const value = security.apply(conn, "agora.settings.set", setting[1]!, body);
      tasks.reconcileBudgets();
      return ok(value);
    }
    catch (error) {
      if (!(error instanceof AgoraError) || error.code !== "confirmation_required") throw error;
      return confirmationReply(security.request(conn, "agora.settings.set", setting[1]!, body));
    }
  }
  if (method === "POST" && pathname === "/v1/principals/register") return ok(await auth.register(conn, body));
  if (method === "POST" && pathname === "/v1/principals/reclaim") return ok(await auth.reclaim(conn, body));
  const principalTakeover = pathname.match(/^\/v1\/principals\/([^/]+)\/takeover$/);
  if (method === "POST" && principalTakeover) {
    hostClient(auth, conn);
    throw new AgoraError(403, "confirmation_required", "接管主会话控制租约需要用户确认", { action: "agora.principal.takeover", target: principalTakeover[1]!, params: body });
  }
  if (method === "POST" && pathname === "/v1/lease/renew") { const result = auth.renew(conn); auth.refresh(conn); return ok(result); }
  if (method === "POST" && pathname === "/v1/lease/release") return ok(auth.release(conn));
  const run = pathname.match(/^\/v1\/runs\/([^/]+)\/(ready|fatal|authorized)$/);
  if (method === "GET" && run?.[2] === "authorized") return ok(tasks.authorized(conn, run[1]!));
  if (method === "POST" && run) return ok(run[2] === "ready" ? await tasks.ready(conn, body, run[1]!) : tasks.fatal(conn, run[1]!));
  if (pathname === "/v1/tasks") {
    if (method === "POST") return { status: 201, body: await tasks.spawn(conn, body) };
    if (method === "GET") return ok(tasks.list(conn, url.searchParams.get("scope") ?? "mine", positive(url.searchParams.get("limit"), 50, 200), positive(url.searchParams.get("cursor"), 0, Number.MAX_SAFE_INTEGER, true), url.searchParams.getAll("status")));
  }
  const task = pathname.match(/^\/v1\/tasks\/([^/]+)(?:\/(result|stop|steer|cleanup|recover|limits|takeover))?$/);
  if (task) {
    if (method === "GET" && !task[2]) return ok(tasks.status(conn, task[1]!));
    if (method === "GET" && task[2] === "result") return ok(tasks.result(conn, task[1]!, url.searchParams.has("generation") ? positive(url.searchParams.get("generation"), 1, Number.MAX_SAFE_INTEGER) : undefined));
    if (method === "POST" && task[2] === "stop") return ok(await tasks.stop(conn, task[1]!, body));
    if (method === "POST" && task[2] === "steer") return ok(await tasks.steer(conn, task[1]!, body));
    if (method === "POST" && task[2] === "cleanup") return ok(await tasks.cleanup(conn, task[1]!, body));
    if (method === "POST" && task[2] === "recover") return ok(await tasks.recover(conn, task[1]!, body));
    if (method === "POST" && task[2] === "limits") return ok(store.transaction(() => {
      const value = tasks.limits(conn, task[1]!, body);
      security.recordExecution("agora.task.limits", task[1]!, conn.principalId!, "none", "applied");
      return value;
    }));
    if (method === "POST" && task[2] === "takeover") { hostClient(auth, conn); throw new AgoraError(403, "confirmation_required", "接管任务需要用户确认", { action: "agora.task.takeover", target: task[1]!, params: body }); }
  }
  if (pathname === "/v1/requests") {
    if (method === "POST") return { status: 201, body: context.requests.ask(conn, body) };
    if (method === "GET") return ok(context.requests.list(conn, url.searchParams.getAll("state"), positive(url.searchParams.get("limit"), 50, 200), positive(url.searchParams.get("cursor"), 0, Number.MAX_SAFE_INTEGER, true), url.searchParams.get("taskId") ?? undefined));
  }
  const question = pathname.match(/^\/v1\/requests\/([^/]+)(?:\/(answer|escalate|cancel))?$/);
  if (question) {
    if (method === "GET" && !question[2]) return ok(context.requests.detail(conn, question[1]!));
    if (method === "POST" && question[2]) return ok(context.requests.update(conn, question[1]!, question[2], body));
  }
  if (pathname === "/v1/inbox" && method === "GET") {
    if (!tasks.inboxAllowed(conn)) return ok({ items: [] });
    const recipient = auth.inboxRecipient(conn);
    const wait = positive(url.searchParams.get("wait"), 0, 25, true);
    const deadline = Date.now() + wait * 1000;
    let rows = store.takeInbox(recipient, undefined, tasks.inboxSilentOnly(conn));
    while (!rows.length && Date.now() < deadline && !context.closing.aborted && !response.destroyed) {
      await delay(Math.min(200, Math.max(1, deadline - Date.now())), undefined, { signal: context.closing }).catch(() => {});
      if (!context.closing.aborted && !response.destroyed) {
        auth.inboxRecipient(conn);
        rows = tasks.inboxAllowed(conn) ? store.takeInbox(recipient, undefined, tasks.inboxSilentOnly(conn)) : [];
      }
    }
    return ok({ items: rows.map(row => ({ noticeId: row.id, dedupeKey: row.dedupe_key, kind: row.kind, payload: JSON.parse(row.payload), createdAt: row.created_at })) });
  }
  if (pathname === "/v1/inbox/ack" && method === "POST") return ok(auth.ack(conn, body));
  if (pathname === "/v1/status" && method === "GET") {
    auth.requireMain(conn);
    return ok({ daemonVersion: VERSION, instanceId: context.instanceId, protocol: PROTOCOL_RANGE, draining: tasks.draining, activeRuns: tasks.activeCount(), archiveBytes: await archiveStorageBytes(store.home), security: security.state(), taskCounts: store.all("SELECT status,COUNT(*) AS count FROM tasks GROUP BY status LIMIT 20") });
  }
  if (pathname === "/v1/changes" && method === "GET") {
    await streamChanges(store, auth, conn, url, request, response, context.closing);
    return ok(null);
  }
  if (pathname === "/v1/sessions" && method === "GET") {
    auth.requireMain(conn);
    return ok(listSessions(store, conn, url.searchParams, positive(url.searchParams.get("limit"), 50, 200)));

  }
  const archiveDelete = pathname.match(/^\/v1\/sessions\/([^/]+)\/archive\/delete$/);
  if (archiveDelete && method === "POST") {
    auth.requireMain(conn);
    if (Object.keys(body).some(key => key !== "expectedRevision")) invalid("存档删除仅接受 expectedRevision");
    const row = store.session(archiveDelete[1]!);
    tasks.acl.session(conn, row);
    const expectedRevision = body.expectedRevision === undefined ? row.revision : body.expectedRevision;
    if (!Number.isSafeInteger(expectedRevision) || Number(expectedRevision) < 1) invalid("expectedRevision 必须为正整数");
    if (expectedRevision !== row.revision) throw new AgoraError(409, "conflict", "会话版本已变化，请重新读取");
    confirmationRequired("agora.archive.delete", row.id, { expectedRevision });
  }
  if (pathname === "/v1/archive/verify" && method === "POST") {
    auth.requireMain(conn);
    const verify = async (sessionId: string) => {
      const row = store.session(sessionId);
      tasks.acl.session(conn!, row);
      const run = async () => {
        tasks.acl.session(conn!, store.session(sessionId));
        await tasks.sessions.settled(sessionId);
        const result = await tasks.archives.verify(sessionId);
        tasks.acl.session(conn!, store.session(sessionId));
        return result;
      };
      return row.task_id ? tasks.archiveControl(sessionId, run) : run();
    };
    const sessionId = body.sessionId === undefined ? undefined : text(body.sessionId, "sessionId", 128);
    if (sessionId) return ok(await verify(sessionId));
    const limit = positive(url.searchParams.get("limit"), 200, 200), cursor = positive(url.searchParams.get("cursor"), 0, Number.MAX_SAFE_INTEGER, true);
    const rows = tasks.acl.sessions(conn, cursor, limit + 1), items: unknown[] = [];
    for (const row of rows.slice(0, limit)) items.push(await verify(row.id));
    for (const row of rows.slice(0, limit)) tasks.acl.session(conn, store.session(row.id));
    return ok({ items, nextCursor: rows.length > limit ? String(rows[limit - 1]!.cursor) : null });
  }
  const view = pathname.match(/^\/v1\/sessions\/([^/]+)\/(snapshot|history|stream|diagnostics)$/);
  if (method === "GET" && view) {
    auth.requireMain(conn);
    const sessionId = view[1]!, row = store.session(sessionId);
    tasks.acl.session(conn, row);
    const read = async (work: Promise<unknown>) => {
      const value = await work;
      tasks.acl.session(conn!, store.session(sessionId));
      return ok(value);
    };
    if (view[2] === "snapshot") return read(tasks.sessions.snapshot(sessionId, positive(url.searchParams.get("limit"), 100, 200)));
    if (view[2] === "history") return read(tasks.sessions.history(sessionId, { before: url.searchParams.get("before") ?? undefined, limit: positive(url.searchParams.get("limit"), 100, 200) }));
    if (view[2] === "diagnostics") return read(tasks.sessions.diagnostics(sessionId));
    let epoch = url.searchParams.get("epoch") ?? undefined;
    let afterSeq = url.searchParams.has("afterSeq") ? positive(url.searchParams.get("afterSeq"), 0, Number.MAX_SAFE_INTEGER, true) : undefined;
    const lastId = request.headers["last-event-id"];
    if (!epoch && afterSeq === undefined && typeof lastId === "string") {
      const colon = lastId.lastIndexOf(":");
      if (colon < 1) invalid("事件游标无效");
      epoch = lastId.slice(0, colon);
      afterSeq = positive(lastId.slice(colon + 1), 0, Number.MAX_SAFE_INTEGER, true);
    }
    await tasks.sessions.snapshot(sessionId);
    tasks.acl.session(conn, store.session(sessionId));
    const stop = () => { if (!response.writableEnded) response.end(); };
    const guard = setInterval(() => {
      try { const current = auth.authenticate(request.headers.authorization); tasks.acl.session(current, store.session(sessionId)); }
      catch { stop(); }
    }, 1000);
    guard.unref();
    context.closing.addEventListener("abort", stop, { once: true });
    response.once("close", () => { clearInterval(guard); context.closing.removeEventListener("abort", stop); });
    tasks.sessions.stream(sessionId, request, response, { epoch, afterSeq });
    return ok(undefined);
  }
  const session = pathname.match(/^\/v1\/sessions\/([^/]+)$/);
  if (method === "GET" && session) {
    auth.requireMain(conn);
    const row = store.session(session[1]!);
    tasks.acl.session(conn, row);
    return ok(sessionDetail(store, row.id));
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
