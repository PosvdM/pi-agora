import path from "node:path";
import type { LaunchSpec } from "../types.js";

/** 参数顺序与资源隔离开关属于 pi 适配，不经过 shell。 */
export function buildPiArgv(cliEntry: string, spec: LaunchSpec, extensionPath: string, extraExtensions: string[] = []): string[] {
  const argv = [cliEntry, "--mode", "rpc", "--session-dir", path.dirname(spec.sessionFile),
    "--session", spec.sessionFile, "--model", spec.model, "--thinking", spec.thinking,
    "--tools", spec.tools?.join(",") ?? "read,grep,find,ls,agora_*", "-ne", "--no-mcp", "-ns", "-np", "--no-approve",
    "-e", extensionPath];
  for (const extension of extraExtensions) argv.push("-e", extension);
  for (const skillPath of spec.skillPaths ?? []) argv.push("--skill", skillPath);
  return argv;
}
