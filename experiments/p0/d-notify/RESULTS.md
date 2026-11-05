# D 组：可靠通知与故障注入

## 验证范围

本实验对应 [roadmap.md](../../../docs/roadmap.md) 的 agora #7、#8。运行环境为 macOS、Node v26.12.0、pi 1.5.0。版本取自已安装包的 `package.json`。所有模型请求均由共用 harness 的 `p0-fake/scripted` 在本地生成；没有调用真实模型，也没有访问外部网络。

| 验证项 | macOS 结论 | Windows | Linux |
| --- | --- | --- | --- |
| agora #7：通知送达、静默注入、条目确认、清队列和去重 | 部分通过 | 待测 | 待测 |
| agora #8：通知故障注入 | 通过 | 待测 | 待测 |

#7 的基本送达和 `clear_queue` 路径均符合通过标准。额外覆盖的“仅 `abort`，未调用 `clear_queue`”路径中，按设计描述释放内存去重标记后重投，同一 `dedupeKey` 在会话文件中出现两次，连续 3 次一致。该现象不发生在本次测得的 `clear_queue` + `abort` 路径中。

#8 的结论限定于本机进程强杀和下文定义的事件派发边界，不包含断电、`fsync` 持久性或跨平台验收。

## 复跑

在仓库根目录执行：

```sh
node --test experiments/p0/d-notify/notify.test.mjs
```

需要 `pi` 1.5.0 位于 `PATH`，以及提供 `node:sqlite` 的 Node。无需安装依赖。每个故障点默认重复 3 次，可通过 `P0_REPEAT` 调整次数；正式记录使用默认值。

脚本覆盖 25 个观测用例：7 个基本行为、5 个故障点各 3 次、3 次仅 `abort` 的偏差复现。`observations.json` 会被本次观测覆盖。保存终端输出可使用：

```sh
node --test experiments/p0/d-notify/notify.test.mjs > experiments/p0/d-notify/test-output.txt 2>&1
```

本次输出摘要：

```text
tests 25
pass 25
fail 0
cancelled 0
skipped 0
```

**25/25 表示脚本的观测断言成立，不表示设计的全部通过标准成立。** 其中 3 个用例明确断言“实际有 2 条”，用于固定已经发现的偏差。全部用例共收到 25 次 ack；daemon 独立检查时，25 次均能读到对应的完整会话记录，提前 ack 为 0 次。

## 原型与判定依据

文件职责：

| 文件 | 职责 |
| --- | --- |
| `daemon.mjs` | 独立进程中的 SQLite WAL outbox；任务状态与通知同事务写入；`dedupeKey` 唯一；通过 loopback HTTP 收取通知和确认。 |
| `notice-extension.ts` | 运行在真实 pi 中的注入扩展；会话条目去重、正在排队的通知去重、磁盘确认、重启恢复和故障点。 |
| `notify.test.mjs` | 创建隔离现场，驱动 RPC，真正发送 `SIGKILL`，恢复原会话并检查计数。 |
| `observations.json` | 逐用例的扩展日志、daemon 日志、outbox 状态、provider 请求摘要、会话记录及退出信号。 |
| `test-output.txt` | 本次完整测试输出。 |

原型按 [tasks.md“完成通知与 outbox”](../../../docs/tasks.md#完成通知与-outbox) 实现以下部分：

1. 通知写入 outbox 后，以 `triggerTurn: true, deliverAs: "followUp"` 注入；静默通知改为 `triggerTurn: false`。
2. 注入前查询 `ctx.sessionManager.getEntries()`，同 key 已存在则不再注入；尚在排队的 key 用内存集合去重。
3. 在拉取、`turn_end` 和 `agent_settled` 时检查确认条件。必须先在内存会话条目中找到 `entryId`，再在磁盘 JSONL 中找到同 id、同 key 的完整 `custom_message` 行，才发送 ack。
4. `message_end` 回调本身不确认。空会话只有自定义通知、没有 user/assistant 时，也不确认。
5. `agent_settled` 时，已注入但还没有会话条目的 key 从内存集合移除；之后从 outbox 重投。
6. daemon 在 ack 时额外独立读取会话文件，只把结果写入日志，不以服务器拒收来掩盖提前 ack。

实验将可见性超时从设计默认的 120 秒缩短到 250 毫秒，以便重复测试；自动拉取间隔为 50 毫秒。手动的 `/p0-poll` 也通过同一串行链执行。实验检查受控小文件的所有完整行，没有实现生产环境的尾部扫描和长轮询。没有实现鉴权、租约身份、会话写锁、业务通知内容或完整 daemon。

`board.md` 的 `deliveryId` 与 `confirmedSeq` 没有单独建模；本实验只验证它依赖的相同自定义消息与磁盘确认机制，不把 board 游标推进算作已测功能。

## agora #7：通知送达

### 逐项结果

| 验证内容 | 通过标准 | 实测结果 | 结论 |
| --- | --- | --- | --- |
| 空闲时唤醒 | 不需要额外用户输入，开始新一轮；最终只有一条通知。 | `inject.idle=true`；provider 请求数从种子对话的 1 增至 2；内存和磁盘各一条。 | 通过 |
| 模型忙碌时注入 | 当前请求期间排队，随后送达；超时重取不能增加重复通知。 | 在延迟的假 provider 请求中注入，落盘计数为 0；250 毫秒后再次收取被内存集合去重；当前请求自然结束后送达，最终一条。 | 通过 |
| 工具执行时注入 | 工具完成前排队，工具结果先写入，通知随后送达。 | 假 provider 调用真实执行的 `p0_gate` 工具。测试确认已进入工具的 `execute()`，在其等待释放文件时注入；此前磁盘计数为 0。工具读取临时输入并返回后，后续 provider 请求包含通知，最终一条。 | 通过 |
| 已有对话的空闲会话中静默注入 | 不启动模型请求；可从条目和完整磁盘记录确认。 | provider 请求数保持 1；内存和磁盘各一条。RPC 收到一个自定义 `message_end`，扩展的 `message_end` 钩子没有收到该通知。 | 通过 |
| 没有对话的新会话中静默注入 | 未落盘时不 ack；第一条对话后再确认，不能重复注入。 | `memoryCount=1,diskCount=0`，文件不存在，outbox 未确认。第一条用户对话创建文件后，同一通知落盘一次并 ack。 | 通过 |
| 忙碌会话中静默注入 | 不额外启动一轮，当前运行结束后追加并确认。 | 注入后暂未落盘；中止当前假 provider 请求后，通知从 pending custom 路径写入。请求数仅包含种子和被中止的请求，共 2 次；没有通知引发的请求。 | 通过 |
| `clear_queue` 清掉排队通知 | 不把排队视作确认；在 settled 后可重新注入，最终仅一条。 | 清除前磁盘为 0、未 ack。`clear_queue` + `abort` 后出现 `reset_inflight`；自动拉取重新注入，累计注入 2 次、磁盘 1 条。 | 通过 |
| outbox key 与在途去重 | 同 key 不能产生多条 outbox；排队期间重取不重复注入。 | 基本用例重复创建同 key，outbox 均只有 1 行。忙碌和清队列用例收到 `deduped,inEntries=false,inFlight=true`。 | 通过 |
| 仅 `abort` 后重投的去重 | 同 key 在会话中仍只能出现一次。 | 3/3 次在 `agent_settled` 释放在途标记后重投，内存和磁盘各 2 条，同一 key 对应不同 entryId。 | 不通过 |

### 关键日志

以下摘录省略 PID、entryId 和其他不影响判断的字段；完整记录见 `observations.json`。

正常唤醒中的扩展回调先于会话追加：

```json
{"kind":"inject","dedupeKey":"notice:idle","silent":false,"idle":true}
{"kind":"extension_message_end","dedupeKey":"notice:idle","memoryCount":0,"diskCount":0}
{"kind":"ack","dedupeKey":"notice:idle","onDisk":true}
```

清除排队通知的 RPC 返回值没有包含自定义通知的文字：

```json
{"steering":[],"followUp":[]}
```

清队列后的恢复依据是会话条目，而不是这个返回值：

```json
{"kind":"reset_inflight","dedupeKey":"notice:clear_queue"}
{"kind":"inject","dedupeKey":"notice:clear_queue","silent":false,"idle":true}
```

仅 `abort` 的偏差时序如下。两次 `extension_message_end` 分别观察到通知尚未存在、以及已有一条：

```json
{"kind":"reset_inflight","dedupeKey":"notice:abort-queue:1"}
{"kind":"inject","dedupeKey":"notice:abort-queue:1","silent":false,"idle":true}
{"kind":"extension_message_end","dedupeKey":"notice:abort-queue:1","memoryCount":0,"diskCount":0}
{"kind":"extension_message_end","dedupeKey":"notice:abort-queue:1","memoryCount":1,"diskCount":1}
```

最终磁盘中的两条记录均是 `customType="agora:notice"`，`details.dedupeKey="notice:abort-queue:1"`，entryId 不同。第 2、3 次重复具有相同结果。

### 与设计的差异及影响

pi 的 `abort` 不清掉低层 custom followUp 队列。此时出现的 `agent_settled` 不意味着所有尚未落入条目的通知都已被丢弃。原型按设计在 settled 释放去重标记后，新的注入触发一轮，原队列里的同 key 通知也被消费，因此出现两条。对照源码，`sendCustomMessage()` 把通知直接交给 `agent.followUp()`；`abort()` 调用中止并等待空闲，没有 `clearAllQueues()`；后者在 `clearQueue()` 中。

受影响的位置：

- `tasks.md` →“完成通知与 outbox”→“投递”中的“被清掉的通知”和“先在当前会话条目中查找相同 dedupeKey”的规则。仅 `abort` 后尚有未消费队列时，条目与在途标记不能阻止本次复现的重复。
- `board.md` →“投递流程”“恢复”也使用同类自定义 followUp 和条目确认；上述队列行为与其通知机制相关。本实验没有直接执行 board 投递。
- `architecture.md` →“与会话的通信”“控制队列与并发”。其规定的停止顺序为 `clear_queue` + `abort`；本实验中这条顺序没有复现重复，偏差限定于没有清队列的直接 `abort`。

另外，排队的自定义通知确实被 `clear_queue` 清掉，但它的文本没有出现在返回的 `followUp` 数组中。pi 只在 `_followUpMessages` 中跟踪常规 follow-up 文本，自定义消息直接进入 agent 队列。这个观察不影响本实验的磁盘确认判定。

## agora #8：通知故障注入

### 故障边界

每个点实际执行 3 次强杀，没有通过抛异常或返回失败代替杀进程：

- 扩展 `message_end`：在真实通知的扩展回调内对 pi 自身发送 `SIGKILL`。
- 公共 `message_end` 派发后、持久化前：仅在当前子进程内包装 `AgentSession._emit` 与 `SessionManager.appendCustomMessageEntry`。前者调用原实现后记下 `public_dispatched`；后者调用原实现前杀死 pi。没有修改安装包。
- 静默注入后：`pi.sendMessage()` 返回后、确认扫描前杀死 pi。已有对话与尚无对话分别测试。
- ack 请求发出前：扩展已经核实完整磁盘记录，停在 HTTP 请求前的 barrier；驱动强杀 daemon，然后释放 barrier。扩展记录连接错误。按 architecture 的旧 run 退出约束，驱动再杀死旧 pi，确认退出后重启 daemon 和原会话。

公共事件派发与 RPC 接收需要区分。pi 的 `writeRawStdout()` 通过 Promise 队列输出；`public_dispatched` 证明真正的公共 listener 已执行，但该故障点的 3 次强杀中，RPC 驱动均没有收到通知的 `message_end`。因此本项验证了“内部已经派发、文件还没写”的边界，没有把“RPC 客户端已经收到该行”冒充为同一观测。本报告按事件在 pi 内完成派发理解 roadmap 中的“`message_end` 已发出”。

### 逐项结果

统一通过标准：被杀进程确实退出；恢复后同一 key 在内存和磁盘中各恰好一条；通知未写入完整磁盘记录前，outbox 不得确认。

| 验证内容 | 杀进程前的事实 | 恢复结果与重复次数 | 结论 |
| --- | --- | --- | --- |
| 扩展 `message_end` 回调内杀 pi | 回调中 `memoryCount=0,diskCount=0`；outbox 未确认；退出信号 `SIGKILL`。 | 重启并重投后磁盘一条；总注入两次；3/3 一致。 | 通过 |
| 公共 `message_end` 派发后、会话写入前杀 pi | `public_dispatched` 在故障日志之前；持久化入口前磁盘为 0；outbox 未确认；退出信号 `SIGKILL`。 | 恢复后磁盘一条；总注入两次；3/3 一致。RPC 接收的范围限制见上文。 | 通过 |
| 已有对话的会话中静默注入后立即杀 pi | `sendMessage()` 返回时 `memoryCount=1,diskCount=1`，尚未 ack；退出信号 `SIGKILL`。 | 恢复后先从会话条目核实原 entryId，再确认；不再注入，总注入一次，磁盘一条；3/3 一致。 | 通过 |
| 没有任何对话的新会话中静默注入后杀 pi | 返回时 `memoryCount=1,diskCount=0`；文件尚不存在，outbox 未确认；退出信号 `SIGKILL`。 | 原路径恢复后重新注入；第一条用户对话使文件首次落盘，随后确认；总注入两次，磁盘一条；3/3 一致。 | 通过 |
| ack 请求发出前杀 daemon | 通知已经完整落盘，但 outbox 未确认；daemon 退出信号 `SIGKILL`，扩展随后收到连接失败。 | 同一个 SQLite outbox 重启后仍未确认；旧 pi 退出后恢复原会话，核实原条目再 ack；总注入一次、磁盘一条；3/3 一致。 | 通过 |

### 关键日志

公共派发后的故障点：

```json
{"kind":"extension_message_end","dedupeKey":"fault:public-before-persist:1","memoryCount":0,"diskCount":0}
{"kind":"public_dispatched","dedupeKey":"fault:public-before-persist:1"}
{"kind":"fault","point":"public-before-persist","dedupeKey":"fault:public-before-persist:1","diskCount":0}
```

新会话的静默注入在崩溃前只存在于内存：

```json
{"kind":"silent_returned","dedupeKey":"fault:silent-new-after-send:1","memoryCount":1,"diskCount":0}
{"kind":"fault","point":"silent-after-send"}
```

daemon 的故障点发生在确认请求之前；恢复后的 daemon 才收到 ack：

```json
{"kind":"before_ack","dedupeKey":"fault:daemon-before-ack:1","onDisk":true}
{"kind":"transport_error","error":"TypeError: fetch failed"}
{"kind":"ack","dedupeKey":"fault:daemon-before-ack:1","onDisk":true}
```

这 15 次故障实验中，没有观察到同一故障点有时重复、有时丢失的情况。已有完整会话记录的两类恢复允许直接确认，outbox 的 `attempts` 可以保持 1；文件中没有记录的恢复需要重新注入，`attempts` 为 2。

## 源码依据

以下路径相对 pi 1.5.0 安装包；实验以实现和实际日志为准：

- `dist/core/agent-session.js` 的 `_handleAgentEvent`：先等待扩展事件，再 `_emit` 公共事件，然后追加会话消息。
- 同文件的 `sendCustomMessage`、`_appendCustomMessage`：忙碌的唤醒通知进入 followUp；空闲静默通知同步追加，再只向公共 listener 发送消息事件；忙碌静默通知延迟到 turn 结束或 run 清理时追加。
- 同文件的 `_emitAgentSettled`、`abort`、`clearQueue`：settled 的工作延后启动；abort 与清除队列是分开的操作。
- `dist/core/session-manager.js` 的 `_hasConversation`、`_persist`：第一条 user/assistant 前不创建会话文件；首次落盘和后续追加均使用同步文件 I/O。
- `dist/core/output-guard.js` 的 `writeRawStdout`：stdout 实际写入排在 Promise 链中，不能把公共 listener 返回等同于 RPC 对端已经读到。

## harness、现场与进程

没有修改 `experiments/p0/harness/`，也没有修改 `docs/` 或其他组的目录。

共用 harness 没有阻挡本组实验的功能缺陷。其 `RpcDriver.killGroup()` 使用 POSIX 负 PID；本组在自己的测试文件中包了一层，避免对已经退出的 child 重复发信号，并为 Windows 的单进程 fixture 提供 `child.kill()` 分支。Windows 行为仍为待测，包装层不承诺进程树监管。测试不生成 shell 后代进程。

所有 pi 的 cwd、HOME、`PI_CODING_AGENT_DIR`、会话文件和原型数据库均在 harness 创建的临时目录内。daemon 也使用相同的隔离 HOME 和 agent 目录。进程只按自己持有的 child PID 或 pi 进程组终止，没有使用按名称杀进程，也没有访问主人的 `~/.pi`。

正常观测与强杀恢复通过后，临时现场删除。出现偏差或断言失败的现场保留。最后一次运行保留的 3 个偏差现场为：

```text
$TMPDIR/pi-p0-WWONgg
$TMPDIR/pi-p0-oTj3IL
$TMPDIR/pi-p0-4ZAuCa
```

完整路径也写在 `observations.json` 的 `retainedFixtures`。前面诊断运行的失败现场没有回滚或删除；它们不代表额外的正式重复次数。保留的目录只含实验数据，相关进程均已终止。

最终 `observations.json` 中 `lingering=[]`。所有已拉起的 pi 和 daemon 都等待了退出事件，没有遗留本组子进程。
