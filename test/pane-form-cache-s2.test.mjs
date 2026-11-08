import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFormCache, displayRecord, FORM_CACHE_FILE, MAX_FORM_CACHE_BYTES, MAX_FORM_CACHE_ITEMS } from "../packages/pane-plugin/dist/form-cache.js";

const item = (revision = 1, id = "one") => ({ kind: "request", id, form: {
  id: `agora:request:${id}`, source: "agora", revision, title: "提问", createdAt: "2026-01-01T00:00:00Z",
  questions: [{ id: "q", question: "选择方案", options: [{ label: "甲", recommended: true }], dependsOn: { questionId: "previous", value: ["甲"] } }],
} });
async function directory(t) {
  const dir = await mkdtemp(join(tmpdir(), "agora-form-cache-unit-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("缓存仅首次调用才读取；缺失文件为空，实际读写位于临时 dataDir", async t => {
  const dir = await directory(t), cache = createFormCache(dir, () => {});
  assert.deepEqual(await readdir(dir), []);
  assert.equal((await cache.load()).size, 0);
  await cache.save([item()]);
  assert.deepEqual([...await cache.load()], [[item().form.id, item()]]);
  assert.deepEqual(await readdir(dir), [FORM_CACHE_FILE]);
});

test("缓存写盘按入队顺序固定快照，不回写旧版本，失败后后续写入仍可继续", async t => {
  const dir = await directory(t), cache = createFormCache(dir, () => {});
  const mutable = item(1);
  const first = cache.save([mutable]); mutable.form.revision = 99;
  const second = cache.save([item(2)]), third = cache.save([item(3)]);
  await Promise.all([first, second, third]);
  assert.equal((await cache.load()).get(item().form.id).form.revision, 3);
  assert.throws(() => cache.save([item(0)]), /格式无效/);
  await cache.save([item(4)]);
  assert.equal((await cache.load()).get(item().form.id).form.revision, 4);
  assert.deepEqual(await readdir(dir), [FORM_CACHE_FILE]);
});

for (const [label, mutate] of [
  ["重复标识", values => values.push(structuredClone(values[0]))],
  ["业务标识不匹配", values => { values[0].id = "other"; }],
  ["来源不匹配", values => { values[0].form.source = "other"; }],
  ["非法业务类型", values => { values[0].kind = "unknown"; }],
  ["非法时间", values => { values[0].form.createdAt = "无效日期"; }],
  ["非法修订号", values => { values[0].form.revision = 0; }],
  ["缺少标题", values => { delete values[0].form.title; }],
  ["原始业务对象", values => { values[0].object = { token: "不能保存" }; }],
  ["表单额外凭据", values => { values[0].form.token = "不能保存"; }],
  ["嵌套选项额外凭据", values => { values[0].form.questions[0].options[0].privateKey = "不能保存"; }],
]) {
  test(`${label}缓存拒绝加载，不能伪装成空列表`, async t => {
    const dir = await directory(t), values = [item()]; mutate(values);
    await writeFile(join(dir, FORM_CACHE_FILE), JSON.stringify({ version: 1, records: values }));
    await assert.rejects(createFormCache(dir, () => {}).load(), /格式无效/);
  });
}

test("非法 UTF-8 缓存不能以替换字符作为合法显示内容", async t => {
  const dir = await directory(t);
  await writeFile(join(dir, FORM_CACHE_FILE), Buffer.concat([Buffer.from('{"version":1,"records":[],"extra":"'), Buffer.from([0xff]), Buffer.from('"}') ]));
  await assert.rejects(createFormCache(dir, () => {}).load());
});

test("白名单投影丢弃原始对象和深层凭据，不复用输入引用", () => {
  const value = item(); value.object = { token: "不能保存" }; value.form.token = "不能保存";
  value.form.questions[0].options[0].privateKey = "不能保存";
  const projected = displayRecord(value);
  assert.doesNotMatch(JSON.stringify(projected), /token|privateKey|不能保存/);
  projected.form.questions[0].question = "外部修改";
  assert.equal(value.form.questions[0].question, "选择方案");
});

test("递归字段深度有界，损坏缓存不会导致无限递归", async t => {
  const dir = await directory(t), value = item();
  let field = { id: "leaf", label: "字段", type: "text" };
  for (let i = 0; i < 20; i++) field = { id: "group", label: "分组", type: "group", fields: [field] };
  value.form.fields = [field];
  await writeFile(join(dir, FORM_CACHE_FILE), JSON.stringify({ version: 1, records: [value] }));
  await assert.rejects(createFormCache(dir, () => {}).load(), /格式无效/);
});

test("缓存恰好 4096 项可读写，多一项拒绝且保留原文件", async t => {
  const dir = await directory(t), cache = createFormCache(dir, () => {});
  const values = Array.from({ length: MAX_FORM_CACHE_ITEMS }, (_, i) => item(1, String(i)));
  await cache.save(values); assert.equal((await cache.load()).size, MAX_FORM_CACHE_ITEMS);
  const before = await readFile(join(dir, FORM_CACHE_FILE), "utf8");
  assert.throws(() => cache.save([...values, item(1, "extra")]), /事项超过限制/);
  assert.equal(await readFile(join(dir, FORM_CACHE_FILE), "utf8"), before);
});

test("缓存恰好 8 MiB 可读写，多一个字节拒绝且保留原文件", async t => {
  const dir = await directory(t), cache = createFormCache(dir, () => {}), value = item();
  value.form.description = "";
  const overhead = Buffer.byteLength(JSON.stringify({ version: 1, records: [value] }));
  value.form.description = "x".repeat(MAX_FORM_CACHE_BYTES - overhead);
  await cache.save([value]);
  const before = await readFile(join(dir, FORM_CACHE_FILE));
  assert.equal(before.length, MAX_FORM_CACHE_BYTES); assert.equal((await cache.load()).size, 1);
  value.form.description += "x";
  assert.throws(() => cache.save([value]), /8 MiB/);
  assert.deepEqual(await readFile(join(dir, FORM_CACHE_FILE)), before);
  await writeFile(join(dir, FORM_CACHE_FILE), Buffer.concat([before, Buffer.from(" ")]));
  await assert.rejects(cache.load(), /超过限制/);
});

test("停用发生在写盘期间时，不替换旧快照，临时文件清理且队列不再开始新写盘", async t => {
  const dir = await directory(t);
  await createFormCache(dir, () => {}).save([item(1)]);
  const before = await readFile(join(dir, FORM_CACHE_FILE), "utf8");
  let checks = 0;
  const cache = createFormCache(dir, () => {
    // 两次入队检查后，首次写盘在完成临时文件写入后检测停用。
    if (++checks >= 6) throw new Error("agora 插件已停用");
  });
  const results = await Promise.allSettled([cache.save([item(2)]), cache.save([item(3)])]);
  assert.deepEqual(results.map(value => value.status), ["rejected", "rejected"]);
  assert.equal(await readFile(join(dir, FORM_CACHE_FILE), "utf8"), before);
  assert.deepEqual(await readdir(dir), [FORM_CACHE_FILE]);
});
