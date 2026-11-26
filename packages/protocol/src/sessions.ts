import type { Page, SessionKind, SessionParent, UsageSummary } from "./index.js";

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
  /** 会话行修订号，与 SessionSummary.revision 相同，可直接用作存档删除的 expectedRevision。 */
  revision: number;
  usage?: UsageSummary;
}

/** `GET /v1/sessions` 的列表项，也是 `GET /v1/sessions/:id` 的详情。 */
export interface SessionSummary extends SessionMetadata {
  agoraSessionId: string;
  taskId: string;
  piSessionId: string | null;
  kind: SessionKind;
  title: string;
  status: string;
  statusDetail: string | null;
  /** 会话行修订号：存档删除的 expectedRevision、签名挑战和 agora_status 事件使用它。 */
  revision: number;
  /** 变更流口径的树修订号，pane 插件据此换算 TreeNode.revision。 */
  treeRevision: number;
  parentId: string | null;
  hasChildren: boolean;
  childCount: number;
  createdAt: string;
  lastActivityAt: string;
  endedAt?: string;
  profile: string;
  model: string;
  thinking: string;
  cwd: string;
  archiveState: string;
  archiveHash: string | null;
  archiveBytes: number;
  archiveVerifiedAt: string | null;
  archiveError: string | null;
  treeUsage?: UsageSummary;
  originToolCall?: { sessionRef: { source: string; id: string }; toolCallId: string };
}

export interface SessionsPage extends Page<SessionSummary> {
  changesCursor: StreamCursor;
}
