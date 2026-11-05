import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const recording = process.env.P0_RECORD === '1';
export const evidenceDir = recording
  ? fileURLToPath(new URL('./', import.meta.url))
  : await mkdtemp(join(tmpdir(), 'pi-p0-a-evidence-'));

export async function recordEvidence(name, value) {
  const path = join(evidenceDir, name);
  await writeFile(path, JSON.stringify(value, null, 2) + '\n');
  return path;
}
