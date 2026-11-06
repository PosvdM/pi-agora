import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  acquireSessionWriterLock, comparisonKey, currentProcessIdentity, isSameProcess,
  isSessionWriterLock, locatePi, realPathOrPending, stopByIdentity,
  type Containment, type ExtensionUiRequest, type ExtensionUiResponse,
  type ManagedProcess, type ProcessIdentity, type RpcCommand, type RpcEvent,
  type RpcResponse, type SessionWriterLock, type StopOptions, type StopReport,
} from "pi-hostkit";

export const DEFAULT_CHILD_UI_TIMEOUT_MS = 10 * 60_000;
export interface LaunchSpec {
  agoraSessionId: string;
  runId: string;
  instanceId: string;
  cwd: string;
  model: string;
  thinking: string;
  profile: "explore";
  sessionFile: string;
  env: Record<string, string>;
}
export interface DriverOptions {
  home: string;
  piPath?: string;
  extensionPath?: string;
  env?: Record<string, string>;
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
export interface DriverDiagnostics {
  identity: ProcessIdentity;
  reason: string;
  code: number | null;
  signal: string | null;
  events: RpcEvent[];
  activeTools: ActiveTool[];
  lastCompletedAction?: RpcEvent;
  possibleSideEffects: ActiveTool[];
  stderr: string;
  stopReport?: StopReport;
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

/** 会话锁在写者放行前取得，直到停止报告及进程身份均通过检查后才释放。 */
export class RpcSubprocessDriver implements SessionDriver {
  private readonly recovering = new Set<string>();
  constructor(private readonly options: DriverOptions) {
    duration(options.readyTimeoutMs, 30_000);
    duration(options.heartbeatIntervalMs, 10_000);
    duration(options.heartbeatTimeoutMs, 30_000);
    duration(options.childUiTimeoutMs, DEFAULT_CHILD_UI_TIMEOUT_MS);
    checkStopOptions(options.stopOptions);
  }
  async recoverOldRun(identity: ProcessIdentity, sessionFile?: string): Promise<StopReport> {
    const key = sessionFile && sessionKey(sessionFile);
    if (key) this.recovering.add(key);
    // 即使 pi 已退出也执行，Linux 的旧 scope 仍可能有后代。
    const report = await stopByIdentity(identity, this.options.stopOptions);
    await verifyStopped(identity, report);
    if (key) this.recovering.delete(key);
    return report;
  }
  async start(spec: LaunchSpec): Promise<DriverHandle> {
    if (spec.profile !== "explore") throw failure("EAGORA_PROFILE", "此切片只支持 explore 档位");
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
    const recovery = await lock.recoverPreviousWriter();
    if (recovery === "failed") throw failure("EAGORA_RECOVERY_FAILED", "上一个写者状态不明，不能启动会话");
    // 恢复报告里的残留不能因新写者启动而被忽略。
    if (lock.recoveryReports.some((report) => report.leftovers.length)) {
      await lock.release();
      throw failure("EAGORA_RECOVERY_FAILED", "上一个写者仍有遗留进程");
    }
    const argv = [pi.cliEntry, "--mode", "rpc", "--session-dir", path.dirname(spec.sessionFile),
      "--session", spec.sessionFile, "--model", spec.model, "--thinking", spec.thinking,
      "--tools", "read,grep,find,ls,agora_*", "-ne", "-ns", "-np", "--no-approve",
      "-e", this.options.extensionPath];
    for (const extension of this.options.extraExtensions ?? []) argv.push("-e", extension);
    const env = { ...this.options.env, ...spec.env };
    for (const name of Object.keys(env)) if (name.toUpperCase() === "AGORA_HOME") delete env[name];
    let proc: ManagedProcess;
    try {
      proc = await lock.spawnWriter({ argv, cwd: spec.cwd, env, runId: spec.runId,
        instanceId: spec.instanceId, containment: this.options.containment,
        snapshotIntervalMs: this.options.snapshotIntervalMs });
    } catch (error) {
      // spawnWriter 的失败路径自行停止进程；release 仍会核对写者，不能强行解锁。
      await lock.release();
      throw error;
    }
    return new RpcDriverHandle(proc, lock, spec, this.options);
  }
}

async function verifyStopped(identity: ProcessIdentity, report: StopReport): Promise<void> {
  if (!["job_object", "cgroup", "snapshot_visible"].includes(report.coverage)) {
    throw failure("EAGORA_STOP_COVERAGE", "停止报告缺少有效的覆盖范围");
  }
  const uncertainSnapshot = report.steps.some((step) => !step.ok && ["snapshot", "snapshot cleanup", "verify"].includes(step.step));
  if (uncertainSnapshot || report.leftovers.length || await isSameProcess(identity) !== "gone") {
    throw failure("EAGORA_STOP_INCOMPLETE", "进程树尚未确认退出，保留会话写锁");
  }
}

class RpcDriverHandle implements DriverHandle {
  readonly identity: ProcessIdentity;
  readonly exited: Promise<DriverExit>;
  private resolveExit!: (exit: DriverExit) => void;
  private readonly listeners = new Set<(event: RpcEvent) => void>();
  private readonly exitListeners = new Set<(exit: DriverExit) => void>();
  private readonly events: RpcEvent[] = [];
  private readonly tools = new Map<string, ActiveTool>();
  private readonly pendingUi = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly unsubscribe: (() => void)[] = [];
  private ready = false;
  private stopping = false;
  private stopPromise?: Promise<StopReport>;
  private finishPromise?: Promise<DriverExit>;
  private exitResult?: DriverExit;
  private exitInfo = { code: null as number | null, signal: null as string | null };
  private reason = "停止";
  private error?: string;
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
    const allowed = ["get_state", "get_available_models", "get_entries", "get_last_assistant_text", "get_commands", "prompt", "steer", "follow_up", "clear_queue", "abort"];
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
    return { identity: this.identity, reason: this.reason, ...this.exitInfo,
      events: structuredClone(this.events), activeTools, lastCompletedAction: this.lastCompleted,
      possibleSideEffects: activeTools.filter((tool) => !["read", "grep", "find", "ls"].includes(tool.toolName)),
      stderr: this.proc.stderrTail(), stopReport: this.report, error: this.error,
      warnings: this.report?.coverage === "snapshot_visible" ? ["停止仅覆盖快照见过的进程，空残留列表不能证明整棵进程树均已退出"] : [] };
  }
  stop(opts?: StopOptions): Promise<StopReport> {
    if (this.stopPromise) return this.stopPromise;
    try { checkStopOptions(opts); } catch (error) { return Promise.reject(error); }
    this.stopping = true;
    this.interruptedTools = [...this.tools.values()].map((tool) => ({ ...tool }));
    clearTimeout(this.readyTimer); clearInterval(this.heartbeatTimer);
    this.stopPromise = this.performStop(opts);
    return this.stopPromise;
  }
  private async performStop(opts?: StopOptions): Promise<StopReport> {
    try {
      for (const [id, timer] of this.pendingUi) {
        clearTimeout(timer);
        try { this.proc.rpc.respondUi({ id, cancelled: true }); } catch { /* 传输关闭后继续清理进程。 */ }
      }
      this.pendingUi.clear();
      let updateError: unknown;
      try { await this.lock.update({ state: "stopping" }); }
      catch (error) { updateError = error; }
      try { await this.proc.rpc.send({ type: "clear_queue" }, { timeoutMs: 2_000 }); }
      catch (error) { this.receive({ type: "driver_clear_queue_failed", error: String(error) }); }
      this.report = await this.proc.stop(opts ?? this.options.stopOptions);
      await verifyStopped(this.identity, this.report);
      this.exitInfo = await this.proc.exited;
      if (updateError) throw updateError;
      await this.lock.release();
      this.cleanupConfirmed = true;
      return this.report;
    } catch (error) {
      this.error = this.error ? `${this.error}; ${String(error)}` : String(error);
      throw error;
    } finally {
      await this.finish();
    }
  }
  private finish(): Promise<DriverExit> {
    this.finishPromise ??= (async () => {
      const result: DriverExit = { identity: this.identity, ...this.exitInfo, reason: this.reason, cleanupConfirmed: this.cleanupConfirmed, stopReport: this.report, error: this.error };
      const directory = path.join(this.options.home, "sessions", this.spec.agoraSessionId);
      const target = path.join(directory, `${this.spec.runId}.diagnostics.json`);
      try {
        await mkdir(directory, { recursive: true });
        const temporary = `${target}.tmp`;
        await writeFile(temporary, JSON.stringify(this.diagnostics(), null, 2), { mode: 0o600 });
        await rename(temporary, target);
        result.diagnosticsPath = target;
      } catch (error) { result.error = `${result.error ?? ""} 退出诊断写入失败：${String(error)}`.trim(); }
      for (const off of this.unsubscribe) off();
      this.exitResult = result;
      this.resolveExit(result);
      emit(this.exitListeners, result);
      this.exitListeners.clear(); this.listeners.clear();
      return result;
    })();
    return this.finishPromise;
  }
}
