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
  agora pending [--home <目录>]
  agora answer <提问 ID> --answers <JSON 数组> [--revision <版本>] [--home <目录>]
  agora task stop|cleanup|recover <任务 ID> [--mode resume|reopen|replace|abandon] [--discard] [--home <目录>]

查询和任务控制不自动启动 daemon。切片 1b 的 CLI 答复未经用户设备确认，daemon 无法区分用户与 Agent。
`;

export interface CliIo { out(text: string): void; error(text: string): void }

function parseArgs(argv: string[]): { words: string[]; options: Map<string, string | true> } {
  const words: string[] = [];
  const options = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) { words.push(arg); continue; }
    if (["--force", "--help", "--discard"].includes(arg)) { options.set(arg, true); continue; }
    if (!["--home", "--timeout", "--limit", "--cursor", "--answers", "--revision", "--mode"].includes(arg)) throw new Error(`未知选项：${arg}`);
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
    if (rest.length && (command !== "task" || rest.length !== 1)) throw new Error("参数过多，请运行 agora --help");
    const start = command === "daemon" && operand === "start";
    if (!start && !["shutdown", "status", "ls", "show", "pending", "answer", "task"].includes(command)) throw new Error("不支持的命令，请运行 agora --help");
    if (command === "show" && !operand) throw new Error("请指定任务或会话 ID");
    if (command === "answer" && (!operand || !options.has("--answers"))) throw new Error("请提供提问 ID 和 --answers JSON 数组");
    if (command === "task" && (!["stop", "cleanup", "recover"].includes(operand) || !rest[0])) throw new Error("请指定任务动作和 ID");
    if (!["daemon", "show", "answer", "task"].includes(command) && operand) throw new Error("参数过多，请运行 agora --help");
    const home = path.resolve(String(options.get("--home") ?? process.env.AGORA_HOME ?? path.join(homedir(), ".pi", "agora")));
    client = await connectHost({ home, as: "host:cli", autoStart: start });
    let result: unknown;
    if (start) result = { message: "daemon 已启动", url: client.url };
    else if (command === "status") result = await client.request("GET", "/v1/status");
    else if (command === "pending") result = await client.request("GET", "/v1/requests?state=open&state=escalated");
    else if (command === "answer") {
      let answers: unknown;
      try { answers = JSON.parse(String(options.get("--answers"))); } catch { throw new Error("--answers 不是合法 JSON"); }
      if (!Array.isArray(answers)) throw new Error("--answers 必须是 JSON 数组");
      result = await client.request("POST", `/v1/requests/${encodeURIComponent(operand)}/answer`, { answers,
        ...(options.has("--revision") ? { expectedRevision: numberOption(options, "--revision", 1, 1, Number.MAX_SAFE_INTEGER) } : {}) }, { idempotencyKey: randomUUID() });
    } else if (command === "task") {
      result = await client.request("POST", `/v1/tasks/${encodeURIComponent(rest[0])}/${operand}`, {
        ...(operand === "cleanup" ? { discard: options.has("--discard") } : {}),
        ...(operand === "recover" ? { mode: options.get("--mode") ?? "resume" } : {}),
      }, { idempotencyKey: randomUUID() });
    }
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
