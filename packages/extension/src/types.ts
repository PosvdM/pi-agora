export interface SessionEntry {
  id: string;
  type: string;
  customType?: string;
  data?: unknown;
  details?: Record<string, unknown>;
}
export interface SessionContext {
  cwd: string;
  model?: { provider: string; id: string };
  hasUI?: boolean;
  ui?: { notify(message: string, level: 'info' | 'warning' | 'error'): void };
  sessionManager: {
    getSessionId(): string;
    getSessionFile(): string | undefined;
    getEntries(): SessionEntry[];
    getBranch(): SessionEntry[];
  };
  shutdown(): void;
}
export interface ToolCall { toolName: string; input: Record<string, unknown> }
export interface ToolResult { content: { type: 'text'; text: string }[]; details: unknown }
export interface PiExtensionApi {
  on(event: string, handler: (event: any, context: SessionContext) => unknown): unknown;
  registerTool(tool: {
    name: string; label: string; description: string; parameters: object;
    executionMode?: 'sequential';
    execute(id: string, params: any, signal: AbortSignal | undefined, update: unknown, context: SessionContext): Promise<ToolResult>;
  }): void;
  appendEntry(customType: string, data: unknown): void;
  sendMessage(message: { customType: string; content: string; display: boolean; details: Record<string, unknown> },
    options: { triggerTurn: boolean; deliverAs: 'followUp' }): void;
  getActiveTools(): string[];
  getThinkingLevel(): string;
}
export interface ChildPolicy {
  profile: 'explore';
  allowedRoots: string[];
  protectedPaths: string[];
  tools: string[];
  model: string;
  thinking: string;
  extensionVersion: string;
}
export interface LaunchIdentity { runId: string; principalId: string; policy: ChildPolicy }
