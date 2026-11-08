import type { SessionEntry } from "@pi-agora/protocol";
import { setImmediate } from "node:timers/promises";
import { ArchiveError } from "./errors.js";

function* projection(entries: SessionEntry[], leafId: string | null): Generator<void, SessionEntry[]> {
  const byId = new Map<string, SessionEntry>();
  for (const entry of entries) {
    byId.set(entry.id, entry);
    yield;
  }
  const result: SessionEntry[] = [];
  const visited = new Set<string>();
  let id = leafId;
  while (id !== null) {
    if (visited.has(id)) throw new ArchiveError("invalid_branch", "会话活动分支包含循环引用");
    visited.add(id);
    const entry = byId.get(id);
    if (!entry) break;
    result.push(entry);
    id = entry.parentId;
    yield;
  }
  return result.reverse();
}

/** 返回从根到叶子的完整活动分支，保留压缩条目及其之前的内容。 */
export function projectUserView(entries: SessionEntry[], leafId: string | null): SessionEntry[] {
  const steps = projection(entries, leafId);
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
  }
}

export async function projectUserViewAsync(entries: SessionEntry[], leafId: string | null): Promise<SessionEntry[]> {
  const steps = projection(entries, leafId);
  let count = 0;
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
    if (++count % 1000 === 0) await setImmediate();
  }
}
