import { createHash, randomUUID } from "node:crypto";
import { setImmediate as yieldTurn } from "node:timers/promises";
import type { NodeStatus, PanePlugin, SessionRef, SessionSnapshot, TreeNode } from "@pi-pane/plugin-api";

/** Structural boundary until the archive adapter's v1 types are available. */
export interface ArchivedSessionSummary {
  agoraSessionId: string;
  kind: "task" | "meeting-seat" | "secretary";
  title: string;
  model: string;
  profile: "explore" | "review" | "implement";
  convenerId: string;
  parentPiSessionId?: string;
  taskId?: string;
  meetingId?: string;
  status: string;
  archiveState: "ok" | "partial" | "suspect" | "missing";
  messageCount?: number;
  inheritsFrom?: string;
  createdAt: string;
  endedAt?: string;
  /** Enhanced adapter metadata: a pane node ID, not a pi session ID. */
  parentId?: string | null;
  lastActivityAt?: string;
  statusDetail?: string;
}

export interface ArchiveReader {
  listSessions(q?: { convenerId?: string; meetingId?: string; taskId?: string; limit?: number; cursor?: string }):
    Promise<{ items: ArchivedSessionSummary[]; nextCursor?: string }>;
  getSession(id: string): Promise<ArchivedSessionSummary | undefined>;
  readUserView(id: string, q?: { before?: string; limit?: number }):
    Promise<{ leafId: string | null; entries: unknown[]; historyBefore: string | null }>;
  readPartials(id: string): Promise<NonNullable<SessionSnapshot["unfinishedPartials"]>>;
  close(): void;
}

export const OFFLINE_LIMITS = Object.freeze({ sessions: 4096, scanPages: 64, scanPageSize: 128, pageSize: 200 });

export interface OfflineViews {
  tree: NonNullable<PanePlugin["tree"]>;
  sessions: NonNullable<PanePlugin["sessions"]>;
  panels?: PanePlugin["panels"];
  dispose(): void;
}

const SESSION = "agora:session:";
const MEETING = "agora:meeting:";
const USER_TASKS = "agora:root:user-tasks";
const USER_MEETINGS = "agora:root:user-meetings";
const statuses: Record<string, NodeStatus> = {
  idle: "idle", created: "waiting", running: "running", waiting: "waiting", paused: "paused",
  waiting_decision: "waiting", waiting_children: "waiting", quota_paused: "paused",
  completed: "done", done: "done", failed: "failed", stopped: "stopped", interrupted: "interrupted",
  convening: "waiting", queued: "waiting", sealed: "running", critique: "running", merging: "running",
  reviewing: "running", minuting: "running", ended: "done",
};

function status(value: string): NodeStatus {
  const result = Object.hasOwn(statuses, value) ? statuses[value] : undefined;
  if (!result) throw new Error(`Unsupported archived session status: ${value}`);
  return result;
}

function pageLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > OFFLINE_LIMITS.pageSize) {
    throw new Error(`Offline page limit must be between 1 and ${OFFLINE_LIMITS.pageSize}`);
  }
  return limit;
}

function copyNode(node: TreeNode): TreeNode {
  return { ...node, capabilities: [...node.capabilities], ...(node.sessionRef ? { sessionRef: { ...node.sessionRef } } : {}) };
}

interface Index {
  nodes: Map<string, TreeNode>;
  children: Map<string | null, TreeNode[]>;
  revision: number;
}

/** Owns a single reader and a bounded, immutable metadata cut for this offline epoch. */
export function createOfflineViews(reader: ArchiveReader, epoch = `offline:${randomUUID()}`): OfflineViews {
  const abort = new AbortController();
  let pendingIndex: Promise<Index> | undefined;

  function check(): void {
    if (abort.signal.aborted) throw new DOMException("Offline archive reader was disposed", "AbortError");
  }

  function run<T>(work: () => Promise<T>): Promise<T> {
    check();
    return new Promise<T>((resolve, reject) => {
      const cancelled = () => reject(new DOMException("Offline archive reader was disposed", "AbortError"));
      abort.signal.addEventListener("abort", cancelled, { once: true });
      Promise.resolve().then(() => { check(); return work(); }).then(resolve, reject).finally(() => {
        abort.signal.removeEventListener("abort", cancelled);
      });
    });
  }

  async function pause(): Promise<void> {
    await yieldTurn();
    check();
  }

  async function buildIndex(): Promise<Index> {
    const summaries = new Map<string, ArchivedSessionSummary>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; ; page++) {
      check();
      if (page >= OFFLINE_LIMITS.scanPages) throw new Error(`Offline metadata scan exceeds ${OFFLINE_LIMITS.scanPages} pages`);
      await pause();
      const result = await run(() => reader.listSessions({ limit: OFFLINE_LIMITS.scanPageSize, ...(cursor ? { cursor } : {}) }));
      if (result.items.length > OFFLINE_LIMITS.scanPageSize) throw new Error("Archive adapter exceeded the requested metadata page size");
      for (const item of result.items) {
        if (summaries.has(item.agoraSessionId)) throw new Error(`Duplicate archived session metadata: ${item.agoraSessionId}`);
        summaries.set(item.agoraSessionId, { ...item });
      }
      if (summaries.size > OFFLINE_LIMITS.sessions) throw new Error(`Offline metadata scan exceeds ${OFFLINE_LIMITS.sessions} sessions`);
      if (!result.nextCursor) break;
      if (cursors.has(result.nextCursor)) throw new Error("Archive adapter returned a repeated metadata cursor");
      cursors.add(result.nextCursor);
      cursor = result.nextCursor;
    }

    const nodes = new Map<string, TreeNode>();
    function group(id: string, title: string, parentId: string | null, sortKey: string, badge?: string): void {
      const previous = nodes.get(id);
      if (previous) {
        if (previous.parentId !== parentId) throw new Error(`Conflicting archived group parent: ${id}`);
        if (sortKey < previous.sortKey) previous.sortKey = sortKey;
        return;
      }
      nodes.set(id, { id, source: "agora", kind: "group", parentId, title, badge, status: "idle",
        availability: "archived", hasChildren: false, sortKey, revision: 0, capabilities: [] });
    }

    let processed = 0;
    for (const summary of summaries.values()) {
      if (processed++ % 64 === 0) await pause();
      let item = summary;
      // parentPiSessionId also appears on nested tasks; it cannot identify their direct parent.
      if (item.parentId === undefined && item.convenerId !== "user") {
        const detail = await run(() => reader.getSession(item.agoraSessionId));
        if (detail) {
          if (detail.agoraSessionId !== item.agoraSessionId) throw new Error("Archive adapter returned a mismatched session ID");
          item = { ...item, parentId: detail.parentId };
        }
      }
      let parentId = item.parentId ?? null;
      if (item.kind === "task") {
        if (item.parentId === undefined && item.convenerId === "user") parentId = USER_TASKS;
        if (parentId === USER_TASKS) group(USER_TASKS, "用户任务", null, "");
      } else if (item.meetingId) {
        const meetingId = `${MEETING}${item.meetingId}`;
        // A seat's parentId names the meeting, not the meeting's convener.
        const meetingParent = item.convenerId === "user" ? USER_MEETINGS : null;
        group(meetingId, `会议 ${item.meetingId}`, meetingParent, item.createdAt, "会议");
        if (meetingParent === USER_MEETINGS) group(USER_MEETINGS, "用户会议", null, "");
        parentId = meetingId;
      }
      const id = `${SESSION}${item.agoraSessionId}`;
      nodes.set(id, { id, source: "agora", kind: "session", parentId, title: item.title,
        badge: item.kind === "task" ? "子代理" : item.kind === "secretary" ? "书记" : "参会",
        sessionRef: { source: "agora", id: item.agoraSessionId }, status: status(item.status),
        statusDetail: item.statusDetail, availability: item.archiveState === "missing" ? "missing" : "archived",
        hasChildren: false, lastActivityAt: item.lastActivityAt ?? item.endedAt ?? item.createdAt,
        messageCount: item.messageCount,
        sortKey: item.kind === "task" ? item.createdAt : `${item.kind === "secretary" ? "1" : "0"}:${item.createdAt}`,
        revision: 0, capabilities: ["open"] });
    }

    const children = new Map<string | null, TreeNode[]>();
    processed = 0;
    for (const node of nodes.values()) {
      if (processed++ % 64 === 0) await pause();
      const siblings = children.get(node.parentId) ?? [];
      siblings.push(node);
      children.set(node.parentId, siblings);
    }
    const compare = (a: TreeNode, b: TreeNode) => a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    for (const siblings of children.values()) {
      await pause();
      siblings.sort(compare);
    }
    const hash = createHash("sha256");
    // Sorting and hashing operate only on the explicitly bounded metadata cut, never archive entries.
    const ordered = [...nodes.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    processed = 0;
    for (const node of ordered) {
      if (processed++ % 64 === 0) await pause();
      node.childCount = children.get(node.id)?.length ?? 0;
      node.hasChildren = node.childCount > 0;
      hash.update(JSON.stringify(node));
      hash.update("\n");
    }
    const revision = Number.parseInt(hash.digest("hex").slice(0, 12), 16);
    processed = 0;
    for (const node of nodes.values()) {
      if (processed++ % 64 === 0) await pause();
      node.revision = revision;
    }
    return { nodes, children, revision };
  }

  function index(): Promise<Index> {
    check();
    if (!pendingIndex) {
      pendingIndex = buildIndex().catch(error => { pendingIndex = undefined; throw error; });
    }
    return pendingIndex;
  }

  function validateRef(ref: SessionRef): void {
    if (ref.source !== "agora" || !ref.id) throw new Error("Offline sessions require an agora session reference");
  }

  async function session(ref: SessionRef): Promise<ArchivedSessionSummary> {
    validateRef(ref);
    const item = await run(() => reader.getSession(ref.id));
    if (!item) throw new Error(`Archived session metadata is unavailable: ${ref.id}`);
    if (item.agoraSessionId !== ref.id) throw new Error("Archive adapter returned a mismatched session ID");
    if (item.archiveState === "missing") throw new Error(`Archived session file is missing: ${ref.id}`);
    return item;
  }

  return {
    tree: {
      snapshot: req => run(async () => {
        if (req.openNodeIds.length > OFFLINE_LIMITS.sessions) throw new Error("Too many open nodes for an offline snapshot");
        const recentSince = Date.parse(req.recentSince);
        if (!Number.isFinite(recentSince)) throw new Error("Invalid offline snapshot recentSince");
        const data = await index();
        const selected = new Set<string>();
        const open = new Set(req.openNodeIds);
        let processed = 0;
        for (const node of data.nodes.values()) {
          if (processed++ % 64 === 0) await pause();
          const hot = open.has(node.id) || ["running", "waiting", "paused"].includes(node.status)
            || (node.lastActivityAt !== undefined && Date.parse(node.lastActivityAt) > recentSince);
          if (!hot) continue;
          let current: TreeNode | undefined = node;
          while (current && !selected.has(current.id)) {
            if (selected.size % 64 === 0) await pause();
            selected.add(current.id);
            current = current.parentId ? data.nodes.get(current.parentId) : undefined;
          }
        }
        return { source: "agora", epoch, revision: data.revision,
          nodes: [...selected].map(id => copyNode(data.nodes.get(id)!)) };
      }),
      children: (parentId, page) => run(async () => {
        if (page.epoch !== epoch) return { reset: true, epoch };
        const limit = pageLimit(page.limit);
        const data = await index();
        const siblings = data.children.get(parentId) ?? [];
        let offset = 0;
        if (page.cursor !== undefined) {
          try {
            if (typeof page.cursor !== "string" || page.cursor.length > 4096) throw new Error();
            const cursor = JSON.parse(Buffer.from(page.cursor, "base64url").toString("utf8"));
            if (cursor.epoch !== epoch) return { reset: true, epoch };
            if (cursor.parentId !== parentId || cursor.revision !== data.revision || !Number.isSafeInteger(cursor.offset)
              || cursor.offset < 0 || cursor.offset > siblings.length) throw new Error();
            offset = cursor.offset;
          } catch {
            throw new Error("Invalid offline children cursor");
          }
        }
        const next = offset + limit;
        return { epoch, revision: data.revision, nodes: siblings.slice(offset, next).map(copyNode),
          ...(next < siblings.length ? { nextCursor: Buffer.from(JSON.stringify({ epoch, revision: data.revision, parentId, offset: next })).toString("base64url") } : {}) };
      }),
      subscribe: () => { check(); return () => {}; },
    },
    sessions: {
      snapshot: ref => run(async () => {
        const item = await session(ref);
        const [view, partials] = await Promise.all([
          run(() => reader.readUserView(ref.id, { limit: OFFLINE_LIMITS.pageSize })),
          run(() => reader.readPartials(ref.id)),
        ]);
        if (view.entries.length > OFFLINE_LIMITS.pageSize) throw new Error("Archive adapter exceeded the requested history page size");
        return { ref: { ...ref }, cursor: { epoch, seq: 0 }, leafId: view.leafId, entries: view.entries,
          historyBefore: view.historyBefore, unfinishedPartials: partials,
          status: status(item.status), readonly: true, readonlyReason: "archived" };
      }),
      history: (ref, page) => run(async () => {
        const limit = pageLimit(page.limit);
        await session(ref);
        const view = await run(() => reader.readUserView(ref.id, { before: page.before, limit }));
        if (view.entries.length > limit) throw new Error("Archive adapter exceeded the requested history page size");
        return { entries: view.entries, historyBefore: view.historyBefore };
      }),
      subscribe: () => { check(); return () => {}; },
    },
    dispose() {
      if (abort.signal.aborted) return;
      abort.abort();
      pendingIndex = undefined;
      reader.close();
    },
  };
}
