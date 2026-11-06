import { mkdir, realpath, readFile, writeFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { acquireInstanceLock, assertLocalFilesystem } from "pi-hostkit";
import { Auth, proof } from "./auth.js";
import { AgoraError } from "./errors.js";
import { openStore, id, type Store } from "./store.js";
import { TaskManager } from "./tasks.js";
import { createHttpServer, VERSION, PROTOCOL_RANGE } from "./server.js";
import { RpcSubprocessDriver, type SessionDriver } from "./driver.js";

export interface DaemonOptions {
  home: string; piPath?: string; extensionPath?: string; maxConcurrentRuns?: number;
  readyTimeoutMs?: number; env?: NodeJS.ProcessEnv; containment?: "auto" | "snapshot";
  /** 独立测试驱动不通过生产环境变量或 HTTP 配置注入。 */
  driver?: SessionDriver;
}
export interface RunningDaemon {
  url: string; instanceId: string; store: Store; auth: Auth; tasks: TaskManager;
  close(options?: { force?: boolean; timeoutMs?: number }): Promise<void>;
}
export function childEnvironment(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && !["AGORA_HOME", "PI_PANE_HOME", "AGORA_URL", "AGORA_LAUNCH_TICKET"].includes(key.toUpperCase())) result[key] = value;
  }
  return result;
}
async function existingDaemon(home: string): Promise<never> {
  try {
    const discovered = JSON.parse(await readFile(path.join(home, "run", "daemon.json"), "utf8")) as { port: number; instanceId: string };
    if (!Number.isInteger(discovered.port) || discovered.port < 1 || discovered.port > 65535) throw new Error("发现信息无效");
    const key = await readFile(path.join(home, "secret", "host.key"));
    const clientNonce = randomBytes(32).toString("base64url");
    const url = `http://127.0.0.1:${discovered.port}`;
    const response = await fetch(`${url}/v1/auth/challenge`, { method: "POST", redirect: "error", headers: { "Content-Type": "application/json", "Agora-Protocol": "1" }, body: JSON.stringify({ clientNonce }), signal: AbortSignal.timeout(3000) });
    const challenge = await response.json() as { instanceId: string; serverProof: string };
    const expected = Buffer.from(proof(key, ["server", clientNonce, discovered.instanceId]));
    const actual = Buffer.from(challenge.serverProof ?? "");
    if (!response.ok || challenge.instanceId !== discovered.instanceId || actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("实例证明无效");
    throw new AgoraError(409, "daemon_running", "daemon 已运行，请连接现有实例", { url, instanceId: discovered.instanceId });
  } catch (error) {
    if (error instanceof AgoraError) throw error;
    throw new AgoraError(409, "daemon_busy", "daemon 锁已被占用，但现有实例无法认证；请检查正在启动或退出的后台进程");
  }
}

export async function startDaemon(options: DaemonOptions): Promise<RunningDaemon> {
  await mkdir(path.resolve(options.home), { recursive: true });
  const home = await realpath(path.resolve(options.home));
  assertLocalFilesystem(home);
  const runDirectory = path.join(home, "run");
  await mkdir(runDirectory, { recursive: true });
  const lock = await acquireInstanceLock("daemon", runDirectory);
  if (!lock) return existingDaemon(home);
  let store: Store | undefined;
  let server: ReturnType<typeof createHttpServer> | undefined;
  const closing = new AbortController();
  const instanceId = id("in");
  const discoveryFile = path.join(runDirectory, "daemon.json");
  const temporaryFile = `${discoveryFile}.${instanceId}.tmp`;
  try {
    store = await openStore(home);
    const auth = await Auth.create(store, instanceId);
    store.run("UPDATE operations SET state='failed',status=409,result=? WHERE state='in_progress'", JSON.stringify({ error: { code: "operation_interrupted", message: "操作被 daemon 重启中断，请核对任务状态" } }));
    const driver = options.driver ?? new RpcSubprocessDriver({ home, piPath: options.piPath,
      extensionPath: options.extensionPath ?? fileURLToPath(new URL("../../extension/dist/index.js", import.meta.url)),
      env: childEnvironment(options.env), containment: options.containment, readyTimeoutMs: options.readyTimeoutMs });
    const taskOptions = { home, instanceId, url: "", maxConcurrentRuns: options.maxConcurrentRuns, readyTimeoutMs: options.readyTimeoutMs };
    const tasks = new TaskManager(store, auth, driver, taskOptions);
    await tasks.recoverPreviousRuns();
    let closePromise: Promise<void> | undefined;
    const close = (opts: { force?: boolean; timeoutMs?: number } = {}): Promise<void> => {
      if (closePromise) return closePromise;
      if (opts.timeoutMs !== undefined && (!Number.isInteger(opts.timeoutMs) || opts.timeoutMs < 1 || opts.timeoutMs > 2_147_483_647)) return Promise.reject(new AgoraError(400, "invalid_params", "关闭超时无效"));
      closePromise = (async () => {
        await tasks.shutdown(opts.force ?? false, opts.timeoutMs ?? 600_000);
        closing.abort();
        await new Promise<void>((resolve, reject) => {
          server!.close(error => error ? reject(error) : resolve());
          server!.closeIdleConnections();
        });
        // 出口事件在停止期间排入控制队列，先让这些数据库写入完成。
        await tasks.flush();
        const discovery = await readFile(discoveryFile, "utf8").then(value => JSON.parse(value) as { instanceId: string }, () => undefined);
        if (discovery?.instanceId === instanceId) await unlink(discoveryFile);
        store!.close();
        await lock.release();
      })().catch(error => { closePromise = undefined; throw error; });
      return closePromise;
    };
    server = createHttpServer({ store, auth, tasks, instanceId, close, closing: closing.signal });
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(0, "127.0.0.1", () => { server!.off("error", reject); resolve(); });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("daemon 监听地址无效");
    const url = `http://127.0.0.1:${address.port}`;
    taskOptions.url = url;
    await writeFile(temporaryFile, JSON.stringify({ port: address.port, pid: process.pid, instanceId, daemonVersion: VERSION, protocol: PROTOCOL_RANGE }), { flag: "wx", mode: 0o600 });
    await rename(temporaryFile, discoveryFile);
    tasks.startQueue();
    return { url, instanceId, store, auth, tasks, close };
  } catch (error) {
    closing.abort();
    if (server?.listening) await new Promise<void>(resolve => { server!.close(() => resolve()); server!.closeAllConnections(); });
    await unlink(temporaryFile).catch(() => {});
    store?.close();
    await lock.release();
    throw error;
  }
}

export { Auth, proof } from "./auth.js";
export { Store, openStore, consistentBackup, SCHEMA_VERSION } from "./store.js";
export { AgoraError } from "./errors.js";
export { RpcSubprocessDriver } from "./driver.js";
export type { DriverHandle, SessionDriver, LaunchSpec } from "./driver.js";
