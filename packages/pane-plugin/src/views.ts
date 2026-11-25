import type {
  PanePlugin, NodeStatus, TreeNode, TreeChange, TreeSnapshotRequest, SessionRef, SessionSnapshot, HistoryPage,
  SessionStreamEvent, PanelContent,
} from "@pi-pane/plugin-api";
import { AgoraReplyError, encoded, message, parentNodeId, statusDetail, userTask, type PluginRuntime, type SessionItem, type SessionsPage, type ApiEvent } from "./contracts.js";

const USER_TASKS = "agora:root:user-tasks";
const TASK_PANEL = "agora.task";
/** pane 协议中使节点成为热节点的状态（“按需加载”一节）。 */
const HOT = new Set<NodeStatus>(["running", "waiting", "paused"]);
const TERMINAL = new Set(["completed", "done", "failed", "stopped", "interrupted"]);
const STEERABLE = new Set(["running", "waiting_decision", "waiting_children", "completed", "failed"]);
const MAX_PAGES = 10_000;
const RESULT_LIMIT = 20;
const MAX_PENDING_CHANGES = 256;
const MAX_PENDING_CHANGE_BYTES = 8 * 1024 * 1024;

/**
 * 每个变更 seq 占用的来源级修订号个数。pane 协议要求每条 upsert/remove 各分配一个新修订号，同一条变更可能推送
 * 节点本身和用户任务根两帧，因此修订号为 `seq × REVISION_SLOTS + 子序号`。快照和分页的切点包含该 seq 的全部推送，
 * 取最后一个子序号；订阅切点落在某个 seq 中间时，插件从该 seq 重新读取，只推送修订号更大的帧。
 * 一条变更的最后一帧总是取最后一个子序号，前面的帧按顺序往前排（两帧就是倒数第二、最后一个），所以一条变更
 * 最多推送 REVISION_SLOTS 帧。pane 以收到的最大修订号为水位，分页的修订号大于水位时要等订阅追上，超过 5 秒按
 * reset 处理；最后一帧取切点值，处理完一条变更后水位就等于同一 seq 的分页修订号。
 */
export const REVISION_SLOTS = 4;
/** 快照和分页中节点自身的修订号（会话行 treeRevision 换算），不大于同一 seq 的任何推送。 */
const NODE_SLOT = 0;
function revisionOf(seq: number, slot: number): number {
  const value = seq * REVISION_SLOTS + slot;
  if (!Number.isSafeInteger(value)) throw new Error("变更序号超出树修订号的范围");
  return value;
}
/** 快照或分页切点对应的修订号：包含该 seq 的全部推送。 */
function cutRevision(seq: number): number { return revisionOf(seq, REVISION_SLOTS - 1); }

class TreeReset extends Error {
  constructor() { super("任务树来源已重置，请重新扫描"); }
}

function status(value: string): NodeStatus {
  const mapped: Record<string, NodeStatus> = {
    created: "waiting", waiting_decision: "waiting", waiting_children: "waiting",
    quota_paused: "paused", budget_paused: "paused", completed: "done", convening: "waiting", queued: "waiting",
    sealed: "running", critique: "running", merging: "running", reviewing: "running",
    minuting: "running", ended: "done",
  };
  if (mapped[value]) return mapped[value];
  return ["idle", "running", "waiting", "paused", "done", "failed", "stopped", "interrupted"].includes(value)
    ? value as NodeStatus : "idle";
}
function nodeId(id: string): string { return id.startsWith("agora:") ? id : `agora:session:${id}`; }
function sessionId(ref: SessionRef): string {
  if (ref.source !== "agora" || !ref.id) throw new Error("会话不属于 agora");
  return encoded(ref.id);
}
// childCount 来自快照扫描和订阅中的增减；用户任务根不是 daemon 的会话行，没有扫描结果时不填写。
function group(revision: number, childCount?: number): TreeNode {
  return { id: USER_TASKS, source: "agora", kind: "group", parentId: null, title: "用户任务",
    status: "idle", availability: "online", hasChildren: true, ...(childCount === undefined ? {} : { childCount }), sortKey: "", revision, capabilities: [] };
}
// 协议版本仍为 1；不返回 treeRevision 的是旧 daemon，不能拿会话行 revision 顶替节点修订号。
function treeRevision(item: SessionItem): number {
  const value: unknown = item.treeRevision;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("agora 后台版本过旧，会话缺少 treeRevision，请运行 agora shutdown 后重新启动后台");
  }
  return revisionOf(value, NODE_SLOT);
}
function node(item: SessionItem, revision = treeRevision(item), userTasks?: number): TreeNode {
  if (item.agoraSessionId === USER_TASKS) return group(revision, userTasks);
  const capabilities = ["open"];
  const historical = !!item.taskId && item.isCurrent === false;
  const userOwned = userTask(item);
  const steerable = !!item.taskId && !historical && userOwned && STEERABLE.has(item.status);
  const paused = ["quota_paused", "budget_paused"].includes(item.status);
  if (!historical && (!item.taskId || !TERMINAL.has(item.status) && !paused)) capabilities.push("subscribe");
  if (steerable) capabilities.push("send", "action:agora.task.steer");
  // abort 与停止动作调用同一端点；pane 已为 abort 显示停止按钮，只在不能 abort 时提供停止动作。
  if (item.taskId && !historical && !TERMINAL.has(item.status)) capabilities.push(paused ? "action:agora.task.stop" : "abort");
  if (item.taskId && !historical && ["completed", "failed"].includes(item.status)) capabilities.push("action:agora.task.cleanup");
  if (item.taskId && !historical && userOwned && ["quota_paused", "budget_paused", "interrupted"].includes(item.status)) capabilities.push("action:agora.task.recover");
  if (item.taskId && !historical && !userOwned) capabilities.push("action:agora.task.takeover");
  const detail = [item.taskId && !historical && !userOwned ? "由 Agent 管理，接管后可操作" : undefined, statusDetail(item)].filter(Boolean).join("；");
  return {
    id: nodeId(item.agoraSessionId), source: "agora", kind: "session",
    parentId: parentNodeId(item), title: item.title,
    badge: item.taskId ? "子代理" : item.kind === "secretary" ? "书记" : "参会",
    sessionRef: { source: "agora", id: item.agoraSessionId }, status: status(item.status),
    ...(detail ? { statusDetail: detail } : {}),
    availability: item.archiveState === "missing" ? "missing" : historical || item.archiveState === "archived" ? "archived" : "online",
    hasChildren: item.hasChildren, ...(item.childCount === undefined ? {} : { childCount: item.childCount }),
    lastActivityAt: item.lastActivityAt, sortKey: item.createdAt, revision, capabilities,
    ...(steerable ? { composer: { actionId: "agora.task.steer", placeholder: "对子代理补充说明或返工", images: false } } : {}),
    ...(item.originToolCall ? { originToolCall: item.originToolCall } : {}),
  };
}
function query(path: string, values: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== undefined) params.set(key, String(value));
  return `${path}?${params}`;
}
function display(value: unknown): string {
  return value === undefined || value === null ? "—" : typeof value === "string" ? value : JSON.stringify(value);
}

export function createViews(runtime: PluginRuntime): {
  tree: NonNullable<PanePlugin["tree"]>;
  sessions: NonNullable<PanePlugin["sessions"]>;
  panels: NonNullable<PanePlugin["panels"]>;
  renderers: PanePlugin["renderers"];
  refreshHolds(): Promise<void>;
  dispose(): void;
} {
  let disposed = false;
  const lifetime = new AbortController();
  const subscriptions = new Set<() => void>();
  const taskSessions = new Map<string, string>();
  const holds = new Map<string, { count: number; release(): void }>();
  let holdRefresh: Promise<void> | undefined;
  let holdDirty = false;
  const warn = (error: unknown) => runtime.context.log.warn("agora views", error);
  async function get<T = any>(path: string, signal = lifetime.signal): Promise<T> {
    if (disposed) throw new Error("agora 视图已关闭");
    const reply = await runtime.api.request<T>("GET", path, undefined, { signal });
    if (reply.status < 200 || reply.status >= 300) throw new AgoraReplyError(reply.status, reply);
    return reply.body;
  }
  function remember(items: SessionItem[]) {
    for (const item of items) if (item.taskId) taskSessions.set(item.taskId, item.agoraSessionId);
  }
  function listen(path: string, receive: (event: ApiEvent) => void, failed: (error: unknown) => void) {
    if (disposed) throw new Error("agora 视图已关闭");
    let active = true;
    let off = () => {};
    const controller = new AbortController();
    const stop = () => {
      if (!active) return;
      active = false;
      controller.abort();
      off();
      subscriptions.delete(stop);
    };
    subscriptions.add(stop);
    try {
      off = runtime.api.subscribe(path, event => { if (active && !disposed) receive(event); },
        error => { if (active && !disposed) failed(error); });
      if (!active) off();
    } catch (error) { stop(); throw error; }
    return { stop, signal: controller.signal, active: () => active && !disposed };
  }
  /** 分页读取全部可见会话；读取期间来源重置时抛出 TreeReset。 */
  async function scanSessions(): Promise<{ epoch: string; items: Map<string, SessionItem> } | undefined> {
    const items = new Map<string, SessionItem>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    let epoch: string | undefined;
    let pages = 0;
    do {
      if (disposed) return undefined;
      if (++pages > MAX_PAGES) throw new Error("任务树分页超过扫描上限");
      let page: SessionsPage;
      try { page = await get<SessionsPage>(query("/v1/sessions", { limit: 200, cursor })); }
      catch (error) {
        // 游标绑定 epoch，来源切换后 daemon 对旧游标返回 400 invalid_params；核实来源，同 epoch 的错误原样抛出。
        if (epoch !== undefined && error instanceof AgoraReplyError && error.status === 400 && error.code === "invalid_params") {
          const latest = await get<SessionsPage>("/v1/sessions?limit=1");
          if (disposed) return undefined;
          if (latest.changesCursor.epoch !== epoch) throw new TreeReset();
        }
        throw error;
      }
      if (disposed) return undefined;
      if (epoch !== undefined && page.changesCursor.epoch !== epoch) throw new TreeReset();
      epoch = page.changesCursor.epoch;
      remember(page.items);
      for (const item of page.items) items.set(nodeId(item.agoraSessionId), item);
      cursor = page.nextCursor ?? undefined;
      if (cursor && cursors.has(cursor)) throw new Error("任务树分页游标未前进");
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return { epoch: epoch!, items };
  }
  /**
   * 用户任务根的直接子节点 ID，含历史会话；根节点的 childCount 取集合大小，供“历史（N）”使用。快照扫描建立集合，
   * 所有订阅处理变更时按会话移入、移出或删除持续增减，新订阅（包括浏览器重连后的续订）从当前集合开始，不回到快照时的副本。
   * 集合按 ID 增减，订阅回放已计入的变更不会重复计数；没有订阅期间漏掉的变更由续订回放补齐。`seq` 为已计入的
   * 最新变更序号；之后的结构标记或来源切换使集合作废，直到下一次快照重新扫描。
   */
  let userTasks: { epoch: string; ids: Set<string>; seq: number } | undefined;
  /**
   * 统计挂在 pane 节点下的直接子节点总数，收集用户任务根的直接子节点，含历史会话；扫描期间来源重置时返回 undefined。
   * 扫描晚于快照页，可能读到切点之后才出现或变热的会话。pane 对其他来源父节点的“历史（N）”只扣除经快照或分页取到的
   * 子节点，订阅推来的不扣除；这类会话由订阅回放推送，且是热节点时宿主会直接显示，因此不计入 foreignChildCounts，
   * 否则同一个任务既显示为子节点又算进历史。冷的照常计入，宿主不显示订阅推来的冷节点，要靠“历史”分页取到。
   */
  async function childCounts(epoch: string, cut: number, snapshotIds: ReadonlySet<string>, req: TreeSnapshotRequest): Promise<{ foreign: Record<string, number>; userTasks: Set<string> } | undefined> {
    let scan;
    try { scan = await scanSessions(); }
    catch (error) { if (error instanceof TreeReset) return undefined; throw error; }
    // 来源已重置时快照的订阅会收到 reset，下一次快照再报告数目。
    if (!scan || scan.epoch !== epoch) return undefined;
    const recentSince = Date.parse(req.recentSince);
    const hot = (id: string, item: SessionItem) => HOT.has(status(item.status)) || req.openNodeIds.includes(id)
      || Date.parse(item.lastActivityAt) > recentSince;
    const foreign: Record<string, number> = {};
    const userTasks = new Set<string>();
    for (const [id, item] of scan.items) {
      const parent = parentNodeId(item);
      if (parent?.startsWith("pane:")) {
        if (!snapshotIds.has(id) && treeRevision(item) > cut && hot(id, item)) continue;
        foreign[parent] = (foreign[parent] ?? 0) + 1;
      } else if (parent === USER_TASKS) userTasks.add(id);
    }
    return { foreign, userTasks };
  }
  async function scanHolds() {
    if (disposed) return;
    for (const [id, hold] of holds) if (!runtime.context.mainSessions.get(id)) { hold.release(); holds.delete(id); }
    if (!runtime.online()) return;
    const scan = await scanSessions();
    if (!scan) return;
    const { items } = scan;
    if (disposed || !runtime.online()) return;
    const counts = new Map<string, number>();
    for (const item of items.values()) {
      if (!item.taskId || TERMINAL.has(item.status)) continue;
      let parent = parentNodeId(item);
      const visited = new Set<string>();
      while (parent && !parent.startsWith("pane:session:")) {
        if (visited.has(parent)) { parent = null; break; }
        visited.add(parent);
        const ancestor = items.get(parent);
        parent = ancestor ? parentNodeId(ancestor) : null;
      }
      if (!parent) continue;
      const id = parent.slice("pane:session:".length);
      if (runtime.context.mainSessions.get(id)) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    // hold 可登记在尚未托管的主会话上，主会话上线后仍然有效。
    for (const id of new Set([...holds.keys(), ...counts.keys()])) {
      const count = runtime.context.mainSessions.get(id) ? counts.get(id) ?? 0 : 0;
      const previous = holds.get(id);
      if (previous?.count === count) continue;
      if (count) {
        const release = runtime.context.mainSessions.hold({ source: "pane", id }, `等待子代理（${count} 个）`);
        holds.set(id, { count, release });
        previous?.release();
      } else if (previous) { previous.release(); holds.delete(id); }
    }
  }
  function refreshHolds(): Promise<void> {
    if (disposed) return Promise.resolve();
    holdDirty = true;
    if (!holdRefresh) {
      holdRefresh = Promise.resolve().then(async () => {
        try {
          do {
            holdDirty = false;
            await scanHolds();
          } while (holdDirty && !disposed);
        } finally { holdRefresh = undefined; }
      });
      // 每个运行任务只观察一次错误，避免为每条变更保留一个回调。
      void holdRefresh.catch(warn);
    }
    return holdRefresh;
  }
  const offMains = runtime.context.mainSessions.onChange(() => { void refreshHolds(); });
  const tree: NonNullable<PanePlugin["tree"]> = {
    async snapshot(req) {
      const params = new URLSearchParams({ snapshot: "1", recentSince: req.recentSince });
      for (const id of req.openNodeIds) params.append("openNodeId", id);
      const page = await get<SessionsPage>(`/v1/sessions?${params}`);
      remember(page.items);
      const revision = cutRevision(page.changesCursor.seq);
      // 快照只含热节点，用户任务根与 pane 主会话下的冷节点数目需要扫描全部会话才能得到。
      const counts = await childCounts(page.changesCursor.epoch, revision, new Set(page.items.map(item => nodeId(item.agoraSessionId))), req);
      userTasks = counts ? { epoch: page.changesCursor.epoch, ids: counts.userTasks, seq: page.changesCursor.seq } : undefined;
      const userTaskCount = counts?.userTasks.size;
      const nodes = page.items.map(item => node(item, undefined, userTaskCount));
      if (!nodes.some(item => item.id === USER_TASKS)) nodes.push(group(revision, userTaskCount));
      return { source: "agora", epoch: page.changesCursor.epoch, revision, nodes, ...(counts ? { foreignChildCounts: counts.foreign } : {}) };
    },
    async children(parentId, page) {
      // 旧来源的游标可能在 daemon 返回 epoch 前被拒绝，先用有界读取核实来源。
      const current = await get<SessionsPage>("/v1/sessions?limit=1");
      lifetime.signal.throwIfAborted();
      if (current.changesCursor.epoch !== page.epoch) return { reset: true, epoch: current.changesCursor.epoch };
      const reply = await runtime.api.request("GET",
        query("/v1/sessions", { parent: parentId, limit: page.limit, cursor: page.cursor }),
        undefined, { signal: lifetime.signal });
      lifetime.signal.throwIfAborted();
      if (reply.status < 200 || reply.status >= 300) {
        if (page.cursor !== undefined && reply.status === 400 && reply.body?.error?.code === "invalid_params") {
          // 两次读取之间也可能切换来源；同 epoch 的参数错误仍交给调用方。
          const latest = await get<SessionsPage>("/v1/sessions?limit=1");
          lifetime.signal.throwIfAborted();
          if (latest.changesCursor.epoch !== page.epoch) return { reset: true, epoch: latest.changesCursor.epoch };
        }
        throw new AgoraReplyError(reply.status, reply);
      }
      const result: SessionsPage = reply.body;
      if (result.changesCursor.epoch !== page.epoch) return { reset: true, epoch: result.changesCursor.epoch };
      remember(result.items);
      return { epoch: result.changesCursor.epoch, revision: cutRevision(result.changesCursor.seq),
        nodes: result.items.map(item => node(item)), ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}) };
    },
    subscribe(from, emit) {
      // 切点落在某个 seq 的中间（例如连接断在同一条变更的两帧之间）时，从该 seq 重新读取，只推送修订号更大的帧。
      const fromSeq = Math.floor(from.revision / REVISION_SLOTS);
      const partial = from.revision % REVISION_SLOTS !== REVISION_SLOTS - 1 && fromSeq > 0;
      let seq = partial ? fromSeq - 1 : fromSeq;
      let queue = Promise.resolve();
      let pendingChanges = 0;
      let pendingBytes = 0;
      let stopped = false;
      let stream: ReturnType<typeof listen> | undefined;
      // 本订阅最近一次推送给宿主的根节点 childCount。宿主手里的数目可能来自更早的快照或其他订阅，
      // 新订阅在第一条树变更时总会推送一次根节点，之后数目变化才推送。
      let sentCount: number | undefined;
      /** 与本订阅同一来源周期的用户任务根子节点集合；没有扫描结果或已作废时为 undefined，根节点不填 childCount。 */
      const tracked = () => userTasks?.epoch === from.epoch ? userTasks : undefined;
      function reset(epoch = from.epoch) {
        if (stopped || disposed) return;
        stopped = true;
        stream?.stop();
        taskSessions.clear();
        if (epoch !== from.epoch && userTasks?.epoch === from.epoch) userTasks = undefined;
        emit({ type: "reset", epoch });
      }
      /** 推送一帧；重新读取切点所在的 seq 时，跳过宿主已收到的帧（修订号不大于切点）。返回是否推送。 */
      function push(change: Exclude<TreeChange, { type: "reset" }>): boolean {
        if (change.revision <= from.revision) return false;
        emit(change);
        return true;
      }
      type Frame = (revision: number) => Exclude<TreeChange, { type: "reset" }>;
      /** 带当前 childCount 的根节点（非树对象推进水位时也用它）。 */
      const rootFrame: Frame = revision => ({ type: "upsert", revision, node: group(revision, tracked()?.ids.size) });
      /** 推送一条变更的全部帧：最后一帧取该 seq 的切点值，前面的帧按顺序往前排。 */
      function pushFrames(seq: number, frames: Frame[]) {
        if (frames.length > REVISION_SLOTS) throw new Error(`一条变更最多推送 ${REVISION_SLOTS} 帧`);
        const first = REVISION_SLOTS - frames.length;
        frames.forEach((frame, index) => {
          const change = frame(revisionOf(seq, first + index));
          if (push(change) && change.type === "upsert" && change.node.id === USER_TASKS) sentCount = change.node.childCount;
        });
      }
      /** 节点移入、移出用户任务根或被删除时更新共享的子节点集合；返回根节点是否需要推送新的 childCount。 */
      function trackUserTask(id: string, parent: string | null): boolean {
        const state = tracked();
        if (state) { if (parent === USER_TASKS) state.ids.add(id); else state.ids.delete(id); }
        const count = tracked()?.ids.size;
        return count !== undefined && count !== sentCount;
      }
      // 变更流只能核对 seq：切点落在 head 之后的 seq 中间时，按协议先 reset，不推送其他变更。核对排在所有变更之前。
      if (partial) queue = queue.then(async () => {
        if (stopped || !stream?.active()) return;
        const head = await get<SessionsPage>("/v1/sessions?limit=1", stream.signal);
        if (stopped || !stream.active()) return;
        if (head.changesCursor.epoch !== from.epoch) reset(head.changesCursor.epoch);
        else if (from.revision > cutRevision(head.changesCursor.seq)) reset();
      }).catch(error => { if (!stopped && stream?.active()) { warn(error); reset(); } });
      stream = listen(query("/v1/changes", { epoch: from.epoch, afterSeq: seq }), event => {
        if (event.type === "reset") { reset(event.data.epoch); return; }
        if (event.type !== "change" || stopped) return;
        const change = event.data;
        // 计入正在映射的事件；transport 的单帧限制之外再限制整个积压。
        const bytes = Buffer.byteLength(JSON.stringify(change), "utf8");
        if (pendingChanges >= MAX_PENDING_CHANGES || bytes > MAX_PENDING_CHANGE_BYTES - pendingBytes) {
          reset();
          return;
        }
        pendingChanges++;
        pendingBytes += bytes;
        queue = queue.then(async () => {
          if (stopped || !stream!.active()) return;
          if (change.cursor.epoch !== from.epoch) { reset(change.cursor.epoch); return; }
          if (change.cursor.seq <= seq) return;
          const last = cutRevision(change.cursor.seq);
          if (change.objectType === "tree" && change.objectId === "all") {
            // 结构迁移改变父关系，集合在下一次快照前不再可信；晚于该标记的快照已重新扫描，不受影响。
            const state = tracked();
            if (state && state.seq < change.cursor.seq) userTasks = undefined;
            reset();
            return;
          }
          if (change.objectType === "task" || change.objectType === "session") {
            let id = change.objectId as string;
            if (change.objectType === "task") {
              if (change.tombstone) {
                const known = taskSessions.get(id);
                if (!known) { reset(); return; }
                taskSessions.delete(id);
                id = known;
              } else {
                const task = await get(`/v1/tasks/${encoded(id)}`, stream!.signal);
                id = task.agoraSessionId;
                if (!id) throw new Error("任务没有关联会话");
              }
            }
            if (stopped || !stream!.active()) return;
            if (change.tombstone) {
              for (const [taskId, known] of taskSessions) if (known === id) taskSessions.delete(taskId);
              const root = trackUserTask(nodeId(id), null);
              pushFrames(change.cursor.seq, [revision => ({ type: "remove", revision, id: nodeId(id) }), ...(root ? [rootFrame] : [])]);
            } else {
              const item = await get<SessionItem>(`/v1/sessions/${encoded(id)}`, stream!.signal);
              if (stopped || !stream!.active()) return;
              remember([item]);
              treeRevision(item);
              // 每条变更都推送，修订号按变更 seq 分配；详情是读取时的最新数据，可能新于本条变更。
              // pane 只应用修订号更大的 upsert，同一节点之后的推送或分页只会带来同样新或更新的数据。
              const probe = node(item, last);
              const root = trackUserTask(probe.id, probe.parentId);
              pushFrames(change.cursor.seq, [revision => ({ type: "upsert", revision, node: node(item, revision, tracked()?.ids.size) }), ...(root ? [rootFrame] : [])]);
            }
            runtime.context.panelChanged({ panelId: TASK_PANEL, revision: last, nodeId: nodeId(id) });
            void refreshHolds();
          } else {
            // 非树对象也推进来源水位，避免分页等待一个永远不会推送的修订号。
            pushFrames(change.cursor.seq, [rootFrame]);
            if (change.objectType === "request" && !change.tombstone) {
              const request = await get(`/v1/requests/${encoded(change.objectId)}`, stream!.signal);
              if (stopped || !stream!.active()) return;
              if (request.taskId) {
                const task = await get(`/v1/tasks/${encoded(request.taskId)}`, stream!.signal);
                if (stream!.active() && task.agoraSessionId) runtime.context.panelChanged({ panelId: TASK_PANEL, revision: last, nodeId: nodeId(task.agoraSessionId) });
              }
            }
          }
          seq = change.cursor.seq;
          const state = tracked();
          if (state && seq > state.seq) state.seq = seq;
        }).catch(error => { if (!stopped && stream!.active()) { warn(error); reset(); } })
          .finally(() => { pendingChanges--; pendingBytes -= bytes; });
      }, error => { warn(error); reset(); });
      if (stopped) stream.stop();
      return () => { stopped = true; stream!.stop(); };
    },
  };
  const sessions: NonNullable<PanePlugin["sessions"]> = {
    async snapshot(ref) {
      const id = sessionId(ref);
      const data = await get<any>(`/v1/sessions/${id}/snapshot`);
      const item = await get<SessionItem>(`/v1/sessions/${id}`);
      remember([item]);
      const readonly = !item.taskId || item.isCurrent === false || !userTask(item) || !STEERABLE.has(item.status);
      return { ref, cursor: data.cursor, leafId: data.leafId, entries: data.entries,
        historyBefore: data.historyBefore, inFlight: data.inFlight, unfinishedPartials: data.unfinishedPartials,
        status: status(data.status), readonly, ...(readonly ? { readonlyReason: item.isCurrent === false ? "archived" as const : "noPermission" as const } : {}) } satisfies SessionSnapshot;
    },
    async history(ref, page) {
      return get<HistoryPage>(query(`/v1/sessions/${sessionId(ref)}/history`, page));
    },
    subscribe(ref, after, emit) {
      const path = query(`/v1/sessions/${sessionId(ref)}/stream`, { epoch: after.epoch, afterSeq: after.seq });
      let stopped = false;
      let stream: ReturnType<typeof listen> | undefined;
      const resync = (data: any) => {
        if (stopped || disposed) return;
        stopped = true;
        stream?.stop();
        emit({ ref, cursor: data?.cursor ?? { epoch: data?.epoch ?? after.epoch, seq: 0 },
          event: { ...(data?.event ?? data ?? {}), type: "resync" } });
      };
      stream = listen(path, incoming => {
        if (stopped) return;
        if (incoming.type === "resync") { resync(incoming.data); return; }
        if (incoming.type !== "session") return;
        const { cursor, event } = incoming.data;
        if (event.type === "agora_run") return;
        if (event.type === "resync") { resync(incoming.data); return; }
        let mapped = event;
        if (event.type === "agora_entries") mapped = { ...event, type: "pane_entries" };
        if (event.type === "agora_status") {
          const { statusDetail, revision: _revision, controlRevision: _controlRevision, ...rest } = event;
          mapped = { ...rest, type: "pane_status", status: status(event.status), ...(statusDetail ? { detail: statusDetail } : {}) };
        }
        emit({ ref, cursor, event: mapped } satisfies SessionStreamEvent);
      }, error => { warn(error); resync(undefined); });
      if (stopped) stream.stop();
      return () => { stopped = true; stream!.stop(); };
    },
    async send(ref, input, req) {
      if (input.images?.length) return { status: "rejected", message: "agora 任务只接受文字" };
      if (input.delivery === "followUp") return { status: "rejected", message: "agora 任务通过返工发送，不支持 followUp" };
      if (req.expectedRevision !== undefined) return { status: "rejected", message: "agora 未提供会话控制修订号，请刷新后重试" };
      const item = await get<SessionItem>(`/v1/sessions/${sessionId(ref)}`);
      if (!item.taskId || item.isCurrent === false || !userTask(item) || !STEERABLE.has(item.status)) return { status: "rejected", message: "此会话当前不能返工" };
      const reply = await runtime.api.request("POST", `/v1/tasks/${encoded(item.taskId)}/steer`,
        { message: input.text, interrupt: false }, { idempotencyKey: req.idempotencyKey, signal: lifetime.signal });
      if (reply.status < 200 || reply.status >= 300) return {
        status: ["idempotency_mismatch", "idempotency_conflict"].includes(reply.body?.error?.code) ? "idempotencyConflict" : "rejected", message: message(reply),
      };
      return { status: reply.status === 202 ? "pending" : "accepted" };
    },
    async abort(ref, req) {
      if (req.expectedRevision !== undefined) throw new Error("agora 未提供会话控制修订号，请刷新后重试");
      const item = await get<SessionItem>(`/v1/sessions/${sessionId(ref)}`);
      if (!item.taskId || item.isCurrent === false) return { status: "nothingToStop" };
      const task = await get(`/v1/tasks/${encoded(item.taskId)}`);
      if (task.taskId !== item.taskId || task.agoraSessionId !== ref.id) throw new Error("任务状态与目标不匹配");
      if (!Number.isSafeInteger(task.generation) || task.generation < 1 || !Number.isSafeInteger(task.revision) || task.revision < 1) throw new Error("任务版本无效，请重新读取任务");
      const reply = await runtime.api.request("POST", `/v1/tasks/${encoded(item.taskId)}/stop`,
        { expectedGeneration: task.generation, expectedRevision: task.revision },
        { signal: lifetime.signal });
      if (reply.status < 200 || reply.status >= 300) throw new Error(message(reply));
      void refreshHolds();
      // stop 总会清队列；clearQueue 只决定是否把原文交还输入框。
      const clearedText = (reply.body.droppedSteers ?? []).map((item: { message: string }) =>
        item.message.replace(/^【agora 返工 [^\n]*】\r?\n/, ""));
      return { status: "done", ...(req.clearQueue ? { clearedText } : {}) };
    },
  };
  const panels: NonNullable<PanePlugin["panels"]> = {
    list: () => [{ id: TASK_PANEL, source: "agora", title: "任务信息", placement: "node",
      appliesTo: { kinds: ["session"], sources: ["agora"] }, revision: 0 }],
    async content(panelId, id) {
      if (panelId !== TASK_PANEL || !id?.startsWith("agora:session:")) throw new Error("任务面板需要 agora 会话节点");
      const item = await get<SessionItem>(`/v1/sessions/${encoded(id.slice("agora:session:".length))}`);
      const rows: { key: string; value: string }[] = [];
      const add = (key: string, value: unknown) => rows.push({ key, value: display(value) });
      if (!item.taskId) {
        add("席位", item.title); add("角色", item.kind); add("模型", item.model); add("状态", item.status);
      } else {
        const task = await get(`/v1/tasks/${encoded(item.taskId)}`);
        add("当前会话", item.isCurrent === false ? "否（历史会话）" : "是");
        add("任务", item.taskId); add("状态", task.status); add("模型", task.model ?? item.model);
        add("档位", task.profile ?? item.profile); add("思考", task.thinking ?? item.thinking);
        add("代数", task.generation); add("worktree", task.worktree); add("工作目录", task.cwd);
        add("任务用量", task.usage); add("任务树用量", task.treeUsage); add("上下文 token", task.usage?.contextTokens);
        if (task.budget !== undefined) add("任务预算", task.budget);
        if (Number.isSafeInteger(task.generation) && task.generation > 0) {
          const start = Math.max(1, task.generation - RESULT_LIMIT + 1);
          if (start > 1) add("结果范围", `显示最近 ${RESULT_LIMIT} 代（第 ${start}—${task.generation} 代）`);
          for (let generation = start; generation <= task.generation; generation++) {
            const result = await get(query(`/v1/tasks/${encoded(item.taskId)}/result`, { generation }));
            add(`第 ${generation} 代状态`, result.status); add(`第 ${generation} 代结果`, result.resultText);
            add(`第 ${generation} 代用量`, result.generationUsage);
          }
        } else add("结果", task.resultText);
        let cursor: string | undefined;
        const seen = new Set<string>();
        let count = 0;
        do {
          const page: { items: any[]; nextCursor?: string | null } = await get(query("/v1/requests", { taskId: item.taskId, state: "answered", limit: 200, cursor }));
          if (!Array.isArray(page.items)) throw new Error("提问记录响应无效");
          count += page.items.length;
          if (count > 4096) throw new Error("答复记录超过面板读取上限，请通过 API 分页查看");
          for (const request of page.items) {
            if (request.taskId !== item.taskId || request.state !== "answered") continue;
            add(`提问 ${request.id} 的答复`, request.answers);
            const proof = request.answeredVia;
            add(`提问 ${request.id} 的确认来源`, proof?.confirmedBy === "device"
              ? `由 ${request.answeredBy ?? "用户"} 答复，经设备 ${proof.deviceId ?? "未知"} 确认`
              : `由 ${request.answeredBy ?? "未知"} 答复，未经设备确认`);
          }
          cursor = page.nextCursor ?? undefined;
          if (cursor && seen.has(cursor)) throw new Error("提问记录分页游标未前进");
          if (cursor) seen.add(cursor);
        } while (cursor);
      }
      return { type: "keyValue", rows } satisfies PanelContent;
    },
  };
  return { tree, sessions, panels, refreshHolds,
    renderers: { customMessages: [
      { customType: "agora:notice", label: "agora 通知", body: "content",
        fields: [{ path: "taskId", label: "任务" }, { path: "generation", label: "代数" }], nodeIdPath: "nodeId" },
      { customType: "agora:board-delta", label: "board 增量", collapsed: true },
      { customType: "agora:meeting-turn", label: "会议阶段",
        fields: [{ path: "phase", label: "阶段" }, { path: "phaseEpoch", label: "阶段轮次" }] },
    ] },
    dispose() {
      if (disposed) return;
      disposed = true;
      lifetime.abort();
      offMains();
      for (const stop of subscriptions) stop();
      for (const hold of holds.values()) hold.release();
      holds.clear();
      taskSessions.clear();
    },
  };
}
