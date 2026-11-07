import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { checkPrivate, ensurePrivateDir, writePrivateFile } from "pi-hostkit";
import { AgoraError, text, optionalBoolean } from "./errors.js";
import { Store, id, now, type PrincipalRow } from "./store.js";

export interface RunPolicy {
  profile: "explore" | "review" | "implement"; allowedRoots: string[]; protectedPaths: string[];
  tools: string[]; model: string; thinking: string; extensionVersion: string;
}
export interface Connection {
  token: string; connectionId: string; principalId?: string;
  type: "agent:main" | "agent:child" | "host:cli" | "host:pane";
  expiresAt: number; runId?: string; policy?: RunPolicy;
}
interface Challenge { serverNonce: string; expiresAt: number }
interface Ticket { principalId: string; runId: string; policy: RunPolicy; expiresAt: number }
const TOKEN_MS = 3_600_000;
const LEASE_MS = 90_000;
export function proof(key: Uint8Array, values: string[]): string {
  return createHmac("sha256", key).update(JSON.stringify(values)).digest("base64url");
}
function equal(actual: unknown, expected: string): boolean {
  if (typeof actual !== "string") return false;
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export class Auth {
  readonly connections = new Map<string, Connection>();
  private readonly challenges = new Map<string, Challenge>();
  private readonly tickets = new Map<string, Ticket>();
  private constructor(readonly store: Store, readonly instanceId: string, private readonly hostKey: Buffer) {}
  static async create(store: Store, instanceId: string): Promise<Auth> {
    const directory = path.join(store.home, "secret");
    await ensurePrivateDir(directory);
    await ensurePrivateDir(path.join(directory, "principals"));
    const file = path.join(directory, "host.key");
    let key: Buffer;
    try { key = await readFile(file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      key = randomBytes(32);
      await writePrivateFile(file, key);
    }
    if (key.length !== 32 || !(await checkPrivate(file)).ok) throw new Error("主机凭证无效或权限不安全");
    store.run("UPDATE principals SET lease_connection_id=NULL,lease_expires_at=NULL");
    return new Auth(store, instanceId, key);
  }
  challenge(body: Record<string, unknown>) {
    const clientNonce = text(body.clientNonce, "clientNonce", 256);
    if (clientNonce.length < 16) throw new AgoraError(400, "invalid_params", "随机挑战长度不足");
    const at = Date.now();
    for (const [key, value] of this.challenges) if (value.expiresAt <= at) this.challenges.delete(key);
    if (this.challenges.size >= 1024) throw new AgoraError(429, "rate_limited", "认证请求过多，请稍后重试");
    const challengeId = id("ch"), serverNonce = randomBytes(32).toString("base64url");
    this.challenges.set(challengeId, { serverNonce, expiresAt: at + 60_000 });
    return { challengeId, serverNonce, instanceId: this.instanceId, serverProof: proof(this.hostKey, ["server", clientNonce, this.instanceId]) };
  }
  exchange(body: Record<string, unknown>) {
    const challengeId = text(body.challengeId, "challengeId", 128);
    const challenge = this.challenges.get(challengeId);
    this.challenges.delete(challengeId);
    if (!challenge || challenge.expiresAt <= Date.now() || !equal(body.clientProof, proof(this.hostKey, ["client", challenge.serverNonce, this.instanceId]))) {
      throw new AgoraError(401, "unauthenticated", "认证证明无效或已过期");
    }
    if (!["agent:main", "host:cli", "host:pane"].includes(String(body.as))) throw new AgoraError(400, "invalid_params", "请求的身份无效");
    const type = body.as as Connection["type"];
    const principalId = type === "agent:main" ? undefined : type;
    if (principalId) this.store.run("INSERT OR IGNORE INTO principals(id,type,label,created_at) VALUES(?,?,?,?)", principalId, type, type, now());
    return this.response(this.issue({ type, principalId }));
  }
  private issue(values: Pick<Connection, "type" | "principalId" | "runId" | "policy">): Connection {
    const at = Date.now();
    for (const [token, conn] of this.connections) if (conn.expiresAt <= at) this.connections.delete(token);
    if (this.connections.size >= 10_000) throw new AgoraError(429, "rate_limited", "连接数量超过限制");
    const connection: Connection = { ...values, token: randomBytes(32).toString("base64url"), connectionId: id("cn"), expiresAt: at + TOKEN_MS };
    this.connections.set(connection.token, connection);
    return connection;
  }
  response(conn: Connection) {
    return { token: conn.token, connectionId: conn.connectionId, expiresAt: new Date(conn.expiresAt).toISOString(), principalId: conn.principalId, runId: conn.runId, policy: conn.policy };
  }
  authenticate(header: string | undefined): Connection {
    const token = header?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
    const conn = token ? this.connections.get(token) : undefined;
    if (!conn) throw new AgoraError(401, "unauthenticated", "请重新认证");
    if (conn.expiresAt <= Date.now()) {
      this.connections.delete(conn.token);
      throw new AgoraError(401, "token_expired", "连接已过期，请重新认证");
    }
    return conn;
  }
  refresh(conn: Connection) { conn.expiresAt = Date.now() + TOKEN_MS; return this.response(conn); }
  requireAgent(conn: Connection): PrincipalRow | undefined {
    if (conn.type !== "agent:child") return this.requireMain(conn);
    const run = this.store.get<{ state: string }>("SELECT state FROM process_runs WHERE id=? AND exited_at IS NULL", conn.runId ?? "");
    if (!run || run.state !== "ready") throw new AgoraError(403, "run_not_ready", "协作会话尚未通过最终就绪核对");
    return this.store.principal(conn.principalId!);
  }
  requireMain(conn: Connection): PrincipalRow | undefined {
    if (conn.type === "agent:child") throw new AgoraError(403, "forbidden", "协作会话不能执行此操作");
    if (conn.type !== "agent:main") return undefined;
    const principal = conn.principalId ? this.store.principal(conn.principalId) : undefined;
    if (!principal || principal.lease_connection_id !== conn.connectionId || (principal.lease_expires_at ?? 0) <= Date.now()) {
      throw new AgoraError(409, "lease_required", "请先认领主会话并取得控制租约");
    }
    return principal;
  }
  private bootstrap(conn: Connection): void {
    if (conn.type !== "agent:main" || conn.principalId) throw new AgoraError(403, "forbidden", "此连接不能注册或认领主会话");
  }
  async register(conn: Connection, body: Record<string, unknown>) {
    this.bootstrap(conn);
    const sessionId = text(body.sessionId, "sessionId", 256);
    const ephemeral = optionalBoolean(body.ephemeral, "ephemeral") ?? false;
    const sessionFile = ephemeral ? null : path.resolve(text(body.sessionFile, "sessionFile", 32768));
    const cwd = path.resolve(text(body.cwd, "cwd", 32768));
    const forkedFrom = body.forkedFrom === undefined ? null : text(body.forkedFrom, "forkedFrom", 128);
    const principalId = id("pr");
    const keyFile = path.join(this.store.home, "secret", "principals", `${principalId}.key`);
    if (!ephemeral) await writePrivateFile(keyFile, randomBytes(32));
    try {
      this.bootstrap(conn);
      this.store.run("INSERT INTO principals(id,type,label,pi_session_id,session_file,cwd,ephemeral,forked_from,lease_connection_id,lease_expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)", principalId, "agent:main", typeof body.label === "string" ? body.label.slice(0, 200) : sessionId, sessionId, sessionFile, cwd, ephemeral ? 1 : 0, forkedFrom, conn.connectionId, Date.now() + LEASE_MS, now());
    } catch (error) { if (!ephemeral) await unlink(keyFile).catch(() => {}); throw error; }
    conn.principalId = principalId;
    return { principalId, leaseExpiresAt: new Date(Date.now() + LEASE_MS).toISOString() };
  }
  async reclaim(conn: Connection, body: Record<string, unknown>) {
    this.bootstrap(conn);
    const principalId = text(body.principalId, "principalId", 128);
    if (!/^pr_[a-f0-9-]{36}$/.test(principalId)) throw new AgoraError(404, "not_found", "主会话不存在");
    const principal = this.store.principal(principalId);
    if (!principal || principal.type !== "agent:main") throw new AgoraError(404, "not_found", "主会话不存在");
    if (principal.ephemeral) throw new AgoraError(410, "principal_ephemeral", "内存会话不能在退出后认领");
    const sessionId = text(body.sessionId, "sessionId", 256);
    if (sessionId !== principal.pi_session_id) throw new AgoraError(403, "session_mismatch", "会话身份不同，请注册新主会话");
    const file = path.join(this.store.home, "secret", "principals", `${principalId}.key`);
    if (!(await checkPrivate(file)).ok) throw new AgoraError(403, "forbidden", "恢复凭证不可用");
    const key = await readFile(file);
    if (!equal(body.proof, proof(key, ["reclaim", principalId, sessionId, conn.connectionId, this.instanceId]))) throw new AgoraError(403, "forbidden", "恢复证明无效");
    this.bootstrap(conn);
    const expiry = Date.now() + LEASE_MS;
    const changed = this.store.run("UPDATE principals SET lease_connection_id=?,lease_expires_at=? WHERE id=? AND (lease_connection_id IS NULL OR lease_expires_at<=?)", conn.connectionId, expiry, principalId, Date.now());
    if (!changed.changes) throw new AgoraError(409, "lease_held", "该主会话已由另一个连接控制", { principalId });
    conn.principalId = principalId;
    return { principalId, leaseExpiresAt: new Date(expiry).toISOString() };
  }
  renew(conn: Connection) {
    const principal = this.requireMain(conn);
    if (!principal) throw new AgoraError(403, "forbidden", "只有主会话持有控制租约");
    const expiry = Date.now() + LEASE_MS;
    this.store.run("UPDATE principals SET lease_expires_at=? WHERE id=? AND lease_connection_id=?", expiry, principal.id, conn.connectionId);
    return { principalId: principal.id, leaseExpiresAt: new Date(expiry).toISOString() };
  }
  release(conn: Connection) {
    if (conn.type !== "agent:main") throw new AgoraError(403, "forbidden", "只有主会话持有控制租约");
    if (conn.principalId) this.store.run("UPDATE principals SET lease_connection_id=NULL,lease_expires_at=NULL WHERE id=? AND lease_connection_id=?", conn.principalId, conn.connectionId);
    conn.principalId = undefined;
    return { released: true };
  }
  ticket(principalId: string, runId: string, policy: RunPolicy): string {
    for (const [ticket, value] of this.tickets) if (value.expiresAt <= Date.now()) this.tickets.delete(ticket);
    const value = randomBytes(32).toString("base64url");
    this.tickets.set(value, { principalId, runId, policy, expiresAt: Date.now() + 60_000 });
    return value;
  }
  launch(body: Record<string, unknown>) {
    const value = text(body.ticket, "ticket", 256);
    const ticket = this.tickets.get(value);
    this.tickets.delete(value);
    if (!ticket || ticket.expiresAt <= Date.now()) throw new AgoraError(401, "unauthenticated", "启动凭证无效或已过期");
    return this.response(this.issue({ type: "agent:child", principalId: ticket.principalId, runId: ticket.runId, policy: ticket.policy }));
  }
  revokeRun(runId: string): void {
    for (const [key, conn] of this.connections) if (conn.runId === runId) this.connections.delete(key);
    for (const [key, ticket] of this.tickets) if (ticket.runId === runId) this.tickets.delete(key);
  }
  inboxRecipient(conn: Connection): string {
    if (conn.type === "agent:main") this.requireMain(conn);
    if (!conn.principalId) throw new AgoraError(403, "forbidden", "连接尚未绑定会话");
    return conn.type.startsWith("host:") ? "user" : conn.principalId;
  }
  ack(conn: Connection, body: Record<string, unknown>) {
    const recipient = this.inboxRecipient(conn);
    const noticeId = text(body.noticeId, "noticeId", 128);
    const notice = this.store.get<{ recipient_id: string }>("SELECT recipient_id FROM outbox WHERE id=?", noticeId);
    if (!notice || notice.recipient_id !== recipient) throw new AgoraError(404, "not_found", "通知不存在");
    const host = conn.type.startsWith("host:");
    const ephemeral = !host && !!this.store.principal(recipient)?.ephemeral;
    const persisted = optionalBoolean(body.persisted, "persisted") ?? !ephemeral;
    if (!host && persisted === ephemeral) throw new AgoraError(400, "invalid_params", ephemeral ? "内存会话不能声明磁盘持久化" : "持久会话必须在核实磁盘条目后确认");
    const entryId = host ? null : text(body.entryId, "entryId", 256);
    this.store.run("UPDATE outbox SET acked_at=COALESCE(acked_at,?),persisted_at=CASE WHEN ? THEN COALESCE(persisted_at,?) ELSE persisted_at END,persisted=?,entry_id=COALESCE(entry_id,?) WHERE id=? AND recipient_id=?", now(), persisted ? 1 : 0, now(), persisted ? 1 : 0, entryId, noticeId, recipient);
    return { acked: true };
  }
}
