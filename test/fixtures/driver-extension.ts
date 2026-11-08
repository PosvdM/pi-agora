// 仅供驱动层测试加载；生产 explore 白名单不提供 shell 或此扩展。
import { appendFileSync, writeFileSync, renameSync } from "node:fs";
import path from "node:path";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi) {
  const root = process.env.DRIVER_TEST_ROOT;
  const record = (entry) => appendFileSync(path.join(root, "extension.jsonl"), `${JSON.stringify(entry)}\n`);
  const bash = createBashToolDefinition(process.cwd());
  pi.registerTool({ ...bash, name: "agora_test_shell", label: "测试 shell", description: "运行隔离现场的受控 shell，忽略 abort",
    async execute(id, params) { return bash.execute(id, params, undefined); },
  });
  pi.registerTool({ name: "agora_test_hang", label: "测试阻塞", description: "忽略取消信号的受控工具",
    parameters: Type.Object({}), async execute() {
      record({ type: "hang_started" });
      await new Promise(() => {});
    },
  });
  pi.registerCommand("driver-ui", { description: "测试四类界面对话框", async handler(_args, ctx) {
    const select = await ctx.ui.select("选择", ["甲", "乙"]);
    const confirm = await ctx.ui.confirm("确认", "是否继续？");
    const input = await ctx.ui.input("输入", "文字");
    const editor = await ctx.ui.editor("编辑", "初始文字");
    record({ type: "ui_result", select: select ?? null, confirm, input: input ?? null, editor: editor ?? null });
  } });
  pi.registerCommand("driver-block", { description: "测试 RPC 心跳失去响应", handler() {
    writeFileSync(path.join(root, "rpc-blocked"), "已进入同步阻塞");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  } });
  pi.registerCommand("driver-extension-error", { description: "测试扩展故障", handler() {
    throw new Error("受控扩展命令故障");
  } });
  pi.registerCommand("driver-crash", { description: "测试进程异常退出", handler() {
    process.stderr.write("驱动崩溃诊断标记\n");
    process.exit(17);
  } });
  pi.registerCommand("driver-events", { description: "测试事件尾部边界", handler(_args, ctx) {
    for (let index = 0; index < 65; index++) ctx.ui.notify(`事件 ${index}`);
  } });
  pi.on("session_start", (_event, ctx) => {
    if (process.env.DRIVER_TEST_PRE_READY_UI === "1") {
      // pi 1.5.0 在 session_start 完成后才读取 RPC 输入，对话框必须等输入监听器绑定。
      setTimeout(async () => {
        const value = await ctx.ui.confirm("就绪前确认", "此项应取消");
        // 存在性是父进程的完成屏障，不能让它观察到已创建但尚未写完的 JSON。
        const temporary = path.join(root, "pre-ready-ui.tmp");
        writeFileSync(temporary, JSON.stringify({ value }));
        renameSync(temporary, path.join(root, "pre-ready-ui.json"));
      }, 0);
    }
  });
}
