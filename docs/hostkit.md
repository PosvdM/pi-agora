# pi-hostkit：宿主平台能力

> 状态：设计草案。接口和默认值是草案，P0 验证后冻结。包名 `pi-hostkit` 为暂定名。

pi-hostkit 是一个独立的小包，封装托管 pi 子进程时与操作系统相关的能力。pi-agora 的 daemon 和 pi-pane 的服务端都依赖它，两者彼此不依赖。

**本文是 pi-hostkit 的权威定义。** 本文暂时放在 pi-agora 仓库，将来 pi-hostkit 拆成独立仓库时随包迁移；pi-pane 的文档只引用本文，不另行定义这些接口。修改本文中的共享协议（尤其是“会话写锁”）时，pane 和 agora 必须同时升级到兼容版本。

## 范围

| 模块 | 内容 |
| --- | --- |
| `locatePi` | 定位 pi 安装、检查版本 |
| `rpc` | pi RPC 的 JSONL 传输 |
| `process` | 启动受管进程、记录进程身份、终止整棵进程树 |
| `locks` | 单实例锁、会话写锁 |
| `secrets` | 密钥目录与文件的权限 |
| `paths` | 路径规范化与包含关系判断 |

不在范围内：业务概念（任务、会议、聊天视图）、HTTP 服务、鉴权协议。

## 支持的平台

- Windows、macOS、Linux 同时支持，三个平台的行为在本文逐项写明；同一功能在不同平台上的结果一致，实现方式可以不同。
- Node.js 24 及以上。
- Node 没有内置命名 mutex、`flock`、Job Object 和进程创建时间查询，这些能力由 pi-hostkit 自带的 **N-API 预编译模块**提供。
  - **选型理由**：锁的文件描述符直接由宿主进程持有，宿主存活则锁在，宿主崩溃或被强杀则内核自动释放，天然符合会话写锁的语义；若使用单独的辅助程序持锁，辅助程序单独崩溃时锁被内核释放，但宿主进程和写入仍在继续，就会出现两个写者破坏会话。实测两种形态在 macOS 原型上均已跑通，进程创建时间等读数逐字一致。
  - **后续代价**：需为 Windows、macOS、Linux 三平台及对应架构分别分发预编译二进制包，三平台的构建与 CI 打包列入后续阶段（P1）。
- 数据目录和锁目录必须在本地磁盘上。网络文件系统上的 `flock` 不可靠，pi-hostkit 检测到网络文件系统时拒绝启动并报错（macOS 通过 `statfs` 的 `MNT_LOCAL` 检查已在原型中验证；远程挂载拒绝行为待后续平台补测）。

## 定位 pi

目标 pi 版本：**1.5.x**（`>=1.5.0 <1.6.0`）。本文和其他文档中对 pi 行为的依据都以本机 pi 1.5.0 的文件为准，路径相对于 pi 包目录。

```ts
// 草案，P0 后冻结
export function locatePi(opts: { piPath?: string }): Promise<PiInstall>;

export interface PiInstall {
  packageDir: string;   // @earendil-works/pi-coding-agent 包目录（真实路径）
  cliEntry: string;     // package.json 的 bin.pi，1.5.0 中为 dist/bundle/cli.js
  version: string;      // package.json 的 version
  supported: boolean;   // version 是否在支持区间内
}
```

查找顺序：

1. 配置项 `piPath`（pane 与 agora 各自的配置文件里同名）：可以是包目录，也可以直接指向 `cli.js`。
2. 全局 npm 根目录：执行 `npm root -g`，取 `<root>/@earendil-works/pi-coding-agent`。Windows 上 `npm` 是 `.cmd` 脚本，要经 `cmd.exe /d /s /c npm root -g` 调用，参数固定，不拼接任何外部输入。结果缓存到进程退出。
3. 都找不到时报错，提示安装 pi 或设置 `piPath`。

启动 pi 时用 `process.execPath`（Node）直接运行 `cliEntry`，不经 shell、`pi.cmd` 或 Git Bash。版本不在支持区间内时拒绝启动受管会话，提示升级 pi-hostkit 的使用方或改用支持的 pi 版本。

## RPC 传输

pi RPC 是严格的 JSONL：每条记录是一个完整的 JSON 对象，以 LF 结尾（依据：`docs/rpc.md` 的 Framing 一节）。

```ts
// 草案，P0 后冻结
export interface RpcTransport {
  send(cmd: RpcCommand, opts?: { timeoutMs?: number }): Promise<RpcResponse>; // 按 id 关联响应
  onEvent(listener: (ev: RpcEvent) => void): () => void;                    // 会话事件
  onUiRequest(listener: (req: ExtensionUiRequest) => void): () => void;     // extension_ui_request
  respondUi(res: ExtensionUiResponse): void;
  closeInput(): void;                                                        // 关闭子进程 stdin
}
```

- **只按 LF 切分**：stdout 按字节流读，用 UTF-8 流式解码，遇到 `\n` 切出一条记录，去掉末尾可选的 `\r`。不用 Node 的 `readline`：它还会在 `U+2028`、`U+2029` 处切分，而这两个字符可以合法出现在 JSON 字符串里（依据同上）。
- **写入**：每条命令 `JSON.stringify(cmd) + "\n"`，按写入顺序串行。
- **单条记录上限**：默认 64 MiB（含图片的消息可能很大）。超过上限视为协议错误，传输层报告错误，由使用方终止该次运行。
- **命令超时**：每条命令可设超时，超时后 Promise 以超时错误结束，响应晚到时丢弃并记日志。`abort` 必须设超时，见“进程树终止”。
- 不用 pi 自带的 `RpcClient`：它的公开声明里没有回应扩展 UI 请求的接口（依据：`dist/modes/rpc/rpc-client.d.ts`）。

## 受管进程与进程身份

```ts
// 草案，P0 后冻结
export function spawnManaged(spec: {
  argv: string[];               // [cliEntry, ...pi 参数]，以 process.execPath 执行
  cwd: string;                  // 作为 spawn 参数，不调用 process.chdir()
  env: Record<string, string>;
  runId: string;                // 使用方分配
  instanceId: string;           // 使用方（daemon 或 pane 服务端）本次启动的实例 id
}): Promise<ManagedProcess>;

export interface ProcessIdentity {
  pid: number;
  startTime: string;            // 操作系统记录的进程创建时间
  runId: string;
  instanceId: string;
}

export interface ManagedProcess {
  readonly identity: ProcessIdentity;
  readonly rpc: RpcTransport;
  stop(opts: StopOptions): Promise<StopReport>;   // 见“进程树终止”
}

export function isSameProcess(id: ProcessIdentity): Promise<"alive" | "gone">;
export function stopByIdentity(id: ProcessIdentity, opts: StopOptions): Promise<StopReport>;
```

- 使用方把 `ProcessIdentity` 持久化（agora 写入 `process_runs` 表，pane 写入自己的运行记录）。
- **防 PID 复用**：判断一个记录中的进程是否还活着，必须 PID 存在**且**创建时间相同；只有 PID 相同不算。任何终止操作之前都先做这项检查，绝不对一个可能已被复用的 PID 发信号。
- 进程创建时间的来源：Windows `GetProcessTimes`；Linux `/proc/<pid>/stat` 的 starttime 字段加系统启动时间；macOS `proc_pidinfo`（原生部分）。精度和取法在 P0 验证。
- `stopByIdentity` 供重启后的宿主停止上一个实例遗留的进程（见下文“宿主被强杀”）。

## 进程树终止

目标：停止一个受管 pi 后，它启动的命令进程（包括 `bash` 工具的后台进程和孙进程）都不留下。

```ts
// 草案，P0 后冻结
export interface StopOptions {
  abortTimeoutMs?: number;      // RPC abort 的等待上限，默认 10000
  graceMs?: number;             // 关闭 stdin 后等待自行退出，默认 5000
  termGraceMs?: number;         // POSIX：SIGTERM 后等待，默认 3000
}

export interface StopReport {
  steps: { step: string; at: string; ok: boolean; detail?: string }[];
  coverage: "job_object" | "cgroup" | "snapshot_visible"; // 覆盖范围标注：快照方式仅保证快照能看到的进程
  leftovers: { pid: number; startTime: string; exe?: string }[]; // 覆盖范围内复查后仍存活的后代，正常应为空
}
```

调用方在调用 `stop` 之前，按自己的语义决定是否先发 `clear_queue`（见 pi `docs/rpc-commands.md` 的 `clear_queue`）。`stop` 本身的步骤如下。

### Windows

- 启动：每个受管 pi 放进一个独立的 Job Object，设置 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`，不允许 breakaway。为避免“进程在加入 Job 前已经启动了子进程”，由原生部分以挂起状态创建进程、加入 Job 后再恢复运行。
- 停止：RPC `abort`（带超时）→ 关闭 stdin → 等待 `graceMs` → `TerminateJobObject` → 复查 Job 内进程数为 0。`coverage` 为 `"job_object"`。
- Job 内的后代进程不论父进程是否已退出都在 Job 里，所以“pi 主进程先退出、孙进程还在”的情况同样能清理。
- 宿主（daemon 或 pane 服务端）退出或被强杀时，Job 句柄关闭，Job 内所有进程随之终止。

### macOS 与 Linux

pi 1.5.0 的 `bash` 工具在 POSIX 上以 `detached` 方式启动每条命令（新会话、新进程组，依据：`dist/core/tools/bash.js:65`）。因此只对 pi 自己的进程组发信号杀不到这些命令。pi 在 RPC 模式下收到 SIGTERM 或 SIGHUP 时会先终止它记录的这些命令进程树（依据：`dist/modes/rpc/rpc-mode.js:276–283`），但被 SIGKILL 时来不及清理。

- **Linux**：有 cgroup v2 时**默认开启**（通过 `systemd-run --user --scope`），将受管进程及其所有后代放入同一 scope，停止时通过 cgroup 一次性杀死整棵树，`coverage` 标注为 `"cgroup"`；环境无 cgroup v2 时退回下方快照模式。
- **macOS**：不支持 cgroup，采用快照模式。
  - 启动：pi 以 `detached: true` 启动，自成进程组（pgid = pi 的 pid）。
  - 运行期间：受管 pi 有工具在执行时，每 5 秒对进程表做一次快照，记录 pi 的全部后代及其 pgid、创建时间。这样 pi 先退出、后代被系统收养后，仍能按记录找到它们。
  - 停止顺序：
    1. RPC `abort`（带超时）；
    2. 关闭 stdin，等待 `graceMs`；
    3. 向 pi 发 SIGTERM，让 pi 自己清理它启动的命令，等待 `termGraceMs`；
    4. 对进程表做快照，收集 pi 的全部后代的 pgid，加上运行期间记录过的 pgid；逐个做进程身份检查后，对每个 pgid 发 `SIGKILL`（`kill(-pgid)`），最后对 pi 自己的进程组发 `SIGKILL`；
    5. 复查：快照中出现过的进程都已不在。仍存活的写进 `StopReport.leftovers`；`coverage` 标注为 `"snapshot_visible"`（只保证快照能看到的进程）。
  - 进程表快照：Linux 读 `/proc`；macOS 用原生 N-API 调用 `proc_listpids` 与 `proc_pidinfo`。
  - **收窄承诺**：macOS 原型实测表明快照模式存在两种无法发现的盲窗，会留下孤儿进程（见下方剩余风险），不能出具无说明的 0 残留保证。

### 场景

| 场景 | 处理 |
| --- | --- |
| 正常停止 | 按上述顺序 |
| pi 不响应 `abort` | `abortTimeoutMs` 到期后继续后面的步骤，`StopReport` 记录 abort 超时 |
| pi 主进程先退出，后代仍在 | Windows：Job 内仍可终止；POSIX：用运行期间记录的 pgid 和当前快照清理 |
| 宿主被强杀 | Windows：Job 关闭，受管进程随之终止；POSIX：受管进程可能仍在运行。宿主重启后读出持久化的 `ProcessIdentity`，对仍存活（身份一致）的进程调用 `stopByIdentity` 并确认退出后，才允许再次打开同一会话文件。另一个宿主先取得该文件的写锁时，按会话写锁的“取得锁之后”清理同一个进程 |
| 宿主所在机器重启 | 所有记录的进程身份都不再匹配，按“已退出”处理 |

### 剩余风险

- **macOS 快照盲窗**：在 macOS 上（及未开启 cgroup 的 Linux），以下两种情况均会留下孤儿进程，且快照复查无法检出（`StopReport.leftovers` 仍为 0，故必须通过 `coverage: "snapshot_visible"` 标明覆盖边界）：
  1. 两次快照（间隔 5 秒）之间，后代进程 `setsid` 后父进程退出，接着 pi 被 SIGKILL；
  2. bash 用 `nohup … &` 起了后台进程，而该命令在第一次快照之前就结束了（这种情况 pi 正常停止也会遗漏）。
  - **P1 调研项**：调研能否在 pi 里用扩展包住 bash 工具，命令一启动就把进程组上报给宿主，以兜住早退后台进程（视 pi 扩展接口能力而定，目前不承诺）。
- 不是由受管进程直接启动的进程（如通过计划任务、系统服务、`launchd`/`systemd` 启动的）不在 Job、进程组或进程树里，无法清理。

## 锁

两种锁都由操作系统在持有进程退出时自动释放，不依赖锁文件是否被删除。**不使用“排他创建锁文件 + 发现残留时改名”的方案**：判断残留和改名之间存在 ABA 竞态，两个进程可能同时认为自己拿到了锁。

```ts
// 草案，P0 后冻结
export function acquireInstanceLock(name: string, scopeDir: string): Promise<HeldLock | null>; // null：已被占用

export function acquireSessionWriterLock(sessionFile: string, host: LockHost): Promise<SessionWriterLock | { heldBy?: SessionLockRecord }>;
export function probeSessionWriterLock(sessionFile: string): Promise<{ held: boolean; record?: SessionLockRecord }>;

export interface HeldLock { release(): Promise<void> }

export interface LockHost {
  app: "pi-pane" | "pi-agora";
  identity: ProcessIdentity;        // 持锁的宿主进程
}

export interface SessionWriterLock extends HeldLock {
  readonly previous?: SessionLockRecord;              // 取得锁时读到的上一份记录
  recoverPreviousWriter(opts: StopOptions): Promise<"none" | "stopped" | "failed">; // 见“取得锁之后”
  update(patch: Partial<Pick<SessionLockRecord, "writer" | "state">>): Promise<void>;
}

/** 与锁放在一起的共享记录，两个宿主都读写同一格式 */
export interface SessionLockRecord {
  version: 1;
  sessionFile: string;              // 规范化后的会话文件路径
  host: LockHost;                   // 当前（或最后一个）持锁宿主
  writer?: ProcessIdentity;         // 实际写这个文件的 pi 进程；尚未拉起时为空
  state: "starting" | "running" | "stopping" | "released";
  updatedAt: string;
}
```

### 实现

| 平台 | 实现 |
| --- | --- |
| Windows | 命名 mutex：`Local\pi-hostkit-v1-<用途>-<sha256(key)>`。持有进程退出后 mutex 变为 abandoned，下一个等待者获得所有权（`WAIT_ABANDONED` 视为获得锁）。 |
| macOS、Linux | 打开（必要时创建）锁文件，`flock(LOCK_EX \| LOCK_NB)`。锁文件永不删除，删除会让两个进程分别锁住新旧两个文件。 |

POSIX 锁文件和 Windows mutex 名中的 `key` 为规范化后的路径（见“路径规范化”）。

### 单实例锁

- 用于 agora daemon（`scopeDir = AGORA_HOME`）和 pane 服务端（各自的数据目录）。
- 拿到锁后，使用方才写自己的发现信息文件（如 agora 的 `run/daemon.json`）。发现信息只用于找到对方，不作为互斥依据。

### 会话写锁

同一个 pi 会话文件同一时间只能有一个托管写者。pi-pane 和 pi-agora 使用同一协议，所以两者不会同时托管同一个会话。

- 锁的 key 为会话文件规范化后的路径。POSIX 锁文件位于共享目录 `~/.pi/hostkit/locks/session-<sha256>.lock`（目录权限 `0700`）；Windows 用上表的命名 mutex，用途段为 `session`。
- **共享记录**：锁旁边的 `~/.pi/hostkit/locks/session-<sha256>.json` 保存 `SessionLockRecord`（三个平台都用这个目录；Windows 上锁本身是命名 mutex，目录里只有记录）。只有持锁方能写它，写法为写临时文件后原子替换。记录是恢复协议的一部分，不只是展示：它告诉下一个持锁方，上一个写者是哪个 pi 进程、停在什么状态。
- 持锁方是宿主进程（daemon 或 pane 服务端）。它在记录里依次写入：取得锁后 `starting`；pi 拉起后立即写入 `writer`（pi 的进程身份）并改为 `running`；停止时 `stopping`；确认 pi 及其进程树已退出后 `released`，然后释放锁。

#### 取得锁的时机

pi 在打开已有会话文件时就可能改写它：文件为空时写入会话头，旧格式时迁移后整体重写（依据：`dist/core/session-manager.js` 的 `_setSessionFile`、`_loadEntries`）。进程内切换会话时，这一步发生在旧会话的 `session_shutdown` 之前（依据：`dist/core/agent-session-runtime.js:128–143`）。所以写锁必须在 pi 打开文件之前取得：

| 情况 | 取锁时机 | 失败时 |
| --- | --- | --- |
| ① 拉起 pi 打开已有文件（`--session <文件>`） | 宿主在拉起 pi 之前 | 不拉起，告诉使用方“已被 <host> 托管” |
| ② 拉起 pi 新建会话 | 宿主预先分配一个确定的路径（会话目录下的新文件名），取得该路径的锁后用 `--session <该路径>` 拉起。路径含 `/` 或以 `.jsonl` 结尾时，pi 把参数当作路径；文件不存在时 pi 新建会话并沿用这个路径（依据：`dist/main.js` 的 `resolveSessionPath`、`dist/core/session-manager.js` 的 `_setSessionFile` 的 else 分支）。不用 `--session-id` 让 pi 自己生成路径 | 换一个路径重试 |
| ③ 进程内切换到已有会话（RPC `switch_session`，或扩展调用 `switchSession`，即 `reason = "resume"`） | 宿主自己发 RPC 时，在发送之前取得目标文件的锁；由扩展发起时，宿主放在 pi 里的桥接扩展在 `session_before_switch`（带 `targetSessionFile`）里同步请求宿主取锁 | 桥接扩展返回 `{ cancel: true }`，切换不发生 |
| ④ 进程内新建或分叉（RPC `new_session`、`fork`、`clone`，或扩展调用 `newSession`、`fork`） | 新文件的路径由 pi 生成（会话目录下的 `<时间>_<新会话 id>.jsonl`），`session_before_switch`（`reason = "new"`）和 `session_before_fork` 都不带这个路径；最早在 `session_shutdown` 的 `targetSessionFile` 里出现。宿主（经桥接扩展）在 `session_shutdown` 时取得新路径的锁 | 见下文 |
| ⑤ 宿主在自己进程内预先建文件，再拉起 pi 打开它（如 pi-pane 只读视图的“Fork 为新会话”用 `SessionManager.forkFrom()` 复制出新文件，依据：`dist/core/session-manager.js` 的 `forkFrom`） | 先写后锁：`forkFrom` 以新生成的会话 id 命名并用排他方式创建新文件，宿主在它返回后取得新文件的锁，再按①拉起 pi。理由同④中带叶子的 fork：新文件名是新生成的，其他宿主不会预先持有它的锁 | 不拉起，删除刚建的文件或保留并告诉使用方 |

关于④：

- `new` 和不带叶子的 `fork`：新文件要等会话里出现第一条 user 或 assistant 消息才写入（依据：`dist/core/session-manager.js` 的 `_persist`、`_hasConversation`），这发生在新会话的 `session_start` 之后，所以在 `session_shutdown` 时取锁仍早于第一次写入。
- 带叶子的 `fork` 和 `clone`：分支上已有对话时，pi 在 `session_shutdown` 之前就写出新文件（依据：`dist/core/session-manager.js` 的 `createBranchedSession`、`dist/core/agent-session-runtime.js` 的 `fork`），宿主只能在写入之后取锁。新文件名带新生成的会话 id，其他宿主不会预先持有它的锁，所以实际不会冲突。
- 取锁失败时（理论上只有路径冲突），新会话已经无法取消。宿主停止向该进程发送任何输入，终止该进程（按“进程树终止”），把会话标为中断并告诉使用方。不论切换由宿主的 RPC 还是扩展命令发起，处理都一样。

切换成功后，旧文件的锁在新会话的 `session_start` 之后释放（记录写为 `released`），不必等 pi 退出：`session_start` 之前 pi 已对旧实例发出 `session_shutdown` 并拆除旧运行时，不会再写旧文件。切换失败时（没有等到新会话的 `session_start`，且 RPC `get_state` 的 `sessionFile` 仍是旧文件），宿主释放已取得的目标锁。agora 的协作会话禁止会话替换：daemon 不发这几种 RPC，agora 扩展注册 `session_before_switch` 和 `session_before_fork`，一律返回 `{ cancel: true }`。pi 只要有一个处理器返回取消，就不再执行后面的处理器并取消替换（依据：`dist/core/extensions/runner.js:813–825`），所以 implement 档位按白名单加载的其他扩展也无法发起替换。

**宿主与扩展的生命周期与容错**：
- **`session_start` 幂等**：RPC 替换会话（new、resume、fork、clone）在 runtimeHost 替换完成后与 RPC 自身 rebind 时各触发一次 `session_start`（依据：`dist/modes/rpc/rpc-mode.js` 与 `dist/core/agent-session-runtime.js`），宿主及桥接扩展必须对 `session_start` 做幂等处理（复用同一个就绪 Promise，每实例只绑定一次监听）。
- **启动阶段退出码 1**：ticket 被抢先兑换、ticket 失效或扩展加载失败时，pi 会在未响应 `get_state` 前直接以退出码 1 退出。宿主遇到「启动阶段退出码 1」，应作为 ticket 或扩展启动故障处理，记下诊断，不自动重试。

#### 取得锁之后

锁被释放只说明上一个**宿主**已经退出或放手，不说明它的 pi 已经退出（POSIX 上宿主被强杀时 pi 可能仍在运行）。任何宿主取得会话写锁后、启动新写者之前，都要调用 `recoverPreviousWriter`：

1. 读共享记录。没有记录或 `state = "released"` → 没有遗留写者。
2. 有 `writer` → 用 `isSameProcess` 判断。仍存活 → `stopByIdentity` 停止整棵进程树并确认退出；无法停止 → 释放锁、报告错误，不启动新写者。
3. `state = "starting"` 且没有 `writer`（上一个宿主在拉起 pi 和写入记录之间退出）→ 在进程表里查找命令行包含该会话文件路径和 `--mode rpc` 的 pi 进程，找到则按第 2 步处理。**没找到也不能排除遗留写者**（命令行可能被截断、路径写法不同、进程表读取受限），返回 `"failed"`：不自动拉起新写者，释放锁，告诉使用方“上一个写者状态不明”。使用方提示用户人工确认没有遗留的 pi 进程后，才可以显式强制继续（agora 中这是用户级操作）。
4. 完成后把记录改写为自己的 `starting`，再拉起新写者。

第 3 步的窗口来自“拉起进程”和“写入 `writer`”之间的间隔。消除办法：由原生部分以挂起状态创建进程（Windows 已经这样做，见“进程树终止”）、写入 `writer` 后再恢复运行；在 POSIX 上先 fork 一个等待管道信号的辅助进程，写入记录后再让它 exec pi。P0 在 macOS 原型上验证了 POSIX 的 exec 前门闩：放行前目标程序不运行，exec 后 PID 和创建时间与保存的身份一致；该机制尚未并入宿主的拉起和恢复流程，Windows 挂起创建待测。让 pi 启动后在扩展 `session_start` 中握手、宿主写入记录后再放行的办法不能作为门闩：到达握手点之前，会话文件已经可能被 pi 改写。把门闩集成进拉起流程列为后续工作。

这样不论上一个写者属于 pi-pane 还是 pi-agora，新持锁方都会先清理它。

#### 其他

- 终端里直接运行的 pi 不参与这个协议，pi-hostkit 无法发现它。如何处理这种外部写者由使用方决定（pi-pane 见其 `docs/architecture.md`）。
- 协议版本体现在名称中（`v1`）。改变锁的名称、位置、共享记录的格式或语义属于不兼容修改，pane 和 agora 必须同时升级。

## 密钥目录权限

```ts
// 草案，P0 后冻结
export function ensurePrivateDir(dir: string): Promise<void>;           // 创建或收紧，失败时抛出
export function writePrivateFile(file: string, data: Uint8Array): Promise<void>; // 排他创建，仅当前用户可读写
export function checkPrivate(path: string): Promise<{ ok: boolean; problem?: string }>;
```

| 平台 | 做法 |
| --- | --- |
| Windows | `icacls <path> /inheritance:r /grant:r *<当前用户 SID>:(OI)(CI)F`，用 SID 而不用本地化的账户名；`icacls.exe` 从 `%SystemRoot%\System32` 以 execFile 调用，不经 shell。具体参数和验证方法在 P0 确定。 |
| macOS、Linux | 目录 `0700`、文件 `0600`（创建时用 `O_EXCL`），每次启动检查属主为当前用户且权限不宽于上述值；不满足时拒绝启动并说明原因。 |

这一层只防其他操作系统用户。与用户同为一个系统用户的进程（包括 Agent 启动的命令）仍能读这些文件，相应的安全设计见 [security.md](security.md)。

## 路径规范化

用于路径校验（agora 的受保护目录、只读根目录）、会话写锁的 key、会话文件的比较。

```ts
// 草案，P0 后冻结
export function canonicalPath(input: string, cwd: string, mode: "read" | "write"): Promise<string>;
export function comparisonKey(canonical: string): string;
export function isWithin(root: string, target: string): boolean;     // target 是 root 或在其下
export function isAncestorOf(dir: string, target: string): boolean;  // dir 是 target 的祖先（或相同）
```

步骤：

1. **与 pi 解析工具路径的规则一致**，确保校验的是 pi 实际会打开的文件：去掉开头的 `@`、把 Unicode 空格（`U+00A0`、`U+2000–U+200A`、`U+202F`、`U+205F`、`U+3000`）换成普通空格、展开 `~`、`file://` URL 转路径、Windows 上把 Git Bash/MSYS/WSL 形式的盘符路径（`/c/...`、`/mnt/c/...`）转成 `C:\...`，再相对 `cwd` 解析（依据：`dist/utils/paths.js` 的 `normalizePath`、`resolvePath`，`dist/core/tools/path-utils.js` 的 `resolveToCwd`）。
2. `mode = "read"` 时还要按 pi 的 `resolveReadPath` 依次尝试 macOS 截图名的窄不换行空格变体、NFD 变体、弯引号变体，取第一个存在的文件（依据：`dist/core/tools/path-utils.js`）。
3. **真实路径**：`fs.realpath.native` 解析符号链接和 Windows junction。目标不存在时（如 `write` 新文件），对最深的已存在祖先取真实路径，再拼上其余部分。比较路径前两方必须均做 `realpath`（macOS 上系统临时目录 `event.cwd` 时而是 `/private/var`、时而是 `/var`）。
4. **比较键**：Windows 上统一分隔符为 `\`、去掉 `\\?\` 前缀、折叠大小写（与 pi 的 `getPathComparisonKey` 一致，忽略 NTFS 按目录开启的大小写敏感）；macOS 默认卷不区分大小写且对 Unicode 规范化不敏感，比较前折叠大小写并转为 NFC（`realpath` 是否返回磁盘上的实际大小写在 P0 验证）；Linux 不折叠。

pi 的这些函数位于内部模块，不在包的公开导出里，所以 pi-hostkit 自行实现同样的规则，并把 pi 1.5.0 的行为整理成测试用例；升级支持的 pi 版本时先跑这组用例。

剩余风险：校验与 pi 实际打开文件之间存在时间差，期间链接被替换会绕过校验（TOCTOU）。路径校验只是工具层的限制，不是沙箱。

## 平台差异汇总

| 能力 | Windows | macOS | Linux |
| --- | --- | --- | --- |
| 进程树终止 | Job Object | 进程组 + 进程表快照（收窄承诺，标注覆盖范围） | cgroup v2 默认开启（无 cgroup 时退回进程组 + 进程表快照） |
| 宿主被强杀后 | 受管进程随 Job 终止 | 受管进程可能存活，重启后按身份停止 | 同 macOS |
| 单实例锁、会话写锁 | 命名 mutex | `flock` | `flock` |
| 进程创建时间 | `GetProcessTimes` | `proc_pidinfo` | `/proc/<pid>/stat` |
| 密钥权限 | `icacls` | `0700/0600` | `0700/0600` |
| 路径比较 | 折叠大小写、统一分隔符 | 折叠大小写、NFC | 原样 |

## P0 验证结论与后续工作

P0 实测结果（macOS，详见各组 RESULTS.md）：
- **原生部分形态**：已定为 N-API 预编译模块。锁的文件描述符由宿主进程持有，崩溃自动释放；辅助程序单独崩溃会导致锁释放但写者继续运行的风险。三平台构建与 CI 打包列入 P1。
- **锁与恢复**：单实例锁与会话写锁争抢、强杀后释放、双向跨宿主恢复（pi-pane ↔ pi-agora）在 macOS 原型上全部通过，inode 与共享记录保持一致。
- **写锁时机**：预分配路径 `--session` 生效；`session_before_switch` 取消不改目标文件；新会话取锁失败时阻断后续发送；RPC 替换会产生两次 `session_start`，宿主与 bridge 已按幂等处理。
- **进程树终止**：快照机制在两次快照间 setsid 退出和早退后台进程两类时序下会遗漏进程，故 Linux 默认开启 cgroup v2，macOS 收窄承诺并增加 `StopReport.coverage` 字段；P1 调研 bash 启动上报 pgid。
- **路径规范化**：macOS 静态路径规则通过；TOCTOU 确认为固有剩余风险；比较前必须 realpath。
- **启动窗口门闩**：POSIX exec 前门闩的机制已在 macOS 原型上运行（结论为部分通过），但未并入双向宿主恢复测试；扩展 `session_start` 握手发生前会话文件已可能被改写，不能作为门闩（见“取得锁之后”）。门闩的集成列为后续工作。
- **进程身份未测项**：P0 只验证了伪造创建时间的记录被拒绝；真实 PID 复用、机器重启，以及身份检查到发信号之间的竞态未实测，仍待验证。
- **后续跨平台验证（移入公开发布前）**：Windows Job Object 与挂起创建、原生 PowerShell 与 junction、`icacls` 权限、Linux cgroup v2、Windows `GetProcessTimes` 与 Linux `/proc` 的进程身份精度、非本地文件系统拒绝。
