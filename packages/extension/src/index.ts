import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AgoraConnectionError, AgoraHttpError, agoraHome, connectHost, connectLaunch, hmacProof, agoraTaskSchema, gitRead } from '@pi-agora/protocol';
import { canonicalPath, isWithin } from 'pi-hostkit/paths';
import type { AgoraClient } from '@pi-agora/protocol';
import { NoticeDelivery } from './notifications.js';
import type { Notice } from './notifications.js';
import { checkToolPath, EXTENSION_VERSION, validatePolicy, verifyRuntime } from './permissions.js';
import type { ChildPolicy, LaunchIdentity, PiExtensionApi, SessionContext } from './types.js';

const taskSchema = agoraTaskSchema;
function principalReference(ctx: SessionContext): string | undefined {
  const entries = ctx.sessionManager.getEntries();
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if (entry.type !== 'custom' || entry.customType !== 'agora-principal') continue;
    const id = (entry.data as { principalId?: unknown })?.principalId;
    if (typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id)) return id;
  }
  return undefined;
}
async function bindMain(ctx: SessionContext, client: AgoraClient, home: string): Promise<{ ephemeral: boolean; principalId?: string }> {
  const sessionId = ctx.sessionManager.getSessionId();
  const sessionFile = ctx.sessionManager.getSessionFile();
  const ephemeral = !sessionFile;
  const previous = principalReference(ctx);
  if (previous) {
    let key: Buffer;
    try { key = await readFile(join(home, 'secret', 'principals', `${previous}.key`)); }
    catch { throw new Error('无法读取 agora 会话恢复凭证'); }
    if (key.length !== 32) throw new Error('agora 会话恢复凭证无效');
    try {
      await client.request('POST', '/v1/principals/reclaim', { principalId: previous, sessionId,
        proof: hmacProof(key, ['reclaim', previous, sessionId, client.connectionId, client.instanceId]) });
      return { ephemeral };
    } catch (error) {
      if (!(error instanceof AgoraHttpError) || error.code !== 'session_mismatch') throw error;
    }
  }
  const registered = await client.request<{ principalId: string }>('POST', '/v1/principals/register', {
    sessionId, sessionFile, cwd: ctx.cwd, ephemeral, ...(previous ? { forkedFrom: previous } : {}),
  });
  if (!registered || !/^[A-Za-z0-9_-]{1,128}$/.test(registered.principalId)) throw new Error('agora 会话注册响应无效');
  return { ephemeral, principalId: registered.principalId };
}
interface SessionRuntime {
  ctx: SessionContext;
  sessionId: string;
  controller: AbortController;
  client?: AgoraClient;
  delivery?: NoticeDelivery;
  policy?: ChildPolicy;
  runId?: string;
  ready: boolean;
  fatal: boolean;
  initializing?: Promise<void>;
  authorizing?: Promise<void>;
  reconnecting?: Promise<void>;
  reconnectAfter: number;
  leaseTimer?: ReturnType<typeof setInterval>;
  refreshTimer?: ReturnType<typeof setInterval>;
}

export default function agoraExtension(pi: PiExtensionApi): void {
  // 必须在扩展工厂的第一个异步操作之前移除，后续扩展和工具不能继承启动凭证。
  const managed = Object.hasOwn(process.env, 'AGORA_LAUNCH_TICKET') || Boolean(process.env.AGORA_URL);
  const ticket = process.env.AGORA_LAUNCH_TICKET;
  const childUrl = process.env.AGORA_URL;
  delete process.env.AGORA_LAUNCH_TICKET;
  const home = managed ? undefined : agoraHome();
  const launchPromise = managed
    ? (ticket && childUrl ? connectLaunch<LaunchIdentity>(childUrl, ticket) : Promise.reject(new Error('agora 子会话缺少启动凭证')))
    : undefined;
  void launchPromise?.catch(() => {});
  let runtime: SessionRuntime | undefined;
  const current = (r: SessionRuntime) => runtime === r && !r.controller.signal.aborted;
  const notify = (r: SessionRuntime, message: string) => {
    try { if (current(r) && r.ctx.hasUI) r.ctx.ui?.notify(message, 'error'); } catch { /* 界面错误不能中断权限检查或清理。 */ }
  };
  async function release(client: AgoraClient): Promise<void> {
    await client.request('POST', '/v1/lease/release', {}, { timeoutMs: 2000 }).catch(() => {});
    client.close();
  }
  function recordFatal(r: SessionRuntime): void {
    r.ready = false;
    if (r.fatal || !current(r)) return;
    r.fatal = true;
    try { pi.appendEntry('agora-fatal', { message: '权限检查失败，已拒绝工具调用' }); } catch { /* 关闭期间不放行工具。 */ }
    notify(r, 'agora 权限检查失败，协作会话已停用');
    try {
      if (r.client && r.runId) void r.client.request('POST', `/v1/runs/${encodeURIComponent(r.runId)}/fatal`, {}).catch(() => {});
    } catch { /* 通知后台失败时仍须阻断工具。 */ }
    try { r.ctx.shutdown(); } catch { /* 关闭失败时保持 fatal，后续工具仍被拒绝。 */ }
  }
  async function connectMain(r: SessionRuntime): Promise<{ client: AgoraClient; ephemeral: boolean } | undefined> {
    const replacement = await connectHost({ home, as: 'agent:main', signal: r.controller.signal });
    if (!current(r)) { replacement.close(); return; }
    try {
      const binding = await bindMain(r.ctx, replacement, home!);
      // register/reclaim 可能已在 daemon 接受后遇到 shutdown，迟到的租约仍须释放。
      if (!current(r)) { await release(replacement); return; }
      if (binding.principalId) pi.appendEntry('agora-principal', { principalId: binding.principalId });
      return { client: replacement, ephemeral: binding.ephemeral };
    } catch (error) {
      // 响应丢失时也可能已绑定；release 只释放本连接持有的租约。
      await release(replacement);
      throw error;
    }
  }
  function reconnect(r: SessionRuntime): Promise<void> {
    if (managed || !current(r) || Date.now() < r.reconnectAfter) return Promise.resolve();
    if (r.reconnecting) return r.reconnecting;
    r.reconnectAfter = Date.now() + 5000;
    r.reconnecting = (async () => {
      const connection = await connectMain(r);
      if (!connection) return;
      const previous = r.client;
      r.client = connection.client;
      r.delivery?.setClient(connection.client);
      previous?.close();
    })().finally(() => { r.reconnecting = undefined; });
    return r.reconnecting;
  }
  async function recover(r: SessionRuntime, error: unknown): Promise<void> {
    if (error instanceof AgoraConnectionError || error instanceof AgoraHttpError &&
        (error.status === 401 || error.status === 409 && error.code === 'lease_required')) {
      await reconnect(r).catch(() => {});
    }
  }
  async function poll(r: SessionRuntime, wait: number): Promise<number> {
    const client = r.client;
    const delivery = r.delivery;
    if (!current(r) || !client || !delivery) return 0;
    // 单条确认的暂时故障不能阻断收取后续通知；鉴权与连接故障由 inbox 请求触发恢复。
    await delivery.confirm().catch(() => {});
    if (!current(r) || client !== r.client) return 0;
    const response = await client.request<{ items: Notice[] }>('GET', `/v1/inbox?wait=${wait}`, undefined, { signal: r.controller.signal });
    if (!current(r) || client !== r.client) return 0;
    if (!response || !Array.isArray(response.items)) throw new Error('agora 通知响应无效');
    await delivery.accept(response.items);
    return response.items.length;
  }
  async function drain(r: SessionRuntime, wait: number): Promise<void> {
    let count = await poll(r, wait);
    while (current(r) && count > 0) count = await poll(r, 0);
  }
  async function pollLoop(r: SessionRuntime): Promise<void> {
    while (current(r)) {
      try { await drain(r, 25); } catch (error) { await recover(r, error); }
      try { await delay(250, undefined, { signal: r.controller.signal }); } catch { break; }
    }
  }
  async function authorize(r: SessionRuntime): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (current(r) && Date.now() < deadline) {
      const result = await r.client!.request<{ ready: boolean }>('GET', `/v1/runs/${encodeURIComponent(r.runId!)}/authorized`, undefined, { signal: r.controller.signal });
      if (result.ready) {
        verifyRuntime(pi, r.ctx, r.policy!); r.ready = true;
        r.delivery = new NoticeDelivery(pi, r.ctx, r.client!, false);
        await drain(r, 0); void pollLoop(r); return;
      }
      await delay(25, undefined, { signal: r.controller.signal });
    }
    if (current(r)) throw new Error('agora 最终就绪核对超时');
  }
  async function initialize(r: SessionRuntime): Promise<void> {
    try {
      if (managed) {
        const auth = await launchPromise!;
        if (!current(r)) { auth.client.close(); return; }
        r.client = auth.client;
        r.policy = auth.launch.policy;
        r.runId = auth.launch.runId;
        if (typeof r.runId !== 'string' || !r.runId) throw new Error('agora 子会话运行标识无效');
        validatePolicy(r.policy);
        verifyRuntime(pi, r.ctx, r.policy);
        const accepted = await r.client.request<{ ready: boolean }>('POST', `/v1/runs/${encodeURIComponent(r.runId)}/ready`, {
          tools: pi.getActiveTools(), model: `${r.ctx.model!.provider}/${r.ctx.model!.id}`,
          thinking: pi.getThinkingLevel(), extensionVersion: EXTENSION_VERSION,
        });
        if (!current(r)) return;
        if (accepted?.ready !== true) throw new Error('agora 子会话就绪检查未通过');
        verifyRuntime(pi, r.ctx, r.policy);
        // session_start 必须先返回，daemon 才能执行 RPC 二次核对。
        r.authorizing = authorize(r).catch(() => { if (current(r)) recordFatal(r); });
      } else {
        const connection = await connectMain(r);
        if (!connection) return;
        r.client = connection.client;
        r.delivery = new NoticeDelivery(pi, r.ctx, r.client, connection.ephemeral);
        r.leaseTimer = setInterval(() => {
          if (current(r)) void r.client?.request('POST', '/v1/lease/renew', {}).catch(error => recover(r, error));
        }, 30000);
        r.leaseTimer.unref();
        await drain(r, 0).catch(() => {});
        if (!current(r)) return;
        void pollLoop(r);
      }
      r.refreshTimer = setInterval(() => {
        if (current(r) && Date.parse(r.client?.expiresAt ?? '') - Date.now() <= 30 * 60 * 1000) void r.client?.refresh().catch(error => {
          if (managed) { if (!(error instanceof AgoraConnectionError)) recordFatal(r); }
          else void recover(r, error);
        });
      }, 30_000);
      r.refreshTimer.unref();
    } catch {
      if (!current(r)) return;
      if (managed) recordFatal(r);
      else {
        notify(r, 'agora 连接失败，请检查后台进程或会话控制租约');
        r.controller.abort(); r.delivery?.close(); r.client?.close();
      }
      throw new Error(managed ? 'agora 子会话初始化失败，已拒绝运行' : 'agora 主会话初始化失败');
    }
  }
  pi.on('session_before_switch', () => managed ? { cancel: true } : undefined);
  pi.on('session_before_fork', () => managed ? { cancel: true } : undefined);
  pi.on('session_before_tree', () => managed ? { cancel: true } : undefined);
  pi.on('tool_call', async (event, ctx) => {
    if (!managed) return;
    const r = runtime;
    try {
      if (r?.authorizing) await r.authorizing;
      if (!r || !current(r) || !r.ready || r.fatal || !r.policy || ctx.sessionManager.getSessionId() !== r.sessionId) {
        return { block: true, reason: 'agora 子会话尚未通过就绪检查' };
      }
      verifyRuntime(pi, ctx, r.policy);
      const reason = await checkToolPath(event, ctx, r.policy);
      if (!current(r) || !r.ready || r.fatal) return { block: true, reason: 'agora 协作会话已经关闭' };
      verifyRuntime(pi, ctx, r.policy);
      if (reason) return { block: true, reason };
    } catch {
      if (r) recordFatal(r);
      return { block: true, reason: 'agora 权限检查失败，已拒绝工具调用' };
    }
  });
  pi.on('user_bash', () => managed ? { result: { output: '只读协作会话不能执行命令', exitCode: 1, cancelled: false, truncated: false } } : undefined);
  pi.on('session_start', (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    if (runtime) {
      if (runtime.sessionId === sessionId) return runtime.initializing;
      throw new Error('agora 不能在释放旧会话之前初始化其他会话');
    }
    const r: SessionRuntime = { ctx, sessionId, controller: new AbortController(), ready: false, fatal: false, reconnectAfter: 0 };
    runtime = r;
    r.initializing = initialize(r);
    return r.initializing;
  });
  pi.on('turn_end', async () => {
    const r = runtime;
    if (r && current(r)) await r.delivery?.confirm().catch(() => {});
  });
  pi.on('agent_settled', async () => {
    const r = runtime;
    if (!r || !current(r)) return;
    await r.delivery?.settled().catch(() => {});
    await drain(r, 0).catch(error => recover(r, error));
  });
  pi.on('session_shutdown', async () => {
    const r = runtime;
    if (!r) return;
    runtime = undefined;
    r.ready = false;
    r.controller.abort();
    clearInterval(r.leaseTimer);
    clearInterval(r.refreshTimer);
    r.delivery?.close();
    if (r.client) { if (managed) r.client.close(); else await release(r.client); }
  });
  pi.registerTool({
    name: 'agora_task', label: 'agora 任务', executionMode: 'sequential',
    description: '派出子代理，列出和查询任务、取结果、返工、停止子树、清理 worktree 或处理中断。下级只能管理自己直接派出的任务，权限和子树限制不能放宽。',
    parameters: taskSchema,
    async execute(toolCallId, params, signal, _update, ctx) {
      const r = runtime;
      if (r?.authorizing) await r.authorizing;
      if (!r || !current(r) || !r.client || managed && !r.ready || ctx.sessionManager.getSessionId() !== r.sessionId) throw new Error('agora 会话尚未通过连接核对');
      const client = r.client;
      let result: unknown;
      const options = { signal: signal ? AbortSignal.any([signal, r.controller.signal]) : r.controller.signal, idempotencyKey: toolCallId };
      if (params.action === 'spawn') {
        if (!['explore', 'review', 'implement'].includes(params.profile) || typeof params.prompt !== 'string' || !params.prompt.trim() ||
            typeof params.model !== 'string' || !params.model.includes('/') || (params.isolation && !['none', 'worktree'].includes(params.isolation))) {
          throw new Error('任务需要完整模型名、任务书及有效权限档位');
        }
        const { action: _action, taskId: _taskId, reason: _reason, generation: _generation, ...body } = params;
        result = await client.request('POST', '/v1/tasks', { ...body, cwd: params.cwd ?? ctx.cwd,
          originToolCall: { toolCallId, sessionId: ctx.sessionManager.getSessionId() } }, options);
      } else if (params.action === 'list') {
        const query = new URLSearchParams({ scope: params.scope ?? 'mine' });
        for (const status of params.status ?? []) query.append('status', status);
        result = await client.request('GET', `/v1/tasks?${query}`, undefined, options);
      } else {
        if (typeof params.taskId !== 'string' || !params.taskId) throw new Error('请提供任务标识');
        const path = `/v1/tasks/${encodeURIComponent(params.taskId)}`;
        if (params.action === 'status') result = await client.request('GET', path, undefined, options);
        else if (params.action === 'result') result = await client.request('GET', path + '/result' + (params.generation ? `?generation=${params.generation}` : ''), undefined, options);
        else if (['stop', 'steer', 'cleanup', 'recover'].includes(params.action)) {
          const { action, taskId: _taskId, ...body } = params;
          result = await client.request('POST', path + '/' + action, body, options);
        }
        else throw new Error('任务操作无效');
      }
      if (!current(r)) throw new Error('agora 会话已经关闭');
      const text = JSON.stringify(result);
      return { content: [{ type: 'text', text: text.length <= 12000 ? text : text.slice(0, 12000) + '\n结果已截断；请按任务标识查询。' }], details: result };
    },
  });
  pi.registerTool({
    name: 'agora_request', label: 'agora 提问', executionMode: 'sequential',
    description: '向直接上级提问；主代理向用户提问。可答复、逐级转交、取消或列出提问。超时、取消和转交均不表示同意，未获答复时应停在安全状态。',
    parameters: { type: 'object', required: ['action'], properties: {
      action: { enum: ['ask', 'answer', 'escalate', 'cancel', 'list'] }, requestId: { type: 'string' },
      questions: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'object' } },
      answers: { type: 'array', items: { type: 'object' } }, context: { type: 'string' }, note: { type: 'string' },
      expiresAt: { type: 'string' }, waitSeconds: { type: 'integer', minimum: 0, maximum: 240 }, expectedRevision: { type: 'integer', minimum: 1 },
      state: { type: 'array', items: { type: 'string' } },
    } },
    async execute(toolCallId, params, signal, _update, ctx) {
      const r = runtime;
      if (r?.authorizing) await r.authorizing;
      if (!r || !current(r) || !r.client || managed && !r.ready || ctx.sessionManager.getSessionId() !== r.sessionId) throw new Error('agora 会话尚未连接');
      const combined = signal ? AbortSignal.any([signal, r.controller.signal]) : r.controller.signal;
      const options = { signal: combined, idempotencyKey: toolCallId };
      let result: any;
      if (params.action === 'list') {
        const query = new URLSearchParams();
        for (const state of params.state ?? []) query.append('state', state);
        result = await r.client.request('GET', '/v1/requests?' + query, undefined, options);
      } else if (params.action === 'ask') {
        if (params.waitSeconds !== undefined && (!Number.isInteger(params.waitSeconds) || params.waitSeconds < 0 || params.waitSeconds > 240)) throw new Error('等待时间必须为 0 到 240 秒');
        result = await r.client.request('POST', '/v1/requests', { questions: params.questions, context: params.context, expiresAt: params.expiresAt }, options);
        const deadline = Date.now() + (params.waitSeconds ?? 240) * 1000;
        while (current(r) && result.state === 'open' && Date.now() < deadline) {
          await delay(Math.min(250, Math.max(1, deadline - Date.now())), undefined, { signal: combined });
          result = await r.client.request('GET', '/v1/requests/' + encodeURIComponent(result.id), undefined, { signal: combined });
        }
        if (['open', 'escalated'].includes(result.state)) result = { ...result, message: '提问尚未答复。答复到达后会以消息送达；请停在安全状态，不得自行假设批准。' };
      } else {
        if (typeof params.requestId !== 'string' || !params.requestId || !['answer', 'escalate', 'cancel'].includes(params.action)) throw new Error('提问动作或标识无效');
        const { action, requestId, ...body } = params;
        result = await r.client.request('POST', `/v1/requests/${encodeURIComponent(requestId)}/${action}`, body, options);
      }
      return { content: [{ type: 'text', text: JSON.stringify(result).slice(0, 16000) }], details: result };
    },
  });
  if (managed) pi.registerTool({
    name: 'agora_git', label: 'agora git', executionMode: 'sequential',
    description: 'review 档位的只读 git 查询。只允许 status、diff、log、show 和固定选项；不会运行仓库的外部 diff、filter、签名器、pager 或 fsmonitor。',
    parameters: { type: 'object', required: ['command'], properties: { command: { enum: ['status', 'diff', 'log', 'show'] },
      options: { type: 'array', items: { type: 'string' } }, refs: { type: 'array', items: { type: 'string' } }, paths: { type: 'array', items: { type: 'string' } } } },
    async execute(_id, params, signal, _update, ctx) {
      const r = runtime; if (r?.authorizing) await r.authorizing;
      if (!r?.ready || !current(r) || !r.policy || !['review', 'implement'].includes(r.policy.profile)) throw new Error('当前档位不能使用 agora_git');
      for (const item of params.paths?.length ? params.paths : [ctx.cwd]) {
        const target = await canonicalPath(item, ctx.cwd, 'read');
        const root = await canonicalPath(ctx.cwd, ctx.cwd, 'write');
        const protectedPaths = await Promise.all(r.policy.protectedPaths.map(p => canonicalPath(p, ctx.cwd, 'write')));
        if (!isWithin(root, target) || protectedPaths.some(p => isWithin(p, target) || isWithin(target, p))) throw new Error('git 路径越界或包含受保护目录');
      }
      const output = await gitRead(ctx.cwd, params.command, params.options, params.refs, params.paths, signal);
      return { content: [{ type: 'text', text: output }], details: { output } };
    },
  });
}
