import { mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  acquireSessionWriterLock, comparisonKey, currentProcessIdentity, isSameProcess,
  isSessionWriterLock, locatePi, realPathOrPending, stopByIdentity,
  type Containment, type ExtensionUiRequest, type ExtensionUiResponse,
  type ManagedProcess, type ProcessIdentity, type RpcCommand, type RpcEvent,
  type RpcResponse, type SessionWriterLock, type StopOptions, type StopReport,
} from "pi-hostkit";

import type { LaunchSpec, ResolvedSkill } from "../types.js";
import { normalizePiEvent } from "./events.js";
import { buildPiArgv } from "./launch.js";
export type { LaunchSpec } from "../types.js";
export { normalizePiEvent } from "./events.js";

export const DEFAULT_CHILD_UI_TIMEOUT_MS = 10 * 60_000;
export interface DriverOptions {
  home: string;
  piPath?: string;
  extensionPath?: string;
  env?: Record<string, string>;
  /** 指定后仅从这些目录解析技能；相对路径以用户 agentDir 为基准。 */
  skillDirectories?: string[];
  /** 仅供驱动层隔离测试注入；daemon 的配置和 HTTP 不接受此项。 */
  extraExtensions?: string[];
  containment?: Containment;
  readyTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  childUiPolicy?: "cancel" | "pending";
  childUiTimeoutMs?: number;
  stopOptions?: StopOptions;
  snapshotIntervalMs?: number;
}
export interface ActiveTool {
  toolCallId: string;
  toolName: string;
  argsSummary: string;
  startedAt: string;
}
export interface StopDiagnostic {
  code: unknown; message: string; verificationPhase: unknown; status: unknown; attempts: unknown;
  timeoutMs: unknown; identity: unknown; stopReport: unknown;
}
export interface StopTrace { phase: string; at: string; elapsedMs: number; detail?: unknown }
export interface DriverDiagnostics {
  identity: ProcessIdentity;
  reason: string;
  code: number | null;
  signal: string | null;
  cleanupConfirmed: boolean;
  events: RpcEvent[];
  activeTools: ActiveTool[];
  lastCompletedAction?: RpcEvent;
  possibleSideEffects: ActiveTool[];
  stderr: string;
  stopReport?: StopReport;
  stopFailure?: StopDiagnostic;
  stopTrace: StopTrace[];
  warnings: string[];
  error?: string;
}
export interface DriverExit {
  identity: ProcessIdentity;
  code: number | null;
  signal: string | null;
  reason: string;
  cleanupConfirmed: boolean;
  stopReport?: StopReport;
  diagnosticsPath?: string;
  error?: string;
}
export interface DriverHandle {
  readonly identity: ProcessIdentity;
  readonly exited: Promise<DriverExit>;
  send(cmd: RpcCommand, opts?: { timeoutMs?: number }): Promise<RpcResponse>;
  onEvent(listener: (event: RpcEvent) => void): () => void;
  onExit(listener: (exit: DriverExit) => void): () => void;
  respondUi(response: ExtensionUiResponse): void;
  markReady(): void;
  diagnostics(): DriverDiagnostics;
  stop(opts?: StopOptions): Promise<StopReport>;
}
export interface SessionDriver {
  resolveSkills?(names: string[]): Promise<ResolvedSkill[]>;
  start(spec: LaunchSpec): Promise<DriverHandle>;
  recoverOldRun(identity: ProcessIdentity, sessionFile?: string): Promise<StopReport>;
}

function failure(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}
function duration(value: number | undefined, fallback: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > 2 ** 31 - 1) {
    throw failure("EINVAL", "超时必须为 1 到 2147483647 之间的整数毫秒");
  }
  return result;
}
function checkStopOptions(options?: StopOptions): void {
  for (const value of [options?.abortTimeoutMs, options?.graceMs, options?.termGraceMs]) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0 || value > 2 ** 31 - 1)) {
      throw failure("EINVAL", "停止超时必须为 0 到 2147483647 之间的有限毫秒数");
    }
  }
}
function summary(value: unknown, max = 2048): string {
  return (JSON.stringify(value) ?? "").slice(0, max);
}
function boundedEvent(event: RpcEvent): RpcEvent {
  const text = JSON.stringify(event);
  return text.length <= 16_384 ? structuredClone(event) : { type: event.type, summary: text.slice(0, 16_384), truncated: true };
}
function emit<T>(listeners: Set<(value: T) => void>, value: T): void {
  for (const listener of [...listeners]) {
    try { listener(value); } catch (error) { queueMicrotask(() => { throw error; }); }
  }
}
function sessionKey(file: string): string { return comparisonKey(realPathOrPending(file)); }
function validSkillName(name: string): boolean {
  return typeof name === "string" && name.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name);
}
function userPath(value: string, base: string): string {
  const expanded = value === "~" ? homedir() : /^~[/\\]/.test(value) ? path.join(homedir(), value.slice(2)) : value;
  return path.resolve(base, expanded);
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
/** 会话锁在写者放行前取得，直到停止报告及进程身份均通过检查后才释放。 */
export class RpcSubprocessDriver implements SessionDriver {
  private readonly recovering = new Map<string, Set<string>>();
  private readonly recoveryOperations = new Map<string, Promise<StopReport>>();
  private readonly retainedLocks = new Map<string, SessionWriterLock>();
  constructor(private readonly options: DriverOptions) {
    duration(options.readyTimeoutMs, 30_000);
    duration(options.heartbeatIntervalMs, 10_000);
    duration(options.heartbeatTimeoutMs, 30_000);
    duration(options.childUiTimeoutMs, DEFAULT_CHILD_UI_TIMEOUT_MS);
    checkStopOptions(options.stopOptions);
  }
  async resolveSkills(names: string[]): Promise<ResolvedSkill[]> {
    for (const name of names) if (!validSkillName(name)) throw failure("EINVAL", `技能名称无效：${name}`);
    if (!names.length) return [];
    const configuredAgentDir = this.options.env?.PI_CODING_AGENT_DIR ?? process.env.PI_CODING_AGENT_DIR;
    const agentDir = userPath(configuredAgentDir || path.join(homedir(), ".pi", "agent"), homedir());
    let directories = this.options.skillDirectories;
    if (directories === undefined) {
      let settings: Record<string, unknown> = {};
      try { settings = record(JSON.parse((await readFile(path.join(agentDir, "settings.json"), "utf8")).replace(/^\uFEFF/, ""))); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (settings.skills !== undefined && (!Array.isArray(settings.skills) || settings.skills.some((value) => typeof value !== "string"))) {
        throw failure("EINVAL", "用户 settings.json 的 skills 必须为路径数组");
      }
      directories = [path.join(agentDir, "skills"), ...(settings.skills as string[] | undefined ?? [])];
    }
    const pi = await locatePi(this.options.piPath ? { piPath: this.options.piPath } : {});
    if (!pi.supported) throw failure("EAGORA_PI_VERSION", `不支持的 pi 版本：${pi.version}`);
    const { loadSkillsFromDir } = await import(pathToFileURL(path.join(pi.packageDir, "dist", "core", "skills.js")).href) as {
      loadSkillsFromDir(options: { dir: string; source: string }): { skills: { name: string; filePath: string }[] };
    };
    const matches = new Map<string, Map<string, string>>();
    for (const directory of directories) {
      if (typeof directory !== "string" || !directory.trim()) throw failure("EINVAL", "技能路径必须为非空字符串");
      let target = userPath(directory, agentDir);
      try {
        if ((await stat(target)).isFile()) {
          if (path.basename(target) !== "SKILL.md") throw failure("EINVAL", `技能文件必须为 SKILL.md：${target}`);
          target = path.dirname(target);
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      for (const skill of loadSkillsFromDir({ dir: target, source: "user" }).skills) {
        if (path.basename(skill.filePath) !== "SKILL.md" || !validSkillName(skill.name) || !names.includes(skill.name)) continue;
        const canonical = await realpath(path.dirname(skill.filePath));
        const candidates = matches.get(skill.name) ?? new Map<string, string>();
        candidates.set(comparisonKey(canonical), canonical);
        matches.set(skill.name, candidates);
      }
    }
    return names.map((name) => {
      const candidates = matches.get(name);
      if (!candidates?.size) throw failure("EAGORA_SKILL_NOT_FOUND", `找不到用户技能：${name}`);
      if (candidates.size > 1) throw failure("EAGORA_SKILL_AMBIGUOUS", `用户技能名称有歧义：${name}`);
      return { name, path: candidates.values().next().value! };
    });
  }
  async recoverOldRun(identity: ProcessIdentity, sessionFile?: string): Promise<StopReport> {
    const key = sessionFile && sessionKey(sessionFile);
    const processKey = `${identity.pid}:${identity.startTime}`;
    const operationKey = `${key ?? ""}\n${processKey}`;
    const existing = this.recoveryOperations.get(operationKey);
    if (existing) return existing;
    if (key) {
      const pending = this.recovering.get(key) ?? new Set<string>();
      pending.add(processKey);
      this.recovering.set(key, pending);
    }
    const operation = (async () => {
      // 即使 pi 已退出也执行，Linux 的旧 scope 仍可能有后代。
      const report = await stopByIdentity(identity, this.options.stopOptions);
      await verifyStopped(identity, report);
      if (key) {
        const pending = this.recovering.get(key)!;
        pending.delete(processKey);
        if (!pending.size) this.recovering.delete(key);
      }
      return report;
    })();
    this.recoveryOperations.set(operationKey, operation);
    try { return await operation; }
    finally { this.recoveryOperations.delete(operationKey); }
  }
  async start(spec: LaunchSpec): Promise<DriverHandle> {
    if (!["explore", "review", "implement"].includes(spec.profile)) throw failure("EAGORA_PROFILE", "权限档位无效");
    for (const id of [spec.agoraSessionId, spec.runId, spec.instanceId]) {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw failure("EINVAL", "会话和运行标识格式无效");
    }
    const key = sessionKey(spec.sessionFile);
    if (this.recovering.has(key)) throw failure("EAGORA_RECOVERY_PENDING", "旧运行尚未确认退出，不能恢复会话");
    const pi = await locatePi(this.options.piPath ? { piPath: this.options.piPath } : {});
    if (!pi.supported) throw failure("EAGORA_PI_VERSION", `不支持的 pi 版本：${pi.version}`);
    if (!this.options.extensionPath) throw failure("EAGORA_EXTENSION", "缺少受管扩展路径");
    const lock = await acquireSessionWriterLock(spec.sessionFile, {
      app: "pi-agora", identity: currentProcessIdentity(spec.instanceId),
    });
    if (!isSessionWriterLock(lock)) throw failure("EAGORA_SESSION_BUSY", "会话已被其他宿主托管");
    const recovery = await lock.recoverPreviousWriter(this.options.stopOptions);
    if (recovery === "failed") {
      throw Object.assign(failure("EAGORA_RECOVERY_FAILED", "上一个写者状态不明，不能启动会话"), { recoveryReports: lock.recoveryReports });
    }
    // hostkit 的恢复只要求覆盖范围内无残留，宿主还须拒绝快照探测不全。
    const uncertainReport = lock.recoveryReports.find((report) => stopReportProblem(report));
    if (uncertainReport) {
      this.retainedLocks.set(key, lock);
      const pending = this.recovering.get(key) ?? new Set<string>();
      pending.add("unconfirmed-recovery");
      this.recovering.set(key, pending);
      throw Object.assign(failure("EAGORA_RECOVERY_FAILED", "上一个写者的清理尚未确认，保留会话写锁"),
        { stopReport: uncertainReport, recoveryReports: lock.recoveryReports });
    }
    if (this.recovering.has(key)) {
      await lock.release();
      throw failure("EAGORA_RECOVERY_PENDING", "旧运行尚未确认退出，不能恢复会话");
    }
    const argv = buildPiArgv(pi.cliEntry, spec, this.options.extensionPath, this.options.extraExtensions);
    const env = { ...this.options.env, ...spec.env };
    for (const name of Object.keys(env)) if (name.toUpperCase() === "AGORA_HOME") delete env[name];
    let proc: ManagedProcess;
    try {
      proc = await lock.spawnWriter({ argv, cwd: spec.cwd, env, runId: spec.runId,
        instanceId: spec.instanceId, containment: this.options.containment,
        snapshotIntervalMs: this.options.snapshotIntervalMs });
    } catch (error) {
      // spawnWriter 的失败路径自行停止进程；release 仍会核对写者，不能强行解锁。
      try { await lock.release(); }
      catch (cleanup) {
        throw new AggregateError([error, cleanup], `写者启动失败且会话锁未释放：${String(error)}；${String(cleanup)}`);
      }
      throw error;
    }
    return new RpcDriverHandle(proc, lock, spec, this.options);
  }
}

function stopReportProblem(report: StopReport): string | undefined {
  if (!["job_object", "cgroup", "snapshot_visible"].includes(report.coverage)) return "停止报告缺少有效的覆盖范围";
  if (report.steps.some((step) => !step.ok && ["snapshot", "snapshot cleanup", "verify"].includes(step.step))) return "停止报告包含未确认的快照或退出复查";
  if (report.leftovers.length) return "停止报告仍有遗留进程";
  return undefined;
}
async function verifyStopped(identity: ProcessIdentity, report: StopReport, trace?: (phase: string, detail?: unknown) => void): Promise<void> {
  trace?.("report_validation_start");
  const problem = stopReportProblem(report);
  if (problem) {
    const code = problem === "停止报告缺少有效的覆盖范围" ? "EAGORA_STOP_COVERAGE" : "EAGORA_STOP_INCOMPLETE";
    throw Object.assign(failure(code, `${problem}，保留会话写锁`), { identity, stopReport: report, verificationPhase: "report", status: null, attempts: 0, timeoutMs: 0 });
  }
  trace?.("report_validation_passed");
  const attempts = 1, timeoutMs = 0;
  let status: Awaited<ReturnType<typeof isSameProcess>> | "unknown" = "unknown";
  let cause: unknown;
  // hostkit 返回前负责退出可见性；单次独立核对仍未知时保留写锁。
  try {
    trace?.("identity_query_start", { attempts });
    status = await isSameProcess(identity);
    trace?.("identity_query_result", { attempts, status });
    if (status === "gone") return;
  } catch (error) { status = "unknown"; cause = error; trace?.("identity_query_error", { attempts, error: String(error) }); }
  const detail = cause ? `无法核对写者身份：${String(cause)}` : `写者身份状态：${status}`;
  throw Object.assign(failure("EAGORA_STOP_INCOMPLETE", `${detail}，尚未确认退出，保留会话写锁`),
    { cause, identity, stopReport: report, status, attempts, timeoutMs, verificationPhase: "identity" });
}

class RpcDriverHandle implements DriverHandle {
  readonly identity: ProcessIdentity;
  readonly exited: Promise<DriverExit>;
  private resolveExit!: (exit: DriverExit) => void;
  private readonly listeners = new Set<(event: RpcEvent) => void>();
  private readonly exitListeners = new Set<(exit: DriverExit) => void>();
  private readonly events: RpcEvent[] = [];
  private readonly tools = new Map<string, ActiveTool>();
  private readonly completedMessages = new Set<string>();
  private messageSequence = 0;
  private readonly pendingUi = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly unsubscribe: (() => void)[] = [];
  private ready = false;
  private stopping = false;
  private stopPromise?: Promise<StopReport>;
  private processStopPromise?: Promise<StopReport>;
  private finishPromise?: Promise<DriverExit>;
  private exitResult?: DriverExit;
  private exitInfo = { code: null as number | null, signal: null as string | null };
  private reason = "停止";
  private error?: string;
  private stopError?: string;
  private stopFailure?: StopDiagnostic;
  private readonly stopTrace: StopTrace[] = [];
  private readonly stopClock = performance.now();
  private traceStop = (phase: string, detail?: unknown): void => {
    this.stopTrace.push({ phase, at: new Date().toISOString(), elapsedMs: Math.round(performance.now() - this.stopClock), detail });
  };
  private report?: StopReport;
  private cleanupConfirmed = false;
  private lastCompleted?: RpcEvent;
  private interruptedTools?: ActiveTool[];
  private readonly readyTimer: ReturnType<typeof setTimeout>;
  private readonly heartbeatTimer: ReturnType<typeof setInterval>;
  private heartbeatPending = false;
  constructor(private readonly proc: ManagedProcess, private readonly lock: SessionWriterLock,
    private readonly spec: LaunchSpec, private readonly options: DriverOptions) {
    this.identity = proc.identity;
    this.exited = new Promise((resolve) => { this.resolveExit = resolve; });
    this.unsubscribe.push(proc.rpc.onEvent((event) => this.receive(event)),
      proc.rpc.onUiRequest((request) => {
        try { this.ui(request); } catch (error) { this.fatal("界面请求处理失败", error); }
      }),
      proc.rpc.onError((error) => this.fatal("RPC 故障", error)));
    this.readyTimer = setTimeout(() => this.fatal("就绪超时"), duration(options.readyTimeoutMs, 30_000));
    this.heartbeatTimer = setInterval(() => void this.heartbeat(), duration(options.heartbeatIntervalMs, 10_000));
    this.readyTimer.unref(); this.heartbeatTimer.unref();
    void proc.exited.then((exit) => {
      this.traceStop("process_exited", exit);
      this.exitInfo = exit;
      if (!this.stopping) this.fatal(this.ready ? "进程意外退出" : "就绪前退出");
    });
    void proc.rpc.closed.then(() => { if (!this.stopping) this.fatal("RPC 管道关闭"); });
  }
  markReady(): void {
    if (this.stopping) throw failure("EAGORA_STOPPING", "运行正在停止");
    this.ready = true;
    clearTimeout(this.readyTimer);
  }
  send(cmd: RpcCommand, opts?: { timeoutMs?: number }): Promise<RpcResponse> {
    if (this.stopping) return Promise.reject(failure("EAGORA_STOPPING", "运行正在停止"));
    const allowed = ["get_state", "get_available_models", "get_entries", "get_last_assistant_text", "get_session_stats", "get_commands", "prompt", "steer", "follow_up", "clear_queue", "abort"];
    if (!allowed.includes(cmd.type)) return Promise.reject(failure("EAGORA_RPC_FORBIDDEN", "不允许此 RPC 命令"));
    if (!this.ready && ["prompt", "steer", "follow_up"].includes(cmd.type)) {
      return Promise.reject(failure("EAGORA_NOT_READY", "受管扩展尚未就绪"));
    }
    return this.proc.rpc.send(cmd, { timeoutMs: opts?.timeoutMs ?? 30_000 });
  }
  onEvent(listener: (event: RpcEvent) => void): () => void {
    this.listeners.add(listener); return () => this.listeners.delete(listener);
  }
  onExit(listener: (exit: DriverExit) => void): () => void {
    this.exitListeners.add(listener);
    if (this.exitResult) queueMicrotask(() => { if (this.exitListeners.has(listener)) listener(this.exitResult!); });
    return () => this.exitListeners.delete(listener);
  }
  respondUi(response: ExtensionUiResponse): void {
    const timer = this.pendingUi.get(response.id);
    if (!timer) throw failure("EAGORA_UI_EXPIRED", "界面请求已结束或不存在");
    this.proc.rpc.respondUi(response);
    clearTimeout(timer); this.pendingUi.delete(response.id);
  }
  private receive(event: RpcEvent): void {
    this.events.push(boundedEvent(event));
    if (this.events.length > 50) this.events.shift();
    if (event.type === "tool_execution_start") {
      const id = String(event.toolCallId);
      this.tools.set(id, { toolCallId: id, toolName: String(event.toolName),
        argsSummary: summary(event.args), startedAt: new Date().toISOString() });
    } else if (event.type === "tool_execution_end") {
      this.tools.delete(String(event.toolCallId)); this.lastCompleted = boundedEvent(event);
    } else if (event.type === "message_end") this.lastCompleted = boundedEvent(event);
    if (event.type === "message_end" && record(event.message).role === "assistant") {
      const message = record(event.message);
      const id = typeof message.id === "string" && message.id ? `id:${message.id}` : `body:${createHash("sha256").update(JSON.stringify(message)).digest("hex")}`;
      if (!this.completedMessages.has(id)) {
        this.completedMessages.add(id);
        for (const normalized of normalizePiEvent(event, `message-${++this.messageSequence}`, Date.now())) {
          this.events.push(boundedEvent(normalized));
          if (this.events.length > 50) this.events.shift();
          emit(this.listeners, normalized);
        }
      }
    }
    emit(this.listeners, event);
    if (event.type === "extension_error") this.fatal("扩展故障", new Error(summary(event)));
    if (event.type === "session_shutdown" && ["new", "resume", "fork"].includes(String(event.reason))) this.fatal("会话发生未授权替换");
  }
  private ui(request: ExtensionUiRequest): void {
    const dialog = ["select", "confirm", "input", "editor"].includes(request.method);
    if (dialog && (!this.ready || this.stopping || this.options.childUiPolicy !== "pending")) {
      this.proc.rpc.respondUi({ id: request.id, cancelled: true });
    } else if (dialog) {
      const timer = setTimeout(() => {
        try { this.respondUi({ id: request.id, cancelled: true }); }
        catch (error) { this.fatal("界面请求取消失败", error); }
      }, duration(this.options.childUiTimeoutMs, DEFAULT_CHILD_UI_TIMEOUT_MS));
      timer.unref(); this.pendingUi.set(request.id, timer);
    }
    this.receive(request);
  }
  private async heartbeat(): Promise<void> {
    if (!this.ready || this.stopping || this.heartbeatPending) return;
    this.heartbeatPending = true;
    try {
      const response = await this.proc.rpc.send({ type: "get_state" }, { timeoutMs: duration(this.options.heartbeatTimeoutMs, 30_000) });
      if (!response.success) throw new Error(response.error ?? "心跳被拒绝");
    } catch (error) { if (!this.stopping) this.fatal("心跳超时或失败", error); }
    finally { this.heartbeatPending = false; }
  }
  private fatal(reason: string, error?: unknown): void {
    if (this.stopping) return;
    this.reason = reason;
    if (error) this.error = String(error);
    void this.stop().catch(() => { /* 错误保存在退出诊断，由 exited/onExit 交给 daemon。 */ });
  }
  diagnostics(): DriverDiagnostics {
    const activeTools = (this.interruptedTools ?? [...this.tools.values()]).map((tool) => ({ ...tool }));
    return { identity: this.identity, reason: this.reason, ...this.exitInfo, cleanupConfirmed: this.cleanupConfirmed,
      events: structuredClone(this.events), activeTools, lastCompletedAction: this.lastCompleted,
      possibleSideEffects: activeTools.filter((tool) => !["read", "grep", "find", "ls"].includes(tool.toolName)),
      stderr: this.proc.stderrTail(), stopReport: this.report, stopFailure: this.stopFailure, stopTrace: structuredClone(this.stopTrace), error: [this.error, this.stopError].filter(Boolean).join("; ") || undefined,
      warnings: this.report?.coverage === "snapshot_visible" ? ["停止仅覆盖快照见过的进程，空残留列表不能证明整棵进程树均已退出"] : [] };
  }
  stop(opts?: StopOptions): Promise<StopReport> {
    if (this.stopPromise) return this.stopPromise;
    try { checkStopOptions(opts); } catch (error) { return Promise.reject(error); }
    this.stopping = true;
    this.interruptedTools ??= [...this.tools.values()].map((tool) => ({ ...tool }));
    clearTimeout(this.readyTimer); clearInterval(this.heartbeatTimer);
    this.stopPromise = this.performStop(opts).catch((error) => {
      this.stopPromise = undefined;
      throw error;
    });
    return this.stopPromise;
  }
  private async stopProcess(opts?: StopOptions): Promise<StopReport> {
    for (const [id, timer] of this.pendingUi) {
      clearTimeout(timer);
      try { this.proc.rpc.respondUi({ id, cancelled: true }); } catch { /* 传输关闭后继续清理进程。 */ }
    }
    this.pendingUi.clear();
    let updateError: unknown;
    try { await this.lock.update({ state: "stopping" }); }
    catch (error) { updateError = error; }
    try {
      this.traceStop("clear_queue_start");
      const response = await this.proc.rpc.send({ type: "clear_queue" }, { timeoutMs: 2_000 });
      this.traceStop("clear_queue_returned", { success: response.success });
      this.receive({ type: "driver_queue_cleared", data: response.data });
    } catch (error) { this.traceStop("clear_queue_failed", { error: String(error) }); this.receive({ type: "driver_clear_queue_failed", error: String(error) }); }
    this.traceStop("process_stop_start", opts ?? this.options.stopOptions);
    this.report = await this.proc.stop(opts ?? this.options.stopOptions);
    this.traceStop("process_stop_returned", this.report);
    if (updateError) throw updateError;
    return this.report;
  }
  private async performStop(opts?: StopOptions): Promise<StopReport> {
    this.finishPromise = undefined;
    try {
      // 保留首次停止报告；无报告的停止失败保持缓存，显式重试只复查身份和锁释放。
      const report = this.report ?? await (this.processStopPromise ??= this.stopProcess(opts));
      await verifyStopped(this.identity, report, this.traceStop);
      this.exitInfo = await this.proc.exited;
      await this.lock.release();
      this.cleanupConfirmed = true;
      this.stopError = undefined;
      this.stopFailure = undefined;
      this.traceStop("cleanup_confirmed");
      return report;
    } catch (error) {
      this.stopError = String(error);
      const value = error as Partial<StopDiagnostic> | undefined;
      this.stopFailure = { code: value?.code ?? null, message: value?.message ?? String(error),
        verificationPhase: value?.verificationPhase ?? "stop_or_lock", status: value?.status ?? null,
        attempts: value?.attempts ?? null, timeoutMs: value?.timeoutMs ?? null,
        identity: value?.identity ?? this.identity, stopReport: value?.stopReport ?? this.report ?? null };
      this.traceStop("stop_failed", this.stopFailure);
      throw error;
    } finally {
      await this.finish();
    }
  }
  private finish(): Promise<DriverExit> {
    this.finishPromise ??= (async () => {
      const firstExit = !this.exitResult;
      const cleanupCompleted = this.cleanupConfirmed && !this.exitResult?.cleanupConfirmed;
      const snapshot: DriverExit = { identity: this.identity, ...this.exitInfo, reason: this.reason, cleanupConfirmed: this.cleanupConfirmed,
        stopReport: this.report, error: [this.error, this.stopError].filter(Boolean).join("; ") || undefined };
      // exited 只能兑现一次；就地刷新同一对象，供控制队列中的后续 stop 读取。
      const result = this.exitResult ? Object.assign(this.exitResult, snapshot) : snapshot;
      const directory = path.join(this.options.home, "sessions", this.spec.agoraSessionId);
      const target = path.join(directory, `${this.spec.runId}.diagnostics.json`);
      try {
        await mkdir(directory, { recursive: true });
        const temporary = `${target}.tmp`;
        await writeFile(temporary, JSON.stringify(this.diagnostics(), null, 2), { mode: 0o600 });
        await rename(temporary, target);
        result.diagnosticsPath = target;
      } catch (error) { result.error = `${result.error ?? ""} 退出诊断写入失败：${String(error)}`.trim(); }
      this.exitResult = result;
      if (this.cleanupConfirmed) {
        for (const off of this.unsubscribe) off();
        this.listeners.clear();
      }
      if (firstExit) this.resolveExit(result);
      if (firstExit || cleanupCompleted) emit(this.exitListeners, result);
      if (this.cleanupConfirmed) this.exitListeners.clear();
      return result;
    })();
    return this.finishPromise;
  }
}
