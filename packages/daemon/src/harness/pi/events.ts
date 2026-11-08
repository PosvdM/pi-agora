import type { RpcEvent } from "pi-hostkit";
import type { HarnessDerivedEvent, QuotaExhaustedEvent } from "../types.js";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}
function resetTime(value: unknown, relative: boolean, nowMs: number): string | null {
  let ms: number;
  if (typeof value === "number" || (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value))) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric < 0) return null;
    ms = relative && numeric < 1_000_000_000 ? nowMs + numeric * 1000 : numeric < 100_000_000_000 ? numeric * 1000 : numeric;
  } else if (typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/i.test(value)) {
    ms = Date.parse(value);
  } else return null;
  return Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? new Date(ms).toISOString() : null;
}
function quotaEvent(message: Record<string, unknown>, nowMs: number): QuotaExhaustedEvent | undefined {
  if (message.stopReason !== "error") return undefined;
  const objects: Record<string, unknown>[] = [];
  const texts: string[] = [];
  const visit = (value: unknown, depth = 0): void => {
    if (depth > 8) return;
    if (typeof value === "string") {
      texts.push(value);
      const start = value.indexOf("{");
      const end = value.lastIndexOf("}");
      if (start >= 0 && end > start) {
        try { visit(JSON.parse(value.slice(start, end + 1)), depth + 1); } catch { /* 非 JSON 错误继续按文字识别。 */ }
      }
    } else if (value !== null && typeof value === "object") {
      const object = record(value);
      objects.push(object);
      for (const nested of Object.values(value)) visit(nested, depth + 1);
    }
  };
  visit(message.errorMessage);
  visit(message.error);
  const text = texts.join("\n");
  const reason = text.match(/\b(usage_limit_reached|quota_exceeded|insufficient_quota)\b/i)?.[1].toLowerCase();
  const has429 = [message, ...objects].some((object) =>
    [object.status, object.statusCode, object.httpStatusCode, object.status_code].some((status) => status === 429 || status === "429")) ||
    /(?:^\s*(?:Error:\s*)?429\b|\bHTTP(?:\/\d(?:\.\d)?)?\s+429\b|\bstatus(?:[ _-]?code)?\s*[:=]?\s*429\b|\(429\))/im.test(text);
  if (!reason || !has429) return undefined;
  let resumeAt: string | null = null;
  for (const object of objects) {
    for (const key of ["resets_at", "reset_at", "resetAt", "retry_after"]) {
      resumeAt = resetTime(object[key], key === "retry_after", nowMs);
      if (resumeAt !== null) break;
    }
    if (resumeAt !== null) break;
  }
  if (resumeAt === null) {
    const reset = text.match(/\b(resets?[ _-]?(?:at)?|retry[ _-]?after)\s*(?:[:=]|\bis\b|\bon\b)?\s*["']?(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)|\d{10,13})\b/i);
    if (reset) resumeAt = resetTime(reset[2], false, nowMs);
  }
  return { type: "quota_exhausted", resumeAt, reason };
}

/** 返回派生事件；调用方须按运行去重，并先于原 message_end 派发。 */
export function normalizePiEvent(event: RpcEvent, requestId: string, nowMs: number): HarnessDerivedEvent[] {
  const message = record(event.message);
  if (event.type !== "message_end" || message.role !== "assistant") return [];
  const usage = record(message.usage);
  const inputTokens = tokenCount(usage.input);
  const cacheReadTokens = tokenCount(usage.cacheRead);
  const cacheWriteTokens = tokenCount(usage.cacheWrite);
  const events: HarnessDerivedEvent[] = [{ type: "usage_record",
    requestId: typeof message.id === "string" && message.id ? message.id : requestId,
    inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens: tokenCount(usage.output),
    reasoningTokens: tokenCount(usage.reasoning), contextTokens: inputTokens + cacheReadTokens + cacheWriteTokens }];
  const quota = quotaEvent(message, nowMs);
  if (quota) events.push(quota);
  return events;
}

