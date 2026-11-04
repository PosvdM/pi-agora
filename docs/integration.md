# 集成协议

> 状态：设计草案，P0 后冻结。

本文定义 pi-agora 自己对外的接口，以及 agora 如何接入 pi-pane：

1. daemon HTTP API 概要（agora 扩展、CLI、pane 插件共用）；
2. daemon 侧的会话流订阅；
3. agora 数据到 pane 协议的映射（树、面板、动作、通知）；
4. 离线存档读取；
5. 版本协商。

**权威归属**：

| 内容 | 以哪里为准 |
| --- | --- |
| pane 协议（`TreeNode`、`SessionSnapshot`、`SessionStreamEvent`、`PanelSpec`、`PanelContent`、`ActionSpec`、`FormSpec`、`PaneNotification` 等类型，渲染与同步规则，pane 协议版本） | pi-pane 仓库的 `docs/plugin-api.md` |
| daemon HTTP API、daemon 侧会话流、agora → pane 协议的映射、archive adapter | 本文及 pi-agora 的其他文档 |

本文用到 pane 协议的类型时只写类型名，不重复定义字段。

## 依赖方向

```text
packages/protocol ◄── daemon、extension、cli、archive、pane-plugin
packages/archive  ◄── cli、pane-plugin
@pi-pane/plugin-api（peer 依赖）◄── 只有 pane-plugin
```

- `daemon`、`extension`、`cli`、`archive`、`protocol` 都不依赖 pi-pane。不装 pi-pane 时 pi-agora 完整可用。
- 只有 `packages/pane-plugin` 把 `@pi-pane/plugin-api` 作为 peer 依赖，负责把 agora 的数据翻译成 pane 协议。pane 协议升级时只需改这个包。

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
- agora pane 插件运行在 pi-pane 服务端进程里，以 `user` 身份连 daemon。

## daemon HTTP API 概要

### 约定

- 地址：`http://127.0.0.1:<port>/v1/...`，端口从 `AGORA_HOME/run/daemon.json` 读取。
- 鉴权：除 `GET /v1/health` 和 `/v1/auth/*` 外，所有请求带 `Authorization: Bearer <连接 token>`。身份只由 token 决定，请求体里的身份字段一律忽略。
- 协议版本：每个请求带 `Agora-Protocol: 1`，见“版本协商”。
- 来源进程：以 user 身份执行操作时，pane 插件在请求头 `Agora-Origin-Pid` 里转交 pi-pane 测得的浏览器请求对端 PID（`RequestOrigin.peerPid`，见 pi-pane `docs/plugin-api.md`）。daemon 用它做来源检查和审计，见 [architecture.md](architecture.md#user-身份的来源检查与审计)。
- 请求和响应都是 JSON（UTF-8）。时间用 ISO 8601 UTC 字符串。
- 有副作用的 `POST` 支持 `Idempotency-Key` 头：同一 principal、同一 key 在 24 小时内重复提交，返回第一次的结果。
- 列表分页：`?limit=&cursor=`，响应 `{ "items": [...], "nextCursor": "..." }`。`limit` 默认 50，最大 200。
- 错误：

  ```json
  { "error": { "code": "lease_held", "message": "该主会话已由另一个连接控制", "details": { "principalId": "pr_1a2b" } } }
  ```

  | HTTP | code（示例） |
  | --- | --- |
  | 400 | `invalid_params`、`invalid_ref`、`duplicate_role`、`unanswered_objections`、`exceeds_concurrency` |
  | 401 | `unauthenticated`、`token_expired` |
  | 403 | `forbidden`（权限档位或角色不允许）、`origin_in_managed_tree`（来源进程属于 agora 管理的会话） |
  | 404 | `not_found` |
  | 409 | `lease_held`、`conflict`、`invalid_state`（如对已停止的任务 steer） |
  | 426 | `protocol_unsupported` |
  | 503 | `draining`（daemon 正在排空，拒绝新任务） |

### 端点

| 分组 | 方法与路径 | 用途 | 主要调用方 |
| --- | --- | --- | --- |
| 基础 | `GET /v1/health` | 版本、协议范围、instanceId；不需要鉴权，不返回其他信息 | 全部 |
| 鉴权 | `POST /v1/auth/challenge` | 双向握手第一步 | 主会话扩展、CLI、pane 插件 |
| | `POST /v1/auth/token` | 用户密钥证明换连接 token；`as: "user"` 或主会话注册/认领；带 `client: "cli" \| "pane" \| "extension"` | 同上 |
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
| | `POST /v1/requests/:id/answer`、`/escalate`、`/cancel` | 答复、转给用户、取消；响应和详情里带审计信息 | 召集人、user |
| board | `GET /v1/boards/:id`、`GET /v1/boards/:id/entries?afterSeq=` | 元数据、公开条目 | 成员、user |
| | `POST /v1/boards/:id/entries` | 发条目（`sealed` 仅会议密封阶段） | 成员、召集人、user |
| | `POST /v1/boards` | 新建独立 board（非会议） | 主会话扩展、user |
| 会议 | `POST /v1/meetings` | 召集；名额不足时返回 `queued` 和排队信息 | 主会话扩展、CLI、pane 插件 |
| | `GET /v1/meetings/:id` | 状态、阶段、修订、认可、用量、排队位置 | 召集人、user |
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
| 审计 | `GET /v1/audit?target=` | user 身份操作的审计记录 | CLI、pane 插件 |
| 管理 | `POST /v1/admin/shutdown` | 排空或强制关闭 | CLI（user） |

请求和响应的完整字段在 `packages/protocol` 里以 TypeScript 类型和 JSON schema 给出；工具参数与 [tasks.md](tasks.md)、[board.md](board.md)、[meetings.md](meetings.md) 中的定义一一对应。

## 会话流订阅

### 事件流

`GET /v1/sessions/:id/stream?afterSeq=<n>`，`Content-Type: text/event-stream`。每个事件：

```text
id: 1842
event: session
data: {"seq":1842,"sessionId":"as_c21e","event":{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"好"}}}
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

### 转成 pane 会话流

pane 插件把上面的快照和事件转成 pane 协议的 `SessionSnapshot` 和 `SessionStreamEvent`：

| daemon 字段 | pane 字段 |
| --- | --- |
| 会话 id `as_…` | `SessionRef { source: "agora", id: "as_…" }` |
| `items` | `messages` |
| `inFlight`、`unfinishedPartials` | 同名字段 |
| `streamSeq` | `seq` |
| `status`（agora 状态） | `status`（按下文“状态映射”转换） |
| — | `readonly: true`（协作会话一律只读，用户通过 steer 动作对它说话） |
| SSE 的 `seq`、`event` | `SessionStreamEvent.seq`、`.event`；`agora_status` 转为 `pane_status` |

## agora 到 pane 协议的映射

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

| 节点 | `kind` | `parentId` | `title` | `badge` |
| --- | --- | --- | --- | --- |
| 任务会话 | session | `pane:session:<召集人的 piSessionId>`；召集人是 user 时为 `agora:root:user-tasks` | 任务标题 | `子代理` |
| 会议 | group | 召集人主会话；召集人是 user 时为 `agora:root:user-meetings` | 议题 | `会议` |
| 参会者 | session | 会议节点 | `<seat 名>（<模型简称>，<角色>）` | `参会` |
| 书记 | session | 会议节点 | `书记（<模型简称>）` | `书记` |
| board | resource（`resourceRef.type = "board"`） | 会议节点；独立 board 挂召集人 | board 标题 | `board` |
| 继承出的新会话 | session | 与原会话相同 | 原标题 + `（重开 #n）` 或 `（换人）` | 同原会话 |

召集人主会话不在 pi-pane 的会话列表里（如另一个项目的终端会话）时，按 pane 协议的规则进入 pi-pane 的“未归属”分组。

`sortKey` 用创建时间的 ISO 字符串；同一会议内参会者按席位顺序，书记在后，board 置底。`messageCount` 取 daemon 记录的最终消息数。

状态映射：

| agora 状态 | `NodeStatus` |
| --- | --- |
| created、running | `running` |
| waiting_decision | `waiting` |
| completed | `done` |
| failed | `failed` |
| stopped | `stopped` |
| interrupted | `interrupted` |
| 会议 paused、会议排队等名额 | `paused` |
| 会话被回收、任务未结束 | 保持任务状态；`availability` 仍为 `online` |

`capabilities`：

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

| 面板 id | `placement` | 内容 |
| --- | --- | --- |
| `agora.pending` | sidebar | “待处理”：转给用户的提问、召集人不可达时的决策请求、中断的任务；`list` 类型，每项带动作；`badgeCount` 为未处理数量 |
| `agora.task` | node（任务会话） | `keyValue`：模型、档位、代数、worktree、用量，各代结果；答复过的提问附“由谁、从哪里答复” |
| `agora.meeting` | node（会议） | 阶段、修订号、认可情况、用量与上限、暂停或排队原因 |
| `agora.board` | node（board） | `timeline`，按 seq 显示公开条目，`note` 标注替代关系和“基于旧版本” |

### 动作

| actionId | `scope` | 表单 | 调用的 daemon 端点 |
| --- | --- | --- | --- |
| `agora.task.spawn` | global | 模型、档位、隔离方式、任务书 | `POST /v1/tasks` |
| `agora.task.steer` | node | textarea 字段 `message`，checkbox `interrupt` | `POST /v1/tasks/:id/steer` |
| `agora.task.stop` | node | 无，`confirm` | `POST /v1/tasks/:id/stop` |
| `agora.task.cleanup` | node | checkbox `discard` | `POST /v1/tasks/:id/cleanup` |
| `agora.task.recover` | node、panelRow | 单选 resume / reopen / replace / abandon | `POST /v1/tasks/:id/recover` |
| `agora.request.answer` | panelRow | 由提问本身的题目生成（`RequestQuestion` 与 `FormQuestion` 字段一一对应） | `POST /v1/requests/:id/answer` |
| `agora.meeting.convene` | global | 议题、交付物、brief、参会者、合并人 | `POST /v1/meetings` |
| `agora.meeting.interject` | node | kind 单选 + 正文 | `POST /v1/meetings/:id/interject` |
| `agora.meeting.decide` | node、panelRow | 由决策请求生成 | `POST /v1/meetings/:id/decide` |
| `agora.meeting.stop` | node | 无，`confirm` | `POST /v1/meetings/:id/stop` |

每次 `invoke` 和表单 `submit`，pane 插件把 `RequestOrigin.peerPid` 放进 `Agora-Origin-Pid` 头。

转给用户的提问以持久表单呈现：插件收到 `request:<id>:escalated` 通知后调用 `ctx.formAdded()`，`FormSpec.id` 用 `requestId`；提问在别处被答复或取消后调用 `ctx.formRemoved()`。表单取消、过期时插件不调用 answer，提问保持原状态。

### 通知

pane 插件以 user 身份长轮询 `/v1/inbox`，把发给 user 的通知（转交的提问、中断、会议决策请求和排队提示、存档校验异常）转成 `PaneNotification`，展示后 ack。发给 Agent 召集人的通知由主会话里的 agora 扩展处理，pane 插件不重复展示，只更新对应节点。

## 离线存档读取

daemon 不在线时（`/v1/health` 连接失败），pane 插件和 CLI 改用 archive adapter（见 [archive.md](archive.md#只读-archive-adapter)）：

- 树：`listSessions` 和 `getMeeting` 构造节点，`availability` 全部为 `archived`（文件缺失的为 `missing`），`capabilities` 只有 `open`。
- 会话内容：`readMessages` + `readPartials` 构造 `SessionSnapshot`，`readonly: true`。
- board：`listBoardEntries` 构造 `timeline` 面板内容。
- “待处理”面板显示“agora 未运行”，不提供动作。
- 每 15 秒重试 `/v1/health`，daemon 恢复后发 `reset` 并切回在线模式。

pane 插件和 CLI 不直接读 SQLite 表，不解析 `AGORA_HOME` 下的文件布局，全部通过 adapter。

## 版本协商

三处版本独立演进，分别由不同方维护：

| 层 | 归属 | 标识 | 当前 |
| --- | --- | --- | --- |
| daemon HTTP API | pi-agora（本文） | `Agora-Protocol` 请求头；`/v1/health` 返回 `protocol: { min, max }` | 1 |
| archive adapter | pi-agora（[archive.md](archive.md)） | `openArchive({ apiVersion })` | 1 |
| pane 协议 | pi-pane（`docs/plugin-api.md`） | 插件声明 `paneProtocol: [min, max]`，pi-pane 协商 | 1 |

daemon HTTP API：

```json
GET /v1/health
{ "daemonVersion": "0.1.0", "instanceId": "in_5f2c", "protocol": { "min": 1, "max": 1 } }
```

- 客户端选双方区间交集中的最大值，写进之后每个请求的 `Agora-Protocol` 头。
- 没有交集：daemon 返回 `426 protocol_unsupported`，`details` 里带 daemon 的区间；主会话扩展提示用户升级哪一方，CLI 提示运行 `agora shutdown` 后用新版本启动。
- 增加可选字段、增加端点不升版本；删除或改变字段语义才升版本。daemon 至少同时支持当前和上一个版本。

archive adapter：`apiVersion` 只在返回结构不兼容时递增，旧版本保留至少一个大版本。

pane 协议：协商规则见 pi-pane 的 `docs/plugin-api.md`。`packages/pane-plugin` 声明自己支持的 `paneProtocol` 范围；pi-pane 升级 pane 协议时，只需更新 `pane-plugin`，daemon 和其他包不受影响。
