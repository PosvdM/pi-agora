# C 组：工具限制与路径校验

## 范围与环境

本实验覆盖 [roadmap.md](../../../docs/roadmap.md) 的 agora #3、#4、#5、#19。结论限于本机 macOS 和本目录的受管扩展原型，不代表尚未实现的 daemon 已经通过验收。Windows 和 Linux 均为**待测**。

- 实测环境：macOS，Node `v26.12.0`，pi `1.5.0`，git `2.56.0`。
- 最后一次完整运行：`2026-11-05T14:25:20.208Z`；18 个测试，16 个通过，2 个 Windows 测试跳过，0 个失败，约 10.3 秒。
- 临时卷实测不区分大小写，NFC/NFD 文件名互通。`realpath` 把 `PROTECTED` 和 `protected` 都返回为磁盘上的 `protected`，并把 `/var/...` 返回为 `/private/var/...`。
- 所有模型请求都来自共用 harness 的假 provider；没有真实模型请求，没有网络访问。`HOME`、`PI_CODING_AGENT_DIR`、会话和工作目录均指向临时现场；没有修改全局安装、全局 git 配置或用户的 `~/.pi`。

| 条目 | 结论 | 主要结果 |
| --- | --- | --- |
| agora #3 | 通过 | 已保存信任的项目确实加载了 thinking 设置，但 `defaultTools` 不能绕过显式白名单；非白名单真实调用全部失败。MCP 结果不变。 |
| agora #4 | 通过 | 受管原型通过：五种指定故障都未发送任务书、未执行 canary，并结束进程、记录诊断；不代表真实 daemon 已验收。 |
| agora #5 | 部分通过 | 静态越界调用全部被拒；TOCTOU 能越过检查，与文档声明的剩余风险一致。原生 Windows 的 PowerShell 和 junction 尚未验证。 |
| agora #19 | 部分通过 | git 2.56.0 接受固定 argv，加固调用的恶意标记为 0；最低支持版本没有实测。 |

## 重跑与文件

从仓库根目录运行：

```sh
node experiments/p0/c-tools/run.mjs
```

运行器调用 `node --test --test-timeout=20000`，每次创建不同的系统临时目录，保存完整 `run.log`、`observations.json` 和两个项目设置现场的原始 provider/RPC 日志。直接运行 `node --test --test-timeout=20000 experiments/p0/c-tools/tools.test.mjs` 也会创建唯一临时证据目录。

只有显式设置 `P0_RECORD=1` 才刷新仓库里的已提交证据：

```sh
P0_RECORD=1 node experiments/p0/c-tools/run.mjs
```

默认完整重跑前后，仓库中 `observations.json` 和 `run.log` 的 SHA-256 均保持不变。本次记录运行的证据目录是 `/var/folders/0d/1h73_ysx6818yv_98vhrj3580000gn/T/pi-p0-c-tools-run-8RrTX0`。

测试主体只使用 Node 标准库、现有 pi 和 git。macOS 上 pager 的终端正控还使用已有的 `/usr/bin/python3` 标准库 `pty`；找不到该程序时不运行该正控，其他测试不依赖 Python。Windows 原生 PowerShell、junction 用例已经写入脚本，本次跳过；跨平台脚本未经 Windows/Linux 实测。

| 文件 | 用途 |
| --- | --- |
| `tools.test.mjs` | 受管启动监督原型、假 provider 驱动、故障注入和攻击用例。 |
| `run.mjs` | 创建唯一临时输出目录、运行测试并捕获完整日志；仅 `P0_RECORD=1` 刷新仓库日志。 |
| `safe-harness.mjs` | 本组复制的 harness 入口，沿用共用 RPC 驱动，并包装幂等 stop 和已退出检查。 |
| `managed-extension.ts` | 删除 launch ticket、验证 ticket、报告工具集合、就绪前拒绝调用、捕获策略异常、文件路径检查和 `agora_git`。 |
| `path-policy.mjs` | pi 路径解析规则的独立原型、真实路径与包含关系检查。 |
| `git-policy.mjs` | argv 白名单、filter 覆盖、环境清理及无 shell 的 git 调用。 |
| `fake-mcp.mjs` | 两个本地 stdio MCP 服务器共用的实现，记录 PID、协议请求和工具执行。 |
| `observations.json` | 逐用例观察、保留现场和退出后 PID 检查。 |
| `run.log` | 最后一次完整测试输出。 |

## 原型边界

受管扩展和监督器使用临时目录中的文件交换 ticket、ready、确认与故障报告，不实现 HTTP daemon。ticket 记录绑定 `runId`，带到期时间，以独占创建 `ticket.spent` 文件实现一次性消费。扩展工厂同步读取并删除 `AGORA_LAUNCH_TICKET`；`session_start` 完成兑换和初始就绪报告。监督器同时核对工具集合、模型、thinking 和原型版本，成功后通过仅用于测试的 `/p0-ready` 命令确认。

`tool_call` 在 ready 之前全部拒绝。策略内部异常由扩展自己捕获，写入 fatal 诊断并返回 `{ block: true }`，不依赖 pi 将异常转换成 RPC `extension_error`。`agora_canary` 是协作工具的执行标记；`agora_git` 只在 review 原型中注册。

#4 的钩子故障必须通过一次工具调用触发，因此脚本使用单独标识的 `P0 pre-ready fault probe`，让假 provider 在任务书之前发出 canary 调用。它不是任务书，provider 请求日志也单独核对没有 `P0 task`。这项解释避免把“触发钩子的测试输入”和“已经放行的业务任务书”混为一谈。

## agora #3：工具与资源限制

### 验证内容与通过标准

使用 `--tools read,grep,find,ls,agora_* -ne -e <原型> -ns -np`，同时在临时 agent 配置两个 MCP 服务器，在项目 `.pi/settings.json` 配置 `defaultTools`，尝试加入 `bash`、`edit`、`write`、`codemode` 和非白名单 MCP 工具。分别验证 `--no-approve` 和已保存项目信任两条启动路径；后者既不传 `--no-approve`，也不传 `--approve`。

通过标准：先用独立于工具选择的 thinking 标记证明项目设置确实被加载；再确认每个 provider 请求都没有越权工具的声明，假 provider 实际发出的越权调用失败。implement 的 MCP 控制实验只声明白名单服务器的工具，并记录两个服务器是否启动。

### 实测结果

两个项目设置现场都在临时 agent 的 `trust.json` 中将规范化 cwd 保存为 `true`，并将全局 `defaultProjectTrust` 设为 `never`，避免默认放行。独立标记为全局 `defaultThinkingLevel=low`、项目 `defaultThinkingLevel=high`。没有 CLI thinking 参数或运行时改级别。

| 场景 | 信任参数 | 初始 `get_state.thinkingLevel` | ready 的 thinking | 项目设置是否加载 |
| --- | --- | --- | --- | --- |
| 拒绝对照 | `--no-approve`，覆盖已保存的信任 | `low` | `low` | 否 |
| 已保存信任 | 不传信任覆盖参数，读取临时 `trust.json` | `high` | `high` | 是 |

`high` 来自同一份项目设置文件，证明可信现场的 `.pi/settings.json` 没有被跳过。随后两场景各检查 14 个 provider 请求，工具集合始终精确等于以下白名单：

```text
read, grep, find, ls, agora_canary
bash -> Tool bash not found
edit -> Tool edit not found
write -> Tool write not found
codemode -> Tool codemode not found
mcp__allowed__ping -> Tool mcp__allowed__ping not found
mcp__denied__ping -> Tool mcp__denied__ping not found
powershell -> Tool powershell not found
MCP spawn count = 0
```

这些错误来自真实 pi 工具分派结果，不是仅检查启动参数。两场景中，假 provider 都实际尝试上述 7 类越权调用；断言同时要求 `isError=true` 和精确的 `Tool <name> not found`，不以受管钩子的 ready 拒绝代替工具不可调用。`write` 的目标 `blocked.txt` 不存在，两个 MCP 服务器的启动记录也不存在。

原始 provider 请求、RPC 记录、全局/项目设置和 `trust.json` 分别归档在本次证据目录的 `project-settings-deny/`、`project-settings-saved/`。`observations.json.archived` 记录其绝对路径。

implement 策略的 MCP 专项控制只选取只读文件工具和 agora 工具。显式加载 `-e builtin:mcp` 并加入 `mcp__allowed__*` 后，分别测试 `direct` 和默认的 `codemode` exposure：

| exposure | provider 的 MCP 声明 | allowed 服务器 | denied 服务器 | denied 工具调用 |
| --- | --- | --- | --- | --- |
| `direct` | 只有 `mcp__allowed__ping` | 启动、initialize、tools/list | 启动、initialize、tools/list | `Tool mcp__denied__ping not found` |
| `codemode` | 没有直接 MCP 声明 | 启动、initialize、tools/list | 启动、initialize、tools/list | `Tool mcp__denied__ping not found` |

两个 exposure 下，`codemode` 本身都没有声明，真实调用也失败。`-ne -e builtin:mcp` 没有把另一个内置 codemode 扩展带入进程。默认 exposure 的 allowed MCP 工具也不能直接调用，结果是 `Tool mcp__allowed__ping not found`。

`direct` 模式中，allowed 工具在 ready 之前返回 `agora not ready`；取得异步 MCP 注册后的真实工具快照并确认 ready 后，返回 `allowed called`。denied 服务器的执行记录始终为 0。快照由原型 `/p0-report` 命令读取 `pi.getActiveTools()`，没有由测试端伪造工具列表。

### 结论

**通过**。受信任项目用独立 thinking 标记证明设置确实加载；其 `defaultTools` 没有绕过显式白名单，每个 provider 请求的声明和全部真实越权调用均满足断言。拒绝信任对照与 MCP 专项也通过。MCP 白名单限制工具暴露，不限制服务器连接：未列入的服务器仍启动、接收初始化和工具发现请求。这个事实影响 [architecture.md「权限档位」](../../../docs/architecture.md#权限档位) 中的 MCP 连接范围；本实验没有把连接误记为工具执行。

Windows：待测。Linux：待测。

## agora #4：受管扩展 fail closed

### 验证内容与通过标准

故障包括扩展工厂加载失败、策略钩子内部抛出异常、ticket 过期、ticket 已被消费、ready 报告的活动工具集合与预期不符。

通过标准：监督器没有发送任务书；canary 的执行标记不存在；进程结束，并留下错误或监督器诊断。

### 实测结果

| 故障 | 关键诊断 | 任务书 | canary 执行 |
| --- | --- | --- | --- |
| 加载失败 | `Failed to load extension: P0 deliberate factory failure`；RPC 启动失败，进程自行退出 | 未发送 | 0 |
| 钩子异常 | `policy failed closed: Error: P0 deliberate policy exception` | 未发送 | 0 |
| ticket 过期 | `Error: invalid or expired ticket` | 未发送 | 0 |
| ticket 重放 | `EEXIST ... ticket.spent` | 未发送 | 0 |
| 工具集合不符 | `ready tool set mismatch` | 未发送 | 0 |

除自行退出的加载失败外，其余进程在监督器拒绝后由 harness 停止，本机退出结果都是 `{ code: 143, signal: null }`。诊断包含原型的 `fatal.json` 或监督器生成的 `supervisor-diagnostic.json`；测试核对执行标记和 provider 的任务书记录。

另外两个边界观察如下：

1. 在 `session_start` 上报 ready 时，`direct` MCP 工具尚未加入活动集合。初始报告为 `read,grep,find,ls,agora_canary`，首个 provider 请求已经多出 `mcp__allowed__ping`。MCP 的异步注册使两个时点的集合不同；此时初始报告不能作为最终 MCP 集合的证据。控制实验使用 `/p0-report` 取得较晚的真实快照，之后才放行 allowed 调用。这影响 [architecture.md「受管扩展的就绪检查」](../../../docs/architecture.md#受管扩展的就绪检查) 的报告时点，以及「权限档位」中的 MCP 工具集合。
2. 另加一个没有 catch 的裸 `tool_call` 处理器，ready 后让假 provider 调用 canary。工具返回 `P0 raw tool_call throw` 且 `isError: true`，执行标记不存在，但 RPC `extension_error` 数量为 0。pi 仍完成本轮运行，没有自行结束进程。这与把所有钩子抛错都理解为 RPC `extension_error` 的假设不符；设计里明确要求扩展自己捕获异常的路径已单独测试。关联位置是 architecture.md「受管扩展的就绪检查」第 4、5 点。

### 结论

**通过**（受管原型）。五种指定故障在受管原型中均关闭放行路径，任务书和执行标记均为 0。这个结论不涵盖真实 HTTP 认证服务、持久化 ticket 存储或 pi 原生 `extension_error` 对所有异常的覆盖；裸钩子抛错的观察不能用于声称 pi 会发该事件。

Windows：待测。Linux：待测。

## agora #5：路径校验与命令工具

### 验证内容与通过标准

通过标准：所有静态越界文件类调用均被拒；搜索根覆盖受保护目录时拒绝；记录链接切换的实际表现；命令工具按平台和启动白名单提供。`bash`、`powershell` 的命令内容不作为路径隔离对象。

原型按 pi 1.5.0 的规则处理 `@`、`~`、`file://`、Unicode 空格、macOS 截图窄空格、NFD、弯引号，再解析真实路径；新文件回退到最深存在祖先。macOS 比较键转 NFC 并折叠大小写。文件工具的原始参数从实际 `tool_call.input.path` 记录。

### 静态路径实测

以下调用均为假 provider 实际发出，结果均为 `isError: true`：

- `read` 受保护文件、代表 `AGORA_HOME/secret` 的独立临时 secret 目录、受保护目录的大小写变体。
- `read` 的 `@`、`..`、`file://`、目录符号链接、目录内嵌套符号链接。
- NFC/NFD 文件名、普通空格与 `U+00A0`、截图时间的 `U+202F`、直引号与弯引号。`safe/` 中对应的变体文件本身是指向受保护文件的符号链接，因此能验证“实际采用的候选路径”，不只是在明显带有 `protected/` 的输入上做前缀判断。
- `edit` 受保护文件；`write` 通过符号链接向尚不存在的多级路径写入，以及大小写变体目录下的新文件。原文件没有改变，受保护目录下没有新文件。
- `grep`、`find`、`ls` 以 cwd、受保护目录本身或指向它的链接作为根；省略 `path` 时也以 cwd 检查。cwd 内有受保护目录，因此结果为 `search root contains protected path`。
- explore 越出允许根读取文件，以及 `~/outside.txt`；额外只读根中的受保护子目录仍被拒。

合法对照：`read safe/ok.txt`、`ls safe`、`grep safe`、`find safe`、`write safe/new/deep.txt` 和额外只读根中的公开文件均成功。`safe` 内含指向受保护目录的链接，`grep` 返回 `No matches found`，`find *.txt` 没有穿过目录链接读取受保护内容。

关键日志：

```text
write alias/new/deep.txt -> Error: protected path
read ../outside.txt -> Error: outside allowed roots
grep path omitted -> Error: search root contains protected path
read extra/public.txt -> extra public
caseInsensitive = true; nfdExists = true
realpath(PROTECTED) = realpath(protected) = .../cwd/protected
```

### TOCTOU 实测

扩展先检查 `race/value.txt`，当时 `race` 指向合法的 `safe/`。随后另一个仅用于测试的处理器在检查与内置 read 执行之间，把同一链接改为指向 `protected/`。

```text
guard allowed target = .../cwd/safe/value.txt
read result: isError = false
read content: TOCTOU_SECRET
```

该调用读到了受保护 fixture。攻击处理器用于确定性安排竞态窗口，不代表 explore 会加载攻击扩展。它证明检查和实际打开之间没有原子性，结果符合 [hostkit.md「路径规范化」](../../../docs/hostkit.md#路径规范化) 明示的 TOCTOU 剩余风险；不能把静态路径测试的通过解释为抵御链接切换。

### PowerShell 与平台

正常受管白名单没有 PowerShell：provider 没有该声明，实际调用返回 `Tool powershell not found`。

额外的原始 pi 控制实验在 macOS 上显式传入 `--tools powershell`，未加载 agora 原型。provider **看得到** `powershell`；真实发出 `Write-Output P0` 后返回：

```text
The powershell tool is only available on Windows.
```

因此，pi 1.5.0 的非 Windows 执行限制不等于不声明：显式选择仍会暴露 schema。这与“pi 自身会在非 Windows 上隐藏显式选择的 powershell”的理解不符；正常受管启动省略该工具的路径已经通过。关联位置为 [architecture.md「权限档位」](../../../docs/architecture.md#权限档位) 及「平台注意事项」。该控制没有执行 PowerShell 进程。

原生 Windows 上的 PowerShell 启用/禁用和 junction：**macOS 上无法验证**，Windows 待测。Linux：待测。

### 结论

**部分通过**。macOS 静态文件路径检查与正常受管命令工具白名单通过；TOCTOU 的越界读取有实测记录；原生 Windows 的两部分没有完成。原始 pi 显式选择 PowerShell 的 schema 暴露与默认受管白名单的结果已分别记录，没有把两条路径混为一谈。

## agora #19：`agora_git` 加固

### 验证内容与通过标准

通过标准：固定 argv 被 git 接受；临时恶意仓库中的程序在所有加固调用期间都不执行；参数白名单外调用失败；最低支持版本上也有验证记录。

仓库包含两个提交、一个带合成 `gpgsig` 的提交对象、与 HEAD 不同的暂存区内容、与暂存区不同且 mtime 置为旧值的工作区内容，确保工作区状态信息过期。签名不依赖真实密钥。

恶意配置包括 textconv、`diff.external`、`core.fsmonitor`、`core.pager`、clean/smudge/process filter、`log.showSignature=true` 和 `gpg.program`。程序只写入本现场的 `git-markers.jsonl`。配置只写临时仓库的 `.git/config` 和 `.gitattributes`；`GIT_CONFIG_GLOBAL` 指向临时空文件，`GIT_CONFIG_NOSYSTEM=1`。

### 实测结果

固定前缀与 [architecture.md「agora_git 的加固」](../../../docs/architecture.md#agora_git-的加固) 一致：

```text
--no-pager --no-optional-locks
-c core.fsmonitor=false -c core.pager=cat
-c color.ui=never -c log.showSignature=false
-c filter.evil.clean= -c filter.evil.smudge= -c filter.evil.process=
```

| 调用 | git 2.56.0 的结果 | 恶意标记 |
| --- | --- | --- |
| `status` 固定 argv | 接受；输出 `MM tracked.txt` | 0 |
| 工作区 `diff` | 接受；包含暂存版本与工作区内容的差异 | 0 |
| `diff --cached` | 接受；包含 HEAD 与暂存版本的差异 | 0 |
| `diff HEAD~1..HEAD` | 接受；包含两个提交的差异 | 0 |
| `log -p -n 2` | 接受；含补丁输出 | 0 |
| `show HEAD` | 接受；含补丁输出 | 0 |
| 删除 process 配置后保留恶意 clean/smudge，再运行工作区 `diff` | 接受 | 0 |

实际 provider 发出 `agora_git status`，同样得到 `MM tracked.txt`。其余固定命令直接调用该工具使用的同一个 `hardenedGit` 实现；所有 argv 都写入 `observations.json`。

本机 git 2.56.0 中，把仓库 filter 的 `clean`、`smudge`、`process` 以 `-c` 覆盖为空，没有触发恶意程序。该结论限于已测的默认非 required filter 配置，不包括任意 git 版本和任意 filter 组合。

假 provider 真正尝试以下 12 类白名单外选项，全部收到 `isError: true`、`option not allowed`：

```text
-c, --output, --exec, --git-dir, --work-tree, -C,
--ext-diff, --textconv, --show-signature, --config-env, --color, --no-index
```

工具实现还拒绝 `checkout`、`HEAD:tracked.txt`、以 `-` 开头的 revision、越出 cwd 的路径、git pathspec magic 和受保护路径。环境清理断言确认 `GIT_DIR`、`GIT_WORK_TREE`、`GIT_CONFIG_PARAMETERS`、`GIT_CONFIG_COUNT`、`GIT_CONFIG_KEY_*`、`GIT_CONFIG_VALUE_*` 被移除。

正控没有仅检查脚本可执行性：测试在同一临时仓库中运行没有加固的受控 git 调用，实际触发 textconv、external、fsmonitor、clean、process、smudge、gpg 和 pager 八类标记。smudge 使用写入临时 checkout 目录的 `checkout-index` 正控；pager 使用 PTY 正控。process 协议失败和合成签名验证失败不影响“程序确实执行”的标记判断。正控在全部加固测试完成之后运行，标记单独统计。

```text
hardenedMarkers = 0
positiveMarkers = [textconv, external, fsmonitor, clean, process, smudge, gpg, pager]
minimumGitVersionTested = false
```

### 结论

**部分通过**。本机 git 2.56.0 的固定 argv、安全标记和参数拒绝通过。最低支持版本由主人确定，本轮不测，也没有运行第二个 git 版本，因此不能据此满足 roadmap #19 的全部条件。关联位置是 architecture.md「agora_git 的加固」固定 argv 后的版本要求。

Windows：待测。Linux：待测。最低 git 版本：待测。

## Harness 与现场清理

共用 harness 没有修改。审查确认其 `stop()` 会在检查退出状态前发送信号，重复 `stop()`/`cleanup()` 有向已回收 PGID 发信号的风险；没有证据表明本实验实际误杀了进程。

本组 `safe-harness.mjs` 复制共用入口并包装每个驱动：先检查 child 的退出状态，已退出时只等待 exit；首次停止的 Promise 被缓存，并发或重复调用共用该 Promise。单元测试用会抛错的已退出驱动证明原始 stop 调用次数为 0；用显式 release barrier 证明并发和后续 stop 只调用原实现一次。没有使用固定延时作为同步。

本组仍补充 ready/ticket 监督、MCP 日志条件等待和退出后的精确 PID 检查。共用工具不覆盖完整独立子进程组清理；本次 MCP 由 pi 正常 shutdown 关闭，逐 PID 检查均未发现遗留。

最后一次完整运行保留三个预期需要复查的现场，绝对路径只适用于本机：

| 现场 | 原因 |
| --- | --- |
| `/var/folders/0d/1h73_ysx6818yv_98vhrj3580000gn/T/pi-p0-WPxgVd` | 裸 `tool_call` 抛错没有 RPC `extension_error`。 |
| `/var/folders/0d/1h73_ysx6818yv_98vhrj3580000gn/T/pi-p0-ADV144` | macOS 原始 pi 显式声明 PowerShell、执行时拒绝。 |
| `/var/folders/0d/1h73_ysx6818yv_98vhrj3580000gn/T/pi-p0-MMlU6u` | TOCTOU 读到受保护 fixture。 |

每个现场保留 `requests.jsonl`、`rpc-1.jsonl`、guard 日志和隔离配置。早期探查中有两次外层命令超时、若干正控和断言调整；相应临时现场没有删除，也没有据此修改或回滚 pi、harness、设计文档。初次 MCP/PowerShell/裸异常/TOCTOU 的异常观察已向主 Agent 报告。

最后一次测试的 `observations.json.cleanup` 中，所有记录的 `remaining` 都为空。所有正常 git/Python 控制进程都等待退出；最后额外按本组脚本路径检查进程表，也没有找到本组进程。**没有遗留进程**。除保留现场外，成功 fixture 在测试结束时删除。没有推送或发起 PR，也没有修改 `docs/`。

## 源码依据

本机安装根目录为 `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/`。核对的关键位置如下：

- `docs/cli.md`、`docs/extensions.md`、`docs/mcp.md`：显式工具选择、资源禁用、钩子及 MCP exposure。
- `dist/core/settings-manager.js` 的项目设置加载、`dist/core/sdk.js` 的显式工具覆盖，以及 `dist/core/trust-manager.js` 的规范化路径和布尔 trust 文件格式：受信任设置补测的依据。
- `dist/core/extensions/runner.js` 的 `emitToolCall`：该函数没有将抛错转换成 `extension_error` 的 catch。
- `dist/core/tools/path-utils.js`、`dist/utils/paths.js`：路径解析和 read 候选顺序；`read.js` 使用异步候选解析。
- `dist/core/tools/grep.js`、`find.js`：搜索参数含 hidden，不设置 follow。
- `dist/core/tools/index.js`：工具工厂包含 `powershell`；`dist/utils/shell.js` 的 `getPowerShellConfig` 在执行解析时检查 `process.platform`。
