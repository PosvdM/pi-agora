export interface LaunchSpec {
  agoraSessionId: string;
  runId: string;
  instanceId: string;
  cwd: string;
  model: string;
  thinking: string;
  profile: "explore" | "review" | "implement";
  tools?: string[];
  skillPaths?: string[];
  sessionFile: string;
  env: Record<string, string>;
}

export interface ResolvedSkill { name: string; path: string }

/** 按单次请求计量；调用方按 runId 与 requestId 去重。 */
export interface UsageRecordEvent extends Record<string, unknown> {
  type: "usage_record";
  requestId: string;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  contextTokens: number;
}
export interface QuotaExhaustedEvent extends Record<string, unknown> {
  type: "quota_exhausted";
  resumeAt: string | null;
  reason: string;
}
export type HarnessDerivedEvent = UsageRecordEvent | QuotaExhaustedEvent;
