import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createExperiment } from './experiment.mjs';

const reply = text => ({ segments: [{ type: 'text', text }] });
test('A9 automatic retry emits an intermediate agent_end before final agent_settled', async t => {
  const e = await createExperiment({ settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 20, maxDelayMs: 20 } }, script: { turns: [{ segments: [{ type: 'error', message: '503 overloaded' }] }, reply('recovered')] } });
  t.diagnostic('fixture: ' + e.root);
  try {
    const rpc = await e.start();
    await rpc.promptAndWait('retry');
    const events = rpc.events.filter(r => ['agent_start', 'agent_end', 'auto_retry_start', 'auto_retry_end', 'agent_settled'].includes(r.event.type)).map(r => ({ seq: r.seq, type: r.event.type, willRetry: r.event.willRetry, aborted: r.event.aborted }));
    assert.equal(events.filter(r => r.type === 'agent_end').length, 2);
    assert.equal(events.filter(r => r.type === 'agent_settled').length, 1);
    assert.equal(events.find(r => r.type === 'agent_end').willRetry, true);
    assert.equal(events.at(-1).type, 'agent_settled');
    t.diagnostic('retry: ' + JSON.stringify(events));
    await writeFile(new URL('./retry-evidence.json', import.meta.url), JSON.stringify({ events }, null, 2) + '\n');
    await e.cleanup();
  } catch (error) { await e.stop(); t.diagnostic('retained: ' + e.root); throw error; }
});

test('A10 an uncompacted session restores both users and assistants to the fake provider', async t => {
  const e = await createExperiment({ script: { fallback: reply('saved assistant') } });
  t.diagnostic('fixture: ' + e.root);
  try {
    const file = join(e.root, 'explicit.jsonl');
    let rpc = await e.start({ args: ['--session', file] });
    await rpc.promptAndWait('saved first user');
    await rpc.promptAndWait('saved second user');
    const before = (await rpc.command({ type: 'get_entries' })).data;
    await rpc.stop();
    rpc = await e.start({ args: ['--session', file] });
    assert.deepEqual((await rpc.command({ type: 'get_entries' })).data, before);
    await rpc.promptAndWait('third user');
    const messages = (await e.requests()).at(-1).context.messages.filter(m => m.role !== 'system');
    assert.deepEqual(messages.map(m => m.role), ['user', 'assistant', 'user', 'assistant', 'user']);
    assert.match(JSON.stringify(messages), /saved first user/);
    assert.match(JSON.stringify(messages), /saved second user/);
    t.diagnostic('restored roles: ' + messages.map(m => m.role).join(','));
    await writeFile(new URL('./restore-evidence.json', import.meta.url), JSON.stringify({ messages, fileMatches: (await rpc.command({ type: 'get_state' })).data.sessionFile === file }, null, 2) + '\n');
    await e.cleanup();
  } catch (error) { await e.stop(); t.diagnostic('retained: ' + e.root); throw error; }
});
