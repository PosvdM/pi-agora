# 全量对话存档

> 状态：设计草案。目录结构、校验规则和 adapter 接口是草案，P0 验证后冻结。

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
  <pi 会话文件>.jsonl       # 由 pi 写入；实际路径以 get_state 返回的 sessionFile 为准
  partials/<runId>.jsonl   # 流片段
  runs/<runId>.json        # 退出诊断
```

- 每个协作会话启动时显式指定 `--session-dir` 和 `--session-id`，**不使用 `--no-session`**，保证 pi 落盘（依据：`docs/cli.md`）。
- `--session-dir` 下的文件布局**未核实**（可能按 cwd 再分一层目录）。daemon 不推断路径，以 RPC `get_state` 返回的 `sessionFile` 为准写入 `agora_sessions.session_file`。
- `runId` 对应 `process_runs` 表的一行，同一会话每次拉起进程都是新的 run。

### 流片段

daemon 从 RPC 事件流里收到 `message_update` 增量（依据：`docs/json.md`，RPC 线上的 `message_update` 只带增量），按 `contentIndex` 缓存当前正在生成的消息：

- 每秒最多一次，把缓存追加写入 `partials/<runId>.jsonl`：`{ "t": 时间, "messageSeq": n, "contentIndex": i, "delta": "..." }`。
- 收到该消息的 `message_end` 后追加一行 `{ "messageSeq": n, "closed": true }`。最终内容以 pi JSONL 为准，片段只用于还原没写完的部分。
- 进程异常退出时，没有 `closed` 标记的片段就是“未完成的流片段”，查看器在对话末尾单独显示为“中断时正在生成的内容”。

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
  "lastConfirmedAction": { "type": "tool_execution_end", "tool": "edit", "at": "2026-11-05T08:41:02Z" },
  "inFlightTools": [{ "tool": "bash", "argsSummary": "npm test", "startedAt": "2026-11-05T08:41:05Z" }],
  "possibleSideEffects": ["bash: npm test 可能已部分执行"],
  "lastEvents": ["…最后 50 条事件的摘要…"],
  "stderrTail": "…最后 8 KiB…"
}
```

正常退出（回收、停止）也写诊断，`reason` 分别为 `idle_reclaim`、`stopped`。

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

1. 会话文件存在、每行都是可解析的 JSON。
2. 文件里的消息条目数 ≥ daemon 在该会话所有 run 中观察到的 `message_end` 次数（自定义消息和压缩会引起差异，比较规则在 P0 按实际文件确定）。
3. daemon 记录的最后一条 `message_end` 消息（角色 + 时间戳）能在文件里找到。
4. 计算文件 sha256，写入 `agora_sessions.archive_hash`。之后再校验时哈希变化而文件只是追加（前缀不变）视为正常，前缀变化视为被改动。

结果写入 `agora_sessions.archive_state`：

| 值 | 含义 |
| --- | --- |
| `ok` | 校验通过 |
| `partial` | 文件完整，但有未完成的流片段（进程中断） |
| `suspect` | 条数不足、最后一条消息找不到、或前缀被改动 |
| `missing` | 会话文件不存在 |

`suspect` 和 `missing` 会给召集人和用户发通知。

## 保留策略

- daemon 从不自动删除会话目录或会话文件。
- 用户删除存档只能显式执行 `agora archive delete <sessionId>`，需二次确认；删除后 `archive_state = missing`，SQLite 中的元数据保留，树中显示为“缺失”。
- 存档占用的磁盘空间在 `agora status` 里显示。

## 读取权限

| 读者 | 能读什么 |
| --- | --- |
| user principal（CLI、pi-pane 插件） | 全部存档 |
| 召集人（Agent） | 自己召集的任务和会议下所有会话；会议进行中的参会者对话除外，会议结束后可读 |
| 参会者、书记 | 不能读其他会话的对话，只能读 board 公开条目 |
| 子代理 | 不能读其他会话的对话 |

MVP 中 Agent 读存档只通过 `agora_task result` 和会议纪要，不提供读取完整对话的工具（避免把大量历史塞回主代理上下文）。

## 只读 archive adapter

`packages/archive` 是一个版本化的只读库，供 CLI 和 pi-pane 插件在 daemon 不运行时读取存档。daemon 在线时客户端优先走 HTTP API（见 [integration.md](integration.md#离线存档读取)），两者返回相同的数据结构。

```ts
// 草案，P0 后冻结
export function openArchive(opts: { home?: string; apiVersion: 1 }): Promise<ArchiveReaderV1>;

export interface ArchiveReaderV1 {
  readonly apiVersion: 1;
  readonly schemaVersion: number;          // 底层数据库版本，仅供诊断
  listSessions(q?: { convenerId?: string; meetingId?: string; taskId?: string; limit?: number; cursor?: string })
    : Promise<Page<ArchivedSessionSummary>>;
  getSession(agoraSessionId: string): Promise<ArchivedSession | undefined>;
  readMessages(agoraSessionId: string, q?: { cursor?: string; limit?: number }): Promise<Page<ArchivedMessage>>;
  readPartials(agoraSessionId: string): Promise<PartialFragment[]>;
  readDiagnostics(agoraSessionId: string): Promise<RunDiagnostics[]>;
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
  parentPiSessionId?: string;   // 召集人是主会话时，对应 pi 的 sessionId
  taskId?: string;
  meetingId?: string;
  status: string;
  archiveState: "ok" | "partial" | "suspect" | "missing";
  messageCount?: number;        // 最终消息数，未知时省略
  inheritsFrom?: string;
  createdAt: string;
  endedAt?: string;
}

export interface Page<T> { items: T[]; nextCursor?: string }
```

实现约束：

- 用 `node:sqlite` 以只读方式打开 `agora.db`（`readOnly` 选项，Node 24；daemon 同时在写时依赖 WAL 的读写并发，P0 验证）。
- 会话文件按 pi 的 JSONL 格式解析，消息结构与 pi 的 `AgentMessage` 一致；可以复用 pi 导出的 `SessionManager.open()`（依据：`dist/core/session-manager.d.ts`），是否复用在实现时决定。
- 只接受 `AGORA_HOME` 下的路径：从数据库读出的 `session_file` 先做真实路径解析，不在数据目录内的拒绝读取。
- adapter 不暴露 SQLite 表结构。数据库迁移时同步更新 adapter；`apiVersion` 只在返回结构不兼容时递增，旧版本保留至少一个大版本。
- 不读取、不返回密封草稿。
