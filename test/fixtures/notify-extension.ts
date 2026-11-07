import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentSession, SessionManager } from '@earendil-works/pi-coding-agent';
import agoraExtension from '../../packages/extension/dist/index.js';

// 此扩展只包装生产入口；通知拉取、注入、磁盘确认和 principal 恢复由生产代码执行。
export default function notifyFixture(pi) {
  const root = process.env.NOTIFY_TEST_ROOT;
  const control = () => JSON.parse(readFileSync(join(root, 'control.json'), 'utf8'));
  const log = (value) => appendFileSync(join(root, 'extension.jsonl'), JSON.stringify({ pid: process.pid, ...value }) + '\n');
  const records = (file) => !file || !existsSync(file) ? [] : readFileSync(file, 'utf8')
    .split('\n').slice(0, -1).map((line) => JSON.parse(line));
  let ctx;
  let armed = true;
  const snapshot = (key) => {
    const entries = ctx.sessionManager.getEntries();
    return {
      sessionFile: ctx.sessionManager.getSessionFile(), sessionId: ctx.sessionManager.getSessionId(),
      header: ctx.sessionManager.getHeader(),
      principalEntries: entries.filter((entry) => entry.type === 'custom' && entry.customType === 'agora-principal'),
      memory: entries.filter((entry) => entry.type === 'custom_message' && entry.details?.dedupeKey === key),
      disk: records(ctx.sessionManager.getSessionFile()).filter((entry) => entry.type === 'custom_message' && entry.details?.dedupeKey === key),
    };
  };
  function killAt(point, key) {
    if (!armed || control().fault !== point) return;
    armed = false;
    log({ kind: 'fault', point, dedupeKey: key, ...snapshot(key) });
    // 同步屏障把 pi 固定在此 API 边界，由父测试真正 SIGKILL；Windows 同样由持有 child 的进程终止。
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20000);
    throw new Error('父测试未在夹具屏障处通过 SIGKILL 终止 pi');
  }
  pi.on('message_end', (event, context) => {
    if (event.message.customType !== 'agora:notice') return;
    ctx = context;
    const key = event.message.details.dedupeKey;
    log({ kind: 'extension_message_end', dedupeKey: key, ...snapshot(key) });
    killAt('extension-message-end', key);
  });

  const originalEmit = AgentSession.prototype._emit;
  let dispatchedKey;
  AgentSession.prototype._emit = function (event) {
    const result = originalEmit.call(this, event);
    if (event.type === 'message_end' && event.message.customType === 'agora:notice') {
      dispatchedKey = event.message.details.dedupeKey;
      log({ kind: 'public_dispatched', dedupeKey: dispatchedKey });
    }
    return result;
  };
  const originalAppend = SessionManager.prototype.appendCustomMessageEntry;
  SessionManager.prototype.appendCustomMessageEntry = function (customType, content, display, details) {
    if (customType === 'agora:notice' && dispatchedKey === details.dedupeKey) {
      killAt('public-before-persist', details.dedupeKey);
    }
    return originalAppend.call(this, customType, content, display, details);
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async function (url, options) {
    const path = new URL(String(url)).pathname;
    if (['/v1/health', '/v1/auth/challenge'].includes(path) && !armed && control().fault === 'daemon-before-ack') {
      // 故障期间让重连握手等待，恢复由父测试拥有的 daemon 完成。
      // 否则生产扩展可能先自动启动后台实例，与夹具重启争抢单实例锁。
      log({ kind: 'reconnect_blocked' });
      await new Promise(() => {});
    }
    if (path !== '/v1/inbox/ack') return originalFetch(url, options);
    const body = JSON.parse(options.body);
    const key = ctx.sessionManager.getEntries().find((entry) => entry.id === body.entryId)?.details?.dedupeKey;
    log({ kind: 'before_ack', body, dedupeKey: key, ...snapshot(key) });
    if (armed && control().fault === 'daemon-before-ack') {
      armed = false;
      log({ kind: 'ack_blocked', dedupeKey: key });
      const deadline = Date.now() + 20000;
      while (!existsSync(join(root, 'release-ack'))) {
        if (Date.now() > deadline) throw new Error('等待释放 ack 夹具屏障超时');
        await delay(10);
      }
    }
    log({ kind: 'ack_request', dedupeKey: key });
    try {
      const response = await originalFetch(url, options);
      log({ kind: 'ack_response', status: response.status, dedupeKey: key });
      return response;
    } catch (error) {
      log({ kind: 'ack_transport_error', dedupeKey: key, error: String(error) });
      throw error;
    }
  };

  const wrapped = new Proxy(pi, {
    get(target, property) {
      if (property === 'on') return (name, handler) => target.on(name, async (event, context) => {
        if (name === 'session_start') ctx = context;
        const result = await handler(event, context);
        if (name === 'session_start') log({ kind: 'ready', ...snapshot(undefined) });
        return result;
      });
      if (property === 'sendMessage') return (message, options) => {
        if (message.customType === 'agora:notice') log({ kind: 'inject', dedupeKey: message.details.dedupeKey, options });
        const result = target.sendMessage(message, options);
        if (message.customType === 'agora:notice' && options.triggerTurn === false) {
          log({ kind: 'silent_returned', dedupeKey: message.details.dedupeKey, ...snapshot(message.details.dedupeKey) });
          killAt('silent-after-send', message.details.dedupeKey);
        }
        return result;
      };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  agoraExtension(wrapped);
  pi.registerCommand('notify-test-snapshot', {
    description: '记录隔离通知测试现场的快照',
    handler: async (_args, context) => { ctx = context; log({ kind: 'snapshot', ...snapshot(control().key) }); },
  });
  pi.on('session_shutdown', () => {
    AgentSession.prototype._emit = originalEmit;
    SessionManager.prototype.appendCustomMessageEntry = originalAppend;
    globalThis.fetch = originalFetch;
  });
}
