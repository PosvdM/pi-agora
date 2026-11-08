import type { SessionEntry, Page, PermissionProfile, SessionKind, SessionParent, UsageSummary } from "@pi-agora/protocol";

export type { SessionEntry, Page, SessionParent };
export type ArchiveState = "ok" | "partial" | "suspect" | "missing";

export interface ArchivedSessionSummary {
  agoraSessionId: string;
  kind: SessionKind;
  title: string;
  model: string;
  profile: PermissionProfile;
  convenerId: string;
  parent?: SessionParent;
  parentDiagnostics?: { kind: string; message: string }[];
  parentPiSessionId?: string;
  taskId?: string;
  meetingId?: string;
  status: string;
  archiveState: ArchiveState;
  messageCount?: number;
  inheritsFrom?: string;
  inheritReason?: string;
  isCurrent?: boolean;
  usage?: UsageSummary;
  createdAt: string;
  endedAt?: string;
}

export interface ArchivedSession extends ArchivedSessionSummary {
  sessionFile: string;
  piSessionId?: string;
  thinking: string;
  cwd: string;
  availability: "available" | "missing";
}

export interface PartialFragment {
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
  [key: string]: unknown;
}

export interface RunDiagnostics {
  runId: string;
  [key: string]: unknown;
}

export interface SessionQuery {
  convenerId?: string;
  meetingId?: string;
  taskId?: string;
  limit?: number;
  cursor?: string;
}

export interface ArchiveReaderV1 {
  readonly apiVersion: 1;
  readonly schemaVersion: number;
  listSessions(q?: SessionQuery): Promise<Page<ArchivedSessionSummary>>;
  getSession(id: string): Promise<ArchivedSession | undefined>;
  readUserView(id: string, q?: { before?: string; limit?: number }): Promise<{
    leafId: string | null; entries: SessionEntry[]; historyBefore: string | null;
  }>;
  readRawEntries(id: string, q?: { cursor?: string; limit?: number }): Promise<Page<SessionEntry>>;
  readPartials(id: string): Promise<PartialFragment[]>;
  readDiagnostics(id: string): Promise<RunDiagnostics[]>;
  verifySession(id: string): Promise<VerificationResult>;
  listBoardEntries(boardId: string, q?: { afterSeq?: number; limit?: number }): Promise<Page<never>>;
  getMeeting(meetingId: string): Promise<never>;
  close(): void;
}

export interface VerifyExpected {
  messageEndCount?: number;
  lastMessage?: { role: string; timestamp: unknown };
  previous?: { hash: string; bytes: number };
  hasUnfinishedPartials?: boolean;
}

export interface VerificationResult {
  state: "ok" | "partial" | "suspect" | "missing";
  hash: string | null;
  bytes: number;
  messageCount: number;
  diagnostics: unknown[];
}
