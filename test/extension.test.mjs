import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NoticeDelivery, persistedNotices } from '../packages/extension/dist/notifications.js';
import { checkToolPath, validatePolicy, verifyRuntime } from '../packages/extension/dist/permissions.js';

async function fixture(t, { ephemeral = false, disk = true, queued = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'agora-extension-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'session.jsonl');
  const entries = [];
  const sends = [];
  const acks = [];
  let failAck = false;
  const ctx = { cwd: root, sessionManager: {
    getEntries: () => entries,
    getSessionFile: () => ephemeral ? undefined : file,
  } };
  const client = { async request(_method, path, body) {
    assert.equal(path, '/v1/inbox/ack');
    if (failAck) throw new Error('确认连接中断');
    acks.push(body);
    return {};
  } };
  const persist = async entry => { await appendFile(file, JSON.stringify(entry) + '\n'); };
  let sequence = 0;
  const pi = { sendMessage(message, options) {
    sends.push({ message, options });
    if (!queued) entries.push({ id: `entry-${++sequence}`, type: 'custom_message', ...message });
  } };
  const delivery = new NoticeDelivery(pi, ctx, client, ephemeral);
  t.after(() => delivery.close());
  const notice = { noticeId: 'nt_one', dedupeKey: 'task:one:1:completed', kind: 'task', payload: { taskId: 'tk_one', generation: 1, content: '任务完成', notify: 'silent' } };
  return { root, file, entries, sends, acks, ctx, pi, client, persist, delivery, notice,
    setFailAck(value) { failAck = value; }, disk };
}

test('通知只有在内存条目与完整磁盘行一致时才确认', async t => {
  const f = await fixture(t);
  await f.delivery.accept([f.notice]);
  assert.equal(f.sends.length, 1);
  assert.equal(f.acks.length, 0);
  assert.equal(f.sends[0].options.triggerTurn, false);
  await writeFile(f.file, JSON.stringify(f.entries[0]));
  await f.delivery.confirm();
  assert.equal(f.acks.length, 0, '未换行片段不是完整记录');
  await appendFile(f.file, '\n');
  await f.delivery.confirm();
  assert.deepEqual(f.acks, [{ noticeId: 'nt_one', entryId: 'entry-1', persisted: true }]);
  await f.delivery.accept([f.notice]);
  assert.equal(f.sends.length, 1);
  assert.equal(f.acks.length, 1);
});

test('message_end前无内存条目时不能凭磁盘记录确认', async t => {
  const f = await fixture(t, { queued: true });
  await f.delivery.accept([f.notice]);
  await writeFile(f.file, JSON.stringify({ type: 'custom_message', id: 'on-disk', customType: 'agora:notice', details: { noticeId: f.notice.noticeId, dedupeKey: f.notice.dedupeKey } }) + '\n');
  await f.delivery.confirm();
  assert.equal(f.acks.length, 0);
});

test('ephemeral会话仅确认内存，不声称已落盘', async t => {
  const f = await fixture(t, { ephemeral: true });
  await f.delivery.accept([f.notice]);
  assert.deepEqual(f.acks, [{ noticeId: 'nt_one', entryId: 'entry-1', persisted: false }]);
});

test('clear_queue丢掉在途通知后在settled恢复，落盘后只确认一次', async t => {
  const f = await fixture(t, { queued: true });
  await f.delivery.accept([f.notice]);
  await f.delivery.accept([f.notice]);
  assert.equal(f.sends.length, 1);
  await f.delivery.settled();
  await f.delivery.accept([f.notice]);
  assert.equal(f.sends.length, 2);
  const entry = { id: 'recovered', type: 'custom_message', ...f.sends[1].message };
  f.entries.push(entry);
  await f.persist(entry);
  await f.delivery.confirm();
  await f.delivery.accept([f.notice]);
  assert.equal(f.sends.length, 2);
  assert.equal(f.acks.length, 1);
});

test('ack失败及daemon重连保留在途去重；恢复后重用原条目', async t => {
  const f = await fixture(t);
  await f.delivery.accept([f.notice]);
  await f.persist(f.entries[0]);
  f.setFailAck(true);
  await assert.rejects(f.delivery.confirm(), /确认连接中断/);
  assert.equal(f.acks.length, 0);
  f.delivery.setClient(f.client);
  f.setFailAck(false);
  await f.delivery.accept([f.notice]);
  assert.equal(f.sends.length, 1);
  assert.equal(f.acks.length, 1);
  const restored = new NoticeDelivery(f.pi, f.ctx, f.client, false);
  await restored.accept([f.notice]);
  restored.close();
  assert.equal(f.sends.length, 1, '重建controller也不能重新注入已落盘通知');
});

test('逆向扫描跨块Unicode、损坏行和伪造同id记录', async t => {
  const f = await fixture(t);
  await f.delivery.accept([f.notice]);
  const entry = f.entries[0];
  const wrong = { ...entry, details: { ...entry.details, dedupeKey: 'other' } };
  await writeFile(f.file, JSON.stringify(wrong) + '\n');
  assert.equal((await persistedNotices(f.file, [entry])).size, 0);
  await f.persist(entry);
  await appendFile(f.file, JSON.stringify({ id: 'large', content: '中'.repeat(40000) }) + '\n{损坏记录}\n尾部片段');
  assert.deepEqual([...(await persistedNotices(f.file, [entry]))], ['entry-1']);
});

test('超过4MiB的其他会话记录不阻断更早通知的磁盘核实', async t => {
  const f = await fixture(t);
  await f.delivery.accept([f.notice]);
  await f.persist(f.entries[0]);
  await appendFile(f.file, JSON.stringify({ type: 'message', id: 'large-image', content: 'x'.repeat(5 * 1024 * 1024) }) + '\n');
  await f.delivery.confirm();
  assert.equal(f.acks.length, 1);
  assert.equal(f.acks[0].entryId, 'entry-1');
});

test('重复会话条目只ack一次，close之后排队操作不再注入', async t => {
  const f = await fixture(t);
  await f.delivery.accept([f.notice]);
  f.entries.push({ ...f.entries[0], id: 'duplicate-entry' });
  for (const entry of f.entries) await f.persist(entry);
  await Promise.all([f.delivery.confirm(), f.delivery.accept([f.notice]), f.delivery.confirm()]);
  assert.equal(f.acks.length, 1);
  const pending = f.delivery.accept([{ ...f.notice, noticeId: 'other', dedupeKey: 'other' }]);
  f.delivery.close();
  await pending;
  assert.equal(f.sends.length, 1);
});

test('注入失败释放在途标记且通知内容明确标注与截断', async t => {
  const f = await fixture(t);
  const original = f.pi.sendMessage;
  f.pi.sendMessage = () => { throw new Error('注入失败'); };
  await assert.rejects(f.delivery.accept([f.notice]), /注入失败/);
  f.pi.sendMessage = original;
  await f.delivery.accept([{ ...f.notice, payload: { summary: '长'.repeat(4000) } }]);
  assert.equal(f.sends.length, 1);
  assert.match(f.sends[0].message.content, /^【agora 子代理事件】/);
  assert.ok(f.sends[0].message.content.length < 2200);
  assert.equal(f.sends[0].options.triggerTurn, true);
});

test('允许根、secret及其搜索祖先和symlink的路径检查', async t => {
  const f = await fixture(t);
  const allowed = join(f.root, 'allowed');
  const secret = join(allowed, 'secret');
  const publicDir = join(allowed, 'public');
  const outside = join(f.root, 'outside');
  await Promise.all([secret, publicDir, outside].map(p => mkdir(p, { recursive: true })));
  await writeFile(join(secret, 'host.key'), '只用于测试');
  await writeFile(join(publicDir, 'ok.txt'), '公开内容');
  const policy = { profile: 'explore', tools: ['read', 'grep', 'find', 'ls'], allowedRoots: [allowed], protectedPaths: [secret], model: 'fake/model', thinking: 'off', extensionVersion: '0.1.0' };
  const ctx = { cwd: allowed, model: { provider: 'fake', id: 'model' } };
  validatePolicy(policy);
  verifyRuntime({ getActiveTools: () => policy.tools, getThinkingLevel: () => 'off' }, ctx, policy);
  assert.equal(await checkToolPath({ toolName: 'read', input: { path: 'public/ok.txt' } }, ctx, policy), undefined);
  for (const name of ['find', 'grep', 'ls']) assert.match(await checkToolPath({ toolName: name, input: {} }, ctx, policy), /缩小范围/);
  assert.match(await checkToolPath({ toolName: 'read', input: { path: 'secret/host.key' } }, ctx, policy), /受保护/);
  assert.match(await checkToolPath({ toolName: 'read', input: { path: outside } }, ctx, policy), /允许的目录/);
  assert.match(await checkToolPath({ toolName: 'bash', input: { command: 'anything' } }, ctx, policy), /允许列表/);
  const link = join(publicDir, 'escape');
  await symlink(secret, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.match(await checkToolPath({ toolName: 'read', input: { path: join(link, 'host.key') } }, ctx, policy), /受保护/);
  assert.throws(() => verifyRuntime({ getActiveTools: () => [...policy.tools, 'bash'], getThinkingLevel: () => 'off' }, ctx, policy), /不符/);
  assert.throws(() => validatePolicy({ ...policy, protectedPaths: [] }), /无效/);
});
