import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { notificationFixture, forceKill, records, until, spawnPrompt, childResult } from './fixtures/notify-helpers.mjs';

// piFixture 会临时替换父进程 HOME；这五个真实进程测试必须串行执行。
const points = ['extension-message-end', 'public-before-persist', 'silent-after-send', 'silent-new-after-send', 'daemon-before-ack'];
for (const point of points) {
  test(`production notices: ${point}${point === 'extension-message-end' ? ' (real child completes while main closes)' : ''}`,
    { concurrency: false, timeout: 90000 }, async (t) => {
      const f = await notificationFixture(t);
      const original = await f.startPi();
      const principalId = original.ready.principalEntries[0].data.principalId;
      const sessionId = original.ready.sessionId;
      const fresh = point === 'silent-new-after-send';
      if (fresh) {
        // 可恢复 principal 的空对话现场：仅预建 header 和 principal 引用，没有 user/assistant 或 notice。
        // 这验证通知持久化边界，不把未落盘的 principal 引用声称为可恢复。
        await writeFile(f.sessionFile, [original.ready.header, ...original.ready.principalEntries].map((entry) => JSON.stringify(entry)).join('\n') + '\n');
        assert.equal((await records(f.sessionFile)).some((entry) => entry.type === 'message'), false);
      } else {
        await f.prompt(original, 'Seed the isolated principal conversation');
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
          content: `Production notification fault ${point}`, notify: point.includes('silent') ? 'silent' : 'wake',
        } });
      }

      let before;
      if (point === 'daemon-before-ack') {
        await until(async () => (await f.ext()).find((entry) => entry.kind === 'ack_blocked'), 25000);
        before = (await f.ext()).find((entry) => entry.kind === 'before_ack');
        assert.equal(before.memory.length, 1);
        assert.equal(before.disk.length, 1);
        assert.equal((await f.ext()).filter((entry) => entry.kind === 'ack_request').length, 0, 'The ack HTTP request has not been issued');
        assert.equal((await f.state()).outbox[0].acked_at, null);
        assert.equal((await f.daemonLog()).filter((entry) => entry.kind === 'ack_received').length, 0);
        await forceKill(f.daemon);
        await writeFile(path.join(f.root, 'release-ack'), 'release');
        await until(async () => (await f.ext()).some((entry) => entry.kind === 'ack_transport_error'), 10000);
        // 同一会话只能在旧 main 已退出后恢复。
        await forceKill(original);
        await f.startDaemon();
        assert.equal((await f.state()).outbox[0].acked_at, null, 'WAL outbox remains unacknowledged after the daemon restart');
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
            'Real public listeners ran before appendCustomMessageEntry; this does not claim RPC peer receipt');
        }
        if (point === 'extension-message-end') {
          const state = await f.state();
          assert.equal(state.tasks.length, 1, 'The notification comes from an actual daemon task');
          task = state.tasks[0];
          assert.equal(task.status, 'completed');
          assert.equal(key, `task:${task.id}:${task.generation}:completed`);
          assert.equal(state.runs.length, 1, 'A real child process run was recorded');
          assert.ok(evidence.some((entry) => entry.kind === 'extension_message_end' && entry.dedupeKey === key));
        }
        const row = (await f.state()).outbox.find((notice) => notice.dedupe_key === key);
        assert.ok(row);
        assert.equal(row.acked_at, null, 'No premature ack at the fault boundary');
        assert.equal((await f.daemonLog()).filter((entry) => entry.kind === 'ack_received').length, 0);
        await forceKill(original);
      }
      if (prompt) await prompt;
      assert.equal((await f.notices(key)).length, before.disk.length, 'SIGKILL cannot advance past the fixture barrier');
      await f.daemon.call('expire', { principalId });
      await f.control({ fault: null, key });
      const recovered = await f.startPi();
      assert.equal(recovered.ready.sessionId, sessionId, 'The original pi session is reopened');
      assert.equal(recovered.ready.principalEntries[0].data.principalId, principalId, 'Production reclaim restores the same principal');
      assert.equal((await f.state()).principals.length, 1, 'Recovery must not register a replacement principal');
      if (fresh) {
        await until(async () => (await f.ext()).some((entry) => entry.pid === recovered.child.pid && entry.kind === 'silent_returned'), 10000);
        assert.equal((await f.notices(key)).length, 0, 'Silent notice cannot persist before the first conversation');
        assert.equal((await f.state()).outbox[0].acked_at, null);
        await f.prompt(recovered, 'Create the first actual conversation');
      }
      const row = await until(async () => (await f.state()).outbox.find((notice) => notice.dedupe_key === key && notice.acked_at), 30000);
      await until(async () => !(await recovered.rpc.send({ type: 'get_state' })).data.isStreaming, 10000);
      const snapshot = await recovered.rpc.send({ type: 'prompt', message: '/notify-test-snapshot' });
      assert.equal(snapshot.success, true);
      const disk = await f.notices(key);
      assert.equal(disk.length, 1, 'Exactly one complete on-disk custom_message has the recovered dedupeKey');
      assert.equal(row.entry_id, disk[0].id);
      assert.equal(row.id, disk[0].details.noticeId);
      assert.equal(row.persisted, 1);
      const evidence = await f.ext();
      assert.equal(evidence.findLast((entry) => entry.kind === 'snapshot').memory.length, 1);
      const injections = evidence.filter((entry) => entry.kind === 'inject' && entry.dedupeKey === key);
      assert.equal(injections.length, before.disk.length ? 1 : 2, 'Persisted entries are confirmed without reinjection');
      const acks = (await f.daemonLog()).filter((entry) => entry.kind === 'ack_received');
      assert.ok(acks.length > 0);
      assert.ok(acks.every((entry) => entry.onDisk && entry.persisted === true), 'Independent daemon observation rejects premature-ack evidence');
      for (const attempt of evidence.filter((entry) => entry.kind === 'before_ack')) {
        assert.ok(attempt.disk.some((entry) => entry.id === attempt.body.entryId && entry.details.dedupeKey === attempt.dedupeKey),
          'Every attempted ack follows a complete matching disk record');
      }
      if (task) {
        const host = await f.host();
        const result = await host.request('GET', `/v1/tasks/${task.id}/result`);
        assert.equal(result.status, 'completed');
        assert.ok(JSON.stringify(result).includes(childResult), 'Actual child result survives main shutdown and recovery');
      }
    });
}
