import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../packages/daemon/dist/store.js';
import { openArchive } from '../packages/archive/dist/index.js';
import createPlugin from '../packages/pane-plugin/dist/plugin.js';

const jsonl = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n';

test('真实 archive 默认接线读取父关系、接管标记、聊天及未完成块，离线不能写', { timeout: 15000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'agora-pane-real-archive-'));
  const dataDir = join(home, 'pane'), sessionDir = join(home, 'sessions', 'as_real');
  const file = join(sessionDir, 'session.jsonl'), at = new Date().toISOString();
  await mkdir(join(sessionDir, 'partials'), { recursive: true });
  await writeFile(file, jsonl([
    { type: 'session', version: 3, id: 'pi-real', timestamp: at, cwd: home },
    { type: 'message', id: 'entry001', parentId: null, timestamp: at, message: { role: 'user', content: '真实存档消息', timestamp: 1 } },
  ]));
  await writeFile(join(sessionDir, 'partials', 'run_real.jsonl'), jsonl([
    { t: at, messageSeq: 1, contentIndex: 0, blockType: 'text', delta: '尚未完成的输出' },
  ]));
  const store = await openStore(home);
  store.transaction(() => {
    store.run("INSERT INTO principals(id,type,created_at) VALUES('child_real','agent:child',?)", at);
    store.run("INSERT INTO agora_sessions(id,task_id,principal_id,convener_id,session_file,profile,model,thinking,cwd,status,created_at) VALUES('as_real','tk_real','child_real','user',?,'explore','test/model','high',?,'interrupted',?)", file, home, at);
    store.run("INSERT INTO tasks(id,agora_session_id,convener_id,requested_by,title,prompt,model,thinking,profile,cwd,notify,status,created_at,updated_at,max_tokens,taken_over_from) VALUES('tk_real','as_real','user','user','真实离线任务','目标','test/model','high','explore',?,'silent','interrupted',?,?,1000,'old_agent')", home, at, at);
    store.run("INSERT INTO principals(id,type,pi_session_id,created_at) VALUES('old_agent','agent:main','pi-old',?)", at);
    store.run("INSERT INTO principals(id,type,created_at) VALUES('old_child_real','agent:child',?)", at);
    store.run("INSERT INTO agora_sessions(id,task_id,principal_id,convener_id,session_file,profile,model,thinking,cwd,status,created_at) VALUES('as_old','tk_real','old_child_real','old_agent',?,'explore','test/model','high',?,'completed',?)", file + '.old', home, at);
    store.run("INSERT INTO task_generations(task_id,generation,status,agora_session_id) VALUES('tk_real',1,'interrupted','as_real')");
  });
  store.close();
  const reader = await openArchive({ home, apiVersion: 1 });
  const meta = await reader.getSession('as_real');
  assert.deepEqual(meta.parent, { kind: 'user' });
  assert.equal(meta.takenOver, true); assert.equal(meta.isCurrent, true);
  const old = await reader.getSession('as_old');
  assert.deepEqual(old.parent, { kind: 'user' });
  assert.equal(old.isCurrent, false); assert.equal(old.takenOver, true);
  reader.close();
  const plugin = createPlugin({ home, retryMs: 60000 });
  t.after(async () => { await plugin.deactivate(); await rm(home, { recursive: true, force: true }); });
  await plugin.activate({ paneProtocol: 1, dataDir,
    log: { info() {}, warn() {}, error() {} }, notify() {}, panelChanged() {}, formAdded() {}, formRemoved() {},
    setBanner() {}, clearBanner() {}, listBanners: () => [],
    mainSessions: { list: () => [], get: () => undefined, onChange: () => () => {}, hold: () => () => {} },
    userPresence: { devices: () => [], onDevicesChange: () => () => {}, confirm: async () => { throw new Error('离线不得请求签名'); } },
  });
  const tree = await plugin.tree.snapshot({ openNodeIds: [], recentSince: '2000-01-01T00:00:00Z' });
  const node = tree.nodes.find(value => value.id === 'agora:session:as_real');
  assert.equal(node.parentId, 'agora:root:user-tasks');
  assert.match(node.statusDetail, /已由用户接管/);
  assert.deepEqual(node.capabilities, ['open']);
  const ref = { source: 'agora', id: 'as_real' }, snapshot = await plugin.sessions.snapshot(ref);
  assert.equal(snapshot.readonly, true); assert.equal(snapshot.readonlyReason, 'archived');
  assert.equal(snapshot.entries[0].message.content, '真实存档消息');
  assert.equal(snapshot.unfinishedPartials[0].blocks[0].text, '尚未完成的输出');
  assert.equal(snapshot.unfinishedPartials[0].runId, 'run_real');
  assert.deepEqual(await plugin.actions.list(), []);
});
