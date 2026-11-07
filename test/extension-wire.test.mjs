import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { extensionWire } from './fixtures/extension-wire.mjs';

for (const permanent of [false, true]) test(`夹具原子发布${permanent ? '永久错误保留旧文件并失败' : '有界处理Windows临时共享冲突'}`, { timeout: 10000 }, async t => {
  const root = await fs.mkdtemp(join(tmpdir(), 'agora-wire-publish-'));
  const wire = await extensionWire(root);
  const file = join(root, 'run', 'daemon.json');
  const original = await fs.readFile(file, 'utf8');
  const rename = fs.rename;
  let attempts = 0;
  const spy = mock.method(fs, 'rename', async (...args) => {
    if (String(args[1]) === file) {
      attempts++;
      if (permanent || attempts <= 2) {
        assert.equal(await fs.readFile(file, 'utf8'), original, '替换失败期间旧发现记录必须完整不变');
        throw Object.assign(new Error('受控发布故障'), { code: permanent ? 'EIO' : 'EPERM' });
      }
    }
    return rename(...args);
  });
  syncBuiltinESMExports();
  try {
    if (permanent || process.platform !== 'win32') {
      await assert.rejects(wire.restart(), error => error.code === (permanent ? 'EIO' : 'EPERM'));
      assert.equal(attempts, 1, '永久错误或非Windows权限错误不能被重试掩盖');
      assert.equal(await fs.readFile(file, 'utf8'), original);
    } else {
      await wire.restart();
      assert.equal(attempts, 3);
      assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).instanceId, 'instance-two');
      t.diagnostic('Windows真实执行两次EPERM注入后原子替换成功，无非原子回退');
    }
  } finally {
    spy.mock.restore(); syncBuiltinESMExports();
    await wire.close();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
  }
});
