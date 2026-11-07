import test from 'node:test';
import assert from 'node:assert/strict';
import { notificationFixture, records, until } from './fixtures/notify-helpers.mjs';

// notificationFixture隔离HOME、agent配置和锁目录；使用真实pi队列、生产扩展及daemon。
test('真实主会话clear_queue+abort后settled重投通知，同代不重复唤醒，新generation再次唤醒',
  { concurrency: false, timeout: 90000 }, async t => {
    const f = await notificationFixture(t);
    await f.setScript({
      routes: [{ when: { request: 1 }, reply: { segments: [{ type: 'hang' }] } }],
      fallback: { segments: [{ type: 'text', text: '通知已读取' }] },
    });
    const main = await f.startPi();
    const principalId = main.ready.principalEntries[0].data.principalId;
    const taskId = 'clear-queue-task';
    const key = generation => `task:${taskId}:${generation}:completed`;
    const row = async generation => (await f.state()).outbox.find(n => n.dedupe_key === key(generation));
    const injections = async generation => (await f.ext()).filter(e => e.kind === 'inject' && e.dedupeKey === key(generation));
    const requests = async () => (await records(f.env.FAKE_REQUEST_LOG)).filter(e => e.kind === 'request');
    const seed = generation => f.daemon.call('seed', { recipient: principalId, key: key(generation), payload: {
      taskId, generation, title: '队列恢复验收', status: 'completed', content: '相同完成摘要', notify: 'wake',
    } });
    const state = async () => (await main.rpc.send({ type: 'get_state' })).data;
    const idle = () => until(async () => !(await state()).isStreaming, 15000);

    assert.equal((await main.rpc.send({ type: 'prompt', message: '保持主会话运行，等待用户中止' })).success, true);
    await until(async () => (await records(f.env.FAKE_REQUEST_LOG)).some(e => e.kind === 'hang'), 15000);
    await seed(1);
    await until(async () => (await row(1))?.attempts >= 2, 15000);
    assert.equal((await injections(1)).length, 1, '未落盘的同代通知多次投递只入队一次');
    assert.equal((await row(1)).acked_at, null);
    assert.equal((await f.notices(key(1))).length, 0, '排队通知未进入会话文件');
    assert.equal((await requests()).length, 1, '主会话仍阻塞在首个模型请求');
    assert.equal((await state()).isStreaming, true);

    assert.equal((await main.rpc.send({ type: 'clear_queue' })).success, true);
    assert.equal((await main.rpc.send({ type: 'abort' })).success, true);
    await until(async () => (await row(1))?.acked_at, 15000);
    await idle();
    assert.equal((await records(f.env.FAKE_REQUEST_LOG)).filter(e => e.kind === 'abort_received').length, 1);
    assert.equal((await injections(1)).length, 2, '被清掉的通知必须在agent_settled后重新注入');
    assert.equal((await f.notices(key(1))).length, 1, '原队列确实被清除，最终只落盘重投的一条通知');
    assert.equal((await requests()).length, 2, '重投仅唤醒一个模型回合');
    const stored = (await f.notices(key(1)))[0];
    assert.equal((await row(1)).entry_id, stored.id);
    assert.equal((await row(1)).persisted, 1);
    assert.ok((await f.daemonLog()).filter(e => e.kind === 'ack_received').every(e => e.onDisk && e.persisted));
    assert.ok((await injections(1)).every(e => e.options.triggerTurn && e.options.deliverAs === 'followUp'));

    // 重复完成事件不能生成另一条outbox记录或唤醒；返工通知用相同taskId和不同generation。
    const originalId = (await row(1)).id;
    await seed(1);
    await seed(2);
    await until(async () => (await row(2))?.acked_at, 15000);
    await idle();
    assert.equal((await row(1)).id, originalId);
    assert.equal((await injections(1)).length, 2);
    assert.equal((await injections(2)).length, 1);
    assert.equal((await f.notices(key(1))).length, 1);
    assert.equal((await f.notices(key(2))).length, 1);
    assert.equal((await requests()).length, 3, '新generation必须再次唤醒，不能按taskId或摘要误去重');
    assert.equal((await f.state()).outbox.length, 2);
    const second = (await f.notices(key(2)))[0];
    assert.equal(second.details.taskId, taskId);
    assert.equal(second.details.generation, 2);
    assert.equal((await row(2)).entry_id, second.id);
  });
