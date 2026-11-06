# E 组：pi-hostkit P0

本目录验证 agora #6、#15 和 pane #10。结果见 [RESULTS.md](RESULTS.md)。这是实验原型，不是可发布的 pi-hostkit 实现。

## 运行

在仓库根目录执行：

```sh
node --test experiments/p0/e-hostkit/hostkit.test.mjs
```

本机要求 macOS、Node.js 26、pi 1.5.0、Clang 和 Node 的 C 头文件。无需安装 npm 依赖。默认 pi 安装路径是 `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent`；可通过 `PI_PACKAGE` 指向其他安装目录。`NODE_HEADERS` 可指定包含 `node_api.h` 的目录。

全量运行约 140 秒。原生程序和 `.node` 模块编译到系统临时目录。Windows、Linux 的平台实现尚未编写，对应项目输出跳过，不能用本套脚本在这些平台的退出码判断平台能力已通过。

只跑某一类实验：

```sh
node --test --test-name-pattern='cross-host' experiments/p0/e-hostkit/hostkit.test.mjs
node --test --test-name-pattern='process:' experiments/p0/e-hostkit/hostkit.test.mjs
```

## 结果与现场

- 第一行 `E_HOSTKIT_FIXTURE` 给出本轮总目录，包含 `observations.jsonl`、`evidence.jsonl`、`fixtures.txt`、`owned-identities.json` 和原生构建产物。
- 每个 pi 的现场由共用 harness 创建，包含隔离的 `HOME`、`PI_CODING_AGENT_DIR`、会话、假 provider 请求、RPC 记录和故障注入文件。脚本不删除现场。
- 本目录的 `evidence.jsonl` 是报告对应完整运行的观察记录副本，不含 provider 的完整提示词。默认运行只写临时目录；设置 `P0_RECORD=1` 且测试、清理均通过时才原子替换仓库证据。
- 每个测试和 pi 现场在启动进程前登记应急清理。`finally` 停止 tracker，并读取该现场的 oracle，按 PID 与创建时间核对、逐个终止本轮进程；`after` hook 作为幂等兜底。清理必须在 5 秒截止前确认至少 250 毫秒静默，否则报“清理不完整”，即使最后一轮没有残留。现场的 `emergency-cleanup.json` 记录静默时长和超时状态；不按名称终止进程。
- 两个盲窗实验断言“能够复现一个残留”，随后记录并清理该残留。因此测试运行全绿不代表设计全部通过；设计结论以 `RESULTS.md` 为准。

刷新完整证据：

```sh
P0_RECORD=1 node --test experiments/p0/e-hostkit/hostkit.test.mjs
```

`cleanup failure:` 用例在正常 oracle 登记前注入异常，分别覆盖 `nohup` 后代、native `setsid` 孤儿和 `daemon.json` 尚未生成的 daemon/pi 子进程。它们验证异常仍会执行应急清理；不会给被测 `ProcessTracker` 补入 oracle 身份。`cleanup deadline:` 用可控时钟确定性验证：临近截止才出现身份、未满足静默窗口时必须失败，并以完整 250 毫秒静默作为成功对照。机制和边界见 [RESULTS.md 的清理与边界](RESULTS.md#清理与边界)。

## 文件

| 文件 | 内容 |
| --- | --- |
| `native.c` | 共用的 macOS `flock`、`proc_pidinfo`、`proc_listpids` 实现；分别编译为 N-API 模块和辅助程序。辅助程序还提供 exec 门闩、`setsid` 故障注入和 PTY。 |
| `prototype.mjs` | 构建入口、身份检查、快照、停止顺序、RPC、路径和权限原型。 |
| `host.mjs` | 用 `app` 参数区分 pane/agora 的最小宿主，执行同一套共享锁记录协议。 |
| `worker.mjs` | 锁竞争者、命令后代和带真实 pi RPC 子进程的 daemon。 |
| `hostkit.test.mjs` | 自动实验、故障注入、断言和观察日志。 |
| `test-cleanup.mjs` | 测试专用的现场清理、tracker 的 `finally` 管理、daemon 清理日志和证据写入开关。 |

`ProcessTracker.stop()` 的默认等待值与设计一致：abort 10 秒、stdin 宽限 5 秒、TERM 宽限 3 秒。实验明确传入 200/150/150 毫秒缩短等待；运行期快照仍为设计的 5 秒。原型对崩溃后无法取得的 RPC 和 stdin 记录失败，再继续信号阶段。
