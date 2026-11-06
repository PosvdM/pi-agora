import { appendFileSync, existsSync, readFileSync, writeFileSync, unlinkSync, watch } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

export default function (pi) {
  const root = process.env.P0_A_ROOT!;
  const config = () => JSON.parse(readFileSync(join(root, 'control.json'), 'utf8'));
  const record = (data) => appendFileSync(join(root, 'extension.jsonl'), JSON.stringify(data) + '\n');
  const log = (event, ctx) => record({ ...event, file: ctx.sessionManager.getSessionFile(),
    targetExists: event.targetSessionFile ? existsSync(event.targetSessionFile) : null });
  for (const name of ['session_start', 'session_shutdown', 'session_before_switch', 'session_before_fork']) {
    pi.on(name, (event, ctx) => {
      log(event, ctx);
      ctx.ui.notify('P0_LIFECYCLE:' + JSON.stringify({ ...event, file: ctx.sessionManager.getSessionFile() }));
      const c = config();
      if (name === 'session_before_switch' || name === 'session_before_fork') {
        if (c.cancelAll || (c.cancelResume && event.reason === 'resume')) return { cancel: true };
      }
      if (name === 'session_start' && event.previousSessionFile && c.lockProbe) {
        const oldLock = join(root, 'lock-' + event.previousSessionFile.split(/[\\/]/).pop());
        if (existsSync(oldLock)) unlinkSync(oldLock);
      }
      if (c.lockProbe && event.targetSessionFile &&
          ((name === 'session_before_switch' && event.reason === 'resume') ||
           (name === 'session_shutdown' && event.reason !== 'resume'))) {
        const lockFile = join(root, 'lock-' + event.targetSessionFile.split(/[\\/]/).pop());
        if (c.forceLockFailure && !existsSync(lockFile)) writeFileSync(lockFile, 'occupied');
        try {
          writeFileSync(lockFile, '', { flag: 'wx' });
          record({ type: 'lock_result', at: name, acquired: true, target: event.targetSessionFile });
        } catch (error) {
          record({ type: 'lock_result', at: name, acquired: false, target: event.targetSessionFile, error: error.code });
          if (name === 'session_before_switch') return { cancel: true };
        }
      }
    });
  }
  let barrierSequence = 0;
  pi.on('provider_stream_event', async (event, ctx) => {
    if (!config().streamBarrier || event.data.type !== 'text_delta' || event.data.delta !== ' beta') return;
    const name = 'stream-release-' + process.pid + '-' + (++barrierSequence);
    const path = join(root, name);
    record({ type: 'stream_barrier', name });
    ctx.ui.notify('P0_BARRIER:' + name);
    await new Promise<void>((resolve, reject) => {
      let done = false;
      let timer;
      const signal = ctx.signal;
      const finish = (error?) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        watcher.close();
        signal?.removeEventListener('abort', abort);
        if (error) reject(error); else resolve();
      };
      const check = () => { if (existsSync(path)) finish(); };
      const abort = () => finish(signal?.reason ?? new Error('barrier aborted'));
      const watcher = watch(root, check);
      watcher.once('error', finish);
      timer = setTimeout(() => finish(new Error('stream barrier deadline exceeded')), 10000);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort(); else check();
    });
  });
  pi.registerCommand('p0-notify', { description: 'P0 custom message', handler: args => {
    pi.sendMessage({ customType: 'p0-notice', content: 'NOTICE_' + args, display: true,
      details: { dedupeKey: 'notice-' + args } }, { triggerTurn: args === 'wake', deliverAs: 'followUp' });
  }});
  pi.on('message_end', (event, ctx) => {
    const entries = ctx.sessionManager.getEntries();
    record({ type: 'message_end_before_persist', role: event.message.role,
      alreadyPresent: entries.some(e => e.type === 'message' && JSON.stringify(e.message) === JSON.stringify(event.message)) });
  });
  pi.on('input', event => event.text === 'HANDLE_STEER' ? { action: 'handled' } : undefined);
  pi.registerTool({ name: 'p0_gate', label: 'P0 gate', description: 'Local controlled gate', parameters: Type.Object({}),
    async execute() {
      record({ type: 'gate_start' });
      await new Promise(resolve => {
        const timer = setInterval(() => {
          if (existsSync(join(root, 'release'))) { clearInterval(timer); resolve(undefined); }
        }, 10);
      });
      record({ type: 'gate_end' });
      return { content: [{ type: 'text', text: 'gate complete' }], details: {} };
    },
  });
  pi.registerCommand('p0-ping', { description: 'P0 extension command', handler: (_, ctx) => {
    pi.appendEntry('p0-ping', { mode: ctx.mode, hasUI: ctx.hasUI, idle: ctx.isIdle() });
  }});
  pi.registerCommand('p0-ui', { description: 'P0 UI dialogs', handler: async (args, ctx) => {
    const timeout = args === 'timeout' ? { timeout: 60 } : undefined;
    const started = Date.now();
    const select = await ctx.ui.select('select', ['A', 'B'], timeout);
    const confirm = await ctx.ui.confirm('confirm', 'continue?', timeout);
    const input = await ctx.ui.input('input', 'text', timeout);
    const editor = args === 'timeout' ? null : await ctx.ui.editor('editor', 'prefill');
    pi.appendEntry('p0-ui', { select: select ?? null, confirm, input: input ?? null, editor: editor ?? null, elapsed: Date.now() - started });
  }});
  pi.registerCommand('p0-replace', { description: 'P0 session replacement', handler: async (args, ctx) => {
    const [action, ...rest] = args.split(' ');
    let result;
    if (action === 'new') result = await ctx.newSession();
    if (action === 'resume') result = await ctx.switchSession(rest.join(' '));
    if (action === 'fork') result = await ctx.fork(rest[0]);
    if (action === 'clone') result = await ctx.fork(ctx.sessionManager.getLeafId(), { position: 'at' });
    record({ type: 'replacement_result', action, result });
  }});
  pi.registerCommand('p0-navigate', { description: 'P0 leaf navigation', handler: async (args, ctx) => {
    await ctx.navigateTree(args, { summarize: false });
  }});
  pi.registerCommand('p0-fork-file', { description: 'P0 static forkFrom', handler: (args, ctx) => {
    const source = args || ctx.sessionManager.getSessionFile();
    const before = readFileSync(source);
    const copy = SessionManager.forkFrom(source, ctx.cwd, ctx.sessionManager.getSessionDir());
    const after = readFileSync(source);
    const hash = bytes => createHash('sha256').update(bytes).digest('hex');
    record({ type: 'forkFrom', source, target: copy.getSessionFile(),
      beforeHash: hash(before), afterHash: hash(after), beforeBytes: before.length, afterBytes: after.length,
      sourceUnchanged: before.equals(after), appendedNewlineOnly: after.equals(Buffer.concat([before, Buffer.from('\n')])) });
  }});
  pi.on('session_before_compact', (event, ctx) => {
    if (!config().customCompact) return;
    const messages = ctx.sessionManager.getEntries().filter(e => e.type === 'message');
    return { compaction: { summary: 'P0 compact summary', firstKeptEntryId: messages.at(-2).id, tokensBefore: 1234 } };
  });
}
