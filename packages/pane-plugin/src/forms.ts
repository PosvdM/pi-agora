import type { FormSpec, FormSubmission, FormSubmitResult, PanePlugin, RequestOrigin, FormRemovedReason } from "@pi-pane/plugin-api";
import { encoded, message, type ApiReply, type PluginRuntime } from "./contracts.js";
import { confirmationOf, type Security } from "./security.js";
import { createFormCache, displayRecord, MAX_FORM_CACHE_BYTES, MAX_FORM_CACHE_ITEMS, type FormRecord } from "./form-cache.js";

function businessId(kind: string, object: any): unknown {
  return kind === "confirmation" ? object.confirmationId ?? object.id : kind === "device" ? object.deviceId : kind === "decision" ? object.taskId : object.id;
}
const STATES: Record<string, readonly string[]> = {
  request: ["open", "escalated", "answered", "cancelled", "expired"],
  confirmation: ["pending", "executing", "confirmed", "failed", "cancelled", "expired"],
  device: ["pending", "paired", "revoked", "rejected"],
  decision: ["created", "running", "waiting_decision", "waiting_children", "quota_paused", "budget_paused", "completed", "failed", "stopped", "interrupted"],
};
function businessState(kind: string, object: any): string {
  const state = kind === "decision" ? object.status : object.state;
  if (typeof state !== "string" || !STATES[kind]?.includes(state)) throw new Error("无法识别事项状态，无法核实终态，保留待处理表单");
  return state;
}
function removedReason(kind: string, object: any): FormRemovedReason {
  const state = businessState(kind, object);
  if (kind === "request") {
    if (["open", "escalated"].includes(state)) {
      if (object.targetId === "user") throw new Error("事项仍待处理，保留待处理表单");
      return "withdrawn";
    }
    return state === "cancelled" ? "cancelled" : state === "expired" ? "expired" : "handled";
  }
  if (kind === "confirmation") {
    if (["pending", "executing"].includes(state)) throw new Error("事项仍在处理，保留待处理表单");
    return state === "cancelled" ? "cancelled" : state === "expired" ? "expired" : "handled";
  }
  if (kind === "device") {
    if (state === "pending") throw new Error("事项仍待处理，保留待处理表单");
    if (state === "revoked") return "withdrawn";
    if (state === "rejected") return "cancelled";
  }
  if (kind === "decision" && state === "interrupted") throw new Error("事项仍待处理，保留待处理表单");
  return "handled";
}
function ok(reply: ApiReply): boolean { return reply.status >= 200 && reply.status < 300 && reply.status !== 202; }
export function createForms(runtime: PluginRuntime, security: Security) {
  const current = new Map<string, FormRecord>();
  let refresh: Promise<FormSpec[]> | undefined;
  let disposed = false;
  function active() { if (disposed) throw new Error("agora 插件已停用"); }
  const cache = createFormCache(runtime.context.dataDir, active);
  let initial: Promise<void> | undefined;
  function initialize(): Promise<void> {
    if (!initial) initial = cache.load().then(items => {
      active();
      for (const [id, item] of items) current.set(id, item);
    });
    return initial;
  }
  function sorted(): FormSpec[] {
    return structuredClone([...current.values()].map(item => item.form).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)));
  }
  function record(kind: string, id: string, object: any, options: Partial<FormSpec>): FormRecord {
    return displayRecord({ kind, id, form: { id: `agora:${kind}:${id}`, source: "agora", revision: object.revision ?? 1,
      title: "待处理事项", createdAt: object.createdAt, ...options } });
  }
  async function pages(path: string, budget: { items: number; bytes: number; pages: number }): Promise<any[]> {
    const items: any[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      active();
      if (++budget.pages > MAX_FORM_CACHE_ITEMS) throw new Error("待处理事项分页超过读取限制");
      const response = await runtime.api.request("GET", `${path}${path.includes("?") ? "&" : "?"}limit=200${cursor ? `&cursor=${encoded(cursor)}` : ""}`);
      active();
      if (response.status !== 200 || !Array.isArray(response.body?.items)) throw new Error("无法读取 agora 待处理事项");
      budget.items += response.body.items.length;
      if (budget.items > MAX_FORM_CACHE_ITEMS) throw new Error("待处理事项超过单次读取限制");
      for (const item of response.body.items) {
        budget.bytes += Buffer.byteLength(JSON.stringify(item) ?? "null");
        if (budget.bytes > MAX_FORM_CACHE_BYTES) throw new Error("待处理事项超过 8 MiB 读取限制");
        if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("agora 待处理事项字段无效");
        items.push(item);
      }
      if (response.body.nextCursor != null && typeof response.body.nextCursor !== "string") throw new Error("agora 列表分页游标无效");
      cursor = response.body.nextCursor || undefined;
      if (cursor && seen.has(cursor)) throw new Error("agora 列表分页游标没有前进");
      if (cursor) seen.add(cursor);
    } while (cursor);
    return items;
  }
  async function load(): Promise<FormSpec[]> {
    active();
    await initialize();
    active();
    if (!runtime.online()) return sorted();
    const budget = { items: 0, bytes: 0, pages: 0 };
    const requests = await pages("/v1/requests?state=open&state=escalated", budget);
    const confirmations = await pages("/v1/confirmations", budget);
    const devices = await pages("/v1/devices", budget);
    const decisions = await pages("/v1/tasks?scope=mine&status=interrupted", budget);
    for (const [kind, items] of [["request", requests], ["confirmation", confirmations], ["device", devices], ["decision", decisions]] as const) {
      for (const item of items) businessState(kind, item);
    }
    const next = new Map<string, FormRecord>();
    const add = (item: FormRecord) => {
      if (next.has(item.form.id)) throw new Error("agora 待处理事项标识重复");
      next.set(item.form.id, item);
    };
    for (const request of requests) if (request.targetId === "user" && ["open", "escalated"].includes(request.state)) {
      add(record("request", request.id, request, { title: "答复提问", description: request.context ?? undefined,
        questions: request.questions, cancel: { label: "不答复，取消提问" }, expiresAt: request.expiresAt ?? undefined }));
    }
    for (const confirmation of confirmations) if (["pending", "executing"].includes(confirmation.state)) {
      add(record("confirmation", confirmation.confirmationId ?? confirmation.id, confirmation, { title: confirmation.title,
        description: `${confirmation.summary}\n\n发起方：${confirmation.requestedBy ?? "未知"}`, expiresAt: confirmation.expiresAt, cancel: { label: "拒绝" } }));
    }
    for (const device of devices) if (device.state === "pending") {
      add(record("device", device.deviceId, device, { title: "批准设备", description: `设备：${device.label}\n\n公钥指纹：${device.fingerprint}\n\n请求时间：${device.createdAt}`, cancel: { label: "拒绝" } }));
    }
    for (const task of decisions) if (task.status === "interrupted") {
      add(record("decision", task.taskId, task, { title: `处理中断任务：${task.title}`, nodeId: `agora:session:${task.agoraSessionId}`,
        fields: [{ id: "mode", label: "处理方式", type: "select", required: true, options: ["resume", "reopen", "replace", "abandon"] },
          { id: "model", label: "换人时的模型", type: "text" }, { id: "profile", label: "换人时的权限档位", type: "select", options: ["explore", "review", "implement"] }] }));
    }
    active();
    const removals: { id: string; reason: FormRemovedReason }[] = [];
    for (const [id, previous] of current) if (!next.has(id)) {
      let reason: FormRemovedReason = "handled";
      const source = previous.kind === "request" ? requests : previous.kind === "confirmation" ? confirmations : previous.kind === "device" ? devices : decisions;
      let object = source.find(item => businessId(previous.kind, item) === previous.id);
      if (!object) {
        active();
        const endpoint = previous.kind === "request" ? "requests" : previous.kind === "confirmation" ? "confirmations" : previous.kind === "device" ? "devices" : "tasks";
        const detail = await runtime.api.request("GET", `/v1/${endpoint}/${encoded(previous.id)}`);
        active();
        if (detail.status === 200 && detail.body && typeof detail.body === "object" && businessId(previous.kind, detail.body) === previous.id) object = detail.body;
        else if (detail.status === 404) reason = "withdrawn";
        else throw new Error("暂时无法核实事项的终态，保留待处理表单");
      }
      active();
      if (object) reason = removedReason(previous.kind, object);
      removals.push({ id, reason });
    }
    active();
    await cache.save(next.values());
    active();
    for (const item of next.values()) {
      const previous = current.get(item.form.id);
      active();
      if (!previous || item.form.revision > previous.form.revision) runtime.context.formAdded(structuredClone(item.form));
    }
    for (const { id, reason } of removals) { active(); runtime.context.formRemoved(id, reason); }
    current.clear(); for (const [id, item] of next) current.set(id, item);
    return sorted();
  }
  function pending(): Promise<FormSpec[]> {
    if (disposed) return Promise.reject(new Error("agora 插件已停用"));
    if (!refresh) refresh = load().finally(() => { refresh = undefined; });
    return refresh;
  }
  async function mapped(response: ApiReply, req: FormSubmission): Promise<FormSubmitResult> {
    active();
    if (response.status === 202) return { status: "pending", message: "操作等待确认或仍在处理" };
    if (ok(response)) return { status: "accepted" };
    const code = response.body?.error?.code;
    if (code === "idempotency_mismatch") return { status: "idempotencyConflict", message: message(response) };
    if (code === "already_handled") return { status: "alreadyHandled", message: message(response) };
    if (["conflict", "stale", "revision_mismatch"].includes(code)) {
      if (refresh) await refresh;
      const latest = (await pending()).find(form => form.id === req.formId);
      if (latest && latest.revision !== req.revision) return { status: "stale", form: latest };
      if (!latest) return { status: "alreadyHandled", message: "该事项已在其他标签页处理" };
    }
    return { status: "failed", message: message(response) };
  }
  const forms: NonNullable<PanePlugin["forms"]> = {
    pending,
    async submit(req: FormSubmission, origin: RequestOrigin): Promise<FormSubmitResult> {
      if (!runtime.online()) return { status: "failed", message: "agora 未运行，待处理事项仍然保留" };
      if (disposed || !Number.isSafeInteger(req.revision) || req.revision < 1 || !["submitted", "cancelled"].includes(req.outcome?.status)) return { status: "failed", message: "表单提交无效" };
      const match = /^agora:(request|confirmation|device|decision):([^/]+)$/.exec(req.formId);
      if (!match) return { status: "failed", message: "无法识别的 agora 表单" };
      const kind = match[1]!, id = match[2]!, cancelled = req.outcome.status === "cancelled";
      try {
        let result: ApiReply;
        const options = { idempotencyKey: req.idempotencyKey, origin, actAsUser: true };
        if (kind === "request") {
          result = await security.execute("POST", `/v1/requests/${encoded(id)}/${cancelled ? "cancel" : "answer"}`, {
            expectedRevision: req.revision, ...(req.outcome.status === "submitted" ? { answers: req.outcome.values.answers } : {}),
          }, options);
        } else if (kind === "confirmation") {
          if (cancelled) result = await runtime.api.request("POST", `/v1/confirmations/${encoded(id)}/cancel`, {}, { idempotencyKey: req.idempotencyKey });
          else {
            const response = await runtime.api.request("GET", `/v1/confirmations/${encoded(id)}`);
            active();
            if (!runtime.online()) return { status: "failed", message: "agora 未运行，待处理事项仍然保留" };
            if (response.status !== 200) return mapped(response, req);
            const state = businessState("confirmation", response.body);
            if (state === "executing") return { status: "pending", message: "操作已经签名，正在执行" };
            if (state !== "pending") return { status: "alreadyHandled" };
            if ((response.body.revision ?? 1) !== req.revision) {
              const latest = (await pending()).find(form => form.id === req.formId);
              return latest ? { status: "stale", form: latest } : { status: "alreadyHandled" };
            }
            const confirmation = confirmationOf({ confirmation: response.body });
            if (!confirmation) return { status: "failed", message: "待确认内容无效" };
            result = await security.confirm(confirmation, origin);
          }
        } else if (kind === "device") {
          result = await security.execute("POST", `/v1/devices/${encoded(id)}/${cancelled ? "revoke" : "approve"}`, {}, options);
        } else {
          if (req.outcome.status !== "submitted") return { status: "failed", message: "任务处理表单不能取消业务操作" };
          const fields = req.outcome.values.fields ?? {}, mode = fields.mode;
          if (typeof mode !== "string" || !["resume", "reopen", "replace", "abandon"].includes(mode)) return { status: "failed", message: "请选择任务处理方式" };
          if (mode === "replace" && (typeof fields.model !== "string" || !fields.model || typeof fields.profile !== "string" || !["explore", "review", "implement"].includes(fields.profile))) return { status: "failed", message: "换人需要选择模型和权限档位" };
          result = await security.execute("POST", `/v1/tasks/${encoded(id)}/recover`, { mode, expectedRevision: req.revision,
            ...(mode === "replace" ? { model: fields.model, profile: fields.profile } : {}) }, options);
        }
        const resultMapped = await mapped(result, req);
        if (resultMapped.status === "accepted" || resultMapped.status === "alreadyHandled") await pending().catch(() => {});
        return resultMapped;
      } catch { return { status: "pending", message: "暂时无法确定操作结果，请用原请求查询" }; }
    },
  };
  return { forms, refresh: pending, dispose() { disposed = true; } };
}
