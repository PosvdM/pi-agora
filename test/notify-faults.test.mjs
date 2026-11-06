import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { notificationFixture, forceKill, records, until, spawnPrompt, childResult } from './fixtures/notify-helpers.mjs';

// piFixture 会临时替换父进程 HOME；这五个真实进程测试必须串行执行。
const points = {
  'extension-message-end': '生产通知：真实子代理完成，在 message_end 回调强杀主会话后恢复',
  'public-before-persist': '生产通知：公共 message_end 派发后、落盘前强杀 pi 后恢复',
  'silent-after-send': '生产通知：已有对话中静默发送后强杀 pi 后恢复',
  'silent-new-after-send': '生产通知：空对话新会话中静默发送后强杀 pi 后恢复',
  'daemon-before-ack': '生产通知：ack 请求发出前强杀 daemon 后恢复',
};
for (const [point, name] of Object.entries(points)) {
  test(name,
    { concurrency: false, timeout: 90000 }, async (t) => {
      const f = await notificationFixture(t);
      const original = await f.startPi();
      const principalId = original.ready.principalEntries[0].data.principalId;
      const sessionId = original.ready.sessionId;
      const fresh = point === 'silent-new-after-send';
      if (fresh) {
        // 可恢复 principal 的空对话现场：仅预建 header 和 principal 引用，没有 user/assistant 或 notice。
        // 这验证通知持久化边界，不把未落盘的 principal 引用声称为可恢复。
        const principalReference = { ...original.ready.principalEntries[0], parentId: null };
        await writeFile(f.sessionFile, [original.ready.header, principalReference].map((entry) => JSON.stringify(entry)).join('\n') + '\n');
        assert.equal((await records(f.sessionFile)).some((entry) => entry.type === 'message'), false);
      } else {
        await f.prompt(original, '创建隔离主会话的初始对话');
      }
      const actualPoint = fresh ? 'silent-after-send' : point;
      let key = `fault:${point}`;
      await f.control({ fault: actualPoint, key });
      let prompt;
      let task;
      if (point === 'extension-message-end') {
        // 由真实 main 工具调用启动真实 child；此用例不直接插入 outbox。
        prompt = original.rpc.send({ type: 'prompt', message: spawnPrompt }).catch((error) => ({ closed: String(error) }));
      } else {
        await f.daemon.call('seed', { recipient: principalId, key, payload: {
          content: `生产通知故障：${point}`, notify: point.includes('silent') ? 'silent' : 'wake',
        } });
      }

      let before;
      if (point === 'daemon-before-ack') {
        await until(async () => (await f.ext()).find((entry) => entry.kind === 'ack_blocked'), 25000);
        before = (await f.ext()).find((entry) => entry.kind === 'before_ack');
        assert.equal(before.memory.length, 1);
        assert.equal(before.disk.length, 1);
        assert.equal((await f.ext()).filter((entry) => entry.kind === 'ack_request').length, 0, 'ack 的 HTTP 请求尚未发出');
        assert.equal((await f.state()).outbox[0].acked_at, null);
        assert.equal((await f.daemonLog()).filter((entry) => entry.kind === 'ack_received').length, 0);
        await forceKill(f.daemon);
        await writeFile(path.join(f.root, 'release-ack'), 'release');
        await until(async () => (await f.ext()).some((entry) => entry.kind === 'ack_transport_error'), 10000);
        // 同一会话只能在旧 main 已退出后恢复。
        await forceKill(original);
        await f.startDaemon();
        assert.equal((await f.state()).outbox[0].acked_at, null, 'daemon 重启后，WAL outbox 中的通知仍未确认');
      } else {
        before = await until(async () => (await f.ext()).find((entry) => entry.kind === 'fault'), 35000);
        key = before.dedupeKey;
        assert.equal(before.point, actualPoint);
        assert.equal(before.disk.length, point === 'silent-after-send' ? 1 : 0);
        assert.equal(before.memory.length, point.includes('silent') ? 1 : 0);
        const evidence = await f.ext();
        if (point === 'public-before-persist') {
          const dispatched = evidence.findIndex((entry) => entry.kind === 'public_dispatched' && entry.dedupeKey === key);
          assert.ok(dispatched >= 0 && dispatched < evidence.findIndex((entry) => entry.kind === 'fault'),
            '公共监听器在 appendCustomMessageEntry 前已执行；这不代表 RPC 对端已收到事件');
        }
        if (point === 'extension-message-end') {
          const state = await f.state();
          assert.equal(state.tasks.length, 1, '通知必须来自真实 daemon 任务');
          task = state.tasks[0];
          assert.equal(task.status, 'completed');
          assert.equal(key, `task:${task.id}:${task.generation}:completed`);
          assert.equal(state.runs.length, 1, '必须记录真实子代理进程的运行');
          if (process.env.CI_REQUIRE_CGROUP === '1') {
            assert.ok(JSON.parse(state.runs[0].identity).cgroup, '此 CI 环境要求真实子代理运行在 cgroup 中，不得回退到快照模式');
          }
          assert.ok(evidence.some((entry) => entry.kind === 'extension_message_end' && entry.dedupeKey === key));
        }
        const row = (await f.state()).outbox.find((notice) => notice.dedupe_key === key);
        assert.ok(row);
        assert.equal(row.acked_at, null, '故障边界处不得提前确认通知');
        assert.equal((await f.daemonLog()).filter((entry) => entry.kind === 'ack_received').length, 0);
        await forceKill(original);
      }
      if (prompt) await prompt;
      assert.equal((await f.notices(key)).length, before.disk.length, 'SIGKILL 后不得越过夹具屏障继续落盘');
      await f.daemon.call('expire', { principalId });
      await f.control({ fault: null, key });
      const recovered = await f.startPi();
      assert.equal(recovered.ready.sessionId, sessionId, '必须重新打开原 pi 会话');
      assert.equal(recovered.ready.principalEntries[0].data.principalId, principalId, '生产 reclaim 必须恢复原 principal');
      assert.equal((await f.state()).principals.length, 1, '恢复不得注册替代 principal');
      if (fresh) {
        await until(async () => (await f.ext()).some((entry) => entry.pid === recovered.child.pid && entry.kind === 'silent_returned'), 10000);
        // pi 1.5.0 重开已有 header 文件后视为已落盘，静默追加无需先产生对话。
        // 因而此处验证重投后的完整记录，而杀前的 memory=1、disk=0 已在上方验证。
        const entries = await records(f.sessionFile);
        assert.equal(entries.some((entry) => entry.type === 'message' && ['user', 'assistant'].includes(entry.message.role)), false,
          '恢复的会话仍不得包含用户或助手对话');
        assert.equal((await records(f.env.FAKE_REQUEST_LOG)).filter((entry) => entry.kind === 'request').length, 0,
          '空对话会话的静默恢复不得调用模型');
        assert.equal((await f.notices(key)).length, 1, '重开已有文件后，重投通知必须完整落盘一次');
      }
      const row = await until(async () => (await f.state()).outbox.find((notice) => notice.dedupe_key === key && notice.acked_at), 30000);
      await until(async () => !(await recovered.rpc.send({ type: 'get_state' })).data.isStreaming, 10000);
      const snapshot = await recovered.rpc.send({ type: 'prompt', message: '/notify-test-snapshot' });
      assert.equal(snapshot.success, true);
      const disk = await f.notices(key);
      assert.equal(disk.length, 1, '恢复后的 dedupeKey 必须恰好对应一条完整落盘的 custom_message');
      assert.equal(row.entry_id, disk[0].id);
      assert.equal(row.id, disk[0].details.noticeId);
      assert.equal(row.persisted, 1);
      const evidence = await f.ext();
      assert.equal(evidence.findLast((entry) => entry.kind === 'snapshot').memory.length, 1);
      const injections = evidence.filter((entry) => entry.kind === 'inject' && entry.dedupeKey === key);
      assert.equal(injections.length, before.disk.length ? 1 : 2, '已落盘条目必须直接确认，不得重复注入');
      const acks = (await f.daemonLog()).filter((entry) => entry.kind === 'ack_received');
      assert.ok(acks.length > 0);
      assert.ok(acks.every((entry) => entry.onDisk && entry.persisted === true), 'daemon 独立观测到的每次确认都必须有完整磁盘记录');
      for (const attempt of evidence.filter((entry) => entry.kind === 'before_ack')) {
        assert.ok(attempt.disk.some((entry) => entry.id === attempt.body.entryId && entry.details.dedupeKey === attempt.dedupeKey),
          '每次尝试确认前都必须存在匹配的完整磁盘记录');
      }
      if (task) {
        const host = await f.host();
        const result = await host.request('GET', `/v1/tasks/${task.id}/result`);
        assert.equal(result.status, 'completed');
        assert.ok(JSON.stringify(result).includes(childResult), '真实子代理结果必须在主会话关闭并恢复后仍可读取');
      }
    });
}
