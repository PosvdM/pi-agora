# 任务（子代理）

> 切片 1c 提供任务核心、多层委派、三个权限档位、worktree、提问与逐级转交、skill 白名单、用量记录、额度暂停、任务树软预算、设备签名确认和显式用户接管。浏览器配对与确认界面在切片 2 接入，1c 由测试签名器验收；仅使用终端时需离线关闭保护。board 和会议按后续切片提供。实现与测试映射见 [development.md](development.md)。

任务是召集人派给一个协作会话（`kind = task`）的一件工作。它覆盖现有“派子代理”的核心用法：按模型和权限档位派任务、worktree 隔离、完成后叫醒召集人、steer 返工、查看列表和结果、停止、子代理提问并由召集人答复或转给用户。

进程、权限档位、worktree 的底层机制见 [architecture.md](architecture.md)，各操作的访问控制见 [security.md](security.md#资源级访问控制)。

## 工具一览

agora 扩展按连接 token 的权限注册工具。子代理功能只注册 `agora_task` 一个工具名，不设别名。

| 工具 | 谁能用 | 用途 |
| --- | --- | --- |
| `agora_task` | 主代理及任务子代理（最终就绪后） | 派任务、列表、取结果、返工、停止子树、清理 worktree、恢复、调整软预算 |
| `agora_request` | 所有 agora 会话 | 子代理提问；召集人答复、转给用户、取消 |
| `agora_board`（后续切片） | 绑定了 board 的会话 | 读写共享桌面，见 [board.md](board.md) |
| `agora_meeting`（后续切片） | 主代理；参会者只有 `endorse` | 召开和管理会议，见 [meetings.md](meetings.md) |

任务子代理可以继续派出下级。默认层数为 2（子代理、孙代理），每个任务同时存在的未结束下级数默认不限，整棵树共用并发名额。配置、主代理派活和下级派活可以逐层收紧，不能放宽；下级档位不能高于父任务，skill 名单只能取父任务名单的子集。谁派的谁管理：子代理只能查看、返工、停止和答复自己直接派出的下级；主代理可查看、停止整棵树，但只返工直接下级。CLI 以 `host:cli` 身份操作；返工仅限召集人为 `user` 的任务，恢复 Agent 任务前必须由用户显式接管。接管后的边界见“用户接管”。

父任务 settled 时仍有未结束下级，进入 `waiting_children`，不交付最终结果，也不占推理名额。下级进入终态（完成、启动失败、fatal、异常退出、结果读取失败或停止）时，由统一的状态结算入口通知召集人。父任务处于 `waiting_children` 时，不论下级 `notify` 是否为 `silent`，均领取推理名额并通过通知启动真实回合；父进程已回收时重新拉起后投递。父任务不在等待下级时，静默消息只投递，不领取名额，也不延长空闲进程的存活时间；已回收进程的静默消息保留到下一次运行。额度暂停的未知重置时间提示与到时通知也通过同一调度入口。父任务自行核对并交出最终结果后才完成。停止父任务时逐层停止整棵子树，返回每层 StopReport。

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
      skills?: string[];            // 按名字选择用户 skill；未配置档位默认值时为空，[] 显式禁用
      title?: string;                // 侧栏显示用，默认取 prompt 首行
      cwd?: string;                  // 默认召集人的 cwd
      isolation?: "none" | "worktree"; // 默认 "none"
      notify?: "wake" | "silent";    // 默认 wake；父任务等待下级时始终叫醒
      maxDepth?: number;              // 以新任务为第一层的子树层数，不能超过父任务剩余层数
      maxChildren?: number | null;    // 每个任务同时存在的未结束下级数，null 为不限
      maxTokens?: number;              // 本任务及子树的累计软预算；下级只能收紧
    }
  | { action: "list"; status?: TaskStatus[]; scope?: "mine" | "all" }  // 默认 mine
  | { action: "status"; taskId: string }                          // 当前任务详情
  | { action: "result"; taskId: string; generation?: number }        // 默认最新一代
  | { action: "steer"; taskId: string; message: string; interrupt?: boolean }
  | { action: "stop"; taskId: string; reason?: string }
  | { action: "cleanup"; taskId: string; discard?: boolean }
  | { action: "limits"; taskId: string; maxTokens: number; expectedRevision?: number }
  | { action: "recover"; taskId: string; mode: "resume" | "reopen" | "replace" | "abandon"; model?: string; profile?: "explore" | "review" | "implement" };
```

返回值（工具结果的 `details`，同时给模型一段简短文本）：

```json
{
  "taskId": "tk_8f3a",
  "agoraSessionId": "as_c21e",
  "status": "created",
  "generation": 1,
  "worktree": { "path": "~/.pi/agora-worktrees/repo-1c9e2a7b/agora-tk_8f3a", "branch": "agora/tk_8f3a", "base_commit": "4e1c9d0" },
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
- **limits**：调整自己直接下级的任务树软预算；主 Agent 在封顶内可直接增额，超出封顶发起用户确认。预算暂停后仍须明确 recover resume，不自动恢复下级。

agora 对任务只提供“取消（含队列）”这一种停止。协作会话的 pi 队列里只有 agora 自己发的消息，被清掉的消息都有记录，召集人可以重新发送。

### 派活与 skill 名单

任务书应只覆盖一件范围明确的工作，将必要的接口和结论直接摘入；并行前先确定接口，机械性工作使用 `medium`，完成的任务不追加新工作。daemon 发出的任务书固定以“你是子代理。”开头，包括重新拉起后的任务说明。全局和项目 `AGENTS.md` 仍由 pi 加载；只针对主会话的规则由其中的子代理约定跳过。

`spawn.skills` 按名字选择用户 skill，覆盖 `AGORA_HOME/config.json` 的 `defaultSkills` 对应档位名单；未指定且未配置时为空，显式 `[]` 禁用该档位默认值。下级名单必须是上级名单的子集；配置的默认值也受此限制。不存在、歧义或不可访问的名字在 spawn 返回 `400 skill_not_found`，越出上级名单返回 `403 skill_upgrade`。解析范围和文件访问规则见 [security.md](security.md#skill-白名单)。

### 用量与上下文

`status` 和 `result` 的 `usage` 汇总当前任务全部代数，`treeUsage` 汇总该任务及全部后代；`result.generationUsage` 只汇总请求的代数。字段为 `requests`、`inputTokens`、`cacheReadTokens`、`cacheWriteTokens`、`outputTokens`、`reasoningTokens`、`contextTokens`。result 的 `usage` 同时保留原 `get_session_stats` 数据（如 `tokens`、`cost`），新字段以逐请求记录为准。

每次模型请求结束记录一条用量，关联 taskId、generation、agoraSessionId、runId 和驱动提供的 requestId；重复事件不重复记账。禁止继续执行与接收用量分别控制：stop、额度暂停、预算暂停或中断返工的 abort 收尾期间，旧运行确认结束前收到的合法用量仍记入原任务、原代和原会话。复用进程时，在旧回合中断确认、开始新代回合后才切换记账代数；运行退出后拒收事件。输入、缓存读、缓存写、输出和推理 token 各字段分别按请求相加；预算计数不重复叠加推理 token，见“任务树软预算”。模型未单独返回推理 token 时记为 0，不把输出 token 推测为推理 token。`contextTokens` 取最近一次非零的 `input + cacheRead + cacheWrite`，代表服务最近报告的输入上下文大小；没有可用数据时为 0。任务树的上下文大小是各任务最近值之和，不是历史请求的输入总和，也不是模型上下文窗口上限。CLI 的专用展示在 1d，pane 展示在切片 2。

### 任务树软预算

每个任务的 `maxTokens` 限制该任务及全部后代的累计用量，跨 generation、会话替换和 daemon 重启保留。HTTP `POST /v1/tasks` 可指定 `maxTokens`；根任务省略时取数据库 `settings` 中的 `taskLimitDefaults.maxTokens`，子任务省略时继承父任务上限。下级不能超过任何祖先的预算，不单独预留或重复占用每日授予。根任务默认上限为 50,000,000 token，可在派活时显式收紧。

根任务的未签名授予受两项限制：主 Agent 的单树上限为 `taskLimitDefaults.maxTokens × agentLimitCap.perTaskFactor`，host 的单树上限为 `taskLimitDefaults.maxTokens`；所有 principal 共用同一数据目录的 `agentLimitCap.dailyTokens`。`perTaskFactor` 默认为 2，主 Agent 在封顶内可将单树提高到 100,000,000 token；`dailyTokens` 默认为 2,500,000,000 token，按授权额计算。超出任一限制均需设备签名；`userConfirmation = off` 产生的 `confirmedBy: "none"` 仍属于未签名授予，不能绕过封顶。

`budget_grants` 按本地日历日记录根任务的预算授予，创建时记全额，提高时只记新旧上限的正差额；调低、停止或清理均不退还当日授予。设备签名授予保留在账本中，但不占未签名日封顶。授予检查、账本与任务写入共用事务，不能通过并发创建或更换 principal 绕过。

预算计数使用逐请求去重后的 `treeUsage`。`tokenAccounting: "all"` 计入 `inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens`；`"uncached"` 排除 `cacheReadTokens`。`reasoningTokens` 单独展示，不额外叠加到预算计数中；默认口径为 `"all"`，包含 cacheRead，不按缓存价格折扣。`spawn`、`status`、`result` 和调整上限的响应包含 `budget`：`maxTokens`、`usedTokens`、`remainingTokens`、`tokenAccounting` 与 `ancestors`；`ancestors` 列出每个祖先的上限、用量和暂停标志，剩余值最低为 0，用量不截断。

任一任务或祖先累计用量达到上限时，daemon 将耗尽预算的任务及其子树内所有非终态任务置为 `budget_paused`，持久化 `task:budget_paused` 通知，并通过现有调度唤醒召集人；即使下级指定 `notify: "silent"`，预算暂停仍须处理。通知身份包含本次暂停后的 revision，同代增额恢复后再次耗尽会产生新事件；同一次暂停中的重复 usage 和停止尾量不重复通知。然后按任务控制队列执行 `clear_queue`、`abort` 和进程停止，释放名额并保存停止报告与诊断。已结束任务保留终态；停止期间的合法尾量仍按原任务、原代、原会话去重入账，可能超过上限。这是请求结束后执行的软预算，不能保证恰好在指定 token 数停止。

调度、spawn 下级、steer、通知唤醒、额度自动恢复和 recover 都检查当前任务及祖先预算。预算不足返回 `409 budget_exhausted`，下级上限超过祖先返回 `403 budget_limit_exceeded`。增额不会改变暂停状态；调用方须先补足相关预算，再显式 `recover`、`mode: "resume"`，且旧运行必须已确认退出。恢复父任务不会恢复任何下级；下级仍须由其直接召集人逐一决定。未曾启动的任务恢复时保留原任务书。

默认值按历史实现树与返工的请求用量校准：普通实现树约 2,900–3,200 万 token，较大实现树可超过 1 亿；每日封顶按创建和增额的授权额计算，不能以当天实际消耗替代。小任务应在派活时收紧预算。

上限可由 `agora_task` 的 `limits`、`POST /v1/tasks/:id/limits`、`{ "maxTokens": <正整数> }` 或 `agora task limits <任务 ID> --max-tokens <数量>` 调整；召集人为 `user` 的任务增额走用户确认。预算配置、签名要求和接管边界见 [security.md](security.md#任务预算与设置)。

用户接管后，尚交给子树外部 Agent 的提问同事务转给用户，保留原 requestId 与 asker 并增加 revision；子树内部的提问继续由内部直接接收方处理。旧 Agent 对这些问题不能继续读取、答复、取消或转交，问题列表也不再返回越过接管边界的记录。

### 额度暂停

驱动识别模型额度用完后，任务在 settled 时进入 `quota_paused`，不记为失败。daemon 停止该进程、保留原会话和代数并释放推理名额；停止未确认时保留清理记录并拒绝恢复。`quotaResumeAt` 记录服务返回的重置时间。识别规则由 [architecture.md](architecture.md#用量与额度事件) 定义。

默认 `quotaRecovery: "notify"`：到达重置时间后向直接上级发送持久化的 `task:quota_ready` 通知，附该上级最多 200 个暂停任务的上下文大小，其余任务可按状态分页查询，由上级调用 `recover`、`mode: "resume"` 续跑，或 stop 后重新派活。配置 `quotaRecovery: "auto"` 时，到期只续跑该任务，不递归续跑下级。重置时间缺失时不猜测时间，暂停状态、`task:quota_unknown` 通知及唤醒标记在同一事务中提交，等待上级核对后手动续跑。暂停事务提交后立即调度上级，再等待本任务停止；停止失败也不能阻止等待下级的上级收取提示。续跑仍要求旧运行已确认退出；停止进行中或内存通知前退出时，启动恢复会补投同一条 outbox，不生成重复提示。启动时也扫描尚无通知标记的未知时间暂停记录，按原运行去重键补建提示及标记，兼容已有的待通知暂停记录。重置时间未到的手动恢复返回 `409 quota_not_reset`。额度暂停任务只接受 resume 或 abandon；需换模型时先停止再派活。

`quota_paused` 与 `waiting_children` 不同：前者不能被下级完成、答复或普通 inbox 通知唤醒，后者可以。暂停进程直接停止，不依赖空闲回收定时器；暂停状态和重置时间跨 daemon 重启保留，到期通知按去重键只生成一次。停止父任务会递归停止额度暂停的下级并取消定时恢复；续跑父任务不会自动续跑任何下级。

## 状态机

```text
                 ┌──────────────── steer（新一代）────────────────┐
                 ▼                                               │
created ──► running ──► completed ───────────────────────────────┤
              │  ▲  └─► failed ──────────────────────────────────┤
              │  │                                               │
              ├────► quota_paused ── recover resume / 自动续跑 ──► running
              │             └── stop / abandon ──► stopped
              ├────► budget_paused ── 增额后显式 recover resume ──► running
              │             └── stop / abandon ──► stopped
              ▼  │ 答复送达                                      │
        waiting_decision / waiting_children                      │
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
| `waiting_children` | 会话 settled 时，该任务还有未结束的下级且没有未决提问；释放名额并等待通知 |
| `quota_paused` | 模型额度用完；不占推理名额，保留会话和代数，等待上级决定或配置的自动恢复 |
| `budget_paused` | 任务或祖先软预算耗尽；停止进程并释放名额，保留代数，增额后仍须显式恢复 |
| `completed` | 会话 settled、`aborted: false`、没有助手错误、未决提问或未结束的下级 |
| `failed` | 会话 settled 且最后一条助手消息是错误（已识别的额度暂停除外），或 spawn 校验、就绪检查失败 |
| `stopped` | 召集人或用户调用 stop，或放弃中断的任务 |
| `interrupted` | 进程崩溃、心跳超时、daemon 强制关闭、恢复时就绪检查失败 |

判定完成只看 `agent_settled`，不看 `agent_end`：`agent_end` 之后 pi 仍可能重试、压缩或处理排队消息（依据：`docs/json.md`、`docs/extensions.md` 的 Agent Events 一节）。settled 只是判定的输入，还要结合提问状态和 `aborted` 标志，不能“一空闲就完成”。

所有状态迁移都经过该任务的串行控制队列，并带 `expectedGeneration`、`expectedRevision` 做条件更新（见 [architecture.md](architecture.md#控制队列与并发)）。停止进行中时，通知投递和 board 投递不会唤醒该会话。

## 返工 generation

每个任务有一个 `generation` 计数，从 1 开始。

- 对 `completed` 或 `failed` 的任务 steer：`generation + 1`，状态回到 `running`，用 RPC `prompt` 发送返工消息（会话空闲时）。
- 对 `running` 的任务 steer：不增加代数，用 RPC `steer` 排队。pi 的 steer 在当前助手回合的工具调用全部执行完后、下一次模型调用前送达，**不会打断正在执行的工具**（依据：`docs/rpc-commands.md` 的 `steer`）。
- `interrupt: true`：先 `clear_queue`，再 `abort`（带超时），等旧运行结束（`agent_settled`，超时则终止进程树后用 `--session` 重新拉起），再以新一代发送消息。旧代若未进入终态，在切代的同一事务中封存为 `interrupted` 并记录结算时间；中断确认后尽量读取部分回复与会话统计，读取失败时保留已有数据。逐请求用量保留在原代，不转入新代。用于工具卡住、普通 steer 迟迟送不到的情况。
- 对 `waiting_decision` 或 `waiting_children` 的任务 steer：按同代追加指令处理，先取得名额再唤醒会话。

### 送达追踪

pi 的 `queue_update` 事件只给出排队消息的文本（依据：`docs/json.md`），同样的文本可能出现多次，按文本匹配有歧义。所以 daemon 给每条返工消息分配 `steerId`，并在消息第一行加标注 `【agora 返工 st_xxxx，第 n 代】`；送达状态按这个标注匹配：

| 状态 | 判定 |
| --- | --- |
| `accepted` | daemon 已收到并写入 `steer_messages` |
| `queued` | `steer` 命令成功，且 `queue_update` 的 `steering` 中出现带该 `steerId` 的文本 |
| `delivered` | 出现角色为 user、文本带该 `steerId` 的 `message_end` |
| `dropped` | 被 `clear_queue` 清掉（返回的文本中带该 `steerId`），或运行在送达前被中止 |

界面上分开显示这几种状态。标注会被模型看到，这是为了可靠追踪付出的小代价。

每一代的结果单独保存在 `task_generations`（task_id、generation、started_at、settled_at、status、result_text、usage）。旧一代的结果不会被新一代覆盖。`task_generations.agora_session_id` 记录该代所属会话；`tasks.agora_session_id` 只表示任务的当前会话。读取历史 result 时，会话标识取该代记录，不能用当前会话替代。

## 完成通知与 outbox

### 写入

任务进入 `completed`、`failed`、`interrupted` 或 `stopped` 时，daemon 在**同一个 SQLite 事务**里：

1. 更新任务和代数记录；
2. 向 `outbox` 插入一条通知，`dedupe_key` 唯一；按当前父任务状态同时保存 `triggerTurn`。父任务处于 `waiting_children` 时，即使下级选择静默通知，也必须启动父任务回合。

| 事件 | `dedupe_key` |
| --- | --- |
| 完成 / 失败 | `task:<taskId>:<generation>:<completed|failed>` |
| 中断 | `task:<taskId>:<generation>:interrupted:<processRunId>` |
| 工具无进展 | `task:<taskId>:stall:<toolCallId>:<n>` |
| 额度重置时间已到 | `task:<taskId>:<generation>:quota:<quotaResumeAt>` |
| 额度暂停但无重置时间 | `task:<taskId>:<generation>:quota_unknown:<runId>` |
| 主会话额度重置时间已到 | `main_quota:<pauseId>:ready` |
| 主会话额度暂停但无重置时间 | `main_quota:<pauseId>:unknown` |
| 主会话定时项到期 | `schedule:<scheduleId>:<revision>` |
| 主会话立即续跑（pi-pane 发起） | `continue:<requestId>` |
| 新提问 | `request:<requestId>:opened` |
| 提问被答复（发给提问者） | `request:<requestId>:answered` |

事务保证：状态、通知和强制唤醒决定共同提交或回滚。daemon 启动时扫描未确认的唤醒通知，按名额调度父任务；提交后、内存调度前退出不会丢失唤醒。

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
- **静默通知**：`notify: "silent"` 的任务仍写 outbox（供列表和“待处理”展示）。父任务等待下级时，daemon 在通知中标记 `triggerTurn: true` 并按推理名额调度；其他静默事件以 `triggerTurn: false` 投递，空闲子进程可在不领取名额的情况下收取这类事件。会话空闲时静默消息直接写入会话，不经过扩展的消息事件（依据：`dist/core/agent-session.js` 的 `_appendCustomMessage`），所以同样只能靠检查会话条目来确认。
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
  route: string[];               // 已经转交过的直接上级 principal
  answers?: RequestAnswer[];
  answeredBy?: string;
  answeredVia?: {                // 答复者是 user 时由 daemon 填写，来自可信确认入口
    confirmedBy: "device" | "none"; // none：userConfirmation = off
    deviceId?: string;
    confirmationId?: string;
    requestedBy: string;         // 发起答复的 principal，如 host:pane、host:cli
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

host 发起的答复和取消都是用户级操作，保护开启时需要设备签名确认并写入审计；保护关闭时仅 CLI 可走 `none` 通路。提问详情和通知的 `answeredVia` 返回实际确认方式、发起方、设备 ID 与确认 ID，证明持久保存在 `requests.answer_proof`，不接受调用方伪造。见 [security.md](security.md#用户确认)。

### 状态

```text
open ──► answered
  │
  ├──► escalated ──► answered
  │         └──────► cancelled / expired
  ├──► cancelled
  └──► expired
```

- **逐级转交**（escalate）保留原 `requestId`。下级先向直接上级提问，上级答不了时转给自己的召集人，直到主代理再转给用户。新提问和转交均通过鉴权 principal 找到所属任务，以任务树当前的 `tasks.convener_id` 解析直接上级，不使用会话创建时保存的上级关系；父任务 reopen / replace 后，现存下级也遵循当前任务树。`targetId` 表示当前接收方，`route` 保留经过的上级；答复始终送回原提问者。主代理自己的 ask 直接发给用户。
- **取消、过期都不算同意**。提问者收到的结果明确写“未获答复”，任务书要求它停在安全状态，不得自行假设批准。可选 expiresAt 由 daemon 定时裁定；转给用户后停止计时，工具的 waitSeconds 超时只返回 pending，不使提问过期。
- 同一提问并发答复时只接受一次（按 `revision` 条件更新），其余返回 `409 already_handled`。

### `agora_request` 接口

```ts
// 草案，P0 后冻结
type AgoraRequestParams =
  | { action: "ask"; questions: RequestQuestion[]; context?: string; waitSeconds?: number; expiresAt?: string } // Agent 用，默认等 240 秒
  | { action: "answer"; requestId: string; answers: RequestAnswer[] }                       // 召集人
  | { action: "escalate"; requestId: string; note?: string }                                 // 召集人转给用户
  | { action: "cancel"; requestId: string }
  | { action: "list"; state?: AgoraRequest["state"][] };
```

`ask` 的行为：

1. 写入 `requests`，同事务写一条给直接上级的 outbox 通知。路由按鉴权 principal 和委派关系确定，同项目的其他主会话不接收该提问；转交后才逐级改变目标。
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

这些操作使用用户级确认：保护开启时 CLI 生成待确认，由设备签名执行；浏览器界面在切片 2 接入。仅使用终端时，先停止 daemon，再执行 `agora offline set userConfirmation off`；关闭后无法区分用户与 Agent，实际操作记录 `confirmedBy: "none"`。不能把磁盘凭证当作用户身份。

召集人恢复后，补送的通知按产生顺序送达；已被用户处理的事项送达一条“已由用户处理”的说明，不再要求召集人决定。

## 主会话的上下文压缩

长任务中，主 Agent 分多个阶段派活和验收，用户可能不在场，只看最终交付。主会话的上下文随阶段增长，需要在合适的时机压缩，并且压缩后没有用户发消息也能继续工作。本节规定 agora 扩展在主会话中提供的支持，属于切片 1 之后的设计，尚未实现；标为“待定”的细节在实现前确定。下级任务的上下文超限处理见 [roadmap.md](roadmap.md#切片-1agora-任务核心) 的“1d 之后”。下文的 pi 依据均指 pi 1.5.2 的 `dist/core/agent-session.js` 和 `dist/core/extensions/types.d.ts`。

### 触发

- **主 Agent 主动压缩**：主 Agent 调用压缩工具（名称待定，下文记作 `agora_compact`），参数 `focus` 写下一阶段要保留的方案、接口约定、未完成的事项，以及可以丢弃的过程。工具只登记一次待执行的压缩并立即返回，压缩在主会话空闲后执行，见[执行时机](#执行时机)。压缩不在回合中途执行，因为 `ctx.compact()` 会先中止当前运行，并且不续跑被中止的回合（依据：`compact()` 开头的 `abort()`）。
- **阈值提醒**：扩展在主会话 `agent_settled` 时用 `ctx.getContextUsage()` 读取上下文大小（依据：`ContextUsage`）。超过 `mainCompaction.thresholdTokens`、提醒处于开放状态且没有待执行的压缩时，注入一条提醒，要求主 Agent 在派下一批任务前调用 `agora_compact`，然后关闭提醒。主会话有未结束的下级任务时，提醒以 `triggerTurn: true` 投递，立即开始新一轮；没有时（通常是用户在场对话），以 `deliverAs: "nextTurn"` 随下一轮送达，不主动开始回合。`tokens` 为 `null`（刚压缩完、还没有新的模型请求）时不判断。
- **提醒的开放状态**：初始为开放，发出提醒后关闭，在某次 `agent_settled` 读到的 `tokens` 低于阈值时重新开放。压缩后上下文仍高于阈值时提醒保持关闭，不会每次 settled 都提醒并反复压缩，之后由 pi 的自动压缩处理。
- **阈值范围**：阈值应低于 pi 自动压缩的阈值（`contextWindow - reserveTokens`），使主动压缩先于 pi 在回合中途发生、不带重点的自动压缩；还应高于压缩后的典型大小，即 pi 的 `keepRecentTokens` 加上总结和检查点的预估大小，否则压缩后提醒无法重新开放。扩展加载配置时校验这两项，不满足时记录警告。
- 压缩不要求下级全部结束。主会话 settled 时通常正在等待下级，此时压缩不影响下级运行。压缩期间通知的处理见[压缩期间的通知](#压缩期间的通知)。

### 执行时机

- 已登记待执行的压缩时，扩展在 `agent_settled` 的处理中不收取 inbox、不注入消息，只安排压缩。
- `agent_settled` 的处理结束后，pi 才执行处理期间推迟的操作，包括用户在此期间提交的提示和扩展以 `triggerTurn: true` 注入的消息（依据：`_emitAgentSettled` 与 `_deferredSettledActions`）。因此压缩不在 `agent_settled` 的处理中调用，而是在处理结束后的下一个事件循环中执行。执行前确认 `ctx.isIdle()` 为真、`ctx.hasPendingMessages()` 为假；不满足时说明新的运行已经开始，压缩保留到下一次 settled，避免中止这次运行。
- `agent_settled` 的 `aborted` 为真（用户中止了本次运行）时，取消待执行的压缩，并以 `deliverAs: "nextTurn"` 告诉主 Agent 压缩已取消。

### 执行

- 扩展调用 `ctx.compact({ customInstructions, onComplete, onError })`（依据：pi `docs/extensions.md` 的 `ctx.compact()`）。`customInstructions` 由主 Agent 的 `focus` 和 daemon 返回的协作状态组成。协作状态包括：该 principal 召集的任务树，各任务的 taskId、generation、状态和 worktree 分支，未确认的通知，未答复的提问。
- 协作状态有条数上限（默认值待定）：未结束的任务和未答复的提问逐条列出，超出上限的部分只给按状态汇总的数量，主 Agent 可用 `agora_task` 的 `list` 和 `agora_request` 的 `list` 查询其余条目。检查点使用同一份内容和上限。
- 压缩使用 pi 自带的总结流程和当前会话的模型，agora 不另选模型，也不自己生成总结。

### 压缩期间的通知

- 压缩期间 pi 只拒绝 `prompt()` 提交的提示，不拦截扩展消息：会话空闲时以 `triggerTurn: true` 调用 `sendMessage`，会直接开始新一轮，与正在进行的总结同时运行（依据：`prompt()` 的压缩检查只在 `prompt()` 中，`sendCustomMessage` 调用的 `_startRun` 不检查压缩状态）。因此由 agora 扩展保证压缩期间不注入：从开始执行压缩到收到成功或失败的结果，扩展停止 inbox 长轮询，也不注入任何通知。
- 压缩开始时仍在进行的长轮询如果返回了通知，扩展把这些通知留在内存中，压缩结束后先注入它们，再恢复收取。这些通知已经进入可见性超时，压缩结束后重新收取取不到，所以不能只靠重新收取。进程在此期间退出时，这些通知未确认，按可见性超时重投（见[投递](#投递)）。
- 滞留批次中的主会话额度通知、定时项和续跑通知不按上一条直接注入，进入[注入调度](#注入调度)的队列。压缩成功后，扩展先注入滞留的普通通知，再恢复收取，以便取得检查点；定时发送和续跑等检查点写入会话后才注入。压缩中止、失败或无需压缩时不生成检查点，扩展恢复收取，注入队列不再等待。

### 压缩后续跑

- 压缩成功后（扩展收到 `session_compact` 事件，依据：`SessionCompactEvent`），扩展请 daemon 生成一条检查点通知写入 outbox，`dedupeKey` 取压缩条目的 entryId。检查点按 daemon 的当前状态生成，不依赖总结是否准确：内容为上面的协作状态，以及一条提示，要求主 Agent 重新读取协作规则（如有）并继续压缩前的工作。pi 在发出 `session_compact` 时尚未解除压缩状态，所以 `session_compact` 的处理中只请求生成检查点，不注入；主动压缩的检查点在 `onComplete` 之后注入。
- 检查点的投递方式由压缩来源决定：
  - **主动压缩和阈值提醒引起的压缩**：主 Agent 预期压缩后继续工作。检查点以 `triggerTurn: true, deliverAs: "followUp"` 投递，会话空闲时不需要用户发消息就开始新一轮；压缩结束后已有新的运行时，检查点排在该运行之后。
  - **pi 的自动压缩**：发生在两个位置。一是下一次模型请求之前，压缩后这次请求照常发出，检查点经 daemon 生成，在这次请求发出之后才投递。二是运行结束时，压缩后只有队列中还有消息，运行才继续（依据：`_runAutoCompaction` 返回 `hasQueuedMessages()`），通常会话随即空闲。两种情况下检查点都以 `triggerTurn: false` 投递：会话运行中时，检查点在当前轮结束后写入会话，本次运行的后续请求会带上它，运行不会因此多一轮；会话空闲时，检查点直接写入会话，随下一轮被模型读到，不另起回合。
- 压缩失败时不自动重试：
  - `session_compact_failed` 的 `aborted` 为真时，压缩被中止，包括用户在压缩期间按停止（依据：`abort()` 会调用 `abortCompaction()`）。扩展只记录，不启动回合；中止的是主动压缩时，以 `deliverAs: "nextTurn"` 告诉主 Agent 压缩已取消。
  - 主动压缩因 `Already compacted` 或 `Nothing to compact` 失败时（依据：`compact()` 的准备步骤），按无需压缩处理：以 `triggerTurn: true` 注入一条“无需压缩”的说明，主 Agent 照常继续工作。
  - 主动压缩因其他原因失败时，以 `triggerTurn: true` 注入一条失败说明，附 pi 的错误信息，由主 Agent 决定是否再次压缩。
  - pi 的自动压缩失败时，pi 自己结束或报错，扩展只记录，不注入消息。
- 进程退出：
  - 检查点写入会话前退出：检查点留在 outbox，恢复后重投。
  - 压缩条目已写入会话、检查点尚未写入 outbox 时退出：扩展在 `session_start` 时检查当前分支上最新的压缩条目，会话中没有以其 entryId 为 `dedupeKey` 的检查点时，请 daemon 补生成；daemon 按 `dedupeKey` 去重，outbox 中已有时不重复生成。压缩条目是分支上最后一个条目时，会话停在压缩之后，检查点以 `triggerTurn: true` 投递；否则以 `triggerTurn: false` 投递。
  - 压缩完成前退出：不生成检查点。待执行压缩的登记只保存在扩展内存中，随进程丢失；会话恢复后上下文仍超过阈值时，由阈值提醒重新触发。

### pi 的自动压缩

`session_before_compact` 的处理结果只能取消压缩或提供完整的总结（依据：`SessionBeforeCompactResult`），不能只补充总结指令。因此 agora 不拦截 pi 的自动压缩，只在压缩后投递检查点。

### 无人值守时的记录

- 下级转给用户的提问和需要用户确认的事项照常进入“待处理”，不阻塞其他任务。
- 每次主会话压缩记录时间、触发方式（主动、阈值提醒、pi 自动）、结果（成功、无需压缩、失败、中止）、压缩前的 token 数（`tokensBefore`）、总结请求的用量（`usage`，pi 提供时）和检查点的投递结果，供用户事后查看。压缩条目本身在 pi 会话文件中，随全量存档保存。CLI 和 pane 中的展示位置待定。

### 配置与可迁移性

- `mainCompaction.enabled` 和 `mainCompaction.thresholdTokens` 的默认值待定；阈值按固定 token 数还是按模型上下文窗口的比例设置，也待定。
- `session_compact`、`session_compact_failed`、`ctx.compact()`、`ctx.getContextUsage()`、`ctx.isIdle()` 和 `ctx.hasPendingMessages()` 这些 pi 接口的调用限于 Harness 适配层，并登记到 [harness-portability.md](harness-portability.md)。上文依赖的 pi 行为（压缩前中止当前运行、settled 处理后执行推迟的操作、扩展消息不受压缩状态拦截）同样登记，换用其他 Harness 时逐项核对。

## 主会话的额度暂停、定时发送与续跑

主会话因模型额度用完而中断后，用户通常要等额度重置再继续。本节规定 agora 扩展和 daemon 为主会话提供的三项支持：

- **额度暂停**：识别并记录主会话因额度中断，到重置时间后提示用户或自动续跑。
- **定时发送**：用户写好消息，到指定时间（可以是“额度重置后”）发送到主会话。
- **续跑**：不加入新的用户消息，让被中断的回合从中断处继续；可以立即执行，也可以定时执行。

本节属于切片 1 之后的设计，尚未实现；标为“待定”的细节在实现前确定。pi-pane 本身不实现定时功能，pane 中的显示和操作由 agora pane 插件通过 pi-pane 现有的插件接口提供，见 [integration.md](integration.md#主会话的定时项与续跑)。下文的 pi 依据均指 pi 1.5.2。

本节的功能只适用于会话文件已经写出的主会话。以 `--no-session` 运行的主会话（ephemeral principal）无法在会话文件中确认投递，进程退出后也不能认领；新会话在第一条用户或助手消息之前没有会话文件（依据：`dist/core/session-manager.js` 的 `_persist`）。这两种情况下 daemon 拒绝为该会话登记额度暂停和定时项。

### 主会话的额度暂停

- **识别**：扩展在主会话 `agent_settled` 且 `aborted` 为假时，读取当前分支上最后一条助手消息及其 entryId。`stopReason` 为 `error`，并按 [architecture.md](architecture.md#用量与额度事件) 的规则识别为额度用完时，记为额度暂停。pi 的自动重试在 `agent_settled` 之前结束，重试成功的运行不会进入暂停。识别和重置时间解析放在共享包 `packages/harness-pi`，扩展和 daemon 使用同一份规则。
- **用户取消**：用户停止运行（`agent_settled` 的 `aborted` 为真），或在自动重试的等待期间取消重试（终端按 Esc、RPC `abort_retry`；pi 1.5.2 中 `abortRetry()` 发出 `success` 为假、`finalError` 为 `Retry cancelled` 的 `auto_retry_end`，此时 `aborted` 可能为假），且最后一条助手消息是额度错误时，扩展不登记暂停，用 `pi.appendEntry` 写入 `agora-quota-dismissed`（`{ errorEntryId }`）。这条记录不进入模型上下文，供重新扫描时识别已被用户放弃的额度错误。两种取消来源由适配层统一识别。
- **登记**：扩展调用 `POST /v1/main/quota-pauses`，以 principal、会话 id 和出错助手消息的 entryId 为幂等键。daemon 记录一条暂停（`pauseId`），包括会话文件、`quotaResumeAt`（未识别时为 null）、出错消息的 entryId、当时的[锚点](#锚点)，以及下文的续跑链。每条出错消息最多登记一次暂停：同一 entryId 的暂停已经结束或被替换时，再次登记返回原记录，不重新打开，也不再产生通知。
- **重新扫描**：扩展在 `session_start`、`session_tree` 和与 daemon 重新连接后检查当前分支：最后一条助手消息是额度错误，且其后没有对应的 `agora-quota-dismissed` 时，登记暂停，daemon 按幂等键去重；daemon 中该会话未结束的暂停不再有效（见下一条）时，结束该暂停。这样，助手消息落盘后、登记或结束完成前扩展退出，也不会遗漏。
- **每个主会话最多一条未结束的暂停**：登记新暂停时，旧暂停在同一事务中记为 `replaced`，尚未投递的旧通知一并撤回。
- **有效与结束**：暂停只在当前分支上最后一条助手消息仍是其出错消息、其后没有 `agora-quota-dismissed` 时有效。扩展在 `agent_settled`、用户取消和重新扫描时发现暂停不再有效（出现了新的助手消息，不论正常结束、被中止还是出错；用户取消；`/tree` 切到其他分支），调用 `/end`，暂停记为 `ended`，尚未投递的通知撤回。主会话进程不因暂停而停止，用户随时可以发消息。
- **到重置时间**：daemon 为有 `quotaResumeAt` 的暂停设置定时器，启动时从数据库恢复。触发事务只在暂停仍未结束、`quotaResumeAt` 未变时，向所属 principal 的 outbox 写入 `main_quota:<pauseId>:ready`，通知带 `pauseId` 和出错消息的 entryId。扩展按[投递](#投递)的规则收取后先复核：暂停在本地仍然有效，并且向 daemon 查询该 `pauseId` 仍是该会话未结束的暂停。通知可能在暂停被替换或结束之前已经收取，所以不能只依赖撤回。复核不通过时以 `outcome: "obsolete"` 确认（见[投递结果](#投递结果)），不做任何事。复核通过时：
  - `quotaRecovery: "notify"`（默认），或续跑链已达上限：用扩展 UI 通知（`ctx.ui.notify`）提示额度已重置，可以续跑，以 `outcome: "uiNotified"` 确认。
  - `quotaRecovery: "auto"`：把一次自动续跑放进[注入调度](#注入调度)，锚点为暂停记录中的锚点，`dedupeKey` 取这条通知的 `dedupeKey`，执行后按会话文件中的标记确认。注入前再次确认暂停仍然有效。
- **重置时间未知**：不设定时器、不推测时间，登记后立即写入 `main_quota:<pauseId>:unknown`。扩展用扩展 UI 通知说明重置时间未知，由用户手动续跑或定时，以 `outcome: "uiNotified"` 确认。
- **续跑链**：用来限制连续自动续跑的次数。登记暂停时，扩展从出错消息向前找最近的一条用户消息或 `agora:continue` 标记，跳过其他自定义消息（通知、`nextTurn` 消息、`before_agent_start` 处理器写入的消息）。找到的是 `auto` 为真的标记时，暂停沿用标记中的 `chainId` 和 `attempt`；找到用户消息（包括运行中 steer 或 followUp 的用户消息）、`auto` 为假的标记或找不到时，开始新链，`attempt` 为 0。因此用户发消息、手动续跑和定时续跑都会切断链。每条暂停最多引起一次自动续跑：标记的 `dedupeKey` 取 `main_quota:<pauseId>:ready`，注入前按[注入前去重](#定时项)的规则在会话文件中查找，已有时不再注入；标记中的 `attempt` 为暂停记录的 `attempt` 加 1。暂停记录的 `attempt` 已达到 `mainSchedule.autoContinueLimit` 时只发通知。判定只依赖会话文件中的条目，跨进程重启和重新扫描时结果相同。
- `quotaRecovery` 同时适用于下级任务和主会话，配置见 [architecture.md](architecture.md#用量与额度事件)。

### 投递结果

本节的通知都经 outbox 投递。持久会话的确认仍以会话文件为准（见[投递](#投递)）；部分通知不在会话中写入任何条目，`POST /v1/inbox/ack` 为本节新增的通知种类增加 `outcome` 字段，daemon 按通知种类校验字段组合。已有的通知种类不接受 `outcome`；省略 `outcome` 等同于 `persisted`，已有客户端不受影响。

| 通知 | `persisted`（带 entryId） | `uiNotified` | `obsolete` | 其他要求 |
| --- | --- | --- | --- | --- |
| `main_quota:*:ready` | 自动续跑的标记已写入会话 | 已交给 pi 提示 | 暂停已失效 | — |
| `main_quota:*:unknown` | ✘ | 已交给 pi 提示 | 暂停已失效 | — |
| `continue:*` | 续跑的标记已写入会话 | ✘ | 到时检查不通过 | — |
| `schedule:*` | 对应条目已写入会话 | ✘ | ✘ | 带 `claimId`，或按“恢复”的规则带 `recover: true`；也随定时项的状态迁移关闭，见迁移表 |

- `uiNotified` 只表示提示已交给 pi。RPC 模式没有显示回执，没有终端或浏览器在显示时，提示会丢失；持续的状态以 pane 面板中的会话状态行和 CLI 列表（命令名称待定）为准。
- `obsolete` 表示原通知已失效、没有执行。扩展可以另在进程内用扩展 UI 通知说明原因，这条说明不经 outbox，也不影响确认。

### 锚点

续跑的锚点是当前分支上最后一个进入模型上下文的条目：消息（用户、助手、工具结果）、自定义消息（`custom_message`，包括 `agora:continue` 标记）、压缩条目和分支摘要。`appendEntry` 写入的自定义条目（如 `agora-principal`、`agora-quota-dismissed`）、会话名称、标签和模型或 thinking 切换不影响模型收到的内容，不算锚点。会话状态的上报、定时续跑的创建和注入前的检查都按这个定义取锚点，因此修改会话名称、扩展重连时追加 `agora-principal` 都不会使锚点失效。

### 定时项

定时发送和定时续跑统一保存为主会话的定时项，存在 daemon 数据库中，跨 daemon 重启保留，定时器在 daemon 启动时恢复。

| 字段 | 含义 |
| --- | --- |
| `scheduleId`、`revision` | 定时项 id；创建时 `revision` 为 1，每次修改或重新执行加 1。扩展命令创建的定时项由扩展生成随机 id，daemon 拒绝重复的 id |
| `principalId`、`sessionId`、`sessionFile` | 所属主会话 |
| `kind` | `send`（定时发送）或 `continue`（定时续跑） |
| `text` | `send` 的正文，只支持纯文本 |
| `fireAt`、`fireBasis` | 触发时间（毫秒整数）；`fireBasis` 为 `time`（用户指定的时间）或 `quotaReset`（额度重置后） |
| `anchorEntryId` | `continue` 的[锚点](#锚点)，取创建时的值 |
| `origin`、`commandTag`、`confirmationId` | `send` 的来源：`command`（扩展命令，附来源标签）或 `signed`（设备签名，附确认记录），见[定时发送](#定时发送) |
| `state`、`stateReason` | 状态及原因（如 `sessionClosed`、`timeout`、`originUnverified`、`deliveryUnknown`） |
| `createdBy`、`confirmedBy` | 发起的 principal 和确认方式，与审计记录一致 |

- **触发时间**：`fireBasis: "quotaReset"` 取该会话当前未结束暂停的 `quotaResumeAt` 加 `mainSchedule.quotaResetMarginMs`。扩展命令路径由扩展在提交前读取暂停并算出 `fireAt`（标签需要它），daemon 在创建事务中核对它与当前暂停相符；设备签名路径由 daemon 在验签后的执行事务中读取暂停并算出。保存后之后暂停被替换或结束，`fireAt` 也不变。会话没有未结束的暂停或重置时间未知时，不能选择这一项。
- **适用范围**：只能为当前持有控制租约、会话文件已经写出的主会话创建定时项。定时项不拉起主会话：主会话由终端或 pi-pane 托管，daemon 不能启动它。
- **状态与迁移**：每条迁移都是条件更新，与下表的副作用和变更流记录在同一事务中提交。

  | 迁移 | 条件 | 同一事务的副作用 |
  | --- | --- | --- |
  | 创建 → `scheduled` | 见上文 | — |
  | `scheduled` → `scheduled`（修改） | `expectedRevision` 一致，来源规则见[定时发送](#定时发送) | `revision` 加 1，保存新的正文、时间、来源证明 |
  | `scheduled` → `cancelled` | `expectedRevision` 一致 | — |
  | `scheduled` → `due`（触发） | `revision`、`fireAt` 与定时器登记时一致；租约状态见下文 | 写入 `schedule:<scheduleId>:<revision>` 通知 |
  | `scheduled` → `missed`（触发） | 同上，且所属主会话明确离线 | 生成待处理表单，`stateReason: "sessionClosed"` |
  | `scheduled` → `missed`（启动补扫） | daemon 启动时已过截止时间 | 生成待处理表单，`stateReason: "timeout"` |
  | `due` → `delivering`（领取） | 见“领取” | 生成 `claimId` |
  | `delivering` → `due`（放回） | `claimId` 有效（或按“恢复”的规则），当前时间早于截止时间 | `claimId` 作废 |
  | `delivering` → `delivered` | `claimId` 有效（或按“恢复”的规则），会话文件中已有对应条目 | 确认通知 |
  | `delivering` → `skipped` | `claimId` 有效，到时检查不通过 | 关闭通知 |
  | `due`、`delivering` → `missed` | 到截止时间仍为 `due`；放回时已到截止时间；来源无法确认；结果未知 | 关闭该 revision 的通知，生成待处理表单 |
  | `missed` → `due`（立即执行） | `expectedRevision` 一致、状态仍为 `missed`、所属主会话持有有效租约，均在执行事务中复核 | `revision` 加 1；`fireAt` 为扩展命令签入的时间（命令路径）或执行事务的时间（设备签名路径）；保存新的来源证明；写入新 revision 的通知，移除表单 |
  | `missed` → `abandoned` | `expectedRevision` 一致 | 移除表单 |

  `delivered`、`skipped`、`abandoned`、`cancelled` 是终态。

- **触发与租约**：触发时按所属主会话的在线状态分三种情况。持有有效租约时改为 `due`。明确离线时改为 `missed`：daemon 本次启动以来观察到该 principal 释放了租约（主会话关闭、切换），或租约过期未续（pi 异常退出后 90 秒）。状态未知时改为 `due`，由截止时间裁定：daemon 启动时清空全部租约，启动后一个租约期内，该 principal 既未重新认领也未释放的属于这种情况。状态未知时到期的定时项，主会话在截止时间前重新认领后仍会执行。启动时，停机期间已到时间的 `scheduled` 定时项按同样规则处理，已过截止时间的直接改为 `missed`。修改和取消先提交事务，再重设内存中的定时器，旧定时器触发时因条件不符而不生效。
- **截止时间**：`fireAt + mainSchedule.missedAfterMs`。领取要求当前时间早于截止时间；当前时间到达截止时间时，仍为 `due` 的定时项改为 `missed`。已领取的定时项不受截止时间影响。领取和超时都是条件更新，两者只有一个生效。
- **领取**：扩展收到通知后放进[注入调度](#注入调度)的本地队列。到注入时，扩展为这次领取生成一个 `claimKey`，调用 `POST /v1/main/schedules/:id/claim`（带 `revision` 和 `claimKey`）。daemon 检查定时项为 `due`、请求所用的连接持有该会话的租约、当前时间（daemon 的时钟）早于截止时间，满足时改为 `delivering`，生成绑定 `revision`、该连接和 `claimKey` 的 `claimId`；已到截止时间的同时改为 `missed`。响应丢失时扩展用同一 `claimKey` 重试，daemon 返回原 `claimId`；放回后的下一次领取使用新的 `claimKey`。`/release`、`/skipped`、`/missed` 和 ack 都带 `claimId`，与记录不符时返回 `409`，同一请求重复提交返回相同的结果。领取返回后扩展重新检查，按结果分别处理：会话忙碌时放回；续跑的锚点已失效时调用 `/skipped`；来源无法确认时调用 `/missed`。
- **注入前去重**：扩展注入前，在整个会话文件（所有分支，不只当前分支）中查找同一投递：定时发送按 `scheduleId`（不论 revision）查找 `agora:scheduled` 条目，续跑按 `dedupeKey` 查找 `agora:continue` 标记。已有时不再注入，以该条目的 entryId 按 `persisted` 确认，daemon 接受 `details.scheduleId` 与定时项相同的条目。这条检查保证“结果未知”的定时项重新执行时，会话中最多一条对应消息；它不能说明这条消息是否已经引起模型请求。
- **确认**：注入后，扩展按[投递](#投递)的规则在会话文件中核实对应条目，再带 `claimId` 调用 ack；daemon 在同一事务中确认通知并把定时项改为 `delivered`。`delivered` 只表示消息已写入会话，不跟踪随后的回合是否完成：消息写入后、模型请求发出前 pi 退出时，分支最后一条是这条消息，按[续跑](#续跑)的条件可以续跑。
- **恢复**：扩展在 `globalThis` 上为整个 pi 进程保存“已交给 pi、尚未写入会话”的注入记录（scheduleId、revision、`claimId`），扩展 reload 后仍可读到。`sendMessage` 不返回运行是否开始，pi 之后还可能等待 settled 处理、压缩或 `before_agent_start`，所以记录在条目写入会话文件后才移除；会话随后空闲、仍没有对应条目时，视为 pi 不会再写入，也移除记录。扩展在取得新连接或新租约后，以及每次 `agent_settled` 时，核对该会话的 `delivering` 定时项，请求带 `recover: true`，daemon 只接受当前租约持有者的这类请求：
  - 会话文件中已有完整的对应条目：按 `persisted` 确认，定时项改为 `delivered`。
  - 进程内注入记录中仍有该项：等待，不做裁定。
  - 两者都没有：这次领取在本进程内没有交给 pi（领取响应丢失，或交给 pi 后已确认不会写入），调用 `/release` 放回 `due`；已到截止时间的改为 `missed`。

  pi 进程重启后进程内记录随之丢失；旧进程已退出，不会再写入，按会话文件核对后放回或确认。旧领取所属的连接失去租约后，没有任何连接取得该会话的租约，到租约期满时 daemon 把它改为 `missed`，`stateReason: "deliveryUnknown"`，待处理表单写明消息可能已经写入会话。
- **修改和取消**：只有 `scheduled` 的定时项可以修改和取消，请求带 `expectedRevision`；其他状态返回 `409`。经设备签名执行的修改，在验签后执行时重新检查状态、revision 和权限。
- **处理错过的定时项**：经 `POST /v1/main/schedules/:id/resolve` 提交，带 `action`、`expectedRevision` 和幂等键：
  - `abandon`：改为 `abandoned`。
  - `runNow`：要求所属主会话持有有效租约，否则返回 `409 session_not_running`，表单保留。`send` 的来源证明见[定时发送](#定时发送)；`continue` 的锚点取该会话当前租约下最新的[会话状态](#会话状态)，状态离线或当前租约尚未上报时返回 `409`。执行后按领取流程投递，注入前去重保证 `deliveryUnknown` 的定时项不会重复写入。

### 定时发送

- **入口**：终端中用扩展命令（名称待定）；pi-pane 中用 agora 插件的面板动作，见 [integration.md](integration.md#主会话的定时项与续跑)。不提供 Agent 可调用的工具。
- **来源**：正文到时以用户的身份进入主会话，必须能确认是用户本人写的。定时发送只有两个合法来源，访问控制见 [security.md](security.md#主会话定时项)：
  - **扩展命令**（`origin: "command"`）：用户在终端或 pi-pane 的输入框里输入命令，由所属主会话里的 agora 扩展发起，不需要设备签名，保护开启时只用终端也能使用。扩展进程启动后生成一个随机密钥，保存在 `globalThis` 上，同一进程内扩展 reload 和会话替换后继续使用，不写入磁盘。扩展按提交后的值计算 `commandTag = HMAC-SHA256(密钥, JCS({ purpose: "agora.main.schedule.send", principalId, sessionId, scheduleId, revision, text, fireAt }))`：创建时 `revision` 为 1，修改和终端发起的“立即执行”为 `expectedRevision + 1`；`fireAt` 由扩展算出，“立即执行”取扩展当前时间。daemon 核对 `revision` 符合规则、“立即执行”的 `fireAt` 与 daemon 当前时间相差不超过 `mainSchedule.clockSkewMs`，然后原样保存这些值和标签，不自行重取时间。
  - **pi-pane 插件**（`origin: "signed"`）：经设备签名的用户级操作发起。签名内容为操作、scheduleId、`expectedRevision`、正文和触发方式，`fireAt` 和新的 `revision` 由 daemon 在验签后的执行事务中生成，同时保存 `confirmationId`。
- **投递时的来源检查**：扩展注入 `origin: "command"` 的定时发送前，用自己的密钥按保存的值重新计算 `commandTag` 并比较。标签绑定了定时项 id、revision、正文和时间，复制到其他定时项或改动其中任一字段都会不一致。不一致时（pi 进程已经重启、密钥已变，或定时项由其他进程伪造）不注入，调用 `/missed`，`stateReason: "originUnverified"`，由用户决定。`origin: "signed"` 的定时发送由 daemon 在验签时核实，扩展不再检查，不绑定进程。
- **修改**：修改正文或时间的来源规则与创建相同；取消不以用户身份发言，是主 Agent 级操作。错过的定时发送改为立即发送，需要扩展命令重新计算标签，或在 pi-pane 中重新签名。
- **注入**：经[注入调度](#注入调度)在会话空闲时执行：

  ```ts
  pi.sendMessage(
    { customType: "agora:scheduled", content: text, display: true,
      details: { scheduleId, revision, dedupeKey, fireAt } },
    { triggerTurn: true },
  );
  ```

  会话空闲时 `triggerTurn` 立即开始新一轮。定时发送不进入 pi 的 followUp 队列，所以用户停止时 `clear_queue` 不会清出它，也不会出现队列中的旧副本和重投的新副本同时落盘。正文原样交给模型，不加 agora 的标注行：它是经确认的用户发言，与“完成通知”中子代理事件的正文不同。斜杠命令和提示模板不展开。
- 发送后的回合再次因额度中断时，按[主会话的额度暂停](#主会话的额度暂停)重新登记。正文已经在会话中，之后只需续跑，不重发正文。

### 续跑

- **含义**：不加入新的用户消息，让模型从被中断的位置继续。适用于回合因错误（包括额度用完）或用户停止而中断的情况。
- **可续跑的条件**：从当前分支末端向前，跳过不进入模型上下文的条目（如 `appendEntry` 写入的记录）和 `agora:continue` 标记后，最后一条消息是以下之一：`stopReason` 为 `error` 或 `aborted` 的助手消息、用户消息、工具结果，或进入模型上下文的自定义消息（如 `agora:scheduled`）。pi-ai 组装模型请求时跳过 `stopReason` 为 `error` 和 `aborted` 的助手消息（依据：pi-ai `dist/api/transform-messages.js`），模型看到的上下文停在之前的用户消息或工具结果上；被中止回合里已生成的半截内容不交给模型，续跑时重新生成。最后一条是正常结束的助手消息时没有可以继续的内容，续跑不可用，界面说明原因，用户需要发新消息。
- **不使用 `canContinue`**：`agent_before_settle` 的 `canContinue` 先用 `convertToLlm` 转换消息再检查最后一条的角色，不经过 pi-ai 对出错助手消息的过滤。额度错误后最后一条是助手消息，没有待处理消息时这项判断为假；待处理消息会改变结果（依据：`dist/core/agent-session.js` 的 `_buildBoundaryContext`）。
- **执行**：扩展写入一条隐藏的标记消息启动回合，并在 `context` 事件中删除它（依据：`ContextEvent`、`ContextEventResult`）：

  ```ts
  pi.sendMessage(
    { customType: "agora:continue", content: "Continue.", display: false,
      details: { dedupeKey, scheduleId, anchorEntryId, auto, chainId, attempt } },
    { triggerTurn: true },
  );
  ```

- **`context` 处理**：本节只规定 agora 的 `context` 处理器的输出，之后的处理器仍可改写结果。
  - 历史标记（不是本次运行启动的标记）总是删除。
  - 本次运行启动的标记，在本次运行的第一次模型请求时决定是否删除：删除后，按 pi-ai 跳过出错和中止助手消息的规则，剩下的上下文仍满足可续跑的条件时删除；不满足时保留，模型收到一句用户文本 `Continue.`，效果与用户手动发一句“继续”相同。这个决定在本次运行的后续请求中保持不变，不因工具执行后上下文末尾变化而改变。保留的情况出现在注入检查之后、运行开始之前分支发生了变化，见[注入调度](#注入调度)。
- **与中断前的差别**：除删除标记外，这次运行和其他运行一样经过 pi 的常规处理：开始前可能先自动压缩，带上待发的 `nextTurn` 消息和 `before_agent_start` 处理器的输出；`context` 处理器按扩展加载顺序执行，每个都看到前一个的结果，之后还有 `context_with_system` 处理（依据：`_prepareRun`、`dist/core/extensions/runner.js`）。以下是已知行为，agora 不做处理：
  - 排在 agora 之前、按消息条数截断上下文的处理器会把标记计为一条；
  - 排在 agora 之前、把自定义消息改为用户消息的处理器会去掉 `customType`，agora 无法识别，标记作为 `Continue.` 交给模型；
  - pi 的压缩和分支摘要直接序列化会话历史，不经过 `context` 事件，`Continue.` 会出现在总结的输入中。
- 会话文件中保留标记消息，作为续跑记录和投递确认的依据。没有加载 agora 扩展的 pi 打开这个会话时，标记会作为一句用户文本交给模型，所以正文固定为 `Continue.`。
- **立即续跑**：终端中用扩展命令（名称待定）发起，扩展直接放进注入调度，不经过 daemon；这条命令由用户输入，效果与用户手动发一句“继续”相同。pi-pane 中由插件的面板动作发起：插件取该会话当前租约下最新会话状态中的锚点，调用 `POST /v1/main/continue`；状态离线或当前租约尚未上报时 daemon 返回 `409`。daemon 对同一会话、同一锚点只保留一个未完成的续跑请求，写入 `continue:<requestId>` 通知，由扩展执行。
- **定时续跑**：创建 `kind: "continue"` 的定时项，锚点取创建时的值。续跑不向会话加入新的用户发言，效果与 `quotaRecovery: "auto"` 的自动续跑相同，因此创建、修改和取消都是主 Agent 级操作。
- **到时检查**：经 daemon 执行的续跑（pi-pane 发起的立即续跑、定时续跑和自动续跑）注入前，扩展确认满足可续跑的条件，且当前的[锚点](#锚点)与记录的锚点相同。会话忙碌（见[注入调度](#注入调度)）时继续等待，不算检查不通过。检查不通过（最后一条是正常结束的助手消息，或锚点已变化，说明用户已经发过消息或已经续跑过）时不执行：定时项调用 `/skipped`，由 daemon 关闭通知；其他续跑以 `outcome: "obsolete"` 确认。扩展同时可用扩展 UI 通知说明原因，这条说明在进程内产生，不另经 outbox。执行了的续跑按会话文件中的标记确认。

### 会话状态

插件接口的 `mainSessions` 不提供主会话的快照，续跑按钮需要的状态由扩展上报：扩展在 `session_start`、`agent_start`、`agent_settled`、`session_tree`（`/tree` 导航）、`session_compact`、每次注入后，以及与 daemon 重新连接后调用 `POST /v1/main/session-state`，报告会话 id、[锚点](#锚点)、会话文件是否已写出、是否正在运行、是否可续跑及不可续跑的原因。

- 每次上报带 `seq`，在同一租约内单调递增。daemon 只接受当前租约所属连接的上报，在同一租约内只接受 `seq` 大于已保存值的上报，迟到的旧上报被丢弃；租约变化后，新租约的第一份上报直接接受，`seq` 重新计数。
- 租约释放、过期或被接管时，daemon 把该会话的状态标为离线；新租约第一份上报到达前，状态仍为离线。
- 状态写入变更流。插件用它显示状态和提供锚点；是否执行以扩展注入前的检查为准。

### 注入调度

定时发送和各种续跑共用扩展内的一个注入队列。agora 的普通通知和压缩检查点仍按[投递](#投递)和[压缩后续跑](#压缩后续跑)的规则注入，不经过这个队列；它们之间的顺序以压缩一节为准。

- **忙碌**：以下任一情况成立时，队列中的项不注入，继续等待：
  - `ctx.isIdle()` 为假，或 `ctx.hasPendingMessages()` 为真；
  - 已登记待执行的压缩、压缩正在进行，或压缩已结束而检查点尚未写入会话；
  - 有已注入但尚未写入会话的 agora 通知，或进程内注入记录中有尚未写入会话的定时项；
  - agora 自己的 `agent_settled` 处理器尚未结束（它可能等待网络请求，期间 pi 会推迟 `triggerTurn`）；
  - 用户输入处理中（见下一条）。
- **用户输入处理中**：pi 的 `isIdle` 不包括用户提示的预处理（`input` 处理器、模板展开、模型与鉴权检查）。预处理期间扩展以 `triggerTurn` 启动运行，用户的提示随后可能被 pi 拒绝（“Agent is already processing”）或按 steer、followUp 排队（依据：`prompt()` 的 `_promptPreflightCount`、`_preparePrompt` 与 `_startRun`）。扩展在 agora 的 `input` 处理器中记下“用户输入处理中”，在 `messageType` 为 `user` 的 `before_agent_start` 或 `agent_start` 时清除；输入被其他扩展处理或检查失败、没有启动运行时，在 `mainSchedule.inputSettleMs` 后清除。
- **时机**：在 agora 的 `agent_settled` 处理器结束后，安排到下一个事件循环检查队列，不在处理器内注入；会话空闲时收到通知、用户输入命令、“用户输入处理中”清除、压缩检查点写入会话或压缩以不生成检查点的结果结束时，也检查队列。
- **已知限制**：以下窗口是扩展无法观察的，不在保证范围内：
  - 排在 agora 之前的 `input` 处理器异步等待时，agora 还没有记下“用户输入处理中”；预处理超过 `inputSettleMs` 时标记已经清除。此时注入，用户的提示可能被拒绝（用户需重新发送），或排在注入的运行之后。
  - 其他扩展的 `agent_settled` 处理器跨事件循环等待时，pi 把注入推迟到推迟的操作之后执行（依据：`_emitAgentSettled`、`_deferredSettledActions`、`sendCustomMessage`），用户先提交的提示可能先运行。定时发送因此排在用户的回合之后，不影响正确性；续跑的锚点可能已经过时，`context` 处理会保留标记，结果是在用户的回合之后多一轮以 `Continue.` 开始的运行。
- **检查与注入在同一同步步骤内完成**：不忙碌、当前会话仍是该项所属的会话、扩展仍持有租约，续跑还要通过到时检查。全部满足后在同一步骤中调用 `sendMessage`，中间不让出事件循环。定时项的领取是异步请求，领取返回后重新检查。
- **会话切换**：所属会话不是当前会话的项不注入，留给认领该会话的扩展处理。
- **顺序**：按 `fireAt` 排列，每次只注入一项，下一项等下一次 `agent_settled`。排在定时发送后面的续跑会因锚点变化而跳过，这是预期的结果。
- 注入后用户再发的消息由 pi 按 steer 或 followUp 照常排队，与注入不冲突。

### pi-pane 中的保活

agora pane 插件为每个主会话最多持有一个 hold，根据 daemon 的状态重新计算，不按单个定时项增减：会话有 `scheduled`、`due` 或 `delivering` 的定时项，或有带重置时间、未结束的额度暂停时持有，全部没有时释放。插件在变更流事件、`ctx.mainSessions.onChange` 和重新连接 daemon 后重新计算。`reason` 写明下一个定时项的类型和时间。hold 只阻止空闲回收，不拉起未运行的会话；pi-pane 重启后主会话没有运行、租约已释放，期间到期的定时项由 daemon 记为错过。

### 配置与可迁移性

- `mainSchedule.missedAfterMs`、`mainSchedule.quotaResetMarginMs`、`mainSchedule.autoContinueLimit`、`mainSchedule.inputSettleMs` 和 `mainSchedule.clockSkewMs` 的默认值待定。
- 本节依赖以下 pi 接口和行为，调用限于 Harness 适配层，并登记到 [harness-portability.md](harness-portability.md)：`context` 事件删改发给模型的消息及处理器的执行顺序；`sendMessage` 的 `display: false` 与 `triggerTurn`；`appendEntry`；pi-ai 跳过出错和中止的助手消息；`agent_settled` 的 `aborted` 及其处理期间推迟 `triggerTurn`；`auto_retry_end` 表示取消重试的字段；`input`、`before_agent_start`、`agent_start`、`session_tree`、`session_compact` 事件；会话条目的类型（用于判定锚点）；`ctx.isIdle()`、`ctx.hasPendingMessages()`；`ctx.ui.notify`；扩展命令注册；`globalThis` 在同一进程的 reload 和会话替换之间保留。
- 实现前先做验证实验：
  1. 没有其他 `context` 处理器时，额度错误中断后和用户停止后续跑，常规模型请求中没有 `agora:continue`；
  2. 按消息条数截断的处理器、把自定义消息改为用户消息的处理器排在 agora 之前时，记录实际行为，核对与上文的已知行为一致；
  3. 用户提示预处理期间注入：agora 的 `input` 处理器记下标记之后、`inputSettleMs` 之内注入被推迟；鉴权检查超过 `inputSettleMs` 时，记录用户提示的实际结果（被拒绝或排队），据此确定 `inputSettleMs`；
  4. 自动重试等待期间在终端按 Esc 和发送 RPC `abort_retry`：两种情况都写入 `agora-quota-dismissed`，不登记暂停；
  5. pi-pane 托管的主会话中扩展 UI 通知的显示，以及 `display: false` 的消息默认不显示；
  6. RPC 会话替换时 `session_start` 触发两次的情况下，密钥沿用、注入队列按会话正确绑定。

## 用户接管

`POST /v1/tasks/:id/takeover` 或 `agora task takeover <任务 ID>` 显式将目标任务的召集人改为 `user`。用户可接管召集人仍可达的任务；保护开启时须设备签名，保护关闭时 CLI 可通过可信的 `none` 通路执行。普通 host 即使持有签名，也不能跳过接管直接恢复 Agent 的任务：召集人可达时返回 `convener_reachable`，不可达时返回 `takeover_required`。

接管在同一事务内写入 `tasks.taken_over_from`、更新当前会话召集人与 worktree 所有者，并向原召集人写入 `task:taken_over` outbox 通知，提交后才尝试唤醒。通知按既有至少一次投递规则重投，事务回滚不唤醒。`parent_task_id`、任务层级、用量和祖先预算归属保持不变，接管不会重新授予预算；正常预算耗尽仍可暂停包含接管任务的对应子树。

原 Agent 对目标及其子树的读取和管理返回 `403 task_taken_over`。祖先的 stop、abandon 和调低预算若会跨越接管边界，均在停止、改预算等副作用前拒绝。目标、祖先或后代正在执行控制操作时，接管返回 `409 task_busy`；已排队的旧控制操作在执行时重查权限。祖先 reopen / replace 不能收回已接管下级。

接管不禁止目标任务运行时管理自己的直接下级，也不改变其自身状态的有限读取权限；嵌套接管形成新的边界，外层运行时不能跨越。接管后，目标任务后续通知发给 `user`，恢复及增额按用户任务规则确认。

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
