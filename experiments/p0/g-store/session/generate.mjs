// 用假 provider 驱动 pi 1.5.0 生成一个 v3 会话文件，覆盖常见条目类型和分支。
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createExperiment } from '../../harness/index.mjs';
import { stopDriver } from '../lib.mjs';

export const genExtPath = fileURLToPath(new URL('./gen-ext.ts', import.meta.url));

const text = (t) => ({ segments: [{ type: 'text', text: t }] });

async function ok(rpc, command) {
  const response = await rpc.command(command, { timeoutMs: 20_000 });
  if (!response.success) throw new Error(`${command.type} failed: ${JSON.stringify(response)}`);
  return response;
}

async function prompt(rpc, message) {
  const { response, settled } = await rpc.promptAndWait(message, { timeoutMs: 20_000 });
  if (!response.success) throw new Error(`prompt ${message} failed: ${JSON.stringify(response)}`);
  return settled;
}

async function entries(rpc) {
  return (await ok(rpc, { type: 'get_entries' })).data;
}

/**
 * 返回 { experiment, sessionFile, log }。experiment 由调用方 stop/cleanup。
 * 结束时 pi 已停止；sessionFile 在 experiment 的 agent/sessions 下。
 */
export async function generateSession() {
  const experiment = await createExperiment({
    // keepRecentTokens 很小，短会话也能手动压缩。
    settings: { compaction: { enabled: false, keepRecentTokens: 1 } },
    script: {
      turns: [],
      routes: [
        { when: { lastUser: 'hello 你好' }, reply: text('hi 世界 first reply') },
        { when: { lastUser: 'read the file', request: 2 }, reply: { segments: [{ type: 'toolCall', name: 'read', arguments: { path: 'input.txt' } }] } },
        { when: { lastUser: 'read the file' }, reply: text('file says fixture data') },
        { when: { lastUser: 'after compact' }, reply: text('reply after compaction') },
        { when: { lastUser: 'on new branch' }, reply: text('reply on the new branch') },
      ],
      // 压缩和分支摘要的请求也经过假 provider，落到 fallback。
      fallback: text('## Goal\nSUMMARY-BY-FAKE-PROVIDER'),
    },
  });
  const log = [];
  await experiment.write('input.txt', 'fixture data\n');
  const rpc = await experiment.start({ args: ['-e', genExtPath] });
  try {
    await prompt(rpc, 'hello 你好');
    await prompt(rpc, 'read the file');
    await ok(rpc, { type: 'set_session_name', name: 'g-session' });
    await ok(rpc, { type: 'set_thinking_level', level: 'high' });
    await ok(rpc, { type: 'prompt', message: '/g-entry state-1' });
    await ok(rpc, { type: 'prompt', message: '/g-msg note-1' });
    let data = await entries(rpc);
    const firstUser = data.entries.find((e) => e.type === 'message' && e.message.role === 'user');
    const firstAssistant = data.entries.find((e) => e.type === 'message' && e.message.role === 'assistant');
    await ok(rpc, { type: 'prompt', message: `/g-label ${firstUser.id} start` });
    const compact = await rpc.command({ type: 'compact' }, { timeoutMs: 20_000 });
    log.push(`compact: ${JSON.stringify(compact).slice(0, 300)}`);
    await prompt(rpc, 'after compact');
    data = await entries(rpc);
    const oldLeaf = data.leafId;
    // 回到第一条助手回复并生成分支摘要，再在新分支上继续对话。
    const nav = await rpc.command({ type: 'prompt', message: `/g-nav ${firstAssistant.id} summarize` }, { timeoutMs: 20_000 });
    log.push(`navigate(summarize): ${JSON.stringify(nav)}`);
    await prompt(rpc, 'on new branch');
    data = await entries(rpc);
    log.push(`entries=${data.entries.length} leaf=${data.leafId} oldBranchLeaf=${oldLeaf}`);
    const state = await ok(rpc, { type: 'get_state' });
    const sessionFile = state.data.sessionFile;
    return { experiment, rpc, sessionFile, oldBranchLeaf: oldLeaf, firstAssistantId: firstAssistant.id, log };
  } catch (error) {
    await stopDriver(rpc); // 不调用 experiment.stop()，避免对已退出的 driver 再发信号

    error.message += `; fixture: ${experiment.root}`;
    throw error;
  }
}

export function snapshot(sessionFile, dir, name) {
  const target = join(dir, name);
  copyFileSync(sessionFile, target);
  return target;
}
