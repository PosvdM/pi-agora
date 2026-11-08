import type { PanePlugin, PaneHostContext, TreeChange, SessionStreamEvent, ActionResult, FormSpec, RequestOrigin } from "@pi-pane/plugin-api";
import { AgoraConnectionError } from "@pi-agora/protocol";
import { connectDaemonApi } from "./transport.js";
import { createViews } from "./views.js";
import { createActions } from "./actions.js";
import { createForms } from "./forms.js";
import { createSecurity, type Security } from "./security.js";
import { OperationIdentities } from "./identity.js";
import { createOfflineViews, type ArchiveReader } from "./offline.js";
import type { AgoraApi, PluginRuntime } from "./contracts.js";

export interface PluginOptions {
  home?: string;
  connect?: () => Promise<AgoraApi>;
  openArchive?: () => Promise<ArchiveReader>;
  retryMs?: number;
}
function offlineError(error: unknown): boolean {
  return error instanceof AgoraConnectionError || error instanceof Error && error.message === "agora 后台进程尚未启动";
}
const offlineMessage = "agora 未运行，只能读取存档";
export default function createPlugin(options: PluginOptions = {}): PanePlugin {
  let context: PaneHostContext | undefined;
  let api: AgoraApi | undefined;
  let online = false, activated = false, generation = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let probing: Promise<void> | undefined;
  let views: ReturnType<typeof createViews>;
  let forms: ReturnType<typeof createForms>;
  let actions: ReturnType<typeof createActions>;
  let security: Security;
  let archive: Promise<ReturnType<typeof createOfflineViews>> | undefined;
  let domainOff: (() => void) | undefined;
  let domainRefresh: Promise<unknown> | undefined;
  let domainsDirty = false;
  let inboxGeneration = 0;
  let inboxRunning = false;
  const identities = new OperationIdentities();
  const treeSubscriptions = new Set<{ emit(change: TreeChange): void; stop(): void }>();
  const sessionSubscriptions = new Set<{ ref: { source: string; id: string }; emit(event: SessionStreamEvent): void; stop(): void }>();
  const inProgress = new Map<string, Promise<any>>();
  const log = (message: string, error: unknown) => context?.log.warn(message, error instanceof Error ? error.name : "unknown");
  const runtime: PluginRuntime = {
    get context() { if (!context) throw new Error("agora 插件尚未启用"); return context; },
    api: {
      request: async (...args) => {
        if (!api) throw new AgoraConnectionError();
        const token = generation;
        const response = await api.request(...args);
        if (!activated || generation !== token) throw new AgoraConnectionError();
        return response;
      },
      subscribe: (...args) => { if (!api) throw new AgoraConnectionError(); return api.subscribe(...args); },
      close() {},
    },
    online: () => activated && online,
  };
  function active() { if (!activated || !context) throw new Error("agora 插件尚未启用"); }
  async function offline() {
    active();
    if (!archive) archive = (async () => {
      let reader: ArchiveReader;
      if (options.openArchive) reader = await options.openArchive();
      else {
        const packageName = "@pi-agora/archive";
        const module = await import(packageName);
        const raw = await module.openArchive({ home: options.home, apiVersion: 1 });
        if (typeof module.projectPartials !== "function") { raw.close(); throw new Error("存档适配器缺少流片段投影接口"); }
        reader = {
          listSessions: query => raw.listSessions(query), getSession: id => raw.getSession(id),
          readUserView: (id, query) => raw.readUserView(id, query),
          readPartials: async id => module.projectPartials(await raw.readPartials(id)), close: () => raw.close(),
        };
      }
      if (!activated || online) { reader.close(); throw new Error("存档读取状态已变化"); }
      return createOfflineViews(reader);
    })().catch(error => { archive = undefined; throw error; });
    return archive;
  }
  function resetSubscribers() {
    for (const subscription of treeSubscriptions) {
      subscription.stop(); subscription.emit({ type: "reset", epoch: `agora:connection:${generation}` });
    }
    treeSubscriptions.clear();
    for (const subscription of sessionSubscriptions) {
      subscription.stop(); subscription.emit({ ref: subscription.ref, cursor: { epoch: `agora:connection:${generation}`, seq: 0 }, event: { type: "resync" } });
    }
    sessionSubscriptions.clear();
  }
  function disconnect() {
    if (!online && !api) return;
    online = false; generation++; inboxGeneration++; inboxRunning = false;
    domainOff?.(); domainOff = undefined;
    api?.close(); api = undefined;
    resetSubscribers();
    // 安全横幅与待处理表单保持宿主中的持久状态，离线不表示解除。
  }
  async function refreshDomains(): Promise<void> {
    if (!activated || !online) return;
    domainsDirty = true;
    if (!domainRefresh) {
      domainRefresh = (async () => {
        while (domainsDirty && activated && online) {
          domainsDirty = false;
          const results = await Promise.allSettled([security.refreshAlerts(), forms.refresh(), views.refreshHolds()]);
          for (const result of results) if (result.status === "rejected") log("agora 领域状态暂时无法对齐", result.reason);
        }
      })().finally(() => {
        domainRefresh = undefined;
        if (domainsDirty && activated && online) void refreshDomains();
      });
    }
    await domainRefresh;
  }
  async function watchDomains(token: number): Promise<void> {
    const response = await runtime.api.request("GET", "/v1/sessions?limit=1");
    const cursor = response.body?.changesCursor;
    if (!activated || !online || generation !== token || response.status !== 200 || !cursor) return;
    domainOff?.();
    domainOff = runtime.api.subscribe(`/v1/changes?epoch=${encodeURIComponent(cursor.epoch)}&afterSeq=${cursor.seq}`, event => {
      if (!activated || !online || token !== generation) return;
      if (event.type === "reset") {
        domainOff?.(); domainOff = undefined;
        resetSubscribers();
        void refreshDomains().then(() => watchDomains(token)).catch(error => log("agora 变更流暂时不可用", error));
      } else if (event.type === "change") void refreshDomains();
    }, error => { domainOff?.(); domainOff = undefined; log("agora 领域变更流已断开", error); });
  }
  async function inbox(token: number): Promise<void> {
    let wait = 25;
    inboxRunning = true;
    try {
      while (activated && online && token === inboxGeneration) {
        const response = await runtime.api.request("GET", `/v1/inbox?wait=${wait}`);
        if (!activated || !online || token !== inboxGeneration) return;
        if (response.status !== 200 || !Array.isArray(response.body?.items)) throw new Error("agora 通知响应无效");
        const notices = response.body.items;
        for (const notice of notices) {
          if (!activated || !online || token !== inboxGeneration) return;
          if (typeof notice.noticeId !== "string" || typeof notice.dedupeKey !== "string") throw new Error("agora 通知标识无效");
          const payload = notice.payload ?? {};
          context!.notify({ id: `agora:${notice.dedupeKey}`, source: "agora", level: /failed|interrupted|unknown/.test(notice.kind) ? "warning" : "info",
            title: typeof payload.title === "string" ? payload.title : "agora 通知", body: typeof payload.summary === "string" ? payload.summary : notice.kind,
            ...(typeof payload.nodeId === "string" ? { nodeId: payload.nodeId } : {}) });
          await runtime.api.request("POST", "/v1/inbox/ack", { noticeId: notice.noticeId, persisted: false });
        }
        wait = notices.length ? 0 : 25;
      }
    } catch (error) { if (activated && token === inboxGeneration) log("agora 通知暂时无法领取", error); }
    finally { if (token === inboxGeneration) inboxRunning = false; }
  }
  async function probe(): Promise<void> {
    if (!activated) return;
    if (probing) return probing;
    const token = generation;
    probing = (async () => {
      if (api && online) {
        try {
          const health = await api.request("GET", "/v1/health", undefined, { timeoutMs: 5_000 });
          if (!activated || token !== generation) return;
          if (health.status !== 200) throw new AgoraConnectionError();
          const authorization = await api.request("GET", "/v1/status", undefined, { timeoutMs: 5_000 });
          if (!activated || token !== generation) return;
          if (authorization.status !== 200) throw new AgoraConnectionError();
          await refreshDomains();
          if (!domainOff) await watchDomains(generation);
          if (!inboxRunning) void inbox(++inboxGeneration);
          return;
        } catch (error) { if (activated) { log("agora 连接需要重建", error); disconnect(); } }
      }
      if (!activated) return;
      let next: AgoraApi;
      try { next = await (options.connect ?? (() => connectDaemonApi(options.home)))(); }
      catch (error) {
        if (!offlineError(error)) throw error;
        return;
      }
      if (!activated || token !== generation && online) { next.close(); return; }
      api = next; online = true; generation++;
      if (archive) { void archive.then(value => value.dispose()).catch(() => {}); archive = undefined; }
      resetSubscribers();
      await refreshDomains();
      await watchDomains(generation);
      const inboxToken = ++inboxGeneration;
      void inbox(inboxToken);
    })().finally(() => { probing = undefined; });
    return probing;
  }
  async function guarded<T extends { status: string }>(key: string, identity: unknown, invoke: () => Promise<T>): Promise<T> {
    if (!await identities.check(key, identity)) return { status: "idempotencyConflict", message: "同一幂等键对应了不同的操作内容" } as unknown as T;
    const final = identities.result<T>(key);
    if (final) return final;
    const pending = inProgress.get(key);
    if (pending) return pending;
    const operation = invoke().then(async result => {
      if (result.status !== "pending") await identities.finish(key, result);
      return result;
    }).finally(() => { inProgress.delete(key); });
    inProgress.set(key, operation);
    return operation;
  }
  function securityAction(actionId: string): string | undefined {
    return actionId === "agora.security.acknowledge" ? "devices-reset" : actionId === "agora.security.acknowledge-budget" ? "budget-config-changed" : undefined;
  }
  function acknowledgeForm(actionId: string): FormSpec | null {
    const kind = securityAction(actionId), alert = kind ? security.displayedAlert(kind) : undefined;
    return alert ? { id: `agora:ack:${encodeURIComponent(alert.alertId)}:${alert.revision}`, source: "agora", title: "确认知悉安全警告", revision: alert.revision,
      description: `警告类型：${alert.kind}\n\n警告版本：${alert.revision}\n\n${JSON.stringify(alert.details ?? {})}`, createdAt: alert.createdAt ?? new Date(0).toISOString(), submitLabel: "我已知悉" } : null;
  }
  const plugin: PanePlugin = {
    id: "agora", paneProtocol: [1, 1],
    async activate(ctx) {
      if (activated) throw new Error("agora 插件已经启用");
      context = ctx; activated = true; generation++;
      try {
        await identities.open(ctx.dataDir);
        views = createViews(runtime); security = createSecurity(runtime); forms = createForms(runtime, security); actions = createActions(runtime, security.execute);
        plugin.renderers = views.renderers;
        await probe();
        if (!activated) return;
        timer = setInterval(() => { void probe().catch(error => log("agora 重连失败", error)); }, options.retryMs ?? 15_000); timer.unref();
      } catch (error) { await plugin.deactivate?.(); throw error; }
    },
    async deactivate() {
      if (!activated) return;
      activated = false; generation++; inboxGeneration++;
      if (timer) clearInterval(timer); timer = undefined;
      domainOff?.(); domainOff = undefined;
      security?.dispose(); forms?.dispose(); views?.dispose(); api?.close(); api = undefined; online = false;
      for (const subscription of treeSubscriptions) subscription.stop(); treeSubscriptions.clear();
      for (const subscription of sessionSubscriptions) subscription.stop(); sessionSubscriptions.clear();
      if (archive) { await archive.then(value => value.dispose()).catch(() => {}); archive = undefined; }
    },
    tree: {
      async snapshot(req) { active(); return online ? views.tree.snapshot(req) : (await offline()).tree.snapshot(req); },
      async children(parentId, page) { active(); return online ? views.tree.children(parentId, page) : (await offline()).tree.children(parentId, page); },
      subscribe(from, emit) {
        active();
        const subscription = { emit, stop: online ? views.tree.subscribe(from, emit) : () => {} };
        treeSubscriptions.add(subscription);
        return () => { subscription.stop(); treeSubscriptions.delete(subscription); };
      },
    },
    sessions: {
      async snapshot(ref) { active(); return online ? views.sessions.snapshot(ref) : (await offline()).sessions.snapshot(ref); },
      async history(ref, page) { active(); return online ? views.sessions.history(ref, page) : (await offline()).sessions.history(ref, page); },
      subscribe(ref, after, emit) {
        active(); const subscription = { ref, emit, stop: online ? views.sessions.subscribe(ref, after, emit) : () => {} };
        sessionSubscriptions.add(subscription); return () => { subscription.stop(); sessionSubscriptions.delete(subscription); };
      },
      async send(ref, input, req) {
        active(); if (!online) return { status: "rejected", message: offlineMessage };
        return guarded(req.idempotencyKey, { type: "send", ref, input }, () => views.sessions.send!(ref, input, req));
      },
      async abort(ref, req) { active(); if (!online) throw new Error(offlineMessage); return views.sessions.abort!(ref, req); },
    },
    panels: {
      list: () => views?.panels.list() ?? [],
      async content(id, nodeId) {
        active();
        if (online) return views.panels.content(id, nodeId);
        const reader = await offline();
        if (!reader.panels) throw new Error(offlineMessage);
        return reader.panels.content(id, nodeId);
      },
    },
    actions: {
      list: () => online ? [...actions.list(), { id: "agora.device.pair", source: "agora", title: "配对当前浏览器", scope: ["global"], timeoutMs: 60_000 },
        ...["devices-reset", "budget-config-changed"].map(kind => ({ id: kind === "devices-reset" ? "agora.security.acknowledge" : "agora.security.acknowledge-budget", source: "agora", title: "我已知悉", scope: ["global" as const], hasForm: true, timeoutMs: 60_000 }))] : [],
      async resolveForm(actionId, target) { active(); if (!online) return null; return securityAction(actionId) ? acknowledgeForm(actionId) : actionId === "agora.device.pair" ? null : actions.resolveForm!(actionId, target); },
      async invoke(inv, origin) {
        active(); if (!online) return { status: "failed", message: offlineMessage };
        return guarded(inv.idempotencyKey, { type: "action", ...inv }, async (): Promise<ActionResult> => {
          let response;
          if (inv.actionId === "agora.device.pair") response = await security.pair(origin, inv.idempotencyKey);
          else if (securityAction(inv.actionId)) {
            const match = /^agora:ack:([^:]+):(\d+)$/.exec(inv.formId ?? "");
            if (!match || Number(match[2]) !== inv.formRevision) return { status: "failed", message: "请先读取当前安全警告再确认知悉" };
            response = await security.acknowledge(decodeURIComponent(match[1]!), Number(match[2]), inv.idempotencyKey, origin);
          } else return actions.invoke(inv, origin);
          if (response.status === 202) return { status: "pending" };
          if (response.body?.error?.code === "idempotency_mismatch") return { status: "idempotencyConflict", message: "幂等键对应了不同操作" };
          return response.status < 300 ? { status: "ok" } : { status: "failed", message: response.body?.error?.message ?? "操作未执行" };
        });
      },
    },
    forms: {
      async pending() { active(); return forms.forms.pending(); },
      async submit(req, origin) {
        active();
        if (!online) return forms.forms.submit(req, origin);
        return guarded(req.idempotencyKey, { type: "form", ...req }, () => forms.forms.submit(req, origin));
      },
    },
  };
  return plugin;
}
