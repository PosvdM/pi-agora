# 全量对话存档

> 切片 1d 实现任务会话的流片段、退出诊断、完整性校验、只读 archive adapter 和会话视图。board、会议及其存档查询保留接口，调用时返回 `unsupported`；不读取密封草稿。

agora 拉起的每个会话（子代理、参会者、书记）的完整对话都永久保存，以后可以查看。结束、取消、崩溃、换人都不会删除存档。

## 存什么

| 内容 | 来源 | 说明 |
| --- | --- | --- |
| 对话 | pi JSONL | pi 自己写的会话文件，含用户消息、助手消息、工具调用与结果、自定义消息、压缩记录（格式见 pi `docs/session-format.md`） |
| 未完成的流片段 | daemon 写 | 已经收到、但还没形成最终消息（没有 `message_end`）的流式增量 |
| 退出诊断 | daemon 写 | 每次进程退出的退出码、信号、最后的事件、进行中的工具调用、stderr 尾部 |
| 关系与元数据 | SQLite | 父子关系、召集人、任务、会议、继承关系、模型、档位、状态、校验结果 |

“完整”指 daemon 实际收到的消息和工具结果，不包括模型服务没有返回的内部推理。

主会话（终端或 pi-pane 托管）的对话由 pi 按自己的默认位置保存（依据：`docs/sessions.md`，默认 `~/.pi/agent/sessions/`），agora 只在 `principals` 表里记录它的会话文件路径，用于建立父子关系。

## 存在哪

```text
<AGORA_HOME>/sessions/<agoraSessionId>/
  session.jsonl            # pi 会话文件，路径由 daemon 预先分配，由 pi 写入
  partials/<runId>.jsonl   # 流片段
  runs/<runId>.json        # 含运行元数据和校验结果的退出诊断
  <runId>.diagnostics.json # driver 的原始退出诊断，兼容旧存档
```

- 每个协作会话启动时用 `--session <预先分配的路径>`，**不使用 `--no-session`**，保证 pi 落盘（依据：`docs/cli.md`；路径分配和写锁见 [architecture.md](architecture.md#启动参数)）。
- daemon 启动后用 RPC `get_state` 返回的 `sessionFile` 核对路径，写入 `agora_sessions.session_file`。会话文件要等第一条 user 或 assistant 消息出现后才创建（依据：`dist/core/session-manager.js` 的 `_persist`），协作会话的第一条消息就是任务书，所以就绪后很快落盘。
- `runId` 对应 `process_runs` 表的一行，同一会话每次拉起进程都是新的 run。

### 流片段

daemon 从 RPC 事件流里收到 `message_update` 增量（依据：`docs/json.md`，RPC 线上的 `message_update` 只带增量），按 `contentIndex` 缓存当前正在生成的消息：

- 每秒最多一次，把缓存追加写入 `partials/<runId>.jsonl`，每行保留块类型：

  ```json
  { "runId": "pr_51d0", "t": "2026-11-05T08:41:03Z", "messageSeq": 7, "contentIndex": 1, "blockType": "toolCall", "toolCallId": "call_abc", "toolName": "bash", "delta": "{\"command\":\"npm te" }
  ```

  `blockType` 为 `thinking`、`text` 或 `toolCall`；`toolCall` 块的开始行带 `toolCallId` 和 `toolName`。
- **只在最终消息确认已写入会话文件后才关闭片段**：收到 `message_end` 时不关闭（pi 先发 `message_end` 再写文件，依据：`dist/core/agent-session.js:760–779`）；daemon 用 `get_entries` 取到这条消息对应的 entryId，并在会话文件里读到该 entryId 的完整一行后，才追加一行 `{ "messageSeq": n, "closed": true, "entryId": "…" }`。`get_entries` 返回的条目不一定已写入文件（新会话在第一条对话消息之前只在内存里），所以不能只看它。最终内容以 pi JSONL 为准，片段只用于还原没写完的部分。
- `message_end` 写入 `{ messageSeq, ended: true, message }` 匹配行。块结束的权威内容用 `replace: true` 行替换增量，并保存 `done`、工具参数及元数据。读取时只在完整最终消息与会话条目逐字段相符时去重；同角色、同时间戳但正文不同的消息不能互相替代。
- 进程退出后，未关闭且没有对应磁盘最终消息的片段按运行、消息和 `contentIndex` 重建，在对话末尾显示为“中断时正在生成的内容”。`projectPartials` 返回与会话快照相同的块结构；活跃助手和等待条目确认的完整消息由 `inFlight` 展示，不重复列为中断片段。未确认停止时继续接收迟到流，确认退出后才退订。

### 退出诊断

`runs/<runId>.json`：

```json
{
  "runId": "pr_51d0",
  "agoraSessionId": "as_c21e",
  "pid": 12345,
  "startedAt": "2026-11-05T08:00:00Z",
  "exitedAt": "2026-11-05T08:42:10Z",
  "exitCode": null,
  "signal": "SIGKILL",
  "reason": "heartbeat_timeout",
  "lastConfirmedAction": { "type": "tool_execution_end", "toolCallId": "call_edit", "toolName": "edit", "isError": false },
  "inFlightTools": [{ "toolCallId": "call_bash", "toolName": "bash", "argsSummary": "npm test", "startedAt": "2026-11-05T08:41:05Z" }],
  "possibleSideEffects": [{ "toolCallId": "call_bash", "toolName": "bash", "argsSummary": "npm test", "startedAt": "2026-11-05T08:41:05Z" }],
  "lastEvents": [{ "type": "agent_start" }],
  "stderrTail": "…最后 8 KiB…"
}
```

正常退出也写诊断，回收、停止、daemon 关闭的 `reason` 分别为 `idle_reclaim`、`stopped`、`daemon_shutdown`。文件同时保留 driver 的原始字段、归档 I/O 诊断及本次校验结果；`lastEvents` 最多 50 条，每条最多保留约 16 KiB，`stderrTail` 为最后 8 KiB。

## 三种投影

| 投影 | 内容 | 用途 |
| --- | --- | --- |
| ① 原始存档 | 会话文件中的全部条目（含废弃分支和自定义条目；v2/v3 具有稳定 entryId，v1 因缺 id 在解析时派生，不可作为跨进程的持久键） | 完整性校验、导出 |
| ② 用户聊天视图 | 从当前叶子沿 `parentId` 回到根的整条活动分支，包括压缩前的内容；压缩条目作为分隔标记保留 | 会话查看（CLI、pi-pane） |
| ③ 模型当前上下文 | 压缩和 context edit 之后实际发给模型的消息 | 诊断 |

`packages/archive` 的 `projectUserView(entries, leafId)` 输出从根到叶子的完整活动分支，保持迁移后的 pi 条目形状，包含压缩前的历史。在线使用 `get_entries` 的 `leafId`；只读文件按 pi 重新打开语义取最后一个非 session 条目。协作会话不支持分支导航，检测到叶子移到另一分支时发 `resync`。v1 的派生 ID 只能在同一未变内容快照内使用，跨读取器比较时按条目位置规范化，不能持久保存。接口见 [integration.md](integration.md#会话视图)。

## 继承关系

重开和换人都产生**新会话**，原会话保持不变：

| 字段 | 含义 |
| --- | --- |
| `inherits_from` | 原会话的 agoraSessionId |
| `inherit_reason` | `reopen`（同配置重开）、`replace`（换模型或档位）、`seat-replace`（会议换人） |

恢复（`resume`）不产生新会话：同一会话文件继续追加，新增一个 run。

查看器按 `inherits_from` 把一串会话显示为同一个任务或席位的前后几段。

## 完整性校验

消息数不能证明存档完整：数字对得上不代表内容都落盘了。daemon 在以下时机校验：

- 每次 run 结束（含回收、停止、崩溃）；
- 会话进入终态（任务 completed / failed / stopped，席位结束）；
- 用户运行 `agora verify-archive [sessionId]`。

校验内容：

1. 会话文件存在。尾部及中间补换行留下的合法 JSON 前缀跳过并诊断，结果为 `partial`，不直接判为 `suspect`。真正的 JSON 语法损坏、无效编码、头部或不支持的版本判为 `suspect`。
2. 文件里的消息条目数 ≥ daemon 在该会话所有 run 中观察到的最终消息数。`archive_observed_messages` 按完整消息摘要去重，不把同一消息的重复事件或恢复重发重复计数。
3. daemon 记录的最后一条 `message_end` 消息（角色 + 时间戳）能在文件里找到。
4. 计算文件 SHA-256 与字节数。可信结果写入 `agora_sessions.archive_hash`、`archive_bytes` 和 `archive_verified_at`；纯追加时核对旧字节范围的前缀哈希。`suspect` 或 `missing` 不覆盖最后一次可信基线，重复校验不能把改写后的内容变成正常。

`ArchiveReaderV1.verifySession(id)` 以只读方式使用相同的消息观察和前缀基线；daemon 在其结果上更新状态，离线 CLI 只返回结果，不写数据库。v4/v5 或迁移前的历史没有完整观察证据时，只检查已有证据。`verifySessionFile(file, expected?)` 是文件级检查入口，调用方没有提供的消息或旧哈希证据不能凭空推导。

结果写入 `agora_sessions.archive_state`：

| 值 | 含义 |
| --- | --- |
| `ok` | 校验通过 |
| `partial` | 有未完成的流片段、空会话或截断行；旧的 `live` 元数据在未校验时也保守显示为此状态 |
| `suspect` | 条数不足、最后一条消息找不到、或前缀被改动 |
| `missing` | 会话文件不存在 |

`suspect` 和 `missing` 会给召集人和用户发通知。

## 保留策略

- daemon 从不自动删除会话目录或会话文件。
- 用户删除存档必须显式执行 `agora archive delete <sessionId> --offline`。在线删除属于用户级操作，在签名确认通路接入前拒绝执行，不能凭主机凭证绕过。离线维护同时持有 daemon 实例锁与会话写锁，要求终态、全部 run 明确退出、旧写者已释放，以及真实目录和普通文件检查全部通过；不会停止未知写者，也不使用 `assumeNoWriter`。
- 删除后 `archive_state = missing`，SQLite 元数据保留，树节点仍然列出，`availability` 为 `missing`，发布 `upsert`，不是 tombstone。文件缺失、锁证明不足、状态不明或路径包含链接时保守拒绝删除。用户级目标见 [security.md](security.md#用户确认)，树映射见 [integration.md](integration.md#同步与按需加载)。
- 存档占用的磁盘空间在 `agora status` 里显示。

## 读取权限

| 读者 | 能读什么 |
| --- | --- |
| CLI、pi-pane 插件（`host:cli`、`host:pane`） | 全部存档 |
| 召集人（Agent） | 自己召集的任务和会议下所有会话；会议进行中的参会者对话除外，会议结束后可读 |
| 参会者、书记 | 不能读其他会话的对话，只能读 board 公开条目 |
| 子代理 | 不能读其他会话的对话 |

MVP 中 Agent 读存档只通过 `agora_task result` 和会议纪要，不提供读取完整对话的工具（避免把大量历史塞回主代理上下文）。

## 只读 archive adapter

`packages/archive` 是一个版本化的只读库，供 CLI 和 pi-pane 插件在 daemon 不运行时读取存档。daemon 在线时客户端优先走 HTTP API（见 [integration.md](integration.md#离线存档读取)），两者返回相同的数据结构。

```ts
export function openArchive(opts: { home?: string; apiVersion: 1 }): Promise<ArchiveReaderV1>;

export interface ArchiveReaderV1 {
  readonly apiVersion: 1;
  readonly schemaVersion: number;          // 底层数据库版本，仅供诊断
  listSessions(q?: { convenerId?: string; meetingId?: string; taskId?: string; limit?: number; cursor?: string })
    : Promise<Page<ArchivedSessionSummary>>;
  getSession(agoraSessionId: string): Promise<ArchivedSession | undefined>;
  readUserView(agoraSessionId: string, q?: { before?: string; limit?: number })   // ②，从叶子往回分页
    : Promise<{ leafId: string | null; entries: SessionEntry[]; historyBefore: string | null }>;
  readRawEntries(agoraSessionId: string, q?: { cursor?: string; limit?: number }): Promise<Page<SessionEntry>>; // ①
  readPartials(agoraSessionId: string): Promise<PartialFragment[]>;
  readDiagnostics(agoraSessionId: string): Promise<RunDiagnostics[]>;
  verifySession(agoraSessionId: string): Promise<VerificationResult>; // 只读检查，不更新数据库
  listBoardEntries(boardId: string, q?: { afterSeq?: number; limit?: number }): Promise<Page<BoardEntry>>;
  getMeeting(meetingId: string): Promise<MeetingSummary | undefined>;
  close(): void;
}

export interface ArchivedSessionSummary {
  agoraSessionId: string;
  kind: "task" | "meeting-seat" | "secretary";
  title: string;
  model: string;
  profile: "explore" | "review" | "implement";
  convenerId: string;
  parent?: { kind: "task"; taskId: string; sessionId: string }
    | { kind: "main"; piSessionId: string } | { kind: "user" };
  parentDiagnostics?: { kind: string; message: string }[];
  isCurrent?: boolean;         // 当前任务所指向的会话
  usage?: UsageSummary;        // 本会话的累计请求与最近已知上下文
  parentPiSessionId?: string;   // 召集人是主会话时，对应 pi 的 sessionId
  taskId?: string;
  meetingId?: string;
  status: string;
  archiveState: "ok" | "partial" | "suspect" | "missing";
  messageCount?: number;        // 最终消息数，未知时省略
  inheritsFrom?: string;
  inheritReason?: string;
  createdAt: string;
  endedAt?: string;
}

export interface Page<T> { items: T[]; nextCursor?: string }
```

实现约束：

- 用 `node:sqlite` 以只读方式打开 `agora.db`（`readOnly` 选项，Node 24；daemon 同时在写时依赖 WAL 的读写并发）。注意：以只读方式打开 WAL 数据库时同样会尝试创建或读写 `-wal` 和 `-shm` 文件，因此数据库所在目录（`AGORA_HOME`）必须可写，否则打开失败。
- **会话文件只读解析**：`packages/harness-pi` 按 pi 的 JSONL 格式（`docs/session-format.md`）自行解析，旧版本格式在内存里迁移，绝不写回。不用 pi 导出的 `SessionManager.open()`：它在文件为空或需要从旧格式迁移时会调用 `_rewriteFile()` 重写文件（依据：`dist/core/session-manager.js:666–727`）。末尾未写完的截断行或中间补换行留下的不完整行直接跳过并记录，不当成损坏。解析结果的条目保持 pi `SessionEntry` 的原始形状。
- **条目键与叶子节点**：v1 条目 ID 在读取时临时生成，不具备跨读取器的稳定性。同一 reader 仅在文件指纹不变时复用快照以支持分页；文件内容变化后旧水位无效，需要重新取快照。v2/v3 保留文件 ID，文件叶子取最后一个非 session 条目。
- **关系与分页**：`parent` 只包含领域标识，子任务的 `sessionId` 指向父任务当前会话，不使用任何查看器节点格式；主会话标识缺失时省略并附诊断。会话列表按创建时间和 ID 倒序，游标绑定筛选条件；每页默认 50、上限 200。`getSession` 额外返回经真实路径检查的 `sessionFile`，列表不返回路径。
- 只接受 `AGORA_HOME` 下的路径：从数据库读出的 `session_file` 先做真实路径解析，不在数据目录内的拒绝读取。
- adapter 不暴露 SQLite 表结构。数据库迁移时同步更新 adapter；`apiVersion` 只在返回结构不兼容时递增，旧版本保留至少一个大版本。
- 不读取、不返回密封草稿。
- `listBoardEntries`、`getMeeting` 保留为明确失败的占位接口，当前调用返回 `unsupported`，不伪造空结果。
- `test/archive-parser-pi-1d.test.mjs` 用真实 pi 1.5.0 重新打开副本，核对 v1/v2/v3、分支和截断文件的条目与叶子；原文件哈希始终不变。`archive-e2e-1d.test.mjs` 验证真实流中途强杀后的三类块、退出诊断和完整落盘后的去重。
