# G 组 P0 实验结果：存储与只读解析

本组验证 pi-agora `docs/roadmap.md` 的 P0 第 9、10 项，以及 pi-pane `docs/roadmap.md` 的 P0 第 6、8 项。agora #10 与 pane #8 是同一类验证，共用一套实验。

## 结论汇总

| 项 | 内容 | macOS | Windows | Linux |
| --- | --- | --- | --- | --- |
| agora #9 | `node:sqlite`：WAL 读写并发、事务、强杀后一致性、`backup()` | 通过 | 待测 | 待测 |
| agora #10 | 会话文件只读解析（各版本、空文件、截断） | 通过 | 待测 | 待测 |
| pane #6 | 项目信任：预判、`project_trust` 处理器、`isProjectTrusted()` | 通过 | 待测 | 待测 |
| pane #8 | 会话文件只读解析（v1、v2、v3、截断） | 通过 | 待测 | 待测 |

“通过”只针对下文列出的场景和对通过标准的理解。各项还记录了与设计文档描述不完全一致的实际行为，见每项的“观察”。断电（操作系统崩溃）造成的不一致在 macOS 上无法用本实验验证，见 agora #9。

## 环境与重跑

- macOS 27.0.1（arm64），Node v26.12.0，`node:sqlite` 内置 SQLite 3.54.1，pi 1.5.0（`/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent`，`pi` 命令指向 `dist/bundle/cli.js`）。
- 实验在 2026-11-05 运行。下文的次数、耗时和 id 来自当天的运行日志，每次运行会有差异。所有 pi 进程都通过 `experiments/p0/harness/` 的假 provider 运行，不调用模型服务，不联网。
- 每个现场都是临时目录，`HOME`、`PI_CODING_AGENT_DIR`、会话目录和 `trust.json` 都在其中。测试通过后删除现场，失败时保留并在输出中打印 `fixture:` 路径。

在仓库根目录执行：

```sh
node --test "experiments/p0/g-store/*.test.mjs"
```

本机一次完整运行约 41 秒，52 个测试全部通过。可以单独运行某个文件，例如 `node --test experiments/p0/g-store/sqlite.test.mjs`。

| 环境变量 | 作用 | 默认 |
| --- | --- | --- |
| `P0_KEEP=1` | 测试通过时也保留现场 | 不保留 |
| `P0_CRASH_ITERATIONS` | 强杀实验的次数 | 24 |
| `P0_BACKUP_TIMEOUT_MS` | 备份实验等待完成的时长 | 20000 |
| `P0_PI_ROOT` | pi 安装目录（读取 `trust-manager.js`） | 上面的 Homebrew 路径 |

脚本只依赖 Node 内置模块和共用 harness。子进程用独立进程组启动，按进程组终止；路径用 `node:path` 拼接。Windows 上没有进程组，`lib.mjs` 改为终止单个进程，未实际运行过。

## 文件

| 路径 | 内容 |
| --- | --- |
| `sqlite.test.mjs` | agora #9 |
| `sqlite/writer.mjs` | 模拟 daemon 的写者：每个事务更新 `tasks.revision`，并写入同样行数的 `outbox` 和 `changes` |
| `sqlite/reader.mjs` | 模拟 archive adapter：`readOnly` 打开，反复读并检查事务原子性 |
| `sqlite/backup-run.mjs` | 调用 `backup()`，记录进度和重新开始的次数 |
| `sqlite/check.mjs` | `PRAGMA integrity_check` 加事务不变量检查 |
| `session.test.mjs` | agora #10、pane #8 |
| `session/parser.mjs` | 只读解析器原型与活动分支投影 |
| `session/generate.mjs`、`session/gen-ext.ts` | 用 pi 生成 v3 会话文件的驱动脚本和测试扩展 |
| `trust.test.mjs` | pane #6 |
| `trust/pane-bridge-trust.ts` | pane-bridge 的 `project_trust` 处理器原型 |
| `trust/early-trust.ts`、`trust/late-trust.ts` | 排在 pane-bridge 之前、之后的其他 `project_trust` 处理器 |
| `lib.mjs` | 子进程管理、临时目录、哈希 |

## agora #9：node:sqlite

### 验证内容

- WAL 模式下一个写者进程持续写入，两个读者进程用 `readOnly: true` 打开并持续读取。
- 每个写者事务在 `BEGIN IMMEDIATE … COMMIT` 内同时更新 `tasks`、写入 `outbox` 和 `changes`。读者在单条语句和显式读事务两种方式下检查三者是否始终一致。
- 写者进程被 `SIGKILL` 强杀 24 次，覆盖小事务、单个事务 2 万行（强杀大概率落在事务中）、每个事务后执行 `PRAGMA wal_checkpoint(TRUNCATE)` 几种情况。强杀后先以 `readOnly` 打开（daemon 尚未重启时的 adapter），再以读写方式打开（daemon 重启），都执行 `PRAGMA integrity_check` 和不变量检查。
- `backup()` 在写入进行中：独立连接备份、另一进程写入；同一连接备份、本进程在备份期间写入。备份以 `readOnly` 打开后执行 `integrity_check` 和不变量检查。数据库预先填充 32 MiB，备份约 8200 页。
- daemon 未运行时 adapter 以 `readOnly` 打开数据库。

### 通过标准

并发读写无错误；崩溃后数据一致；备份可打开且校验通过。

### 实测结果

基本信息：新建连接的 `synchronous` 为 2（FULL），`busy_timeout` 为 0；`readOnly` 连接写入时报 `ERR_SQLITE_ERROR errcode=8 attempt to write a readonly database`。写者和读者的 stderr 为空，Node 26 使用 `node:sqlite` 时没有输出实验性警告。

并发读写，每种配置运行 3 秒：

| 配置 | 写者提交 | 每个读者的读取次数 | 违反不变量 | 错误 |
| --- | --- | --- | --- | --- |
| 读者 busy timeout 0，写者每 20 个事务 TRUNCATE 检查点 | 1120 | 5453、5441 | 0 | 无 |
| 读者 busy timeout 0，只有自动检查点 | 26706 | 188、192 | 0 | 无 |
| 读者 busy timeout 5000，写者每 20 个事务 TRUNCATE 检查点 | 940 | 6950、6957 | 0 | 无 |

```text
读者: {"reads":5453,"txReads":5453,"violations":[],"errors":{},"openError":null,"maxTx":1120}
结束后校验: {"integrity":["ok"],"journalMode":"wal","revision":1120,"maxTx":1120,"problems":[]}
```

强杀：24 次中 22 次落在 `BEGIN` 与 `COMMIT` 之间，2 次落在事务之间。每次 `readOnly` 和读写打开的结果相同，`integrity_check` 都是 `ok`，没有部分写入的事务，已确认提交（写者在 `COMMIT` 返回后同步输出）的事务没有丢失，未提交的事务不可见。

```text
#2 rows=20000 ckpt=0 lastBegin=2 lastAcked=1 ro.maxTx=1 rw.maxTx=1 ro.problems=0 rw.problems=0
#5 rows=1 ckpt=5 lastBegin=2032 lastAcked=2031 ro.maxTx=2032 rw.maxTx=2032 ro.problems=0 rw.problems=0
汇总: {"midTx":22,"betweenTx":2,"beforeFirstBegin":0,"ackedLost":0,"uncommittedVisible":0}
```

`#5` 中 `maxTx` 比 `lastAcked` 大 1：事务已提交，写者在输出确认前被杀，属于允许范围。

`backup()`：

| 配置 | 结果 |
| --- | --- |
| 同一连接，备份期间本进程每 1 ms 写一个事务，`rate` 50 | 62 ms 完成；期间写入的 52 个事务包含在备份中；校验 `ok` |
| 独立连接，另一进程每 50 ms 写一个事务，`rate` 100 | 58 ms 完成，重新开始 1 次；校验 `ok` |
| 独立连接，另一进程连续写，`rate` 1000000（一步复制全部页） | 66 ms 完成；校验 `ok` |
| 独立连接，另一进程每 2 ms 写一个事务，`rate` 100 | 20 秒内未完成，重新开始 7690 次 |

```text
backup: {"mode":"own","rate":100,"progressCalls":91941,"pages":null,"ms":19899,"error":"terminated before completion","restarts":7690,"lastProgress":{"totalPages":8863,"remainingPages":8063}}; 另一进程在此期间提交: 7730
```

`rate` 必须是正整数，传 -1 时 `backup()` 抛出 `ERR_OUT_OF_RANGE`。

daemon 未运行时：写者正常关闭后目录里只有 `agora.db`；`readOnly` 打开并读取后，目录里出现 `agora.db-shm` 和 `agora.db-wal`。把数据库移到不可写的目录（`chmod 555`）后，`readOnly` 打开读取失败：

```text
打开或读取失败：ERR_SQLITE_ERROR errcode=1544 attempt to write a readonly database
```

### 结论

通过（macOS，进程崩溃）。Windows、Linux 待测。

断电或操作系统崩溃时，未落盘的页缓存会丢失，这与进程被强杀不同。macOS 上无法用本实验验证这一部分；roadmap“必须测试的故障”中的“数据库在事务中断电”仍未覆盖。

### 观察

- **独立连接的备份会被其他连接的写入打断**：源库被另一个连接修改后，SQLite 在线备份从头开始。写入间隔短于整个备份所需时间时，备份一直无法完成。同一连接上的写入不会打断备份，并会同步到备份中；一步复制全部页（`rate` 大于总页数）时备份持有读快照，也能完成。architecture.md“升级”第 1 步只写了使用 `backup()`，没有规定用哪个连接。
- **`readOnly` 打开 WAL 数据库会创建 `-wal` 和 `-shm` 文件**，目录不可写时打开失败。archive.md“只读 archive adapter”的 adapter 在 daemon 未运行时以 `readOnly` 打开 `agora.db`，因此需要对 `AGORA_HOME` 有写权限。
- **WAL 无法回卷时读取变慢**：只有自动检查点时，读者一直持有读快照，WAL 无法重置，3 秒内增长到约 2.6 万个事务，读者每 3 秒只完成约 190 次读取（另两种配置约 5500–7000 次）。没有出现错误。
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

日志摘录：

日志摘录（v3 追加中途截断，同一轮运行；id 每次运行都不同）：

```text
解析: status=ok version=3 entries=20 leaf=ccb62c75 branch=8 diagnostics={"size":16923,"malformedLines":[],"tailWithoutNewline":true,"truncatedTail":true,"migratedFrom":null}
解析前后 sha256=65c8d4226ddedaf4… 相同=true mtime 相同=true
pi get_entries: entries=20 leafId=ccb62c75 sessionFile 相同=true
pi 对副本的改动: 在末尾追加 "\n"
原文件一致：条目 20 个，leaf ccb62c75，活动分支 8 个（model_change → thinking_level_change → system → user → assistant → branch_summary → user → assistant）
pi 写回后的副本：version=3 条目 20 个，leaf ccb62c75，与 get_entries 完全一致；diagnostics={"size":16924,"malformedLines":[22],"tailWithoutNewline":false,"truncatedTail":false,"migratedFrom":null}
```

进程内导航（同一轮）：

```text
导航后 pi 内存中的 leafId=a7b14aef；只读解析 leafId=ccb62c75；pi 重新打开后 leafId=ccb62c75
```

不带摘要的 `navigateTree` 不写文件；pi 内存中的叶子变为旧分支的末端，文件推导的叶子仍是最后一个条目。pi 重新打开后的叶子与只读解析相同。

### 结论

agora #10：通过（macOS）。pane #8：通过（macOS）。Windows、Linux 待测。

### 观察

- **pi 打开文件时会改写文件**，与 archive.md“只读 archive adapter”和 pi-pane architecture.md“只读查看历史会话”所述的原因一致，并且范围更大：除了空文件和旧版本迁移会重写，最后一行没有换行符（包括截断行）时 pi 会在末尾补一个换行；会话里没有模型信息时（只有 session 头、空文件）pi 打开时就写入 `model_change` 和 `thinking_level_change`。依据：`loadEntriesFromFile` 中的 `appendFileSync(resolvedFilePath, "\n")`。
- **截断行在恢复会话后留在文件中**：v3 文件有截断行时，pi 打开后在末尾补一个换行，截断行变成带换行但无法解析的一行（上面摘录中 pi 写回后的副本 `malformedLines: [22]`）；之后的条目用 `appendFileSync` 写在它后面，它留在文件中间。旧版本文件因为整体重写，截断行被丢弃。archive.md“完整性校验”第 1 条要求“每行都是可解析的 JSON”，进程中断后 `resume` 继续写入同一文件的会话（archive.md“继承关系”）会因此不满足这一条。
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

所有场景中，`isProjectTrusted()`、`APPEND_SYSTEM.md` 是否进入系统提示、项目 `settings.json` 是否生效三者一致。

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

处理器运行时机：

```text
事件顺序: factory#1(exchanged=true,decisions=1) → project_trust#1 → session_start#1
服务端收到: [{"url":"/exchange","body":{"ticket":"ticket-1"}}]
pane 处理器调用: [{"instance":1,"source":"startup-config","r":{"trusted":"yes","remember":false},"hasUI":false,"uiConfirm":false,"mode":"rpc"}]
```

pi 等待异步工厂函数完成（`dist/core/extensions/loader.js` 的 `await factory(load.api)`），工厂函数里服务端延迟 300 ms 的兑换完成后，`project_trust` 处理器才运行并使用兑换得到的配置。启动时工厂函数只执行一次，`project_trust` 和 `session_start` 由同一个实例处理；每次进程内切换会话产生一个新实例。处理器上下文的 `hasUI` 为 false、`mode` 为 `rpc`，`ctx.ui.confirm()` 立即返回 false，与 pi-pane architecture.md 的描述一致。

### 结论

通过（macOS）。Windows、Linux 待测。

### 观察

- **没有项目资源时不一定“直接通过”**：pi-pane architecture.md“项目信任”的决定顺序第 2 步写“目录里没有需要信任的项目资源时直接通过”。实际是 `trustStore.get(cwd) ?? true`（`dist/core/project-trust.js` 的 `resolveProjectTrusted`、`dist/main.js` 的 `createRuntime`）：`trust.json` 中该目录或其父目录为 false 时，`isProjectTrusted()` 为 false（场景 A2）。此时没有可加载的内容，但会话视图会显示“未加载”。
- **`event.cwd` 的形式不固定**：启动时 `event.cwd` 是 pi 进程的工作目录，macOS 上为解析后的 `/private/var/…`；进程内切换时是目标会话头里记录的 `cwd`，原样为 `/var/…`。服务端拉起时使用的路径是 `/var/…`。原型对两边都做 `realpath` 才能匹配。`trust.json` 的键由 pi 写成解析后的路径，读取时键本身不做解析，所以手写的未解析路径不会命中（A7），预判和 pi 在这一点上一致。
- **`ProjectTrustStore.get()` 有写操作**：读取前会 `mkdirSync` agent 目录并用 `proper-lockfile` 创建 `trust.json.lock`（`dist/core/trust-manager.js` 的 `acquireTrustLockSync`）。服务端预判时会在 agent 目录短暂创建锁目录。这一点来自源码，实验中未单独观测。
- **处理器等待期间会话切换被阻塞**：切换命令在 D1、D3 中耗时 24 ms、12 ms，在 D2 中耗时 1540 ms，即等到处理器 1.5 秒超时返回后才完成。设计的 60 秒超时意味着进程内切换到未知目录时，最长 60 秒内 pi 不处理该切换之后的工作。
- 同一进程内已解析过的目录不再触发 `project_trust`（`dist/main.js` 的 `projectTrustByCwd` 缓存），切回原会话时沿用之前的决定，即使之后 `trust.json` 改变也不重新询问。

## harness 使用情况

- 直接使用 `experiments/p0/harness/` 的 `createExperiment`、`readJsonl`，没有修改或复制 harness。
- 未发现 harness 的问题。使用中注意到的行为：现场的 `cwd` 位于 `os.tmpdir()`，macOS 上是符号链接 `/var/…`，pi 进程内看到的是 `/private/var/…`，比较路径时需要先解析。
- `node:sqlite` 实验不需要 pi，使用本目录的 `lib.mjs` 管理子进程。

## 未覆盖

- Windows、Linux：全部待测。
- 断电或操作系统崩溃下的数据库一致性：macOS 上无法用本实验验证。
- 会话文件中的 `context_edit` 和 `usage` 条目：没有用 pi 生成，解析器对它们不做特殊处理（按普通条目保留）。
- pane #6 中“浏览器询问”本身（浏览器界面、60 秒内无人作答）未实测，原型用测试代码的固定回答或不回应代替。
