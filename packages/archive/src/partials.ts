import type { InFlightBlock, UnfinishedPartial } from "@pi-agora/protocol";
import { setImmediate } from "node:timers/promises";
import type { PartialFragment } from "./types.js";

type Group = { runId: string; at: string; blocks: Map<number, InFlightBlock> };
function* groupPartials(fragments: PartialFragment[]): Generator<void, UnfinishedPartial[]> {
  const groups = new Map<string, Group>();
  for (const fragment of fragments) {
    const key = JSON.stringify([fragment.runId, fragment.messageSeq]);
    let group = groups.get(key);
    if (!group) {
      group = { runId: fragment.runId, at: fragment.t, blocks: new Map() };
      groups.set(key, group);
    }
    let block = group.blocks.get(fragment.contentIndex);
    if (!block || block.type !== fragment.blockType) {
      block = fragment.blockType === "toolCall"
        ? { type: "toolCall", contentIndex: fragment.contentIndex, id: "", toolName: "", argsText: "", done: false }
        : { type: fragment.blockType, contentIndex: fragment.contentIndex, text: "", done: false };
      group.blocks.set(fragment.contentIndex, block);
    }
    if (block.type === "toolCall") {
      if (fragment.toolCallId !== undefined) block.id = fragment.toolCallId;
      if (fragment.toolName !== undefined) block.toolName = fragment.toolName;
      block.argsText = fragment.replace === true ? fragment.delta : block.argsText + fragment.delta;
      if (fragment.args !== undefined) block.args = structuredClone(fragment.args);
    } else block.text = fragment.replace === true ? fragment.delta : block.text + fragment.delta;
    if (typeof fragment.done === "boolean") block.done = fragment.done;
    yield;
  }
  return [...groups.values()].sort((a, b) => a.at.localeCompare(b.at) || a.runId.localeCompare(b.runId))
    .map(group => ({ runId: group.runId, at: group.at, blocks: [...group.blocks.values()].sort((a, b) => a.contentIndex - b.contentIndex) }));
}

/** 将旁车增量还原为查看器使用的块，权威结束行替换之前的拼接结果。 */
export function projectPartials(fragments: PartialFragment[]): UnfinishedPartial[] {
  const steps = groupPartials(fragments);
  for (;;) { const step = steps.next(); if (step.done) return step.value; }
}

export async function projectPartialsAsync(fragments: PartialFragment[]): Promise<UnfinishedPartial[]> {
  const steps = groupPartials(fragments);
  let count = 0;
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
    if (++count % 1000 === 0) await setImmediate();
  }
}
