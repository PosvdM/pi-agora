import { appendFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { loadNative, identity, piArgs, RpcTransport, delay } from './prototype.mjs';
const [mode, addonPath, log, detail] = process.argv.slice(2);
const native = loadNative(addonPath);
if (mode === 'lock') {
  process.on('message', message => {
    if (message !== 'go') return;
    const fd = native.lock(detail);
    process.send({ held: fd >= 0, identity: identity(native, process.pid) });
    if (fd < 0) process.exit(2);
  });
  process.send({ ready: true });
} else if (mode === 'daemon') {
  const oracle = join(dirname(detail), 'cleanup-oracle.jsonl');
  appendFileSync(oracle, `${JSON.stringify(identity(native, process.pid))}\n`);
  const child = spawn(process.execPath, piArgs(), { detached: true, stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
  appendFileSync(oracle, `${JSON.stringify(identity(native, child.pid))}\n`);
  const rpc = new RpcTransport(child);
  // A test-only barrier keeps daemon.json absent while both processes already exist.
  if (process.env.E_DAEMON_READY_GATE) {
    writeFileSync(`${process.env.E_DAEMON_READY_GATE}.waiting`, 'ready');
    while (!existsSync(process.env.E_DAEMON_READY_GATE)) await delay(20);
  }
  const state = await rpc.command({ type: 'get_state' });
  if (!state.success) throw new Error(JSON.stringify(state));
  await rpc.prompt('daemon child fake-provider ready');
  writeFileSync(detail, JSON.stringify({ daemon: identity(native, process.pid), child: identity(native, child.pid), childIsPiRpc: true }));
  setInterval(() => appendFileSync(log, `daemon ${Date.now()}\n`), 50);
} else {
  if (mode === 'stubborn') { process.on('SIGTERM', () => {}); process.on('SIGHUP', () => {}); }
  appendFileSync(log, `${JSON.stringify(identity(native, process.pid))}\n`);
  setInterval(() => {}, 1000);
}
