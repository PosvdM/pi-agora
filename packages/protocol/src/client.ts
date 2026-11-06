import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { open, readFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export type HostRole = 'agent:main' | 'host:cli' | 'host:pane';
export interface RequestOptions { signal?: AbortSignal; idempotencyKey?: string; timeoutMs?: number }
export interface AgoraClient {
  readonly url: string;
  readonly token: string;
  readonly connectionId: string;
  readonly instanceId: string;
  readonly expiresAt: string;
  request<T = unknown>(method: string, path: string, body?: unknown, options?: RequestOptions): Promise<T>;
  refresh(): Promise<void>;
  close(): void;
}
export class AgoraConnectionError extends Error {
  constructor() { super('无法连接 agora，请检查后台进程'); this.name = 'AgoraConnectionError'; }
}
export class AgoraHttpError extends Error {
  constructor(public readonly status: number, public readonly code: string) {
    super(`agora 请求失败（${status}，${code}）`);
    this.name = 'AgoraHttpError';
  }
}
export function agoraHome(home?: string): string {
  return resolve(home ?? process.env.AGORA_HOME ?? join(homedir(), '.pi', 'agora'));
}
export function hmacProof(key: Uint8Array, values: string[]): string {
  return createHmac('sha256', key).update(JSON.stringify(values)).digest('base64url');
}
export function loopbackUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('agora 地址必须是 IPv4 本机 HTTP 地址');
  }
  return url.origin;
}

async function jsonRequest<T>(url: string, method: string, path: string, body: unknown,
  token: string | undefined, options: RequestOptions, closed?: AbortSignal): Promise<T> {
  if (!path.startsWith('/v1/') || path.includes('#') || path.includes('\\') || path.startsWith('//')) {
    throw new Error('agora 请求路径无效');
  }
  const target = new URL(path, url);
  if (target.origin !== url || !target.pathname.startsWith('/v1/')) throw new Error('agora 请求路径无效');
  const signals = [AbortSignal.timeout(options.timeoutMs ?? 35000), options.signal, closed].filter((s): s is AbortSignal => Boolean(s));
  let response: Response;
  try {
    response = await fetch(target, {
      method, redirect: 'error', signal: AbortSignal.any(signals),
      headers: { 'Agora-Protocol': '1', ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    if (options.signal?.aborted) throw new Error('agora 请求已取消');
    throw new AgoraConnectionError();
  }
  let data: unknown;
  try { data = await response.json(); } catch { throw new Error('agora 返回了无效响应'); }
  if (!response.ok) {
    const value = data as { error?: { code?: unknown } | string; code?: unknown };
    const raw = typeof value.error === 'object' ? value.error?.code : value.code ?? value.error;
    const code = typeof raw === 'string' && /^[a-z_]{1,64}$/.test(raw) ? raw : 'request_failed';
    throw new AgoraHttpError(response.status, code);
  }
  return data as T;
}

export function createClient(options: { url: string; token: string; connectionId?: string; instanceId?: string; expiresAt?: string }): AgoraClient {
  const url = loopbackUrl(options.url);
  const closed = new AbortController();
  let token = options.token;
  let expiresAt = options.expiresAt ?? '';
  return {
    url, get token() { return token; }, connectionId: options.connectionId ?? '',
    instanceId: options.instanceId ?? '', get expiresAt() { return expiresAt; },
    request: (method, path, body, requestOptions = {}) => jsonRequest(url, method, path, body, token, requestOptions, closed.signal),
    async refresh() {
      const next = await jsonRequest<{ token: string; expiresAt: string }>(url, 'POST', '/v1/auth/refresh', {}, token, {}, closed.signal);
      if (!next.token || !next.expiresAt) throw new Error('agora 凭证续期响应无效');
      token = next.token; expiresAt = next.expiresAt;
    },
    close: () => closed.abort(),
  };
}

interface Discovery { port: number; instanceId: string }
async function discover(home: string): Promise<Discovery | undefined> {
  try {
    const data = JSON.parse(await readFile(join(home, 'run', 'daemon.json'), 'utf8')) as Discovery;
    if (!Number.isInteger(data.port) || data.port < 1 || data.port > 65535 || typeof data.instanceId !== 'string') {
      throw new Error('agora 后台发现信息无效');
    }
    return data;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error('无法读取 agora 后台发现信息');
  }
}
async function startDaemon(home: string, entry: string): Promise<void> {
  await mkdir(join(home, 'logs'), { recursive: true });
  const log = await open(join(home, 'logs', 'startup.log'), 'a', 0o600);
  try {
    const child = spawn(process.execPath, [entry, '--home', home], {
      cwd: home, env: { ...process.env, AGORA_HOME: home },
      detached: true, windowsHide: true, shell: false, stdio: ['ignore', log.fd, log.fd],
    });
    await new Promise<void>((ok, fail) => { child.once('spawn', ok); child.once('error', fail); });
    child.unref();
  } catch { throw new Error('无法启动 agora 后台进程，请检查安装'); }
  finally { await log.close(); }
}

export interface ConnectHostOptions {
  home?: string;
  as: HostRole;
  signal?: AbortSignal;
  autoStart?: boolean;
  daemonEntry?: string;
  startupTimeoutMs?: number;
}
export async function connectHost(options: ConnectHostOptions): Promise<AgoraClient> {
  const home = agoraHome(options.home);
  const existing = await discover(home);
  if (existing) {
    try { return await authenticateHost(home, existing, options); }
    catch (error) { if (!(error instanceof AgoraConnectionError) || options.autoStart === false) throw error; }
  } else if (options.autoStart === false) throw new Error('agora 后台进程尚未启动');
  const entry = options.daemonEntry ?? fileURLToPath(new URL('../../daemon/dist/main.js', import.meta.url));
  await startDaemon(home, entry);
  const deadline = Date.now() + (options.startupTimeoutMs ?? 15000);
  while (Date.now() < deadline) {
    const discovery = await discover(home);
    if (discovery) {
      try { return await authenticateHost(home, discovery, options); }
      catch (error) { if (!(error instanceof AgoraConnectionError)) throw error; }
    }
    await delay(100, undefined, { signal: options.signal });
  }
  throw new Error('等待 agora 后台启动超时');
}
async function authenticateHost(home: string, discovery: Discovery, options: ConnectHostOptions): Promise<AgoraClient> {
  const url = loopbackUrl(`http://127.0.0.1:${discovery.port}`);
  let key: Buffer;
  try { key = await readFile(join(home, 'secret', 'host.key')); }
  catch { throw new Error('无法读取 agora 主机凭证'); }
  if (key.length !== 32) throw new Error('agora 主机凭证无效');
  const clientNonce = randomBytes(32).toString('base64url');
  const requestOptions = { signal: options.signal, timeoutMs: 5000 };
  const challenge = await jsonRequest<{ challengeId: string; serverNonce: string; instanceId: string; serverProof: string }>(
    url, 'POST', '/v1/auth/challenge', { clientNonce }, undefined, requestOptions);
  const expected = Buffer.from(hmacProof(key, ['server', clientNonce, challenge.instanceId]), 'base64url');
  const actual = Buffer.from(challenge.serverProof ?? '', 'base64url');
  if (challenge.instanceId !== discovery.instanceId || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error('agora 后台身份核验失败，已拒绝发送凭证');
  }
  const auth = await jsonRequest<{ token: string; connectionId: string; expiresAt: string }>(url, 'POST', '/v1/auth/token', {
    challengeId: challenge.challengeId, clientProof: hmacProof(key, ['client', challenge.serverNonce, challenge.instanceId]), as: options.as,
  }, undefined, requestOptions);
  if (!auth.token || !auth.connectionId) throw new Error('agora 登录响应无效');
  return createClient({ url, ...auth, instanceId: challenge.instanceId });
}

export async function connectLaunch<T>(url: string, ticket: string): Promise<{ client: AgoraClient; launch: T }> {
  url = loopbackUrl(url);
  const launch = await jsonRequest<T & { token: string }>(url, 'POST', '/v1/auth/launch', { ticket }, undefined, { timeoutMs: 10000 });
  if (!launch.token) throw new Error('agora 子会话登录响应无效');
  return { client: createClient({ url, token: launch.token }), launch };
}
