# A 组：RPC 生命周期与会话

## 环境与重跑

本组在 macOS 27.0.1、arm64、Node.js v26.12.0、pi 1.5.0 上实测。pi 版本取自本机安装包的 `package.json`。Windows、Linux 均待测；下文“通过”仅指 macOS 的本组实验，不表示三个平台都已验收。

在仓库根目录运行：

```sh
node --test --test-reporter=tap experiments/p0/a-rpc/*.test.mjs
```

保存完整输出：

```sh
node --test --test-reporter=tap experiments/p0/a-rpc/*.test.mjs > experiments/p0/a-rpc/run.tap 2>&1
```

测试断言记录实测行为；已确认的设计差异也有观察断言，因此测试全部成功不等于设计全部通过。每次运行会重写本目录的 `*-evidence.json`、`evidence.json`；重定向命令还会重写 `run.tap`。

所有 provider 请求都交给 harness 的 `p0-fake/scripted`，不调用真实模型，不联网。每个现场使用独立的临时 `HOME`、`PI_CODING_AGENT_DIR`、会话目录和工作目录，不访问使用者的 `~/.pi`。测试扩展、技能和模板均由脚本创建。

### 文件

| 文件 | 用途 |
| --- | --- |
| `rpc.test.mjs` | A1–A8：生命周期、停止、持久化、快照、UI、切换、替换取消。 |
| `retry.test.mjs` | A9–A10：自动重试与未压缩会话的恢复。 |
| `edges.test.mjs` | A11–A14：技能与模板列表、只发 abort、忽略 abort 的 provider、用户扩展自动发现。 |
| `probe-extension.ts` | 在隔离现场加载的受控扩展，记录生命周期、提供门控工具、会话命令和 UI 对话框。 |
| `session-model.mjs` | 最小会话模型与快照原型，按 stdout 顺序同步更新状态、分配 epoch/seq，串行取 `get_entries since`。 |
| `experiment.mjs` | 本组对 harness 的进程停止包装。 |
| `evidence.json`、`*-evidence.json`、`process-evidence-*.json` | 逐项观测、模型请求摘录、进程退出记录。 |
| `run.tap` | 一次完整复跑的输出。 |

## 结论汇总

| 验证项 | macOS 结论 | Windows | Linux | 实验 |
| --- | --- | --- | --- | --- |
| pane #2：RPC 托管与用户扩展 | 通过 | 待测 | 待测 | A1、A4、A9、A10、A14 |
| pane #3：快照切点与重连 | 通过 | 待测 | 待测 | A1、A4、A5 |
| pane #4：停止与超时恢复 | 部分通过 | 待测 | 待测 | A2、A3、A12、A13 |
| pane #5：扩展 UI | 通过 | 待测 | 待测 | A6 |
| pane #7：会话切换与取锁时机 | 通过 | 待测 | 待测 | A3、A4、A7 |
| pane #13：斜杠命令 | 通过 | 待测 | 待测 | A1、A11 |
| agora #1：RPC 生命周期 | 通过 | 待测 | 待测 | A1–A3、A9、A12、A13 |
| agora #2：会话落盘与恢复 | 通过 | 待测 | 待测 | A3–A5、A10 |
| agora #17：子会话扩展 UI | 通过 | 待测 | 待测 | A6 |
| agora #18：steer 送达追踪 | 通过 | 待测 | 待测 | A1、A2 |
| agora #20：禁止会话替换 | 通过 | 待测 | 待测 | A8 |

## RPC 托管与运行结束

对应 pane #2、agora #1。

**验证内容**：拉起 RPC，读取 `get_state`、`get_entries`、`get_last_assistant_text`；发送 `prompt`、`steer`、`follow_up`、`clear_queue`、`abort`；观察工具边界、自动重试与结束事件；加载模拟用户扩展。

**通过标准**：能完成并恢复对话；steer 在当前工具结束后送达；清队列返回原文字；能区分接收、低层运行结束和会话运行稳定结束；RPC 模式可以加载用户扩展。

**实测结果**：

- `prompt` 响应为 `disposition: "started"` 时，工具与模型工作尚未结束。工具执行期间 `get_state.isStreaming` 为 `true`。
- A1 的门控工具启动后才排入 steer；放开工具后先出现 `tool_execution_end`，再出现包含 steer 标注的 user `message_end`，随后才有下一次 provider 请求。
- steer 与 follow-up 均出现在 `queue_update`；清队列返回原字符串，送达后的 user 消息只出现一次。最后助手文字由 `get_last_assistant_text` 取得。
- A9 的第一次回复返回假 provider 错误 `503 overloaded`。共有两次 `agent_end`、一次 `agent_settled`：

  ```text
  seq 11 agent_end willRetry=true
  seq 12 auto_retry_start
  seq 14 agent_start
  seq 21 auto_retry_end
  seq 23 agent_end willRetry=false
  seq 24 agent_settled aborted=false
  ```

- A10 重新拉起同一会话后，第二个进程的 `get_entries` 与退出前完全相等。下次假 provider 请求中的非 system 角色顺序为 `user, assistant, user, assistant, user`；前两条用户文字和两条助手回复都保留。
- A14 把 `p0-user.ts` 放进隔离的 `agent/extensions/`，用本组临时 preload 仅移除 harness 的 `--no-extensions` 参数。RPC 自动发现该扩展，`get_commands` 列出其命令，执行后扩展记录 `{ "mode": "rpc" }`。其他资源发现开关不变。
- A1 的显式测试扩展还验证了自定义工具、命令、输入处理器和会话条目写入。没有加载使用者的真实扩展；本结论不覆盖任意第三方扩展的 TUI 专属功能。

**结论**：pane #2「通过」；agora #1「通过」。只发 `abort` 对队列的实际影响另见“停止与超时恢复”。

## 会话落盘、since 与压缩历史

对应 agora #2，以及 pane #2、#3 的重叠部分。

**验证内容**：为不存在的预分配路径先创建文件锁替身，再用 `--session <路径>` 拉起；对比 RPC 条目与磁盘；压缩后读取历史；重启并核对 provider 上下文；在 `message_end` 后立即请求 `get_entries since`。

**通过标准**：`get_state.sessionFile` 与预分配路径相同；出现对话后文件确实写在该路径；恢复无重复或缺失；`since` 严格排除游标条目并返回当前 `leafId`；压缩前历史仍可读取。

**实测结果**：

- 首次 `get_state` 返回预分配路径，但文件尚不存在。首条对话之后该路径出现 JSONL 文件。空会话已记录的配置条目不能据此认定已落盘。
- A4 在五次 `message_end` 回调后发起的条目请求均找到对应消息，包括 system、user 和 assistant。扩展内部同一事件回调记录的 `alreadyPresent` 为 `false`，和 `agent-session.js` 中先发事件、后持久化消息的顺序一致；RPC 往返完成时已能取到对应条目。
- `get_entries` 以当前最后条目为 `since` 时返回：

  ```json
  { "entries": [], "leafId": "<最后条目 id>" }
  ```

  不存在的游标返回 `success: false`，错误为 `Entry not found: missing-id`。
- A4 用扩展返回受控摘要完成压缩，没有调用真实模型。压缩前的 5 条 message 条目全部保留；全量条目为 8 条。以压缩前最后条目为 `since`，只新增一条 `compaction`。
- 压缩后的 RPC 全量条目与磁盘中除 session header 外的条目逐条相等。重启后条目相等；假 provider 上下文含摘要 `P0 compact summary`、保留的 `history two` 以及其助手回复。
- 导航到较早的助手条目后，`get_entries since=<最后追加的条目>` 返回空增量，但 `leafId` 指向较早的条目。只看新增条目数量无法判断活动分支是否变化。

日志摘录位于 `evidence.json` 的 `persistence` 和 `restore-evidence.json`。压缩测试把 fixture 的 `keepRecentTokens` 设为 1，以便小会话达到可压缩门槛。默认门槛下的短会话返回 `Nothing to compact (session too small)`；该现场保留，没有修改 pi。

**结论**：agora #2「通过」。pane #2、#3 依赖的 `since`、`leafId`、压缩历史和 `message_end` 后补取条目行为「通过」。

## 快照切点与重连

对应 pane #3，并覆盖 agora #2 的会话模型一致性。

**验证内容**：使用最小内存原型处理 stdout；重建 text、thinking、toolCall 块；在事件与条目响应之间取同步快照；从快照游标重放；丢弃内存模型后从 RPC 和会话文件重建；在流式输出中停止旧进程，再重启同一文件。

**通过标准**：快照加游标后的事件能得到同一最终状态；补入持久化条目后移除对应 `completed`，没有重复消息或块；epoch 变化、未来游标和过期游标均返回 `resync`；重建后的条目与磁盘一致。

**实测结果**：

- 原型在同一个同步回调中更新状态、分配 `seq`。条目补取串行执行，处理 `get_entries` 响应时产生 `pane_entries`。
- A1 覆盖工具调用及队列，在每个快照切点重放后都得到与最终模型相同的条目和进行中消息状态；最终条目与会话文件相同。一次复跑包含 55 个此类切点，数量可能随调度变化。
- A5 的两个块分别为 thinking `plan two`、text `alpha beta gamma`。丢弃原模型前的流式快照明确含 thinking 全文和 text `alpha`；此前 16 个切点重放后都等于丢弃前状态。
- 丢弃模型后创建新的 epoch，以 `get_entries` 重建持久化部分并接收后续 RPC 事件。收到最终 `message_end` 后，完整 thinking/text 替换进行中内容；随后条目补取移除 `completed`。最终消息内容如下：

  ```json
  [
    { "type": "thinking", "thinking": "plan two" },
    { "type": "text", "text": "alpha beta gamma" }
  ]
  ```

  新模型的全部切点重放后等于其最终状态；`active` 为 `null`，`completed` 为空。最终条目与 JSONL 一致。
- 旧 epoch 的游标、超过当前 head 的游标，以及缓冲中移除首事件后的游标 0，都返回 `resync`。
- 模型丢弃后重启同一会话，以及再次流式输出中终止旧进程、确认退出后重启，新 epoch 都拒绝旧游标；重建条目与当时的磁盘相同。

这里的浏览器和服务端重连均为内存模型实验，没有实际 HTTP/WebSocket 或页面。丢弃正在输出的模型后，单靠 `get_entries` 不能恢复尚未持久化的部分消息前缀；该次实验通过后续完整 `message_end` 恢复最终内容。它没有验证在丢失所有内存且旧进程仍输出时，立即恢复已有流式前缀，也没有验证强杀前未落盘片段的持久化。服务端重启场景按设计先终止旧 pi 并确认退出，再打开会话文件。

**结论**：pane #3「通过」，范围为本任务要求的切点原型、最终内容一致性和 epoch 重同步。原型不实现历史分页、完整界面状态、真实浏览器重连或生产服务端。

## 停止与超时恢复

对应 pane #4，并覆盖 agora #1 的 abort 与超时部分。

**验证内容**：运行中同时排队 steer 和 follow-up；先清队列再 abort；工具或 provider 忽略 abort；只发 abort 而不清队列。

**通过标准**：停止流程返回全部排队文字，此后不执行这些文字；abort 超时后能终止受管进程并恢复同一会话。另核对 pane `architecture.md`“停止与控制队列”中“只停止当前回复，排队消息继续执行”的描述。

**实测结果**：

- A2 先发 `clear_queue`，原序返回两个 steer 和一个 follow-up。随后 `abort` 成功、`agent_settled.aborted` 为 `true`；provider 请求只有 1 次，磁盘中的用户文字只有原始输入，没有执行被清掉的文字。
- A3 的 `p0_gate` 工具不监听 abort signal。`abort` 等待 180 ms 后在驱动侧超时；此时 `get_state` 仍可响应，`isStreaming` 为 `true`，没有 `agent_settled`。按该进程自己的进程组发 `SIGKILL`，等待退出后重新打开同一路径。退出记录为：

  ```json
  { "code": null, "signal": "SIGKILL" }
  ```

  恢复后的假 provider 能看到原用户输入；没有自动重放工具，`gate_start` 总数为 1。
- A13 的 provider 忽略 abort，同样出现驱动超时；provider 日志记录 `abort_received`，但没有 `agent_settled`，`get_state` 仍报告输出中。该受管进程最终退出。
- A12 只发 `abort`，排队文字没有自动继续执行。实测摘录：

  ```json
  {
    "requests": 1,
    "isStreaming": false,
    "pendingMessageCount": 2,
    "clearAfterSettled": {
      "steering": ["steer after abort"],
      "followUp": ["queued after abort"]
    }
  }
  ```

  在 `agent_settled.aborted: true` 和成功的 abort 响应之后，队列仍可由 `clear_queue` 取回。这和 pi `docs/rpc-commands.md` 的 `abort continues queued messages`，以及 pane `docs/architecture.md`“停止与控制队列”的“只停止当前回复”行为描述不符。影响范围是该菜单项的续跑承诺；先清队列再 abort 的主停止流程符合标准。pi 源码 `agent-session.js` 的 `_startRun`、`_handlePostAgentRun` 在 `_agentRunAbortRequested` 为真时结束续跑，与观察一致。

**结论**：pane #4「部分通过」。主停止流程、超时识别、强制终止和恢复通过；只 abort 后队列自动继续执行的描述不通过。agora #1 所列命令和结束判定的验收标准「通过」。

## 扩展 UI

对应 pane #5、agora #17。

**验证内容**：通过 RPC 模拟浏览器回应 `select`、`confirm`、`input`、`editor`；不回应带 timeout 的请求；模拟子会话立即取消及 pending 超时取消。

**通过标准**：扩展收到与回应一致的值；pi 自身 timeout 返回文档规定的默认值；无人处理的协作 UI 不会无限挂起。

**实测结果**：

- A6 的正常回应使扩展收到：

  ```json
  { "select": "B", "confirm": true, "input": "typed", "editor": "edited\nlines" }
  ```

- 对 select、confirm、input 各设 60 ms timeout，不发送回应；三个对话框顺序结束，耗时约 180–190 ms。扩展收到的 select/input 为 `undefined`，confirm 为 `false`。写入实验条目时将 `undefined` 归一为 `null`。
- `editor` 的 API 与 RPC 请求不提供 timeout；本实验没有为它编造 pi 自身的超时能力。它的取消由宿主发送匹配 id 的 `{ cancelled: true }`。
- 四类请求均立即回应取消时，扩展收到默认值，命令返回 `disposition: "handled"`。
- pending 替身按每题 40 ms 的宿主期限回应取消，四个对话框结束约需 160–175 ms，扩展收到相同默认值。该实验验证取消机制，不实等默认 10 分钟，也没有实现 daemon 的持久待处理队列。

**结论**：pane #5「通过」；agora #17「通过」。浏览器通过 RPC 适配的部分由受控驱动模拟。

## 会话切换与取锁时机

对应 pane #7。

**验证内容**：RPC 与扩展命令分别发起 new、resume、fork、clone；静态 `SessionManager.forkFrom()`；取消 resume；用简单文件锁替身核对取锁时点和新会话取锁失败后的输入阻断、退出时点。

**通过标准**：预分配路径生效；forkFrom 不修改源文件；取消后不换会话、不修改目标文件；回调中的目标路径和前一会话路径与实际一致；新会话取锁失败后没有新输入进入，在新 `session_start` 后停止进程。

**实测结果**：

- A4 在 spawn 前创建文件锁替身，之后不存在的 `--session` 路径由 pi 沿用。A7 的 `forkFrom` 输出另一个文件，源文件内容逐字节不变。
- 扩展没有独立的 `clone()` 方法，实验按 pi API 使用 `ctx.fork(leafId, { position: "at" })`。
- 八个切换用例的 `session_shutdown.targetSessionFile` 均等于切换后 `get_state.sessionFile`，`session_start.previousSessionFile` 均等于源路径。
- 取锁替身的调用顺序为：

  | 操作 | 取锁事件 | 事件发生时目标文件是否已存在 |
  | --- | --- | --- |
  | new | `session_shutdown` | 否 |
  | resume | `session_before_switch` | 是 |
  | 带已有历史的 fork | `session_shutdown` | 是 |
  | clone | `session_shutdown` | 是 |

- `session_before_switch` 返回取消时，`get_state.sessionFile` 保持源路径。目标文件锁被预先占用时，替身在该事件中返回取消；目标 JSONL 逐字节不变。
- 新会话取锁替身返回 `EEXIST` 时，宿主原型在 shutdown 阶段阻断后续发送，尝试发送的 prompt 被本地拒绝，实际发往 pi 的额外输入数为 0。收到新 `session_start` 后终止该受管进程，记录退出码 143。
- **额外观察**：四种 RPC 替换均触发两次相同的 `session_start`；对应扩展命令各触发一次。RPC 摘录为：

  ```text
  session_before_switch / session_before_fork
  session_shutdown
  lock_result
  session_start
  session_start
  ```

  resume 的 `lock_result` 在 `session_before_switch` 与 `session_shutdown` 之间。重复的 start 中目标及 previous 路径相同，没有观察到第二次会话文件替换。`rpc-mode.js` 在 runtimeHost 替换完成后又调用 `rebindSession()`，runtimeHost 自身也通过回调 rebind；源代码与双回调现象一致。该观察涉及 pane `architecture.md`“会话切换”“会话替换后的重绑定”，本组没有把事件次数视为恰好一次。

**结论**：pane #7「通过」。这里仅验证取锁时点；真实跨进程写锁、原生锁释放与跨宿主恢复不在本组范围。

## 斜杠命令

对应 pane #13。

**验证内容**：读取 `get_commands`；运行中用 `prompt` 发送扩展命令；加载并执行受控技能和模板。

**通过标准**：扩展、技能、模板的补全名称及来源正确；扩展命令在工具仍执行时立即处理。

**实测结果**：

- A1 的 `p0-ping` 来源为 `extension`，含 description 和 sourceInfo；在门控工具尚未放开时执行，命令响应为 `handled`，条目记录 `idle: false`。没有等待模型结束，也没有因此向 provider 发送该命令。
- A11 的命令列表摘录：

  ```json
  [
    { "name": "p0-template", "source": "prompt" },
    { "name": "skill:p0-skill", "source": "skill" }
  ]
  ```

- 发送 `/p0-template argument` 后，假 provider 请求含 `TEMPLATE_SENTINEL argument`；发送 `/skill:p0-skill` 后请求含 `SKILL_SENTINEL`。
- `get_commands` 没有列出内置 `compact`；本实验没有把该列表解释为全部 TUI 内置命令。

**结论**：pane #13「通过」。

## steer 送达追踪

对应 agora #18。

**验证内容**：用标注 `【agora 返工 st_delivered，第 2 代】` 和 `【agora 返工 st_dropped，第 3 代】` 跟踪排队、送达和被清除。

**通过标准**：标注在 queue_update、user message_end、clear_queue 中保持不变，足以区分四种状态。

**实测结果**：

- 原型在接收返工消息时建立 `accepted` 记录；这一步为本地状态，不是 pi 的事件，也未验证尚不存在的 daemon SQLite 实现。
- 两条标注都可以从 `queue_update.steering` 中完整匹配，转为 `queued`。
- 放开工具后，`st_delivered` 在 user `message_end` 中完整出现；后续 provider 请求也能看到该标注。该用户消息只出现一次。
- `st_dropped` 由 `clear_queue.steering` 原样返回，未进入用户对话。
- 状态轨迹：

  ```json
  {
    "st_delivered": ["accepted", "queued", "delivered"],
    "st_dropped": ["accepted", "queued", "dropped"]
  }
  ```

**结论**：agora #18「通过」。

## 禁止协作会话替换

对应 agora #20。

**验证内容**：受管扩展的 `session_before_switch` 和 `session_before_fork` 返回 `{ cancel: true }`；尝试 RPC 和另一段命令逻辑发起替换；模拟保护未取消时的宿主退出监控。

**通过标准**：new、resume、fork、clone 均取消，会话文件及内容不变；宿主收到意外 shutdown 时停止该 run。

**实测结果**：

- A8 的四个 RPC 命令分别返回 `cancelled: true`。
- 在受管保护扩展之后，额外用显式 `-e` 加载白名单测试扩展 `caller.ts`。它的命令分别调用 `ctx.newSession()`、`ctx.switchSession()`、`ctx.fork()` 和 `ctx.fork(..., { position: "at" })`，四个结果均为 `cancelled: true`；对应 prompt 响应为 `disposition: "handled"`。该调用扩展还注册了稍后执行的 before 处理器；保护扩展返回取消后，后面的处理器未执行。
- 八个请求前后的 `get_state.sessionFile` 相同，源文件逐字节相同，没有 `session_shutdown`。
- 在同一现场单独关闭取消开关，再发 `new_session`。测试桥接把真实 `session_shutdown(reason: "new")` 转成 RPC 通知；宿主原型收到后立即停止自己启动的进程，得到退出码 143。这里没有借助真正的 agora daemon。

**结论**：agora #20「通过」。

## harness 边界与现场

没有修改共用 harness。`experiment.mjs` 包装了两项已从源码核实的行为：

1. harness 的 `stop()` 在检查进程是否已关闭之前先给进程组发信号。本组包装在 `exitInfo` 已存在时直接返回，避免重复清理已回收的进程组。
2. harness 的 `killGroup()` 使用负 PID。Windows 包装分支改为仅给已知子进程发信号；本组不启动 shell 或工具后代进程，该分支仍标为待测，不代表验证了 Windows 进程树终止。

A14 为测试用户扩展自动发现，用临时 `NODE_OPTIONS --import` preload 从 pi 的 argv 中移除默认 `--no-extensions`。它只作用于该隔离现场，不修改 harness 或全局安装。

出现预期外结果的现场未删除。首次失败的 abort 现场和短会话 compact 现场保留在本机临时目录；每次完整复跑还会保留 abort 队列差异和重复 `session_start` 的现场，路径由 `run.tap` 的 `retained` 行给出。其他成功现场清理。保留现场不是遗留进程。

`process-evidence-*.json` 分别记录三个测试文件启动的全部 pi 子进程；它们的退出都已等待，`alive` 数组为空。测试未创建外部工具后代；没有遗留进程。没有按进程名终止任何进程。

本组只写 `experiments/p0/a-rpc/`，没有修改两仓的 `docs/`。上述差异仅作事实记录，未提出或实施设计调整。
