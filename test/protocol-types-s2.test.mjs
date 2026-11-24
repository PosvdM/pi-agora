import test from 'node:test';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('公开会话类型声明列表、详情的 revision 与 treeRevision 和快照的 revision', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  execFileSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '--ignoreConfig', '--noEmit', '--pretty', 'false',
    '--strict', '--target', 'ES2023', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--types', 'node',
    path.join(root, 'test/fixtures/protocol-session-types.ts')], { cwd: root, timeout: 60_000, encoding: 'utf8', stdio: 'pipe' });
});
