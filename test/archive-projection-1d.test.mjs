import test from 'node:test';
import assert from 'node:assert/strict';
import { projectPartials, projectPartialsAsync } from '../packages/archive/dist/index.js';

function fragment(extra = {}) {
  return { runId: 'pr_one', t: '2026-01-01T00:00:00.000Z', messageSeq: 1, contentIndex: 0, blockType: 'text', delta: '', ...extra };
}

test('未完成流片段按运行、消息、内容块分组，权威结束内容替换增量', async () => {
  const rows = [
    fragment({ contentIndex: 2, blockType: 'toolCall', toolCallId: 'call', toolName: 'read' }),
    fragment({ delta: '旧' }), fragment({ delta: '内容' }),
    fragment({ contentIndex: 1, blockType: 'thinking', delta: '思考' }),
    fragment({ delta: '权威文本', replace: true, done: true }),
    fragment({ contentIndex: 2, blockType: 'toolCall', delta: '{"path":' }),
    fragment({ contentIndex: 2, blockType: 'toolCall', delta: '{"path":"a"}', replace: true, done: true, args: { path: 'a' } }),
    fragment({ messageSeq: 2, delta: '下一条', t: '2026-01-01T00:00:01.000Z' }),
  ];
  const before = structuredClone(rows);
  const result = projectPartials(rows);
  assert.deepEqual(result, [
    { runId: 'pr_one', at: rows[0].t, blocks: [
      { type: 'text', contentIndex: 0, text: '权威文本', done: true },
      { type: 'thinking', contentIndex: 1, text: '思考', done: false },
      { type: 'toolCall', contentIndex: 2, id: 'call', toolName: 'read', argsText: '{"path":"a"}', args: { path: 'a' }, done: true },
    ] },
    { runId: 'pr_one', at: rows.at(-1).t, blocks: [{ type: 'text', contentIndex: 0, text: '下一条', done: false }] },
  ]);
  assert.deepEqual(await projectPartialsAsync(rows), result);
  assert.deepEqual(rows, before);
});

test('片段异步投影分批让出事件循环，跨运行顺序可重现', async () => {
  const rows = Array.from({ length: 12000 }, (_, i) => fragment({ runId: i % 2 ? 'b' : 'a', delta: '文' }));
  let ticks = 0;
  const timer = setInterval(() => ticks++, 1);
  let result;
  try { result = await projectPartialsAsync(rows); }
  finally { clearInterval(timer); }
  assert.ok(ticks > 0);
  assert.deepEqual(result.map(group => [group.runId, group.blocks[0].text.length]), [['a', 6000], ['b', 6000]]);
});
