import path from "node:path";
import { lstat, readdir, realpath, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { AgoraError } from "./errors.js";
import type { Store, SessionRow } from "./store.js";
import type { SessionViews } from "./sessions.js";
import { acquireInstanceLock, acquireSessionWriterLock, assertLocalFilesystem, currentProcessIdentity,
  isSessionWriterLock, probeSessionWriterLock, type SessionWriterLock } from "pi-hostkit";

function refuse(message: string): never { throw new Error(`存档删除已拒绝：${message}`); }
async function exactPath(file: string, directory: boolean): Promise<void> {
  const stat = await lstat(file);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) || path.relative(file, await realpath(file)) !== "") {
    refuse(`路径不是普通${directory ? "目录" : "文件"}：${file}`);
  }
}
async function checkedSessionFile(directory: string, stored: string): Promise<string> {
  if (!path.isAbsolute(stored)) refuse("会话文件路径不是绝对路径");
  const file = await realpath(stored);
  if (path.relative(directory, path.dirname(file)) !== "") refuse("会话文件不在指定会话目录内");
  if ((await lstat(stored)).isSymbolicLink()) refuse("会话文件不能是链接");
  await exactPath(file, false);
  return file;
}
async function noLinks(directory: string): Promise<void> {
  const pending = [directory];
  let count = 0;
  while (pending.length) {
    const current = pending.pop()!;
    await exactPath(current, true);
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (++count > 20_000) refuse("会话目录项目过多，不能完成有界安全检查");
      if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) refuse("会话目录含链接或特殊文件");
      if (entry.isDirectory()) pending.push(path.join(current, entry.name));
      else await exactPath(path.join(current, entry.name), false);
    }
  }
}
/** 调用方持有 daemon 实例锁及目标任务控制队列；会话写锁独立取得。 */
export async function deleteArchiveOnline(options: {
  store: Store; sessions: SessionViews; sessionId: string; expectedRevision: number; authorize(): void;
}): Promise<{ sessionId: string; archiveState: "missing"; deleted: true }> {
  const { store, sessions, sessionId, expectedRevision } = options;
  if (store.db.isTransaction) throw new AgoraError(409, "transaction_active", "存档删除不能在数据库事务中执行");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) throw new AgoraError(400, "invalid_params", "会话 ID 格式无效");
  const original = store.session(sessionId);
  const check = (): SessionRow => {
    options.authorize();
    const row = store.session(sessionId);
    if (row.revision !== expectedRevision || row.session_file !== original.session_file || row.task_id !== original.task_id) throw new AgoraError(409, "conflict", "会话状态或版本已变化，请重新确认");
    if (!["completed", "failed", "stopped", "interrupted"].includes(row.status) || row.control_state) throw new AgoraError(409, "archive_busy", "会话仍可运行或处于控制操作中");
    if (store.get("SELECT id FROM process_runs WHERE agora_session_id=? AND (exited_at IS NULL OR state<>'exited' OR cleanup_error IS NOT NULL) LIMIT 1", sessionId)) throw new AgoraError(409, "archive_busy", "存在尚未明确清理完成的 run");
    return row;
  };
  check();
  const releaseView = await sessions.prepareArchiveDeletion(sessionId);
  let writer: SessionWriterLock | undefined;
  try {
    check();
    const home = await realpath(path.resolve(store.home));
    assertLocalFilesystem(home);
    const root = path.join(home, "sessions"), directory = path.join(root, sessionId);
    await exactPath(root, true); await exactPath(directory, true);
    const file = await checkedSessionFile(directory, original.session_file);
    writer = await archiveWriter(file, sessionId);
    await noLinks(directory);
    await exactPath(root, true); await exactPath(directory, true);
    if (await checkedSessionFile(directory, original.session_file) !== file) refuse("删除前会话真实路径发生变化");
    check();
    let removalError: unknown;
    try { await rm(directory, { recursive: true, force: false }); }
    catch (error) { removalError = error; }
    store.transaction(() => {
      store.run("UPDATE agora_sessions SET archive_state=?,archive_error=?,revision=revision+1 WHERE id=?", removalError ? "suspect" : "missing", removalError ? "archive_delete_failed" : null, sessionId);
      store.change("session", sessionId);
    });
    if (removalError) throw new AgoraError(500, "archive_delete_failed", "存档删除未完成，请检查会话目录与诊断");
    return { sessionId, archiveState: "missing", deleted: true };
  } catch (error) {
    if (error instanceof AgoraError) throw error;
    throw new AgoraError(409, "archive_delete_refused", error instanceof Error ? error.message : "无法核对存档删除条件");
  } finally {
    releaseView();
    await writer?.release();
  }
}
async function archiveWriter(file: string, sessionId: string): Promise<SessionWriterLock> {
  const probe = await probeSessionWriterLock(file);
  if (probe.held || !probe.record || probe.record.state !== "released") refuse("无法证明旧写者已释放会话写锁；不采用进程或文件存在性推断");
  const acquired = await acquireSessionWriterLock(file, { app: "pi-agora", identity: currentProcessIdentity(`archive-delete-${sessionId}`) });
  if (!isSessionWriterLock(acquired)) refuse("会话写锁被占用");
  try {
    if (!acquired.previous || acquired.previous.state !== "released") refuse("取得写锁后，旧写者释放证明发生变化");
    if (await acquired.recoverPreviousWriter() !== "none") refuse("旧写者状态不能由只读维护核对");
    return acquired;
  } catch (error) { await acquired.release(); throw error; }
}
/** 持有 daemon 与会话写锁；不迁移数据库、不停止进程、不根据 PID 猜测写者状态。 */
export async function deleteArchiveOffline(options: { home: string; sessionId: string }): Promise<{
  sessionId: string; archiveState: "missing"; deleted: true;
}> {
  const { sessionId } = options;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) refuse("会话 ID 格式无效");
  const home = await realpath(path.resolve(options.home));
  assertLocalFilesystem(home);
  const run = path.join(home, "run"), sessions = path.join(home, "sessions"), directory = path.join(sessions, sessionId);
  await exactPath(run, true);
  await exactPath(sessions, true);
  await exactPath(directory, true);
  const lock = await acquireInstanceLock("daemon", run);
  if (!lock) refuse("daemon 实例锁被占用，请先正常关闭 daemon");
  let db: DatabaseSync | undefined, writer: SessionWriterLock | undefined;
  try {
    const database = path.join(home, "agora.db");
    await exactPath(database, false);
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      try { await exactPath(`${database}${suffix}`, false); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    db = new DatabaseSync(database, { enableForeignKeyConstraints: true });
    const version = Number((db.prepare("SELECT version FROM schema_version LIMIT 1").get() as { version?: number } | undefined)?.version);
    if (![4, 5, 6].includes(version)) refuse("数据库版本未通过维护接口核对");
    // 在不可逆文件操作前验证诊断字段和变更流所需的 SQL。
    const metadata = db.prepare("UPDATE agora_sessions SET archive_state=?,archive_error=?,revision=revision+1 WHERE id=?");
    const change = db.prepare("INSERT INTO changes(epoch,object_type,object_id,tombstone,created_at) VALUES(?,'session',?,0,?)");
    const session = db.prepare("SELECT session_file,status,control_state FROM agora_sessions WHERE id=? LIMIT 1").get(sessionId) as {
      session_file: string; status: string; control_state: string | null;
    } | undefined;
    if (!session) refuse("会话不存在");
    if (!["completed", "failed", "stopped", "interrupted"].includes(session.status) || session.control_state) refuse("会话仍可运行或处于控制操作中");
    const activeRun = () => db!.prepare("SELECT id FROM process_runs WHERE agora_session_id=? AND (exited_at IS NULL OR state<>'exited' OR cleanup_error IS NOT NULL) LIMIT 1").get(sessionId);
    if (activeRun()) refuse("存在尚未明确清理完成的 run，请由 daemon 核对退出状态");
    const sessionFile = await checkedSessionFile(directory, session.session_file);
    writer = await archiveWriter(sessionFile, sessionId);
    await noLinks(directory);
    // 删除前重新核对真实路径与数据库状态；锁的持有期覆盖删除和元数据提交。
    await exactPath(run, true);
    await exactPath(sessions, true);
    await exactPath(directory, true);
    if (await checkedSessionFile(directory, session.session_file) !== sessionFile) refuse("删除前会话真实路径发生变化");
    if (activeRun()) refuse("删除前发现未清理 run");
    const latest = db.prepare("SELECT session_file,status,control_state FROM agora_sessions WHERE id=? LIMIT 1").get(sessionId) as typeof session;
    if (!latest || latest.session_file !== session.session_file || latest.status !== session.status || latest.control_state || activeRun()) refuse("删除前会话状态发生变化");
    const epoch = db.prepare("SELECT value FROM settings WHERE key='epoch' LIMIT 1").get() as { value: string } | undefined;
    if (!epoch?.value) refuse("变更流 epoch 缺失");
    let removalError: unknown;
    try { await rm(directory, { recursive: true, force: false }); }
    catch (error) { removalError = error; }
    // 文件系统与数据库分别提交；部分删除也要留下可诊断状态，不能报告成功。
    db.exec("BEGIN IMMEDIATE");
    try {
      metadata.run(removalError ? "suspect" : "missing", removalError ? "archive_delete_failed" : null, sessionId);
      change.run(epoch.value, sessionId, new Date().toISOString());
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    if (removalError) throw removalError;
    return { sessionId, archiveState: "missing", deleted: true };
  } finally {
    try { db?.close(); }
    finally { try { await writer?.release(); } finally { await lock.release(); } }
  }
}
