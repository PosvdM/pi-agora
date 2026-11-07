import { canonicalPath, isWithin } from 'pi-hostkit/paths';
import type { ChildPolicy, PiExtensionApi, SessionContext, ToolCall } from './types.js';

export const EXTENSION_VERSION = '0.1.0';
const EXPLORE_TOOLS = ['find', 'grep', 'ls', 'read'];
export function sameTools(left: string[], right: string[]): boolean {
  return left.length === right.length && new Set(left).size === left.length &&
    [...left].sort().every((name, i) => name === [...right].sort()[i]);
}
export function validatePolicy(policy: ChildPolicy): void {
  if (!policy || policy.profile !== 'explore' || !sameTools(policy.tools ?? [], EXPLORE_TOOLS) ||
      !Array.isArray(policy.allowedRoots) || !policy.allowedRoots.length ||
      !Array.isArray(policy.protectedPaths) || !policy.protectedPaths.length ||
      [...policy.allowedRoots, ...policy.protectedPaths].some(p => typeof p !== 'string' || !p) ||
      typeof policy.model !== 'string' || !policy.model.includes('/') ||
      typeof policy.thinking !== 'string' || policy.extensionVersion !== EXTENSION_VERSION) {
    throw new Error('agora 子会话权限策略无效');
  }
}
export function verifyRuntime(pi: PiExtensionApi, ctx: SessionContext, policy: ChildPolicy): void {
  if (!sameTools(pi.getActiveTools(), policy.tools) || !ctx.model ||
      `${ctx.model.provider}/${ctx.model.id}` !== policy.model || pi.getThinkingLevel() !== policy.thinking) {
    throw new Error('agora 子会话工具、模型或思考级别与启动策略不符');
  }
}
export async function checkToolPath(event: ToolCall, ctx: SessionContext, policy: ChildPolicy): Promise<string | undefined> {
  if (!policy.tools.includes(event.toolName)) return '此工具不在只读任务的允许列表中';
  const search = event.toolName !== 'read';
  const raw = event.input.path;
  if ((raw !== undefined && (typeof raw !== 'string' || !raw)) || (!search && typeof raw !== 'string')) {
    return '文件路径无效';
  }
  const target = await canonicalPath(typeof raw === 'string' ? raw : ctx.cwd, ctx.cwd, event.toolName === 'read' ? 'read' : 'write');
  const roots = await Promise.all(policy.allowedRoots.map(root => canonicalPath(root, ctx.cwd, 'write')));
  const protectedPaths = await Promise.all(policy.protectedPaths.map(root => canonicalPath(root, ctx.cwd, 'write')));
  if (protectedPaths.some(root => isWithin(root, target))) return '此路径受保护，不能读取';
  if (search && protectedPaths.some(root => isWithin(target, root))) return '搜索范围包含受保护目录，请缩小范围';
  if (!roots.some(root => isWithin(root, target))) return '此路径不在任务允许的目录内';
  return undefined;
}
