import { homedir } from "node:os";
import path from "node:path";
import { startDaemon } from "./index.js";
import { AgoraError } from "./errors.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index], value = args[index + 1];
    if (!flag || !["--home", "--pi-path", "--extension-path"].includes(flag) || !value || values.has(flag)) throw new Error("启动参数无效：支持 --home、--pi-path、--extension-path");
    values.set(flag, value);
  }
  const daemon = await startDaemon({ home: values.get("--home") ?? process.env.AGORA_HOME ?? path.join(homedir(), ".pi", "agora"),
    piPath: values.get("--pi-path"), extensionPath: values.get("--extension-path") });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void daemon.close({ force: true }).catch(() => { stopping = false; console.error("部分进程未确认退出，后台进程保持运行"); process.exitCode = 1; });
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

void main().catch(error => {
  if (error instanceof AgoraError && error.code === "daemon_running") return;
  console.error(error instanceof AgoraError ? error.message : "daemon 启动失败，请检查配置、数据库和本机权限");
  process.exitCode = 1;
});
