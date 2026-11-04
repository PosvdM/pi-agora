# 集成协议

> 状态：设计草案，P0 后冻结。**本文是 pi-agora 与 pi-pane 集成协议的唯一依据**，pi-pane 的文档链接到这里，不另行定义。改协议先改本文，再改两边代码。

本文包括：

1. daemon HTTP API 概要（agora 扩展、CLI、pane 插件共用）；
2. 会话流订阅；
3. pane 协议 v1 的数据类型：通用树节点、面板、动作、表单、通知；
4. agora 数据到 pane 协议的映射；
5. 离线存档读取；
6. 协议版本协商。

pi-pane 一侧如何加载插件、插件实现哪些方法、界面怎么渲染，见 pi-pane 仓库的 `docs/plugin-api.md`。

## 连接拓扑

```text
浏览器 ──WebSocket/HTTP──► pi-pane 服务端 ──► 主会话 pi --mode rpc ──► agora 扩展 ──┐
                              │                                                    │
                              └─ agora pane 插件（服务端，user 身份）──HTTP──► agora daemon ◄─┘
                                        │
                                        └─ daemon 不在线时：archive adapter 只读打开存档
```

- **浏览器只连 pi-pane**，不持有任何 daemon 凭证，daemon 也拒绝带 `Origin` 头的请求。
- pi-pane 托管的主会话里装着 agora 扩展，它和终端里的主代理一样，以 `agent:main` 身份连 daemon（见 [architecture.md](architecture.md#身份与鉴权)）。
- agora pane 插件（`packages/pane-plugin`）运行在 pi-pane 服务端进程里，读 `AGORA_HOME/secret/user.key` 以 `user` 身份连 daemon，把 daemon 的数据映射成 pane 协议的树节点、面板、动作和表单。
- 代码层面：pane 协议 v1 的 TypeScript 类型由 pi-pane 的插件 API 包导出，agora pane 插件把它作为 peer 依赖。类型必须与本文一致。

## daemon HTTP API 概要

### 约定

- 地址：`http://127.0.0.1:<port>/v1/...`，端口从 `AGORA_HOME/run/daemon.json` 读取。
- 鉴权：除 `GET /v1/health` 和 `/v1/auth/*` 外，所有请求带 `Authorization: Bearer <连接 token>`。身份只由 token 决定，请求体里的身份字段一律忽略。
- 协议版本：每个请求带 `Agora-Protocol: 1`，见“协议版本协商”。
- 请求和响应都是 JSON（UTF-8）。时间用 ISO 8601 UTC 字符串。
- 有副作用的 `POST` 支持 `Idempotency-Key` 头：同一 principal、同一 key 在 24 小时内重复提交，返回第一次的结果。
- 列表分页：`?limit=&cursor=`，响应 `{ "items": [...], "nextCursor": "..." }`。`limit` 默认 50，最大 200。
- 错误：

  ```json
  { "error": { "code": "lease_held", "message": "该主会话已由另一个连接控制", "details": { "principalId": "pr_1a2b" } } }
  ```

  | HTTP | code（示例） |
  | --- | --- |
  | 400 | `invalid_params`、`invalid_ref`、`duplicate_role`、`unanswered_objections` |
  | 401 | `unauthenticated`、`token_expired` |
  | 403 | `forbidden`（权限档位或角色不允许） |
  | 404 | `not_found` |
  | 409 | `lease_held`、`conflict`、`invalid_state`（如对已停止的任务 steer） |
  | 426 | `protocol_unsupported` |
  | 503 | `draining`（daemon 正在排空，拒绝新任务） |

### 端点

| 分组 | 方法与路径 | 用途 | 主要调用方 |
| --- | --- | --- | --- |
| 基础 | `GET /v1/health` | 版本、协议范围、instanceId；不需要鉴权，不返回其他信息 | 全部 |
| 鉴权 | `POST /v1/auth/challenge` | 双向握手第一步 | 主会话扩展、CLI、pane 插件 |
| | `POST /v1/auth/token` | 用户密钥证明换连接 token；`as: "user"` 或主会话注册/认领 | 同上 |
| | `POST /v1/auth/launch` | 协作会话用 launch ticket 换 token | 协作会话里的扩展 |
| | `POST /v1/auth/refresh` | 续期 token | 全部 |
| 主会话 | `POST /v1/principals/register` | 注册主会话 principal | 主会话扩展 |
| | `POST /v1/principals/reclaim` | 恢复后认领 principal | 主会话扩展 |
| | `POST /v1/lease/renew` | 续控制租约（每 30 秒） | 主会话扩展 |
| | `POST /v1/principals/:id/takeover` | 强制转移租约 | CLI（user） |
| 任务 | `POST /v1/tasks` | spawn | 主会话扩展、CLI、pane 插件 |
| | `GET /v1/tasks`、`GET /v1/tasks/:id` | 列表、详情（含各代结果） | 同上 |
| | `POST /v1/tasks/:id/steer`、`/stop`、`/cleanup`、`/recover` | 返工、停止、清理 worktree、中断后的处理（resume / reopen / replace / abandon） | 同上 |
| 提问 | `POST /v1/requests` | 提问 | 协作会话扩展 |
| | `GET /v1/requests` | 按状态和接收方查询；`?for=me` | 全部 |
| | `POST /v1/requests/:id/answer`、`/escalate`、`/cancel` | 答复、转给用户、取消 | 召集人、user |
| board | `GET /v1/boards/:id`、`GET /v1/boards/:id/entries?afterSeq=` | 元数据、公开条目 | 成员、user |
| | `POST /v1/boards/:id/entries` | 发条目（`sealed` 仅会议密封阶段） | 成员、召集人、user |
| | `POST /v1/boards` | 新建独立 board（非会议） | 主会话扩展、user |
| 会议 | `POST /v1/meetings` | 召集 | 主会话扩展、CLI、pane 插件 |
| | `GET /v1/meetings/:id` | 状态、阶段、修订、认可、用量 | 召集人、user |
| | `POST /v1/meetings/:id/interject`、`/decide`、`/stop` | 插话、回应决策请求、结束 | 召集人、user |
| | `POST /v1/meetings/:id/endorse` | 认可修订 | 参会者扩展 |
| 会话 | `GET /v1/sessions` | 协作会话列表及关系（召集人、任务、会议、继承） | CLI、pane 插件 |
| | `GET /v1/sessions/:id` | 会话详情 | 同上 |
| | `GET /v1/sessions/:id/messages?cursor=` | 已落盘的最终消息（读 pi JSONL）+ 未完成流片段 | 同上 |
| | `GET /v1/sessions/:id/stream?afterSeq=` | 实时事件流（SSE），见下节 | 同上 |
| | `GET /v1/sessions/:id/diagnostics` | 各次 run 的退出诊断 | 同上 |
| 收件箱 | `GET /v1/inbox?after=&wait=25` | 长轮询通知（outbox 中发给当前 principal 的条目） | 全部扩展、pane 插件 |
| | `POST /v1/inbox/ack` | 确认已注入会话或已展示 | 同上 |
| 变更流 | `GET /v1/changes?afterSeq=` | 领域对象变更的 SSE（任务、会话、会议、提问、board 头序号） | pane 插件 |
| 管理 | `POST /v1/admin/shutdown` | 排空或强制关闭 | CLI（user） |

请求和响应的完整字段在 `packages/protocol` 里以 TypeScript 类型和 JSON schema 给出；工具参数与 [tasks.md](tasks.md)、[board.md](board.md)、[meetings.md](meetings.md) 中的定义一一对应。

## 会话流订阅

### daemon 一侧

`GET /v1/sessions/:id/stream?afterSeq=<n>`，`Content-Type: text/event-stream`。每个事件：

```text
id: 1842
event: session
data: {"seq":1842,"sessionRef":{"source":"agora","id":"as_c21e"},"event":{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"好"}}}
```

- `event` 字段原样转发 pi RPC 的会话事件（格式见 pi `docs/json.md`）。`message_update` 只带增量，不带累计快照，流量与输出长度成线性关系。
- `seq` 是 daemon 给该会话分配的递增序号（跨 run 连续）。daemon 在内存里保留每个会话最近 2000 个事件。
- 重连：带 `afterSeq` 或 `Last-Event-ID`。请求的序号已经不在缓冲区内时，daemon 先发 `event: resync`，客户端应重新取快照。
- daemon 额外发的事件类型：`agora_status`（会话状态变化，`{ status, statusDetail }`）、`agora_run`（进程拉起或退出，`{ runId, phase: "started" | "exited", reason? }`）、`resync`。

### 快照

`GET /v1/sessions/:id/messages` 返回：

```json
{
  "items": [ { "role": "user", "content": "…" }, { "role": "assistant", "content": [ "…" ] } ],
  "nextCursor": null,
  "inFlight": { "contentIndex": 0, "text": "正在生成的部分……" },
  "unfinishedPartials": [ { "runId": "pr_51d0", "text": "中断时正在生成的内容……" } ],
  "streamSeq": 1842,
  "status": "running"
}
```

客户端流程：取快照 → 用返回的 `streamSeq` 作为 `afterSeq` 订阅 → 收到 `message_end` 时用完整消息替换本地拼接的增量。

### pane 一侧

pane 插件把 daemon 的流转成 pane 协议的会话流：

```ts
// pane 协议 v1，草案，P0 后冻结
interface SessionRef { source: string; id: string }

interface SessionSnapshot {
  ref: SessionRef;
  messages: unknown[];            // pi AgentMessage，按 pi docs/message-types.md 渲染
  inFlight?: { contentIndex: number; text: string };
  unfinishedPartials?: { runId: string; text: string }[];
  seq: number;
  status: NodeStatus;
  readonly: boolean;              // true：只能看，不能发消息
}

interface SessionStreamEvent {
  seq: number;
  ref: SessionRef;
  event: { type: string; [k: string]: unknown }; // pi 会话事件，或 pane_status / resync
}
```

pi-pane 对自己托管的主会话也产生同样形状的快照和事件，所以主会话、子代理、参会者、书记都用同一套聊天组件渲染。

## pane 协议 v1：通用树节点

侧栏的会话树由节点组成。节点不一定是会话：会议是分组节点，board 是资源节点。

```ts
// pane 协议 v1，草案，P0 后冻结
interface TreeNode {
  id: string;                  // 带来源前缀的全局唯一 id，如 "agora:session:as_c21e"
  source: string;              // 提供该节点的插件 id，如 "agora"；pi-pane 自己的节点为 "pane"
  kind: "session" | "group" | "resource";
  parentId: string | null;     // 可以指向其他来源的节点，如 "pane:session:<piSessionId>"
  title: string;
  badge?: string;              // 类型标签，如 "子代理"、"参会"、"书记"、"会议"、"board"
  sessionRef?: SessionRef;     // kind = session 时必填
  resourceRef?: { source: string; type: string; id: string }; // kind = resource 时必填
  status: NodeStatus;
  availability: "online" | "archived" | "missing";
  messageCount?: number;       // 最终消息数，不计流片段；未知时省略
  sortKey: string;             // 同一父节点下按字典序升序排列
  revision: number;            // 节点内容每变化一次 +1
  capabilities: string[];      // 见下表
}

type NodeStatus =
  | "idle" | "running" | "waiting" | "paused"
  | "done" | "failed" | "stopped" | "interrupted";
```

字段规则：

- `availability`：`online` 表示可以订阅实时流；`archived` 表示只能读存档（会话已结束，或 daemon 不在线）；`missing` 表示存档文件不存在。**daemon 不在线不等于任务失败**，此时节点保留原 `status`，`availability` 为 `archived`。
- `parentId` 指向的节点不存在（如召集人是另一个项目的终端会话）时，pi-pane 把节点放到“未归属”分组下，不丢弃。
- pi-pane 检测循环引用，出现循环时把形成循环的节点挂到“未归属”分组并记录警告。
- 挂在树下不代表有读取权限：点开节点时 pi-pane 仍通过插件请求内容，由插件和 daemon 判断权限。
- `capabilities` 的取值：

  | 值 | 含义 |
  | --- | --- |
  | `open` | 可以打开查看（快照） |
  | `subscribe` | 可以订阅实时流 |
  | `send` | 可以向该会话发消息（pi-pane 显示输入框） |
  | `abort` | 可以中止当前运行 |
  | `action:<actionId>` | 节点上可执行的插件动作，如 `action:agora.task.steer` |

### 同步

插件提供全量快照和增量变更：

```ts
interface TreeSnapshot { source: string; revision: number; nodes: TreeNode[] }

type TreeChange =
  | { type: "upsert"; node: TreeNode }    // 节点 revision 大于本地才替换
  | { type: "remove"; id: string }
  | { type: "reset" };                    // 本地丢弃该 source 的全部节点，重新取快照
```

`TreeSnapshot.revision` 是该来源的全局修订号，订阅增量时带上，插件无法从该修订号接续时发 `reset`。

## pane 协议 v1：面板

```ts
// pane 协议 v1，草案，P0 后冻结
interface PanelSpec {
  id: string;                          // "agora.pending"
  source: string;
  title: string;
  placement: "sidebar" | "node";       // sidebar：侧栏固定面板；node：打开某节点时显示
  nodeKinds?: TreeNode["kind"][];      // placement = node 时适用的节点类型
  badgeCount?: number;                 // 侧栏标题上的数字，如待处理数量
  revision: number;
}

type PanelContent =
  | { type: "markdown"; markdown: string }
  | { type: "keyValue"; rows: { key: string; value: string }[] }
  | { type: "table"; columns: { key: string; title: string }[]; rows: Record<string, string>[];
      rowActions?: string[] }          // 每行可用的 actionId，调用时 target 为行的 rowId 字段
  | { type: "list"; items: ListItem[] }
  | { type: "timeline"; items: TimelineItem[]; hasMoreBefore: boolean };

interface ListItem { id: string; title: string; subtitle?: string; badge?: string; nodeId?: string; actions?: string[] }

interface TimelineItem {               // board 条目等按序号排列的记录
  id: string;
  seq: number;
  badge: string;                       // 如 "proposal"
  author: string;
  markdown: string;
  refs?: { id: string; label: string }[];
  note?: string;                       // 如 "已被 be_91 合并"、"基于旧版本"
  time: string;
}
```

面板内容按需拉取，变化时插件推送新的 `revision`，pi-pane 再拉取。面板是声明式的，插件不能注入任意前端代码。

## pane 协议 v1：动作

```ts
// pane 协议 v1，草案，P0 后冻结
interface ActionSpec {
  id: string;                    // "agora.task.stop"
  source: string;
  title: string;                 // 按钮文字，如 "停止"
  scope: "node" | "panelRow" | "global";
  confirm?: string;              // 有值时先弹确认框，内容为该文字
  danger?: boolean;
  form?: FormSpec;               // 有值时先填表单，答案作为 input 传入
}

interface ActionInvocation {
  actionId: string;
  target?: string;               // 节点 id 或面板行 id
  input?: FormAnswers;
  idempotencyKey: string;        // pi-pane 生成，防止重复点击
}

interface ActionResult {
  ok: boolean;
  message?: string;              // 显示为通知
  followUpForm?: FormSpec;       // 需要进一步填写时
  openNodeId?: string;           // 执行后打开的节点
}
```

动作的业务处理在插件服务端完成，浏览器不直接改任何状态。

## 表单

多题表单，用于 agora 转给用户的提问、会议决策请求、召集会议等。题目格式和 [tasks.md](tasks.md#数据模型) 的 `RequestQuestion` 一致。

```ts
// pane 协议 v1，草案，P0 后冻结
interface FormSpec {
  id: string;                    // 对 agora 提问即 requestId
  source: string;
  title: string;
  description?: string;          // Markdown
  questions: FormQuestion[];     // 0–5 题
  fields?: FormField[];          // 自由填写的字段，如会议议题；与 questions 可同时存在
  submitLabel?: string;
  expiresAt?: string;
}

interface FormQuestion {
  id: string;
  question: string;              // Markdown
  header?: string;
  detail?: string;
  multiSelect?: boolean;
  options?: { label: string; description?: string; recommended?: boolean; preview?: string }[];
  allowCustom?: boolean;         // 默认 true：允许“其他”自由输入
  dependsOn?: { questionId: string; value?: string | string[] };
}

interface FormField {
  id: string;
  label: string;
  type: "text" | "textarea" | "number" | "select" | "checkbox";
  required?: boolean;
  options?: string[];            // type = select
  default?: string;
}

interface FormAnswers {
  answers: { id: string; selected: string[]; custom?: string }[];
  fields?: Record<string, string>;
}

type FormOutcome =
  | { status: "submitted"; values: FormAnswers }
  | { status: "cancelled" }
  | { status: "expired" };
```

- 取消和过期是明确的结果，插件不得把它们当作同意。
- 表单可以持久：用户关闭浏览器后再打开，插件仍会在“待处理”里列出未答的表单。

## pane 协议 v1：通知

```ts
// pane 协议 v1，草案，P0 后冻结
interface PaneNotification {
  id: string;                    // 去重用，同 id 只显示一次
  source: string;
  level: "info" | "warning" | "error";
  title: string;
  body?: string;                 // Markdown
  nodeId?: string;               // 点击后打开的节点
  actions?: string[];            // 通知上的动作按钮
  sticky?: boolean;              // true：需要用户手动关闭
}
```

## agora 的映射

### 树

```text
pane:session:<piSessionId>                     主对话（pi-pane 自己的节点）
 ├─ agora:session:<as_id>        〔子代理〕     任务会话
 └─ agora:meeting:<mt_id>        〔会议〕       分组节点
     ├─ agora:session:<as_id>    〔参会〕
     ├─ agora:session:<as_id>    〔参会〕
     ├─ agora:session:<as_id>    〔书记〕
     └─ agora:board:<bd_id>      〔board〕     资源节点
agora:root:user-meetings         〔用户会议〕   用户召开的会议挂在这里
agora:root:user-tasks            〔用户任务〕   用户通过 CLI 或 pi-pane 直接派的任务
```

| 节点 | kind | parentId | title | badge |
| --- | --- | --- | --- | --- |
| 任务会话 | session | `pane:session:<召集人的 piSessionId>`；召集人是 user 时为 `agora:root:user-tasks` | 任务标题 | `子代理` |
| 会议 | group | 召集人主会话；召集人是 user 时为 `agora:root:user-meetings` | 议题 | `会议` |
| 参会者 | session | 会议节点 | `<seat 名>（<模型简称>，<角色>）` | `参会` |
| 书记 | session | 会议节点 | `书记（<模型简称>）` | `书记` |
| board | resource | 会议节点；独立 board 挂召集人 | board 标题 | `board` |
| 继承出的新会话 | session | 与原会话相同 | 原标题 + `（重开 #n）` 或 `（换人）` | 同原会话 |

召集人主会话不在 pi-pane 的会话列表里（如另一个项目的终端会话）时，节点按协议规则进入 pi-pane 的“未归属”分组。

`sortKey` 用创建时间的 ISO 字符串，同一会议内参会者按席位顺序、书记最后、board 置底。

状态映射：

| agora 状态 | NodeStatus |
| --- | --- |
| created、running | `running` |
| waiting_decision | `waiting` |
| completed | `done` |
| failed | `failed` |
| stopped | `stopped` |
| interrupted | `interrupted` |
| 会议 paused | `paused` |
| 会话被回收、任务未结束 | 保持任务状态；`availability` 仍为 `online` |

capabilities：

| 节点 | daemon 在线 | daemon 不在线 |
| --- | --- | --- |
| 运行中的任务 | `open`、`subscribe`、`action:agora.task.steer`、`action:agora.task.stop` | `open` |
| 已完成的任务 | `open`、`action:agora.task.steer`（返工）、`action:agora.task.cleanup` | `open` |
| 中断的任务 | `open`、`action:agora.task.recover` | `open` |
| 参会者、书记 | `open`、`subscribe` | `open` |
| 会议 | `action:agora.meeting.interject`、`action:agora.meeting.decide`、`action:agora.meeting.stop` | 无 |
| board | `open` | `open` |

协作会话节点不带 `send`：用户对子代理说话一律通过 steer 动作，保证有记录、有代数。

### 面板

| 面板 id | placement | 内容 |
| --- | --- | --- |
| `agora.pending` | sidebar | “待处理”：转给用户的提问、召集人不可达时的决策请求、中断的任务，`list` 类型，每项带动作；`badgeCount` 为未处理数量 |
| `agora.task` | node（任务会话） | 任务信息 `keyValue`：模型、档位、代数、worktree、用量，以及各代结果 |
| `agora.meeting` | node（会议） | 阶段、修订号、认可情况、用量与上限、暂停原因 |
| `agora.board` | node（board） | `timeline`，按 seq 显示公开条目，附替代和“基于旧版本”标注 |

### 动作

| actionId | scope | 表单 | 调用的 daemon 端点 |
| --- | --- | --- | --- |
| `agora.task.spawn` | global | 模型、档位、隔离方式、任务书 | `POST /v1/tasks` |
| `agora.task.steer` | node | textarea 字段 `message`，checkbox `interrupt` | `POST /v1/tasks/:id/steer` |
| `agora.task.stop` | node | 无，`confirm` | `POST /v1/tasks/:id/stop` |
| `agora.task.cleanup` | node | checkbox `discard` | `POST /v1/tasks/:id/cleanup` |
| `agora.task.recover` | node、panelRow | 单选 resume / reopen / replace / abandon | `POST /v1/tasks/:id/recover` |
| `agora.request.answer` | panelRow | 由提问本身的题目生成 | `POST /v1/requests/:id/answer` |
| `agora.meeting.convene` | global | 议题、交付物、brief、参会者、合并人 | `POST /v1/meetings` |
| `agora.meeting.interject` | node | kind 单选 + 正文 | `POST /v1/meetings/:id/interject` |
| `agora.meeting.decide` | node、panelRow | 由决策请求生成 | `POST /v1/meetings/:id/decide` |
| `agora.meeting.stop` | node | 无，`confirm` | `POST /v1/meetings/:id/stop` |

### 通知

pane 插件以 user 身份长轮询 `/v1/inbox`，把发给 user 的通知（转交的提问、中断、会议决策请求、存档校验异常）转成 `PaneNotification`，展示后 ack。发给 Agent 召集人的通知由主会话里的 agora 扩展处理，pane 插件不重复展示，只在对应节点上更新状态。

## 离线存档读取

daemon 不在线时（`/v1/health` 连接失败），pane 插件改用 archive adapter（见 [archive.md](archive.md#只读-archive-adapter)）：

- 树：`listSessions` 和 `getMeeting` 构造节点，`availability` 全部为 `archived`（文件缺失的为 `missing`），`capabilities` 只有 `open`。
- 会话内容：`readMessages` + `readPartials` 构造 `SessionSnapshot`，`readonly: true`。
- board：`listBoardEntries` 构造 `timeline`。
- “待处理”面板显示“agora 未运行”，不提供动作。
- 每 15 秒重试 `/v1/health`，daemon 恢复后发 `reset` 并切回在线模式。

pane 插件不直接读 SQLite 表，不解析 `AGORA_HOME` 下的文件布局，全部通过 adapter。

## 协议版本协商

三处版本独立演进：

| 层 | 标识 | 当前 |
| --- | --- | --- |
| daemon HTTP API | `Agora-Protocol` 请求头；`/v1/health` 返回 `protocol: { min, max }` | 1 |
| pane 协议 | 插件声明 `paneProtocol: [min, max]`；pi-pane 声明自己支持的范围 | 1 |
| archive adapter | `openArchive({ apiVersion })` | 1 |

daemon HTTP API：

```json
GET /v1/health
{ "daemonVersion": "0.1.0", "instanceId": "in_5f2c", "protocol": { "min": 1, "max": 1 } }
```

- 客户端选双方区间交集中的最大值，写进之后每个请求的 `Agora-Protocol` 头。
- 没有交集：daemon 返回 `426 protocol_unsupported`，`details` 里带 daemon 的区间；主会话扩展提示用户升级哪一方，CLI 提示运行 `agora shutdown` 后用新版本启动。
- 增加可选字段、增加端点不升版本；删除或改变字段语义才升版本。daemon 至少同时支持当前和上一个版本。

pane 协议：

- 插件在注册时声明 `paneProtocol`；pi-pane 不支持时拒绝加载该插件，并在设置页显示原因。
- 新增可选字段不升版本；pi-pane 忽略不认识的字段和 `capabilities` 值；不认识的 `PanelContent.type` 显示为“此面板需要更新的 pi-pane”。
