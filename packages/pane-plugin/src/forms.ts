import type { FormSpec, FormSubmission, FormSubmitResult, PanePlugin, RequestOrigin, FormRemovedReason } from "@pi-pane/plugin-api";
import { encoded, message, type ApiReply, type PluginRuntime } from "./contracts.js";
import { confirmationOf, type Security } from "./security.js";

interface FormRecord { form: FormSpec; kind: string; id: string; object: any }
function ok(reply: ApiReply): boolean { return reply.status >= 200 && reply.status < 300 && reply.status !== 202; }
export function createForms(runtime: PluginRuntime, security: Security) {
  const current = new Map<string, FormRecord>();
  let refresh: Promise<FormSpec[]> | undefined;
  let disposed = false;
  function record(kind: string, id: string, object: any, options: Partial<FormSpec>): FormRecord {
    return { kind, id, object, form: { id: `agora:${kind}:${id}`, source: "agora", revision: object.revision ?? 1,
      title: "待处理事项", createdAt: object.createdAt, ...options } };
  }
  async function pages(path: string): Promise<any[]> {
    const items: any[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const response = await runtime.api.request("GET", `${path}${path.includes("?") ? "&" : "?"}limit=200${cursor ? `&cursor=${encoded(cursor)}` : ""}`);
      if (response.status !== 200 || !Array.isArray(response.body?.items)) throw new Error("无法读取 agora 待处理事项");
      items.push(...response.body.items);
      cursor = response.body.nextCursor || undefined;
      if (cursor && seen.has(cursor)) throw new Error("agora 列表分页游标没有前进");
      if (cursor) seen.add(cursor);
      if (items.length > 100_000) throw new Error("待处理事项超过单次读取限制");
    } while (cursor);
    return items;
  }
  async function load(): Promise<FormSpec[]> {
    if (!runtime.online()) return [...current.values()].map(item => item.form).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    const [requests, confirmations, devices, decisions] = await Promise.all([
      pages("/v1/requests?state=open&state=escalated"), pages("/v1/confirmations"), pages("/v1/devices"), pages("/v1/tasks?scope=mine&status=interrupted"),
    ]);
    const next = new Map<string, FormRecord>();
    const add = (item: FormRecord) => {
      if (typeof item.id !== "string" || !item.id || typeof item.form.createdAt !== "string" || !Number.isFinite(Date.parse(item.form.createdAt)) || !Number.isSafeInteger(item.form.revision) || item.form.revision < 1) throw new Error("agora 待处理事项字段无效");
      next.set(item.form.id, item);
    };
    for (const request of requests) if (request.targetId === "user" && ["open", "escalated"].includes(request.state)) {
      add(record("request", request.id, request, { title: "答复提问", description: request.context ?? undefined,
        questions: request.questions, cancel: { label: "不答复，取消提问" }, expiresAt: request.expiresAt ?? undefined }));
    }
    for (const confirmation of confirmations) if (confirmation.state === "pending") {
      add(record("confirmation", confirmation.confirmationId ?? confirmation.id, confirmation, { title: confirmation.title,
        description: `${confirmation.summary}\n\n发起方：${confirmation.requestedBy ?? "未知"}`, expiresAt: confirmation.expiresAt, cancel: { label: "拒绝" } }));
    }
    for (const device of devices) if (device.state === "pending") {
      add(record("device", device.deviceId, device, { title: "批准设备", description: `设备：${device.label}\n\n公钥指纹：${device.fingerprint}\n\n请求时间：${device.createdAt}`, cancel: { label: "拒绝" } }));
    }
    for (const task of decisions) {
      add(record("decision", task.taskId, task, { title: `处理中断任务：${task.title}`, nodeId: `agora:session:${task.agoraSessionId}`,
        fields: [{ id: "mode", label: "处理方式", type: "select", required: true, options: ["resume", "reopen", "replace", "abandon"] },
          { id: "model", label: "换人时的模型", type: "text" }, { id: "profile", label: "换人时的权限档位", type: "select", options: ["explore", "review", "implement"] }] }));
    }
    if (disposed) return [];
    const removals: { id: string; reason: FormRemovedReason }[] = [];
    for (const [id, previous] of current) if (!next.has(id)) {
      let reason: FormRemovedReason = "handled";
      let object = previous.kind === "request" ? requests.find(item => item.id === previous.id) : previous.kind === "confirmation" ? confirmations.find(item => (item.confirmationId ?? item.id) === previous.id) : undefined;
      if (previous.kind === "request" && !object) {
        const detail = await runtime.api.request("GET", `/v1/requests/${encoded(previous.id)}`);
        if (detail.status === 200) object = detail.body;
        else if (detail.status === 404) reason = "withdrawn";
        else throw new Error("暂时无法核实提问的终态，保留待处理表单");
      }
      if (disposed) return [];
      if (object?.state === "cancelled") reason = "cancelled";
      else if (object?.state === "expired") reason = "expired";
      removals.push({ id, reason });
    }
    if (disposed) return [];
    for (const item of next.values()) {
      const previous = current.get(item.form.id);
      if (!previous || item.form.revision > previous.form.revision) runtime.context.formAdded(item.form);
    }
    for (const { id, reason } of removals) runtime.context.formRemoved(id, reason);
    current.clear(); for (const [id, item] of next) current.set(id, item);
    return [...current.values()].map(item => item.form).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }
  function pending(): Promise<FormSpec[]> {
    if (!refresh) refresh = load().finally(() => { refresh = undefined; });
    return refresh;
  }
  async function mapped(response: ApiReply, req: FormSubmission): Promise<FormSubmitResult> {
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
            if (response.status !== 200) return mapped(response, req);
            if (response.body.state !== "pending") return { status: "alreadyHandled" };
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
