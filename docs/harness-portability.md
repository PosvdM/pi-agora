# Harness 耦合清单

本清单覆盖源码、测试、配置、CLI 输出及项目文档。当前运行时仅支持 pi 1.5.x。目录边界见 [总体架构的 Harness 适配层](architecture.md#harness-适配层)。

代价指替换该项所依赖的 Harness 行为所需的改动范围：低表示适配层内的局部替换，中表示需要实现并验证一组能力，高表示涉及领域调用方、持久化、公开协议或扩展生命周期。整体迁移文件的代价与替换其行为的代价不同；本轮只收拢不改变调用方合同的代码，不实现其他 Harness。

## 拉起与参数

| 位置 | pi 依赖 | 更换 Harness 时的工作 | 代价 |
| --- | --- | --- | --- |
| `packages/daemon/src/harness/pi/driver.ts`：`RpcSubprocessDriver.start` | `locatePi`、pi 版本检查、hostkit 的 `spawnWriter` 与 pi RPC 启动门闩。 | 替换定位、版本约束和启动门闩；保持写锁先于会话写者、身份记录先于放行的保证。停止依赖 hostkit 的退出可见性，适配器在有效报告后只核对一次身份；alive / unknown 保锁，显式重试不重放底层停止。hostkit 的写者 API 也校验 pi 参数，不能直接当作通用进程启动器。 | 中 |
| `packages/daemon/src/harness/pi/launch.ts`：`buildPiArgv` | `--mode rpc`、`--session-dir`、`--session`、`--model`、`--thinking`、`--tools`、资源开关和显式扩展 / skill 参数。 | 在新适配器中生成原生参数并验证资源隔离；当前参数顺序、默认工具及路径传递保持原样。 | 低 |
| `packages/daemon/src/index.ts`：`DaemonOptions/startDaemon/childEnvironment`；`main.ts` | `piPath`、`extensionPath`、默认 pi 扩展产物位置、`--pi-path` / `--extension-path`，清理环境中的 `PI_PANE_HOME`。 | 在了解目标接口后确定 Harness 选择和配置兼容；保留现有启动参数。 | 中 |

## RPC 命令与事件

| 位置 | pi 依赖 | 更换 Harness 时的工作 | 代价 |
| --- | --- | --- | --- |
| `harness/pi/driver.ts`：`DriverHandle/SessionDriver/RpcDriverHandle` | hostkit 的 `RpcCommand/RpcResponse/RpcEvent`、UI 请求与响应；RPC 命令白名单、`get_state` 心跳、`extension_error`、未授权会话替换检测及工具事件诊断。 | 定义目标 Harness 的命令、就绪、事件、UI、停止和恢复合同；不能将现有 `SessionDriver` 视为中立协议。 | 中 |
| `packages/daemon/src/tasks.ts`：`data/launch/settle/trackSteer` 及返工、恢复、停止流程 | 直接发 `get_available_models/get_state/prompt/steer/get_last_assistant_text/get_session_stats/clear_queue` 等；解析 `model`、`thinkingLevel`、`sessionFile/sessionId`、`agent_settled`、`queue_update`、`message_end`、`stopReason/errorMessage` 和被清队列内容。 | 将就绪核对、提示与返工、结果读取、队列追踪和 settled 状态整体改为中立能力，覆盖串行控制、去重和中断竞态。 | 高，仅记录 |

## 会话文件

| 位置 | pi 依赖 | 更换 Harness 时的工作 | 代价 |
| --- | --- | --- | --- |
| `tasks.ts` 的会话分配、继承与 RPC 核对；`harness/pi/driver.ts` 的锁与恢复 | 固定 `sessions/<id>/session.jsonl`，pi 的原生 sessionId 与 sessionFile；只准原文件恢复，不允许进程内替换会话。 | 定义新会话文件、身份与继承关系；验证首次启动、恢复、写锁和崩溃清理，避免多个写者。 | 高 |
| `packages/daemon/src/store.ts`：`PrincipalRow/SessionRow`、建表与迁移；`auth.ts`：`register/reclaim`；`server.ts`：`sessionView` | 数据库 `pi_session_id`、HTTP `piSessionId` 和主会话恢复认领。 | 设计旧数据及旧客户端兼容，不能只重命名字段；当前 schema 和 API 保持不变。 | 高，仅记录 |
| `packages/extension/src/index.ts`：`principalReference/bindMain`；`notifications.ts`：`noticeEntry/persistedNotices/NoticeDelivery` | `custom/agora-principal`、`custom_message/agora:notice`、JSONL 完整行、entry ID 与 details；恢复及通知确认依赖真实落盘证明。 | 替换身份引用和消息持久化证明，并重做迟到确认、fork、重投和清队列回归。 | 高 |

## 扩展 API

| 位置 | pi 依赖 | 更换 Harness 时的工作 | 代价 |
| --- | --- | --- | --- |
| `packages/extension/src/types.ts`、`index.ts` | `registerTool/appendEntry/sendMessage`、sessionManager、模型与 thinking 查询；session / turn / tool / settled / shutdown 钩子及取消、阻断返回值。整个包属于 pi 侧适配。 | 实现对应 Harness 的扩展包或其他桥接方式；保持两阶段就绪、工具调用 fail closed、token 与生命周期绑定。 | 高 |
| `packages/extension/src/notifications.ts` | `sendMessage`、`followUp`、`triggerTurn` 与 pi 已持久化条目。 | 替换注入与唤醒机制，保留 outbox 为准、落盘后确认和每代去重规则。 | 高 |

## usage 与额度错误

| 位置 | pi 依赖 | 更换 Harness 时的工作 | 代价 |
| --- | --- | --- | --- |
| `harness/pi/events.ts`：`normalizePiEvent/quotaEvent/resetTime`；`harness/pi/driver.ts`：`receive` | 助手 `message_end.message.usage` 的 input/cacheRead/cacheWrite/output/reasoning；429 与明确额度码、重置时间字段；助手消息 ID / 内容摘要去重。 | 替换解析器，输出 `harness/types.ts` 的 `usage_record/quota_exhausted`；保留逐请求去重、先于原事件派发及未知重置时间为 null。 | 低 |
| `tasks.ts`：`recordUsage/pauseQuota/armQuotaTimer/resumeQuota`；`store.ts` 的用量账本；`packages/protocol/src/index.ts`：`UsageSummary/TaskStatus` | 用量和额度状态本身是中立合同；结果中还保存原始 `get_session_stats`，任务 settled 仍受 pi 事件控制。 | 复用账本、树汇总和恢复规则；替换原始统计与完成时机。若重新定义统计合同，还需兼容持久化与客户端。 | 高，仅记录 |

## 安全与任务树预算

| 位置 | pi 依赖 | 更换 Harness 时的工作 | 代价 |
| --- | --- | --- | --- |
| `packages/daemon/src/budgets.ts`、`acl.ts`、`security.ts`、`offline.ts` | 预算、资源关系、设备签名、JCS、SQLite 和实例锁不依赖 pi。预算暂停只调用既有 `DriverHandle.stop()`；取消队列、停止推理和清理进程由适配器完成。 | 复用安全与预算规则；新驱动必须保留停止和停止后尾量记账的合同。 | 低 |
| `test/task-security-1c.test.mjs`、`security-http-1c.test.mjs`、`security-core.test.mjs` | 安全服务与 HTTP 用测试签名器验收；任务模拟器仍构造 pi RPC 事件和停止队列。 | 替换任务夹具的 Harness 事件，安全签名与迁移测试可复用。 | 安全低；任务夹具中 |

## 设置与项目信任

| 位置 | pi 依赖 | 更换 Harness 时的工作 | 代价 |
| --- | --- | --- | --- |
| `harness/pi/driver.ts`：`resolveSkills`；`harness/pi/launch.ts` | 用户 agent 目录为 `PI_CODING_AGENT_DIR` 或 `~/.pi/agent`；读取 `settings.json.skills`；生产固定 `--no-approve`。 | 替换用户设置来源并重新验证默认信任和资源隔离。 | 中 |
| `packages/daemon/src/index.ts`：`configured`；`docs/security.md`、`architecture.md` 的项目信任设计 | 当前配置仅接受现有字段；`implement.projectTrust: "saved"` 与扩展 / MCP 白名单推迟至 [#10](https://github.com/PosvdM/pi-agora/issues/10)：pi CLI 缺少独立 auth/models 路径；不复制 OAuth 凭证，也不引入 SDK launcher。 | 使用新 Harness 的实际信任接口设计隔离方案；不得将文档中的后续设计当作现有能力。 | 中 |

## skill 与 MCP

| 位置 | pi 依赖 | 更换 Harness 时的工作 | 代价 |
| --- | --- | --- | --- |
| `harness/pi/driver.ts`：`resolveSkills`；`harness/pi/launch.ts` | 动态导入 pi 私有 `dist/core/skills.js` 的 `loadSkillsFromDir`；默认用户 skills、配置路径与 `SKILL.md`；`-ns -np --skill`。 | 替换发现、名字解析与显式加载；保留同名歧义拒绝、真实目录去重、不查项目 skill。 | 中 |
| `tasks.ts`、`auth.ts` 的 `RunPolicy`、`extension/src/permissions.ts`；配置 `skillDirectories/defaultSkills` | 名单继承收紧、只读根授权与 pi 工具路径检查结合。`-ne --no-mcp` 关闭 MCP，当前没有可选 MCP 配置。 | 复用名单规则，适配工具访问语义；开放 MCP 前单独验证服务器启动隔离、异步注册与 exposure。 | 中；跨层权限验证高 |

## 路径规则（经 hostkit）

| 位置 | pi 依赖 | 更换 Harness 时的工作 | 代价 |
| --- | --- | --- | --- |
| `harness/pi/driver.ts`：`sessionKey`；`tasks.ts` 的会话写锁；`packages/extension/src/permissions.ts`、`index.ts` | `comparisonKey/realPathOrPending/canonicalPath/isWithin`、会话写锁；hostkit 路径规则同时兼容 pi 的工具路径语义，检查 pi 工具名及 `input.path`。扩展只加载 `pi-hostkit/paths`。 | 分开复用平台真实路径与进程锁能力、替换 Harness 的工具路径和参数解释；重新验证符号链接、受保护祖先、新文件及大小写规则。 | 平台复用低；工具映射中 |

## 其他

| 位置 | pi 依赖 | 更换 Harness 时的工作 | 代价 |
| --- | --- | --- | --- |
| `packages/protocol/src/index.ts`：`ThinkingLevel/EXPLORE_TOOLS/ReadyReport/spawnTaskSchema`；`tasks.ts/auth.ts` 的工具与模型策略 | thinking 枚举、`provider/id` 模型名、内置工具名、扩展版本及就绪字段。 | 做能力映射并确定协议兼容，不扩散新 Harness 原始字段到领域层。 | 高，仅记录 |
| `packages/protocol/src/client.ts`：`agoraHome`；`packages/cli/src/index.ts`；`packages/daemon/src/main.ts` | 默认 `~/.pi/agora`，worktree 默认 `~/.pi/agora-worktrees`。client 自动启动的是 agora daemon，不是 pi。 | 确定目录兼容与旧数据发现，避免更换 Harness 后误开空数据目录。 | 中 |
| `packages/cli/src/index.ts`：`HELP/runCli`；`server.ts`：`sessionView` | 帮助称“pi 协作引擎”；`ls/show` 原样输出含 `piSessionId` 的 HTTP JSON。 | 品牌文案可局部修改；字段需要版本兼容。当前 CLI 输出保持不变，连接错误仅补底层错误码。 | 文案低；字段高 |
| 各 `package.json`、`package-lock.json`、`.github/workflows/ci.yml` | pi-agora 品牌和包描述、固定 pi-hostkit 依赖；CI 安装真实 pi 1.5.0。 | 核对平台包哪些 API 为 pi 专用；为新适配器提供独立运行时安装与矩阵。 | 中 |

## 测试与文档

| 位置 | pi 依赖 | 更换 Harness 时的工作 | 代价 |
| --- | --- | --- | --- |
| `test/fixtures/driver-helpers.mjs`、`driver-host.mjs`、`driver-fault-worker.mjs`；`test/driver*.test.mjs` | 真实 pi 1.5.0、`PI_PACKAGE` 与 `PI_*` 环境、用户 settings、写锁和 RPC；D15 内存加载 pi 实现并替换 hostkit，旧 `dist/driver.js` 导入继续可用。 | 为新 Harness 保留相同故障语义和独立真实夹具；不要只替换 mock。 | 中 |
| `test/fixtures/*provider.ts`、`driver-extension.ts`、`notify-extension.ts`；`test/*e2e*.test.mjs`、`daemon*.test.mjs`、`cli.test.mjs`、`notification-clear-1b.test.mjs`、`claim-fork-1b.test.mjs` | pi Provider 注册、`@earendil-works/pi-ai/compat`、扩展工具与命令、`AgentSession/SessionManager`、真实会话格式和通知落盘。CLI 测试也有真实 pi 夹具。 | 替换模型假服务接入和运行夹具，保持不联网、HOME 隔离、正负控制、进程清理和通知证明。 | 高 |
| `test/extension*.test.mjs`、`permissions-1b.test.mjs`、`notice-fork.test.mjs`、`notify-faults.test.mjs`；`experiments/p0/` | pi 扩展 API mock、生命周期、路径、消息字段和早期 pi 行为实测。 | 更新目标 Harness 的契约测试并独立实测；P0 文件属于历史证据，不能将其结果当作新 Harness 证据。 | 中—高 |
| `test/task-1b.test.mjs`、`task-d15.test.mjs` | 假驱动构造 pi RPC 响应和事件，领域测试仍知道队列与会话格式。 | 随高成本任务层解耦统一替换，不只更新文件导入。 | 高 |
| `test/harness-pi.test.mjs` | pi 参数精确序列、派生事件和旧导出兼容。 | 保留 pi 专属回归，为新适配器增加对应测试。 | 低 |
| `README.md`、`docs/development.md`、`architecture.md`、`security.md`、`tasks.md` | pi 安装与 `pi -e`、目录、配置、工具、RPC、信任、skill、用量和额度合同。 | 在实现实际适配后同步使用步骤、限制和能力映射。 | 文案低；合同验证中—高 |
| `docs/archive.md`、`integration.md`、`board.md`、`meetings.md`、`roadmap.md` | 已实现边界与后续目标中的 pi JSONL、pi-pane、会话视图和集成假设。 | 区分当前与后续能力，核对原始会话读取、事件流投影和宿主接入方式；未实现部分不能宣称支持。 | 中—高 |

## 保留边界

`harness/types.ts` 只定义启动规格、技能解析结果及中立用量 / 额度事件，不引入 pi 或 hostkit 类型。`driver.ts` 保留原导出并指向 `harness/pi/driver.ts`。`SessionDriver/DriverHandle` 仍暴露 pi RPC，任务状态机、数据库、HTTP、CLI 和 pi 扩展合同保持原样；这些高成本项只记录，不以重命名掩盖耦合。
