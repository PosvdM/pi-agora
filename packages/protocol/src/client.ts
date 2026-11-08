import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { open, readFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { isFetchForbiddenPort } from './ports.js';

export const PROTOCOL_VERSION = 1;
export const PROTOCOL_RANGE = { min: 1, max: 1 } as const;
export interface ProtocolRange { min: number; max: number }

export function negotiateProtocol(remote: ProtocolRange, local: ProtocolRange = PROTOCOL_RANGE): number {
  const valid = (range: ProtocolRange) => Number.isSafeInteger(range.min) && Number.isSafeInteger(range.max) && range.min >= 1 && range.min <= range.max;
  if (!valid(remote) || !valid(local) || Math.max(local.min, remote.min) > Math.min(local.max, remote.max)) {
    throw new Error('协议版本不兼容，请运行 agora shutdown 后启动兼容版本');
  }
  return Math.min(local.max, remote.max);
}

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
  readonly fetchForbidden: boolean;
  constructor(options?: ErrorOptions & { port?: number }) {
    const codes = connectionErrorCodes(options?.cause);
    const fetchForbidden = options?.port !== undefined && isFetchForbiddenPort(options.port) || isBadPortError(options?.cause);
    super(fetchForbidden
      ? `无法连接 agora，端口${options?.port === undefined ? '' : ` ${options.port}`} 被 Fetch 禁止，请重启后台进程`
      : `无法连接 agora，请检查后台进程${codes.length ? `（${codes.join('，')}）` : ''}`, options);
    this.name = 'AgoraConnectionError';
    this.fetchForbidden = fetchForbidden;
  }
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
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('agora 地址无效'); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('agora 地址必须是 IPv4 本机 HTTP 地址');
  }
  return url.origin;
}

function assertActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('agora 请求已取消');
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
// 诊断遍历不参与重试判定，避免嵌套错误改变请求策略。
function connectionErrorCodes(error: unknown): string[] {
  const pending = [error];
  const seen = new Set<object>();
  const codes = new Set<string>();
  for (let index = 0; index < pending.length; index++) {
    const value = pending[index];
    if (!record(value) || seen.has(value)) continue;
    seen.add(value);
    if (typeof value.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value.code)) codes.add(value.code);
    pending.push(value.cause);
    if (value instanceof AggregateError) pending.push(...value.errors);
  }
  return [...codes];
}
function isBadPortError(error: unknown): boolean {
  const pending = [error];
  const seen = new Set<object>();
  for (let index = 0; index < pending.length; index++) {
    const value = pending[index];
    if (!record(value) || seen.has(value)) continue;
    seen.add(value);
    if (value.message === 'bad port') return true;
    pending.push(value.cause);
    if (value instanceof AggregateError) pending.push(...value.errors);
  }
  return false;
}
function isTransportError(error: unknown): boolean {
  const codes = ['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'EAI_AGAIN',
    'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'];
  return record(error) && (codes.includes(String(error.code)) ||
    (record(error.cause) && codes.includes(String(error.cause.code))));
}

async function jsonRequest<T>(url: string, method: string, path: string, body: unknown,
  token: string | undefined, options: RequestOptions, closed?: AbortSignal, protocolVersion: number | null = PROTOCOL_VERSION): Promise<T> {
  assertActive(options.signal);
  if (!path.startsWith('/v1/') || path.includes('#') || path.includes('\\') || path.startsWith('//')) {
    throw new Error('agora 请求路径无效');
  }
  const target = new URL(path, url);
  if (target.origin !== url || !target.pathname.startsWith('/v1/')) throw new Error('agora 请求路径无效');
  const requestSignal = options.signal;
  const idempotencyKey = options.idempotencyKey;
  const signal = AbortSignal.any([AbortSignal.timeout(options.timeoutMs ?? 35000), requestSignal, closed]
    .filter((s): s is AbortSignal => Boolean(s)));
  const verb = method.toUpperCase();
  const authPath = target.pathname.startsWith('/v1/auth/');
  // 一次性凭证不能重放；业务写入必须由调用方提供原幂等键。
  const retryable = (verb === 'POST' && ['/v1/auth/refresh', '/v1/lease/renew'].includes(target.pathname)) ||
    (!authPath && (verb === 'GET' || Boolean(idempotencyKey)));
  // 每次发送共用身份、参数和总期限，避免结果未知时变成另一笔业务。
  const headers = { ...(protocolVersion === null ? {} : { 'Agora-Protocol': String(protocolVersion) }),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) };
  const payload = body === undefined ? undefined : JSON.stringify(body);
  for (let attempt = 0; ; attempt++) {
    assertActive(requestSignal);
    if (signal.aborted) throw new AgoraConnectionError();
    let response: Response | undefined;
    let text: string;
    try {
      response = await fetch(target, { method, redirect: 'error', signal, headers, body: payload });
      text = await response.text();
    } catch (error) {
      assertActive(requestSignal);
      if (isFetchForbiddenPort(Number(target.port)) || isBadPortError(error)) {
        throw new AgoraConnectionError({ cause: error, port: Number(target.port) });
      }
      const transportError = isTransportError(error);
      // 至多发送三次；收到 HTTP 拒绝后，即使正文中断也不重试。
      if (retryable && attempt < 2 && !signal.aborted && transportError && (!response || response.ok)) {
        try { await delay(50 * (attempt + 1), undefined, { signal }); }
        catch (delayError) { assertActive(requestSignal); throw new AgoraConnectionError({ cause: delayError }); }
        continue;
      }
      if (response && !transportError && !signal.aborted) throw new Error('agora 返回了无效响应');
      throw new AgoraConnectionError({ cause: error });
    }
    let data: unknown;
    try { data = JSON.parse(text); } catch { throw new Error('agora 返回了无效响应'); }
    if (!response.ok) {
      const value = record(data) ? data : {};
      const raw = record(value.error) ? value.error.code : value.code ?? value.error;
      const code = typeof raw === 'string' && /^[a-z_]{1,64}$/.test(raw) ? raw : 'request_failed';
      throw new AgoraHttpError(response.status, code);
    }
    return data as T;
  }
}

async function connectionProtocol(url: string, options: RequestOptions, expectedInstanceId?: string): Promise<{ protocolVersion: number; instanceId: string }> {
  const health = await jsonRequest<unknown>(url, 'GET', '/v1/health', undefined, undefined, options, undefined, null);
  if (!record(health) || !nonempty(health.daemonVersion) || !nonempty(health.instanceId) || !record(health.protocol) ||
      typeof health.protocol.min !== 'number' || typeof health.protocol.max !== 'number') throw new Error('agora 健康检查响应无效');
  if (expectedInstanceId !== undefined && health.instanceId !== expectedInstanceId) {
    throw new Error('agora 后台身份核验失败，已拒绝发送凭证');
  }
  return { protocolVersion: negotiateProtocol({ min: health.protocol.min, max: health.protocol.max }), instanceId: health.instanceId };
}

export function createClient(options: { url: string; token: string; connectionId?: string; instanceId?: string; expiresAt?: string; protocolVersion?: number }): AgoraClient {
  const url = loopbackUrl(options.url);
  const protocolVersion = options.protocolVersion ?? PROTOCOL_VERSION;
  const closed = new AbortController();
  let token = options.token;
  let expiresAt = options.expiresAt ?? '';
  return {
    url, get token() { return token; }, connectionId: options.connectionId ?? '',
    instanceId: options.instanceId ?? '', get expiresAt() { return expiresAt; },
    request: (method, path, body, requestOptions = {}) => jsonRequest(url, method, path, body, token, requestOptions, closed.signal, protocolVersion),
    async refresh() {
      const next = await jsonRequest<{ token: string; expiresAt: string }>(url, 'POST', '/v1/auth/refresh', {}, token, {}, closed.signal, protocolVersion);
      if (!record(next) || !nonempty(next.token) || !nonempty(next.expiresAt) || !Number.isFinite(Date.parse(next.expiresAt))) {
        throw new Error('agora 凭证续期响应无效');
      }
      token = next.token; expiresAt = next.expiresAt;
    },
    close: () => closed.abort(),
  };
}

interface Discovery { port: number; instanceId: string }
async function discover(home: string, signal?: AbortSignal): Promise<Discovery | undefined> {
  // daemon 原子发布；同时容忍外部非原子写入造成的短暂截断，不将畸形内容用于认证。
  for (let attempt = 0; ; attempt++) {
    assertActive(signal);
    try {
      const data = JSON.parse(await readFile(join(home, 'run', 'daemon.json'), 'utf8')) as Discovery;
      if (!record(data) || !Number.isInteger(data.port) || data.port < 1 || data.port > 65535 || !nonempty(data.instanceId)) {
        throw new Error('agora 后台发现信息无效');
      }
      return data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      if (!(error instanceof SyntaxError) || attempt >= 9) throw new Error('无法读取 agora 后台发现信息');
      try { await delay(50, undefined, { signal }); } catch { assertActive(signal); throw new Error('无法读取 agora 后台发现信息'); }
    }
  }
}
async function startDaemon(home: string, entry: string, signal?: AbortSignal): Promise<void> {
  assertActive(signal);
  await mkdir(join(home, 'logs'), { recursive: true });
  const log = await open(join(home, 'logs', 'startup.log'), 'a', 0o600);
  try {
    assertActive(signal);
    const child = spawn(process.execPath, [entry, '--home', home], {
      cwd: home, env: { ...process.env, AGORA_HOME: home },
      detached: true, windowsHide: true, shell: false, stdio: ['ignore', log.fd, log.fd],
    });
    await new Promise<void>((ok, fail) => { child.once('spawn', ok); child.once('error', fail); });
    child.unref();
  } catch { assertActive(signal); throw new Error('无法启动 agora 后台进程，请检查安装'); }
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
  assertActive(options.signal);
  const home = agoraHome(options.home);
  const existing = await discover(home, options.signal);
  if (existing) {
    try { return await authenticateHost(home, existing, options); }
    catch (error) { if (!(error instanceof AgoraConnectionError) || error.fetchForbidden || options.autoStart === false) throw error; }
  } else if (options.autoStart === false) throw new Error('agora 后台进程尚未启动');
  const entry = options.daemonEntry ?? fileURLToPath(new URL('../../daemon/dist/main.js', import.meta.url));
  await startDaemon(home, entry, options.signal);
  const deadline = Date.now() + (options.startupTimeoutMs ?? 15000);
  while (Date.now() < deadline) {
    const discovery = await discover(home, options.signal);
    if (discovery) {
      try { return await authenticateHost(home, discovery, options, deadline); }
      catch (error) { if (!(error instanceof AgoraConnectionError) || error.fetchForbidden) throw error; }
    }
    await delay(100, undefined, { signal: options.signal });
  }
  throw new Error('等待 agora 后台启动超时');
}
async function authenticateHost(home: string, discovery: Discovery, options: ConnectHostOptions, deadline?: number): Promise<AgoraClient> {
  assertActive(options.signal);
  const url = loopbackUrl(`http://127.0.0.1:${discovery.port}`);
  let key: Buffer;
  try { key = await readFile(join(home, 'secret', 'host.key')); }
  catch { throw new Error('无法读取 agora 主机凭证'); }
  if (key.length !== 32) throw new Error('agora 主机凭证无效');
  const clientNonce = randomBytes(32).toString('base64url');
  const requestOptions = { signal: options.signal, timeoutMs: Math.max(1, Math.min(5000, (deadline ?? Date.now() + 5000) - Date.now())) };
  const { protocolVersion } = await connectionProtocol(url, requestOptions, discovery.instanceId);
  const challenge = await jsonRequest<{ challengeId: string; serverNonce: string; instanceId: string; serverProof: string }>(
    url, 'POST', '/v1/auth/challenge', { clientNonce }, undefined, requestOptions, undefined, protocolVersion);
  if (!record(challenge) || !nonempty(challenge.challengeId) || !nonempty(challenge.serverNonce) ||
      !nonempty(challenge.instanceId) || !nonempty(challenge.serverProof)) throw new Error('agora 握手响应无效');
  const expected = Buffer.from(hmacProof(key, ['server', clientNonce, challenge.instanceId]), 'base64url');
  const actual = Buffer.from(challenge.serverProof ?? '', 'base64url');
  if (challenge.instanceId !== discovery.instanceId || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error('agora 后台身份核验失败，已拒绝发送凭证');
  }
  const auth = await jsonRequest<{ token: string; connectionId: string; expiresAt: string }>(url, 'POST', '/v1/auth/token', {
    challengeId: challenge.challengeId, clientProof: hmacProof(key, ['client', challenge.serverNonce, challenge.instanceId]), as: options.as,
  }, undefined, requestOptions, undefined, protocolVersion);
  if (!record(auth) || !nonempty(auth.token) || !nonempty(auth.connectionId) || !nonempty(auth.expiresAt) ||
      !Number.isFinite(Date.parse(auth.expiresAt))) throw new Error('agora 登录响应无效');
  return createClient({ url, token: auth.token, connectionId: auth.connectionId, expiresAt: auth.expiresAt,
    instanceId: challenge.instanceId, protocolVersion });
}

export async function connectLaunch<T>(url: string, ticket: string): Promise<{ client: AgoraClient; launch: T }> {
  url = loopbackUrl(url);
  const options = { timeoutMs: 10000 };
  const { protocolVersion, instanceId } = await connectionProtocol(url, options);
  const launch = await jsonRequest<T & { token: string; expiresAt?: unknown; connectionId?: unknown }>(url, 'POST', '/v1/auth/launch', { ticket }, undefined, options, undefined, protocolVersion);
  if (!record(launch) || !nonempty(launch.token)) throw new Error('agora 子会话登录响应无效');
  if (launch.expiresAt !== undefined && (!nonempty(launch.expiresAt) || !Number.isFinite(Date.parse(launch.expiresAt)))) throw new Error('agora 子会话凭证期限无效');
  return { client: createClient({ url, token: launch.token, expiresAt: launch.expiresAt as string | undefined,
    connectionId: typeof launch.connectionId === 'string' ? launch.connectionId : undefined, protocolVersion, instanceId }), launch };
}
