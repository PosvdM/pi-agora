# 开发

## 实现范围

切片 1b 提供任务核心。四个 workspace 为 protocol、daemon、extension、cli，不依赖 pi-pane。任务动作包括 spawn、list、status、result、steer、stop、cleanup 和 recover；权限档位为 explore、review、implement。子代理可以继续派出下级，daemon 强制核对 principal、直接召集关系、任务树、层数、下级数和档位。

提问由 `agora_request` 创建、答复、逐级转交或取消；CLI 提供 pending 和 answer。父任务有未完成下级时进入 `waiting_children`，有未答复提问时进入 `waiting_decision`。两者 settled 后都释放推理名额，可空闲回收。需要推理的通知重新排队取得名额，必要时拉起原会话，再由扩展注入持久通知；静默投递与等待下级时的强制唤醒规则见 [tasks.md](tasks.md#工具一览)。

尚未提供：用户设备确认、预算与完整资源 ACL、配对及安全状态审计（1c），可选扩展 / MCP 白名单及 `implement.projectTrust: "saved"`（建议随 1c 跟进），存档读取与会话视图（1d），board、会议和 pane 插件。生产子会话固定 `-ne --no-mcp --no-approve`，只显式加载 agora；测试 driver 可以独立注入假 provider，不开放生产 HTTP 注入。

**1b 的 CLI 答复未经设备确认，无法区分用户与 Agent。** 完整用户级安全模型仍以 [security.md](security.md) 为设计目标，不能把此通路视为已完成的用户身份验证。

## 环境与构建

- Node.js 24 及以上、npm、pi 1.5.x。真实进程测试固定 pi 1.5.0。
- pi-hostkit 固定为 git 提交 `36f97ae683d5b0fb8ee495eecc04df7ab381f66a`，不引用相邻仓库工作区。安装会运行 prepare 构建；原生模块需要 Python 3 和 C/C++ 工具链，Windows 使用 Visual Studio Build Tools。
- 数据库使用内置 `node:sqlite`、WAL 和 FULL 同步级别。

```sh
npm install
npm run build
npm test
```

构建使用 `tsc -b` 和 project references。测试命令是 `node --test --test-concurrency=1 "test/**/*.test.mjs"`。不提交 dist、node_modules 或 tsbuildinfo。

## 源码结构

| 路径 | 职责 |
| --- | --- |
| `packages/protocol/src/index.ts` | 协议类型、工具 schema 和版本 |
| `packages/protocol/src/client.ts` | 发现、双向握手、连接、请求总期限与有界重试 |
| `packages/protocol/src/git.ts` | 共用 Git 安全调用层、配置与环境清理、字面路径和只读查询白名单 |
| `packages/daemon/src/index.ts`、`main.ts` | 配置、单实例、启动恢复、排空与入口 |
| `packages/daemon/src/server.ts`、`auth.ts` | HTTP、幂等记录、principal、租约、launch ticket |
| `packages/daemon/src/store.ts` | schema v4、一致性备份、迁移、条件更新、outbox 和逐请求用量 |
| `packages/daemon/src/tasks.ts` | 控制队列、树限制、调度、返工、恢复、回收和看门狗 |
| `packages/daemon/src/requests.ts`、`worktrees.ts` | 提问及逐级转交、按仓库串行的 worktree 操作 |
| `packages/daemon/src/driver.ts` | RPC、会话写锁、整树停止、UI 取消、心跳、诊断及 pi 的 skill、用量和额度适配 |
| `packages/extension/src/index.ts`、`permissions.ts` | 主 / 子会话工具、最终就绪门槛、三档与路径检查 |
| `packages/extension/src/notifications.ts` | 在途去重、完整磁盘记录核对和确认 |
| `packages/cli/src/index.ts`、`main.ts` | CLI 参数和命令 |

扩展的路径检查只加载 `pi-hostkit/paths`，不加载原生模块。archive 和 pane-plugin 包在对应切片创建。

## 启动与配置

默认数据目录为 `~/.pi/agora`，可用 `AGORA_HOME` 或 CLI 的 `--home` 指定。daemon 仅监听 127.0.0.1 的随机端口，原子发布 `run/daemon.json`；除 health 和认证入口外均要求连接 token 和 `Agora-Protocol: 1`。

daemon 启动时读取 `<AGORA_HOME>/config.json`。未配置时使用默认值，未知字段或非法类型拒绝启动；修改后需排空并重启。

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `maxConcurrentRuns` | 4 | 全树同时推理名额，1–64 |
| `maxTaskDepth` | 2 | 子代理与孙代理共两层；1–64 |
| `maxChildren` | null | 每个任务同时存在的未结束下级数；null 表示不限，整数为 0–1000000 |
| `idleReclaimMs` | 300000 | settled 且没有活动工具后回收进程的空闲毫秒数 |
| `toolStallMinutes` | 10 | 工具期间没有任何会话事件时的提醒周期；只通知，不自动停止 |
| `readyTimeoutMs` | 30000 | 受管扩展启动就绪上限 |
| `worktreeRoot` | `~/.pi/agora-worktrees` | worktree 根目录，配置值必须为绝对路径 |
| `allowedRoots` | [] | 额外只读根，绝对路径数组；任务 cwd 始终在允许根中 |
| `protectedPaths` | [] | 额外受保护路径，绝对路径数组；secret 始终受保护 |
| `powershell` | false | 仅 Windows 的 implement 档位可选；其他平台不提供 |
| `skillDirectories` | 用户 skill 目录及用户 settings 的 skills 路径 | 指定绝对路径数组后替换默认查找范围，详见 [security.md](security.md#skill-白名单) |
| `defaultSkills` | {} | 按 explore / review / implement 配置默认 skill 名单；未配置档位为空，spawn 的显式名单覆盖默认值，下级只能取上级名单的子集 |
| `quotaRecovery` | `"notify"` | 额度重置后通知直接上级；`"auto"` 仅续跑到期任务，不递归恢复下级 |

spawn 的 `maxDepth` 表示以新任务为第一层的子树层数，`maxChildren` 表示该任务及其下级继承的同时下级数限制。指定值不能超过配置或父任务剩余限制；下级可以继续收紧。模型没有额外层级限制。

```sh
node packages/cli/dist/main.js daemon start --home <目录>
node packages/cli/dist/main.js status --home <目录>
node packages/cli/dist/main.js ls --limit 50 --home <目录>
node packages/cli/dist/main.js show <任务或会话 ID> --home <目录>
node packages/cli/dist/main.js pending --home <目录>
node packages/cli/dist/main.js answer <提问 ID> --answers '[{"id":"q","selected":[],"custom":"答复"}]' --home <目录>
node packages/cli/dist/main.js task stop <任务 ID> --home <目录>
node packages/cli/dist/main.js task cleanup <任务 ID> --discard --home <目录>
node packages/cli/dist/main.js task recover <任务 ID> --mode resume --home <目录>
node packages/cli/dist/main.js shutdown --timeout 600 --home <目录>
```

只有 daemon start 自动启动 daemon。CLI 输出 JSON，错误返回非零退出码。原生 PowerShell 中 JSON 参数应按当前 shell 的引号规则传入；机器可直接使用 HTTP API，避免 shell 转义。

shutdown 默认排空，超时后保留 daemon；force 中断并清理运行。停止固定先 clear_queue，再 abort 和 hostkit 清理；无法确认时保锁和诊断，不自动 assumeNoWriter。成功的重复 stop 不改已有终态结果、业务 revision 和更新时间。

## 关键约束

- **两阶段就绪**：扩展报告工具 / 模型后先结束 session_start，daemon 再通过 RPC 核对可用模型、thinking 和会话路径。子会话工具授权另等 `GET /v1/runs/:id/authorized` 返回最终 ready；不能把 HTTP ready 的接受响应当作授权。
- **控制与名额**：发送、返工、停止、恢复、回收和唤醒经任务控制队列执行，写入时核对 generation / revision。停止在队列内重查租约与权限，拒绝过期请求前不改变停止标志。等待下级或提问的 settled 父任务不占名额，重新唤醒仍排队。启动恢复扫描只调度需要推理的 outbox，统一队列在旧运行核对和 HTTP 监听完成后才启动。
- **可靠通知**：状态、结果和通知同事务；每批最多 200，扩展取到空批。完整磁盘行的 entryId、noticeId、dedupeKey 全部相符才 ack。继承的历史通知不能代替当前 inbox 的授权。被 clear_queue 清掉的在途通知在 settled 后可重投；每代完成有独立 key。
- **请求重试**：安全 GET、可幂等续期及带原 Idempotency-Key 的业务写入最多三次，共用一个总期限、原 token、参数与 key；间隔 50 / 100ms。取消、关闭、HTTP 拒绝、协议不兼容、无效 JSON 和一次性认证兑换不重试。子会话短暂续期传输错误不立即 fatal。
- **Windows 退出可见性**：有效 StopReport 后最多 2 秒纯身份查询，不补杀；持续 alive / unknown 仍保锁。driver 的失败 stop 可显式重试，只复查原报告、身份和 release，不重放清队列或底层停止；已有失败报告不能变成新成功报告。TaskManager 重试仍核对版本与租约。
- **迁移**：schema v3 为任务树、限制、返工、提问和 worktree 增加字段与表；v4 保存 skill 名单与解析路径、额度恢复时间和逐请求用量。旧库依次升级到 v4，已有 v2 任务按第一层、默认两层回填。迁移前从同一 SQLite 连接做一致性 backup、只读 integrity_check，DDL 同事务，提交前 foreign_key_check；失败回滚原库。
- **恢复**：旧 run 未确认退出不能拉起写者；resume 代数不变，reopen / replace 新建继承会话并增加代数，历史 result 指向所属代数的会话。连续 resume 失败两次后需重开、换人或放弃，不自动重放副作用。

## 测试与 CI

测试使用真实 pi 1.5.0 和本地假 provider，不访问模型服务。HOME、USERPROFILE、APPDATA、LOCALAPPDATA、agent 配置、会话、数据与锁全部隔离。PI_PACKAGE 可指定安装；KEEP_FIXTURES=1 可保留现场。

| 测试文件 | 验收与边界 |
| --- | --- |
| `test/task-1b.test.mjs` | generation、幂等 steer / answer、送达追踪、中断旧代结果与用量、D14 七项规则、失败与额度通知唤醒、静默投递、直接停止孙任务、恢复后的提问路由、父提交 worktree、回收、看门狗、配置及 v2→v4 迁移 |
| `test/task-d15.test.mjs`、`driver-d15.test.mjs`、`d15-e2e.test.mjs` | 子代理标记、skill 白名单与只读授权、同项目双主会话的提问路由、任务 / 代 / 树用量及 stop / interrupt 收尾记账、静默终态唤醒与未知重置时间提示的持久化恢复、额度暂停与通知 / 自动恢复、v3→v4 备份和迁移回滚；真实 pi 的本地 429 与 skill 加载 |
| `test/tree-e2e.test.mjs` | 真实子代理调用 agora_task 再派下级；单名额下静默下级通知真正启动父回合，覆盖父进程未回收及回收重拉、通知落盘；恶意 MCP / 扩展不启动；Windows 原生 PowerShell 实际工具调用 |
| `test/permissions-1b.test.mjs`、`git-1b.test.mjs`、`git-paths-review.test.mjs`、`git-contexts-review.test.mjs` | 三档精确工具集合、受保护路径及祖先、新文件、真实 junction、Unicode / 大小写、Windows 8.3 短名（所在卷不分配短名时说明原因并跳过）；Git 字面路径与 cwd 边界、非提交对象拒绝、范围端点固定 OID、恶意配置、worktree 创建/清理的条件 filter / hooks 正负控及进程退出、子模块递归与清理边界 |
| `test/git-security-review.test.mjs`、`git-execution-review.test.mjs`、`git-index-review.test.mjs` | notes/replace/grafts/mailmap 的受保护内容正负控；缺失 promisor 对象的 SSH/helper、空协议白名单及 Windows 环境删除绕过；执行入口代表性正控与命令白名单拒绝；POSIX TTY pager；超过 1 MiB 干净索引的流式清理。完整分类见 [Git 安全调用层](security.md#git-安全调用层) |
| `test/client-retry.test.mjs` | 保留 keep-alive 的真实 socket 故障、响应丢失后的原 key 重试、总期限、取消、拒绝和一次性 ticket 不重放 |
| `test/e2e.test.mjs`、`notice-fork.test.mjs` | 真实主 pi 派活、通知叫醒取结果；fork 不确认父通知、同摘要乱序完成仍可定位 |
| `test/notify-faults.test.mjs` | P0 五个真实强杀故障时点、无提前确认、恢复后同 key 一条 |
| `test/driver.test.mjs`、`driver-faults.test.mjs` | 写锁、忽略 abort、shell 后代、覆盖范围、UI、崩溃恢复、故障保锁和停止重试 |
| `test/auth.test.mjs`、`store.test.mjs` | 握手、ticket 单次消费、租约、WAL、条件迁移、原子 outbox 和备份回滚 |
| `test/daemon.test.mjs`、`daemon-restart.test.mjs` | HTTP / 幂等、排空、就绪、批量通知及真实旧 pi 清理 |
| `test/extension-hooks.test.mjs`、`extension.test.mjs` | switch 的迟到通知屏障、managed 续期故障与恢复、最终授权、路径 fail closed 和磁盘确认 |
| `test/notification-clear-1b.test.mjs`、`claim-fork-1b.test.mjs` | 真实主 pi 清队列 / abort 后重投、同代只唤醒一次与返工再次唤醒；fork 与原会话并发认领、同 sessionId 并发租约 |
| `test/extension-client.test.mjs`、`extension-wire.test.mjs` | 双向认证、协议与发现记录故障，Windows 原子发布重试 |
| `test/cli.test.mjs`、`protocol-cli.test.mjs` | 独立 CLI 进程、单实例复用、参数和协议 |

CI 在 Windows、macOS、Linux auto / snapshot 四个组合执行 npm test。Linux auto 要求真实 cgroup 可用。Windows 完整测试后额外重复 shell 后代退出观测十次；保留 2 秒纯观察窗口和完整 StopReport / oracle 时间序列，仍不补杀。

macOS 完整测试后额外执行 25 次“忽略 abort 的 provider”真实用例；`CI` 环境下 `AGORA_STOP_PROVIDER_REPEATS` 控制该用例的注册次数（1–100，默认 1）。每次都保留原停止期限、报告校验和独立身份断言，单次失败即使后续成功也使测试失败。

停止失败以完整 JSON 输出 `code`、`message`、`verificationPhase`、`status`、`attempts`、`timeoutMs`、`identity` 和 `stopReport`。driver 的 `stopFailure` 及 `stopTrace` 记录报告校验和身份复查阶段、清队列、底层停止和进程退出的时间点；`verificationPhase` 区分报告拒绝、有效报告后的身份复查与停止/锁错误。设置 `AGORA_DRIVER_DIAGNOSTICS_DIR` 时，测试在清理临时现场前将 driver 诊断写入该目录；CI 始终上传为 `driver-diagnostics-<平台>-<模式>` artifact。

### Windows 本机实测

1b 在 Node 24.14.1、pi 1.5.0、Git 2.53.0.windows.2 上运行。真实 directory junction 把允许根内的路径指向受保护目录，read / write / 搜索祖先均被拒绝；不存在文件按 junction 的真实目标祖先判定，测试无需管理员权限。原生 PowerShell 工具在 implement 中实际执行 Write-Output 和 Set-Content，输出含原生 PSEdition，并由独立 Node 读取生成文件验证。其他平台的 PowerShell 提供边界由工具集合断言覆盖。

## 未实测与限制

- 可选 MCP / 扩展白名单和 saved 项目信任未开放。pi 1.5.0 没有独立 MCP 配置参数，配置隔离方式尚未确定；当前基线直接关闭 MCP。
- CLI 答复无设备确认，完整用户身份与审计在 1c。此项限制不能通过工具层 ACL 消除。
- Git 最低设计版本为 2.34；1b 本机实际测试版本为 2.53.0.windows.2，旧版 2.34 的 P0 证据不等同于本轮重测。lazy-fetch 回归另行移除 `GIT_NO_LAZY_FETCH`，验证兼容旧版的协议防线。真实 TTY pager 由 Linux/macOS 的 Python PTY 执行；Windows 无 POSIX PTY 时说明原因跳过，固定 `--no-pager` argv 仍有独立回归。
- 未做真实断电、PID 复用、机器重启、网络文件系统或 macOS 大小写敏感卷的破坏性实测。
- hostkit 的快照盲窗及路径校验 TOCTOU 没有消除，snapshot_visible 的空 leftovers 不证明整树退出。
- 第三方 RPC 客户端只发 abort 而不 clear_queue，可能保留原队列并产生重复记录；展示仍按 dedupeKey 去重。
