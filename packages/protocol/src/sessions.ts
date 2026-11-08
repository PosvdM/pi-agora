import type { SessionParent, UsageSummary } from "./index.js";

export interface SessionMetadata {
  parent?: SessionParent;
  parentDiagnostics?: { kind: string; message: string }[];
  parentPiSessionId?: string;
  inheritsFrom?: string;
  inheritReason?: string;
  isCurrent?: boolean;
  /** 仅任务且数据库提供接管来源列时返回；普通任务为 false。 */
  takenOver?: boolean;
  usage?: UsageSummary;
}

export interface SessionEntry {
  type: string;
  id: string;
  parentId: string | null;
  [key: string]: unknown;
}

export interface MessageIdentity { role: unknown; timestamp: unknown }
export interface SessionMessageEvidence extends MessageIdentity { entryId: string; message: unknown }

export interface StreamCursor { epoch: string; seq: number }

export type InFlightBlock =
  | { type: "text" | "thinking"; contentIndex: number; text: string; done: boolean }
  | { type: "toolCall"; contentIndex: number; id: string; toolName: string; argsText: string; args?: unknown; done: boolean };

export interface InFlightState {
  phase: "idle" | "streaming" | "tools" | "compacting" | "retrying" | "waitingUi" | "stopping";
  assistant?: { startedAt: number; blocks: InFlightBlock[]; usage?: unknown };
  completed?: unknown[];
  tools: { toolCallId: string; toolName: string; args: unknown; partialResult?: unknown; startedAt: number }[];
  queue: { steering: string[]; followUp: string[] };
  retry?: { attempt: number; maxAttempts: number; delayMs: number; errorMessage: string };
}

export interface UnfinishedPartial { runId: string; at: string; blocks: InFlightBlock[] }
export interface SessionStreamEvent {
  cursor: StreamCursor;
  sessionId: string;
  event: { type: string; [key: string]: unknown };
}

export interface SessionSnapshot {
  cursor: StreamCursor;
  leafId: string | null;
  entries: unknown[];
  historyBefore: string | null;
  inFlight: InFlightState;
  unfinishedPartials: UnfinishedPartial[];
  status: string;
  statusDetail: string | null;
  usage?: UsageSummary;
}
