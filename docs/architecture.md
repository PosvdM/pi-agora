# 总体架构

> 状态：设计草案。接口、表结构和默认值都是草案，P0 验证后冻结。

pi-agora 是 pi 的协作引擎：一个每用户单实例的后台进程（daemon）负责拉起和监管所有协作会话（子代理、参会者、书记），并持久保存任务、提问、共享桌面（board）、会议和全部对话。主代理通过 pi 扩展调用它，用户通过 CLI 或 pi-pane 插件调用它。

本文覆盖组件、进程模型、daemon 生命周期、身份与鉴权、存储、权限档位、worktree、崩溃与恢复、资源与回收和 Windows 注意事项。业务细节见：

- 任务（子代理）：[tasks.md](tasks.md)
- 共享桌面：[board.md](board.md)
- 会议：[meetings.md](meetings.md)
- 对话存档：[archive.md](archive.md)
- daemon HTTP API 与接入 pi-pane 的映射：[integration.md](integration.md)

## 设计约束

- **基座是 pi**（`@earendil-works/pi-coding-agent` 1.4.0）。不重写 Agent 循环、Provider、上下文压缩。
- **每个会话一个 `pi --mode rpc` 子进程**。某个会话里的工具卡死或进程崩溃，不影响其他会话和 daemon。
- **单一驱动**：MVP 只实现 RPC 子进程这一种会话驱动，保留 `SessionDriver` 接口，不同时维护进程内 SDK 驱动。
- **协作状态只有一个写者**：任务、提问、board、会议、outbox 都由 daemon 写。终端、pi-pane、CLI 都是客户端，不各自运行调度器。
- **可以单独使用**：不装 pi-pane 时，主代理在 pi 终端里通过扩展使用全部功能。MVP 的验收环境就是 pi 终端。
- **权限只到工具层**，不是沙箱，详见“权限档位”。

## 组件

```text
 pi 终端（主代理）        pi-pane 托管的主会话          用户
   └─ agora 扩展            └─ agora 扩展               ├─ agora CLI
          │                        │                    └─ pi-pane 浏览器
          │ loopback HTTP          │                           │
          ▼                        ▼                           ▼
 ┌──────────────────────── agora daemon ─────────────┐   pi-pane 服务端
 │ 身份与鉴权 │ 任务 │ 提问 │ board │ 会议 │ outbox  │◄── agora pane 插件
 │ 进程监管（SessionDriver） │ 存档 │ SQLite        │
 └──────┬──────────────┬──────────────┬──────────────┘
        ▼              ▼              ▼
  pi --mode rpc   pi --mode rpc   pi --mode rpc      （子代理 / 参会者 / 书记）
   └─ agora 扩展   └─ agora 扩展   └─ agora 扩展
```

| 组件 | 包（草案） | 职责 |
| --- | --- | --- |
| daemon | `packages/daemon` | 进程监管、身份与鉴权、任务/提问/board/会议状态机、outbox、存档、HTTP API |
| pi 扩展 | `packages/extension` | 装进主代理和每个协作会话；按 token 的权限注册工具，收取通知并注入会话，执行工具层权限检查 |
| CLI | `packages/cli` | 启停 daemon、列出和查看所有会话、答复待处理提问、以用户身份召开会议 |
| archive adapter | `packages/archive` | 版本化只读存档读取库，daemon 不运行时也能用，详见 [archive.md](archive.md) |
| pane 插件 | `packages/pane-plugin` | 运行在 pi-pane 服务端，把 daemon 的数据映射成 pi-pane 的树节点、面板、动作、表单，详见 [integration.md](integration.md) |
| 协议类型 | `packages/protocol` | daemon HTTP API 的 TypeScript 类型与 JSON schema |

依赖方向：`daemon`、`extension`、`cli`、`archive`、`protocol` 都不依赖 pi-pane；只有 `pane-plugin` 把 pi-pane 的 `@pi-pane/plugin-api` 作为 peer 依赖。pane 插件接口（树节点、面板、动作、表单、通知等类型）以 pi-pane 仓库的 `docs/plugin-api.md` 为准，daemon API 和 agora 到 pane 的映射以本仓库的 [integration.md](integration.md) 为准。

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
  readonly pid: number;
  send(cmd: RpcCommand): Promise<RpcResponse>;          // pi RPC 命令，见 pi docs/rpc-commands.md
  onEvent(listener: (ev: RpcEvent) => void): () => void; // 会话事件与 extension_ui_request
  respondUi(res: ExtensionUiResponse): void;
  stop(opts: { graceMs: number }): Promise<ExitInfo>;    // abort → 关闭 stdin → 终止进程树
}

interface LaunchSpec {
  agoraSessionId: string;
  cwd: string;                  // 作为 spawn 参数传入，不调用 process.chdir()
  model: string;                // 完整 provider/id
  thinking: ThinkingLevel;
  profile: "explore" | "review" | "implement";
  resume?: { sessionFile: string }; // 有值时用 --session 恢复
  env: Record<string, string>;  // AGORA_URL、AGORA_LAUNCH_TICKET；不含 AGORA_HOME，见“user 身份的来源检查与审计”
}
```

MVP 的唯一实现是 `RpcSubprocessDriver`。不用 pi 自带的 `RpcClient`：它能启动进程、关联响应，但公开声明里没有回应扩展 UI 请求的接口（依据：`dist/modes/rpc/rpc-client.d.ts`），自写一层很薄的 JSONL 传输即可。

### 启动参数

daemon 用 `process.execPath`（Node）直接运行 pi 的 JS 入口（`package.json` 的 `bin.pi` 指向 `dist/bundle/cli.js`），不经 shell、`pi.cmd` 或 Git Bash。

```text
node <pi>/dist/bundle/cli.js --mode rpc
  --session-dir <AGORA_HOME>/sessions/<agoraSessionId>
  --session-id <agoraSessionId>            # 首次启动
  --session <sessionFile>                  # 回收后重新拉起时代替上一行
  --model <provider/id> --thinking <level>
  --tools <按档位的白名单>
  -ne -e <agora 扩展路径> [ -e <档位允许的其他扩展> ]
  --no-mcp                                  # explore / review 必加
```

依据：`docs/cli.md`（`--session-dir`、`--session-id`、`--session`、`--tools`、`-ne`、`-e`、`--no-mcp`）、`docs/rpc.md`。

- `--session-id` 在 `--session-dir` 下是否按 cwd 分组存放**未核实**。daemon 不猜路径，启动后用 RPC `get_state` 读出 `sessionFile` 和 `sessionId` 记入 SQLite（依据：`docs/rpc-commands.md` 的 `get_state`）。
- `-ne` 关闭自动发现的扩展，显式 `-e` 仍加载（依据：`docs/cli.md`）。协作会话默认只加载 agora 扩展，避免把用户的其他扩展（如 pi-web-ui 的子代理工具）带进子会话。implement 档位可在配置里白名单其他扩展。

### 与会话的通信

- **常规控制和聊天流**走 RPC 的 stdin/stdout：任务书用 `prompt`，返工用 `steer` 或 `prompt`，停止用 `abort`，结果用 `get_last_assistant_text`，事件流照 `docs/json.md` 的定义转发。
- **扩展 ↔ daemon** 走 loopback HTTP（见“身份与鉴权”）：工具调用、通知收取、投递确认。
- `pi.events` 是进程内事件总线，不跨进程、不持久，只用于同一 pi 进程内扩展之间通信（依据：`dist/core/event-bus.d.ts`）。

## daemon 生命周期

### 数据目录

默认 `~/.pi/agora/`，可用环境变量 `AGORA_HOME` 覆盖。

```text
<AGORA_HOME>/
  agora.db              # SQLite（WAL 模式）
  run/daemon.lock       # 单实例锁
  run/daemon.json       # 发现信息：端口、pid、instanceId、版本、协议范围
  secret/user.key       # 用户密钥（32 字节随机数）
  secret/principals/    # 主会话的恢复凭证
  sessions/<agoraSessionId>/   # pi JSONL、流片段、退出诊断，见 archive.md
  backups/              # 升级前的数据库备份
  logs/
```

`secret/` 目录只允许当前用户访问：Windows 上用 `icacls` 去掉继承并只授权当前用户（execFile 调用，不经 shell），其他平台用 `0700`/`0600`。`icacls` 的具体参数在 P0 验证。

### 单实例与启动

`daemon.json` 只是发现信息，不能作为互斥依据。启动流程：

1. 用排他创建（`open(path, "wx")`）写 `run/daemon.lock`，内容为 pid、instanceId、启动时间。
2. 创建失败说明锁已存在：读出锁内容，对 `daemon.json` 里的端口做**认证握手**（见下文）。握手成功 → 已有实例在运行，直接使用。
3. 握手失败且 pid 不存在 → 判定为残留锁：把锁文件改名为 `daemon.lock.stale-<时间>`（改名是原子操作，只有一个进程能成功），然后回到第 1 步。pid 仍存在但握手失败 → 不抢锁，报错让用户检查（可能是另一个版本的 daemon 或被占用）。
4. 监听 `127.0.0.1` 的随机端口，写 `daemon.json`，开始接受请求。

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
3. 新 daemon 启动时发现 `schema_version` 低于自身 → 先把 `agora.db` 复制到 `backups/agora-<旧版本>-<时间>.db`，再在一个事务里执行迁移。迁移失败则保持旧库不动并退出。

版本协商见 [integration.md](integration.md#版本协商)。

## 身份与鉴权

daemon 只信任自己签发的 token。**请求体里的任何身份字段都被忽略**，调用者身份由 token 查出。

### principal

principal 是 daemon 里的行为主体，所有任务、提问、board 条目、会议都记录到 principal。

| 类型 | 说明 |
| --- | --- |
| `user` | 当前操作系统用户，每个数据目录只有一个，CLI 和 pi-pane 插件以它的身份调用 |
| `agent:main` | 一个主代理会话（终端或 pi-pane 托管），绑定 pi 的 sessionId |
| `agent:child` | daemon 拉起的协作会话（kind = task / meeting-seat / secretary） |

召集人（convener）是任务或会议的发起 principal。MVP 中只能是 `agent:main` 或 `user`；协作会话不能再派任务或召开会议（见 [tasks.md](tasks.md)）。

### 用户凭证与认证握手

- `secret/user.key` 是用户密钥，首次启动时生成，不进命令行、会话、日志。
- 握手（双向）：
  1. 客户端 `POST /v1/auth/challenge`，带随机 `clientNonce`；daemon 返回 `serverNonce`、`instanceId` 和 `serverProof = HMAC(userKey, "server" | clientNonce | instanceId)`。客户端校验 `serverProof`，确认对方是持有同一密钥的 daemon，防止端口被别的程序占用后冒充。
  2. 客户端 `POST /v1/auth/token`，带 `clientProof = HMAC(userKey, "client" | serverNonce | instanceId)` 和想要的身份（`user` 或注册/认领主会话）。daemon 校验后签发连接 token。
- 连接 token：不透明随机串，绑定 principalId、connectionId、权限范围，默认有效期 1 小时，可在过期前续期；daemon 重启后全部失效。

### 主会话注册与恢复

主代理的 agora 扩展在 `session_start` 时：

1. 用户密钥握手。
2. 查当前会话里有没有 `customType = "agora-principal"` 的条目（`pi.appendEntry` 写入，依据：`dist/core/extensions/types.d.ts` 的 `appendEntry`）。
   - 没有：`POST /v1/principals/register`，带 pi 的 `sessionId` 和会话文件路径。daemon 创建 `agent:main` principal，生成**恢复凭证**写到 `secret/principals/<principalId>.key`，返回 principalId。扩展用 `appendEntry` 只记 `{ principalId }`，不记凭证。
   - 有：`POST /v1/principals/reclaim`，带 principalId 和当前 pi `sessionId`。扩展读取本地恢复凭证并附上证明。daemon 校验凭证，并检查 pi `sessionId` 与注册时一致。
3. 认领成功后取得该 principal 的**控制租约**。

为什么不把凭证写进会话：`appendEntry` 的内容会随会话导出、复制、fork，只能当引用。

- **fork / clone**：新会话的 pi `sessionId` 不同，`reclaim` 被拒绝，扩展转为 `register` 新 principal，并在请求里带上 `forkedFrom`（原 principalId）供展示。fork 不继承原会话的任务和通知。
- **控制租约**：同一 principal 同时只允许一个活动连接持有租约（续租间隔 30 秒，90 秒未续视为释放）。第二个连接认领时返回 `409 lease_held`；用户可在 CLI 用 `agora takeover <principalId>` 强制转移。
- **协作会话**：daemon 启动子进程时生成一次性 launch ticket，经环境变量 `AGORA_LAUNCH_TICKET` 传入。扩展启动后立即用 `POST /v1/auth/launch` 兑换连接 token，并从 `process.env` 删除该变量，避免 bash 子进程继承。ticket 60 秒内有效、只能兑换一次，进程退出后对应 token 作废，重新拉起换新 ticket。

### user 身份的来源检查与审计

implement 档位的子代理开了 bash，和用户是同一个操作系统用户，可以读到 `secret/user.key`，进而以 user 身份答复自己转给用户的提问、给自己加预算。提示词注入就可能触发这种行为。以下措施用来抬高门槛，定位仍是“工具层权限”，不是隔离：

1. **对端进程检查**：daemon 处理任何用用户密钥完成的认证（`as: "user"`，以及主会话的 register / reclaim，它们同样依赖用户密钥和可读的恢复凭证）时，按这条 loopback TCP 连接的对端端口查出对端进程 PID，再沿父进程链向上查。如果它在任何 agora 管理的会话进程树里，拒绝认证（`403 origin_in_managed_tree`）并记审计。
   - Windows 上查 TCP 连接的所属进程用 `GetExtendedTcpTable` 一类系统接口，查父进程用进程快照一类接口；**具体 API 及在 Node 里的调用方式（原生模块或辅助程序）未核实**，P0 验证。
   - pane 插件运行在 pi-pane 服务端里，它与 daemon 之间的连接对端是 pi-pane 进程，查不到真正发起操作的一方。所以 pane 插件在每个 user 操作上转交 pi-pane 测得的浏览器请求对端 PID（`Agora-Origin-Pid`，见 [integration.md](integration.md#约定)），daemon 对它做同样的检查。子代理用偷到的 pi-pane 访问令牌直接调 pi-pane 接口时，会在这一步被拦下。
   - CLI 连接的对端就是 CLI 进程本身，直接检查。
2. **审计**：所有 user 身份的操作（答复转交的提问、加预算、裁决、批准恢复、停止、接管任务、takeover）写入 `audit_log`：操作、目标、来源客户端（`cli` / `pane`，客户端自报）、测得的 PID 与可执行文件路径、时间。被拒绝的尝试也记录。pi-pane 和 CLI 在提问、决策的详情里显示“由谁、从哪里答复”，如“用户（pi-pane，PID 8812，2026-11-05 10:21）”。
3. **文件工具拦截密钥目录**：所有档位的 `read`、`grep`、`find`、`ls`、`edit`、`write` 路径校验都拒绝 `AGORA_HOME/secret` 及其下的路径（真实路径比较），并拒绝配置项 `protectedPaths` 列出的其他目录（默认包含 pi-pane 的 `~/.pi/pane/secret`）。
4. **不给路径提示**：daemon 拉起子进程时从环境变量里去掉 `AGORA_HOME`（以及 `PI_PANE_HOME`），只传 `AGORA_URL` 和 `AGORA_LAUNCH_TICKET`；任务书、工具结果和错误信息里也不出现密钥目录的路径。

剩余风险：

- implement 的 bash 仍然可以读密钥文件（默认位置可以猜到）。
- 子进程可以脱离进程树再发起连接，例如通过计划任务、服务、`start` 启动后父进程退出的进程，来绕过对端进程检查。
- 这一层只用来抬高门槛、防止提示词注入被直接利用，并留下可追查的记录；对蓄意绕过的程序无效。

### 安全边界

- 只监听 loopback；浏览器不直接连 daemon（pi-pane 服务端插件代连），daemon 拒绝带 `Origin` 头的请求。
- token 不出现在工具结果、会话内容和日志里。
- **不防同一操作系统用户下的恶意程序**：同用户进程可以读密钥文件、读其他进程的内存或环境。上一节的措施只针对 agora 自己拉起的会话。文档和界面不宣称更强的隔离。

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
| `agora_sessions` | id、kind、profile、model、thinking、cwd、session_file、pi_session_id、convener_id、parent_principal_id、task_id、meeting_id、inherits_from、inherit_reason、status、archive_state、created_at、ended_at |
| `process_runs` | id、agora_session_id、pid、started_at、exited_at、exit_code、signal、diagnostics_path |
| `tasks`、`task_generations` | 见 [tasks.md](tasks.md) |
| `requests` | 见 [tasks.md](tasks.md#提问答复与转交) |
| `worktrees` | id、task_id、repo_root、base_commit、branch、path、owner_id、state |
| `boards`、`board_entries`、`board_drafts`、`board_cursors` | 见 [board.md](board.md) |
| `meetings`、`meeting_seats`、`meeting_revisions`、`meeting_endorsements` | 见 [meetings.md](meetings.md) |
| `outbox` | id、recipient_id、dedupe_key（唯一）、kind、payload、created_at、delivered_at、acked_at、attempts |
| `audit_log` | id、principal_id、action、target、client（cli / pane / extension）、peer_pid、peer_exe、result（allowed / denied）、created_at |
| `schema_version` | version、migrated_at |

## 权限档位

会话种类和权限分开：`kind` = `task | meeting-seat | secretary` 决定会话在流程里的角色；`permissionProfile` = `explore | review | implement` 决定能用哪些工具。参会者和书记固定用 `explore`。

| 档位 | 内置工具 | 其他 |
| --- | --- | --- |
| `explore` | `read`、`grep`、`find`、`ls` | agora 工具；`--no-mcp`；只加载 agora 扩展 |
| `review` | 同 explore | 另加只读 git 查询工具 `agora_git`（见下文“`agora_git` 的加固”）；不能跑测试 |
| `implement` | `read`、`bash`、`edit`、`write`、`grep`、`find`、`ls` | agora 工具；MCP 和其他扩展按配置白名单开启 |

执行方式：

1. **工具白名单**：启动参数 `--tools` 用明确的工具名列表。`--tools` 列明工具名时会替换整个默认选择，`codemode` 不在列表里就不会启用；MCP 工具不受 `--tools` 的普通名称影响，所以 explore/review 必须加 `--no-mcp`（依据：`docs/cli.md` 的 Tools 和 MCP tools 两节）。
2. **路径校验**：agora 扩展注册 `tool_call` 钩子（依据：`docs/extensions.md`，`dist/core/extensions/types.d.ts` 的 `tool_call` 事件），对文件类工具的路径参数做真实路径解析（`fs.realpath`，覆盖符号链接和 Windows junction）。explore/review 的 `read`、`grep`、`find`、`ls` 不在允许根目录（会话 cwd 加配置的额外只读根）内就拒绝；所有档位的文件类工具都拒绝受保护目录（`AGORA_HOME/secret` 和 `protectedPaths`，见“user 身份的来源检查与审计”）。Windows 上比较前统一大小写和分隔符。
3. **不依赖工具注解**：`readOnlyHint` 等注解未经验证（依据：`docs/extensions.md`），不作为放行依据。
4. **恢复不提权**：重新拉起进程时档位从 SQLite 读取，不接受客户端传入。

边界说明：

- explore/review 是严格只读：不开 shell、MCP、codemode、网络。“只读”指不改工作文件；写 board、发起提问属于协作权限，照常允许。
- **implement 开了 bash 之后，不保证命令不越出工作目录**。路径校验只覆盖文件类工具。这一层叫“工具层权限”，不叫沙箱；需要抵御恶意脚本时要用容器或虚拟机，不在本项目范围内。

### `agora_git` 的加固

只读的 git 命令也能执行代码：仓库自带的 `.git/config` 和 `.gitattributes` 可以配置 `diff.<driver>.textconv`、`diff.external`、`core.fsmonitor`、`core.pager`、`filter.<driver>.clean`、`log.showSignature`（会调用 `gpg.program`）等。review 任务审查的恰恰可能是不可信的代码，所以 `agora_git` 按以下规则执行：

- **调用方式**：`execFile("git", args, { cwd: 任务工作目录, env })`，不经 shell；单次超时 30 秒，输出上限 1 MiB。
- **固定在子命令前加的参数**：`--no-pager -c core.fsmonitor=false -c core.pager=cat -c log.showSignature=false`。
- **子命令只允许 `status`、`diff`、`log`、`show`**：
  - `diff`、`show`、`log` 固定加 `--no-ext-diff --no-textconv`；
  - `status` 固定加 `--porcelain=v1 --ignore-submodules=all --no-optional-locks`；
  - 所有子命令固定加 `--no-color`。
- **环境变量**：在继承的环境上设 `GIT_CONFIG_NOSYSTEM=1`、`GIT_PAGER=cat`、`PAGER=cat`、`GIT_EXTERNAL_DIFF=`（空）、`GIT_TERMINAL_PROMPT=0`，并去掉 `GIT_DIR`、`GIT_WORK_TREE`、`GIT_CONFIG_PARAMETERS`、`GIT_CONFIG_COUNT` 及 `GIT_CONFIG_KEY_*` / `GIT_CONFIG_VALUE_*`。
- **参数白名单**：模型只能传白名单内的选项（如 `--stat`、`--name-only`、`--name-status`、`-n <数字>`、`--oneline`、`--format=<固定几种>`、`-U<数字>`、`--cached`、提交号和提交范围）和 `--` 之后的路径。其余一律拒绝，尤其是 `-c`、`--output`、`--exec`、`--git-dir`、`--work-tree`、`-C`、`--ext-diff`、`--textconv`、`--show-signature`、`--config-env` 和任何会写文件或改引用的选项。提交号和范围用正则校验（十六进制、分支名字符、`..`、`~n`、`^`），不允许以 `-` 开头。
- **路径限定**：`--` 之后的路径做真实路径解析，必须在任务工作目录内，同时受“受保护目录”规则约束。
- **clean filter**：`status` 在文件状态信息过期时可能对工作区文件运行 `filter.<driver>.clean`。执行前用 `git config --get-regexp "^filter\."` 读出仓库配置的 filter（读配置不执行代码），对每个 driver 用 `-c` 覆盖其 `clean`、`smudge`、`process` 为空。空值是否等于禁用 filter **未核实**；P0 不通过则 review 档位不提供 `status`。

P0 用一个带恶意配置的测试仓库验证：配置了 textconv、`diff.external`、`core.fsmonitor`、`core.pager`、clean filter、`log.showSignature` + `gpg.program` 的仓库中，`agora_git` 的各子命令都不会执行这些程序（用写标记文件的脚本判断）。

## worktree

任务可以选择 `isolation: "worktree"`，在独立 git worktree 里工作。

- 位置和命名：`<repoRoot>/.worktrees/agora-<taskId>`，分支 `agora/<taskId>`，从当前 `HEAD` 创建。
- 记录：repo 根目录（真实路径）、base commit、分支、路径、owner principal、状态（`active | kept | removed`）。
- 串行化：同一仓库的 `git worktree add/remove` 由 daemon 内的按仓库互斥锁串行执行。
- 无隔离时的冲突：同一目录同时只允许一个不隔离的 implement 任务，第二个直接拒绝并提示用 worktree。
- 身份不看路径：worktree 里的会话和主目录里的会话一样，通信授权只看 principal 和委派关系，不比较 cwd。
- 清理：任务完成后**保留** worktree，召集人验收后显式调用清理。清理前用 `git status --porcelain --untracked-files=all` 检查真实状态，有未提交改动或未跟踪文件时拒绝，除非调用方传 `discard: true`。
- 不自动提交、推送、合并。合并由召集人另派任务完成。

## 崩溃与恢复

### 会话崩溃

子进程意外退出、RPC 管道断开、或心跳超时（`get_state` 30 秒无响应），daemon：

1. 写退出诊断：退出码或信号、最后 50 条事件、正在执行的工具调用（名称、参数摘要、开始时间）、最后确认完成的动作、stderr 尾部、可能已经发生的副作用（如进行中的 `bash`/`edit`/`write`）。
2. 把会话和所属任务标为 `interrupted`，会议标为暂停。
3. 给召集人写 outbox 通知，附诊断摘要和可选操作：恢复、重开、换人、放弃。召集人的处理方式见 [tasks.md](tasks.md#召集人离线时的行为) 和 [meetings.md](meetings.md#崩溃处理)。

规则：

- **恢复不自动重放有副作用的工具**。恢复时用 `--session <sessionFile>` 重新拉起，发一条说明中断现场的消息，由会话自己核对后继续。
- **不递归自救**：daemon 不自动执行恢复动作。召集人不可达（没有活动租约），或同一任务连续恢复失败达到上限（默认 2 次），任务停在 `interrupted`，通知用户（进入“待处理”）。

### daemon 崩溃或重启

- 启动时扫描 `agora_sessions` 里状态为运行中的会话：对应子进程已不在（daemon 退出时子进程随之终止，或启动时检测 pid）→ 按“会话崩溃”处理。
- outbox 里未确认的通知重新投递，接收方按 `dedupe_key` 去重。
- board 投递位置只在接收方确认后推进，重启后从已确认位置重发，宁可重复不漏读。

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

## Windows 注意事项

- 启动 pi 用 Node 直接执行 JS 入口，不经 shell；`cwd` 作为 spawn 参数；`windowsHide: true`。
- pi 的 `bash` 工具在原生 Windows 上默认用 Git Bash，按 `shellPath` 设置、`%ProgramFiles%\Git\bin\bash.exe` 等顺序查找（依据：`docs/windows.md`）。daemon 不改这套逻辑，只保证协作会话继承正确的环境。
- **停止后不能留下受管命令进程（MVP 验收项）**。停止顺序：RPC `abort` → 关闭 stdin → 等待 5 秒 → 用 `taskkill /PID <pid> /T /F` 终止进程树（execFile 调用）→ 检查是否还有遗留后代进程。`taskkill /T` 按父进程关系查找，父进程已退出的孙进程可能漏掉；P0 先验证这种情况，不通过再改用 Job Object（需要原生模块或辅助程序）。
- 路径比较统一大小写和分隔符，真实路径解析要覆盖 junction。
- 文件锁：Windows 上被打开的文件不能删除或改名，清理 worktree 前确认相关会话进程已停止。
