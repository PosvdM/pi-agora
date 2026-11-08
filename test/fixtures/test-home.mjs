import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const temporaryDirectory = tmpdir();
const keys = ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA'];
function inside(root, file) {
  const relative = path.relative(root, file);
  return relative === '' || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}
async function pendingRealpath(file) {
  let current = path.resolve(file);
  const remaining = [];
  for (;;) {
    try { return path.join(await realpath(current), ...remaining.reverse()); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      remaining.push(path.basename(current)); current = parent;
    }
  }
}

/** 在任何真实 pi 或会话锁操作前调用；四个用户目录都必须位于独立临时现场。 */
export async function assertIsolatedTestHome(root, environment = process.env) {
  if (!root || !path.isAbsolute(root)) throw new Error('测试 HOME 未隔离：缺少绝对临时现场路径');
  const canonical = await realpath(root), temporary = await realpath(temporaryDirectory);
  if (canonical === temporary || !inside(temporary, canonical)) throw new Error('测试 HOME 未隔离：现场必须是系统临时目录中的独立子目录');
  for (const key of keys) {
    const value = environment[key];
    // 先做词法边界检查，拒绝时不读取真实用户目录。
    if (!value || !path.isAbsolute(value) || !inside(path.resolve(root), path.resolve(value))) throw new Error(`测试 HOME 未隔离：${key} 必须重定向到当前临时现场`);
    if (!inside(canonical, await pendingRealpath(value))) throw new Error(`测试 HOME 未隔离：${key} 的链接指向临时现场之外`);
  }
}
