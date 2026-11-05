import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createExperiment, DeadlineError, JsonlDecoder, scriptedUi } from './index.mjs';

async function fixture(t, options) {
  const experiment = await createExperiment(options);
  t.diagnostic(`fixture: ${experiment.root}`);
  t.after(async () => {
    await experiment.stop();
    // Failures keep settings, scripts, sessions, and every log for diagnosis.
    if (t.passed) await experiment.cleanup();
  });
  return experiment;
}

// Two valid, distinct 1x1 PNGs. Input order is asserted byte-for-byte.
const images = [
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=',
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
].map((data) => ({ type: 'image', data, mimeType: 'image/png' }));

test('JSONL preserves Unicode separators, split UTF-8, and CRLF', () => {
  const records = [];
  const decoder = new JsonlDecoder((record) => records.push(record));
  const bytes = Buffer.from(`${JSON.stringify({ text: '中\u2028文\u2029🙂' })}\r\n{"ok":true}\n`);
  for (const byte of bytes) decoder.push(Buffer.from([byte]));
  decoder.end();
  assert.deepEqual(records, [{ text: '中\u2028文\u2029🙂' }, { ok: true }]);
  const truncated = new JsonlDecoder(() => {});
  truncated.push(Buffer.from('{"missing":'));
  assert.throws(() => truncated.end(), /Truncated/);
});

test('streaming text/thinking, usage, and full image/tool request log', async (t) => {
  const experiment = await fixture(t, { script: { turns: [{
    segments: [
      { type: 'thinking', chunks: ['plan', { text: ' first', delayMs: 15 }] },
      { type: 'text', chunks: ['hello\u2028', { text: '世界\u2029', delayMs: 35 }] },
    ],
    usage: { input: 11, output: 7, cacheRead: 3, cacheWrite: 2, cost: { total: 0.125 } },
  }] } });
  const extension = await experiment.write('provider-hooks.ts', `export default function(pi) {
    pi.on('before_provider_request', event => ({ ...event.payload, p0Marker: true }));
    pi.on('after_provider_response', event => pi.appendEntry('p0-response', { status: event.status }));
    pi.on('provider_stream_event', event => {
      if (event.data.type === 'start') pi.appendEntry('p0-provider-stream', { model: event.model });
    });
  }`);
  const rpc = await experiment.start({ args: ['-e', extension] });
  const from = rpc.cursor;
  const run = await rpc.promptAndWait('ordered images', { images });
  assert.equal(run.response.success, true);
  assert.equal(run.settled.aborted, false);
  const deltas = rpc.events.slice(from).filter(({ event }) => event.assistantMessageEvent?.type === 'text_delta');
  assert.equal(deltas.map(({ event }) => event.assistantMessageEvent.delta).join(''), 'hello\u2028世界\u2029');
  assert.ok(deltas[1].elapsedMs - deltas[0].elapsedMs >= 20);
  assert.ok(rpc.events.some(({ event }) => event.assistantMessageEvent?.type === 'thinking_delta'));
  const completed = rpc.events.findLast(({ event }) => event.type === 'message_end' && event.message.role === 'assistant').event.message;
  assert.equal(completed.usage.totalTokens, 23);
  assert.equal(completed.usage.cost.total, 0.125);
  const [request] = await experiment.requests();
  assert.ok(request.tools.some((tool) => tool.name === 'read'));
  assert.ok(request.tools.some((tool) => tool.name === 'bash'));
  assert.equal(typeof request.systemPrompt, 'string');
  assert.ok(request.systemPrompt.length > 0);
  const user = request.context.messages.findLast((message) => message.role === 'user');
  assert.deepEqual(user.content.filter((block) => block.type === 'image'), images);
  assert.equal(user.content[0].type, 'text');
  assert.match(await readFile(rpc.logPath, 'utf8'), /"timestamp":/);
  assert.equal((await rpc.command({ type: 'get_state' })).data.model.provider, 'p0-fake');
  assert.equal((await experiment.providerEvents()).find((entry) => entry.kind === 'payload').payload.p0Marker, true);
  const entries = (await rpc.command({ type: 'get_entries' })).data.entries;
  assert.deepEqual(entries.find((entry) => entry.customType === 'p0-response').data, { status: 200 });
  assert.deepEqual(entries.find((entry) => entry.customType === 'p0-provider-stream').data, { model: 'scripted' });
});

test('read tool executes and its real result reaches the next provider request', async (t) => {
  const experiment = await fixture(t, { script: { turns: [
    { segments: [{ type: 'toolCall', name: 'read', arguments: { path: 'input.txt' } }] },
    { segments: [{ type: 'text', text: 'read complete' }] },
  ] } });
  await experiment.write('input.txt', 'REAL_READ_SENTINEL\n');
  const rpc = await experiment.start();
  const from = rpc.cursor;
  await rpc.promptAndWait('read the fixture');
  const result = await rpc.waitFor((event) => event.type === 'tool_execution_end' && event.toolName === 'read', { from });
  assert.equal(result.isError, false);
  assert.match(JSON.stringify(result.result), /REAL_READ_SENTINEL/);
  const requests = await experiment.requests();
  assert.equal(requests.length, 2);
  const toolResult = requests[1].context.messages.find((message) => message.role === 'toolResult');
  assert.match(JSON.stringify(toolResult), /REAL_READ_SENTINEL/);
});

test('a hanging provider responds to abort and settles', async (t) => {
  const experiment = await fixture(t, { script: { turns: [{ segments: [{ type: 'hang' }] }] } });
  const rpc = await experiment.start();
  const from = rpc.cursor;
  assert.equal((await rpc.command({ type: 'prompt', message: 'hang' })).success, true);
  await experiment.waitForProvider((entry) => entry.kind === 'hang');
  assert.equal((await rpc.command({ type: 'abort' }, { timeoutMs: 2000 })).success, true);
  assert.equal((await rpc.waitFor('agent_settled', { from })).aborted, true);
  const message = rpc.events.findLast(({ event }) => event.type === 'message_end' && event.message.role === 'assistant').event.message;
  assert.equal(message.stopReason, 'aborted');
});

test('ignoreAbort is observable as an abort deadline, not an idle run', async (t) => {
  const experiment = await fixture(t, { script: { turns: [{ ignoreAbort: true, segments: [{ type: 'hang' }] }] } });
  const rpc = await experiment.start();
  const from = rpc.cursor;
  await rpc.command({ type: 'prompt', message: 'ignore abort' });
  await experiment.waitForProvider((entry) => entry.kind === 'hang' && entry.ignoreAbort);
  await assert.rejects(rpc.command({ type: 'abort' }, { timeoutMs: 250 }), DeadlineError);
  await experiment.waitForProvider((entry) => entry.kind === 'abort_received');
  assert.equal(rpc.events.slice(from).some(({ event }) => event.type === 'agent_settled'), false);
  assert.equal((await rpc.command({ type: 'get_state' })).data.isStreaming, true);
  await rpc.stop({ graceMs: 100 });
  assert.ok(rpc.exitInfo.signal || rpc.exitInfo.code !== null);
});

test('scripts can change between turns, match last user text, and report errors', async (t) => {
  const experiment = await fixture(t, { script: { turns: [{ segments: [{ type: 'text', text: 'first' }] }] } });
  const rpc = await experiment.start();
  await rpc.promptAndWait('one');
  await experiment.enqueue({ segments: [{ type: 'text', text: 'queued' }] });
  await rpc.promptAndWait('two');
  await experiment.setScript({ routes: [{ when: { lastUser: 'fail', request: 3 }, reply: {
    segments: [{ type: 'text', text: 'partial' }, { type: 'error', message: 'P0 deliberate failure' }],
  } }] });
  const from = rpc.cursor;
  await rpc.promptAndWait('fail');
  const message = await rpc.waitFor((event) => event.type === 'message_end' && event.message.stopReason === 'error', { from });
  assert.equal(message.message.errorMessage, 'P0 deliberate failure');
  assert.equal((await experiment.requests()).length, 3);
});

test('extension UI scripted reply and deliberately unanswered timeout', async (t) => {
  const experiment = await fixture(t, { ui: scriptedUi([
    { method: 'confirm', response: { confirmed: true } },
    { method: 'input' },
  ]) });
  const extension = await experiment.write('ui-test.ts', `export default function(pi) {
    pi.registerCommand('p0-ui', { description: 'UI fixture', handler: async (_, ctx) => {
      const confirmed = await ctx.ui.confirm('confirm fixture', 'continue?');
      const input = await ctx.ui.input('input fixture', 'text', { timeout: 50 });
      pi.appendEntry('p0-ui-result', { confirmed, input: input ?? null });
    }});
  }`);
  const rpc = await experiment.start({ args: ['-e', extension] });
  const from = rpc.cursor;
  const response = await rpc.command({ type: 'prompt', message: '/p0-ui' });
  assert.equal(response.success, true);
  assert.equal(response.data.disposition, 'handled');
  const entries = await rpc.command({ type: 'get_entries' });
  assert.deepEqual(entries.data.entries.find((entry) => entry.customType === 'p0-ui-result').data, { confirmed: true, input: null });
  assert.equal(rpc.events.slice(from).filter(({ event }) => event.type === 'extension_ui_request').length, 2);
});
