# 总体架构

> 状态：设计草案。接口、表结构和默认值都是草案，P0 验证后冻结。

pi-agora 是 pi 的协作引擎：一个每用户单实例的后台进程（daemon）负责拉起和监管所有协作会话（子代理、参会者、书记），并持久保存任务、提问、共享桌面（board）、会议和全部对话。主代理通过 pi 扩展调用它，用户通过 CLI 或 pi-pane 插件调用它。

本文覆盖组件、进程模型、daemon 生命周期、存储、权限档位、worktree、崩溃与恢复、资源与回收和平台注意事项。其他内容见：

- 安全模型（身份、用户确认、设备配对、访问控制、剩余风险）：[security.md](security.md)
- 平台相关能力（pi 定位、RPC 传输、进程树终止、锁、路径规范化）：[hostkit.md](hostkit.md)
- 任务（子代理）：[tasks.md](tasks.md)
- 共享桌面：[board.md](board.md)
- 会议：[meetings.md](meetings.md)
- 对话存档：[archive.md](archive.md)
- daemon HTTP API 与接入 pi-pane 的映射：[integration.md](integration.md)

## 设计约束

- **基座是 pi**（`@earendil-works/pi-coding-agent` 1.5.x）。不重写 Agent 循环、Provider、上下文压缩。pi 的定位方式和版本检查见 [hostkit.md](hostkit.md#定位-pi)。文档中对 pi 行为的依据以 pi 1.5.0 的文件为准，路径相对于 pi 包目录。
- **三个平台同时支持**：Windows、macOS、Linux。与平台相关的部分都放在共享包 pi-hostkit 里。
- **每个会话一个 `pi --mode rpc` 子进程**。某个会话里的工具卡死或进程崩溃，不影响其他会话和 daemon。
- **单一驱动**：MVP 只实现 RPC 子进程这一种会话驱动，保留 `SessionDriver` 接口，不同时维护进程内 SDK 驱动。
- **协作状态只有一个写者**：任务、提问、board、会议、outbox 都由 daemon 写。终端、pi-pane、CLI 都是客户端，不各自运行调度器。
- **可以单独使用**：不装 pi-pane 时，主代理在 pi 终端里通过扩展使用全部主 Agent 级功能。用户级操作在只用终端时的处理见 [security.md](security.md#只用终端)。
- **权限只到工具层**，不是沙箱，详见“权限档位”。

## 组件

```text
 pi 终端（主代理）        pi-pane 托管的主会话          用户
   └─ agora 扩展            └─ agora 扩展               ├─ agora CLI
          │                        │                    └─ pi-pane 浏览器
          │ loopback HTTP          │                           │
          ▼                        ▼                           ▼
 ┌──────────────────────── agora daemon ─────────────┐   pi-pane 服务端
 │ 鉴权与确认 │ 任务 │ 提问 │ board │ 会议 │ outbox  │◄── agora pane 插件
 │ 进程监管（SessionDriver） │ 存档 │ SQLite        │
 └──────┬──────────────┬──────────────┬──────────────┘
        ▼              ▼              ▼
  pi --mode rpc   pi --mode rpc   pi --mode rpc      （子代理 / 参会者 / 书记）
   └─ agora 扩展   └─ agora 扩展   └─ agora 扩展
```

| 组件 | 包（草案） | 职责 |
| --- | --- | --- |
| daemon | `packages/daemon` | 进程监管、鉴权与用户确认、任务/提问/board/会议状态机、outbox、存档、HTTP API |
| pi 扩展 | `packages/extension` | 装进主代理和每个协作会话；按 token 的权限注册工具，收取通知并注入会话，执行工具层权限检查 |
| CLI | `packages/cli` | 启停 daemon、列出和查看所有会话、发起用户级操作（生成待确认）、设备与配置管理 |
| archive adapter | `packages/archive` | 版本化只读存档读取库与用户聊天视图投影，daemon 不运行时也能用，详见 [archive.md](archive.md) |
| pane 插件 | `packages/pane-plugin` | 运行在 pi-pane 服务端，把 daemon 的数据映射成 pi-pane 的树节点、面板、动作、表单，详见 [integration.md](integration.md) |
| 协议类型 | `packages/protocol` | daemon HTTP API 的 TypeScript 类型与 JSON schema |
| 平台能力 | `pi-hostkit`（独立包） | pi 定位、RPC 传输、进程树终止、锁、密钥权限、路径规范化，详见 [hostkit.md](hostkit.md) |

依赖方向：

- `daemon` 依赖 `pi-hostkit`；`extension` 的路径校验也使用 `pi-hostkit` 的路径规范化。pi-pane 同样依赖 `pi-hostkit`，pi-pane 与 pi-agora 的核心包彼此不依赖。
- `daemon`、`extension`、`cli`、`archive`、`protocol` 都不依赖 pi-pane；只有 `pane-plugin` 把 pi-pane 的 `@pi-pane/plugin-api` 作为 peer 依赖。pane 插件接口以 pi-pane 仓库的 `docs/plugin-api.md` 为准，daemon API 和 agora 到 pane 的映射以本仓库的 [integration.md](integration.md) 为准。

模块边界：

- daemon 内部按领域分模块（`tasks`、`requests`、`board`、`meetings`、`archive`、`supervisor`、`auth`）。领域规则留在各自模块里，`supervisor` 只管进程，不理解“任务”或“会议”。
- 扩展不保存协作状态，进程重启后从 daemon 取。
- pane 插件只调用 daemon 的 HTTP API 和 archive adapter，不读 SQLite 表结构。

## 进程模型

### 会话驱动

```ts
// 草案，P0 后冻结
interface SessionDriver {
  start(spec: LaunchSpec): Promise<DriverHandle>;
}

interface DriverHandle {
  readonly identity: ProcessIdentity;                    // pid + 创建时间 + runId + instanceId，见 hostkit.md
  send(cmd: RpcCommand, opts?: { timeoutMs?: number }): Promise<RpcResponse>; // pi RPC 命令，见 pi docs/rpc-commands.md
  onEvent(listener: (ev: RpcEvent) => void): () => void; // 会话事件与 extension_ui_request
  respondUi(res: ExtensionUiResponse): void;
  stop(opts: StopOptions): Promise<StopReport>;           // 进程树终止，见 hostkit.md
}

interface LaunchSpec {
  agoraSessionId: string;
  runId: string;
  cwd: string;                  // 作为 spawn 参数传入，不调用 process.chdir()
  model: string;                // 完整 provider/id
  thinking: ThinkingLevel;
  profile: "explore" | "review" | "implement";
  sessionFile: string;          // daemon 预先分配的会话文件路径，首次启动和恢复都用 --session 传入
  env: Record<string, string>;  // AGORA_URL、AGORA_LAUNCH_TICKET；不含 AGORA_HOME，见 security.md
}
```

MVP 的唯一实现是 `RpcSubprocessDriver`，用 pi-hostkit 的 `spawnManaged` 和 `RpcTransport`（JSONL 只按 LF 切分，不用 `readline`，见 [hostkit.md](hostkit.md#rpc-传输)）。

拉起前，daemon 先用 pi-hostkit 取得该会话文件的**会话写锁**（[hostkit.md](hostkit.md#会话写锁)），保证 pi-pane 和 daemon 不会同时托管同一个会话文件。取得锁后先按共享记录清理上一个写者（可能是 pi-pane 留下的，见 [hostkit.md](hostkit.md#取得锁之后)），拉起 pi 后立即把它的进程身份写入记录；确认进程树已退出后才释放。

### 启动参数

daemon 用 `process.execPath`（Node）直接运行 pi 的 JS 入口（`package.json` 的 `bin.pi`，1.5.0 中为 `dist/bundle/cli.js`），不经 shell。

```text
node <pi>/dist/bundle/cli.js --mode rpc
  --session-dir <AGORA_HOME>/sessions/<agoraSessionId>
  --session <AGORA_HOME>/sessions/<agoraSessionId>/session.jsonl   # 首次启动和重新拉起都用同一路径
  --model <provider/id> --thinking <level>
  --tools <按档位的白名单>
  -ne -e <agora 扩展路径> [ -e builtin:mcp ]  # 后者仅 implement 且配置了 MCP 白名单
  -ns -np
  --no-approve                              # 默认所有档位都加，见下文“项目信任”
```

依据：`docs/cli.md`（Sessions、Tools、Resources、Prompts and process 各节）、`docs/rpc.md`。

- `-ne` 关闭自动发现、配置和内置的扩展，包括内置 MCP 支持；显式 `-e` 仍加载（依据：`docs/cli.md` 的 `-ne` 说明）。所以协作会话默认没有 MCP，不需要 `--no-mcp`。协作会话只加载 agora 扩展，避免把用户的其他扩展带进子会话。
- `-ns`、`-np` 关闭自动发现的 skill 和提示词模板，协作会话的行为只由任务书决定。
- **会话文件路径由 daemon 预先分配**：daemon 先取得该路径的会话写锁，再用 `--session <路径>` 拉起。文件不存在时 pi 新建会话并沿用这个路径（依据：`dist/main.js` 的 `resolveSessionPath`、`dist/core/session-manager.js` 的 `_setSessionFile`），所以不用 `--session-id`（它让 pi 自己生成文件名，daemon 无法在 pi 打开文件之前取锁，见 [hostkit.md](hostkit.md#取得锁的时机)）。pi 的会话 id 由 pi 生成，启动后用 RPC `get_state` 读出 `sessionFile` 和 `sessionId` 核对并记入 SQLite（依据：`docs/rpc-commands.md` 的 `get_state`）。

#### 项目信任

- explore、review、会议席位和书记固定加 `--no-approve`，不加载需要项目信任的本地配置和资源（依据：`docs/cli.md` 的 `--no-approve`、`docs/security.md` 的 Understand project trust）。
- implement 默认也加 `--no-approve`；配置 `implement.projectTrust: "saved"` 后不加该参数，改按用户已保存的信任决定（`~/.pi/agent/trust.json`）。RPC 模式不能弹出信任提示，没有保存决定时按 `defaultProjectTrust` 处理（依据：`docs/security.md` 的 Project trust without an interactive prompt）。不加 `--approve`。注意：即使目录里没有需要信任的项目资源，如果 `trust.json` 中记为 false，仍按不信任处理。
- `AGENTS.md`、`CLAUDE.md` 等上下文文件不受项目信任控制，仍会加载（依据同上）。agora 不加 `-nc`，因为项目约定对子代理有用；任务书提醒子代理把仓库里的指令当作不可信输入。

### 受管扩展的就绪检查

协作会话的安全检查都在 agora 扩展里，所以扩展没有正常工作时会话必须不能做任何事（fail closed）：

1. 扩展加载后立即用 launch ticket 换连接 token（ticket 绑定 runId，见 [security.md](security.md#协作会话)）。
2. 就绪等待：MCP 工具注册是异步的，在 `session_start` 时可能尚未完成。扩展必须等 MCP 工具注册完成（或等到超时按 fail closed 处理），生成工具清单前按平台过滤（macOS 和 Linux 上不列 `powershell`），再向 daemon 报告就绪：`POST /v1/runs/:runId/ready`，带完整的 `pi.getActiveTools()` 结果、当前模型和 thinking 级别、扩展版本（依据：`dist/core/extensions/types.d.ts` 的 `getActiveTools`、`getThinkingLevel`）。
3. daemon 核对：活动工具集合与档位白名单完全一致；模型和 thinking 与 `LaunchSpec` 一致，并用 RPC `get_state` 再核对一次模型；扩展版本与 daemon 兼容。全部通过后 run 进入 `ready`，daemon 才发送任务书或会议消息。
4. 就绪前，扩展的 `tool_call` 钩子拒绝一切工具调用。钩子内部必须显式用 `try/catch` 包住，出异常时自行记录 fatal 诊断并返回 `{ block: true }` 拒绝调用，不依赖 pi 对抛出异常的处理方式（实测裸钩子抛错时 pi 不发 RPC `extension_error`，进程不会自行退出；安全策略必须 fail closed 自行闭环）。
5. 就绪超时（`readyTimeoutMs`，默认 30000）、核对失败、或运行期间收到来自 agora 扩展的 `extension_error` 事件（依据：`docs/json.md`），daemon 立即停止该 run，记录诊断；任务进入 `failed`（首次启动）或 `interrupted`（恢复时），并通知召集人。

### 禁止会话替换

协作会话的会话文件由 daemon 分配并持有写锁，进程内不能切换到别的会话。daemon 不发 RPC `new_session`、`switch_session`、`fork`、`clone`；agora 扩展注册 `session_before_switch` 和 `session_before_fork`，一律返回 `{ cancel: true }`。pi 只要有一个处理器返回取消就取消替换，不再执行后面的处理器（依据：`dist/core/extensions/runner.js:813–825`），所以 implement 档位按白名单加载的其他扩展调用 `newSession`、`fork`、`switchSession` 也会被取消。万一仍出现 `session_shutdown`（`reason` 为 `new`、`resume`、`fork`），daemon 立即停止该 run 并标为中断。规则与 [hostkit.md](hostkit.md#取得锁的时机) 一致。

### 扩展 UI 请求

协作会话里没有人看界面，扩展的 `ctx.ui.*` 对话框请求（`extension_ui_request`，依据：`docs/rpc-extension-ui.md`）由 daemon 统一处理，不能无限等待：

| 方法 | 处理 |
| --- | --- |
| `select`、`confirm`、`input`、`editor` | 默认立即回应 `{ cancelled: true }`。配置 `childUiPolicy: "pending"` 时，转成召集人（不可达时为用户）的待处理事项，`childUiTimeoutMs`（默认 10 分钟）内无人回应则回应取消 |
| `notify`、`setStatus`、`setWidget`、`setTitle`、`set_editor_text` | 记入会话事件流供查看，不需要回应 |

就绪检查完成之前收到的对话框请求一律立即取消。

### 与会话的通信

- **常规控制和聊天流**走 RPC 的 stdin/stdout：任务书用 `prompt`，返工用 `steer` 或 `prompt`，停止用 `clear_queue` + `abort`，结果用 `get_last_assistant_text`，会话条目用 `get_entries`（pi 已记录的条目，不一定已写入文件），事件流照 `docs/json.md` 的定义转发。
- **扩展 ↔ daemon** 走 loopback HTTP（见 [security.md](security.md)）：工具调用、通知收取、投递确认、就绪报告。
- `pi.events` 是进程内事件总线，不跨进程、不持久，只用于同一 pi 进程内扩展之间通信（依据：`dist/core/event-bus.d.ts`）。

### 控制队列与并发

同一会话可能同时收到多个控制请求（召集人 steer、用户停止、通知投递、会议调度、空闲回收），daemon 按以下规则串行化：

- **每个任务、每个会话一个串行控制队列**。改变会话或任务状态的操作（发送 prompt/steer、停止、恢复、回收、注入通知）都排进队列，一次执行一个。
- **条件迁移**：每次状态迁移都带 `expectedGeneration` 和 `expectedRevision`，在 SQLite 里用条件更新执行；条件不满足时返回 `409 conflict`，调用方重新读取状态后再决定。
- **停止中**：停止或 `interrupt` 返工开始后，会话进入内部的 `stopping` 控制状态（对外仍显示原状态，`statusDetail` 为“停止中”）。这期间 outbox 通知、board 投递、会议调度都不会唤醒该会话，直到停止完成或新一代开始。
- **不依赖 pi 队列存活**：`clear_queue` 会清掉 pi 队列里排队的所有消息，包括扩展注入的自定义消息（依据：`docs/rpc-commands.md` 的 `clear_queue`、`dist/core/agent-session.js` 的 `sendCustomMessage`）。所以通知以 outbox 为准，只有在会话文件里找到对应记录后才算送达（见 [tasks.md](tasks.md#完成通知与-outbox)）；被清掉的通知会在下次投递时重发。

## daemon 生命周期

### 数据目录

默认 `~/.pi/agora/`，可用环境变量 `AGORA_HOME` 覆盖。必须在本地磁盘上（见 [hostkit.md](hostkit.md#支持的平台)）。

```text
<AGORA_HOME>/
  agora.db              # SQLite（WAL 模式）
  run/daemon.lock       # POSIX 单实例锁文件（Windows 用命名 mutex，无此文件）
  run/daemon.json       # 发现信息：端口、pid、instanceId、版本、协议范围
  secret/host.key       # 磁盘凭证（主 Agent 级），见 security.md
  secret/principals/    # 主会话的恢复凭证
  sessions/<agoraSessionId>/   # pi JSONL、流片段、退出诊断，见 archive.md
  backups/              # 升级前的数据库备份
  logs/
```

`secret/` 目录只允许当前用户访问，由 pi-hostkit 的 `ensurePrivateDir` 设置和检查（见 [hostkit.md](hostkit.md#密钥目录权限)）。

### 单实例与启动

1. 用 pi-hostkit 的单实例锁（Windows 命名 mutex，POSIX `flock`）取得 `AGORA_HOME` 的 daemon 锁。拿不到说明已有实例：读 `run/daemon.json`，对其中的端口做认证握手（[security.md](security.md#握手)），成功则直接使用该实例；失败则报错，让用户检查（可能是另一个版本的 daemon 正在启动或退出）。锁随进程退出自动释放，不处理残留锁文件。
2. 处理上一个实例遗留的进程，见“daemon 崩溃或重启”。
3. 监听 `127.0.0.1` 的随机端口，写 `daemon.json`，开始接受请求。

谁来启动：扩展和 CLI 在找不到可用 daemon 时自动拉起（detached、`windowsHide: true`、不经 shell），也可以手动运行 `agora daemon start`。

### 关闭

- 关闭终端或 pi-pane **不会**让 daemon 退出，运行中的任务继续执行。
- `agora shutdown`：排空。停止接受新任务和新会议；等运行中的会话到达 settled；超过 `--timeout`（默认 10 分钟）后询问是否强制。
- `agora shutdown --force`：把运行中的任务和会议标记为 `interrupted`，写入退出诊断，再停止所有子进程。
- daemon 空闲时不自动退出（MVP）。

### 升级

不热替换运行中的调度器。新版本 CLI 或扩展发现正在运行的 daemon 版本不同时：

1. 协议兼容（双方协议版本区间有交集）→ 继续使用旧 daemon，提示用户择机升级。
2. 不兼容 → 拒绝连接并提示运行 `agora shutdown`。
3. 新 daemon 启动时发现 `schema_version` 低于自身：
   1. 用 SQLite 在线备份接口（`node:sqlite` 的 `backup()`）把 `agora.db` 备份到 `backups/agora-<旧版本>-<时间>.db`。WAL 模式下直接复制文件可能得到不一致的副本，所以不用文件复制。**备份约束**：备份只用同一个连接，或者一步复制（`rate` 设为极大值一步复制全部页）；不能使用独立连接做逐步 `backup()`（写入持续并发时独立连接会被打断重置而永远无法完成）。以只读方式打开 WAL 数据库同样会创建 `-wal` 和 `-shm` 文件，因此数据库所在目录必须对 daemon 进程保持可写。
   2. 以只读方式打开备份，执行 `PRAGMA integrity_check`，通过后才继续。
   3. 在一个事务里执行迁移。备份或校验失败、迁移失败，都保持原库不动并退出。

版本协商见 [integration.md](integration.md#版本协商)。

## 身份与鉴权

完整定义见 [security.md](security.md)。要点：

- daemon 只信任自己签发的连接 token，请求体里的身份字段一律忽略。
- 权限分三级：子 Agent 级（协作会话，凭 launch ticket）、主 Agent 级（主代理及 CLI、pane 插件，凭磁盘上的 `secret/host.key` 和主会话恢复凭证）、用户级。
- 主代理是用户的代理人：可以裁决自己召集的会议，在 `agentLimitCap` 以内提高自己会议的上限。
- 用户级操作（超过封顶的预算、答复转给用户的提问、用户召集的会议的决定、以用户为作者的 board 条目、设备与安全设置等）必须由已配对浏览器的设备密钥对 daemon 的挑战签名；CLI 只能发起待确认。
- 身份由 token 决定，不看工作目录：worktree 里的会话和主目录里的一样通信。

## 存储

| 内容 | 位置 | 说明 |
| --- | --- | --- |
| 业务状态 | `agora.db`，SQLite | Node 24 内置 `node:sqlite`，无原生驱动依赖；WAL 模式；daemon 是唯一写者 |
| board 条目 | `agora.db` 的追加表 | 只插入不更新正文 |
| 待投递通知 | `agora.db` 的 `outbox` 表 | 与状态变更同事务写入，见 [tasks.md](tasks.md#完成通知与-outbox) |
| 对话 | pi JSONL | 由 pi 自己写，daemon 不复制到数据库 |
| 流片段、退出诊断 | `sessions/<id>/` 下的文件 | 见 [archive.md](archive.md) |

不做通用事件溯源：业务状态用普通表，board 条目追加，状态变更和 outbox 在同一事务里完成。代价是不能重放任意历史时刻的业务状态；需要追溯的信息（board、对话、状态变更时间）都单独保存。

`node:sqlite` 的 API 是同步的，查询会阻塞 daemon 事件循环。约束：所有列表查询带 `LIMIT`，大字段（board 正文、诊断）按需读取，单个事务内不做 I/O 等待。

主要表（草案）：

| 表 | 主要字段 |
| --- | --- |
| `principals` | id、type、label、pi_session_id、session_file、forked_from、created_at |
| `agora_sessions` | id、kind、profile、model、thinking、cwd、session_file、pi_session_id、convener_id、parent_principal_id、task_id、meeting_id、inherits_from、inherit_reason、status、control_state、revision、archive_state、created_at、ended_at |
| `process_runs` | id（runId）、agora_session_id、pid、process_start_time、daemon_instance_id、state（starting / ready / exited）、started_at、exited_at、exit_code、signal、diagnostics_path |
| `tasks`、`task_generations`、`steer_messages` | 见 [tasks.md](tasks.md) |
| `requests` | 见 [tasks.md](tasks.md#提问答复与转交) |
| `worktrees` | id、task_id、repo_root、base_commit、branch、path、owner_id、state |
| `boards`、`board_entries`、`board_drafts`、`board_cursors` | 见 [board.md](board.md) |
| `meetings`、`meeting_seats`、`meeting_revisions`、`meeting_endorsements`、`meeting_objections`、`budget_ledger` | 见 [meetings.md](meetings.md) |
| `outbox` | id、recipient_id、dedupe_key（唯一）、kind、payload、created_at、visible_after、delivered_at、persisted_at、acked_at、attempts |
| `changes` | seq、epoch、object_type、object_id、tombstone、created_at（供 `/v1/changes`，见 [integration.md](integration.md#变更流)） |
| `pending_confirmations` | id、action、target、params、params_hash、nonce、requested_by、expires_at、state、result |
| `devices` | device_id、public_key、alg、label、state（pending / paired / revoked）、paired_at、approved_by |
| `audit_log` | 见 [security.md](security.md#审计) |
| `settings` | key、value（如 `userConfirmation`、`everPaired`、`reTofuArmed`、`meetingLimitDefaults`、`agentLimitCap`、daemon 记下的设备记录指纹） |
| `security_alerts` | alert_id、kind（devices-reset / protection-off）、revision、details、state（open / acknowledged / resolved）、acknowledged_by、updated_at |
| `schema_version` | version、migrated_at |

## 权限档位

会话种类和权限分开：`kind` = `task | meeting-seat | secretary` 决定会话在流程里的角色；`permissionProfile` = `explore | review | implement` 决定能用哪些工具。参会者和书记固定用 `explore`。

| 档位 | 内置工具 | 其他 |
| --- | --- | --- |
| `explore` | `read`、`grep`、`find`、`ls` | agora 工具；无 MCP；只加载 agora 扩展；`--no-approve` |
| `review` | 同 explore | 另加只读 git 查询工具 `agora_git`（见下文“`agora_git` 的加固”）；不能跑测试 |
| `implement` | `read`、`bash`、`edit`、`write`、`grep`、`find`、`ls`；Windows 上按配置可加 `powershell` | agora 工具；MCP 按配置白名单开启；其他扩展按配置白名单加载 |

执行方式：

1. **工具白名单**：`--tools` 用明确的工具名列表，例如 explore 为 `read,grep,find,ls,agora_*`。列明工具名时会替换整个默认选择，`codemode` 不在列表里就不会启用（依据：`docs/cli.md` 的 Tools 一节）。就绪检查再核对一次实际的活动工具集合。
2. **MCP**：协作会话因 `-ne` 默认没有 MCP。implement 需要 MCP 时显式加 `-e builtin:mcp`，并在 `--tools` 里只列白名单服务器的工具（如 `mcp__radius__*`）。P0 实测表明：MCP 白名单只限制工具能否调用，不限制服务器启动（未列入的服务器仍会被拉起并初始化）。为防止未列入的服务器启动造成副作用或凭证泄露，agora 为每个子代理单独生成一份只含白名单服务器的 MCP 配置文件。就绪检查必须等待异步 MCP 工具注册完成后才发任务书。
3. **路径校验**：比较路径前两端先调用 realpath（解决如 macOS 上系统临时目录 `event.cwd` 在 `/private/var` 与 `/var` 的不一致）。详见下节。
4. **不依赖工具注解**：`readOnlyHint` 等注解未经验证（依据：`docs/extensions.md`），不作为放行依据。
5. **恢复不提权**：重新拉起进程时档位从 SQLite 读取，不接受客户端传入。

边界说明：

- explore/review 是严格只读：不开 shell、MCP、codemode、网络。“只读”指不改工作文件；写 board、发起提问属于协作权限，照常允许。
- **implement 开了 `bash`（Windows 上还可能有 `powershell`）之后，不保证命令不越出工作目录**。对这两个工具只能决定是否提供，不检查命令内容，也不做路径隔离；路径校验只覆盖文件类工具（`read`、`grep`、`find`、`ls`、`edit`、`write`）。这一层叫“工具层权限”，不叫沙箱；需要抵御恶意脚本时要用容器或虚拟机，不在本项目范围内。

### 路径校验

agora 扩展注册 `tool_call` 钩子（依据：`docs/extensions.md` 的 `tool_call`），对文件类工具的路径参数用 pi-hostkit 的 `canonicalPath` 规范化（与 pi 解析路径的规则一致，再取真实路径，见 [hostkit.md](hostkit.md#路径规范化)）后检查：

- **允许根目录**：explore/review 的 `read`、`grep`、`find`、`ls` 的目标必须在允许根目录（会话 cwd 加配置的额外只读根）内。
- **受保护目录**：所有档位的文件类工具都拒绝受保护目录（`AGORA_HOME/secret` 和配置项 `protectedPaths`）及其下的路径。
- **搜索类工具**：`grep`、`find`、`ls` 的搜索根（`path` 参数，省略时为 cwd）如果是某个受保护目录的祖先（或就是它），直接拒绝，并提示缩小搜索范围。这几个工具都没有排除参数：`grep` 只有一个可选的 `glob` 过滤，`find` 只有 `pattern`（glob）和 `path`，`ls` 只有 `path`（依据：`dist/core/tools/grep.js:11–18`、`dist/core/tools/find.js:17–23`、`dist/core/tools/ls.js:8–10`），无法可靠地追加排除规则，所以不采用“强制排除”。pi 1.5.0 调用 `rg`、`fd` 时带 `--hidden`、不带 `--follow`（依据：`dist/core/tools/grep.js:95`、`dist/core/tools/find.js:128`），不会顺着搜索根下的符号链接进入受保护目录；agora 不改变这些参数。
- **写入新文件**：`write` 的目标不存在时，对最深的已存在祖先取真实路径再判断。
- **`bash` 和 `powershell`**：不做路径校验，只在 implement 档位提供（`powershell` 只在原生 Windows 上、按配置开启）。见上文“边界说明”。

P0 测试用例：搜索根是受保护目录的祖先、受保护目录嵌套在允许根内、符号链接和 junction、校验后切换链接、`write` 新文件、大小写和 Unicode 变体。

### `agora_git` 的加固

只读的 git 命令也能执行代码：仓库自带的 `.git/config` 和 `.gitattributes` 可以配置 `diff.<driver>.textconv`、`diff.external`、`core.fsmonitor`、`core.pager`、`filter.<driver>.clean`、`log.showSignature`（会调用 `gpg.program`）等。review 任务审查的恰恰可能是不可信的代码，所以 `agora_git` 按以下规则执行：

- **调用方式**：`execFile("git", argv, { cwd: 任务工作目录, env })`，不经 shell；单次超时 30 秒，输出上限 1 MiB。
- **固定前缀**（全部是 git 的全局选项，放在子命令之前）：

  ```text
  git --no-pager --no-optional-locks
      -c core.fsmonitor=false -c core.pager=cat -c color.ui=never -c log.showSignature=false
      [ -c filter.<driver>.clean= -c filter.<driver>.smudge= -c filter.<driver>.process= ]…   # 见下文 filter
  ```

- **各子命令的完整 argv**（`<前缀>` 为上面的固定前缀；`[白名单选项]` 见下；末尾总是追加 `--`，之后才是路径）：

  | 子命令 | argv |
  | --- | --- |
  | `status` | `<前缀> status --porcelain=v1 --ignore-submodules=all --untracked-files=normal -- [<路径>…]` |
  | `diff` | `<前缀> diff --no-ext-diff --no-textconv --no-color [白名单选项] [--cached] [<提交> \| <提交>..<提交>] -- [<路径>…]` |
  | `log` | `<前缀> log --no-ext-diff --no-textconv --no-color --no-show-signature [白名单选项] [<提交范围>] -- [<路径>…]` |
  | `show` | `<前缀> show --no-ext-diff --no-textconv --no-color --no-show-signature [白名单选项] <提交> -- [<路径>…]` |

  `status` 不接受 `--no-color`，颜色由全局的 `-c color.ui=never` 关闭；`--no-optional-locks` 是全局选项，不能放在子命令之后。git 最低支持版本定为 **2.34**（覆盖主流仍维护的 LTS 发行版如 Ubuntu 22.04 自带版本，补测已在 git 2.34.1 与 2.56.0 上通过，见 `experiments/p0/c-tools/RESULTS.md`）。实测差异：git 2.34 会将 `core.fsmonitor=false` 解释为执行名为 `false` 的 hook（执行从 PATH 解析的 false 退出，无害且恶意 fsmonitor 未触发），后续评估统一改用 `-c core.fsmonitor=` 并双版本验证。
- **环境变量**：在继承的环境上设 `GIT_CONFIG_NOSYSTEM=1`、`GIT_PAGER=cat`、`PAGER=cat`、`GIT_EXTERNAL_DIFF=`（空）、`GIT_TERMINAL_PROMPT=0`，并去掉 `GIT_DIR`、`GIT_WORK_TREE`、`GIT_CONFIG_PARAMETERS`、`GIT_CONFIG_COUNT` 及 `GIT_CONFIG_KEY_*` / `GIT_CONFIG_VALUE_*`。
- **白名单选项**：模型只能传白名单内的选项（如 `--stat`、`--name-only`、`--name-status`、`-n <数字>`、`--oneline`、`--format=<固定几种>`、`-U<数字>`、`--cached`（仅 `diff`））、提交号和提交范围，以及 `--` 之后的路径。其余一律拒绝，尤其是 `-c`、`--output`、`--exec`、`--git-dir`、`--work-tree`、`-C`、`--ext-diff`、`--textconv`、`--show-signature`、`--config-env`、`--color` 和任何会写文件或改引用的选项。提交号和范围用正则校验（十六进制、分支名字符、`..`、`~n`、`^`），不允许以 `-` 开头，不允许包含 `:`（防止 `<提交>:<路径>` 形式读取任意 blob 时触发 textconv）。
- **路径限定**：`--` 之后的路径用 `canonicalPath` 规范化，必须在任务工作目录内，同时受“受保护目录”规则约束。
- **filter**：`status` 和对工作区的 `diff` 在文件状态信息过期时可能对工作区文件运行 `filter.<driver>.clean` 或 `process`。每次执行前用 `git config --get-regexp "^filter\."` 读出仓库配置的 filter（读配置不执行代码），对每个 driver 在前缀中用 `-c` 把 `clean`、`smudge`、`process` 覆盖为空。空值是否等于禁用 filter **未核实**；P0 不通过则 review 档位不提供 `status` 和工作区 `diff`（只保留针对提交的 `diff`、`log`、`show`）。

P0 用一个带恶意配置的测试仓库验证：仓库配置了 textconv、`diff.external`、`core.fsmonitor`、`core.pager`、clean/smudge/process filter、`log.showSignature` + `gpg.program`，并让工作区文件的状态信息过期；对 `status`、`diff`（工作区、`--cached`、两个提交之间）、`log`（含 `-p`）、`show` 的每一种调用都检查，这些程序一次都不会执行（用写标记文件的脚本判断）。

## worktree

任务可以选择 `isolation: "worktree"`，在独立 git worktree 里工作。

- **位置在仓库外**：默认 `~/.pi/agora-worktrees/<仓库目录名>-<repoRoot 哈希前 8 位>/agora-<taskId>`（配置项 `worktreeRoot`），分支 `agora/<taskId>`，从当前 `HEAD` 创建。放在仓库外，主目录里的 `git status`、构建和搜索都看不到它；也不放在 `AGORA_HOME` 下，避免子代理的工作目录紧挨密钥目录。
- **未提交改动不带入**：worktree 从 `HEAD` 创建，主目录里未提交和未跟踪的改动不会出现在 worktree 里。spawn 时 daemon 用 `git status --porcelain --untracked-files=all` 检查主目录，不干净时在返回值的 `warnings` 和给召集人的文字里写明“主目录有 N 处未提交改动，不会带入 worktree”。
- 记录：repo 根目录（真实路径）、base commit、分支、路径、owner principal、状态（`active | kept | removed`）。
- 串行化：同一仓库的 `git worktree add/remove` 由 daemon 内的按仓库互斥锁串行执行。
- 无隔离时的冲突：同一目录同时只允许一个不隔离的 implement 任务，第二个直接拒绝并提示用 worktree。
- 身份不看路径：worktree 里的会话和主目录里的会话一样，通信授权只看 principal 和委派关系，不比较 cwd。
- 清理：任务完成后**保留** worktree，召集人验收后显式调用清理。清理前用 `git status --porcelain --untracked-files=all` 检查真实状态，有未提交改动或未跟踪文件时拒绝，除非调用方传 `discard: true`。清理前确认相关会话的进程树已退出（Windows 上被打开的文件不能删除）。
- 不自动提交、推送、合并。合并由召集人另派任务完成。

## 崩溃与恢复

### 会话崩溃与卡住

子进程意外退出、RPC 管道断开、或心跳超时（`get_state` 30 秒无响应），daemon：

1. 写退出诊断：退出码或信号、最后 50 条事件、正在执行的工具调用（名称、参数摘要、开始时间）、最后确认完成的动作、stderr 尾部、可能已经发生的副作用（如进行中的 `bash`/`edit`/`write`）、`StopReport` 中的遗留进程。
2. 把会话和所属任务标为 `interrupted`，会议标为暂停。
3. 给召集人写 outbox 通知，附诊断摘要和可选操作：恢复、重开、换人、放弃。召集人的处理方式见 [tasks.md](tasks.md#召集人离线时的行为) 和 [meetings.md](meetings.md#崩溃处理)。

`get_state` 心跳只能发现进程或 RPC 层失去响应，查不出“某个工具一直在运行”这种卡住：工具运行时 pi 仍会正常响应 `get_state`。所以另有**无进展看门狗**：

- 某个工具调用开始后（`tool_execution_start`），连续 `toolStallMinutes`（默认 10 分钟，按工具名可配置）没有收到该会话的任何事件，daemon 给召集人发一条通知，附工具名、参数摘要、已运行时间和可选操作：继续等待、`stop`、`steer` 加 `interrupt: true`。
- 看门狗只通知，不自动停止；召集人选择继续等待后，下一个周期再提醒一次。

规则：

- **恢复不自动重放有副作用的工具**。恢复时用 `--session <sessionFile>` 重新拉起，发一条说明中断现场的消息，由会话自己核对后继续。
- **不递归自救**：daemon 不自动执行恢复动作。召集人不可达（没有活动租约），或同一任务连续恢复失败达到上限（默认 2 次），任务停在 `interrupted`，通知用户（进入 pi-pane 的“待处理”或 `agora pending`）。

### daemon 崩溃或重启

daemon 被强杀时，Windows 上 Job Object 关闭，受管进程随之终止；macOS 和 Linux 上受管 pi 自成进程组，可能仍在运行（见 [hostkit.md](hostkit.md#场景)）。所以启动时：

1. 扫描 `process_runs` 中没有 `exited_at` 的记录，用 pi-hostkit 的 `isSameProcess` 按 pid + 创建时间判断进程是否还在。
2. 仍在运行的旧进程（属于上一个 `daemon_instance_id`）：新 daemon 不接管它的 RPC 管道（管道已随旧 daemon 断开），用 `stopByIdentity` 停止整棵进程树并确认退出，写诊断。
3. 旧 run 确认退出之后，对应会话按“会话崩溃”处理，标为 `interrupted`。在此之前，任何对同一会话文件的 resume 都被拒绝。
4. outbox 里未确认的通知重新投递，接收方按 `dedupe_key` 去重。
5. board 投递位置只在接收方确认后推进，重启后从已确认位置重发，宁可重复不漏读。

## 资源与回收

- 每个空闲 pi RPC 进程估算占 100–300 MiB（**估算，未实测**，P0 测量）。长上下文和图片会抬高峰值。
- 同时推理的协作会话默认最多 4 个（`maxConcurrentRuns`，可配置）。一次运行从发出 `prompt`（或注入触发新一轮的消息）开始占用一个名额，到 `agent_settled` 释放。见下文“名额优先级”。
- 回收：协作会话 settled、没有进行中的工具调用、没有待回应的扩展 UI 对话框，空闲 5 分钟后停止进程（`idleReclaimMs`，默认 300000）。等待答复（`waiting_decision`）的会话同样可回收，答复到达后重新拉起。已结束的会议成员在纪要完成后立即回收。
- 回收只停进程，**不删除**会话、任务、worktree 或存档。

### 名额优先级

> 待定：规则和预计等待时间的算法在试运行后确定。

- 优先级：**主会话 > 进行中会议的参会者和书记 > 任务**；同级先到先得。主会话由终端或 pi-pane 托管，不经过 daemon，也不占名额，所以它始终优先；daemon 实际排序的只有后两级。
- 正在运行的任务不被抢占。名额释放时，先给排队中的会议，再给任务。
- **会议整体准入**：会议开始（或从暂停恢复）前，必须能一次拿到与席位数相同的名额，并在会议进行期间一直保留；某个席位暂时空闲时，它的名额也不借给任务。这样会议不会开到一半因为拿不到名额而卡住。书记使用会议已保留的名额。会议暂停、结束时释放。
- 席位数超过 `maxConcurrentRuns` 的会议永远无法开始，convene 直接返回 `400 exceeds_concurrency`。
- 拿不到全部名额时会议进入排队：convene 返回 `queued`，并给召集人发一条通知，写明排队位置、占用名额的任务及其已运行时间、预计等待时间（按历史任务运行时长的中位数粗估，没有历史时写“无法估计”）。召集人可以继续等、停掉某个任务让出名额，或取消会议。

## 平台注意事项

进程树终止、锁、密钥权限、路径比较的平台差异都在 pi-hostkit 里处理，见 [hostkit.md](hostkit.md#平台差异汇总)。agora 自己需要注意的：

- 启动 pi 用 Node 直接执行 JS 入口，不经 shell；`cwd` 作为 spawn 参数；Windows 上 `windowsHide: true`。
- **停止后不能留下受管命令进程（MVP 验收项）**。停止顺序和三平台的实现见 [hostkit.md](hostkit.md#进程树终止)；daemon 在调用 `stop` 之前按自己的语义先发 `clear_queue`（见 [tasks.md](tasks.md)）。
- Windows：pi 的 `bash` 工具默认用 Git Bash，按 `shellPath` 设置、`%ProgramFiles%\Git\bin\bash.exe` 等顺序查找（依据：`docs/windows.md`）；可选的 `powershell` 工具只在原生 Windows 上可用。daemon 不改这套逻辑，只保证协作会话继承正确的环境。
- Windows：被打开的文件不能删除或改名，清理 worktree 前确认相关会话进程已停止。
- macOS 和 Linux：daemon 被强杀后受管 pi 可能存活，重启时按“daemon 崩溃或重启”处理。
- 自动拉起 daemon 后，关闭终端窗口（Windows 控制台、macOS Terminal、Linux 终端会话的 SIGHUP）不应让 daemon 退出，P0 在三个平台上验证。
