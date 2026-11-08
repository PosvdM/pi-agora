import type {
  PanePlugin, NodeStatus, TreeNode, SessionRef, SessionSnapshot, HistoryPage,
  SessionStreamEvent, PanelContent,
} from "@pi-pane/plugin-api";
import { encoded, message, parentNodeId, type PluginRuntime, type SessionItem, type SessionsPage, type ApiEvent } from "./contracts.js";

const USER_TASKS = "agora:root:user-tasks";
const TASK_PANEL = "agora.task";
const TERMINAL = new Set(["completed", "done", "failed", "stopped", "interrupted"]);
const STEERABLE = new Set(["running", "waiting_decision", "waiting_children", "completed", "failed"]);
const MAX_PAGES = 10_000;
const RESULT_LIMIT = 20;

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
function group(revision: number): TreeNode {
  return { id: USER_TASKS, source: "agora", kind: "group", parentId: null, title: "用户任务",
    status: "idle", availability: "online", hasChildren: true, sortKey: "", revision, capabilities: [] };
}
function node(item: SessionItem, revision = item.revision): TreeNode {
  if (item.agoraSessionId === USER_TASKS) return group(revision);
  const capabilities = ["open"];
  const steerable = !!item.taskId && STEERABLE.has(item.status);
  const paused = ["quota_paused", "budget_paused"].includes(item.status);
  if (!item.taskId || !TERMINAL.has(item.status) && !paused) capabilities.push("subscribe");
  if (steerable) capabilities.push("send", "action:agora.task.steer");
  if (item.taskId && !TERMINAL.has(item.status)) {
    if (!paused) capabilities.push("abort");
    capabilities.push("action:agora.task.stop");
  }
  if (item.taskId && ["completed", "failed"].includes(item.status)) capabilities.push("action:agora.task.cleanup");
  if (item.taskId && ["quota_paused", "budget_paused", "interrupted"].includes(item.status)) capabilities.push("action:agora.task.recover");
  return {
    id: nodeId(item.agoraSessionId), source: "agora", kind: "session",
    parentId: parentNodeId(item), title: item.title,
    badge: item.taskId ? "子代理" : item.kind === "secretary" ? "书记" : "参会",
    sessionRef: { source: "agora", id: item.agoraSessionId }, status: status(item.status),
    ...(item.statusDetail ? { statusDetail: item.statusDetail } : {}),
    availability: item.archiveState === "missing" ? "missing" : item.archiveState === "archived" ? "archived" : "online",
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
  let holdQueue = Promise.resolve();
  const warn = (error: unknown) => runtime.context.log.warn("agora views", error);
  async function get<T = any>(path: string, signal = lifetime.signal): Promise<T> {
    if (disposed) throw new Error("agora 视图已关闭");
    const reply = await runtime.api.request<T>("GET", path, undefined, { signal });
    if (reply.status < 200 || reply.status >= 300) throw new Error(message(reply));
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
  async function scanHolds() {
    if (disposed) return;
    for (const [id, hold] of holds) if (!runtime.context.mainSessions.get(id)) { hold.release(); holds.delete(id); }
    if (!runtime.online()) return;
    const items = new Map<string, SessionItem>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    let epoch: string | undefined;
    let pages = 0;
    do {
      if (disposed) return;
      if (++pages > MAX_PAGES) throw new Error("任务树分页超过保活扫描上限");
      const page = await get<SessionsPage>(query("/v1/sessions", { limit: 200, cursor }));
      if (epoch !== undefined && page.changesCursor.epoch !== epoch) throw new Error("任务树来源已重置，请重新扫描");
      epoch = page.changesCursor.epoch;
      remember(page.items);
      for (const item of page.items) items.set(nodeId(item.agoraSessionId), item);
      cursor = page.nextCursor ?? undefined;
      if (cursor && cursors.has(cursor)) throw new Error("任务树分页游标未前进");
      if (cursor) cursors.add(cursor);
    } while (cursor);
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
    const next = holdQueue.then(scanHolds);
    holdQueue = next.catch(() => {});
    return next;
  }
  const offMains = runtime.context.mainSessions.onChange(() => { void refreshHolds().catch(warn); });
  const tree: NonNullable<PanePlugin["tree"]> = {
    async snapshot(req) {
      const params = new URLSearchParams({ snapshot: "1", recentSince: req.recentSince });
      for (const id of req.openNodeIds) params.append("openNodeId", id);
      const page = await get<SessionsPage>(`/v1/sessions?${params}`);
      remember(page.items);
      const revision = page.changesCursor.seq;
      const nodes = page.items.map(item => node(item));
      if (!nodes.some(item => item.id === USER_TASKS)) nodes.push(group(revision));
      return { source: "agora", epoch: page.changesCursor.epoch, revision, nodes };
    },
    async children(parentId, page) {
      const result = await get<SessionsPage>(query("/v1/sessions", { parent: parentId, limit: page.limit, cursor: page.cursor }));
      if (result.changesCursor.epoch !== page.epoch) return { reset: true, epoch: result.changesCursor.epoch };
      remember(result.items);
      return { epoch: result.changesCursor.epoch, revision: result.changesCursor.seq,
        nodes: result.items.map(item => node(item)), ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}) };
    },
    subscribe(from, emit) {
      let seq = from.revision;
      let queue = Promise.resolve();
      let stopped = false;
      let stream: ReturnType<typeof listen> | undefined;
      function reset(epoch = from.epoch) {
        if (stopped || disposed) return;
        stopped = true;
        stream?.stop();
        taskSessions.clear();
        emit({ type: "reset", epoch });
      }
      stream = listen(query("/v1/changes", { epoch: from.epoch, afterSeq: from.revision }), event => {
        if (event.type === "reset") { reset(event.data.epoch); return; }
        if (event.type !== "change" || stopped) return;
        const change = event.data;
        queue = queue.then(async () => {
          if (stopped || !stream!.active()) return;
          if (change.cursor.epoch !== from.epoch) { reset(change.cursor.epoch); return; }
          if (change.cursor.seq <= seq) return;
          const revision = change.cursor.seq;
          if (change.objectType === "tree" && change.objectId === "all") { reset(); return; }
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
              emit({ type: "remove", revision, id: nodeId(id) });
            } else {
              const item = await get<SessionItem>(`/v1/sessions/${encoded(id)}`, stream!.signal);
              if (stopped || !stream!.active()) return;
              remember([item]);
              emit({ type: "upsert", revision, node: node(item, revision) });
            }
            runtime.context.panelChanged({ panelId: TASK_PANEL, revision, nodeId: nodeId(id) });
            void refreshHolds().catch(warn);
          } else {
            // 非树对象也推进来源水位，避免分页等待一个永远不会推送的修订号。
            emit({ type: "upsert", revision, node: group(revision) });
            if (change.objectType === "request" && !change.tombstone) {
              const request = await get(`/v1/requests/${encoded(change.objectId)}`, stream!.signal);
              if (request.taskId) {
                const task = await get(`/v1/tasks/${encoded(request.taskId)}`, stream!.signal);
                if (stream!.active() && task.agoraSessionId) runtime.context.panelChanged({ panelId: TASK_PANEL, revision, nodeId: nodeId(task.agoraSessionId) });
              }
            }
          }
          seq = revision;
        }).catch(error => { if (!stopped && stream!.active()) { warn(error); reset(); } });
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
      const readonly = !item.taskId || !STEERABLE.has(item.status);
      return { ref, cursor: data.cursor, leafId: data.leafId, entries: data.entries,
        historyBefore: data.historyBefore, inFlight: data.inFlight, unfinishedPartials: data.unfinishedPartials,
        status: status(data.status), readonly, ...(readonly ? { readonlyReason: "noPermission" as const } : {}) } satisfies SessionSnapshot;
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
      if (!item.taskId || !STEERABLE.has(item.status)) return { status: "rejected", message: "此会话当前不能返工" };
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
      if (!item.taskId) return { status: "nothingToStop" };
      const reply = await runtime.api.request("POST", `/v1/tasks/${encoded(item.taskId)}/stop`, {},
        { signal: lifetime.signal });
      if (reply.status < 200 || reply.status >= 300) throw new Error(message(reply));
      void refreshHolds().catch(warn);
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
