import path from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { connectHost } from "@pi-agora/protocol";
import { offline } from "@pi-agora/daemon";

export const HELP = `agora：pi 协作引擎

用法：
  agora daemon start [--home <目录>]
  agora shutdown [--force] [--timeout <秒>] [--home <目录>]
  agora status [--home <目录>]
  agora ls [--limit <数量>] [--cursor <游标>] [--home <目录>]
  agora show <任务或会话 ID> [--home <目录>]
  agora pending [--home <目录>]
  agora answer <提问 ID> --answers <JSON 数组> [--revision <版本>] [--wait] [--home <目录>]
  agora task stop|cleanup|recover|limits|takeover <任务 ID> [--mode resume|reopen|replace|abandon] [--max-tokens <数量>] [--discard] [--wait] [--home <目录>]
  agora confirmations [确认 ID] [--wait] [--timeout <秒>] [--home <目录>]
  agora devices [--home <目录>]
  agora takeover <主会话 principal ID> [--wait] [--home <目录>]
  agora pair --reset [--wait] [--home <目录>]
  agora config get [配置名] [--home <目录>]
  agora config set <配置名> <JSON 值或 device|off> [--wait] [--home <目录>]
  agora offline pair-reset [--home <目录>]
  agora offline set userConfirmation off|device [--home <目录>]

查询和任务控制不自动启动 daemon。用户级操作默认生成待确认，需已配对设备签名。
仅用终端时，先停止 daemon，再运行 agora offline set userConfirmation off；关闭后无法区分用户与 Agent。
`;

export interface CliIo { out(text: string): void; error(text: string): void }

function parseArgs(argv: string[]): { words: string[]; options: Map<string, string | true> } {
  const words: string[] = [], options = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) { words.push(arg); continue; }
    if (["--force", "--help", "--discard", "--wait", "--reset"].includes(arg)) { options.set(arg, true); continue; }
    if (!["--home", "--timeout", "--limit", "--cursor", "--answers", "--revision", "--mode", "--max-tokens"].includes(arg)) throw new Error(`未知选项：${arg}`);
    const value = argv[++i];
    if (!value || value.startsWith("--")) throw new Error(`选项 ${arg} 缺少参数`);
    options.set(arg, value);
  }
  return { words, options };
}
function numberOption(options: Map<string, string | true>, key: string, fallback: number, min: number, max: number): number {
  const raw = options.get(key), n = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`${key} 必须是 ${min} 到 ${max} 之间的整数`);
  return n;
}
function settingValue(raw: string): unknown {
  if (["device", "off"].includes(raw)) return raw;
  try { return JSON.parse(raw); } catch { throw new Error("配置值必须是 JSON、device 或 off"); }
}
interface Confirmation { confirmationId: string; state?: string; result?: unknown }
interface ConfirmationReply { confirmation?: Confirmation }

export async function runCli(argv: string[], io: CliIo = { out: console.log, error: console.error }): Promise<number> {
  let client: Awaited<ReturnType<typeof connectHost>> | undefined;
  try {
    const { words, options } = parseArgs(argv);
    if (options.has("--help") || !words.length) { io.out(HELP); return 0; }
    const [command, operand, ...rest] = words;
    const home = path.resolve(String(options.get("--home") ?? process.env.AGORA_HOME ?? path.join(homedir(), ".pi", "agora")));
    if (command === "offline") {
      const result = await offline(home, words.slice(1));
      io.out(JSON.stringify(result, null, 2));
      return 0;
    }
    const start = command === "daemon" && operand === "start";
    if (!start && !["shutdown", "status", "ls", "show", "pending", "answer", "task", "confirmations", "devices", "pair", "config", "takeover"].includes(command!)) throw new Error("不支持的命令，请运行 agora --help");
    const arity = command === "config" ? (operand === "get" ? [2, 3] : [4]) : command === "task" ? [3] : ["show", "answer", "takeover"].includes(command!) ? [2] : command === "confirmations" ? [1, 2] : start ? [2] : [1];
    if (!arity.includes(words.length)) throw new Error("参数无效，请运行 agora --help");
    if (command === "pair" && !options.has("--reset")) throw new Error("终端仅支持 pair --reset；设备配对由浏览器签名完成");
    if (command === "answer" && !options.has("--answers")) throw new Error("请提供 --answers JSON 数组");
    if (command === "task" && !["stop", "cleanup", "recover", "limits", "takeover"].includes(operand!)) throw new Error("请指定有效任务动作和 ID");
    client = await connectHost({ home, as: "host:cli", autoStart: start });
    const post = (route: string, body: unknown) => client!.request("POST", route, body, { idempotencyKey: randomUUID() });
    const encode = (value: string) => encodeURIComponent(value);
    let result: unknown;
    if (start) result = { message: "daemon 已启动", url: client.url };
    else if (command === "status") result = await client.request("GET", "/v1/status");
    else if (command === "pending") result = await client.request("GET", "/v1/requests?state=open&state=escalated");
    else if (command === "devices") result = await client.request("GET", "/v1/devices");
    else if (command === "confirmations") result = await client.request("GET", operand ? `/v1/confirmations/${encode(operand)}` : "/v1/confirmations");
    else if (command === "pair") result = await post("/v1/devices/reset", {});
    else if (command === "takeover") result = await post(`/v1/principals/${encode(operand!)}/takeover`, {});
    else if (command === "config") {
      if (operand === "get") {
        const settings = await client.request<Record<string, unknown>>("GET", "/v1/settings");
        result = rest[0] ? { [rest[0]]: settings[rest[0]] } : settings;
      } else if (operand === "set") result = await post(`/v1/settings/${encode(rest[0]!)}`, { value: settingValue(rest[1]!) });
      else throw new Error("config 只支持 get 或 set");
    } else if (command === "answer") {
      let answers: unknown;
      try { answers = JSON.parse(String(options.get("--answers"))); } catch { throw new Error("--answers 不是合法 JSON"); }
      if (!Array.isArray(answers)) throw new Error("--answers 必须是 JSON 数组");
      result = await post(`/v1/requests/${encode(operand!)}/answer`, { answers,
        ...(options.has("--revision") ? { expectedRevision: numberOption(options, "--revision", 1, 1, Number.MAX_SAFE_INTEGER) } : {}) });
    } else if (command === "task") {
      result = await post(`/v1/tasks/${encode(rest[0]!)}/${operand}`, {
        ...(operand === "cleanup" ? { discard: options.has("--discard") } : {}),
        ...(operand === "recover" ? { mode: options.get("--mode") ?? "resume" } : {}),
        ...(operand === "limits" ? { maxTokens: numberOption(options, "--max-tokens", 0, 1, Number.MAX_SAFE_INTEGER) } : {}),
        ...(options.has("--revision") ? { expectedRevision: numberOption(options, "--revision", 1, 1, Number.MAX_SAFE_INTEGER) } : {}),
      });
    } else if (command === "ls") {
      const query = new URLSearchParams({ limit: String(numberOption(options, "--limit", 50, 1, 200)) });
      const cursor = options.get("--cursor");
      if (typeof cursor === "string") query.set("cursor", cursor);
      result = await client.request("GET", `/v1/sessions?${query}`);
    } else if (command === "show") {
      const id = encode(operand!);
      result = await client.request("GET", operand!.startsWith("tk_") ? `/v1/tasks/${id}` : `/v1/sessions/${id}`);
    } else {
      const timeoutMs = numberOption(options, "--timeout", 600, 1, 2_147_000) * 1000;
      result = await client.request("POST", "/v1/admin/shutdown", { force: options.has("--force"), timeoutMs }, { idempotencyKey: randomUUID(), timeoutMs: timeoutMs + 30_000 });
    }
    let pending = (result as ConfirmationReply | undefined)?.confirmation;
    if (command === "confirmations" && operand) pending = result as Confirmation;
    if (pending?.confirmationId) {
      io.error(`已提交，请在已配对的浏览器中确认（${pending.confirmationId}）`);
      if (options.has("--wait")) {
        const deadline = Date.now() + numberOption(options, "--timeout", 600, 1, 2_147_000) * 1000;
        while (Date.now() < deadline) {
          const current = await client.request<Confirmation>("GET", `/v1/confirmations/${encode(pending.confirmationId)}`);
          result = current;
          if (current.state && !["pending", "executing"].includes(current.state)) break;
          await delay(Math.min(500, Math.max(1, deadline - Date.now())));
        }
        const state = (result as Confirmation).state;
        if (!state || ["pending", "executing"].includes(state)) throw new Error("等待确认超时；操作可能仍待处理，请用 agora confirmations 查询，不要重新发起");
        if (state !== "confirmed") { io.out(JSON.stringify(result, null, 2)); return 1; }
      }
    }
    if (["answer", "task", "pair", "config", "confirmations", "devices", "takeover"].includes(command!)) {
      const state = await client.request<{ alerts?: unknown[] }>("GET", "/v1/security/state");
      if (state.alerts?.length) io.error(`安全警告：${JSON.stringify(state.alerts)}`);
    }
    io.out(JSON.stringify(result, null, 2));
    return 0;
  } catch (error) {
    io.error(error instanceof Error ? error.message : String(error));
    return 1;
  } finally { client?.close(); }
}
