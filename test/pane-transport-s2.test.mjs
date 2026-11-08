import test from "node:test";
import assert from "node:assert/strict";
import { createDaemonApi } from "../packages/pane-plugin/dist/transport.js";

function client() { return { url: "http://127.0.0.1:4001", token: "private-token", async refresh() {}, close() {} }; }
test("插件传输只允许本机 daemon 相对端点，并透传协议、幂等和用户级标记", async () => {
  const calls = [];
  const api = createDaemonApi(client(), async (url, options) => {
    calls.push({ url, options }); return Response.json({ error: { code: "already_handled", message: "已处理" } }, { status: 409 });
  });
  const result = await api.request("POST", "/v1/requests/rq/answer", { answers: [] }, { idempotencyKey: "original-key", actAsUser: true });
  assert.equal(result.status, 409); assert.equal(calls.length, 1);
  assert.equal(calls[0].options.headers.Authorization, "Bearer private-token");
  assert.equal(calls[0].options.headers["Agora-Protocol"], "1");
  assert.equal(calls[0].options.headers["Idempotency-Key"], "original-key");
  assert.equal(calls[0].options.headers["Agora-Act-As"], "user");
  for (const path of ["https://elsewhere/v1", "//elsewhere/v1", "/v1/../../secret", "/v1/a#fragment", "/v1/\\evil"]) await assert.rejects(api.request("GET", path));
  api.close();
});

test("结果未知只重发相同幂等请求，普通写入不自动重发", async () => {
  const seen = [];
  const api = createDaemonApi(client(), async (_url, options) => { seen.push(options); throw new TypeError("网络断开"); });
  await assert.rejects(api.request("POST", "/v1/tasks", { title: "任务" })); assert.equal(seen.length, 1);
  await assert.rejects(api.request("POST", "/v1/tasks", { title: "任务" }, { idempotencyKey: "key" })); assert.equal(seen.length, 3);
  assert.deepEqual(seen[1].headers, seen[2].headers); assert.equal(seen[1].body, seen[2].body);
  api.close();
});

test("SSE 解析支持 UTF-8 与跨网络分片，取消订阅后不再回调", async () => {
  let controller;
  const api = createDaemonApi(client(), async (_url, options) => {
    const stream = new ReadableStream({ start(value) { controller = value; options.signal.addEventListener("abort", () => value.error(new Error("已取消")), { once: true }); } });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
  });
  const events = [], errors = [];
  const stop = api.subscribe("/v1/changes?epoch=e&afterSeq=0", event => events.push(event), error => errors.push(error));
  await new Promise(resolve => setImmediate(resolve));
  const bytes = new TextEncoder().encode('event: change\r\ndata: {"message":"中文"}\r\n\r\nevent: reset\ndata: {"epoch":"new"}\n\n');
  for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, [{ type: "change", data: { message: "中文" } }, { type: "reset", data: { epoch: "new" } }]);
  stop(); await new Promise(resolve => setImmediate(resolve)); assert.equal(errors.length, 0);
  api.close();
});
