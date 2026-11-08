import { realpath, mkdir, stat, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { acquireSessionWriterLock, currentProcessIdentity, isSessionWriterLock, type ProcessIdentity, type RpcResponse, type SessionWriterLock, type StopReport } from "pi-hostkit";
import { Auth, type Connection, type RunPolicy } from "./auth.js";
import { AgoraError, invalid, text } from "./errors.js";
import { Store, id, now, type RunRow, type TaskRow } from "./store.js";
import type { DriverHandle, DriverExit, SessionDriver } from "./driver.js";
import { Worktrees } from "./worktrees.js";
import { optionalBoolean } from "./errors.js";
import { AccessControl, confirmationRequired } from "./acl.js";
import type { RequestRow } from "./requests.js";
import { Budgets, budgetConfig, type BudgetOptions, type UserExecutionProof } from "./budgets.js";
export type { UserExecutionProof } from "./budgets.js";

const TOOLS = ["read", "grep", "find", "ls", "agora_task", "agora_request"];
const TERMINAL = ["completed", "failed", "stopped", "interrupted"];
function rank(profile: string): number { return ["explore", "review", "implement"].indexOf(profile); }
function bounded(value: unknown, fallback: number | null, name: string, nullable = false): number | null {
  if (value === undefined) return fallback;
  if (nullable && value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < (nullable ? 0 : 1) || value > (nullable ? 1_000_000 : 64)) invalid(`${name} 必须是有效整数`);
  return value;
}
interface Runtime {
  taskId: string; runId: string; handle?: DriverHandle; policy: RunPolicy;
  usageGeneration: number; usageSessionId: string; usageClosed: boolean;
  stopped: boolean; accepted: boolean; active: boolean; ready: boolean;
  terminal?: "stopped" | "interrupted" | "failed"; assistantError?: boolean;
  quota?: { resumeAt: string | null; reason: string };
  resolveReady(): void; rejectReady(error: Error): void; readyPromise: Promise<void>;
  handlePromise: Promise<DriverHandle>; resolveHandle(handle: DriverHandle): void;
  rejectHandle(error: Error): void; timer?: ReturnType<typeof setTimeout>;
  idleTimer?: ReturnType<typeof setTimeout>;
  stallTimer?: ReturnType<typeof setInterval>; lastEvent: number;
  tools: Map<string, { name: string; at: number; count: number }>;
}
export interface TaskOptions extends BudgetOptions {
  home: string; instanceId: string; url: string; maxConcurrentRuns?: number; readyTimeoutMs?: number;
  maxTaskDepth?: number; maxChildren?: number | null; worktreeRoot?: string; idleReclaimMs?: number;
  toolStallMinutes?: number; protectedPaths?: string[]; allowedRoots?: string[]; powershell?: boolean;
  defaultSkills?: Partial<Record<"explore" | "review" | "implement", string[]>>;
  quotaRecovery?: "notify" | "auto";
}
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
    revision: row.revision, parentTaskId: row.parent_task_id, depth: row.depth, maxDepth: row.depth_limit - row.depth + 1, maxChildren: row.child_limit, statusDetail: row.status_detail, skills: JSON.parse(row.skills), quotaResumeAt: row.quota_resume_at, createdAt: row.created_at, updatedAt: row.updated_at };
}

export class TaskManager {
  private readonly runtimes = new Map<string, Runtime>();
  private readonly controls = new Map<string, Promise<unknown>>();
  private readonly activeControls = new Set<string>();
  private readonly pending: string[] = [];
  private readonly recoveryLocks = new Map<string, SessionWriterLock>();
  private occupied = 0;
  readonly worktrees: Worktrees;
  private readonly waking = new Set<string>();
  private readonly quotaTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private halted = false;
  private queueStarted = false;
  draining = false;
  private readonly maxConcurrentRuns: number;
  readonly acl: AccessControl;
  readonly budgets: Budgets;
  constructor(readonly store: Store, readonly auth: Auth, readonly driver: SessionDriver, readonly options: TaskOptions) {
    this.worktrees = new Worktrees(store, options.worktreeRoot);
    this.acl = new AccessControl(store, auth);
    this.budgets = new Budgets(store, options);
    budgetConfig(store, options);
    bounded(options.maxTaskDepth, 2, "maxTaskDepth"); bounded(options.maxChildren, null, "maxChildren", true);
    this.maxConcurrentRuns = options.maxConcurrentRuns ?? 4;
    if (!Number.isInteger(this.maxConcurrentRuns) || this.maxConcurrentRuns < 1 || this.maxConcurrentRuns > 64) throw new Error("并发运行数必须为 1 到 64 的整数");
  }
  private control<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
    const promise = (this.controls.get(taskId) ?? Promise.resolve()).catch(() => {}).then(async () => {
      this.activeControls.add(taskId);
      try { return await fn(); }
      finally { this.activeControls.delete(taskId); }
    });
    this.controls.set(taskId, promise);
    void promise.finally(() => { if (this.controls.get(taskId) === promise) this.controls.delete(taskId); }).catch(() => {});
    return promise;
  }
  async spawn(conn: Connection, body: Record<string, unknown>, proof?: UserExecutionProof) {
    this.auth.requireAgent(conn);
    return this.control("@spawn", () => this.spawnInternal(conn, body, proof));
  }
  private async spawnInternal(conn: Connection, body: Record<string, unknown>, proof?: UserExecutionProof) {
    const principal = this.auth.requireAgent(conn);
    const parent = conn.type === "agent:child" ? this.store.get<TaskRow>("SELECT t.* FROM tasks t JOIN agora_sessions s ON s.id=t.agora_session_id WHERE s.principal_id=?", conn.principalId!) : undefined;
    if (conn.type === "agent:child" && (!parent || !["running", "waiting_decision", "waiting_children"].includes(parent.status) || this.ancestorsStopping(parent))) throw new AgoraError(409, "invalid_state", "父任务不能派出下级");
    if (parent) this.budgets.requireAvailable(parent);
    const maxTokens = this.budgets.amount(body.maxTokens, parent ? this.budgets.max(parent) : budgetConfig(this.store, this.options).defaults.maxTokens);
    if (parent) this.budgets.checkChild(parent, maxTokens);
    const depth = parent ? parent.depth + 1 : 1, cap = parent?.depth_limit ?? this.options.maxTaskDepth ?? 2;
    if (depth > cap) throw new AgoraError(403, "depth_exceeded", "任务层数超过子树上限");
    const requestedDepth = bounded(body.maxDepth, cap - depth + 1, "maxDepth")!;
    if (requestedDepth > cap - depth + 1) throw new AgoraError(403, "depth_limit_exceeded", "指定层数不能放宽配置或父任务的限制");
    const childCap = parent?.child_limit ?? this.options.maxChildren ?? null;
    const childLimit = bounded(body.maxChildren, childCap, "maxChildren", true);
    if (childCap !== null && (childLimit === null || childLimit > childCap)) throw new AgoraError(403, "child_limit_exceeded", "下级数量限制不能放宽");
    if (parent?.child_limit !== null && parent?.child_limit !== undefined && this.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM tasks WHERE parent_task_id=? AND status NOT IN ('completed','failed','stopped','interrupted')", parent.id)!.n >= parent.child_limit) throw new AgoraError(409, "children_exceeded", "同时运行的下级数量已达上限");
    if (this.draining) throw new AgoraError(503, "draining", "daemon 正在排空，不接受新任务");
    const profile = text(body.profile, "profile", 16);
    if (rank(profile) < 0) invalid("权限档位无效");
    if (parent && rank(profile) > rank(parent.profile)) throw new AgoraError(403, "profile_upgrade", "下级权限档位不能高于父任务");
    const requestedSkills = body.skills === undefined ? this.options.defaultSkills?.[profile as "explore" | "review" | "implement"] ?? [] : body.skills;
    if (!Array.isArray(requestedSkills) || !requestedSkills.every(name => typeof name === "string" && name.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) || new Set(requestedSkills).size !== requestedSkills.length) invalid("skills 必须是不重复的 skill 名字数组");
    const skills = requestedSkills as string[];
    if (parent && skills.some(name => !(JSON.parse(parent.skills) as string[]).includes(name))) throw new AgoraError(403, "skill_upgrade", "下级 skill 名单不能超出上级名单");
    let resolved: { name: string; path: string }[] = [];
    if (skills.length) {
      if (!this.driver.resolveSkills) throw new AgoraError(400, "skill_not_found", "当前驱动无法解析 skill");
      try { resolved = await this.driver.resolveSkills(skills); }
      catch { throw new AgoraError(400, "skill_not_found", "skill 不存在、名字有歧义或目录不可访问"); }
      if (resolved.length !== skills.length || skills.some(name => !resolved.some(item => item.name === name))) throw new AgoraError(400, "skill_not_found", "skill 解析结果不完整");
    }
    if (body.isolation !== undefined && !["none", "worktree"].includes(String(body.isolation))) invalid("隔离方式无效");
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
    this.auth.requireAgent(conn);
    if (parent && this.ancestorsStopping(parent)) throw new AgoraError(409, "invalid_state", "父任务正在停止");
    if (this.draining) throw new AgoraError(503, "draining", "daemon 正在排空，不接受新任务");
    const taskId = id("tk"), sessionId = id("as"), principalId = id("ch"), at = now();
    const sessionFile = path.join(this.options.home, "sessions", sessionId, "session.jsonl");
    const convenerId = conn.type.startsWith("agent:") ? conn.principalId! : "user";
    if (!parent) this.budgets.checkGrant(conn, taskId, maxTokens, maxTokens, body, "spawn", proof);
    let isolated: Awaited<ReturnType<Worktrees["create"]>> | undefined;
    if (body.isolation === "worktree") { isolated = await this.worktrees.create(cwd, taskId); cwd = isolated.worktree.path; }
    if (!isolated && profile === "implement" && this.store.get("SELECT id FROM tasks WHERE cwd=? AND profile='implement' AND status NOT IN ('completed','failed','stopped','interrupted') LIMIT 1", cwd)) throw new AgoraError(409, "implement_conflict", "同一目录只允许一个无隔离的 implement 任务，请使用 worktree");
    this.auth.requireAgent(conn);
    if (parent && this.ancestorsStopping(parent)) throw new AgoraError(409, "invalid_state", "父任务正在停止");
    this.store.transaction(() => {
      if (parent) {
        const latestParent = this.store.task(parent.id);
        this.budgets.requireAvailable(latestParent);
        this.budgets.checkChild(latestParent, maxTokens);
      } else this.budgets.grant(conn, taskId, maxTokens, maxTokens, body, "spawn", proof);
      this.store.run("INSERT INTO principals(id,type,label,cwd,created_at) VALUES(?,?,?,?,?)", principalId, "agent:child", title, cwd, at);
      this.store.run("INSERT INTO agora_sessions(id,task_id,principal_id,convener_id,parent_principal_id,session_file,profile,model,thinking,cwd,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", sessionId, taskId, principalId, convenerId, conn.principalId!, sessionFile, profile, model, thinking, cwd, "created", at);
      this.store.run("INSERT INTO tasks(id,agora_session_id,convener_id,requested_by,title,prompt,model,thinking,profile,cwd,notify,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)", taskId, sessionId, convenerId, conn.principalId!, title, prompt, model, thinking, profile, cwd, notify, "created", at, at);
      this.store.run("UPDATE tasks SET parent_task_id=?,depth=?,depth_limit=?,child_limit=?,max_tokens=? WHERE id=?", parent?.id ?? null, depth, depth + requestedDepth - 1, childLimit, maxTokens, taskId);
      this.store.run("UPDATE tasks SET skills=?,skill_paths=? WHERE id=?", JSON.stringify(skills), JSON.stringify(resolved.map(item => item.path)), taskId);
      if (isolated) this.store.run("INSERT INTO worktrees VALUES(?,?,?,?,?,?,?)", taskId, isolated.worktree.repo_root, isolated.worktree.base_commit, isolated.worktree.branch, cwd, convenerId, "active");
      this.store.run("INSERT INTO task_generations(task_id,generation,status,agora_session_id) VALUES(?,1,'created',?)", taskId, sessionId);
      this.store.change("task", taskId);
    });
    this.pending.push(taskId);
    queueMicrotask(() => this.pump());
    return { ...taskSummary(this.store.task(taskId)), budget: this.budgets.view(this.store.task(taskId)), worktree: isolated?.worktree, warnings: isolated?.warnings ?? [] };
  }
  private pump(): void {
    while (this.queueStarted && !this.halted && this.occupied < this.maxConcurrentRuns && this.pending.length) {
      const taskId = this.pending.shift()!;
      if (this.budgets.blocked(this.store.task(taskId))) { this.enforceBudgets(this.store.task(taskId)); this.waking.delete(taskId); continue; }
      if (this.store.task(taskId).status !== "created" && !this.waking.has(taskId)) continue;
      this.occupied++;
      void this.control(taskId, async () => {
        if (this.halted || this.store.session(this.store.task(taskId).agora_session_id).control_state === "stopping" || this.store.task(taskId).status !== "created" && !this.waking.has(taskId)) { this.occupied--; this.waking.delete(taskId); return; }
        this.waking.delete(taskId);
        if (this.budgets.blocked(this.store.task(taskId))) { this.enforceBudgets(this.store.task(taskId)); this.occupied--; return; }
        const runtime = this.runtimes.get(taskId);
        if (runtime?.handle && !runtime.stopped) {
          runtime.active = true; runtime.accepted = true; runtime.assistantError = false;
          if (runtime.idleTimer) clearTimeout(runtime.idleTimer);
          const task = this.store.task(taskId);
          runtime.usageGeneration = task.generation;
          if (task.status !== "running") this.transition(task, "running");
          if (task.pending_message) {
            this.store.run("UPDATE tasks SET pending_message=NULL WHERE id=?", taskId);
            try { data(await runtime.handle.send({ type: "prompt", message: `你是子代理。\n\n${task.pending_message}` })); }
            catch {
              runtime.stopped = true;
              this.transition(this.store.task(taskId), "interrupted", "返工送达结果未知，请核对会话后恢复，不能自动重放", runtime.runId);
              this.releaseSlot(runtime);
              await runtime.handle.stop(); this.auth.revokeRun(runtime.runId);
            }
          }
        } else await this.launch(taskId);
      }).catch(() => {});
    }
  }
  private transition(...args: Parameters<Store["transition"]>): TaskRow {
    const result = this.store.transition(...args);
    if (TERMINAL.includes(result.status)) this.notifyConvener(result);
    return result;
  }
  private notifyConvener(task: TaskRow, notify = task.notify): void {
    const parent = this.store.get<TaskRow>("SELECT t.* FROM tasks t JOIN agora_sessions s ON s.id=t.agora_session_id WHERE s.principal_id=?", task.convener_id);
    // 等待下级的父任务必须进入真实回合；其余静默消息只投递。
    if (notify === "silent" && parent?.status !== "waiting_children") return;
    this.store.run("UPDATE outbox SET payload=json_set(payload,'$.triggerTurn',json('true')) WHERE recipient_id=? AND acked_at IS NULL AND json_extract(payload,'$.taskId')=? AND json_extract(payload,'$.generation')=?", task.convener_id, task.id, task.generation);
    this.wake(task.convener_id);
  }
  private releaseSlot(runtime: Runtime): void {
    if (!runtime.active) return;
    runtime.active = false;
    this.occupied--;
    queueMicrotask(() => this.pump());
  }
  private async launch(taskId: string): Promise<void> {
    const task = this.store.task(taskId), session = this.store.session(task.agora_session_id);
    if (this.budgets.blocked(task)) { this.enforceBudgets(task); this.occupied--; return; }
    const runId = id("run");
    const tools = [...TOOLS, ...(task.profile !== "explore" ? ["agora_git"] : []), ...(task.profile === "implement" ? ["bash", "edit", "write", ...(process.platform === "win32" && this.options.powershell ? ["powershell"] : [])] : [])];
    const policy: RunPolicy = { profile: task.profile as RunPolicy["profile"], allowedRoots: [task.cwd, ...this.options.allowedRoots ?? []], protectedPaths: [path.join(this.options.home, "secret"), ...this.options.protectedPaths ?? []], readOnlyRoots: JSON.parse(task.skill_paths), tools, model: task.model, thinking: task.thinking, extensionVersion: "0.1.0" };
    let resolveReady!: () => void, rejectReady!: (error: Error) => void;
    const readyPromise = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    let resolveHandle!: (handle: DriverHandle) => void, rejectHandle!: (error: Error) => void;
    const handlePromise = new Promise<DriverHandle>((resolve, reject) => { resolveHandle = resolve; rejectHandle = reject; });
    void readyPromise.catch(() => {}); void handlePromise.catch(() => {});
    const runtime: Runtime = { taskId, runId, policy, usageGeneration: task.generation, usageSessionId: session.id, usageClosed: false, stopped: false, accepted: false, active: true, ready: false,
      readyPromise, resolveReady, rejectReady, handlePromise, resolveHandle, rejectHandle, lastEvent: Date.now(), tools: new Map() };
    this.runtimes.set(taskId, runtime);
    this.store.run("INSERT INTO process_runs(id,agora_session_id,daemon_instance_id,state,started_at) VALUES(?,?,?,'starting',?)", runId, session.id, this.options.instanceId, now());
    const ticket = this.auth.ticket(session.principal_id, runId, policy);
    runtime.timer = setTimeout(() => rejectReady(new AgoraError(503, "ready_timeout", "受管扩展就绪超时")), this.options.readyTimeoutMs ?? 30_000);
    runtime.timer.unref();
    let phase = "process_start_failed";
    try {
      await mkdir(path.dirname(session.session_file), { recursive: true });
      const handle = await this.driver.start({ agoraSessionId: session.id, runId, instanceId: this.options.instanceId,
        cwd: task.cwd, model: task.model, thinking: task.thinking, profile: policy.profile, tools: policy.tools, skillPaths: JSON.parse(task.skill_paths), sessionFile: session.session_file,
        env: { AGORA_URL: this.options.url, AGORA_LAUNCH_TICKET: ticket } });
      runtime.handle = handle;
      this.store.run("UPDATE process_runs SET identity=?,pid=?,process_start_time=? WHERE id=?", JSON.stringify(handle.identity), handle.identity.pid, handle.identity.startTime, runId);
      handle.onEvent(event => {
        runtime.lastEvent = Date.now();
        if (event.type === "usage_record") this.recordUsage(runtime, event);
        if (event.type === "quota_exhausted") runtime.quota = { resumeAt: typeof event.resumeAt === "string" && Number.isFinite(Date.parse(event.resumeAt)) ? new Date(event.resumeAt).toISOString() : null, reason: typeof event.reason === "string" ? event.reason.slice(0, 2000) : "模型额度用完" };
        if (event.type === "tool_execution_start") runtime.tools.set(String(event.toolCallId), { name: String(event.toolName), at: Date.now(), count: 0 });
        if (event.type === "tool_execution_end") runtime.tools.delete(String(event.toolCallId));
        if (["queue_update", "message_end", "driver_queue_cleared"].includes(event.type)) this.trackSteer(taskId, event);
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
              if (latest.status === "running") this.transition(latest, "interrupted", "结果读取失败，任务不会自动重放", runId);
              try { await handle.stop(); } finally { this.auth.revokeRun(runId); this.releaseSlot(runtime); }
            }
          }).catch(() => {});
        }
      });
      handle.onExit(exit => {
        if (exit.cleanupConfirmed) runtime.usageClosed = true;
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
      this.budgets.requireAvailable(this.store.task(taskId));
      runtime.accepted = true;
      if (this.store.task(taskId).status !== "running") this.transition(this.store.task(taskId), "running");
      runtime.stallTimer = setInterval(() => this.watchdog(runtime), Math.min(60_000, Math.max(10, (this.options.toolStallMinutes ?? 10) * 60_000)));
      runtime.stallTimer.unref();
      phase = "prompt_rejected";
      const message = task.pending_message ?? (task.status === "created" ? task.prompt : undefined);
      if (message !== undefined) {
        this.store.run("UPDATE tasks SET pending_message=NULL WHERE id=?", taskId);
        data(await handle.send({ type: "prompt", message: `你是子代理。\n\n${message}` }, { timeoutMs: 30_000 }));
      }
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
      if (["created", "running", "waiting_decision", "waiting_children"].includes(latest.status)) this.transition(latest, runtime.terminal ?? (task.status === "created" ? "failed" : "interrupted"), message, runId);
      this.releaseSlot(runtime);
    } finally { if (runtime.timer) clearTimeout(runtime.timer); }
  }
  async ready(conn: Connection, body: Record<string, unknown>, runId: string) {
    const runtime = this.childRun(conn, runId);
    if (runtime.ready) return { ready: true };
    try {
      const tools = body.tools;
      if (!Array.isArray(tools) || tools.length !== runtime.policy.tools.length || new Set(tools).size !== runtime.policy.tools.length || !runtime.policy.tools.every(tool => tools.includes(tool))) throw new Error("工具清单不匹配");
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
        if (["created", "running", "waiting_children", "waiting_decision"].includes(task.status)) this.transition(task, runtime.accepted ? "interrupted" : "failed", "权限检查失败，运行已停止", runId);
        this.releaseSlot(runtime);
      }
    }).catch(() => {});
    return { stopped: true };
  }
  private async settle(runtime: Runtime, event: Record<string, unknown>): Promise<void> {
    const task = this.store.task(runtime.taskId);
    if (task.status !== "running" || runtime.stopped) return;
    const handle = runtime.handle!;
    if (runtime.quota) { await this.pauseQuota(runtime); return; }
    const last = data(await handle.send({ type: "get_last_assistant_text" }, { timeoutMs: 10_000 }));
    const usage = data(await handle.send({ type: "get_session_stats" }, { timeoutMs: 10_000 }));
    const lastError = runtime.assistantError;
    const children = this.store.get("SELECT id FROM tasks WHERE parent_task_id=? AND status NOT IN ('completed','failed','stopped','interrupted') LIMIT 1", task.id);
    const requests = this.store.get("SELECT id FROM requests WHERE task_id=? AND state IN ('open','escalated') LIMIT 1", task.id);
    const status = event.aborted ? "interrupted" : lastError ? "failed" : requests ? "waiting_decision" : children ? "waiting_children" : "completed";
    const result = typeof last.text === "string" ? last.text : "";
    if (runtime.stopped || this.store.task(task.id).status === "budget_paused") return;
    this.budgets.requireAvailable(this.store.task(task.id));
    this.transition(task, status, result, runtime.runId, usage);
    if (!["interrupted", "failed"].includes(status)) this.store.run("UPDATE tasks SET recovery_attempts=0 WHERE id=?", task.id);
    this.releaseSlot(runtime);

    runtime.idleTimer = setTimeout(() => {
      void this.control(task.id, async () => {
        if (runtime.active || runtime.tools.size || runtime.stopped) return;
        runtime.stopped = true; await handle.stop(); this.auth.revokeRun(runtime.runId);
      }).catch(() => {});
    }, this.options.idleReclaimMs ?? 300_000);
    runtime.idleTimer.unref();
  }
  private recordUsage(runtime: Runtime, event: Record<string, unknown>): void {
    if (!runtime.accepted || runtime.usageClosed || typeof event.requestId !== "string" || !event.requestId || event.requestId.length > 512) return;
    const fields = ["inputTokens", "cacheReadTokens", "cacheWriteTokens", "outputTokens", "reasoningTokens", "contextTokens"] as const;
    const values = fields.map(field => event[field]);
    if (values.some(value => typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)) return;
    this.store.run("INSERT OR IGNORE INTO usage_records(task_id,generation,agora_session_id,run_id,request_id,input_tokens,cache_read_tokens,cache_write_tokens,output_tokens,reasoning_tokens,context_tokens,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
      runtime.taskId, runtime.usageGeneration, runtime.usageSessionId, runtime.runId, event.requestId, ...(values as number[]), now());
    this.enforceBudgets(this.store.task(runtime.taskId));
  }
  private enforceBudgets(task: TaskRow): void {
    const outerTransaction = this.store.db.isTransaction;
    for (const exhausted of this.budgets.exhausted(task)) {
      const subtree = this.store.all<TaskRow>("WITH RECURSIVE subtree(id) AS (SELECT ? UNION ALL SELECT t.id FROM tasks t JOIN subtree s ON t.parent_task_id=s.id) SELECT t.* FROM tasks t JOIN subtree s ON s.id=t.id", exhausted.id);
      for (const row of subtree) {
        const latest = this.store.task(row.id);
        if (TERMINAL.includes(latest.status) || latest.status === 'budget_paused') continue;
        // 暂停与签名调用方共用事务，数据库门禁先于异步进程控制生效。
        this.budgets.atomic(() => {
          this.store.run("UPDATE tasks SET status='budget_paused',revision=revision+1,status_detail=NULL,updated_at=? WHERE id=?", now(), row.id);
          this.store.run("UPDATE agora_sessions SET status='budget_paused',revision=revision+1 WHERE id=?", row.agora_session_id);
          this.store.run("UPDATE task_generations SET status='budget_paused' WHERE task_id=? AND generation=?", row.id, row.generation);
          this.store.change('task', row.id);
          this.store.notice(row.convener_id, `task:${row.id}:${row.generation}:budget:${exhausted.id}`, 'task:budget_paused', { taskId: row.id, generation: row.generation, status: 'budget_paused', budget: this.budgets.view(this.store.task(row.id)), summary: '任务或祖先预算已用完，请增额后明确恢复；下级不会自动恢复。' });
        });
        const pause = () => {
          // 外层签名事务可能回滚，不能提前停止进程或修改内存运行状态。
          if (this.store.task(row.id).status !== 'budget_paused') return;
          this.clearQuotaTimer(row.id);
          this.waking.delete(row.id);
          const runtime = this.runtimes.get(row.id);
          if (runtime) {
            runtime.stopped = true;
            runtime.rejectReady(new Error('任务预算已用完'));
            if (runtime.idleTimer) clearTimeout(runtime.idleTimer);
            if (runtime.stallTimer) clearInterval(runtime.stallTimer);
          }
          void this.control(row.id, () => this.pauseBudgetRun(row.id, runtime)).catch(error => {
            this.store.run('UPDATE tasks SET status_detail=? WHERE id=?', JSON.stringify({ message: '预算暂停运行尚未确认退出', diagnostic: failureDiagnostic(error) }), row.id);
          });
        };
        if (outerTransaction) queueMicrotask(pause);
        else pause();
      }
    }
  }
  private async pauseBudgetRun(taskId: string, runtime?: Runtime): Promise<void> {
    if (!runtime) return;
    const handle = runtime.handle;
    if (!handle) { this.releaseSlot(runtime); return; }
    const diagnostics: unknown[] = [];
    let stopReport: StopReport | undefined;
    let cleanupConfirmed = false;
    try {
      // 驱动负责取消队列、停止推理与进程清理；预算层不发送 Harness 专有命令。
      stopReport = await handle.stop();
      const exit = await handle.exited;
      cleanupConfirmed = exit.cleanupConfirmed === true;
      if (!cleanupConfirmed) throw new Error('预算暂停写者尚未确认退出');
      await this.exited(runtime, exit);
      this.store.run('UPDATE tasks SET status_detail=? WHERE id=? AND status=\'budget_paused\'', JSON.stringify({ stopReport, diagnostics }), taskId);
    } catch (error) {
      diagnostics.push(failureDiagnostic(error));
      throw error;
    } finally {
      const diagnosticPath = path.join(this.options.home, 'sessions', runtime.usageSessionId, `${runtime.runId}.budget.diagnostics.json`);
      const previous = this.store.get<{ diagnostics_path: string | null }>('SELECT diagnostics_path FROM process_runs WHERE id=?', runtime.runId)?.diagnostics_path;
      const diagnostic = { reason: '任务预算暂停', runId: runtime.runId, taskId, stopReport, diagnostics, cleanupConfirmed, previousDiagnosticsPath: previous ?? null };
      try {
        await mkdir(path.dirname(diagnosticPath), { recursive: true });
        await writeFile(`${diagnosticPath}.tmp`, JSON.stringify(diagnostic, null, 2), { mode: 0o600 });
        await rename(`${diagnosticPath}.tmp`, diagnosticPath);
        this.store.run('UPDATE process_runs SET diagnostics_path=? WHERE id=?', diagnosticPath, runtime.runId);
      } catch {
        this.store.run('UPDATE tasks SET status_detail=? WHERE id=?', JSON.stringify({ message: '预算暂停诊断写入失败', diagnostic }), taskId);
      }
      this.store.run("UPDATE steer_messages SET state='dropped',updated_at=? WHERE task_id=? AND state IN ('accepted','queued')", now(), taskId);
      this.auth.revokeRun(runtime.runId);
      this.releaseSlot(runtime);
    }
  }
  private clearQuotaTimer(taskId: string): void {
    const timer = this.quotaTimers.get(taskId);
    if (timer) clearTimeout(timer);
    this.quotaTimers.delete(taskId);
  }
  private async pauseQuota(runtime: Runtime): Promise<void> {
    const task = this.store.task(runtime.taskId), quota = runtime.quota!;
    if (task.status === 'budget_paused' || this.budgets.blocked(task)) { this.enforceBudgets(task); return; }
    runtime.stopped = true;
    if (runtime.idleTimer) clearTimeout(runtime.idleTimer);
    if (runtime.stallTimer) clearInterval(runtime.stallTimer);
    const paused = this.transition(task, "quota_paused", quota.reason, runtime.runId, undefined, quota);
    try {
      if (!quota.resumeAt) this.notifyConvener(paused, "wake");
      await runtime.handle!.stop();
      const exit = await runtime.handle!.exited;
      if (!exit.cleanupConfirmed) throw new Error("额度暂停运行尚未确认退出");
      await this.exited(runtime, exit);
      this.armQuotaTimer(this.store.task(task.id));
    } finally { this.auth.revokeRun(runtime.runId); this.releaseSlot(runtime); }
  }
  private armQuotaTimer(task: TaskRow): void {
    this.clearQuotaTimer(task.id);
    if (!task.quota_resume_at || task.quota_notified_at || this.draining) return;
    const remaining = Date.parse(task.quota_resume_at) - Date.now();
    const timer = setTimeout(() => {
      this.quotaTimers.delete(task.id);
      void this.control(task.id, async () => {
        const latest = this.store.task(task.id);
        if (latest.status !== "quota_paused" || latest.quota_notified_at || this.draining || this.ancestorsStopping(latest)) return;
        if (Date.parse(latest.quota_resume_at ?? "") > Date.now()) { this.armQuotaTimer(latest); return; }
        if (this.options.quotaRecovery === "auto" && !this.unconfirmedRun(task.id) && !this.budgets.blocked(latest)) {
          await this.resumeQuota(task.id);
          return;
        }
        this.store.transaction(() => {
          const paused = this.store.all<TaskRow>("SELECT * FROM tasks WHERE status='quota_paused' AND convener_id=? ORDER BY id LIMIT 200", latest.convener_id);
          const tasks = paused.map(row => ({ taskId: row.id, generation: row.generation, resumeAt: row.quota_resume_at, contextTokens: this.store.usage(row.id).contextTokens }));
          this.store.notice(latest.convener_id, `task:${latest.id}:${latest.generation}:quota:${latest.quota_resume_at}`, "task:quota_ready", {
            taskId: latest.id, generation: latest.generation, title: latest.title, status: "quota_paused", notify: "wake", tasks,
            summary: `额度重置时间已到。暂停任务及上下文 token：${tasks.map(item => `${item.taskId}=${item.contextTokens}`).join("，")}。请决定 recover resume 续跑或停止后改派；续跑父任务不会续跑下级。`,
          });
          this.store.run("UPDATE tasks SET quota_notified_at=? WHERE id=?", now(), latest.id);
        });
        this.notifyConvener(latest, "wake");
      }).catch(() => {});
    }, Math.min(2_147_483_647, Math.max(1, remaining)));
    timer.unref(); this.quotaTimers.set(task.id, timer);
  }
  private async resumeQuota(taskId: string): Promise<void> {
    const task = this.store.task(taskId);
    this.budgets.requireAvailable(task);
    if (task.status !== "quota_paused" || this.ancestorsStopping(task)) throw new AgoraError(409, "invalid_state", "任务不能续跑");
    if (task.quota_resume_at && Date.parse(task.quota_resume_at) > Date.now()) throw new AgoraError(409, "quota_not_reset", "额度尚未到重置时间");
    if (this.unconfirmedRun(taskId)) throw new AgoraError(409, "stop_incomplete", "额度暂停运行尚未确认退出");
    this.clearQuotaTimer(taskId);
    this.store.run("UPDATE tasks SET pending_message=? WHERE id=?", "【agora 额度恢复】请从当前会话继续；核对工具是否已产生副作用，不要重放已经完成的操作。下级保持原状态。", taskId);
    this.transition(task, "running", undefined, undefined, undefined, { resumeAt: null });
    this.schedule(taskId);
  }
  private async exited(runtime: Runtime, exit: DriverExit): Promise<void> {
    this.auth.revokeRun(runtime.runId);
    if (runtime.idleTimer) clearTimeout(runtime.idleTimer);
    if (runtime.stallTimer) clearInterval(runtime.stallTimer);
    const clean = exit.cleanupConfirmed === true;
    if (clean) runtime.usageClosed = true;
    this.store.run("UPDATE process_runs SET state=?,exited_at=?,exit_code=?,signal=?,diagnostics_path=COALESCE(?,diagnostics_path),cleanup_error=? WHERE id=?", clean ? "exited" : "stopping", clean ? now() : null, exit.code, exit.signal, exit.diagnosticsPath ?? null, clean ? null : "运行尚未确认退出", runtime.runId);
    const task = this.store.task(runtime.taskId);
    if (!runtime.stopped && ["created", "running", "waiting_children", "waiting_decision"].includes(task.status)) this.transition(task, runtime.accepted ? "interrupted" : "failed", "协作进程退出，请检查诊断", runtime.runId);
    this.releaseSlot(runtime);
    if (clean && this.runtimes.get(runtime.taskId) === runtime) this.runtimes.delete(runtime.taskId);
  }
  status(conn: Connection, taskId: string) {
    this.auth.requireAgent(conn);
    const task = this.store.task(taskId);
    this.acl.task(conn, task, "status");
    if (conn.type === "agent:child" && task.convener_id !== conn.principalId) return { ...taskSummary(task), budget: this.budgets.view(task), usage: this.store.usage(taskId), treeUsage: this.store.usage(taskId, true) };
    const generation = this.store.get<{ result_text: string | null }>("SELECT result_text FROM task_generations WHERE task_id=? AND generation=?", taskId, task.generation);
    return { ...taskSummary(task), budget: this.budgets.view(task), thinking: task.thinking, cwd: task.cwd, prompt: task.prompt, usage: this.store.usage(taskId), treeUsage: this.store.usage(taskId, true), resultText: generation?.result_text ?? null, worktree: this.worktrees.get(taskId) };
  }
  result(conn: Connection, taskId: string, generation?: number) {
    this.auth.requireAgent(conn);
    const task = this.store.task(taskId);
    this.acl.task(conn, task, "result");
    const gen = generation ?? task.generation;
    if (!Number.isSafeInteger(gen) || gen < 1) invalid("代数无效");
    const row = this.store.get<{ status: string; result_text: string | null; usage: string | null; agora_session_id: string | null }>("SELECT status,result_text,usage,agora_session_id FROM task_generations WHERE task_id=? AND generation=?", taskId, gen);
    if (!row) throw new AgoraError(404, "not_found", "任务代数不存在");
    if (["completed", "failed", "interrupted"].includes(row.status)) this.store.run("UPDATE outbox SET processed_at=COALESCE(processed_at,?) WHERE id IN (SELECT id FROM outbox WHERE recipient_id=? AND dedupe_key LIKE ? AND processed_at IS NULL LIMIT 200)", now(), task.convener_id, `task:${taskId}:${gen}:%`);
    return { taskId, budget: this.budgets.view(task), agoraSessionId: row.agora_session_id ?? task.agora_session_id, generation: gen, status: row.status, resultText: row.result_text, usage: { ...(row.usage ? JSON.parse(row.usage) : {}), ...this.store.usage(taskId) }, generationUsage: this.store.usage(taskId, false, gen), treeUsage: this.store.usage(taskId, true), worktree: this.worktrees.get(taskId) };
  }
  list(conn: Connection, scope: string, limit: number, cursor: number, statuses: string[] = []) {
    this.auth.requireAgent(conn);
    if (conn.type === "agent:child" && scope !== "mine") throw new AgoraError(403, "forbidden", "子代理只能列出直接下级");
    if (!["mine", "all"].includes(scope)) invalid("任务范围无效");
    const owner = conn.type.startsWith("agent:") ? conn.principalId! : "user";
    const clauses = ["rowid>?"];
    const args: (string | number)[] = [cursor];
    if (scope === "mine") { clauses.push("convener_id=?"); args.push(owner); }
    if (statuses.length) { clauses.push(`status IN (${statuses.map(() => "?").join(",")})`); args.push(...statuses); }
    const rows = this.store.all<TaskRow & { cursor: number }>(`SELECT rowid AS cursor,* FROM tasks WHERE ${clauses.join(" AND ")} ORDER BY rowid LIMIT ?`, ...args, limit + 1);
    const nextCursor = rows.length > limit ? String(rows[limit - 1]!.cursor) : null;
    const items = rows.slice(0, limit).map(row => {
      if (scope === "all" && conn.type === "agent:main" && !this.acl.ownsTree(conn, row)) return { taskId: row.id, title: row.title, status: row.status, convener: row.convener_id === "user" ? "用户" : this.store.principal(row.convener_id)?.label ?? "未知召集人" };
      return taskSummary(row);
    });
    return { items, nextCursor };
  }
  async stop(conn: Connection | undefined, taskId: string, body: Record<string, unknown>) {
    if (conn) this.auth.requireAgent(conn);
    return this.control(taskId, async () => {
      // 权限、版本与停止副作用共用队列内的线性化点。
      const task = this.store.task(taskId);
      if (conn) this.acl.task(conn, task, "stop");
      if (body.expectedGeneration !== undefined && body.expectedGeneration !== task.generation || body.expectedRevision !== undefined && body.expectedRevision !== task.revision) throw new AgoraError(409, "conflict", "任务状态已变化，请重新读取");
      if (!["created", "running", "waiting_decision", "waiting_children", "quota_paused", "budget_paused", "interrupted", "completed", "failed", "stopped"].includes(task.status)) throw new AgoraError(409, "invalid_state", "任务当前状态不能停止");
      this.store.run("UPDATE agora_sessions SET control_state='stopping' WHERE id=?", task.agora_session_id);
      const subtreeReports: unknown[] = [], failures: unknown[] = [];
      let cursor = "";
      while (true) {
        const descendants = this.store.all<TaskRow>("SELECT * FROM tasks WHERE parent_task_id=? AND id>? ORDER BY id LIMIT 200", taskId, cursor);
        if (!descendants.length) break;
        for (const child of descendants) {
          cursor = child.id;
          try { subtreeReports.push(await this.stopDescendant(child.id)); } catch (error) { failures.push(error); }
        }
      }
      this.clearQuotaTimer(taskId);
      const droppedSteers = this.store.all("SELECT id,message FROM steer_messages WHERE task_id=? AND state IN ('accepted','queued') LIMIT 1000", taskId);
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
      this.store.run("UPDATE steer_messages SET state='dropped',updated_at=? WHERE task_id=? AND state IN ('accepted','queued')", now(), taskId);
      if (failures.length) throw new AgoraError(409, "stop_incomplete", "部分下级尚未确认退出，保留子树停止现场", { subtreeReports });
      // 只有所有运行均确认退出后才清控制标志；失败路径保留停止中现场。
      this.store.transaction(() => {
        this.store.run("UPDATE tasks SET status_detail=NULL,quota_resume_at=NULL,quota_notified_at=NULL WHERE id=?", taskId);
        this.store.run("UPDATE agora_sessions SET control_state=NULL WHERE task_id=? AND control_state='stopping'", taskId);
      });
      this.auth.revokeRun(runtime?.runId ?? "");
      if (runtime) this.releaseSlot(runtime);
      if (["completed", "failed", "stopped"].includes(task.status)) return { ...taskSummary(this.store.task(taskId)), stopReport: report ?? null, subtreeReports, droppedSteers };
      const result = this.transition(this.store.task(taskId), "stopped");
      return { ...taskSummary(result), stopReport: report ?? null, subtreeReports, droppedSteers };
    });
  }
  private stopDescendant(taskId: string) { return this.stop(undefined, taskId, {}); }
  private expected(task: TaskRow, body: Record<string, unknown>): void {
    if (body.expectedGeneration !== undefined && body.expectedGeneration !== task.generation || body.expectedRevision !== undefined && body.expectedRevision !== task.revision) throw new AgoraError(409, "conflict", "任务状态已变化，请重新读取");
  }
  private ancestorsStopping(task: TaskRow): boolean {
    let value = task;
    while (true) {
      if (this.store.session(value.agora_session_id).control_state === "stopping") return true;
      if (!value.parent_task_id) return false;
      value = this.store.task(value.parent_task_id);
    }
  }
  inboxAllowed(conn: Connection): boolean {
    if (conn.type !== "agent:child") return true;
    const runtime = [...this.runtimes.values()].find(r => r.runId === conn.runId);
    return !!runtime?.accepted && runtime.ready && !runtime.stopped && !this.ancestorsStopping(this.store.task(runtime.taskId));
  }
  inboxSilentOnly(conn: Connection): boolean {
    return conn.type === "agent:child" && ![...this.runtimes.values()].some(runtime => runtime.runId === conn.runId && runtime.active);
  }
  authorized(conn: Connection, runId: string) {
    const runtime = this.childRun(conn, runId);
    return { ready: runtime.accepted && this.store.get<{ state: string }>("SELECT state FROM process_runs WHERE id=?", runId)?.state === "ready" };
  }
  wake(principalId: string): void {
    const task = this.store.get<TaskRow>("SELECT t.* FROM tasks t JOIN agora_sessions s ON s.id=t.agora_session_id WHERE s.principal_id=?", principalId);
    if (!task || this.ancestorsStopping(task) || this.budgets.blocked(task) || ["stopped", "interrupted", "failed", "completed", "quota_paused", "budget_paused"].includes(task.status)) return;
    if (this.runtimes.get(task.id)?.active || this.waking.has(task.id)) return;
    this.waking.add(task.id); this.pending.push(task.id); queueMicrotask(() => this.pump());
  }
  private schedule(taskId: string): void {
    const task = this.store.task(taskId);
    if (this.budgets.blocked(task)) { this.enforceBudgets(task); return; }
    if (this.waking.has(taskId)) return;
    this.waking.add(taskId); this.pending.push(taskId); queueMicrotask(() => this.pump());
  }
  private trackSteer(taskId: string, event: Record<string, unknown>): void {
    const serialized = JSON.stringify(event);
    const rows = this.store.all<{ id: string; state: string }>("SELECT id,state FROM steer_messages WHERE task_id=? AND state IN ('accepted','queued') LIMIT 1000", taskId);
    for (const row of rows) {
      if (!serialized.includes(row.id)) continue;
      const role = (event.message as { role?: string } | undefined)?.role;
      const state = event.type === "driver_queue_cleared" ? "dropped" : event.type === "message_end" && role === "user" ? "delivered" : event.type === "queue_update" ? "queued" : undefined;
      if (state) this.store.run("UPDATE steer_messages SET state=?,updated_at=? WHERE id=?", state, now(), row.id);
    }
  }
  private watchdog(runtime: Runtime): void {
    if (!runtime.active || runtime.stopped) return;
    const interval = (this.options.toolStallMinutes ?? 10) * 60_000;
    if (Date.now() - runtime.lastEvent < interval) return;
    for (const [toolId, tool] of runtime.tools) {
      const cycle = Math.floor((Date.now() - runtime.lastEvent) / interval);
      if (cycle <= tool.count) continue;
      tool.count = cycle;
      const task = this.store.task(runtime.taskId);
      this.store.notice(task.convener_id, `task:${task.id}:stall:${toolId}:${cycle}`, "task:stall", { taskId: task.id, generation: task.generation, title: task.title, status: "running", summary: `工具 ${tool.name} 已运行 ${Date.now() - tool.at} 毫秒，期间没有事件。可继续等待、停止或中断返工。` });
      this.notifyConvener(task, "wake");
    }
  }
  private nextGeneration(task: TaskRow, message: string, interrupted?: { text?: string; usage?: unknown }): void {
    this.store.transaction(() => {
      this.store.run("UPDATE task_generations SET status='interrupted',settled_at=?,result_text=COALESCE(?,result_text),usage=COALESCE(?,usage) WHERE task_id=? AND generation=? AND status NOT IN ('completed','failed','stopped','interrupted')", now(), interrupted?.text ?? null, interrupted?.usage === undefined ? null : JSON.stringify(interrupted.usage), task.id, task.generation);
      const changed = this.store.run("UPDATE tasks SET generation=generation+1,revision=revision+1,status='running',status_detail=NULL,pending_message=?,updated_at=? WHERE id=? AND generation=? AND revision=?", message, now(), task.id, task.generation, task.revision);
      if (!changed.changes) throw new AgoraError(409, "conflict", "任务状态已变化");
      this.store.run("INSERT INTO task_generations(task_id,generation,status,agora_session_id) VALUES(?,?,'running',?)", task.id, task.generation + 1, task.agora_session_id);
      this.store.run("UPDATE agora_sessions SET status='running',control_state=NULL,ended_at=NULL WHERE id=?", task.agora_session_id);
      this.store.change("task", task.id);
    });
  }
  async steer(conn: Connection, taskId: string, body: Record<string, unknown>) {
    this.auth.requireAgent(conn);
    return this.control(taskId, async () => {
      let task = this.store.task(taskId);
      this.acl.task(conn, task, "steer"); this.expected(task, body);
      this.budgets.requireAvailable(task);
      if (this.ancestorsStopping(task) || !["running", "completed", "failed", "waiting_decision", "waiting_children"].includes(task.status)) throw new AgoraError(409, "invalid_state", "此状态不能返工");
      const message = text(body.message, "message", 1_000_000), interrupt = optionalBoolean(body.interrupt, "interrupt") ?? false;
      let runtime = this.runtimes.get(taskId);
      const interrupted: { text?: string; usage?: unknown } = {};
      const newGeneration = interrupt || ["completed", "failed"].includes(task.status);
      const steerId = id("st"), generation = task.generation + (newGeneration ? 1 : 0);
      const annotated = `【agora 返工 ${steerId}，第 ${generation} 代】\n${message}`;
      if (interrupt && runtime?.handle && !runtime.stopped) {
        runtime.stopped = true;
        this.store.run("UPDATE agora_sessions SET control_state='stopping' WHERE id=?", task.agora_session_id);
        this.trackSteer(taskId, { type: "driver_queue_cleared", data: data(await runtime.handle.send({ type: "clear_queue" })) });
        let done!: () => void;
        const settled = new Promise<void>(resolve => { done = resolve; });
        const off = runtime.handle.onEvent(event => { if (event.type === "agent_settled") done(); });
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await runtime.handle.send({ type: "abort" }, { timeoutMs: 2000 });
          await Promise.race([settled, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("中断超时")), 2000); })]);
          // 中断已确认，尽量保存当前可读取的旧代结果；失败不阻断已获批准的返工。
          try {
            const last = data(await runtime.handle.send({ type: "get_last_assistant_text" }, { timeoutMs: 2000 }));
            if (typeof last.text === "string") interrupted.text = last.text;
          } catch { /* 旧代保留已有结果与逐请求用量。 */ }
          try { interrupted.usage = data(await runtime.handle.send({ type: "get_session_stats" }, { timeoutMs: 2000 })); }
          catch { /* 会话统计不可用时保留已有统计。 */ }
          this.budgets.requireAvailable(this.store.task(taskId));
          runtime.stopped = false;
        } catch {
          await runtime.handle.stop();
          const exit = await runtime.handle.exited;
          if (!exit.cleanupConfirmed) throw new AgoraError(409, "stop_incomplete", "旧运行尚未确认退出");
          await this.exited(runtime, exit);
          runtime = undefined;
        } finally { off(); if (timer) clearTimeout(timer); }
        if (runtime) this.releaseSlot(runtime);
        this.store.run("UPDATE steer_messages SET state='dropped',updated_at=? WHERE task_id=? AND state IN ('accepted','queued')", now(), taskId);
      }
      task = this.store.task(taskId);
      this.auth.requireAgent(conn);
      this.acl.task(conn, task, 'steer');
      this.expected(task, body);
      this.budgets.requireAvailable(task);
      if (newGeneration) this.nextGeneration(task, annotated, interrupted);
      this.store.run("INSERT INTO steer_messages VALUES(?,?,?,?,?,?,?)", steerId, taskId, generation, annotated, "accepted", now(), now());
      if (!newGeneration && runtime?.handle && runtime.active && !runtime.stopped) {
        data(await runtime.handle.send({ type: "steer", message: annotated }));
      } else {
        if (!newGeneration) this.store.run("UPDATE tasks SET pending_message=COALESCE(pending_message || char(10),'') || ? WHERE id=?", annotated, taskId);
        this.schedule(taskId);
      }
      return { ...taskSummary(this.store.task(taskId)), steerId, delivery: this.store.get<{ state: string }>("SELECT state FROM steer_messages WHERE id=?", steerId)!.state };
    });
  }
  async cleanup(conn: Connection, taskId: string, body: Record<string, unknown>) {
    this.auth.requireAgent(conn);
    return this.control(taskId, async () => {
      const task = this.store.task(taskId); this.acl.task(conn, task, "cleanup"); this.expected(task, body);
      if (!TERMINAL.includes(task.status) || this.unconfirmedRun(taskId)) throw new AgoraError(409, "invalid_state", "清理前必须停止并确认相关进程退出");
      await this.worktrees.remove(taskId, optionalBoolean(body.discard, "discard") ?? false);
      return { ...taskSummary(this.store.task(taskId)), worktree: this.worktrees.get(taskId) };
    });
  }
  async recover(conn: Connection, taskId: string, body: Record<string, unknown>, proof?: UserExecutionProof) {
    this.auth.requireAgent(conn);
    if (body.mode === "abandon") {
      this.acl.task(conn, this.store.task(taskId), "recover", body, proof);
      return this.stop(conn, taskId, body);
    }
    return this.control(taskId, async () => {
      let task = this.store.task(taskId); this.acl.task(conn, task, "recover", body, proof); this.expected(task, body);
      this.budgets.requireAvailable(task, true);
      if (this.ancestorsStopping(task)) throw new AgoraError(409, 'invalid_state', '任务或祖先正在停止');
      if (task.status === "budget_paused") {
        if (body.mode !== "resume") throw new AgoraError(409, "invalid_state", "预算暂停任务请增额后明确续跑");
        if (this.unconfirmedRun(taskId)) throw new AgoraError(409, "stop_incomplete", "预算暂停运行尚未确认退出");
        const started = this.store.get<{ started_at: string | null }>('SELECT started_at FROM task_generations WHERE task_id=? AND generation=?', taskId, task.generation)?.started_at;
        const explanation = '【agora 预算恢复】请核对已执行操作后继续；下级保持暂停，不得重放已完成操作。';
        this.store.run("UPDATE tasks SET pending_message=? WHERE id=?", started ? explanation : `${task.prompt}\n\n${explanation}`, taskId);
        this.transition(task, "running");
        this.schedule(taskId);
        return { ...taskSummary(this.store.task(taskId)), budget: this.budgets.view(this.store.task(taskId)) };
      }
      if (task.status === "quota_paused") {
        if (body.mode !== "resume") throw new AgoraError(409, "invalid_state", "额度暂停任务请先续跑或停止后改派");
        await this.resumeQuota(taskId);
        return taskSummary(this.store.task(taskId));
      }
      if (task.status !== "interrupted") throw new AgoraError(409, "invalid_state", "只有中断任务可以恢复");
      const mode = body.mode;
      if (!["resume", "reopen", "replace"].includes(String(mode))) invalid("恢复方式无效");
      if (mode === "resume" && task.recovery_attempts >= 2) throw new AgoraError(409, "recovery_exhausted", "连续恢复失败已达上限，请重开、换人或放弃");
      const runtime = this.runtimes.get(taskId);
      if (runtime?.handle) {
        runtime.stopped = true; await runtime.handle.stop();
        const exit = await runtime.handle.exited;
        if (!exit.cleanupConfirmed) throw new AgoraError(409, "stop_incomplete", "旧写者尚未确认退出");
        await this.exited(runtime, exit);
      }
      await this.recoverPreviousRuns(taskId, false);
      if (this.unconfirmedRun(taskId)) throw new AgoraError(409, "stop_incomplete", "旧写者尚未确认退出");
      this.auth.requireAgent(conn);
      task = this.store.task(taskId);
      this.expected(task, body);
      this.acl.task(conn, task, "recover", body, proof);
      this.budgets.requireAvailable(task, true);
      const explanation = "【agora 中断恢复】旧运行已停止。请核对会话记录、工作目录与退出诊断，正在执行的工具可能已经产生副作用，不得自动重放。";
      if (mode === "resume") {
        this.store.run("UPDATE tasks SET pending_message=?,recovery_attempts=recovery_attempts+1 WHERE id=?", explanation, taskId);
        this.transition(this.store.task(taskId), "running");
      } else {
        const profile = mode === "replace" && body.profile !== undefined ? text(body.profile, "profile", 16) : task.profile;
        const model = mode === "replace" && body.model !== undefined ? text(body.model, "model", 512) : task.model;
        if (rank(profile) < 0 || !/^[^/\s]+\/.+/.test(model)) invalid("替换模型或档位无效");
        if (task.parent_task_id && rank(profile) > rank(this.store.task(task.parent_task_id).profile)) throw new AgoraError(403, "profile_upgrade", "下级不能升级档位");
        const oldSession = this.store.session(task.agora_session_id), newSession = id("as"), child = id("ch"), at = now();
        this.store.transaction(() => {
          this.store.run("INSERT INTO principals(id,type,label,cwd,created_at) VALUES(?,'agent:child',?,?,?)", child, task.title, task.cwd, at);
          this.store.run("INSERT INTO agora_sessions(id,task_id,principal_id,convener_id,parent_principal_id,inherits_from,inherit_reason,session_file,profile,model,thinking,cwd,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'created',?)", newSession, taskId, child, task.convener_id, task.requested_by, oldSession.id, String(mode), path.join(this.options.home, "sessions", newSession, "session.jsonl"), profile, model, task.thinking, task.cwd, at);
          this.store.run("UPDATE tasks SET agora_session_id=?,profile=?,model=?,recovery_attempts=0 WHERE id=?", newSession, profile, model, taskId);
          this.store.run("UPDATE tasks SET convener_id=?,requested_by=? WHERE parent_task_id=? AND taken_over_from IS NULL", child, child, taskId);
          this.store.run("UPDATE requests SET target_id=? WHERE target_id=?", child, oldSession.principal_id);
          this.store.run("UPDATE requests SET asker_id=? WHERE asker_id=? AND state IN ('open','escalated')", child, oldSession.principal_id);
          this.store.run("UPDATE outbox SET recipient_id=? WHERE recipient_id=? AND acked_at IS NULL", child, oldSession.principal_id);
        });
        task = this.store.task(taskId);
        const last = this.store.get<{ result_text: string | null }>("SELECT result_text FROM task_generations WHERE task_id=? AND generation=?", taskId, task.generation);
        this.nextGeneration(task, `${task.prompt}\n\n${explanation}\n原会话摘要：${last?.result_text ?? "没有最终结果"}`);
      }
      this.schedule(taskId);
      return taskSummary(this.store.task(taskId));
    });
  }
  limits(conn: Connection, taskId: string, body: Record<string, unknown>, proof?: UserExecutionProof) {
    this.auth.requireAgent(conn);
    const task = this.store.task(taskId);
    this.acl.task(conn, task, 'limits', body, proof);
    this.expected(task, body);
    if (body.maxTokens === undefined) invalid('必须指定 maxTokens');
    const maxTokens = this.budgets.amount(body.maxTokens, this.budgets.max(task));
    if (task.parent_task_id) this.budgets.checkChild(this.store.task(task.parent_task_id), maxTokens);
    const delta = maxTokens - this.budgets.max(task);
    if (delta > 0 && task.convener_id === 'user' && !proof) confirmationRequired('agora.task.limits', taskId, body);
    this.budgets.atomic(() => {
      if (!task.parent_task_id && delta > 0) this.budgets.grant(conn, taskId, maxTokens, delta, body, 'limits', proof);
      this.store.run('UPDATE tasks SET max_tokens=?,revision=revision+1,updated_at=? WHERE id=?', maxTokens, now(), taskId);
      this.store.change('task', taskId);
      this.enforceBudgets(this.store.task(taskId));
    });
    return { ...taskSummary(this.store.task(taskId)), budget: this.budgets.view(this.store.task(taskId)) };
  }
  takeOver(conn: Connection, taskId: string, body: Record<string, unknown>, proof?: UserExecutionProof) {
    this.auth.requireAgent(conn);
    this.store.transaction(() => {
      const task = this.store.task(taskId);
      this.acl.task(conn, task, 'takeover', body, proof);
      this.expected(task, body);
      if (task.convener_id === 'user') return;
      // 已排队的操作在执行时重检 ACL；已开始的相关操作须先退出线性化区间。
      const related = this.store.all<{ id: string }>(`WITH RECURSIVE
        ancestors(id,parent_task_id) AS (SELECT id,parent_task_id FROM tasks WHERE id=? UNION ALL SELECT t.id,t.parent_task_id FROM tasks t JOIN ancestors a ON t.id=a.parent_task_id),
        subtree(id) AS (SELECT ? UNION ALL SELECT t.id FROM tasks t JOIN subtree s ON t.parent_task_id=s.id)
        SELECT id FROM ancestors UNION SELECT id FROM subtree`, taskId, taskId);
      if (related.some(row => this.activeControls.has(row.id)) || this.ancestorsStopping(task)) throw new AgoraError(409, 'task_busy', '任务或相关任务正在执行控制操作，请稍后重试接管');
      this.store.run("UPDATE tasks SET taken_over_from=convener_id,convener_id='user',revision=revision+1,updated_at=? WHERE id=?", now(), taskId);
      this.store.run("UPDATE agora_sessions SET convener_id='user',revision=revision+1 WHERE id=?", task.agora_session_id);
      this.store.run("UPDATE worktrees SET owner_id='user' WHERE task_id=?", taskId);
      const requests = this.store.all<RequestRow>(`WITH RECURSIVE subtree(id) AS (
        SELECT ? UNION ALL SELECT t.id FROM tasks t JOIN subtree s ON t.parent_task_id=s.id
      ) SELECT q.* FROM requests q WHERE q.state IN ('open','escalated') AND q.target_id!='user'
        AND COALESCE(q.task_id,(SELECT task_id FROM agora_sessions WHERE principal_id=q.asker_id)) IN (SELECT id FROM subtree)
        AND NOT EXISTS(SELECT 1 FROM agora_sessions s WHERE s.principal_id=q.target_id AND s.task_id IN (SELECT id FROM subtree))`, taskId);
      for (const request of requests) {
        this.store.run("UPDATE requests SET target_id='user',state='escalated',revision=revision+1,updated_at=? WHERE id=?", now(), request.id);
        // 只结束提问通知的业务待办，保留投递记录及任务接管通知。
        this.store.run("UPDATE outbox SET processed_at=COALESCE(processed_at,?) WHERE kind IN ('request:opened','request:escalated') AND json_extract(payload,'$.requestId')=? AND recipient_id!='user'", now(), request.id);
        this.store.notice('user', `request:${request.id}:taken_over:${id('op')}`, 'request:escalated', {
          requestId: request.id, taskId: request.task_id, state: 'escalated', questions: JSON.parse(request.questions), context: request.context,
          summary: `提问 ${request.id} 所属任务已被用户接管，请用户答复。`,
        });
        this.store.change('request', request.id);
      }
      const key = `task:${taskId}:taken_over:${id('op')}`;
      this.store.notice(task.convener_id, key, 'task:taken_over', {
        taskId, generation: task.generation, title: task.title, summary: '任务已被用户接管', notify: 'wake', triggerTurn: true,
      });
      this.store.change('task', taskId);
      queueMicrotask(() => {
        if (this.store.get('SELECT id FROM outbox WHERE recipient_id=? AND dedupe_key=?', task.convener_id, key)) this.wake(task.convener_id);
      });
    });
    return { ...taskSummary(this.store.task(taskId)), budget: this.budgets.view(this.store.task(taskId)) };
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
        // 清理结论与诊断写入分开：先清除过时的清理错误，后续写盘失败单独记录。
        if (clean) this.store.run("UPDATE process_runs SET cleanup_error=NULL WHERE id=?", run.id);
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
        if (["created", "running"].includes(task.status)) this.transition(task, "interrupted", clean ? "daemon 重启，旧运行已停止；任务不会自动重放" : "旧进程尚未确认退出，禁止恢复", run.id);
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
  startQueue(): void {
    this.reconcileBudgets();
    let pausedCursor = "";
    while (true) {
      const paused = this.store.all<TaskRow>("SELECT * FROM tasks WHERE status='quota_paused' AND quota_notified_at IS NULL AND id>? ORDER BY id LIMIT 200", pausedCursor);
      if (!paused.length) break;
      for (const task of paused) {
        pausedCursor = task.id;
        if (task.quota_resume_at) this.armQuotaTimer(task);
        else this.store.transaction(() => {
          const run = this.store.get<{ id: string }>("SELECT id FROM process_runs WHERE agora_session_id=? ORDER BY started_at DESC,rowid DESC LIMIT 1", task.agora_session_id);
          this.store.quotaUnknownNotice(task, run?.id ?? "unknown");
        });
      }
    }
    let cursor = "";
    while (true) {
      const rows = this.store.all<{ id: string }>("SELECT p.id FROM principals p WHERE p.type='agent:child' AND p.id>? AND EXISTS(SELECT 1 FROM outbox o WHERE o.recipient_id=p.id AND o.acked_at IS NULL AND o.processed_at IS NULL AND (json_extract(o.payload,'$.triggerTurn')=1 OR (COALESCE(json_extract(o.payload,'$.notify'),'wake')<>'silent' AND COALESCE(json_extract(o.payload,'$.silent'),0)<>1))) ORDER BY p.id LIMIT 200", cursor);
      if (!rows.length) break;
      for (const row of rows) { cursor = row.id; this.wake(row.id); }
    }
    this.queueStarted = true;
    this.pump();
  }
  reconcileBudgets(): void {
    let cursor = "";
    while (true) {
      const rows = this.store.all<TaskRow>("SELECT * FROM tasks WHERE id>? AND status NOT IN ('completed','failed','stopped','interrupted') ORDER BY id LIMIT 200", cursor);
      if (!rows.length) return;
      for (const row of rows) { cursor = row.id; this.enforceBudgets(row); }
    }
  }
  activeCount(): number { return this.occupied; }
  async shutdown(force: boolean, timeoutMs: number): Promise<void> {
    this.draining = true;
    for (const taskId of this.quotaTimers.keys()) this.clearQuotaTimer(taskId);
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
        if (["created", "running"].includes(task.status)) this.transition(task, "interrupted", "daemon 强制关闭，任务不会自动重放", runtime.runId);
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
