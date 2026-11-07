import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, access } from "node:fs/promises";
import { isSameProcess, readIdentity, stopByIdentity } from "pi-hostkit";
import { piFixture, until } from "./fixtures/driver-helpers.mjs";

const exec = promisify(execFile);
const entry = fileURLToPath(new URL("../packages/cli/dist/main.js", import.meta.url));

test("CLI 真实进程：自动启动、复用单实例、status/ls/show 和排空关闭", { timeout: 90_000 }, async () => {
  const f = await piFixture();
  const home = path.join(f.root, "agora-cli");
  const env = { ...f.env, AGORA_HOME: home };
  const discovery = path.join(home, "run", "daemon.json");
  let identity;
  const cli = (...args) => exec(process.execPath, [entry, ...args, "--home", home], { env, cwd: f.cwd, timeout: 30_000, windowsHide: true });
  try {
    await assert.rejects(cli("status"), (error) => error.code === 1 && /尚未启动/.test(error.stderr));
    assert.match((await cli("daemon", "start")).stdout, /daemon 已启动/);
    const first = JSON.parse(await readFile(discovery, "utf8"));
    identity = readIdentity(first.pid, "cli-daemon", first.instanceId);
    assert.ok(identity);
    await cli("daemon", "start");
    const second = JSON.parse(await readFile(discovery, "utf8"));
    assert.equal(second.instanceId, first.instanceId);
    assert.equal(second.pid, first.pid);
    const status = JSON.parse((await cli("status")).stdout);
    assert.equal(status.instanceId, first.instanceId);
    assert.equal(status.activeRuns, 0);
    assert.equal(status.draining, false);
    assert.deepEqual(JSON.parse((await cli("ls", "--limit", "1")).stdout).items, []);
    await assert.rejects(cli("show", "tk_missing"), (error) => error.code === 1 && /not_found/.test(error.stderr));
    await assert.rejects(cli("shutdown", "--timeout", "0"), (error) => error.code === 1 && /必须/.test(error.stderr));
    assert.equal(JSON.parse((await cli("shutdown", "--timeout", "5")).stdout).stopped, true);
    await until(() => access(discovery).then(() => false, (error) => error.code === "ENOENT"));
    await until(async () => await isSameProcess(identity) === "gone");
    await assert.rejects(cli("status"), (error) => error.code === 1 && /尚未启动/.test(error.stderr));
  } finally {
    if (identity && await isSameProcess(identity) === "alive") await stopByIdentity(identity, { termGraceMs: 1000 });
    await f.cleanup();
  }
});
