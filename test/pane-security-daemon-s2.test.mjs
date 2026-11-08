import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign, verify } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startDaemon } from "../packages/daemon/dist/index.js";
import { signingData } from "../packages/daemon/dist/security.js";
import { connectHost } from "../packages/protocol/dist/client.js";
import createPlugin from "../packages/pane-plugin/dist/plugin.js";
import { connectDaemonApi } from "../packages/pane-plugin/dist/transport.js";
import { FORM_CACHE_FILE } from "../packages/pane-plugin/dist/form-cache.js";

const questions = [{ id: "q", question: "允许继续吗？", options: [{ label: "允许" }, { label: "拒绝" }] }];
const answers = [{ id: "q", selected: ["允许"] }];
const globalTarget = { type: "global" };
const limits = { timeout: 20_000 };

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function eventually(check, message) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(10);
  }
  assert.fail(message);
}
function browser(label = "测试浏览器") {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const deviceId = randomUUID(), spki = publicKey.export({ type: "spki", format: "der" }).toString("base64url");
  return {
    deviceId, publicKey: spki, alg: "ECDSA-P256-SHA256", label, connected: true,
    proof(payload) {
      const signature = sign("sha256", signingData(payload), { key: privateKey, dsaEncoding: "ieee-p1363" });
      assert.equal(verify("sha256", signingData(payload), { key: publicKey, dsaEncoding: "ieee-p1363" }, signature), true);
      return { deviceId, publicKey: spki, alg: "ECDSA-P256-SHA256", signature: signature.toString("base64url") };
    },
  };
}

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), "agora-pane-security-wire-"));
  const tabs = [], calls = [], clients = [];
  let daemon, running = false, alertsGate, latestAlerts;
  let starts = 0;
  const nativeFetch = globalThis.fetch;
  t.after(async () => {
    alertsGate?.resolve();
    try {
      for (const tab of tabs) await tab.plugin.deactivate();
      for (const client of clients) client.close();
      if (running) await daemon.close({ force: true, timeoutMs: 1_000 });
      assert.equal(starts, 0, "安全测试不能启动模型或联网调用模型");
    } finally {
      globalThis.fetch = nativeFetch;
      await rm(home, { recursive: true, force: true });
    }
  });
  daemon = await startDaemon({ home, driver: {
    async start() { starts++; throw new Error("安全测试不启动模型"); },
    async recoverOldRun() { throw new Error("安全测试没有历史进程"); },
  } });
  running = true;
  // 观测与读屏障均透传真实 HTTP；不替换状态码、响应体、鉴权或签名。
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.origin !== daemon.url) return nativeFetch(input, init);
    const method = init?.method ?? "GET";
    const isAlerts = method === "GET" && url.pathname === "/v1/security/alerts";
    const observed = method === "POST" && url.pathname.startsWith("/v1/") || isAlerts;
    const call = observed ? { method, path: url.pathname, headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined } : undefined;
    if (call) calls.push(call);
    if (isAlerts && alertsGate) await alertsGate.promise;
    const response = await nativeFetch(input, init);
    if (call) {
      call.status = response.status;
      call.reply = await response.clone().json();
      if (isAlerts) latestAlerts = call;
    }
    return response;
  };
  const api = await connectDaemonApi(home); clients.push(api);
  const main = await connectHost({ home, as: "agent:main", autoStart: false }); clients.push(main);
  await main.request("POST", "/v1/principals/register", { sessionId: randomUUID(), ephemeral: true, cwd: home });

  async function tab(device = browser()) {
    const banners = new Map(), forms = new Map(), events = [], confirmations = [];
    const dataDir = join(home, `pane-${tabs.length}`);
    const origin = { client: "browser", connectionId: randomUUID(), deviceId: device.deviceId, receivedAt: new Date().toISOString() };
    const value = { device, dataDir, origin, banners, forms, events, confirmations,
      onConfirm: request => device.proof(request.payload) };
    const context = {
      paneProtocol: 1, dataDir,
      log: { info() {}, warn(...args) { events.push({ type: "warn", args }); }, error() {} },
      notify(notice) { events.push({ type: "notify", notice }); }, panelChanged() {},
      formAdded(form) { forms.set(form.id, structuredClone(form)); events.push({ type: "formAdded", form }); },
      formRemoved(id, reason) { forms.delete(id); events.push({ type: "formRemoved", id, reason }); },
      setBanner(banner) { banners.set(banner.id, structuredClone(banner)); },
      clearBanner(id) {
        const kind = id.slice("agora:security:".length);
        assert.equal(latestAlerts?.status, 200, "横幅清除必须有真实 GET alerts 成功响应");
        assert.equal(latestAlerts.reply.items.some(item => item.kind === kind && !item.acknowledgedAt &&
          !["acknowledged", "cleared", "resolved"].includes(item.state)), false, "权威列表仍活动时不能清除横幅");
        banners.delete(id); events.push({ type: "clearBanner", id, authority: structuredClone(latestAlerts.reply) });
      },
      listBanners: () => structuredClone([...banners.values()]),
      mainSessions: { list: () => [], get: () => undefined, onChange: () => () => {}, hold: () => () => {} },
      userPresence: {
        devices: () => [{ deviceId: device.deviceId, publicKey: device.publicKey, alg: device.alg, label: device.label, connected: true }],
        onDevicesChange: () => () => {},
        async confirm(request) {
          confirmations.push(structuredClone(request));
          assert.deepEqual(request.origin, origin, "必须保留发起标签的 origin");
          const pending = calls.find(call => call.status === 202 && call.reply?.confirmation &&
            call.reply.confirmation.challenge.nonce === request.payload.nonce);
          assert.ok(pending, "浏览器签名必须来自真实 HTTP 202 的 daemon 挑战");
          assert.deepEqual(request.payload, pending.reply.confirmation.challenge);
          return value.onConfirm(request);
        },
      },
    };
    value.context = context;
    value.plugin = createPlugin({ home, connect: () => connectDaemonApi(home), retryMs: 60_000 });
    tabs.push(value);
    await value.plugin.activate(context);
    return value;
  }
  async function pair(tab) {
    return tab.plugin.actions.invoke({ actionId: "agora.device.pair", target: globalTarget, idempotencyKey: randomUUID() }, tab.origin);
  }
  async function question() {
    return main.request("POST", "/v1/requests", { questions });
  }
  async function requestForm(tab, question) {
    const form = (await tab.plugin.forms.pending()).find(item => item.id === `agora:request:${question.id}`);
    assert.ok(form, "用户提问必须通过真实列表进入插件待处理表单");
    return form;
  }
  async function submit(tab, form, cancelled = false, idempotencyKey = randomUUID()) {
    return tab.plugin.forms.submit({ formId: form.id, revision: form.revision, idempotencyKey,
      outcome: cancelled ? { status: "cancelled" } : { status: "submitted", values: { answers } } }, tab.origin);
  }
  async function confirmPending(tab, confirmation) {
    const forms = await tab.plugin.forms.pending();
    const form = forms.find(item => item.id === `agora:confirmation:${confirmation.confirmationId}`);
    assert.ok(form, "真实待确认必须可以通过插件持久表单签名");
    return submit(tab, form);
  }
  async function setting(tab, value) {
    const response = await api.request("POST", "/v1/settings/userConfirmation", { value }, { idempotencyKey: randomUUID() });
    if (value === "device") {
      // 开启保护的真实接口可直接生效；关闭保护必须先由已配对设备签名。
      assert.equal(response.status, 200, JSON.stringify(response));
      assert.equal(response.body.value, "device");
    } else {
      assert.equal(response.status, 202, JSON.stringify(response));
      assert.equal((await confirmPending(tab, response.body.confirmation)).status, "accepted");
    }
  }
  function alert(kind, revision = 1, alertId = `sa_${randomUUID()}`) {
    const at = new Date().toISOString();
    daemon.store.transaction(() => {
      daemon.store.run("INSERT INTO security_alerts(id,kind,revision,details,created_at) VALUES(?,?,?,?,?) ON CONFLICT(kind) DO UPDATE SET revision=excluded.revision,details=excluded.details,acknowledged_at=NULL,acknowledged_by=NULL",
        alertId, kind, revision, JSON.stringify({ reason: "安全接口测试", revision }), at);
      daemon.store.change("security_alert", alertId);
    });
    return alertId;
  }
  async function acknowledge(tab, actionId) {
    const form = await tab.plugin.actions.resolveForm(actionId, globalTarget);
    assert.ok(form, "警告动作必须先读取 daemon 投影的当前 revision");
    return tab.plugin.actions.invoke({ actionId, target: globalTarget, formId: form.id,
      formRevision: form.revision, idempotencyKey: randomUUID() }, tab.origin);
  }
  return {
    home, daemon, api, calls, tab, pair, question, requestForm, submit, confirmPending, setting, alert, acknowledge,
    pauseAlerts() { assert.equal(alertsGate, undefined); alertsGate = deferred(); },
    releaseAlerts() { const gate = alertsGate; alertsGate = undefined; gate?.resolve(); },
    async stop() {
      for (const value of tabs) await value.plugin.deactivate();
      clients.forEach(client => client.close());
      await daemon.close({ force: true, timeoutMs: 1_000 }); running = false;
    },
    async remount(value) {
      await value.plugin.deactivate();
      value.plugin = createPlugin({ home, connect: () => connectDaemonApi(home), retryMs: 60_000 });
      await value.plugin.activate(value.context);
    },
  };
}

function post(f, path) { return f.calls.filter(call => call.method === "POST" && call.path === path); }
function challengeFor(f, path) {
  const call = post(f, path).at(-1);
  assert.equal(call?.status, 202, JSON.stringify(call?.reply));
  return call.reply.confirmation;
}
async function detail(f, id) {
  const response = await f.api.request("GET", `/v1/requests/${id}`);
  assert.equal(response.status, 200);
  return response.body;
}

test("真实 daemon 排空时拒绝创建，插件返回确定失败且原 key 保持终态", limits, async t => {
  const f = await fixture(t), tab = await f.tab();
  f.daemon.tasks.draining = true;
  const form = await tab.plugin.actions.resolveForm('agora.task.spawn', globalTarget);
  const invocation = { actionId: 'agora.task.spawn', target: globalTarget, formId: form.id, formRevision: form.revision,
    input: { answers: [], fields: { model: 'test/model', profile: 'explore', prompt: '不能创建', cwd: f.home } }, idempotencyKey: randomUUID() };
  const result = await tab.plugin.actions.invoke(invocation, tab.origin);
  assert.equal(result.status, 'failed', JSON.stringify(result));
  assert.match(result.message, /排空/);
  assert.deepEqual(await tab.plugin.actions.invoke(invocation, tab.origin), result);
  assert.equal(f.daemon.store.get('SELECT COUNT(*) AS n FROM tasks').n, 0);
  assert.equal(post(f, '/v1/tasks').length, 1);
});

test("未归属任务的 Pane 接管动作展示后果并完成真实设备签名，之后才开放返工", limits, async t => {
  const f = await fixture(t), tab = await f.tab();
  assert.equal((await f.pair(tab)).status, "ok");
  const owner = f.daemon.store.get("SELECT id FROM principals WHERE type='agent:main' LIMIT 1").id;
  const taskId = `tk_${randomUUID()}`, sessionId = `as_${randomUUID()}`, principalId = `ch_${randomUUID()}`, at = new Date().toISOString();
  f.daemon.store.transaction(() => {
    f.daemon.store.run("INSERT INTO principals(id,type,created_at) VALUES(?,'agent:child',?)", principalId, at);
    f.daemon.store.run("INSERT INTO agora_sessions(id,task_id,principal_id,convener_id,parent_principal_id,session_file,profile,model,thinking,cwd,status,created_at) VALUES(?,?,?,?,?,?,'explore','test/model','high',?,'completed',?)", sessionId, taskId, principalId, owner, owner, join(f.home, `${sessionId}.jsonl`), f.home, at);
    f.daemon.store.run("INSERT INTO tasks(id,agora_session_id,convener_id,requested_by,title,prompt,model,thinking,profile,cwd,notify,status,created_at,updated_at,max_tokens) VALUES(?,?,?,?,?,'只读验证','test/model','high','explore',?,'silent','completed',?,?,1000)", taskId, sessionId, owner, owner, '接管界面验证', f.home, at, at);
    f.daemon.store.run("INSERT INTO task_generations(task_id,generation,status,agora_session_id) VALUES(?,1,'completed',?)", taskId, sessionId);
    f.daemon.store.run('UPDATE principals SET pi_session_id=NULL WHERE id=?', owner);
    f.daemon.store.change('task', taskId);
  });
  const target = { type: 'node', nodeId: `agora:session:${sessionId}` };
  const treeReq = { openNodeIds: [target.nodeId], recentSince: '2020-01-01T00:00:00Z' };
  const before = (await tab.plugin.tree.snapshot(treeReq)).nodes.find(node => node.id === target.nodeId);
  assert.equal(before.composer, undefined);
  assert.equal(before.parentId, null, '无法确定 pi 父关系时保持未归属，不能猜成用户任务');
  assert.ok(before.capabilities.includes('action:agora.task.takeover'));
  assert.match(before.statusDetail, /由 Agent 管理，接管后可操作/);
  assert.equal(await tab.plugin.actions.resolveForm('agora.task.steer', target), null);
  const spec = tab.plugin.actions.list().find(action => action.id === 'agora.task.takeover');
  assert.ok(spec.confirm && spec.hasForm && spec.danger);
  const form = await tab.plugin.actions.resolveForm(spec.id, target);
  assert.match(form.description, /原 Agent 将不能再管理该任务及子树/);
  const invocation = { actionId: spec.id, target, formId: form.id, formRevision: form.revision, input: { answers: [], fields: {} }, idempotencyKey: randomUUID() };
  const result = await tab.plugin.actions.invoke(invocation, tab.origin);
  assert.equal(result.status, 'ok', JSON.stringify(result));
  const confirmation = challengeFor(f, `/v1/tasks/${taskId}/takeover`);
  assert.equal(confirmation.challenge.action, 'agora.task.takeover');
  assert.ok(post(f, `/v1/confirmations/${confirmation.confirmationId}/sign`).some(call => call.status === 200));
  assert.equal(f.daemon.store.task(taskId).convener_id, 'user');
  const after = (await tab.plugin.tree.snapshot(treeReq)).nodes.find(node => node.id === target.nodeId);
  assert.equal(after.parentId, 'agora:root:user-tasks');
  assert.equal(after.composer.actionId, 'agora.task.steer');
  assert.match(after.statusDetail, /已由用户接管/);
  assert.ok(await tab.plugin.actions.resolveForm('agora.task.steer', target));
  assert.equal(await tab.plugin.actions.resolveForm(spec.id, target), null);
  const signatures = post(f, `/v1/confirmations/${confirmation.confirmationId}/sign`).length;
  assert.deepEqual(await tab.plugin.actions.invoke(invocation, tab.origin), result);
  assert.equal(post(f, `/v1/confirmations/${confirmation.confirmationId}/sign`).length, signatures);
});

test("首设备由发起浏览器真实自签配对，普通新设备保持 pending 直到已有设备批准", limits, async t => {
  const f = await fixture(t), first = await f.tab();
  assert.equal((await f.pair(first)).status, "ok");
  const initial = challengeFor(f, "/v1/devices/pair");
  assert.equal(initial.challenge.action, "agora.device.pair");
  const signed = post(f, `/v1/confirmations/${initial.confirmationId}/sign`);
  assert.equal(signed.length, 1); assert.equal(signed[0].status, 200);
  assert.equal(signed[0].body.deviceId, first.device.deviceId);
  assert.equal(signed[0].body.publicKey, first.device.publicKey);
  assert.equal(signed[0].body.alg, "ECDSA-P256-SHA256");
  assert.equal(signed[0].reply.state, "paired");
  const second = await f.tab(browser("另一个浏览器"));
  assert.equal((await f.pair(second)).status, "ok");
  let devices = (await f.api.request("GET", "/v1/devices")).body.items;
  assert.equal(devices.find(item => item.deviceId === second.device.deviceId).state, "pending");
  const form = (await first.plugin.forms.pending()).find(item => item.id === `agora:device:${second.device.deviceId}`);
  assert.ok(form); assert.match(form.description, /公钥指纹/);
  assert.equal((await f.submit(first, form)).status, "accepted");
  const approval = challengeFor(f, `/v1/devices/${second.device.deviceId}/approve`);
  assert.equal(post(f, `/v1/confirmations/${approval.confirmationId}/sign`)[0].body.deviceId, first.device.deviceId);
  devices = (await f.api.request("GET", "/v1/devices")).body.items;
  assert.equal(devices.find(item => item.deviceId === second.device.deviceId).state, "paired");
});

for (const cancelled of [false, true]) {
  test(`用户提问表单${cancelled ? "取消" : "答复"}经过真实 202 挑战和设备签名才改变业务状态`, limits, async t => {
    const f = await fixture(t), tab = await f.tab();
    assert.equal((await f.pair(tab)).status, "ok");
    const question = await f.question(), form = await f.requestForm(tab, question), gate = deferred();
    tab.onConfirm = async request => { await gate.promise; return tab.device.proof(request.payload); };
    t.after(() => gate.resolve());
    const key = randomUUID(), route = `/v1/requests/${question.id}/${cancelled ? "cancel" : "answer"}`;
    const operation = f.submit(tab, form, cancelled, key);
    await eventually(() => post(f, route).some(call => call.status === 202) && tab.confirmations.length === 2, "应进入真实用户在场确认");
    const confirmation = challengeFor(f, route);
    assert.equal((await detail(f, question.id)).state, "open");
    assert.equal(post(f, `/v1/confirmations/${confirmation.confirmationId}/sign`).length, 0);
    const call = post(f, route)[0];
    assert.equal(call.headers.get("Agora-Act-As"), "user");
    assert.equal(call.headers.get("Idempotency-Key"), key);
    assert.equal(call.body.expectedRevision, form.revision);
    if (!cancelled) assert.deepEqual(call.body.answers, answers);
    gate.resolve();
    const result = await operation;
    assert.equal(result.status, "accepted", JSON.stringify(result));
    const state = await detail(f, question.id);
    assert.equal(state.state, cancelled ? "cancelled" : "answered");
    if (!cancelled) { assert.equal(state.answeredBy, "user"); assert.equal(state.answeredVia.confirmedBy, "device"); }
    assert.equal(post(f, `/v1/confirmations/${confirmation.confirmationId}/sign`)[0].status, 200);
    assert.equal((await tab.plugin.forms.pending()).some(item => item.id === form.id), false, "终态表单应被移除");
    assert.ok(tab.events.some(event => event.type === "formRemoved" && event.id === form.id && event.reason === (cancelled ? "cancelled" : "handled")));
  });
}

test("两个标签用不同幂等键提交同一 revision，真实签名后只有一份答复生效", limits, async t => {
  const f = await fixture(t), first = await f.tab();
  assert.equal((await f.pair(first)).status, "ok");
  const second = await f.tab(first.device), question = await f.question();
  const forms = await Promise.all([f.requestForm(first, question), f.requestForm(second, question)]);
  const gates = [deferred(), deferred()];
  t.after(() => gates.forEach(gate => gate.resolve()));
  [first, second].forEach((tab, index) => { tab.onConfirm = async request => { await gates[index].promise; return tab.device.proof(request.payload); }; });
  const keys = [randomUUID(), randomUUID()], route = `/v1/requests/${question.id}/answer`;
  const operations = [f.submit(first, forms[0], false, keys[0]), f.submit(second, forms[1], false, keys[1])];
  await eventually(() => post(f, route).filter(call => call.status === 202).length === 2, "两个标签均应得到独立的真实挑战");
  const pending = post(f, route);
  assert.notEqual(pending[0].reply.confirmation.confirmationId, pending[1].reply.confirmation.confirmationId);
  assert.notEqual(pending[0].headers.get("Idempotency-Key"), pending[1].headers.get("Idempotency-Key"));
  assert.equal(pending[0].body.expectedRevision, pending[1].body.expectedRevision);
  assert.equal((await detail(f, question.id)).state, "open");
  gates[0].resolve();
  assert.equal((await operations[0]).status, "accepted");
  gates[1].resolve();
  const loser = await operations[1];
  assert.equal(loser.status, "alreadyHandled", JSON.stringify(loser));
  const final = await detail(f, question.id);
  assert.equal(final.state, "answered"); assert.equal(final.revision, question.revision + 1);
  const signed = pending.map(call => post(f, `/v1/confirmations/${call.reply.confirmation.confirmationId}/sign`)[0]);
  assert.deepEqual(signed.map(call => call.status).sort(), [200, 409]);
  const audit = (await f.api.request("GET", "/v1/audit")).body.items;
  assert.equal(audit.filter(item => item.action === "agora.request.answer" && item.target === question.id && item.outcome === "confirmed").length, 1);
});

test("host:pane 在保护 off 时仍不能绕过设备签名", limits, async t => {
  const f = await fixture(t), tab = await f.tab();
  assert.equal((await f.pair(tab)).status, "ok");
  await f.setting(tab, "off");
  assert.equal((await f.api.request("GET", "/v1/security/state")).body.userConfirmation, "off");
  const question = await f.question(), form = await f.requestForm(tab, question);
  tab.onConfirm = async () => { throw Object.assign(new Error("浏览器没有设备"), { code: "noDevice" }); };
  assert.equal((await f.submit(tab, form)).status, "pending");
  const confirmation = challengeFor(f, `/v1/requests/${question.id}/answer`);
  assert.equal((await detail(f, question.id)).state, "open");
  assert.equal(post(f, `/v1/confirmations/${confirmation.confirmationId}/sign`).length, 0);
  assert.equal((await f.api.request("GET", `/v1/confirmations/${confirmation.confirmationId}`)).body.state, "pending");
  tab.onConfirm = request => tab.device.proof(request.payload);
  assert.equal((await f.confirmPending(tab, confirmation)).status, "accepted");
  assert.equal((await detail(f, question.id)).answeredVia.confirmedBy, "device");
});

test("浏览器明确 rejected 时只取消待确认，不签名也不取消原提问", limits, async t => {
  const f = await fixture(t), tab = await f.tab();
  assert.equal((await f.pair(tab)).status, "ok");
  const question = await f.question(), form = await f.requestForm(tab, question);
  tab.onConfirm = async () => { throw Object.assign(new Error("用户拒绝"), { code: "rejected" }); };
  const result = await f.submit(tab, form);
  assert.equal(result.status, "failed", JSON.stringify(result));
  const confirmation = challengeFor(f, `/v1/requests/${question.id}/answer`);
  assert.equal(post(f, `/v1/confirmations/${confirmation.confirmationId}/sign`).length, 0);
  assert.equal(post(f, `/v1/confirmations/${confirmation.confirmationId}/cancel`).length, 1);
  assert.equal(post(f, `/v1/requests/${question.id}/cancel`).length, 0);
  assert.equal((await f.api.request("GET", `/v1/confirmations/${confirmation.confirmationId}`)).body.state, "cancelled");
  assert.equal((await detail(f, question.id)).state, "open");
  assert.ok((await tab.plugin.forms.pending()).some(item => item.id === form.id));
});

for (const code of ["timeout", "noDevice"]) {
  test(`浏览器 ${code} 保留 daemon pending 与持久表单，离线重启仍可见`, limits, async t => {
    const f = await fixture(t), tab = await f.tab();
    assert.equal((await f.pair(tab)).status, "ok");
    const question = await f.question(), form = await f.requestForm(tab, question);
    tab.onConfirm = async () => { throw Object.assign(new Error("没有用户授权"), { code }); };
    assert.equal((await f.submit(tab, form)).status, "pending");
    const confirmation = challengeFor(f, `/v1/requests/${question.id}/answer`);
    assert.equal(post(f, `/v1/confirmations/${confirmation.confirmationId}/sign`).length, 0);
    assert.equal(post(f, `/v1/confirmations/${confirmation.confirmationId}/cancel`).length, 0);
    assert.equal((await detail(f, question.id)).state, "open");
    assert.equal((await f.api.request("GET", `/v1/confirmations/${confirmation.confirmationId}`)).body.state, "pending");
    const pending = await tab.plugin.forms.pending();
    const ids = [form.id, `agora:confirmation:${confirmation.confirmationId}`];
    for (const id of ids) assert.ok(pending.some(item => item.id === id));
    await f.stop();
    const cache = JSON.parse(await readFile(join(tab.dataDir, FORM_CACHE_FILE), "utf8"));
    for (const id of ids) assert.ok(cache.records.some(item => item.form.id === id), "停用后表单必须留在临时 home 的缓存中");
    await f.remount(tab);
    const offline = await tab.plugin.forms.pending();
    for (const id of ids) assert.ok(offline.some(item => item.id === id), "daemon 离线时仍读取持久表单");
    assert.equal(tab.events.some(event => event.type === "formRemoved" && ids.includes(event.id)), false);
  });
}

test("安全警告 revision 在确认期间变化，旧签名失败且警告横幅保留", limits, async t => {
  const f = await fixture(t), tab = await f.tab();
  assert.equal((await f.pair(tab)).status, "ok");
  const alertId = f.alert("devices-reset");
  await eventually(() => tab.banners.has("agora:security:devices-reset"), "真实变更流应投影安全警告");
  const gate = deferred(); t.after(() => gate.resolve());
  tab.onConfirm = async request => { await gate.promise; return tab.device.proof(request.payload); };
  const route = `/v1/security/alerts/${alertId}/acknowledge`;
  const operation = f.acknowledge(tab, "agora.security.acknowledge");
  await eventually(() => post(f, route).some(call => call.status === 202), "知悉警告应先返回真实挑战");
  const confirmation = challengeFor(f, route);
  f.alert("devices-reset", 2, alertId);
  gate.resolve();
  const result = await operation;
  assert.equal(result.status, "failed", JSON.stringify(result));
  assert.equal(post(f, `/v1/confirmations/${confirmation.confirmationId}/sign`)[0].status, 409);
  await eventually(() => /警告版本：2/.test(tab.banners.get("agora:security:devices-reset")?.body ?? ""), "旧确认不能解除新 revision 的横幅");
  assert.ok((await f.api.request("GET", "/v1/security/alerts")).body.items.some(item => item.alertId === alertId && item.revision === 2));
  assert.equal(tab.events.some(event => event.type === "clearBanner" && event.id === "agora:security:devices-reset"), false);
  tab.onConfirm = request => tab.device.proof(request.payload);
  assert.equal((await f.acknowledge(tab, "agora.security.acknowledge")).status, "ok");
  await eventually(() => !tab.banners.has("agora:security:devices-reset"), "新 revision 签名并由 GET alerts 核实后才清除");
});

test("三类安全横幅只按真实 GET alerts 权威清除，签名成功和插件停用均不能自行清除", limits, async t => {
  const f = await fixture(t), tab = await f.tab();
  assert.equal((await f.pair(tab)).status, "ok");
  f.alert("devices-reset"); f.alert("budget-config-changed");
  await f.setting(tab, "off");
  const kinds = ["devices-reset", "budget-config-changed", "protection-off"];
  await eventually(() => kinds.every(kind => tab.banners.has(`agora:security:${kind}`)), "三类真实警告应同时显示");
  assert.ok([...tab.banners.values()].every(item => item.persistent));
  assert.deepEqual(tab.banners.get("agora:security:protection-off").actions, []);
  f.pauseAlerts();
  assert.equal((await f.acknowledge(tab, "agora.security.acknowledge")).status, "ok");
  assert.equal((await f.acknowledge(tab, "agora.security.acknowledge-budget")).status, "ok");
  await f.setting(tab, "device");
  for (const kind of kinds) assert.ok(tab.banners.has(`agora:security:${kind}`), "签名成功不能代替权威读取而清除横幅");
  assert.equal(tab.events.filter(event => event.type === "clearBanner").length, 0);
  f.releaseAlerts();
  await eventually(() => kinds.every(kind => !tab.banners.has(`agora:security:${kind}`)), "真实 GET alerts 确认解除后应清除三类横幅");
  assert.equal(tab.events.filter(event => event.type === "clearBanner").length, 3);

  f.alert("devices-reset", 2);
  await eventually(() => tab.banners.has("agora:security:devices-reset"), "后续警告应重新显示");
  const before = structuredClone(tab.banners.get("agora:security:devices-reset"));
  await f.stop();
  assert.deepEqual(tab.banners.get(before.id), before, "插件停用与 daemon 离线不代表安全状态解除");
  await f.remount(tab);
  assert.deepEqual(tab.banners.get(before.id), before, "连接失败不能清除宿主持久横幅");
});
