# daemon 关窗口手动测试

本目录的工具用于在真实的 macOS 图形终端里验证 agora roadmap #15「daemon 存活」：pi 以 TUI 模式运行在终端窗口中，由扩展拉起 daemon 原型；关闭窗口后，检查 daemon 和它的 pi 子进程是否仍然存活。自动实验的结果见 [RESULTS.md 的 daemon 存活](../RESULTS.md#daemon-存活)。

下面的命令使用 worktree `/Users/pm/Harness/pi-design-review/pi-agora/.worktrees/sa-dcadd98c` 中的路径。在其他检出目录运行时，把路径前缀换成对应的仓库根目录。

## 操作步骤

全程约 5 分钟，使用假模型，不联网，不读写 `~/.pi`。

1. 打开「终端」（Terminal.app），按 ⌘N 新建一个窗口。
2. 在新窗口中复制并运行：

   ```sh
   sh /Users/pm/Harness/pi-design-review/pi-agora/.worktrees/sa-dcadd98c/experiments/p0/e-hostkit/manual-terminal-close/start.sh
   ```

   窗口里先显示「pi-agora #15 关窗口测试」的说明，随后打开 pi 界面。不要在 pi 里输入任何内容。
3. 等输入框附近出现绿色的「>>> 现在可以关闭这个窗口 <<<」（通常几秒内出现），然后关闭这个窗口：点左上角的红色按钮或按 ⌘W。如果弹出「终止进程？」之类的确认框，点「终止」。
4. 按 ⌘N 打开一个新窗口，复制并运行检查：

   ```sh
   node /Users/pm/Harness/pi-design-review/pi-agora/.worktrees/sa-dcadd98c/experiments/p0/e-hostkit/manual-terminal-close/check.mjs
   ```

   输出中有「daemon 存活：是/否」「pi 子进程存活：是/否」，最后一行是「结论：」。
5. 把第 4 步窗口里的全部输出复制下来，发给姐姐。
6. 运行清理，看到「清理完成。」即可：

   ```sh
   node /Users/pm/Harness/pi-design-review/pi-agora/.worktrees/sa-dcadd98c/experiments/p0/e-hostkit/manual-terminal-close/cleanup.mjs
   ```

   如果第 4 步的结论是「不通过」，先把输出发给姐姐，等姐姐确认后再清理。

如需在 iTerm2 中再测一次，完成第 6 步后在 iTerm2 中重复第 1～6 步。

如需把检查结果写进仓库证据，第 4 步改为运行：

```sh
P0_RECORD=1 node /Users/pm/Harness/pi-design-review/pi-agora/.worktrees/sa-dcadd98c/experiments/p0/e-hostkit/manual-terminal-close/check.mjs
```

## 检查结论

| 结论 | 退出码 | 含义 |
| --- | --- | --- |
| 通过 | 0 | 终端侧 pi 已退出，daemon 和 pi 子进程都存活，1.5 秒内心跳文件增大。 |
| 不通过 | 1 | 终端侧 pi 已退出，但 daemon 或 pi 子进程已退出，或心跳停止。 |
| 无法判断 | 2 | 没有现场，或 daemon 没有就绪。 |
| 无效 | 3 | 终端侧 pi 仍在运行，窗口可能还没关闭。关闭窗口后可再运行检查。 |

检查可以重复运行，例如关窗口几分钟后再查一次。

## 工作方式

- `start.sh` 运行 `prepare.mjs`：用共用 harness 创建隔离现场（临时 `HOME`、`PI_CODING_AGENT_DIR`、会话和工作目录），把原生模块编译到现场的 `build/`，写入两个扩展和 `launch.sh`。随后 `start.sh` 用 `exec` 进入 `launch.sh`，后者再 `exec` 到 `env -i … node <pi CLI>`，因此 pi 和手动输入 `pi` 一样，是 shell 的前台作业。关窗口时终端发出的 SIGHUP 直接到达 pi；工具中没有屏蔽或忽略 SIGHUP 的代码。
- pi 以 TUI 模式运行，参数为 `--offline -ne -ns -np --no-themes -na`，加载假 provider 和两个扩展：
  - `daemon.ts` 由 `test-cleanup.mjs` 的 `daemonExtensionSource` 生成，与自动实验 `daemon:` 相同：以 `detached: true`、`windowsHide: true`、`stdio: ignore`、`unref()` 启动 `worker.mjs daemon`。daemon 再启动 pi RPC 子进程，完成一次假 provider 回复后，把两者的身份写入 `daemon.json`，每 50 毫秒追加一行心跳。
  - `notice.ts` 把终端侧 pi 的身份写入 `oracle.jsonl`，等 `daemon.json` 出现且心跳增长后，把三者的身份写入 `manual-state.json`，并在界面上显示「现在可以关闭这个窗口」。60 秒内未就绪时显示错误提示。
- 身份是 `proc_pidinfo` 给出的 PID 加创建时间，与本组其他实验相同；PID 相同但创建时间不同的进程视为已退出，僵尸进程也视为已退出。
- 现场位置记在本目录的 `.state/current.json`（已在 `.gitignore` 中忽略）。上一次的现场未清理时，`start.sh` 拒绝启动并提示先清理。
- `check.mjs` 每次把 JSON 记录写到系统临时目录的 `e-hostkit-manual-close-records/`；设置 `P0_RECORD=1` 时，再向本目录的 `evidence.jsonl` 追加一行。记录包含终端程序（`TERM_PROGRAM` 等）、macOS、Node 和 pi 版本、三个进程的身份与存活状态以及心跳数据，不含提示词。
- `cleanup.mjs` 用 `test-cleanup.mjs` 的 `FixtureCleanup`：读取 `oracle.jsonl`、`cleanup-oracle.jsonl`、`daemon.json` 和 `manual-state.json` 中的身份及其后代，按 PID 加创建时间发 SIGKILL，确认 250 毫秒静默后删除现场和 `.state/current.json`。清理不完整时保留现场并以退出码 1 结束。没有现场时直接返回，可以重复运行。
- daemon 不会自行退出，心跳文件约每小时增大 1.5 MB，测试结束后需运行清理。

环境变量 `MANUAL_CLOSE_STATE` 和 `MANUAL_CLOSE_RECORDS` 可改变状态文件和记录目录，供自测使用。`NODE` 可指定 `start.sh` 使用的 Node。

## 自测

```sh
node experiments/p0/e-hostkit/manual-terminal-close/selftest.mjs
```

自测不操作任何图形程序。它用 `script` 创建真实 PTY，在其中启动开启作业控制的交互 zsh，输入 `start.sh` 的命令，等待界面出现「现在可以关闭这个窗口」，然后结束 `script` 进程来关闭 PTY master。分两轮：第一轮先向 pi 的前台进程组发 SIGHUP 再关闭 master；第二轮只关闭 master，并在通过后杀掉 pi 子进程，验证检查会报「不通过」。每轮还验证关窗口前检查报「无效」、清理后无残留进程（按身份和 `ps` 双重检查），以及重复清理安全。结果与预期不符时保留现场并以退出码 1 结束。

## 文件

| 文件 | 内容 |
| --- | --- |
| `start.sh` | 启动入口：准备现场后 `exec` 进入 pi TUI。 |
| `prepare.mjs` | 创建现场、编译原生模块、生成扩展和 `launch.sh`。 |
| `check.mjs` | 读取状态文件，判断存活和心跳，输出结论并写 JSON 记录。 |
| `cleanup.mjs` | 按身份终止本次测试的进程，删除现场。 |
| `lib.mjs` | 共用的路径、状态文件读写和身份判断。 |
| `selftest.mjs` | PTY 模拟关窗口的自测。 |
