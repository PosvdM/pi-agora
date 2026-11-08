import test from 'node:test';
import assert from 'node:assert/strict';
import { createViews } from '../packages/pane-plugin/dist/views.js';
import { createOfflineViews } from '../packages/pane-plugin/dist/offline.js';

const PARENT = 'agora:root:user-tasks';
const SECOND = { epoch: 'db', limit: 1, cursor: 'valid-second-page' };
const row = id => ({ agoraSessionId: id, taskId: `t-${id}`, parentId: PARENT,
  title: id, status: 'completed', revision: 7, createdAt: '2026-01-01T00:00:00Z', hasChildren: false });
const ok = (epoch = 'db', items = [], nextCursor = null) => ({ status: 200,
  body: { items, changesCursor: { epoch, seq: 10 }, nextCursor } });
const invalid = () => ({ status: 400,
  body: { error: { code: 'invalid_params', message: '分页游标与查询条件不符' } } });
function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}
function setup(t, handler) {
  const requests = [];
  const views = createViews({
    online: () => true,
    api: {
      async request(method, path, body, options) {
        assert.equal(method, 'GET');
        assert.equal(body, undefined);
        const url = new URL(path, 'http://agora');
        assert.equal(url.pathname, '/v1/sessions');
        const request = { path, options, params: url.searchParams };
        requests.push(request);
        return handler(request, requests.length);
      },
      subscribe() { throw new Error('分页不应订阅变更流'); },
      close() {},
    },
    context: { log: { warn() {} }, mainSessions: { onChange: () => () => {} } },
  });
  t.after(() => views.dispose());
  return { views, requests };
}
function assertProbe(request) {
  assert.equal(request.path, '/v1/sessions?limit=1');
  assert.equal(request.params.has('cursor'), false);
  assert.equal(request.params.has('parent'), false);
  assert.equal(request.options.signal.aborted, false);
}

// 模拟 daemon 的 epoch 绑定；只接受当前来源签发的分页游标。
function daemon() {
  let epoch = 'db';
  const cursor = () => Buffer.from(JSON.stringify({ v: 1, after: 1, filter: `fingerprint:${epoch}` })).toString('base64url');
  return {
    setEpoch(value) { epoch = value; },
    handle({ params }) {
      const raw = params.get('cursor');
      if (raw) {
        try {
          const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
          if (parsed.v !== 1 || parsed.filter !== `fingerprint:${epoch}`) return invalid();
        } catch { return invalid(); }
        return ok(epoch, [row('second')]);
      }
      return ok(epoch, [row('first')], cursor());
    },
  };
}

test('离线第一页的真实 nextCursor 在恢复在线后返回 reset，且不发送旧游标', async t => {
  const summaries = ['first', 'second'].map(id => ({ ...row(id), kind: 'task', model: 'test',
    profile: 'implement', convenerId: 'user', parent: { kind: 'user' }, archiveState: 'ok' }));
  const offline = createOfflineViews({
    async listSessions() { return { items: summaries }; },
    close() {},
  }, 'offline:period');
  t.after(() => offline.dispose());
  const first = await offline.tree.children(PARENT, { epoch: 'offline:period', limit: 1 });
  assert.ok(first.nextCursor);
  assert.equal(first.nodes.length, 1);
  const db = daemon();
  const h = setup(t, request => db.handle(request));
  assert.deepEqual(await h.views.tree.children(PARENT, {
    epoch: first.epoch, limit: 1, cursor: first.nextCursor,
  }), { reset: true, epoch: 'db' });
  assert.equal(h.requests.length, 1);
  assertProbe(h.requests[0]);
});

test('旧数据库 epoch 签发的第二页游标在新 epoch 直接 reset', async t => {
  const db = daemon();
  const h = setup(t, request => db.handle(request));
  const first = await h.views.tree.children(PARENT, { epoch: 'db', limit: 1 });
  assert.ok(first.nextCursor);
  const before = h.requests.length;
  db.setEpoch('new-db');
  assert.deepEqual(await h.views.tree.children(PARENT, {
    epoch: first.epoch, limit: 1, cursor: first.nextCursor,
  }), { reset: true, epoch: 'new-db' });
  assert.equal(h.requests.length, before + 1);
  assertProbe(h.requests.at(-1));
});

test('同 epoch 的非法游标复核后仍抛出原始参数错误', async t => {
  const db = daemon();
  const h = setup(t, request => db.handle(request));
  await assert.rejects(h.views.tree.children(PARENT, { ...SECOND, cursor: 'invalid' }), /分页游标与查询条件不符/);
  assert.equal(h.requests.length, 3);
  assertProbe(h.requests[0]);
  assert.equal(h.requests[1].params.get('cursor'), 'invalid');
  assertProbe(h.requests[2]);
});

test('前置核实后 epoch 再次变更，游标被拒绝后复核并 reset', async t => {
  const h = setup(t, (_request, count) => count === 1 ? ok() : count === 2 ? invalid() : ok('new-db'));
  assert.deepEqual(await h.views.tree.children(PARENT, SECOND), { reset: true, epoch: 'new-db' });
  assert.equal(h.requests.length, 3);
  assertProbe(h.requests[0]);
  assert.equal(h.requests[1].params.get('cursor'), SECOND.cursor);
  assertProbe(h.requests[2]);
});

test('合法第二页保留 parent、limit、游标和分页结果', async t => {
  const db = daemon();
  const h = setup(t, request => db.handle(request));
  const first = await h.views.tree.children(PARENT, { epoch: 'db', limit: 1 });
  const before = h.requests.length;
  const second = await h.views.tree.children(PARENT, { epoch: 'db', limit: 1, cursor: first.nextCursor });
  assert.equal(h.requests.length, before + 2);
  assertProbe(h.requests[before]);
  const params = h.requests.at(-1).params;
  assert.equal(params.get('parent'), PARENT);
  assert.equal(params.get('limit'), '1');
  assert.equal(params.get('cursor'), first.nextCursor);
  assert.equal(second.epoch, 'db');
  assert.equal(second.revision, 10);
  assert.deepEqual(second.nodes.map(node => [node.id, node.parentId, node.revision]), [['agora:session:second', PARENT, 7]]);
  assert.equal(second.nextCursor, undefined);
});

test('分页成功回复跨 epoch 时仍返回 reset', async t => {
  const h = setup(t, (_request, count) => count === 1 ? ok() : ok('new-db', [row('second')]));
  assert.deepEqual(await h.views.tree.children(PARENT, SECOND), { reset: true, epoch: 'new-db' });
  assert.equal(h.requests.length, 2);
});

test('HTTP、传输和取消失败均保留失败，不返回空页或 reset', async t => {
  for (const stage of [1, 2, 3]) {
    for (const kind of ['HTTP', 'transport', 'abort']) {
      await t.test(`第 ${stage} 次读取发生 ${kind} 失败`, async t => {
        const failure = kind === 'abort' ? new DOMException('请求已取消', 'AbortError') : new Error('读取失败');
        const h = setup(t, (_request, count) => {
          if (count === stage) {
            if (kind === 'HTTP') return { status: 503, body: { error: { message: '读取失败' } } };
            throw failure;
          }
          return count === 2 ? invalid() : ok();
        });
        await assert.rejects(h.views.tree.children(PARENT, SECOND), kind === 'HTTP' ? /读取失败/ : error => error === failure);
        assert.equal(h.requests.length, stage);
      });
    }
  }
});

test('其他 HTTP 错误以及不带游标的参数错误不触发 epoch 复核', async t => {
  for (const [status, code, cursor] of [
    [400, 'other_error', SECOND.cursor], [403, 'invalid_params', SECOND.cursor],
    [500, 'invalid_params', SECOND.cursor], [400, 'invalid_params', undefined],
  ]) {
    await t.test(`${status}/${code}/${cursor ?? '无游标'}`, async t => {
      const h = setup(t, (_request, count) => count === 1 ? ok() : count === 2
        ? { status, body: { error: { code, message: '不可掩盖的读取错误' } } } : ok('new-db'));
      await assert.rejects(h.views.tree.children(PARENT, { ...SECOND, cursor }), /不可掩盖的读取错误/);
      assert.equal(h.requests.length, 2);
    });
  }
});

test('dispose 中断每个读取阶段，迟到的成功响应或参数错误不能产生结果', async t => {
  for (const stage of [1, 2, 3]) {
    await t.test(`第 ${stage} 次读取期间 dispose`, async t => {
      const entered = deferred(), pending = deferred();
      const h = setup(t, (_request, count) => {
        if (count === stage) { entered.resolve(); return pending.promise; }
        return count === 2 ? invalid() : ok();
      });
      const result = h.views.tree.children(PARENT, SECOND);
      const rejected = assert.rejects(result, { name: 'AbortError' });
      await entered.promise;
      h.views.dispose();
      assert.equal(h.requests.at(-1).options.signal.aborted, true);
      pending.resolve(stage === 2 ? invalid() : ok('new-db'));
      await rejected;
      assert.equal(h.requests.length, stage);
      await assert.rejects(h.views.tree.children(PARENT, SECOND), /视图已关闭/);
      assert.equal(h.requests.length, stage);
    });
  }
});
