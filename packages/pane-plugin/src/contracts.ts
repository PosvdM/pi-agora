import type { PaneHostContext } from "@pi-pane/plugin-api";

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
export interface SessionItem {
  agoraSessionId: string;
  taskId?: string | null;
  kind?: string;
  parentId: string | null;
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
export function encoded(value: string): string { return encodeURIComponent(value); }
export function message(reply: ApiReply): string {
  return typeof reply.body?.error?.message === "string" ? reply.body.error.message : "agora 操作未完成，请重新读取状态";
}
