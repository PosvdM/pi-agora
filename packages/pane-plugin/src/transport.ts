import { connectHost, type AgoraClient } from "@pi-agora/protocol";
import type { AgoraApi, ApiEvent, ApiOptions, ApiReply } from "./contracts.js";

const MAX_BODY = 8 * 1024 * 1024;
const MAX_EVENT = 4 * 1024 * 1024;
function target(client: AgoraClient, relative: string): URL {
  if (!relative.startsWith("/v1/") || relative.includes("\\") || relative.includes("#")) throw new Error("agora 请求路径无效");
  const url = new URL(relative, client.url);
  if (url.origin !== client.url || !url.pathname.startsWith("/v1/")) throw new Error("agora 请求路径无效");
  return url;
}
async function boundedText(response: Response): Promise<string> {
  if (!response.body) throw new Error("agora 返回了空响应");
  const reader = response.body.getReader();
  let size = 0;
  const parts: Uint8Array[] = [];
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > MAX_BODY) throw new Error("agora 响应超过大小限制");
      parts.push(part.value);
    }
    return Buffer.concat(parts).toString("utf8");
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export function createDaemonApi(client: AgoraClient, fetcher: typeof fetch = fetch): AgoraApi {
  const closing = new AbortController();
  const streams = new Set<AbortController>();
  const refresh = setInterval(() => { void client.refresh().catch(() => {}); }, 30 * 60_000);
  refresh.unref();
  const headers = () => ({ Authorization: `Bearer ${client.token}`, "Agora-Protocol": "1" });
  return {
    async request<T>(method: string, relative: string, body?: unknown, options: ApiOptions = {}): Promise<ApiReply<T>> {
      const url = target(client, relative);
      const signal = AbortSignal.any([closing.signal, AbortSignal.timeout(options.timeoutMs ?? 35_000), ...(options.signal ? [options.signal] : [])]);
      const verb = method.toUpperCase();
      const requestHeaders = { ...headers(), ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(options.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : {}), ...(options.actAsUser ? { "Agora-Act-As": "user" } : {}) };
      const payload = body === undefined ? undefined : JSON.stringify(body);
      for (let attempt = 0; ; attempt++) {
        try {
          const response = await fetcher(url, { method: verb, headers: requestHeaders, body: payload, signal, redirect: "error" });
          const data = JSON.parse(await boundedText(response));
          return { status: response.status, body: data as T };
        } catch (error) {
          // 同一请求只使用同一个身份和幂等键；HTTP 拒绝不进入重试。
          if (attempt >= 1 || signal.aborted || !(verb === "GET" || options.idempotencyKey)) throw error;
        }
      }
    },
    subscribe(relative: string, emit: (event: ApiEvent) => void, failed: (error: unknown) => void): () => void {
      const url = target(client, relative);
      const controller = new AbortController();
      streams.add(controller);
      const signal = AbortSignal.any([controller.signal, closing.signal]);
      void (async () => {
        const response = await fetcher(url, { headers: { ...headers(), Accept: "text/event-stream" }, signal, redirect: "error" });
        if (!response.ok || !response.headers.get("content-type")?.startsWith("text/event-stream") || !response.body) throw new Error(`agora 事件流不可用（${response.status}）`);
        const reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8", { fatal: true });
        let buffer = "", type = "message", data: string[] = [], bytes = 0;
        const line = (value: string) => {
          if (value === "") {
            if (data.length && !signal.aborted) emit({ type, data: JSON.parse(data.join("\n")) });
            type = "message"; data = []; bytes = 0;
          } else if (value.startsWith("event:")) type = value.slice(6).trimStart();
          else if (value.startsWith("data:")) {
            const content = value.slice(5).replace(/^ /, "");
            bytes += content.length;
            if (bytes > MAX_EVENT) throw new Error("agora 事件超过大小限制");
            data.push(content);
          }
        };
        try {
          for (;;) {
            const part = await reader.read();
            if (part.done) throw new Error("agora 事件流已断开");
            buffer += decoder.decode(part.value, { stream: true });
            if (buffer.length > MAX_EVENT) throw new Error("agora 事件行超过大小限制");
            let index: number;
            while ((index = buffer.indexOf("\n")) >= 0) {
              line(buffer.slice(0, index).replace(/\r$/, ""));
              buffer = buffer.slice(index + 1);
            }
          }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      })().catch(error => { if (!signal.aborted) failed(error); }).finally(() => streams.delete(controller));
      return () => { controller.abort(); streams.delete(controller); };
    },
    close() { clearInterval(refresh); closing.abort(); for (const controller of streams) controller.abort(); streams.clear(); client.close(); },
  };
}
export async function connectDaemonApi(home?: string, signal?: AbortSignal): Promise<AgoraApi> {
  return createDaemonApi(await connectHost({ home, as: "host:pane", autoStart: false, signal }));
}
