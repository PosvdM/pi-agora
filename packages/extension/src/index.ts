import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AgoraHttpError, agoraHome, connectHost, connectLaunch, hmacProof } from '@pi-agora/protocol';
import type { AgoraClient } from '@pi-agora/protocol';
import { NoticeDelivery } from './notifications.js';
import type { Notice } from './notifications.js';
import { checkToolPath, EXTENSION_VERSION, validatePolicy, verifyRuntime } from './permissions.js';
import type { ChildPolicy, LaunchIdentity, PiExtensionApi, SessionContext } from './types.js';

const taskSchema = {
  type: 'object', additionalProperties: false, required: ['action'],
  properties: {
    action: { type: 'string', enum: ['spawn', 'status', 'result', 'stop'] },
    taskId: { type: 'string', minLength: 1 }, model: { type: 'string', minLength: 3 },
    thinking: { type: 'string', enum: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] },
    profile: { type: 'string', enum: ['explore'] }, prompt: { type: 'string', minLength: 1 },
    title: { type: 'string' }, cwd: { type: 'string' },
    isolation: { type: 'string', enum: ['none'] }, notify: { type: 'string', enum: ['wake', 'silent'] },
    reason: { type: 'string' }, generation: { type: 'integer', minimum: 1 },
  },
};
function principalReference(ctx: SessionContext): string | undefined {
  const entries = ctx.sessionManager.getBranch();
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if (entry.type !== 'custom' || entry.customType !== 'agora-principal') continue;
    const id = (entry.data as { principalId?: unknown })?.principalId;
    if (typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id)) return id;
  }
  return undefined;
}
async function bindMain(pi: PiExtensionApi, ctx: SessionContext, client: AgoraClient, home: string): Promise<boolean> {
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
      return ephemeral;
    } catch (error) {
      if (!(error instanceof AgoraHttpError) || error.code !== 'session_mismatch') throw error;
    }
  }
  const registered = await client.request<{ principalId: string }>('POST', '/v1/principals/register', {
    sessionId, sessionFile, cwd: ctx.cwd, ephemeral, ...(previous ? { forkedFrom: previous } : {}),
  });
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(registered.principalId)) throw new Error('agora 会话注册响应无效');
  pi.appendEntry('agora-principal', { principalId: registered.principalId });
  return ephemeral;
}

export default function agoraExtension(pi: PiExtensionApi): void {
  // 必须在扩展工厂的第一个异步操作之前移除，后续扩展和工具不能继承启动凭证。
  const managed = Object.hasOwn(process.env, 'AGORA_LAUNCH_TICKET') || Boolean(process.env.AGORA_URL);
  const ticket = process.env.AGORA_LAUNCH_TICKET;
  const childUrl = process.env.AGORA_URL;
  delete process.env.AGORA_LAUNCH_TICKET;
  let client: AgoraClient | undefined;
  let context: SessionContext | undefined;
  let delivery: NoticeDelivery | undefined;
  let policy: ChildPolicy | undefined;
  let runId: string | undefined;
  let ready = false;
  let fatal = false;
  let stopped = true;
  let controller = new AbortController();
  let leaseTimer: ReturnType<typeof setInterval> | undefined;
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  let initializing: Promise<void> | undefined;
  let sessionKey: string | undefined;
  const home = managed ? undefined : agoraHome();
  const launchPromise = managed
    ? (ticket && childUrl ? connectLaunch<LaunchIdentity>(childUrl, ticket) : Promise.reject(new Error('agora 子会话缺少启动凭证')))
    : undefined;
  // session_start 接管错误；附加处理器防止加载期间出现未处理的拒绝。
  void launchPromise?.catch(() => {});

  function notify(message: string): void {
    if (context?.hasUI) context.ui?.notify(message, 'error');
  }
  function recordFatal(): void {
    ready = false;
    if (fatal) return;
    fatal = true;
    try { pi.appendEntry('agora-fatal', { message: '权限检查失败，已拒绝工具调用' }); } catch { /* 关闭期间不放行工具。 */ }
    notify('agora 权限检查失败，协作会话已停用');
    if (client && runId) void client.request('POST', `/v1/runs/${encodeURIComponent(runId)}/fatal`, {}).catch(() => {});
    context?.shutdown();
  }
  async function poll(wait: number): Promise<void> {
    const activeClient = client;
    const activeDelivery = delivery;
    if (!activeClient || !activeDelivery || stopped) return;
    await activeDelivery.confirm();
    const response = await activeClient.request<{ items: Notice[] }>('GET', `/v1/inbox?wait=${wait}`, undefined, { signal: controller.signal });
    if (stopped || activeClient !== client) return;
    await activeDelivery.accept(response.items);
  }
  let reconnecting: Promise<void> | undefined;
  function reconnect(): Promise<void> {
    if (managed || stopped || !context) return Promise.resolve();
    if (reconnecting) return reconnecting;
    const ctx = context;
    reconnecting = (async () => {
      const replacement = await connectHost({ home, as: 'agent:main', signal: controller.signal });
      try {
        await bindMain(pi, ctx, replacement, home!);
        if (stopped || context !== ctx) { replacement.close(); return; }
        const previous = client;
        client = replacement;
        delivery?.setClient(replacement);
        previous?.close();
      } catch (error) { replacement.close(); throw error; }
    })().finally(() => { reconnecting = undefined; });
    return reconnecting;
  }
  async function pollLoop(): Promise<void> {
    while (!stopped && !controller.signal.aborted) {
      try { await poll(25); }
      catch {
        if (stopped) break;
        await reconnect().catch(() => {});
      }
      try { await delay(250, undefined, { signal: controller.signal }); } catch { break; }
    }
  }
  pi.on('session_before_switch', () => managed ? { cancel: true } : undefined);
  pi.on('session_before_fork', () => managed ? { cancel: true } : undefined);
  pi.on('session_before_tree', () => managed ? { cancel: true } : undefined);
  pi.on('tool_call', async (event, ctx) => {
    if (!managed) return;
    try {
      if (!ready || fatal || !policy) return { block: true, reason: 'agora 子会话尚未通过就绪检查' };
      verifyRuntime(pi, ctx, policy);
      const reason = await checkToolPath(event, ctx, policy);
      if (reason) return { block: true, reason };
    } catch {
      recordFatal();
      return { block: true, reason: 'agora 权限检查失败，已拒绝工具调用' };
    }
  });
  pi.on('user_bash', () => managed ? { result: { output: '只读协作会话不能执行命令', exitCode: 1, cancelled: false, truncated: false } } : undefined);
  async function initialize(ctx: SessionContext): Promise<void> {
    context = ctx;
    stopped = false;
    controller = new AbortController();
    try {
      if (managed) {
        const auth = await launchPromise!;
        client = auth.client;
        policy = auth.launch.policy;
        runId = auth.launch.runId;
        if (typeof runId !== 'string' || !runId) throw new Error('agora 子会话运行标识无效');
        validatePolicy(policy);
        verifyRuntime(pi, ctx, policy);
        const accepted = await client.request<{ ready: boolean }>('POST', `/v1/runs/${encodeURIComponent(runId)}/ready`, {
          tools: pi.getActiveTools(), model: `${ctx.model!.provider}/${ctx.model!.id}`,
          thinking: pi.getThinkingLevel(), extensionVersion: EXTENSION_VERSION,
        });
        if (accepted.ready !== true) throw new Error('agora 子会话就绪检查未通过');
        if (stopped) { client.close(); return; }
        ready = true;
      } else {
        client = await connectHost({ home, as: 'agent:main', signal: controller.signal });
        const ephemeral = await bindMain(pi, ctx, client, home!);
        if (stopped) { client.close(); return; }
        delivery = new NoticeDelivery(pi, ctx, client, ephemeral);
        leaseTimer = setInterval(() => {
          void client?.request('POST', '/v1/lease/renew', {}).catch(() => reconnect().catch(() => {}));
        }, 30000);
        leaseTimer.unref();
        await poll(0).catch(() => {});
        void pollLoop();
      }
      refreshTimer = setInterval(() => {
        void client?.refresh().catch(() => { if (managed) recordFatal(); else void reconnect().catch(() => {}); });
      }, 30 * 60 * 1000);
      refreshTimer.unref();
    } catch {
      if (managed) recordFatal();
      else { stopped = true; delivery?.close(); client?.close(); notify('agora 连接失败，请检查后台进程或会话控制租约'); }
      throw new Error(managed ? 'agora 子会话初始化失败，已拒绝运行' : 'agora 主会话初始化失败');
    }
  }
  pi.on('session_start', (_event, ctx) => {
    const key = ctx.sessionManager.getSessionId();
    if (initializing) {
      if (sessionKey === key) return initializing;
      throw new Error('agora 不能在释放旧会话之前初始化其他会话');
    }
    sessionKey = key;
    initializing = initialize(ctx);
    return initializing;
  });
  pi.on('turn_end', async () => { if (!stopped) await delivery?.confirm().catch(() => {}); });
  pi.on('agent_settled', async () => {
    if (stopped) return;
    await delivery?.settled().catch(() => {});
    // 与长轮询分开，空闲边界的即时拉取不能等待长轮询超时。
    await poll(0).catch(() => {});
  });
  pi.on('session_shutdown', async () => {
    stopped = true;
    ready = false;
    clearInterval(leaseTimer);
    clearInterval(refreshTimer);
    controller.abort();
    delivery?.close();
    if (client && !managed) await client.request('POST', '/v1/lease/release', {}, { timeoutMs: 2000 }).catch(() => {});
    client?.close();
    context = undefined;
    initializing = undefined;
    sessionKey = undefined;
  });
  if (managed) return;
  pi.registerTool({
    name: 'agora_task', label: 'agora 任务', executionMode: 'sequential',
    description: '派只读子代理，查询任务状态、获取结果或停止任务。仅支持 explore 档位和不创建 worktree 的任务。工具文字最多返回 12000 字。',
    parameters: taskSchema,
    async execute(toolCallId, params, signal, _update, ctx) {
      if (!client || stopped) throw new Error('agora 主会话尚未连接');
      let result: unknown;
      const options = { signal, idempotencyKey: toolCallId };
      if (params.action === 'spawn') {
        if (params.profile !== 'explore' || typeof params.prompt !== 'string' || !params.prompt.trim() ||
            typeof params.model !== 'string' || !params.model.includes('/') || (params.isolation && params.isolation !== 'none')) {
          throw new Error('任务需要完整模型名、任务书及 explore 档位');
        }
        const { action: _action, taskId: _taskId, reason: _reason, generation: _generation, ...body } = params;
        result = await client.request('POST', '/v1/tasks', { ...body, cwd: params.cwd ?? ctx.cwd,
          originToolCall: { toolCallId, sessionId: ctx.sessionManager.getSessionId() } }, options);
      } else {
        if (typeof params.taskId !== 'string' || !params.taskId) throw new Error('请提供任务标识');
        const path = `/v1/tasks/${encodeURIComponent(params.taskId)}`;
        if (params.action === 'status') result = await client.request('GET', path, undefined, options);
        else if (params.action === 'result') result = await client.request('GET', path + '/result' + (params.generation ? `?generation=${params.generation}` : ''), undefined, options);
        else if (params.action === 'stop') result = await client.request('POST', path + '/stop', { reason: params.reason }, options);
        else throw new Error('任务操作无效');
      }
      const text = JSON.stringify(result);
      return { content: [{ type: 'text', text: text.length <= 12000 ? text : text.slice(0, 12000) + '\n结果已截断；请按任务标识查询。' }], details: result };
    },
  });
}
