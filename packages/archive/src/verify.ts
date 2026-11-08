import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { ArchiveError, isMissing } from "./errors.js";
import type { VerificationResult, VerifyExpected } from "./types.js";

export async function verifySessionFile(file: string, expected: VerifyExpected = {}): Promise<VerificationResult> {
  if (expected.messageEndCount !== undefined &&
      (!Number.isSafeInteger(expected.messageEndCount) || expected.messageEndCount < 0)) {
    throw new ArchiveError("invalid_expected", "预期消息数必须为非负整数");
  }
  if (expected.previous && (!Number.isSafeInteger(expected.previous.bytes) ||
      expected.previous.bytes < 0 || !/^[a-f0-9]{64}$/i.test(expected.previous.hash))) {
    throw new ArchiveError("invalid_expected", "前次校验必须包含有效的字节数和 SHA-256");
  }
  try {
    if (!(await stat(file)).isFile()) throw new ArchiveError("invalid_file", "会话路径不是普通文件");
    const { parseSessionFile } = await import("@pi-agora/harness-pi");
    const parsed = await parseSessionFile(file);
    const diagnostics: unknown[] = [...parsed.diagnostics];
    const incomplete = (kind: string) => /truncat|incomplete|partial|unterminated|截断|不完整/i.test(kind);
    let suspect = parsed.status === "invalid" || parsed.diagnostics.some(d => !incomplete(d.kind));
    const partial = parsed.status === "empty" || !!expected.hasUnfinishedPartials ||
      parsed.diagnostics.some(d => incomplete(d.kind));
    if (parsed.status === "empty") diagnostics.push({ kind: "empty_session", message: "会话文件为空，尚无可读取条目" });
    let messageCount = 0;
    let foundLast = expected.lastMessage === undefined;
    for (let i = 0; i < parsed.entries.length; i++) {
      const entry = parsed.entries[i];
      if (entry.type === "message" && entry.message && typeof entry.message === "object") {
        messageCount++;
        const message = entry.message as Record<string, unknown>;
        if (expected.lastMessage && message.role === expected.lastMessage.role &&
            isDeepStrictEqual(message.timestamp, expected.lastMessage.timestamp)) foundLast = true;
      }
      if (i % 1000 === 999) await setImmediate();
    }
    const fail = (kind: string, message: string) => { suspect = true; diagnostics.push({ kind, message }); };
    if (expected.messageEndCount !== undefined && messageCount < expected.messageEndCount) {
      fail("message_count", "会话文件的消息数少于观察到的 message_end 次数");
    }
    if (!foundLast) fail("last_message", "会话文件缺少最后观察到的消息");
    if (expected.previous) {
      if (parsed.bytes < expected.previous.bytes) fail("prefix_changed", "会话文件短于前次校验基线");
      else {
        const hash = createHash("sha256");
        let bytes = 0;
        if (expected.previous.bytes > 0) {
          for await (const chunk of createReadStream(file, { start: 0, end: expected.previous.bytes - 1, highWaterMark: 64 * 1024 })) {
            hash.update(chunk);
            bytes += (chunk as Buffer).length;
            await setImmediate();
          }
        }
        if (bytes !== expected.previous.bytes || hash.digest("hex") !== expected.previous.hash.toLowerCase()) {
          fail("prefix_changed", "会话文件前缀与前次校验基线不符");
        }
      }
    }
    return { state: suspect ? "suspect" : partial ? "partial" : "ok",
      hash: parsed.hash, bytes: parsed.bytes, messageCount, diagnostics };
  } catch (error) {
    if (!isMissing(error)) throw error;
    return { state: "missing", hash: null, bytes: 0, messageCount: 0,
      diagnostics: [{ kind: "missing", message: "会话文件不存在" }] };
  }
}
