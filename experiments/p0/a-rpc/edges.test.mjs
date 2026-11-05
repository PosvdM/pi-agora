import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createExperiment, DeadlineError } from './experiment.mjs';

import { recordEvidence } from './record.mjs';

const results = {};
async function run(t, options, body) {
  const e = await createExperiment(options);
  t.diagnostic('fixture: ' + e.root);
  try { await body(e); await e.stop(); if (!e.preserve) await e.cleanup(); else t.diagnostic('retained observation: ' + e.root); }
  catch (error) { await e.stop(); t.diagnostic('retained: ' + e.root); throw error; }
}

test('A11 get_commands lists explicit skills and templates with source metadata', async t => {
  await run(t, { script: { fallback: { segments: [{ type: 'text', text: 'expanded' }] } } }, async e => {
    const skill = await e.write('skills/p0-skill/SKILL.md', '---\nname: p0-skill\ndescription: P0 test skill\n---\nSKILL_SENTINEL\n');
    const template = await e.write('p0-template.md', '---\ndescription: P0 test template\n---\nTEMPLATE_SENTINEL $1\n');
    const rpc = await e.start({ args: ['--skill', skill, '--prompt-template', template] });
    const commands = (await rpc.command({ type: 'get_commands' })).data.commands;
    assert.ok(commands.some(c => c.name === 'skill:p0-skill' && c.source === 'skill'));
    assert.ok(commands.some(c => c.name === 'p0-template' && c.source === 'prompt'));
    await rpc.promptAndWait('/p0-template argument');
    await rpc.promptAndWait('/skill:p0-skill');
    const requests = await e.requests();
    assert.match(JSON.stringify(requests[0].context.messages), /TEMPLATE_SENTINEL argument/);
    assert.match(JSON.stringify(requests[1].context.messages), /SKILL_SENTINEL/);
    results.commands = commands.map(c => ({ name: c.name, description: c.description, source: c.source }));
    t.diagnostic('commands: ' + JSON.stringify(results.commands));
  });
});

test('A12 abort alone settles with queued text retained instead of automatically continuing', async t => {
  await run(t, { script: { turns: [{ segments: [{ type: 'hang' }] }], fallback: { segments: [{ type: 'text', text: 'continued' }] } } }, async e => {
    const rpc = await e.start();
    const from = rpc.cursor;
    await rpc.command({ type: 'prompt', message: 'original' });
    await e.waitForProvider(x => x.kind === 'hang');
    await rpc.command({ type: 'steer', message: 'steer after abort' });
    await rpc.command({ type: 'follow_up', message: 'queued after abort' });
    await rpc.command({ type: 'abort' });
    await rpc.waitFor('agent_settled', { from });
    const requests = await e.requests();
    assert.equal(requests.length, 1);
    const state = (await rpc.command({ type: 'get_state' })).data;
    assert.equal(state.isStreaming, false);
    assert.equal(state.pendingMessageCount, 2);
    const cleared = await rpc.command({ type: 'clear_queue' });
    assert.deepEqual(cleared.data, { steering: ['steer after abort'], followUp: ['queued after abort'] });
    e.preserve = true;
    results.abortOnly = { requests: requests.length, lastUser: requests.at(-1).lastUser, isStreaming: state.isStreaming, pendingMessageCount: state.pendingMessageCount, clearAfterSettled: cleared.data, text: (await rpc.command({ type: 'get_last_assistant_text' })).data.text };
    t.diagnostic('abort only: ' + JSON.stringify(results.abortOnly));
  });
});

test('A13 ignored provider abort times out while get_state remains responsive', async t => {
  await run(t, { script: { turns: [{ ignoreAbort: true, segments: [{ type: 'hang' }] }] } }, async e => {
    const rpc = await e.start();
    const from = rpc.cursor;
    await rpc.command({ type: 'prompt', message: 'ignore provider abort' });
    await e.waitForProvider(x => x.kind === 'hang');
    await assert.rejects(rpc.command({ type: 'abort' }, { timeoutMs: 160 }), DeadlineError);
    await e.waitForProvider(x => x.kind === 'abort_received');
    assert.equal((await rpc.command({ type: 'get_state' })).data.isStreaming, true);
    assert.equal(rpc.events.slice(from).some(r => r.event.type === 'agent_settled'), false);
    await rpc.stop({ graceMs: 100 });
    results.ignoredProvider = { abortReceived: true, stateStillStreaming: true, settled: false, exit: rpc.exitInfo };
    t.diagnostic('ignored provider: ' + JSON.stringify(results.ignoredProvider));
  });
});

test('A14 user extension autodiscovery uses only the isolated agent directory in RPC mode', async t => {
  await run(t, {}, async e => {
    const preload = await e.write('enable-user-extensions.mjs', "process.argv = process.argv.filter(arg => arg !== '--no-extensions');\n");
    const dir = join(e.agentDir, 'extensions'); await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'p0-user.ts'), `export default function(pi) {
      pi.registerCommand('p0-user', { description: 'P0 isolated user extension', handler: (_, ctx) => pi.appendEntry('p0-user-loaded', { mode: ctx.mode }) });
    }`);
    const rpc = await e.start({ env: { NODE_OPTIONS: '--import=' + pathToFileURL(preload).href } });
    const command = (await rpc.command({ type: 'get_commands' })).data.commands.find(c => c.name === 'p0-user');
    assert.ok(command);
    assert.equal(command.source, 'extension');
    assert.equal((await rpc.command({ type: 'prompt', message: '/p0-user' })).data.disposition, 'handled');
    const entry = (await rpc.command({ type: 'get_entries' })).data.entries.find(e => e.customType === 'p0-user-loaded');
    assert.deepEqual(entry.data, { mode: 'rpc' });
    results.userExtension = { source: command.source, sourceScope: command.sourceInfo?.scope, mode: entry.data.mode };
    t.diagnostic('user extension: ' + JSON.stringify(results.userExtension));
  });
});

test.after(async () => {
  await recordEvidence('edges-evidence.json', results);
});
