import type { SessionEntry } from "@pi-agora/harness-pi";

export interface ArchiveFragment {
  runId: string;
  t: string;
  messageSeq: number;
  contentIndex: number;
  blockType: "thinking" | "text" | "toolCall";
  delta: string;
  toolCallId?: string;
  toolName?: string;
  messageRole?: string;
  messageTimestamp?: unknown;
}
export interface OpenMessage {
  messageSeq: number;
  message: Record<string, unknown>;
  ended: boolean;
  fragments: ArchiveFragment[];
}
export type PartialRow = ArchiveFragment | {
  runId: string; t: string; messageSeq: number; ended: true; message: Record<string, unknown>;
} | { runId: string; t: string; messageSeq: number; closed: true; entryId: string };
export type ArchiveChange =
  | { type: "message_start"; messageSeq: number; message: Record<string, unknown> }
  | { type: "fragment"; fragment: ArchiveFragment }
  | { type: "message_end"; messageSeq: number; message: Record<string, unknown> }
  | { type: "tool"; event: Record<string, unknown> };

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).filter(key => object[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${stable(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** 完整消息逐字段比较，避免把同角色、同时间戳的不同回复误判为已落盘。 */
export function sameMessage(a: unknown, b: unknown): boolean { return stable(a) === stable(b); }

/** RPC 格式验证集中在 pi 适配层，不能用空数组掩盖失败或格式不兼容。 */
export function entriesFromResponse(response: unknown): { entries: SessionEntry[]; leafId: string | null } {
  const value = record(response), data = record(value.data);
  if (value.success !== true || !Array.isArray(data.entries) ||
      !(data.leafId === null || typeof data.leafId === "string") ||
      data.entries.some(entry => {
        const item = record(entry);
        return typeof item.type !== "string" || typeof item.id !== "string" || !(item.parentId === null || typeof item.parentId === "string");
      })) throw new Error("get_entries 未返回有效的会话条目与叶子");
  return structuredClone({ entries: data.entries as SessionEntry[], leafId: data.leafId as string | null });
}

/** 同步捕获事件；异步刷新只按消息序号移除精确匹配的消息，不能重置整个流状态。 */
export class PiArchiveEvents {
  private sequence = 0;
  private current?: OpenMessage;
  readonly messages = new Map<number, OpenMessage>();
  messageEndCount = 0;
  lastMessage?: { role: string; timestamp: unknown };
  constructor(private readonly runId: string) {}

  receive(input: unknown): { changes: ArchiveChange[]; rows: PartialRow[]; refresh: boolean } {
    const event = record(input), changes: ArchiveChange[] = [], rows: PartialRow[] = [];
    const t = new Date().toISOString();
    const start = (message: Record<string, unknown>): OpenMessage => {
      const item: OpenMessage = { messageSeq: ++this.sequence, message: structuredClone(message), ended: false, fragments: [] };
      this.current = item;
      this.messages.set(item.messageSeq, item);
      changes.push({ type: "message_start", messageSeq: item.messageSeq, message: structuredClone(message) });
      return item;
    };
    if (event.type === "message_start") start(record(event.message));
    if (event.type === "message_update") {
      const update = record(event.assistantMessageEvent);
      const message = record(event.message ?? update.partial);
      const item = this.current && !this.current.ended ? this.current : start(message);
      if (Object.keys(message).length) item.message = structuredClone(message);
      const kind = typeof update.type === "string" ? update.type : "";
      const match = /^(thinking|text|toolcall)_(start|delta)$/.exec(kind);
      if (match && Number.isSafeInteger(update.contentIndex) && Number(update.contentIndex) >= 0) {
        const contentIndex = Number(update.contentIndex);
        const block = record(Array.isArray(message.content) ? message.content[contentIndex] : undefined);
        const fragment: ArchiveFragment = {
          runId: this.runId, t, messageSeq: item.messageSeq, contentIndex,
          blockType: match[1] === "toolcall" ? "toolCall" : match[1] as "thinking" | "text",
          delta: match[2] === "delta" && typeof update.delta === "string" ? update.delta : "",
          ...(typeof block.id === "string" ? { toolCallId: block.id } : {}),
          ...(typeof block.name === "string" ? { toolName: block.name } : {}),
          ...(typeof item.message.role === "string" ? { messageRole: item.message.role } : {}),
          ...(item.message.timestamp !== undefined ? { messageTimestamp: structuredClone(item.message.timestamp) } : {}),
        };
        item.fragments.push(fragment);
        rows.push(fragment);
        changes.push({ type: "fragment", fragment });
      }
    }
    if (event.type === "message_end") {
      const message = record(event.message);
      const item = this.current && !this.current.ended ? this.current : start(message);
      item.message = structuredClone(message);
      item.ended = true;
      this.current = undefined;
      this.messageEndCount++;
      if (typeof message.role === "string") this.lastMessage = { role: message.role, timestamp: structuredClone(message.timestamp) };
      rows.push({ runId: this.runId, t, messageSeq: item.messageSeq, ended: true, message: structuredClone(message) });
      changes.push({ type: "message_end", messageSeq: item.messageSeq, message: structuredClone(message) });
    }
    if (typeof event.type === "string" && event.type.startsWith("tool_execution_")) {
      changes.push({ type: "tool", event: structuredClone(event) });
    }
    return { changes, rows, refresh: event.type === "message_end" || event.type === "agent_settled" };
  }

  close(messageSeq: number): void { this.messages.delete(messageSeq); }
  inFlight(entries: SessionEntry[]): OpenMessage[] {
    return structuredClone([...this.messages.values()].filter(item =>
      !item.ended || !entries.some(entry => entry.type === "message" && sameMessage(entry.message, item.message))));
  }
  unfinished(entries: SessionEntry[]): ArchiveFragment[] {
    return structuredClone([...this.messages.values()].filter(item =>
      !item.ended || !entries.some(entry => entry.type === "message" && sameMessage(entry.message, item.message)))
      .flatMap(item => item.fragments));
  }
}
