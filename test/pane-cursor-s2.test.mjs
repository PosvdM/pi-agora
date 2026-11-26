import test from 'node:test';
import assert from 'node:assert/strict';
import { createViews, REVISION_SLOTS } from '../packages/pane-plugin/dist/views.js';
import { createOfflineViews } from '../packages/pane-plugin/dist/offline.js';

const PARENT = 'agora:root:user-tasks';
const UNSYNCED = { reset: true, epoch: 'agora:unsynced' };
const row = id => ({ agoraSessionId: id, taskId: `t-${id}`, parentId: PARENT,
  title: id, status: 'completed', revision: 3, treeRevision: 7, createdAt: '2026-01-01T00:00:00Z', hasChildren: false });
const ok = (epoch = 'db', items = [], nextCursor = null) => ({ status: 200,
  body: { items, changesCursor: { epoch, seq: 10 }, nextCursor } });
const invalid = () => ({ status: 400,
  body: { error: { code: 'invalid_params', message: '分页游标与查询条件不符' } } });
function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}
/**
 * 先以 daemon epoch db 取一次快照建立处理器实例（这些请求不计入 requests，也不经过 handler），
 * 之后的分页请求按顺序交给 handler，count 从 1 开始。h.second 是本实例 epoch 下的第二页请求。
 */
async function setup(t, handler) {
  const requests = [];
  let opening = true;
  const views = createViews({
    online: () => true,
    api: {
      async request(method, path, body, options) {
        assert.equal(method, 'GET');
        assert.equal(body, undefined);
        const url = new URL(path, 'http://agora');
        assert.equal(url.pathname, '/v1/sessions');
        if (opening) return ok();
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
  const { epoch } = await views.tree.snapshot({ openNodeIds: [], recentSince: '2026-01-01T00:00:00Z' });
  opening = false;
  return { views, requests, epoch, second: { epoch, limit: 1, cursor: 'valid-second-page' } };
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

test('离线第一页的真实 nextCursor 在恢复在线后返回 reset，且不读取 daemon', async t => {
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
  const h = await setup(t, request => db.handle(request));
  assert.notEqual(h.epoch, first.epoch, '在线与离线的 epoch 不同');
  assert.deepEqual(await h.views.tree.children(PARENT, {
    epoch: first.epoch, limit: 1, cursor: first.nextCursor,
  }), { reset: true, epoch: h.epoch });
  assert.equal(h.requests.length, 0);
});

test('旧数据库 epoch 签发的第二页游标被 daemon 拒绝后核实 epoch，实例结束并 reset', async t => {
  const db = daemon();
  const h = await setup(t, request => db.handle(request));
  const first = await h.views.tree.children(PARENT, { epoch: h.epoch, limit: 1 });
  assert.ok(first.nextCursor);
  assert.equal(first.epoch, h.epoch);
  const before = h.requests.length;
  db.setEpoch('new-db');
  assert.deepEqual(await h.views.tree.children(PARENT, {
    epoch: first.epoch, limit: 1, cursor: first.nextCursor,
  }), UNSYNCED);
  assert.equal(h.requests.length, before + 2);
  assert.equal(h.requests[before].params.get('cursor'), first.nextCursor);
  assertProbe(h.requests.at(-1));
  // 实例已结束，同一 epoch 的后续分页直接 reset。
  assert.deepEqual(await h.views.tree.children(PARENT, { epoch: first.epoch, limit: 1 }), UNSYNCED);
  assert.equal(h.requests.length, before + 2);
});

test('同 epoch 的非法游标复核后仍抛出原始参数错误', async t => {
  const db = daemon();
  const h = await setup(t, request => db.handle(request));
  await assert.rejects(h.views.tree.children(PARENT, { ...h.second, cursor: 'invalid' }), /分页游标与查询条件不符/);
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[0].params.get('cursor'), 'invalid');
  assertProbe(h.requests[1]);
  assert.equal((await h.views.tree.children(PARENT, { epoch: h.epoch, limit: 1 })).epoch, h.epoch, '实例保留');
});

test('游标被拒绝后复核发现 daemon 已换 epoch 时 reset', async t => {
  const h = await setup(t, (_request, count) => count === 1 ? invalid() : ok('new-db'));
  assert.deepEqual(await h.views.tree.children(PARENT, h.second), UNSYNCED);
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[0].params.get('cursor'), h.second.cursor);
  assertProbe(h.requests[1]);
});

test('合法第二页保留 parent、limit、游标和分页结果，不先核实 epoch', async t => {
  const db = daemon();
  const h = await setup(t, request => db.handle(request));
  const first = await h.views.tree.children(PARENT, { epoch: h.epoch, limit: 1 });
  const before = h.requests.length;
  const second = await h.views.tree.children(PARENT, { epoch: h.epoch, limit: 1, cursor: first.nextCursor });
  assert.equal(h.requests.length, before + 1);
  const params = h.requests.at(-1).params;
  assert.equal(params.get('parent'), PARENT);
  assert.equal(params.get('limit'), '1');
  assert.equal(params.get('cursor'), first.nextCursor);
  assert.equal(second.epoch, h.epoch);
  assert.equal(second.revision, 10 * REVISION_SLOTS + REVISION_SLOTS - 1, '分页切点包含 seq 10 的全部推送');
  assert.deepEqual(second.nodes.map(node => [node.id, node.parentId, node.revision]), [['agora:session:second', PARENT, 7 * REVISION_SLOTS]]);
  assert.equal(second.nextCursor, undefined);
});

test('分页成功回复跨 epoch 时实例结束并返回 reset', async t => {
  const h = await setup(t, () => ok('new-db', [row('second')]));
  assert.deepEqual(await h.views.tree.children(PARENT, h.second), UNSYNCED);
  assert.equal(h.requests.length, 1);
});

test('HTTP、传输和取消失败均保留失败，不返回空页或 reset', async t => {
  for (const stage of [1, 2]) {
    for (const kind of ['HTTP', 'transport', 'abort']) {
      await t.test(`第 ${stage} 次读取发生 ${kind} 失败`, async t => {
        const failure = kind === 'abort' ? new DOMException('请求已取消', 'AbortError') : new Error('读取失败');
        const h = await setup(t, (_request, count) => {
          if (count === stage) {
            if (kind === 'HTTP') return { status: 503, body: { error: { message: '读取失败' } } };
            throw failure;
          }
          return count === 1 ? invalid() : ok();
        });
        await assert.rejects(h.views.tree.children(PARENT, h.second), kind === 'HTTP' ? /读取失败/ : error => error === failure);
        assert.equal(h.requests.length, stage);
      });
    }
  }
});

test('其他 HTTP 错误以及不带游标的参数错误不触发 epoch 复核', async t => {
  for (const [status, code, cursor] of [
    [400, 'other_error', 'valid-second-page'], [403, 'invalid_params', 'valid-second-page'],
    [500, 'invalid_params', 'valid-second-page'], [400, 'invalid_params', undefined],
  ]) {
    await t.test(`${status}/${code}/${cursor ?? '无游标'}`, async t => {
      const h = await setup(t, (_request, count) => count === 1
        ? { status, body: { error: { code, message: '不可掩盖的读取错误' } } } : ok('new-db'));
      await assert.rejects(h.views.tree.children(PARENT, { ...h.second, cursor }), /不可掩盖的读取错误/);
      assert.equal(h.requests.length, 1);
    });
  }
});

test('dispose 中断每个读取阶段，迟到的成功响应或参数错误不能产生结果', async t => {
  for (const stage of [1, 2]) {
    await t.test(`第 ${stage} 次读取期间 dispose`, async t => {
      const entered = deferred(), pending = deferred();
      const h = await setup(t, (_request, count) => {
        if (count === stage) { entered.resolve(); return pending.promise; }
        return count === 1 ? invalid() : ok();
      });
      const result = h.views.tree.children(PARENT, h.second);
      const rejected = assert.rejects(result, { name: 'AbortError' });
      await entered.promise;
      h.views.dispose();
      assert.equal(h.requests.at(-1).options.signal.aborted, true);
      pending.resolve(stage === 1 ? invalid() : ok('new-db'));
      await rejected;
      assert.equal(h.requests.length, stage);
      await assert.rejects(h.views.tree.children(PARENT, h.second), /视图已关闭/);
      assert.equal(h.requests.length, stage);
    });
  }
});
