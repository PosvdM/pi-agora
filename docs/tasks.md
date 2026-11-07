# 任务（子代理）

> 本文描述完整任务设计。切片 1a 提供 explore 档位的 spawn、status、result、stop 和可靠通知；其他动作按 [roadmap.md](roadmap.md) 推进。实现与测试见 [development.md](development.md)。

任务是召集人派给一个协作会话（`kind = task`）的一件工作。它覆盖现有“派子代理”的核心用法：按模型和权限档位派任务、worktree 隔离、完成后叫醒召集人、steer 返工、查看列表和结果、停止、子代理提问并由召集人答复或转给用户。

进程、权限档位、worktree 的底层机制见 [architecture.md](architecture.md)，各操作的访问控制见 [security.md](security.md#资源级访问控制)。

## 工具一览

agora 扩展按连接 token 的权限注册工具。子代理功能只注册 `agora_task` 一个工具名，不设别名。

| 工具 | 谁能用 | 用途 |
| --- | --- | --- |
| `agora_task` | 主代理（`agent:main`） | 派任务、列表、取结果、返工、停止、清理 worktree |
| `agora_request` | 所有 agora 会话 | 子代理提问；召集人答复、转给用户、取消 |
| `agora_board` | 绑定了 board 的会话 | 读写共享桌面，见 [board.md](board.md) |
| `agora_meeting` | 主代理；参会者只有 `endorse` | 召开和管理会议，见 [meetings.md](meetings.md) |

MVP 不允许子代理再派子代理：协作会话的 token 没有 `agora_task` 权限。用户通过 CLI 或 pi-pane 也能执行 `agora_task` 的各项操作，这类任务的召集人记为 `user`；其中属于用户级的操作（如处理转给用户的中断任务、接管）需要用户确认，见 [security.md](security.md#权限级别)。

## `agora_task` 接口

```ts
// 草案，P0 后冻结
type AgoraTaskParams =
  | {
      action: "spawn";
      model: string;                 // 完整 provider/id，如 "<provider>/<model-id>"
      thinking?: ThinkingLevel;      // 默认 "high"
      profile: "explore" | "review" | "implement"; // 各档位的工具和限制见 architecture.md“权限档位”
      prompt: string;                // 完整任务书，子代理看不到召集人的对话
      title?: string;                // 侧栏显示用，默认取 prompt 首行
      cwd?: string;                  // 默认召集人的 cwd
      isolation?: "none" | "worktree"; // 默认 "none"
      boardId?: string;              // 可选，挂到已有 board（调用方须是该 board 的 owner）
      notify?: "wake" | "silent";    // 完成时是否叫醒召集人，默认 "wake"
    }
  | { action: "list"; status?: TaskStatus[]; scope?: "mine" | "all" }  // 默认 mine
  | { action: "status"; taskId: string }                          // 当前任务详情
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
  "status": "created",
  "generation": 1,
  "worktree": { "path": "~/.pi/agora-worktrees/repo-1c9e2a7b/agora-tk_8f3a", "branch": "agora/tk_8f3a", "baseCommit": "4e1c9d0" },
  "warnings": ["主目录有 3 处未提交改动，不会带入 worktree"]
}
```

各动作的语义：

- **spawn**：建任务、建会话、拉起进程，等受管扩展就绪检查通过后用 RPC `prompt` 发出任务书（见 [architecture.md](architecture.md#受管扩展的就绪检查)），立即返回，不等待完成。模型名在 spawn 时用 `get_available_models` 校验，无效则任务直接 `failed` 并说明原因。推理名额不足时任务保持 `created` 排队，优先级低于会议（见 [architecture.md](architecture.md#名额优先级)）。
- **review 档位的 git 查询**：review 任务可以用 `agora_git` 看 `status`、`diff`、`log`、`show`。只读 git 命令也可能被仓库配置利用来执行代码，所以该工具固定禁用这些机制、只接受白名单参数，规则见 [architecture.md](architecture.md#agora_git-的加固)。
- **list**：返回任务摘要（标题、模型、档位、状态、代数、最近活动时间、待答复提问数）。`scope: "all"` 对主代理只返回摘要，见 [security.md](security.md#任务)。
- **status**：返回当前任务状态、generation、revision 和详情；访问权限与 result 相同。
- **result**：返回指定代的最终回复（RPC `get_last_assistant_text` 在 settled 时取得并存入 `task_generations`）、状态、worktree 信息、用量统计。任务仍在运行时返回当前状态和“尚无结果”。
- **steer**：见“返工 generation”。
- **stop**：取消当前运行，包括排队的消息：先 RPC `clear_queue`，再 `abort`（带超时，见 [pi-hostkit 设计文档的“进程树终止”](https://github.com/PosvdM/pi-hostkit/blob/main/docs/design.md#进程树终止)），等旧运行结束；abort 超时则终止进程树。任务进入 `stopped`。`clear_queue` 返回的排队文本中属于 agora 返工消息的，对应的 steer 记录标为 `dropped` 并在 stop 的结果里列出。停止不回滚文件。
- **cleanup**：清理 worktree，规则见 [architecture.md](architecture.md#worktree)。

agora 对任务只提供“取消（含队列）”这一种停止。协作会话的 pi 队列里只有 agora 自己发的消息，被清掉的消息都有记录，召集人可以重新发送。

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
| `created` | 记录已写入；排队等推理名额，或进程尚未通过就绪检查 |
| `running` | 任务书或返工消息已被 pi 接受（`prompt` 响应成功或已排队） |
| `waiting_decision` | 会话 settled 时，该任务还有 `open` 或 `escalated` 状态的提问 |
| `completed` | 会话 settled、`aborted: false`、没有未决提问 |
| `failed` | 会话 settled 且最后一条助手消息是错误（如模型报错、重试耗尽），或 spawn 校验、就绪检查失败 |
| `stopped` | 召集人或用户调用 stop，或放弃中断的任务 |
| `interrupted` | 进程崩溃、心跳超时、daemon 强制关闭、恢复时就绪检查失败 |

判定完成只看 `agent_settled`，不看 `agent_end`：`agent_end` 之后 pi 仍可能重试、压缩或处理排队消息（依据：`docs/json.md`、`docs/extensions.md` 的 Agent Events 一节）。settled 只是判定的输入，还要结合提问状态和 `aborted` 标志，不能“一空闲就完成”。

所有状态迁移都经过该任务的串行控制队列，并带 `expectedGeneration`、`expectedRevision` 做条件更新（见 [architecture.md](architecture.md#控制队列与并发)）。停止进行中时，通知投递和 board 投递不会唤醒该会话。

## 返工 generation

每个任务有一个 `generation` 计数，从 1 开始。

- 对 `completed` 或 `failed` 的任务 steer：`generation + 1`，状态回到 `running`，用 RPC `prompt` 发送返工消息（会话空闲时）。
- 对 `running` 的任务 steer：不增加代数，用 RPC `steer` 排队。pi 的 steer 在当前助手回合的工具调用全部执行完后、下一次模型调用前送达，**不会打断正在执行的工具**（依据：`docs/rpc-commands.md` 的 `steer`）。
- `interrupt: true`：先 `clear_queue`，再 `abort`（带超时），等旧运行结束（`agent_settled`，超时则终止进程树后用 `--session` 重新拉起），再以新一代发送消息。用于工具卡住、普通 steer 迟迟送不到的情况。
- 对 `waiting_decision` 的任务 steer：视同答复之外的追加指令，按 `running` 处理并唤醒会话。

### 送达追踪

pi 的 `queue_update` 事件只给出排队消息的文本（依据：`docs/json.md`），同样的文本可能出现多次，按文本匹配有歧义。所以 daemon 给每条返工消息分配 `steerId`，并在消息第一行加标注 `【agora 返工 st_xxxx，第 n 代】`；送达状态按这个标注匹配：

| 状态 | 判定 |
| --- | --- |
| `accepted` | daemon 已收到并写入 `steer_messages` |
| `queued` | `steer` 命令成功，且 `queue_update` 的 `steering` 中出现带该 `steerId` 的文本 |
| `delivered` | 出现角色为 user、文本带该 `steerId` 的 `message_end` |
| `dropped` | 被 `clear_queue` 清掉（返回的文本中带该 `steerId`），或运行在送达前被中止 |

界面上分开显示这几种状态。标注会被模型看到，这是为了可靠追踪付出的小代价。

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
| 工具无进展 | `task:<taskId>:stall:<toolCallId>:<n>` |
| 新提问 | `request:<requestId>:opened` |
| 提问被答复（发给提问者） | `request:<requestId>:answered` |

事务保证：要么状态和通知都写入，要么都没写入。daemon 在两者之间崩溃不会丢通知。

### 三种状态

| 状态 | 含义 | 依据 |
| --- | --- | --- |
| 已生成 | outbox 中有这条通知 | 上面的事务 |
| 已写入会话 | 接收方的会话文件（磁盘上的 JSONL）里有一条完整的、带该 `dedupeKey` 的 `agora:notice` 记录 | 扩展在会话文件中核实后，调用 `POST /v1/inbox/ack`（带 entryId） |
| 已处理 | 接收方对该事项采取了业务动作（取了结果、答复了提问、做了决定） | 对应的业务请求 |

重投只看“已写入会话”：没有写入就一直重投。“已处理”只用于列表里的未处理计数和“待处理”，不影响投递。

### 投递

- **收取**：`GET /v1/inbox?wait=25` 从发给当前 principal 的全部未确认通知中，按创建时间、id 顺序返回当前可见的一批，每批最多 200 条，不使用游标。daemon 在返回时给每条通知设可见性超时（默认 120 秒），超时前不再返回；超时后仍未确认的会再次返回。扩展收到非空批次后连续用 `wait=0` 拉取，直到空批，再恢复长轮询；在 `session_start` 和 `agent_settled` 时也立即执行同一批量收取流程。这是至少一次投递，重复通知按 `dedupeKey` 去重，不把批次边界或已返回响应当作确认。
- **注入**：扩展拿到通知后，先在当前会话条目（`ctx.sessionManager.getEntries()`，依据：`dist/core/session-manager.d.ts` 的 `ReadonlySessionManager`）中查找相同 `dedupeKey` 的 `agora:notice`：已存在就不再注入（是否确认按下面的规则）；不存在才注入：

  ```ts
  pi.sendMessage(
    { customType: "agora:notice", content: "【agora 子代理事件】任务 tk_8f3a（第 1 代）已完成……", display: true,
      details: { noticeId, dedupeKey, taskId, generation, nodeId } }, // nodeId 供 pi-pane 的卡片链接
    { triggerTurn: true, deliverAs: "followUp" },
  );
  ```

  依据：`dist/core/extensions/types.d.ts` 的 `sendMessage`（`triggerTurn`、`deliverAs: "steer" | "followUp" | "nextTurn"`）；自定义消息在下一次模型请求前转成用户角色文本（`docs/message-types.md` 的 CustomMessage）。主代理空闲时立即开始新一轮；忙碌时作为 followUp 排队。
- **确认归属**：待确认集合只接纳当前鉴权 inbox 返回的 noticeId / dedupeKey，不把会话文件中的历史通知直接视为本 principal 的通知。fork 继承的父会话通知只作历史展示，不能由新 principal 确认；服务端仍严格核对接收方。单条通知永久失效（404 / 410）从本地待确认集合移除，不阻断后续 inbox 收取。
- **确认以会话文件为准**：扩展看到 `message_end` 时**不确认**，因为 pi 先把 `message_end` 发给扩展，再写入会话文件（依据：`dist/core/agent-session.js:760–779`），这期间进程退出会丢失这条消息。`getEntries()` 里出现也**不够**：新会话在出现第一条 user 或 assistant 消息之前，条目只在内存里，会话文件还不存在（依据：`dist/core/session-manager.js` 的 `_persist`、`_hasConversation`）。所以扩展在 `turn_end`、`agent_settled` 和每次拉取时：
  1. 在 `getEntries()` 里找到带该 `dedupeKey` 的条目，取得 entryId；
  2. 读 `ctx.sessionManager.getSessionFile()` 指向的文件（只读、从文件末尾向前扫描），确认文件存在，且有一行完整的 JSON 是该 entryId 的 `custom_message` 条目；
  3. 两步都满足才调用 `POST /v1/inbox/ack`。会话文件尚未首次落盘时不确认，通知留在 outbox，等会话出现第一条对话消息、文件写出后再确认；期间进程退出，通知会在恢复后重新注入。
- **静默通知**：`notify: "silent"` 的任务仍写 outbox（供列表和“待处理”展示），扩展注入时用 `triggerTurn: false`。会话空闲时这类消息直接写入会话，不经过扩展的消息事件（依据：`dist/core/agent-session.js` 的 `_appendCustomMessage`），所以同样只能靠检查会话条目来确认。
- **不持久化的主会话**：主会话以 `--no-session` 运行时（`ctx.sessionManager` 没有会话文件），通知永远无法写入文件。扩展注册 principal 时声明 `ephemeral: true`；对这类 principal，通知出现在 `getEntries()` 后即以 `persisted: false` 确认，daemon 记为“只送达内存会话”。ephemeral principal 无法在进程退出后认领，进程退出后它召集的任务按“召集人不可达”处理，未处理的事项进入用户的“待处理”。
- **被清掉的通知**：主会话里用户按停止（`clear_queue`）会清掉排队中的 `agora:notice`。扩展在内存里记录“已注入、尚未写入会话”的通知；在 `agent_settled` 时仍未写入的，从记录里移除，等可见性超时后重新注入。pane 和 agora 停止时都用 `clear_queue` + `abort`，这条路径实测通知只落盘一条。第三方 RPC 客户端如果只发 `abort`，排队中的通知仍在 pi 队列中（尚未写入会话），settled 时查不到条目便会重投，导致同一通知在下一轮和原队列中的通知各写一条（P0 实测复现，见 [D 组 RESULTS.md](../experiments/p0/d-notify/RESULTS.md)）；这是已知偏差，展示时统一按 `dedupeKey` 去重。
- 模型可见的正文固定包含 taskId、generation、标题、状态，以及带 taskId / generation 参数的 `agora_task` result 调用方法，再附最多 2000 字的摘要。pi 的模型投影不保留 details，因此定位信息不能只放 details；details 继续供界面卡片使用。正文明确标注为子代理事件，不冒充用户发言。

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
  answeredVia?: {                // 答复者是 user 时由 daemon 填写，来自审计记录
    confirmedBy: "device" | "none"; // none：userConfirmation = off
    deviceId?: string;
    deviceLabel?: string;
    requestedBy: string;         // 发起答复的 principal，如 host:pane、host:cli
    at: string;
  };
  expiresAt?: string;            // 可选，ISO 时间
  revision: number;
  createdAt: string;
  updatedAt: string;
}

interface RequestQuestion {
  id: string;
  question: string;              // Markdown
  header?: string;
  detail?: string;
  multiSelect?: boolean;
  options?: { label: string; description?: string; recommended?: boolean; preview?: string }[];
  allowCustom?: boolean;         // 默认 true：允许“其他”自由输入
  dependsOn?: { questionId: string; value?: string | string[] };  // 前一题答案匹配时才显示
}

interface RequestAnswer { id: string; selected: string[]; custom?: string }
```

`RequestQuestion` 的字段与 pane 协议 v1 的 `FormQuestion` 相同（名称、类型和默认值以 pi-pane 仓库的 `docs/plugin-api.md` 为准；`allowCustom` 缺省为 `true`），转给用户时逐字段复制即可渲染；映射方式见 [integration.md](integration.md#表单)。pane 协议以后给 `FormQuestion` 增加的字段，agora 在升级 `paneProtocol` 时再决定是否跟进，未跟进的字段取 pane 的缺省值。daemon 校验 `dependsOn` 指向同一提问中排在前面的题目，`allowCustom: false` 时拒绝带 `custom` 的答复。核心包不引用 pi-pane 的类型，`RequestQuestion` 在 `packages/protocol` 中独立定义。

用户答复（无论来自 CLI 还是 pi-pane）都是用户级操作，需要已配对浏览器签名确认，并写入审计；提问详情和提问者收到的通知里显示 `answeredVia`，如“由用户答复（设备：工作电脑 Chrome，2026-11-05 10:21）”。见 [security.md](security.md#用户确认)。

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
- 同一提问并发答复时只接受一次（按 `revision` 条件更新），其余返回 `409 already_handled`。

### `agora_request` 接口

```ts
// 草案，P0 后冻结
type AgoraRequestParams =
  | { action: "ask"; questions: RequestQuestion[]; context?: string; waitSeconds?: number } // 子代理用，默认等 240 秒
  | { action: "answer"; requestId: string; answers: RequestAnswer[] }                       // 召集人
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
| 子代理提问 | 提问保持 `open`，任务进入 `waiting_decision`；同时进入用户的“待处理”，用户可以直接答复（用户级，`answeredBy` 记为 user，并记录 `answeredVia`） |
| 需要新决策、增加预算 | 暂停等待，不自动继续 |
| 任务崩溃 | 停在 `interrupted`，通知进入“待处理”，见 [architecture.md](architecture.md#崩溃与恢复) |

“待处理”是发给用户的事项：CLI 用 `agora pending` 查看，pi-pane 以持久表单列在它唯一的“待处理”区（见 [integration.md](integration.md#表单)）。用户可以：

- 答复提问、转回给召集人；
- 对中断的任务选择恢复、重开、换人或放弃；
- 接管任务：把任务的召集人改为 user，之后的通知都进入“待处理”。

这些都是用户级操作：在 pi-pane 里点击后由浏览器确认；在 CLI 里只生成待确认（见 [security.md](security.md#经-cli-发起)）。

召集人恢复后，补送的通知按产生顺序送达；已被用户处理的事项送达一条“已由用户处理”的说明，不再要求召集人决定。

## 中断任务的处理选项

召集人或用户对 `interrupted` 任务可以选择：

| 选项 | 效果 |
| --- | --- |
| `resume` | 用原会话文件重新拉起进程，发送中断说明（诊断摘要、最后确认的动作、可能已发生的副作用），由子代理核对现场后继续。代数不变 |
| `reopen` | 新建会话，`inherits_from` 指向原会话，`inherit_reason = reopen`；任务书 + 原会话最后结果摘要 + 诊断作为新会话的首条消息。代数 + 1 |
| `replace` | 同 reopen，但换模型或档位，`inherit_reason = replace` |
| `abandon` | 任务进入 `stopped`，保留 worktree 和存档 |

- `resume` 之前，原会话的所有旧 run 必须已确认退出（按进程身份检查，见 [architecture.md](architecture.md#daemon-崩溃或重启)），并重新取得会话写锁；否则返回 `409 invalid_state`。
- 恢复不自动重放有副作用的工具。同一任务连续恢复失败 2 次（`maxRecoveryAttempts`）后不再接受 `resume`，只能 reopen、replace 或 abandon，并通知用户。
