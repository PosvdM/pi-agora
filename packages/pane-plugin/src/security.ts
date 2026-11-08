import type { RequestOrigin, UserPresenceProof } from "@pi-pane/plugin-api";
import { encoded, type ApiReply, type PluginRuntime } from "./contracts.js";

export type ExecuteOperation = (method: string, path: string, body: unknown, options: {
  idempotencyKey: string; origin: RequestOrigin; actAsUser?: boolean;
}) => Promise<ApiReply>;
export interface Confirmation {
  id: string; challenge: Record<string, unknown>; title: string; summary: string;
  expiresAt?: string;
}
export function confirmationOf(body: any): Confirmation | undefined {
  const value = body?.confirmation ?? body?.operation?.confirmation;
  const id = value?.id ?? value?.confirmationId;
  if (typeof id !== "string" || !id || typeof value?.title !== "string" || typeof value?.summary !== "string" ||
      !value.challenge || typeof value.challenge !== "object" || Array.isArray(value.challenge)) return undefined;
  return { id, title: value.title, summary: value.summary, challenge: value.challenge, expiresAt: value.expiresAt };
}
export interface SecurityAlert {
  alertId: string; kind: string; revision: number; details?: unknown; createdAt?: string;
  state?: string; acknowledgedAt?: string | null;
}
const failure = (code: string, message: string, status = 409): ApiReply => ({ status, body: { error: { code, message } } });
export function createSecurity(runtime: PluginRuntime, options: { waitMs?: number } = {}) {
  let disposed = false;
  const pending = new Map<string, Promise<ApiReply>>();
  const alerts = new Map<string, SecurityAlert>();
  const waitMs = options.waitMs ?? 8_000;
  function active() { if (disposed) throw new Error("agora 插件已停用"); }
  async function sign(confirmation: Confirmation, origin: RequestOrigin, expectedDeviceId?: string): Promise<ApiReply> {
    active();
    const existing = pending.get(confirmation.id);
    if (existing) return existing;
    const operation = (async (): Promise<ApiReply> => {
      try {
        const proof: UserPresenceProof = await runtime.context.userPresence.confirm({ title: confirmation.title, summary: confirmation.summary,
          payload: confirmation.challenge, origin, timeoutMs: 120_000 });
        active();
        if (expectedDeviceId && proof.deviceId !== expectedDeviceId) return failure("device_mismatch", "请在正在配对的设备上确认", 403);
        return await runtime.api.request("POST", `/v1/confirmations/${encoded(confirmation.id)}/sign`, proof);
      } catch (error) {
        if (disposed) return { status: 202, body: { confirmation, state: "pending" } };
        if ((error as { code?: string })?.code === "rejected") {
          const cancelled = await runtime.api.request("POST", `/v1/confirmations/${encoded(confirmation.id)}/cancel`, {});
          if (cancelled.status >= 200 && cancelled.status < 300) return failure("confirmation_cancelled", "用户已拒绝此次操作");
          return cancelled;
        }
        // 超时、设备缺席和传输失败都没有授权；后台待确认仍由 daemon 裁定。
        return { status: 202, body: { confirmation, state: "pending" } };
      }
    })();
    pending.set(confirmation.id, operation);
    void operation.then(result => {
      if (!disposed && result.status !== 202) runtime.context.notify({ id: `agora:confirmation:${confirmation.id}:result`, source: "agora",
        level: result.status < 300 ? "info" : "warning", title: result.status < 300 ? "用户操作已完成" : "用户操作未执行",
        body: confirmation.title });
    }).catch(error => { if (!disposed) runtime.context.log.warn("用户确认结果尚未确定", error instanceof Error ? error.name : "unknown"); })
      .finally(() => { if (pending.get(confirmation.id) === operation) pending.delete(confirmation.id); });
    return operation;
  }
  async function confirm(confirmation: Confirmation, origin: RequestOrigin, expectedDeviceId?: string): Promise<ApiReply> {
    const work = sign(confirmation, origin, expectedDeviceId);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([work, new Promise<ApiReply>(resolve => { timer = setTimeout(() => resolve({ status: 202, body: { confirmation, state: "pending" } }), waitMs); timer.unref(); })]);
    } finally { if (timer) clearTimeout(timer); }
  }
  const execute: ExecuteOperation = async (method, path, body, request) => {
    active();
    const response = await runtime.api.request(method, path, body, { idempotencyKey: request.idempotencyKey, actAsUser: request.actAsUser });
    const confirmation = response.status === 202 ? confirmationOf(response.body) : undefined;
    return confirmation ? confirm(confirmation, request.origin) : response;
  };
  async function refreshAlerts(): Promise<void> {
    active();
    const response = await runtime.api.request("GET", "/v1/security/alerts");
    if (response.status !== 200 || !Array.isArray(response.body?.items)) throw new Error("无法核实 agora 安全警告");
    const items: SecurityAlert[] = response.body.items;
    if (items.some(item => !item || typeof item.alertId !== "string" || typeof item.kind !== "string" || !Number.isSafeInteger(item.revision) || item.revision < 1)) throw new Error("agora 安全警告响应无效");
    active();
    const activeIds = new Set<string>();
    const next = new Map<string, SecurityAlert>();
    for (const alert of items) {
      const bannerId = `agora:security:${alert.kind}`;
      if (alert.acknowledgedAt || ["acknowledged", "cleared", "resolved"].includes(alert.state ?? "")) continue;
      next.set(alert.alertId, alert); activeIds.add(bannerId);
      runtime.context.setBanner({ id: bannerId, persistent: true, level: "error",
        title: alert.kind === "protection-off" ? "用户确认已关闭，无法区分你和 Agent 的操作" : alert.kind === "devices-reset" ? "设备记录已被重置或修改" : "安全状态需要核实",
        body: `检测时间：${alert.createdAt ?? "未知"}\n\n警告版本：${alert.revision}\n\n${JSON.stringify(alert.details ?? {})}`,
        actions: alert.kind === "devices-reset" ? ["agora.security.acknowledge"] : [] });
    }
    for (const banner of runtime.context.listBanners()) {
      if (banner.id.startsWith("agora:security:") && !activeIds.has(banner.id)) runtime.context.clearBanner(banner.id);
    }
    alerts.clear(); for (const [id, value] of next) alerts.set(id, value);
  }
  async function pair(origin: RequestOrigin, key: string, requestedDeviceId = origin.deviceId): Promise<ApiReply> {
    active();
    if (!requestedDeviceId || origin.deviceId !== requestedDeviceId) return failure("device_unknown", "请在需要配对的浏览器中发起操作", 400);
    const device = runtime.context.userPresence.devices().find(item => item.deviceId === requestedDeviceId && item.connected);
    if (!device) return failure("device_unknown", "当前浏览器设备尚未连接", 400);
    const response = await runtime.api.request("POST", "/v1/devices/pair", { deviceId: device.deviceId, publicKey: device.publicKey, label: device.label }, { idempotencyKey: key });
    const confirmation = response.status === 202 ? confirmationOf(response.body) : undefined;
    return confirmation ? confirm(confirmation, origin, device.deviceId) : response;
  }
  return {
    execute, confirm, refreshAlerts, pair,
    displayedAlert(): SecurityAlert | undefined { return [...alerts.values()].find(alert => alert.kind === "devices-reset"); },
    acknowledge: (alertId: string, revision: number, key: string, origin: RequestOrigin) => execute("POST", `/v1/security/alerts/${encoded(alertId)}/acknowledge`, { revision }, { idempotencyKey: key, origin, actAsUser: true }),
    dispose() { disposed = true; alerts.clear(); },
  };
}
export type Security = ReturnType<typeof createSecurity>;
