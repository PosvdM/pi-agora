import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { byId, childModel, confirmPresence, createWorld, delay, deviceId, devices, globalAction, loadPane, node, sessionNode, until } from './fixtures/pane-browser/world.mjs';

// pi-pane M3 插件界面与 agora 的浏览器联调。运行方式见 docs/development.md 的“pane 浏览器联调”。
const pane = await loadPane();
const treeRow = (page, id) => page.locator(`[data-testid="tree-node"][data-node-id="${id}"]`);
const skip = pane ? false : '未设置 AGORA_PANE_DIR，跳过 pi-pane 浏览器联调';

/** 新设备：在页面脚本运行前写入设备名称，便于在“待批准设备”表单中区分。 */
async function namedDevice(w, label) {
  await w.launch();
  const context = await w.browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript(value => localStorage.setItem('pi-pane.deviceLabel', value), label);
  w.contexts.push(context);
  const page = pane.web.observePage(await context.newPage());
  w.track(page);
  await page.goto(`${w.server.origin}/#code=${w.server.auth.issuePairCode()}`);
  await byId(page, 'sidebar').waitFor();
  await byId(page, 'plugin-roots').filter({ hasText: 'pi-agora' }).waitFor();
  return { context, page, id: await deviceId(page) };
}
async function audit(w, target) { return (await w.get(`/v1/audit?target=${encodeURIComponent(target)}&limit=200`)).items; }
async function deviceState(w, id) { return (await devices(w)).find(d => d.deviceId === id)?.state; }

test('设备配对：首台设备自签，新设备待批准并由首台批准', { timeout: 120_000, skip }, async t => {
  const w = await createWorld(t, pane); if (!w) return;
  await w.startDaemon(); await w.startPane();
  const a = await namedDevice(w, '设备甲');
  assert.equal((await w.get('/v1/security/state')).everPaired, false);
  await globalAction(a.page, '配对当前浏览器');
  // 首台设备没有可批准的设备，只能由自己的密钥签名配对挑战。
  await confirmPresence(a.page, `配对设备：${a.id}`);
  await byId(a.page, 'toast').filter({ hasText: '已配对当前浏览器' }).waitFor();
  assert.equal(await deviceState(w, a.id), 'paired');
  assert.ok((await audit(w, a.id)).some(row => row.action === 'agora.device.pair' && row.outcome === 'confirmed' && row.device_id === a.id));
  let state = await w.get('/v1/security/state');
  assert.equal(state.everPaired, true); assert.equal(state.reTofuArmed, false);

  // 第二台设备：自签只把它登记为待批准，提示不能写成已配对。
  const b = await namedDevice(w, '设备乙');
  await globalAction(b.page, '配对当前浏览器');
  await confirmPresence(b.page, `配对设备：${b.id}`);
  await byId(b.page, 'toast').filter({ hasText: '请在已配对的设备上批准' }).waitFor();
  assert.equal(await deviceState(w, b.id), 'pending');
  // 待批准设备出现在所有浏览器的待处理区；由首台设备签名批准。
  for (const page of [a.page, b.page]) await byId(page, 'pending-item').filter({ hasText: '待批准设备：设备乙' }).waitFor();
  await byId(a.page, 'pending-item').filter({ hasText: '待批准设备：设备乙' }).click();
  await byId(a.page, 'form-dialog').filter({ hasText: '公钥指纹' }).waitFor();
  await byId(a.page, 'form-submit').click();
  await confirmPresence(a.page, `批准设备：${b.id}`);
  await until(async () => await deviceState(w, b.id) === 'paired');
  for (const page of [a.page, b.page]) await until(async () => await byId(page, 'pending-item').filter({ hasText: '待批准设备' }).count() === 0);
  assert.ok((await audit(w, b.id)).some(row => row.action === 'agora.device.approve' && row.outcome === 'confirmed' && row.device_id === a.id), '批准由首台设备签名');
});

test('两台浏览器同时首次配对：只有一台消费 TOFU，另一台进入待批准', { timeout: 120_000, skip }, async t => {
  const w = await createWorld(t, pane); if (!w) return;
  await w.startDaemon(); await w.startPane();
  const c = await namedDevice(w, '设备丙'), d = await namedDevice(w, '设备丁');
  // 两个确认框都弹出后再同时签名，签名请求并发到达 daemon。
  await Promise.all([c, d].map(x => globalAction(x.page, '配对当前浏览器')));
  await Promise.all([c, d].map(x => byId(x.page, 'presence-dialog').waitFor()));
  // 待批准提示 5 秒后自动消失，签名之前就开始等，记下出现在哪一页，不要求轮询结束后它仍在屏幕上。
  const toasted = Promise.any([c, d].map(x => byId(x.page, 'toast').filter({ hasText: '请在已配对的设备上批准' }).waitFor({ timeout: 60_000 }).then(() => x)));
  await Promise.all([c, d].map(x => confirmPresence(x.page)));
  await until(async () => { const states = [await deviceState(w, c.id), await deviceState(w, d.id)]; return states.every(Boolean) && states; });
  const states = [await deviceState(w, c.id), await deviceState(w, d.id)].sort();
  assert.deepEqual(states, ['paired', 'pending'], '只有一台浏览器直接配对');
  const loser = await deviceState(w, c.id) === 'pending' ? c : d;
  assert.equal(await toasted, loser, '待批准提示出现在进入待批准的浏览器');
  await byId(c.page, 'pending-item').filter({ hasText: `待批准设备：${loser === c ? '设备丙' : '设备丁'}` }).waitFor();
});

test('离线重置后的单次 TOFU：下一台设备直接配对并消费 reTofuArmed，之后的设备需要批准', { timeout: 180_000, skip }, async t => {
  const w = await createWorld(t, pane, { allowedErrors: [/status of 50[23]/] }); if (!w) return;
  await w.startDaemon(); await w.startPane();
  const a = await namedDevice(w, '设备甲');
  await globalAction(a.page, '配对当前浏览器'); await confirmPresence(a.page);
  await until(async () => await deviceState(w, a.id) === 'paired');
  await w.restartDaemon(async () => assert.deepEqual(await w.offline(['pair-reset']), { reset: true, reTofuArmed: true }));
  let state = await w.get('/v1/security/state');
  assert.deepEqual(state.devices, []); assert.equal(state.reTofuArmed, true); assert.equal(state.everPaired, true);
  // 插件重连后显示设备重置横幅，“配对当前浏览器”重新可用。
  await byId(a.page, 'banner-title').filter({ hasText: '设备记录已被重置或修改' }).waitFor({ timeout: 40_000 });
  const e = await namedDevice(w, '设备戊');
  await globalAction(e.page, '配对当前浏览器');
  await confirmPresence(e.page, `配对设备：${e.id}`);
  await byId(e.page, 'toast').filter({ hasText: '已配对当前浏览器' }).waitFor();
  assert.equal(await deviceState(w, e.id), 'paired');
  state = await w.get('/v1/security/state');
  assert.equal(state.reTofuArmed, false, '离线重置后的配对消费 reTofuArmed');
  const f = await namedDevice(w, '设备己');
  await globalAction(f.page, '配对当前浏览器');
  await confirmPresence(f.page, `配对设备：${f.id}`);
  await byId(f.page, 'toast').filter({ hasText: '请在已配对的设备上批准' }).waitFor();
  assert.equal(await deviceState(w, f.id), 'pending');
  // 被重置的旧设备同样只能等待批准。
  await globalAction(a.page, '配对当前浏览器'); await confirmPresence(a.page);
  await until(async () => await deviceState(w, a.id) === 'pending');
  const resets = (await audit(w, 'devices')).filter(row => row.action === 'agora.device.reset');
  assert.equal(resets.length, 1); assert.equal(resets[0].via, 'offline');
});

async function pair(w, x) {
  await globalAction(x.page, '配对当前浏览器'); await confirmPresence(x.page);
  await until(async () => await deviceState(w, x.id) === 'paired');
}
let spawnKey = 0;
/** 以 host:pane 身份经 HTTP 创建用户任务（与插件“创建任务”动作同一端点），返回任务摘要。 */
async function spawnTask(w, title, prompt = title) {
  const reply = await w.api.request('POST', '/v1/tasks', { model: childModel, profile: 'explore', thinking: 'off', title, prompt, cwd: w.f.cwd },
    { idempotencyKey: `browser-spawn-${++spawnKey}` });
  assert.equal(reply.status, 201, JSON.stringify(reply.body));
  return reply.body;
}
const ask = (id, question, options) => ({ segments: [{ type: 'toolCall', name: 'agora_request',
  arguments: { action: 'ask', waitSeconds: 240, questions: [{ id, question, options: options.map(label => ({ label })), allowCustom: false }] } }] });
async function openRequests(w) { return (await w.get('/v1/requests?state=open')).items.filter(item => item.targetId === 'user'); }
async function confirmationsFor(w, target) {
  return (await w.get('/v1/confirmations?limit=200')).items.filter(item => item.target === target);
}

/** 打开待处理区中的提问表单并选择一个选项。 */
async function fillQuestion(page, title, option) {
  await byId(page, 'pending-item').filter({ hasText: title }).click();
  await byId(page, 'form-dialog').filter({ hasText: title }).waitFor();
  await byId(page, 'form-option').filter({ hasText: option }).click();
}

test('两个标签页同时提交子代理转给用户的同一提问：只有一个生效，另一个显示已在别处处理', { timeout: 150_000, skip }, async t => {
  const w = await createWorld(t, pane, { childScript: { turns: [ask('plan', '选择方案甲还是乙？', ['甲', '乙'])], fallback: { segments: [{ type: 'text', text: '收到答复，继续执行' }] } } }); if (!w) return;
  await w.startDaemon(); await w.startPane();
  const a = await namedDevice(w, '设备甲');
  await pair(w, a);
  const task = await spawnTask(w, '需要用户决定的任务');
  const [request] = await until(async () => { const items = await openRequests(w); return items.length === 1 && items; }, 30_000);
  assert.equal(request.taskId, task.taskId);
  const other = await w.tab(a.context);
  const title = '提问：选择方案甲还是乙？';
  for (const page of [a.page, other]) await fillQuestion(page, title, '乙');
  // 同时提交同一 revision：宿主只让一个提交进入插件，另一个立即得到“已在别处处理”。
  await Promise.all([a.page, other].map(page => byId(page, 'form-submit').click()));
  const winner = await until(async () => (await byId(a.page, 'presence-dialog').count()) ? a.page : (await byId(other, 'presence-dialog').count()) ? other : null);
  const loser = winner === a.page ? other : a.page;
  await byId(loser, 'toast').filter({ hasText: '已在别处处理' }).waitFor();
  await confirmPresence(winner, `agora.request.answer：${request.id}`);
  await until(async () => (await w.get(`/v1/requests/${request.id}`)).state === 'answered', 20_000);
  const answered = await w.get(`/v1/requests/${request.id}`);
  assert.deepEqual(answered.answers, [{ id: 'plan', selected: ['乙'] }]);
  const signed = await confirmationsFor(w, request.id);
  assert.deepEqual(signed.map(item => item.state), ['confirmed'], 'daemon 只收到并执行一次答复');
  assert.equal((await audit(w, request.id)).filter(row => row.action === 'agora.request.answer' && row.outcome === 'confirmed').length, 1);
  for (const page of [a.page, other]) await until(async () => await byId(page, 'pending-item').filter({ hasText: title }).count() === 0);
  // 子代理的提问工具取得答复后继续执行到完成。
  await until(async () => (await w.get(`/v1/tasks/${task.taskId}`)).status === 'completed', 30_000);
});

test('在场确认被拒绝、超时、没有可接收确认的设备：daemon 均不当作授权', { timeout: 240_000, skip }, async t => {
  const w = await createWorld(t, pane, { childScript: { turns: [ask('q1', '超时的提问？', ['是', '否']), ask('q2', '拒绝的提问？', ['是', '否']), ask('q3', '断开设备的提问？', ['是', '否'])],
    fallback: { segments: [{ type: 'text', text: '收到答复' }] } } }); if (!w) return;
  await w.startDaemon(); await w.startPane();
  const a = await namedDevice(w, '设备甲');
  await pair(w, a);
  const requests = [];
  for (const [index, name] of ['超时', '拒绝', '断开设备'].entries()) {
    const task = await spawnTask(w, `${name}任务`);
    const items = await until(async () => { const value = await openRequests(w); return value.length === index + 1 && value; }, 30_000);
    requests.push({ ...items.find(item => item.taskId === task.taskId), task });
  }
  const [timedOut, rejected, absent] = requests;
  const tabs = [a.page, await w.tab(a.context), await w.tab(a.context)];
  // 提问表单关联发起任务的会话节点：待处理条目显示任务标题，树节点显示待处理标记。
  await byId(tabs[0], 'pending-item').filter({ hasText: '提问：超时的提问？' }).filter({ hasText: '超时任务' }).waitFor();
  await treeRow(tabs[0], sessionNode(timedOut.task.agoraSessionId)).locator('[data-testid="node-pending"]').waitFor();

  // 超时：确认框留在第一个标签页，直到宿主按插件给出的 120 秒期限结束确认。
  await fillQuestion(tabs[0], '提问：超时的提问？', '是');
  await byId(tabs[0], 'form-submit').click();
  await byId(tabs[0], 'presence-dialog').filter({ hasText: 'agora.request.answer' }).waitFor();
  const timeoutStarted = Date.now();

  // 拒绝：插件取消待确认，表单保留并显示失败。
  await fillQuestion(tabs[1], '提问：拒绝的提问？', '否');
  await byId(tabs[1], 'form-submit').click();
  await byId(tabs[1], 'presence-dialog').filter({ hasText: 'agora.request.answer' }).waitFor();
  await byId(tabs[1], 'presence-reject').click();
  await byId(tabs[1], 'form-error').filter({ hasText: '用户已拒绝此次操作' }).waitFor();
  await byId(tabs[1], 'form-later').click();
  await until(async () => (await confirmationsFor(w, rejected.id)).map(item => item.state).join() === 'cancelled');

  // 没有设备：确认只发给发起的标签页，关闭它后宿主以 noDevice 结束确认。
  await fillQuestion(tabs[2], '提问：断开设备的提问？', '是');
  await byId(tabs[2], 'form-submit').click();
  await byId(tabs[2], 'presence-dialog').filter({ hasText: 'agora.request.answer' }).waitFor();
  await tabs[2].close();
  const closedAt = Date.now();
  assert.equal(await byId(tabs[1], 'presence-dialog').count(), 0, '其他标签页没有收到这次确认');
  // 待确认一经创建就以持久表单列在待处理区，与确认是否结束无关，所以表单出现不能区分 noDevice 和超时。
  // 插件按 confirmationId 复用进行中的 confirm：宿主以 noDevice 结束后再提交这条待确认会发起新的确认，
  // 超时那条在 120 秒期满前再提交则复用仍在第一个标签页等待的确认，不弹新的确认框。
  const [absentConfirmation] = await until(async () => { const value = await confirmationsFor(w, absent.id); return value.length === 1 && value; });
  const [timedOutConfirmation] = await until(async () => { const value = await confirmationsFor(w, timedOut.id); return value.length === 1 && value; });
  const formItem = (page, id) => page.locator(`[data-testid="pending-item"][data-form-id="${id}"]`);
  const absentForm = `agora:confirmation:${absentConfirmation.confirmationId}`, timedOutForm = `agora:confirmation:${timedOutConfirmation.confirmationId}`;
  for (const id of [absentForm, timedOutForm]) await formItem(tabs[1], id).waitFor();
  const probe = await w.tab(a.context);
  await formItem(probe, absentForm).click();
  await byId(probe, 'form-dialog').waitFor();
  await byId(probe, 'form-submit').click();
  await byId(probe, 'presence-dialog').filter({ hasText: 'agora.request.answer' }).waitFor({ timeout: 15_000 });
  assert.ok(Date.now() - closedAt < 15_000, '关闭标签页后宿主远早于 120 秒期限以 noDevice 结束了确认');
  // 关闭这个标签页同样以 noDevice 结束，待确认仍留给 daemon 裁定。
  await probe.close();
  // 对照：超时那条的确认仍在进行，提交它的待确认只得到处理中，任何其他标签页都不弹新的确认框。
  await formItem(tabs[1], timedOutForm).click();
  await byId(tabs[1], 'form-dialog').waitFor();
  await byId(tabs[1], 'form-submit').click();
  // 插件等待约 8 秒后返回 pending，宿主关闭弹窗并在待处理条目上显示处理中。
  await formItem(tabs[1], timedOutForm).filter({ hasText: '操作等待确认或仍在处理' }).waitFor({ timeout: 20_000 });
  await byId(tabs[1], 'form-dialog').waitFor({ state: 'detached' });
  assert.equal(await byId(tabs[1], 'presence-dialog').count(), 0, '超时那条复用进行中的确认');
  assert.equal(await byId(tabs[0], 'presence-dialog').count(), 1, '超时那条的确认框仍未结束');

  const beforeDeadline = 115_000 - (Date.now() - timeoutStarted);
  if (beforeDeadline > 0) await delay(beforeDeadline);
  assert.equal(await byId(tabs[0], 'presence-dialog').count(), 1, '确认框在 120 秒期限前仍然保留');
  const remaining = 125_000 - (Date.now() - timeoutStarted);
  if (remaining > 0) await delay(remaining);
  await byId(tabs[0], 'presence-dialog').waitFor({ state: 'detached', timeout: 15_000 });
  for (const request of requests) {
    const value = await w.get(`/v1/requests/${request.id}`);
    assert.equal(value.state, 'open', `${request.id} 没有被答复`);
    assert.notEqual((await w.get(`/v1/tasks/${request.task.taskId}`)).status, 'completed');
    assert.equal((await audit(w, request.id)).filter(row => row.outcome === 'confirmed').length, 0, '审计中没有任何经确认执行的答复');
  }
  assert.deepEqual((await confirmationsFor(w, timedOut.id)).map(item => item.state), ['pending'], '超时不取消也不授权');
  assert.deepEqual((await confirmationsFor(w, absent.id)).map(item => item.state), ['pending'], '没有设备不取消也不授权');
  assert.deepEqual((await confirmationsFor(w, rejected.id)).map(item => item.state), ['cancelled']);
  // 三个提问的表单都保留；超时和没有设备的两条待确认也在待处理区。
  for (const title of ['提问：超时的提问？', '提问：拒绝的提问？', '提问：断开设备的提问？']) await byId(tabs[0], 'pending-item').filter({ hasText: title }).waitFor();
  await until(async () => await byId(tabs[0], 'pending-item').filter({ hasText: '待确认：agora.request.answer' }).count() === 2);
});

/** 经“＋”菜单的“创建任务”表单创建用户任务；插件返回 openNodeId 后界面打开该任务会话。 */
async function spawnFromForm(w, page, title, prompt) {
  await globalAction(page, '创建任务');
  const form = byId(page, 'form-dialog').filter({ hasText: '任务书' });
  await form.waitFor();
  const field = id => form.locator(`[data-testid="form-field"][data-field-id="${id}"]`);
  await field('model').locator('input').fill(childModel);
  await field('thinking').locator('select').selectOption('off');
  await field('cwd').locator('input').fill(w.f.cwd);
  await field('title').locator('input').fill(title);
  await field('prompt').locator('textarea').fill(prompt);
  await byId(page, 'form-submit').click();
  await byId(page, 'plugin-title').filter({ hasText: title }).waitFor();
  const id = await byId(page, 'plugin-session').getAttribute('data-node-id');
  return id.slice('agora:session:'.length);
}
const assistantTexts = entries => entries.filter(entry => entry.message?.role === 'assistant')
  .map(entry => entry.message.content.filter(block => block.type === 'text').map(block => block.text).join(''));

test('子会话流式输出时浏览器断网再恢复：只显示一份与 daemon 记录逐字一致的完整输出', { timeout: 120_000, skip }, async t => {
  const reply = '子代理流式输出断网验收：' + '甲乙丙丁戊己庚辛壬癸'.repeat(8) + '结束。';
  const w = await createWorld(t, pane, { allowedErrors: [/net::ERR_INTERNET_DISCONNECTED/],
    childScript: { fallback: { segments: [{ type: 'text', chunks: [...reply].map(text => ({ text, delayMs: 80 })) }] } } }); if (!w) return;
  await w.startDaemon(); await w.startPane();
  const { page, context } = await w.device();
  await byId(page, 'plugin-roots').filter({ hasText: 'pi-agora' }).waitFor();
  const id = await spawnFromForm(w, page, '流式输出任务', '请慢慢输出');
  await page.waitForFunction(() => document.querySelector('[data-testid="plugin-session"] [data-testid="streaming"]')?.textContent.includes('断网验收'));
  await context.setOffline(true);
  const seen = (await page.evaluate(() => document.querySelector('[data-testid="streaming"]')?.textContent ?? '')).trim();
  assert.ok(seen.length < reply.length && reply.startsWith(seen), '断网时浏览器只显示了部分输出');
  await byId(page, 'net-banner').waitFor();
  // 离线期间 daemon 继续记录流式事件：游标至少前进十步。
  const cut = await w.get(`/v1/sessions/${id}/snapshot`);
  await until(async () => (await w.get(`/v1/sessions/${id}/snapshot`)).cursor.seq > cut.cursor.seq + 10, 20_000, 100);
  assert.equal(await page.evaluate(() => document.querySelector('[data-testid="streaming"]')?.textContent.trim() ?? ''), seen, '离线期间浏览器没有收到新内容');
  await context.setOffline(false);
  await until(async () => (await w.get(`/v1/sessions/${id}`)).status === 'completed', 30_000);
  // 会话状态先于最后一条助手消息出现在快照中，等快照含有助手输出后再比对。
  const final = await until(async () => {
    const snapshot = await w.get(`/v1/sessions/${id}/snapshot`);
    return assistantTexts(snapshot.entries).length > 0 && snapshot;
  }, 20_000, 100);
  assert.deepEqual(assistantTexts(final.entries), [reply], 'daemon 记录一份完整输出');
  await page.waitForFunction(expected => {
    const view = document.querySelector('[data-testid="plugin-session"]');
    const items = view?.querySelectorAll('[data-testid="assistant-message"]') ?? [];
    return items.length === 1 && items[0].textContent.trim() === expected && !view.querySelector('[data-testid="streaming"]') && !view.querySelector('[data-testid="unfinished"]');
  }, reply, { timeout: 20_000 });
  const shown = await page.locator('[data-testid="plugin-session"] [data-testid="assistant-message"]').allTextContents();
  assert.deepEqual(shown.map(text => text.trim()), assistantTexts(final.entries), '界面与 daemon 记录逐字一致，不重不漏');
});

const BANNERS = { protection: '用户确认已关闭，无法区分你和 Agent 的操作', devices: '设备记录已被重置或修改', budget: '安全状态需要核实' };
const bannerOf = (page, title) => byId(page, 'global-banner').filter({ hasText: title });
async function bannerTitles(page) { return (await byId(page, 'banner-title').allTextContents()).sort(); }
async function expectBanners(pages, titles, unavailable = false) {
  for (const page of pages) {
    await until(async () => JSON.stringify(await bannerTitles(page)) === JSON.stringify([...titles].sort()), 40_000);
    for (const title of titles) {
      await until(async () => (await bannerOf(page, title).locator('[data-testid="banner-unavailable"]').count()) === (unavailable ? 1 : 0), 20_000);
      // 横幅没有关闭按钮：只有展开/收起和插件声明的“我已知悉”。
      for (const text of await bannerOf(page, title).locator('button').allTextContents()) assert.ok(['展开', '收起', '我已知悉'].includes(text), `横幅上不应有按钮“${text}”`);
    }
  }
}
/** 展开横幅，返回正文与动作按钮。 */
async function expand(page, title) {
  const banner = bannerOf(page, title);
  if (!await banner.locator('.g-banner-body').count()) await banner.locator('.g-banner-line').click();
  return banner;
}
/** pi-pane 重启后浏览器凭证失效，用新的配对码重新登录（设备密钥在同一源下保留）。 */
async function relogin(w, pages) {
  for (const page of pages) {
    await page.goto(`${w.server.origin}/#code=${w.server.auth.issuePairCode()}`);
    await page.reload();
    await byId(page, 'sidebar').waitFor();
  }
}
const agoraOffline = w => until(() => { try { return w.server.plugins.runtime.get('agora').actions.list().length === 0; } catch { return false; } }, 40_000);
const agoraOnline = w => until(() => { try { return w.server.plugins.runtime.get('agora').actions.list().length > 0; } catch { return false; } }, 40_000);

test('三类安全横幅：所有标签页可见、不能关闭，跨 pi-pane 重启、daemon 重启、插件停用和加载失败保留；按规则消失，旧 revision 的知悉被拒', { timeout: 300_000, skip }, async t => {
  // pi-pane 停止期间页面的请求连接被拒，重启后旧凭证的请求返回 401，页面随后重新配对。
  const w = await createWorld(t, pane, { allowedErrors: [/status of 50[234]/, /status of 409/, /status of 401/, /net::ERR_CONNECTION_REFUSED/] }); if (!w) return;
  await w.startDaemon(); await w.startPane();
  const a = await namedDevice(w, '设备甲');
  await pair(w, a);
  const tabs = [a.page, await w.tab(a.context)];
  // 离线重置设备、离线关闭保护、启动配置放宽预算后启动 daemon。
  await w.restartDaemon(async () => {
    await w.offline(['pair-reset']);
    await w.offline(['set', 'userConfirmation', 'off']);
    await writeFile(path.join(w.home, 'config.json'), JSON.stringify({ taskLimitDefaults: { maxTokens: 60_000_000 } }));
  });
  const all = Object.values(BANNERS);
  await expectBanners(tabs, all);
  const alerts = await w.get('/v1/security/alerts');
  assert.deepEqual(alerts.items.map(item => item.kind).sort(), ['budget-config-changed', 'devices-reset', 'protection-off']);
  const recorded = (await w.get('/v1/audit?limit=200')).items.filter(row => row.action === 'security.state_alert' && row.outcome === 'alert');
  for (const kind of ['budget-config-changed', 'devices-reset', 'protection-off']) assert.ok(recorded.some(row => JSON.parse(row.details).kind === kind), `审计记录 ${kind}`);
  // 只有设备与预算横幅提供“我已知悉”。
  assert.equal(await (await expand(tabs[0], BANNERS.protection)).locator('[data-testid="banner-action"]').count(), 0);
  assert.deepEqual(await (await expand(tabs[0], BANNERS.devices)).locator('[data-testid="banner-action"]').allTextContents(), ['我已知悉']);
  for (const title of all) await bannerOf(tabs[0], title).locator('.g-banner-line').click();

  // daemon 停止期间重启 pi-pane：横幅来自 pi-pane 的持久记录，插件无法从 daemon 重新读取。
  await w.stopDaemon(); await agoraOffline(w);
  await w.stopPane(); await w.startPane();
  await relogin(w, tabs);
  await agoraOffline(w);
  await expectBanners(tabs, all);
  await w.startDaemon(); await agoraOnline(w);
  await expectBanners(tabs, all);

  // 插件停用：横幅保留并标明来源插件不可用，动作不可用。
  await w.server.plugins.runtime.stop('agora');
  await expectBanners(tabs, all, true);
  assert.equal(await (await expand(tabs[0], BANNERS.devices)).locator('[data-testid="banner-action"]').isDisabled(), true);
  await bannerOf(tabs[0], BANNERS.devices).locator('.g-banner-line').click();
  // 插件加载失败：插件数据目录中的幂等记录损坏时启用失败，横幅同样保留并标明不可用。
  const identities = path.join(w.f.root, 'pane', 'plugins', 'agora', 'operation-identities.json');
  await w.stopPane();
  await writeFile(identities, '{');
  await w.startPane();
  assert.equal(w.plugin().state, 'failed');
  await relogin(w, tabs);
  await expectBanners(tabs, all, true);
  await rm(identities);
  await w.stopPane(); await w.startPane();
  await relogin(w, tabs);
  assert.equal(w.plugin().state, 'active');
  await expectBanners(tabs, all);

  // 设备横幅：离线重置后重新配对（消费 reTofuArmed），再签名确认知悉。
  await pair(w, a);
  const devicesAlert = () => w.get('/v1/security/alerts').then(value => value.items.find(item => item.kind === 'devices-reset'));
  const first = await devicesAlert();
  let banner = await expand(tabs[0], BANNERS.devices);
  await banner.locator('.g-banner-body').filter({ hasText: `警告版本：${first.revision}` }).waitFor();
  await banner.locator('[data-testid="banner-action"]').click();
  await byId(tabs[0], 'form-dialog').filter({ hasText: `警告版本：${first.revision}` }).waitFor();
  await byId(tabs[0], 'form-submit').click();
  await byId(tabs[0], 'presence-dialog').filter({ hasText: `revision ${first.revision}` }).waitFor();
  // 确认框打开期间设备记录被绕过 agora 修改：签名时 daemon 检测到变化并提升 revision，旧知悉被拒。
  const db = new DatabaseSync(path.join(w.home, 'agora.db'));
  try {
    const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const spki = publicKey.export({ type: 'spki', format: 'der' });
    db.prepare("INSERT INTO devices(id,public_key,label,state,created_at) VALUES(?,?,?,?,?)")
      .run(createHash('sha256').update(spki).digest('base64url'), spki.toString('base64url'), '手工插入', 'pending', new Date().toISOString());
  } finally { db.close(); }
  await byId(tabs[0], 'presence-confirm').click();
  await byId(tabs[0], 'toast').filter({ hasText: '警告已变化' }).waitFor();
  const second = await until(async () => { const value = await devicesAlert(); return value?.revision > first.revision && value; });
  assert.equal(second.alertId, first.alertId);
  // 签名有效、执行时 revision 已变：旧知悉的待确认结束为 failed，审计记下冲突，不留下无法完成的待确认。
  assert.ok((await audit(w, first.alertId)).some(row => row.action === 'agora.security.acknowledge' && row.outcome === 'failed' && row.reason === 'conflict'), '旧 revision 的知悉执行失败并写审计');
  assert.deepEqual((await confirmationsFor(w, first.alertId)).filter(item => item.state === 'pending'), [], '旧知悉的待确认不再待处理');
  for (const page of tabs) {
    banner = await expand(page, BANNERS.devices);
    await banner.locator('.g-banner-body').filter({ hasText: `警告版本：${second.revision}` }).waitFor();
  }
  await expectBanners(tabs, all);
  // 按新内容重新确认知悉后，设备横幅在所有标签页消失。
  await (await expand(tabs[1], BANNERS.devices)).locator('[data-testid="banner-action"]').click();
  await byId(tabs[1], 'form-dialog').filter({ hasText: `警告版本：${second.revision}` }).waitFor();
  await byId(tabs[1], 'form-submit').click();
  await confirmPresence(tabs[1], `revision ${second.revision}`);
  await expectBanners(tabs, [BANNERS.protection, BANNERS.budget]);
  assert.ok((await audit(w, first.alertId)).some(row => row.action === 'agora.security.acknowledge' && row.outcome === 'confirmed' && row.device_id === a.id));

  // 预算横幅同样签名知悉后消失。
  await (await expand(tabs[0], BANNERS.budget)).locator('[data-testid="banner-action"]').click();
  await byId(tabs[0], 'form-dialog').filter({ hasText: 'budget-config-changed' }).waitFor();
  await byId(tabs[0], 'form-submit').click();
  await confirmPresence(tabs[0]);
  await expectBanners(tabs, [BANNERS.protection]);
  // 保护横幅不能确认知悉，跨 daemon 重启仍在，只在重新开启保护后消失。
  await w.restartDaemon(); await agoraOnline(w);
  await expectBanners(tabs, [BANNERS.protection]);
  const enabled = await w.api.request('POST', '/v1/settings/userConfirmation', { value: 'device' });
  assert.equal(enabled.status, 200, JSON.stringify(enabled.body));
  await expectBanners(tabs, []);
});

const STATUS_TEXT = { completed: '已完成', running: '运行中', interrupted: '已中断', stopped: '已停止', failed: '失败', waiting_decision: '等待中', created: '等待中' };
/** 侧栏中 agora 任务节点的标识、状态与可用性，与 daemon 的会话列表逐项比较。 */
async function sidebarMatchesDaemon(w, page) {
  return until(async () => {
    const items = (await w.get('/v1/sessions?limit=200')).items.filter(item => item.taskId);
    const expected = Object.fromEntries(items.map(item => [sessionNode(item.agoraSessionId), `${item.title}|${STATUS_TEXT[item.status] ?? item.status}|online`]));
    const rows = await page.locator('[data-testid="tree-node"][data-node-id^="agora:session:"]').evaluateAll(elements => elements.map(element =>
      [element.dataset.nodeId, `${element.getAttribute('title').split('\n')[0]}|${element.getAttribute('title').split('\n')[1].split('：')[0]}|${/\bav-(\w+)/.exec(element.className)[1]}`]));
    const actual = Object.fromEntries(rows);
    return rows.length === items.length && JSON.stringify(actual, Object.keys(actual).sort()) === JSON.stringify(expected, Object.keys(expected).sort()) && actual;
  }, 40_000, 100);
}

test('daemon 重启和变更流过期后，侧栏树 reset 并与 daemon 一致', { timeout: 240_000, skip }, async t => {
  const done = { segments: [{ type: 'text', text: '完成' }] };
  const w = await createWorld(t, pane, { allowedErrors: [/status of 50[234]/, /net::ERR_INTERNET_DISCONNECTED/],
    childScript: { turns: [done, done, { segments: [{ type: 'text', text: '长时间运行' }, { type: 'hang' }] }], fallback: done } }); if (!w) return;
  await w.startDaemon(); await w.startPane();
  const { page, context } = await w.device();
  const finished = [];
  for (const title of ['已完成任务一', '已完成任务二']) {
    const task = await spawnTask(w, title); finished.push(task);
    await until(async () => (await w.get(`/v1/tasks/${task.taskId}`)).status === 'completed', 30_000);
  }
  const running = await spawnTask(w, '运行中的任务');
  await until(async () => (await w.get(`/v1/tasks/${running.taskId}`)).status === 'running', 30_000);
  await sidebarMatchesDaemon(w, page);

  // daemon 强制停止：插件离线时树 reset 为只读存档；重启后运行中的任务变为中断，树再次 reset 并与 daemon 一致。
  await w.stopDaemon(); await agoraOffline(w);
  await until(async () => (await page.locator('[data-testid="tree-node"][data-node-id^="agora:session:"].av-archived').count()) === 3, 30_000);
  await w.startDaemon(); await agoraOnline(w);
  assert.equal((await w.get(`/v1/tasks/${running.taskId}`)).status, 'interrupted');
  const restarted = await sidebarMatchesDaemon(w, page);
  assert.equal(restarted[sessionNode(running.agoraSessionId)], '运行中的任务|已中断|online');

  // 对照：短暂断网后浏览器按原游标续订，不重新取树快照。
  const snapshots = [];
  page.on('request', request => { if (request.url().endsWith('/api/plugins/agora/tree/snapshot')) snapshots.push(Date.now()); });
  await context.setOffline(true); await byId(page, 'net-banner').waitFor();
  await context.setOffline(false); await byId(page, 'net-banner').waitFor({ state: 'detached' });
  await delay(1_500);
  assert.equal(snapshots.length, 0, '游标仍有效时不 reset');
  // 断网期间产生新的变更，并按保留期清理掉浏览器游标之后的变更：重连时的续订得到 reset，浏览器重取快照。
  const { changesCursor, pruneChanges, readChanges } = await import('../packages/daemon/dist/changes.js');
  const before = changesCursor(w.daemon.store);
  await context.setOffline(true); await byId(page, 'net-banner').waitFor();
  const late = await spawnTask(w, '断网期间完成的任务');
  await until(async () => (await w.get(`/v1/tasks/${late.taskId}`)).status === 'completed', 30_000);
  // 保留期要求超过十万条且早于七天：写入占位变更，再以八天后的时间执行 daemon 的清理函数。
  w.daemon.store.transaction(() => { for (let index = 0; index < 101_000; index++) w.daemon.store.change('security', 'retention-filler'); });
  assert.ok(pruneChanges(w.daemon.store, Date.now() + 8 * 86_400_000) > 0);
  assert.equal(readChanges(w.daemon.store, before.epoch, before.seq).reset, true, '浏览器持有的游标已过期');
  await context.setOffline(false); await byId(page, 'net-banner').waitFor({ state: 'detached' });
  await until(() => snapshots.length > 0, 30_000);
  const expired = await sidebarMatchesDaemon(w, page);
  assert.equal(expired[sessionNode(late.agoraSessionId)], '断网期间完成的任务|已完成|online');
});

const mainSpawn = (id, title) => ({ segments: [{ type: 'toolCall', id, name: 'agora_task',
  arguments: { action: 'spawn', model: childModel, profile: 'explore', thinking: 'off', title, prompt: `${title}：请执行` } }] });
const say = text => ({ segments: [{ type: 'text', text }] });

test('主会话派出的子任务：树、工具卡片链接、通知卡片、显示名称、唯一停止入口；接管后打开的会话及时开放输入、停止与返工；冷历史', { timeout: 240_000, skip }, async t => {
  const w = await createWorld(t, pane, { mainAgora: true, allowedErrors: [/status of 50[234]/],
    mainScript: { turns: [mainSpawn('call-quick', '快速子任务'), say('已派出快速子任务'), say('收到完成通知'), mainSpawn('call-long', '长时间子任务'), say('已派出长时间子任务')], fallback: say('好的') },
    childScript: { turns: [say('快速完成'), { segments: [{ type: 'text', text: '长时间处理中' }, { type: 'hang' }] }], fallback: say('返工完成') } }); if (!w) return;
  await w.startDaemon(); await w.startPane();
  const { page } = await w.device();
  const self = await deviceId(page);
  await globalAction(page, '配对当前浏览器'); await confirmPresence(page);
  await until(async () => await deviceState(w, self) === 'paired');
  await byId(page, 'plugin-roots').filter({ hasText: 'pi-agora' }).waitFor();

  // 主会话经 agora_task 派出子任务，完成通知以 agora:notice 卡片注入主会话。
  await pane.web.newSession(page, w.f);
  await pane.web.send(page, '请派一个快速子任务');
  const mainId = await byId(page, 'chat').getAttribute('data-session-id');
  const quick = await until(async () => (await w.get('/v1/tasks?scope=all')).items.find(item => item.title === '快速子任务'), 30_000);
  await until(async () => (await w.get(`/v1/tasks/${quick.taskId}`)).status === 'completed', 30_000);
  const quickNode = sessionNode(quick.agoraSessionId);
  const notice = page.locator('[data-testid="custom-message"][data-custom-type="agora:notice"]');
  await page.getByText('收到完成通知').waitFor({ timeout: 40_000 });
  // 通知只注入一条：界面只显示一张卡片，并使用插件声明的“agora 通知”渲染器。
  await notice.filter({ hasText: 'agora 通知' }).waitFor();
  assert.equal(await notice.count(), 1);
  await page.reload(); await byId(page, 'chat').waitFor();
  // 插件目录晚于条目到达时，已显示的卡片随之改用插件渲染器。
  await notice.filter({ hasText: 'agora 通知' }).waitFor();
  assert.equal(await page.locator('[data-testid="custom-message"]').count(), 1, '刷新后仍只有一张通知卡片');
  // 子任务节点挂在主会话下：插件树的父节点是该主会话。
  const tree = await w.server.plugins.runtime.get('agora').tree.snapshot({ openNodeIds: [], recentSince: new Date(Date.now() - 86_400_000).toISOString() });
  assert.equal(tree.nodes.find(item => item.id === quickNode).parentId, `pane:session:${mainId}`);
  // 子任务结束后主会话行折叠，显示子节点数；展开后列出子任务。
  const mainRow = page.locator(`[data-testid="session-item"][data-node-id="pane:session:${mainId}"]`);
  await mainRow.locator('[data-testid="child-count"]').filter({ hasText: '1 个子节点' }).waitFor();
  await mainRow.locator('[data-testid="twisty"]').click();
  await treeRow(page, quickNode).filter({ hasText: '快速子任务' }).waitFor();
  // 工具卡片链接与通知卡片的节点链接都打开子任务会话，面包屑回到主会话。
  await byId(page, 'tool-node-link').filter({ hasText: '快速子任务' }).click();
  await byId(page, 'plugin-title').filter({ hasText: '快速子任务' }).locator('.src-tag').filter({ hasText: 'pi-agora' }).waitFor();
  await byId(page, 'crumbs').locator('button').filter({ hasText: '请派一个快速子任务' }).click();
  await byId(page, 'chat').waitFor();
  await notice.locator('.card-head').click();
  await notice.locator('[data-testid="custom-node-link"]').click();
  await byId(page, 'plugin-title').filter({ hasText: '快速子任务' }).waitFor();
  await byId(page, 'crumbs').locator('button').filter({ hasText: '请派一个快速子任务' }).click();
  await byId(page, 'chat').waitFor();

  // 第二个子任务长时间运行：由 Agent 管理，打开后只读，只有一个停止入口。
  await pane.web.send(page, '再派一个长时间子任务');
  const long = await until(async () => (await w.get('/v1/tasks?scope=all')).items.find(item => item.title === '长时间子任务' && item.status === 'running'), 30_000);
  const longNode = sessionNode(long.agoraSessionId);
  await byId(page, 'tool-node-link').filter({ hasText: '长时间子任务' }).click();
  await byId(page, 'plugin-session').filter({ hasText: '长时间处理中' }).waitFor();
  await byId(page, 'plugin-readonly').waitFor();
  assert.equal(await byId(page, 'plugin-editor').count(), 0);
  assert.equal(await byId(page, 'plugin-stop').count(), 1, '只读视图只有一个停止按钮');
  assert.deepEqual(await byId(page, 'node-head-action').allTextContents(), ['接管任务'], '停止不再作为节点动作重复出现');
  await treeRow(page, longNode).click({ button: 'right' });
  const menu = await byId(page, 'node-menu').textContent();
  assert.match(menu, /接管任务/); assert.doesNotMatch(menu, /停止任务/);
  await page.keyboard.press('Escape'); await page.mouse.click(900, 400);

  // 接管：确认、表单、设备签名；已打开的会话随后开放输入框和返工动作，停止入口仍只有一个。
  await byId(page, 'node-head-action').filter({ hasText: '接管任务' }).click();
  // 动作的 confirm 由 pi-pane 的应用内确认框承载。
  await byId(page, 'choice-dialog').filter({ hasText: '确定接管此任务' }).locator('[data-choice="ok"]').click();
  await byId(page, 'form-dialog').filter({ hasText: '原 Agent 将不能再管理' }).waitFor();
  await byId(page, 'form-submit').click();
  await confirmPresence(page);
  await byId(page, 'plugin-readonly').waitFor({ state: 'detached' });
  await byId(page, 'plugin-composer').filter({ hasText: '作为“发送返工指令”提交给 pi-agora' }).waitFor();
  assert.equal(await byId(page, 'plugin-stop').count(), 1);
  assert.deepEqual((await byId(page, 'node-head-action').allTextContents()).sort(), ['发送返工指令']);
  const taken = await w.get(`/v1/sessions/${long.agoraSessionId}`);
  assert.equal(taken.parent.kind, 'user');
  assert.ok((await audit(w, long.taskId)).some(row => row.action === 'agora.task.takeover' && row.outcome === 'confirmed' && row.device_id === self));

  // 返工动作表单：运行中提交的返工排队；停止清空队列，被清出的返工原文交还浏览器。
  await byId(page, 'node-head-action').filter({ hasText: '发送返工指令' }).click();
  const steer = byId(page, 'form-dialog').filter({ hasText: '返工指令' });
  await steer.locator('textarea').fill('请补充边界测试');
  await byId(page, 'form-submit').click();
  await byId(page, 'toast').filter({ hasText: '已发送返工指令' }).waitFor();
  const aborted = page.waitForResponse(response => response.url().endsWith(`/api/plugins/agora/sessions/${long.agoraSessionId}/abort`));
  await byId(page, 'plugin-stop').click();
  const abort = await (await aborted).json();
  assert.equal(abort.status, 'done');
  assert.ok(abort.clearedText.some(text => text.includes('请补充边界测试')), JSON.stringify(abort));
  await until(async () => (await w.get(`/v1/tasks/${long.taskId}`)).status === 'stopped', 30_000);
  assert.deepEqual(w.daemon.store.all("SELECT state FROM steer_messages WHERE task_id=?", long.taskId).map(row => row.state), ['dropped']);
  // 已停止的任务不能返工：打开的会话随即变为只读，停止按钮消失。
  await byId(page, 'plugin-status').filter({ hasText: '已停止' }).waitFor();
  await byId(page, 'plugin-readonly').waitFor();
  assert.equal(await byId(page, 'plugin-stop').count(), 0);

  // 冷历史：八天后打开的标签页只显示“历史（N）”，展开后分页加载已结束的任务。
  const later = pane.web.observePage(await page.context().newPage()); w.track(later);
  await later.clock.setFixedTime(new Date(Date.now() + 8 * 86_400_000));
  await later.goto(w.server.origin);
  await treeRow(later, 'agora:root:user-tasks').waitFor();
  assert.equal(await treeRow(later, longNode).count(), 0, '冷节点不在热快照中');
  await later.locator('[data-testid="node-history"]').filter({ hasText: '历史（1）' }).click();
  await treeRow(later, longNode).waitFor();
  // 主会话下的快速子任务同样是冷节点，子节点数只能来自快照的 foreignChildCounts。八天后主会话本身也不在
  // pi-pane 的热列表里，冷子任务先计入“未归属”；加载项目历史列出主会话后，数目回到主会话行，展开后从“历史（1）”加载。
  assert.equal(await treeRow(later, quickNode).count(), 0, '主会话下的冷子任务不在热快照中');
  await byId(later, 'unassigned-history').filter({ hasText: '历史（1）' }).waitFor();
  await byId(later, 'project-history').click();
  const laterMain = later.locator(`[data-testid="session-item"][data-node-id="pane:session:${mainId}"]`);
  await laterMain.locator('[data-testid="child-count"]').filter({ hasText: '1 个子节点' }).waitFor();
  assert.equal(await byId(later, 'unassigned').count(), 0, '主会话列出后冷子任务不再算作未归属');
  await laterMain.locator('[data-testid="twisty"]').click();
  await later.locator('[data-testid="node-history"]').filter({ hasText: '历史（1）' }).click();
  await treeRow(later, quickNode).filter({ hasText: '快速子任务' }).waitFor();
});

test('排队中的任务：没有运行进程时会话视图仍有停止入口，停止后 daemon 记为已停止', { timeout: 150_000, skip }, async t => {
  const w = await createWorld(t, pane, { childScript: { turns: [{ segments: [{ type: 'text', text: '占用唯一的运行名额' }, { type: 'hang' }] }], fallback: say('完成') } }); if (!w) return;
  // 只允许一个运行中的任务：第二个任务停在 created，界面显示为“等待中”，节点只声明 abort。
  await w.startDaemon({ maxConcurrentRuns: 1 }); await w.startPane();
  const { page } = await w.device();
  const busy = await spawnTask(w, '占用名额的任务');
  await until(async () => (await w.get(`/v1/tasks/${busy.taskId}`)).status === 'running', 30_000);
  const queued = await spawnTask(w, '排队中的任务');
  assert.equal((await w.get(`/v1/tasks/${queued.taskId}`)).status, 'created');
  await treeRow(page, sessionNode(queued.agoraSessionId)).click();
  await byId(page, 'plugin-title').filter({ hasText: '排队中的任务' }).waitFor();
  await byId(page, 'plugin-status').filter({ hasText: '等待中' }).waitFor();
  assert.equal(await byId(page, 'plugin-stop').count(), 1, '排队中的任务有且只有一个停止入口');
  await byId(page, 'plugin-stop').click();
  await until(async () => (await w.get(`/v1/tasks/${queued.taskId}`)).status === 'stopped', 30_000);
  await byId(page, 'plugin-stop').waitFor({ state: 'detached' });
  assert.equal((await w.get(`/v1/tasks/${busy.taskId}`)).status, 'running', '停止排队的任务不影响运行中的任务');
});
