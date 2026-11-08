import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const destination = path.join(root, "packages/pane-plugin/vendor/plugin-api");
const sourceFile = path.join(destination, "SOURCE.json");
const repository = "https://github.com/PosvdM/pi-pane.git";
const commit = "03f7916c1a7e3787fc4eaddbdfb10667a217fae7";
const files = ["package.json", "src/index.ts", "tsconfig.json"];
const hash = data => createHash("sha256").update(data).digest("hex");
const command = process.argv[2] ?? "verify";
const checkout = process.argv[3];
function original(file) {
  return execFileSync("git", ["-C", checkout, "show", `${commit}:packages/plugin-api/${file}`], { timeout: 30_000, maxBuffer: 1_000_000 });
}
if (command === "generate") {
  if (!checkout) throw new Error("生成副本需要 pi-pane 仓库路径");
  const hashes = {};
  for (const file of files) {
    const data = original(file);
    await mkdir(path.dirname(path.join(destination, file)), { recursive: true });
    await writeFile(path.join(destination, file), data);
    hashes[file] = hash(data);
  }
  await writeFile(sourceFile, `${JSON.stringify({ repository, commit, files: hashes }, null, 2)}\n`);
} else if (command === "verify" || command === "compare") {
  const source = JSON.parse(await readFile(sourceFile, "utf8"));
  if (source.repository !== repository || source.commit !== commit || JSON.stringify(Object.keys(source.files).sort()) !== JSON.stringify([...files].sort())) throw new Error("pane API 副本来源记录无效");
  for (const file of files) {
    const data = await readFile(path.join(destination, file));
    if (hash(data) !== source.files[file]) throw new Error(`pane API 副本哈希不符：${file}`);
    if (command === "compare" && (!checkout || !data.equals(original(file)))) throw new Error(`pane API 副本与固定提交不符：${file}`);
  }
  async function checkDirectory(directory, prefix = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = `${prefix}${entry.name}`;
      if (["dist", "node_modules"].includes(relative)) continue;
      if (entry.isDirectory()) await checkDirectory(path.join(directory, entry.name), `${relative}/`);
      else if (relative !== "SOURCE.json" && !files.includes(relative)) throw new Error(`pane API 副本存在来源外文件：${relative}`);
    }
  }
  await checkDirectory(destination);
  console.log("pane API 固定提交与只读副本校验通过");
} else throw new Error("未知的副本维护命令");
