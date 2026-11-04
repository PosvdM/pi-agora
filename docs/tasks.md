# 任务（子代理）

> 状态：设计草案。工具参数、状态名和默认值是草案，P0 验证后冻结。

任务是召集人派给一个协作会话（`kind = task`）的一件工作。它覆盖现有“派子代理”的核心用法：按模型和权限档位派任务、worktree 隔离、完成后叫醒召集人、steer 返工、查看列表和结果、停止、子代理提问并由召集人答复或转给用户。

进程、权限档位、worktree 的底层机制见 [architecture.md](architecture.md)。

## 工具一览

agora 扩展按连接 token 的权限注册工具。子代理功能只注册 `agora_task` 一个工具名，不设别名。

| 工具 | 谁能用 | 用途 |
| --- | --- | --- |
| `agora_task` | 主代理（`agent:main`） | 派任务、列表、取结果、返工、停止、清理 worktree |
| `agora_request` | 所有 agora 会话 | 子代理提问；召集人答复、转给用户、取消 |
| `agora_board` | 绑定了 board 的会话 | 读写共享桌面，见 [board.md](board.md) |
| `agora_meeting` | 主代理；参会者只有 `endorse` | 召开和管理会议，见 [meetings.md](meetings.md) |

MVP 不允许子代理再派子代理：协作会话的 token 没有 `agora_task` 权限。用户通过 CLI 或 pi-pane 也能执行 `agora_task` 的各项操作（以 `user` principal 身份）。

## `agora_task` 接口

```ts
// 草案，P0 后冻结
type AgoraTaskParams =
  | {
      action: "spawn";
      model: string;                 // 完整 provider/id，如 "<provider>/<model-id>"
      thinking?: ThinkingLevel;      // 默认 "high"
      profile: "explore" | "review" | "implement";
      prompt: string;                // 完整任务书，子代理看不到召集人的对话
      title?: string;                // 侧栏显示用，默认取 prompt 首行
      cwd?: string;                  // 默认召集人的 cwd
      isolation?: "none" | "worktree"; // 默认 "none"
      boardId?: string;              // 可选，挂到已有 board
      notify?: "wake" | "silent";    // 完成时是否叫醒召集人，默认 "wake"
    }
  | { action: "list"; status?: TaskStatus[]; scope?: "mine" | "all" }  // 默认 mine
  | { action: "result"; taskId: string; generation?: number }        // 默认最新一代
  | { action: "steer"; taskId: string; message: string; interrupt?: boolean }
  | { action: "stop"; taskId: string; reason?: string }
  | { action: "cleanup"; taskId: string; discard?: boolean };
```

返回值（工具结果的 `details`，同时给模型一段简短文本）：

```json
{
  "taskId": "tk_8f3a",
  "agoraSessionId": "as_c21e",
  "status": "running",
  "generation": 1,
  "worktree": { "path": "D:/repo/.worktrees/agora-tk_8f3a", "branch": "agora/tk_8f3a", "baseCommit": "4e1c9d0" }
}
```

各动作的语义：

- **spawn**：建任务、建会话、拉起进程、用 RPC `prompt` 发出任务书，立即返回，不等待完成。模型名在 spawn 时用 `get_available_models` 校验，无效则任务直接 `failed` 并说明原因。
- **list**：返回任务摘要（标题、模型、档位、状态、代数、最近活动时间、待答复提问数）。
- **result**：返回指定代的最终回复（RPC `get_last_assistant_text` 在 settled 时取得并存入 `task_generations`）、状态、worktree 信息、用量统计。任务仍在运行时返回当前状态和“尚无结果”。
- **steer**：见“返工 generation”。
- **stop**：先清空 pi 的队列（RPC `clear_queue`）再 `abort`，超时后终止进程树。任务进入 `stopped`。停止不回滚文件。
- **cleanup**：清理 worktree，规则见 [architecture.md](architecture.md#worktree)。

## 状态机

```text
                 ┌──────────────── steer（新一代）────────────────┐
                 ▼                                               │
created ──► running ──► completed ───────────────────────────────┤
              │  ▲  └─► failed ──────────────────────────────────┤
              │  │                                               │
              ▼  │ 答复送达                                      │
        waiting_decision                                         │
              │                                                  │
   任意运行态 ─┼─► stopped（stop）                                │
              └─► interrupted（崩溃 / 强制关闭）── 恢复 ──► running
                                     └── 放弃 ──► stopped
```

| 状态 | 进入条件 |
| --- | --- |
| `created` | 记录已写入，进程尚未就绪 |
| `running` | 任务书或返工消息已被 pi 接受（`prompt` 响应 `disposition: started` 或已排队） |
| `waiting_decision` | 会话 settled 时，该任务还有 `open` 或 `escalated` 状态的提问 |
| `completed` | 会话 settled、`aborted: false`、没有未决提问 |
| `failed` | 会话 settled 且最后一条助手消息是错误（如模型报错、重试耗尽），或 spawn 校验失败 |
| `stopped` | 召集人或用户调用 stop，或放弃中断的任务 |
| `interrupted` | 进程崩溃、心跳超时、daemon 强制关闭 |

判定完成只看 `agent_settled`，不看 `agent_end`：`agent_end` 之后 pi 仍可能重试、压缩或处理排队消息（依据：`docs/json.md`）。settled 只是判定的输入，还要结合提问状态和 `aborted` 标志，不能“一空闲就完成”。

## 返工 generation

每个任务有一个 `generation` 计数，从 1 开始。

- 对 `completed` 或 `failed` 的任务 steer：`generation + 1`，状态回到 `running`，用 RPC `prompt` 发送返工消息（会话空闲时）。
- 对 `running` 的任务 steer：不增加代数，用 RPC `steer` 排队。pi 的 steer 在当前助手回合的工具调用全部执行完后、下一次模型调用前送达，**不会打断正在执行的工具**（依据：`docs/rpc-commands.md` 的 `steer`）。
- `interrupt: true`：先 `abort` 当前运行，再以新一代发送消息。用于工具卡住、普通 steer 迟迟送不到的情况。
- 对 `waiting_decision` 的任务 steer：视同答复之外的追加指令，按 `running` 处理并唤醒会话。

steer 的送达状态分三步记录，界面上分开显示：`accepted`（daemon 已收到）、`queued`（pi 已排队，`queue_update` 事件可见）、`delivered`（对应用户消息的 `message_end` 已出现）。

每一代的结果单独保存在 `task_generations`（task_id、generation、started_at、settled_at、status、result_text、usage）。旧一代的结果不会被新一代覆盖。

## 完成通知与 outbox

### 写入

任务进入 `completed`、`failed`、`interrupted`、`waiting_decision`（有新提问）时，daemon 在**同一个 SQLite 事务**里：

1. 更新任务和代数记录；
2. 向 `outbox` 插入一条通知，`dedupe_key` 唯一。

| 事件 | `dedupe_key` |
| --- | --- |
| 完成 / 失败 | `task:<taskId>:<generation>:<completed|failed>` |
| 中断 | `task:<taskId>:<generation>:interrupted:<processRunId>` |
| 新提问 | `request:<requestId>:opened` |
| 提问被答复（发给提问者） | `request:<requestId>:answered` |

事务保证：要么状态和通知都写入，要么都没写入。daemon 在两者之间崩溃不会丢通知。

### 投递

- 接收方扩展长轮询 `GET /v1/inbox?after=<cursor>&wait=25`（见 [integration.md](integration.md)），拿到通知后用 `pi.sendMessage` 注入会话：

  ```ts
  pi.sendMessage(
    { customType: "agora:notice", content: "【agora 子代理事件】任务 tk_8f3a（第 1 代）已完成……", display: true,
      details: { noticeId, dedupeKey, taskId, generation } },
    { triggerTurn: true, deliverAs: "followUp" },
  );
  ```

  依据：`dist/core/extensions/types.d.ts` 的 `sendMessage`（`triggerTurn`、`deliverAs: "steer" | "followUp" | "nextTurn"`）；自定义消息在下一次模型请求前转成用户角色文本（`docs/message-types.md` 的 CustomMessage）。主代理空闲时立即开始新一轮；忙碌时作为 followUp 排队。

- 内容只放结果摘要（默认前 2000 字）和取全文的方法（`agora_task result`），明确标注是子代理事件，不冒充用户发言。
- **确认**：扩展监听 `message_end`，看到 `customType = "agora:notice"` 且 `details.noticeId` 匹配的消息后，调用 `POST /v1/inbox/ack`。只有确认后 daemon 才标记 `acked_at`。
- **去重**：重投时扩展先在当前会话条目里查找相同 `dedupeKey` 的 `agora:notice`，已存在就直接确认，不再注入。
- `notify: "silent"` 的任务仍写 outbox（供列表和待处理入口展示），但扩展注入时用 `triggerTurn: false`。

## 提问、答复与转交

### 数据模型

```ts
// 草案，P0 后冻结
interface AgoraRequest {
  id: string;                    // "rq_..."
  askerId: string;               // 提问的 principal
  targetId: string;              // 默认是提问会话的召集人
  taskId?: string;
  meetingId?: string;
  questions: RequestQuestion[];  // 1–3 题
  context?: string;
  state: "open" | "answered" | "escalated" | "cancelled" | "expired";
  escalatedTo?: string;          // 转交时为 user principal
  answers?: RequestAnswer[];
  answeredBy?: string;
  expiresAt?: string;            // 可选，ISO 时间
  createdAt: string;
  updatedAt: string;
}

interface RequestQuestion {
  id: string;
  question: string;
  header?: string;
  detail?: string;
  multiSelect?: boolean;
  options?: { label: string; description?: string; recommended?: boolean }[];
}

interface RequestAnswer { id: string; selected: string[]; custom?: string }
```

题目格式和 pi-pane 的表单一致，便于转给用户时直接渲染（见 [integration.md](integration.md#表单)）。

### 状态

```text
open ──► answered
  │
  ├──► escalated ──► answered
  │         └──────► cancelled / expired
  ├──► cancelled
  └──► expired
```

- **转给用户**（escalate）保留原 `requestId`，用户的答复回到同一个提问，提问者无需区分是谁答的。
- **取消、过期都不算同意**。提问者收到的结果明确写“未获答复”，任务书要求它停在安全状态，不得自行假设批准。

### `agora_request` 接口

```ts
// 草案，P0 后冻结
type AgoraRequestParams =
  | { action: "ask"; questions: RequestQuestion[]; context?: string; waitSeconds?: number } // 子代理用，默认等 240 秒
  | { action: "answer"; requestId: string; answers: RequestAnswer[] }                       // 召集人或用户
  | { action: "escalate"; requestId: string; note?: string }                                 // 召集人转给用户
  | { action: "cancel"; requestId: string }
  | { action: "list"; state?: AgoraRequest["state"][] };
```

`ask` 的行为：

1. 写入 `requests`，同事务写一条给召集人的 outbox 通知。
2. 工具调用最多等待 `waitSeconds`（默认 240）：期间收到答复就把答复作为工具结果返回。
3. 超时或被转给用户：工具返回“提问 rq_xxx 尚未答复（当前状态：open / escalated），答复到达后会以消息送达；在此之前停在安全状态”。提问保持原状态，转给用户后不再计时。
4. 会话 settled 时该提问仍未答复，任务进入 `waiting_decision`，进程可按回收规则停止。
5. 答复到达后，daemon 通过 outbox 把答复投递给提问会话（必要时重新拉起），任务回到 `running`。

这样子代理不必一直挂着一个长时间阻塞的工具调用，daemon 重启也不会丢失提问。

## 召集人离线时的行为

主会话关闭（终端退出、pi-pane 关闭会话）后，它的 principal 失去控制租约，但不注销。daemon 视为“召集人暂不可达”。

| 情况 | 行为 |
| --- | --- |
| 已授权、正在运行的任务 | 继续运行到 settled |
| 任务完成、失败 | 通知留在 outbox；召集人恢复会话并认领 principal 后补送 |
| 子代理提问 | 提问保持 `open`，任务进入 `waiting_decision`；同时出现在用户的“待处理”列表，用户可以直接答复（`answeredBy` 记为 user） |
| 需要新决策、增加预算 | 暂停等待，不自动继续 |
| 任务崩溃 | 停在 `interrupted`，通知进入“待处理”，见 [architecture.md](architecture.md#崩溃与恢复) |

“待处理”是 user principal 的收件箱视图：CLI 用 `agora pending` 查看，pi-pane 用侧栏面板显示（见 [integration.md](integration.md)）。用户可以：

- 答复提问、转回给召集人；
- 对中断的任务选择恢复、重开、换人或放弃；
- 接管任务：把任务的召集人改为 user，之后的通知都进入“待处理”。

召集人恢复后，补送的通知按产生顺序送达；已被用户处理的事项送达一条“已由用户处理”的说明，不再要求召集人决定。

## 中断任务的处理选项

召集人或用户对 `interrupted` 任务可以选择：

| 选项 | 效果 |
| --- | --- |
| `resume` | 用原会话文件重新拉起进程，发送中断说明（诊断摘要、最后确认的动作、可能已发生的副作用），由子代理核对现场后继续。代数不变 |
| `reopen` | 新建会话，`inherits_from` 指向原会话，`inherit_reason = reopen`；任务书 + 原会话最后结果摘要 + 诊断作为新会话的首条消息。代数 + 1 |
| `replace` | 同 reopen，但换模型或档位，`inherit_reason = replace` |
| `abandon` | 任务进入 `stopped`，保留 worktree 和存档 |

恢复不自动重放有副作用的工具。同一任务连续恢复失败 2 次（`maxRecoveryAttempts`）后不再接受 `resume`，只能 reopen、replace 或 abandon，并通知用户。
