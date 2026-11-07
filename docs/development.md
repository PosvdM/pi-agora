# 开发

## 实现范围

切片 1a 提供任务的最小闭环：主会话通过 `agora_task` 派出只读子代理，daemon 监管独立 pi RPC 进程，任务 settled 后把结果和 outbox 通知同事务写入 SQLite，扩展收取通知并唤醒主会话。可用动作是 `spawn`、`status`、`result`、`stop`。

[architecture.md](architecture.md)、[tasks.md](tasks.md)、[security.md](security.md) 和 [integration.md](integration.md) 描述完整设计。1a 不提供 steer、resume、worktree、review / implement、提问、用户确认、设备配对、存档读取、board、会议或 pane 插件；这些接口在收到请求时不会降级执行。任务保留 generation，首代为 1，完整后续状态名和会话关系字段保留在协议及数据库中。

## 环境与构建

- Node.js 24 及以上、npm、pi 1.5.x。真实进程测试固定使用 pi 1.5.0。
- pi-hostkit 固定为 git 提交 `ec911be193668e4c6b3b0616323c2b18aefd142c`，不引用相邻仓库的工作区。安装 git 依赖时会运行其 prepare 构建；原生模块需要 Python 3 和 C/C++ 工具链。Windows 使用 Visual Studio Build Tools 的 C++ 工作负载。
- 存储使用 Node 内置 `node:sqlite`，不安装外部 SQLite 驱动。

```sh
npm install
npm run build
npm test
```

`npm run build` 使用 `tsc -b` 和 project references；`npm test` 先构建，再运行 `node --test --test-concurrency=1 "test/**/*.test.mjs"`。不把 `dist/`、`node_modules/` 或 `.tsbuildinfo` 提交到版本库。

## 源码结构

| 路径 | 职责 |
| --- | --- |
| `packages/protocol/src/index.ts` | HTTP 协议常量、公开类型、工具参数 schema 和版本协商 |
| `packages/protocol/src/client.ts` | 发现后台实例、双向 host.key 握手、连接 token、请求超时和自动启动 |
| `packages/daemon/src/index.ts`、`main.ts` | 单实例锁、发现信息、初始化、排空与进程入口 |
| `packages/daemon/src/server.ts` | loopback HTTP、版本与来源检查、幂等操作记录、端点路由 |
| `packages/daemon/src/auth.ts` | principal、主会话注册与恢复证明、控制租约、launch ticket、连接权限 |
| `packages/daemon/src/store.ts` | WAL 数据库、迁移与一致性备份、条件迁移、outbox |
| `packages/daemon/src/tasks.ts` | 任务控制队列、并发名额、就绪核对、settled 结果、停止和重启清理 |
| `packages/daemon/src/driver.ts` | 会话写锁、RpcSubprocessDriver、StopReport 检查、UI 取消、心跳及退出诊断 |
| `packages/extension/src/index.ts` | 主会话与子会话扩展入口、四个任务动作、租约与通知轮询 |
| `packages/extension/src/permissions.ts` | 只读工具集合、模型与 thinking 复查、路径权限检查 |
| `packages/extension/src/notifications.ts` | 在途去重、内存条目和完整磁盘行核对、通知确认 |
| `packages/cli/src/index.ts`、`main.ts` | `daemon start`、`shutdown`、`status`、`ls`、`show` |

`archive` 和 `pane-plugin` 包在后续切片创建；1a 不建立空包。各包不依赖 pi-pane。扩展仅使用 `pi-hostkit/paths` 做路径检查，不在 pi 进程内加载 hostkit 原生模块。

## 启动与配置

默认数据目录是 `~/.pi/agora`，可用 `AGORA_HOME` 或 CLI 的 `--home` 指定。daemon 只监听 `127.0.0.1` 的随机端口，发现文件是 `<AGORA_HOME>/run/daemon.json`；所有有权限的业务请求通过连接 token 鉴权，并发送 `Agora-Protocol: 1`。

```sh
node packages/cli/dist/main.js daemon start --home <本地目录>
node packages/cli/dist/main.js status --home <本地目录>
node packages/cli/dist/main.js ls --limit 50 --home <本地目录>
node packages/cli/dist/main.js show <ID> --home <本地目录>
node packages/cli/dist/main.js shutdown --timeout 600 --home <本地目录>
```

`daemon start` 和主会话扩展会自动启动 daemon。`status`、`ls`、`show`、`shutdown` 只连接已有实例，不为查询启动后台服务。发现信息存在但无法通过 host.key 核验时，客户端拒绝发送客户端证明；单实例锁阻止并行启动两个服务。CLI 输出 JSON，错误返回非零退出码。

daemon 的独立入口还接受 `--pi-path <pi 包或入口>` 和 `--extension-path <扩展入口>`：

```sh
node packages/daemon/dist/main.js --home <本地目录> --pi-path <pi 包目录>
```

这条命令在前台运行 daemon。通常使用 CLI 的后台启动方式；程序化测试可调用 `startDaemon` 并注入 `SessionDriver`。生产 HTTP 不接受额外扩展列表，协作会话只加载 agora 扩展。假 provider 和故障钩子仅由测试 driver / fixture 注入。

`shutdown` 默认等已接受的任务 settled，600 秒后仍未完成则报 `drain_timeout`，不自动强制终止。用户需显式执行 `shutdown --force`。停止先发 `clear_queue`，再通过 hostkit abort 并清理进程树；停止或写锁释放无法确认时保留现场。`snapshot_visible` 只保证快照见过的进程，不把空 leftovers 声称为完整进程树已经退出。

## 关键约束

- **启动与就绪分两层**：hostkit 的 gate 确保会话写者身份写入共享锁记录后才加载 pi。扩展用一次性 ticket 报告就绪；HTTP 响应后 pi 才结束 `session_start` 并开始读取 RPC，daemon 随后再核对 RPC 模型、thinking、会话路径和可用模型。全部通过前不发送任务书，见 [受管扩展的就绪检查](architecture.md#受管扩展的就绪检查)。
- **停止条件**：stop 在任务控制队列内检查租约和 expectedGeneration / expectedRevision，失败不修改运行标志或回收定时器。所有 `exited_at IS NULL` 的持久化 run 都纳入 stop / shutdown 清理，即使没有内存 handle；安全重试失败时返回 stop_incomplete，保持 daemon 和诊断可用。
- **停止与恢复**：正常停止和崩溃诊断保留 StopReport、最近 50 条事件、活动工具、stderr 和可能副作用。重启读取没有确认退出的 process_runs；旧写者按进程身份停止并确认退出后才可重新打开会话文件。1a 不开放恢复任务的用户动作，不自动重放运行中的任务。
- **通知确认**：内存条目和磁盘上完整、带换行的 JSONL 行必须具有同一 entryId、noticeId 和 dedupeKey，才能确认持久通知。`message_end` 回调、排队中的消息以及未首次落盘的内存会话条目都不是磁盘证据。inbox 每批最多返回 200 条，扩展连续取到空批为止；可见性超时后的重投仍按 dedupeKey 去重。ephemeral 主会话只确认内存送达，不声明可恢复。
- **幂等**：服务端按 principal 与 Idempotency-Key 记录请求指纹及当前操作状态；同 key 不同参数返回冲突，不启动第二个任务。调用方发生超时时需用原 key 重试，不通过换 key 推断上次没有执行。
- **迁移**：schema v2 允许同一任务关联多个继承会话，tasks 指向当前会话，每代单独关联所属会话。迁移从 v1 回填代数关联，重建会话表保留数据、显式索引和触发器，提交前检查外键。同一个数据库连接调用 SQLite backup，再以只读连接核对备份完整性；所有 DDL 在事务中执行。备份或迁移失败不继续启动，不复制 WAL 主文件充当一致性备份。

## 测试与 CI

测试使用真实 pi 1.5.0 加本地脚本 provider，不连接模型服务。`PI_PACKAGE` 可指定 pi 包目录；没有指定时先按 hostkit 定位规则找到安装，再隔离 HOME。测试把 HOME、USERPROFILE、APPDATA、LOCALAPPDATA、agent 配置、数据目录和 hostkit 锁目录指向独立临时现场，不访问使用者的 agent 设置和会话。`KEEP_FIXTURES=1` 可保留普通测试现场，通知故障失败时自动保留证据目录。

| 测试文件 | 验收与边界 |
| --- | --- |
| `test/e2e.test.mjs` | 真实主 pi 调用 spawn；只读子 pi 读取文件并完成；主会话由通知自动唤醒，再调用 result；独立核对文件不变、工具集合和磁盘通知确认 |
| `test/notice-fork.test.mjs` | 父会话已有落盘通知后真实 fork，新 principal 不确认父通知；新任务乱序完成且摘要相同时，模型正文仍包含各自 taskId、generation、标题、状态和 result 参数 |
| `test/notify-faults.test.mjs` | 五个 P0 通知故障时点真实强杀并恢复；第一项使用实际子任务完成时关闭主会话；断言原 principal / task 结果保留、无提前确认、最终同 key 只落盘一次 |
| `test/driver.test.mjs`、`test/driver-faults.test.mjs` | 写锁、就绪门槛、忽略 abort 的工具和 provider、shell 后代、StopReport 覆盖范围、扩展 UI、超时、崩溃和旧进程恢复；独立模块 mock 验证清理失败保留锁、多旧身份恢复屏障和清理确认 |
| `test/extension-hooks.test.mjs`、`test/extension.test.mjs` | 扩展幂等初始化、认证恢复、只读权限、fail closed、路径及符号链接、通知确认和去重 |
| `test/auth.test.mjs`、`test/store.test.mjs` | 双向握手、挑战与 ticket 单次消费、主会话恢复与租约、ephemeral、WAL、原子 outbox、条件迁移、一致性备份和迁移失败回滚 |
| `test/daemon.test.mjs`、`test/daemon-restart.test.mjs` | HTTP 鉴权与版本、spawn 幂等、并发与就绪拒绝、排空、通知批量，以及真实 daemon 强杀后的旧进程清理与中断通知 |
| `test/extension-client.test.mjs` | 客户端握手、防假 daemon、发现过期实例、token 续期、自动启动取消和输入校验 |
| `test/protocol-cli.test.mjs` | 协议版本、客户端地址限制、参数校验与 CLI 帮助 |
| `test/cli.test.mjs` | 独立 CLI 进程自动启动、单实例复用、status / ls / show 和排空关闭 |

通知故障测试在受控子进程里包装生产扩展调用点，强杀进程而不是用异常代替崩溃。ack 前杀 daemon 的夹具将重连握手挂起，直到旧 pi 退出，避免生产扩展自动启动实例与测试控制的重启争抢锁；生产自动重连路径另有测试。公共事件故障点只声称 pi 内部 listener 已运行，不声称 RPC 对端已收到消息。为缩短测试时间，fixture 把 inbox 可见性设为 150 毫秒，并直接使旧租约过期；生产仍使用 120 秒和 90 秒。无对话的静默通知用例预建仅含 header 和 principal 引用的会话，不预写通知；它验证通知首次落盘边界，不声称进程退出后能恢复尚未落盘的 principal 引用。

CI 的 `.github/workflows/ci.yml` 用 Node 24 安装原生依赖和 pi 1.5.0，执行相同的 `npm test`：Windows 和 macOS 各一次；Linux auto / snapshot 各一次。Linux auto 启动用户 systemd 实例并要求 cgroup 可用，避免静默退回快照模式。每项自动测试都在这四个矩阵组合运行，平台差异由 StopReport 断言区分。

## 未实测范围

- macOS 及 Linux 快照模式不可见的孤儿进程盲窗没有消除；仅检查已记录或当前可见的后代。
- 没有进行真实断电、PID 复用、机器重启、网络文件系统或 macOS 大小写敏感卷的破坏性实测。
- 自动化测试不代替真实关闭终端窗口的手动验证；Windows 和 Linux 的关窗口行为不列为 1a 已实测结果。
- 浏览器设备确认、MCP、review 的 git 查询和 implement 工具不在 1a 测试范围。
