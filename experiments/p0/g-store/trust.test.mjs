// pane P0 #6：项目信任。pane-bridge 的 project_trust 处理器原型 + 服务端拉起前的预判。
// 每个场景一个隔离现场（临时 HOME 与 PI_CODING_AGENT_DIR，trust.json 只写在临时 agent 目录）。
// “实际加载”用两个可观察的效果判断：项目 .pi/APPEND_SYSTEM.md 的标记出现在发给 provider 的系统提示里，
// 项目 .pi/settings.json 的 defaultThinkingLevel=low 体现在 get_state.thinkingLevel。
// 运行：node --test experiments/p0/g-store/trust.test.mjs
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createExperiment, readJsonl } from '../harness/index.mjs';
import { PI_ROOT } from './lib.mjs';

// 服务端预判用 pi 自己的实现（pi-pane 设计中由 pi 导出的同名函数）。直接导入 trust-manager.js，
// 避免加载整个 pi 入口。
const { hasTrustRequiringProjectResources, ProjectTrustStore } = await import(
  pathToFileURL(join(PI_ROOT, 'dist/core/trust-manager.js')).href
);

const ext = (name) => fileURLToPath(new URL(`./trust/${name}`, import.meta.url));
const MARK = 'TRUST-MARKER-MAIN';

function withHome(home, fn) {
  const saved = process.env.HOME;
  process.env.HOME = home;
  try { return fn(); } finally { process.env.HOME = saved; }
}

/** 拉起前的服务端预判（pi-pane 主方案）：有需要信任的资源且没有保存的决定时才询问用户。 */
function precheck(e, cwd) {
  return withHome(e.home, () => ({
    hasResources: hasTrustRequiringProjectResources(cwd),
    saved: new ProjectTrustStore(e.agentDir).get(cwd),
  }));
}

function readTrust(e) {
  const path = join(e.agentDir, 'trust.json');
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

async function writeProjectResources(dir, marker) {
  mkdirSync(join(dir, '.pi'), { recursive: true });
  writeFileSync(join(dir, '.pi', 'APPEND_SYSTEM.md'), `${marker}\n`);
  writeFileSync(join(dir, '.pi', 'settings.json'), JSON.stringify({ defaultThinkingLevel: 'low' }));
}

/**
 * 跑一个场景，返回实际观察：
 * { pre, decisionSent, loaded, thinkingLevel, isProjectTrusted, bridgeLog, otherLog, trustBefore, trustAfter, e }
 */
async function scenario(t, opts) {
  const e = await createExperiment({
    settings: opts.defaultProjectTrust ? { defaultProjectTrust: opts.defaultProjectTrust } : {},
    script: { turns: [], fallback: { segments: [{ type: 'text', text: 'ok' }] } },
  });
  t.diagnostic(`fixture: ${e.root}`);
  let ok = false;
  t.after(async () => { await e.stop(); if (ok && !process.env.P0_KEEP) await e.cleanup(); });
  const real = realpathSync(e.cwd);
  if (opts.resources !== false) await writeProjectResources(e.cwd, MARK);
  if (opts.setup) await opts.setup(e, real);
  if (opts.trustJson) writeFileSync(join(e.agentDir, 'trust.json'), JSON.stringify(opts.trustJson(e, real), null, 2));
  const trustBefore = readTrust(e);
  const pre = precheck(e, e.cwd);
  // 主方案：有资源且没有保存的决定 → 浏览器询问 → 把用户的回答放进启动配置。
  const decisions = [];
  if (pre.hasResources && pre.saved === null && opts.userAnswer) decisions.push({ cwd: e.cwd, ...opts.userAnswer });
  // forceAnswer：绕过预判直接下发（例如启动配置与 trust.json 不一致时），用来确认处理器优先于 trust.json。
  if (opts.forceAnswer) decisions.push({ cwd: e.cwd, ...opts.forceAnswer });
  const bridgeLog = join(e.root, 'bridge.jsonl');
  const otherLog = join(e.root, 'other.jsonl');
  const configPath = join(e.root, 'bridge-config.json');
  writeFileSync(configPath, JSON.stringify({ decisions, logPath: bridgeLog, bridgeUrl: opts.bridgeUrl, askTimeoutMs: opts.askTimeoutMs }));
  const args = [];
  if (opts.early) args.push('-e', ext('early-trust.ts'));
  args.push('-e', ext('pane-bridge-trust.ts'));
  if (opts.late) args.push('-e', ext('late-trust.ts'));
  const rpc = await e.start({
    args: [...args, ...(opts.args ?? [])],
    env: { P0_PANE_BRIDGE_CONFIG: configPath, P0_TRUST_LOG: otherLog, P0_EARLY_TRUST: opts.early ?? '', P0_LATE_TRUST: opts.late ?? '', ...opts.env },
  });
  const observe = async (marker, from) => {
    const { response } = await rpc.promptAndWait(`probe ${randomUUID()}`, { timeoutMs: 20_000 });
    assert.equal(response.success, true);
    const reqs = await e.requests();
    const last = reqs.at(-1);
    const state = (await rpc.command({ type: 'get_state' })).data;
    return { loaded: last.systemPrompt.includes(marker), thinkingLevel: state.thinkingLevel, requestIndex: reqs.length - 1 };
  };
  const first = await observe(MARK);
  const result = { e, rpc, pre, decisionSent: decisions[0] ?? null, ...first, trustBefore };
  if (opts.after) Object.assign(result, await opts.after({ e, rpc, observe, real }));
  result.bridgeLog = await readJsonl(bridgeLog);
  result.otherLog = await readJsonl(otherLog);
  result.trustAfter = readTrust(e);
  const starts = result.bridgeLog.filter((r) => r.kind === 'session_start');
  result.isProjectTrusted = starts[0]?.isProjectTrusted;
  result.paneHandlerCalls = result.bridgeLog.filter((r) => r.kind === 'project_trust');
  t.diagnostic(`预判: hasResources=${pre.hasResources} saved=${pre.saved}；下发决定: ${JSON.stringify(result.decisionSent)}`);
  t.diagnostic(`实际: APPEND_SYSTEM 加载=${result.loaded} thinkingLevel=${result.thinkingLevel} isProjectTrusted=${result.isProjectTrusted}`);
  t.diagnostic(`pane 处理器调用: ${JSON.stringify(result.paneHandlerCalls.map(({ source, result: r, hasUI, uiConfirm, mode, instance }) => ({ instance, source, r, hasUI, uiConfirm, mode })))}`);
  if (result.otherLog.length) t.diagnostic(`其他处理器: ${JSON.stringify(result.otherLog.map(({ kind, mode }) => ({ kind, mode })))}`);
  t.diagnostic(`trust.json 前: ${JSON.stringify(trustBefore)} 后: ${JSON.stringify(result.trustAfter)}`);
  result.finish = () => { ok = true; };
  return result;
}

/** 所有场景共同的断言：会话视图显示的状态（isProjectTrusted）与实际加载一致，两个效果一致。 */
function assertConsistent(r, expectedLoaded) {
  assert.equal(r.loaded, expectedLoaded, 'APPEND_SYSTEM 是否加载');
  assert.equal(r.thinkingLevel === 'low', expectedLoaded, '项目 settings.json 是否生效');
  assert.equal(r.isProjectTrusted, expectedLoaded, 'ctx.isProjectTrusted() 与实际加载一致');
}

// ---------- A. 服务端预判与 pi 实际决定 ----------

test('A1 没有需要信任的资源：不询问，pi 直接信任，不触发 project_trust', async (t) => {
  const r = await scenario(t, { resources: false });
  assert.equal(r.pre.hasResources, false);
  assert.equal(r.paneHandlerCalls.length, 0);
  assert.equal(r.isProjectTrusted, true);
  r.finish();
});

test('A2 没有资源但 trust.json 对该目录存了 false：记录 isProjectTrusted', async (t) => {
  const r = await scenario(t, { resources: false, trustJson: (e, real) => ({ [real]: false }) });
  assert.equal(r.pre.hasResources, false);
  assert.equal(r.pre.saved, false);
  assert.equal(r.paneHandlerCalls.length, 0);
  t.diagnostic(`观察：无资源目录在 trust.json 里为 false 时 isProjectTrusted=${r.isProjectTrusted}`);
  assert.equal(r.isProjectTrusted, false);
  r.finish();
});

test('A3 trust.json 对该目录存了 true：预判 saved=true，不询问，pane 返回 undecided，pi 加载', async (t) => {
  const r = await scenario(t, { trustJson: (e, real) => ({ [real]: true }), userAnswer: { trusted: 'no', remember: false } });
  assert.equal(r.pre.saved, true);
  assert.equal(r.decisionSent, null);
  assert.equal(r.paneHandlerCalls[0].result.trusted, 'undecided');
  assertConsistent(r, true);
  r.finish();
});

test('A4 父目录在 trust.json 里为 true：预判与 pi 都按最近的父目录决定加载', async (t) => {
  const r = await scenario(t, { trustJson: (e, real) => ({ [realpathSync(e.root)]: true }) });
  assert.equal(r.pre.saved, true);
  assertConsistent(r, true);
  r.finish();
});

test('A5 父目录 true、该目录 false：预判与 pi 都取该目录的 false', async (t) => {
  const r = await scenario(t, { trustJson: (e, real) => ({ [realpathSync(e.root)]: true, [real]: false }) });
  assert.equal(r.pre.saved, false);
  assertConsistent(r, false);
  r.finish();
});

test('A6 父目录 false、该目录 true：取该目录的 true', async (t) => {
  const r = await scenario(t, { trustJson: (e, real) => ({ [realpathSync(e.root)]: false, [real]: true }) });
  assert.equal(r.pre.saved, true);
  assertConsistent(r, true);
  r.finish();
});

test('A7 trust.json 的键是未解析符号链接的路径（macOS 的 /var → /private/var）', async (t) => {
  const r = await scenario(t, { trustJson: (e) => ({ [e.cwd]: true }) });
  t.diagnostic(`键 ${r.e.cwd}；realpath ${realpathSync(r.e.cwd)}；预判 saved=${r.pre.saved}；pi 实际加载=${r.loaded}`);
  assert.equal(r.pre.saved === true, r.loaded, '预判与 pi 实际一致');
  r.finish();
});

test('A8 只有祖先目录里有 .agents/skills：预判为需要信任', async (t) => {
  const r = await scenario(t, {
    resources: false,
    setup: (e) => mkdirSync(join(e.root, '.agents', 'skills'), { recursive: true }),
    userAnswer: { trusted: 'no', remember: false },
  });
  assert.equal(r.pre.hasResources, true);
  assert.equal(r.paneHandlerCalls.length, 1, 'pi 也认为需要信任并触发 project_trust');
  assert.equal(r.isProjectTrusted, false);
  r.finish();
});

// ---------- B. pane-bridge 返回决定 ----------

for (const [name, answer, loaded, remembered] of [
  ['B1 信任、不记住', { trusted: 'yes', remember: false }, true, undefined],
  ['B2 信任并记住', { trusted: 'yes', remember: true }, true, true],
  ['B3 不信任并记住', { trusted: 'no', remember: true }, false, false],
  ['B4 不信任、不记住', { trusted: 'no', remember: false }, false, undefined],
]) {
  test(`${name}：处理器按启动配置返回，remember 决定是否写入 trust.json`, async (t) => {
    const r = await scenario(t, { userAnswer: answer });
    assert.deepEqual(r.decisionSent?.trusted, answer.trusted);
    assert.equal(r.paneHandlerCalls.length, 1);
    assert.deepEqual(r.paneHandlerCalls[0].result, answer);
    assert.equal(r.paneHandlerCalls[0].hasUI, false);
    assert.equal(r.paneHandlerCalls[0].uiConfirm, false);
    assertConsistent(r, loaded);
    const real = realpathSync(r.e.cwd);
    assert.equal(r.trustAfter?.[real], remembered, 'trust.json 中该目录的值');
    r.finish();
  });
}

for (const [name, early, pane, loaded] of [
  ['B5 更早的扩展返回 yes，pane 返回 no', 'yes', 'no', true],
  ['B6 更早的扩展返回 no，pane 返回 yes', 'no', 'yes', false],
  ['B7 更早的扩展抛出异常，pane 返回 yes', 'throw', 'yes', true],
  ['B8 更早的扩展返回 undecided，pane 返回 no', 'undecided', 'no', false],
]) {
  test(`${name}`, async (t) => {
    const r = await scenario(t, { early, userAnswer: { trusted: pane, remember: false } });
    assertConsistent(r, loaded);
    const paneCalled = r.paneHandlerCalls.length > 0;
    t.diagnostic(`pane 处理器是否被调用: ${paneCalled}`);
    assert.equal(paneCalled, early === 'throw' || early === 'undecided');
    r.finish();
  });
}

test('B9 trust.json 已有 yes，pane 仍返回 no（不记住）：处理器优先，不加载，trust.json 不变', async (t) => {
  const r = await scenario(t, { trustJson: (e, real) => ({ [real]: true }), forceAnswer: { trusted: 'no', remember: false } });
  assertConsistent(r, false);
  assert.deepEqual(r.trustAfter, r.trustBefore);
  r.finish();
});

// ---------- C. pane-bridge 返回 undecided ----------

test('C1 pane undecided（用户未作答），trust.json 已有 yes → 加载', async (t) => {
  // 用户未作答：服务端不下发决定。trust.json 的 yes 写在父目录，预判时视为已保存，这里模拟“未询问”。
  const r = await scenario(t, { trustJson: (e) => ({ [realpathSync(e.root)]: true }) });
  assert.equal(r.paneHandlerCalls[0].result.trusted, 'undecided');
  assertConsistent(r, true);
  r.finish();
});

test('C2 pane undecided，之后加载的扩展返回 yes → 加载', async (t) => {
  const r = await scenario(t, { late: 'yes' });
  assert.equal(r.paneHandlerCalls[0].result.trusted, 'undecided');
  assertConsistent(r, true);
  r.finish();
});

test('C3 pane undecided，defaultProjectTrust = "always" → 加载', async (t) => {
  const r = await scenario(t, { defaultProjectTrust: 'always' });
  assert.equal(r.paneHandlerCalls[0].result.trusted, 'undecided');
  assertConsistent(r, true);
  r.finish();
});

test('C4 pane undecided，其余都没有决定（defaultProjectTrust 默认 ask，RPC 无 UI）→ 不加载', async (t) => {
  const r = await scenario(t, {});
  assert.equal(r.paneHandlerCalls[0].result.trusted, 'undecided');
  assertConsistent(r, false);
  r.finish();
});

test('C5 pane undecided，defaultProjectTrust = "never"、trust.json 有 yes → trust.json 优先，加载', async (t) => {
  const r = await scenario(t, { defaultProjectTrust: 'never', trustJson: (e, real) => ({ [real]: true }) });
  assertConsistent(r, true);
  r.finish();
});

// ---------- D. 进程内切换到新目录 ----------

async function withBridgeServer(behavior, fn) {
  const requests = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      requests.push({ url: req.url, body: parsed });
      const answer = typeof behavior === 'function' ? behavior(req.url, parsed) : behavior;
      if (answer === 'hang') return; // 不回应，让处理器自己超时
      Promise.resolve(answer).then((value) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(value));
      });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`, requests);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

function makeOtherProjectSession(e) {
  const dir2 = join(e.root, 'proj2');
  mkdirSync(join(dir2, '.pi'), { recursive: true });
  writeFileSync(join(dir2, '.pi', 'APPEND_SYSTEM.md'), 'TRUST-MARKER-PROJ2\n');
  writeFileSync(join(dir2, '.pi', 'settings.json'), JSON.stringify({ defaultThinkingLevel: 'low' }));
  const file = join(e.agentDir, 'sessions', 'proj2.jsonl');
  mkdirSync(join(e.agentDir, 'sessions'), { recursive: true });
  const ts = new Date().toISOString();
  writeFileSync(file, [
    { type: 'session', version: 3, id: randomUUID(), timestamp: ts, cwd: dir2 },
    { type: 'model_change', id: 'm0000001', parentId: null, timestamp: ts, provider: 'p0-fake', modelId: 'scripted' },
    { type: 'message', id: 'u0000001', parentId: 'm0000001', timestamp: ts, message: { role: 'user', content: 'earlier', timestamp: Date.now() } },
  ].map((x) => `${JSON.stringify(x)}\n`).join(''));
  return { dir2, file };
}

for (const [name, behavior, expectLoaded, useBridge] of [
  ['D1 服务端回答 yes（不记住）', { trusted: 'yes', remember: false }, true, true],
  ['D2 服务端不回应，处理器超时返回 undecided', 'hang', false, true],
  ['D3 回连不可用（没有 bridgeUrl）', null, false, false],
]) {
  test(`${name}：切换到另一个有资源的目录时经回连询问`, async (t) => {
    await withBridgeServer(behavior ?? {}, async (url, serverRequests) => {
      const r = await scenario(t, {
        userAnswer: { trusted: 'yes', remember: false },
        bridgeUrl: useBridge ? url : undefined,
        askTimeoutMs: 1500,
        after: async ({ e, rpc, observe }) => {
          const { dir2, file } = makeOtherProjectSession(e);
          const mainFile = (await rpc.command({ type: 'get_state' })).data.sessionFile;
          const switchStarted = performance.now();
          const sw = await rpc.command({ type: 'prompt', message: `/g-switch ${file}` }, { timeoutMs: 20_000 });
          const switchMs = Math.round(performance.now() - switchStarted);
          assert.equal(sw.success, true);
          const second = await observe('TRUST-MARKER-PROJ2');
          // 再切回最初的会话：同一进程内已解析过的目录不再触发 project_trust。
          const back = await rpc.command({ type: 'prompt', message: `/g-switch ${mainFile}` }, { timeoutMs: 20_000 });
          assert.equal(back.success, true);
          const third = await observe(MARK);
          return { dir2, second, third, switchMs };
        },
      });
      const calls = r.paneHandlerCalls;
      const starts = r.bridgeLog.filter((x) => x.kind === 'session_start');
      t.diagnostic(`服务端收到的询问: ${JSON.stringify(serverRequests)}`);
      t.diagnostic(`切换后: 加载=${r.second.loaded} thinkingLevel=${r.second.thinkingLevel}；session_start: ${JSON.stringify(starts.map(({ instance, reason, isProjectTrusted, cwd }) => ({ instance, reason, isProjectTrusted, cwd })))}`);
      t.diagnostic(`factory 调用: ${JSON.stringify(r.bridgeLog.filter((x) => x.kind === 'factory').map((x) => x.instance))}`);
      t.diagnostic(`切换命令耗时 ${r.switchMs} ms；切回原会话后: 加载=${r.third.loaded} thinkingLevel=${r.third.thinkingLevel}`);
      assert.equal(calls.length, 2, '启动一次、切换到新目录一次；切回原目录不再询问');
      assert.equal(r.third.loaded, true, '切回后沿用本进程对原目录的决定');
      assert.equal(starts.at(-1).isProjectTrusted, true);
      assert.equal(calls[1].eventCwd, r.dir2);
      assert.equal(calls[1].source, useBridge ? (behavior === 'hang' ? 'bridge-timeout' : 'bridge-answer') : 'no-bridge');
      assert.equal(r.second.loaded, expectLoaded);
      assert.equal(r.second.thinkingLevel === 'low', expectLoaded);
      const afterSwitch = starts.at(-2);
      assert.equal(afterSwitch.cwd, r.dir2);
      assert.equal(afterSwitch.isProjectTrusted, expectLoaded, '切换后 isProjectTrusted 与实际一致');
      if (useBridge) assert.equal(serverRequests.length, 1);
      r.finish();
    });
  });
}

// ---------- E. 处理器运行时机与实例 ----------

test('E1 project_trust 处理器运行时 pane-bridge 的工厂已执行、进程级连接对象已存在；记录实例序号', async (t) => {
  const r = await scenario(t, { userAnswer: { trusted: 'yes', remember: false } });
  const order = r.bridgeLog.map((x) => `${x.kind}#${x.instance}`);
  t.diagnostic(`事件顺序: ${order.join(' → ')}`);
  t.diagnostic(`处理器上下文: eventCwd=${r.paneHandlerCalls[0].eventCwd} ctxCwd=${r.paneHandlerCalls[0].ctxCwd} canonical=${r.paneHandlerCalls[0].canonicalCwd} mode=${r.paneHandlerCalls[0].mode}`);
  assert.equal(r.bridgeLog[0].kind, 'factory');
  assert.equal(r.paneHandlerCalls[0].source, 'startup-config');
  r.finish();
});

test('E2 工厂函数异步兑换 ticket（服务端延迟 300 ms 响应）后，project_trust 处理器拿到兑换响应里的启动配置', async (t) => {
  let cwd;
  const behavior = (url, body) => {
    if (url !== '/exchange' || body.ticket !== 'ticket-1') return { error: 'bad ticket' };
    return new Promise((resolve) => setTimeout(() => resolve({ startupConfig: { decisions: [{ cwd, trusted: 'yes', remember: false }] } }), 300));
  };
  await withBridgeServer(behavior, async (url, serverRequests) => {
    const r = await scenario(t, {
      setup: (e) => { cwd = e.cwd; },
      env: { P0_PANE_BRIDGE_EXCHANGE_URL: `${url}/exchange`, P0_PANE_BRIDGE_TICKET: 'ticket-1' },
    });
    t.diagnostic(`事件顺序: ${r.bridgeLog.map((x) => `${x.kind}#${x.instance}${x.kind === 'factory' ? `(exchanged=${x.exchanged},decisions=${x.decisions})` : ''}`).join(' → ')}`);
    t.diagnostic(`服务端收到: ${JSON.stringify(serverRequests)}`);
    assert.equal(serverRequests.length, 1);
    assert.equal(r.paneHandlerCalls[0].source, 'startup-config');
    assertConsistent(r, true);
    r.finish();
  });
});
