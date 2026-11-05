# G 组 P0 实验结果：存储与只读解析

本组验证 pi-agora `docs/roadmap.md` 的 P0 第 9、10 项，以及 pi-pane `docs/roadmap.md` 的 P0 第 6、8 项。agora #10 与 pane #8 是同一类验证，共用一套实验。

## 结论汇总

| 项 | 内容 | macOS | Windows | Linux |
| --- | --- | --- | --- | --- |
| agora #9 | `node:sqlite`：WAL 读写并发、事务、强杀后一致性、`backup()` | 通过（进程崩溃；备份限于同一连接或一步复制） | 待测 | 待测 |
| agora #10 | 会话文件只读解析（各版本、空文件、截断） | 通过（文件重新打开语义） | 待测 | 待测 |
| pane #6 | 项目信任：预判、`project_trust` 处理器、`isProjectTrusted()` | 通过（浏览器询问界面未测） | 待测 | 待测 |
| pane #8 | 会话文件只读解析（v1、v2、v3、截断） | 通过（文件重新打开语义） | 待测 | 待测 |

“通过”只针对下文列出的场景和对通过标准的理解，括号里是范围限定：

- agora #9：崩溃指进程被 `SIGKILL`，断电（操作系统崩溃）在 macOS 上无法用本实验验证。备份“可打开且校验通过”在同一连接备份和一步复制全部页两种方式下成立；独立连接按 100 页一步备份、另一连接每 2 ms 写一次时，20 秒内无法完成。
- agora #10、pane #8：解析结果与 pi 重新打开该文件时 `get_entries` 和叶子的计算结果一致。pi 进程运行中导航到别的分支、尚未追加条目时，在线的 `leafId` 与从文件推导的叶子不同，所以不能扩大为“在线与离线的叶子在任何时刻都相同”。
- pane #6：浏览器里的询问界面没有实测，用测试代码的固定回答或不回应代替。

各项还记录了与设计文档描述不完全一致的实际行为，见每项的“观察”。

## 环境与重跑

- macOS 27.0.1（arm64），Node v26.12.0，`node:sqlite` 内置 SQLite 3.54.1，pi 1.5.0（`/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent`，`pi` 命令指向 `dist/bundle/cli.js`）。
- 所有 pi 进程都通过 `experiments/p0/harness/` 的假 provider 运行，不调用模型服务，不联网。
- 每个现场都是临时目录，`HOME`、`PI_CODING_AGENT_DIR`、会话目录和 `trust.json` 都在其中。测试通过后删除现场，失败时保留并在输出中打印 `fixture:` 或 `保留现场:` 路径。

在仓库根目录执行：

```sh
node --test "experiments/p0/g-store/*.test.mjs"
```

本机一次完整运行约 40 秒，55 个测试全部通过。可以单独运行某个文件，例如 `node --test experiments/p0/g-store/sqlite.test.mjs`。

### 证据文件

每个测试文件结束时把观察结果写成 JSON，并在输出中打印 `# 证据: <路径>`：

- 默认写到系统临时目录下每次新建的 `g-store-evidence-<时间>-<随机后缀>/`，不改动仓库。
- 设置 `P0_RECORD=1` 时写入 `experiments/p0/g-store/evidence/`（`sqlite.json`、`session.json`、`trust.json`），刷新已提交的证据。

下文的次数、耗时和 id 都来自已提交的证据，即 2026-11-05T14:23Z 的一次 `P0_RECORD=1` 完整运行；每次运行的数值会有差异，id 每次都不同。

| 环境变量 | 作用 | 默认 |
| --- | --- | --- |
| `P0_RECORD=1` | 证据写入仓库的 `evidence/` | 写到临时目录 |
| `P0_KEEP=1` | 测试通过时也保留现场 | 不保留 |
| `P0_CRASH_ITERATIONS` | 随机时刻强杀的次数 | 24 |
| `P0_BACKUP_TIMEOUT_MS` | 备份实验的期限 | 20000 |
| `P0_PI_ROOT` | pi 安装目录（读取 `trust-manager.js`） | 上面的 Homebrew 路径 |

脚本只依赖 Node 内置模块和共用 harness。子进程用独立进程组启动，按进程组终止，已退出的子进程不再发信号；路径用 `node:path` 拼接。Windows 上没有进程组，`lib.mjs` 改为终止单个进程，未实际运行过。

时机同步都用条件等待加期限：等写者输出某一行（`ready`、`begin <tx>`、`barrier`、`committed`）、等 RPC 事件或响应。需要“事务保持打开”的地方由写者输出 `barrier` 后阻塞，父进程收到后才强杀。测试里出现的时长只有四类：读写并发的测量时长（3 秒）、备份和等待的期限、写者的写入间隔（备份实验的负载形态）、被测对象本身的超时或延迟（pane-bridge 询问超时 1.5 秒，兑换响应故意延迟 300 ms），都不用来充当同步。随机时刻强杀的时机由随机选定的事务编号决定，不用随机延时。

## 文件

| 路径 | 内容 |
| --- | --- |
| `sqlite.test.mjs` | agora #9 |
| `sqlite/writer.mjs` | 模拟 daemon 的写者：每个事务更新 `tasks.revision`，并写入同样行数的 `outbox` 和 `changes`；可在事务中途输出 barrier 并保持事务打开 |
| `sqlite/reader.mjs` | 模拟 archive adapter：`readOnly` 打开，反复读并检查事务原子性 |
| `sqlite/backup-run.mjs` | 调用 `backup()`，记录进度、重新开始的次数和起止时间 |
| `sqlite/check.mjs` | `PRAGMA integrity_check` 加事务不变量检查 |
| `session.test.mjs` | agora #10、pane #8 |
| `session/parser.mjs` | 只读解析器原型与活动分支投影 |
| `session/generate.mjs`、`session/gen-ext.ts` | 用 pi 生成 v3 会话文件的驱动脚本和测试扩展 |
| `trust.test.mjs` | pane #6 |
| `trust/pane-bridge-trust.ts` | pane-bridge 的 `project_trust` 处理器原型 |
| `trust/early-trust.ts`、`trust/late-trust.ts` | 排在 pane-bridge 之前、之后的其他 `project_trust` 处理器 |
| `lib.mjs` | 子进程管理、harness 现场收尾、证据输出、临时目录、哈希 |
| `evidence/` | 已提交的证据（`P0_RECORD=1` 时刷新） |

## agora #9：node:sqlite

### 验证内容

- WAL 模式下一个写者进程持续写入，两个读者进程用 `readOnly: true` 打开并持续读取。
- 每个写者事务在 `BEGIN IMMEDIATE … COMMIT` 内同时更新 `tasks`、写入 `outbox` 和 `changes`。读者在单条语句和显式读事务两种方式下检查三者是否始终一致。
- 随机时刻强杀：写者被 `SIGKILL` 强杀 24 次，覆盖小事务、单个事务 2 万行、每 5 个或每个事务后执行 `PRAGMA wal_checkpoint(TRUNCATE)` 的压力场景。父进程等写者输出随机选定的第 k 个事务的 `begin` 行后立即强杀。
- 事务打开时强杀（确定性）：写者在 `BEGIN IMMEDIATE`、更新 `tasks`、写入 N 行 `outbox` 和 N/2 行 `changes` 之后输出 `barrier`，保持事务打开并阻塞；父进程收到 `barrier` 后强杀。三种情况：新库的第一个业务事务；已提交 200 个事务（每 20 个 TRUNCATE 检查点）之后；页缓存设为 50 页的 2 万行大事务（未提交的页提前写进 WAL 文件）。
- 每次强杀后先以 `readOnly` 打开（daemon 尚未重启时的 adapter），再以读写方式打开（daemon 重启），都执行 `PRAGMA integrity_check` 和不变量检查。
- `backup()` 在写入进行中，每个方式声明期望（见下表）。备份以 `readOnly` 打开后执行 `integrity_check` 和不变量检查。数据库预先填充 32 MiB，备份约 8200 页。“备份期间的写入”按时间戳统计：另一进程的写者在每次 `COMMIT` 后输出 `Date.now()`，落在备份的开始和结束时刻之间的计数；同一连接方式由本进程直接计数。
- daemon 未运行时 adapter 以 `readOnly` 打开数据库。

### 通过标准

并发读写无错误；崩溃后数据一致；备份可打开且校验通过。

### 实测结果

基本信息：新建连接的 `synchronous` 为 2（FULL），`busy_timeout` 为 0；`readOnly` 连接写入时报 `ERR_SQLITE_ERROR errcode=8 attempt to write a readonly database`。写者和读者的 stderr 为空，Node 26 使用 `node:sqlite` 时没有输出实验性警告。

并发读写，每种配置运行 3 秒（`evidence/sqlite.json` 的 `walConcurrency`）：

| 配置 | 写者提交 | 每个读者的读取次数 | 违反不变量 | 错误 |
| --- | --- | --- | --- | --- |
| 读者 busy timeout 0，写者每 20 个事务 TRUNCATE 检查点 | 1040 | 6181、6186 | 0 | 无 |
| 读者 busy timeout 0，只有自动检查点 | 28708 | 191、190 | 0 | 无 |
| 读者 busy timeout 5000，写者每 20 个事务 TRUNCATE 检查点 | 1100 | 6001、5989 | 0 | 无 |

随机时刻强杀（`randomKill`）：24 次中 23 次发生在“已输出 `begin`、尚未输出 `committed`”的窗口里，1 次发生在确认之后、下一个 `begin` 之前。`begin` 在执行 `BEGIN` 之前输出，`committed` 在 `COMMIT` 返回之后输出，所以这个窗口既包含事务打开期间，也包含 `BEGIN` 之前和 `COMMIT` 已返回、确认尚未输出的瞬间，不能据此断定强杀时事务一定处于打开状态。检查点同样没有单独记录边界，只能说这些是启用了检查点的压力场景，不能说强杀命中了进行中的检查点。

每次 `readOnly` 和读写打开的结果相同，`integrity_check` 都是 `ok`，没有部分写入的事务，已确认的事务没有丢失，`maxTx` 都不超过最后一个 `begin` 的编号。

```text
#0 rows=1 ckpt=0 k=837 lastBegin=838 lastAcked=837 ro.maxTx=838 rw.maxTx=838 ro.problems=0 rw.problems=0
#2 rows=20000 ckpt=0 k=1 lastBegin=1 lastAcked=0 ro.maxTx=0 rw.maxTx=0 ro.problems=0 rw.problems=0
#5 rows=1 ckpt=5 k=2815 lastBegin=4520 lastAcked=4520 ro.maxTx=4520 rw.maxTx=4520 ro.problems=0 rw.problems=0
汇总: {"unackedWindow":23,"afterAck":1,"ackedLost":0,"beyondLastBegin":0}
```

`#0` 中 `maxTx` 比 `lastAcked` 大 1：该事务已提交，写者在输出确认前被杀。

事务打开时强杀（`barrierKill`）：

| 情况 | barrier | 强杀前 WAL 文件 | 恢复后 `maxTx`（readOnly / 读写） | `integrity_check` |
| --- | --- | --- | --- | --- |
| 新库的第一个业务事务 | `barrier 1 10 5` | 45352 字节 | 0 / 0 | ok |
| 已提交 200 个事务之后 | `barrier 201 10 5` | 0 字节 | 200 / 200 | ok |
| 2 万行大事务，页缓存 50 页 | `barrier 4 20000 10000` | 6324232 字节 | 3 / 3 | ok |

三种情况下打开中的事务（含 `tasks` 的更新、已写入的 `outbox` 和 `changes` 行）恢复后都不可见，`tasks.revision` 等于已提交的事务数。第三种情况强杀前 WAL 文件已有约 6 MiB，而此前只提交过 3 个小事务，说明未提交的页已写入 WAL；恢复时这些页被忽略。

`backup()`（`backup`）：

| 方式 | 期望 | 结果 |
| --- | --- | --- |
| 同一连接，备份期间本进程每 1 ms 写一个事务，`rate` 50 | 必须完成，期间必须有写入 | 62 ms 完成；计数到的写入 52 个，备份的 `revision` 为 61（初始 10 加 51）；校验 `ok` |
| 独立连接，另一进程连续写，`rate` 1000000（一步复制全部页） | 必须完成，期间必须有写入 | 64 ms 完成；期间另一进程提交 538 个事务；备份是开始时刻的一致快照（`revision` 1515）；校验 `ok` |
| 独立连接，另一进程每 50 ms 写一个事务，`rate` 100 | 必须完成（按实测） | 53 ms 完成，重新开始 1 次，期间另一进程提交 2 个事务；校验 `ok` |
| 独立连接，另一进程每 2 ms 写一个事务，`rate` 100 | 观察饥饿，允许超时，但超时时必须观察到重新开始 | 20 秒内未完成，重新开始 7718 次，期间另一进程提交 7719 个事务 |

同一连接方式中，备份里的写入比计数少 1 个。计数在 `await backup()` 返回后才停止，差的一次写入可能发生在备份完成与计数停止之间，这一点没有单独核实。

`rate` 必须是正整数，传 -1 时 `backup()` 抛出 `ERR_OUT_OF_RANGE`。

daemon 未运行时（`readOnlyOffline`）：写者正常关闭后目录里只有 `agora.db`；`readOnly` 打开并读取后，目录里出现 `agora.db-shm` 和 `agora.db-wal`。把数据库移到不可写的目录（`chmod 555`）后，`readOnly` 打开读取失败：

```text
打开或读取失败：ERR_SQLITE_ERROR errcode=1544 attempt to write a readonly database
```

### 结论

通过（macOS，进程崩溃；备份限于同一连接或一步复制全部页）。Windows、Linux 待测。

断电或操作系统崩溃时，未落盘的页缓存会丢失，这与进程被强杀不同。macOS 上无法用本实验验证这一部分；roadmap“必须测试的故障”中的“数据库在事务中断电”仍未覆盖。

### 观察

- **独立连接的备份会被其他连接的写入打断**：源库被另一个连接修改后，SQLite 在线备份从头开始。按 100 页一步时，写入间隔短于整个备份所需时间，备份就一直无法完成。同一连接上的写入不会打断备份，并会同步到备份中；一步复制全部页（`rate` 大于总页数）时一次完成。architecture.md“升级”第 1 步只写了使用 `backup()`，没有规定用哪个连接、每步多少页。
- **`readOnly` 打开 WAL 数据库会创建 `-wal` 和 `-shm` 文件**，目录不可写时打开失败。archive.md“只读 archive adapter”的 adapter 在 daemon 未运行时以 `readOnly` 打开 `agora.db`，因此需要对 `AGORA_HOME` 有写权限。
- **WAL 无法回卷时读取变慢**：只有自动检查点时，读者一直持有读快照，WAL 无法重置，3 秒内写者提交约 2.9 万个事务，读者每 3 秒只完成约 190 次读取（另两种配置约 6000 次）。没有出现错误。
- 读者 busy timeout 为 0 和 5000 时都没有出现 `SQLITE_BUSY`。

## agora #10 与 pane #8：会话文件只读解析

### 验证内容

1. 用 pi 1.5.0 和假 provider 生成 v3 会话：两轮对话（含一次 `read` 工具调用）、`set_session_name`、`set_thinking_level`、扩展写入的 `custom` 和 `custom_message`、`label`、RPC `compact`、带摘要的 `navigateTree`（产生 `branch_summary` 和一个被放弃的分支），之后在新分支上继续对话。文件包含 20 个条目。
2. 按 pi `dist/core/session-manager.js` 的迁移逻辑反向构造旧版本：
   - v2：头部 `version: 2`，在末尾追加一条 `message.role` 为 `hookMessage` 的消息（v2→v3 迁移只改这一处）。
   - v1：取被放弃分支那条路径（含 `compaction`），去掉 `id`、`parentId`，`compaction` 的 `firstKeptEntryId` 换成 `firstKeptEntryIndex`（与 pi 相同，下标包含 session 头），去掉按 id 引用其他条目的 `label`，末尾追加一条 `hookMessage` 消息。分别构造头部没有 `version` 和 `version: 1` 两种。
3. 变体：最后一行没有换行符；追加新条目时中途截断（切在多字节字符中间）；最后一个条目被截去一半；中间一行损坏；只有 session 头；0 字节空文件；只有空行；第一行不是 session 头；v1 最后一行被截断。共 13 个样本。
4. 对每个样本：用 `session/parser.mjs` 解析两次，比较结果和文件的 sha256、大小、mtime；再复制一份交给 pi（`--session <副本>`），用 RPC `get_entries` 取条目和 `leafId`，与解析结果比较条目、叶子和活动分支（从叶子沿 `parentId` 回到根，即 archive.md 的投影②）；最后在 pi 退出后解析 pi 写回的副本，与 `get_entries` 比较。
5. pi 进程内用 `navigateTree` 回到旧分支、不追加条目，比较此时的 `get_entries.leafId`、只读解析的叶子和 pi 重新打开后的叶子。

解析器按 pi 的规则实现：跳过空行和无法解析的行；最后一行没有换行符时仍尝试解析，能解析就保留；第一个能解析的条目必须是带字符串 `id` 的 session 头；条目列表不含 `type` 为 `session` 的行；叶子是文件中最后一个条目。解析器只调用 `readFileSync`。

### 通过标准

解析出的活动分支与 pi `get_entries` 加叶子计算的结果一致；解析前后文件哈希不变。

对标准的理解：

- v1 文件没有 id，pi 迁移时用 `randomUUID()` 生成，每次打开原文件得到的 id 都不同，只读解析无法重现。解析器改用由会话 id 和行号派生的确定性 id。v1 的比较把 id、`parentId`、`firstKeptEntryId` 换成条目在列表中的位置后再比较，叶子和活动分支同样按位置比较。
- 空文件和只有 session 头的文件，pi 打开时会先写入新条目（见“实测结果”）。这两种情况比较原文件对应的部分（原文件没有条目），pi 新写入的条目另外用“pi 写回后的副本”比较。
- “pi 加叶子计算的结果”指 pi 以 `--session` 重新打开该文件后 `get_entries` 返回的条目和 `leafId`。叶子不写入文件，pi 进程运行中的叶子可以不同于文件推导的叶子（第 5 步），所以结论限定为文件重新打开语义，不表示在线与离线的叶子在任何时刻都相同。

### 实测结果

13 个样本全部满足：两次解析结果相同，解析前后 sha256、大小、mtime 都不变；pi 能打开的 11 个样本，解析结果与 `get_entries` 一致；pi 拒绝打开的 2 个样本，解析器都判为无效；pi 写回后的副本与 `get_entries` 完全一致。

| 样本 | 解析结果 | pi `get_entries` | pi 对副本的改动 |
| --- | --- | --- | --- |
| v3 | 20 个条目，活动分支 8 个 | 相同 | 未改动 |
| v3，最后一行没有换行符 | 20 个条目 | 相同 | 在末尾追加 `"\n"` |
| v3，追加中途截断 | 20 个条目，截断行忽略 | 相同 | 在末尾追加 `"\n"` |
| v3，最后一个条目被截去一半 | 19 个条目，叶子为前一个条目 | 相同 | 在末尾追加 `"\n"` |
| v3，中间一行损坏 | 20 个条目，第 7 行记为损坏 | 相同 | 未改动 |
| v3，只有 session 头 | 0 个条目，叶子 `null` | 2 个条目（pi 新写入） | 追加 `model_change`、`thinking_level_change` |
| v2 | 21 个条目，`hookMessage` 迁移为 `custom` | 相同 | 重写为 v3（17030 → 17025 字节） |
| v1（无 `version`） | 17 个条目，线性 | 按位置相同；id 相同的 0/17 | 重写为 v3（15001 → 15653 字节） |
| v1（`version: 1`） | 17 个条目 | 按位置相同；id 相同的 0/17 | 重写为 v3 |
| v1，最后一行被截断 | 16 个条目 | 按位置相同 | 重写为 v3，截断行被丢弃 |
| 空文件 | `empty`，0 个条目 | 2 个条目（pi 新写入） | 写入新的 session 头和 2 个条目 |
| 只有空行 | `invalid` | pi 退出：`Session file is not a valid pi session` | 未改动 |
| 第一行不是 session 头 | `invalid` | pi 退出，同上 | 未改动 |

证据摘录（`evidence/session.json` 的 `variants[2]`，v3 追加中途截断）：

```json
"parsed": { "status": "ok", "version": 3, "entries": 20, "leafId": "d1109a48", "branch": 8,
  "diagnostics": { "size": 16923, "malformedLines": [], "tailWithoutNewline": true, "truncatedTail": true } },
"fingerprintBefore": { "sha256": "d095c0ae…727b", "size": 16923, "mtimeMs": 1793888616565.6096 },
"fingerprintAfter":  { "sha256": "d095c0ae…727b", "size": 16923, "mtimeMs": 1793888616565.6096 },
"pi": { "entries": 20, "leafId": "d1109a48" },
"piChange": "在末尾追加 \"\\n\"",
"postPi": { "entries": 20, "leafId": "d1109a48", "diagnostics": { "size": 16924, "malformedLines": [22] }, "matchesGetEntries": true }
```

进程内导航（`navigation`）：

```json
{ "liveLeafAfterNavigate": "5bfd0dee", "parsedLeaf": "d1109a48", "reopenedLeaf": "d1109a48" }
```

不带摘要的 `navigateTree` 不写文件；pi 内存中的叶子变为旧分支的末端，文件推导的叶子仍是最后一个条目。pi 重新打开后的叶子与只读解析相同。

### 结论

agora #10：通过（macOS，文件重新打开语义）。pane #8：通过（macOS，文件重新打开语义）。Windows、Linux 待测。

范围：只读解析的结果与 pi 重新打开同一文件时的 `get_entries` 和叶子一致，解析不改动文件。pi 进程运行中导航到别的分支、尚未追加条目时，在线 `leafId` 与离线解析的叶子不同（见“观察”），本结论不覆盖这种情况。

### 观察

- **pi 打开文件时会改写文件**，与 archive.md“只读 archive adapter”和 pi-pane architecture.md“只读查看历史会话”所述的原因一致，并且范围更大：除了空文件和旧版本迁移会重写，最后一行没有换行符（包括截断行）时 pi 会在末尾补一个换行；会话里没有模型信息时（只有 session 头、空文件）pi 打开时就写入 `model_change` 和 `thinking_level_change`。依据：`loadEntriesFromFile` 中的 `appendFileSync(resolvedFilePath, "\n")`。
- **截断行在恢复会话后留在文件中**：v3 文件有截断行时，pi 打开后在末尾补一个换行，截断行变成带换行但无法解析的一行（上面摘录中 `postPi` 的 `malformedLines: [22]`）；之后的条目用 `appendFileSync` 写在它后面，它留在文件中间。旧版本文件因为整体重写，截断行被丢弃。archive.md“完整性校验”第 1 条要求“每行都是可解析的 JSON”，进程中断后 `resume` 继续写入同一文件的会话（archive.md“继承关系”）会因此不满足这一条。
- **v1 文件的条目 id 不稳定**：只读解析给出的 id 与 pi 迁移后写入文件的 id 不同，pi 每次迁移生成的 id 也不同。archive.md“三种投影”的①写的是“带稳定的 entryId”；以 entryId 作游标的读取（`get_entries since`、历史分页）在 v1 文件被 pi 打开前后会失效。v2、v3 文件的 id 来自文件本身，不受影响。
- **在线与离线的叶子可能不同**：pi 进程内导航到别的分支而还没有追加条目时，`get_entries.leafId` 与从文件推导的叶子不同，直到追加下一个条目或进程重启。archive.md“三种投影”写的是在线和离线对同一函数输入不同来源，“返回的视图相同”；这种情况下两者不同。
- pi 拒绝打开的文件（只有空行、第一行不是 session 头）不会被改写，pi 以退出码 1 退出。

## pane #6：项目信任

### 验证内容

按 pi-pane architecture.md“项目信任”实现原型：

- 服务端预判：直接调用 pi 的 `hasTrustRequiringProjectResources(cwd)` 和 `new ProjectTrustStore(agentDir).get(cwd)`（`dist/core/trust-manager.js`，`dist/index.d.ts` 导出同名函数）。有需要信任的资源且没有保存的决定时，模拟用户在浏览器里作答，把 `{ cwd, trusted, remember }` 放进启动配置。
- pane-bridge 原型（`trust/pane-bridge-trust.ts`）：启动配置从文件读取，或在异步工厂函数里用 ticket 向本地 HTTP 服务兑换；`project_trust` 处理器把 `event.cwd` 与配置里的目录都做 `realpath` 后匹配，匹配上返回配置的决定；进程内切换到配置里没有的目录时 `POST /bridge/trust` 询问服务端，超时（测试中 1.5 秒，设计为 60 秒）、回连不可用时返回 `undecided`；在每次 `session_start` 记录 `ctx.isProjectTrusted()`。
- “实际加载”用两个效果判断：项目 `.pi/APPEND_SYSTEM.md` 的标记是否出现在发给 provider 的系统提示里；项目 `.pi/settings.json` 的 `defaultThinkingLevel: "low"` 是否体现在 `get_state.thinkingLevel`（全局默认为 `medium`）。
- 共 27 个场景，每个场景一个隔离现场，`trust.json` 只写在临时 agent 目录。

### 通过标准

会话视图显示的“已加载/未加载”在所有组合下都与实际一致。原型以 `session_start` 时的 `ctx.isProjectTrusted()` 作为会话视图显示的值（设计中 `bridgeReady` 报告的值）。

### 实测结果

所有场景中，`isProjectTrusted()`、`APPEND_SYSTEM.md` 是否进入系统提示、项目 `settings.json` 是否生效三者一致。每个场景的预判、下发的决定、处理器日志和 `trust.json` 前后内容见 `evidence/trust.json` 的 `scenarios`。

预判与 pi 的实际决定：

| 场景 | 预判 `hasResources` / `saved` | 实际加载 | `isProjectTrusted()` |
| --- | --- | --- | --- |
| A1 没有项目资源 | false / null | 无可加载 | true；未触发 `project_trust` |
| A2 没有项目资源，`trust.json` 中该目录为 false | false / false | 无可加载 | **false**；未触发 `project_trust` |
| A3 `trust.json` 中该目录为 true | true / true | 是 | true |
| A4 父目录为 true | true / true | 是 | true |
| A5 父目录 true、该目录 false | true / false | 否 | false |
| A6 父目录 false、该目录 true | true / true | 是 | true |
| A7 `trust.json` 的键是未解析符号链接的路径（`/var/…`，实际为 `/private/var/…`） | true / null | 否 | false |
| A8 只有祖先目录有 `.agents/skills`，用户答“不信任” | true / null | 无可观察的内容（实验带 `-ns`） | false；触发了 `project_trust` |

pane-bridge 返回决定：

| 场景 | 实际加载 | `trust.json` 变化 |
| --- | --- | --- |
| B1 yes，不记住 | 是 | 无 |
| B2 yes，记住 | 是 | 写入 `{"<realpath>": true}` |
| B3 no，记住 | 否 | 写入 `{"<realpath>": false}` |
| B4 no，不记住 | 否 | 无 |
| B5 更早的扩展返回 yes，pane 配置为 no | 是；pane 处理器未被调用 | 无 |
| B6 更早的扩展返回 no，pane 配置为 yes | 否；pane 处理器未被调用 | 无 |
| B7 更早的扩展抛出异常，pane 配置为 yes | 是；pane 处理器被调用 | 无 |
| B8 更早的扩展返回 undecided，pane 配置为 no | 否 | 无 |
| B9 `trust.json` 已有 yes，pane 仍返回 no（不记住） | 否 | 不变（仍为 yes） |

pane-bridge 返回 `undecided`：

| 场景 | 实际加载 |
| --- | --- |
| C1 `trust.json` 已有 yes（父目录） | 是 |
| C2 之后加载的扩展返回 yes | 是 |
| C3 `defaultProjectTrust: "always"` | 是 |
| C4 其他都没有决定（默认 `ask`，RPC 下无 UI） | 否 |
| C5 `defaultProjectTrust: "never"`，`trust.json` 有 yes | 是 |

进程内切换（扩展命令调用 `ctx.switchSession()` 打开一个 cwd 为另一个有资源目录的会话，再切回原会话）：

| 场景 | 服务端收到询问 | 切换后加载 | 切换后 `isProjectTrusted()` | 切回原会话 |
| --- | --- | --- | --- | --- |
| D1 服务端答 yes（不记住） | 1 次 | 是 | true | 不再触发 `project_trust`，沿用原决定 |
| D2 服务端不回应，1.5 秒后超时 | 1 次 | 否 | false | 同上 |
| D3 回连不可用 | 0 次 | 否 | false | 同上 |

处理器运行时机（场景 E2，由 `bridgeLog` 整理）：

```text
factory#1(exchanged=true,decisions=1) → project_trust#1 → session_start#1
project_trust: {"instance":1,"source":"startup-config","result":{"trusted":"yes","remember":false},"hasUI":false,"uiConfirm":false,"mode":"rpc"}
```

pi 等待异步工厂函数完成（`dist/core/extensions/loader.js` 的 `await factory(load.api)`），工厂函数里服务端延迟 300 ms 的兑换完成后，`project_trust` 处理器才运行并使用兑换得到的配置。启动时工厂函数只执行一次，`project_trust` 和 `session_start` 由同一个实例处理；每次进程内切换会话产生一个新实例。处理器上下文的 `hasUI` 为 false、`mode` 为 `rpc`，`ctx.ui.confirm()` 立即返回 false，与 pi-pane architecture.md 的描述一致。

### 结论

通过（macOS，浏览器询问界面未测）。Windows、Linux 待测。

### 观察

- **没有项目资源时不一定“直接通过”**：pi-pane architecture.md“项目信任”的决定顺序第 2 步写“目录里没有需要信任的项目资源时直接通过”。实际是 `trustStore.get(cwd) ?? true`（`dist/core/project-trust.js` 的 `resolveProjectTrusted`、`dist/main.js` 的 `createRuntime`）：`trust.json` 中该目录或其父目录为 false 时，`isProjectTrusted()` 为 false（场景 A2）。此时没有可加载的内容，但会话视图会显示“未加载”。
- **`event.cwd` 的形式不固定**：启动时 `event.cwd` 是 pi 进程的工作目录，macOS 上为解析后的 `/private/var/…`；进程内切换时是目标会话头里记录的 `cwd`，原样为 `/var/…`。服务端拉起时使用的路径是 `/var/…`。原型对两边都做 `realpath` 才能匹配。`trust.json` 的键由 pi 写成解析后的路径，读取时键本身不做解析，所以手写的未解析路径不会命中（A7），预判和 pi 在这一点上一致。
- **`ProjectTrustStore.get()` 有写操作**：读取前会 `mkdirSync` agent 目录并用 `proper-lockfile` 创建 `trust.json.lock`（`dist/core/trust-manager.js` 的 `acquireTrustLockSync`）。服务端预判时会在 agent 目录短暂创建锁目录。这一点来自源码，实验中未单独观测。
- **处理器等待期间会话切换被阻塞**：切换命令在 D1、D3 中耗时 24 ms、13 ms，在 D2 中耗时 1516 ms，即等到处理器 1.5 秒超时返回后才完成。设计的 60 秒超时意味着进程内切换到未知目录时，最长 60 秒内 pi 不处理该切换之后的工作。
- 同一进程内已解析过的目录不再触发 `project_trust`（`dist/main.js` 的 `projectTrustByCwd` 缓存），切回原会话时沿用之前的决定，即使之后 `trust.json` 改变也不重新询问。

## harness 使用情况

- 直接使用 `experiments/p0/harness/` 的 `createExperiment`、`readJsonl`，没有修改或复制 harness。
- harness 的 `RpcDriver.stop()` 先向负 PID 发 `SIGTERM`，再判断进程是否已退出；`e.stop()`、`e.cleanup()` 会对现场启动过的所有 driver 再调用一次。本组不调用 `e.stop()` 和 `e.cleanup()`：自己记录启动过的 driver，收尾时只对仍在运行的 driver 调用 `stop()`，再自己删除现场目录（`lib.mjs` 的 `stopDriver`、`teardownExperiment`）。`lib.mjs` 管理的其他子进程在已退出时也不再发信号。
- 其他使用中注意到的行为：现场的 `cwd` 位于 `os.tmpdir()`，macOS 上是符号链接 `/var/…`，pi 进程内看到的是 `/private/var/…`，比较路径时需要先解析。
- `node:sqlite` 实验不需要 pi，使用本目录的 `lib.mjs` 管理子进程。

## 未覆盖

- Windows、Linux：全部待测。
- 断电或操作系统崩溃下的数据库一致性：macOS 上无法用本实验验证。
- 检查点进行中被强杀：检查点没有单独的边界记录，只覆盖了启用检查点的压力场景。
- 会话文件中的 `context_edit` 和 `usage` 条目：没有用 pi 生成，解析器对它们不做特殊处理（按普通条目保留）。
- pane #6 中“浏览器询问”本身（浏览器界面、60 秒内无人作答）未实测，原型用测试代码的固定回答或不回应代替。
