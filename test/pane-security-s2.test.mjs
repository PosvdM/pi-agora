import test from "node:test";
import assert from "node:assert/strict";
import { createSecurity } from "../packages/pane-plugin/dist/security.js";

const origin = { client: "browser", connectionId: "tab-a", deviceId: "device-a", receivedAt: new Date().toISOString() };
const proof = { deviceId: "device-a", publicKey: "key", alg: "ECDSA-P256-SHA256", signature: "signature" };
const confirmation = { confirmationId: "cf-one", title: "答复提问", summary: "确认真实参数", challenge: { action: "agora.request.answer", nonce: "nonce" } };
function fixture(confirm = async () => proof) {
  const calls = [], notices = [], banners = new Map();
  let reply = { status: 202, body: { confirmation } };
  const api = { async request(method, path, body, options) {
    calls.push({ method, path, body, options });
    if (path.endsWith("/sign")) return { status: 200, body: { done: true } };
    if (path.endsWith("/cancel")) return { status: 200, body: { cancelled: true } };
    return reply;
  } };
  const context = { userPresence: { confirm, devices: () => [{ ...proof, connected: true, label: "Chrome" }] },
    notify: item => notices.push(item), log: { warn() {} }, setBanner: item => banners.set(item.id, item),
    clearBanner: id => banners.delete(id), listBanners: () => [...banners.values()] };
  return { calls, notices, banners, context, api, runtime: { api, context, online: () => true }, setReply: value => { reply = value; } };
}

test("同一待确认并发查询只弹一个确认框，原始 origin 和参数交给浏览器", async () => {
  let release, count = 0;
  const f = fixture(request => { count++; assert.deepEqual(request.origin, origin); assert.deepEqual(request.payload, confirmation.challenge); return new Promise(resolve => { release = resolve; }); });
  const security = createSecurity(f.runtime, { waitMs: 20 });
  const first = security.execute("POST", "/v1/requests/rq/answer", { answers: [] }, { idempotencyKey: "key", origin, actAsUser: true });
  const second = security.execute("POST", "/v1/requests/rq/answer", { answers: [] }, { idempotencyKey: "key", origin, actAsUser: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(count, 1); release(proof);
  assert.equal((await first).status, 200); assert.equal((await second).status, 200);
  assert.equal(f.calls.filter(call => call.path.endsWith("/sign")).length, 1);
  assert.equal(f.calls[0].options.idempotencyKey, "key"); assert.equal(f.calls[0].options.actAsUser, true);
  security.dispose();
});

for (const code of ["rejected", "timeout", "noDevice", "unsupported"]) {
  test(`确认失败 ${code} 不会被当作同意`, async () => {
    const f = fixture(async () => { throw Object.assign(new Error(code), { code }); });
    const security = createSecurity(f.runtime);
    const result = await security.execute("POST", "/v1/requests/rq/answer", {}, { idempotencyKey: "key", origin });
    assert.equal(result.status, code === "rejected" ? 409 : 202);
    assert.equal(f.calls.some(call => call.path.endsWith("/cancel")), code === "rejected");
    assert.equal(f.calls.some(call => call.path.endsWith("/sign")), false);
    security.dispose();
  });
}

test("三类安全横幅持久化，断线与无效响应不会清除，只有权威对齐才能清除", async () => {
  const f = fixture();
  f.banners.set("agora:security:devices-reset", { id: "agora:security:devices-reset", persistent: true, title: "旧警告" });
  const security = createSecurity(f.runtime);
  f.setReply({ status: 503, body: {} });
  await assert.rejects(security.refreshAlerts()); assert.equal(f.banners.size, 1);
  f.setReply({ status: 200, body: { items: [{ kind: "devices-reset" }] } });
  await assert.rejects(security.refreshAlerts()); assert.equal(f.banners.size, 1);
  const items = ["devices-reset", "protection-off", "budget-config-changed"].map((kind, index) => ({ alertId: `alert-${index}`, kind, revision: 3, details: { from: 1, to: 2 }, createdAt: new Date().toISOString() }));
  f.setReply({ status: 200, body: { items } }); await security.refreshAlerts();
  assert.equal(f.banners.size, 3); assert.ok([...f.banners.values()].every(item => item.persistent));
  assert.deepEqual(f.banners.get("agora:security:protection-off").actions, []);
  assert.deepEqual(f.banners.get("agora:security:budget-config-changed").actions, ["agora.security.acknowledge-budget"]);
  f.setReply({ status: 200, body: { items: items.map(item => item.kind === "devices-reset" ? { ...item, revision: 4 } : item) } });
  await security.refreshAlerts(); assert.equal(security.displayedAlert().revision, 4);
  f.setReply({ status: 409, body: { error: { code: "conflict" } } });
  await security.acknowledge("alert-0", 3, "old-revision", origin);
  assert.equal(f.banners.size, 3); assert.equal(f.calls.at(-1).body.revision, 3);
  f.setReply({ status: 200, body: { items: [] } }); await security.refreshAlerts(); assert.equal(f.banners.size, 0);
  security.dispose();
});

test("配对使用发起设备自签，其他设备的签名不能完成配对", async () => {
  const f = fixture(async () => ({ ...proof, deviceId: "other-device" }));
  const security = createSecurity(f.runtime);
  const result = await security.pair(origin, "pair-key");
  assert.equal(result.status, 403); assert.equal(f.calls[0].body.deviceId, origin.deviceId);
  assert.equal(f.calls.some(call => call.path.endsWith("/sign")), false);
  assert.equal((await security.pair({ ...origin, deviceId: undefined }, "key")).status, 400);
  security.dispose();
});

test("插件停用期间到达的签名不继续执行，也不清除原有横幅", async () => {
  let release;
  const f = fixture(() => new Promise(resolve => { release = resolve; }));
  f.banners.set("agora:security:protection-off", { id: "agora:security:protection-off", persistent: true });
  const security = createSecurity(f.runtime);
  const result = security.execute("POST", "/v1/operation", {}, { idempotencyKey: "key", origin });
  await new Promise(resolve => setImmediate(resolve)); security.dispose(); release(proof);
  assert.equal((await result).status, 202); assert.equal(f.banners.size, 1);
  assert.equal(f.calls.some(call => call.path.endsWith("/sign")), false);
});
