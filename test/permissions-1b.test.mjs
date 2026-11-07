import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { checkToolPath, validatePolicy, verifyRuntime } from '../packages/extension/dist/permissions.js';

const legacy = ['read', 'grep', 'find', 'ls'];
const explore = [...legacy, 'agora_task', 'agora_request'];
const review = [...explore, 'agora_git'];
const implement = [...review, 'bash', 'edit', 'write'];
const tools = { explore, review, implement };
const policy = (profile, roots = ['/allowed'], protectedPaths = ['/protected']) => ({
  profile, tools: [...tools[profile]], allowedRoots: roots, protectedPaths,
  model: 'fake/model', thinking: 'off', extensionVersion: '0.1.0',
});
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'agora-permissions-1b-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const allowed = path.join(root, 'Allowed');
  const publicDir = path.join(allowed, 'public');
  const secret = path.join(allowed, 'Secret');
  const outside = path.join(root, 'outside');
  await Promise.all([publicDir, secret, outside].map(dir => mkdir(dir, { recursive: true })));
  for (const dir of [publicDir, secret, outside]) await writeFile(path.join(dir, 'file.txt'), 'fixture');
  const ctx = { cwd: allowed, model: { provider: 'fake', id: 'model' } };
  const policies = Object.fromEntries(Object.keys(tools).map(profile => [profile, policy(profile, [allowed], [secret])]));
  const check = (profile, toolName, target, input = {}) => checkToolPath({ toolName,
    input: target === undefined ? input : { ...input, path: target } }, ctx, policies[profile]);
  return { root, allowed, publicDir, secret, outside, ctx, policies, check };
}

test('1b policy：三个档位必须完全匹配，explore 只兼容精确的四工具集合', () => {
  for (const profile of Object.keys(tools)) {
    const p = policy(profile);
    validatePolicy(p);
    validatePolicy({ ...p, tools: [...p.tools].reverse() });
    for (const name of p.tools) assert.throws(() => validatePolicy({ ...p, tools: p.tools.filter(tool => tool !== name) }), /无效/);
    for (const extra of ['unknown', 'mcp_read', 'powershell', ...implement.filter(name => !p.tools.includes(name))]) {
      if (profile === 'implement' && extra === 'powershell' && process.platform === 'win32') continue;
      assert.throws(() => validatePolicy({ ...p, tools: [...p.tools, extra] }), /无效/);
    }
    assert.throws(() => validatePolicy({ ...p, tools: [...p.tools, p.tools[0]] }), /无效/);
    for (const value of [null, {}, 'read', [null]]) assert.throws(() => validatePolicy({ ...p, tools: value }), /无效/);
  }
  validatePolicy({ ...policy('explore'), tools: legacy });
  assert.throws(() => validatePolicy({ ...policy('review'), tools: [...legacy, 'agora_git'] }), /无效/);
  const powershell = { ...policy('implement'), tools: [...implement, 'powershell'] };
  if (process.platform === 'win32') validatePolicy(powershell);
  else assert.throws(() => validatePolicy(powershell), /无效/);
  for (const patch of [{ profile: 'unknown' }, { profile: '__proto__' }, { allowedRoots: [] },
    { protectedPaths: [] }, { allowedRoots: [null] }, { protectedPaths: [''] }, { model: 'model' },
    { extensionVersion: 'unknown' }, { thinking: null }]) {
    assert.throws(() => validatePolicy({ ...policy('explore'), ...patch }), /无效/);
  }
  assert.throws(() => validatePolicy(null), /无效/);
});

test('1b runtime：各档位核实工具、模型及思考级别', () => {
  const ctx = { model: { provider: 'fake', id: 'model' } };
  for (const profile of Object.keys(tools)) {
    const p = policy(profile);
    const pi = { getActiveTools: () => p.tools, getThinkingLevel: () => p.thinking };
    verifyRuntime(pi, ctx, p);
    assert.throws(() => verifyRuntime({ ...pi, getActiveTools: () => [...p.tools, 'unknown'] }, ctx, p), /不符/);
    assert.throws(() => verifyRuntime({ ...pi, getActiveTools: () => p.tools.slice(1) }, ctx, p), /不符/);
    assert.throws(() => verifyRuntime({ ...pi, getThinkingLevel: () => 'high' }, ctx, p), /不符/);
    assert.throws(() => verifyRuntime(pi, { model: { provider: 'other', id: 'model' } }, p), /不符/);
    assert.throws(() => verifyRuntime(pi, {}, p), /不符/);
  }
});

test('1b gate：协作工具不处理 path，shell 不检查 command，未知工具拒绝', async t => {
  const f = await fixture(t);
  for (const profile of Object.keys(tools)) {
    for (const name of ['agora_task', 'agora_request', 'agora_git']) {
      const reason = await f.check(profile, name, { invalid: true });
      if (tools[profile].includes(name)) assert.equal(reason, undefined);
      else assert.match(reason, /允许列表/);
    }
    for (const name of ['bash', 'powershell', 'unknown', 'mcp_read', 'edit', 'write']) {
      if (profile === 'implement' && ['bash', 'edit', 'write'].includes(name)) continue;
      assert.match(await f.check(profile, name), /允许列表/);
    }
  }
  assert.equal(await f.check('implement', 'bash', null, { command: 'anything > protected' }), undefined);
  if (process.platform === 'win32') {
    f.policies.implement.tools.push('powershell');
    assert.equal(await f.check('implement', 'powershell', {}, { command: 'anything' }), undefined);
  }
  f.policies.implement.tools.push('unknown');
  assert.match(await f.check('implement', 'unknown'), /允许列表/);
});

test('1b paths：explore/review 限根，implement 可跨 cwd，三档都保护路径和搜索祖先', async t => {
  const f = await fixture(t);
  for (const profile of Object.keys(tools)) {
    for (const name of legacy) {
      assert.equal(await f.check(profile, name, path.join(f.publicDir, 'file.txt')), undefined);
      assert.match(await f.check(profile, name, f.secret), /受保护/);
      const outside = await f.check(profile, name, f.outside);
      if (profile === 'implement') assert.equal(outside, undefined);
      else assert.match(outside, /允许的目录/);
    }
    for (const name of ['grep', 'find', 'ls']) {
      assert.match(await f.check(profile, name), /缩小范围/);
      assert.match(await f.check(profile, name, f.root), /缩小范围/);
    }
    for (const name of tools[profile].filter(name => [...legacy, 'edit', 'write'].includes(name))) {
      for (const bad of ['', null, 1, {}, []]) assert.match(await f.check(profile, name, bad), /路径无效/);
      if (!['grep', 'find', 'ls'].includes(name)) assert.match(await f.check(profile, name), /路径无效/);
    }
  }
  for (const name of ['edit', 'write']) {
    assert.equal(await f.check('implement', name, path.join(f.outside, 'new', 'deep', 'file.txt')), undefined);
    assert.match(await f.check('implement', name, path.join(f.secret, 'new', 'deep', 'file.txt')), /受保护/);
  }
  for (const profile of ['explore', 'review']) {
    assert.match(await f.check(profile, 'read', path.join(f.allowed + '-sibling', 'new.txt')), /允许的目录/);
  }
  assert.equal(await f.check('implement', 'write', path.join(f.allowed, 'Secret-sibling', 'new.txt')), undefined);
});

test('1b 原生路径：真实 junction/symlink、缺失文件祖先与链接逃逸', async t => {
  const f = await fixture(t);
  const kind = process.platform === 'win32' ? 'junction' : 'dir';
  const protectedLink = path.join(f.publicDir, 'protected-link');
  const outsideLink = path.join(f.publicDir, 'outside-link');
  const alias = path.join(f.root, 'allowed-alias');
  const pendingLink = path.join(f.publicDir, 'pending-link');
  await symlink(f.secret, protectedLink, kind);
  await symlink(f.outside, outsideLink, kind);
  await symlink(f.allowed, alias, kind);
  await symlink(path.join(f.secret, 'not-created'), pendingLink, kind);
  assert.equal((await lstat(protectedLink)).isSymbolicLink(), true);
  assert.equal(await realpath(protectedLink), await realpath(f.secret));
  for (const profile of Object.keys(tools)) {
    for (const name of tools[profile].filter(name => [...legacy, 'edit', 'write'].includes(name))) {
      assert.match(await f.check(profile, name, path.join(protectedLink, 'new', 'deep.txt')), /受保护/);
      assert.match(await f.check(profile, name, path.join(pendingLink, 'new', 'deep.txt')), /受保护/);
      assert.equal(await f.check(profile, name, path.join(alias, 'public', 'file.txt')), undefined);
      const escape = await f.check(profile, name, path.join(outsideLink, 'new', 'deep.txt'));
      if (profile === 'implement') assert.equal(escape, undefined);
      else assert.match(escape, /允许的目录/);
    }
    for (const name of ['grep', 'find', 'ls']) assert.match(await f.check(profile, name, alias), /缩小范围/);
  }
  t.diagnostic(JSON.stringify({ platform: process.platform, kind, cwd: f.ctx.cwd,
    protectedLink, realTarget: await realpath(protectedLink),
    pendingPath: path.join(pendingLink, 'new', 'deep.txt'), result: 'protected; search ancestors blocked; outside root denied except implement' }));
});

test('1b Windows 8.3 短名仍受真实路径权限约束', { skip: process.platform !== 'win32' && '仅 Windows 提供 8.3 短名' }, async t => {
  const f = await fixture(t), protectedDir = path.join(f.allowed, 'LongProtectedDirectory'), publicDir = path.join(f.allowed, 'LongPublicDirectory');
  await mkdir(protectedDir); await mkdir(publicDir);
  await writeFile(path.join(protectedDir, 'file.txt'), '受保护'); await writeFile(path.join(publicDir, 'file.txt'), '安全');
  const short = target => execFileSync('cmd.exe', ['/d', '/c', `for %I in ("${target}") do @echo %~sI`],
    { encoding: 'utf8', timeout: 10_000, windowsHide: true }).trim();
  let protectedShort, publicShort;
  try { protectedShort = short(protectedDir); publicShort = short(publicDir); }
  catch (error) { t.skip(`cmd.exe 无法获取短名：${error.code ?? error.message}`); return; }
  if (!protectedShort.includes('~') || !publicShort.includes('~')) {
    t.skip('临时目录所在卷未分配 8.3 短名；cmd %~sI 返回长路径，无法构造真实短名别名'); return;
  }
  assert.equal((await realpath(protectedShort)).toLowerCase(), (await realpath(protectedDir)).toLowerCase());
  for (const profile of Object.keys(tools)) {
    f.policies[profile].protectedPaths.push(protectedDir);
    for (const name of legacy) {
      assert.match(await f.check(profile, name, path.join(protectedShort, 'file.txt')), /受保护/);
      assert.equal(await f.check(profile, name, path.join(publicShort, 'file.txt')), undefined);
    }
    if (profile === 'implement') assert.match(await f.check(profile, 'write', path.join(protectedShort, 'new', 'file.txt')), /受保护/);
  }
  t.diagnostic('已用 cmd %~sI 取得实际 8.3 别名，核对真实目录和三档保护规则');
});

test('1b 原生路径：Unicode 空格、read NFD 回退、Windows 大小写及 shell 风格路径', async t => {
  const f = await fixture(t);
  const spaced = path.join(f.publicDir, 'private key.txt');
  const nfd = path.join(f.publicDir, 'café.txt'.normalize('NFD'));
  await writeFile(spaced, 'secret');
  await writeFile(nfd, 'secret');
  for (const profile of Object.keys(tools)) {
    f.policies[profile].protectedPaths.push(spaced, nfd);
    assert.match(await f.check(profile, 'read', '@' + spaced.replace('private key', 'private\u202fkey')), /受保护/);
    assert.match(await f.check(profile, 'read', path.join(f.publicDir, 'café.txt')), /受保护/);
  }
  if (process.platform === 'win32') {
    const drive = f.secret[0].toLowerCase();
    const slash = f.secret.slice(2).replaceAll('\\', '/');
    for (const form of [f.secret.toUpperCase(), `/${drive}${slash}`, `/mnt/${drive}${slash}`, `\\\\?\\${f.secret}`]) {
      assert.match(await f.check('implement', 'write', `${form}/not-created/key`), /受保护/);
      t.diagnostic(`win32 protected path denied: ${form}`);
    }
    assert.equal(await f.check('explore', 'read', path.join(f.publicDir, 'file.txt').toUpperCase()), undefined);
  } else {
    const distinct = path.join(f.allowed, 'secret');
    if (process.platform === 'linux') {
      await mkdir(distinct);
      assert.equal(await f.check('implement', 'write', path.join(distinct, 'key')), undefined);
    }
  }
});
