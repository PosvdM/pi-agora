# pi-agora

pi-agora 是 [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) 编码智能体的协作引擎。主代理用它把任务派给子代理、召开多模型会议，所有协作会话的完整对话都会永久保存。

> **当前状态：设计阶段，还没有代码。** 本仓库目前只有设计文档，接口和默认值都是草案，P0 验证后冻结。

## 功能

- **子代理**：按模型（Claude、GPT、Gemini 等）和权限档位（`explore` / `review` / `implement`）派任务；可在独立 git worktree 里工作；完成后自动叫醒主代理；用 steer 返工；查看列表、取结果、停止；子代理可以向主代理提问，主代理答复或转给用户。
- **共享桌面（board）**：多个会话共用的结构化记录，条目只追加，有类型、引用和替代关系。会议、并行开发的接口约定、跨任务的提问都可以放在上面。
- **会议**：主代理或用户召开，参会者各自独立上下文，通过 board 讨论。默认“定方案”流程：密封独立方案 → 交叉质疑 → 指定合并人合并 → 其他人核对 → 迭代到全员认可同一版。书记写纪要，主代理只拿回纪要和定稿方案。
- **全量对话存档**：子代理、参会者、书记的对话都保存，结束、取消、崩溃都不删，以后可以查看。
- **单独使用**：在 pi 终端里装上扩展即可用，不需要 Web 界面。
- **用户确认**：主代理作为用户的代理人，可以裁决自己召集的会议、在封顶以内提高预算；答复转给用户的提问、超过封顶的预算、设备与安全设置等用户级操作，要在已配对的浏览器里确认后才生效，子代理读到磁盘上的凭证也不能冒充用户。只用终端时可以停掉 daemon 后用离线命令关闭这项保护。

## 解决的问题

此前使用的 pi-web-ui 把 Web 界面和子代理功能做在一起，问题集中在：

- **臃肿**：服务端约 12.7 万行 JS，前端打包约 6.8 MB，同一个子代理工具注册了两个名字。
- **子代理对话不保存**：关闭后只剩主对话，子代理做了什么查不到。
- **子代理层的 bug**：worktree 里的子代理提问被判成跨项目拦截、工具卡死拖住整个对话、steer 一直排队、完成通知统计不准。

pi-agora 的对应做法：

- 协作功能独立成一个项目，Web 界面另由 pi-pane（独立仓库）负责，两者通过版本化协议集成。
- 每个协作会话一个独立的 pi 子进程，一个会话卡死不影响其他会话；所有协作会话显式落盘并做完整性校验。
- 身份由 daemon 签发的 token 决定，不根据工作目录推断，worktree 里的会话和主目录里的一样通信。
- 协作会话的受管扩展未就绪时不发任务书、不执行任何工具；停止时清理整棵进程树。
- 任务状态、提问和通知存在 SQLite 里，完成通知与状态变更同事务写入，重启不丢。

## 和 pi-pane 的关系

| 项目 | 职责 |
| --- | --- |
| pi-agora（本仓库） | 后台 daemon、pi 扩展、CLI；子代理、board、会议、提问、存档；对外 HTTP API 和只读存档接口 |
| pi-pane | 轻量 Web 界面：托管主会话、聊天流、图片占位符、通用插件接口（会话树、面板、动作、表单、通知） |

pi-pane 不认识“子代理”“会议”这些概念。pi-agora 提供一个运行在 pi-pane 服务端的插件（`packages/pane-plugin`），把子会话树、board、会议进度等通过 pi-pane 的通用接口显示出来，转给用户的提问和待确认操作进入 pi-pane 的“待处理”区。

- pane 插件接口（树节点、面板、动作、表单、通知等）以 pi-pane 仓库的 `docs/plugin-api.md` 为准。
- daemon HTTP API 和 agora 数据到 pane 接口的映射以本仓库的 [docs/integration.md](docs/integration.md) 为准。
- 只有 `pane-plugin` 依赖 pi-pane 的插件接口包，其余包都不依赖 pi-pane。
- 两者共用平台相关的包 [pi-hostkit](https://github.com/PosvdM/pi-hostkit)（定位 pi、RPC 传输、进程树终止、锁、路径规范化）。它是独立仓库，权威设计见其 [docs/design.md](https://github.com/PosvdM/pi-hostkit/blob/main/docs/design.md)。

不装 pi-pane 时，pi-agora 的全部功能都可以在 pi 终端和 `agora` CLI 里使用；其中的用户级操作需要已配对的浏览器确认，或按 [docs/security.md](docs/security.md#只用终端) 关闭这项保护。

## 组成

```text
packages/
  daemon/        后台进程：进程监管、身份鉴权、任务/提问/board/会议、存档、HTTP API
  extension/     pi 扩展：装进主代理和每个协作会话，提供 agora_* 工具
  cli/           agora 命令行
  archive/       只读存档读取库（daemon 不运行时也能用）
  pane-plugin/   pi-pane 插件
  protocol/      协议类型与 schema
```

运行环境（计划）：Node.js 24 及以上（使用内置 `node:sqlite`），pi 1.5.x；Windows、macOS、Linux 同时支持。pi 从配置项 `piPath` 或全局 npm 目录查找，见 [pi-hostkit 的“定位 pi”](https://github.com/PosvdM/pi-hostkit/blob/main/docs/design.md#定位-pi)。

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | 总体架构、进程模型、受管扩展就绪检查、控制队列、daemon 生命周期、存储、权限档位与路径校验、worktree、崩溃与恢复、资源、平台注意事项 |
| [docs/security.md](docs/security.md) | 安全模型：principal、主 Agent 级与用户级权限、用户确认、设备配对、只用终端、资源级访问控制、审计、剩余风险 |
| [docs/tasks.md](docs/tasks.md) | 任务（子代理）：工具接口、状态机、返工与送达追踪、可靠通知、提问与转交、召集人离线 |
| [docs/board.md](docs/board.md) | 共享桌面：数据模型、条目类型、可见性、投递与增量、工具、prompt cache |
| [docs/meetings.md](docs/meetings.md) | 会议：召集、定方案流程、认可、反对意见、阶段 fencing、僵局、预算、书记与纪要、插话、崩溃 |
| [docs/archive.md](docs/archive.md) | 全量对话存档：存什么、存在哪、三种投影、继承关系、完整性校验、只读 adapter |
| [docs/integration.md](docs/integration.md) | daemon HTTP API、会话视图与事件流、变更流、agora 到 pi-pane 插件接口的映射、离线存档读取、版本协商 |
| [docs/roadmap.md](docs/roadmap.md) | P0 验证项、MVP 切分、工程量、必须测试的故障、明确不做、主要风险 |
