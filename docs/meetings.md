# 会议

> 状态：设计草案。流程、阈值和默认值是草案，部分阈值标为“待定”，P0 和试运行后冻结。

会议是 board 的一种用法：召集人指定议题和参会者，每个参会者是一个独立上下文的协作会话（`kind = meeting-seat`，权限档位 `explore`），大家通过同一块 board 交换方案、反对意见和证据，由 daemon 调度发言，最后由独立的书记会话写纪要。

最常见的用法：用户和主代理（Claude）交流时，主代理召开一个两人会议（一个 Claude、一个 Astra）定方案，会议结束后主代理只拿回纪要和定稿方案，讨论过程不占主代理的上下文。

参会者复用任务的进程、权限、停止、恢复和存档机制（见 [tasks.md](tasks.md)、[architecture.md](architecture.md)）。区别在上层：参会者每次 settled 只通知会议调度器，不叫醒召集人。

## 召集

### 召集人

召集人可以是：

- **Agent**：主代理用 `agora_meeting convene`；
- **用户**：`agora meeting convene <meeting.yaml>`，或在 pi-pane 里填表单。用户召开的会议在 pi-pane 侧栏挂在“用户会议”根节点下。

### 参数

```ts
// 草案，P0 后冻结
interface ConveneMeetingParams {
  action: "convene";
  topic: string;                 // 议题
  deliverable: string;           // 要交付什么，如“一份可直接实施的接口方案”
  brief: string;                 // 背景、已定约束、资料说明；所有参会者看到同一份
  materials?: string[];          // 资料路径（参会者用只读工具读取）
  cwd?: string;                  // 参会者读资料的根目录
  flow?: "define-plan";          // MVP 只有这一种流程
  seats: SeatSpec[];             // 2–4 人
  mergerSeat: string;            // 合并人的 seat 名，必填
  secretary?: { model: string; thinking?: ThinkingLevel }; // 默认用配置里的书记模型
  limits?: MeetingLimits;
}

interface SeatSpec {
  name: string;                  // 会议内唯一，如 "claude-fe"
  model: string;                 // 完整 provider/id
  thinking?: ThinkingLevel;
  role: string;                  // 角色说明，如“前端可行性与交互”“算法正确性审查”
}

interface MeetingLimits {         // 安全上限，触发后暂停询问召集人
  maxTokens?: number;            // 总额度：所有参会者与书记的输入+输出 token 合计，含 diagnosticReserveTokens，默认 2 000 000（待定）
  maxModelCalls?: number;        // 实际模型请求次数，默认 200（待定）
  maxDurationMinutes?: number;   // 默认 90（待定）
  maxCycles?: number;            // 合并—核对循环次数，默认 6（待定）
  diagnosticReserveTokens?: number; // 总额度中预留给书记纪要和通知的部分，默认 60 000（待定）
}
```

**预算的组成**：`maxTokens` 是会议的总额度，其中 `diagnosticReserveTokens` 预留给书记写纪要和发通知，参会者的普通运行只能用 `maxTokens - diagnosticReserveTokens`。convene 和提高上限时校验 `0 ≤ diagnosticReserveTokens ≤ maxTokens`，不满足返回 `400 invalid_params`；下面的封顶按总额度（含预留）计算。

上限的默认值和未经设备签名时可设定的封顶：

```ts
// 配置，草案；默认值待试运行后校准
meetingLimitDefaults = { maxTokens: 2_000_000, maxModelCalls: 200, maxDurationMinutes: 90, maxCycles: 6,
                         diagnosticReserveTokens: 60_000 };
agentLimitCap = {
  perMeetingFactor: 2,           // 主 Agent 为单个会议设定或提高的每一项上限，不超过默认值 × 2
  dailyTokens: 6_000_000,        // 每日封顶，见下
};
```

- **单会议封顶**：主 Agent（`agent:main`）召集会议或提高自己会议的上限时，每一项不超过 `meetingLimitDefaults × perMeetingFactor`。用户召集的会议（经 CLI 或 pi-pane，即 `host:cli`、`host:pane` 发起）不经签名时只能用 `meetingLimitDefaults` 以内的值，之后的任何提高都需要用户确认。
- **每日封顶**：同一数据目录内，同一天（本地日历日）**所有未经设备签名**的会议创建和预算提高所授予的 `maxTokens` 之和不超过 `dailyTokens`，不区分发起方是 `agent:main`、`host:cli` 还是 `host:pane`。每次创建或提高时，daemon 在同一个事务里读当天累计、判断、写入账本（`budget_grants` 表），并发请求不会一起越过封顶。经设备签名的授予不计入。
- **超出封顶**：超出单会议或每日封顶的部分是用户级操作，请求只生成一条待确认，在已配对浏览器中签名后生效（见 [security.md](security.md#会议)）。
- 修改 `meetingLimitDefaults` 和 `agentLimitCap` 属于安全设置：调高需要用户确认，调低随时可以。

同一模型可以多人参会（如 Astra 和 Sol，或两个 Claude）。同模型参会者必须给不同的 `role`，否则 convene 返回 `400 duplicate_role`，避免两份几乎相同的方案互相附和。

`convene` 立即返回 `meetingId` 和会议节点信息，召集人收到的是**会议回执**，不是讨论流水。

推理名额：会议必须一次拿到与席位数相同的名额才开始。席位数超过 `maxConcurrentRuns` 时 convene 返回 `400 exceeds_concurrency`；名额暂时不够时回执的状态为 `queued`，并附排队位置和预计等待时间，拿到名额后自动开始并再发一条通知。规则见 [architecture.md](architecture.md#名额优先级)（待定）。

### `agora_meeting` 的其他动作

| action | 谁能用 | 说明 |
| --- | --- | --- |
| `status` | 召集人、用户 | 当前阶段、修订号、认可情况、用量、暂停原因 |
| `interject` | 召集人、用户 | 插话，见“插话” |
| `decide` | 召集人、用户 | 回应决策请求（继续、裁决、换人、结束、放弃）。主 Agent 召集的会议由主 Agent 自己裁决；用户召集的会议的决定是用户级操作 |
| `limits` | 召集人、用户 | 提高预算和时长上限。主 Agent 在 `agentLimitCap` 以内直接生效，超出部分需要用户确认；用户召集的会议需要用户确认 |
| `stop` | 召集人、用户 | 结束会议；默认由书记出纪要，`skipMinutes: true` 时直接结束 |
| `result` | 召集人、用户 | 取纪要和定稿方案 |
| `endorse` | 参会者 | 认可某版修订，见“认可与版本绑定” |

用户在会议中的插话（以用户为作者的条目）、对用户召集的会议的决定，以及超过封顶的提高上限，都需要用户确认；主 Agent 对自己会议的裁决、结束和封顶以内的提高不需要。参会者和书记不能做这些操作，只能用 `agora_request ask` 提问。完整的访问控制见 [security.md](security.md#会议)。

### 合并人的选择

合并人由召集人按角色指定（`mergerSeat`），不按谁先发言决定。常见做法：议题主要落在哪个角色的职责上，就由那个角色合并，另一方负责核对。

## 默认流程：定方案（define-plan）

不固定轮数。流程按阶段推进，直到所有参会者认可同一版方案，或触发僵局、上限而暂停。

```text
brief ─► 密封独立方案 ─► 揭示 ─► 交叉质疑 ─► 合并 R1 ─► 核对 ─┬─► 全员认可同一版 ─► 纪要 ─► 结束
                                               ▲             │
                                               └── 合并 Rn+1 ◄┘（有新反对意见）
```

### 1. 密封独立方案

- 每个参会者收到 brief 和本阶段要求，独立写一份 `proposal`，用 `agora_board post` 加 `sealed: true` 提交（草稿机制见 [board.md](board.md#可见性与密封草稿)）。
- 阶段在全部提交或超时（`sealedPhaseMinutes`，默认 20，待定）后结束。超时未交的参会者记一条 `status` 条目“缺席”。
- 揭示时所有草稿在一个事务里转为公开条目。

### 2. 交叉质疑

- 每个参会者收到其他人的方案（增量投递），本阶段要求对每份他人方案至少给出一种回应：`objection`（具体风险、反例、证据缺口）、`evidence`、`question`，或一条 `status` 说明“无反对意见”并给出理由。
- 没有新证据时允许直接说明，不强迫为继续而发言。
- 所有人完成后进入合并。

### 3. 合并

- 合并人收到全部方案和质疑，写一份合并稿：`proposal`，`supersedes` 各方原方案，`meta.revision = { meetingId, number: n }`。
- 合并稿必须在 `meta.responses` 里**逐项回应**所有尚未关闭的反对意见：

  ```json
  { "responses": [
      { "objection": "be_42", "resolution": "accepted", "where": "第 3 节" },
      { "objection": "be_47", "resolution": "rejected", "reason": "……" } ] }
  ```

  daemon 在 `post` 时做结构检查：未回应的反对意见 id 列表非空就拒绝提交，并把缺失的 id 返回给合并人。
- 合并稿提交后即冻结：daemon 记录修订号和条目 `hash`，之后不可修改，只能出新修订。

### 4. 核对

- 其他参会者收到合并稿，逐项核对：合并稿是否遗漏或歪曲了自己的方案和反对意见，回应是否成立。
- 结论二选一：
  - **认可**：`agora_meeting endorse`，见下节；
  - **不认可**：提交新的 `objection`（引用合并稿）。
- 合并人自己也要显式认可合并稿。

### 5. 迭代

- 有新的反对意见 → 合并人出下一版修订（回到第 3 步）。
- 全员认可同一版修订 → 进入纪要。

## 反对意见的关闭与重开

每条 `objection` 在 `meeting_objections` 表里有状态：

| 状态 | 进入条件 |
| --- | --- |
| `open` | 提交时 |
| `addressed` | 某版合并稿的 `meta.responses` 回应了它（`accepted` 或 `rejected`） |
| `closed` | 作者认可了回应它的修订或之后的修订；或作者发 `status` 条目撤回（`meta.withdraws`）；或召集人写 `decision` 裁定关闭（`meta.closes`） |

- `addressed` 不等于关闭：作者不接受回应时，用新的 `objection` 重开，`meta.reopens` 指向原条目。重开的反对意见是新的 `open` 条目，合并人必须在下一版回应；原条目保持原状态，保留历史。
- 参会者对当前修订提交反对意见时，自动撤销自己对该修订的认可。
- 合并稿的结构检查只看 `open` 的反对意见（含重开的）。

## 认可与版本绑定

```ts
// 草案，P0 后冻结
interface EndorseParams {
  action: "endorse";
  meetingId: string;
  revisionEntryId: string;     // 被认可的合并稿条目
  revisionHash: string;        // 必须等于该条目的 hash
  verified: string[];          // 已核对的项目，至少 1 项
  risks: string[];             // 遗留风险，没有时写 ["无"]
}
```

- 认可绑定不可变的修订条目 id 和 hash。`revisionHash` 与当前条目不一致时拒绝。认可还要通过阶段 fencing 检查（见“阶段 fencing”），只能认可当前修订。
- 合并人出了新修订，旧修订上的所有认可自动失效。
- **沉默、超时都不算认可**。核对阶段超时（`reviewPhaseMinutes`，默认 20，待定）未表态的参会者记为“未表态”，会议不能进入纪要，转为暂停询问召集人。
- 认可同时写入 `meeting_endorsements` 表和一条 board `status` 条目（`meta.endorsement` 带上述字段），所有人可见。
- “全员认可”只说明参会者对同一版没有异议，不等于方案正确。纪要必须带上每位认可者列出的已核对项和遗留风险。

## 调度

- 每个阶段，daemon 给需要发言的参会者发一条 `agora:meeting-turn` 自定义消息：本阶段要求 + board 增量（格式见 [board.md](board.md#投递内容格式)），触发一轮。
- 同一阶段内各参会者并行运行。会议开始时已经为每个席位保留了一个推理名额，会议进行中不会因拿不到名额而停住（规则见 [architecture.md](architecture.md#名额优先级)，待定）。
- 参会者 settled 后，调度器检查本阶段的完成条件，满足后推进到下一阶段。
- 参会者不会因自己发的条目被唤醒。
- 参会者在会议中可以用 `agora_request ask` 向召集人提问，提问期间会议暂停在当前阶段。
- 会议的所有状态迁移经过该会议的串行控制队列；席位处于停止中时不投递新的阶段消息（见 [architecture.md](architecture.md#控制队列与并发)）。

### 阶段 fencing

会议中的消息和产物可能晚到：参会者在旧阶段开始的运行，可能在阶段已经推进（或被 `decision` 重置）之后才提交条目。daemon 用 `phaseEpoch` 区分：

- 每次进入一个阶段（包括被 `decision` 打回合并阶段、从暂停恢复），`phaseEpoch` 加 1。
- `agora:meeting-turn` 消息带 `phaseEpoch` 和本阶段的目标修订（如核对阶段要核对的修订条目 id）。agora 扩展记住最近一次注入的阶段消息，参会者之后的 `post` 和 `endorse` 自动带上这两个值，不需要模型填写。
- daemon 在**同一个事务**里校验：会议当前阶段、席位仍为 `active`、`phaseEpoch` 等于当前值、目标修订等于当前修订。
- 校验不通过的条目照常追加到 board（保留历史），但标为过时（`stale: true`，界面显示“旧阶段产物，不计入”），不计入任何完成条件；过时的认可不写入 `meeting_endorsements`。书记在纪要的“保留的分歧”里列出过时的反对意见。
- 阶段推进或重置时，仍在运行的席位先停止（`clear_queue` + `abort`），确认结束后才投递新阶段的消息。

### 并发到达

同一会议的认可和反对意见在 daemon 内串行处理，每次处理都在同一事务里重新计算完成条件（全部 `active` 席位认可当前修订，且没有针对当前修订的 `open` 反对意见）：

- **最后一个认可先提交**：完成条件满足，会议在该事务内进入 `minuting`，`phaseEpoch` 加 1。随后到达的反对意见因 `phaseEpoch` 过时而只记录不计入，书记把它写进纪要的“保留的分歧”，并在召集人收到的纪要通知里单独列出。
- **反对意见先提交**：完成条件不满足，随后的认可照常记录；合并人按反对意见出下一版修订，旧修订上的认可随之失效。

## 僵局检测

MVP 只用循环次数上限：

- 每完成一次“合并—核对”循环计数一次。达到 `maxCycles`（默认 6，待定）仍未全员认可 → 会议**暂停**，不自动结束。
- 给召集人发决策请求，附各方立场摘要：每位参会者当前坚持的反对意见、对应的合并稿回应、双方引用的证据。
- 召集人选择：裁决（写一条 `decision`，会议继续，循环计数清零）、调整参会者、结束会议（生成纪要，停止原因为“僵局”）。

后续版本再加入“无实质进展”的启发式判断（如反对意见文本的 3-gram Jaccard 相似度、合并稿的改动比例），用于在达到上限前提前暂停。启发式只用来暂停并交给召集人，不用来直接结束会议。

## 预算与时长上限

上限只是安全阀，不是流程的正常结束条件。MVP 的预算是**软上限、尽力记账**：达到上限后会议会暂停，但实际用量可能略超上限，超出多少不做保证。

### 记账

预算按每一次模型请求记在会议的共享账本（`budget_ledger` 表）里，账本的每次记账都是一个 SQLite 事务，多个席位并发时不会重复计算。

- **请求开始**：每个席位和书记里的 agora 扩展在 `before_provider_request` 钩子里（依据：`docs/extensions.md` 的 `before_provider_request`，该钩子在每次请求发出前触发）向 daemon 报告一次请求和本次估算（当前上下文估算 + 输出上限），计入调用次数和预留额度。钩子不等待 daemon 的批准，不拖慢请求。
- **请求结束**：按实际 `usage` 结算（来自 `message_end` 的助手消息用量；非助手消息的用量来自会话文件中的用量记录，依据：`docs/session-format.md`），释放预留与实际的差额。没有结算的预留在 run 结束时按预留值计入。
- **计数规则**：

  | 情况 | 计数 |
  | --- | --- |
  | pi 的自动重试 | 每次重试是一次新请求，经过钩子，单独记账 |
  | 模型服务 SDK 内部的重试 | 不经过钩子，看不到单独的请求，只能计入最终返回的用量；可能少计 |
  | 上下文压缩 | 只记压缩产生的汇总用量，不细分到每次请求 |
  | cache warming | 协作会话默认禁用：agora 扩展对 `cache_warming_decision` 返回 `{ action: "stop" }`（依据：`docs/extensions.md` 的 `cache_warming_decision`）。若仍发生，用量按会话文件中的记录计入 |
  | 失败的请求 | 计调用次数；token 按实际返回的用量计 |

- **达到上限**：某次记账后参会者的累计用量达到 `maxTokens - diagnosticReserveTokens`，或调用次数等其他任一上限，daemon 不再投递新的阶段消息，并停止正在运行的席位（`clear_queue` + `abort`）。停止之前已经发出的请求、SDK 内部重试和压缩仍会产生用量，所以最终用量可能略超上限。
- 账本中的用量和纪要里的数字都标为“记账值”，与模型服务的账单可能不一致；超出上限的部分在纪要中如实列出。

硬上限（请求发出之前就拦住）不在 MVP 内，见“以后可能做”。

### 时长

`maxDurationMinutes` 由 daemon 的独立定时器计时，不依赖席位的事件。到期后会议不再投递新的阶段消息；仍在运行的席位最多再运行 `durationGraceMinutes`（默认 5，待定），之后停止。

### 触发

- 任何一项上限触及 → 会议暂停，给召集人发决策请求：提高上限后继续、立即结束并出纪要、放弃。提高上限的权限见上文“参数”中的封顶规则。
- **诊断额度**：`diagnosticReserveTokens` 只用于书记写纪要和通知，让“暂停后结束”时尽量还能产出纪要。预算是软上限，参会者超出的部分可能已经用掉预留，所以不保证一定能写出纪要；预留不够时书记仍会启动，超出部分如实记账。
- 费用（货币）只做估算展示，不作为限制：各模型服务的计价和缓存计费**未核实**。

### 以后可能做

- 硬上限：需要在请求发出之前拦住，例如关闭模型服务 SDK 的内部重试并让 daemon 批准每次请求，或经由一个记账网关转发模型请求。

## 插话

召集人和用户都可以在会议进行中发言，内容进入 board，带作者身份：

| 方式 | 写成 | 效果 |
| --- | --- | --- |
| 补充信息、提问 | `question` 或 `evidence` | 在下一次投递时送达所有参会者，不中断当前阶段 |
| 硬约束、裁决 | `decision` | 当前阶段暂停；正在运行的席位停止；调度器从合并阶段重新开始（`phaseEpoch` 加 1），之前阶段的晚到产物按“阶段 fencing”标为过时；合并稿必须回应该 decision |

接口：`agora_meeting interject { meetingId, kind, body, refs? }`；用户用 CLI `agora meeting interject` 或 pi-pane 会议节点上的插话动作。用户插话以 user 为作者，是用户级操作，需要用户确认。brief 不能被无记录地修改，所有变更都以条目形式留在 board 上。

## 书记与纪要

### 书记

- 独立会话（`kind = secretary`，档位 `explore`），只能读 board 的公开条目，不能读密封草稿，也不能读参会者的对话。
- `secretary.mode`：`final-only`（只在收尾时启动书记写纪要）或 `checkpoint`（另外在每次揭示和每次合并后启动一次，写 `summary` 条目，供参会者和召集人跟进）。两人会议默认 `final-only`，三人及以上默认 `checkpoint`。
- 首个会议版本只实现 `final-only`，`checkpoint` 在后续版本加入（见 [roadmap.md](roadmap.md#mvp-切分)）；在此之前三人及以上的会议也按 `final-only` 运行。
- 书记的模型和参会者无关，默认用配置里的书记模型（如 Gemini）。

### 纪要格式

纪要是一条 board `summary` 条目（`meta.minutes = true`），同时作为会议结果返回给召集人。

```markdown
# 会议纪要：<议题>

- 会议：mt_xxx　召集人：<名称>　参会：<名称（模型，角色）>…　书记：<名称（模型）>
- 资料版本：<brief 条目 id、资料路径、git commit（如有）>

## 定稿方案
<最后全员认可的修订条目全文或链接；未达成认可时写“未定稿”及最后一版修订>

## 共识
- <要点>（依据：be_xx、be_yy）

## 保留的分歧
- <分歧点>：<各方观点、证据、反驳、未解决原因>

## 未决问题
## 风险
- <认可者列出的遗留风险，注明来源>

## 待拍板项
- <需要召集人或用户决定的事项及选项>

## 费用与停止原因
- token（记账值）：<输入/输出/缓存读>　调用次数：<n>　时长：<分钟>　估算费用：<金额，标注为估算>
- 停止原因：<全员认可 | 召集人结束 | 僵局后结束 | 上限后结束 | 放弃>；超出上限的部分（记账值）：<如有>
- 缺席、超时、未表态：<列表>
```

## 召集人收到什么

召集人（Agent）只收到以下几类通知，其他讨论过程留在 board 和参会者的存档里：

| 通知 | 时机 |
| --- | --- |
| 会议回执 | convene 成功；排队的会议开始时再发一条 |
| 决策请求 | 循环次数达到上限、上限触发、参会者提问、核对超时 |
| 异常 | 参会者或书记崩溃 |
| 最终纪要 | 会议结束 |

通知走 outbox，规则同 [tasks.md](tasks.md#完成通知与-outbox)，`dedupe_key` 形如 `meeting:<meetingId>:<事件>:<序号>`。

## 崩溃处理

- 参会者崩溃 → 会议暂停（`phaseEpoch` 加 1），，召集人收到异常通知（附诊断）和选项：
  - **恢复**该参会者（原会话重新拉起）；
  - **换人**：新会话继承该席位，`inherits_from` 指向原会话，首条消息是 brief + 当前 board 检查点（生效修订、未关闭的反对意见、decision）；
  - **去掉该席位**继续：之后的“全员认可”不再包括该席位，纪要里记录；
  - **结束**：书记用诊断额度出纪要，停止原因记“参会者崩溃后结束”。
- 书记崩溃 → 召集人可重开书记（新会话，只读 board，不影响已有结论）。
- 召集人不可达，或同一席位连续恢复失败 2 次 → 会议停在 `interrupted`，通知用户（“待处理”），不递归自救。

## 会议状态

```text
convening ─► queued（等名额，可跳过）─► sealed ─► critique ─► merging ⇄ reviewing ─► minuting ─► ended
                         任意阶段 ─► paused ─► （召集人决定后回到原阶段）
                         任意阶段 ─► interrupted（崩溃且无人处理）
```

在 pi-pane 中的状态映射见 [integration.md](integration.md#状态映射)。

表结构（草案）：

| 表 | 主要字段 |
| --- | --- |
| `meetings` | id、board_id、convener_id、topic、deliverable、flow、state、phase、phase_epoch、current_revision、cycle_count、revision、paused_reason、merger_seat、limits、usage、stop_reason、created_at、ended_at |
| `meeting_seats` | meeting_id、name、agora_session_id、model、thinking、role、state（active / absent / removed / replaced） |
| `meeting_revisions` | meeting_id、number、entry_id、hash、created_at |
| `meeting_endorsements` | meeting_id、revision_entry_id、seat_name、phase_epoch、verified、risks、revoked_at、created_at |
| `meeting_objections` | meeting_id、entry_id、author_seat、target_revision、state（open / addressed / closed）、reopens、closed_by、updated_at |
| `budget_ledger` | id、meeting_id、seat_name、run_id、kind（reserve / settle / release）、tokens、calls、created_at |
| `budget_grants` | id、meeting_id、principal_id、kind（convene / raise）、tokens、signed（是否经设备签名）、day、created_at |
