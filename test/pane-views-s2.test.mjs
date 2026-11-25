import test from 'node:test';
import assert from 'node:assert/strict';
import { createViews } from '../packages/pane-plugin/dist/views.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function item(id = 's1', patch = {}) {
  return { agoraSessionId: id, taskId: `t-${id}`, parentId: 'pane:session:main',
    title: id, status: 'running', revision: 2, treeRevision: 2, createdAt: '2026-01-01T00:00:00Z',
    hasChildren: false, ...patch };
}
function page(items = [], patch = {}) {
  return { items, changesCursor: { epoch: 'db', seq: 10 }, nextCursor: null, ...patch };
}
function setup(t, handler = () => undefined) {
  const requests = [], streams = [], held = [], panels = [], warnings = [];
  const mains = new Map([['main', { ref: { source: 'pane', id: 'main' },
    nodeId: 'pane:session:main', hosted: true }]]);
  let mainListener;
  const runtime = {
    online: () => true,
    api: {
      async request(method, path, body, options) {
        requests.push({ method, path, body, options });
        const result = await handler({ method, path, body, options, url: new URL(path, 'http://agora') });
        if (result !== undefined) return result;
        if (path.startsWith('/v1/sessions?')) return { status: 200, body: page() };
        if (path.startsWith('/v1/requests?')) return { status: 200, body: { items: [], nextCursor: null } };
        throw new Error(`Unexpected request: ${method} ${path}`);
      },
      subscribe(path, emit, failed) {
        const stream = { path, emit, failed, closed: false };
        streams.push(stream);
        return () => { stream.closed = true; };
      },
      close() {},
    },
    context: {
      log: { info() {}, warn(...args) { warnings.push(args); }, error() {} },
      panelChanged(value) { panels.push(value); },
      mainSessions: {
        list: () => [...mains.values()].filter(main => main.hosted),
        get: id => mains.get(id),
        onChange(listener) { mainListener = listener; return () => { mainListener = undefined; }; },
        hold(ref, reason) {
          const entry = { ref, reason, releases: 0 };
          held.push(entry);
          return () => { entry.releases++; };
        },
      },
    },
  };
  const views = createViews(runtime);
  t.after(() => views.dispose());
  return { views, runtime, requests, streams, held, panels, warnings, mains,
    mainChanged: () => mainListener?.() };
}
function change(stream, seq, objectType = 'session', objectId = 's1', patch = {}) {
  stream.emit({ type: 'change', data: { cursor: { epoch: 'db', seq }, objectType, objectId, ...patch } });
}

test('Agent 管理的当前任务显示接管入口，接管后才开放输入和恢复', async t => {
  let current = item('managed', { status: 'interrupted', parent: { kind: 'main', piSessionId: 'main' } });
  const h = setup(t, ({ path, url }) => {
    if (url.pathname === '/v1/sessions') return { status: 200, body: page([current]) };
    if (path === '/v1/sessions/managed') return { status: 200, body: current };
    if (path === '/v1/sessions/managed/snapshot') return { status: 200, body: { cursor: { epoch: 'db', seq: 0 }, leafId: null, entries: [], historyBefore: null, status: current.status } };
  });
  const req = { openNodeIds: ['agora:session:managed'], recentSince: '2026-01-01T00:00:00Z' };
  const managed = (await h.views.tree.snapshot(req)).nodes.find(node => node.id === 'agora:session:managed');
  assert.ok(managed.capabilities.includes('action:agora.task.takeover'));
  assert.ok(!managed.capabilities.includes('action:agora.task.recover'));
  assert.equal(managed.composer, undefined);
  assert.match(managed.statusDetail, /由 Agent 管理，接管后可操作/);
  assert.equal((await h.views.sessions.snapshot({ source: 'agora', id: 'managed' })).readonly, true);
  current = { ...current, parent: { kind: 'user' }, takenOver: true, revision: 3, treeRevision: 3 };
  const owned = (await h.views.tree.snapshot(req)).nodes.find(node => node.id === 'agora:session:managed');
  assert.ok(owned.capabilities.includes('action:agora.task.recover'));
  assert.ok(!owned.capabilities.includes('action:agora.task.takeover'));
  assert.equal(owned.statusDetail, '已由用户接管');
});

test('历史任务节点只读且不能通过 send 或 abort 操作当前任务', async t => {
  const historical = item('old', { status: 'completed', isCurrent: false });
  const h = setup(t, ({ path, url }) => {
    if (url.pathname === '/v1/sessions') return { status: 200, body: page([historical]) };
    if (path === '/v1/sessions/old') return { status: 200, body: historical };
    if (path === '/v1/sessions/old/snapshot') return { status: 200, body: { cursor: { epoch: 'db', seq: 0 }, leafId: null, entries: [], historyBefore: null, status: 'completed' } };
  });
  const snapshot = await h.views.tree.snapshot({ openNodeIds: ['agora:session:old'], recentSince: '2026-01-01T00:00:00Z' });
  assert.deepEqual(snapshot.nodes.find(node => node.id === 'agora:session:old').capabilities, ['open']);
  assert.equal(snapshot.nodes.find(node => node.id === 'agora:session:old').availability, 'archived');
  const ref = { source: 'agora', id: 'old' };
  const historicalSnapshot = await h.views.sessions.snapshot(ref);
  assert.equal(historicalSnapshot.readonly, true);
  assert.equal(historicalSnapshot.readonlyReason, 'archived');
  assert.equal((await h.views.sessions.send(ref, { text: '不能误控' }, { idempotencyKey: 'old', origin: {} })).status, 'rejected');
  assert.equal((await h.views.sessions.abort(ref, { clearQueue: true, origin: {} })).status, 'nothingToStop');
  assert.equal(h.requests.filter(request => request.method === 'POST').length, 0);
});

test('树映射热快照、虚拟根、状态与子节点分页 epoch', async t => {
  const rows = [
    item('created', { status: 'created', parentId: null, parent: { kind: 'user' }, takenOver: true, statusDetail: '排队中' }),
    item('paused', { status: 'quota_paused', parent: { kind: 'user' } }),
    item('done', { status: 'completed', archiveState: 'missing', parent: { kind: 'user' } }),
    item('interrupted', { status: 'interrupted', parent: { kind: 'user' } }),
    item('seat', { taskId: null, kind: 'secretary', status: 'completed', originToolCall: {
      sessionRef: { source: 'pane', id: 'main' }, toolCallId: 'call' } }),
  ];
  const h = setup(t, ({ url }) => url.pathname === '/v1/sessions' ? { status: 200, body: page(rows) } : undefined);
  const snapshot = await h.views.tree.snapshot({ openNodeIds: ['agora:session:s?1', 'pane:session:main'], recentSince: '2026-01-01' });
  const params = new URL(h.requests[0].path, 'http://agora').searchParams;
  assert.equal(params.get('snapshot'), '1');
  assert.deepEqual(params.getAll('openNodeId'), ['agora:session:s?1', 'pane:session:main']);
  assert.equal(params.get('recentSince'), '2026-01-01');
  assert.equal(snapshot.epoch, 'db'); assert.equal(snapshot.revision, 10);
  const [created, paused, done, interrupted, seat, root] = snapshot.nodes;
  assert.equal(created.status, 'waiting'); assert.equal(created.parentId, 'agora:root:user-tasks');
  assert.equal(created.statusDetail, '已由用户接管；排队中');
  assert.equal(paused.status, 'paused'); assert.equal(done.status, 'done');
  assert.equal(done.availability, 'missing'); assert.equal(done.composer.images, false);
  assert.ok(done.capabilities.includes('action:agora.task.cleanup'));
  assert.ok(interrupted.capabilities.includes('action:agora.task.recover'));
  assert.equal(seat.badge, '书记'); assert.ok(seat.capabilities.includes('subscribe'));
  assert.equal(seat.composer, undefined); assert.equal(seat.originToolCall.toolCallId, 'call');
  assert.equal(root.kind, 'group'); assert.equal(root.hasChildren, true); assert.equal(root.sessionRef, undefined);
  assert.ok(snapshot.nodes.every(node => !node.capabilities.some(value => value.includes('meeting.'))));
  const reset = await h.views.tree.children('pane:session:main', { epoch: 'old', limit: 2, cursor: 'cursor?' });
  assert.deepEqual(reset, { reset: true, epoch: 'db' });
  const children = await h.views.tree.children('pane:session:main', { epoch: 'db', limit: 2, cursor: 'cursor?' });
  assert.equal(children.revision, 10); assert.equal(children.nodes.length, 5);
  const childParams = new URL(h.requests.at(-1).path, 'http://agora').searchParams;
  assert.equal(childParams.get('parent'), 'pane:session:main'); assert.equal(childParams.get('cursor'), 'cursor?');
});

test('树串行读取任务会话，非树对象推进来源修订号', async t => {
  const task = deferred(), session = deferred();
  const h = setup(t, ({ path }) => {
    if (path === '/v1/tasks/t1') return task.promise;
    if (path === '/v1/sessions/s1') return session.promise;
    if (path === '/v1/tasks/t2') return { status: 200, body: { agoraSessionId: 's2' } };
    if (path === '/v1/sessions/s2') return { status: 200, body: item('s2', { revision: 999, treeRevision: 999 }) };
  });
  const emitted = [];
  h.views.tree.subscribe({ epoch: 'db', revision: 0 }, value => emitted.push(value));
  const stream = h.streams[0];
  assert.equal(stream.path, '/v1/changes?epoch=db&afterSeq=0');
  change(stream, 1, 'task', 't1'); change(stream, 2, 'task', 't2');
  change(stream, 3, 'device', 'd1'); change(stream, 2, 'session', 's2');
  change(stream, 4, 'session', 's2', { tombstone: true });
  await tick();
  assert.deepEqual(h.requests.map(req => req.path), ['/v1/tasks/t1']);
  task.resolve({ status: 200, body: { agoraSessionId: 's1' } });
  await tick();
  assert.deepEqual(h.requests.map(req => req.path), ['/v1/tasks/t1', '/v1/sessions/s1']);
  session.resolve({ status: 200, body: item() });
  await tick();
  assert.deepEqual(emitted.map(value => [value.type, value.revision]), [['upsert', 1], ['upsert', 2], ['upsert', 3], ['remove', 4]]);
  assert.equal(emitted[1].node.revision, 2, '订阅推送的节点修订号取变更 seq，不取会话行 revision 或数据的 treeRevision');
  assert.equal(emitted[2].node.id, 'agora:root:user-tasks');
  assert.equal(emitted[3].id, 'agora:session:s2');
  assert.equal(h.panels[0].nodeId, 'agora:session:s1');
});

test('从两次变更之前恢复订阅时，每条变更都按 seq 推送，节点数据取最新', async t => {
  // 会话 s1 在 seq 1 和 seq 3 各变更一次，读到的详情已是 seq 3 的数据。
  const latest = item('s1', { status: 'completed', revision: 5, treeRevision: 3 });
  const h = setup(t, ({ path }) => path === '/v1/sessions/s1' ? { status: 200, body: latest } : undefined);
  const emitted = [];
  h.views.tree.subscribe({ epoch: 'db', revision: 0 }, value => emitted.push(value));
  change(h.streams[0], 1); change(h.streams[0], 2, 'device', 'd1'); change(h.streams[0], 3);
  for (let i = 0; i < 5; i++) await tick();
  assert.deepEqual(emitted.map(value => [value.type, value.revision, value.node.id, value.node.revision]), [
    ['upsert', 1, 'agora:session:s1', 1],
    ['upsert', 2, 'agora:root:user-tasks', 2],
    ['upsert', 3, 'agora:session:s1', 3],
  ]);
  assert.equal(emitted[0].node.status, 'done');
  assert.equal(emitted[2].node.status, 'done');
  assert.deepEqual(h.panels.map(panel => [panel.nodeId, panel.revision]), [['agora:session:s1', 1], ['agora:session:s1', 3]]);
  assert.equal(h.streams[0].closed, false);
  assert.deepEqual(h.warnings, []);
});

test('回放时历史会话的存档删除照常推送，即使共享任务随后已有变更', async t => {
  // 任务 T 重开后 A 是历史会话、B 是当前会话：先删除 A 的存档（seq 5），T 随后完成（seq 6）。
  // 回放 seq 5 时 A 的详情因共享任务已带 treeRevision 6；seq 6 的任务详情只指向 B。
  const a = item('A', { taskId: 'T', isCurrent: false, status: 'completed', archiveState: 'missing', treeRevision: 6 });
  const b = item('B', { taskId: 'T', status: 'completed', archiveState: 'archived', treeRevision: 6 });
  const h = setup(t, ({ path }) => {
    if (path === '/v1/sessions/A') return { status: 200, body: a };
    if (path === '/v1/sessions/B') return { status: 200, body: b };
    if (path === '/v1/tasks/T') return { status: 200, body: { taskId: 'T', agoraSessionId: 'B' } };
  });
  const emitted = [];
  h.views.tree.subscribe({ epoch: 'db', revision: 4 }, value => emitted.push(value));
  change(h.streams[0], 5, 'session', 'A'); change(h.streams[0], 6, 'task', 'T');
  for (let i = 0; i < 8; i++) await tick();
  assert.deepEqual(emitted.map(value => [value.type, value.revision, value.node.id, value.node.revision, value.node.availability]), [
    ['upsert', 5, 'agora:session:A', 5, 'missing'],
    ['upsert', 6, 'agora:session:B', 6, 'archived'],
  ]);
  assert.deepEqual(h.warnings, []);
});

test('旧 daemon 不返回 treeRevision 时树快照、分页和订阅明确报错，不输出缺修订号的节点', async t => {
  const legacy = item('old');
  delete legacy.treeRevision;
  const h = setup(t, ({ path, url }) => {
    if (url.pathname === '/v1/sessions') return { status: 200, body: page([legacy]) };
    if (path === '/v1/sessions/old') return { status: 200, body: legacy };
  });
  const expected = /agora 后台版本过旧，会话缺少 treeRevision，请运行 agora shutdown 后重新启动后台/;
  await assert.rejects(h.views.tree.snapshot({ openNodeIds: [], recentSince: '2026-01-01T00:00:00Z' }), expected);
  await assert.rejects(h.views.tree.children('pane:session:main', { epoch: 'db', limit: 10 }), expected);
  const emitted = [];
  h.views.tree.subscribe({ epoch: 'db', revision: 0 }, value => emitted.push(value));
  change(h.streams[0], 1, 'session', 'old');
  for (let i = 0; i < 5; i++) await tick();
  assert.deepEqual(emitted, [{ type: 'reset', epoch: 'db' }]);
  assert.equal(h.streams[0].closed, true);
  assert.match(String(h.warnings[0]?.[1]?.message), expected);
});

test('树重置和取消使排队读取失效，禁止迟到更新', async t => {
  for (const mode of ['reset', 'unsubscribe', 'dispose']) {
    const pending = deferred();
    const h = setup(t, ({ path }) => path === '/v1/sessions/s1' ? pending.promise : undefined);
    const emitted = [];
    const off = h.views.tree.subscribe({ epoch: 'db', revision: 0 }, value => emitted.push(value));
    change(h.streams[0], 1); change(h.streams[0], 2);
    await tick();
    const signal = h.requests[0].options.signal;
    if (mode === 'reset') h.streams[0].emit({ type: 'reset', data: { epoch: 'new-db' } });
    else if (mode === 'unsubscribe') off(); else h.views.dispose();
    assert.equal(signal.aborted, true);
    pending.resolve({ status: 200, body: item() });
    await tick();
    assert.deepEqual(emitted, mode === 'reset' ? [{ type: 'reset', epoch: 'new-db' }] : []);
    assert.equal(h.requests.length, 1); assert.equal(h.streams[0].closed, true);
  }
});

test('树映射积压最多 256 条，溢出关流且迟到详情不能继续更新', async t => {
  for (const outcome of ['resolve', 'reject']) {
    const pending = deferred();
    const h = setup(t, ({ path }) => path === '/v1/sessions/s1' ? pending.promise : undefined);
    const emitted = [];
    h.views.tree.subscribe({ epoch: 'db', revision: 0 }, value => emitted.push(value));
    const stream = h.streams[0];
    change(stream, 1);
    await tick();
    for (let seq = 2; seq <= 256; seq++) change(stream, seq);
    assert.equal(stream.closed, false);
    assert.deepEqual(emitted, []);
    change(stream, 257);
    assert.equal(stream.closed, true);
    assert.equal(h.requests[0].options.signal.aborted, true);
    assert.deepEqual(emitted, [{ type: 'reset', epoch: 'db' }]);
    for (let seq = 258; seq <= 10_000; seq++) change(stream, seq);
    stream.failed(new Error('late transport failure'));
    stream.emit({ type: 'reset', data: { epoch: 'late' } });
    if (outcome === 'resolve') pending.resolve({ status: 200, body: item() });
    else pending.reject(new Error('aborted detail'));
    await tick(); await tick();
    assert.deepEqual(emitted, [{ type: 'reset', epoch: 'db' }]);
    assert.equal(h.requests.length, 1);
    assert.equal(h.panels.length, 0);
    assert.equal(h.held.length, 0);
  }
});

test('树映射积压同时限制总字节，未达到数量上限也会关闭', async t => {
  const pending = deferred();
  const h = setup(t, () => pending.promise);
  const emitted = [];
  h.views.tree.subscribe({ epoch: 'db', revision: 0 }, value => emitted.push(value));
  const stream = h.streams[0];
  change(stream, 1);
  await tick();
  // 每帧低于 transport 的 4 MiB 限制，总积压超过 8 MiB。
  const payload = '中'.repeat(1024 * 1024);
  change(stream, 2, 'session', 's1', { payload });
  change(stream, 3, 'session', 's1', { payload });
  assert.equal(stream.closed, false);
  change(stream, 4, 'session', 's1', { payload });
  assert.equal(stream.closed, true);
  pending.resolve({ status: 200, body: item() });
  await tick(); await tick();
  assert.deepEqual(emitted, [{ type: 'reset', epoch: 'db' }]);
  assert.equal(h.requests.length, 1);
});

test('树映射完成后归还积压预算，持续变更仍按修订号串行映射', async t => {
  const h = setup(t, ({ path }) => path === '/v1/sessions/s1'
    ? { status: 200, body: item() } : undefined);
  const emitted = [];
  h.views.tree.subscribe({ epoch: 'db', revision: 0 }, value => emitted.push(value));
  for (let batch = 0; batch < 3; batch++) {
    for (let n = 1; n <= 256; n++) change(h.streams[0], batch * 256 + n);
    await tick();
  }
  assert.equal(h.streams[0].closed, false);
  assert.deepEqual(emitted.map(value => value.revision), Array.from({ length: 768 }, (_, i) => i + 1));
  assert.ok(emitted.every(value => value.type === 'upsert'));
});

test('HTTP 失败触发重置，仅 tombstone 删除节点', async t => {
  const h = setup(t, ({ path }) => path === '/v1/sessions/s1'
    ? { status: 404, body: { error: { message: 'missing metadata' } } } : undefined);
  const emitted = [];
  h.views.tree.subscribe({ epoch: 'db', revision: 0 }, value => emitted.push(value));
  change(h.streams[0], 1);
  await tick();
  assert.deepEqual(emitted, [{ type: 'reset', epoch: 'db' }]);
  assert.equal(h.warnings.length, 1);
  const known = setup(t, ({ url }) => url.pathname === '/v1/sessions'
    ? { status: 200, body: page([item()]) } : undefined);
  await known.views.tree.snapshot({ openNodeIds: [], recentSince: '' });
  const removed = [];
  known.views.tree.subscribe({ epoch: 'db', revision: 10 }, value => removed.push(value));
  change(known.streams[0], 11, 'task', 't-s1', { tombstone: true });
  await tick();
  assert.deepEqual(removed, [{ type: 'remove', revision: 11, id: 'agora:session:s1' }]);
});

test('会话视图透传条目与历史，仅映射 agora 协议事件', async t => {
  const entries = [{ opaquePiShape: { content: ['no parsing'] } }];
  const inFlight = { phase: 'streaming', tools: [], queue: { steering: [], followUp: [] } };
  const h = setup(t, ({ url }) => {
    if (url.pathname.endsWith('/snapshot')) return { status: 200, body: { cursor: { epoch: 'run', seq: 5 },
      leafId: 'leaf', entries, historyBefore: 'before', inFlight, unfinishedPartials: [], status: 'waiting_children', controlRevision: 99 } };
    if (url.pathname.endsWith('/history')) return { status: 200, body: { entries, historyBefore: null } };
    if (url.pathname === '/v1/sessions/s1') return { status: 200, body: item('s1', { parent: { kind: 'user' } }) };
  });
  const ref = { source: 'agora', id: 's1' };
  const snapshot = await h.views.sessions.snapshot(ref);
  assert.equal(snapshot.entries, entries); assert.equal(snapshot.inFlight, inFlight);
  assert.equal(snapshot.status, 'waiting'); assert.equal(snapshot.readonly, false);
  assert.equal('controlRevision' in snapshot, false);
  const history = await h.views.sessions.history(ref, { before: 'entry?1', limit: 7 });
  assert.equal(history.entries, entries);
  assert.equal(new URL(h.requests.at(-1).path, 'http://agora').searchParams.get('before'), 'entry?1');
  const emitted = [];
  h.views.sessions.subscribe(ref, snapshot.cursor, value => emitted.push(value));
  const stream = h.streams[0];
  assert.equal(stream.path, '/v1/sessions/s1/stream?epoch=run&afterSeq=5');
  const raw = { type: 'message_update', unknownPiFormat: true };
  [raw, { type: 'agora_entries', entries, leafId: 'new' },
    { type: 'agora_status', status: 'quota_paused', phase: 'idle', statusDetail: '额度暂停', revision: 10 },
    { type: 'agora_run', phase: 'exited' }].forEach((event, index) => stream.emit({ type: 'session', data: {
    cursor: { epoch: 'run', seq: index + 6 }, sessionId: 's1', event } }));
  assert.equal(emitted.length, 3); assert.equal(emitted[0].event, raw);
  assert.equal(emitted[1].event.type, 'pane_entries'); assert.equal(emitted[1].event.entries, entries);
  assert.deepEqual(emitted[2].event, { type: 'pane_status', status: 'paused', phase: 'idle', detail: '额度暂停' });
  stream.emit({ type: 'resync', data: { epoch: 'next', reason: 'buffer expired' } });
  assert.equal(emitted[3].event.type, 'resync'); assert.equal(emitted[3].cursor.epoch, 'next');
  assert.equal(emitted[3].event.reason, 'buffer expired');
  stream.emit({ type: 'session', data: { cursor: snapshot.cursor, event: raw } });
  assert.equal(emitted.length, 4); assert.equal(stream.closed, true);
  assert.equal(h.views.renderers.customMessages[0].nodeIdPath, 'nodeId');
  assert.deepEqual(h.views.renderers.customMessages.map(value => value.customType), ['agora:notice', 'agora:board-delta', 'agora:meeting-turn']);
});

test('会话席位只读，停止使用任务版本且不伪造会话控制修订号', async t => {
  let current = item('s1', { parent: { kind: 'user' } });
  let steerStatus = 200, stopStatus = 200;
  const h = setup(t, ({ method, path }) => {
    if (method === 'GET' && path === '/v1/sessions/s1') return { status: 200, body: current };
    if (method === 'GET' && path === '/v1/tasks/t-s1') return { status: 200,
      body: { taskId: 't-s1', agoraSessionId: 's1', status: 'running', generation: 3, revision: 19 } };
    if (path.endsWith('/steer')) return { status: steerStatus, body: steerStatus === 200 ? {} : { error: { message: 'steer denied' } } };
    if (path.endsWith('/stop')) return { status: stopStatus, body: stopStatus === 200
      ? { droppedSteers: [{ message: '【agora 返工 st_1，第 2 代】\n原始\n文本' }, { message: '未加标注' }] }
      : { error: { message: 'stop incomplete' } } };
  });
  const ref = { source: 'agora', id: 's1' }, req = { idempotencyKey: 'send-key', origin: {} };
  assert.equal((await h.views.sessions.send(ref, { text: 'x', images: [{}] }, req)).status, 'rejected');
  assert.equal((await h.views.sessions.send(ref, { text: 'x', delivery: 'followUp' }, req)).status, 'rejected');
  assert.equal((await h.views.sessions.send(ref, { text: 'x' }, { ...req, expectedRevision: 1 })).status, 'rejected');
  assert.equal(h.requests.length, 0);
  assert.deepEqual(await h.views.sessions.send(ref, { text: '补充说明' }, req), { status: 'accepted' });
  assert.deepEqual(h.requests.at(-1).body, { message: '补充说明', interrupt: false });
  assert.equal(h.requests.at(-1).options.idempotencyKey, 'send-key');
  assert.equal(h.requests.at(-1).options.actAsUser, undefined);
  steerStatus = 403;
  assert.deepEqual(await h.views.sessions.send(ref, { text: 'x' }, req), { status: 'rejected', message: 'steer denied' });
  const result = await h.views.sessions.abort(ref, { clearQueue: true, origin: {} });
  assert.deepEqual(result, { status: 'done', clearedText: ['原始\n文本', '未加标注'] });
  assert.deepEqual(h.requests.find(request => request.path.endsWith('/stop')).body, { expectedGeneration: 3, expectedRevision: 19 });
  assert.deepEqual(await h.views.sessions.abort(ref, { clearQueue: false, origin: {} }), { status: 'done' });
  stopStatus = 409;
  await assert.rejects(h.views.sessions.abort(ref, { clearQueue: true, origin: {} }), /stop incomplete/);
  await assert.rejects(h.views.sessions.abort(ref, { clearQueue: true, origin: {}, expectedRevision: 1 }), /控制修订号/);
  current = item('s1', { taskId: null, kind: 'participant' });
  const before = h.requests.filter(request => request.method === 'POST').length;
  assert.equal((await h.views.sessions.send(ref, { text: 'x' }, req)).status, 'rejected');
  assert.deepEqual(await h.views.sessions.abort(ref, { clearQueue: true, origin: {} }), { status: 'nothingToStop' });
  assert.equal(h.requests.filter(request => request.method === 'POST').length, before);
});

test('保活统计整棵任务树，未托管主会话可登记并按生命周期释放', async t => {
  let rows = [
    item('parent', { status: 'completed', hasChildren: true }),
    item('child', { parentId: 'agora:session:parent', status: 'quota_paused', hasChildren: true }),
    item('grandchild', { parentId: 'agora:session:child', status: 'waiting_children' }),
    item('user', { parentId: 'agora:root:user-tasks' }),
    item('orphan', { parentId: 'pane:session:missing' }),
    item('cycle', { parentId: 'agora:session:cycle' }),
  ];
  const h = setup(t, ({ url }) => url.pathname === '/v1/sessions' ? { status: 200,
    body: page(url.searchParams.has('cursor') ? rows.slice(2) : rows.slice(0, 2),
      { nextCursor: url.searchParams.has('cursor') ? null : 'next' }) } : undefined);
  h.mains.get('main').hosted = false;
  await h.views.refreshHolds();
  assert.equal(h.held.length, 1); assert.deepEqual(h.held[0].ref, { source: 'pane', id: 'main' });
  assert.equal(h.held[0].reason, '等待子代理（2 个）');
  assert.ok(h.requests.every(request => !new URL(request.path, 'http://agora').searchParams.has('parent')));
  h.mains.get('main').hosted = true;
  h.mainChanged(); await tick();
  assert.equal(h.held.length, 1); assert.equal(h.held[0].releases, 0);
  rows = rows.map(row => row.agoraSessionId === 'grandchild' ? { ...row, status: 'completed' } : row);
  await h.views.refreshHolds();
  assert.equal(h.held[0].releases, 1); assert.equal(h.held[1].reason, '等待子代理（1 个）');
  rows = rows.map(row => row.agoraSessionId === 'child' ? { ...row, status: 'stopped' } : row);
  await h.views.refreshHolds(); assert.equal(h.held[1].releases, 1);
  rows = [item()]; await h.views.refreshHolds();
  assert.equal(h.held[2].releases, 0);
  h.mains.delete('main'); h.mainChanged(); await tick();
  assert.equal(h.held[2].releases, 1);
  h.views.dispose(); h.views.dispose();
  assert.ok(h.held.every(hold => hold.releases === 1));
});

test('树变更刷新保活，停用释放保活与事件流', async t => {
  let current = item();
  const h = setup(t, ({ url }) => {
    if (url.pathname === '/v1/sessions') return { status: 200, body: page([current]) };
    if (url.pathname === '/v1/sessions/s1') return { status: 200, body: current };
  });
  await h.views.refreshHolds();
  assert.equal(h.held[0].releases, 0);
  h.views.tree.subscribe({ epoch: 'db', revision: 10 }, () => {});
  const ref = { source: 'agora', id: 's1' };
  const events = [];
  const offSession = h.views.sessions.subscribe(ref, { epoch: 'run', seq: 0 }, value => events.push(value));
  offSession();
  h.streams[1].emit({ type: 'session', data: { cursor: { epoch: 'run', seq: 1 }, event: { type: 'message_end' } } });
  assert.deepEqual(events, []);
  current = item('s1', { status: 'completed' });
  change(h.streams[0], 11);
  await tick();
  assert.equal(h.held[0].releases, 1);
  current = item();
  change(h.streams[0], 12); await tick();
  assert.equal(h.held[1].releases, 0);
  h.views.dispose();
  assert.equal(h.held[1].releases, 1); assert.ok(h.streams.every(stream => stream.closed));
  assert.throws(() => h.views.tree.subscribe({ epoch: 'db', revision: 12 }, () => {}), /视图已关闭/);
});

test('保活合并大量变更，追赶扫描中的变更仍会再扫描并收敛', async t => {
  const scans = [];
  let blocked = false, active = 0, maxActive = 0;
  const h = setup(t, async ({ url }) => {
    if (url.pathname === '/v1/sessions/s1') return { status: 200, body: item() };
    if (url.pathname !== '/v1/sessions') return;
    if (!blocked) return { status: 200, body: page([item()]) };
    const scan = deferred();
    scans.push(scan);
    maxActive = Math.max(maxActive, ++active);
    try { return await scan.promise; } finally { active--; }
  });
  await h.views.refreshHolds();
  blocked = true;
  h.views.tree.subscribe({ epoch: 'db', revision: 0 }, () => {});
  const refresh = h.views.refreshHolds();
  await tick();
  for (let round = 0; round < 2; round++) {
    for (let seq = 1; seq <= 200; seq++) change(h.streams[0], round * 200 + seq);
    for (let n = 0; n < 1000; n++) {
      h.mainChanged();
      assert.equal(h.views.refreshHolds(), refresh);
    }
    await tick();
    assert.equal(scans.length, round + 1);
    assert.equal(active, 1);
    scans[round].resolve({ status: 200, body: page(round === 0 ? [item()] : [item(), item('s2')]) });
    await tick();
    assert.equal(scans.length, round + 2);
  }
  scans[2].resolve({ status: 200, body: page([item('s1', { status: 'completed' }), item('s2', { status: 'completed' })]) });
  await refresh;
  await tick();
  assert.equal(scans.length, 3);
  assert.equal(maxActive, 1);
  assert.equal(active, 0);
  assert.equal(h.held.length, 2);
  assert.equal(h.held[1].reason, '等待子代理（2 个）');
  assert.ok(h.held.every(hold => hold.releases === 1));
});

test('停用释放已有保活并取消 dirty 追赶，迟到分页不得登记新保活', async t => {
  const pending = deferred();
  let blocked = false;
  const h = setup(t, ({ url }) => url.pathname === '/v1/sessions'
    ? blocked ? pending.promise : { status: 200, body: page([item()]) } : undefined);
  await h.views.refreshHolds();
  blocked = true;
  const refresh = h.views.refreshHolds();
  await tick();
  for (let n = 0; n < 1000; n++) h.mainChanged();
  assert.equal(h.requests.length, 2);
  h.views.dispose();
  assert.equal(h.requests[1].options.signal.aborted, true);
  assert.equal(h.held[0].releases, 1);
  pending.resolve({ status: 200, body: page([item(), item('s2')], { nextCursor: 'late' }) });
  await refresh;
  await h.views.refreshHolds();
  await tick();
  assert.equal(h.requests.length, 2);
  assert.equal(h.held.length, 1);
  assert.equal(h.held[0].releases, 1);
});

test('保活拒绝停滞分页，停用阻止迟到登记', async t => {
  const broken = setup(t, ({ url }) => url.pathname === '/v1/sessions'
    ? { status: 200, body: page([item()], { nextCursor: 'same' }) } : undefined);
  await assert.rejects(broken.views.refreshHolds(), /游标未前进/);
  assert.equal(broken.held.length, 0); assert.equal(broken.requests.length, 2);
  const pending = deferred();
  const h = setup(t, () => pending.promise);
  const refresh = h.views.refreshHolds(); await tick(); h.views.dispose();
  assert.equal(h.requests[0].options.signal.aborted, true);
  pending.resolve({ status: 200, body: page([item()]) });
  await refresh;
  assert.equal(h.held.length, 0);
});

test('任务面板展示答复者与设备确认来源，提问变化刷新相关面板', async t => {
  const h = setup(t, ({ path, url }) => {
    if (path === '/v1/sessions/s1') return { status: 200, body: item() };
    if (path === '/v1/tasks/t-s1') return { status: 200, body: { agoraSessionId: 's1', resultText: '结果' } };
    if (path === '/v1/requests/rq-one') return { status: 200, body: { taskId: 't-s1' } };
    if (url.pathname === '/v1/requests') {
      assert.equal(url.searchParams.get('taskId'), 't-s1');
      assert.equal(url.searchParams.get('state'), 'answered');
      return { status: 200, body: { items: [{ id: 'rq-one', taskId: 't-s1', state: 'answered', answers: [{ id: 'q', selected: ['甲'] }], answeredBy: 'user', answeredVia: { confirmedBy: 'device', deviceId: '工作电脑' } }] } };
    }
  });
  const content = await h.views.panels.content('agora.task', 'agora:session:s1');
  assert.ok(content.rows.some(row => row.value.includes('经设备 工作电脑 确认')));
  const emitted = [];
  h.views.tree.subscribe({ epoch: 'db', revision: 0 }, value => emitted.push(value));
  change(h.streams[0], 1, 'request', 'rq-one');
  await tick(); await tick();
  assert.equal(emitted[0].node.id, 'agora:root:user-tasks');
  assert.ok(h.panels.some(panel => panel.nodeId === 'agora:session:s1'));
});

test('任务面板显示任务树用量、上下文和有界各代结果', async t => {
  const h = setup(t, ({ url }) => {
    if (url.pathname === '/v1/sessions/s1') return { status: 200, body: item() };
    if (url.pathname === '/v1/tasks/t-s1') return { status: 200, body: { model: 'model', profile: 'fast',
      generation: 30, status: 'running', worktree: { path: '/tree' }, usage: { contextTokens: 42 },
      treeUsage: { inputTokens: 100 }, resultText: 'latest' } };
    if (url.pathname.endsWith('/result')) return { status: 200, body: { status: 'completed',
      resultText: `generation ${url.searchParams.get('generation')}`, generationUsage: { inputTokens: 1 } } };
  });
  assert.equal(h.views.panels.list().length, 1); assert.equal(h.views.panels.list()[0].id, 'agora.task');
  const content = await h.views.panels.content('agora.task', 'agora:session:s1');
  const values = Object.fromEntries(content.rows.map(row => [row.key, row.value]));
  assert.equal(values['上下文 token'], '42'); assert.match(values['任务树用量'], /100/);
  assert.match(values['结果范围'], /11—30/); assert.equal(values['第 30 代结果'], 'generation 30');
  assert.equal(h.requests.filter(request => request.path.includes('/result?')).length, 20);
  await assert.rejects(h.views.panels.content('agora.meeting', 'agora:session:s1'), /任务面板/);
});

test('能 abort 的任务不再声明停止动作，不能 abort 的未结束任务保留停止动作', async t => {
  const rows = [
    item('owned', { parent: { kind: 'user' } }),
    item('managed', { parent: { kind: 'main', piSessionId: 'main' } }),
    item('quota', { status: 'quota_paused', parent: { kind: 'user' } }),
    item('budget', { status: 'budget_paused', parent: { kind: 'main', piSessionId: 'main' } }),
    item('finished', { status: 'completed', parent: { kind: 'user' } }),
  ];
  const h = setup(t, ({ url }) => url.pathname === '/v1/sessions' ? { status: 200, body: page(rows) } : undefined);
  const nodes = new Map((await h.views.tree.snapshot({ openNodeIds: [], recentSince: '2026-01-01T00:00:00Z' })).nodes.map(node => [node.id, node]));
  const capabilities = id => nodes.get(`agora:session:${id}`).capabilities;
  for (const id of ['owned', 'managed']) {
    assert.ok(capabilities(id).includes('abort'), id);
    assert.ok(!capabilities(id).includes('action:agora.task.stop'), id);
  }
  for (const id of ['quota', 'budget']) {
    assert.ok(!capabilities(id).includes('abort'), id);
    assert.ok(capabilities(id).includes('action:agora.task.stop'), id);
  }
  assert.ok(!capabilities('finished').includes('abort'));
  assert.ok(!capabilities('finished').includes('action:agora.task.stop'));
});

test('每个未结束的任务恰好有一个停止入口：排队和等待状态声明 abort，暂停状态声明停止动作', async t => {
  const abortable = ['created', 'running', 'waiting_decision', 'waiting_children'];
  const paused = ['quota_paused', 'budget_paused'];
  const terminal = ['completed', 'failed', 'stopped', 'interrupted'];
  const rows = [...abortable, ...paused, ...terminal].map(status => item(status, { status, parent: { kind: 'user' } }));
  const h = setup(t, ({ url }) => url.pathname === '/v1/sessions' ? { status: 200, body: page(rows) } : undefined);
  const nodes = new Map((await h.views.tree.snapshot({ openNodeIds: [], recentSince: '2026-01-01T00:00:00Z' })).nodes.map(node => [node.id, node]));
  const stops = status => nodes.get(`agora:session:${status}`).capabilities.filter(value => value === 'abort' || value === 'action:agora.task.stop');
  for (const status of abortable) assert.deepEqual(stops(status), ['abort'], status);
  for (const status of paused) assert.deepEqual(stops(status), ['action:agora.task.stop'], status);
  for (const status of terminal) assert.deepEqual(stops(status), [], status);
  // created 与两种等待状态在 pane 中同为 waiting，停止按钮依赖 abort 能力出现。
  for (const status of ['created', 'waiting_decision', 'waiting_children']) assert.equal(nodes.get(`agora:session:${status}`).status, 'waiting', status);
});

test('在线快照扫描全部会话，在 foreignChildCounts 中报告 pane 节点下的直接子节点总数', async t => {
  const all = [
    item('hot', { parent: { kind: 'main', piSessionId: 'main' } }),
    item('cold', { status: 'completed', parent: { kind: 'main', piSessionId: 'main' } }),
    item('old', { status: 'completed', isCurrent: false, parent: { kind: 'main', piSessionId: 'main' } }),
    item('legacy', { status: 'completed', parent: undefined, parentId: 'pane:session:legacy' }),
    item('child', { status: 'completed', parent: { kind: 'task', taskId: 't-cold', sessionId: 'cold' } }),
    item('other', { status: 'completed', parent: { kind: 'main', piSessionId: 'other' } }),
    item('user', { status: 'completed', parent: { kind: 'user' } }),
  ];
  let epoch = 'db';
  const h = setup(t, ({ url }) => {
    if (url.pathname !== '/v1/sessions') return undefined;
    if (url.searchParams.get('snapshot') === '1') return { status: 200, body: page([all[0]]) };
    // 扫描分两页，第二页之前可以切换来源 epoch。
    if (!url.searchParams.get('cursor')) return { status: 200, body: page(all.slice(0, 4), { nextCursor: 'p2' }) };
    return { status: 200, body: page(all.slice(4), { changesCursor: { epoch, seq: 11 } }) };
  });
  const req = { openNodeIds: [], recentSince: '2026-01-01T00:00:00Z' };
  const snapshot = await h.views.tree.snapshot(req);
  assert.deepEqual(snapshot.nodes.map(node => node.id), ['agora:session:hot', 'agora:root:user-tasks']);
  assert.deepEqual(snapshot.foreignChildCounts, { 'pane:session:main': 3, 'pane:session:legacy': 1, 'pane:session:other': 1 });
  const scans = h.requests.filter(request => request.path.startsWith('/v1/sessions?') && !request.path.includes('snapshot=1'));
  assert.equal(scans.length, 2);
  assert.equal(new URL(scans[0].path, 'http://agora').searchParams.get('limit'), '200');
  assert.equal(new URL(scans[1].path, 'http://agora').searchParams.get('cursor'), 'p2');
  // 扫描中途来源重置时省略数目，快照本身照常返回，订阅随后收到 reset。
  epoch = 'db-2';
  const reset = await h.views.tree.snapshot(req);
  assert.equal(reset.foreignChildCounts, undefined);
  assert.equal(reset.epoch, 'db');
  assert.deepEqual(reset.nodes.map(node => node.id), ['agora:session:hot', 'agora:root:user-tasks']);
});

test('订阅按用户任务根子节点集合增减根节点 childCount，修订号取变更 seq', async t => {
  const cold = item('cold', { status: 'completed', parent: { kind: 'user' } });
  // late 在快照页之后创建，已出现在扫描结果中；回放它的变更不能重复计数。
  const late = item('late', { parent: { kind: 'user' } });
  const sessions = new Map([
    ['fresh', item('fresh', { parent: { kind: 'user' } })],
    ['late', late],
    ['moved', item('moved', { parent: { kind: 'main', piSessionId: 'main' } })],
    ['cold', cold],
  ]);
  const h = setup(t, ({ path, url }) => {
    if (url.pathname === '/v1/sessions') return { status: 200, body: page(url.searchParams.get('snapshot') === '1' ? [] : [cold, late]) };
    const id = /^\/v1\/sessions\/([^/]+)$/.exec(path)?.[1];
    if (id && sessions.has(id)) return { status: 200, body: sessions.get(id) };
  });
  const snapshot = await h.views.tree.snapshot({ openNodeIds: [], recentSince: '2026-01-01T00:00:00Z' });
  assert.equal(snapshot.nodes.find(node => node.id === 'agora:root:user-tasks').childCount, 2);
  const emitted = [];
  h.views.tree.subscribe({ epoch: 'db', revision: 10 }, value => emitted.push(value));
  const stream = h.streams[0];
  change(stream, 11, 'session', 'late');
  change(stream, 12, 'session', 'fresh');
  change(stream, 13, 'session', 'fresh');
  change(stream, 14, 'device', 'd1');
  // 接管等父节点变化：cold 移出用户任务根，moved 移入。
  change(stream, 15, 'session', 'moved');
  change(stream, 16, 'session', 'cold');
  change(stream, 17, 'session', 'fresh', { tombstone: true });
  change(stream, 18, 'session', 'unknown', { tombstone: true });
  sessions.set('moved', item('moved', { parent: { kind: 'user' } }));
  sessions.set('cold', item('cold', { status: 'completed', parent: { kind: 'main', piSessionId: 'main' } }));
  for (let i = 0; i < 20; i++) await tick();
  const root = 'agora:root:user-tasks';
  assert.deepEqual(emitted.map(value => value.type === 'remove' ? ['remove', value.revision, value.id]
    : [value.revision, value.node.id, value.node.revision, value.node.id === root ? value.node.childCount : undefined]), [
    [11, 'agora:session:late', 11, undefined],
    [12, 'agora:session:fresh', 12, undefined],
    [12, root, 12, 3],
    [13, 'agora:session:fresh', 13, undefined],
    [14, root, 14, 3],
    [15, 'agora:session:moved', 15, undefined],
    [15, root, 15, 4],
    [16, 'agora:session:cold', 16, undefined],
    [16, root, 16, 3],
    ['remove', 17, 'agora:session:fresh'],
    [17, root, 17, 2],
    ['remove', 18, 'agora:session:unknown'],
  ]);
  assert.deepEqual(h.warnings, []);
});

test('快照扫描失败或来源不符时，订阅推送的用户任务根不填 childCount', async t => {
  let epoch = 'db';
  const h = setup(t, ({ path, url }) => {
    if (url.pathname === '/v1/sessions') {
      if (url.searchParams.get('snapshot') === '1') return { status: 200, body: page([]) };
      return { status: 200, body: page([], { changesCursor: { epoch, seq: 10 } }) };
    }
    if (path === '/v1/sessions/fresh') return { status: 200, body: item('fresh', { parent: { kind: 'user' } }) };
  });
  epoch = 'db-2';
  await h.views.tree.snapshot({ openNodeIds: [], recentSince: '2026-01-01T00:00:00Z' });
  const emitted = [];
  h.views.tree.subscribe({ epoch: 'db', revision: 10 }, value => emitted.push(value));
  change(h.streams[0], 11, 'session', 'fresh'); change(h.streams[0], 12, 'device', 'd1');
  for (let i = 0; i < 6; i++) await tick();
  assert.deepEqual(emitted.map(value => [value.revision, value.node.id, value.node.childCount]), [
    [11, 'agora:session:fresh', undefined], [12, 'agora:root:user-tasks', undefined]]);
});
