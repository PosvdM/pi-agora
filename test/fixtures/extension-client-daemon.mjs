import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { extensionWire } from './extension-client-wire.mjs';

const home = process.argv[process.argv.indexOf('--home') + 1];
if (!home || process.env.HOME !== home || process.env.USERPROFILE !== home) throw new Error('测试后台进程必须使用隔离的 HOME');
writeFileSync(join(home, 'client-fixture-pid.json'), JSON.stringify({ pid: process.pid }));
process.once('exit', () => writeFileSync(join(home, 'client-fixture-exited'), '测试进程已退出'));
await extensionWire(home);
