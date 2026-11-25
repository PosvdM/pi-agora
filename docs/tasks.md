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

每次模型请求结束记录一条用量，关联 taskId、generation、agoraSessionId、runId 和驱动提供的 requestId；重复事件不重复记账。pi 的提示缓存预热请求也是计费请求，同样各记一条，计入 `requests` 和各 token 字段（主要是 cacheRead），但不更新 `contextTokens`；受管子代理只在 agent 运行期间预热，空闲时不预热，见 [资源与回收](architecture.md#资源与回收)。运行 settled 后、进程退出前收到的用量记入当前代。禁止继续执行与接收用量分别控制：stop、额度暂停、预算暂停或中断返工的 abort 收尾期间，旧运行确认结束前收到的合法用量仍记入原任务、原代和原会话。复用进程时，在旧回合中断确认、开始新代回合后才切换记账代数；运行退出后拒收事件。输入、缓存读、缓存写、输出和推理 token 各字段分别按请求相加；预算计数不重复叠加推理 token，见“任务树软预算”。模型未单独返回推理 token 时记为 0，不把输出 token 推测为推理 token。`contextTokens` 取最近一次非零的 `input + cacheRead + cacheWrite`，代表服务最近报告的输入上下文大小；没有可用数据时为 0。任务树的上下文大小是各任务最近值之和，不是历史请求的输入总和，也不是模型上下文窗口上限。CLI 的专用展示在 1d，pane 展示在切片 2。

### 任务树软预算

每个任务的 `maxTokens` 限制该任务及全部后代的累计用量，跨 generation、会话替换和 daemon 重启保留。HTTP `POST /v1/tasks` 可指定 `maxTokens`；根任务省略时取数据库 `settings` 中的 `taskLimitDefaults.maxTokens`，子任务省略时继承父任务上限。下级不能超过任何祖先的预算，不单独预留或重复占用每日授予。根任务默认上限为 50,000,000 token，可在派活时显式收紧。

根任务的未签名授予受两项限制：主 Agent 的单树上限为 `taskLimitDefaults.maxTokens × agentLimitCap.perTaskFactor`，host 的单树上限为 `taskLimitDefaults.maxTokens`；所有 principal 共用同一数据目录的 `agentLimitCap.dailyTokens`。`perTaskFactor` 默认为 2，主 Agent 在封顶内可将单树提高到 100,000,000 token；`dailyTokens` 默认为 2,500,000,000 token，按授权额计算。超出任一限制均需设备签名；`userConfirmation = off` 产生的 `confirmedBy: "none"` 仍属于未签名授予，不能绕过封顶。

`budget_grants` 按本地日历日记录根任务的预算授予，创建时记全额，提高时只记新旧上限的正差额；调低、停止或清理均不退还当日授予。设备签名授予保留在账本中，但不占未签名日封顶。授予检查、账本与任务写入共用事务，不能通过并发创建或更换 principal 绕过。

预算计数使用逐请求去重后的 `treeUsage`，包含提示缓存预热请求的用量。`tokenAccounting: "all"` 计入 `inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens`；`"uncached"` 排除 `cacheReadTokens`。`reasoningTokens` 单独展示，不额外叠加到预算计数中；默认口径为 `"all"`，包含 cacheRead，不按缓存价格折扣。`spawn`、`status`、`result` 和调整上限的响应包含 `budget`：`maxTokens`、`usedTokens`、`remainingTokens`、`tokenAccounting` 与 `ancestors`；`ancestors` 列出每个祖先的上限、用量和暂停标志，剩余值最低为 0，用量不截断。

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
- 压缩期间以及压缩成功后检查点写入会话之前，不注入定时发送和续跑（见[主会话的额度暂停、定时发送与续跑](#主会话的额度暂停定时发送与续跑)）。

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

主会话因模型额度用完而中断后，用户通常要等额度重置再继续。本节规定 agora 为主会话提供的三项支持：

- **额度暂停**：识别并记录主会话因额度中断，到重置时间后提示用户或自动续跑。
- **定时发送**：用户写好消息，到指定时间（可以是“额度重置后”）发送到主会话。
- **续跑**：不加入新的用户消息，让被中断的回合继续；可以立即执行，也可以定时执行。

本节属于切片 1 之后的设计，尚未实现，只规定方向和关键约束；投递、领取、恢复和时序的细节在实现时确定，见[实现前待定](#实现前待定)。下文的 pi 依据均指 pi 1.5.2。

### 范围

- 功能由 agora 扩展和 daemon 实现。pi-pane 不实现定时功能，pane 中的显示和操作由 agora pane 插件通过 pi-pane 现有的插件接口提供，见 [integration.md](integration.md#主会话的定时项与续跑)。
- 只做一次性的定时项，不做周期任务。
- 只适用于会话文件已经写出的主会话。以 `--no-session` 运行的主会话和尚未写出会话文件的新会话无法在会话文件中确认投递，不支持。
- daemon 不能拉起主会话。定时项到期时主会话不在线，记为错过，进入用户的“待处理”，由用户选择立即执行或放弃；重新打开会话时不自动补发。

### 额度暂停

- **识别**：主会话一次运行结束后，扩展检查当前分支上最后一条助手消息，按 [architecture.md](architecture.md#用量与额度事件) 的规则识别为额度用完时，向 daemon 登记暂停，记录重置时间（未识别时为空）。识别规则与下级任务共用，放在 `packages/harness-pi`。pi 自动重试成功的运行不算暂停；用户停止运行时不登记。
- **结束**：主会话进程不因暂停而停止，用户随时可以发消息。之后出现新的助手消息、用户停止运行或切到其他分支时，暂停结束。
- **到重置时间**：`quotaRecovery: "notify"`（默认）时，扩展用扩展 UI 通知（`ctx.ui.notify`）提示可以续跑；`"auto"` 时自动续跑一次。连续的自动续跑有次数上限，防止重置时间解析有误时反复请求；用户发消息、手动续跑、定时续跑或定时发送后重新计数。重置时间未知时不推测，只提示。
- 扩展 UI 通知不写入会话，RPC 模式也没有显示回执，没有界面在显示时提示会丢失。持续的状态以 pane 面板和 CLI 列表为准。
- `quotaRecovery` 同时适用于下级任务和主会话，配置见 [architecture.md](architecture.md#用量与额度事件)。

### 定时项

- 定时发送和定时续跑统一保存为定时项，存在 daemon 数据库中，跨 daemon 重启保留。触发时间可以是指定的时间，也可以是“额度重置后”，即创建时当前暂停的重置时间加一段余量。
- 到期后经 outbox 投递给主会话里的扩展，扩展在会话空闲时注入。投递沿用至少一次的规则（见[投递](#投递)），扩展按定时项 id 在会话文件中去重，同一定时项在会话中最多写入一条消息。这只保证消息不重复，不保证消息写入后模型请求已经发出；请求没有发出时，可以续跑。
- 到期后超过一段宽限时间仍未执行的，记为错过，进入“待处理”。
- 只有尚未到期的定时项可以修改和取消。

### 定时发送

- **入口**：终端中用扩展命令（名称待定）；pi-pane 中用 agora 插件的面板动作。不提供 Agent 可调用的工具。
- **来源**：正文到时以用户的身份进入主会话，所以只接受两种来源，访问控制见 [security.md](security.md#主会话定时项)：
  - **扩展命令**：用户在终端或 pi-pane 的输入框里输入命令，由所属主会话里的 agora 扩展创建，不需要设备签名，保护开启时只用终端也能使用。扩展进程内保存一个随机密钥，不写入磁盘，对定时项的 id、revision、正文和触发时间计算 HMAC 标签交给 daemon，投递前重新计算核对。仅凭磁盘凭证或数据库内容无法伪造标签。pi 进程重启后密钥变化，尚未投递的这类定时项进入“待处理”，由用户决定。
  - **pi-pane 插件**：经设备签名的用户级操作创建。
- **注入**：

  ```ts
  pi.sendMessage(
    { customType: "agora:scheduled", content: text, display: true,
      details: { scheduleId, revision, dedupeKey, fireAt } },
    { triggerTurn: true },
  );
  ```

  只在会话空闲时注入，不进入 pi 的 followUp 队列，所以用户停止运行时 `clear_queue` 不会清出它。正文原样交给模型，不加 agora 的标注行，斜杠命令和提示模板不展开。只支持纯文本。

### 续跑

- **可续跑的条件**：会话空闲，且当前分支上最后一条进入模型上下文的消息（`agora:continue` 标记除外）是 `stopReason` 为 `error` 或 `aborted` 的助手消息、用户消息、工具结果或进入上下文的自定义消息。pi-ai 的常规消息转换跳过 `stopReason` 为 `error` 和 `aborted` 的助手消息（依据：pi-ai `dist/api/transform-messages.js`），模型看到的上下文停在之前的用户消息或工具结果上，被中断的回合重新生成。最后一条是正常结束的助手消息时续跑不可用，用户需要发新消息。`agent_before_settle` 的 `canContinue` 不经过这项过滤，不能用来判断。
- **做法**：扩展写入一条隐藏的标记消息启动回合，并在 `context` 事件中把它从发给模型的消息里删除（依据：`ContextEvent`、`ContextEventResult`）：

  ```ts
  pi.sendMessage(
    { customType: "agora:continue", content: "Continue.", display: false,
      details: { dedupeKey, scheduleId, auto } },
    { triggerTurn: true },
  );
  ```

  标记保留在会话文件中，作为续跑记录和投递确认的依据。没有加载 agora 扩展的 pi 打开这个会话时，标记会作为一句用户文本交给模型，所以正文固定为 `Continue.`。pi 的压缩和分支摘要不经过 `context` 事件，`Continue.` 会出现在总结的输入中。
- **入口**：立即续跑在终端中用扩展命令（名称待定）发起，在 pi-pane 中由插件的面板动作经 daemon 发起；定时续跑创建定时项。
- **执行前检查**：经 daemon 执行的续跑（pane 发起的立即续跑、定时续跑和自动续跑）记录发起时的会话位置。执行前仍满足可续跑的条件，且会话在这期间没有新的对话时才执行，否则不执行并提示用户。
- **权限**：续跑不向会话加入新的用户发言，效果与用户发一句“继续”相同，因此是主 Agent 级操作。

### pi-pane 中的显示与保活

- 插件接口的 `mainSessions` 不提供主会话的快照。面板需要的状态（是否可续跑、额度暂停、定时项）由扩展上报给 daemon，插件从 daemon 读取。
- 主会话有未处理的定时项或带重置时间的额度暂停时，插件对它持有 hold，避免空闲回收。hold 不拉起未运行的会话，pi-pane 重启期间到期的定时项记为错过。

### 已知限制

- 有几个时序窗口扩展观察不到：排在 agora 之前的 `input` 处理器异步等待、用户提示的预处理时间较长、其他扩展的 `agent_settled` 处理器跨事件循环等待。在这些窗口中注入时，用户的提示可能被 pi 拒绝而需要重新发送，或者多运行一轮。
- 排在 agora 之前的 `context` 处理器（按消息条数截断、把自定义消息改为用户消息）可能使标记计入截断或无法被识别。
- 用户在自动重试的等待期间取消重试（终端按 Esc、RPC `abort_retry`）时，pi 不通知扩展，agora 会照常登记暂停。处理办法在实现时确定。
- 扩展命令的来源证明防不住同一 pi 进程中的其他扩展和借系统自动化输入的命令，见 [security.md](security.md#剩余风险)。

### 实现前待定

- 默认值：错过的宽限时间、“额度重置后”的余量、自动续跑的次数上限；扩展命令的名称。
- 投递、领取、恢复、注入时机、会话状态上报和续跑计数的细节，以及设计审查提出的未解决问题，记在 [#23](https://github.com/PosvdM/pi-agora/issues/23)。
- 本节依赖的 pi 接口和行为（`context` 事件、`sendMessage` 的 `display: false` 与 `triggerTurn`、pi-ai 对出错助手消息的过滤、`ctx.ui.notify`、扩展命令等）的调用限于 Harness 适配层，并登记到 [harness-portability.md](harness-portability.md)。
- 实现前先做验证实验：
  1. 额度错误中断后和用户停止后续跑，常规模型请求中没有 `agora:continue`；
  2. 其他扩展的 `context` 处理器排在 agora 之前时的实际效果；
  3. 用户提示预处理期间、其他扩展异步处理 `agent_settled` 期间注入时的实际顺序；
  4. 自动重试等待期间取消重试时扩展能观察到什么；
  5. pi-pane 托管的主会话中扩展 UI 通知的显示，以及 `display: false` 的消息默认不显示。

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
