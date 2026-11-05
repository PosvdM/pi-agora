import { appendFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { loadNative, identity, piArgs, RpcTransport } from './prototype.mjs';
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
  const child = spawn(process.execPath, piArgs(), { detached: true, stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
  const rpc = new RpcTransport(child);
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
