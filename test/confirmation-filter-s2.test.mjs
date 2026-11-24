import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startDaemon } from '../packages/daemon/dist/index.js';
import { connectHost } from '../packages/protocol/dist/client.js';

const states = ['pending', 'executing', 'confirmed', 'failed', 'cancelled', 'expired'];
const activeQuery = 'state=pending&state=executing';
const ids = rows => rows.map(row => row.confirmationId);

async function setup(t) {
  const home = await mkdtemp(join(tmpdir(), 'agora-confirmation-filter-'));
  const driver = { async start() { throw new Error('列表读取不能启动模型'); }, async recoverOldRun() { throw new Error('列表读取不能恢复进程'); } };
  const daemon = await startDaemon({ home, driver });
  const clients = [];
  t.after(async () => {
    clients.forEach(client => client.close());
    await daemon.close({ force: true, timeoutMs: 1000 });
    await rm(home, { recursive: true, force: true });
  });
  const connect = async as => {
    const client = await connectHost({ home, as, autoStart: false });
    clients.push(client);
    if (as === 'agent:main') await client.request('POST', '/v1/principals/register', { sessionId: randomUUID(), ephemeral: true, cwd: home });
    return client;
  };
  const cli = await connect('host:cli'), pane = await connect('host:pane');
  const main = await connect('agent:main'), other = await connect('agent:main');
  const conn = client => daemon.auth.authenticate(`Bearer ${client.token}`);
  const http = async (client, query = '', extra = {}, path = '/v1/confirmations') => {
    const response = await fetch(daemon.url + path + (query ? `?${query}` : ''), {
      headers: { 'Agora-Protocol': '1', ...(client ? { Authorization: `Bearer ${client.token}` } : {}), ...extra },
      signal: AbortSignal.timeout(5000),
    });
    return { status: response.status, body: await response.json() };
  };
  const seed = (id, state, requestedBy = conn(cli).principalId) => {
    const at = new Date().toISOString(), expiresAt = '2099-01-01T00:00:00.000Z';
    const challenge = { action: 'agora.request.answer', target: id, paramsHash: 'fixture', nonce: id, expiresAt };
    daemon.store.run('INSERT INTO pending_confirmations(id,action,target,params,challenge,nonce,expires_at,requested_by,state,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
      id, challenge.action, id, JSON.stringify({ answers: [] }), JSON.stringify(challenge), id, expiresAt, requestedBy, state, at);
    return { confirmationId: id, state, requestedBy };
  };
  const changes = () => daemon.store.get('SELECT total_changes() AS count LIMIT 1').count;
  return { home, daemon, cli, pane, main, other, conn, http, seed, changes };
}

async function pages(f, client, query, limit) {
  const items = [], cursors = new Set();
  let cursor;
  for (let page = 0; page < 100; page++) {
    const response = await f.http(client, [query, `limit=${limit}`, ...(cursor ? [`cursor=${cursor}`] : [])].filter(Boolean).join('&'));
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const value = response.body;
    assert.ok(value.items.length <= limit);
    for (const item of value.items) {
      assert.ok(item.cursor > Number(cursor ?? 0));
      assert.equal(items.some(old => old.confirmationId === item.confirmationId), false);
      items.push(item);
    }
    if (value.nextCursor === null) return items;
    assert.equal(value.items.length, limit);
    assert.equal(value.nextCursor, String(value.items.at(-1).cursor));
    assert.equal(cursors.has(value.nextCursor), false);
    cursors.add(value.nextCursor);
    cursor = value.nextCursor;
  }
  assert.fail('分页未在预期范围内结束');
}

test('5000 条终态历史不挤占活动列表，SQL 内过滤与小页游标不漏项且不写业务状态', async t => {
  const f = await setup(t), active = [], history = [];
  const mainId = f.conn(f.main).principalId, otherId = f.conn(f.other).principalId;
  f.daemon.store.transaction(() => {
    for (let i = 0; i < 5000; i++) {
      history.push(f.seed(`history-${i}`, states[2 + i % 4], i % 2 ? mainId : otherId));
      if (i === 100) active.push(f.seed('active-main-pending', 'pending', mainId));
      if (i === 2500) active.push(f.seed('active-other-executing', 'executing', otherId));
    }
    active.push(f.seed('active-host-pending', 'pending'));
    f.seed('gap-confirmed', 'confirmed');
    active.push(f.seed('active-main-executing', 'executing', mainId));
    f.seed('gap-cancelled', 'cancelled');
    active.push(f.seed('active-host-last', 'pending'));
  });
  const before = f.changes();
  const response = await f.http(f.cli, activeQuery);
  assert.equal(response.status, 200);
  assert.deepEqual(ids(response.body.items), ids(active));
  assert.equal(response.body.nextCursor, null);
  assert.equal(response.body.items.every(item => ['pending', 'executing'].includes(item.state)), true);
  for (const client of [f.cli, f.pane, f.main, f.other]) {
    const expected = client === f.main ? active.filter(row => row.requestedBy === mainId)
      : client === f.other ? active.filter(row => row.requestedBy === otherId) : active;
    for (const limit of [1, 2]) assert.deepEqual(ids(await pages(f, client, activeQuery, limit)), ids(expected));
  }
  const duplicate = await f.http(f.cli, `${activeQuery}&state=pending&state=executing`);
  assert.equal(duplicate.status, 200);
  assert.deepEqual(duplicate.body, response.body);
  const empty = await f.http(f.cli, `${activeQuery}&cursor=${response.body.items.at(-1).cursor}`);
  assert.deepEqual(empty.body, { items: [], nextCursor: null });
  assert.equal(f.changes(), before, '读取列表不能执行动作或修改授权、审计和确认状态');
  const plan = f.daemon.store.all('EXPLAIN QUERY PLAN SELECT rowid AS cursor,* FROM pending_confirmations WHERE rowid>? AND (? IS NULL OR requested_by=?) AND state IN (?,?) ORDER BY rowid LIMIT ?',
    0, null, null, 'pending', 'executing', 201);
  t.diagnostic(`活动查询计划：${plan.map(row => row.detail).join('；')}`);
  assert.equal(history.length, 5000);
});

test('未给 state 保留全状态、旧调用签名和默认分页，每种合法状态均可筛选', async t => {
  const f = await setup(t), expected = [];
  f.daemon.store.transaction(() => {
    for (let i = 0; i < 55; i++) expected.push(f.seed(`all-${i}`, states[i % states.length]));
  });
  const before = f.changes();
  const response = await f.http(f.cli);
  assert.equal(response.status, 200);
  assert.equal(response.body.items.length, 50);
  assert.equal(response.body.nextCursor, String(response.body.items.at(-1).cursor));
  assert.deepEqual(response.body.items, f.daemon.security.listConfirmations());
  assert.deepEqual(ids(await pages(f, f.cli, '', 7)), ids(expected));
  assert.deepEqual(ids(f.daemon.security.listConfirmations(200, 0)), ids(expected));
  assert.deepEqual(ids(f.daemon.security.listConfirmations(200, 0, f.conn(f.cli).principalId)), ids(expected));
  for (const state of states) {
    const filtered = await f.http(f.cli, `state=${state}`);
    assert.equal(filtered.status, 200);
    assert.deepEqual(ids(filtered.body.items), ids(expected.filter(row => row.state === state)));
    assert.equal(filtered.body.nextCursor, null);
  }
  assert.deepEqual(ids(await pages(f, f.cli, states.map(state => `state=${state}`).join('&'), 8)), ids(expected));
  assert.equal(f.changes(), before);
});

test('空值、不支持值、组合格式、大小写和注入字符串均返回 400 invalid_params', async t => {
  const f = await setup(t);
  f.seed('unchanged', 'pending');
  const before = f.changes();
  for (const value of ['', ' ', '\t', '\u0000', 'Pending', 'PENDING', 'pending ', 'unknown', 'all', 'null', 'undefined', 'pending,executing', '["pending"]', "pending') OR 1=1 --"]) {
    for (const query of [`state=${encodeURIComponent(value)}`, `state=pending&state=${encodeURIComponent(value)}`, `state=${encodeURIComponent(value)}&state=executing`]) {
      const response = await f.http(f.cli, query);
      assert.equal(response.status, 400, query);
      assert.equal(response.body.error.code, 'invalid_params', query);
    }
  }
  const bare = await f.http(f.cli, 'state');
  assert.equal(bare.status, 400);
  assert.equal(bare.body.error.code, 'invalid_params');
  for (const selected of [[], [''], ['pending', 'bad'], ["pending') OR 1=1 --"]]) {
    assert.throws(() => f.daemon.security.listConfirmations(50, 0, undefined, selected), error => error.status === 400 && error.code === 'invalid_params');
  }
  assert.equal(f.changes(), before, '非法参数不能触发业务写入');
});

test('state 不扩张身份权限，终态详情仍可核实，未认证和浏览器请求仍被拒绝', async t => {
  const f = await setup(t), mainId = f.conn(f.main).principalId, otherId = f.conn(f.other).principalId;
  f.seed('own-pending', 'pending', mainId);
  f.seed('other-pending', 'pending', otherId);
  f.seed('own-confirmed', 'confirmed', mainId);
  f.seed('other-confirmed', 'confirmed', otherId);
  const own = await f.http(f.main, 'state=pending&state=confirmed');
  assert.equal(own.status, 200);
  assert.deepEqual(ids(own.body.items), ['own-pending', 'own-confirmed']);
  assert.deepEqual(ids((await f.http(f.main)).body.items), ['own-pending', 'own-confirmed']);
  assert.deepEqual(ids((await f.http(f.main, activeQuery)).body.items), ['own-pending']);
  const detail = await f.http(f.main, '', {}, '/v1/confirmations/own-confirmed');
  assert.equal(detail.status, 200);
  assert.equal(detail.body.state, 'confirmed');
  assert.equal((await f.http(f.main, '', {}, '/v1/confirmations/other-confirmed')).status, 403);
  assert.equal((await f.http(f.pane, '', {}, '/v1/confirmations/other-confirmed')).status, 200);
  assert.equal((await f.http(undefined, activeQuery)).status, 401);
  assert.equal((await f.http(f.cli, activeQuery, { Origin: 'https://example.com' })).status, 403);
  assert.equal((await f.http(f.main, activeQuery, { 'Agora-Act-As': 'user' })).status, 403);
});
