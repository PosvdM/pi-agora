import path from "node:path";
import { lstat, readdir, realpath, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { acquireInstanceLock, acquireSessionWriterLock, assertLocalFilesystem, currentProcessIdentity,
  isSessionWriterLock, probeSessionWriterLock, type SessionWriterLock } from "pi-hostkit";

function refuse(message: string): never { throw new Error(`离线删除已拒绝：${message}`); }
async function exactPath(file: string, directory: boolean): Promise<void> {
  const stat = await lstat(file);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) || path.relative(file, await realpath(file)) !== "") {
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
    }
  }
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
    const session = db.prepare("SELECT session_file,status,control_state FROM agora_sessions WHERE id=? LIMIT 1").get(sessionId) as {
      session_file: string; status: string; control_state: string | null;
    } | undefined;
    if (!session) refuse("会话不存在");
    if (!["completed", "failed", "stopped", "interrupted"].includes(session.status) || session.control_state) refuse("会话仍可运行或处于控制操作中");
    const activeRun = () => db!.prepare("SELECT id FROM process_runs WHERE agora_session_id=? AND (exited_at IS NULL OR state<>'exited' OR cleanup_error IS NOT NULL) LIMIT 1").get(sessionId);
    if (activeRun()) refuse("存在尚未明确清理完成的 run，请由 daemon 核对退出状态");
    const sessionFile = await checkedSessionFile(directory, session.session_file);
    const probe = await probeSessionWriterLock(sessionFile);
    if (probe.held || !probe.record || probe.record.state !== "released") refuse("无法证明旧写者已释放会话写锁；不采用进程或文件存在性推断");
    const acquired = await acquireSessionWriterLock(sessionFile, { app: "pi-agora", identity: currentProcessIdentity(`archive-delete-${sessionId}`) });
    if (!isSessionWriterLock(acquired)) refuse("会话写锁被占用");
    writer = acquired;
    if (!writer.previous || writer.previous.state !== "released") refuse("取得写锁后，旧写者释放证明发生变化");
    if (await writer.recoverPreviousWriter() !== "none") refuse("旧写者状态不能由只读维护核对");
    await noLinks(directory);
    // 删除前重新核对真实路径与数据库状态；锁的持有期覆盖删除和元数据提交。
    await exactPath(run, true);
    await exactPath(sessions, true);
    await exactPath(directory, true);
    if (await checkedSessionFile(directory, session.session_file) !== sessionFile) refuse("删除前会话真实路径发生变化");
    if (activeRun()) refuse("删除前发现未清理 run");
    db.exec("BEGIN IMMEDIATE");
    try {
      const latest = db.prepare("SELECT session_file,status,control_state FROM agora_sessions WHERE id=? LIMIT 1").get(sessionId) as typeof session;
      if (!latest || latest.session_file !== session.session_file || latest.status !== session.status || latest.control_state || activeRun()) refuse("删除前会话状态发生变化");
      const epoch = db.prepare("SELECT value FROM settings WHERE key='epoch' LIMIT 1").get() as { value: string } | undefined;
      if (!epoch?.value) refuse("变更流 epoch 缺失");
      // 先验证所有 SQL 可执行；文件删除失败时事务回滚，元数据仍保留。
      db.prepare("UPDATE agora_sessions SET archive_state='missing',revision=revision+1 WHERE id=?").run(sessionId);
      db.prepare("INSERT INTO changes(epoch,object_type,object_id,tombstone,created_at) VALUES(?,'session',?,0,?)").run(epoch.value, sessionId, new Date().toISOString());
      await rm(directory, { recursive: true, force: false });
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    return { sessionId, archiveState: "missing", deleted: true };
  } finally {
    try { db?.close(); }
    finally { try { await writer?.release(); } finally { await lock.release(); } }
  }
}
