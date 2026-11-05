# 共享桌面（board）

> 状态：设计草案。字段、条目类型和上限值是草案，P0 验证后冻结。

board 是多个会话共享的、只追加的结构化记录。会议是它最主要的用法；并行开发时的接口约定、跨任务的提问和证据也可以放在 board 上。它不是群聊：每条记录有类型、作者、引用关系和所依据的 board 版本。

## 数据模型

```ts
// 草案，P0 后冻结
interface Board {
  id: string;                 // "bd_..."
  title: string;
  ownerId: string;            // 创建者 principal
  meetingId?: string;         // 属于会议时有值
  members: BoardMember[];
  headSeq: number;            // 最新公开条目序号
  createdAt: string;
}

interface BoardMember {
  principalId: string;
  role: "owner" | "writer" | "reader";
}

interface BoardEntry {
  id: string;                 // "be_..."
  boardId: string;
  seq: number;                // 公开序号，board 内从 1 开始连续递增
  kind: EntryKind;
  authorId: string;           // 由 daemon 根据 token 填写
  authorLabel: string;        // 显示名，如 "Claude（前端视角）"
  body: string;               // Markdown，默认上限 16 KiB
  refs: EntryRef[];
  supersedes: string[];       // 被本条替代的条目 id
  basedOnSeq: number;         // 作者写这条时已看到的公开序号
  meta: Record<string, unknown>; // 各用法的附加数据，如会议的修订号、认可信息
  artifactRefs: string[];     // 附件引用（内容哈希），MVP 只存引用
  hash: string;               // 规范化后的 sha256，供认可绑定
  createdAt: string;
}

interface EntryRef {
  entryId: string;
  rel: "responds" | "cites" | "objects" | "answers" | "implements";
}

type EntryKind =
  | "proposal" | "objection" | "evidence" | "question" | "answer"
  | "contract" | "decision" | "status" | "summary";
```

## 条目类型

| kind | 用途 | 约束 |
| --- | --- | --- |
| `proposal` | 方案或方案修订 | 正文写明假设和依据 |
| `objection` | 反对意见 | 必须有一条 `rel: "objects"` 的引用；写清可检验的理由 |
| `evidence` | 代码片段、实验结果、文档摘录、截图引用 | 写明来源（文件路径和行号、命令和输出摘要） |
| `question` | 向 board 成员提问 | 可以有 `responds` 引用 |
| `answer` | 回答 | 必须有一条 `rel: "answers"` 的引用 |
| `contract` | 并行开发的接口约定 | 修改用新条目 `supersedes` 旧条目 |
| `decision` | 决议或硬约束 | 只有 board owner（召集人）或 user principal 能写；以 user 为作者时是用户级操作，需要用户确认 |
| `status` | 进展、阻塞、缺席、认可等状态 | 会议的认可用 `meta.endorsement`，见 [meetings.md](meetings.md#认可与版本绑定) |
| `summary` | 对某个序号范围的摘要 | `meta.range = [fromSeq, toSeq]` |

条目内容是协作数据，不是授权。正文里写着“用户已批准”不带来任何权限；`decision` 的权威来自 daemon 记录的作者身份。

## 引用与替代

- `refs` 中的条目必须存在，并且对作者可见；否则 `post` 返回 `400 invalid_ref`。
- 修改通过追加新条目并在 `supersedes` 里列出旧条目表达，旧条目永远保留。
- 作者替代自己的条目：旧条目在“当前视图”中折叠到新条目下。
- 替代别人的条目（如会议合并人用合并稿替代各方原方案）：允许，但旧条目在当前视图中仍然单独显示并标注“已被 be_xxx 合并”。替代不抹掉原观点的有效性，原作者可以继续引用或反对。
- 同一条目被两条新条目分别替代时，当前视图显示为冲突，需要一条 `decision` 或新的合并条目解决。
- `basedOnSeq` 让读者看到作者依据的是哪个版本。界面上对 `basedOnSeq` 落后于其引用目标的条目标注“基于旧版本”。

“当前视图”是根据条目计算出的投影，不单独存储，可以随时重算。

## 可见性与密封草稿

会议的首轮方案要求独立完成：提交前其他参会者不能看到。实现方式是**草稿不进入公开序列**：

- 密封草稿存在 `board_drafts` 表，没有公开 `seq`。
- 草稿只对作者本人可见。`read`、`get`、会话流订阅、存档查询（包括 HTTP API 和 archive adapter）都不返回别人的草稿。书记也看不到草稿。
- 揭示（reveal）时，daemon 在一个事务里把所有草稿按参会者顺序追加为公开条目，分配连续的 `seq`，删除草稿行。
- 这样公开序列没有空洞，投递位置不会跨过尚不可见的记录。

草稿揭示后，各参会者会话里自己写草稿时的过程仍在其 pi 对话存档里；存档的读取权限见 [archive.md](archive.md#读取权限)，会议进行中不对其他参会者开放。

## 投递位置与增量

每个 board 成员（Agent 会话）有一个**已确认投递位置** `confirmedSeq`，存在 `board_cursors`。

### 投递流程

1. daemon 决定唤醒某个会话（会议调度或有新条目引用它），取 `(confirmedSeq, headSeq]` 中与它相关的公开条目。
2. 生成一条投递，`deliveryId = <boardId>:<principalId>:<fromSeq>-<toSeq>`，写入该会话的 outbox。
3. 会话里的 agora 扩展收到后用 `pi.sendMessage({ customType: "agora:board-delta", ... }, { triggerTurn: true, deliverAs: "followUp" })` 追加到上下文末尾。
4. 扩展在会话文件里核实带该 `deliveryId` 的自定义消息记录已完整写入后确认，daemon 把 `confirmedSeq` 推进到 `toSeq`。

只有确认后才推进位置。HTTP 请求成功、扩展收到数据、出现 `message_end`、出现在 `getEntries()` 里都不算：`message_end` 先于写入会话文件发出，新会话的条目在第一条对话消息之前只在内存里。确认规则与任务通知相同，见 [tasks.md](tasks.md#投递)。

会话处于停止中（`stopping`）时不投递，等停止完成或新一轮开始后再按 `confirmedSeq` 继续（见 [architecture.md](architecture.md#控制队列与并发)）。被 `clear_queue` 清掉的投递没有写入会话，下次会重发。

### 恢复

- 进程崩溃或回收后重新拉起：从 `confirmedSeq` 重发。之前已注入但未确认的投递会再出现一次，扩展先在会话条目里查找相同 `deliveryId`，找到就直接确认，找不到就注入。
- 原则是**宁可重发，不漏读**：重复几条条目的 token 成本可以接受，漏掉一条反对意见不可以。
- MVP 不支持在运行中切换会话分支；会话分支发生变化（如 fork）时视为新会话，从头投递摘要。

### 投递内容格式

```text
【agora board 增量】bd_7c1 #41–#45（共 5 条，依据 #40 之后）
#41 proposal  Claude（前端视角）  基于 #38
  ……正文……
#42 objection Astra（算法审查）  反对 #41
  ……正文……
（#43–#45 正文较长，已省略；用 agora_board get 读取：be_91, be_92, be_93）
```

- 单次投递默认最多 30 条、24 000 字符（`maxDeliveryEntries`、`maxDeliveryChars`）。超出部分只列条目 id、类型和标题，由会话按需用 `get` 读取。
- 不投递作者自己的条目（作者已在自己的上下文里看到）。

## 给 Agent 的工具

`agora_board`，只注册给绑定了 board 的会话和召集人。

```ts
// 草案，P0 后冻结
type AgoraBoardParams =
  | { action: "read"; boardId?: string; afterSeq?: number; kinds?: EntryKind[]; limit?: number } // limit 默认 30，最大 100
  | { action: "get"; boardId?: string; ids: string[] }                                         // 最多 20 条
  | { action: "post"; boardId?: string; kind: EntryKind; body: string; refs?: EntryRef[];
      supersedes?: string[]; basedOnSeq: number; meta?: Record<string, unknown>;
      idempotencyKey: string; sealed?: boolean };   // sealed 只在会议密封阶段可用
```

- 会话只绑定一个 board 时 `boardId` 可省略。
- `read` 只返回公开条目，不推进投递位置（投递位置只由投递确认推进）。
- `post` 的 `idempotencyKey` 由调用方生成，同一 key 重复提交返回第一次的结果，防止工具重试产生重复条目。
- `basedOnSeq` 必填，由 Agent 填写它最后看到的序号。daemon 不校验它是否真实，只用于展示。会议中判断条目是否属于当前阶段用的是 daemon 自己记录的 `phaseEpoch`，不是 `basedOnSeq`。
- **不提供阻塞等待（wait）**。需要等别人发言时，Agent 结束本轮，由 daemon 在有新条目时唤醒。

召集人和用户在 CLI 或 pi-pane 里发条目时走同一个 HTTP 接口，作者是对应的 principal。以 user 为作者的条目是用户级操作，经用户确认后写入（见 [security.md](security.md#用户确认)）。各角色的读写权限见 [security.md](security.md#board)。

会议中的条目还要通过阶段 fencing 检查（`phaseEpoch`、目标修订），旧阶段的晚到条目照常追加但标为过时，见 [meetings.md](meetings.md#阶段-fencing)。

## prompt cache 的考虑

很多模型服务对请求前缀做缓存，前缀不变时后续请求更便宜、更快。board 的投递方式按这个前提设计：

- **只往上下文末尾追加**，不修改系统提示词，不在前面插入“最新完整 board”，不改写已发送的消息。
- 纠错和更新也追加为新条目，不回头修改已投递内容。
- 每次投递只包含新增条目，大材料通过 `get` 按需读取。
- pi 自动压缩上下文后（扩展收到 `session_compact` 事件，依据：`dist/core/extensions/types.d.ts`），下一次投递先附一份检查点：当前生效的方案版本、未解决的反对意见、生效的 decision 和 contract，再接着给增量。压缩本身会让缓存失效，这是可接受的代价。

增量投递不等于历史不再计费：历史仍在上下文里，能否命中缓存取决于模型服务、适配器和缓存有效期。**各模型的实际缓存命中情况未实测**，P0 用会话事件里的 `usage.cacheRead` 观察（依据：`docs/json.md` 的 `message_update.usage`）。

## 存储

| 表 | 内容 |
| --- | --- |
| `boards` | Board 字段 |
| `board_members` | boardId、principalId、role |
| `board_entries` | BoardEntry 字段；`(board_id, seq)` 唯一；只插入；会议条目另记 `phase_epoch`、`stale` |
| `board_drafts` | 密封草稿：boardId、authorId、kind、body、refs、meta、createdAt |
| `board_cursors` | boardId、principalId、confirmed_seq、pending_delivery_id、updated_at |

`board_entries` 的插入、`boards.head_seq` 的更新、相关 outbox 投递记录在同一事务内完成。
