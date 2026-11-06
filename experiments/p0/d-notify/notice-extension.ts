import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentSession, SessionManager } from '@earendil-works/pi-coding-agent';

export default function (pi) {
  const root = process.env.P0_NOTIFY_ROOT;
  const controlPath = join(root, 'control.json');
  const control = () => JSON.parse(readFileSync(controlPath, 'utf8'));
  const log = (data) => appendFileSync(join(root, 'extension.jsonl'), JSON.stringify({ pid: process.pid, ...data }) + '\n');
  const entriesOnDisk = (file) => {
    if (!file || !existsSync(file)) return [];
    return readFileSync(file, 'utf8').split('\n').slice(0, -1).map(line => JSON.parse(line));
  };
  let ctx;
  let timer;
  let chain = Promise.resolve();
  const injected = new Set();
  const acknowledged = new Set();
  let armed = true;
  async function waitForRelease(name, signal) {
    const deadline = Date.now() + 12000;
    while (!existsSync(join(root, name))) {
      signal?.throwIfAborted();
      if (Date.now() >= deadline) throw new Error(`P0 barrier ${name} timed out`);
      await delay(10);
    }
  }
  pi.on('provider_stream_event', async (event, context) => {
    if (!control().busyBarrier || event.data.type !== 'text_end' || event.data.content !== 'P0 busy held') return;
    log({ kind: 'busy_blocked' });
    await waitForRelease('release-busy', context.signal);
    log({ kind: 'busy_released' });
  });
  function killAt(point, extra = {}) {
    if (!armed || control().fault !== point) return;
    armed = false;
    log({ kind: 'fault', point, ...extra });
    process.kill(process.pid, 'SIGKILL');
  }
  const originalEmit = AgentSession.prototype._emit;
  AgentSession.prototype._emit = function (event) {
    const result = originalEmit.call(this, event);
    if (event.type === 'message_end' && event.message.customType === 'agora:notice') {
      log({ kind: 'public_dispatched', dedupeKey: event.message.details.dedupeKey });
    }
    return result;
  };
  // The wrapper changes only this child process and runs at the real persistence boundary.
  const originalAppend = SessionManager.prototype.appendCustomMessageEntry;
  SessionManager.prototype.appendCustomMessageEntry = function (customType, content, display, details) {
    if (customType === 'agora:notice') killAt('public-before-persist', {
      dedupeKey: details.dedupeKey,
      diskCount: entriesOnDisk(this.getSessionFile()).filter(e => e.details?.dedupeKey === details.dedupeKey).length,
    });
    return originalAppend.call(this, customType, content, display, details);
  };
  async function api(path, body) {
    const response = await fetch(control().url + path, {
      method: body ? 'POST' : 'GET',
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }
  async function confirm() {
    if (!ctx) return;
    const sessionFile = ctx.sessionManager.getSessionFile();
    const disk = entriesOnDisk(sessionFile);
    for (const entry of ctx.sessionManager.getEntries()) {
      const key = entry.details?.dedupeKey;
      if (entry.type !== 'custom_message' || entry.customType !== 'agora:notice' || !key || acknowledged.has(key)) continue;
      if (!disk.some(e => e.id === entry.id && e.type === 'custom_message' && e.details?.dedupeKey === key)) continue;
      if (control().fault === 'daemon-before-ack' && armed) {
        armed = false;
        log({ kind: 'before_ack', dedupeKey: key, entryId: entry.id, onDisk: true });
        await waitForRelease('release-ack');
      }
      await api('/ack', { dedupeKey: key, entryId: entry.id, sessionFile });
      acknowledged.add(key);
      log({ kind: 'acked', dedupeKey: key, entryId: entry.id });
    }
  }
  async function poll() {
    if (!ctx) return;
    await confirm();
    const notices = await api('/inbox');
    for (const notice of notices) {
      const key = notice.dedupeKey;
      const entry = ctx.sessionManager.getEntries().find(e => e.type === 'custom_message' && e.customType === 'agora:notice' && e.details?.dedupeKey === key);
      if (entry || injected.has(key)) {
        log({ kind: 'deduped', dedupeKey: key, inEntries: Boolean(entry), inFlight: injected.has(key) });
        continue;
      }
      injected.add(key);
      log({ kind: 'inject', dedupeKey: key, silent: Boolean(notice.silent), idle: ctx.isIdle() });
      pi.sendMessage({ customType: 'agora:notice', content: `P0 notice ${key}`, display: true, details: { dedupeKey: key, noticeId: key } }, {
        triggerTurn: !notice.silent, deliverAs: 'followUp',
      });
      if (notice.silent) {
        log({ kind: 'silent_returned', dedupeKey: key,
          memoryCount: ctx.sessionManager.getEntries().filter(e => e.details?.dedupeKey === key).length,
          diskCount: entriesOnDisk(ctx.sessionManager.getSessionFile()).filter(e => e.details?.dedupeKey === key).length });
        killAt('silent-after-send');
      }
    }
    await confirm();
  }
  function serialize(fn) {
    const result = chain.then(fn);
    chain = result.catch(error => log({ kind: 'transport_error', error: String(error) }));
    return chain;
  }
  pi.on('session_start', async (_event, context) => {
    ctx = context;
    log({ kind: 'session_start', sessionFile: ctx.sessionManager.getSessionFile() });
    if (control().auto) await serialize(poll);
    timer = setInterval(() => { if (control().auto) void serialize(poll); }, 50);
  });
  pi.on('session_shutdown', () => {
    clearInterval(timer);
    SessionManager.prototype.appendCustomMessageEntry = originalAppend;
    AgentSession.prototype._emit = originalEmit;
  });
  pi.on('message_end', (event, context) => {
    if (event.message.customType !== 'agora:notice') return;
    const key = event.message.details.dedupeKey;
    log({ kind: 'extension_message_end', dedupeKey: key,
      memoryCount: context.sessionManager.getEntries().filter(e => e.details?.dedupeKey === key).length,
      diskCount: entriesOnDisk(context.sessionManager.getSessionFile()).filter(e => e.details?.dedupeKey === key).length });
    killAt('extension-message-end', { dedupeKey: key });
  });
  pi.on('turn_end', async () => { await serialize(confirm); });
  pi.on('agent_settled', async (_event, context) => {
    log({ kind: 'settled' });
    for (const key of injected) {
      if (!context.sessionManager.getEntries().some(e => e.type === 'custom_message' && e.details?.dedupeKey === key)) {
        injected.delete(key);
        log({ kind: 'reset_inflight', dedupeKey: key });
      }
    }
    await serialize(control().auto ? poll : confirm);
  });
  pi.registerCommand('p0-poll', { description: 'Poll the isolated P0 outbox', handler: async () => { await serialize(poll); } });
  pi.registerCommand('p0-snapshot', { description: 'Record isolated P0 session entries', handler: async (_args, context) => {
    log({ kind: 'snapshot', entries: context.sessionManager.getEntries().filter(e => e.customType === 'agora:notice'), disk: entriesOnDisk(context.sessionManager.getSessionFile()).filter(e => e.customType === 'agora:notice') });
  } });
}
