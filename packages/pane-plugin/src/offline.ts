import { createHash, randomUUID } from "node:crypto";
import { setImmediate as yieldTurn } from "node:timers/promises";
import type { NodeStatus, PanePlugin, SessionRef, SessionSnapshot, TreeNode } from "@pi-pane/plugin-api";
import { statusDetail } from "./contracts.js";

/** 归档关系使用领域标识符，由插件映射为树节点 ID。 */
export type ArchivedSessionParent =
  | { kind: "task"; taskId: string; sessionId: string }
  | { kind: "main"; piSessionId: string }
  | { kind: "user" };

/** 归档读取器的结构边界，供适配器对齐会话元数据。 */
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
  isCurrent?: boolean;
  takenOver?: boolean;
  usage?: { contextTokens?: number };
  createdAt: string;
  endedAt?: string;
  parent?: ArchivedSessionParent;
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
  waiting_decision: "waiting", waiting_children: "waiting", quota_paused: "paused", budget_paused: "paused",
  completed: "done", done: "done", failed: "failed", stopped: "stopped", interrupted: "interrupted",
  convening: "waiting", queued: "waiting", sealed: "running", critique: "running", merging: "running",
  reviewing: "running", minuting: "running", ended: "done",
};

function status(value: string): NodeStatus {
  const result = Object.hasOwn(statuses, value) ? statuses[value] : undefined;
  if (!result) throw new Error(`不支持的归档会话状态：${value}`);
  return result;
}

function pageLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > OFFLINE_LIMITS.pageSize) {
    throw new Error(`离线分页条数必须是 1 到 ${OFFLINE_LIMITS.pageSize} 之间的整数`);
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

/** 每个离线周期持有一个读取器和有界、固定的元数据快照。 */
export function createOfflineViews(reader: ArchiveReader, epoch = `offline:${randomUUID()}`): OfflineViews {
  const abort = new AbortController();
  let pendingIndex: Promise<Index> | undefined;

  function check(): void {
    if (abort.signal.aborted) throw new DOMException("离线归档读取器已释放", "AbortError");
  }

  function run<T>(work: () => Promise<T>): Promise<T> {
    check();
    return new Promise<T>((resolve, reject) => {
      const cancelled = () => reject(new DOMException("离线归档读取器已释放", "AbortError"));
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
      if (page >= OFFLINE_LIMITS.scanPages) throw new Error(`离线元数据扫描超过 ${OFFLINE_LIMITS.scanPages} 页`);
      await pause();
      const result = await run(() => reader.listSessions({ limit: OFFLINE_LIMITS.scanPageSize, ...(cursor ? { cursor } : {}) }));
      if (result.items.length > OFFLINE_LIMITS.scanPageSize) throw new Error("归档适配器返回的元数据超过请求的分页条数");
      for (const item of result.items) {
        if (summaries.has(item.agoraSessionId)) throw new Error(`归档会话元数据重复：${item.agoraSessionId}`);
        summaries.set(item.agoraSessionId, { ...item, ...(item.parent ? { parent: { ...item.parent } } : {}) });
      }
      if (summaries.size > OFFLINE_LIMITS.sessions) throw new Error(`离线元数据扫描超过 ${OFFLINE_LIMITS.sessions} 个会话`);
      if (!result.nextCursor) break;
      if (cursors.has(result.nextCursor)) throw new Error("归档适配器返回了重复的元数据游标");
      cursors.add(result.nextCursor);
      cursor = result.nextCursor;
    }

    const nodes = new Map<string, TreeNode>();
    function group(id: string, title: string, parentId: string | null, sortKey: string, badge?: string): void {
      const previous = nodes.get(id);
      if (previous) {
        if (previous.parentId !== parentId) throw new Error(`归档分组的父节点冲突：${id}`);
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
      // 列表缺少直接父级时查询详情；parentPiSessionId 也出现在嵌套任务中，不能据此推断。
      if (item.parent === undefined) {
        const detail = await run(() => reader.getSession(item.agoraSessionId));
        if (detail) {
          if (detail.agoraSessionId !== item.agoraSessionId) throw new Error("归档适配器返回的会话 ID 不匹配");
          item = { ...item, ...(detail.parent ? { parent: { ...detail.parent } } : {}) };
        }
      }
      let parentId = item.parent?.kind === "task" ? `${SESSION}${item.parent.sessionId}`
        : item.parent?.kind === "main" ? `pane:session:${item.parent.piSessionId}`
        : item.parent?.kind === "user" ? USER_TASKS : null;
      if (item.kind === "task") {
        if (parentId === USER_TASKS) group(USER_TASKS, "用户任务", null, "");
      } else if (item.meetingId) {
        const meetingId = `${MEETING}${item.meetingId}`;
        // 席位挂在会议分组下，会议分组挂在召集方下；用户会议使用独立根节点。
        const meetingParent = item.parent?.kind === "user" || (item.parent === undefined && item.convenerId === "user")
          ? USER_MEETINGS : parentId;
        group(meetingId, `会议 ${item.meetingId}`, meetingParent, item.createdAt, "会议");
        if (meetingParent === USER_MEETINGS) group(USER_MEETINGS, "用户会议", null, "");
        parentId = meetingId;
      }
      const id = `${SESSION}${item.agoraSessionId}`;
      nodes.set(id, { id, source: "agora", kind: "session", parentId, title: item.title,
        badge: item.kind === "task" ? "子代理" : item.kind === "secretary" ? "书记" : "参会",
        sessionRef: { source: "agora", id: item.agoraSessionId }, status: status(item.status),
        statusDetail: statusDetail(item), availability: item.archiveState === "missing" ? "missing" : "archived",
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
    // 排序和哈希只处理有明确上限的元数据快照，不读取归档条目。
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
    if (ref.source !== "agora" || !ref.id) throw new Error("离线会话必须使用 agora 会话引用");
  }

  async function session(ref: SessionRef): Promise<ArchivedSessionSummary> {
    validateRef(ref);
    const item = await run(() => reader.getSession(ref.id));
    if (!item) throw new Error(`归档会话元数据不可用：${ref.id}`);
    if (item.agoraSessionId !== ref.id) throw new Error("归档适配器返回的会话 ID 不匹配");
    if (item.archiveState === "missing") throw new Error(`归档会话文件缺失：${ref.id}`);
    return item;
  }

  return {
    tree: {
      snapshot: req => run(async () => {
        if (req.openNodeIds.length > OFFLINE_LIMITS.sessions) throw new Error("离线快照的打开节点数超过上限");
        const recentSince = Date.parse(req.recentSince);
        if (!Number.isFinite(recentSince)) throw new Error("离线快照的 recentSince 时间无效");
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
            throw new Error("离线子节点分页游标无效");
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
        if (view.entries.length > OFFLINE_LIMITS.pageSize) throw new Error("归档适配器返回的历史记录超过请求的分页条数");
        return { ref: { ...ref }, cursor: { epoch, seq: 0 }, leafId: view.leafId, entries: view.entries,
          historyBefore: view.historyBefore, unfinishedPartials: partials,
          status: status(item.status), readonly: true, readonlyReason: "archived" };
      }),
      history: (ref, page) => run(async () => {
        const limit = pageLimit(page.limit);
        await session(ref);
        const view = await run(() => reader.readUserView(ref.id, { before: page.before, limit }));
        if (view.entries.length > limit) throw new Error("归档适配器返回的历史记录超过请求的分页条数");
        return { entries: view.entries, historyBefore: view.historyBefore };
      }),
      subscribe: () => { check(); return () => {}; },
    },
    panels: {
      list: () => [{ id: "agora.task", source: "agora", title: "任务信息", placement: "node", appliesTo: { kinds: ["session"], sources: ["agora"] }, revision: 0 }],
      content: (panelId, nodeId) => run(async () => {
        if (panelId !== "agora.task" || !nodeId?.startsWith(SESSION)) throw new Error("任务面板需要 agora 会话节点");
        const item = await session({ source: "agora", id: nodeId.slice(SESSION.length) });
        const rows = [
          { key: "会话", value: item.agoraSessionId }, { key: "任务", value: item.taskId ?? "—" },
          { key: "模型", value: item.model }, { key: "档位", value: item.profile }, { key: "状态", value: item.status },
          { key: "当前会话", value: item.isCurrent === undefined ? "未知" : item.isCurrent ? "是" : "否（历史会话）" },
          { key: "会话用量", value: item.usage === undefined ? "—" : JSON.stringify(item.usage) },
          { key: "上下文 token", value: String(item.usage?.contextTokens ?? "—") },
        ];
        return { type: "keyValue", rows };
      }),
    },
    dispose() {
      if (abort.signal.aborted) return;
      abort.abort();
      pendingIndex = undefined;
      reader.close();
    },
  };
}
