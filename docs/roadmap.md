# 路线图

> 状态：设计阶段，尚无代码。工程量是估算，P0 结束后重估。

## P0 验证项

P0 只做小实验，验证设计依赖的 pi 行为和平台行为，结论写回对应文档后冻结接口。任何一项不通过，先改设计再进入 MVP。

| # | 验证内容 | 通过标准 | 影响的文档 |
| --- | --- | --- | --- |
| 1 | RPC 生命周期：`prompt`、`steer`、`follow_up`、`abort`、`get_state`、`get_last_assistant_text`；`agent_end` 与 `agent_settled` 的先后和含义 | 能可靠判定“本次运行结束”；steer 在工具执行完后送达 | tasks.md |
| 2 | 会话落盘：`--session-dir` + `--session-id` 的实际文件布局；用 `--session <file>` 重新拉起后上下文完整 | `get_state.sessionFile` 与磁盘一致；恢复后模型能看到之前的对话 | architecture.md、archive.md |
| 3 | 工具限制：`--tools read,grep,find,ls,agora_*` + `--no-mcp` + `-ne -e <agora>` 时，模型看不到也调不到 `bash`、`codemode`、MCP 工具；项目 `.pi/settings.json` 的 `defaultTools` 不会绕过 | 逐项尝试调用均失败 | architecture.md |
| 4 | 路径校验：`tool_call` 钩子能拿到 `read`/`grep`/`find`/`ls` 的路径参数并拒绝；覆盖符号链接、junction、大小写、`..` | 越界调用全部被拒 | architecture.md |
| 5 | Windows 进程树终止：`bash` 工具启动的长命令、后台进程、父进程先退出的孙进程 | `stop` 后没有遗留进程；不通过则评估 Job Object | architecture.md |
| 6 | 通知注入：扩展 `pi.sendMessage(..., { triggerTurn: true, deliverAs: "followUp" })` 在主代理空闲、忙碌、执行工具时的行为；`message_end` 能看到该自定义消息 | 空闲时立即开始新一轮；忙碌时排队；确认时机可靠 | tasks.md、board.md |
| 7 | `node:sqlite`：WAL 模式下 daemon 写、archive adapter 以 `readOnly` 读；事务内写 outbox | 并发读写无错误；崩溃后数据一致 | architecture.md、archive.md |
| 8 | 资源实测：空闲 pi RPC 进程的内存；8 个进程同时存在时的总内存 | 得到实测值替换“100–300 MiB”估算 | architecture.md |
| 9 | prompt cache：同一会话连续追加 board 增量时，Claude、GPT（Sol、Astra）、Gemini 的 `usage.cacheRead` | 记录各模型的实际命中情况 | board.md |
| 10 | launch ticket：扩展删除 `process.env.AGORA_LAUNCH_TICKET` 后，`bash` 子进程是否还能看到 | 看不到 | architecture.md |
| 11 | daemon 存活：Windows 上由终端里的 pi 扩展自动拉起（detached、`windowsHide`）的 daemon，在关闭终端窗口、注销前是否存活 | 关闭终端后 daemon 和子进程继续运行 | architecture.md |

P0 约 3–4 人日。

## MVP 范围

MVP 在 **pi 终端**里验收：主代理装 agora 扩展，不依赖 pi-pane。

包含：

- daemon：单实例、认证握手、主会话注册与恢复、控制租约、launch ticket、排空关闭、版本协商、数据库迁移与备份。
- 进程监管：`RpcSubprocessDriver`、并发上限、空闲回收、进程树终止、崩溃诊断。
- 任务：`agora_task` 全部动作、状态机、generation、outbox 通知、worktree 创建与清理、三个权限档位。
- 提问：`agora_request`、转给用户、“待处理”（CLI）。
- board：条目、引用与替代、密封草稿、投递位置与增量、`agora_board`。
- 会议：define-plan 流程、认可与版本绑定、僵局检测、预算与时长上限、插话、书记与纪要、崩溃处理、用户召开会议（CLI）。
- 存档：全量保存、流片段、退出诊断、继承关系、完整性校验、archive adapter。
- CLI：`agora daemon start`、`agora shutdown`、`agora status`、`agora ls [--tree]`、`agora show`、`agora log`、`agora tail`、`agora pending`、`agora answer`、`agora meeting convene|status|interject|decide|stop`、`agora task stop|cleanup|recover`、`agora takeover`、`agora verify-archive`。
- pane 插件：按 [integration.md](integration.md) 实现树、面板、动作、表单、通知和离线读取（与 pi-pane MVP 联调时完成）。

## 分期与工程量

一名主开发带 AI 子代理开发的估算：

| 阶段 | 内容 | 人日 |
| --- | --- | --- |
| P0 | 上表验证项 | 3–4 |
| M1 daemon 核心 | 生命周期、鉴权、SQLite 与迁移、进程监管、存档、HTTP 框架 | 6–8 |
| M2 任务 | 任务与提问、outbox、worktree、权限档位、扩展工具、CLI 基本命令 | 6–8 |
| M3 board 与会议 | board、密封草稿、投递、会议调度、认可、僵局、预算、书记 | 5–7 |
| M4 对外接口 | archive adapter、pane 插件、其余 CLI 命令 | 2–3 |
| M5 联调与故障验收 | 见下方“必须测试的故障” | 3–5 |
| 合计 | | 25–35 |

与 pi-pane（12–18 人日）合计 37–53 人日，日历时间 8–11 周。M2 之后 pi-pane 可以并行开发。公开发布前的加固（安装体验、跨平台测试、安全审查、文档补全）另算。

### 必须测试的故障

- 子代理完成的瞬间主会话关闭或切换会话；
- 返工完成再次通知，重投的通知不重复叫醒；
- 主代理和子代理同时提问；
- worktree 里的会话提问、写 board（不得因路径被拒）；
- 工具卡住、忽略 abort、遗留 shell 后代进程；
- board 条目已写入但投递未确认时 daemon 崩溃；
- 密封草稿通过任何接口泄漏给其他参会者；
- 主会话 fork 后两个会话同时认领同一 principal；
- 会议多模型并发时触及预算上限；
- daemon 运行中升级版本。

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

## 主要风险

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| pi RPC 行为与文档不一致，或 pi 升级后变化 | 完成判定、通知注入、恢复失效 | P0 逐项验证；锁定 pi 版本范围；对关键行为写集成测试，pi 升级时先跑 |
| Windows 进程树终止不可靠 | 停止后残留进程，占用文件锁和资源 | P0 验证，必要时上 Job Object |
| 多进程内存占用超出预期 | 8 个会话同时运行时机器吃紧 | 并发上限、空闲回收；P0 实测后调整默认值 |
| 会议不收敛或“伪共识” | 浪费额度，或拿回看似一致的错误方案 | 认可绑定版本、逐项回应、核对者列已验证项和风险、僵局交召集人；试运行后调整阈值 |
| 僵局检测误判 | 过早或过晚暂停 | 只用于暂停，不自动结束；阈值待定，试运行校准 |
| 各模型的 prompt cache 行为不同 | 会议成本高于预期 | P0 观察；预算上限兜底 |
| 存档量增长 | 磁盘占用 | `agora status` 显示占用；显式删除命令 |
| 集成协议两边不同步 | pi-pane 显示错误 | 协议只在 integration.md 定义，版本协商，pane 插件契约测试 |
| 同用户恶意程序 | 读取密钥、冒充主会话 | 明确不防；文档说明边界 |
