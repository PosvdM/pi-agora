export * from "./client.js";

export const VERSION = "0.1.0";
export const PROTOCOL_VERSION = 1;
export const PROTOCOL_RANGE = { min: 1, max: 1 } as const;
export const EXPLORE_TOOLS = ["read", "grep", "find", "ls"] as const;

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type PermissionProfile = "explore" | "review" | "implement";
export type TaskStatus = "created" | "running" | "waiting_decision" | "completed" | "failed" | "stopped" | "interrupted";
export type PrincipalType = "user" | "host:cli" | "host:pane" | "agent:main" | "agent:child";
export type SessionKind = "task" | "meeting-seat" | "secretary";

export interface ProtocolRange { min: number; max: number }
export interface Health {
  daemonVersion: string;
  instanceId: string;
  protocol: ProtocolRange;
}
export interface Discovery extends Health { port: number; pid: number }
export interface ApiErrorBody { error: { code: string; message: string; details?: unknown } }
export interface Page<T> { items: T[]; nextCursor?: string | null }

export interface SpawnTaskParams {
  model: string;
  thinking?: ThinkingLevel;
  profile: PermissionProfile;
  prompt: string;
  title?: string;
  cwd?: string;
  isolation?: "none" | "worktree";
  boardId?: string;
  notify?: "wake" | "silent";
}
export type AgoraTaskParams =
  | ({ action: "spawn" } & SpawnTaskParams)
  | { action: "status"; taskId: string }
  | { action: "result"; taskId: string; generation?: number }
  | { action: "stop"; taskId: string; reason?: string };

export interface TaskSummary {
  taskId: string;
  agoraSessionId: string;
  title: string;
  model: string;
  profile: PermissionProfile;
  status: TaskStatus;
  generation: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
export interface TaskResult {
  taskId: string;
  agoraSessionId: string;
  generation: number;
  status: TaskStatus;
  resultText?: string | null;
  usage?: unknown;
}
export interface Notice {
  noticeId: string;
  dedupeKey: string;
  kind: string;
  taskId?: string;
  generation?: number;
  nodeId?: string;
  payload: Record<string, unknown>;
  createdAt: string;
}
export interface ReadyReport {
  tools: string[];
  model: string;
  thinking: ThinkingLevel;
  extensionVersion: string;
}
export interface InboxAck {
  noticeId: string;
  entryId: string;
  persisted: boolean;
}

// schema 保留完整设计的参数位置，1a 在服务端拒绝尚未提供的档位和隔离方式。
export const spawnTaskSchema = {
  type: "object",
  required: ["model", "profile", "prompt"],
  additionalProperties: false,
  properties: {
    model: { type: "string", minLength: 3 },
    thinking: { enum: ["off", "minimal", "low", "medium", "high", "xhigh", "max"] },
    profile: { enum: ["explore", "review", "implement"] },
    prompt: { type: "string", minLength: 1 },
    title: { type: "string" },
    cwd: { type: "string" },
    isolation: { enum: ["none", "worktree"] },
    boardId: { type: "string" },
    notify: { enum: ["wake", "silent"] },
  },
} as const;
export const agoraTaskSchema = {
  type: "object",
  required: ["action"],
  properties: {
    action: { enum: ["spawn", "status", "result", "stop"] },
    taskId: { type: "string" },
    generation: { type: "integer", minimum: 1 },
    reason: { type: "string" },
    ...spawnTaskSchema.properties,
  },
} as const;

export function negotiateProtocol(remote: ProtocolRange, local: ProtocolRange = PROTOCOL_RANGE): number {
  const min = Math.max(local.min, remote.min);
  const max = Math.min(local.max, remote.max);
  if (!Number.isInteger(min) || !Number.isInteger(max) || min > max) {
    throw new Error("协议版本不兼容，请运行 agora shutdown 后启动兼容版本");
  }
  return max;
}
