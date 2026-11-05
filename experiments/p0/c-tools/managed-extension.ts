import { readFileSync, writeFileSync, appendFileSync, existsSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { Type } from 'typebox';
import { checkPath } from './path-policy.mjs';
import { hardenedGit } from './git-policy.mjs';

export default function(pi) {
  const ticket = process.env.AGORA_LAUNCH_TICKET;
  delete process.env.AGORA_LAUNCH_TICKET;
  const root = process.env.C_TOOLS_CONTROL;
  const config = JSON.parse(readFileSync(join(root, 'control.json'), 'utf8'));
  if (config.fault === 'load') throw new Error('P0 deliberate factory failure');
  let ready = false;
  const log = entry => appendFileSync(join(root, 'guard.jsonl'), JSON.stringify(entry) + '\n');
  const fatal = reason => {
    ready = false;
    writeFileSync(join(root, 'fatal.json'), JSON.stringify({ reason }));
    log({ kind: 'fatal', reason });
  };

  pi.registerTool({
    name: 'agora_canary', label: 'canary', description: 'P0 execution marker', parameters: Type.Object({}),
    async execute() {
      appendFileSync(join(root, 'executed'), 'canary\n');
      return { content: [{ type: 'text', text: 'executed' }], details: {} };
    },
  });
  if (config.profile === 'review') pi.registerTool({
    name: 'agora_git', label: 'git', description: 'P0 fixed argv read-only git',
    parameters: Type.Object({ command: Type.String(), options: Type.Optional(Type.Array(Type.String())), revision: Type.Optional(Type.String()), paths: Type.Optional(Type.Array(Type.String())) }),
    async execute(_id, input, _signal, _update, ctx) {
      const result = await hardenedGit(ctx.cwd, input, { protectedPaths: config.protectedPaths });
      log({ kind: 'git', argv: result.argv });
      return { content: [{ type: 'text', text: result.stdout || '(empty)' }], details: result };
    },
  });

  // The P0 supervisor uses local files for the launch/ready exchange; no network is used.
  pi.on('session_start', (_event, ctx) => {
    try {
      const record = JSON.parse(readFileSync(join(root, 'ticket.json'), 'utf8'));
      if (!ticket || ticket !== record.ticket || record.runId !== config.runId || record.expiresAt <= Date.now()) throw new Error('invalid or expired ticket');
      closeSync(openSync(join(root, 'ticket.spent'), 'wx'));
      const tools = pi.getActiveTools();
      writeFileSync(join(root, 'ready.json'), JSON.stringify({ runId: config.runId, tools, model: ctx.model?.id, thinking: pi.getThinkingLevel(), version: 'p0-1' }));
      log({ kind: 'ready_report', tools });
    } catch (error) { fatal(String(error)); }
  });
  pi.registerCommand('p0-report', {
    description: 'P0 snapshot after asynchronous MCP connection',
    handler: async (_args, ctx) => {
      writeFileSync(join(root, 'ready.json'), JSON.stringify({ runId: config.runId, tools: pi.getActiveTools(), model: ctx.model?.id, thinking: pi.getThinkingLevel(), version: 'p0-1' }));
    },
  });
  pi.registerCommand('p0-ready', {
    description: 'P0 supervisor ready acknowledgement',
    handler: async () => {
      const decision = JSON.parse(readFileSync(join(root, 'decision.json'), 'utf8'));
      ready = decision.runId === config.runId && decision.accepted === true && !existsSync(join(root, 'fatal.json'));
      log({ kind: 'ready_decision', ready });
    },
  });
  pi.on('tool_call', async (event, ctx) => {
    log({ kind: 'tool_call', tool: event.toolName, input: event.input, ready });
    try {
      if (config.fault === 'hook') throw new Error('P0 deliberate policy exception');
      if (!ready) return { block: true, reason: 'agora not ready' };
      if (['read', 'grep', 'find', 'ls', 'edit', 'write'].includes(event.toolName)) {
        try {
          const target = await checkPath(event.toolName, event.input, ctx.cwd, config);
          log({ kind: 'allowed_path', tool: event.toolName, target });
        } catch (error) { return { block: true, reason: String(error) }; }
      }
    } catch (error) {
      fatal(String(error));
      return { block: true, reason: 'policy failed closed: ' + String(error) };
    }
  });
}
