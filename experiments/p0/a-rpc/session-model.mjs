import { randomUUID } from 'node:crypto';

const copy = value => structuredClone(value);
// custom_message has entry metadata instead of message.timestamp; match its stored payload.
const key = message => message.role === 'custom'
  ? JSON.stringify(['custom_message', message.customType, message.content ?? [], message.display, message.details ?? null])
  : JSON.stringify(['message', message]);

function entryKey(entry) {
  if (entry.type === 'message') return key(entry.message);
  if (entry.type === 'custom_message') return key({ role: 'custom', ...entry });
  return undefined;
}
export function emptyState() { return { entries: [], leafId: null, inFlight: { active: null, completed: [] } }; }

export function reduce(state, event) {
  if (event.type === 'pane_entries') {
    const ids = new Set(state.entries.map(e => e.id));
    for (const entry of event.entries) if (!ids.has(entry.id)) { state.entries.push(copy(entry)); ids.add(entry.id); }
    state.leafId = event.leafId;
    const persisted = new Set(state.entries.map(entryKey).filter(k => k !== undefined));
    state.inFlight.completed = state.inFlight.completed.filter(m => !persisted.has(key(m)));
  }
  if (event.type === 'message_start' && event.message.role === 'assistant') state.inFlight.active = copy(event.message);
  if (event.type === 'message_update') {
    const delta = event.assistantMessageEvent;
    const active = state.inFlight.active;
    if (!active) return;
    const index = delta.contentIndex;
    if (delta.type === 'text_start') active.content[index] = { type: 'text', text: '' };
    if (delta.type === 'thinking_start') active.content[index] = { type: 'thinking', thinking: '' };
    if (delta.type === 'toolcall_start') active.content[index] = { type: 'toolCall', id: delta.id, name: delta.toolName, argumentsText: '' };
    if (delta.type === 'toolcall_delta' && active.content[index]) active.content[index].argumentsText += delta.delta;
    if (delta.type === 'toolcall_end') active.content[index] = copy(delta.toolCall);
    if (delta.type === 'text_delta' && active.content[index]) active.content[index].text += delta.delta;
    if (delta.type === 'thinking_delta' && active.content[index]) active.content[index].thinking += delta.delta;
    if (delta.type === 'text_end') active.content[index] = { type: 'text', text: delta.content };
    if (delta.type === 'thinking_end') active.content[index] = { type: 'thinking', thinking: delta.content };
  }
  if (event.type === 'message_end') {
    const persisted = state.entries.some(e => entryKey(e) === key(event.message));
    if (!persisted) state.inFlight.completed.push(copy(event.message));
    if (event.message.role === 'assistant') state.inFlight.active = null;
  }
}

// Each stdout callback applies its mutation and allocates the cursor synchronously.
export class SessionModel {
  epoch = randomUUID();
  seq = 0;
  state = emptyState();
  buffer = [];
  snapshots = [];
  pending = new Set();
  chain = Promise.resolve();
  failures = [];
  cuts = [];
  constructor(rpc) {
    this.rpc = rpc;
    this.off = rpc.onEvent((event, raw) => {
      if (event.type === 'response') {
        if (this.pending.delete(event.id) && event.success) {
          this.emit({ type: 'pane_entries', ...event.data });
          this.cuts.push({ rawSeq: raw.seq, entries: event.data.entries.map(e => e.id), leafId: event.data.leafId });
        }
      } else {
        this.emit(event);
        if (['message_end', 'entry_appended', 'compaction_end', 'session_info_changed', 'agent_settled'].includes(event.type)) this.refresh();
      }
    });
  }
  emit(event) {
    reduce(this.state, event);
    this.buffer.push({ cursor: { epoch: this.epoch, seq: ++this.seq }, event: copy(event) });
    this.snapshots.push(this.snapshot());
  }
  refresh() {
    this.chain = this.chain.then(async () => {
      const id = 'model-' + randomUUID();
      this.pending.add(id);
      const since = this.state.entries.at(-1)?.id;
      const result = await this.rpc.command({ type: 'get_entries', id, ...(since ? { since } : {}) });
      if (!result.success) throw new Error(JSON.stringify(result));
    }).catch(error => this.failures.push(String(error)));
    return this.chain;
  }
  snapshot() { return { ...copy(this.state), cursor: { epoch: this.epoch, seq: this.seq } }; }
  subscribe(cursor) {
    if (cursor.epoch !== this.epoch || cursor.seq > this.seq || cursor.seq < (this.buffer[0]?.cursor.seq ?? 1) - 1) return { type: 'resync' };
    return this.buffer.filter(record => record.cursor.seq > cursor.seq);
  }
  async flush() { for (;;) { const chain = this.chain; await chain; if (chain === this.chain) break; } }
  dispose() { this.off(); }
}
