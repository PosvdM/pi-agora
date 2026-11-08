import type { Connection } from './auth.js';
import { confirmationRequired, isHost } from './acl.js';
import { AgoraError, invalid } from './errors.js';
import { id, now, type Store, type TaskRow, type UsageSummary } from './store.js';

// 只接受服务端验签后传入的证明；请求 body 中的同名字段没有授权意义。
export interface UserExecutionProof {
  deviceId: string;
  confirmationId: string;
  requestedBy: string;
  confirmedBy: 'device' | 'none';
}
export interface BudgetOptions {
  taskLimitDefaults?: { maxTokens: number };
  agentLimitCap?: { perTaskFactor: number; dailyTokens: number };
  tokenAccounting?: 'all' | 'uncached';
}
export function budgetConfig(store: Store, options: BudgetOptions = {}) {
  function setting<T>(key: string, fallback: T): T {
    const row = store.get<{ value: string }>('SELECT value FROM settings WHERE key=?', key);
    return row ? JSON.parse(row.value) as T : fallback;
  }
  const defaults = setting('taskLimitDefaults', options.taskLimitDefaults ?? { maxTokens: 2_000_000 });
  const cap = setting('agentLimitCap', options.agentLimitCap ?? { perTaskFactor: 2, dailyTokens: 6_000_000 });
  const accounting = setting('tokenAccounting', options.tokenAccounting ?? 'all');
  if (!Number.isSafeInteger(defaults.maxTokens) || defaults.maxTokens < 1 || !Number.isFinite(cap.perTaskFactor) || cap.perTaskFactor < 1 || !Number.isSafeInteger(cap.dailyTokens) || cap.dailyTokens < 1 || !['all', 'uncached'].includes(accounting)) throw new Error('任务预算配置无效');
  return { defaults, cap, accounting };
}
export function countTokens(usage: UsageSummary, accounting: 'all' | 'uncached'): number {
  return usage.inputTokens + usage.cacheWriteTokens + usage.outputTokens + (accounting === 'all' ? usage.cacheReadTokens : 0);
}
export function localBudgetDay(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
export class Budgets {
  constructor(readonly store: Store, readonly options: BudgetOptions) {}
  atomic<T>(fn: () => T): T { return this.store.db.isTransaction ? fn() : this.store.transaction(fn); }
  max(task: TaskRow): number { return (task as TaskRow & { max_tokens: number }).max_tokens; }
  amount(value: unknown, fallback: number): number {
    if (value === undefined) return fallback;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) invalid('maxTokens 必须为正的安全整数');
    return value;
  }
  lineage(task: TaskRow): TaskRow[] {
    const rows = [task];
    while (rows.at(-1)!.parent_task_id) rows.push(this.store.task(rows.at(-1)!.parent_task_id!));
    return rows;
  }
  used(task: TaskRow): number { return countTokens(this.store.usage(task.id, true), budgetConfig(this.store, this.options).accounting); }
  exhausted(task: TaskRow): TaskRow[] { return this.lineage(task).filter(row => this.used(row) >= this.max(row)); }
  blocked(task: TaskRow): boolean {
    return this.lineage(task).some(row => row.status === 'budget_paused' || this.used(row) >= this.max(row));
  }
  requireAvailable(task: TaskRow, recovering = false): void {
    const blocked = this.lineage(task).find(row => (!recovering || row.id !== task.id) && row.status === 'budget_paused' || this.used(row) >= this.max(row));
    if (blocked) throw new AgoraError(409, 'budget_exhausted', '任务或祖先预算不足，请增额并由直接召集人明确恢复', { taskId: blocked.id, budget: this.view(blocked) });
  }
  view(task: TaskRow) {
    const config = budgetConfig(this.store, this.options), usedTokens = this.used(task);
    const ancestors = this.lineage(task).slice(1).map(row => ({ taskId: row.id, maxTokens: this.max(row), usedTokens: this.used(row), paused: row.status === 'budget_paused' }));
    return { maxTokens: this.max(task), usedTokens, remainingTokens: Math.max(0, this.max(task) - usedTokens), tokenAccounting: config.accounting, ancestors };
  }
  checkChild(parent: TaskRow, maxTokens: number): void {
    if (this.lineage(parent).some(row => maxTokens > this.max(row))) throw new AgoraError(403, 'budget_limit_exceeded', '下级预算不能超过任何祖先预算');
  }
  // 调用方必须将检查、授予与任务写入放在同一个 BEGIN IMMEDIATE 事务中。
  checkGrant(conn: Connection, taskId: string, maxTokens: number, delta: number, body: Record<string, unknown>, action: 'spawn' | 'limits', proof?: UserExecutionProof) {
    const config = budgetConfig(this.store, this.options);
    const signed = conn.type !== 'agent:child' && proof?.confirmedBy === 'device';
    const day = localBudgetDay();
    const daily = this.store.get<{ tokens: number }>("SELECT COALESCE(SUM(tokens),0) AS tokens FROM budget_grants WHERE day=? AND confirmed_by!='device'", day)!.tokens;
    const cap = config.defaults.maxTokens * (isHost(conn) ? 1 : config.cap.perTaskFactor);
    if (!signed && (maxTokens > cap || delta > config.cap.dailyTokens - daily)) confirmationRequired(`agora.task.${action}`, action === 'spawn' ? 'new' : taskId, body);
    return { signed, day };
  }
  grant(conn: Connection, taskId: string, maxTokens: number, delta: number, body: Record<string, unknown>, action: 'spawn' | 'limits', proof?: UserExecutionProof): void {
    const { signed, day } = this.checkGrant(conn, taskId, maxTokens, delta, body, action, proof);
    this.store.run('INSERT INTO budget_grants(id,resource_id,principal_id,day,tokens,confirmed_by,created_at) VALUES(?,?,?,?,?,?,?)', id('bg'), taskId, conn.principalId!, day, delta, signed ? 'device' : 'none', now());
  }
}
