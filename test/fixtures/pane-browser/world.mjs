// pi-pane 浏览器联调的公共现场：真实 agora daemon、真实 pi 与本地假 provider、同进程的 pi-pane 服务端与 agora 插件、真实 Chrome。
// pi-pane 的服务端、测试设施和 playwright-core 均从 AGORA_PANE_DIR 指向的已构建 checkout 动态导入。
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { startDaemon, RpcSubprocessDriver, offline } from '../../../packages/daemon/dist/index.js';
import { connectDaemonApi } from '../../../packages/pane-plugin/dist/transport.js';
import { containment, piFixture, providerPath as childProvider, until } from '../driver-helpers.mjs';

export { until, delay };
export const pluginDir = fileURLToPath(new URL('../../../packages/pane-plugin/', import.meta.url));
export const agoraExtension = fileURLToPath(new URL('../../../packages/extension/dist/index.js', import.meta.url));
export const childModel = 'p0-fake/scripted';

let screenshots = 0;
/** 失败截图的文件名：保留中文等字符，只替换路径不安全的字符和空白；名称截到 60 个字符（UTF-8 不超过 240 字节），加序号避免同名覆盖。 */
function screenshotName(testName, pageIndex) {
  const name = Array.from(testName.replace(/[\\/:*?"<>|\s]+/g, '_')).slice(0, 60).join('');
  return `agora-failure-${String(++screenshots).padStart(3, '0')}-${name}-${pageIndex}`;
}

/** 读取 AGORA_PANE_DIR；未设置时返回 null（调用方跳过），AGORA_TEST_REQUIRE_PANE=1 时未设置或缺少构建产物直接失败。 */
export async function loadPane() {
  const dir = process.env.AGORA_PANE_DIR;
  const required = process.env.AGORA_TEST_REQUIRE_PANE === '1';
  if (!dir) {
    assert.ok(!required, 'AGORA_TEST_REQUIRE_PANE=1 时必须设置 AGORA_PANE_DIR');
    return null;
  }
  assert.ok(path.isAbsolute(dir), 'AGORA_PANE_DIR 必须是绝对路径');
  for (const file of ['packages/server/dist/index.js', 'packages/web/dist/index.html', 'test/fixtures/browser.mjs', 'node_modules/playwright-core/package.json']) {
    assert.ok(existsSync(path.join(dir, file)), `AGORA_PANE_DIR 缺少 ${file}，请在 pi-pane checkout 中运行 npm ci 和 npm run build`);
  }
  const load = file => import(pathToFileURL(path.join(dir, file)).href);
  // browser.mjs 在导入时保存浏览器启动环境，必须先于 piFixture 修改 HOME。
  const browser = await load('test/fixtures/browser.mjs');
  const web = await load('test/fixtures/web-e2e.mjs');
  const helpers = await load('test/fixtures/helpers.mjs');
  return { dir, browser, web, helpers };
}

/** 每个用例一个现场：调用方按需启动 daemon、pi-pane 和浏览器上下文；t.after 统一检查页面错误并清理。 */
export async function createWorld(t, pane, options = {}) {
  const executablePath = pane.browser.requireChrome(t);
  if (!executablePath) return null;
  const f = await piFixture(options.mainScript ?? { fallback: { segments: [{ type: 'text', text: '好的' }] } });
  const home = path.join(f.root, 'agora');
  const savedAgoraHome = process.env.AGORA_HOME;
  process.env.AGORA_HOME = home;
  const childScript = path.join(f.root, 'child-script.json');
  const childLog = path.join(f.root, 'child-requests.jsonl');
  await writeFile(childScript, JSON.stringify(options.childScript ?? { fallback: { segments: [{ type: 'text', text: '子代理完成' }] } }));
  const childEnv = { ...f.env, FAKE_SCRIPT_PATH: childScript, FAKE_REQUEST_LOG: childLog };
  const world = {
    t, pane, f, home, childScript, childLog, daemon: undefined, server: undefined, browser: undefined, port: 0,
    pages: [], contexts: [], allowedErrors: [...(options.allowedErrors ?? [])], api: undefined,
    async setChildScript(value) { await writeFile(childScript, JSON.stringify(value)); },
    async startDaemon(extra = {}) {
      assert.equal(world.daemon, undefined, 'daemon 已在运行');
      const driver = new RpcSubprocessDriver({ home, piPath: f.install.packageDir, extensionPath: agoraExtension, env: childEnv, extraExtensions: [childProvider], containment });
      world.daemon = await startDaemon({ home, driver, idleReclaimMs: 60_000, ...extra });
      world.api?.close(); world.api = await connectDaemonApi(home);
      return world.daemon;
    },
    async stopDaemon() {
      world.api?.close(); world.api = undefined;
      const daemon = world.daemon; world.daemon = undefined;
      await daemon?.close({ force: true, timeoutMs: 5_000 });
    },
    async restartDaemon(between) { await world.stopDaemon(); if (between) await between(); return world.startDaemon(); },
    /** 以 host:pane 身份直接读取 daemon，作为与界面比对的权威记录。 */
    async get(route) {
      const reply = await world.api.request('GET', route);
      assert.equal(reply.status, 200, `GET ${route} 返回 ${reply.status}：${JSON.stringify(reply.body)}`);
      return reply.body;
    },
    async offline(words) { assert.equal(world.daemon, undefined, '离线命令要求 daemon 已停止'); return offline(home, words); },
    async startPane(extra = {}) {
      assert.equal(world.server, undefined, 'pi-pane 已在运行');
      const env = options.mainAgora ? { ...f.env, AGORA_HOME: home } : f.env;
      const extensions = [pane.helpers.providerPath, ...(options.mainAgora ? [agoraExtension] : [])];
      world.server = await pane.browser.startWebServer({ ...f, env }, { plugins: [pluginDir], extraExtensions: extensions, ...(world.port ? { port: world.port } : {}), ...extra });
      world.port = Number(new URL(world.server.origin).port);
      return world.server;
    },
    async stopPane() { const server = world.server; world.server = undefined; await server?.close(); },
    async launch() {
      world.browser ??= await pane.browser.launch(executablePath);
      t.diagnostic('Chrome 实际执行：' + world.browser.version());
      return world.browser;
    },
    /** 新的浏览器上下文等于一台新设备（独立的 IndexedDB 设备密钥）。 */
    async device(opts = {}) {
      await world.launch();
      const { context, page } = await pane.browser.openPaired(world.browser, world.server, opts);
      world.contexts.push(context); world.track(page);
      return { context, page };
    },
    /** 同一上下文的新标签页，经 BroadcastChannel 共享 pi-pane 凭证。 */
    async tab(context) {
      const page = pane.web.observePage(await context.newPage());
      world.track(page);
      await page.goto(world.server.origin);
      await byId(page, 'sidebar').waitFor();
      return page;
    },
    track(page) { page.setDefaultTimeout(20_000); world.pages.push(page); return page; },
    plugin() { return world.server.plugins.runtime.list().find(item => item.source === 'agora' || item.locator === pluginDir); },
  };
  t.after(async () => {
    try {
      for (const page of world.pages) {
        if (page.isClosed()) continue;
        if (!t.passed) await pane.browser.screenshot(page, screenshotName(t.name, world.pages.indexOf(page))).catch(() => {});
        pane.browser.assertNoPageErrors(page, world.allowedErrors);
      }
    } finally {
      try { await world.browser?.close(); }
      finally {
        try { await world.stopPane(); }
        finally {
          try { await world.stopDaemon(); }
          finally {
            if (savedAgoraHome === undefined) delete process.env.AGORA_HOME; else process.env.AGORA_HOME = savedAgoraHome;
            await f.cleanup();
          }
        }
      }
    }
  });
  return world;
}

export const byId = (page, id) => page.locator(`[data-testid="${id}"]`);
export const node = (page, id) => page.locator(`[data-node-id="${id}"]`).first();
export const sessionNode = id => `agora:session:${id}`;

/** “＋”菜单中的全局动作。 */
export async function globalAction(page, title) {
  await byId(page, 'add-menu-btn').click();
  await byId(page, 'global-action').filter({ hasText: title }).click();
}

/** 等待当前标签页弹出在场确认框并签名。 */
export async function confirmPresence(page, title) {
  const dialog = byId(page, 'presence-dialog');
  await (title ? dialog.filter({ hasText: title }) : dialog).waitFor();
  await byId(page, 'presence-confirm').click();
  await dialog.waitFor({ state: 'detached' });
}

/** 当前浏览器的设备 ID（pi-pane 前端的 IndexedDB 设备密钥）。 */
export async function deviceId(page) {
  return until(() => page.evaluate(async () => {
    const request = indexedDB.open('pi-pane-device', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('keys');
    const db = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    try {
      const read = db.transaction('keys', 'readonly').objectStore('keys').get('device');
      return await new Promise(resolve => { read.onsuccess = () => resolve(read.result?.deviceId ?? null); read.onerror = () => resolve(null); });
    } finally { db.close(); }
  }), 10_000);
}

export async function devices(world) { return (await world.get('/v1/devices')).items; }
