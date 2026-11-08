import type { Auth, Connection } from './auth.js';
import { AgoraError } from './errors.js';
import type { Store, TaskRow } from './store.js';

import type { UserExecutionProof } from './budgets.js';
export function confirmationRequired(action: string, target: string, params: Record<string, unknown>): never {
  throw new AgoraError(403, 'confirmation_required', '此操作需要用户确认', { action, target, params });
}
export function isHost(conn: Connection): boolean { return conn.type.startsWith('host:'); }

type TaskAction = 'status' | 'result' | 'steer' | 'cleanup' | 'stop' | 'recover' | 'limits' | 'takeover';
interface QuestionResource { asker_id: string; target_id: string; state: string; task_id: string | null }
export class AccessControl {
  constructor(readonly store: Store, readonly auth: Auth) {}
  actor(conn: Connection): string {
    this.auth.requireAgent(conn);
    return conn.principalId!;
  }
  ownsTree(conn: Connection, task: TaskRow): boolean {
    if (task.convener_id === conn.principalId) return true;
    if (conn.type !== 'agent:main') return false;
    let ancestor = task;
    while (ancestor.parent_task_id) {
      if (ancestor.taken_over_from) return false;
      ancestor = this.store.task(ancestor.parent_task_id);
      if (ancestor.convener_id === conn.principalId) return true;
    }
    return false;
  }
  private taskBoundary(conn: Connection, task: TaskRow): void {
    if (isHost(conn)) return;
    let current = task, inside = false;
    while (true) {
      if (this.store.session(current.agora_session_id).principal_id === conn.principalId) inside = true;
      if (current.taken_over_from && !inside) throw new AgoraError(403, 'task_taken_over', '任务已被用户接管，原召集人不能管理该任务或其子树', { taskId: current.id });
      if (!current.parent_task_id) return;
      current = this.store.task(current.parent_task_id);
    }
  }
  reachable(principalId: string): boolean {
    const principal = this.store.principal(principalId);
    if (principal?.type === 'agent:main') return !!principal.lease_connection_id && (principal.lease_expires_at ?? 0) > Date.now();
    return !!this.store.get("SELECT r.id FROM process_runs r JOIN agora_sessions s ON s.id=r.agora_session_id WHERE s.principal_id=? AND r.state='ready' AND r.exited_at IS NULL LIMIT 1", principalId);
  }
  task(conn: Connection, task: TaskRow, action: TaskAction, body: Record<string, unknown> = {}, proof?: UserExecutionProof): void {
    this.actor(conn);
    this.taskBoundary(conn, task);
    // 整树操作在任何停止或预算副作用前检查接管边界。
    if (!isHost(conn) && (action === 'stop' || action === 'limits' && typeof body.maxTokens === 'number' && body.maxTokens < task.max_tokens)) {
      const boundaries = this.store.all<TaskRow>(`WITH RECURSIVE subtree(id) AS (
        SELECT ? UNION ALL SELECT t.id FROM tasks t JOIN subtree s ON t.parent_task_id=s.id
      ) SELECT t.* FROM tasks t JOIN subtree s ON t.id=s.id WHERE t.taken_over_from IS NOT NULL`, task.id);
      for (const boundary of boundaries) this.taskBoundary(conn, boundary);
    }
    if (isHost(conn)) {
      if (['status', 'result', 'stop', 'cleanup'].includes(action)) return;
      if (action === 'takeover') {
        if (!proof) confirmationRequired('agora.task.takeover', task.id, body);
        return;
      }
      if (action === 'steer' && task.convener_id === 'user') return;
      if (action === 'recover' || action === 'limits') {
        if (task.convener_id !== 'user') throw new AgoraError(403, this.reachable(task.convener_id) ? 'convener_reachable' : 'takeover_required', '请由直接召集人操作，或先由用户显式接管');
        if (action === 'recover' && !proof) confirmationRequired('agora.task.recover', task.id, body);
        return;
      }
    } else {
      if (action !== 'takeover' && task.convener_id === conn.principalId) return;
      if (conn.type === 'agent:main' && ['status', 'result', 'stop'].includes(action) && this.ownsTree(conn, task)) return;
      if (conn.type === 'agent:child' && action === 'status' && this.store.session(task.agora_session_id).principal_id === conn.principalId) return;
    }
    throw new AgoraError(403, 'forbidden', '此操作只允许直接召集人执行');
  }
  question(conn: Connection, row: QuestionResource, action: 'read' | 'answer' | 'cancel' | 'escalate', body: Record<string, unknown> = {}, proof?: UserExecutionProof, target = ''): void {
    const actor = this.actor(conn);
    if (action === 'read' && (isHost(conn) || actor === row.asker_id)) return;
    if (!isHost(conn)) {
      const task = row.task_id ? this.store.task(row.task_id) : this.store.get<TaskRow>('SELECT t.* FROM tasks t JOIN agora_sessions s ON s.task_id=t.id WHERE s.principal_id=?', row.asker_id);
      if (task) this.taskBoundary(conn, task);
    }
    if (action === 'read' && actor === row.target_id) return;
    if (proof && isHost(conn) && (action === 'answer' || action === 'cancel')) return;
    if (isHost(conn) && (action === 'answer' || action === 'cancel')) confirmationRequired(`agora.request.${action}`, target, body);
    if (!isHost(conn)) {
      if (action === 'cancel' && row.target_id !== 'user' && row.state !== 'escalated' && (actor === row.asker_id || actor === row.target_id)) return;
      if (action !== 'cancel' && action !== 'read' && row.target_id !== 'user' && actor === row.target_id) return;
    }
    throw new AgoraError(403, 'forbidden', '只有当前接收方可以答复或转交，转给用户的问题须由用户确认处理');
  }
}
