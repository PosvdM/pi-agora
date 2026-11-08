import type { PaneHostContext } from "@pi-pane/plugin-api";
import type { SessionMetadata, SessionParent } from "@pi-agora/protocol";
export type { SessionParent } from "@pi-agora/protocol";

export interface ApiReply<T = any> { status: number; body: T }
export interface ApiOptions {
  idempotencyKey?: string;
  actAsUser?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
}
export interface ApiEvent { type: string; data: any }
export interface AgoraApi {
  request<T = any>(method: string, path: string, body?: unknown, options?: ApiOptions): Promise<ApiReply<T>>;
  subscribe(path: string, emit: (event: ApiEvent) => void, failed: (error: unknown) => void): () => void;
  close(): void;
}
export interface PluginRuntime {
  api: AgoraApi;
  context: PaneHostContext;
  online(): boolean;
}
export function parentNodeId(item: { parent?: SessionParent; parentId?: string | null }): string | null {
  if (item.parent?.kind === "task") return `agora:session:${item.parent.sessionId}`;
  if (item.parent?.kind === "main") return `pane:session:${item.parent.piSessionId}`;
  if (item.parent?.kind === "user") return "agora:root:user-tasks";
  return item.parentId ?? null;
}
export interface SessionItem extends SessionMetadata {
  agoraSessionId: string;
  taskId?: string | null;
  kind?: string;
  isCurrent?: boolean;
  takenOver?: boolean;
  parentId: string | null;
  parent?: SessionParent;
  title: string;
  status: string;
  revision: number;
  createdAt: string;
  lastActivityAt?: string;
  statusDetail?: string | null;
  hasChildren: boolean;
  childCount?: number;
  archiveState?: string;
  model?: string;
  profile?: string;
  thinking?: string;
  cwd?: string;
  piSessionId?: string | null;
  originToolCall?: { sessionRef: { source: string; id: string }; toolCallId: string };
}
export interface ChangeCursor { epoch: string; seq: number }
export interface SessionsPage {
  items: SessionItem[];
  nextCursor?: string | null;
  changesCursor: ChangeCursor;
}
export function userTask(item: { parent?: SessionParent; parentId?: string | null }): boolean {
  return parentNodeId(item) === "agora:root:user-tasks";
}
export function statusDetail(item: { takenOver?: boolean; statusDetail?: string | null }): string | undefined {
  return [item.takenOver ? "已由用户接管" : undefined, item.statusDetail || undefined].filter(Boolean).join("；") || undefined;
}
export function encoded(value: string): string { return encodeURIComponent(value); }
export function message(reply: ApiReply): string {
  return typeof reply.body?.error?.message === "string" ? reply.body.error.message : "agora 操作未完成，请重新读取状态";
}
