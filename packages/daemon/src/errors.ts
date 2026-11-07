export class AgoraError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown) {
    super(message);
  }
}

export function invalid(message = "请求参数无效"): never {
  throw new AgoraError(400, "invalid_params", message);
}

export function text(value: unknown, name: string, max = 8192): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) invalid(`${name} 必须是非空字符串，且不超过 ${max} 字符`);
  return value;
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

export function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value !== undefined && typeof value !== "boolean") invalid(`${name} 必须是布尔值`);
  return value as boolean | undefined;
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().map(key => `${JSON.stringify(key)}:${stableJson(obj[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
