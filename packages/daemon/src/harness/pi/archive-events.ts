import type { SessionEntry } from "@pi-agora/harness-pi";
import type { InFlightBlock, InFlightState } from "@pi-agora/protocol";

export interface ArchiveFragment {
  runId: string;
  t: string;
  messageSeq: number;
  contentIndex: number;
  blockType: "thinking" | "text" | "toolCall";
  delta: string;
  toolCallId?: string;
  toolName?: string;
  replace?: boolean;
  done?: boolean;
  args?: unknown;
  messageRole?: string;
  messageTimestamp?: unknown;
  [key: string]: unknown;
}
export interface OpenMessage {
  messageSeq: number;
  message: Record<string, unknown>;
  ended: boolean;
  fragments: ArchiveFragment[];
  startedAt: number;
  blocks: InFlightBlock[];
  usage?: unknown;
}
export type PartialRow = ArchiveFragment | {
  runId: string; t: string; messageSeq: number; ended: true; message: Record<string, unknown>;
} | { runId: string; t: string; messageSeq: number; closed: true; entryId: string };

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

/** 同步捕获原始事件；异步刷新只能移除精确匹配的最终消息。 */
export class PiArchiveEvents {
  private sequence = 0;
  private current?: OpenMessage;
  private phase: InFlightState["phase"] = "idle";
  private tools: InFlightState["tools"] = [];
  private queue: InFlightState["queue"] = { steering: [], followUp: [] };
  private retry?: InFlightState["retry"];
  readonly messages = new Map<number, OpenMessage>();
  messageEndCount = 0;
  lastMessage?: { role: string; timestamp: unknown };
  constructor(private readonly runId: string) {}

  receive(input: unknown): { rows: PartialRow[]; refresh: boolean } {
    const event = record(input), rows: PartialRow[] = [];
    const t = new Date().toISOString();
    const start = (message: Record<string, unknown>): OpenMessage => {
      const item: OpenMessage = { messageSeq: ++this.sequence, message: structuredClone(message), ended: false,
        fragments: [], startedAt: Date.now(), blocks: [] };
      this.current = item;
      this.messages.set(item.messageSeq, item);
      if (message.role === "assistant") this.phase = "streaming";
      return item;
    };
    const fragment = (item: OpenMessage, block: InFlightBlock, delta: string, replace = false): void => {
      const row: ArchiveFragment = {
        runId: this.runId, t, messageSeq: item.messageSeq, contentIndex: block.contentIndex,
        blockType: block.type, delta,
        ...(replace ? { replace: true } : {}), done: block.done,
        ...(block.type === "toolCall" ? { toolCallId: block.id, toolName: block.toolName,
          ...(block.args !== undefined ? { args: structuredClone(block.args) } : {}) } : {}),
        ...(typeof item.message.role === "string" ? { messageRole: item.message.role } : {}),
        ...(item.message.timestamp !== undefined ? { messageTimestamp: structuredClone(item.message.timestamp) } : {}),
      };
      item.fragments.push(row); rows.push(row);
    };
    if (event.type === "message_start") start(record(event.message));
    if (event.type === "message_update") {
      const update = record(event.assistantMessageEvent);
      const item = this.current && !this.current.ended && this.current.message.role === "assistant"
        ? this.current : start({ role: "assistant", content: [] });
      if (event.usage !== undefined) item.usage = structuredClone(event.usage);
      const kind = typeof update.type === "string" ? update.type : "";
      const match = /^(thinking|text|toolcall)_(start|delta|end)$/.exec(kind);
      if (match && Number.isSafeInteger(update.contentIndex) && Number(update.contentIndex) >= 0) {
        const contentIndex = Number(update.contentIndex);
        const type = match[1] === "toolcall" ? "toolCall" : match[1] as "thinking" | "text";
        let block = item.blocks.find(value => value.contentIndex === contentIndex);
        if (!block || block.type !== type || match[2] === "start") {
          block = type === "toolCall" ? { type, contentIndex, id: "", toolName: "", argsText: "", done: false }
            : { type, contentIndex, text: "", done: false };
          item.blocks = item.blocks.filter(value => value.contentIndex !== contentIndex);
          item.blocks.push(block);
        }
        const delta = match[2] === "delta" && typeof update.delta === "string" ? update.delta : "";
        if (block.type === "toolCall") {
          if (typeof update.id === "string") block.id = update.id;
          if (typeof update.toolName === "string") block.toolName = update.toolName;
          block.argsText += delta;
          if (match[2] === "end") {
            const tool = record(update.toolCall);
            if (typeof tool.id === "string") block.id = tool.id;
            if (typeof tool.name === "string") block.toolName = tool.name;
            block.args = structuredClone(tool.arguments);
            block.argsText = JSON.stringify(tool.arguments) ?? "";
          }
        } else {
          block.text += delta;
          if (match[2] === "end" && typeof update.content === "string") block.text = update.content;
        }
        block.done = match[2] === "end";
        fragment(item, block, block.done ? block.type === "toolCall" ? block.argsText : block.text : delta,
          block.done || match[2] === "start");
        item.blocks.sort((a, b) => a.contentIndex - b.contentIndex);
      }
    }
    if (event.type === "message_end") {
      const message = record(event.message);
      const item = this.current && !this.current.ended ? this.current : start(message);
      item.message = structuredClone(message);
      if (message.role === "assistant") {
        item.blocks = [];
        if (Array.isArray(message.content)) message.content.forEach((value, contentIndex) => {
          const content = record(value);
          let block: InFlightBlock;
          if (content.type === "toolCall") block = { type: "toolCall", contentIndex,
            id: typeof content.id === "string" ? content.id : "", toolName: typeof content.name === "string" ? content.name : "",
            argsText: JSON.stringify(content.arguments) ?? "", args: structuredClone(content.arguments), done: true };
          else if (content.type === "text" || content.type === "thinking") block = { type: content.type, contentIndex,
            text: String(content.type === "text" ? content.text ?? "" : content.thinking ?? ""), done: true };
          else return;
          item.blocks.push(block);
          fragment(item, block, block.type === "toolCall" ? block.argsText : block.text, true);
        });
        if (message.usage !== undefined) item.usage = structuredClone(message.usage);
      }
      item.ended = true;
      this.current = undefined;
      this.messageEndCount++;
      if (typeof message.role === "string") this.lastMessage = { role: message.role, timestamp: structuredClone(message.timestamp) };
      rows.push({ runId: this.runId, t, messageSeq: item.messageSeq, ended: true, message: structuredClone(message) });
    }
    if (event.type === "tool_execution_start" || event.type === "tool_execution_update") {
      if (typeof event.toolCallId === "string") {
        let tool = this.tools.find(value => value.toolCallId === event.toolCallId);
        if (!tool) {
          tool = { toolCallId: event.toolCallId, toolName: String(event.toolName ?? ""), args: structuredClone(event.args), startedAt: Date.now() };
          this.tools.push(tool);
        }
        if (event.args !== undefined) tool.args = structuredClone(event.args);
        if (typeof event.toolName === "string") tool.toolName = event.toolName;
        if (event.partialResult !== undefined) tool.partialResult = structuredClone(event.partialResult);
      }
      this.phase = "tools";
    }
    if (event.type === "tool_execution_end") {
      this.tools = this.tools.filter(value => value.toolCallId !== event.toolCallId);
      if (!this.tools.length) this.phase = "streaming";
    }
    if (event.type === "queue_update") this.queue = {
      steering: Array.isArray(event.steering) ? event.steering.filter((v): v is string => typeof v === "string") : [],
      followUp: Array.isArray(event.followUp) ? event.followUp.filter((v): v is string => typeof v === "string") : [],
    };
    if (event.type === "agent_start" || event.type === "turn_start") this.phase = "streaming";
    if (event.type === "compaction_start") this.phase = "compacting";
    if (event.type === "compaction_end") this.phase = event.willRetry ? "retrying" : "streaming";
    if (event.type === "auto_retry_start" || event.type === "summarization_retry_scheduled") {
      this.phase = "retrying";
      this.retry = { attempt: Number(event.attempt), maxAttempts: Number(event.maxAttempts),
        delayMs: Number(event.delayMs), errorMessage: String(event.errorMessage ?? "") };
    }
    if (event.type === "auto_retry_end" || event.type === "summarization_retry_finished") {
      this.retry = undefined; this.phase = this.tools.length ? "tools" : "streaming";
    }
    if (event.type === "summarization_retry_attempt_start") this.phase = "retrying";
    if (event.type === "agent_settled") {
      this.phase = "idle"; this.tools = []; this.queue = { steering: [], followUp: [] }; this.retry = undefined;
      this.current = undefined;
    }
    return { rows, refresh: ["message_end", "agent_settled", "entry_appended", "turn_end", "compaction_end"].includes(String(event.type)) };
  }

  get activePhase(): InFlightState["phase"] { return this.phase; }
  close(messageSeq: number): void { this.messages.delete(messageSeq); }
  inFlight(entries: SessionEntry[], running = true): InFlightState {
    if (!running) return { phase: "idle", tools: [], queue: { steering: [], followUp: [] } };
    const completed = [...this.messages.values()].filter(item => item.ended &&
      !entries.some(entry => entry.type === "message" && sameMessage(entry.message, item.message))).map(item => item.message);
    const assistant = this.current?.message.role === "assistant" && !this.current.ended ? this.current : undefined;
    return structuredClone({ phase: this.phase, tools: this.tools, queue: this.queue,
      ...(assistant ? { assistant: { startedAt: assistant.startedAt, blocks: assistant.blocks,
        ...(assistant.usage !== undefined ? { usage: assistant.usage } : {}) } } : {}),
      ...(completed.length ? { completed } : {}), ...(this.retry ? { retry: this.retry } : {}),
    });
  }
  unfinished(entries: SessionEntry[], orphanedOnly = false): ArchiveFragment[] {
    return structuredClone([...this.messages.values()].filter(item =>
      (!orphanedOnly || item !== this.current && !item.ended) &&
      (!item.ended || !entries.some(entry => entry.type === "message" && sameMessage(entry.message, item.message))))
      .flatMap(item => item.fragments));
  }
}
