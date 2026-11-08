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
    title: id, status: 'running', revision: 2, createdAt: '2026-01-01T00:00:00Z',
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

test('tree maps snapshot filters, virtual user root, statuses and children epochs', async t => {
  const rows = [
    item('created', { status: 'created', parentId: null }),
    item('paused', { status: 'quota_paused' }),
    item('done', { status: 'completed', archiveState: 'missing' }),
    item('interrupted', { status: 'interrupted' }),
    item('seat', { taskId: null, kind: 'scribe', status: 'completed', originToolCall: {
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

test('tree serializes task-to-session reads, advances past non-tree changes and uses source revisions', async t => {
  const task = deferred(), session = deferred();
  const h = setup(t, ({ path }) => {
    if (path === '/v1/tasks/t1') return task.promise;
    if (path === '/v1/sessions/s1') return session.promise;
    if (path === '/v1/tasks/t2') return { status: 200, body: { agoraSessionId: 's2' } };
    if (path === '/v1/sessions/s2') return { status: 200, body: item('s2', { revision: 999 }) };
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
  assert.deepEqual(emitted.map(value => [value.type, value.revision]), [['upsert', 1], ['upsert', 2], ['remove', 4]]);
  assert.equal(emitted[1].node.revision, 2);
  assert.equal(emitted[2].id, 'agora:session:s2');
  assert.equal(h.panels[0].nodeId, 'agora:session:s1');
});

test('tree reset and cancellation invalidate queued reads without late upserts', async t => {
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

test('HTTP failures reset trees instead of forging deletions; only tombstones remove nodes', async t => {
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

test('session views pass entries/history through and map only agora protocol events', async t => {
  const entries = [{ opaquePiShape: { content: ['no parsing'] } }];
  const inFlight = { phase: 'streaming', tools: [], queue: { steering: [], followUp: [] } };
  const h = setup(t, ({ url }) => {
    if (url.pathname.endsWith('/snapshot')) return { status: 200, body: { cursor: { epoch: 'run', seq: 5 },
      leafId: 'leaf', entries, historyBefore: 'before', inFlight, unfinishedPartials: [], status: 'waiting_children', controlRevision: 99 } };
    if (url.pathname.endsWith('/history')) return { status: 200, body: { entries, historyBefore: null } };
    if (url.pathname === '/v1/sessions/s1') return { status: 200, body: item() };
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

test('sessions enforce read-only seats and map steer/stop without inventing concurrency checks', async t => {
  let current = item();
  let steerStatus = 200, stopStatus = 200;
  const h = setup(t, ({ method, path }) => {
    if (method === 'GET' && path === '/v1/sessions/s1') return { status: 200, body: current };
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
  assert.equal(h.requests.at(-1).options.actAsUser, true);
  steerStatus = 403;
  assert.deepEqual(await h.views.sessions.send(ref, { text: 'x' }, req), { status: 'rejected', message: 'steer denied' });
  const result = await h.views.sessions.abort(ref, { clearQueue: true, origin: {} });
  assert.deepEqual(result, { status: 'done', clearedText: ['原始\n文本', '未加标注'] });
  assert.equal('expectedRevision' in h.requests.find(request => request.path.endsWith('/stop')).body, false);
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

test('holds include the whole task tree and register for unhosted main sessions; counts and lifecycle release', async t => {
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

test('tree changes refresh holds and ordinary disposal releases live holds and streams', async t => {
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

test('holds reject non-advancing pagination and dispose suppresses in-flight registrations', async t => {
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

test('task panels use task/tree usage, context tokens and bounded generation results', async t => {
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
