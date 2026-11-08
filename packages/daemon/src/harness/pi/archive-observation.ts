import { createHash } from "node:crypto";

import type { MessageObservation } from "../types.js";

/** 只统计 pi 实际发出的最终消息；重复事件与恢复后的同一消息只记一次。 */
export function observePiMessage(event: Record<string, unknown>): MessageObservation | undefined {
  if (event.type !== "message_end" || !event.message || typeof event.message !== "object" || Array.isArray(event.message)) return;
  const message = event.message as Record<string, unknown>;
  if (typeof message.role !== "string" || !message.role) return;
  return { signature: createHash("sha256").update(JSON.stringify(message)).digest("hex"), role: message.role, timestamp: message.timestamp };
}
