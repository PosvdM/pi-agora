import { mock } from 'node:test';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startDaemon, RpcSubprocessDriver } from '../../packages/daemon/dist/index.js';

const root = process.env.NOTIFY_TEST_ROOT;
const log = (value) => appendFileSync(join(root, 'daemon.jsonl'), JSON.stringify({ pid: process.pid, ...value }) + '\n');
const options = JSON.parse(process.env.NOTIFY_DAEMON_OPTIONS);
const driver = new RpcSubprocessDriver(options.driverOptions);
const daemon = await startDaemon({ home: options.home, driver, maxConcurrentRuns: 1, readyTimeoutMs: 20000 });
// 只缩短测试的重投时间；生产 inbox、WAL outbox 和 HTTP 处理器保持真实执行。
const takeInbox = daemon.store.takeInbox.bind(daemon.store);
mock.method(daemon.store, 'takeInbox', (recipient) => takeInbox(recipient, 150));
const ack = daemon.auth.ack.bind(daemon.auth);
mock.method(daemon.auth, 'ack', (connection, body) => {
  const notice = daemon.store.get('SELECT * FROM outbox WHERE id=?', body.noticeId);
  const principal = notice && daemon.store.principal(notice.recipient_id);
  const file = principal?.session_file;
  const entries = file && existsSync(file) ? readFileSync(file, 'utf8').split('\n').slice(0, -1).map((line) => JSON.parse(line)) : [];
  const onDisk = entries.some((entry) => entry.type === 'custom_message' && entry.customType === 'agora:notice' &&
    entry.id === body.entryId && entry.details?.dedupeKey === notice?.dedupe_key && entry.details?.noticeId === body.noticeId);
  log({ kind: 'ack_received', noticeId: body.noticeId, entryId: body.entryId, onDisk, persisted: body.persisted });
  return ack(connection, body);
});

process.on('message', async ({ seq, op, body }) => {
  try {
    let result;
    if (op === 'seed') {
      daemon.store.transaction(() => daemon.store.notice(body.recipient, body.key, 'task:completed', body.payload));
      result = daemon.store.get('SELECT * FROM outbox WHERE dedupe_key=?', body.key);
    } else if (op === 'state') {
      result = {
        principals: daemon.store.all('SELECT * FROM principals WHERE type=\'agent:main\''),
        outbox: daemon.store.all('SELECT * FROM outbox'),
        tasks: daemon.store.all('SELECT * FROM tasks'),
        runs: daemon.store.all('SELECT * FROM process_runs'),
      };
    } else if (op === 'expire') {
      // 模拟旧连接租约已经过期，不用 90 秒真实等待；恢复仍走生产 reclaim 和凭证验证。
      daemon.store.run('UPDATE principals SET lease_expires_at=0 WHERE id=?', body.principalId);
      result = true;
    } else if (op === 'close') {
      await daemon.close({ force: true, timeoutMs: 1000 });
      mock.restoreAll();
      process.send({ seq, result: true }, () => process.disconnect());
      return;
    } else throw new Error(`Unknown fixture operation: ${op}`);
    process.send({ seq, result });
  } catch (error) { process.send({ seq, error: String(error?.stack ?? error) }); }
});
process.send({ ready: true, url: daemon.url, instanceId: daemon.instanceId });
