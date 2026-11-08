import { createHash } from "node:crypto";
import type { ActionInvocation, ActionResult, ActionSpec, ActionTarget, FormField, FormSpec, PanePlugin, RequestOrigin } from "@pi-pane/plugin-api";
import { encoded, message, type ApiReply, type PluginRuntime } from "./contracts.js";

export type ExecuteOperation = (method: string, path: string, body: unknown, options: {
  idempotencyKey: string; origin: RequestOrigin; actAsUser?: boolean;
}) => Promise<ApiReply>;

type TaskAction = "spawn" | "steer" | "stop" | "cleanup" | "recover";
type JsonRecord = Record<string, unknown>;
interface TaskState {
  taskId: string; status: string; generation: number; revision: number;
  model?: string; profile?: string; cwd?: string;
}
interface TargetState { nodeId?: string; task?: TaskState }
interface FormRecord {
  form: FormSpec; action: TaskAction; target: string; state: TargetState; replace: boolean;
}
interface Operation { path: string; body: JsonRecord; actAsUser?: boolean }
interface Identity {
  fingerprint: string; expiresAt: number; operation?: Operation;
  preparing?: Promise<Operation | ActionResult>;
}
const DAY = 24 * 60 * 60 * 1000;
const profiles = ["explore", "review", "implement"];
const thinking = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const active = ["created", "running", "waiting_decision", "waiting_children"];
const catalog: ActionSpec[] = [
  { id: "agora.task.spawn", source: "agora", title: "创建任务", scope: ["global", "node"], hasForm: true },
  { id: "agora.task.steer", source: "agora", title: "发送返工指令", scope: ["node"], hasForm: true },
  { id: "agora.task.stop", source: "agora", title: "停止任务", scope: ["node"], confirm: "确定停止此任务及其下级任务？", danger: true },
  { id: "agora.task.cleanup", source: "agora", title: "清理工作树", scope: ["node"], hasForm: true, danger: true },
  { id: "agora.task.recover", source: "agora", title: "恢复任务", scope: ["node"], hasForm: true, timeoutMs: 60000 },
];
class Invalid extends Error {}
class ReadReply extends Error { constructor(readonly reply: ApiReply) { super(message(reply)); } }
function object(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Invalid(`${label}必须是对象`);
  return value as JsonRecord;
}
function keys(value: JsonRecord, allowed: string[], label: string): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Invalid(`${label}包含不支持的字段`);
}
function text(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Invalid(`${label}必须是非空文本，最多 ${max} 个字符`);
  return value;
}
function enumValue(value: unknown, allowed: string[], label: string): string {
  if (typeof value !== "string" || !allowed.includes(value)) throw new Invalid(`${label}的选项无效`);
  return value;
}
function model(value: unknown): string {
  const result = text(value, "模型", 512);
  if (!/^[^/\s]+\/[^\s]+$/.test(result)) throw new Invalid("模型必须使用完整的 provider/id");
  return result;
}
function bool(value: unknown, label: string): boolean {
  if (value !== "true" && value !== "false") throw new Invalid(`${label}必须为 true 或 false`);
  return value === "true";
}
function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Invalid(`${label}无效，请重新读取任务`);
  return value as number;
}
// 完整调用参与身份计算，避免未知字段或表单标识被 HTTP 映射丢弃。
function canonical(value: unknown, seen = new Set<object>()): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return Object.is(value, -0) ? "-0" : String(value);
  if (typeof value !== "object" || value === null || seen.has(value)) throw new Invalid("调用内容必须是无循环引用的 JSON 数据");
  seen.add(value);
  let result: string;
  if (Array.isArray(value)) {
    if (Array.from({ length: value.length }, (_, index) => index).some(index => !Object.hasOwn(value, index))) throw new Invalid("调用内容不接受稀疏数组");
    result = `[${value.map(item => canonical(item, seen)).join(",")}]`;
  }
  else {
    const record = object(value, "调用内容");
    result = `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key], seen)}`).join(",")}}`;
  }
  seen.delete(value);
  return result;
}
function hash(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }
function actionName(id: unknown): TaskAction {
  if (typeof id !== "string" || !catalog.some(item => item.id === id)) throw new Invalid("不支持此动作");
  return id.slice("agora.task.".length) as TaskAction;
}
function targetKey(target: ActionTarget | undefined, action: TaskAction): string {
  if (target === undefined) {
    if (action === "spawn") return "global";
    throw new Invalid("此动作需要任务节点");
  }
  const value = object(target, "目标");
  if (value.type === "global") {
    keys(value, ["type"], "目标");
    if (action === "spawn") return "global";
    throw new Invalid("此动作需要任务节点");
  }
  keys(value, ["type", "nodeId"], "目标");
  if (value.type !== "node" || typeof value.nodeId !== "string" || !/^agora:session:as_[A-Za-z0-9_-]+$/.test(value.nodeId)) throw new Invalid("目标必须是合法的 agora 任务会话节点");
  return value.nodeId;
}
function modes(task: TaskState): string[] {
  return task.status === "quota_paused" ? ["resume"] : task.status === "interrupted" ? ["resume", "reopen", "replace", "abandon"] : [];
}
function allowed(action: TaskAction, task?: TaskState): boolean {
  if (action === "spawn") return true;
  if (!task) return false;
  if (action === "recover") return modes(task).length > 0;
  if (action === "steer") return [...active.filter(status => status !== "created"), "completed", "failed"].includes(task.status);
  if (action === "cleanup") return ["completed", "failed", "stopped", "interrupted"].includes(task.status);
  return [...active, "quota_paused", "interrupted", "completed", "failed", "stopped"].includes(task.status);
}
function outcome(reply: ApiReply, action: TaskAction): ActionResult {
  if (reply.status === 202 || reply.status >= 500) return { status: "pending", message: "操作尚未结束，请使用同一请求标识查询" };
  if (reply.status === 409 && reply.body?.error?.code === "idempotency_mismatch") return { status: "idempotencyConflict", message: message(reply) };
  if (reply.status >= 200 && reply.status < 300) {
    const session = reply.body?.agoraSessionId;
    return { status: "ok", ...(action === "spawn" && typeof session === "string" && /^as_[A-Za-z0-9_-]+$/.test(session) ? { openNodeId: `agora:session:${session}` } : {}) };
  }
  return { status: "failed", message: message(reply) };
}

export function createActions(runtime: PluginRuntime, execute: ExecuteOperation): NonNullable<PanePlugin["actions"]> {
  // 此守卫只保留身份与固定请求参数，不保存 daemon 的执行结果；进程重启后需统一持久化身份模块接管。
  const identities = new Map<string, Identity>();
  const forms = new Map<string, { signature: string; record: FormRecord; expiresAt: number }>();
  const versions = new Map<string, FormRecord>();
  function prune(): void {
    const now = Date.now();
    for (const [key, item] of identities) if (item.expiresAt <= now) identities.delete(key);
    for (const [key, item] of forms) if (item.expiresAt <= now) {
      forms.delete(key);
      for (const version of versions.keys()) if (version.startsWith(`${key}:`)) versions.delete(version);
    }
  }
  async function get(path: string): Promise<JsonRecord> {
    const reply = await runtime.api.request("GET", path);
    if (reply.status < 200 || reply.status >= 300 || reply.status === 202) throw new ReadReply(reply);
    return object(reply.body, "任务状态");
  }
  async function readTarget(key: string): Promise<TargetState> {
    if (key === "global") return {};
    const id = key.slice("agora:session:".length);
    const session = await get(`/sessions/${encoded(id)}`);
    if (session.kind !== undefined && session.kind !== "task") throw new Invalid("此会话不属于任务");
    const taskId = text(session.taskId, "任务标识", 256);
    if (!/^tk_[A-Za-z0-9_-]+$/.test(taskId)) throw new Invalid("会话未关联合法任务");
    const task = await get(`/tasks/${encoded(taskId)}`);
    if (task.taskId !== taskId) throw new Invalid("任务状态与目标不匹配");
    return { nodeId: key, task: {
      taskId, status: text(task.status, "任务状态", 64),
      generation: integer(task.generation, "任务代数"), revision: integer(task.revision, "任务修订号"),
      ...(typeof task.model === "string" ? { model: task.model } : {}),
      ...(typeof task.profile === "string" ? { profile: task.profile } : {}),
      ...(typeof task.cwd === "string" ? { cwd: task.cwd } : {}),
    } };
  }
  function formFor(action: TaskAction, target: string, state: TargetState, replace = false): FormRecord {
    const id = `agora.action.${action}.${hash(target).slice(0, 24)}${replace ? ".replace" : ""}`;
    const signature = hash({ action, target, state, replace });
    const old = forms.get(id);
    if (old?.signature === signature) return old.record;
    let fields: FormField[];
    if (replace) fields = [
      { id: "model", label: "替换模型（provider/id）", type: "text", required: true, default: state.task?.model },
      { id: "profile", label: "权限档位", type: "select", options: profiles, required: true, default: state.task?.profile },
    ];
    else if (action === "spawn") fields = [
      { id: "model", label: "模型（provider/id）", type: "text", required: true },
      { id: "profile", label: "权限档位", type: "select", options: profiles, required: true, default: "explore" },
      { id: "thinking", label: "推理级别", type: "select", options: thinking, default: "high" },
      { id: "isolation", label: "隔离方式", type: "select", options: ["none", "worktree"], default: "none" },
      { id: "cwd", label: "工作目录", type: "text", default: state.task?.cwd },
      { id: "title", label: "任务标题", type: "text" },
      { id: "prompt", label: "任务书", type: "textarea", required: true },
    ];
    else if (action === "steer") fields = [
      { id: "message", label: "返工指令", type: "textarea", required: true },
      { id: "interrupt", label: "中断当前执行", type: "checkbox", default: "false" },
    ];
    else if (action === "cleanup") fields = [{ id: "discard", label: "丢弃未提交的工作树修改", type: "checkbox", default: "false" }];
    else fields = [{ id: "mode", label: "恢复方式", description: "resume：继续恢复；reopen：重开会话；replace：替换模型和档位；abandon：放弃任务。", type: "select", options: modes(state.task!), required: true }];
    const form: FormSpec = {
      id, source: "agora", revision: (old?.record.form.revision ?? 0) + 1,
      title: replace ? "替换任务执行者" : catalog.find(item => item.id === `agora.task.${action}`)!.title,
      createdAt: old?.record.form.createdAt ?? new Date().toISOString(),
      fields, submitLabel: "提交", ...(state.nodeId ? { nodeId: state.nodeId } : {}),
    };
    const record = { form, action, target, state: structuredClone(state), replace };
    forms.set(id, { signature, record, expiresAt: Date.now() + DAY });
    versions.set(`${id}:${form.revision}`, record);
    return record;
  }
  async function resolve(action: TaskAction, target: string): Promise<FormSpec | null> {
    const state = await readTarget(target);
    if (!allowed(action, state.task) || action === "stop") return null;
    return structuredClone(formFor(action, target, state).form);
  }
  function inputFields(inv: ActionInvocation, names: string[]): JsonRecord {
    const input = object(inv.input, "表单输入");
    keys(input, ["answers", "fields"], "表单输入");
    if (!Array.isArray(input.answers) || input.answers.length !== 0) throw new Invalid("此表单不接受选择题答案");
    const fields = input.fields === undefined ? {} : object(input.fields, "表单字段");
    keys(fields, names, "表单字段");
    return fields;
  }
  function conditions(state: TargetState): JsonRecord {
    return state.task ? { expectedGeneration: state.task.generation, expectedRevision: state.task.revision } : {};
  }
  async function prepare(inv: ActionInvocation, action: TaskAction): Promise<Operation | ActionResult> {
    const target = targetKey(inv.target, action);
    if (action === "stop") {
      if (inv.formId !== undefined || inv.formRevision !== undefined || inv.input !== undefined) throw new Invalid("停止任务不接受表单输入");
      const state = await readTarget(target);
      if (!allowed(action, state.task)) throw new Invalid("任务当前状态不允许停止");
      return { path: `/tasks/${encoded(state.task!.taskId)}/stop`, body: conditions(state) };
    }
    if (inv.input === undefined) {
      if (inv.formId !== undefined || inv.formRevision !== undefined) throw new Invalid("表单输入缺失");
      const form = await resolve(action, target);
      if (!form) throw new Invalid("任务当前状态不允许此动作");
      return { status: "needsInput", followUpForm: form };
    }
    if (typeof inv.formId !== "string" || !Number.isSafeInteger(inv.formRevision)) throw new Invalid("请先读取动作表单");
    const record = versions.get(`${inv.formId}:${inv.formRevision}`);
    if (!record || record.action !== action || record.target !== target) throw new Invalid("表单无效或已过期，请重新读取");
    const state = await readTarget(target);
    if (hash(state) !== hash(record.state)) throw new Invalid("任务状态已变化，请重新读取表单");
    if (!allowed(action, state.task)) throw new Invalid("任务当前状态不允许此动作");
    let body: JsonRecord;
    if (action === "spawn") {
      const fields = inputFields(inv, ["model", "profile", "thinking", "isolation", "prompt", "title", "cwd"]);
      body = { model: model(fields.model), profile: enumValue(fields.profile, profiles, "权限档位"), prompt: text(fields.prompt, "任务书", 1_000_000) };
      if (fields.thinking !== undefined) body.thinking = enumValue(fields.thinking, thinking, "推理级别");
      if (fields.isolation !== undefined) body.isolation = enumValue(fields.isolation, ["none", "worktree"], "隔离方式");
      if (fields.title !== undefined && fields.title !== "") body.title = text(fields.title, "任务标题", 200);
      if (fields.cwd !== undefined && fields.cwd !== "") body.cwd = text(fields.cwd, "工作目录", 32768);
      return { path: "/tasks", body };
    }
    if (action === "steer") {
      const fields = inputFields(inv, ["message", "interrupt"]);
      body = { message: text(fields.message, "返工指令", 1_000_000), interrupt: fields.interrupt === undefined ? false : bool(fields.interrupt, "中断选项") };
    } else if (action === "cleanup") {
      const fields = inputFields(inv, ["discard"]);
      body = { discard: fields.discard === undefined ? false : bool(fields.discard, "丢弃选项") };
    } else if (record.replace) {
      const fields = inputFields(inv, ["model", "profile"]);
      body = { mode: "replace", model: model(fields.model), profile: enumValue(fields.profile, profiles, "权限档位") };
    } else {
      const fields = inputFields(inv, ["mode"]);
      const mode = enumValue(fields.mode, modes(state.task!), "恢复方式");
      if (mode === "replace") return { status: "needsInput", followUpForm: structuredClone(formFor(action, target, state, true).form) };
      body = { mode };
    }
    return { path: `/tasks/${encoded(state.task!.taskId)}/${action}`, body: { ...body, ...conditions(state) }, ...(action === "recover" ? { actAsUser: true } : {}) };
  }
  return {
    list: () => structuredClone(catalog),
    async resolveForm(actionId, target) {
      prune();
      try {
        const action = actionName(actionId);
        if (!runtime.online()) return null;
        return await resolve(action, targetKey(target, action));
      } catch { return null; }
    },
    async invoke(inv, origin) {
      prune();
      let action: TaskAction;
      let entry: Identity;
      let idempotencyKey: string;
      try {
        object(inv, "动作调用");
        idempotencyKey = text(inv.idempotencyKey, "请求标识", 1024);
        const fingerprint = hash(inv);
        const old = identities.get(idempotencyKey);
        if (old && old.fingerprint !== fingerprint) return { status: "idempotencyConflict", message: "同一请求标识不能用于不同的动作调用" };
        entry = old ?? { fingerprint, expiresAt: Date.now() + DAY };
        identities.set(idempotencyKey, entry);
        keys(inv as unknown as JsonRecord, ["actionId", "target", "input", "formId", "formRevision", "idempotencyKey"], "动作调用");
        action = actionName(inv.actionId);
        if (!runtime.online()) return { status: "pending", message: "agora 尚未连接，请使用同一请求标识重试" };
        if (!entry.operation) {
          // 参数快照只生成一次；重试不重新注入更新后的任务修订号。
          entry.preparing ??= prepare(structuredClone(inv), action);
          let prepared: Operation | ActionResult;
          try { prepared = await entry.preparing; } finally { entry.preparing = undefined; }
          if ("status" in prepared) return prepared;
          entry.operation = structuredClone(prepared);
        }
      } catch (error) {
        if (error instanceof Invalid) return { status: "failed", message: error.message };
        if (error instanceof ReadReply) return outcome(error.reply, "stop");
        return { status: "pending", message: "网络结果未知，请使用同一请求标识重试" };
      }
      try {
        const operation = entry.operation!;
        return outcome(await execute("POST", operation.path, structuredClone(operation.body), {
          idempotencyKey, origin, ...(operation.actAsUser ? { actAsUser: true } : {}),
        }), action);
      } catch {
        return { status: "pending", message: "网络结果未知，请使用同一请求标识查询，避免重复操作" };
      }
    },
  };
}
