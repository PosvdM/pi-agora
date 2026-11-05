import assert from 'node:assert/strict';
import { after } from 'node:test';
import { writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { createExperiment as createBase } from '../harness/index.mjs';

const drivers = [];

after(async () => {
  await Promise.all(drivers.map(rpc => rpc.stop()));
  const alive = drivers.filter(rpc => { try { process.kill(rpc.child.pid, 0); return true; } catch { return false; } }).map(rpc => rpc.child.pid);
  await writeFile(new URL('./process-evidence-' + basename(process.argv[1], '.mjs') + '.json', import.meta.url), JSON.stringify({ processes: drivers.map(rpc => ({ pid: rpc.child.pid, exit: rpc.exitInfo })), alive }, null, 2) + '\n');
  assert.deepEqual(alive, []);
});
export { DeadlineError, readJsonl } from '../harness/index.mjs';

export async function createExperiment(options) {
  const experiment = await createBase(options);
  const start = experiment.start;
  experiment.start = async overrides => {
    const rpc = await start(overrides);
    drivers.push(rpc);
    const stop = rpc.stop.bind(rpc);
    // The harness signals a process group even when the child is already reaped.
    rpc.stop = options => rpc.exitInfo ? Promise.resolve(rpc.exitInfo) : stop(options);
    if (process.platform === 'win32') {
      // This suite starts no shell or descendant tools; Windows remains untested.
      rpc.killGroup = signal => { if (!rpc.exitInfo) rpc.child.kill(signal); };
    }
    return rpc;
  };
  return experiment;
}
