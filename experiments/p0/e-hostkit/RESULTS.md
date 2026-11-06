# E 组：pi-hostkit P0 结果

## 范围与总结果

本报告覆盖 agora #6、#15、pane #10，以及 `docs/hostkit.md` 的 P0 清单。权威设计、harness 和其他组的文件均未修改。

| 路线图项目 | 结论 | 依据 |
| --- | --- | --- |
| agora #6、pane #10：pi-hostkit | 部分通过 | macOS 原生能力、锁、会话事件、双向恢复、权限和路径用例有可运行原型；进程树的两个快照盲窗会遗漏进程。Windows、Linux 待测。 |
| agora #15：daemon 存活 | 部分通过 | macOS 的 PTY 关闭和 SIGHUP 实验通过；真实关闭图形终端窗口需主人手动。Windows、Linux 待测。 |

**不能把测试全绿理解为设计全部通过。** 两个故障注入测试断言“重现残留”，所以能在保留失败事实的同时检查实验是否可重跑。

### 环境

| 项目 | 实测值 |
| --- | --- |
| 系统 | macOS 27.0.1，build 26A434，arm64 |
| Node.js | v26.12.0 |
| pi | 1.5.0 |
| 编译器 | Apple clang 21.0.0，Command Line Tools |
| 文件系统 | 本机临时目录，APFS，`statfs().f_flags & MNT_LOCAL` 为真 |
| 模型 | 共用 harness 的 `p0-fake/scripted`，未调用真实模型 |
| 隔离 | 每例独立的 `HOME`、`PI_CODING_AGENT_DIR`、会话目录和工作目录；未访问用户的 `~/.pi` |

Node 24、macOS x86_64、大小写敏感 macOS 卷未测。Windows、Linux 的全部平台结论均为待测，不能由本机结果外推。

### 重跑与证据

```sh
node --test experiments/p0/e-hostkit/hostkit.test.mjs
```

报告对应的完整运行输出：

```text
E_HOSTKIT_FIXTURE .../T/e-hostkit-ATaalR
ℹ tests 34
ℹ pass 30
ℹ fail 0
ℹ cancelled 0
ℹ skipped 4
ℹ duration_ms 141663.008625
```

观察记录见 [evidence.jsonl](evidence.jsonl)。默认运行只写系统临时目录；上述完整运行通过 `P0_RECORD=1` 刷新仓库证据。只有测试和清理均通过才替换证据文件。运行方法和文件职责见 [README.md](README.md)。每节列出的测试名称均在 `hostkit.test.mjs` 中，可用 `--test-name-pattern` 单独重跑。

本机保留的总现场为 `/var/folders/0d/1h73_ysx6818yv_98vhrj3580000gn/T/e-hostkit-ATaalR`，其 `fixtures.txt` 列出每个 pi 现场。总目录还包含 `observations.jsonl`、`evidence.jsonl`、`owned-identities.json`、helper 和 N-API 构建产物。完整终端输出位于 `/tmp/e-hostkit-quiescence-record.log`。这些临时文件未删除，也未纳入提交。

## 原生能力

### macOS API

**验证内容**：同一份 C 实现分别编译为 N-API 模块和辅助程序，调用 `flock`、`proc_pidinfo(PROC_PIDTBSDINFO)`、`proc_listpids(PROC_ALL_PIDS)`。

**通过标准**：两种形态均能读取自身及测试子进程的 PID、PPID、PGID、状态和创建时间；同一 PID 的创建时间相同；能够争抢并释放内核锁；错误不能被当成取锁成功。

**实测结果**：两种形态均构建并运行。N-API 和 helper 读到的创建时间逐字一致；快照包含实验进程；不存在的父目录导致 N-API 抛错、helper 非零退出。不存在的 helper 路径启动失败，没有回退到锁文件排他创建。

```json
{"filesystem":{"local":true,"type":"apfs"},"helperBytes":35168,"addonBytes":51536}
```

体积为本机 arm64、`-O2`、未额外 strip 的产物；两者导出的实验功能并不完全相同，不能把体积差当成生产包的性能结论。

**结论：通过。** 测试：`native:`、`locks:`、`helper locks:`。

### 本地磁盘检测

**验证内容**：辅助程序通过 macOS `statfs` 返回文件系统名称及 `MNT_LOCAL`；Node 调用方只接受 `local === true`。

**通过标准**：本地目录可接受；远程目录拒绝；查询失败不能放行。

**实测结果**：APFS 返回 `local: true`；不存在路径报 `statfs: No such file or directory`，调用方抛错。没有挂载远程文件系统，未实测 NFS、SMB 或第三方文件系统的标志与拒绝行为。

**结论：部分通过。** 测试：`native:`；远程挂载项显式跳过。对应 `hostkit.md`「支持的平台」。

## POSIX 进程树终止

### 方法

pi 由 `process.execPath` 直接运行其 CLI 入口，以 `detached: true` 启动。假 provider 请求真正的内置 `bash` 工具，命令启动受控 Node 后代或 C 故障注入进程。

宿主原型按设计顺序执行：RPC abort → 关 stdin → 宽限 → 向 pi 发 SIGTERM → 宽限 → 快照与身份检查 → 后代进程组 SIGKILL → pi 进程组 SIGKILL → 复查。默认等待值与设计一致；测试显式使用 200/150/150 毫秒。运行期快照保持 **5000 毫秒**，没有为了清理成功而加快采样。

快照记录 PID、PGID 和创建时间。组长已退出时，以仍存活、创建时间与 PGID 一致的已记录成员确认该组身份。所有信号只发送给实验启动并记录的进程或进程组。

另有独立的 `oracle.jsonl`：后代自己写出身份，供测试判断实际残留。停止算法不读取它；正常路径在停止结果记录完毕后清理，异常路径由测试的 `finally` 读取并清理。oracle 身份只进入测试应急集合，不进入被测 tracker，避免掩盖快照算法的遗漏。

### 分项结果

**通过标准**：停止后 pi 和对应命令后代均退出，独立记录中无存活后代；报告中的残留与实际一致。每种场景重复三次。

| 验证内容 / 测试后缀 | 实测结果 | 结论 |
| --- | --- | --- |
| bash 长命令的独立进程组 / `independent` | 3/3 清理完成；后代 PGID 与 pi PGID 不同，正常 abort 已终止命令。 | 通过 |
| `nohup … & wait` / `nohup` | 3/3 清理完成；父 shell 在快照时仍存活，已记录其后台后代。 | 通过 |
| 先记录后代，再让父 shell 退出 / `parent-exit` | 3/3 清理完成；即使 pi 随关 stdin 退出，记录中的后代仍可确认原 PGID 并杀掉。 | 通过 |
| 快照已包含后代，再 SIGKILL pi / `pi-SIGKILL` | 3/3 清理完成；RPC 不可用，仍按记录找到独立命令组。 | 通过 |
| 两次快照之间 fork、setsid、父退出，再 SIGKILL pi / `escape-between-snapshots` | 3/3 各残留一个孤儿；`StopReport.leftovers` 均为 0。 | 不通过 |
| 首次快照前执行 `nohup … & exit 0`，之后正常停止 pi / `nohup-before-first-snapshot` | 3/3 各残留一个后台进程；没有 SIGKILL pi，也没有另行 setsid；`StopReport.leftovers` 均为 0。 | 不通过 |

关键日志摘录，字段含义与完整记录一致：

```text
process-parent-exit round=1 recorded=4 reportLeftovers=0 oracleLeftovers=[]
  SIGKILL descendants: [29276]
process-pi-SIGKILL round=1 recorded=2 reportLeftovers=0 oracleLeftovers=[]
  SIGKILL descendants: [29588]
process-escape-between-snapshots
  round=1 reportLeftovers=0 oracleLeftovers=[29751]
  round=2 reportLeftovers=0 oracleLeftovers=[29854]
  round=3 reportLeftovers=0 oracleLeftovers=[29956]
process-nohup-before-first-snapshot
  round=1 recorded=1 reportLeftovers=0 oracleLeftovers=[29963]
  round=2 recorded=1 reportLeftovers=0 oracleLeftovers=[29984]
  round=3 recorded=1 reportLeftovers=0 oracleLeftovers=[30005]
```

**设计差异与影响**：

- `hostkit.md`「进程树终止」开头的“命令进程都不留下”在两种盲窗中未达到。
- 该文「剩余风险」中的 setsid + pi SIGKILL 风险得到复现；普通后台命令在首次快照前被收养，也能在 pi 正常停止时遗漏。这个观察不以 pi 被强杀为前提。
- 复查只覆盖已见过的进程，所以 `leftovers: []` 在本实验中不能证明实际无残留。这影响 `hostkit.md` 的 `StopReport` 解释及「宿主被强杀」「取得锁之后」涉及的整棵进程树确认，也影响 agora `architecture.md`「会话驱动」和 pane `architecture.md`「关闭与回收」。
- 盲窗发生率是刻意安排时序的 3/3，不能解释为日常运行中的概率。

现场保留，报告未改动停止算法以规避上述现象。独立清理的结果见末节。

### 超时与升级终止

**验证内容**：假 provider 忽略 abort，以及 pi 被 SIGSTOP 后完全不能处理 RPC、stdin 和 TERM。

**通过标准**：abort 到期后继续后续步骤，不永远等待；最终进程退出。

**实测结果**：忽略 abort 的 provider 使请求在 200 毫秒超时，该例 pi 在关 stdin 后退出。SIGSTOP 例明确走到 SIGKILL：

```text
abort: false, "abort timeout 200ms"
closeInput: true
SIGTERM: true
SIGKILL descendants: []
SIGKILL pi group: true
leftovers: []
```

**结论：通过。** 测试：`process: unresponsive abort`、`process escalation:`。没有把短等待值的结果当成设计默认等待值的时延测量。

## 单实例锁与会话写锁

### 争抢、强杀和锁文件

**验证内容**：两个独立 Node 宿主同步争抢同一个内核锁；分别以单实例锁、会话锁场景运行三轮。N-API 将 FD 保存在持锁宿主内，锁文件不删除。

**通过标准**：每轮仅一个成功；杀掉赢家后重新取得同一锁；锁文件 inode 不变。

**实测结果**：两类场景各 3/3 只有一个赢家。SIGKILL 后首次成功重取锁的观测耗时为 21.49–22.32 毫秒。轮询间隔为 20 毫秒，该数值包含轮询和调度，不能当作内核释放本身的耗时。六轮 inode 均未变化。

```json
{"name":"lock-instance","round":1,"winners":1,"releaseMs":21.9,"sameInode":true}
{"name":"lock-session","round":3,"winners":1,"releaseMs":22.25,"sameInode":true}
```

会话路径通过真实路径、大小写折叠和 NFC 生成 SHA-256 key。现有文件和不存在文件的符号链接、大小写、Unicode 别名得到相同 key，见路径测试。

**结论：通过。** 测试：`locks:`、`paths: compare`。单实例测试验证互斥原语，不包含 daemon 发现文件的业务逻辑。

### 辅助程序持锁的生命周期

**验证内容**：helper 持锁时 N-API 不能取得；关闭控制管道，以及单独 SIGKILL helper。

**通过标准**：两种释放方式后内核锁可用，主 Node 进程仍存活；记录失败边界。

**实测结果**：两个场景均释放锁。

```json
{"action":"EOF","hostAlive":true,"lockReleased":true}
{"action":"SIGKILL","hostAlive":true,"lockReleased":true}
```

EOF 测试直接关闭宿主到 helper 的管道，验证的是管道断开的行为。helper 退出时，宿主本身没有退出，也没有被此原型自动终止。这是两种持锁形态的生命周期差异，不代表辅助程序可以无条件代替宿主持锁。

**结论：通过。** 测试：`helper locks:`。此处通过指上述原语和故障行为得到验证，不指“helper 退出但写者继续运行”符合会话写锁约束。

## 跨宿主恢复

### 已记录 writer 的双向恢复

**验证内容**：`host.mjs` 分别以 `pi-pane`、`pi-agora` 身份运行；共同使用隔离 HOME 下的 `~/.pi/hostkit/locks/`、同一锁 key 和 version 1 共享记录。旧 pi 写入带宿主名称的会话条目，随后宿主被 SIGKILL。

**通过标准**：旧宿主活着时新宿主取锁失败；旧宿主死后，新宿主先确认并停止旧 writer，再启动新 writer；会话内没有旧、新宿主交错写入；双向均成立。

**实测结果**：两个方向均通过。正常竞争者返回 `busy`；恢复者读到旧 writer 后执行信号停止，再创建新 pi。两个方向分别保留 21、22 条 `host-writer` 标记，切换后没有旧宿主标记。共享记录最终为 `released`，停止报告无已记录残留。

```text
pi-pane -> pi-agora: oldStoppedBeforeNew=true markerCount=21 interleaved=false
pi-agora -> pi-pane: oldStoppedBeforeNew=true markerCount=22 interleaved=false
```

**结论：通过。** 测试：`cross-host: ... spawn window=false`。这是无额外脱离后代的会话写者恢复；不覆盖前节已证实会遗漏的命令树，也不代表完整 pane/agora 产品已集成。

### spawn 与 writer 记录之间

**验证内容**：宿主写入 `starting` 后 spawn pi，暂停在写入 `writer` 之前并被 SIGKILL；另一个宿主取得锁。

**通过标准**：依任务书，两方向的新宿主均返回 `failed`，不自动拉起新 writer。

**实测结果**：两方向均满足；共享记录仍属于旧宿主且无 `writer`，没有覆盖未知状态。

```text
pi-pane -> pi-agora: result=failed newWriterStarted=false
pi-agora -> pi-pane: result=failed newWriterStarted=false
```

**结论：通过。** 测试：`cross-host: ... spawn window=true`。

**解释边界**：`hostkit.md`「取得锁之后」第 3 步允许在命令行扫描找到 pi 时转入第 2 步；P0 清单和本任务书对故障窗口明确要求 `failed`。本原型采用后者：没有 writer 身份就失败，不做命令行扫描命中后的自动恢复。因此本结果不验证“按命令行找回未知 writer”的分支，也不声称消除了记录窗口。

## 会话写锁时机

**验证内容**：锁后 `--session <不存在路径>` 启动；扩展取消 resume；观察 new、fork、clone 的替换事件和磁盘状态。

**通过标准**：指定路径不被替换为 pi 自生成路径；取消时目标不被改写；`session_shutdown.targetSessionFile` 与替换后的 `get_state.sessionFile` 及最终落盘路径一致。

**实测结果**：

- 宿主取得预分配路径的锁再启动 pi。`get_state.sessionFile` 就是该路径。首次启动时文件尚不存在，完成一次假回复后文件存在。
- 对空文件、v1 会话头文件、不存在文件分别发送 `switch_session`。扩展在 `session_before_switch` 返回取消，三次均 `cancelled: true`；原目标内容或“不存在”状态未变。源码 `AgentSessionRuntime.switchSession()` 在取消判断之后才调用 `SessionManager.open()`，与观察一致。未做系统调用级的 open 跟踪。
- 替换结果如下，四次的目标路径都与 `get_state` 一致，随后回复后都在该路径落盘。

| 替换 | before 事件带目标路径 | shutdown 时文件已存在 | 结论 |
| --- | --- | --- | --- |
| new_session | 否 | 否 | 通过 |
| 有对话叶子的 fork | 否 | 是 | 通过 |
| clone | 否 | 是 | 通过 |
| 第一条用户消息之前、无对话内容的 fork | 否 | 否 | 通过 |

```json
{"existsAtStart":false,"cancelled":["empty.jsonl","old.jsonl","missing.jsonl"],"replacements":[{"command":"new_session","atShutdownExists":false,"targetMatches":true},{"command":"fork","atShutdownExists":true,"targetMatches":true},{"command":"clone","atShutdownExists":true,"targetMatches":true},{"command":"fork","atShutdownExists":false,"targetMatches":true}]}
```

**结论：通过。** 测试：`session lock timing:`。这组核实取锁事件的可用时点；除启动路径外，没有实现完整的桥接扩展取目标锁及旧锁释放状态机。`forkFrom()` 的宿主进程内路径不在这组测试内。

## 启动窗口的阻断原型

**验证内容**：辅助程序在继承的 fd 3 上等待一个放行字节，收到后 `exec`；EOF 时退出、不执行目标。比较这种门闩与 pi 扩展 `session_start` 握手。

**通过标准**：放行前不会运行目标程序；可先保存身份再放行；exec 后 PID 和创建时间仍匹配；握手发生时点有实测证据。

**实测结果**：

- 未放行时没有标记文件；管道 EOF 后 helper 退出，标记仍不存在。
- 保存身份再放行时，Node 标记中的 PID 与保存值相同，创建时间相同。
- 目标换为真正的 pi RPC：放行前空会话仍为零字节；放行后可 `get_state`，空文件已有会话头，原身份仍匹配。
- 用扩展 `session_start` 阻塞启动时，到达握手点之前空会话已经被改写。这个扩展事件不能证明“握手前尚未打开会话”。

```json
{"gatedEmptyFileUnchangedBeforeGo":true,"identityStableAfterPiExec":true,"handshakeObservedAfterEmptyFileRewrite":true}
```

**结论：部分通过。** 测试：`spawn gate:`、`startup barriers:`。POSIX exec 前门闩的机制已运行；它没有并入双向宿主恢复测试。没有把门闩、扩展握手和 Windows 挂起创建都算成已经完成的平台启动实现。Windows 挂起创建待测。

## 进程身份与 PID 复用

**验证内容**：内核创建时间的格式、短时间多个进程的区分、错误时间戳记录的拒绝，以及 runId/instanceId 的作用。

**通过标准**：同一活 PID 搭配错误创建时间必须返回 `gone`，不得发信号；真实 PID 复用后不能误认；时间精度有实测记录。

**实测结果**：

- 使用 `pbi_start_tvsec` 和 `pbi_start_tvusec`，按字符串 `秒.六位微秒` 保存，没有转换为毫秒。
- 12 个连续启动的子进程有 12 个不同时间戳，最小观测间隔 532 微秒。这是样本间隔，不是对内核时钟准确度的测量。
- 对活进程伪造 `startTime: "0.000001"` 返回 `gone`，停止函数拒绝发 SIGKILL；真实身份仍为 `alive`。
- 只改 runId/instanceId、保留 PID 与创建时间，仍返回 `alive`。这两个字段属于宿主记录，内核没有对应字段可用于校验。
- 没有为了强迫 PID 回绕而大量创建进程，也没有真实重启机器。真实 PID 复用、机器重启和检查到发信号之间的竞态均未实测。

```json
{"simulatedMismatchRejected":true,"realPidReuse":"not forced","metadataNotKernelIdentity":true}
{"count":12,"unique":12,"minimumObservedDeltaUs":532}
```

**结论：部分通过。** 测试：`identity:`、`identity precision:`。Windows `GetProcessTimes`、Linux `/proc` 的精度和身份行为待测。

## daemon 存活

**验证内容**：C helper 创建真实 PTY，让 pi RPC 连接其 slave，并设置控制终端。pi 扩展以 `detached: true`、`windowsHide: true`、`stdio: ignore`、`unref()` 启动 Node daemon；daemon 再启动真实 pi RPC 子进程，完成一次假 provider 回复后维持心跳。

**通过标准**：关闭 PTY master、终端侧 pi 退出之后，daemon 与它的 pi 子进程仍活着，心跳继续；显式 SIGHUP 也满足。

**实测结果**：三轮均通过；其中两轮先向终端侧 pi 发 SIGHUP，再关闭 master；一轮只关闭 master。每轮 daemon 的 PGID 不同于终端侧 pi，终端侧 pi 已退出，daemon 心跳增大，daemon 和 pi 子进程均存活。

```text
daemon-pty round=1 explicitHup=true  terminalGone=true daemonAlive=true childAlive=true childIsPiRpc=true
daemon-pty round=2 explicitHup=false terminalGone=true daemonAlive=true childAlive=true childIsPiRpc=true
daemon-pty round=3 explicitHup=true  terminalGone=true daemonAlive=true childAlive=true childIsPiRpc=true
```

**结论：部分通过。** 测试：`daemon:`。PTY 内运行的是 RPC 模式，未实测 TUI 的界面生命周期。没有操作 Terminal、iTerm 等图形程序；真实关窗口需主人手动。Windows、Linux 待测。对应 agora `architecture.md` 的 daemon 生命周期和 roadmap #15。

## 路径规范化与权限

### 路径与 pi 对照

**验证内容**：符号链接、大小写、`..`、`@`、`~`、file URL、Unicode 空格、NFD、macOS 截图名、写入不存在的路径、包含关系和锁 key。

**通过标准**：测试路径最终指向与 pi 1.5.0 相同的真实位置；相同文件或不存在目标的别名得到相同锁 key；前缀相似的兄弟目录不被当成子目录。

**实测结果**：

- 独立 Node 子进程在隔离 HOME 中导入安装包 `dist/core/tools/path-utils.js`。12 个输入分别对照 `resolveReadPath` 和 `resolveToCwd`，经真实路径处理后 24 次比较均一致。
- 覆盖普通路径、`@`、`..`、`~`、file URL、NBSP、U+2000、U+200A、U+202F、U+205F、U+3000、NFD 和不存在的多级目标。
- 补充用例覆盖 symlink、弯引号截图名、AM/PM 窄不换行空格回退。写入新文件时，最深已存在祖先被解析为真实路径，其后保留尚不存在的部分。
- 本机 APFS 上，`realpath.native(".../cAFÉ.TxT")` 返回创建时的 `.../Café.txt`。NFD 输入也解析到同一文件；比较键再做小写与 NFC。
- `DataElse/file` 不属于 `Data`。现有文件和新文件的符号链接、大小写及 Unicode 别名共享锁 key。

```json
{"cases":12,"modes":["read","write"],"mismatches":0,"existingAndMissingAliasLockKeysEqual":true}
```

**结论：通过。** 测试：`paths and secrets:`、`paths: compare`。Windows junction、盘符和大小写规则待测；Linux 大小写敏感行为待测。

### 链接切换

**验证内容**：规范化链接后，将同一个链接改为指向另一个受控目录，再按原输入打开文件。

**通过标准**：记录真实打开位置，核实设计已经声明的 TOCTOU 剩余风险。

**实测结果**：校验路径位于 `cwd/Data/Café.txt`；替换链接后读取到另一个目录中的字符串 `outside`。

```json
{"toctou":{"checked":".../cwd/Data/Café.txt","opened":"outside"}}
```

**结论：通过。** 这表示风险描述被复现，**不表示路径校验阻止了链接切换**。对应 `hostkit.md`「路径规范化」的剩余风险；未改变设计的非沙箱边界。

### 目录与文件权限

**验证内容**：目录从 0755 收紧为 0700；文件以 `wx` 和 0600 创建；检查当前属主、宽权限及重复创建。

**通过标准**：最终权限为 0700/0600；重复创建不覆盖；宽权限检查失败。

**实测结果**：0755 目录检查失败，收紧后通过；0600 文件检查通过，改成 0644 后失败；第二次 `wx` 创建报 `EEXIST`，未覆盖内容；属主是当前用户。

```json
{"dirMode":"700","fileMode":"600","owner":true}
```

**结论：通过。** 测试：`paths and secrets:`。没有创建其他系统用户，也没有实测异属主文件；Windows ACL 待测。

## RPC 传输补充验证

**验证内容**：LF 分帧、分字节 UTF-8 输入、CRLF、Unicode 分隔字符、默认 64 MiB 上限、按 id 关联、超时、迟到响应和扩展 UI 回应。

**通过标准**：中文、emoji、U+2028、U+2029 不损坏；超限报错；乱序响应不串号；超时 Promise 不被迟到响应再次完成；真实 pi 扩展能收到 UI 回应。

**实测结果**：以上用例通过。模拟响应进程先返回第二条响应，两个 Promise 仍分别得到 `e-2`、`e-3`；超时响应只进入迟到日志，数量为 1。真实 pi 扩展请求 confirm，宿主回应 `confirmed: false`，扩展通知 `{"answer":false}`，命令为 `handled`。

```json
{"unicodePreserved":true,"over64MiBRejected":true,"lateDiscarded":1,"correlated":["e-2","e-3"]}
{"requestSeen":true,"confirmed":false,"commandDisposition":"handled"}
```

**结论：通过。** 测试：`RPC:`、`RPC extension UI:`。此原型不等于完整公开 `RpcTransport` API；没有对巨量背压做吞吐基准。

## Windows、Linux 与人工项目

以下项目在脚本中显式跳过，没有用 mock 结果代替平台通过。

| 验证内容 | 通过标准 | 实测结果 | 结论 |
| --- | --- | --- | --- |
| Windows 挂起创建、加入 Job 后恢复、长命令/后台/父退出后代终止、宿主强杀时 Job 清空 | 全部后代退出，不能 breakaway | 待测 | macOS 上无法验证 |
| Windows 命名 mutex、争抢与 abandoned 取锁 | 唯一持有；宿主死后可取得 | 待测 | macOS 上无法验证 |
| Windows GetProcessTimes 和 PID 复用 | 身份匹配且不误杀 | 待测 | macOS 上无法验证 |
| Windows icacls 的 SID 参数、继承收紧和实际 ACL | 只有当前用户获所需权限 | 待测；未执行 icacls | macOS 上无法验证 |
| Windows junction、盘符/MSYS/WSL 路径和比较键 | 与 pi 和实际文件一致 | 待测 | macOS 上无法验证 |
| Linux `/proc` 快照、创建时间、flock、进程组停止、权限及路径 | 满足 hostkit 对应平台行为 | 待测 | macOS 上无法验证 |
| Linux cgroup v2 / child subreaper | 能记录和回收脱离后代 | 待测 | macOS 上无法验证 |
| Windows、Linux daemon 终端关闭 | daemon 和子进程继续存活 | 待测 | macOS 上无法验证 |

macOS 图形终端真正关窗口一项属于需主人手动，结论并入 daemon 的“部分通过”。远程文件系统一项属于无挂载现场，结论并入本地磁盘检测的“部分通过”，不称为 macOS 不具备验证能力。

## 原生部分的形态：比较与推荐

### 本机比较

| 能力或故障 | N-API 预编译模块 | 小辅助程序 | Node 自带能力 / 系统命令 |
| --- | --- | --- | --- |
| POSIX flock | 已运行；FD 由宿主持有，SIGKILL 宿主后释放 | 已运行；FD 在 helper 内，控制管道 EOF 或 helper 被杀后释放 | Node 没有公开 flock API；本机 PATH 无 `flock` 命令。`wx` 创建文件不具有内核锁的持有进程生命周期。 |
| macOS 创建时间 | 已运行；微秒字段保留为字符串 | 已运行；与 N-API 相同 | `/bin/ps -o lstart` 实测输出只有秒且受 locale 影响；不能提供本例的微秒区分。 |
| 进程表快照 | 已运行；`proc_listpids` + `proc_pidinfo` | 已运行；同一底层实现，JSON 输出 | `ps` 可提供 PID/PPID/PGID 等诊断数据，但本实验没有用其秒级时间作为安全身份。 |
| exec 前启动门闩 | 本模块未实现此入口 | 已运行；fd 3 放行后 exec，EOF 不执行 | Node 的 spawn + detached 本身没有“先登记内核身份再开始执行”的门闩。 |
| 权限与路径 | 不需要原生扩展 | 不需要 helper | Node fs、realpath、chmod、O_EXCL 和路径 API 已完成本机用例。 |
| 本地文件系统标志 | 底层 C 可调用；本 N-API 导出未包装此入口 | 已运行 statfs/MNT_LOCAL | Node 的 statfs 类型信息不等于本实验读取的 MNT_LOCAL 标志；未用文件系统名称列表替代。 |
| 可预期 API 失败 | 无效锁目录抛 JS 错误 | 无效锁目录退出 70；不存在程序启动失败 | JS 调用方可拒绝继续；实验没有自动降级。 |
| 原生进程崩溃的边界 | 原生代码和宿主同一地址空间；本实验用 SIGKILL 宿主验证锁释放，未注入内存破坏 | SIGKILL helper 不杀宿主，但锁已释放；此行为已实测 | 这一差异来自进程边界，不能只凭“helper 更隔离”判断会话互斥仍成立。 |

### 三平台构建与分发评估

以下是构建接口和平台依赖的比较；**只有 macOS arm64 本地编译及执行已经实测**，没有跨平台预编译发布结果。

| 平台 | N-API 形态 | 辅助程序形态 | 状态 |
| --- | --- | --- | --- |
| macOS | Clang + Node C 头文件，`.node` bundle，libproc 系统 API。本例直接使用 N-API C 接口，无 node-addon-api、node-gyp 或 npm 依赖。 | Clang + macOS SDK，Mach-O 程序，不需要 Node 头文件。 | arm64 两者实测；x86_64、Universal 产物、签名和实际 npm 安装待测。 |
| Linux | Node 头文件和 Linux 编译器；flock 与 `/proc` 后端；需覆盖目标架构及运行时 libc。 | 无 Node 头文件，但仍有目标架构、libc 和系统调用后端的构建要求。 | 待测；本 C 原型以编译错误明确拒绝非 macOS 构建。 |
| Windows | Windows 工具链 + Node 头文件；新增 mutex、GetProcessTimes、挂起创建和 Job API 后端；句柄位于宿主进程。 | Windows 工具链和独立 exe；同样需要 Win32 后端，另有句柄所有者与宿主/helper 生命周期的通信边界。 | 待测；没有编译或运行。 |

两种形态都需要按 OS/架构选择原生产物；Linux 还需处理 libc 兼容性。N-API 将接口限定为 Node 的稳定 C ABI，本例使用 N-API 8；这不免除平台、架构和运行时验证，也不表示已经验证 Node 24。辅助程序不依赖 Node ABI，但需要可执行文件分发、权限和版本匹配的协议。没有实测下载、签名、隔离属性、安全软件拦截或发布流水线，不能据本报告给出这些环节的耗时和成功率。

**形态验证结论：部分通过。** 两者在 macOS 均能提供三项核心原语；三平台构建与分发尚未完成。

### 推荐

推荐以 **N-API 预编译模块**作为平台内核原语的主要形态，最终由主人决定。

依据是本次实测的持锁生命周期：N-API 的锁 FD 直接归宿主，宿主死亡与内核释放是同一次进程退出的后果；独立 helper 被杀时宿主仍活着而锁已经可被别人取得。两种形态都读到了相同的进程身份与快照，因此这里的选择依据是锁的所有权和故障边界，不能以 API 能力不足排除 helper。

exec 门闩 helper 已证明机制可运行，但没有被计入 N-API 成品能力。推荐不表示跨平台启动接口、原生代码崩溃安全或分发工作已经完成；Node 能独立完成的 RPC、路径与 POSIX 权限无需纳入原生实现。

## 清理与边界

### 测试专用的应急清理

每个测试在启动进程前建立清理作用域，每个 harness 现场创建后立即登记 `after` hook。测试主体由 `try/finally` 包围；`withTracker()` 的 `finally` 停掉定时快照并将已有记录交给应急集合，测试的 `finally` 执行现场清理。没有 pi fixture 的锁、RPC 模拟进程、身份和 gate 用例也受测试级作用域保护。重复调用清理返回同一个 Promise。

`test-cleanup.mjs` 在成功和失败路径均读取本现场的 `oracle.jsonl`、`cleanup-oracle.jsonl` 和已存在的 `daemon.json`。host 在 spawn writer 后、daemon 扩展和 worker 在 spawn daemon/pi 子进程后写入清理日志，不依赖就绪消息或 `daemon.json`。清理把日志身份与 tracker 已有身份合并，用快照补充仍可追溯的后代，再按 **PID + 创建时间**逐个 SIGKILL；重复读取日志以收集清理期间的追加记录。清理预算为 5 秒，必须在截止前通过扫描确认至少 250 毫秒没有新增身份、活进程、僵尸或解析错误。成功只由显式的 `quiesced: true` 判定；到达截止时未确认静默，即使 `remaining=[]`、`parseErrors=[]`，也报“清理不完整”。

每个作用域保留 `emergency-cleanup.json`：`quiesced` 表示是否在截止前确认静默，`quietMs` 是最后一次完成扫描时确认的连续静默毫秒数（新增身份或其他异常使其归零），`timedOut` 表示未静默即耗尽预算，`elapsedMs` 记录清理耗时。最后一次等待跨过截止时，不把未再扫描的等待时长计入 `quietMs`。

这套逻辑只用于测试回收；`prototype.mjs` 的停止流程不读取 oracle。两种快照盲窗仍各断言并记录一个实际残留，随后才由测试清理六个残留。没有使用 `pkill`、`killall` 或按名称终止进程。

### 登记前失败注入

`cleanup failure:` 的三个用例使用与正常测试相同的 `withCleanup()`，在 oracle 身份尚未加入应急集合时抛出指定异常，并断言该异常原样传回；若清理另有错误，测试不能通过。

| 现场 | 注入时点 | 结果 |
| --- | --- | --- |
| `nohup` 后台 worker | shell 已退出、oracle 已落盘，但测试尚未读取身份 | 一个独立进程组后代被清理；tracker 定时器已停止，tracker 未得到 oracle 身份。 |
| native `setsid` 孤儿 | helper 父进程已退出、oracle 已落盘，但测试尚未读取身份 | 一个独立进程组后代被清理；tracker 定时器已停止，tracker 未得到 oracle 身份。 |
| PTY 启动的 daemon 与 pi 子进程 | 清理日志已落盘，worker 被门闩保持在写 `daemon.json` 之前 | 两个独立进程组身份被补入并清理；`daemon.json` 始终不存在。 |

三个现场的 `remaining` 均为 `[]`，清理后再按身份确认后代退出。该验证覆盖可执行 `finally` 的测试异常，不覆盖测试 runner 被 SIGKILL、系统崩溃或身份日志尚未落盘且后代已无法追溯的窗口，也不扩大产品停止算法的保证。

### 静默截止条件

`cleanup deadline:` 注入可控时钟和等待函数，预算与静默阈值仍为 5000/250 毫秒。测试使用空进程快照，将 oracle 中的身份视为已退出进程；不启动进程、不发送信号，也不依赖真实调度命中截止窗口。

| 场景 | 最后一次扫描确认的静默 | 结果 |
| --- | --- | --- |
| 无新身份，完整观察 250 毫秒 | `quietMs=250` | `quiesced=true`、`timedOut=false`，成功。 |
| 在 4950 毫秒才写入身份 | `quietMs=0` | 5000 毫秒截止，`quiesced=false`、`timedOut=true`，拒绝成功。 |
| 在 4700 毫秒才写入身份 | `quietMs=200` | 5000 毫秒截止，`quiesced=false`、`timedOut=true`，拒绝成功；没有把最后的等待算作已确认静默。 |

三个场景的 `remaining`、`parseErrors` 均为空。测试核对 Promise 的成功或拒绝、重复调用的幂等性，以及落盘报告中的状态和时长。该结果验证清理循环的截止判定，不代替前述真实进程故障注入。

### 全量运行复查

完整证据运行共登记 **123 个进程身份**，最终 hook 输出：

```json
{"recorded":123,"beforeCleanup":[],"leftovers":[],"zombies":[],"recoveryErrors":[]}
```

测试结束后再次加载 `owned-identities.json`，与新一次原生进程快照按 PID 和创建时间比对：

```json
{"recorded":123,"remaining":[]}
```

复查 65 份测试级和现场级清理报告，均为 `quiesced=true`、`quietMs>=250`、`timedOut=false`；确定性测试单独目录中的预期超时报告不计入这 65 份。

另用 `ps -axo pid=,ppid=,pgid=,stat=,command=` 检查 E 组 worker/host、临时 helper、该 worktree 的 fake-provider 参数和现场路径，没有匹配的实验进程。名称和路径仅用于检查，不用于发信号。

**结论：通过。** 本轮成功路径和三个登记前失败现场均无已登记身份对应的遗留活进程或僵尸进程。现场目录与构建产物仍保留。没有安装全局或本地 npm 依赖，没有改系统设置，没有自动操作图形终端，也没有修改 `docs/`、harness、其他组或 pi-pane 仓库。
