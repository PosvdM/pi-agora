// pane-bridge 的 project_trust 处理器原型（pi-pane docs/architecture.md“项目信任”）。
//
// 启动配置：真实设计里随回连通道的 ticket 兑换响应下发；原型从环境变量 P0_PANE_BRIDGE_CONFIG
// 指向的 JSON 文件读取，格式：
//   { decisions: [{ cwd, trusted: "yes" | "no", remember: boolean }],
//     bridgeUrl?: string,          // 回连地址；进程内切换到配置里没有的目录时 POST /bridge/trust 询问
//     askTimeoutMs?: number,       // 设计为 60000，测试里缩短
//     logPath: string }            // 每次调用写一行 JSON，供测试核对
// 设置了 P0_PANE_BRIDGE_EXCHANGE_URL 和 P0_PANE_BRIDGE_TICKET 时，工厂函数先用 ticket 向该地址兑换，
// 把响应里的启动配置合并进来，再从 process.env 删除 ticket（pi 会 await 异步工厂函数）。
// 连接对象存放在 globalThis[Symbol.for("pi-pane.bridge")]，后续扩展实例复用。
import { appendFileSync, readFileSync, realpathSync } from 'node:fs';

type Decision = { trusted: 'yes' | 'no' | 'undecided'; remember?: boolean };

const KEY = Symbol.for('pi-pane.bridge');

function canonical(path: string): string {
  try { return realpathSync(path); } catch { return path; }
}

function bridge(): any {
  const g = globalThis as any;
  if (!g[KEY]) {
    const configPath = process.env.P0_PANE_BRIDGE_CONFIG;
    const config = configPath ? JSON.parse(readFileSync(configPath, 'utf8')) : { decisions: [] };
    g[KEY] = { config, instances: 0, createdAt: Date.now() };
  }
  return g[KEY];
}

export default async function (pi: any) {
  const conn = bridge();
  const instance = ++conn.instances;
  const log = (record: object) => {
    if (conn.config.logPath) appendFileSync(conn.config.logPath, `${JSON.stringify({ at: Date.now(), instance, ...record })}\n`);
  };
  if (!conn.exchanged && process.env.P0_PANE_BRIDGE_EXCHANGE_URL && process.env.P0_PANE_BRIDGE_TICKET) {
    const response = await fetch(process.env.P0_PANE_BRIDGE_EXCHANGE_URL, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ticket: process.env.P0_PANE_BRIDGE_TICKET }),
    });
    const body = await response.json();
    conn.config = { ...conn.config, ...body.startupConfig };
    conn.exchanged = true;
    delete process.env.P0_PANE_BRIDGE_TICKET;
  }
  log({ kind: 'factory', exchanged: !!conn.exchanged, decisions: (conn.config.decisions ?? []).length });

  pi.on('project_trust', async (event: any, ctx: any) => {
    const target = canonical(event.cwd);
    const match = (conn.config.decisions ?? []).find((d: any) => canonical(d.cwd) === target);
    let result: Decision;
    let source: string;
    if (match) {
      result = { trusted: match.trusted, remember: match.remember };
      source = 'startup-config';
    } else {
      ({ result, source } = await askServer(conn.config, event.cwd));
    }
    // 记录处理器运行时的上下文，核对设计里关于 ctx.ui 的说法。
    const confirm = await Promise.race([
      ctx.ui.confirm('probe', 'probe'),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 500)),
    ]);
    log({ kind: 'project_trust', eventCwd: event.cwd, ctxCwd: ctx.cwd, canonicalCwd: target, hasUI: ctx.hasUI, mode: ctx.mode, uiConfirm: confirm, source, result });
    return result;
  });

  pi.on('session_start', async (event: any, ctx: any) => {
    // 设计中的 bridgeReady：报告实际的信任状态。
    log({ kind: 'session_start', reason: event.reason, cwd: ctx.cwd, isProjectTrusted: ctx.isProjectTrusted(), sessionFile: ctx.sessionManager.getSessionFile() });
  });

  pi.registerCommand('g-switch', {
    description: 'switch to a session file',
    handler: async (args: string, ctx: any) => {
      const result = await ctx.switchSession(args.trim());
      log({ kind: 'switch', target: args.trim(), result });
    },
  });
}

async function askServer(config: any, cwd: string): Promise<{ result: Decision; source: string }> {
  if (!config.bridgeUrl) return { result: { trusted: 'undecided' }, source: 'no-bridge' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.askTimeoutMs ?? 60_000);
  try {
    const response = await fetch(`${config.bridgeUrl}/bridge/trust`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd }), signal: controller.signal,
    });
    if (!response.ok) return { result: { trusted: 'undecided' }, source: `bridge-http-${response.status}` };
    const body = await response.json();
    if (body.trusted === 'yes' || body.trusted === 'no') return { result: { trusted: body.trusted, remember: !!body.remember }, source: 'bridge-answer' };
    return { result: { trusted: 'undecided' }, source: 'bridge-undecided' };
  } catch (error: any) {
    return { result: { trusted: 'undecided' }, source: controller.signal.aborted ? 'bridge-timeout' : `bridge-error:${error?.message}` };
  } finally {
    clearTimeout(timer);
  }
}
