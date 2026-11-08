# pi-agora

pi-agora 是 [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) 编码智能体的协作引擎。主代理用它把任务派给子代理、召开多模型会议，所有协作会话的完整对话都会永久保存。

> **当前状态：切片 1b（任务核心）。** 提供 daemon、pi 扩展和 CLI，支持多层子代理、三个权限档位、worktree、返工、提问与逐级转交、恢复和可靠通知；提供 skill 白名单、逐请求用量和任务树汇总、额度暂停及到期恢复通知。用户设备确认、可选扩展 / MCP 白名单、存档读取、board、会议和 pi-pane 插件属于后续范围；下方“功能”描述完整设计目标。

## 使用

需要 Node.js 24 及以上、pi 1.5.x，以及编译 pi-hostkit 原生模块的工具链（Python 3 和 C/C++ 编译器；Windows 使用 Visual Studio Build Tools）。仓库不发布到 npm，从源码安装：

```sh
npm install
npm run build
```

在仓库根目录启动装有 agora 扩展的 pi：

```sh
pi -e ./packages/extension/dist/index.js
```

向主代理提出任务，并要求使用 `agora_task` 的 `spawn`，指定完整模型名（`provider/id`）、权限档位和任务书。动作包括 `spawn`、`list`、`status`、`result`、`steer`、`stop`、`cleanup` 和 `recover`。子代理也能派出下级，默认最多两层（子代理、孙代理），整棵任务树共用并发上限。下级的档位和子树限制不能放宽，只能管理自己直接派出的任务；主代理能查看、停止整棵树，但只能返工直接下级。

`explore` 提供只读文件工具和协作工具，`review` 另有加固的 `agora_git`，`implement` 提供文件修改和 shell 工具。只读档位的文件访问限定在允许根内；所有档位的文件工具都拒绝凭证目录。shell 不承诺路径隔离，这属于工具层权限，不是操作系统沙箱。

派活时使用范围明确的任务书，直接附必要接口和结论，并行前先定接口。子代理默认不加载 skill；可用 `skills: ["skill-name"]` 按名字指定用户全局 skill，名单不能超出上级的名单。项目 skill 不参与自动加载，名单内 skill 对文件工具只读放行。配置和边界见 [docs/security.md](docs/security.md#skill-白名单)。

`agora_task status` 和 `result` 返回单任务与任务树的 token 用量及最近报告的上下文大小。模型服务返回可识别的额度用完错误时，任务进入 `quota_paused`，不算失败、不占推理名额；到服务返回的重置时间后通知直接上级决定续跑或改派。`AGORA_HOME/config.json` 可设 `quotaRecovery: "auto"` 到期自动续跑；恢复父任务不会自动恢复下级。详细规则见 [docs/tasks.md](docs/tasks.md#额度暂停)。

扩展会自动启动后台 daemon。CLI 也可手动启动和查看：

```sh
node packages/cli/dist/main.js daemon start
node packages/cli/dist/main.js status
node packages/cli/dist/main.js ls
node packages/cli/dist/main.js show <任务或会话 ID>
node packages/cli/dist/main.js pending
node packages/cli/dist/main.js answer <提问 ID> --answers '<答复 JSON 数组>'
node packages/cli/dist/main.js shutdown
```

可用 `npm link --workspace @pi-agora/cli` 注册 `agora` 命令。默认数据目录为 `~/.pi/agora`；设置 `AGORA_HOME` 或给 CLI 传 `--home <目录>` 可改用其他本地目录。关闭主会话不会停止 daemon 或正在运行的子代理；恢复原主会话后会补收尚未确认的通知。通知只有在主会话文件中找到完整记录后才确认。

`shutdown` 排空运行中的任务；`--timeout <秒>` 默认 600，超时后保留 daemon，需用户显式重试 `shutdown --force`。强制关闭会中断任务并清理受管进程。停止报告会说明覆盖范围：Windows Job Object、Linux cgroup，或 macOS / Linux 的进程快照；快照的空残留列表不能证明整棵进程树均已退出。中断任务可选择 `resume`、`reopen`、`replace` 或 `abandon`；恢复要求旧写者已经确认退出，不自动重放有副作用的工具。

## 功能

- **子代理**：按模型和权限档位（`explore` / `review` / `implement`）多层派活；可在独立 git worktree 里工作；下级完成后叫醒直接上级，用 steer 返工；查看列表、取结果、停止子树；提问可逐级转交到主代理和用户。
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

完整设计不依赖 pi-pane：Agent 功能通过 pi 扩展和 `agora` CLI 提供，用户级操作由已配对浏览器确认。**切片 1b 的转交和 CLI 答复通路尚无设备确认，daemon 无法区分用户与同一系统用户下的 Agent。** 用户确认和离线安全设置在 1c 实现，见 [docs/security.md](docs/security.md)。

## 组成

```text
packages/
  daemon/        后台进程：进程监管、身份鉴权、任务/提问/board/会议、存档、HTTP API
  extension/     pi 扩展：装进主代理和每个协作会话，提供 agora_* 工具
  cli/           agora 命令行
  archive/       后续切片：只读存档读取库（daemon 不运行时也能用）
  pane-plugin/   pi-pane 服务端数据插件（加载与边界见 docs/pane-plugin.md）
  protocol/      协议类型与 schema
```

运行环境：Node.js 24 及以上（使用内置 `node:sqlite`），pi 1.5.x；Windows、macOS、Linux 同时支持。pi 依次从配置项 `piPath`、pi 官方安装脚本的安装目录、全局 npm 目录查找，见 [pi-hostkit 的“定位 pi”](https://github.com/PosvdM/pi-hostkit/blob/main/docs/design.md#定位-pi)。

## 开发

```sh
npm run build    # tsc project references 构建工作区
npm test         # 构建后用 node --test 验证，真实 pi 测试要求 1.5.0
```

依赖 pi-hostkit 的固定提交 `b6659ea30a63e7b35b8c7f16cdfa22e7dd5442a6`。测试使用本地假 provider，不访问模型服务，并把 HOME、agent 配置、数据和锁目录隔离到临时目录。CI 覆盖 Windows、macOS、Linux（cgroup 和快照两种模式）。构建、测试映射和限制见 [docs/development.md](docs/development.md)。

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/development.md](docs/development.md) | 1b 实现范围、配置、源码结构、构建、CLI、测试映射和限制 |
| [docs/architecture.md](docs/architecture.md) | 总体架构、进程模型、受管扩展就绪检查、控制队列、daemon 生命周期、存储、权限档位与路径校验、worktree、崩溃与恢复、资源、平台注意事项 |
| [docs/security.md](docs/security.md) | 安全模型：principal、主 Agent 级与用户级权限、用户确认、设备配对、只用终端、资源级访问控制、审计、剩余风险 |
| [docs/tasks.md](docs/tasks.md) | 任务（子代理）：工具接口、状态机、返工与送达追踪、可靠通知、提问与转交、召集人离线 |
| [docs/board.md](docs/board.md) | 共享桌面：数据模型、条目类型、可见性、投递与增量、工具、prompt cache |
| [docs/meetings.md](docs/meetings.md) | 会议：召集、定方案流程、认可、反对意见、阶段 fencing、僵局、预算、书记与纪要、插话、崩溃 |
| [docs/archive.md](docs/archive.md) | 全量对话存档：存什么、存在哪、三种投影、继承关系、完整性校验、只读 adapter |
| [docs/integration.md](docs/integration.md) | daemon HTTP API、会话视图与事件流、变更流、agora 到 pi-pane 插件接口的映射、离线存档读取、版本协商 |
| [docs/pane-plugin.md](docs/pane-plugin.md) | pane 插件构建与加载、固定协议副本、模块、幂等、资源上限、安全横幅和测试边界 |
| [docs/roadmap.md](docs/roadmap.md) | P0 验证项、MVP 切分、工程量、必须测试的故障、明确不做、主要风险 |
