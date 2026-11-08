import path from "node:path";
import { lstat, readFile, realpath } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { projectPartials, type PartialFragment } from "@pi-agora/archive";
import { AgoraConnectionError, AgoraHttpError, connectHost, loopbackUrl, negotiateProtocol, PROTOCOL_VERSION,
  type AgoraClient, type ConnectHostOptions } from "@pi-agora/protocol";

type Row = Record<string, unknown>;
interface Page { items: Row[]; nextCursor?: string | null }
export interface CliArchiveReader {
  listSessions(q?: { taskId?: string; limit?: number; cursor?: string }): Promise<Page>;
  getSession(id: string): Promise<Row | undefined>;
  readUserView(id: string, q?: { before?: string; limit?: number }): Promise<{ leafId: string | null; entries: unknown[]; historyBefore: string | null }>;
  readPartials(id: string): Promise<PartialFragment[]>;
  verifySession?(id: string): Promise<unknown>;
  close(): void;
}
export interface ArchiveCliDependencies {
  available(home: string): Promise<boolean>;
  connect(options: ConnectHostOptions): Promise<AgoraClient>;
  open(home: string): Promise<CliArchiveReader>;
  verify(file: string): Promise<unknown>;
  deleteOffline(home: string, sessionId: string): Promise<unknown>;
  fetch: typeof fetch;
  signal?: AbortSignal;
}
const defaults: ArchiveCliDependencies = {
  available: daemonAvailable,
  connect: connectHost,
  open: async home => (await import("@pi-agora/archive")).openArchive({ home, apiVersion: 1 }) as unknown as Promise<CliArchiveReader>,
  verify: async file => (await import("@pi-agora/archive")).verifySessionFile(file),
  async deleteOffline(home, sessionId) {
    // daemon 的维护入口由装配层导出；缺少入口时拒绝删除。
    const daemon = await import("@pi-agora/daemon") as unknown as Record<string, unknown>;
    const remove = daemon.deleteArchiveOffline;
    if (typeof remove !== "function") throw new Error("离线删除维护入口尚未接线，存档未删除");
    return remove({ home, sessionId });
  },
  fetch: (...args) => fetch(...args),
};
function row(value: unknown): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("归档响应格式无效");
  return value as Row;
}
function transportError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: string; cause?: unknown };
  return ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET"].includes(value.code ?? "") ||
    (value.cause !== error && value.cause !== undefined && transportError(value.cause));
}
/** 仅健康连接不可达或没有发现记录时降级；认证、身份和协议错误必须向上传递。 */
export async function daemonAvailable(home: string): Promise<boolean> {
  let discovery: Row;
  try { discovery = row(JSON.parse(await readFile(path.join(home, "run", "daemon.json"), "utf8"))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  if (!Number.isInteger(discovery.port) || Number(discovery.port) < 1 || Number(discovery.port) > 65535 || typeof discovery.instanceId !== "string") {
    throw new Error("agora 后台发现信息无效");
  }
  let response: Response;
  try { response = await fetch(`${loopbackUrl(`http://127.0.0.1:${discovery.port}`)}/v1/health`, { redirect: "error", signal: AbortSignal.timeout(5000) }); }
  catch (error) { if (transportError(error) || (error instanceof Error && error.name === "TimeoutError")) return false; throw error; }
  if (!response.ok) throw new AgoraHttpError(response.status, "health_failed");
  const health = row(await response.json()), protocol = row(health.protocol);
  if (health.instanceId !== discovery.instanceId || typeof health.daemonVersion !== "string") throw new Error("agora 后台身份核验失败");
  if (typeof protocol.min !== "number" || typeof protocol.max !== "number") throw new Error("agora 健康检查协议字段无效");
  negotiateProtocol({ min: protocol.min, max: protocol.max });
  return true;
}
function limitOption(options: Map<string, string | true>, fallback: number): number {
  const value = Number(options.get("--limit") ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1 || value > 200) throw new Error("--limit 必须是 1 到 200 之间的整数");
  return value;
}
function query(options: Map<string, string | true>, fallback = 100): URLSearchParams {
  const q = new URLSearchParams({ limit: String(limitOption(options, fallback)) });
  for (const key of ["before", "cursor"]) if (typeof options.get(`--${key}`) === "string") q.set(key, String(options.get(`--${key}`)));
  return q;
}
function sessionId(value: Row): string {
  const id = value.agoraSessionId ?? value.id;
  if (typeof id !== "string" || !id) throw new Error("响应缺少会话 ID");
  return id;
}
export function sessionTree(items: Row[]): Row[] {
  const nodes = new Map<string, Row & { children: Row[] }>(items.map(item => [sessionId(item), { ...item, children: [] }]));
  const principals = new Map(items.filter(item => typeof item.principalId === "string").map(item => [String(item.principalId), sessionId(item)]));
  const roots: Row[] = [];
  const parentOf = (value: Row): string | undefined => {
    const relation = value.parent as Row | undefined;
    if (relation && typeof relation === "object") return relation.kind === "task" && typeof relation.sessionId === "string" ? relation.sessionId : undefined;
    return typeof value.inheritsFrom === "string" ? value.inheritsFrom : principals.get(String(value.parentPrincipalId ?? value.convenerId));
  };
  for (const item of items) {
    const id = sessionId(item), node = nodes.get(id)!;
    const parent = parentOf(item);
    // 遇到循环或本页之外的父节点时保留根节点，避免节点丢失。
    let ancestor = parent, cyclic = false;
    const seen = new Set([id]);
    while (ancestor && nodes.has(ancestor)) {
      if (seen.has(ancestor)) { cyclic = true; break; }
      seen.add(ancestor);
      const candidate = nodes.get(ancestor)!;
      ancestor = parentOf(candidate);
    }
    if (parent && nodes.has(parent) && !cyclic) nodes.get(parent)!.children.push(node);
    else roots.push(node);
  }
  return roots;
}
async function offlineId(reader: CliArchiveReader, id: string): Promise<string> {
  if (!id.startsWith("tk_")) return id;
  let cursor: string | undefined;
  const seen = new Set<string>();
  let latest: Row | undefined;
  do {
    const page = await reader.listSessions({ taskId: id, limit: 200, cursor });
    for (const item of page.items) {
      if (item.isCurrent === true) return sessionId(item);
      if (!latest || String(item.createdAt) > String(latest.createdAt)) latest = item;
    }
    cursor = page.nextCursor ?? undefined;
    if (cursor && seen.has(cursor)) throw new Error("归档分页游标重复");
    if (cursor) seen.add(cursor);
  } while (cursor);
  if (!latest) throw new Error("任务没有可读取的归档会话");
  return sessionId(latest);
}
async function onlineId(client: AgoraClient, id: string): Promise<string> {
  return id.startsWith("tk_") ? sessionId(row(await client.request("GET", `/v1/tasks/${encodeURIComponent(id)}`))) : id;
}
async function snapshot(reader: CliArchiveReader, id: string, options: Map<string, string | true>): Promise<Row> {
  const session = await reader.getSession(id);
  if (!session) throw new Error("会话不存在");
  const view = await reader.readUserView(id, { limit: limitOption(options, 100), ...(options.has("--before") ? { before: String(options.get("--before")) } : {}) });
  return { ...view, cursor: { epoch: `offline:${id}`, seq: 0 },
    inFlight: { phase: "idle", tools: [], queue: { steering: [], followUp: [] } },
    unfinishedPartials: projectPartials(await reader.readPartials(id)), status: session.status, statusDetail: null, usage: session.usage, session, offline: true };
}
async function safeFile(home: string, file: unknown): Promise<string> {
  if (typeof file !== "string" || !path.isAbsolute(file)) throw new Error("归档未提供可校验的会话文件路径");
  const root = await realpath(home), parent = await realpath(path.dirname(file));
  let target: string;
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("会话路径不是普通文件");
    target = await realpath(file);
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; target = path.join(parent, path.basename(file)); }
  const relative = path.relative(root, target);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("会话文件超出 AGORA_HOME");
  return target;
}
interface SseEvent { event: string; data: unknown }
/** 限制单帧大小；支持 CRLF、注释、分段 UTF-8 和多行 data。 */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader(), decoder = new TextDecoder();
  let buffer = "", event = "message", data: string[] = [], frameBytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      if (buffer.length > 1_048_576) throw new Error("SSE 帧超出大小限制");
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, ""); buffer = buffer.slice(newline + 1);
        frameBytes += line.length;
        if (frameBytes > 1_048_576) throw new Error("SSE 帧超出大小限制");
        if (!line) {
          if (data.length) yield { event, data: JSON.parse(data.join("\n")) };
          event = "message"; data = []; frameBytes = 0;
        } else if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
async function tail(client: AgoraClient, id: string, options: Map<string, string | true>, io: { out(text: string): void }, deps: ArchiveCliDependencies): Promise<void> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  const signal = deps.signal ? AbortSignal.any([controller.signal, deps.signal]) : controller.signal;
  try {
    while (!signal.aborted) {
      const snap = row(await client.request("GET", `/v1/sessions/${encodeURIComponent(id)}/snapshot?${query(options)}`, undefined, { signal }));
      io.out(JSON.stringify(snap, null, 2));
      const cursor = row(snap.cursor);
      if (typeof cursor.epoch !== "string" || !Number.isSafeInteger(cursor.seq) || Number(cursor.seq) < 0) throw new Error("快照缺少有效流游标");
      if (client.expiresAt && Date.parse(client.expiresAt) - Date.now() < 60_000) await client.refresh();
      const q = new URLSearchParams({ epoch: cursor.epoch, afterSeq: String(cursor.seq) });
      const response = await deps.fetch(`${client.url}/v1/sessions/${encodeURIComponent(id)}/stream?${q}`, {
        headers: { Authorization: `Bearer ${client.token}`, "Agora-Protocol": String(PROTOCOL_VERSION), Accept: "text/event-stream" }, redirect: "error", signal,
      });
      if (!response.ok) throw new AgoraHttpError(response.status, "stream_failed");
      if (!response.body || !response.headers.get("content-type")?.startsWith("text/event-stream")) throw new Error("daemon 未返回 SSE 流");
      let resync = false, ended = false;
      let terminal = ["completed", "failed", "stopped", "interrupted"].includes(String(snap.status));
      for await (const event of readSse(response.body)) {
        if (event.event === "resync" || (event.data && typeof event.data === "object" && (event.data as Row).type === "resync")) { resync = true; break; }
        const data = event.data && typeof event.data === "object" ? event.data as Row : {};
        const change = data.event && typeof data.event === "object" ? data.event as Row : data;
        if (change.type === "agora_run" && change.phase === "exited") ended = true;
        if (change.type === "agora_status") terminal = ["completed", "failed", "stopped", "interrupted"].includes(String(change.status));
        io.out(JSON.stringify(event));
      }
      if (!resync && (ended || terminal)) return;
      if (!resync && !signal.aborted) throw new AgoraConnectionError();
    }
  } catch (error) { if (!signal.aborted) throw error; }
  finally { process.removeListener("SIGINT", cancel); controller.abort(); }
}
export async function runArchiveCli(input: {
  command: string; operand?: string; rest: string[]; options: Map<string, string | true>; home: string;
  io: { out(text: string): void };
}, overrides: Partial<ArchiveCliDependencies> = {}): Promise<boolean> {
  const { command, operand, rest, options, home, io } = input;
  if (!["ls", "show", "log", "tail", "verify-archive", "archive", "takeover"].includes(command)) return false;
  const deps = { ...defaults, ...overrides };
  if (command === "takeover") throw new Error("takeover 尚未开放：需要用户设备签名确认，CLI 不能绕过控制租约");
  if (command === "archive") {
    if (operand !== "delete" || !rest[0] || rest.length !== 1) throw new Error("用法：agora archive delete <会话 ID> --offline");
    if (!options.has("--offline")) throw new Error("在线删除尚未开放；离线删除必须显式指定 --offline");
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(rest[0])) throw new Error("会话 ID 格式无效");
    io.out(JSON.stringify(await deps.deleteOffline(home, rest[0]), null, 2));
    return true;
  }
  if (["show", "log", "tail"].includes(command) && !operand) throw new Error("请指定任务或会话 ID");
  if (rest.length || command === "ls" && operand) throw new Error("参数过多，请运行 agora --help");
  if (options.has("--offline") && command !== "verify-archive") throw new Error("--offline 仅用于 archive delete 或 verify-archive");
  const q = query(options, command === "ls" ? 50 : 100);
  let client: AgoraClient | undefined, reader: CliArchiveReader | undefined;
  try {
    // 连接认证或业务请求失败时不再尝试离线读取。
    if (!options.has("--offline") && await deps.available(home)) client = await deps.connect({ home, as: "host:cli", autoStart: false });
    let result: unknown;
    if (client) {
      if (command === "verify-archive") {
        result = await client.request("POST", "/v1/archive/verify", operand ? { sessionId: await onlineId(client, operand) } : {}, { idempotencyKey: randomUUID() });
      } else if (command === "ls") {
        const page = row(await client.request("GET", `/v1/sessions?${q}`));
        result = options.has("--tree") ? { ...page, items: sessionTree(page.items as Row[]) } : page;
      } else if (command === "show" && operand!.startsWith("tk_")) result = await client.request("GET", `/v1/tasks/${encodeURIComponent(operand!)}`);
      else {
        const id = await onlineId(client, operand!);
        if (command === "tail") { await tail(client, id, options, io, deps); return true; }
        result = await client.request("GET", `/v1/sessions/${encodeURIComponent(id)}/${command === "log" ? "history" : "snapshot"}?${q}`);
      }
    } else {
      reader = await deps.open(home);
      if (command === "ls") {
        const page = await reader.listSessions({ limit: limitOption(options, 50), ...(options.has("--cursor") ? { cursor: String(options.get("--cursor")) } : {}) });
        result = options.has("--tree") ? { ...page, items: sessionTree(page.items) } : page;
      } else if (command === "verify-archive") {
        const results: unknown[] = [];
        const verify = async (id: string) => {
          const session = await reader!.getSession(id);
          if (!session) throw new Error("会话不存在");
          const result = reader!.verifySession ? await reader!.verifySession(id) : await deps.verify(await safeFile(home, session.sessionFile));
          results.push({ sessionId: id, ...row(result) });
        };
        if (operand) await verify(await offlineId(reader, operand));
        else {
          let cursor: string | undefined;
          const seen = new Set<string>();
          do {
            const page = await reader.listSessions({ limit: 200, cursor });
            for (const item of page.items) await verify(sessionId(item));
            cursor = page.nextCursor ?? undefined;
            if (cursor && seen.has(cursor)) throw new Error("归档分页游标重复");
            if (cursor) seen.add(cursor);
          } while (cursor);
        }
        result = { offline: true, persisted: false, results };
      } else {
        const id = await offlineId(reader, operand!);
        if (command === "log") result = await reader.readUserView(id, { limit: limitOption(options, 100), ...(options.has("--before") ? { before: String(options.get("--before")) } : {}) });
        else result = await snapshot(reader, id, options);
        if (command === "tail") result = { ...row(result), streaming: false, reason: "daemon 离线，仅返回归档快照" };
      }
    }
    io.out(JSON.stringify(result, null, 2));
    return true;
  } finally { reader?.close(); client?.close(); }
}
