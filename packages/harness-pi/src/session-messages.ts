import type { SessionEntry, MessageIdentity, SessionMessageEvidence } from "@pi-agora/protocol";
export type { MessageIdentity, SessionMessageEvidence } from "@pi-agora/protocol";

/** 其余包把最终消息当作不透明内容，只通过适配器取得身份和条目关联。 */
export function messageIdentity(message: unknown): MessageIdentity | undefined {
  if (!message || typeof message !== "object" || Array.isArray(message)) return undefined;
  const value = message as Record<string, unknown>;
  return { role: value.role, timestamp: value.timestamp };
}

export function* sessionMessages(entries: SessionEntry[]): Generator<SessionMessageEvidence> {
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const identity = messageIdentity(entry.message);
    if (identity) yield { ...identity, entryId: entry.id, message: entry.message };
  }
}
