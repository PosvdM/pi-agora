import { realpath, mkdir, stat, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { acquireSessionWriterLock, currentProcessIdentity, isSessionWriterLock, type ProcessIdentity, type RpcResponse, type SessionWriterLock, type StopReport } from "pi-hostkit";
import { Auth, type Connection, type RunPolicy } from "./auth.js";
import { AgoraError, invalid, text } from "./errors.js";
import { Store, id, now, type RunRow, type TaskRow } from "./store.js";
import type { DriverHandle, DriverExit, SessionDriver } from "./driver.js";

const TOOLS = ["read", "grep", "find", "ls"];
interface Runtime {
  taskId: string; runId: string; handle?: DriverHandle; policy: RunPolicy;
  stopped: boolean; accepted: boolean; active: boolean; ready: boolean;
  terminal?: "stopped" | "interrupted" | "failed"; assistantError?: boolean;
  resolveReady(): void; rejectReady(error: Error): void; readyPromise: Promise<void>;
  handlePromise: Promise<DriverHandle>; resolveHandle(handle: DriverHandle): void;
  rejectHandle(error: Error): void; timer?: ReturnType<typeof setTimeout>;
  idleTimer?: ReturnType<typeof setTimeout>;
}
export interface TaskOptions { home: string; instanceId: string; url: string; maxConcurrentRuns?: number; readyTimeoutMs?: number }
function data(response: RpcResponse): Record<string, unknown> {
  if (!response.success) throw new Error("pi 拒绝了控制命令");
  return (response.data ?? {}) as Record<string, unknown>;
}
function failureDiagnostic(error: unknown, depth = 0): unknown {
  if (!error || typeof error !== "object") return { message: "没有可用的底层诊断" };
  const value = error as { name?: string; message?: string; code?: string; identity?: unknown; stopReport?: unknown; recoveryReports?: unknown; errors?: unknown[] };
  return { name: value.name, message: value.message?.slice(0, 2048), code: value.code, identity: value.identity,
    stopReport: value.stopReport, recoveryReports: value.recoveryReports,
    errors: depth < 3 && Array.isArray(value.errors) ? value.errors.slice(0, 10).map(item => failureDiagnostic(item, depth + 1)) : undefined };
}
function modelName(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const model = value as { provider?: string; id?: string };
  return `${model.provider ?? ""}/${model.id ?? ""}`;
}
export function taskSummary(row: TaskRow) {
  return { taskId: row.id, agoraSessionId: row.agora_session_id, title: row.title,
    model: row.model, profile: row.profile, status: row.status, generation: row.generation,
    revision: row.revision, statusDetail: row.status_detail, createdAt: row.created_at, updatedAt: row.updated_at };
}

export class TaskManager {
  private readonly runtimes = new Map<string, Runtime>();
  private readonly controls = new Map<string, Promise<unknown>>();
  private readonly pending: string[] = [];
  private readonly recoveryLocks = new Map<string, SessionWriterLock>();
  private occupied = 0;
  private halted = false;
  draining = false;
  private readonly maxConcurrentRuns: number;
  constructor(readonly store: Store, readonly auth: Auth, readonly driver: SessionDriver, readonly options: TaskOptions) {
    this.maxConcurrentRuns = options.maxConcurrentRuns ?? 4;
    if (!Number.isInteger(this.maxConcurrentRuns) || this.maxConcurrentRuns < 1 || this.maxConcurrentRuns > 64) throw new Error("并发运行数必须为 1 到 64 的整数");
  }
  private control<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
    const promise = (this.controls.get(taskId) ?? Promise.resolve()).catch(() => {}).then(fn);
    this.controls.set(taskId, promise);
    void promise.finally(() => { if (this.controls.get(taskId) === promise) this.controls.delete(taskId); }).catch(() => {});
    return promise;
  }
  private access(conn: Connection, task: TaskRow, mutation = false): void {
    if (conn.type === "agent:child") {
      const session = this.store.session(task.agora_session_id);
      if (mutation || session.principal_id !== conn.principalId) throw new AgoraError(403, "forbidden", "不能访问此任务");
      return;
    }
    this.auth.requireMain(conn);
    if (conn.type === "agent:main" && task.convener_id !== conn.principalId) throw new AgoraError(403, "forbidden", "只有召集人可以访问此任务");
  }
  async spawn(conn: Connection, body: Record<string, unknown>) {
    const principal = this.auth.requireMain(conn);
    if (this.draining) throw new AgoraError(503, "draining", "daemon 正在排空，不接受新任务");
    if (body.profile !== "explore") invalid("此切片只支持 explore 档位");
    if (body.isolation !== undefined && body.isolation !== "none") invalid("此切片不支持 worktree 隔离");
    if (body.boardId !== undefined) invalid("此切片不支持 board");
    const model = text(body.model, "model", 512);
    if (!/^[^/\s]+\/.+/.test(model)) invalid("模型必须使用完整的 provider/id");
    const thinking = body.thinking === undefined ? "high" : text(body.thinking, "thinking", 16);
    if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(thinking)) invalid("推理级别无效");
    const prompt = text(body.prompt, "prompt", 1_000_000);
    const title = body.title === undefined ? prompt.split(/\r?\n/, 1)[0]!.slice(0, 200) : text(body.title, "title", 200);
    const notify = body.notify ?? "wake";
    if (notify !== "wake" && notify !== "silent") invalid("通知方式无效");
    const rawCwd = body.cwd ?? principal?.cwd;
    let cwd: string;
    try {
      cwd = await realpath(text(rawCwd, "cwd", 32768));
      if (!(await stat(cwd)).isDirectory()) invalid("工作目录无效");
    } catch (error) { if (error instanceof AgoraError) throw error; invalid("工作目录不存在或不可访问"); }
    // 异步路径检查期间租约或排空状态可能发生变化。
    this.auth.requireMain(conn);
    if (this.draining) throw new AgoraError(503, "draining", "daemon 正在排空，不接受新任务");
    const taskId = id("tk"), sessionId = id("as"), principalId = id("ch"), at = now();
    const sessionFile = path.join(this.options.home, "sessions", sessionId, "session.jsonl");
    const convenerId = conn.type === "agent:main" ? conn.principalId! : "user";
    this.store.transaction(() => {
      this.store.run("INSERT INTO principals(id,type,label,cwd,created_at) VALUES(?,?,?,?,?)", principalId, "agent:child", title, cwd, at);
      this.store.run("INSERT INTO agora_sessions(id,task_id,principal_id,convener_id,parent_principal_id,session_file,profile,model,thinking,cwd,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", sessionId, taskId, principalId, convenerId, conn.principalId!, sessionFile, "explore", model, thinking, cwd, "created", at);
      this.store.run("INSERT INTO tasks(id,agora_session_id,convener_id,requested_by,title,prompt,model,thinking,profile,cwd,notify,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)", taskId, sessionId, convenerId, conn.principalId!, title, prompt, model, thinking, "explore", cwd, notify, "created", at, at);
      this.store.run("INSERT INTO task_generations(task_id,generation,status,agora_session_id) VALUES(?,1,'created',?)", taskId, sessionId);
      this.store.change("task", taskId);
    });
    this.pending.push(taskId);
    queueMicrotask(() => this.pump());
    return taskSummary(this.store.task(taskId));
  }
  private pump(): void {
    while (!this.halted && this.occupied < this.maxConcurrentRuns && this.pending.length) {
      const taskId = this.pending.shift()!;
      if (this.store.task(taskId).status !== "created") continue;
      this.occupied++;
      void this.control(taskId, async () => {
        if (this.halted || this.store.task(taskId).status !== "created") { this.occupied--; return; }
        await this.launch(taskId);
      }).catch(() => {});
    }
  }
  private releaseSlot(runtime: Runtime): void {
    if (!runtime.active) return;
    runtime.active = false;
    this.occupied--;
    queueMicrotask(() => this.pump());
  }
  private async launch(taskId: string): Promise<void> {
    const task = this.store.task(taskId), session = this.store.session(task.agora_session_id);
    const runId = id("run");
    const policy: RunPolicy = { profile: "explore", allowedRoots: [task.cwd], protectedPaths: [path.join(this.options.home, "secret")], tools: [...TOOLS], model: task.model, thinking: task.thinking, extensionVersion: "0.1.0" };
    let resolveReady!: () => void, rejectReady!: (error: Error) => void;
    const readyPromise = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    let resolveHandle!: (handle: DriverHandle) => void, rejectHandle!: (error: Error) => void;
    const handlePromise = new Promise<DriverHandle>((resolve, reject) => { resolveHandle = resolve; rejectHandle = reject; });
    void readyPromise.catch(() => {}); void handlePromise.catch(() => {});
    const runtime: Runtime = { taskId, runId, policy, stopped: false, accepted: false, active: true, ready: false,
      readyPromise, resolveReady, rejectReady, handlePromise, resolveHandle, rejectHandle };
    this.runtimes.set(taskId, runtime);
    this.store.run("INSERT INTO process_runs(id,agora_session_id,daemon_instance_id,state,started_at) VALUES(?,?,?,'starting',?)", runId, session.id, this.options.instanceId, now());
    const ticket = this.auth.ticket(session.principal_id, runId, policy);
    runtime.timer = setTimeout(() => rejectReady(new AgoraError(503, "ready_timeout", "受管扩展就绪超时")), this.options.readyTimeoutMs ?? 30_000);
    runtime.timer.unref();
    let phase = "process_start_failed";
    try {
      await mkdir(path.dirname(session.session_file), { recursive: true });
      const handle = await this.driver.start({ agoraSessionId: session.id, runId, instanceId: this.options.instanceId,
        cwd: task.cwd, model: task.model, thinking: task.thinking, profile: "explore", sessionFile: session.session_file,
        env: { AGORA_URL: this.options.url, AGORA_LAUNCH_TICKET: ticket } });
      runtime.handle = handle;
      this.store.run("UPDATE process_runs SET identity=?,pid=?,process_start_time=? WHERE id=?", JSON.stringify(handle.identity), handle.identity.pid, handle.identity.startTime, runId);
      handle.onEvent(event => {
        if (event.type === "message_end") {
          const message = event.message as { role?: string; stopReason?: string; errorMessage?: string } | undefined;
          if (message?.role === "assistant") runtime.assistantError = message.stopReason === "error" || !!message.errorMessage;
        }
        if (event.type === "agent_settled" && runtime.accepted && !runtime.stopped) {
          void this.control(taskId, async () => {
            try { await this.settle(runtime, event); }
            catch {
              runtime.stopped = true;
              runtime.terminal = "interrupted";
              const latest = this.store.task(taskId);
              if (latest.status === "running") this.store.transition(latest, "interrupted", "结果读取失败，任务不会自动重放", runId);
              try { await handle.stop(); } finally { this.auth.revokeRun(runId); this.releaseSlot(runtime); }
            }
          }).catch(() => {});
        }
      });
      handle.onExit(exit => {
        runtime.rejectReady(new Error("运行在就绪前退出"));
        void this.control(taskId, () => this.exited(runtime, exit)).catch(() => {});
      });
      resolveHandle(handle);
      phase = "ready_timeout";
      await readyPromise;
      if (runtime.stopped) throw new Error("任务已停止");
      phase = "rpc_check_failed";
      const available = data(await handle.send({ type: "get_available_models" }, { timeoutMs: 10_000 }));
      if (!Array.isArray(available.models) || !available.models.some(value => modelName(value) === task.model)) throw new AgoraError(400, "model_unavailable", "指定模型不在可用列表中");
      const state = data(await handle.send({ type: "get_state" }, { timeoutMs: 10_000 }));
      if (modelName(state.model) !== policy.model || state.thinkingLevel !== policy.thinking || typeof state.sessionFile !== "string" || path.resolve(state.sessionFile) !== path.resolve(session.session_file)) throw new AgoraError(403, "rpc_state_mismatch", "RPC 模型、推理级别或会话路径不匹配");
      if (runtime.stopped) throw new Error("任务已停止");
      this.store.run("UPDATE agora_sessions SET pi_session_id=? WHERE id=?", typeof state.sessionId === "string" ? state.sessionId : null, session.id);
      handle.markReady();
      this.store.run("UPDATE process_runs SET state='ready' WHERE id=?", runId);
      runtime.accepted = true;
      this.store.transition(this.store.task(taskId), "running");
      phase = "prompt_rejected";
      const response = await handle.send({ type: "prompt", message: task.prompt }, { timeoutMs: 30_000 });
      data(response);
    } catch (error) {
      rejectHandle(error instanceof Error ? error : new Error("任务启动失败"));
      this.auth.revokeRun(runId);
      const messages: Record<string, string> = {
        process_start_failed: "协作进程启动失败", ready_timeout: "受管扩展就绪超时",
        ready_rejected: "受管扩展就绪报告不匹配", model_unavailable: "指定模型不在可用列表中",
        rpc_state_mismatch: "RPC 模型、推理级别或会话路径不匹配", rpc_check_failed: "RPC 状态检查失败",
        prompt_rejected: "pi 未接受任务书",
      };
      const failureCode = error instanceof AgoraError && messages[error.code] ? error.code : phase;
      const message = runtime.stopped ? "运行已停止，任务不会自动重放" : `任务启动失败：${messages[failureCode]}`;
      let stopped = false;
      if (runtime.handle) {
        try { await runtime.handle.stop(); stopped = true; }
        catch { this.store.run("UPDATE process_runs SET cleanup_error=? WHERE id=?", "运行尚未确认退出", runId); }
      } else {
        // start 抛错时写者可能已过启动门闩，必须保留记录供重启按锁文件复查。
        const detail = error as { identity?: ProcessIdentity; stopReport?: unknown; recoveryReports?: unknown };
        this.store.run("UPDATE process_runs SET identity=COALESCE(?,identity),cleanup_error=? WHERE id=?", detail?.identity ? JSON.stringify(detail.identity) : null,
          JSON.stringify({ message: "启动失败，写者退出状态待复查", diagnostic: failureDiagnostic(error) }).replaceAll(ticket, "[已隐藏启动凭证]"), runId);
      }
      if (stopped) this.store.run("UPDATE process_runs SET state='exited',exited_at=COALESCE(exited_at,?) WHERE id=?", now(), runId);
      const latest = this.store.task(taskId);
      if (["created", "running"].includes(latest.status)) this.store.transition(latest, runtime.terminal ?? "failed", message, runId);
      this.releaseSlot(runtime);
    } finally { if (runtime.timer) clearTimeout(runtime.timer); }
  }
  async ready(conn: Connection, body: Record<string, unknown>, runId: string) {
    const runtime = this.childRun(conn, runId);
    if (runtime.ready) return { ready: true };
    try {
      const tools = body.tools;
      if (!Array.isArray(tools) || tools.length !== TOOLS.length || new Set(tools).size !== TOOLS.length || !TOOLS.every(tool => tools.includes(tool))) throw new Error("工具清单不匹配");
      if (body.model !== runtime.policy.model || body.thinking !== runtime.policy.thinking || body.extensionVersion !== runtime.policy.extensionVersion) throw new Error("运行配置不匹配");
      // pi 在 session_start 返回后才绑定 RPC stdin；此处只确认扩展报告。
      // launch 随后独立核对 RPC 状态，通过前不会发送任务书。
      if (runtime.stopped) throw new Error("运行正在停止");
      runtime.ready = true;
      runtime.resolveReady();
      return { ready: true };
    } catch {
      runtime.rejectReady(new AgoraError(403, "ready_rejected", "受管扩展就绪检查失败"));
      throw new AgoraError(403, "ready_rejected", "受管扩展就绪检查失败，运行将被停止");
    }
  }
  private childRun(conn: Connection, runId: string): Runtime {
    const runtime = [...this.runtimes.values()].find(value => value.runId === runId);
    if (conn.type !== "agent:child" || conn.runId !== runId || !runtime || runtime.stopped) throw new AgoraError(403, "forbidden", "不能控制此运行");
    return runtime;
  }
  fatal(conn: Connection, runId: string) {
    const runtime = this.childRun(conn, runId);
    runtime.rejectReady(new Error("权限检查失败"));
    runtime.stopped = true;
    runtime.terminal = runtime.accepted ? "interrupted" : "failed";
    this.auth.revokeRun(runId);
    void this.control(runtime.taskId, async () => {
      try { await runtime.handle?.stop(); }
      finally {
        const task = this.store.task(runtime.taskId);
        if (["created", "running"].includes(task.status)) this.store.transition(task, runtime.accepted ? "interrupted" : "failed", "权限检查失败，运行已停止", runId);
        this.releaseSlot(runtime);
      }
    }).catch(() => {});
    return { stopped: true };
  }
  private async settle(runtime: Runtime, event: Record<string, unknown>): Promise<void> {
    const task = this.store.task(runtime.taskId);
    if (task.status !== "running" || runtime.stopped) return;
    const handle = runtime.handle!;
    const last = data(await handle.send({ type: "get_last_assistant_text" }, { timeoutMs: 10_000 }));
    const usage = data(await handle.send({ type: "get_session_stats" }, { timeoutMs: 10_000 }));
    const lastError = runtime.assistantError;
    const status = event.aborted ? "interrupted" : lastError ? "failed" : "completed";
    const result = typeof last.text === "string" ? last.text : "";
    this.store.transition(task, status, result, runtime.runId, usage);
    this.releaseSlot(runtime);
    runtime.idleTimer = setTimeout(() => {
      void this.control(task.id, async () => { runtime.stopped = true; await handle.stop(); this.auth.revokeRun(runtime.runId); }).catch(() => {});
    }, 300_000);
    runtime.idleTimer.unref();
  }
  private async exited(runtime: Runtime, exit: DriverExit): Promise<void> {
    this.auth.revokeRun(runtime.runId);
    if (runtime.idleTimer) clearTimeout(runtime.idleTimer);
    const clean = exit.cleanupConfirmed === true;
    this.store.run("UPDATE process_runs SET state=?,exited_at=?,exit_code=?,signal=?,diagnostics_path=?,cleanup_error=? WHERE id=?", clean ? "exited" : "stopping", clean ? now() : null, exit.code, exit.signal, exit.diagnosticsPath ?? null, clean ? null : "运行尚未确认退出", runtime.runId);
    const task = this.store.task(runtime.taskId);
    if (!runtime.stopped && ["created", "running"].includes(task.status)) this.store.transition(task, runtime.accepted ? "interrupted" : "failed", "协作进程退出，请检查诊断", runtime.runId);
    this.releaseSlot(runtime);
    if (clean && this.runtimes.get(runtime.taskId) === runtime) this.runtimes.delete(runtime.taskId);
  }
  status(conn: Connection, taskId: string) {
    const task = this.store.task(taskId);
    this.access(conn, task);
    if (conn.type === "agent:child") return taskSummary(task);
    const generation = this.store.get<{ result_text: string | null }>("SELECT result_text FROM task_generations WHERE task_id=? AND generation=?", taskId, task.generation);
    return { ...taskSummary(task), thinking: task.thinking, cwd: task.cwd, prompt: task.prompt, resultText: generation?.result_text ?? null };
  }
  result(conn: Connection, taskId: string, generation?: number) {
    const task = this.store.task(taskId);
    this.access(conn, task);
    if (conn.type === "agent:child") throw new AgoraError(403, "forbidden", "协作会话只能读取自己的任务状态");
    const gen = generation ?? task.generation;
    if (!Number.isSafeInteger(gen) || gen < 1) invalid("代数无效");
    const row = this.store.get<{ status: string; result_text: string | null; usage: string | null; agora_session_id: string | null }>("SELECT status,result_text,usage,agora_session_id FROM task_generations WHERE task_id=? AND generation=?", taskId, gen);
    if (!row) throw new AgoraError(404, "not_found", "任务代数不存在");
    if (["completed", "failed", "interrupted"].includes(row.status)) this.store.run("UPDATE outbox SET processed_at=COALESCE(processed_at,?) WHERE id IN (SELECT id FROM outbox WHERE recipient_id=? AND dedupe_key LIKE ? AND processed_at IS NULL LIMIT 200)", now(), task.convener_id, `task:${taskId}:${gen}:%`);
    return { taskId, agoraSessionId: row.agora_session_id ?? task.agora_session_id, generation: gen, status: row.status, resultText: row.result_text, usage: row.usage ? JSON.parse(row.usage) : null };
  }
  list(conn: Connection, scope: string, limit: number, cursor: number, statuses: string[] = []) {
    this.auth.requireMain(conn);
    if (!["mine", "all"].includes(scope)) invalid("任务范围无效");
    const owner = conn.type === "agent:main" ? conn.principalId! : "user";
    const clauses = ["rowid>?"];
    const args: (string | number)[] = [cursor];
    if (scope === "mine") { clauses.push("convener_id=?"); args.push(owner); }
    if (statuses.length) { clauses.push(`status IN (${statuses.map(() => "?").join(",")})`); args.push(...statuses); }
    const rows = this.store.all<TaskRow & { cursor: number }>(`SELECT rowid AS cursor,* FROM tasks WHERE ${clauses.join(" AND ")} ORDER BY rowid LIMIT ?`, ...args, limit + 1);
    const nextCursor = rows.length > limit ? String(rows[limit - 1]!.cursor) : null;
    const items = rows.slice(0, limit).map(row => {
      if (scope === "all" && conn.type === "agent:main" && row.convener_id !== owner) return { taskId: row.id, title: row.title, status: row.status, convenerId: row.convener_id };
      return taskSummary(row);
    });
    return { items, nextCursor };
  }
  async stop(conn: Connection, taskId: string, body: Record<string, unknown>) {
    return this.control(taskId, async () => {
      // 权限、版本与停止副作用共用队列内的线性化点。
      const task = this.store.task(taskId);
      this.access(conn, task, true);
      if (body.expectedGeneration !== undefined && body.expectedGeneration !== task.generation || body.expectedRevision !== undefined && body.expectedRevision !== task.revision) throw new AgoraError(409, "conflict", "任务状态已变化，请重新读取");
      if (!["created", "running", "waiting_decision", "interrupted", "completed", "failed", "stopped"].includes(task.status)) throw new AgoraError(409, "invalid_state", "任务当前状态不能停止");
      const runtime = this.runtimes.get(taskId);
      if (runtime) { runtime.stopped = true; runtime.terminal = "stopped"; runtime.rejectReady(new Error("任务已停止")); if (runtime.idleTimer) clearTimeout(runtime.idleTimer); }
      let report;
      this.store.run("UPDATE tasks SET status_detail='停止中' WHERE id=?", taskId);
      this.store.run("UPDATE agora_sessions SET control_state='stopping' WHERE id=?", task.agora_session_id);
      if (runtime?.handle) {
        try {
          report = await runtime.handle.stop();
          const exit = await runtime.handle.exited;
          if (!exit.cleanupConfirmed) throw new Error("写者退出未确认");
          await this.exited(runtime, exit);
        } catch { throw new AgoraError(409, "stop_incomplete", "进程尚未确认退出，保留现场"); }
      }
      const recoveryReports = await this.recoverPreviousRuns(taskId, false);
      report ??= recoveryReports.at(-1);
      if (this.unconfirmedRun(taskId)) throw new AgoraError(409, "stop_incomplete", "旧运行尚未确认退出，不能将任务标为停止");
      if (["completed", "failed", "stopped"].includes(task.status)) return { ...taskSummary(task), stopReport: report ?? null };
      this.store.run("UPDATE agora_sessions SET control_state=NULL WHERE id=?", task.agora_session_id);
      this.auth.revokeRun(runtime?.runId ?? "");
      if (runtime) this.releaseSlot(runtime);
      return { ...taskSummary(this.store.transition(this.store.task(taskId), "stopped")), stopReport: report ?? null };
    });
  }
  private unconfirmedRun(taskId?: string): boolean {
    return !!this.store.get("SELECT r.id FROM process_runs r JOIN agora_sessions s ON s.id=r.agora_session_id WHERE r.exited_at IS NULL AND (? IS NULL OR s.task_id=?) LIMIT 1", taskId ?? null, taskId ?? null);
  }
  async recoverPreviousRuns(taskId?: string, startup = true): Promise<StopReport[]> {
    const allReports: StopReport[] = [];
    let cursor = "";
    while (true) {
      const runs = this.store.all<RunRow>("SELECT r.* FROM process_runs r JOIN agora_sessions s ON s.id=r.agora_session_id WHERE r.exited_at IS NULL AND r.id>? AND (? IS NULL OR s.task_id=?) ORDER BY r.id LIMIT 200", cursor, taskId ?? null, taskId ?? null);
      if (!runs.length) break;
      for (const run of runs) {
        cursor = run.id;
        const session = this.store.session(run.agora_session_id);
        // 有 handle 的失败停止仍由原 driver 持锁，不能绕过其清理确认。
        if ([...this.runtimes.values()].some(runtime => runtime.runId === run.id && runtime.handle)) continue;
        let clean = false;
        let recoveryError: unknown;
        let identity: ProcessIdentity | undefined;
        let reports: StopReport[] = [];
        try {
          if (run.identity) {
            identity = JSON.parse(run.identity) as ProcessIdentity;
            reports.push(await this.driver.recoverOldRun(identity, session.session_file));
          }
          else {
            if (this.recoveryLocks.has(session.id)) throw new Error("旧写者清理不明，保留原写锁");
            const lock = await acquireSessionWriterLock(session.session_file, { app: "pi-agora", identity: currentProcessIdentity(this.options.instanceId) });
            if (!isSessionWriterLock(lock)) throw new Error("旧会话仍被锁定");
            const recovered = await lock.recoverPreviousWriter();
            reports = [...lock.recoveryReports];
            if (recovered === "failed") throw new Error("旧写者身份不明");
            if (reports.some(report => report.leftovers.length || report.steps.some(step => ["snapshot", "snapshot cleanup", "verify"].includes(step.step) && !step.ok))) {
              this.recoveryLocks.set(session.id, lock);
              throw new Error("旧进程清理尚未确认");
            }
            await lock.release();
          }
          clean = true;
        } catch (error) {
          recoveryError = failureDiagnostic(error);
          const report = (error as { stopReport?: StopReport })?.stopReport;
          if (report && !reports.includes(report)) reports.push(report);
          this.store.run("UPDATE process_runs SET cleanup_error=? WHERE id=?", JSON.stringify({ message: "旧进程尚未确认退出，禁止恢复", diagnostic: recoveryError }), run.id);
        }
        allReports.push(...reports);
        const diagnostic = {
          reason: startup ? "daemon 重启清理旧运行" : "停止时重试清理持久化运行", runId: run.id, agoraSessionId: session.id,
          previousDaemonInstanceId: run.daemon_instance_id, daemonInstanceId: this.options.instanceId,
          identity: identity ?? null, cleanupConfirmed: clean,
          stopReports: reports, error: recoveryError,
          warnings: ["旧 daemon 的内存事件、活动工具和 stderr 已不可用，不能据此断言中断前没有副作用",
            ...(reports.some(report => report.coverage === "snapshot_visible") ? ["停止仅覆盖快照见过的进程，空残留列表不能证明整棵进程树均已退出"] : [])],
        };
        const diagnosticPath = path.join(this.options.home, "sessions", session.id, `${run.id}.recovery.diagnostics.json`);
        try {
          await mkdir(path.dirname(diagnosticPath), { recursive: true });
          await writeFile(`${diagnosticPath}.tmp`, JSON.stringify(diagnostic, null, 2), { mode: 0o600 });
          await rename(`${diagnosticPath}.tmp`, diagnosticPath);
          this.store.run("UPDATE process_runs SET diagnostics_path=? WHERE id=?", diagnosticPath, run.id);
        } catch {
          this.store.run("UPDATE process_runs SET cleanup_error=? WHERE id=?", JSON.stringify({ message: "重启诊断写入失败，诊断保留在数据库中", diagnostic }), run.id);
        }
        if (clean) this.store.run("UPDATE process_runs SET state='exited',exited_at=? WHERE id=?", now(), run.id);
        const task = this.store.task(session.task_id);
        if (["created", "running"].includes(task.status)) this.store.transition(task, "interrupted", clean ? "daemon 重启，旧运行已停止；任务不会自动重放" : "旧进程尚未确认退出，禁止恢复", run.id);
      }
    }
    if (!startup) return allReports;
    this.store.run("UPDATE outbox SET visible_after=0 WHERE acked_at IS NULL");
    // 启动前已排队但尚未创建 run 的任务仍保留排队状态。
    let rowid = 0;
    while (true) {
      const rows = this.store.all<{ id: string; cursor: number }>("SELECT rowid AS cursor,id FROM tasks WHERE status='created' AND rowid>? ORDER BY rowid LIMIT 200", rowid);
      if (!rows.length) break;
      for (const row of rows) { rowid = row.cursor; this.pending.push(row.id); }
    }
    return allReports;
  }
  async flush(): Promise<void> {
    while (this.controls.size) await Promise.allSettled([...this.controls.values()]);
  }
  startQueue(): void { this.pump(); }
  activeCount(): number { return this.occupied; }
  async shutdown(force: boolean, timeoutMs: number): Promise<void> {
    this.draining = true;
    if (force) this.halted = true;
    else this.pump();
    if (!force && this.occupied) {
      await new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(() => { clearInterval(check); reject(new AgoraError(409, "drain_timeout", "排空超时；请等待或使用强制关闭")); }, timeoutMs);
        const check = setInterval(() => { if (!this.occupied) { clearTimeout(deadline); clearInterval(check); resolve(); } }, 20);
      });
    }
    const work: Promise<unknown>[] = [];
    for (const runtime of this.runtimes.values()) {
      runtime.stopped = true;
      runtime.terminal = "interrupted";
      runtime.rejectReady(new Error("daemon 正在关闭"));
      if (runtime.idleTimer) clearTimeout(runtime.idleTimer);
      work.push(this.control(runtime.taskId, async () => {
        const task = this.store.task(runtime.taskId);
        if (["created", "running"].includes(task.status)) this.store.transition(task, "interrupted", "daemon 强制关闭，任务不会自动重放", runtime.runId);
        if (runtime.handle) {
          await runtime.handle.stop();
          const exit = await runtime.handle.exited;
          if (!exit.cleanupConfirmed) throw new Error("写者退出未确认");
          await this.exited(runtime, exit);
        }
        this.auth.revokeRun(runtime.runId);
        this.releaseSlot(runtime);
      }));
    }
    const results = await Promise.allSettled(work);
    await this.flush();
    // 数据库是所有未确认运行的统一清单，包括上次 daemon 留下且没有 handle 的运行。
    await this.recoverPreviousRuns(undefined, false);
    if (this.unconfirmedRun() || this.recoveryLocks.size || results.some(result => result.status === "rejected")) throw new AgoraError(409, "stop_incomplete", "部分进程尚未确认退出，daemon 保持运行");
  }
}
