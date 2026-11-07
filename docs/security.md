# 安全模型

> 本文描述完整安全设计。切片 1b 实现 principal、租约、launch ticket、最终就绪、三档路径检查，以及任务树的直接召集关系与权限限制。完整用户级确认、设备配对、审计和资源 ACL 在 1c。1b 的 CLI 可以直接答复提问，尚不能区分用户与同一系统用户下的 Agent。

本文定义 agora daemon 的身份、鉴权、用户确认、设备配对、资源访问控制、审计和剩余风险。进程与存储见 [architecture.md](architecture.md)，平台相关的实现（密钥目录权限、路径规范化）见 [pi-hostkit 设计文档](https://github.com/PosvdM/pi-hostkit/blob/main/docs/design.md)，HTTP 端点见 [integration.md](integration.md)。

## 前提与目标

- 子代理（尤其是开了 `bash` 的 implement 档位）和用户是**同一个操作系统用户**。用户能读的文件，子代理都能读；不存在绝对隔离。
- 目标是堵住“读一个文件 + 用 curl 调接口”这类低成本冒充：子代理不能仅凭磁盘上的东西以用户身份答复自己的提问、超过封顶给会议加预算、批准设备或关闭保护。
- 三个平台使用同一套方案，不依赖系统钥匙串、DPAPI 或浏览器密码管理。
- 剩余风险照实写在“剩余风险”一节，文档和界面不宣称更强的隔离。

## 权限级别

| 级别 | 谁 | 凭证来源 | 能做什么 |
| --- | --- | --- | --- |
| 子 Agent 级 | `agent:child`（任务、参会者、书记） | launch ticket 换来的连接 token | 按档位做自己的工作；任务子代理在限制内派下级，查看、返工、停止及答复自己直接派出的任务；向直接上级提问或逐级转交。不能做主 Agent 级或用户级操作；board 与会议权限随对应切片提供 |
| 主 Agent 级 | `agent:main`（主代理，用户的代理人）；`host:cli`、`host:pane` | 磁盘凭证（`secret/` 下的文件） | 派任务、召开会议、返工、停止、读取、转发、发起待确认；`agent:main` 还可以裁决自己召集的会议、答复发给自己的提问、在 `agentLimitCap` 以内提高自己会议的上限（见 [meetings.md](meetings.md#参数)） |
| 用户级 | `user` | 已配对浏览器的设备密钥对 daemon 挑战的签名 | 见下表 |

**磁盘上的任何凭证都只有主 Agent 级权限**。daemon 没有用户密钥文件；用户身份只来自浏览器设备签名（或在关闭保护后来自 CLI，见“只用终端”）。`host:cli`、`host:pane` 代表用户的界面，但不代表用户本人：它们发起的用户级操作都要用户确认，也不享有 `agent:main` 的封顶内提高上限的权限。

用户级操作：

| 操作 | 说明 |
| --- | --- |
| 超过封顶的预算和上限 | 主 Agent 为自己的会议设定或提高的上限超过 `agentLimitCap`；用户召集的会议超过 `meetingLimitDefaults` 或之后的任何提高 |
| 以用户身份答复、取消提问 | 主 Agent 明确转给用户（`escalated`）的提问、召集人是 `user` 的提问，以及召集人不可达时转到用户“待处理”的提问 |
| 用户召集的会议的决定 | 用户召集的会议的 `decide`；召集人不可达时转给用户的会议决策和中断任务的处理（resume / reopen / replace / abandon） |
| 以 `user` 为作者写 board 条目 | 包括会议插话；条目的权威来自作者身份，所以必须确认 |
| 设备与安全设置 | 批准、撤销设备；在线重置配对；关闭 `userConfirmation`；调高 `meetingLimitDefaults`、`agentLimitCap`；`agora takeover` 强制转移主会话的控制租约；把任务的召集人改为 `user`（接管） |
| 删除存档 | `agora archive delete` |

主 Agent 对自己召集的任务和会议做的决定（返工、停止、处理中断、裁决、封顶以内的提高上限）不需要用户确认。

## principal

principal 是 daemon 里的行为主体。所有任务、提问、board 条目、会议和审计记录都记到 principal。daemon 只信任自己签发的连接 token，**请求体里的任何身份字段都被忽略**。

| 类型 | 说明 | 权限级别 |
| --- | --- | --- |
| `user` | 当前操作系统用户，每个数据目录一个；只通过用户确认出现，没有连接 token | 用户级 |
| `host:cli` | `agora` CLI | 主 Agent 级（不含封顶内提高上限） |
| `host:pane` | 运行在 pi-pane 服务端的 agora pane 插件 | 主 Agent 级（不含封顶内提高上限） |
| `agent:main` | 一个主代理会话（终端或 pi-pane 托管），绑定 pi 的 sessionId | 主 Agent 级 |
| `agent:child` | daemon 拉起的协作会话（kind = task / meeting-seat / secretary） | 子 Agent 级 |

- 任务的召集人（convener）是直接派出该任务的 `agent:main`、任务 `agent:child` 或 `user`。任务子代理可以成为自己直接下级的召集人；更高层祖先不因任务树关系成为直接召集人。
- 会议的召集人只能是 `agent:main` 或 `user`。`host:cli` 和 `host:pane` 创建任务和会议时召集人记为 `user`，同时记录实际发起的 principal；创建本身是主 Agent 级操作，之后对这些资源做的用户级决定仍需确认。
- 任务子代理可以在配置和父子树限制内派下级，不得升级档位或放宽层数 / 下级数；不能召开会议。所有子任务管理在 daemon 按 token 的 principal 和任务树核对，不按 cwd 授权。

## 磁盘凭证与连接 token

```text
<AGORA_HOME>/secret/          # 目录仅当前用户可访问，见 pi-hostkit 设计文档“密钥目录权限”
  host.key                    # 32 字节随机数，首次启动生成
  principals/<principalId>.key  # 主会话的恢复凭证
```

### 握手

CLI、pane 插件和主会话里的扩展用 `host.key` 与 daemon 双向握手：

1. 客户端 `POST /v1/auth/challenge`，带随机 `clientNonce`；daemon 返回 `serverNonce`、`instanceId` 和 `serverProof = HMAC(hostKey, "server" | clientNonce | instanceId)`。客户端校验 `serverProof`，确认对方是同一数据目录的 daemon，防止端口被别的程序占用后冒充。
2. 客户端 `POST /v1/auth/token`，带 `clientProof = HMAC(hostKey, "client" | serverNonce | instanceId)` 和想要的身份：`host:cli`、`host:pane`，或注册/认领主会话。daemon 校验后签发连接 token。

握手证明的消息编码为 UTF-8 的 `JSON.stringify([方向, nonce, instanceId])`，HMAC 使用 SHA-256，证明以 base64url 编码。challengeId 标识有效期为 60 秒的一次性挑战，兑换时消费，失败后也不能重放。主会话恢复证明使用恢复凭证计算 `HMAC-SHA256(JSON.stringify(["reclaim", principalId, sessionId, connectionId, instanceId]))`，同样以 base64url 编码；绑定本次连接，不能转用到另一连接或 daemon 实例。

连接 token 是不透明随机串，绑定 principalId、connectionId 和权限范围，默认有效期 1 小时，过期前可续期；daemon 重启后全部失效。token 不出现在工具结果、会话内容和日志里。

`host.key` 和恢复凭证被子代理读到时，子代理最多获得主 Agent 级权限，这是设计上接受的（见“剩余风险”）。

### 主会话注册与恢复

主代理的 agora 扩展在 `session_start` 时：

1. 用 `host.key` 握手。
2. 查当前会话里有没有 `customType = "agora-principal"` 的条目（`pi.appendEntry` 写入，依据：`dist/core/extensions/types.d.ts` 的 `appendEntry`）。
   - 没有：`POST /v1/principals/register`，带 pi 的 `sessionId` 和会话文件路径。daemon 创建 `agent:main` principal，生成恢复凭证写到 `secret/principals/<principalId>.key`，返回 principalId。扩展用 `appendEntry` 只记 `{ principalId }`，不记凭证。
   - 有：`POST /v1/principals/reclaim`，带 principalId、当前 pi `sessionId` 和用恢复凭证做的证明。daemon 校验凭证，并检查 pi `sessionId` 与注册时一致。
3. 认领成功后取得该 principal 的**控制租约**。

- 凭证不写进会话：`appendEntry` 的内容会随会话导出、复制、fork，只能当引用。
- **fork / clone**：新会话的 pi `sessionId` 不同，`reclaim` 被拒绝，扩展转为 `register` 新 principal，并带上 `forkedFrom`（原 principalId）供展示。fork 不继承原会话的任务和通知。
- **控制租约**：同一 principal 同时只允许一个连接持有租约（续租间隔 30 秒，90 秒未续视为释放）。第二个连接认领时返回 `409 lease_held`。强制转移用 `agora takeover <principalId>`，属于用户级操作。
- 托管进程被扩展命令切换会话时（`session_shutdown` 后 `session_start`，`reason` 为 `new`、`resume` 或 `fork`，依据：`docs/extensions.md` 的 Session Events 一节），扩展释放旧 principal 的租约，再按上述流程处理新会话。

### 协作会话

daemon 拉起协作会话时生成一次性 launch ticket，经环境变量 `AGORA_LAUNCH_TICKET` 传入。扩展启动后立即用 `POST /v1/auth/launch` 兑换连接 token，并从 `process.env` 删除该变量，避免 `bash` 子进程继承。ticket 绑定 runId，60 秒内有效、只能兑换一次；进程退出后对应 token 作废，重新拉起换新 ticket。环境变量在被删除之前对同一进程里的其他代码可见，实际暴露范围：

- explore、review、会议席位和书记用 `-ne` 只加载 agora 扩展，进程里没有其他扩展。
- implement 可能按配置加载白名单扩展和 `builtin:mcp`。agora 扩展排在 `-e` 的第一位，在工厂函数里同步读取并删除该变量。P0 实测证明：首位扩展删除该变量后，后续扩展工厂、MCP 服务器进程和 `bash` 子进程均无法读取 ticket；即使 `builtin:mcp` 排在前面，MCP 进程也是在变量删除后才启动。若排在前面的其他扩展读到 ticket 并抢先兑换，pi 会以退出码 1 退出，被宿主捕获为启动故障而不予重试。此外，为了防止未列入白名单的 MCP 服务器产生后台副作用，agora 会为每个子代理单独生成只包含白名单服务器的 MCP 配置文件。
- 读到 ticket 的代码最多抢先兑换它：ticket 只能兑换一次，被抢先后 agora 扩展兑换失败，就绪检查不通过，run 被结束（见 [architecture.md](architecture.md#受管扩展的就绪检查)）；抢到的 token 只有该协作会话自己的权限，且随进程退出作废。兑换之后还要完成受管扩展的就绪检查，见 [architecture.md](architecture.md#受管扩展的就绪检查)。

## Skill 白名单

`spawn.skills` 只接受名字，不接受路径。驱动从用户的 `~/.pi/agent/skills` 和用户 `~/.pi/agent/settings.json` 的 `skills` 路径解析 skill；`PI_CODING_AGENT_DIR` 可替换用户 agent 目录。daemon 的 `skillDirectories` 配置为显式目录时，仅在这些目录内查找。项目目录的 `.pi/skills` 和项目 settings 不参与解析。解析失败或名字有歧义时拒绝 spawn，不回退到项目 skill。

未指定 `skills` 时使用 `defaultSkills` 对应档位的默认值，未配置时为空；显式名单覆盖默认值。下级名单只能取上级名单的子集，不能通过默认值扩大。配置示例：

```json
{
  "defaultSkills": { "explore": [], "review": [], "implement": ["project-docs"] },
  "quotaRecovery": "notify"
}
```

子进程使用 `-ns` 禁用 skill 自动加载，仅用 `--skill <真实路径>` 加载选中的 skill。任务书包含子代理标记，但不禁用全局或项目 `AGENTS.md`。

名单内 skill 的真实目录作为独立的只读根传给受管扩展：explore/review 可以用 `read`、`grep`、`find`、`ls` 读取该目录，名单外目录没有这项额外授权；所有档位的 `edit`、`write` 都不能修改名单内的 skill 目录。路径规范化、符号链接和受保护目录规则仍然适用，skill 名单不覆盖凭证目录保护。

implement 档位可以用 shell 运行 skill 附带的脚本。shell 不做路径隔离，也不能靠 skill 只读根约束脚本的副作用；名单用于限制自动加载和文件工具授权，不构成操作系统沙箱。若名单外 skill 本身位于原本允许的工作目录，文件工具仍按已有的允许根规则处理；该 skill 不会自动加载。

## 用户确认

本节是 1c 的设计目标。1b 只提供转交和 host:cli 直接答复通路，答复标注 confirmedBy: none；host:pane 不接受此直接执行路径。任何能取得 host.key 的同用户进程都能通过 CLI 身份答复，不能将 1b 声称为已实现用户防冒充。预算封顶、待确认、设备和安全审计尚未开放。

用户级操作必须由已配对浏览器对 daemon 下发的一次性挑战签名，daemon 验签后才执行。pi-pane 服务端只转发，无法伪造签名；pi-pane 的 HTTP 接口没有任何 Agent 可用的凭证（pi-pane 的鉴权见其 `docs/architecture.md`）。

### 挑战

```ts
// 草案，P0 后冻结
interface UserChallenge {
  action: string;        // 如 "agora.request.answer"、"agora.meeting.limits"、"agora.device.approve"
  target: string;        // 目标对象 id，如 "rq_31c0"
  paramsHash: string;    // 请求参数的 sha256（base64url），参数按规范 JSON 序列化
  nonce: string;         // 随机，只能用一次
  expiresAt: string;     // ISO 时间
}
```

- daemon 在用户级请求到达时生成挑战，并把挑战与完整的请求参数一起存为一条**待确认**（`pending_confirmations` 表）。签名只对这条待确认有效。
- 浏览器签名的对象是 pi-pane 定义的 `{ domain: "pi-pane/user-presence/v1", payload: <UserChallenge> }` 的 UTF-8 规范 JSON，算法 `ECDSA-P256-SHA256`。规范 JSON 按 RFC 8785（JCS），签名为 IEEE P1363 格式，daemon 用 Node.js 验签时指定 `dsaEncoding: "ieee-p1363"`；细节以 pi-pane `docs/plugin-api.md` 的“签名格式”为准。`paramsHash` 同样对 JCS 规范化的请求参数计算。
- 有效期：由 pane 当场发起的确认默认 5 分钟；由 CLI 发起、等待用户在浏览器里处理的默认 24 小时。过期后待确认变为 `expired`，不执行。

### 验签

daemon 收到签名后依次检查，任何一步失败都拒绝并写审计：

1. 待确认存在、状态为 `pending`、未过期；
2. `nonce` 未被使用过（使用后立即作废，并发提交只有一次成功，另一次返回 `409 already_handled`）；
3. `deviceId` 是已配对设备，请求中的 `publicKey` 与配对时记录的公钥一致；
4. 签名有效；
5. 挑战的 `action`、`target`、`paramsHash` 与待确认中保存的请求一致；
6. 目标对象的当前状态仍允许该操作（如提问仍为 `escalated`）。

通过后 daemon 以 `user` 身份执行原请求，并在同一事务里把待确认标为 `confirmed`、写审计。

### 经 pi-pane 确认

```text
浏览器点击动作 ─► pane 插件 invoke（带 RequestOrigin）
  ─► daemon 用户级端点（Agora-Act-As: user）─► 202 { confirmationId, challenge, title, summary }
  ─► ctx.userPresence.confirm({ title, summary, payload: challenge, origin }) ─► 浏览器弹出确认，用户点击后签名
  ─► POST /v1/confirmations/:id/sign { deviceId, publicKey, alg, signature } ─► 执行，返回原操作的结果
```

- `title` 和 `summary` 由 daemon 根据请求参数生成，描述实际要执行的操作（如“答复提问 rq_31c0：选择‘方案 B’”），不使用调用方提供的文字。
- 待处理区里的持久表单（如转给用户的提问）走同样的流程，只是入口是 `forms.submit`，确认框出现在提交的标签页（见 [integration.md](integration.md#表单)）。
- `userPresence.confirm` 的接口、签名格式和 `UserPresenceError` 的取值以 pi-pane `docs/plugin-api.md` 为准。pane 插件的处理：`rejected` → 调用 `POST /v1/confirmations/:id/cancel`；`timeout`、`noDevice`、`unsupported` → 待确认保留到过期，并在 pi-pane 的“待处理”区以持久表单列出，用户可以稍后再确认。
- 动作调用的 `idempotencyKey` 原样作为 `Idempotency-Key` 头传给 daemon，同一次点击的重试不会生成第二条待确认。

### 经 CLI 发起

CLI 执行用户级操作时，daemon 只生成一条待确认并返回 `202 confirmation_required`，CLI 显示“已提交，请在已配对的浏览器中确认（confirmationId）”。pane 插件收到 `confirmation:<id>:created` 通知后，用 `ctx.formAdded()` 在“待处理”区列出，表单写明操作内容、发起方（如“由 CLI 发起，无法区分是你本人还是 Agent”）和过期时间；用户提交时再走上面的签名流程。CLI 可以用 `agora confirmations` 查看状态，用 `--wait` 等待结果。

“发起待确认”是主 Agent 级操作；子代理自己的 token 不能发起，但读到 `host.key` 的子代理可以经 CLI 发起。待确认的表单必须显示真实的发起 principal，用户不认识的待确认应当拒绝。

## 设备配对

设备是浏览器里由 pi-pane 前端生成并保存的不可导出签名密钥（WebCrypto，存于 IndexedDB），`deviceId` 和公钥由 `userPresence.confirm` 和 `ctx.userPresence.devices()` 提供（以 pi-pane `docs/plugin-api.md` 为准）。

### 配对状态

daemon 在 `settings` 表里持久记录两个独立的状态：

| 状态 | 含义 | 何时变化 |
| --- | --- | --- |
| `everPaired` | 是否曾有设备配对成功 | 第一次配对成功后置为 `true`，之后永不回到 `false`（撤销、重置都不改它） |
| `reTofuArmed` | 下一次配对是否可以不经批准直接接受 | 只由离线重置（`agora offline pair-reset`）置为 `true`；下一次配对成功时，在同一个事务里消费（置回 `false`） |

配对端点（`POST /v1/devices/pair`）按下面三种情况处理，判断和写入在同一个事务里完成，两个浏览器同时配对时只有一个能消费 TOFU 或 `reTofuArmed`：

| 情况 | 处理 |
| --- | --- |
| `everPaired = false`（从未配对） | TOFU：直接配对，`everPaired` 置为 `true` |
| `everPaired = true` 且 `reTofuArmed = true`（离线重置后） | 直接配对并消费 `reTofuArmed`；写审计；设备重置的安全警告保持，直到被确认知悉（见下文） |
| 其他（普通新增） | 进入“待批准设备”，由已配对设备签名批准（用户级操作 `agora.device.approve`） |

- **配对动作的签名**：前两种情况下没有已配对设备，daemon 只能验证新设备持有自己的私钥：配对挑战（`action: "agora.device.pair"`）由新设备自己的密钥签名，daemon 用请求里附带的公钥验证。这种“自签”只对配对动作本身有效；其他所有用户级操作（包括批准设备）仍然只接受已配对设备的签名，不放宽。
- **待批准设备**：pane 插件在“待处理”区列出，写明新设备的标签、公钥指纹和请求时间。未配对浏览器提交的批准签名无效。pane 插件可以用 `ctx.userPresence.devices()` 发现新登录的浏览器并提示配对。
- **源变化即新设备**：IndexedDB 按源（协议 + 主机 + 端口）隔离。pi-pane 只服务 `http://127.0.0.1:<port>`（默认 4319，可配置），端口或源改变后浏览器里是另一份密钥，按普通新增处理。
- 已配对设备可以在 pi-pane 或 CLI 里查看。

### 撤销与重置

| 操作 | 方式 | 结果 |
| --- | --- | --- |
| 撤销设备 | 用户级，已配对设备签名 | 被撤销的设备失效。撤销的是最后一台设备时，确认框写明“撤销后没有设备可以批准新设备，只能离线重置后再配对”；撤销后 `reTofuArmed` 仍为 `false`，新设备的配对请求只能停在待批准 |
| 在线重置（`agora pair --reset` 经 API） | 用户级，已配对设备签名 | 清掉除签名设备以外的全部设备，签名设备保持配对，不出现无人可批准的空档；不改 `reTofuArmed` |
| 离线重置（`agora offline pair-reset`） | 只能在 daemon 停止时执行 | 清空设备记录，`reTofuArmed` 置为 `true`，写 `via: "offline"` 的审计；下次启动触发设备重置警告 |
| 手动删除数据库里的设备记录 | 绕过 agora | 不会置位 `reTofuArmed`；启动检查发现设备记录变化，触发警告，并提示“需要运行 `agora offline pair-reset` 才能重新配对” |

- 离线命令先取得 daemon 的单实例锁，确认 daemon 没有运行，再直接修改数据库。
- **不提供在线旁路**：pi-pane 的终端配对码等通道只用于 pi-pane 自己的登录，agora 无法验证它们（pane 插件连 daemon 的凭证 `host.key` 只有主 Agent 级），所以不能用来在线重置配对或关闭保护。

### 启动检查与安全警告

daemon 启动时、以及在线检测到状态变化时，检查以下情况，每种情况对应一条安全警告（`security_alerts` 表）：

| 警告 | 判定 | 清除方式 |
| --- | --- | --- |
| `devices-reset` | `everPaired = true`，且设备记录与 daemon 记下的指纹不一致（离线重置、手动删除或修改记录）。daemon 在线执行的、经签名的设备变更会同时更新记下的指纹，不触发 | 用户级确认知悉（见下文） |
| `protection-off` | `userConfirmation = off` | 只能通过重新开启保护清除，不能“确认知悉” |

- 每条警告有 `alertId` 和 `revision`。同一情况再次被检测到新的差异（如又一次离线修改）时，`revision` 加 1，警告内容更新。
- 警告产生和更新都写审计（`action: "security.state_alert"`，附检测到的差异）。
- pane 插件以持久横幅显示，见 [integration.md](integration.md#安全状态横幅)；`agora status` 和 CLI 每次执行用户级相关命令时显示同样的警告。

**确认知悉**（只适用于 `devices-reset`）：

1. pane 插件调用 `POST /v1/security/alerts/:alertId/acknowledge`，带用户看到的 `revision`；daemon 生成待确认和挑战（`action: "agora.security.acknowledge"`、`target: alertId`，`paramsHash` 覆盖 `revision`），返回 `202`。
2. 浏览器签名后，插件走通用的 `POST /v1/confirmations/:id/sign`。签名设备必须是已配对设备（离线重置后重新配对的设备也算）。
3. daemon 在同一个事务里：校验警告仍为未确认、`revision` 未变；记录已知悉（设备、时间）；消费 nonce；写审计；产生变更事件。`revision` 已变时返回 `409 conflict`，用户需要按新内容重新确认，旧的确认不能清掉新的警告。
4. pane 插件收到警告状态变为已知悉的变更后，才清除横幅。

## 只用终端

配置项 `userConfirmation`（存在 daemon 数据库里，用 `agora config get|set userConfirmation` 读写）：

| 值 | 行为 |
| --- | --- |
| `device`（默认） | CLI 的用户级操作只生成待确认，在已配对浏览器里确认后生效 |
| `off` | CLI 的用户级操作直接以 `user` 身份执行，审计记录 `confirmedBy: "none"` |

- 关闭（`off`）后，**daemon 无法区分用户与 Agent**：任何能运行 `agora` 命令的子代理都能以用户身份操作。
- **在线关闭**：经 API 从 `device` 改为 `off` 是用户级操作，必须由已配对设备签名。
- **离线关闭**：没有已配对浏览器（包括从未配对过、只用终端的用户）时，只能停掉 daemon 后运行 `agora offline set userConfirmation off`。离线命令的执行方式和审计同“撤销与重置”中的离线重置。
- 改回 `device` 随时可以，不需要确认。
- 保护关闭期间，pi-pane 所有标签页常驻警告横幅，见“启动检查与安全警告”。

## 资源级访问控制

`user` 没有连接 token，用户级操作都经 CLI 或 pane 插件（`host:*`，即 `host:cli` 和 `host:pane`）发起、确认后以 `user` 身份执行。下表中：✔ 为允许；✘ 为拒绝；“确认”为用户级操作，需要用户确认（见“用户确认”）；“召集人”指资源的 convener；“成员”指 board 成员或会议席位。

### 任务

| 操作 | host:* | 召集人（agent:main） | 其他 agent:main | agent:child |
| --- | --- | --- | --- | --- |
| spawn | ✔（召集人记为 user） | — | ✔（成为新任务的召集人） | ✔，层数、下级数、档位不得放宽 |
| list `scope: "mine"` | ✔（召集人为 user 的任务） | ✔ | ✔ | 仅直接下级 |
| list `scope: "all"` | ✔ 全部 | 只返回摘要 | 只返回摘要 | ✘ |
| 读详情、结果 | ✔ | ✔，包含自己任务树 | ✘ | 直接下级；另可读自己所属任务的状态 |
| steer、cleanup | ✔ | 仅直接下级 | ✘ | 仅直接下级 |
| stop | ✔，整个目标子树 | ✔，整个目标子树 | ✘ | 仅直接下级及随其停止的整棵子树 |
| recover（召集人为 agent:main 且可达） | ✘ | ✔ | ✘ | ✘ |
| recover（召集人为 user，或已转给用户） | 确认 | ✘（显示“已转给用户”） | ✘ | ✘ |
| 接管（召集人改为 user） | 确认 | ✘ | ✘ | ✘ |

`scope: "all"` 对 `host:*` 返回全部任务；对 `agent:main` 只返回摘要（id、标题、状态、召集人显示名），不返回任务书、结果和对话，用于了解并行中的其他工作。

### 提问

| 操作 | host:* | 召集人 | 提问者（agent:child） |
| --- | --- | --- | --- |
| ask | ✘ | ✔，主代理发给用户 | ✔，发给直接上级 |
| 列表、读取 | ✔ 全部 | 发给自己的 | 自己提的 |
| answer（`open`，召集人为 agent:main） | 确认 | ✔ | ✘ |
| answer、cancel（`escalated`，或召集人为 user） | 确认 | ✘ | ✘ |
| escalate | ✘ | ✔，主代理转给用户 | 作为直接召集人时逐级向上转交 |
| cancel（`open`，召集人为 agent:main） | ✘ | ✔ | ✔（自己提的） |

### board

| 操作 | host:* | 召集人（owner） | writer 成员 | reader 成员、书记 |
| --- | --- | --- | --- | --- |
| 读公开条目 | ✔ | ✔ | ✔ | ✔ |
| 读密封草稿 | ✘ | ✘ | 仅自己的 | ✘ |
| post（作者为 user，任何 kind） | 确认 | — | — | — |
| post（非 `decision`） | — | ✔ | ✔ | 书记只能写 `summary` |
| post `decision` | — | ✔ | ✘ | ✘ |
| 新建独立 board | ✔ | ✔ | ✘ | ✘ |
| 把 board 绑定到任务（spawn 的 `boardId`） | ✔ | ✔ | ✘ | ✘ |

### 会议

| 操作 | host:* | 召集人（agent:main） | 参会者 | 书记 |
| --- | --- | --- | --- | --- |
| convene | ✔（召集人记为 user；超出 `meetingLimitDefaults` 或每日封顶需确认） | ✔（超出单会议封顶或每日封顶需确认） | ✘ | ✘ |
| status、result | ✔ | ✔ | 只能读自己会议的阶段和要求 | 同参会者 |
| interject（作者为 user） | 确认 | — | ✘ | ✘ |
| interject（作者为召集人） | — | ✔ | ✘ | ✘ |
| decide（召集人为 agent:main 且可达） | ✘ | ✔（含封顶以内的提高上限） | ✘ | ✘ |
| decide（召集人为 user，或已转给用户） | 确认 | ✘ | ✘ | ✘ |
| 提高预算和时长上限（`agentLimitCap` 的单会议和每日封顶以内） | 确认 | ✔ | ✘ | ✘ |
| 提高预算和时长上限（超出封顶） | 确认 | 发起待确认 | ✘ | ✘ |
| stop | ✔ | ✔ | ✘ | ✘ |
| endorse | ✘ | ✘ | ✔（自己的席位） | ✘ |

### 存档

| 操作 | host:* | 召集人 | agent:child |
| --- | --- | --- | --- |
| 读协作会话对话 | ✔ | 见 [archive.md](archive.md#读取权限) | ✘ |
| 删除存档 | 确认 | ✘ | ✘ |

### 设备与安全设置

| 操作 | host:* | agent:main | agent:child |
| --- | --- | --- | --- |
| 首台设备配对（`everPaired = false`）、离线重置后的配对（`reTofuArmed = true`） | ✔（新设备自签） | ✘ | ✘ |
| 新设备配对请求 | ✔（进入待批准） | ✘ | ✘ |
| 批准、撤销设备；在线重置配对 | 确认 | ✘ | ✘ |
| 关闭 `userConfirmation`；调高 `meetingLimitDefaults`、`agentLimitCap` | 确认 | ✘ | ✘ |
| 开启 `userConfirmation`；调低上述配置 | ✔ | ✘ | ✘ |
| 确认知悉 `devices-reset` 警告 | 确认 | ✘ | ✘ |
| 离线重置、离线关闭保护 | 只能在 daemon 停止时用离线命令 | — | — |

## 审计

所有用户级操作（含被拒绝的尝试）、待确认的创建与处理、主 Agent 在封顶以内提高上限、设备配对和重置、`userConfirmation` 和上限配置的修改、离线命令、启动检查发现的安全状态异常，都写入 `audit_log`：

| 字段 | 说明 |
| --- | --- |
| `principal_id` | 执行身份（确认后为 `user`） |
| `requested_by` | 发起请求的 principal（如 `host:cli`、`host:pane`、某个 `agent:main`） |
| `client` | 客户端自报的类型（`cli` / `pane` / `extension`），仅供参考 |
| `action`、`target` | 操作和目标 |
| `confirmation_id`、`device_id` | 经设备确认时有值 |
| `confirmed_by` | `device`、`none`（`userConfirmation = off`） |
| `via` | `online`、`offline`（离线命令） |
| `result`、`reason` | `allowed` / `denied` 及原因 |
| `created_at` | 时间 |

提问和决策的详情里显示“由谁、怎样确认”，如“由用户答复（设备：工作电脑 Chrome，2026-11-05 10:21）”或“由用户答复（CLI，未经设备确认）”。

## 其他降低冒充成本的措施

- **受保护目录**：所有档位的文件类工具（`read`、`grep`、`find`、`ls`、`edit`、`write`）的路径校验都拒绝 `AGORA_HOME/secret` 及其下的路径，以及配置项 `protectedPaths` 列出的目录。`bash` 和 `powershell` 只有工具级限制（是否提供），不检查命令内容，也不做路径隔离。规则见 [architecture.md](architecture.md#路径校验)。
- **不给路径提示**：daemon 拉起子进程时从环境变量里去掉 `AGORA_HOME`（以及 `PI_PANE_HOME`），只传 `AGORA_URL` 和 `AGORA_LAUNCH_TICKET`；任务书、工具结果和错误信息里不出现密钥目录的路径。
- **网络边界**：daemon 只监听 `127.0.0.1`；浏览器不直接连 daemon，daemon 拒绝带 `Origin` 头的请求。

这些措施只提高门槛，`bash` 仍然可以读 `secret/` 下的文件，读到的也只是主 Agent 级凭证。

## 剩余风险

本设计不做沙箱。它只拦住两类事：低成本冒充（读一个文件 + 用 curl 调接口）和误操作。存心冒充用户需要多个步骤，过程通常可见，也通常留下痕迹，但无法阻止。

- **同一系统用户、同一桌面会话**：Agent（主代理和子代理）与用户是同一个系统用户，处在同一个桌面会话里，可以借系统自动化替用户操作：
  - 向终端输入命令：macOS 的 `osascript` / System Events、Windows 的 SendKeys / UI Automation、Linux X11 下的 `xdotool`；
  - 操作浏览器替用户点确认：同样的自动化手段，Chrome 打开“允许 Apple 事件中的 JavaScript”时可以直接在页面里执行脚本，开启远程调试端口时可以经调试协议控制页面。
- **停 daemon 改数据**：Agent 可以停掉 daemon，用离线命令或直接修改数据库来删设备记录、关闭保护、删除审计日志。设备记录变化和保护关闭会在下次启动时触发常驻警告；审计日志被删则无从追查。
- **浏览器密钥可从磁盘挖出**：设备密钥“不可导出”只针对网页脚本。Chrome 等浏览器把 IndexedDB 中的密钥数据保存在用户配置目录里，同一系统用户的程序理论上可以取出并在别处使用。
- **抢先配对**：从未配对过时的首台设备（TOFU），以及离线重置之后的下一台设备（`reTofuArmed`），如果被 Agent 抢先完成配对，Agent 就能以用户身份操作。后者会触发常驻警告。
- **磁盘凭证的主 Agent 级权限**：子代理能读到 `host.key`，可以用它以 `host:cli` 身份操作，或注册一个新的主会话 principal，获得主 Agent 级权限（包括在 `agentLimitCap` 以内提高它自己召集的会议的上限）。每日封顶按数据目录统一计账，覆盖所有未经设备签名的会议创建和预算提高，不论用了多少个 principal，预算方面的影响都限制在封顶以内；所有操作都记到发起的 principal。
- **用户在不知情时确认**：用户确认能区分“用户点了确认”和“Agent 发起了请求”，不能防止用户确认一条 Agent 发起的待确认。待确认的表单写明真实的发起方。
- **关闭保护**：`userConfirmation = off` 时无法区分用户与 Agent。
- **工具层权限**：路径校验和工具白名单不是沙箱，见 [architecture.md](architecture.md#权限档位)。

真正的隔离需要让 Agent 以另一个系统用户运行，或使用沙箱、虚拟机，不在计划内。

## 以后可能做

- 按 loopback 连接的对端进程 PID 判断请求是否来自受管会话的进程树。它依赖平台接口，且可以被脱离进程树的进程绕过，MVP 不做。
