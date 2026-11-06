import { existsSync, readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadNative, identity, sessionPaths, canonicalPath, atomicJson, spawnPi, ProcessTracker, isSameProcess } from './prototype.mjs';

const config = JSON.parse(process.argv[2]);
const native = loadNative(config.addonPath);
const instanceId = randomUUID();
const paths = sessionPaths(config.session, config.fixture.home);
const fd = native.lock(paths.lock);
if (fd < 0) { process.send({ state: 'busy' }); process.exit(2); }
const previous = existsSync(paths.record) ? JSON.parse(readFileSync(paths.record)) : undefined;
process.send({ state: 'locked', previous });
if (previous && previous.state !== 'released') {
  if (!previous.writer) {
    // P0 injects the unknown-writer window. No automatic force-continue is provided.
    process.send({ state: 'failed', reason: 'starting without writer' }); native.unlock(fd); process.exit(3);
  }
  if (isSameProcess(native, previous.writer) === 'alive') {
    const tracker = new ProcessTracker(native, previous.writer); tracker.capture();
    const report = await tracker.stop(undefined, { abortTimeoutMs: 200, graceMs: 150, termGraceMs: 150 });
    process.send({ state: 'recovered', report, oldWriter: previous.writer });
    if (report.leftovers.length) { native.unlock(fd); process.exit(4); }
  }
}
let record = { version: 1, sessionFile: canonicalPath(config.session, config.fixture.cwd, 'write', config.fixture.home), host: { app: config.app, identity: identity(native, process.pid, randomUUID(), instanceId) }, state: 'starting', updatedAt: new Date().toISOString() };
atomicJson(paths.record, record);
const rpc = spawnPi(config.fixture, ['--session', config.session, '-e', config.extension], { E_HOST_APP: config.app });
const writer = identity(native, rpc.child.pid, randomUUID(), instanceId);
// Cleanup-only journal; it is not consulted by lock recovery or ProcessTracker.
appendFileSync(join(config.fixture.root, 'cleanup-oracle.jsonl'), `${JSON.stringify(writer)}\n`);
const tracker = new ProcessTracker(native, writer); tracker.start();
if (config.window) {
  process.send({ state: 'spawn-window', writer });
  // Hold the exact spawn-before-record window until the test SIGKILLs this host.
  setInterval(() => {}, 1000);
} else {
  record = { ...record, writer, state: 'running' }; atomicJson(paths.record, record);
  await rpc.command({ type: 'get_state' });
  await rpc.prompt(`ready-${config.app}`);
  await rpc.command({ type: 'prompt', message: 'hang' });
  process.send({ state: 'ready', writer });
}
process.on('message', async message => {
  if (message !== 'stop') return;
  atomicJson(paths.record, { ...record, state: 'stopping' });
  const report = await tracker.stop(rpc, { abortTimeoutMs: 200, graceMs: 150, termGraceMs: 150 });
  if (!report.leftovers.length) atomicJson(paths.record, { ...record, state: 'released' });
  native.unlock(fd); process.send({ state: 'stopped', report }); process.exit(report.leftovers.length ? 5 : 0);
});
