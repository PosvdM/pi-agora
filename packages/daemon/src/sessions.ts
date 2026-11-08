import { appendFile, lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { openArchive, projectPartials, projectUserView, verifySessionFile, resolveArchivePath } from "@pi-agora/archive";
import type { InFlightState, SessionStreamEvent } from "@pi-agora/protocol";
import { parseSessionFile, sessionMessages } from "@pi-agora/harness-pi";
import type { SessionEntry } from "@pi-agora/protocol";
import type { DriverHandle } from "./driver.js";
import type { Store } from "./store.js";
import { AgoraError } from "./errors.js";
import { readPiEntries, PiArchiveEvents, sameMessage, type ArchiveFragment, type PartialRow } from "./harness/pi/archive-events.js";

type ViewEvent = SessionStreamEvent;
interface DiskView { entries: SessionEntry[]; leafId: string | null; completeIds: Set<string>; idsStable: boolean }
interface Issue { t: string; kind: string; message: string }
interface Client { response: ServerResponse; close(): void }
type Verification = Awaited<ReturnType<typeof verifySessionFile>>;
interface ViewState {
  sessionId: string; runId: string; epoch: string; seq: number;
  handle?: DriverHandle;
  entries: SessionEntry[]; leafId: string | null; diskEntries: SessionEntry[]; rpcEntries: SessionEntry[];
  events: PiArchiveEvents;
  archivedPartials: ArchiveFragment[];
  pending: PartialRow[];
  work: Promise<void>;
  ready: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  lastWrite: number;
  off: (() => void)[];
  clients: Set<Client>;
  ring: ViewEvent[];
  issues: Issue[];
  closing: boolean; ended: boolean; cleanupPending: boolean; endReason?: string;
  initialMessageCount?: number;
  baseline?: { hash: string; bytes: number };
  verification?: Verification;
  failure?: unknown;
}

const MAX_EVENTS = 2000;
const MAX_CLIENT_BUFFER = 1024 * 1024;
function clone<T>(value: T): T { return structuredClone(value); }
function safeId(value: string): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new AgoraError(400, "invalid_params", "会话或运行标识格式无效");
}
function pageLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > 200) throw new AgoraError(400, "invalid_params", "limit 必须为 1 到 200 的整数");
  return value;
}
function within(home: string, target: string): boolean {
  const relative = path.relative(home, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/** 会话视图只写旁车归档；pi 的 session.jsonl 始终由现有写者独占。 */
export class SessionViews {
  private readonly states = new Map<string, ViewState>();
  private readonly transitions = new Map<string, Promise<void>>();
  private closed = false;
  constructor(private readonly store: Store, private readonly instanceId: string) {}

  private state(sessionId: string, runId = "archive", handle?: DriverHandle): ViewState {
    safeId(sessionId); safeId(runId);
    this.store.session(sessionId);
    return {
      sessionId, runId, epoch: `${this.instanceId}:${runId}`, seq: 0, handle,
      entries: [], leafId: null, diskEntries: [], rpcEntries: [], events: new PiArchiveEvents(runId),
      archivedPartials: [], pending: [], work: Promise.resolve(), ready: Promise.resolve(), lastWrite: 0,
      off: [], clients: new Set(), ring: [], issues: [], closing: false, ended: false, cleanupPending: false,
    };
  }
  private issue(state: ViewState, kind: string, error: unknown): void {
    const issue = { t: new Date().toISOString(), kind, message: error instanceof Error ? error.message : String(error) };
    state.issues.push(issue);
    if (state.issues.length > 200) state.issues.shift();
  }
  private serial<T>(state: ViewState, operation: () => Promise<T>): Promise<T> {
    const result = state.work.then(operation);
    state.work = result.then(() => {}, error => {
      state.failure = error;
      this.issue(state, "archive_io", error);
    });
    return result;
  }
  private async sessionFile(sessionId: string): Promise<string> {
    try { return (await resolveArchivePath(this.store.home, this.store.session(sessionId).session_file)).file; }
    catch (error) {
      if ((error as { code?: string } | undefined)?.code === "unsafe_path") throw new AgoraError(403, "archive_path", "会话真实路径超出 AGORA_HOME");
      throw error;
    }
  }
  private async sidecar(state: ViewState, kind: "partials" | "runs", suffix: string): Promise<string> {
    const home = await realpath(this.store.home);
    const directory = path.join(home, "sessions", state.sessionId, kind);
    // mkdir 之前逐层检查，避免在越界链接目标中创建目录。
    let parent = home;
    for (const component of ["sessions", state.sessionId, kind]) {
      parent = path.join(parent, component);
      try { await mkdir(parent); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      if ((await lstat(parent)).isSymbolicLink() || !within(home, await realpath(parent))) {
        throw new AgoraError(403, "archive_path", "归档旁车目录不能使用符号链接");
      }
    }
    const file = path.join(directory, `${state.runId}${suffix}`);
    try {
      const info = await lstat(file);
      if (info.isSymbolicLink() || info.nlink > 1) throw new AgoraError(403, "archive_path", "归档旁车文件不能使用符号链接或硬链接");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    return file;
  }
  private async disk(state: ViewState): Promise<DiskView> {
    const file = await this.sessionFile(state.sessionId);
    try {
      const parsed = await parseSessionFile(file);
      for (const diagnostic of parsed.diagnostics) this.issue(state, "session_parse", diagnostic.message);
      const completeIds = new Set(parsed.entries.map(entry => entry.id));
      // 未以换行结束的最后条目不作为 closed 的证据，即使它恰好是合法 JSON。
      const descriptor = await open(file, "r");
      try {
        if (parsed.bytes > 0) {
          const tail = Buffer.alloc(1);
          const size = (await descriptor.stat()).size;
          if (size < parsed.bytes) completeIds.clear();
          const read = await descriptor.read(tail, 0, 1, parsed.bytes - 1);
          if (read.bytesRead !== 1 || tail[0] !== 10) {
            const last = parsed.entries.at(-1);
            if (last) completeIds.delete(last.id);
          }
        }
      } finally { await descriptor.close(); }
      return { entries: parsed.entries, leafId: parsed.leafId, completeIds, idsStable: parsed.idsStable !== false };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return { entries: [], leafId: null, completeIds: new Set(), idsStable: true };
    }
  }

  /** 调用方须在最终 RPC 检查和 markReady 后、首个 prompt 前等待 begin。 */
  async begin(sessionId: string, runId: string, handle: DriverHandle): Promise<void> {
    while (this.transitions.has(sessionId)) await this.transitions.get(sessionId);
    let finish!: () => void;
    this.transitions.set(sessionId, new Promise<void>(resolve => { finish = resolve; }));
    try { await this.startRun(sessionId, runId, handle); }
    finally { this.transitions.delete(sessionId); finish(); }
  }
  private async startRun(sessionId: string, runId: string, handle: DriverHandle): Promise<void> {
    if (this.closed) throw new AgoraError(503, "draining", "会话服务已关闭");
    safeId(runId);
    const old = this.states.get(sessionId);
    if (old?.runId === runId && old.handle === handle) { await old.ready; return; }
    if (old) {
      this.publish(old, "agora_run", { runId, phase: "started" });
      this.resync(old);
      if (old.handle && !old.ended) await this.ended(sessionId, old.runId);
    }
    if (this.closed) throw new AgoraError(503, "draining", "会话服务已关闭");
    const state = this.state(sessionId, runId, handle);
    this.states.set(sessionId, state);
    // 订阅先于所有 await，避免首次 get_entries 期间遗漏事件。
    state.off.push(handle.onEvent(event => {
      if (state.closing) return;
      const result = state.events.receive(event);
      state.pending.push(...result.rows);
      // 驱动合成的诊断事件不属于 pi 会话事件；其余事件保留原始形状。
      if (typeof event.type === "string" && event.type !== "usage_record" && event.type !== "quota_exhausted" && !event.type.startsWith("driver_")) {
        this.publish(state, event.type, { ...event });
      }
      if (result.rows.length) this.scheduleWrite(state);
      if (result.refresh) void this.serial(state, () => this.refresh(state)).catch(() => {});
    }), handle.onExit(exit => {
      if (exit.cleanupConfirmed === false) {
        // 未确认退出时继续消费原 RPC，不能丢掉迟到的增量和最终消息。
        state.cleanupPending = true;
        this.status(sessionId);
        void this.serial(state, async () => {
          await this.refresh(state);
          await this.writePending(state);
          await this.verifyState(state);
          await this.saveDiagnostics(state);
        }).catch(() => {});
      } else void this.ended(sessionId, runId, exit.reason).catch(() => {});
    }));
    this.publish(state, "agora_run", { runId, phase: "started" });
    state.ready = this.serial(state, async () => {
      await this.refresh(state, true);
      await this.verifyState(state);
    });
    await state.ready;
  }

  private async refresh(state: ViewState, initial = false): Promise<void> {
    let live: { entries: SessionEntry[]; leafId: string | null } | undefined;
    if (state.handle && !state.closing) {
      try { live = await readPiEntries(command => state.handle!.send(command, { timeoutMs: 5000 }), state.rpcEntries); }
      catch (error) { this.issue(state, "get_entries_fallback", error); }
    }
    const disk = await this.disk(state);
    // 历史运行的未闭片段由只读 adapter 去重；当前运行只消费内存捕获，避免重复展示。
    try {
      const reader = await openArchive({ home: this.store.home, apiVersion: 1 });
      try {
        const partials = await reader.readPartials(state.sessionId);
        state.archivedPartials = state.handle ? partials.filter(fragment => fragment.runId !== state.runId) : partials;
      } finally { reader.close(); }
    } catch (error) { this.issue(state, "archive_partials_read", error); }
    const next = live ?? disk;
    if (live) state.rpcEntries = clone(live.entries);
    const nextMessages = [...sessionMessages(next.entries)];
    if (initial) state.initialMessageCount = Math.max(0,
      nextMessages.length - [...state.events.messages.values()].filter(item => item.ended && nextMessages.some(evidence => sameMessage(evidence.message, item.message))).length);
    const before = new Map(state.entries.map(entry => [entry.id, entry]));
    const changed = next.entries.filter(entry => !sameMessage(before.get(entry.id), entry));
    const ids = new Set(next.entries.map(entry => entry.id));
    const removedIds = state.entries.filter(entry => !ids.has(entry.id)).map(entry => entry.id);
    const leafChanged = next.leafId !== state.leafId;
    const byId = new Map(next.entries.map(entry => [entry.id, entry]));
    const ancestors = new Set<string>();
    let ancestor = next.leafId;
    while (ancestor && !ancestors.has(ancestor)) {
      ancestors.add(ancestor); ancestor = byId.get(ancestor)?.parentId ?? null;
    }
    const branchChanged = state.leafId !== null && !ancestors.has(state.leafId);
    // 这里到 publish 之间没有 await；快照水位与内存投影具有同一切点。
    state.entries = clone(next.entries);
    state.leafId = next.leafId;
    state.diskEntries = clone(disk.entries.filter(entry => disk.completeIds.has(entry.id)));
    if (branchChanged) {
      // 推进水位并丢弃旧分支回放；断线客户端也必须重新取得快照。
      state.seq++; state.ring = []; this.resync(state);
    } else if (changed.length || removedIds.length || leafChanged) {
      this.publish(state, "agora_entries", { entries: clone(changed), leafId: state.leafId });
    }
    const rpcMessages = [...sessionMessages(state.rpcEntries)];
    const diskMessages = new Map([...sessionMessages(disk.entries)].map(evidence => [evidence.entryId, evidence]));
    for (const item of state.events.messages.values()) {
      if (!item.ended || !disk.idsStable) continue;
      // v1 临时 ID 仅供本次读取；即使消息匹配，也不能写入持久 closed 引用。
      // 即使 RPC 已失效，也不能仅凭磁盘解析自行宣称取得了 RPC entryId。
      const evidence = rpcMessages.find(value => sameMessage(value.message, item.message));
      if (!evidence || !disk.completeIds.has(evidence.entryId) || !sameMessage(diskMessages.get(evidence.entryId)?.message, item.message)) continue;
      state.pending.push({ runId: state.runId, t: new Date().toISOString(), messageSeq: item.messageSeq, closed: true, entryId: evidence.entryId });
      state.events.close(item.messageSeq);
      this.scheduleWrite(state);
    }
  }
  private scheduleWrite(state: ViewState): void {
    if (state.timer || state.closing || !state.pending.length) return;
    state.timer = setTimeout(() => {
      state.timer = undefined;
      void this.serial(state, () => this.writePending(state, false)).catch(() => {});
    }, Math.max(0, state.lastWrite + 1000 - Date.now()));
    state.timer.unref();
  }
  private async writePending(state: ViewState, force = true): Promise<void> {
    if (state.timer) { clearTimeout(state.timer); state.timer = undefined; }
    // 定时器可能在上一批 I/O 期间排队，执行时仍须复查间隔；终态屏障可立即刷盘。
    if (!force && state.pending.length && Date.now() < state.lastWrite + 1000) {
      this.scheduleWrite(state);
      return;
    }
    if (!state.pending.length) {
      if (state.failure) throw state.failure;
      return;
    }
    const rows = state.pending.splice(0);
    try {
      const file = await this.sidecar(state, "partials", ".jsonl");
      await appendFile(file, rows.map(row => JSON.stringify(row)).join("\n") + "\n", { mode: 0o600 });
      state.lastWrite = Date.now();
      state.failure = undefined;
    } catch (error) {
      // 保留失败批次；后续刷新与 flush 不能把未落盘片段当成成功。
      state.pending.unshift(...rows);
      throw error;
    }
    this.scheduleWrite(state);
  }
  private async verifyState(state: ViewState): Promise<Verification> {
    const file = await this.sessionFile(state.sessionId);
    const result = await verifySessionFile(file, {
      ...(state.initialMessageCount !== undefined ? { messageEndCount: state.initialMessageCount + state.events.messageEndCount } : {}),
      ...(state.events.lastMessage ? { lastMessage: state.events.lastMessage } : {}),
      ...(state.baseline ? { previous: state.baseline } : {}),
      hasUnfinishedPartials: state.events.unfinished(state.diskEntries).length > 0,
    });
    state.verification = clone(result);
    if (!state.baseline && result.hash !== null) state.baseline = { hash: result.hash, bytes: result.bytes };
    return result;
  }
  private async saveDiagnostics(state: ViewState): Promise<void> {
    const target = await this.sidecar(state, "runs", ".json");
    const temporary = `${target}.${randomUUID()}.tmp`;
    // 临时文件以独占创建方式防止链接替换，所有本运行写入均由 work 串行。
    let descriptor;
    try {
      descriptor = await open(temporary, "wx", 0o600);
      await descriptor.writeFile(JSON.stringify(this.runDiagnostics(state), null, 2));
      await descriptor.close(); descriptor = undefined;
      await rename(temporary, target);
    } finally {
      if (descriptor) await descriptor.close();
      await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; });
    }
  }
  private runDiagnostics(state: ViewState) {
    const raw = state.handle?.diagnostics();
    const run = this.store.get<{ pid: number | null; started_at: string; exited_at: string | null; exit_code: number | null; signal: string | null }>("SELECT pid,started_at,exited_at,exit_code,signal FROM process_runs WHERE id=? LIMIT 1", state.runId);
    return clone({
      ...raw, sessionId: state.sessionId, agoraSessionId: state.sessionId, runId: state.runId,
      pid: raw?.identity?.pid ?? run?.pid ?? null, startedAt: run?.started_at ?? null,
      exitedAt: run?.exited_at ?? (state.ended ? new Date().toISOString() : null),
      exitCode: raw?.code ?? run?.exit_code ?? null, signal: raw?.signal ?? run?.signal ?? null,
      lastConfirmedAction: raw?.lastCompletedAction ?? null, inFlightTools: raw?.activeTools ?? [],
      lastEvents: raw?.events ?? [], stderrTail: Buffer.from(raw?.stderr ?? "").subarray(-8192).toString("utf8"),
      ...(state.endReason !== undefined ? { reason: state.endReason } : {}),
      epoch: state.epoch, ended: state.ended, updatedAt: new Date().toISOString(),
      diagnostics: state.issues, baseline: state.baseline ?? null, verification: state.verification ?? null,
    });
  }

  async settled(sessionId: string): Promise<void> {
    const state = await this.ensure(sessionId);
    await this.serial(state, async () => {
      await this.refresh(state);
      await this.writePending(state);
      await this.verifyState(state);
      if (state.handle) await this.saveDiagnostics(state);
    });
    this.status(sessionId);
  }
  async ended(sessionId: string, runId: string, reason?: string): Promise<void> {
    const state = this.states.get(sessionId);
    // 旧运行的延迟退出回调不能覆盖新运行的 epoch 或流状态。
    if (!state || state.runId !== runId) return;
    state.closing = true;
    state.cleanupPending = false;
    if (reason !== undefined) state.endReason = reason;
    if (state.timer) { clearTimeout(state.timer); state.timer = undefined; }
    for (const off of state.off.splice(0)) off();
    try {
      await this.serial(state, async () => {
        if (!state.ended) {
          try {
            await this.refresh(state);
            await this.writePending(state);
            await this.verifyState(state);
          } finally { state.ended = true; }
        }
        await this.saveDiagnostics(state);
      });
    } finally {
      // 进程已经退出，归档失败也不能继续暴露活动工具或 assistant。
      this.publish(state, "agora_run", { runId: state.runId, phase: "exited", ...(state.endReason !== undefined ? { reason: state.endReason } : {}) });
      this.status(sessionId);
      for (const client of [...state.clients]) client.close();
    }
  }
  private async ensure(sessionId: string): Promise<ViewState> {
    // 重同步后的快照等待运行切换，不能在旧运行收尾期间再次取得旧 epoch。
    while (this.transitions.has(sessionId)) await this.transitions.get(sessionId);
    if (this.closed) throw new AgoraError(503, "draining", "会话服务已关闭");
    let state = this.states.get(sessionId);
    if (!state) {
      const run = this.store.get<{ id: string }>("SELECT id FROM process_runs WHERE agora_session_id=? ORDER BY started_at DESC,id DESC LIMIT 1", sessionId);
      state = this.state(sessionId, run?.id ?? "archive");
      this.states.set(sessionId, state);
      const current = state;
      current.ready = this.serial(current, () => this.refresh(current));
    }
    await state.ready;
    if (this.states.get(sessionId) !== state) return this.ensure(sessionId);
    return state;
  }
  private taskStatus(sessionId: string): { status: string; statusDetail: string | null; phase: InFlightState["phase"]; revision: number } {
    const session = this.store.session(sessionId);
    const task = session.task_id ? this.store.get<{ status_detail: string | null }>("SELECT status_detail FROM tasks WHERE id=?", session.task_id) : undefined;
    const state = this.states.get(sessionId);
    const phase = state?.handle && !state.ended ? state.events.activePhase : "idle";
    return { status: session.status, statusDetail: session.control_state ?? task?.status_detail ?? null,
      phase: state?.handle && !state.ended && (state.closing || state.cleanupPending || session.control_state === "stopping") ? "stopping" : phase,
      revision: (session as unknown as { revision?: number }).revision ?? 0 };
  }
  private historySlice(state: ViewState, before: string | undefined, limit: number) {
    const entries = projectUserView(state.entries, state.leafId);
    const end = before === undefined ? entries.length : entries.findIndex(entry => entry.id === before);
    if (end < 0) throw new AgoraError(400, "invalid_cursor", "历史水位不在当前会话分支中");
    const start = Math.max(0, end - limit);
    return { leafId: state.leafId, entries: clone(entries.slice(start, end)), historyBefore: start > 0 ? entries[start]!.id : null };
  }
  async snapshot(sessionId: string, limit?: number) {
    const count = pageLimit(limit, 100);
    const state = await this.ensure(sessionId);
    // 所有可变字段和游标在同一同步段内复制，绝不跨 await 读取流状态。
    const status = this.taskStatus(sessionId);
    return {
      cursor: { epoch: state.epoch, seq: state.seq }, ...this.historySlice(state, undefined, count),
      inFlight: { ...state.events.inFlight(state.entries, !!state.handle && !state.ended), phase: status.phase },
      unfinishedPartials: projectPartials(clone([...state.archivedPartials,
        ...state.events.unfinished(state.diskEntries, !!state.handle && !state.ended)])),
      status: status.status, statusDetail: status.statusDetail,
      usage: this.store.sessionUsage(sessionId),
    };
  }
  async history(sessionId: string, q: { before?: string; limit?: number } = {}) {
    const count = pageLimit(q.limit, 100);
    const state = await this.ensure(sessionId);
    return this.historySlice(state, q.before, count);
  }
  async diagnostics(sessionId: string) {
    this.store.session(sessionId);
    const reader = await openArchive({ home: this.store.home, apiVersion: 1 });
    let archived: unknown[];
    try { archived = await reader.readDiagnostics(sessionId); }
    finally { reader.close(); }
    const state = this.states.get(sessionId);
    if (!state?.handle) return archived;
    return [...archived.filter(value => (value as { runId?: string }).runId !== state.runId), this.runDiagnostics(state)];
  }
  async verify(sessionId: string): Promise<Verification> {
    const state = await this.ensure(sessionId);
    return this.serial(state, async () => {
      await this.refresh(state);
      await this.writePending(state);
      const result = await this.verifyState(state);
      if (state.handle) await this.saveDiagnostics(state);
      return result;
    });
  }
  status(sessionId: string): void {
    const state = this.states.get(sessionId);
    if (state) this.publish(state, "agora_status", this.taskStatus(sessionId));
  }
  private publish(state: ViewState, type: string, data: Record<string, unknown>): void {
    const event: ViewEvent = clone({ cursor: { epoch: state.epoch, seq: ++state.seq }, sessionId: state.sessionId, event: { ...data, type } });
    state.ring.push(event);
    if (state.ring.length > MAX_EVENTS) state.ring.shift();
    for (const client of [...state.clients]) this.send(client, event);
  }
  private send(client: Client, event: ViewEvent): void {
    const response = client.response;
    try {
      if (response.destroyed || response.writableEnded || response.writableLength > MAX_CLIENT_BUFFER ||
          !response.write(`event: ${event.event.type === "resync" ? "resync" : "session"}\nid: ${event.cursor.epoch}:${event.cursor.seq}\ndata: ${JSON.stringify(event)}\n\n`)) client.close();
    } catch { client.close(); }
  }
  private resync(state: ViewState): void {
    for (const client of [...state.clients]) {
      this.send(client, { cursor: { epoch: state.epoch, seq: state.seq }, sessionId: state.sessionId, event: { type: "resync" } });
      client.close();
    }
  }
  stream(sessionId: string, request: IncomingMessage, response: ServerResponse, q: { epoch?: string; afterSeq?: number }): void {
    this.store.session(sessionId);
    const state = this.states.get(sessionId);
    response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const client: Client = { response, close: () => {
      state?.clients.delete(client);
      if (heartbeat) clearInterval(heartbeat);
      request.off("aborted", client.close);
      response.off("close", client.close);
      response.off("error", client.close);
      if (!response.writableEnded && !response.destroyed) {
        if (response.writableLength > MAX_CLIENT_BUFFER) response.destroy();
        else response.end();
      }
    } };
    request.on("aborted", client.close);
    response.on("close", client.close);
    response.on("error", client.close);
    const after = q.afterSeq;
    const earliest = state?.ring[0]?.cursor.seq ?? (state?.seq ?? 0) + 1;
    if (this.closed || this.transitions.has(sessionId) || !state || q.epoch !== state.epoch || !Number.isSafeInteger(after) || after! < earliest - 1 || after! > state.seq || after! < 0) {
      this.send(client, { cursor: { epoch: state?.epoch ?? `${this.instanceId}:archive`, seq: state?.seq ?? 0 }, sessionId, event: { type: "resync" } });
      client.close(); return;
    }
    // 回放与注册在同一同步段中完成，不存在 snapshot 到 stream 之间的丢事件窗口。
    for (const event of state.ring) {
      if (event.cursor.seq > after!) this.send(client, event);
      if (response.writableEnded || response.destroyed) return;
    }
    if (state.ended) { client.close(); return; }
    state.clients.add(client);
    heartbeat = setInterval(() => {
      try { if (!response.write(": keepalive\n\n")) client.close(); }
      catch { client.close(); }
    }, 15_000);
    heartbeat.unref();
  }

  /** 持久化屏障；服务关闭使用 close，避免把普通 flush 当成运行退出。 */
  async flush(): Promise<void> {
    const results = await Promise.allSettled([...this.states.values()].map(state => this.serial(state, async () => {
      await this.writePending(state);
      if (state.handle) await this.saveDiagnostics(state);
    })));
    const errors = results.filter((result): result is PromiseRejectedResult => result.status === "rejected").map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, "会话归档写入失败");
  }
  async close(): Promise<void> {
    this.closed = true;
    const results = await Promise.allSettled([...this.states.values()].map(async state => {
      try { if (state.handle) await this.ended(state.sessionId, state.runId, state.endReason ?? "daemon_shutdown"); }
      finally {
        if (state.timer) clearTimeout(state.timer);
        for (const off of state.off.splice(0)) off();
        for (const client of [...state.clients]) client.close();
      }
    }));
    const errors = results.filter((result): result is PromiseRejectedResult => result.status === "rejected").map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, "会话服务关闭时归档失败");
  }
}
