import { canonicalPath, isWithin } from 'pi-hostkit/paths';
import type { ChildPolicy, PiExtensionApi, SessionContext, ToolCall } from './types.js';

export const EXTENSION_VERSION = '0.1.0';
const FILE_TOOLS = ['read', 'grep', 'find', 'ls', 'edit', 'write'];
const SEARCH_TOOLS = ['grep', 'find', 'ls'];
const LEGACY_EXPLORE_TOOLS = ['read', 'grep', 'find', 'ls'];
const EXPLORE_TOOLS = [...LEGACY_EXPLORE_TOOLS, 'agora_task', 'agora_request'];
const REVIEW_TOOLS = [...EXPLORE_TOOLS, 'agora_git'];
const IMPLEMENT_TOOLS = [...REVIEW_TOOLS, 'bash', 'edit', 'write'];
function profileTools(profile: ChildPolicy['profile']): string[] {
  switch (profile) {
    case 'explore': return EXPLORE_TOOLS;
    case 'review': return REVIEW_TOOLS;
    case 'implement': return process.platform === 'win32' ? [...IMPLEMENT_TOOLS, 'powershell'] : IMPLEMENT_TOOLS;
    default: return [];
  }
}
function validTools(policy: ChildPolicy): boolean {
  if (!Array.isArray(policy.tools) || !policy.tools.every(tool => typeof tool === 'string')) return false;
  const expected = profileTools(policy.profile);
  return expected.length > 0 && (sameTools(policy.tools, expected) ||
    policy.profile === 'implement' && sameTools(policy.tools, IMPLEMENT_TOOLS) ||
    policy.profile === 'explore' && sameTools(policy.tools, LEGACY_EXPLORE_TOOLS));
}
export function sameTools(left: string[], right: string[]): boolean {
  return left.length === right.length && new Set(left).size === left.length &&
    [...left].sort().every((name, i) => name === [...right].sort()[i]);
}
export function validatePolicy(policy: ChildPolicy): void {
  if (!policy || !validTools(policy) ||
      !Array.isArray(policy.allowedRoots) || !policy.allowedRoots.length ||
      !Array.isArray(policy.protectedPaths) || !policy.protectedPaths.length ||
      [...policy.allowedRoots, ...policy.protectedPaths].some(p => typeof p !== 'string' || !p) ||
      (policy.readOnlyRoots !== undefined && (!Array.isArray(policy.readOnlyRoots) || policy.readOnlyRoots.some(p => typeof p !== 'string' || !p))) ||
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
  if (!policy.tools.includes(event.toolName) || !profileTools(policy.profile).includes(event.toolName)) {
    return '此工具不在任务的允许列表中';
  }
  if (!FILE_TOOLS.includes(event.toolName)) return undefined;
  const search = SEARCH_TOOLS.includes(event.toolName);
  const raw = event.input.path;
  if ((raw !== undefined && (typeof raw !== 'string' || !raw)) || (!search && typeof raw !== 'string')) {
    return '文件路径无效';
  }
  const target = await canonicalPath(typeof raw === 'string' ? raw : ctx.cwd, ctx.cwd, event.toolName === 'read' ? 'read' : 'write');
  const protectedPaths = await Promise.all(policy.protectedPaths.map(root => canonicalPath(root, ctx.cwd, 'write')));
  if (protectedPaths.some(root => isWithin(root, target))) return '此路径受保护，不能访问';
  if (search && protectedPaths.some(root => isWithin(target, root))) return '搜索范围包含受保护目录，请缩小范围';
  const readOnlyRoots = await Promise.all((policy.readOnlyRoots ?? []).map(root => canonicalPath(root, ctx.cwd, 'write')));
  const writing = ['write', 'edit'].includes(event.toolName);
  if (writing && readOnlyRoots.some(root => isWithin(root, target))) return 'skill 目录只允许读取';
  if (policy.profile !== 'implement') {
    const roots = await Promise.all(policy.allowedRoots.map(root => canonicalPath(root, ctx.cwd, 'write')));
    if (![...roots, ...(!writing ? readOnlyRoots : [])].some(root => isWithin(root, target))) return '此路径不在任务允许的目录内';
  }
  return undefined;
}
