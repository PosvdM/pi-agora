# 集成协议

> 本文描述完整集成设计。切片 1a 的实际端点和测试入口见 [development.md](development.md)，pane、archive 和其他领域接口按后续切片提供。

本文定义 pi-agora 自己对外的接口，以及 agora 如何接入 pi-pane：

1. daemon HTTP API 概要（agora 扩展、CLI、pane 插件共用）；
2. 会话视图：快照、历史分页和实时事件流；
3. 变更流；
4. agora 数据到 pane 协议的映射（树、会话、面板、动作、表单、通知）；
5. 离线存档读取；
6. 版本协商。

**权威归属**：

| 内容 | 以哪里为准 |
| --- | --- |
| pane 协议（`TreeNode`、`TreeChange`、`SessionSnapshot`、`SessionStreamEvent`、`PanelSpec`、`PanelContent`、`ActionSpec`、`ActionTarget`、`ActionInvocation`、`FormSpec`、`PaneNotification`、`RequestOrigin`、`userPresence` 等类型，渲染与同步规则，pane 协议版本） | pi-pane 仓库的 `docs/plugin-api.md` |
| pi-hostkit（RPC 传输、进程、锁、路径） | pi-hostkit 仓库的 [docs/design.md](https://github.com/PosvdM/pi-hostkit/blob/main/docs/design.md) |
| 安全模型（principal、用户确认、设备配对、访问控制） | 本仓库 [security.md](security.md) |
| daemon HTTP API、daemon 侧会话视图与变更流、agora → pane 协议的映射、archive adapter | 本文及 pi-agora 的其他文档 |

本文用到 pane 协议的类型时只写类型名和语义，不重复定义字段。

## 依赖方向

```text
packages/protocol ◄── daemon、extension、cli、archive、pane-plugin
packages/archive  ◄── daemon、cli、pane-plugin
pi-hostkit        ◄── daemon、extension（pi-pane 服务端也依赖它）
@pi-pane/plugin-api（peer 依赖）◄── 只有 pane-plugin
```

- `daemon`、`extension`、`cli`、`archive`、`protocol` 都不依赖 pi-pane。不装 pi-pane 时 pi-agora 完整可用。
- 只有 `packages/pane-plugin` 把 `@pi-pane/plugin-api` 作为 peer 依赖，负责把 agora 的数据翻译成 pane 协议。pane 协议升级时只需改这个包。
- `packages/archive` 同时提供“用户聊天视图”的投影函数，daemon 在线读取和 adapter 离线读取用同一份代码，保证返回同一种视图（见 [archive.md](archive.md#三种投影)）。

## 连接拓扑

```text
浏览器 ──HTTP/WebSocket──► pi-pane 服务端 ──► 主会话 pi --mode rpc ──► agora 扩展（agent:main）──┐
  ▲ 设备密钥签名               │                                                              │
  └── userPresence.confirm ◄──┴─ agora pane 插件（host:pane）──HTTP──► agora daemon ◄──────────┘
                                        │
                                        └─ daemon 不在线时：archive adapter 只读打开存档
```

- **浏览器只连 pi-pane**，不持有任何 daemon 凭证；daemon 拒绝带 `Origin` 头的请求。
- pi-pane 托管的主会话里装着 agora 扩展，它和终端里的主代理一样，以 `agent:main` 身份连 daemon。
- agora pane 插件运行在 pi-pane 服务端进程里，以 `host:pane` 身份连 daemon，只有主 Agent 级权限。用户级操作由插件向 daemon 取挑战，经 `ctx.userPresence.confirm()` 交给浏览器签名，再把签名转交 daemon（见 [security.md](security.md#经-pi-pane-确认)）。

## daemon HTTP API 概要

### 约定

- 地址：`http://127.0.0.1:<port>/v1/...`，端口从 `AGORA_HOME/run/daemon.json` 读取。
- 鉴权：除 `GET /v1/health` 和 `/v1/auth/*` 外，所有请求带 `Authorization: Bearer <连接 token>`。身份只由 token 决定，请求体里的身份字段一律忽略。
- **以用户身份执行**：用户级端点要求请求头 `Agora-Act-As: user`。daemon 不直接执行，而是生成待确认并返回 `202`：

  ```json
  { "confirmation": { "id": "cf_71d2", "challenge": { "action": "agora.request.answer", "target": "rq_31c0",
      "paramsHash": "…", "nonce": "…", "expiresAt": "2026-11-05T10:26:00Z" },
      "title": "答复提问 rq_31c0", "summary": "选择：方案 B", "expiresAt": "2026-11-05T10:26:00Z" } }
  ```

  签名提交到 `POST /v1/confirmations/:id/sign` 后，响应体为原操作的结果。`userConfirmation = off` 时，来自 `host:cli` 的用户级请求直接执行（见 [security.md](security.md#只用终端)）。
- 协议版本：每个请求带 `Agora-Protocol: 1`，见“版本协商”。
- 请求和响应都是 JSON（UTF-8）。时间用 ISO 8601 UTC 字符串。
- **幂等**：有副作用的 `POST` 支持 `Idempotency-Key` 头，见下文“幂等”。
- 列表分页：`?limit=&cursor=`，响应 `{ "items": [...], "nextCursor": "..." }`。`limit` 默认 50，最大 200。
- 错误：

  ```json
  { "error": { "code": "lease_held", "message": "该主会话已由另一个连接控制", "details": { "principalId": "pr_1a2b" } } }
  ```

  | HTTP | code（示例） |
  | --- | --- |
  | 202 | `confirmation_required`（不是错误；带 `confirmation`） |
  | 400 | `invalid_params`、`invalid_ref`、`duplicate_role`、`unanswered_objections`、`exceeds_concurrency` |
  | 401 | `unauthenticated`、`token_expired` |
  | 403 | `forbidden`（权限档位、角色或 ACL 不允许）、`signature_invalid`、`device_unknown` |
  | 404 | `not_found` |
  | 409 | `lease_held`、`conflict`（条件迁移失败）、`invalid_state`、`already_handled`、`idempotency_mismatch` |
  | 410 | `confirmation_expired`、`cursor_expired` |
  | 426 | `protocol_unsupported` |
  | 503 | `draining`（daemon 正在排空，拒绝新任务） |

### 幂等

`Idempotency-Key` 标识的是**一次操作**，不是一份响应快照：

- **记录**：daemon 以（principal，key）为键保存操作记录：请求指纹（方法、路径、规范化请求体的 sha256）、操作 id、当前状态（`in_progress`、`awaiting_confirmation`、`succeeded`、`failed`）和最终结果。记录保留 24 小时。
- **不重复执行**：同一 key 的请求只执行一次。
- **重复请求返回当前状态**：同一 key 再次请求时，操作已结束则返回最终结果（成功或失败，与第一次结束时相同）；尚未结束则返回 `202` 和当前状态（如 `{ "operation": { "id": "op_…", "state": "awaiting_confirmation", "confirmation": { … } } }`），不返回旧的中间响应。只有最终结果被缓存。
- **参数不同**：同一 key、请求指纹不同，返回 `409 idempotency_mismatch`，不执行，也不返回原操作的结果。
- **后台完成**：用户级操作在待确认被签名、执行之后，daemon 把操作记录更新为最终结果；之后用同一 key 查询得到的就是这个结果。待确认被拒绝或过期时，操作记录的最终结果为失败（`confirmation_cancelled`、`confirmation_expired`）。
- **pane 插件侧**：把 `ActionInvocation.idempotencyKey` 原样作为该头的值，每次 `invoke` 都把请求转给 daemon，不在插件里缓存中间结果；按 daemon 返回的当前状态映射 `ActionResult`（见“动作”）。`needsInput` 之后的再次提交使用 pi-pane 生成的 `<原 key>/<n>`，是另一次操作。与 pane 协议的约定一致：同一 key 只执行一次，还在处理时返回 `pending`，结束后返回最终结果。

### 任务额度与用量字段

`POST /v1/tasks` 接受可选的 `skills: string[]`，省略时按权限档位配置默认值，未配置时为空；显式数组覆盖默认值，下级只能取上级名单的子集。错误为 `400 skill_not_found`（未找到、歧义或不可访问）和 `403 skill_upgrade`（越出上级名单）。名字格式遵守 pi skill 规范：至多 64 字符，小写字母、数字和单个连接号，不以连接号开头或结尾。

`GET /v1/tasks/:id` 与 `/result` 返回 `usage`（任务累计）和 `treeUsage`（含全部后代），result 还返回 `generationUsage`；各 token 字段和上下文大小语义见 [tasks.md](tasks.md#用量与上下文)。result.usage 保留旧会话统计字段。额度暂停状态为 `quota_paused`，`quotaResumeAt` 是可空的 ISO 8601 UTC 时间。

额度暂停通过现有 `POST /v1/tasks/:id/recover`、`{ "mode": "resume" }` 恢复，不增加代数；重置时间未到返回 `409 quota_not_reset`，旧运行未确认退出返回 `409 stop_incomplete`。通知 `task:quota_ready` 的 payload.tasks 带暂停任务的 taskId、generation、resumeAt 和 contextTokens；没有可识别时间时发送 `task:quota_unknown`。不增加专用恢复端点，父任务恢复不隐式恢复下级。CLI 和 pane 的专用用量展示阶段见 [roadmap.md](roadmap.md)。

### 端点

| 分组 | 方法与路径 | 用途 | 主要调用方 |
| --- | --- | --- | --- |
| 基础 | `GET /v1/status` | 运行状态、活动名额和任务状态计数；需要主 Agent 级鉴权 | CLI |
| 基础 | `GET /v1/health` | 版本、协议范围、instanceId；不需要鉴权，不返回其他信息 | 全部 |
| 鉴权 | `POST /v1/auth/challenge` | 双向握手第一步 | 主会话扩展、CLI、pane 插件 |
| | `POST /v1/auth/token` | `host.key` 证明换连接 token；`as: "host:cli" \| "host:pane"` 或主会话注册/认领 | 同上 |
| | `POST /v1/auth/launch` | 协作会话用 launch ticket 换 token | 协作会话里的扩展 |
| | `POST /v1/auth/refresh` | 续期 token | 全部 |
| 运行 | `POST /v1/runs/:runId/ready` | 协作会话报告就绪（活动工具、模型等），见 [architecture.md](architecture.md#受管扩展的就绪检查) | 协作会话里的扩展 |
| | `POST /v1/runs/:runId/fatal` | 权限检查发生内部故障时报告 fatal，停止自己的 run；不接受控制其他 run | 协作会话里的扩展 |
| 主会话 | `POST /v1/principals/register`、`/reclaim` | 注册、恢复后认领 principal | 主会话扩展 |
| | `POST /v1/lease/renew`、`/release` | 每 30 秒续控制租约及连接 token；关闭或切换主会话时释放租约 | 主会话扩展 |
| | `POST /v1/principals/:id/takeover` | 强制转移租约（用户级） | CLI、pane 插件 |
| 用户确认 | `GET /v1/confirmations` | 待确认列表（状态、发起方、过期时间） | CLI、pane 插件 |
| | `POST /v1/confirmations/:id/sign` | 提交设备签名 `{ deviceId, publicKey, alg, signature }`，验签后执行 | pane 插件 |
| | `POST /v1/confirmations/:id/cancel` | 用户拒绝 | pane 插件、CLI |
| 设备 | `POST /v1/devices/pair` | 取配对挑战（`action: "agora.device.pair"`），新设备用自己的密钥签名后提交。同一事务内按三种情况处理：`everPaired = false` → TOFU 直接配对；`reTofuArmed = true`（离线重置后）→ 直接配对并消费该状态；其他 → 进入待批准。规则见 [security.md](security.md#配对状态) | pane 插件 |
| | `GET /v1/devices` | 已配对和待批准设备 | CLI、pane 插件 |
| | `POST /v1/devices/:id/approve`、`/revoke` | 批准、撤销（用户级，已配对设备签名） | CLI、pane 插件 |
| | `POST /v1/devices/reset` | 在线重置配对（`agora pair --reset`，用户级，已配对设备签名）：保留签名设备，清掉其余。没有可用浏览器时用离线命令，不经 API | CLI、pane 插件 |
| 安全警告 | `GET /v1/security/alerts` | 当前的安全警告（`alertId`、类型、`revision`、内容、状态） | CLI、pane 插件 |
| | `POST /v1/security/alerts/:alertId/acknowledge` | 带 `revision` 发起确认知悉，返回 `202` 和待确认；签名走 `/v1/confirmations/:id/sign`。只适用于 `devices-reset` | pane 插件 |
| 配置 | `GET /v1/settings`、`PUT /v1/settings/:key` | 如 `userConfirmation`、`meetingLimitDefaults`、`agentLimitCap`；关闭保护、调高上限配置是用户级，开启保护、调低随时可以 | CLI |
| 任务 | `POST /v1/tasks` | spawn | 主会话扩展、CLI、pane 插件 |
| | `GET /v1/tasks`、`GET /v1/tasks/:id`、`GET /v1/tasks/:id/result?generation=` | 列表、当前详情、指定代结果 | 同上 |
| | `POST /v1/tasks/:id/steer`、`/stop`、`/cleanup`、`/recover`、`/takeover` | 返工、停止、清理 worktree、中断后的处理、接管 | 同上 |
| 提问 | `POST /v1/requests` | 提问 | 协作会话扩展 |
| | `GET /v1/requests` | 按状态和接收方查询；`?for=me` | 全部 |
| | `POST /v1/requests/:id/answer`、`/escalate`、`/cancel` | 答复、转给用户、取消 | 召集人、`host:*` |
| board | `GET /v1/boards/:id`、`GET /v1/boards/:id/entries?afterSeq=` | 元数据、公开条目 | 成员、`host:*` |
| | `POST /v1/boards/:id/entries` | 发条目（`sealed` 仅会议密封阶段） | 成员、召集人、`host:*`（作者为 user，用户级） |
| | `POST /v1/boards` | 新建独立 board（非会议） | 主会话扩展、`host:*` |
| 会议 | `POST /v1/meetings` | 召集；名额不足时返回 `queued` 和排队信息 | 主会话扩展、CLI、pane 插件 |
| | `GET /v1/meetings/:id` | 状态、阶段、修订、认可、用量、排队位置 | 召集人、`host:*` |
| | `POST /v1/meetings/:id/interject`、`/decide`、`/limits`、`/stop` | 插话、回应决策请求、调整上限、结束 | 召集人、`host:*` |
| | `POST /v1/meetings/:id/endorse` | 认可修订 | 参会者扩展 |
| 会话 | `GET /v1/sessions` | 协作会话列表及关系；`?parent=<nodeId>&cursor=` 按父节点分页 | CLI、pane 插件 |
| | `GET /v1/sessions/:id` | 会话详情 | 同上 |
| | `GET /v1/sessions/:id/snapshot` | 用户聊天视图快照，见“会话视图” | 同上 |
| | `GET /v1/sessions/:id/history?before=&limit=` | 历史水位之前的更早条目 | 同上 |
| | `GET /v1/sessions/:id/stream?epoch=&afterSeq=` | 实时事件流（SSE） | 同上 |
| | `GET /v1/sessions/:id/diagnostics` | 各次 run 的退出诊断 | 同上 |
| 收件箱 | `GET /v1/inbox?wait=25` | 长轮询通知：按创建时间、id 排序，每批最多 200 条，无游标；非空批后用 wait=0 连续拉取到空批，见 [tasks.md](tasks.md#投递) | 全部扩展、pane 插件 |
| | `POST /v1/inbox/ack` | 确认通知已写入会话文件（扩展）或已展示（pane 插件） | 同上 |
| 变更流 | `GET /v1/changes?epoch=&afterSeq=` | 领域对象变更（SSE），见“变更流” | pane 插件 |
| 审计 | `GET /v1/audit?target=` | 审计记录 | CLI、pane 插件 |
| 管理 | `POST /v1/admin/shutdown` | 排空或强制关闭 | CLI |

收件箱采用至少一次投递：返回通知时设置默认 120 秒的可见性超时，未确认项到期后可再次返回。扩展按 `dedupeKey` 去重，只有核实会话条目和完整磁盘记录后才调用 ack；ephemeral 会话单独记录内存送达，不声明已持久化。业务上取得结果与写入会话的确认互不替代。

各端点的访问控制见 [security.md](security.md#资源级访问控制)。请求和响应的完整字段在 `packages/protocol` 里以 TypeScript 类型和 JSON schema 给出；工具参数与 [tasks.md](tasks.md)、[board.md](board.md)、[meetings.md](meetings.md) 中的定义一一对应。

## 会话视图

### 三种投影

同一个会话有三种不同的内容，接口里不混用：

| 投影 | 内容 | 谁用 |
| --- | --- | --- |
| ① 原始存档 | pi JSONL 中的全部条目（含废弃分支、自定义条目）；v2/v3 条目 id 来自文件，具有稳定性；v1 在解析/迁移时派生的 id 不可作为跨进程或迁移前后的持久键 | 完整性校验、导出 |
| ② 用户聊天视图 | 从当前叶子沿 `parentId` 回到根的整条活动分支，包括压缩前的内容；压缩条目显示为分隔标记 | 本节的快照、历史分页、事件流；pi-pane 和 CLI 的会话查看 |
| ③ 模型当前上下文 | 压缩和 context edit 之后实际发给模型的消息 | 只用于诊断；不在会话查看中展示 |

②的条目保留 pi 的原始形状和 entryId，与 pi-pane 对主会话的处理相同（见 pi-pane `docs/plugin-api.md` 的“三种投影”）。②的计算在 `packages/archive` 里实现一次（见 [archive.md](archive.md#三种投影)），条目来源：

- 会话有运行中的进程时，用 RPC `get_entries`（含压缩前的历史，支持 `since` 游标，返回 `leafId`）取条目（依据：`docs/rpc-commands.md` 的 `get_entries`）；
- 没有进程或 daemon 不在线时，用只读解析器读 JSONL（见 [archive.md](archive.md#只读-archive-adapter)）。

不用 RPC `get_messages`：它返回的是③，压缩后会丢掉用户看过的内容。

### 游标

会话事件的游标是 `{ epoch, seq }`，对应 pane 协议的 `StreamCursor`：

- `epoch`：不透明字符串，按 pane 协议的规则在事件流无法保证连续时更换。daemon 取 `<instanceId>:<runId>`：每次会话运行开始（拉起或重建进程，包括恢复、回收后重新拉起）都换一个新 epoch；daemon 重启后 instanceId 也变。会话没有进程时取 `<当前 instanceId>:<最后一次运行的 runId>`，所以 daemon 重启后同样会变。
- `seq`：同一 epoch 内从 1 递增，0 表示该 epoch 还没有事件。daemon 在内存里保留每个会话当前 epoch 最近 2000 个事件。
- **运行变化触发重同步**：daemon 发出 `agora_run`（进程拉起或退出）后，拉起时立即换 epoch，已订阅的连接收到 `resync`，按新快照重新订阅。进程退出时 epoch 不变，订阅者收到 `agora_run` 的 `exited` 和最终状态。

客户端带来的 `epoch` 与当前不同、`afterSeq` 之后的事件已不在缓冲区内、或 `afterSeq` 大于当前 head 时，daemon 只发一条 `event: resync`，客户端必须重新取快照。

### 会话模型与原子切点

daemon 是 RPC 事件的唯一消费者，按 stdout 的顺序为每个有进程的会话维护一个内存模型：

- **已记录的条目**：run 开始时（发送任何 prompt 之前，进程空闲）用 `get_entries` 取得全部条目和 `leafId`。`get_entries` 返回的是 pi 会话里已记录的条目，不一定已写入会话文件：新会话在出现第一条 user 或 assistant 消息之前，条目只在内存里（依据：`dist/core/session-manager.js` 的 `_persist`、`_hasConversation`）。会话视图只需要“pi 已记录”；需要“已写入文件”的地方（通知确认、流片段关闭、完整性校验）另行核对会话文件。之后每次 `message_end`、`turn_end`、`compaction_end`、`agent_settled`、`entry_appended` 后，在该会话的串行控制队列里用 `get_entries` 加 `since=<最后一个已知 entryId>` 取新条目，追加到模型，并产生一个 `agora_entries` 事件 `{ entries, leafId }`。
- **进行中的状态**（`inFlight`）：字段与 pane 协议的 `InFlightState` 一致（在 `packages/protocol` 中独立定义）——`phase`（含 `stopping`）、按 `contentIndex` 排列的进行中助手消息块（thinking、text、toolCall，toolCall 带 id、toolName、参数片段）、`completed`（已收到 `message_end`、还没有对应条目的消息）、正在执行的工具、`queue`（来自 `queue_update`）、`retry`。块由 `message_update` 的 `*_start`/`*_delta`/`*_end` 重建（依据：`docs/json.md` 的 Message events 一节）。收到 `agora_entries` 后，`completed` 中按顺序对应的消息移除。

`GET /v1/sessions/:id/snapshot` 在 daemon 事件循环的同一轮里同步读出模型和当前 seq，所以快照恰好反映 seq 不大于切点的全部事件，之后的事件都在缓冲区里：

```json
{
  "cursor": { "epoch": "in_5f2c:pr_51d0", "seq": 1842 },
  "leafId": "e_9a7c",
  "entries": [ { "type": "message", "id": "e_9a70", "parentId": "e_9a6f", "message": { "role": "user", "content": "…" } } ],
  "historyBefore": "e_9a70",
  "inFlight": {
    "phase": "streaming",
    "assistant": { "startedAt": 1762337000000, "blocks": [
      { "type": "thinking", "contentIndex": 0, "text": "…", "done": true },
      { "type": "toolCall", "contentIndex": 1, "id": "call_abc", "toolName": "bash", "argsText": "{\"command\":\"npm te", "done": false } ] },
    "completed": [],
    "tools": [],
    "queue": { "steering": [], "followUp": [] }
  },
  "unfinishedPartials": [ { "runId": "pr_51d0", "at": "…", "blocks": [ { "type": "text", "contentIndex": 0, "text": "中断时正在生成的内容……", "done": false } ] } ],
  "status": "running",
  "statusDetail": null
}
```

- `entries` 是②从叶子往回的最后一页（默认 100 条，旧在前）。`historyBefore` 是历史水位：更早的条目从这个条目的父条目开始取；`null` 表示已到开头。
- 没有进程的会话：`entries`、`leafId` 由只读解析得到，`inFlight` 为空，`cursor.seq` 为当前 head。

客户端流程：取快照 → 用 `cursor` 订阅事件流 → 按事件更新 `inFlight`，收到 `agora_entries` 时把新条目接在叶子之后。

### 历史分页

`GET /v1/sessions/:id/history?before=<entryId>&limit=` 返回水位之前的条目（旧在前）和新的水位。条目树只追加、`parentId` 不变，沿父链往回翻得到的页面是确定的；新条目只会出现在叶子之后，由事件流送达，所以翻旧页与实时追加之间不会重复也不会遗漏。历史分页读的是不再变化的旧条目，daemon 用只读解析器读会话文件，不经过 RPC。

协作会话不切换分支。万一活动分支的叶子移到了另一条分支（`get_entries` 返回的 `leafId` 不在原叶子之后），daemon 发 `resync`。

### 事件流

`GET /v1/sessions/:id/stream?epoch=<e>&afterSeq=<n>`，`Content-Type: text/event-stream`。每个事件：

```text
id: in_5f2c:pr_51d0:1843
event: session
data: {"cursor":{"epoch":"in_5f2c:pr_51d0","seq":1843},"sessionId":"as_c21e","event":{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":1,"delta":"好"}}}
```

- `event` 字段原样转发 pi RPC 的会话事件（格式见 pi `docs/json.md`）。`message_update` 只带增量，不带累计快照，流量与输出长度成线性关系。
- 重连：带 `epoch` 和 `afterSeq`，或 `Last-Event-ID`（格式 `<epoch>:<seq>`，取最后一个冒号之后的部分为 seq）。
- daemon 额外发的事件类型：`agora_entries`（pi 新记录的条目）、`agora_status`（会话状态变化）、`agora_run`（进程拉起或退出，`{ runId, phase: "started" | "exited", reason? }`；`started` 之后紧跟 epoch 更换和 `resync`）、`resync`。

`agora_status` 的格式：

```json
{ "type": "agora_status", "status": "running", "phase": "stopping", "statusDetail": "停止中", "revision": 12 }
```

## 变更流

`GET /v1/changes?epoch=<e>&afterSeq=<n>`（SSE）推送领域对象的变更：任务、协作会话、会议、提问、board 头序号、待确认、设备。pane 插件据此生成 `TreeChange`、刷新面板和表单。

- 变更记录持久化在 `changes` 表，与业务状态变更同事务写入。每条记录带 `seq`（全局递增）、对象类型与 id；删除时带 `tombstone: true`。
- `epoch` 是数据库级的标识，只在数据库被重建或从备份恢复时改变。
- **保留与过期**：变更记录保留 7 天且至少保留最近 10 万条。请求的 `epoch` 不同、`afterSeq` 早于保留范围、或 `afterSeq` 大于当前 head 时，daemon 只返回一条 `event: reset`；客户端（pane 插件）丢弃本地状态，重新取快照。
- **快照切点**：`GET /v1/sessions` 等列表接口的响应带 `changesCursor: { epoch, seq }`，与列表内容在同一个只读事务里读出，客户端用它订阅变更流即可不重不漏。

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

- pi-pane 的 `pane:session` 节点覆盖 pi 会话存储里能列出的全部会话（包括按 `sessionDir` 设置存放的），所以召集人主会话来自终端还是 pi-pane 都能找到父节点。只有父节点确实列不出（如终端里用 `--session-dir` 指定了别处的会话、会话文件已被删除）时，节点才按 pane 协议的规则进入“未归属”分组。
- **工具卡片链接**：由 `agora_task spawn` 或 `agora_meeting convene` 产生的任务、会议节点填 `originToolCall`，值为召集人会话的 `SessionRef` 和那次工具调用的 `toolCallId`（agora 扩展在调用 daemon 时附上自己收到的 `toolCallId`）。召集人是 user 时不填。
- `sortKey` 用创建时间的 ISO 字符串；同一会议内参会者按席位顺序，书记在后，board 置底。`messageCount` 取 daemon 记录的最终消息数；`lastActivityAt` 取最近一次会话事件或状态变化的时间；`statusDetail` 来自 `agora_status.statusDetail`（如“排队中：第 2 位”“停止中”“合并第 3 版”）。

#### 同步与按需加载

- **修订号**：pane 插件的来源级 `revision` 直接用变更流的 `seq`，`epoch` 用变更流的 `epoch`。每条变更对应一条 `TreeChange`：`upsert` 的 `revision` 和 `node.revision` 为该变更的 `seq`。
- **删除**：`agora archive delete` 只删存档文件、保留元数据，节点仍可列出，插件发 `upsert`，节点的 `availability` 变为 `missing`。只有对象的元数据也被删除、不再能列出时，才发带 `revision` 的 `remove`（tombstone）；MVP 没有删除元数据的操作。
- **订阅与重置**：`tree.subscribe` 以快照的 `{ epoch, revision }` 为起点（参数形状以 pi-pane `docs/plugin-api.md` 为准），插件用它作为变更流的 `epoch` 和 `afterSeq`。`epoch` 不符、`revision` 大于当前 head 或早于保留范围时，变更流返回 `reset`，插件向 pi-pane 发 `TreeChange` 的 `reset`。
- **快照**：`tree.snapshot(req)` 只返回热节点及其祖先，热节点的定义以 pane 协议为准（`req.openNodeIds` 中的节点、`status` 为 `running`/`waiting`/`paused` 的节点、`lastActivityAt` 晚于 `req.recentSince` 的节点）。插件把这些条件转成 daemon 的列表查询，响应里的 `changesCursor.seq` 就是快照的 `revision`。
- **子节点**：`tree.children(parentId, page)` 对应 `GET /v1/sessions?parent=<nodeId>&cursor=&limit=`，响应带 `changesCursor`，插件把其中的 `epoch` 和 `seq` 作为分页结果的 `epoch` 和 `revision`；`epoch` 与当前订阅不同时，pi-pane 按 pane 协议重置。`parentId` 为 `pane:session:<piSessionId>` 时返回该主会话召集的任务和会议。节点都填 `hasChildren`，已知时填 `childCount`。
- 订阅推送 agora 来源全部节点的变更，pi-pane 负责只更新已加载部分和补取祖先。

#### 状态映射

| agora 状态 | `NodeStatus` |
| --- | --- |
| 任务 `created`（排队等名额或进程尚未就绪） | `waiting` |
| 任务 `running` | `running` |
| 任务 `waiting_decision`、`waiting_children` | `waiting` |
| 任务 `quota_paused` | `paused` |
| 任务 `completed` | `done` |
| 任务 `failed` | `failed` |
| 任务 `stopped` | `stopped` |
| 任务 `interrupted` | `interrupted` |
| 会议 `convening`、`queued` | `waiting` |
| 会议 `sealed`、`critique`、`merging`、`reviewing`、`minuting` | `running` |
| 会议 `paused` | `paused` |
| 会议 `interrupted` | `interrupted` |
| 会议 `ended` | `done`（停止原因为“放弃”时为 `stopped`） |
| 会话被回收、任务未结束 | 保持任务状态；`availability` 仍为 `online` |

#### capabilities

| 节点 | daemon 在线 | daemon 不在线 |
| --- | --- | --- |
| 运行中的任务 | `open`、`subscribe`、`send`、`abort`、`action:agora.task.steer`、`action:agora.task.stop` | `open` |
| 已完成、失败的任务 | `open`、`send`、`action:agora.task.steer`（返工）、`action:agora.task.cleanup` | `open` |
| 中断的任务 | `open`、`action:agora.task.recover` | `open` |
| 额度暂停的任务 | `open`、`action:agora.task.recover`（resume）、`action:agora.task.stop` | `open` |
| 参会者、书记 | `open`、`subscribe` | `open` |
| 会议 | `action:agora.meeting.interject`、`action:agora.meeting.decide`、`action:agora.meeting.limits`、`action:agora.meeting.stop` | 无 |
| board | 无（点击 resource 节点时 pi-pane 打开适用的 `agora.board` 面板；`open` 只用于 session 节点） | 无 |

- `send`：任务节点同时填 `composer: { actionId: "agora.task.steer", placeholder: "对子代理补充说明或返工", images: false }`。pi-pane 把聊天输入框的提交转成该动作（文字在 `input.fields.message`），插件调用 `POST /v1/tasks/:id/steer`，保证有记录、有代数。`interrupt` 由动作表单的 checkbox 选择；输入框提交时为 `false`。
- `abort`：插件实现 `sessions.abort(ref, { clearQueue, origin })`，调用 `POST /v1/tasks/:id/stop`，语义是取消（先 `clear_queue` 再 `abort`，见 [tasks.md](tasks.md#agora_task-接口)）。`AbortResult.clearedText` 填被清掉的返工消息原文（去掉 agora 加的标注行），pi-pane 放回输入框。
- 参会者和书记不带 `send`：会议中对参会者说话一律通过会议插话，进入 board。

### 会话

pane 插件的 `sessions.snapshot`、`sessions.history`、`sessions.subscribe` 直接转发 daemon 的会话视图：

| daemon | pane 协议 |
| --- | --- |
| 会话 id `as_…` | `SessionRef { source: "agora", id: "as_…" }` |
| 快照的 `cursor`、`leafId`、`entries`、`historyBefore`、`inFlight`、`unfinishedPartials` | `SessionSnapshot` 的同名字段 |
| `status` | 按“状态映射”转换 |
| — | `readonly`：可以 steer 的任务为 `false`（输入框经 `composer` 转成 steer）；参会者、书记为 `true`（`readonlyReason: "noPermission"`）；daemon 不在线时为 `true`（`"archived"`） |
| `GET .../history` | `sessions.history` 的 `HistoryPage` |
| SSE 的 `cursor`、`event` | `SessionStreamEvent` 的 `cursor`、`event`；`agora_entries` 转为 `pane_entries`；`agora_status` 转为 `pane_status`（`status` 按映射转换，`phase` 原样，`statusDetail` 放入 `detail`）；`agora_run` 本身不转发，它引起的 `resync` 原样转发 |

#### 自定义消息的显示

pane 插件通过 `renderers.customMessages` 声明 agora 自定义消息的渲染方式；没有声明的按 pi-pane 的缺省规则显示为折叠卡片。

| customType | 出现在 | 渲染器 |
| --- | --- | --- |
| `agora:notice` | 召集人主会话 | `label: "agora 通知"`，展开显示正文；`fields` 显示 `details.taskId`、`details.generation`；`nodeIdPath: "nodeId"`（`details.nodeId` 由 daemon 填为对应树节点），点击打开子会话 |
| `agora:board-delta` | 参会者会话 | `label: "board 增量"`，默认折叠 |
| `agora:meeting-turn` | 参会者会话 | `label: "会议阶段"`，`fields` 显示 `details.phase`、`details.phaseEpoch` |

`agora-principal` 是 `appendEntry` 写入的自定义条目，不是消息，pi-pane 不显示。

#### 保活

召集人主会话还有运行中的任务或会议时，pane 插件对该主会话调用 `ctx.mainSessions.hold(ref, "等待子代理（N 个）")`，让 pi-pane 不回收它的 pi 进程，完成通知能及时注入；全部结束后调用 `release()`。用户主动关闭被 hold 的主会话时，通知照常留在 outbox，下次打开该会话时补送。

### 面板

| 面板 id | `placement` | `appliesTo` | 内容 |
| --- | --- | --- | --- |
| `agora.task` | node | `kinds: ["session"]`，`sources: ["agora"]`（参会者和书记节点返回席位信息） | `keyValue`：模型、档位、代数、worktree、用量，各代结果；答复过的提问附“由谁、怎样确认” |
| `agora.meeting` | node | `kinds: ["group"]`，`sources: ["agora"]` | `steps`：各阶段为一步（`StepItem.status` 取 pending / active / done / failed / skipped），`progress` 为合并—核对循环数与上限；`detail` 写修订号、认可情况、用量与上限、暂停或排队原因 |
| `agora.board` | node | `kinds: ["resource"]`，`resourceTypes: ["board"]` | `timeline`，按 seq 显示公开条目，`note` 标注替代关系、“基于旧版本”和“旧阶段产物，不计入” |

- 内容变化时插件调用 `ctx.panelChanged({ panelId, revision, nodeId })` 推送（如会议阶段推进、board 新条目）。
- agora 不提供侧栏面板，也不做“待处理”面板：所有需要用户处理的事项都以持久表单进入 pi-pane 唯一的“待处理”区，见“表单”。

### 动作

| actionId | `scope` | `hasForm` | 表单内容 | 调用的 daemon 端点 | 权限级别 |
| --- | --- | --- | --- | --- | --- |
| `agora.task.spawn` | `["global", "node"]` | 是 | 模型、档位、隔离方式、任务书 | `POST /v1/tasks` | 主 Agent 级（召集人记为 user） |
| `agora.task.steer` | `["node"]` | 是 | textarea `message`，checkbox `interrupt` | `POST /v1/tasks/:id/steer` | 主 Agent 级 |
| `agora.task.stop` | `["node"]` | 否，`confirm` | — | `POST /v1/tasks/:id/stop` | 主 Agent 级 |
| `agora.task.cleanup` | `["node"]` | 是 | checkbox `discard` | `POST /v1/tasks/:id/cleanup` | 主 Agent 级 |
| `agora.task.recover` | `["node"]` | 是 | 单选 resume / reopen / replace / abandon（选项随任务状态） | `POST /v1/tasks/:id/recover` | 见 [security.md](security.md#任务) |
| `agora.meeting.convene` | `["global", "node"]` | 是 | 议题、交付物、brief、参会者（`type: "group"`，`min: 2`、`max: 4`，子字段为名称、模型、角色）、合并人、上限 | `POST /v1/meetings` | 主 Agent 级；pane 召集的会议是用户召集，上限超出 `meetingLimitDefaults` 时用户级 |
| `agora.meeting.interject` | `["node"]` | 是 | kind 单选 + 正文 | `POST /v1/meetings/:id/interject` | 用户级 |
| `agora.meeting.decide` | `["node"]` | 是 | 由当前决策请求生成 | `POST /v1/meetings/:id/decide` | 见 [security.md](security.md#会议) |
| `agora.meeting.limits` | `["node"]` | 是 | 各项上限的新值 | `POST /v1/meetings/:id/limits` | 用户级（从 pi-pane 发起的都是以用户身份；主 Agent 在封顶以内的提高走自己的工具，不经 pane） |
| `agora.meeting.stop` | `["node"]` | 否，`confirm` | — | `POST /v1/meetings/:id/stop` | 主 Agent 级 |

- **动态表单**：表单依赖目标的当前状态（如 recover 是否允许 resume、decide 的选项来自当前决策请求），插件在 `actions.resolveForm(actionId, target)` 里按 `ActionTarget` 现取，`actions.list()` 只给静态目录。
- **目标**：`ActionTarget` 为 `{ type: "node", nodeId }` 时，`agora:session:<as_id>` 解析为任务，`agora:meeting:<mt_id>` 解析为会议；`{ type: "global" }` 用于召集新任务和会议。agora 不使用表格面板，没有 `panelRow` 目标。
- **结果映射**（`ActionResult`）：

  | daemon 响应 | `ActionResult` |
  | --- | --- |
  | 2xx 成功 | `{ status: "ok", message, openNodeId }`（spawn、convene 时 `openNodeId` 为新节点） |
  | 4xx 错误 | `{ status: "failed", message }` |
  | `202` 且操作未结束（处理中、等待用户确认）、调用超时 | `{ status: "pending", message }`；pi-pane 之后用同一 `idempotencyKey` 查询，插件把查询转给 daemon，得到当前状态 |
  | `409 idempotency_mismatch` | `{ status: "idempotencyConflict", message }` |
  | 需要进一步输入（如 recover 选了 replace 后要选模型和档位） | `{ status: "needsInput", followUpForm }` |

- **幂等**：见上文“幂等”。插件不缓存 daemon 的中间响应，同一 key 的每次 `invoke` 都转给 daemon，由 daemon 保证只执行一次并返回当前状态。
- **用户级动作**：插件拿到 `202 confirmation_required` 后调用 `ctx.userPresence.confirm({ title, summary, payload: challenge, origin, timeoutMs })`，`origin` 取 `invoke` 收到的 `RequestOrigin`，确认框优先弹在发起的标签页。用户级动作声明 `timeoutMs: 60000`；确认在此之前完成时，插件提交签名并返回 `ok`；未完成时返回 `pending`，确认在后台继续，签名提交后 daemon 把操作记录更新为最终结果，插件再以 `PaneNotification` 告知；之后用同一 key 查询得到最终结果。用同一 key 查询时，daemon 仍报告 `awaiting_confirmation`：插件还有进行中的 `confirm` 就不再弹第二个确认框；插件重启过、已没有进行中的 `confirm` 时，对同一条待确认重新发起确认。`UserPresenceError` 的处理见 [security.md](security.md#经-pi-pane-确认)。

### 表单

pi-pane 只有一个“待处理”区，承载所有插件的持久表单。agora 需要用户处理的事项都以持久表单呈现（`ctx.formAdded()`），不另做面板：

| 事项 | `FormSpec.id` | 内容 | `cancel` 按钮 | 提交后 |
| --- | --- | --- | --- | --- |
| 转给用户的提问（含召集人不可达时的提问） | `agora:request:<requestId>` | 由提问的题目生成（`RequestQuestion` 的字段与 pane 协议 v1 的 `FormQuestion` 相同，见 [tasks.md](tasks.md#数据模型)） | “不答复，取消提问” | `answer` 或 `cancel`（用户级） |
| 发给用户的决策请求（会议、中断任务） | `agora:decision:<id>` | 选项来自决策请求 | 无 | `decide` 或 `recover`（用户级） |
| CLI 等发起的待确认 | `agora:confirmation:<confirmationId>` | 操作内容、发起方、过期时间 | “拒绝” | 签名后执行；取消为 `cancel` |
| 待批准设备 | `agora:device:<deviceId>` | 新设备标签、公钥指纹、请求时间 | “拒绝” | `approve` 或拒绝（用户级） |
| 子会话的扩展对话框（`childUiPolicy = "pending"` 时） | `agora:ui:<runId>:<uiRequestId>` | 原对话框的标题和选项 | “取消” | 回应该对话框 |

规则：

- `FormSpec.revision` 取 daemon 中对象的 `revision`；`nodeId` 填相关的树节点；`expiresAt` 只用于显示。
- **提交**：`forms.submit(submission, origin)` 中，用户级事项先用 `origin` 调 `ctx.userPresence.confirm()`（确认框出现在提交的标签页），再把签名交给 daemon。结果映射（`FormSubmitResult`）：成功为 `accepted`；`202` 且尚未结束（等待用户确认、处理中）为 `pending`；`409 already_handled` 为 `alreadyHandled`；`revision` 落后为 `stale`（附新表单）；`409 idempotency_mismatch` 为 `idempotencyConflict`；其他错误为 `failed`。
- **关闭显示与取消**：用户关闭弹窗（dismiss）不通知插件，事项仍待处理。用户点 `cancel` 按钮提交的 `{ status: "cancelled" }` 是明确的业务结果：提问被取消且不视为同意，待确认变为 `cancelled`，设备批准变为拒绝。取消提问同样是用户级操作。
- **过期与移除**：由 daemon 统一裁定。事项被处理、取消、过期或撤回（如召集人已答复、CLI 已确认）后，daemon 推送变更，插件调用 `ctx.formRemoved(id, reason)`，`reason` 对应 `handled`、`cancelled`、`expired`、`withdrawn`。插件启动或重连时 `forms.pending()` 从 daemon 重新列出。
- **并发**：多个标签页、多台设备或 CLI 同时处理同一事项时 daemon 只接受一次（按 `revision` 条件更新），其余返回 `alreadyHandled`。
- 取消、过期都不算同意。

### 通知

pane 插件以 `host:pane` 身份长轮询 `/v1/inbox`，把发给用户的通知（转交的提问、中断、会议决策请求和排队提示、存档校验异常、后台完成的用户确认结果）转成 `PaneNotification`，展示后 ack。需要处理的事项同时作为持久表单进入“待处理”。发给 Agent 召集人的通知由主会话里的 agora 扩展处理，pane 插件不重复展示，只更新对应节点。

### 安全状态横幅

daemon 的安全警告（规则见 [security.md](security.md#启动检查与安全警告)）由 pane 插件以**持久横幅**显示：`ctx.setBanner({ id, level: "error", title, body, actions, persistent: true })`（接口以 pi-pane `docs/plugin-api.md` 为准）。持久横幅由 pi-pane 落盘，pi-pane 重启后恢复，所有标签页顶部常驻，用户不能关闭，直到插件显式 `clearBanner(id)`。来源插件不可用（未加载、停用、初始化失败）时，pi-pane 保留横幅并附加“来源不可用，无法确认状态”。

| 横幅 id | 内容 | 动作 | 清除条件 |
| --- | --- | --- | --- |
| `agora:security:devices-reset` | 检测时间、来源（离线命令 / 未知修改）、当前配对设备的标签和指纹、警告 `revision` | “我已知悉”：调用 `POST /v1/security/alerts/:alertId/acknowledge`（带横幅显示的 `revision`），签名走通用确认流程 | 插件从 daemon 收到该警告变为已知悉的变更后清除；`revision` 更新时用新内容替换横幅 |
| `agora:security:protection-off` | “用户确认已关闭，无法区分你和 Agent 的操作” | 无（不能确认知悉） | daemon 报告保护已重新开启后清除 |

插件的规则：

- **只按 daemon 的确定状态清除**：只有从 daemon 读到（`GET /v1/security/alerts` 或变更流）警告已解除时才调用 `clearBanner`。daemon 不可达、插件刚启动还没连上 daemon、读取失败时，一律不清除，保持原横幅。
- **重连对齐**：插件启动、重连 daemon、变更流 `reset` 后，先读 `GET /v1/security/alerts`，为每条未解除的警告 `setBanner`（同 id 整条替换），再清除 daemon 已明确报告解除的横幅。
- 插件不在本地缓存“已解除”的判断。

### 渲染安全

board 正文、对话内容、提问文字都来自模型，按不可信内容处理。pane 插件只提供 Markdown 和纯文本，不提供 HTML；渲染规则（禁用原始 HTML、过滤危险 URL scheme、远程图片策略、CSP）由 pi-pane 执行，见其 `docs/architecture.md`。

## 离线存档读取

daemon 不在线时（`/v1/health` 连接失败），pane 插件和 CLI 改用 archive adapter（见 [archive.md](archive.md#只读-archive-adapter)）：

- 树：`listSessions` 和 `getMeeting` 构造节点，`availability` 全部为 `archived`（文件缺失的为 `missing`）；session 节点的 `capabilities` 只有 `open`，其他节点为空。
- 会话内容：`readUserView` + `readPartials` 构造会话快照，与在线时的用户聊天视图相同；只读。
- board：`listBoardEntries` 构造 `timeline` 面板内容。
- 不提供动作和用户级操作；“待处理”区中 agora 的表单保留显示，提交时提示“agora 未运行”。
- 每 15 秒重试 `/v1/health`，daemon 恢复后发树 `reset` 并切回在线模式。

pane 插件和 CLI 不直接读 SQLite 表，不解析 `AGORA_HOME` 下的文件布局，全部通过 adapter。

pane 插件与 pi-pane 服务端在同一进程里运行，pi-pane 对插件调用只做合作式的异步超时，同步的长时间计算会卡住整个服务端。所以插件和 adapter 都不做同步重计算：`node:sqlite` 的同步查询都带 `LIMIT`，会话文件用流式异步读取并分页，单次处理的条目数有上限。

## 版本协商

三处版本独立演进，分别由不同方维护：

| 层 | 归属 | 标识 | 当前 |
| --- | --- | --- | --- |
| daemon HTTP API | pi-agora（本文） | `Agora-Protocol` 请求头；`/v1/health` 返回 `protocol: { min, max }` | 1 |
| archive adapter | pi-agora（[archive.md](archive.md)） | `openArchive({ apiVersion })` | 1 |
| pane 协议 | pi-pane（`docs/plugin-api.md`） | 插件声明 `paneProtocol: [min, max]`，pi-pane 协商 | 1 |

pi-hostkit 是独立仓库，版本为 0.x，不发布到 npm，使用方以 git 依赖或本地路径安装。会话写锁协议的版本见 [pi-hostkit 设计文档的“外部写者与协议版本”](https://github.com/PosvdM/pi-hostkit/blob/main/docs/design.md#外部写者与协议版本)。

daemon HTTP API：

```json
GET /v1/health
{ "daemonVersion": "0.1.0", "instanceId": "in_5f2c", "protocol": { "min": 1, "max": 1 } }
```

- 主机与 launch 连接都先读取 `/v1/health`，校验协议范围并选择双方区间交集中的最大值，固定为该连接之后每个请求（包括认证、业务和续期）的 `Agora-Protocol` 头。主机连接还核对 health、发现记录与握手中的 instanceId 一致，并按 host.key 验证 serverProof；health 不能替代身份认证。
- 没有交集时，在发送 clientProof 或 launch ticket 前拒绝连接，明确提示协议不兼容；不会因版本不兼容而自动启动另一个 daemon。
- 没有交集：daemon 返回 `426 protocol_unsupported`，`details` 里带 daemon 的区间；主会话扩展提示用户升级哪一方，CLI 提示运行 `agora shutdown` 后用新版本启动。
- 增加可选字段、增加端点不升版本；删除或改变字段语义才升版本。daemon 至少同时支持当前和上一个版本。

archive adapter：`apiVersion` 只在返回结构不兼容时递增，旧版本保留至少一个大版本。

pane 协议：协商规则见 pi-pane 的 `docs/plugin-api.md`。`packages/pane-plugin` 声明自己支持的 `paneProtocol` 范围；pi-pane 升级 pane 协议时，只需更新 `pane-plugin`，daemon 和其他包不受影响。
