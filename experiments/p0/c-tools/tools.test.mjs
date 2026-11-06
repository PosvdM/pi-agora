import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, cp, realpath, symlink, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { existsSync, watch } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createExperiment, readJsonl, guardStop } from './safe-harness.mjs';
import { hardenedGit, gitEnv } from './git-policy.mjs';
import { canonicalPath } from './path-policy.mjs';
const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const baseTools = ['read', 'grep', 'find', 'ls', 'agora_canary'];
const evidenceDir = process.env.P0_C_TOOLS_OUTPUT ?? await mkdtemp(join(tmpdir(), 'pi-p0-c-tools-run-'));
const observations = { platform: process.platform, node: process.version, evidenceDir, cases: [], retained: [], cleanup: [], archived: [] };
console.log('evidence:', evidenceDir);
const reply = (name, args = {}) => ({ segments: [{ type: 'toolCall', name, arguments: args }] });
const done = { segments: [{ type: 'text', text: 'done' }] };
const textOf = result => result?.content?.filter(x => x.type === 'text').map(x => x.text).join('\n') ?? '';
const logCase = value => { observations.cases.push(value); console.log(JSON.stringify(value)); };

async function waitMcp(e) {
  await new Promise((resolve, reject) => {
    const watcher = watch(e.root, () => { void scan(); });
    const timer = setTimeout(() => { watcher.close(); reject(new Error('MCP connect timeout')); }, 3000);
    async function scan() {
      const entries = await readJsonl(join(e.root, 'mcp.jsonl'));
      if (['allowed', 'denied'].every(server => entries.some(x => x.server === server && x.method === 'tools/list'))) {
        clearTimeout(timer); watcher.close(); resolve();
      }
    }
    void scan();
  });
}

async function fixture(t, { fault, profile = 'explore', tools, args = [], settings, mcp = false, expectedTools, projectTrust = 'deny' } = {}) {
  const e = await createExperiment({ settings });
  let passed = false;
  let retained = false;
  e.retain = reason => { retained = true; observations.retained.push({ root: e.root, reason }); console.log('retained fixture:', e.root, reason); };
  t.after(async () => {
    await e.stop();
    const mcps = await readJsonl(join(e.root, 'mcp.jsonl'));
    const pids = new Set(mcps.filter(x => x.kind === 'spawn').map(x => x.pid));
    if (e.rpc) pids.add(e.rpc.child.pid);
    const remaining = [];
    for (const pid of pids) { try { process.kill(pid, 0); remaining.push(pid); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    observations.cleanup.push({ root: e.root, pids: [...pids], remaining });
    if (remaining.length) {
      // Only stop exact PIDs started by this fixture, including MCP's independent groups.
      for (const pid of remaining) { try { process.kill(pid, 'SIGKILL'); } catch {} }
      e.retain('process remained after harness stop: ' + remaining.join(','));
    }
    if (e.archiveLabel) {
      const target = join(evidenceDir, e.archiveLabel);
      await cp(e.root, target, { recursive: true });
      observations.archived.push({ fixture: e.root, path: target });
    }
    if (!passed || retained) console.log('fixture:', e.root);
    else await e.cleanup();
    assert.equal(remaining.length, 0, 'fixture left processes');
  });
  e.pass = () => { passed = true; };
  const selected = tools ?? 'read,grep,find,ls,agora_*';
  const config = { runId: 'p0-run', fault, profile, protectedPaths: [join(e.cwd, 'protected'), join(e.root, 'secret')], expectedTools: expectedTools ?? [...baseTools, ...(profile === 'review' ? ['agora_git'] : [])] };
  await mkdir(join(e.root, 'secret'));
  await writeFile(join(e.root, 'secret/host.key'), 'P0_HOST_MARKER');
  await writeFile(join(e.root, 'control.json'), JSON.stringify(config));
  await writeFile(join(e.root, 'ticket.json'), JSON.stringify({ ticket: 'p0-ticket', runId: config.runId, expiresAt: Date.now() + (fault === 'expired' ? -1 : 60_000) }));
  if (fault === 'replay') await writeFile(join(e.root, 'ticket.spent'), 'spent');
  if (mcp) {
    const mcpServers = Object.fromEntries(['allowed', 'denied'].map(name => [name, { command: process.execPath, args: [join(here, 'fake-mcp.mjs'), name, join(e.root, 'mcp.jsonl')], exposure: mcp === 'codemode' ? 'codemode' : 'direct' }]));
    await writeFile(join(e.agentDir, 'mcp.json'), JSON.stringify({ mcpServers }));
  }
  e.startManaged = async (extraArgs = []) => {
    e.rpc = await e.start({ args: ['-e', join(here, 'managed-extension.ts'), '--tools', selected, ...(projectTrust === 'saved' ? [] : ['--no-approve']), ...args, ...extraArgs], env: { C_TOOLS_CONTROL: e.root, AGORA_LAUNCH_TICKET: 'p0-ticket', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(e.root, 'empty.gitconfig') } });
    return e.rpc;
  };
  e.approve = async () => {
    const report = existsSync(join(e.root, 'ready.json')) ? JSON.parse(await readFile(join(e.root, 'ready.json'), 'utf8')) : undefined;
    const state = await e.rpc.command({ type: 'get_state' });
    const accepted = !!report && JSON.stringify([...report.tools].sort()) === JSON.stringify([...config.expectedTools].sort()) && report.runId === config.runId && report.version === 'p0-1' && report.model === 'scripted' && state.data.model.id === 'scripted' && report.thinking === state.data.thinkingLevel && !existsSync(join(e.root, 'fatal.json'));
    await writeFile(join(e.root, 'decision.json'), JSON.stringify({ runId: config.runId, accepted }));
    if (accepted) await e.rpc.command({ type: 'prompt', message: '/p0-ready' });
    return { accepted, report, state: state.data };
  };
  e.call = async (name, input = {}, message = 'P0 task') => {
    const from = e.rpc.cursor;
    await e.setScript({ turns: [], routes: [{ when: { request: (await e.requests()).length + 1 }, reply: reply(name, input) }], fallback: done });
    await e.rpc.promptAndWait(message);
    return e.rpc.events.slice(from).map(x => x.event).find(x => x.type === 'tool_execution_end' && x.toolName === name);
  };
  return e;
}

test('local stop guard never signals an exited child and coalesces concurrent stops', async () => {
  let calls = 0;
  const exited = guardStop({ child: { exitCode: 0, signalCode: null }, exit: Promise.resolve({ code: 0 }), stop() { calls++; throw new Error('stale PID signal'); } });
  await Promise.all([exited.stop(), exited.stop()]);
  assert.equal(calls, 0);
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  const live = guardStop({ child: { exitCode: null, signalCode: null }, stop() { calls++; return barrier; } });
  const first = live.stop();
  const second = live.stop();
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(calls, 1);
  release({ code: 143 });
  await Promise.all([first, second, live.stop()]);
  assert.equal(calls, 1);
  logCase({ cleanupGuard: true, exitedSignals: 0, liveStopCalls: calls });
});

for (const trust of ['deny', 'saved']) test('#3 explicit tools with project settings: ' + trust, async t => {
  const globalThinking = 'low', projectThinking = 'high';
  const e = await fixture(t, { mcp: true, projectTrust: trust, settings: { defaultThinkingLevel: globalThinking, defaultProjectTrust: 'never' } });
  e.archiveLabel = 'project-settings-' + trust;
  const projectTools = ['bash', 'edit', 'write', 'codemode', 'mcp__denied__ping'];
  await e.write('.pi/settings.json', JSON.stringify({ defaultThinkingLevel: projectThinking, defaultTools: projectTools }));
  await writeFile(join(e.agentDir, 'trust.json'), JSON.stringify({ [await realpath(e.cwd)]: true }));
  await e.startManaged();
  const before = await e.rpc.command({ type: 'get_state' });
  assert.equal(before.success, true);
  const expectedThinking = trust === 'saved' ? projectThinking : globalThinking;
  assert.equal(before.data.thinkingLevel, expectedThinking, 'independent marker proves project settings loading');
  const approval = await e.approve();
  assert.equal(approval.accepted, true);
  assert.equal(approval.report.thinking, expectedThinking);
  logCase({ group: 3, trust, savedTrust: true, trustFlag: trust === 'saved' ? null : '--no-approve', globalThinking, projectThinking, actualThinking: before.data.thinkingLevel, readyThinking: approval.report.thinking, projectSettingsLoaded: trust === 'saved', projectTools });
  for (const [tool, input] of [['bash', { command: 'echo forbidden' }], ['edit', { path: 'blocked.txt', oldText: 'a', newText: 'b' }], ['write', { path: 'blocked.txt', content: 'forbidden' }], ['codemode', { code: 'text(1)' }], ['mcp__allowed__ping', {}], ['mcp__denied__ping', {}], ['powershell', { command: 'echo forbidden' }]]) {
    const result = await e.call(tool, input);
    assert.equal(result.isError, true);
    assert.equal(textOf(result.result), `Tool ${tool} not found`);
    logCase({ group: 3, trust, mode: 'explore', tool, isError: result.isError, text: textOf(result.result) });
  }
  const requests = await e.requests();
  assert.ok(requests.length > 0);
  for (const request of requests) assert.deepEqual(request.tools.map(x => x.name).sort(), [...baseTools].sort());
  assert.equal(existsSync(join(e.cwd, 'blocked.txt')), false);
  assert.equal(existsSync(join(e.root, 'mcp.jsonl')), false);
  logCase({ group: 3, trust, declarations: requests[0].tools.map(x => x.name), checkedRequests: requests.length, mcpSpawns: 0, archivedAt: join(evidenceDir, e.archiveLabel) });
  e.pass();
});

for (const exposure of ['direct', 'codemode']) test('#3 implement MCP whitelist ' + exposure, async t => {
  const e = await fixture(t, { profile: 'implement', mcp: exposure, tools: 'read,grep,find,ls,agora_*,mcp__allowed__*', args: ['-e', 'builtin:mcp'], expectedTools: [...baseTools, ...(exposure === 'direct' ? ['mcp__allowed__ping'] : [])] });
  await e.startManaged();
  // A control prompt waits for direct MCP declarations and records the actual post-connect loadout.
  await e.setScript({ turns: [done], fallback: done });
  await e.rpc.promptAndWait('P0 declaration probe, not a task');
  const requests = await e.requests();
  const declared = requests[0].tools.map(x => x.name);
  const denied = await e.call('mcp__denied__ping');
  assert.equal(denied.isError, true);
  const codemode = await e.call('codemode', { code: 'text(await tools.mcp__denied__ping({}))' });
  assert.equal(codemode.isError, true);
  const allowed = await e.call('mcp__allowed__ping');
  await waitMcp(e);
  const servers = await readJsonl(join(e.root, 'mcp.jsonl'));
  assert.ok(servers.some(x => x.server === 'allowed' && x.method === 'tools/list'));
  assert.ok(servers.some(x => x.server === 'denied' && x.method === 'tools/list'));
  assert.equal(servers.some(x => x.server === 'denied' && x.kind === 'execute'), false);
  assert.equal(declared.includes('mcp__denied__ping'), false);
  assert.equal(declared.includes('codemode'), false);
  logCase({ group: 3, exposure, declared, connections: servers.filter(x => x.kind === 'spawn'), denied: textOf(denied.result), allowedBeforeReady: textOf(allowed.result), executions: servers.filter(x => x.kind === 'execute') });
  // The session_start ready report precedes asynchronous MCP registration.
  logCase({ group: 4, exposure, readyReport: JSON.parse(await readFile(join(e.root, 'ready.json'), 'utf8')).tools, postConnectDeclared: declared });
  if (exposure === 'direct') {
    // This explicit control command obtains a fresh extension-side snapshot, without changing tools.
    await e.rpc.command({ type: 'prompt', message: '/p0-report' });
    assert.equal((await e.approve()).accepted, true);
    const ok = await e.call('mcp__allowed__ping');
    assert.equal(ok.isError, false);
    logCase({ group: 3, exposure, allowedAfterReady: textOf(ok.result) });
  }
  e.pass();
});

for (const fault of ['load', 'hook', 'expired', 'replay', 'tools']) test('#4 fail closed: ' + fault, async t => {
  const e = await fixture(t, { fault, expectedTools: fault === 'tools' ? ['read'] : undefined });
  if (fault === 'load') {
    await assert.rejects(e.startManaged(), /pi closed/);
    assert.equal((await e.requests()).length, 0);
    assert.equal(existsSync(join(e.root, 'executed')), false);
    logCase({ group: 4, fault, taskSent: false, executed: false, diagnostic: await readFile(join(e.root, 'stderr-1.log'), 'utf8') });
    e.pass();
    return;
  }
  const rpc = await e.startManaged();
  // Hook faults are probed before ready with a synthetic canary prompt, never the task book.
  if (fault === 'hook') {
    const result = await e.call('agora_canary', {}, 'P0 pre-ready fault probe');
    assert.equal(result.isError, true);
    assert.match(textOf(result.result), /failed closed/);
  }
  const approval = await e.approve();
  assert.equal(approval.accepted, false);
  assert.equal(existsSync(join(e.root, 'executed')), false);
  const requests = await e.requests();
  assert.equal(requests.some(r => r.lastUser === 'P0 task'), false);
  const diagnostic = existsSync(join(e.root, 'fatal.json')) ? JSON.parse(await readFile(join(e.root, 'fatal.json'), 'utf8')) : { reason: fault === 'tools' ? 'ready tool set mismatch' : rpc.stderr };
  await writeFile(join(e.root, 'supervisor-diagnostic.json'), JSON.stringify(diagnostic));
  await e.stop();
  logCase({ group: 4, fault, taskSent: false, executed: false, diagnostic, exit: rpc.exitInfo });
  e.pass();
});

test('#4 bare pi tool_call throw blocks execution (without prototype catch)', async t => {
  const e = await fixture(t);
  const extension = await e.write('raw-throw.ts', `export default function(pi) { pi.on('tool_call', () => { throw new Error('P0 raw tool_call throw'); }); }`);
  await e.startManaged(['-e', extension]);
  assert.equal((await e.approve()).accepted, true);
  const result = await e.call('agora_canary');
  assert.equal(result.isError, true);
  assert.equal(existsSync(join(e.root, 'executed')), false);
  const errors = e.rpc.events.filter(x => x.event.type === 'extension_error').map(x => x.event);
  logCase({ group: 4, fault: 'raw-throw-after-ready-control', result: textOf(result.result), extensionErrors: errors });
  if (!errors.length) e.retain('raw tool_call throw has no extension_error event');
  e.pass();
});

test('#5 real file-tool hooks, symlinks, aliases, Unicode and new writes', async t => {
  const e = await fixture(t, { profile: 'implement', tools: 'read,grep,find,ls,edit,write,agora_*', expectedTools: [...baseTools, 'edit', 'write'] });
  await e.write('protected/secret.txt', 'C_TOOLS_SECRET\n');
  await e.write('protected/Café.txt', 'UNICODE_SECRET\n');
  await e.write('protected/Capture 1\u202fPM.txt', 'SCREEN_SECRET\n');
  await e.write('protected/Capture d’écran.txt', 'QUOTE_SECRET\n');
  await e.write('safe/ok.txt', 'public text\n');
  await symlink(join(e.cwd, 'protected'), join(e.cwd, 'safe', 'link'), 'dir');
  await symlink(join(e.cwd, 'protected'), join(e.cwd, 'alias'), 'dir');
  for (const name of ['Cafe\u0301.txt', 'Capture 1\u202fPM.txt', 'Capture d’écran.txt', 'space name.txt']) {
    await symlink(join(e.cwd, 'protected/secret.txt'), join(e.cwd, 'safe', name), 'file');
  }
  await e.startManaged();
  assert.equal((await e.approve()).accepted, true);
  const deniedCases = [
    ['read', { path: 'protected/secret.txt' }], ['read', { path: join(e.root, 'secret/host.key') }], ['read', { path: '@protected/secret.txt' }],
    ['read', { path: 'safe/../protected/secret.txt' }], ['read', { path: 'file://' + join(e.cwd, 'protected/secret.txt') }],
    ['read', { path: 'alias/secret.txt' }], ['read', { path: 'safe/link/secret.txt' }],
    ['read', { path: 'PrOtEcTeD/SECRET.TXT' }], ['read', { path: 'protected/Cafe\u0301.txt' }],
    ['read', { path: 'protected/Capture\u00a01 PM.txt' }], ['read', { path: "protected/Capture d'écran.txt" }],
    ['read', { path: 'safe/Café.txt' }], ['read', { path: 'safe/Capture 1 PM.txt' }],
    ['read', { path: "safe/Capture d'écran.txt" }], ['read', { path: 'safe/space\u00a0name.txt' }],
    ['write', { path: 'alias/new/deep.txt', content: 'forbidden' }], ['write', { path: 'PrOtEcTeD/new.txt', content: 'forbidden' }],
    ['edit', { path: 'protected/secret.txt', oldText: 'C_TOOLS_SECRET', newText: 'forbidden' }],
    ...['grep', 'find', 'ls'].flatMap(name => [{ path: '.' }, { path: 'protected' }, { path: 'safe/link' }].map(input => [name, { ...(name === 'grep' ? { pattern: 'SECRET' } : name === 'find' ? { pattern: '*' } : {}), ...input }])),
  ];
  for (const [name, input] of deniedCases) {
    if (input.path.startsWith('PrOtEcTeD') && !existsSync(join(e.cwd, 'PROTECTED'))) continue;
    const result = await e.call(name, input);
    assert.equal(result.isError, true, name + JSON.stringify(input));
    assert.match(textOf(result.result), /protected/);
    logCase({ group: 5, name, input, isError: result.isError, result: textOf(result.result) });
  }
  assert.equal(await readFile(join(e.cwd, 'protected/secret.txt'), 'utf8'), 'C_TOOLS_SECRET\n');
  assert.equal(existsSync(join(e.cwd, 'protected/new')), false);
  assert.equal(existsSync(join(e.cwd, 'protected/new.txt')), false);
  for (const [name, input] of [['read', { path: 'safe/ok.txt' }], ['ls', { path: 'safe' }], ['grep', { path: 'safe', pattern: 'SECRET' }], ['find', { path: 'safe', pattern: '*.txt' }], ['write', { path: 'safe/new/deep.txt', content: 'public' }]]) {
    const result = await e.call(name, input);
    assert.equal(result.isError, false, textOf(result.result));
    assert.equal(textOf(result.result).includes('C_TOOLS_SECRET'), false);
    logCase({ group: 5, name, input, result: textOf(result.result) });
  }
  const realLower = await canonicalPath('protected', e.cwd), realUpper = await canonicalPath('PROTECTED', e.cwd);
  const logs = await readJsonl(join(e.root, 'guard.jsonl'));
  assert.ok(logs.some(x => x.kind === 'tool_call' && x.tool === 'write' && x.input.path === 'alias/new/deep.txt'));
  logCase({ group: 5, caseInsensitive: existsSync(join(e.cwd, 'PROTECTED/secret.txt')), realLower, realUpper, nfdExists: existsSync(join(e.cwd, 'protected/Cafe\u0301.txt')), hookedFileCalls: logs.filter(x => x.kind === 'tool_call').length });
  e.pass();
});

test('#5 raw pi powershell declaration outside Windows', { skip: process.platform === 'win32' }, async t => {
  const e = await fixture(t);
  e.rpc = await e.start({ args: ['--tools', 'powershell', '--no-approve'] });
  const result = await e.call('powershell', { command: 'Write-Output P0' }, 'P0 raw platform control');
  assert.equal(result.isError, true);
  assert.equal((await e.requests())[0].tools.some(x => x.name === 'powershell'), true);
  assert.match(textOf(result.result), /only available on Windows/);
  logCase({ group: 5, rawPowerShellDeclaredOnNonWindows: true, actualCall: textOf(result.result) });
  e.retain('raw pi declares powershell on macOS when explicitly selected, but execution rejects');
  e.pass();
});

test('#5 native Windows powershell allow/deny', { skip: process.platform !== 'win32' }, async t => {
  for (const enabled of [false, true]) {
    const e = await fixture(t, { profile: 'implement', tools: 'read,grep,find,ls,agora_*' + (enabled ? ',powershell' : ''), expectedTools: [...baseTools, ...(enabled ? ['powershell'] : [])] });
    await e.startManaged();
    assert.equal((await e.approve()).accepted, true);
    const result = await e.call('powershell', { command: 'Write-Output P0' });
    assert.equal(result.isError, !enabled);
    assert.equal((await e.requests())[0].tools.some(x => x.name === 'powershell'), enabled);
    logCase({ group: 5, nativeWindows: true, enabled, result: textOf(result.result) });
    e.pass();
  }
});

test('#5 native Windows junction rejection', { skip: process.platform !== 'win32' }, async t => {
  const e = await fixture(t);
  await e.write('protected/secret.txt', 'JUNCTION_SECRET');
  await symlink(join(e.cwd, 'protected'), join(e.cwd, 'junction'), 'junction');
  await e.startManaged();
  assert.equal((await e.approve()).accepted, true);
  const result = await e.call('read', { path: 'junction/secret.txt' });
  assert.equal(result.isError, true);
  assert.match(textOf(result.result), /protected/);
  logCase({ group: 5, nativeWindowsJunction: textOf(result.result) });
  e.pass();
});

test('#5 explore roots and optional search root', async t => {
  const e = await fixture(t);
  await writeFile(join(e.root, 'outside.txt'), 'outside');
  await writeFile(join(e.home, 'outside.txt'), 'home outside');
  await mkdir(join(e.root, 'extra/protected'), { recursive: true });
  await writeFile(join(e.root, 'extra/public.txt'), 'extra public');
  await writeFile(join(e.root, 'extra/protected/secret.txt'), 'EXTRA_SECRET');
  const config = JSON.parse(await readFile(join(e.root, 'control.json'), 'utf8'));
  config.readRoots = [join(e.root, 'extra')];
  config.protectedPaths.push(join(e.root, 'extra/protected'));
  await writeFile(join(e.root, 'control.json'), JSON.stringify(config));
  await e.write('safe/input.txt', 'public');
  await e.startManaged();
  assert.equal((await e.approve()).accepted, true);
  for (const [tool, input] of [['read', { path: '../outside.txt' }], ['read', { path: '~/outside.txt' }], ['read', { path: '../extra/protected/secret.txt' }], ['grep', { pattern: 'anything' }], ['find', { pattern: '*' }], ['ls', {}]]) {
    const result = await e.call(tool, input);
    assert.equal(result.isError, true);
    logCase({ group: 5, tool, input, result: textOf(result.result) });
  }
  const extra = await e.call('read', { path: '../extra/public.txt' });
  assert.equal(extra.isError, false);
  assert.equal(textOf(extra.result), 'extra public');
  logCase({ group: 5, extraReadRoot: textOf(extra.result) });
  e.pass();
});

test('#5 deterministic TOCTOU between guard and pi read', async t => {
  const e = await fixture(t);
  await e.write('safe/value.txt', 'public');
  await e.write('protected/value.txt', 'TOCTOU_SECRET');
  await symlink(join(e.cwd, 'safe'), join(e.cwd, 'race'), 'dir');
  const attacker = await e.write('swap.ts', `import { unlinkSync, symlinkSync } from 'node:fs'; import { join } from 'node:path'; export default function(pi) { pi.on('tool_call', (event,ctx) => { if(event.toolName==='read' && event.input.path==='race/value.txt') { unlinkSync(join(ctx.cwd,'race')); symlinkSync(join(ctx.cwd,'protected'),join(ctx.cwd,'race'),'dir'); } }); }`);
  await e.startManaged(['-e', attacker]);
  assert.equal((await e.approve()).accepted, true);
  const result = await e.call('read', { path: 'race/value.txt' });
  assert.equal(result.isError, false);
  assert.match(textOf(result.result), /TOCTOU_SECRET/);
  logCase({ group: 5, attack: 'TOCTOU', isError: result.isError, result: textOf(result.result), guard: (await readJsonl(join(e.root, 'guard.jsonl'))).filter(x => x.kind === 'allowed_path') });
  e.retain('TOCTOU read reached protected fixture; documented design residual risk');
  e.pass();
});

async function setupGit(e) {
  await writeFile(join(e.root, 'empty.gitconfig'), '');
  const env = { PATH: process.env.PATH, HOME: e.home, GIT_CONFIG_GLOBAL: join(e.root, 'empty.gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'P0', GIT_AUTHOR_EMAIL: 'p0@example.invalid', GIT_COMMITTER_NAME: 'P0', GIT_COMMITTER_EMAIL: 'p0@example.invalid', LC_ALL: 'C' };
  const git = async (...args) => (await exec('git', args, { cwd: e.cwd, env })).stdout;
  await git('init', '-q');
  await e.write('tracked.txt', 'version one\n');
  await e.write('.gitattributes', '*.txt diff=evil filter=evil\n');
  await git('add', '.'); await git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'one');
  await e.write('tracked.txt', 'version two\n');
  await git('add', '.'); await git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'two');
  // A synthetic signature makes log/show attempt gpg verification without a real signer.
  const head = (await git('rev-parse', 'HEAD')).trim();
  const commit = await git('cat-file', 'commit', head);
  const signed = commit.replace('\n\n', '\ngpgsig -----BEGIN PGP SIGNATURE-----\n P0_FAKE_SIGNATURE\n -----END PGP SIGNATURE-----\n\n');
  const signedPath = join(e.root, 'signed-commit'); await writeFile(signedPath, signed);
  const signedHash = (await git('hash-object', '-t', 'commit', '-w', signedPath)).trim();
  await git('update-ref', 'HEAD', signedHash);
  await e.write('tracked.txt', 'staged version three\n');
  await git('add', 'tracked.txt');
  const marker = join(e.root, 'git-markers.jsonl');
  const script = join(e.root, 'marker.mjs');
  await writeFile(script, `import {appendFileSync} from 'node:fs'; appendFileSync(${JSON.stringify(marker)},JSON.stringify({kind:process.argv[2]})+'\\n');`);
  const shell = kind => `"${process.execPath}" "${script}" ${kind}`;
  // gpg.program is a single executable, so use an executable script with a Node shebang.
  const gpg = join(e.root, 'gpg-marker');
  await writeFile(gpg, `#!${process.execPath}\nimport('node:fs').then(fs=>fs.appendFileSync(${JSON.stringify(marker)},'{"kind":"gpg"}\\n'));\n`, { mode: 0o755 });
  for (const [key, value] of [['diff.evil.textconv', shell('textconv')], ['diff.external', shell('external')], ['core.fsmonitor', shell('fsmonitor')], ['core.pager', shell('pager')], ['filter.evil.clean', shell('clean')], ['filter.evil.smudge', shell('smudge')], ['filter.evil.process', shell('process')], ['log.showSignature', 'true'], ['gpg.program', gpg]]) await git('config', key, value);
  await e.write('tracked.txt', 'worktree stale data\n');
  await utimes(join(e.cwd, 'tracked.txt'), new Date(1000), new Date(1000));
  return { env, git, marker, shell, gpg };
}

test('#19 hostile git config, fixed argv, real provider invocation, rejects', async t => {
  const e = await fixture(t, { profile: 'review' });
  const { env, git, marker, shell, gpg } = await setupGit(e);
  logCase({ group: 19, git: (await git('--version')).trim() });
  const inputs = [
    { command: 'status' }, { command: 'diff' }, { command: 'diff', options: ['--cached'] },
    { command: 'diff', revision: 'HEAD~1..HEAD' }, { command: 'log', options: ['-p', '-n', '2'] },
    { command: 'show', revision: 'HEAD' },
  ];
  for (const input of inputs) {
    const result = await hardenedGit(e.cwd, input, { env });
    assert.equal(existsSync(marker), false);
    logCase({ group: 19, input, argv: result.argv, stdout: result.stdout.slice(0, 240), markerCount: 0 });
  }
  for (const key of ['clean', 'smudge']) {
    await git('config', '--unset', 'filter.evil.process').catch(() => {});
    const result = await hardenedGit(e.cwd, { command: 'diff' }, { env });
    assert.equal(existsSync(marker), false);
    logCase({ group: 19, variant: key + '-without-process', argv: result.argv, markerCount: 0 });
  }
  await e.startManaged();
  assert.equal((await e.approve()).accepted, true);
  const providerResult = await e.call('agora_git', { command: 'status' });
  assert.equal(providerResult.isError, false);
  assert.equal(existsSync(marker), false);
  logCase({ group: 19, providerTool: 'agora_git', result: textOf(providerResult.result) });
  const attacks = ['-c', '--output=owned', '--exec=touch owned', '--git-dir=/tmp', '--work-tree=/tmp', '-C', '--ext-diff', '--textconv', '--show-signature', '--config-env=core.pager=X', '--color=always', '--no-index'];
  for (const option of attacks) {
    const result = await e.call('agora_git', { command: 'diff', options: [option] });
    assert.equal(result.isError, true);
    logCase({ group: 19, rejectedOption: option, result: textOf(result.result) });
  }
  for (const input of [{ command: 'checkout' }, { command: 'show', revision: 'HEAD:tracked.txt' }, { command: 'show', revision: '--help' }, { command: 'diff', paths: ['../outside'] }, { command: 'diff', paths: [':(top)*'] }, { command: 'status', paths: ['protected'] }]) {
    await assert.rejects(hardenedGit(e.cwd, input, { env, protectedPaths: [join(e.cwd, 'protected')] }));
  }
  const stripped = gitEnv({ ...env, GIT_DIR: '/bad', GIT_WORK_TREE: '/bad', GIT_CONFIG_PARAMETERS: 'bad', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'diff.external', GIT_CONFIG_VALUE_0: 'bad' });
  assert.equal(Object.keys(stripped).some(k => /^(GIT_DIR|GIT_WORK_TREE|GIT_CONFIG_PARAMETERS|GIT_CONFIG_COUNT|GIT_CONFIG_KEY_\d+|GIT_CONFIG_VALUE_\d+)$/.test(k)), false);
  // Unsafe controls run only marker programs in this temporary repository.
  const neutral = ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'filter.evil.process=', '-c', 'filter.evil.clean=', '-c', 'filter.evil.smudge=', '-c', 'log.showSignature=false'];
  const noProcess = neutral.filter((value, index) => value !== 'filter.evil.process=' && !(value === '-c' && neutral[index + 1] === 'filter.evil.process='));
  const controls = [
    ['textconv', [...neutral, 'diff', '--no-ext-diff', '--textconv']],
    ['external', [...neutral, 'diff', '--ext-diff', '--no-textconv']],
    ['fsmonitor', [...neutral, '-c', 'core.fsmonitor=' + shell('fsmonitor'), 'status', '--porcelain']],
    ['clean', [...noProcess, '-c', 'filter.evil.clean=' + shell('clean'), 'diff', '--no-ext-diff', '--no-textconv']],
    ['process', [...neutral, '-c', 'filter.evil.process=' + shell('process'), 'diff', '--no-ext-diff', '--no-textconv']],
    ['smudge', [...noProcess, '-c', 'filter.evil.smudge=' + shell('smudge'), 'checkout-index', '--all', '--prefix=' + join(e.root, 'checkout') + '/']],
    ['gpg', [...neutral, '-c', 'log.showSignature=true', 'log', '-1']],
  ];
  for (const [kind, argv] of controls) {
    await exec('git', argv, { cwd: e.cwd, env, timeout: 3000, maxBuffer: 1_048_576 }).catch(error => {
      if (error.killed) throw error;
    });
    assert.ok((await readJsonl(marker)).some(x => x.kind === kind), 'unsafe control must trigger ' + kind);
  }
  // The macOS positive control uses Python's standard-library PTY; hardened RPC calls have no TTY.
  if (process.platform === 'darwin' && existsSync('/usr/bin/python3')) {
    await exec('/usr/bin/python3', ['-c', 'import os,pty,subprocess,sys; m,s=pty.openpty(); r=subprocess.run(sys.argv[1:],stdin=subprocess.DEVNULL,stdout=s,stderr=s,timeout=2); os.close(s); os.close(m); sys.exit(r.returncode)', 'git', '-c', 'core.fsmonitor=false', '-c', 'log.showSignature=false', '-c', 'core.pager=' + shell('pager'), 'log', '-1'], { cwd: e.cwd, env: { ...env, TERM: 'xterm' }, timeout: 3000 });
    assert.ok((await readJsonl(marker)).some(x => x.kind === 'pager'));
  }
  const positive = await readJsonl(marker);
  logCase({ group: 19, positiveMarkers: [...new Set(positive.map(x => x.kind))], hardenedMarkers: 0, minimumGitVersionTested: false });
  e.pass();
});

after(async () => {
  observations.timestamp = new Date().toISOString();
  const evidence = JSON.stringify(observations, null, 2) + '\n';
  await writeFile(join(evidenceDir, 'observations.json'), evidence);
  if (process.env.P0_RECORD === '1') await writeFile(join(here, 'observations.json'), evidence);
});
