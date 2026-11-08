// 草案，P0 后冻结
export interface PanePlugin {
  id: string;                         // 即 TreeNode.source，如 "agora"；"pane" 保留给 pi-pane 自己
  paneProtocol: [number, number];
  activate(ctx: PaneHostContext): Promise<void>;
  deactivate?(): Promise<void>;

  tree?: {
    snapshot(req: TreeSnapshotRequest): Promise<TreeSnapshot>;
    children(parentId: string, page: { epoch: string; cursor?: string; limit: number }): Promise<TreeChildrenPage>;
    subscribe(from: TreeCursor, emit: (c: TreeChange) => void): () => void;
  };
  sessions?: {
    snapshot(ref: SessionRef): Promise<SessionSnapshot>;
    history(ref: SessionRef, page: { before: string; limit: number }): Promise<HistoryPage>;
    subscribe(ref: SessionRef, after: StreamCursor, emit: (e: SessionStreamEvent) => void): () => void;
    send?(ref: SessionRef, input: SessionInput, req: SessionSendRequest): Promise<SendResult>;
    abort?(ref: SessionRef, req: SessionAbortRequest): Promise<AbortResult>;
  };
  panels?: {
    list(): PanelSpec[];
    content(panelId: string, nodeId?: string): Promise<PanelContent>;
  };
  actions?: {
    list(): ActionSpec[];                                          // 静态目录
    resolveForm?(actionId: string, target?: ActionTarget): Promise<FormSpec | null>;
    invoke(inv: ActionInvocation, origin: RequestOrigin): Promise<ActionResult>;
  };
  forms?: {
    pending(): Promise<FormSpec[]>;   // 仍待用户处理的持久表单
    submit(req: FormSubmission, origin: RequestOrigin): Promise<FormSubmitResult>;
  };
  renderers?: {
    customMessages?: CustomMessageRenderer[];
  };
}

export type PanePluginFactory = () => PanePlugin;
export type BridgeFormOutcome = FormOutcome | { status: "expired" } | { status: "aborted" };

// 草案，P0 后冻结
export interface PaneHostContext {
  readonly paneProtocol: number;              // 协商后的版本
  readonly dataDir: string;                   // 插件专用目录：~/.pi/pane/plugins/<id>/，仅当前用户可访问
  readonly log: { info(...a: unknown[]): void; warn(...a: unknown[]): void; error(...a: unknown[]): void };
  notify(n: PaneNotification): void;
  panelChanged(update: PanelUpdate): void;
  formAdded(form: FormSpec): void;            // 新的持久表单，或同一 id 的更高 revision
  formRemoved(formId: string, reason: FormRemovedReason): void;
  setBanner(banner: PaneBanner): void;        // 新增或替换同 id 的横幅，见“横幅”
  clearBanner(id: string): void;
  listBanners(): PaneBanner[];               // 本插件当前的横幅
  mainSessions: MainSessionsApi;
  userPresence: UserPresenceApi;
}

export interface MainSessionsApi {
  list(): MainSessionInfo[];                  // 当前托管中（有 pi 进程）的主会话
  get(piSessionId: string): MainSessionInfo | undefined;   // 任何在 pi 会话存储里列得出的主会话
  onChange(listener: () => void): () => void;
  hold(ref: SessionRef, reason: string): () => void;       // 返回 release()
}

export interface MainSessionInfo {
  ref: SessionRef;                            // { source: "pane", id: <piSessionId> }
  nodeId: string;                             // "pane:session:<piSessionId>"
  cwd: string;
  sessionFile: string;
  title: string;
  hosted: boolean;                            // 是否有 pi 进程
  status: NodeStatus;
}

// 草案，P0 后冻结
/** 由 pi-pane 服务端填写，插件不能伪造；用于审计和把确认请求路由回发起的标签页 */
export interface RequestOrigin {
  client: "browser";
  connectionId: string;  // 发起请求的浏览器标签页连接
  deviceId?: string;     // 该标签页登录时报告的设备密钥 id；只用于显示和路由，不是身份证明
  receivedAt: string;
}

// 草案，P0 后冻结
export interface UserPresenceApi {
  devices(): PresenceDevice[];                       // 当前已登录的浏览器设备
  onDevicesChange(listener: () => void): () => void;
  confirm(req: UserPresenceRequest): Promise<UserPresenceProof>;
}

export interface UserPresenceRequest {
  title: string;
  summary: string;              // Markdown，说明用户在确认什么
  payload: unknown;             // 要签名的 JSON 值，由插件定义
  origin?: RequestOrigin;       // 有值时优先在发起请求的标签页弹出
  timeoutMs?: number;           // 默认 120000，最长 600000
}

export interface UserPresenceProof {
  deviceId: string;
  publicKey: string;            // SPKI，base64url
  alg: "ECDSA-P256-SHA256";
  signature: string;            // base64url
}

export interface PresenceDevice {
  deviceId: string;
  publicKey: string;            // SPKI，base64url
  alg: "ECDSA-P256-SHA256";
  label: string;                // 用户在设置页起的名字，如“办公室 Chrome”
  connected: boolean;
}

/** confirm 失败时 reject 的错误 */
export interface UserPresenceError extends Error {
  code: "rejected" | "timeout" | "noDevice" | "unsupported";
}

// pane 协议 v1，草案，P0 后冻结
export interface SessionRef { source: string; id: string }   // 主会话：{ source: "pane", id: <piSessionId> }

export type NodeStatus =
  | "idle" | "running" | "waiting" | "paused"
  | "done" | "failed" | "stopped" | "interrupted";

/** 会话事件流的游标 */
export interface StreamCursor {
  epoch: string;   // 不透明字符串；事件流无法保证连续时更换
  seq: number;     // 同一 epoch 内从 1 递增；0 表示该 epoch 还没有事件
}

// pane 协议 v1，草案，P0 后冻结
export interface TreeNode {
  id: string;                  // 全局唯一，约定以来源为前缀，如 "agora:session:as_c21e"
  source: string;              // 提供该节点的插件 id；pi-pane 自己的节点为 "pane"
  kind: "session" | "group" | "resource";
  parentId: string | null;     // 可以指向其他来源的节点，如 "pane:session:<piSessionId>"
  title: string;
  badge?: string;              // 类型标签，如 "子代理"、"参会"、"书记"
  sessionRef?: SessionRef;     // kind = session 时必填
  resourceRef?: { source: string; type: string; id: string }; // kind = resource 时必填
  status: NodeStatus;
  statusDetail?: string;       // 状态说明，如 "排队中：第 2 位"
  availability: "online" | "archived" | "missing";
  hasChildren: boolean;
  childCount?: number;         // 已知时填写
  lastActivityAt?: string;     // 用于判断“最近”
  messageCount?: number;       // 最终消息数，不计流片段；未知时省略
  sortKey: string;             // 同一父节点下按字典序升序排列
  revision: number;            // 最后一次修改该节点时的来源级 revision
  capabilities: string[];      // 见下表
  composer?: { actionId: string; placeholder?: string; images?: boolean };  // 见“向会话发消息”
  originToolCall?: { sessionRef: SessionRef; toolCallId: string };         // 见“工具卡片链接”
}

// pane 协议 v1，草案，P0 后冻结
export interface TreeSnapshotRequest {
  openNodeIds: string[];
  recentSince: string;         // 默认 7 天前
}

export interface TreeSnapshot {
  source: string;
  epoch: string;               // 修订号序列的标识；插件重建修订号序列时更换
  revision: number;            // 快照对应的来源级修订号
  nodes: TreeNode[];
}

export interface TreeCursor {
  epoch: string;
  revision: number;
}

export type TreeChildrenPage =
  | { epoch: string;           // 必须等于请求里的 epoch
      revision: number;        // 这一页对应的来源级修订号
      nodes: TreeNode[];
      nextCursor?: string }
  | { reset: true; epoch: string };   // 请求的 epoch 已失效

// pane 协议 v1，草案，P0 后冻结
export type TreeChange =
  | { type: "upsert"; revision: number; node: TreeNode }
  | { type: "remove"; revision: number; id: string }      // tombstone
  | { type: "reset"; epoch: string };                     // 丢弃该来源的全部节点，重新取快照

// pane 协议 v1，草案，P0 后冻结
export interface SessionSnapshot {
  ref: SessionRef;
  cursor: StreamCursor;           // 快照对应的切点
  leafId: string | null;          // 当前活动分支的叶子条目
  entries: unknown[];             // ② 的最后一页：pi SessionEntry，按分支顺序（旧在前）
  historyBefore: string | null;   // 历史水位：更早的条目从这个条目的父条目开始取；null 表示已到开头
  inFlight?: InFlightState;
  unfinishedPartials?: UnfinishedPartial[];
  status: NodeStatus;
  controlRevision?: number;       // 控制状态的 revision，见“向会话发消息与停止”
  readonly: boolean;              // true：只能看，不能发消息
  readonlyReason?: "archived" | "externalWriter" | "noPermission";
}

export interface HistoryPage {
  entries: unknown[];             // historyBefore 之前的条目，按分支顺序（旧在前）
  historyBefore: string | null;
}

/** 进行中的状态：完整的进行中助手消息 + 工具执行 + 队列 */
export interface InFlightState {
  phase: "idle" | "streaming" | "tools" | "compacting" | "retrying" | "waitingUi" | "stopping";
  assistant?: {
    startedAt: number;
    blocks: InFlightBlock[];      // 按 contentIndex 排列
    usage?: unknown;              // 最近一次 message_update 的 usage
  };
  completed?: unknown[];          // 已收到 message_end、还没有对应条目的消息
  tools: {
    toolCallId: string;
    toolName: string;
    args: unknown;
    partialResult?: unknown;      // 最近一次 tool_execution_update
    startedAt: number;
  }[];
  queue: { steering: string[]; followUp: string[] };   // 最近一次 queue_update
  retry?: { attempt: number; maxAttempts: number; delayMs: number; errorMessage: string };
}

export type InFlightBlock =
  | { type: "text"; contentIndex: number; text: string; done: boolean }
  | { type: "thinking"; contentIndex: number; text: string; done: boolean }
  | { type: "toolCall"; contentIndex: number; id: string; toolName: string;
      argsText: string;           // 已收到的参数片段（toolcall_delta 拼接）
      args?: unknown;             // toolcall_end 后的完整参数
      done: boolean };

/** 进程中断时没写完的内容，块类型与 InFlightBlock 相同 */
export interface UnfinishedPartial { runId: string; at: string; blocks: InFlightBlock[] }

// pane 协议 v1，草案，P0 后冻结
export interface SessionStreamEvent {
  ref: SessionRef;
  cursor: StreamCursor;
  event: { type: string; [k: string]: unknown };
}

// pane_status 事件，草案，P0 后冻结
export interface PaneStatusEvent {
  type: "pane_status";
  status: NodeStatus;
  phase: InFlightState["phase"];
  controlRevision?: number;                      // 控制状态变化后的新值
  detail?: string;                               // 显示在会话视图底部
  holds?: { source: string; reason: string }[];  // 主会话的保活原因
  readonly?: boolean;
}

// pane 协议 v1，草案，P0 后冻结
export interface SessionInput {
  text: string;
  images?: { mimeType: string; data: string }[];   // base64，按出现顺序
  delivery?: "steer" | "followUp";                 // 会话运行中时由用户选择
}

export type SendResult =
  | { status: "accepted" }
  | { status: "pending" }                                    // 已受理、仍在处理
  | { status: "rejected"; message: string }
  | { status: "conflict"; controlRevision: number; message?: string }  // expectedRevision 不符
  | { status: "idempotencyConflict"; message: string };      // 同一 key、不同内容

export type AbortResult =
  | { status: "done"; clearedText?: string[] }   // clearQueue 为 true 时清出的待发文本，按原顺序
  | { status: "nothingToStop" }
  | { status: "conflict"; controlRevision: number };

// pane 协议 v1，草案，P0 后冻结
export interface SessionSendRequest { idempotencyKey: string; origin: RequestOrigin; expectedRevision?: number }
export interface SessionAbortRequest { clearQueue: boolean; origin: RequestOrigin; expectedRevision?: number }

// pane 协议 v1，草案，P0 后冻结
export interface CustomMessageRenderer {
  customType: string;              // 完全匹配，约定以插件 id 为前缀，如 "agora:notice"
  label: string;                   // 卡片标题
  collapsed?: boolean;             // 默认 true
  body?: "content" | "none";       // content：把消息的文字内容按 Markdown 渲染；默认 content
  fields?: { path: string; label: string }[];   // 从 details 中按点分路径取值，显示为键值行
  nodeIdPath?: string;             // details 中节点 id 的路径；有值时卡片可点击打开该节点
}

// pane 协议 v1，草案，P0 后冻结
export interface PanelSpec {
  id: string;                          // 建议以插件 id 为前缀，如 "agora.board"
  source: string;
  title: string;
  placement: "sidebar" | "node";       // sidebar：侧栏固定面板；node：打开节点时显示
  appliesTo?: {                        // placement = node 时的适用条件；各项同时满足，项内任一匹配
    kinds?: TreeNode["kind"][];
    sources?: string[];                // TreeNode.source
    resourceTypes?: string[];          // TreeNode.resourceRef.type
  };
  badgeCount?: number;                 // 侧栏标题上的数字（初始值）
  revision: number;
}

export interface PanelUpdate {
  panelId: string;
  revision: number;
  nodeId?: string;                     // 只有该节点的内容变了；省略表示全部
  badgeCount?: number | null;          // 有值时更新角标；null 清除
}

export type PanelContent =
  | { type: "markdown"; markdown: string }
  | { type: "keyValue"; rows: { key: string; value: string }[] }
  | { type: "table"; columns: { key: string; title: string }[]; rows: TableRow[] }
  | { type: "list"; items: ListItem[] }
  | { type: "timeline"; items: TimelineItem[]; hasMoreBefore: boolean }
  | { type: "steps"; title?: string; steps: StepItem[]; progress?: { current: number; total: number } };

export interface TableRow {
  rowId: string;                       // 面板内唯一；调用行动作时作为 target.rowId
  cells: Record<string, string>;       // 按 columns[].key 取值
  actions?: string[];                  // 该行可用的 actionId
  nodeId?: string;                     // 该行对应的节点；有值时行可点击打开
}

export interface ListItem { id: string; title: string; subtitle?: string; badge?: string; nodeId?: string; actions?: string[] }

export interface TimelineItem {        // 按序号排列的记录，如共享讨论板
  id: string;
  seq: number;
  badge: string;
  author: string;
  markdown: string;
  refs?: { id: string; label: string }[];
  note?: string;                       // 附注，如 "已被合并"、"基于旧版本"
  time: string;
}

export interface StepItem {            // 有先后顺序的阶段，如会议进度
  id: string;
  title: string;
  status: "pending" | "active" | "done" | "failed" | "skipped";
  detail?: string;                     // Markdown
  nodeId?: string;
  time?: string;
}

// pane 协议 v1，草案，P0 后冻结
export interface ActionSpec {
  id: string;                    // 建议以插件 id 为前缀，如 "agora.task.stop"
  source: string;
  title: string;                 // 按钮文字
  scope: ("node" | "panelRow" | "global")[];
  confirm?: string;              // 有值时先弹确认框
  danger?: boolean;
  hasForm?: boolean;             // true：点击时调用 resolveForm 取表单
  timeoutMs?: number;            // invoke 的超时，默认 10000，最长 60000
}

export type ActionTarget =
  | { type: "node"; nodeId: string }
  | { type: "panelRow"; panelId: string; rowId: string; nodeId?: string }
  | { type: "global" };

export interface ActionInvocation {
  actionId: string;
  target?: ActionTarget;
  input?: FormAnswers;
  formId?: string;               // input 对应的表单 id
  formRevision?: number;
  idempotencyKey: string;        // pi-pane 生成，见下
}

export type ActionResult =
  | { status: "ok"; message?: string; openNodeId?: string }
  | { status: "failed"; message: string }
  | { status: "pending"; message?: string }          // 已受理、仍在处理；之后用同一 key 查询
  | { status: "needsInput"; followUpForm: FormSpec } // 需要进一步填写
  | { status: "idempotencyConflict"; message: string }; // 同一 key、不同内容

// pane 协议 v1，草案，P0 后冻结
export interface FormSpec {
  id: string;
  source: string;
  revision: number;              // 表单内容每变化一次 +1
  title: string;
  description?: string;          // Markdown
  questions?: FormQuestion[];    // 0–5 道选择题
  fields?: FormField[];          // 自由填写的字段；与 questions 可同时存在
  submitLabel?: string;
  cancel?: { label: string };    // 有值时显示业务“取消”按钮，例如“拒绝此请求”
  createdAt: string;             // ISO 时间；同一 id 的后续 revision 不变
  expiresAt?: string;            // 只用于显示倒计时；是否过期由插件裁定
  nodeId?: string;               // 关联的节点
}

export interface FormQuestion {
  id: string;
  question: string;              // Markdown
  header?: string;
  detail?: string;
  multiSelect?: boolean;
  options?: { label: string; description?: string; recommended?: boolean; preview?: string }[];
  allowCustom?: boolean;         // 默认 true：允许“其他”自由输入
  dependsOn?: { questionId: string; value?: string | string[] };  // 前一题答案匹配时才显示
}

export interface FormField {
  id: string;
  label: string;
  type: "text" | "textarea" | "number" | "select" | "checkbox" | "group";
  description?: string;
  required?: boolean;
  options?: string[];            // type = select
  default?: string;
  fields?: FormField[];          // type = group：每组包含的子字段
  min?: number;                  // type = group：最少组数，默认 0
  max?: number;                  // type = group：最多组数，默认 1；大于 1 时可重复添加
}

export type FieldValue = string | FieldGroupValue[];        // group 的值是每组一个对象
export interface FieldGroupValue { [fieldId: string]: FieldValue }

export interface FormAnswers {
  answers: { id: string; selected: string[]; custom?: string }[];
  fields?: Record<string, FieldValue>;   // checkbox 的值为 "true" / "false"
}

export type FormOutcome =
  | { status: "submitted"; values: FormAnswers }
  | { status: "cancelled"; reason?: string };   // 业务取消：用户点了 cancel 按钮

export interface FormSubmission {
  formId: string;
  revision: number;              // 用户看到的表单版本
  outcome: FormOutcome;
  idempotencyKey: string;
}

export type FormSubmitResult =
  | { status: "accepted"; message?: string }
  | { status: "pending"; message?: string }          // 已受理、仍在处理（如等待用户在场确认）
  | { status: "alreadyHandled"; message?: string }   // 已在别处处理
  | { status: "stale"; form: FormSpec }               // 表单已更新，请按新版本重填
  | { status: "failed"; message: string }
  | { status: "idempotencyConflict"; message: string };

export type FormRemovedReason = "handled" | "cancelled" | "expired" | "withdrawn";

// pane 协议 v1，草案，P0 后冻结
export interface PaneNotification {
  id: string;                    // 去重用，同 id 只显示一次
  source: string;
  level: "info" | "warning" | "error";
  title: string;
  body?: string;                 // Markdown
  nodeId?: string;               // 点击后打开的节点
  actions?: string[];            // 通知上的动作按钮（actionId）；target 为 nodeId 对应的节点
  sticky?: boolean;              // true：需要用户手动关闭
}

// pane 协议 v1，草案，P0 后冻结
export interface PaneBanner {
  id: string;                    // 在该插件内唯一；不同插件的同名 id 互不影响
  level: "info" | "warning" | "error";
  title: string;                 // 纯文本，紧凑样式下只显示这一行
  body?: string;                 // Markdown，展开后显示
  actions?: string[];            // actionId，调用时 target 为 { type: "global" }
  persistent?: boolean;          // true：pi-pane 落盘保存，重启和插件不可用时都保留，直到插件显式清除
}

/** 发给浏览器的横幅状态 */
export interface BannerState extends PaneBanner {
  source: string;                // 设置它的插件 id
  sourceUnavailable: boolean;    // 来源插件未加载、初始化失败、停用或卸载
}

export const PANE_PROTOCOL = 1;
export function negotiateProtocol(peer: readonly [number, number], supported: readonly [number, number] = [1, 1]): number {
  for (const range of [peer, supported]) {
    if (!Array.isArray(range) || range.length !== 2 || !Number.isSafeInteger(range[0]) || !Number.isSafeInteger(range[1]) || range[0] < 1 || range[0] > range[1]) throw new Error("协议版本范围无效");
  }
  const version = Math.min(peer[1], supported[1]);
  if (!Number.isSafeInteger(version) || version < Math.max(peer[0], supported[0])) throw new Error("pane 协议版本不兼容");
  return version;
}
export type DraftNode = { type: "text"; text: string } | { type: "image"; assetId: string };
