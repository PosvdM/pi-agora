import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveArchivePath } from "../packages/archive/dist/index.js";

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "agora-archive-paths-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  await mkdir(path.join(home, "sessions"), { recursive: true });
  return { root, home };
}
async function junction(t, target, link) {
  try { await symlink(target, link, "junction"); return true; }
  catch (error) {
    if (["EPERM", "EACCES"].includes(error.code)) { t.skip("本机不允许创建目录链接"); return false; }
    throw error;
  }
}

test("存档路径按真实边界接受根目录别名，存在和缺失文件均返回规范路径", async t => {
  const { root, home } = await fixture(t), alias = path.join(root, "alias");
  if (!await junction(t, home, alias)) return;
  const file = path.join(home, "sessions", "session.jsonl");
  await writeFile(file, "原始记录\n");
  assert.deepEqual(await resolveArchivePath(home, path.join(alias, "sessions", "session.jsonl")), { file, missing: false });
  assert.deepEqual(await resolveArchivePath(alias, "sessions/session.jsonl"), { file, missing: false });
  const missing = path.join(home, "sessions", "absent", "session.jsonl");
  assert.deepEqual(await resolveArchivePath(home, path.join(alias, "sessions", "absent", "session.jsonl")), { file: missing, missing: true });
  assert.equal(await readFile(file, "utf8"), "原始记录\n");
});

test("悬空目录链接仍解析目标，不能把越界目标伪装成 home 内缺失文件", async t => {
  const { root, home } = await fixture(t), outside = path.join(root, "outside");
  await mkdir(outside);
  const link = path.join(home, "jump");
  if (!await junction(t, path.join(outside, "missing"), link)) return;
  await assert.rejects(resolveArchivePath(home, path.join(link, "session.jsonl")), { code: "unsafe_path" });
});

test("home 内悬空链接返回真实待建路径，目标创建后仍指向同一文件", async t => {
  const { home } = await fixture(t), target = path.join(home, "pending"), link = path.join(home, "jump");
  if (!await junction(t, target, link)) return;
  const file = path.join(target, "session.jsonl");
  assert.deepEqual(await resolveArchivePath(home, path.join(link, "session.jsonl")), { file, missing: true });
  await mkdir(target); await writeFile(file, "{}\n");
  assert.deepEqual(await resolveArchivePath(home, path.join(link, "session.jsonl")), { file, missing: false });
});

test("路径组件不是目录时明确失败，不当成缺失文件", async t => {
  const { home } = await fixture(t), file = path.join(home, "plain-file");
  await writeFile(file, "原始记录\n");
  await assert.rejects(resolveArchivePath(home, path.join(file, "session.jsonl")), { code: "invalid_file" });
});
