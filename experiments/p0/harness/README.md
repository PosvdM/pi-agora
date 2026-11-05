# P0 共用测试工具

在 macOS + Node 26 + pi 1.5.0 上运行可复现的 RPC 实验。无需安装依赖；假 provider 由 pi 的扩展加载器导入 pi 自带的模块，不调用模型服务。

两仓的 `experiments/p0/harness/` 保持逐字节一致。修改工具时同步复制整个目录。

## 冒烟测试

在任一仓库根目录执行：

```sh
node --test experiments/p0/harness/smoke.test.mjs
```

8 个测试覆盖 JSONL 分帧、文字和 thinking 流、usage、真实 `read`、图片顺序与工具声明、两种 abort、动态脚本与错误、扩展 UI 回应及超时，以及停止幂等性和已退出子进程的信号保护。成功时删除临时现场，失败时保留并在测试输出打印 `fixture:` 路径。

## 最小用法

在实验目录的 `.mjs` 文件中导入相邻的 harness：

```js
import { createExperiment } from './harness/index.mjs';

const e = await createExperiment({
  script: { turns: [{ segments: [{ type: 'text', chunks: ['hello', { text: ' world', delayMs: 30 }] }] }] },
});
console.log('现场目录:', e.root);
try {
  const rpc = await e.start();
  const result = await rpc.promptAndWait('hi');
  console.log(result, await e.requests());
} finally {
  await e.stop(); // 保留日志和会话；确认结果后再 await e.cleanup()。
}
```

`start()` 先用 `get_state` 确认 RPC 可用，默认启动超时为 20 秒。它没有设置 `--no-session`，会话默认保存在临时 agent 目录。重启同一现场时用 `e.start({ args: ['--session', sessionFile] })` 指定要恢复的会话。

## 回复脚本

每次 provider 请求都算一轮，包括工具执行后的再次请求、压缩和重试。`request` 从 1 开始；工具调用会自然引发下一次请求。编号按同一现场的 `requests.jsonl` 延续，跨 pi 重启、扩展 reload 和会话替换不归零。

```js
await e.setScript({
  turns: [
    { segments: [{ type: 'toolCall', name: 'read', arguments: { path: 'input.txt' } }] },
    { segments: [{ type: 'text', text: 'done' }], usage: { input: 10, output: 4, cacheRead: 3 } },
  ],
  routes: [{
    when: { lastUser: 'fail', request: 3 },
    reply: { segments: [{ type: 'error', message: 'deliberate failure' }] },
  }],
  fallback: { segments: [{ type: 'text', text: 'fallback' }] },
});
await e.write('input.txt', 'fixture data\n');
```

选择顺序为：第一条命中的 `routes` → `turns[request - 1]` → `fallback`。没有回复时产生 `P0 script exhausted` 错误，不自动编造回复。脚本每次请求读取一次；`setScript()` 用原子替换更新文件，只影响后续请求。`enqueue(...replies)` 追加到 `turns`，适合逐轮补充脚本，不支持并发写入。

路由的 `when` 可以省略，或包含以下条件；多个条件须同时满足：

- `request`：全局请求编号。
- `lastUser`：最后一条用户消息的文字完全匹配。
- `includes`：文字包含指定字符串。
- `regex`：传给 `new RegExp()` 的表达式字符串。

用户内容为数组时，匹配文字是所有 text 块按 `\n` 连接，图片不参与匹配。工具结果不会改变最后一条用户消息；路由若要先调用工具再结束，应加 `request` 条件，避免重复调用工具。

回复的 `segments` 按顺序执行，每段可设 `delayMs`：

| `type` | 字段与行为 |
| --- | --- |
| `text`、`thinking` | `text` 或 `chunks`。每个 chunk 为字符串或 `{ text, delayMs }`；每段生成一个内容块，每个 chunk 生成一个 delta。可设 `signature`。 |
| `toolCall` | `name`、`arguments`、可选 `id`。实际交由 pi 查找、校验并执行工具，未知工具和越权调用也走 pi 的错误路径。 |
| `hang` | 永久等待；默认收到 abort 后产生 `aborted` 结果。回复级别设 `ignoreAbort: true` 时，所有延迟和 hang 忽略 abort，需终止进程。 |
| `error` | 以 `message` 产生 provider 错误；可在已有文字后插入，测试部分输出后失败。 |

回复还可设：

- `usage`：`input`、`output`、`cacheRead`、`cacheWrite`、`totalTokens`、`cost` 等 pi usage 字段。未填字段为 0；未填 `totalTokens` 时取四个 token 字段之和。费用默认全部为 0；传入费用不会发起真实计费。
- `stopReason`：正常终止默认按内容选择 `toolUse` 或 `stop`，也可设 `length`。
- `error`：所有 segments 之后产生错误。

自定义工具通过额外扩展注册。假 provider 只生成调用，不绕过 pi 的工具列表、参数校验或 `tool_call` 钩子。

## RPC 与事件

```js
const from = rpc.cursor;
const accepted = await rpc.command({ type: 'prompt', message: 'run' });
if (!accepted.success) throw new Error(accepted.error);
const settled = await rpc.waitFor('agent_settled', { from, timeoutMs: 5000 });
const toolEnd = await rpc.waitFor(
  event => event.type === 'tool_execution_end' && event.toolName === 'read',
  { from },
);
```

- `command(object, { timeoutMs = 10000 })` 自动补唯一 `id`，按 ID 关联响应；也可手动传 `id`。RPC 的 `success: false` 原样返回；进程退出、传输错误和超时拒绝 Promise。
- `waitFor(typeOrPredicate, { from = 0, timeoutMs = 10000 })` 先查已缓存事件，再等新事件，返回原始事件。每轮发送命令前记录 `rpc.cursor`，避免误取上一轮事件。predicate 可接收第二个参数 record。
- `promptAndWait(message, options)` 返回 `{ response, settled }`；命令失败或 `disposition: 'handled'` 时只返回 `{ response }`。它等待发送后首次 `agent_settled`，用于顺序实验，不用于区分多个并发 prompt 的归属。
- `rpc.events` 是 `{ seq, timestamp, elapsedMs, event }[]`；`seq` 从 0 开始。`onEvent((event, record) => {})` 返回取消订阅函数，回调同步执行。
- `send(object)` 写入任意 JSONL 记录，不等待响应，便于协议边界测试。写入串行等待 write callback；stdout 持续读取。
- `DeadlineError` 只代表驱动的等待期限，不会偷偷 abort、杀进程或重发命令。超时后仍会记录迟到响应。
- `rpc.stop({ graceMs = 700 })` 在子进程存活时给独立进程组发 SIGTERM，等待退出；超时且子进程仍存活时发 SIGKILL。已退出的子进程只等待 stdio 关闭，不再发信号。并发或重复调用返回同一 Promise，`graceMs` 以首次调用为准。`killGroup(signal)` 可直接发信号，`rpc.exit` 等待 stdio 关闭并返回 `{ code, signal }`。完整进程树和独立子进程组清理不在本工具范围内。

识别忽略 abort 的示例：

```js
import { DeadlineError } from './harness/index.mjs';

await e.waitForProvider(entry => entry.kind === 'hang');
try {
  await rpc.command({ type: 'abort' }, { timeoutMs: 250 });
} catch (error) {
  if (!(error instanceof DeadlineError)) throw error;
  // 保留现场；实验记录应同时检查 abort_received 和 agent_settled 是否出现。
}
```

## 扩展 UI

默认不回应 UI 请求。传入 `ui(request, rpc)` 函数，返回响应字段；返回 `undefined` 时故意不回应。函数仅处理 `select`、`confirm`、`input`、`editor`，通知不会消耗脚本步骤。

```js
import { scriptedUi } from './harness/index.mjs';
const rpc = await e.start({
  ui: scriptedUi([
    { method: 'select', response: { value: 'Allow' } },
    { method: 'confirm', response: { confirmed: false }, delayMs: 20 },
    { method: 'input' }, // 不回应，让 pi 自己处理请求里的 timeout。
    { method: 'editor', response: { cancelled: true } },
  ]),
});
```

也可 `await rpc.respondUi(id, { cancelled: true })` 手动回应。UI 回应没有普通 command response，不能用 `command()` 等待。

## 隔离与扩展实验

`createExperiment({ script, settings, args, env, ui, executable })` 创建临时 `cwd`、`HOME` 和 `PI_CODING_AGENT_DIR`，不继承父进程凭据及 `PI_*` 会话环境，只继承 `PATH`。`settings` 写入临时 agent 的最小配置；需要项目配置时用 `e.write('.pi/settings.json', ...)` 写入。

默认参数为 `--mode rpc --offline -ne -ns -np --no-themes -e <fake-provider.ts>`。`args` 追加任意 CLI 参数；`start({ args, env, ui, executable, startupTimeoutMs })` 可再追加启动配置。例如：

```js
const extra = await e.write('guard.ts', 'export default function(pi) { /* register hooks */ }');
const rpc = await e.start({ args: ['-e', extra, '--tools', 'read,grep,find,ls', '--no-approve'] });
```

`HOME`、agent/session 目录、离线和 telemetry 开关、脚本与请求日志路径固定指向现场，不接受 `env` 覆盖。项目上下文文件发现保持 pi 默认行为，便于验证 `AGENTS.md`。资源发现默认关闭，但显式 `-e`、`--skill` 等仍按 pi 规则加载。`executable` 默认是 `PATH` 上的 `pi`。

这不是操作系统沙箱。`PI_OFFLINE=1` 只关闭 pi 的自动网络活动；假 provider 自身不联网。不要追加真实 provider、远程资源、外部 agent 路径或访问主人目录的工具调用。额外扩展与 bash 拥有本机权限，必须使用受控 fixture。所有实验无需联网或安装包。

## 日志与现场

每个现场包含：

| 路径 | 内容 |
| --- | --- |
| `script.json` | 当前回复脚本。 |
| `requests.jsonl` | provider 请求和诊断事件，按追加顺序记录。 |
| `rpc-N.jsonl` | 第 N 次启动的所有 stdout 记录，带顺序、ISO 时间与单调时钟毫秒数。 |
| `stderr-N.log` | 原始 stderr，和协议分开；没有 stderr 时文件可能不存在。 |
| `agent/`、`home/`、`cwd/`、`tmp/` | 隔离配置、会话、输入文件及工具临时文件。 |

`e.requests()` 只返回 `kind: 'request'` 的完整请求：`model`、原始 `context.messages`、还原后的 `tools`、`systemPrompt`、`options` 和 `lastUser`。图片 base64 和内容块顺序不裁剪。函数 options 用名称标记，AbortSignal 记录当时的 `aborted` 状态。

`e.providerEvents()` 返回全部日志。`e.waitForProvider(predicate, { from = 0, timeoutMs = 10000 })` 使用文件监听并先查已有记录；`from` 是 provider 日志数组下标。诊断类型包括 `payload`、`hang`、`abort_received`、`done` 和 `error`。`payload` 记录 `before_provider_request` 处理后的实际假请求；具有 `messages` 时路由使用其最后一条用户消息。`request.context` 是扩展收到的上下文，判断请求改写时需同时查看 `payload`。

日志包含完整提示词、图片和工具参数，只应用于受控实验。`e.stop()` 保留现场；`e.cleanup()` 终止驱动后删除整个现场。实验失败时先报告路径与现象，不删除或覆盖原现场。

## 已发现的差异

本冒烟覆盖范围内，未发现设计使用的 RPC 命令名、事件名与 pi 1.5.0 不符。以下是其他组使用工具时需要遵循的实际行为，不代表 P0 各设计项已经通过：

- `prompt` 成功响应表示已接收；完成应等 `agent_settled`。`agent_end` 后仍可能有自动工作。`abort` 会等待 idle 后才回应；忽略 signal 的 provider 会使该响应超时，`get_state` 仍可处理。
- RPC 的 `message_update` 只有增量，不包含 `message` 或 `assistantMessageEvent.partial`。最终内容从 `message_end` 读取。
- 自定义 provider 收到的是 transcript；工具列表与系统提示在系统消息中，用 `getCurrentTools()` 和 `getCurrentSystemPrompt()` 还原，不能读取旧式 `context.tools/systemPrompt`。
- `-ne` 不屏蔽显式 `-e`，因此假 provider 能与被测扩展一同加载。扩展命令通过 `prompt` 返回 `disposition: 'handled'`，不必出现 `agent_settled`。

依据为安装包的 `docs/rpc.md`、`rpc-commands.md`、`rpc-extension-ui.md`、`custom-provider.md`、`json.md`，以及 `dist/modes/rpc/rpc-mode.js` 和 `dist/core/agent-session.js`。假 provider 不适合实测真实模型的 prompt cache 命中率、服务端重试或真实账单。
