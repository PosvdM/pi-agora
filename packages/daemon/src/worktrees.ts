import { mkdir, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { homedir } from 'node:os';
import { gitExec, gitRead, gitHasGitlinks } from '@pi-agora/protocol';
import { AgoraError } from './errors.js';
import type { Store } from './store.js';

export interface WorktreeRow { task_id: string; repo_root: string; base_commit: string; branch: string; path: string; owner_id: string; state: string }
export class Worktrees {
  private readonly queues = new Map<string, Promise<unknown>>();
  constructor(readonly store: Store, readonly root = path.join(homedir(), '.pi', 'agora-worktrees')) {}
  private serial<T>(repo: string, fn: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(repo) ?? Promise.resolve()).catch(() => {}).then(fn);
    this.queues.set(repo, next);
    void next.finally(() => { if (this.queues.get(repo) === next) this.queues.delete(repo); }).catch(() => {});
    return next;
  }
  async create(cwd: string, taskId: string): Promise<{ worktree: WorktreeRow; warnings: string[] }> {
    const repo = await realpath((await gitExec(cwd, ['rev-parse', '--show-toplevel'])).trim());
    return this.serial(repo, async () => {
      const base = (await gitExec(cwd, ['rev-parse', '--verify', 'HEAD'])).trim();
      if (!/^[a-f0-9]{40,64}$/.test(base)) throw new AgoraError(400, 'invalid_repository', '无法确定 worktree 的基础提交');
      const dirty = (await gitRead(cwd, 'status')).trim().split('\n').filter(Boolean).length;
      const hash = createHash('sha256').update(repo).digest('hex').slice(0, 8);
      const parent = path.join(this.root, `${path.basename(repo)}-${hash}`);
      await mkdir(parent, { recursive: true });
      const directory = path.join(parent, `agora-${taskId}`), branch = `agora/${taskId}`;
      // 分支或 gitdir 条件配置必须在新 worktree 的上下文中探测后再检出。
      await gitExec(cwd, ['worktree', 'add', '--no-checkout', '-b', branch, directory, base]);
      await gitExec(directory, ['reset', '--hard', base]);
      return { worktree: { task_id: taskId, repo_root: repo, base_commit: base, branch, path: directory, owner_id: '', state: 'active' },
        warnings: dirty ? [`父工作目录有 ${dirty} 处未提交改动，不会带入 worktree`] : [] };
    });
  }
  get(taskId: string): WorktreeRow | undefined { return this.store.get<WorktreeRow>('SELECT * FROM worktrees WHERE task_id=?', taskId); }
  async remove(taskId: string, discard: boolean): Promise<void> {
    const row = this.get(taskId);
    if (!row || row.state === 'removed') return;
    await this.serial(row.repo_root, async () => {
      // worktree remove 的内部 status 会进入子模块，尚未覆盖这些子仓库的条件配置。
      if (await gitHasGitlinks(row.path)) {
        throw new AgoraError(409, 'worktree_submodules', '含子模块的 worktree 不支持自动清理，请手动验收和清理');
      }
      const dirty = (await gitRead(row.path, 'status')).trim();
      if (dirty && !discard) throw new AgoraError(409, 'worktree_dirty', 'worktree 有未提交改动或未跟踪文件，请验收后显式指定 discard');
      await gitExec(row.repo_root, ['worktree', 'remove', ...(discard ? ['--force'] : []), row.path], undefined, [row.path]);
      this.store.run("UPDATE worktrees SET state='removed' WHERE task_id=?", taskId);
    });
  }
}
