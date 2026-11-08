import { AgoraError, invalid, object, text } from './errors.js';
import type { Auth, Connection } from './auth.js';
import { Store, id, now } from './store.js';
import type { TaskManager } from './tasks.js';

import type { RequestQuestion } from '@pi-agora/protocol';
export interface RequestRow {
  id: string; asker_id: string; target_id: string; task_id: string | null;
  questions: string; context: string | null; state: string; route: string;
  answers: string | null; answered_by: string | null; expires_at: string | null;
  revision: number; created_at: string; updated_at: string;
}
function questionsOf(value: unknown): RequestQuestion[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3) invalid('提问必须有 1 到 3 题');
  const seen = new Set<string>();
  return value.map(raw => {
    const q = object(raw);
    const question: RequestQuestion = { id: text(q.id, 'id', 128), question: text(q.question, 'question', 16000) };
    if (seen.has(question.id)) invalid('题目标识不能重复');
    for (const key of ['header', 'detail'] as const) if (q[key] !== undefined) question[key] = text(q[key], key, 16000);
    for (const key of ['multiSelect', 'allowCustom'] as const) {
      if (q[key] !== undefined && typeof q[key] !== 'boolean') invalid(`${key} 必须为布尔值`);
      if (typeof q[key] === 'boolean') question[key] = q[key];
    }
    if (q.options !== undefined) {
      if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 4) invalid('选项数量必须为 2 到 4');
      question.options = q.options.map(item => {
        const option = object(item), result: NonNullable<RequestQuestion['options']>[number] = { label: text(option.label, 'label', 512) };
        for (const key of ['description', 'preview'] as const) if (option[key] !== undefined) result[key] = text(option[key], key, 16000);
        if (option.recommended !== undefined && typeof option.recommended !== 'boolean') invalid('recommended 必须为布尔值');
        if (typeof option.recommended === 'boolean') result.recommended = option.recommended;
        return result;
      });
      if (new Set(question.options.map(x => x.label)).size !== question.options.length) invalid('选项不能重复');
    }
    if (q.dependsOn !== undefined) {
      const dep = object(q.dependsOn), questionId = text(dep.questionId, 'questionId', 128);
      if (!seen.has(questionId)) invalid('dependsOn 必须指向前面的题目');
      if (dep.value !== undefined && typeof dep.value !== 'string' && (!Array.isArray(dep.value) || !dep.value.every(v => typeof v === 'string'))) invalid('依赖答案无效');
      question.dependsOn = { questionId, value: dep.value as string | string[] | undefined };
    }
    seen.add(question.id);
    return question;
  });
}
function answersOf(questions: RequestQuestion[], value: unknown) {
  if (!Array.isArray(value) || value.length > 3) invalid('答复必须为数组');
  const supplied = new Map<string, { id: string; selected: string[]; custom?: string }>();
  for (const raw of value) {
    const answer = object(raw), id = text(answer.id, 'id', 128);
    if (supplied.has(id) || !questions.some(q => q.id === id)) invalid('答复题目标识无效或重复');
    if (!Array.isArray(answer.selected) || !answer.selected.every(v => typeof v === 'string') || new Set(answer.selected).size !== answer.selected.length) invalid('选择答案无效');
    supplied.set(id, { id, selected: answer.selected as string[], ...(answer.custom === undefined ? {} : { custom: text(answer.custom, 'custom', 16000) }) });
  }
  for (const q of questions) {
    const answer = supplied.get(q.id), dep = q.dependsOn;
    const previous = dep ? supplied.get(dep.questionId) : undefined;
    const matches = !dep || !!previous && (dep.value === undefined || (Array.isArray(dep.value) ? dep.value : [dep.value]).some(v => previous.selected.includes(v) || previous.custom === v));
    if (!matches) { if (answer) invalid('不能答复尚未显示的题目'); continue; }
    if (!answer || !answer.selected.length && !answer.custom) invalid('每道显示的题目都需要答复');
    if (!q.multiSelect && answer.selected.length > 1 || answer.selected.some(v => !q.options?.some(o => o.label === v)) || q.allowCustom === false && answer.custom !== undefined) invalid('答复不符合题目选项或自定义输入限制');
  }
  return [...supplied.values()];
}
export class Requests {
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  constructor(readonly store: Store, readonly auth: Auth, readonly tasks: TaskManager) { this.arm(); }
  close(): void { this.closed = true; if (this.timer) clearTimeout(this.timer); }
  private arm(): void {
    if (this.closed) return;
    if (this.timer) clearTimeout(this.timer);
    const next = this.store.get<{ expires_at: string }>("SELECT expires_at FROM requests WHERE state IN ('open','escalated') AND target_id!='user' AND expires_at IS NOT NULL ORDER BY expires_at LIMIT 1");
    if (!next) return;
    this.timer = setTimeout(() => { this.expire(); this.arm(); }, Math.min(2_147_483_647, Math.max(1, Date.parse(next.expires_at) - Date.now())));
    this.timer.unref();
  }
  private expire(): void {
    while (true) {
      const rows = this.store.all<RequestRow>("SELECT * FROM requests WHERE state IN ('open','escalated') AND target_id!='user' AND expires_at<=? ORDER BY expires_at LIMIT 200", now());
      if (!rows.length) break;
      for (const row of rows) {
        this.store.transaction(() => {
          this.store.run("UPDATE requests SET state='expired',revision=revision+1,updated_at=? WHERE id=? AND revision=?", now(), row.id, row.revision);
          this.store.notice(row.asker_id, `request:${row.id}:expired`, "request:expired", { requestId: row.id, taskId: row.task_id, state: "expired", summary: `提问 ${row.id} 已过期，未获答复不表示同意，请停在安全状态。` });
          this.store.change("request", row.id);
        });
        this.tasks.wake(row.asker_id);
      }
    }
  }
  private get(id: string): RequestRow {
    const row = this.store.get<RequestRow>('SELECT * FROM requests WHERE id=?', id);
    if (!row) throw new AgoraError(404, 'not_found', '提问不存在');
    return row;
  }
  private actor(conn: Connection): string {
    this.auth.requireAgent(conn);
    return conn.type.startsWith('host:') ? 'user' : conn.principalId!;
  }
  private view(row: RequestRow) {
    return { id: row.id, askerId: row.asker_id, targetId: row.target_id, taskId: row.task_id,
      questions: JSON.parse(row.questions), context: row.context, state: row.state,
      route: JSON.parse(row.route), answers: row.answers ? JSON.parse(row.answers) : undefined,
      answeredBy: row.answered_by, expiresAt: row.expires_at, revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at,
      ...(row.answered_by === 'user' ? { answeredVia: { confirmedBy: 'none', requestedBy: 'host:cli' } } : {}) };
  }
  detail(conn: Connection, id: string) {
    this.expire();
    const actor = this.actor(conn), row = this.get(id);
    if (actor !== 'user' && actor !== row.asker_id && actor !== row.target_id) throw new AgoraError(403, 'forbidden', '不能访问其他会话的提问');
    return this.view(row);
  }
  list(conn: Connection, states: string[] = [], limit = 50, cursor = 0, taskId?: string) {
    this.expire();
    const actor = this.actor(conn);
    if (taskId !== undefined) text(taskId, 'taskId', 128);
    const rows = this.store.all<RequestRow & { cursor: number }>(`SELECT rowid AS cursor,* FROM requests WHERE rowid>? AND (?='user' OR asker_id=? OR target_id=?) AND (? IS NULL OR task_id=?) ${states.length ? `AND state IN (${states.map(() => '?').join(',')})` : ''} ORDER BY rowid LIMIT ?`, cursor, actor, actor, actor, taskId ?? null, taskId ?? null, ...states, limit + 1);
    return { items: rows.slice(0, limit).map(row => this.view(row)), nextCursor: rows.length > limit ? String(rows[limit - 1]!.cursor) : null };
  }
  ask(conn: Connection, body: Record<string, unknown>) {
    const asker = this.actor(conn);
    if (asker === 'user') throw new AgoraError(403, 'forbidden', '此端点仅供 Agent 提问');
    const questions = questionsOf(body.questions), context = body.context === undefined ? null : text(body.context, 'context', 32000);
    const session = this.store.get<{ task_id: string; convener_id: string }>('SELECT t.id AS task_id,t.convener_id FROM agora_sessions s JOIN tasks t ON t.id=s.task_id WHERE s.principal_id=?', asker);
    const target = session?.convener_id ?? 'user', requestId = id('rq'), at = now();
    const expires = body.expiresAt === undefined ? null : text(body.expiresAt, 'expiresAt', 64);
    if (expires !== null && (!Number.isFinite(Date.parse(expires)) || Date.parse(expires) <= Date.now())) invalid('expiresAt 必须为将来的有效时间');
    this.store.transaction(() => {
      this.store.run('INSERT INTO requests(id,asker_id,target_id,task_id,questions,context,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)', requestId, asker, target, session?.task_id ?? null, JSON.stringify(questions), context, at, at);
      this.store.notice(target, `request:${requestId}:opened`, 'request:opened', { requestId, taskId: session?.task_id, questions, context, summary: `提问 ${requestId}：${questions.map(q => q.question).join('；')}` });
      if (expires !== null) this.store.run('UPDATE requests SET expires_at=? WHERE id=?', new Date(expires).toISOString(), requestId);
      this.store.change('request', requestId);
    });
    this.arm();
    this.tasks.wake(target);
    return this.view(this.get(requestId));
  }
  update(conn: Connection, requestId: string, action: string, body: Record<string, unknown>) {
    this.expire();
    const actor = this.actor(conn), row = this.get(requestId);
    if (!['open', 'escalated'].includes(row.state)) throw new AgoraError(409, 'already_handled', '提问已经处理');
    if (body.expectedRevision !== undefined && body.expectedRevision !== row.revision) throw new AgoraError(409, 'conflict', '提问状态已变化');
    if (actor !== 'user' && actor !== row.target_id && !(action === 'cancel' && actor === row.asker_id)) throw new AgoraError(403, 'forbidden', '只有当前接收方可以答复或转交');
    if (actor === 'user' && conn.type !== 'host:cli') throw new AgoraError(403, 'forbidden', '切片 1b 只提供 CLI 答复通路');
    const answers = action === 'answer' ? answersOf(JSON.parse(row.questions), body.answers) : undefined;
    if (!['answer', 'escalate', 'cancel'].includes(action)) invalid('提问动作无效');
    let target = row.target_id;
    if (action === 'escalate') {
      if (actor === 'user') throw new AgoraError(403, 'forbidden', '提问已转给用户');
      target = this.store.get<{ convener_id: string }>('SELECT t.convener_id FROM agora_sessions s JOIN tasks t ON t.id=s.task_id WHERE s.principal_id=?', actor)?.convener_id ?? 'user';
    }
    const state = action === 'answer' ? 'answered' : action === 'cancel' ? 'cancelled' : 'escalated';
    this.store.transaction(() => {
      const changed = this.store.run('UPDATE requests SET state=?,target_id=?,route=?,answers=?,answered_by=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?', state, target, action === 'escalate' ? JSON.stringify([...JSON.parse(row.route), actor]) : row.route, answers ? JSON.stringify(answers) : null, action === 'answer' ? actor : null, now(), requestId, row.revision);
      if (!changed.changes) throw new AgoraError(409, 'already_handled', '提问已经处理');
      const recipient = action === 'escalate' ? target : row.asker_id;
      this.store.notice(recipient, `request:${requestId}:${action === 'escalate' ? `escalated:${row.revision}` : state}`, `request:${state}`, { requestId, taskId: row.task_id, state, questions: JSON.parse(row.questions), answers, summary: action === 'escalate' ? `提问 ${requestId} 已逐级转交，请答复或继续转交。` : action === 'cancel' ? `提问 ${requestId} 未获答复，取消不代表批准。请停在安全状态。` : `提问 ${requestId} 已答复：${JSON.stringify(answers)}` });
      this.store.run('UPDATE outbox SET processed_at=? WHERE dedupe_key=?', now(), `request:${requestId}:opened`);
      this.store.change('request', requestId);
    });
    this.arm();
    this.tasks.wake(action === 'escalate' ? target : row.asker_id);
    return this.view(this.get(requestId));
  }
}
