import type { ProtocolRange } from "./client.js";
export * from "./client.js";
export * from "./git.js";

export const VERSION = "0.1.0";
export const EXPLORE_TOOLS = ["read", "grep", "find", "ls"] as const;

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type PermissionProfile = "explore" | "review" | "implement";
export type TaskStatus = "created" | "running" | "waiting_decision" | "waiting_children" | "completed" | "failed" | "stopped" | "interrupted";
export type PrincipalType = "user" | "host:cli" | "host:pane" | "agent:main" | "agent:child";
export type SessionKind = "task" | "meeting-seat" | "secretary";

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
  maxDepth?: number;
  maxChildren?: number | null;
}
export type AgoraTaskParams =
  | ({ action: "spawn" } & SpawnTaskParams)
  | { action: "status"; taskId: string }
  | { action: "result"; taskId: string; generation?: number }
  | { action: "stop"; taskId: string; reason?: string }
  | { action: "list"; status?: TaskStatus[]; scope?: "mine" | "all" }
  | { action: "steer"; taskId: string; message: string; interrupt?: boolean }
  | { action: "cleanup"; taskId: string; discard?: boolean }
  | { action: "recover"; taskId: string; mode: "resume" | "reopen" | "replace" | "abandon"; model?: string; profile?: PermissionProfile };

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

// 工具参数与 HTTP 任务接口共用字段定义。
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
    maxDepth: { type: "integer", minimum: 1 },
    maxChildren: { type: ["integer", "null"], minimum: 0 },
  },
} as const;
export const agoraTaskSchema = {
  type: "object",
  required: ["action"],
  properties: {
    action: { enum: ["spawn", "list", "status", "result", "steer", "stop", "cleanup", "recover"] },
    scope: { enum: ["mine", "all"] }, status: { type: "array", items: { type: "string" } },
    message: { type: "string" }, interrupt: { type: "boolean" }, discard: { type: "boolean" },
    mode: { enum: ["resume", "reopen", "replace", "abandon"] },
    expectedGeneration: { type: "integer", minimum: 1 }, expectedRevision: { type: "integer", minimum: 1 },
    taskId: { type: "string" },
    generation: { type: "integer", minimum: 1 },
    reason: { type: "string" },
    ...spawnTaskSchema.properties,
  },
} as const;
