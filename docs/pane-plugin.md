# pane 插件

`packages/pane-plugin` 提供 `@pi-agora/pane-plugin`。插件运行在 pi-pane 服务端，仅提供声明式数据，不包含浏览器脚本或样式。pane 协议以 pi-pane 的 `docs/plugin-api.md` 为准，业务映射见 [integration.md](integration.md#agora-到-pane-协议的映射)。

## 构建与加载

在仓库根目录运行 `npm install` 和 `npm run build`。在 pi-pane 的插件配置中加入插件包的绝对路径：

```json
{ "plugins": ["<仓库绝对路径>/packages/pane-plugin"] }
```

包入口为 `dist/plugin.js`，声明的 pane 协议范围为 `[1, 1]`，插件 id 为 `agora`。插件使用 `AGORA_HOME` 指定的数据目录；未设置时使用 agora 的默认目录。插件不自动启动 daemon。在线连接以 `host:pane` 身份握手，浏览器不持有 daemon 凭证。

## 协议副本

`@pi-pane/plugin-api` 位于 pi-pane 的 monorepo 子目录，npm git 依赖不能直接选择该子包。插件的 peer 依赖声明固定仓库提交，本地开发依赖指向 `vendor/plugin-api` 的只读副本，构建时不联网。固定提交为 `03f7916c1a7e3787fc4eaddbdfb10667a217fae7`。

副本保留原始的 `package.json`、`tsconfig.json` 和 `src/index.ts`；`SOURCE.json` 记录仓库、完整提交及各文件的 SHA-256。构建使用插件自己的 `tsconfig.api.json`，不修改副本的构建配置。`.gitattributes` 禁止对副本做换行转换。

```sh
node scripts/vendor-pane-api.mjs verify
node scripts/vendor-pane-api.mjs compare <pi-pane仓库路径>
```

普通测试离线校验哈希；三平台 CI 另检出固定提交并逐字节比对。禁止手工修改副本。升级时先更改固定提交，再从该提交重新生成副本及来源记录，并核对协议兼容性：

```sh
node scripts/vendor-pane-api.mjs generate <pi-pane仓库路径>
```

## 模块

| 文件 | 职责 |
| --- | --- |
| `contracts.ts` | 内部 daemon 传输边界与会话列表结构；中立父关系到 pane 节点 ID 的映射 |
| `transport.ts` | 主机握手、带协议头的 JSON 请求、有界重试和 SSE 解析；关闭时取消请求与事件流 |
| `plugin.ts` | 启用、停用、健康检查、在线/离线切换、领域对齐、通知、对外插件接口 |
| `views.ts` | 在线树、会话快照与事件映射、停止、任务面板、自定义消息声明及主会话保活 |
| `actions.ts`、`action-store.ts` | 动态任务表单、目标与输入校验、固定请求快照、跨重启幂等查询 |
| `forms.ts` | 用户提问、中断任务决策、待确认和待批准设备的持久表单及结果映射 |
| `security.ts` | 用户在场确认、设备自签配对、三类安全横幅及带 revision 的确认知悉 |
| `identity.ts` | 完整插件调用身份与最终结果的持久化，防止不同调用映射成相同后台参数后复用 key |
| `offline.ts` | 经 archive adapter 读取的只读树、快照和历史；不解析 pi 文件或 SQLite |

## 同步与离线

在线树使用数据库级变更游标。普通子节点分页按父节点读取；热快照在同一事务内返回热节点及其祖先，不截断成默认列表的第一页。非树对象的变更以虚拟用户任务根的更新推进来源水位，使分页的 revision 可以与订阅对齐。断流、后台恢复或 epoch 失配时向宿主发送 `reset`；会话流对应发送 `resync`。

插件每 15 秒检查连接和认证状态。daemon 不运行时，通过 `openArchive({ home, apiVersion: 1 })` 只读读取，节点保留业务状态，只有 `open` 能力，会话标为只读。恢复在线时关闭 archive reader，并重置已订阅的树和会话。未知认证或协议错误不会在启用时冒充正常的离线状态。

离线元数据扫描每页 128 条，最多 64 页、4096 个会话；超限明确报错，不返回截断的树。每次打开 reader 使用新的离线 epoch，同一 epoch 使用固定元数据索引。归档条目、历史和流片段经 adapter 透传，不由插件重建 pi 格式。父关系缺失时进入未归属，不能用祖先的 pi 会话 ID 猜测直接父节点。

## 幂等与资源上限

完整 `ActionInvocation`、`FormSubmission` 和 `sessions.send` 的调用身份至少保留 24 小时；同 key 不同内容返回 `idempotencyConflict`。插件不缓存 `pending`。任务动作在发送副作用请求之前将方法、路径和请求体原子写入 `actions.json`；重启后同 key 使用原请求快照，避免随当前状态改变条件字段。最终插件结果保存在 `operation-identities.json`。

这些文件位于宿主提供的插件专用 `dataDir`，不包含连接 token。每个目录只允许一个插件实例使用，不提供跨进程写锁。`actions.json` 上限为 16 MiB，每个索引最多 4096 项；未过期记录不能为了容纳新请求而被驱逐，容量耗尽或文件损坏时拒绝写操作。

HTTP JSON 响应最多 8 MiB，单个 SSE 事件最多 4 MiB。任务面板只读取最近 20 代结果，并标明显示范围；答复记录按任务过滤，最多读取 4096 条，展示答复者及设备确认来源，超限要求通过 API 分页查看。主会话保活只阻止空闲回收，不拉起未托管会话；任务全部结束或插件停用时释放。

## 安全状态

`devices-reset`、`budget-config-changed` 和 `protection-off` 都使用宿主落盘的 persistent 横幅。前两类的确认知悉绑定用户看到的 revision，并要求设备签名；保护关闭横幅只能通过重新开启保护清除。用户确认拒绝时取消待确认；超时、缺少设备或不支持签名都不表示授权，待确认留给 daemon 裁定。

只有成功读取并验证 daemon 的当前安全警告列表后，插件才能清除已解除的横幅。断线、无效响应、插件启用尚未连上、停用或迟到的旧连接响应都不能静默清除横幅。来源不可用提示和跨 pi-pane 重启的保存由 pane 宿主实现。

## 测试

| 测试 | 验收 |
| --- | --- |
| `changes-s2.test.mjs`、`pane-daemon-s2.test.mjs` | 重启、游标过期和缺口、保留范围、按父分页、热节点祖先、原子切点、鉴权、背压与关闭；真实 HTTP 变更流驱动插件树并在 daemon 重启后收敛 |
| `pane-api-vendor.test.mjs` | 固定协议副本的来源与哈希 |
| `pane-transport-s2.test.mjs` | 相对端点、协议与幂等头、受控重试、分片 SSE 与取消 |
| `pane-views-s2.test.mjs` | 树水位、串行映射、会话流、composer/abort、任务用量和保活 |
| `pane-actions-s2.test.mjs`、`pane-action-store-s2.test.mjs` | 五个任务动作、动态表单、分步换人、pending 查询、跨重启固定请求、损坏和容量拒绝 |
| `pane-forms-s2.test.mjs` | 表单排序、并发提交、取消、旧 revision、结果未知和离线保留 |
| `pane-security-s2.test.mjs` | 用户拒绝/超时/缺少设备、去重确认、设备自签、旧警告 revision 和持久横幅 |
| `pane-identities-s2.test.mjs` | 跨重启完整调用身份、最终结果与并发登记 |
| `pane-offline-s2.test.mjs` | 离线热树与中立父关系、分页、只读内容、缺失文件、扫描上限与取消 |
| `pane-plugin-s2.test.mjs` | 生命周期、通知展示后确认、离线恢复、停用竞态、重启幂等和无效安全状态保留 |

这些测试在 agora 侧使用模拟主机和数据边界，不代替 pane M3 的浏览器联调。流式输出断网恢复、多标签页交互、设备密钥与签名、横幅跨宿主重启及插件不可用提示，需由 pane 的浏览器测试验收。
