import path from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { connectHost } from "@pi-agora/protocol";

export const HELP = `agora：pi 协作引擎

用法：
  agora daemon start [--home <目录>]
  agora shutdown [--force] [--timeout <秒>] [--home <目录>]
  agora status [--home <目录>]
  agora ls [--limit <数量>] [--cursor <游标>] [--home <目录>]
  agora show <任务或会话 ID> [--home <目录>]

1a 仅提供只读 explore 子代理。status、ls、show 和 shutdown 不自动启动 daemon。
`;

export interface CliIo { out(text: string): void; error(text: string): void }

function parseArgs(argv: string[]): { words: string[]; options: Map<string, string | true> } {
  const words: string[] = [];
  const options = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) { words.push(arg); continue; }
    if (["--force", "--help"].includes(arg)) { options.set(arg, true); continue; }
    if (!["--home", "--timeout", "--limit", "--cursor"].includes(arg)) throw new Error(`未知选项：${arg}`);
    const value = argv[++i];
    if (!value || value.startsWith("--")) throw new Error(`选项 ${arg} 缺少参数`);
    options.set(arg, value);
  }
  return { words, options };
}

function numberOption(options: Map<string, string | true>, key: string, fallback: number, min: number, max: number): number {
  const raw = options.get(key);
  const n = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`${key} 必须是 ${min} 到 ${max} 之间的整数`);
  return n;
}

export async function runCli(argv: string[], io: CliIo = { out: console.log, error: console.error }): Promise<number> {
  let client: Awaited<ReturnType<typeof connectHost>> | undefined;
  try {
    const { words, options } = parseArgs(argv);
    if (options.has("--help") || !words.length) { io.out(HELP); return 0; }
    const [command, operand, ...rest] = words;
    if (rest.length) throw new Error("参数过多，请运行 agora --help");
    const start = command === "daemon" && operand === "start";
    if (!start && !["shutdown", "status", "ls", "show"].includes(command)) throw new Error("不支持的命令，请运行 agora --help");
    if (command === "show" && !operand) throw new Error("请指定任务或会话 ID");
    if (!["daemon", "show"].includes(command) && operand) throw new Error("参数过多，请运行 agora --help");
    const home = path.resolve(String(options.get("--home") ?? process.env.AGORA_HOME ?? path.join(homedir(), ".pi", "agora")));
    client = await connectHost({ home, as: "host:cli", autoStart: start });
    let result: unknown;
    if (start) result = { message: "daemon 已启动", url: client.url };
    else if (command === "status") result = await client.request("GET", "/v1/status");
    else if (command === "ls") {
      const query = new URLSearchParams({ limit: String(numberOption(options, "--limit", 50, 1, 200)) });
      const cursor = options.get("--cursor");
      if (typeof cursor === "string") query.set("cursor", cursor);
      result = await client.request("GET", `/v1/sessions?${query}`);
    } else if (command === "show") {
      const id = encodeURIComponent(operand);
      result = await client.request("GET", operand.startsWith("tk_") ? `/v1/tasks/${id}` : `/v1/sessions/${id}`);
    } else {
      const timeoutMs = numberOption(options, "--timeout", 600, 1, 2_147_000) * 1000;
      result = await client.request("POST", "/v1/admin/shutdown", { force: options.has("--force"), timeoutMs }, { idempotencyKey: randomUUID(), timeoutMs: timeoutMs + 30_000 });
    }
    io.out(JSON.stringify(result, null, 2));
    return 0;
  } catch (error) {
    io.error(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    client?.close();
  }
}
