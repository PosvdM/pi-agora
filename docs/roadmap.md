# 路线图

> 状态：代码覆盖切片 1a；完整任务核心、存档、pane、board 和会议按后续切片推进。实现与测试入口见 [development.md](development.md)。

## P0 验证项

P0 验证设计依赖的 pi 行为和平台行为，目标 pi 版本为 1.5.x，在 macOS（pi 1.5.0）上进行原型实测，Windows、Linux 待测项移入公开发布前的跨平台测试。各实验组详细结论与原始依据见对应链接。

| # | 状态 | 验证内容 | 通过标准 | 结论与后续 | 影响的文档 |
| --- | --- | --- | --- | --- | --- |
| 1 | - [x] | RPC 生命周期：`prompt`、`steer`、`follow_up`、`clear_queue`、`abort`（含超时）、`get_state`、`get_last_assistant_text`；`agent_end` 与 `agent_settled` 的先后和含义 | 能可靠判定“本次运行结束”；steer 在工具执行完后送达；`clear_queue` 返回的文本与排队内容一致 | **通过**。macOS 实测通过，依据见 [A 组 RESULTS.md](../experiments/p0/a-rpc/RESULTS.md)。Windows/Linux 待测移入公开发布前跨平台测试。 | tasks.md |
| 2 | - [x] | 会话落盘：`--session <预先分配的不存在路径>` 新建会话后文件写在该路径；`--session <file>` 重新拉起后上下文完整；`get_entries` 的 `since` 和 `leafId`；`message_end` 之后用 `get_entries since` 取到对应条目 | `get_state.sessionFile` 与磁盘一致；恢复后模型能看到之前的对话；daemon 的会话模型与会话文件一致，无重复或缺失 | **通过**。macOS 实测通过，依据见 [A 组 RESULTS.md](../experiments/p0/a-rpc/RESULTS.md)。Windows/Linux 待测移入公开发布前跨平台测试。 | architecture.md、archive.md、integration.md |
| 3 | - [x] | 工具与资源限制：`--tools read,grep,find,ls,agora_*` + `-ne -e <agora> -ns -np --no-approve` 时，模型看不到也调不到 `bash`、`codemode`、MCP 工具；项目 `.pi/settings.json` 的 `defaultTools` 不会绕过；implement 加 `-e builtin:mcp` 和 `mcp__<server>__*` 时只声明白名单服务器的工具，未列入的服务器是否仍会连接 | 逐项尝试调用均失败；记录 MCP 服务器的实际连接情况 | **通过**（含受信任项目）。MCP 白名单只限制工具暴露不限制服务器连接，未列入的服务器仍会连接，设计改为由 agora 单独生成只含白名单服务器的 MCP 配置以彻底避免启动。依据见 [C 组 RESULTS.md](../experiments/p0/c-tools/RESULTS.md)。Windows/Linux 待测移入公开发布前跨平台测试。 | architecture.md |
| 4 | - [x] | 受管扩展 fail closed：agora 扩展加载失败、`tool_call` 钩子抛出异常、launch ticket 过期或被重放、就绪报告的工具集合不符 | 每种情况下任务书都没有发出，任何工具都没有执行，run 被结束并留下诊断 | **通过**（受管原型范围）。五类故障均未发送任务书且进程终止留诊断。依据见 [C 组 RESULTS.md](../experiments/p0/c-tools/RESULTS.md)。Windows/Linux 待测移入公开发布前跨平台测试。 | architecture.md |
| 5 | - [ ] | 路径校验与命令工具：`tool_call` 钩子能拿到文件类工具的路径参数并拒绝；搜索根是受保护目录的祖先、嵌套的受保护目录、符号链接、junction、校验后切换链接、`write` 新文件、大小写和 Unicode 变体。`powershell` 只在原生 Windows 且配置允许时提供，其他情况下模型看不到也调不到；`bash`、`powershell` 不承诺命令的路径隔离，只验证是否提供 | 越界的文件类工具调用全部被拒；记录链接切换（TOCTOU）的实际表现；`powershell` 的提供与否符合配置 | **部分通过**。macOS 静态文件路径检查全部通过；TOCTOU 为明示剩余风险。pi-hostkit 的路径规则在 Windows、macOS、Linux 的 CI 中与 pi 1.5.0 的内部函数差分比对通过，agora 的 `tool_call` 路径校验尚未实现；Windows 原生 PowerShell 和 junction 仍待测，移入公开发布前跨平台测试。依据见 [C 组 RESULTS.md](../experiments/p0/c-tools/RESULTS.md)、[pi-hostkit 的“验证状态”](https://github.com/PosvdM/pi-hostkit/blob/main/docs/design.md#验证状态)。 | architecture.md、pi-hostkit 设计文档 |
| 6 | - [ ] | pi-hostkit：原生部分的形态；进程树终止（含 `bash` 工具的独立进程组、后台进程、父进程先退出、pi 被 SIGKILL 后的孤儿进程）；单实例锁与会话写锁的争抢和强杀后释放、会话写锁的取锁时机（`--session <不存在的路径>`、`session_before_switch` 取消、`session_shutdown` 的 `targetSessionFile`）、跨宿主恢复（pi-pane 被杀后 pi-agora 打开同一会话，及反向）；进程身份与 PID 复用；`icacls`；路径规范化用例。详见 [pi-hostkit 的“验证状态”](https://github.com/PosvdM/pi-hostkit/blob/main/docs/design.md#验证状态)，与 pi-pane 共用 | 三个平台全部按 pi-hostkit 设计文档工作；残留情况有实测记录 | **部分通过**。P0 在 macOS 原型上定下原生形态（N-API 预编译模块），会话事件的取锁时机通过，并发现快照的两种漏杀盲窗（两次快照间 setsid 退出后 SIGKILL pi，以及首次快照前退出的 nohup 后台进程），因此 Linux 有 cgroup v2 时默认开启，macOS 收窄承诺并以 `StopReport.coverage` 标明覆盖范围。pi-hostkit 0.1 已实现，CI 在 Windows、macOS、Linux（cgroup 与快照两种模式）上自动测试通过：锁的争抢与强杀后释放、跨宿主恢复与 fail closed、启动门闩、`bash` 工具及脱离进程组的后台进程的清理、abort 超时后仍完成停止、身份不符时不发信号、密钥权限（Windows 用 DACL，不用 `icacls`）、路径规则差分比对。仍未验证：真实 PID 复用与机器重启、身份检查与发信号之间的竞态、macOS 快照盲窗（未消除）、网络文件系统的拒绝、Linux 没有用户 systemd 时自动退回快照模式；取锁时机所依赖的 pi 会话事件只在 macOS 上验证；bash 启动上报 pgid 仍为 P1 调研项。依据见 [E 组 RESULTS.md](../experiments/p0/e-hostkit/RESULTS.md)。 | pi-hostkit 设计文档 |
| 7 | - [ ] | 通知送达：`pi.sendMessage(..., { triggerTurn: true, deliverAs: "followUp" })` 在主代理空闲、忙碌、执行工具时的行为；以会话条目确认；`triggerTurn: false` 的静默注入；用户 `clear_queue` 清掉排队中的通知 | 空闲时立即开始新一轮；忙碌时排队；被清掉的通知在 `agent_settled` 后重新注入；同一 `dedupeKey` 在会话里只出现一次 | **部分通过**。受管停止流程采用 `clear_queue` + `abort` 实测通过（通知仅落盘一条）；只发 abort 时排队通知留在队列未落盘、settled 后重投导致重复落盘已确认为第三方 RPC 客户端已知偏差，展示时统一按 `dedupeKey` 去重；Windows/Linux 待测移入公开发布前跨平台测试。依据见 [D 组 RESULTS.md](../experiments/p0/d-notify/RESULTS.md)。 | tasks.md、board.md |
| 8 | - [x] | 通知故障注入：在扩展的 `message_end` 回调中杀掉 pi；`message_end` 已发出、写入会话文件前杀掉 pi；静默注入后立即杀掉 pi；新会话尚未出现任何对话消息时静默注入通知、再杀掉 pi；ack 请求发出前杀掉 daemon | 每种情况下通知最终恰好在会话里出现一次，outbox 不会在通知写入会话文件之前被确认 | **通过**（限 pi 内部派发和强杀两种情况，恢复后恰好落盘一次）。依据见 [D 组 RESULTS.md](../experiments/p0/d-notify/RESULTS.md)。Windows/Linux 待测移入公开发布前跨平台测试。 | tasks.md |
| 9 | - [x] | `node:sqlite`：WAL 模式下 daemon 写、archive adapter 以 `readOnly` 读；事务内写 outbox 和 `changes`；`backup()` 在写入进行中的一致性和 `PRAGMA integrity_check` | 并发读写无错误；崩溃后数据一致；备份可打开且校验通过 | **通过**（macOS 进程崩溃恢复通过；备份限制为同一连接或一步复制全部页；断电操作系统崩溃待后续测试）。依据见 [G 组 RESULTS.md](../experiments/p0/g-store/RESULTS.md)。Windows/Linux 待测移入公开发布前跨平台测试。 | architecture.md、archive.md |
| 10 | - [x] | 只读解析：pi 1.5.0 支持的各版本会话文件、空文件、最后一行被截断的文件 | 解析出的活动分支与 `get_entries` + 叶子计算的结果一致；解析前后文件哈希不变 | **通过**（macOS 文件重新打开语义通过；v1 id 不稳定、截断行留在文件中间作为设计约束）。依据见 [G 组 RESULTS.md](../experiments/p0/g-store/RESULTS.md)。Windows/Linux 待测移入公开发布前跨平台测试。 | archive.md |
| 11 | - [ ] | 资源实测：空闲 pi RPC 进程的内存；8 个进程同时存在时的总内存 | 得到实测值替换“100–300 MiB”估算 | **推迟；具体阶段待排期。** | architecture.md |
| 12 | - [ ] | prompt cache：同一会话连续追加 board 增量时，各模型的 `usage.cacheRead`；`cache_warming_decision` 返回 `stop` 后不再产生 warming 用量 | 记录各模型的实际命中情况；warming 被关闭 | **推迟；具体阶段待排期。** | board.md、meetings.md |
| 13 | - [ ] | 软上限记账的准确度：两席会议跑到触及上限，对比账本的记账值与会话文件中的用量记录、模型服务返回的用量；分别统计 pi 自动重试、模型服务 SDK 内部重试、上下文压缩、停止前已发出的请求造成的差额 | 记录各类差额的实际大小，写回 meetings.md 作为“可能略超”的量级说明；记账值不少于会话文件中记录的用量 | **推迟；具体阶段待排期。** | meetings.md |
| 14 | - [x] | launch ticket：扩展删除 `process.env.AGORA_LAUNCH_TICKET` 后，`bash` 子进程是否还能看到；implement 加载白名单扩展和 `builtin:mcp` 时，扩展工厂函数是否按 `-e` 顺序执行、MCP 服务器进程是否在删除前启动并继承该变量 | `bash` 看不到；记录其他扩展和 MCP 服务器的实际可见范围，写回 security.md | **通过**。删除扩展排首位时后续扩展、MCP 进程、bash 均看不到 ticket。依据见 [B 组 RESULTS.md](https://github.com/PosvdM/pi-pane/blob/main/experiments/p0/b-bridge/RESULTS.md)。Windows/Linux 待测移入公开发布前跨平台测试。 | security.md |
| 15 | - [x] | daemon 存活：由终端里的 pi 扩展自动拉起（detached、`windowsHide`）的 daemon，在关闭终端窗口、SIGHUP 后是否存活 | 三个平台上关闭终端后 daemon 和子进程继续运行 | **通过**（macOS）：伪终端测试通过；在 Terminal.app 中以 TUI 模式真实关闭窗口后，daemon 和 pi 子进程都存活（iTerm2 未测）；Windows/Linux 待测移入公开发布前跨平台测试。依据见 [E 组 RESULTS.md](../experiments/p0/e-hostkit/RESULTS.md)。 | architecture.md |
| 16 | - [x] | 设备签名：pi-pane 生成的 ECDSA P-256 签名在 daemon 中按 RFC 8785 规范 JSON 和 `dsaEncoding: "ieee-p1363"` 验证；挑战重放、过期、参数被改、公钥不符（与 pi-pane P0 共用浏览器部分） | 合法签名通过；其余全部被拒 | **通过**。合法签名通过，重放、过期、参数篡改等均被拒。依据见 [F 组 RESULTS.md](https://github.com/PosvdM/pi-pane/blob/main/experiments/p0/f-browser/RESULTS.md)。Windows/Linux 待测移入公开发布前跨平台测试。 | security.md |
| 17 | - [x] | 子会话的扩展 UI：协作会话里的扩展调用 `ctx.ui.select` 等对话框 | daemon 立即回应取消，会话不挂起；`pending` 策略下超时后取消 | **通过**。立即取消与 pending 超时取消均生效，会话不挂起。依据见 [A 组 RESULTS.md](../experiments/p0/a-rpc/RESULTS.md)。Windows/Linux 待测移入公开发布前跨平台测试。 | architecture.md |
| 18 | - [x] | steer 送达追踪：带 `steerId` 标注的返工消息在 `queue_update`、`message_end`、`clear_queue` 返回值中都能匹配 | 四种状态判定无误 | **通过**。四种状态判定无误。依据见 [A 组 RESULTS.md](../experiments/p0/a-rpc/RESULTS.md)。Windows/Linux 待测移入公开发布前跨平台测试。 | tasks.md |
| 19 | - [x] | `agora_git` 加固：用配置了恶意 textconv、`diff.external`、`core.fsmonitor`、`core.pager`、clean/smudge/process filter、`log.showSignature` + `gpg.program` 的测试仓库，在工作区状态信息过期时对 `status`、`diff`（工作区、`--cached`、提交之间）、`log -p`、`show` 逐一运行；在支持的最低 git 版本上核实固定 argv；尝试白名单外的参数 | 恶意程序一次都未执行（以标记文件判断）；固定 argv 都被接受；白名单外参数全部被拒 | **通过**（macOS）。最低支持版本 git 2.34（实测 2.34.1）与 2.56.0 均满足通过标准，固定 argv 被接受，恶意标记均为 0，参数全部拒绝；2.34 把 `core.fsmonitor=false` 当成名为 `false` 的 hook 执行（无害），后续评估改用 `core.fsmonitor=` 并双版本验证；Windows/Linux 待测移入公开发布前跨平台测试。依据见 [C 组 RESULTS.md](../experiments/p0/c-tools/RESULTS.md)。 | architecture.md |
| 20 | - [x] | 协作会话禁止会话替换：implement 档位按白名单加载一个会调用 `newSession`、`fork`、`switchSession` 的测试扩展；RPC 直接发 `new_session` | 替换全部被取消，会话文件不变；收到意外的 `session_shutdown` 时 run 被停止 | **通过**。替换请求全部取消，意外 shutdown 时 run 被停止。依据见 [A 组 RESULTS.md](../experiments/p0/a-rpc/RESULTS.md)。Windows/Linux 待测移入公开发布前跨平台测试。 | architecture.md、pi-hostkit 设计文档 |

## MVP 切分

pi-agora 和 pi-pane 的 MVP 按同样的三个切片推进，两仓的 roadmap 使用同一套切片名称。MVP 的第一个切片在 **pi 终端和 `agora` CLI** 里验收，不依赖 pi-pane。

| 切片 | pi-agora 的内容 | pi-pane 的部分 |
| --- | --- | --- |
| 1. agora 任务核心 | 见下文 | 不涉及 |
| 2. pane 聊天核心 + 最小任务插件 | agora pane 插件的最小版本 | pi-pane 本身（其 M1–M3） |
| 3. board 与会议 | 先两席 + 只在最后出纪要的书记，验证 fencing、预算、故障恢复；再加中途书记、僵局启发式 | 会议进度（`steps` 面板）、board（`timeline` 面板）、会议相关动作和表单的联调（其 M4） |

### 切片 1：agora 任务核心

切片 1 分四个 PR 交付，1a 的代码和测试见 [development.md](development.md#测试与-ci)：

| 步骤 | 范围 |
| --- | --- |
| 1a：最小闭环 | 四包工程和三平台 CI；daemon 单实例、握手、主会话注册与恢复、租约、launch ticket、就绪检查、排空、版本和迁移；RPC driver、会话写锁、并发、诊断、旧进程清理、扩展 UI；explore 的 spawn / status / result / stop；outbox 可靠通知；CLI start / shutdown / status / ls / show |
| 1b–1d | 其余完整动作与状态机、steer、worktree、三个档位、提问、用户确认、配对、存档与其他 CLI；archive 包在 1d 创建 |

下面列出切片 1 的完整目标，不表示这些内容均已实现。

- daemon：单实例（hostkit 锁）、`host.key` 握手、主会话注册与恢复、控制租约、launch ticket、受管扩展就绪检查、排空关闭、版本协商、数据库迁移与一致性备份。
- 进程监管：`RpcSubprocessDriver`（hostkit 的 RPC 传输与进程树终止，Linux cgroup v2 默认开启支持；`StopReport` 覆盖范围标注）、会话写锁、并发上限与名额、空闲回收、崩溃诊断、无进展看门狗、重启时清理旧进程、子会话扩展 UI 的处理。
- 任务：`agora_task` 全部动作、状态机、generation、串行控制队列与条件迁移、steer 送达追踪、outbox 与可靠通知（以会话条目确认）、worktree（仓库外）、三个权限档位（含路径校验和 `agora_git` 加固）。
- 提问：`agora_request`、转给用户、`agora pending`。
- 安全：子 Agent 级、主 Agent 级与用户级的划分，主 Agent 的封顶（`agentLimitCap`）、资源级访问控制、待确认、设备登记与验签、`everPaired`、离线命令、启动时的安全状态检查、`userConfirmation`、审计。浏览器侧的确认在切片 2 接入；切片 1 用测试签名器验证验签流程，只用终端时用离线命令关闭保护后验收。
- 存档：全量保存、流片段（带块类型）、退出诊断、继承关系、完整性校验、只读解析器、archive adapter、用户聊天视图投影。
- 会话视图：快照、历史分页、事件流（CLI 的 `show`、`log`、`tail` 使用）。
- CLI：`agora daemon start`、`agora shutdown`、`agora status`、`agora ls [--tree]`、`agora show`、`agora log`、`agora tail`、`agora pending`、`agora answer`、`agora task stop|cleanup|recover`、`agora takeover`、`agora confirmations`、`agora pair --reset`、`agora offline pair-reset`、`agora offline set userConfirmation off`、`agora config`、`agora verify-archive`、`agora archive delete`。

### 切片 2：pane 插件

- daemon：变更流 `/v1/changes`、按父节点分页的会话列表。
- pane 插件：按需加载的树与同步、会话视图（快照、历史、实时流）、任务动作（`resolveForm`、幂等、结果映射）、`composer` 与 `abort`、持久表单（提问、决策、待确认、设备）、`userPresence` 确认与设备配对、安全状态横幅、通知、hold、自定义消息渲染器、离线读取。
- 以 pi-pane `docs/plugin-api.md` 的 pane 协议和本仓库 [integration.md](integration.md) 的映射为准，与 pi-pane 的 M3 联调验收。

### 切片 3：board 与会议

- 第一步：board（条目、引用与替代、密封草稿、投递位置与增量、`agora_board`）；define-plan 流程的两席会议、`final-only` 书记；阶段 fencing、反对意见的关闭与重开、并发到达的处理；软上限的预算账本（尽力记账）、主 Agent 封顶内提高上限和独立时长定时器；会议崩溃处理；用户召开会议（CLI）；循环次数上限交给召集人。
- 第二步：`checkpoint` 书记模式（中途纪要）、三到四席会议、僵局启发式（3-gram Jaccard 等）。
- pane 插件的会议部分：`steps`、`timeline` 面板，召集、插话、决定、调整上限等动作和表单。

### 规则

- 每个切片先通过下方“必须测试的故障”中对应的项（杀进程、断电、重复请求），再扩大功能。
- **并行**：pi-hostkit 是两仓共同的前置依赖，0.1 已实现（[PosvdM/pi-hostkit](https://github.com/PosvdM/pi-hostkit)）。切片 1 与 pi-pane 的 P0、M1、M2 可以并行；pi-pane M3 的联调要等切片 1 验收通过；切片 3 在切片 2 验收通过后开始。

## 工程量

工期在 P0 验证后重估。下表是粗估，供排期参考：

| 阶段 | 内容 | 人日（粗估） |
| --- | --- | --- |
| P0 | 上表验证项（原型在 macOS 上实测，部分通过项与平台支持移入后续阶段） | 已完成（5–7） |
| pi-hostkit | 已实现 0.1（[PosvdM/pi-hostkit](https://github.com/PosvdM/pi-hostkit)）：原生部分（N-API 预编译模块）与六个平台/架构的预编译构建、三平台 CI 测试、进程树终止（Linux cgroup v2 默认开启）、锁、路径规范化、测试用例；预编译模块尚未随包分发 | 已完成（5–7） |
| 切片 1 | 见上 | 14–18 |
| 切片 2 | daemon 变更流与 pane 插件 | 4–6 |
| 切片 3 | board 与会议（两步） | 7–10 |
| 合计 | | 35–48 |

pi-pane 的估算见其 `docs/roadmap.md`（18–26 人日，P0 后重估）；两仓合计约 53–74 人日。公开发布前的加固（安装体验、跨平台测试、安全审查、文档补全）另算。

## 必须测试的故障

切片 1：

- 子代理完成的瞬间主会话关闭或切换会话；
- 返工完成再次通知，重投的通知不重复叫醒；
- 通知故障注入（P0 第 8 项的各个时间点），以及用户在主会话按停止清掉排队中的通知；
- 主代理和子代理同时提问；
- worktree 里的会话提问（不得因路径被拒）；
- 工具卡住、忽略 abort、遗留 shell 后代进程；macOS 和 Linux 上 pi 被 SIGKILL 后的孤儿进程；
- daemon 被强杀：macOS、Linux 上旧 pi 仍在运行时，重启后先按进程身份停止并确认退出，再允许 resume；Windows 上受管进程随 Job 终止；
- 模拟断电：会话文件最后一行不完整、数据库在事务中断电；
- 重复请求：同一 `Idempotency-Key` 的 spawn、steer、answer 只执行一次；
- 主会话 fork 后两个会话同时认领同一 principal；
- 子代理读取 `secret/host.key` 后以 `host:cli` 身份尝试答复自己转给用户的提问：只能生成待确认，不能直接生效；
- 待确认的挑战被重放、过期后提交、参数被改；
- pi-pane 正托管某个会话文件时，daemon 尝试托管同一文件（写锁拒绝）；pi-pane 被强杀后 daemon 打开同一会话文件，以及 daemon 被强杀后 pi-pane 打开（新持锁方先停止遗留的 pi 写者）；恰在 spawn 之后、写入 `writer` 之前杀掉宿主（新持锁方返回 failed，不自动拉起）；
- 任务占满名额时召开会议（应排队并通知，名额释放后优先给会议）；
- daemon 运行中升级版本（备份、校验、迁移失败时保持原库）。

切片 2：

- daemon 重启、变更流过期时 pi-pane 树 `reset` 后与 daemon 一致；
- 浏览器在子会话流式输出中断网再恢复：不重复、不遗漏；
- 两个标签页同时提交同一持久表单，只有一个生效；
- 用户在确认框点拒绝、确认超时、没有已配对设备；
- 首台设备配对（新设备自签）、新设备待批准、在线重置需要已配对设备签名、撤销最后一台设备后只能离线重置；离线重置后下一台设备直接配对并消费 `reTofuArmed`，两台浏览器同时配对时只有一台成功；
- 离线重置、离线关闭保护、手动删除设备记录后启动 daemon：所有标签页出现不能关闭的持久横幅，审计里有记录；设备横幅在签名确认知悉后消失，保护横幅只在重新开启保护后消失；
- 确认知悉期间又发生一次离线修改（警告 `revision` 变化）：旧的确认被拒，横幅保留并显示新内容；
- 横幅不静默消失：pi-pane 单独重启、daemon 单独重启、两者同时重启、agora 插件加载失败、插件被停用时，安全横幅都保留（插件不可用时附“来源不可用”）；daemon 不可达期间插件不清除横幅。

切片 3：

- board 条目已写入但投递未确认时 daemon 崩溃；
- 密封草稿通过任何接口泄漏给其他参会者；
- 最后一个认可与新反对意见并发到达；`decision` 插话后旧阶段的晚到条目；
- 会议多席位并发时触及预算上限（会议暂停，超出部分如实记账）；主 Agent 在封顶以内和超出封顶时提高上限；多个 principal 并发创建会议和提高上限时，每日封顶不被越过；
- 参会者崩溃后恢复、换人、去掉席位。

## 明确不做

- 不重写 pi 的 Agent 运行时、Provider、上下文压缩。
- 不做第二种会话驱动（进程内 SDK），只保留 `SessionDriver` 接口。
- 不恢复到会话的任意分支；不支持运行中切换分支。
- 不做通用事件溯源。
- 不做插件市场，不加载第三方前端代码。
- 不开放公网访问，只监听 loopback。
- 不自动合并、推送、发版；不自动删除有改动的 worktree。
- 不承诺有副作用操作的“恰好一次”：通知可去重，外部副作用不自动重放。
- 不做沙箱：implement 档位的 bash 不保证不越界。
- 子代理不能再派子代理（MVP）。
- 不迁移 pi-web-ui 的私有运行状态。

## 以后可能做

- 按 loopback 连接的对端进程 PID 判断请求是否来自受管会话的进程树，作为额外的审计信息和门槛（见 [security.md](security.md#以后可能做)）。
- 子代理再派子代理。
- 会议预算的硬上限：关闭模型服务 SDK 的内部重试并由 daemon 批准每次请求，或经由记账网关转发模型请求（见 [meetings.md](meetings.md#以后可能做)）。
- P1 调研项：在 pi 里用扩展包住 bash 工具，命令启动时上报进程组以兜住早退后台进程（见 [pi-hostkit 设计文档的“剩余风险”](https://github.com/PosvdM/pi-hostkit/blob/main/docs/design.md#剩余风险)）。

## 主要风险

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| pi RPC 行为与文档不一致，或 pi 升级后变化 | 完成判定、通知注入、恢复失效 | P0 逐项验证；限定 pi 版本为 1.5.x；对关键行为写集成测试，升级支持的版本前先跑 |
| pi-hostkit 原生部分的构建与分发 | 某个平台装不上或行为不一致 | N-API 预编译模块；CI 为六个平台/架构构建预编译模块，并在三个平台上运行测试；预编译模块尚未随包分发，以 git 依赖安装时从源码编译，需要编译工具链；失败时拒绝启动并说明原因，不降级到不安全的实现 |
| POSIX 上的孤儿进程 | 停止后残留进程，占用资源 | Linux cgroup v2 默认开启（`systemd-run --user --scope`），无 cgroup 则退回快照；macOS 收窄承诺并在 `StopReport` 注明覆盖范围；运行期快照记录进程组；P1 调研 bash 命令启动上报进程组 |
| 多进程内存占用超出预期 | 8 个会话同时运行时机器吃紧 | 并发上限、空闲回收；待 #11 资源实测（已推迟，具体阶段待排期）后调整默认值 |
| 会议不收敛或“伪共识” | 浪费额度，或拿回看似一致的错误方案 | 认可绑定版本、逐项回应、核对者列已验证项和风险、阶段 fencing、循环上限交召集人；试运行后调整阈值 |
| 预算是软上限 | 实际用量略超上限 | 文档和纪要写明“软上限、记账值”；P0 第 13 项测量差额；硬上限列入以后可能做 |
| 各模型的 prompt cache 行为不同 | 会议成本高于预期 | 待 #12 prompt cache 实测（已推迟，具体阶段待排期）后调整；预算上限兜底 |
| 存档量增长 | 磁盘占用 | `agora status` 显示占用；显式删除命令 |
| pane 协议升级后插件未跟上 | pi-pane 拒绝加载插件或显示错误 | pane 协议由 pi-pane 的 plugin-api.md 定义并做版本协商；只有 `pane-plugin` 依赖它；契约测试 |
| 子代理冒充用户 | 自己答复自己转交的提问、超过封顶加预算、关闭保护 | 磁盘凭证只有主 Agent 级权限；用户级操作需浏览器设备签名；重置和关闭保护只能签名或离线，并触发常驻横幅；剩余风险（系统自动化操作终端和浏览器、停 daemon 改数据、浏览器密钥可从磁盘挖出、抢先配对）见 [security.md](security.md#剩余风险) |
| 同用户恶意程序 | 读取密钥、操纵浏览器 | 明确不防；真正隔离需另一系统用户、沙箱或虚拟机，不在计划内 |
