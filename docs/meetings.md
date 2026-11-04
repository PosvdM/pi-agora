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
  maxTokens?: number;            // 所有参会者与书记的输入+输出 token 合计，默认 2 000 000（待定）
  maxModelCalls?: number;        // 默认 200（待定）
  maxDurationMinutes?: number;   // 默认 90（待定）
  maxCycles?: number;            // 合并—核对循环次数，默认 6（待定）
  diagnosticReserveTokens?: number; // 预留给书记纪要和通知，默认 60 000（待定）
}
```

同一模型可以多人参会（如 Astra 和 Sol，或两个 Claude）。同模型参会者必须给不同的 `role`，否则 convene 返回 `400 duplicate_role`，避免两份几乎相同的方案互相附和。

`convene` 立即返回 `meetingId` 和会议节点信息，召集人收到的是**会议回执**，不是讨论流水。

### `agora_meeting` 的其他动作

| action | 谁能用 | 说明 |
| --- | --- | --- |
| `status` | 召集人、用户 | 当前阶段、修订号、认可情况、用量、暂停原因 |
| `interject` | 召集人、用户 | 插话，见“插话” |
| `decide` | 召集人、用户 | 回应决策请求（继续、加额度、裁决、换人、结束、放弃） |
| `stop` | 召集人、用户 | 结束会议；默认由书记出纪要，`skipMinutes: true` 时直接结束 |
| `result` | 召集人、用户 | 取纪要和定稿方案 |
| `endorse` | 参会者 | 认可某版修订，见“认可与版本绑定” |

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

- 认可绑定不可变的修订条目 id 和 hash。`revisionHash` 与当前条目不一致时拒绝。
- 合并人出了新修订，旧修订上的所有认可自动失效。
- **沉默、超时都不算认可**。核对阶段超时（`reviewPhaseMinutes`，默认 20，待定）未表态的参会者记为“未表态”，会议不能进入纪要，转为暂停询问召集人。
- 认可同时写入 `meeting_endorsements` 表和一条 board `status` 条目（`meta.endorsement` 带上述字段），所有人可见。
- “全员认可”只说明参会者对同一版没有异议，不等于方案正确。纪要必须带上每位认可者列出的已核对项和遗留风险。

## 调度

- 每个阶段，daemon 给需要发言的参会者发一条 `agora:meeting-turn` 自定义消息：本阶段要求 + board 增量（格式见 [board.md](board.md#投递内容格式)），触发一轮。
- 同一阶段内各参会者并行运行，受全局并发上限（默认 4）约束。
- 参会者 settled 后，调度器检查本阶段的完成条件，满足后推进到下一阶段。
- 参会者不会因自己发的条目被唤醒。
- 参会者在会议中可以用 `agora_request ask` 向召集人提问，提问期间会议暂停在当前阶段。

## 僵局检测

每完成一次“合并—核对”循环，调度器判断这一循环有没有实质进展。满足以下任意一条算有进展：

- 出现了新的反对意见，且与该作者之前的反对意见不重复；
- 出现了新的 `evidence`；
- 合并稿正文有实质改动；
- 有参会者从不认可转为认可。

重复判定（**阈值待定**，试运行后校准）：

- 反对意见：与同一作者此前针对同一目标的反对意见做规范化（去空白、标点、大小写）后的字符 3-gram Jaccard 相似度 ≥ 0.8，视为重复——换措辞重复同一意见不算进展。
- 合并稿：与上一版的规范化文本差异比例 < 5%，且没有关闭任何反对意见，视为无实质改动。

连续 2 个循环（`stalemateCycles`，待定）没有进展 → 僵局：

- 会议**暂停**，不自动结束；
- 给召集人发决策请求，附各方立场摘要：每位参会者当前坚持的反对意见、对应的合并稿回应、双方引用的证据；
- 召集人选择：裁决（写一条 `decision`，会议继续）、调整参会者、结束会议（生成纪要，停止原因为“僵局”）。

字符相似度只是近似判断，可能误判。所以检测结果只用来暂停并交给召集人，不用来直接结束会议。

## 预算与时长上限

上限只是安全阀，不是流程的正常结束条件。

- **准入**：每次唤醒参会者或书记之前，按“当前上下文估算 + 输出上限”预留额度；剩余额度（扣除 `diagnosticReserveTokens`）不足就不发起这次调用。
- **结算**：调用 settled 后按实际 `usage` 结算，包含失败重试和压缩产生的用量。
- **触发**：任何一项上限触及 → 会议暂停，给召集人发决策请求：增加额度后继续、立即结束并出纪要、放弃。
- **诊断额度**：`diagnosticReserveTokens` 只用于书记写纪要和通知，保证“暂停后结束”时还能产出纪要。
- 费用（货币）只做估算展示，不作为硬限制：各模型服务的计价和缓存计费**未核实**。

## 插话

召集人和用户都可以在会议进行中发言，内容进入 board，带作者身份：

| 方式 | 写成 | 效果 |
| --- | --- | --- |
| 补充信息、提问 | `question` 或 `evidence` | 在下一次投递时送达所有参会者，不中断当前阶段 |
| 硬约束、裁决 | `decision` | 当前阶段暂停；基于旧约束的未完成产出（`basedOnSeq` 早于该 decision）作废；调度器从合并阶段重新开始，合并稿必须回应该 decision |

接口：`agora_meeting interject { meetingId, kind, body, refs? }`；用户用 CLI `agora meeting interject` 或 pi-pane 的会议面板。brief 不能被无记录地修改，所有变更都以条目形式留在 board 上。

## 书记与纪要

### 书记

- 独立会话（`kind = secretary`，档位 `explore`），只能读 board 的公开条目，不能读密封草稿，也不能读参会者的对话。
- 两人会议默认只在收尾时启动书记；三人及以上的会议在每次揭示和每次合并后启动一次，写 `summary` 条目，供参会者和召集人跟进（成本可通过 `secretary.mode = "final-only"` 关闭）。
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
- token：<输入/输出/缓存读>　调用次数：<n>　时长：<分钟>　估算费用：<金额，标注为估算>
- 停止原因：<全员认可 | 召集人结束 | 僵局后结束 | 上限后结束 | 放弃>
- 缺席、超时、未表态：<列表>
```

## 召集人收到什么

召集人（Agent）只收到以下几类通知，其他讨论过程留在 board 和参会者的存档里：

| 通知 | 时机 |
| --- | --- |
| 会议回执 | convene 成功 |
| 决策请求 | 僵局、上限触发、参会者提问、核对超时 |
| 异常 | 参会者或书记崩溃 |
| 最终纪要 | 会议结束 |

通知走 outbox，规则同 [tasks.md](tasks.md#完成通知与-outbox)，`dedupe_key` 形如 `meeting:<meetingId>:<事件>:<序号>`。

## 崩溃处理

- 参会者崩溃 → 会议暂停，召集人收到异常通知（附诊断）和选项：
  - **恢复**该参会者（原会话重新拉起）；
  - **换人**：新会话继承该席位，`inherits_from` 指向原会话，首条消息是 brief + 当前 board 检查点（生效修订、未关闭的反对意见、decision）；
  - **去掉该席位**继续：之后的“全员认可”不再包括该席位，纪要里记录；
  - **结束**：书记用诊断额度出纪要，停止原因记“参会者崩溃后结束”。
- 书记崩溃 → 召集人可重开书记（新会话，只读 board，不影响已有结论）。
- 召集人不可达，或同一席位连续恢复失败 2 次 → 会议停在 `interrupted`，通知用户（“待处理”），不递归自救。

## 会议状态

```text
convening ─► sealed ─► critique ─► merging ⇄ reviewing ─► minuting ─► ended
                         任意阶段 ─► paused ─► （召集人决定后回到原阶段）
                         任意阶段 ─► interrupted（崩溃且无人处理）
```

表结构（草案）：

| 表 | 主要字段 |
| --- | --- |
| `meetings` | id、board_id、convener_id、topic、deliverable、flow、state、phase、paused_reason、merger_seat、limits、usage、stop_reason、created_at、ended_at |
| `meeting_seats` | meeting_id、name、agora_session_id、model、thinking、role、state（active / absent / removed / replaced） |
| `meeting_revisions` | meeting_id、number、entry_id、hash、created_at |
| `meeting_endorsements` | meeting_id、revision_entry_id、seat_name、verified、risks、created_at |
