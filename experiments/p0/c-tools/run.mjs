import { spawn } from 'node:child_process';
import { mkdtemp, copyFile } from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const output = await mkdtemp(join(tmpdir(), 'pi-p0-c-tools-run-'));
console.log('evidence:', output);
const child = spawn(process.execPath, ['--test', '--test-timeout=20000', join(here, 'tools.test.mjs')], {
  env: { ...process.env, P0_C_TOOLS_OUTPUT: output }, stdio: ['ignore', 'pipe', 'pipe'],
});
for (const [stream, target] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
  stream.on('data', chunk => { appendFileSync(join(output, 'run.log'), chunk); target.write(chunk); });
}
const exit = await new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('close', (code, signal) => resolve({ code, signal }));
});
if (process.env.P0_RECORD === '1') await copyFile(join(output, 'run.log'), join(here, 'run.log'));
console.log('evidence:', output, JSON.stringify(exit));
process.exitCode = exit.code ?? 1;
