import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assertIsolatedTestHome } from './fixtures/test-home.mjs';

const keys = ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA'];
function isolated(root) { return Object.fromEntries(keys.map(key => [key, path.join(root, key.toLowerCase())])); }

test('公共夹具要求四个用户目录全部重定向，不接受真实进程环境或临时目录本身', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'agora-home-guard-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const environment = isolated(root);
  await assertIsolatedTestHome(root, environment);
  await assert.rejects(assertIsolatedTestHome(root), /测试 HOME 未隔离/);
  await assert.rejects(assertIsolatedTestHome(tmpdir(), isolated(tmpdir())), /独立子目录/);
  for (const key of keys) {
    await assert.rejects(assertIsolatedTestHome(root, { ...environment, [key]: undefined }), new RegExp(key));
    await assert.rejects(assertIsolatedTestHome(root, { ...environment, [key]: path.join(path.dirname(root), 'outside') }), new RegExp(key));
  }
});

test('公共夹具拒绝用户目录链接越出当前测试现场', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'agora-home-link-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'agora-home-outside-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); });
  const link = path.join(root, 'linked-home');
  await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(assertIsolatedTestHome(root, { ...isolated(root), HOME: link }), /链接指向/);
});
