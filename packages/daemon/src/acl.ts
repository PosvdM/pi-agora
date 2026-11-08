import type { Auth, Connection } from './auth.js';
import { AgoraError } from './errors.js';
import type { Store, TaskRow } from './store.js';

import type { UserExecutionProof } from './budgets.js';
export function confirmationRequired(action: string, target: string, params: Record<string, unknown>): never {
  throw new AgoraError(403, 'confirmation_required', '此操作需要用户确认', { action, target, params });
}
export function isHost(conn: Connection): boolean { return conn.type.startsWith('host:'); }

type TaskAction = 'status' | 'result' | 'steer' | 'cleanup' | 'stop' | 'recover' | 'limits' | 'takeover';
interface QuestionResource { asker_id: string; target_id: string; state: string }
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
      ancestor = this.store.task(ancestor.parent_task_id);
      if (ancestor.convener_id === conn.principalId) return true;
    }
    return false;
  }
  reachable(principalId: string): boolean {
    const principal = this.store.principal(principalId);
    if (principal?.type === 'agent:main') return !!principal.lease_connection_id && (principal.lease_expires_at ?? 0) > Date.now();
    return !!this.store.get("SELECT r.id FROM process_runs r JOIN agora_sessions s ON s.id=r.agora_session_id WHERE s.principal_id=? AND r.state='ready' AND r.exited_at IS NULL LIMIT 1", principalId);
  }
  task(conn: Connection, task: TaskRow, action: TaskAction, body: Record<string, unknown> = {}, proof?: UserExecutionProof): void {
    this.actor(conn);
    if (isHost(conn)) {
      if (['status', 'result', 'stop', 'cleanup'].includes(action)) return;
      if (action === 'takeover') {
        if (task.convener_id !== 'user' && this.reachable(task.convener_id)) throw new AgoraError(403, 'convener_reachable', '直接召集人仍可达，不能接管任务');
        if (!proof || proof.confirmedBy !== 'device') confirmationRequired('agora.task.takeover', task.id, body);
        return;
      }
      if (action === 'recover' || action === 'limits') {
        if (task.convener_id !== 'user') throw new AgoraError(403, this.reachable(task.convener_id) ? 'convener_reachable' : 'takeover_required', '请由直接召集人操作；不可达时须先由用户确认接管');
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
    if (action === 'read' && (isHost(conn) || actor === row.asker_id || actor === row.target_id)) return;
    if (proof && isHost(conn) && (action === 'answer' || action === 'cancel')) return;
    if (isHost(conn) && (action === 'answer' || action === 'cancel')) confirmationRequired(`agora.request.${action}`, target, body);
    if (!isHost(conn)) {
      if (action === 'cancel' && row.target_id !== 'user' && row.state !== 'escalated' && (actor === row.asker_id || actor === row.target_id)) return;
      if (action !== 'cancel' && action !== 'read' && row.target_id !== 'user' && actor === row.target_id) return;
    }
    throw new AgoraError(403, 'forbidden', '只有当前接收方可以答复或转交，转给用户的问题须由用户确认处理');
  }
}
