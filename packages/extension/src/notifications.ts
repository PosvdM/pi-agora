import { open } from 'node:fs/promises';
import { AgoraHttpError, type AgoraClient } from '@pi-agora/protocol';
import type { PiExtensionApi, SessionContext, SessionEntry } from './types.js';

export interface Notice {
  noticeId: string;
  dedupeKey: string;
  kind: string;
  payload: { content?: string; summary?: string; taskId?: string; generation?: number; nodeId?: string; notify?: string; silent?: boolean; [key: string]: unknown };
}
function noticeEntry(entry: SessionEntry): boolean {
  return entry.type === 'custom_message' && entry.customType === 'agora:notice' &&
    typeof entry.details?.noticeId === 'string' && typeof entry.details.dedupeKey === 'string';
}

// 逆向读取完整 JSONL 行；尾部未换行的片段不能作为确认依据。
export async function persistedNotices(file: string, wanted: SessionEntry[]): Promise<Set<string>> {
  const found = new Set<string>();
  const pendingEntries = new Map(wanted.map(entry => [entry.id, entry]));
  if (!pendingEntries.size) return found;
  let handle;
  try { handle = await open(file, 'r'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return found; throw error; }
  try {
    let position = (await handle.stat()).size;
    let pending = Buffer.alloc(0);
    let discardTail = true;
    let skippingLine = false;
    const accept = (line: Buffer) => {
      try {
        const entry = JSON.parse(line.toString('utf8')) as SessionEntry;
        const memory = pendingEntries.get(entry.id);
        if (memory && noticeEntry(entry) && entry.details?.dedupeKey === memory.details?.dedupeKey &&
            entry.details?.noticeId === memory.details?.noticeId) {
          found.add(entry.id); pendingEntries.delete(entry.id);
        }
      } catch { /* 损坏的行不能证明通知已经落盘。 */ }
    };
    while (position > 0 && pendingEntries.size) {
      const size = Math.min(position, 65536);
      position -= size;
      const block = Buffer.allocUnsafe(size);
      const { bytesRead } = await handle.read(block, 0, size, position);
      if (bytesRead !== size) throw new Error('会话文件读取期间发生变化，暂不确认通知');
      const data = Buffer.concat([block, pending]);
      let end = data.length;
      for (let index = data.lastIndexOf(10); index >= 0; index = data.lastIndexOf(10, index - 1)) {
        const line = data.subarray(index + 1, end);
        if (discardTail) { discardTail = false; skippingLine = false; }
        else if (skippingLine) skippingLine = false;
        else accept(line);
        end = index;
        if (index === 0) break;
      }
      pending = data.subarray(0, end);
      // 其他工具的大图片或大结果不应阻止确认更早的通知；超过上限的整行跳过。
      if (skippingLine || pending.length > 4 * 1024 * 1024) { pending = Buffer.alloc(0); skippingLine = true; }
    }
    if (position === 0 && !discardTail && !skippingLine && pendingEntries.size) accept(pending);
    return found;
  } finally { await handle.close(); }
}

export class NoticeDelivery {
  private readonly injected = new Set<string>();
  private readonly acknowledged = new Set<string>();
  // 只确认当前连接从鉴权 inbox 收到的通知；fork 继承的历史条目不构成授权。
  private readonly pending = new Map<string, string>();
  private chain: Promise<unknown> = Promise.resolve();
  private closed = false;
  constructor(private readonly pi: PiExtensionApi, private readonly ctx: SessionContext,
    private client: AgoraClient, private readonly ephemeral: boolean) {}
  setClient(client: AgoraClient): void { this.client = client; }
  close(): void { this.closed = true; }
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(() => { if (this.closed) return undefined as T; return fn(); });
    this.chain = next.catch(() => {});
    return next;
  }
  private async confirmEntries(): Promise<void> {
    const entries = this.ctx.sessionManager.getEntries().filter(noticeEntry)
      .filter(entry => this.pending.get(entry.details!.noticeId as string) === entry.details!.dedupeKey &&
        !this.acknowledged.has(entry.details!.dedupeKey as string));
    const file = this.ctx.sessionManager.getSessionFile();
    const persisted = file ? await persistedNotices(file, entries) : new Set<string>();
    for (const entry of entries) {
      if (this.closed) return;
      if (this.acknowledged.has(entry.details!.dedupeKey as string)) continue;
      if (!this.ephemeral && !persisted.has(entry.id)) continue;
      try {
        await this.client.request('POST', '/v1/inbox/ack', {
          noticeId: entry.details!.noticeId, entryId: entry.id, persisted: !this.ephemeral,
        });
      } catch (error) {
        if (error instanceof AgoraHttpError && [404, 410].includes(error.status)) {
          this.pending.delete(entry.details!.noticeId as string);
          continue;
        }
        throw error;
      }
      this.pending.delete(entry.details!.noticeId as string);
      this.acknowledged.add(entry.details!.dedupeKey as string);
      this.injected.delete(entry.details!.dedupeKey as string);
    }
  }
  confirm(): Promise<void> { return this.serialize(() => this.confirmEntries()); }
  settled(): Promise<void> {
    return this.serialize(async () => {
      const entries = this.ctx.sessionManager.getEntries().filter(noticeEntry);
      for (const key of this.injected) if (!entries.some(entry => entry.details!.dedupeKey === key)) this.injected.delete(key);
      await this.confirmEntries();
    });
  }
  accept(items: Notice[]): Promise<void> {
    return this.serialize(async () => {
      for (const notice of items) {
        if (this.closed) return;
        if (!notice || typeof notice.noticeId !== 'string' || typeof notice.dedupeKey !== 'string' || !notice.payload) {
          throw new Error('agora 通知格式无效');
        }
        const key = notice.dedupeKey;
        if (this.acknowledged.has(key)) continue;
        this.pending.set(notice.noticeId, key);
        if (this.injected.has(key) ||
            this.ctx.sessionManager.getEntries().some(e => noticeEntry(e) && e.details!.dedupeKey === key)) continue;
        const p = notice.payload;
        const summary = String(p.content ?? p.summary ?? '').slice(0, 2000);
        const taskId = typeof p.taskId === 'string' ? p.taskId : undefined;
        const generation = Number.isSafeInteger(p.generation) && Number(p.generation) > 0 ? p.generation : undefined;
        const title = String(p.title ?? '未命名任务').slice(0, 200);
        const status = String(p.status ?? notice.kind.split(':').at(-1) ?? '未知').slice(0, 64);
        const resultCall = taskId && generation ? `agora_task ${JSON.stringify({ action: 'result', taskId, generation })}` : '此通知未附任务定位信息。';
        this.injected.add(key);
        try {
          this.pi.sendMessage({ customType: 'agora:notice', display: true,
            content: `【agora 子代理事件】任务：${taskId ?? '未提供'}；generation：${generation ?? '未提供'}；标题：${title}；状态：${status}\n取结果：${resultCall}\n摘要：${summary}`,
            details: { noticeId: notice.noticeId, dedupeKey: key, taskId: p.taskId, generation: p.generation, nodeId: p.nodeId } },
          { triggerTurn: p.triggerTurn === true || p.notify !== 'silent' && p.silent !== true, deliverAs: 'followUp' });
        } catch (error) { this.injected.delete(key); throw error; }
      }
      await this.confirmEntries();
    });
  }
}
