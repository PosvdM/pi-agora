import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync, watch } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DeadlineError, RpcDriver } from '../harness/rpc-driver.mjs';

export { RpcDriver, DeadlineError, scriptedUi } from '../harness/rpc-driver.mjs';
export { JsonlDecoder } from '../harness/jsonl.mjs';
export const providerPath = fileURLToPath(new URL('../harness/fake-provider.ts', import.meta.url));

export async function readJsonl(path) {
  if (!existsSync(path)) return [];
  return (await readFile(path, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

/** Prepare an isolated fixture; start only after writing project resources. */
export async function createExperiment({ script = { turns: [] }, settings = {}, env = {}, args = [], ui, executable = 'pi' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pi-p0-'));
  const cwd = join(root, 'cwd');
  const agentDir = join(root, 'agent');
  const home = join(root, 'home');
  const scriptPath = join(root, 'script.json');
  const requestLog = join(root, 'requests.jsonl');
  await Promise.all([cwd, agentDir, home, join(root, 'tmp')].map((path) => mkdir(path, { recursive: true })));
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({
    defaultProvider: 'p0-fake', defaultModel: 'scripted',
    compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: 'off',
    images: { autoResize: false }, enableInstallTelemetry: false, enableAnalytics: false,
    packages: [], ...settings,
  }, null, 2));
  const drivers = [];
  const experiment = {
    root, cwd, agentDir, home, scriptPath, requestLog,
    async setScript(value) {
      const staging = `${scriptPath}.next`;
      await writeFile(staging, JSON.stringify(value, null, 2));
      await rename(staging, scriptPath);
    },
    async enqueue(...replies) {
      const value = JSON.parse(await readFile(scriptPath, 'utf8'));
      (value.turns ??= []).push(...replies);
      await experiment.setScript(value);
    },
    async requests() { return (await readJsonl(requestLog)).filter((entry) => entry.kind === 'request'); },
    async providerEvents() { return readJsonl(requestLog); },
    waitForProvider(predicate, { from = 0, timeoutMs = 10_000 } = {}) {
      return new Promise((resolve, reject) => {
        let done = false;
        const finish = (fn, value) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          watcher.close();
          fn(value);
        };
        const scan = async () => {
          try {
            const records = await readJsonl(requestLog);
            const found = records.slice(from).find(predicate);
            if (found) finish(resolve, found);
          } catch (error) { finish(reject, error); }
        };
        const watcher = watch(root, () => { void scan(); });
        watcher.on('error', (error) => finish(reject, error));
        const timer = setTimeout(() => finish(reject, new DeadlineError('Provider log', timeoutMs)), timeoutMs);
        void scan();
      });
    },
    async write(relativePath, content) {
      const path = join(cwd, relativePath);
      if (relativePath.startsWith('/') || relativePath.split('/').includes('..')) throw new Error('Use a cwd-relative fixture path');
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content);
      return path;
    },
    async start(overrides = {}) {
      const sequence = drivers.length + 1;
      const driver = guardStop(new RpcDriver({
        executable: overrides.executable ?? executable,
        cwd,
        // Caller env is explicit. Parent credentials and PI_* session state are not inherited.
        env: {
          PATH: process.env.PATH ?? '/opt/homebrew/bin:/usr/bin:/bin',
          LANG: 'en_US.UTF-8', TERM: 'dumb', ...env, ...overrides.env,
          HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache'),
          TMPDIR: join(root, 'tmp'), PI_CODING_AGENT_DIR: agentDir,
          PI_CODING_AGENT_SESSION_DIR: join(agentDir, 'sessions'),
          PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0',
          P0_SCRIPT_PATH: scriptPath, P0_REQUEST_LOG: requestLog,
        },
        args: [
          '--offline', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes',
          '--extension', providerPath, ...args, ...(overrides.args ?? []),
        ],
        ui: overrides.ui ?? ui,
        logPath: join(root, `rpc-${sequence}.jsonl`), stderrPath: join(root, `stderr-${sequence}.log`),
      }));
      drivers.push(driver);
      try {
        const state = await driver.command({ type: 'get_state' }, { timeoutMs: overrides.startupTimeoutMs ?? 20_000 });
        if (!state.success) throw new Error(`Startup get_state failed: ${JSON.stringify(state)}`);
        return driver;
      } catch (error) {
        await driver.stop();
        error.message += `; retained fixture: ${root}`;
        throw error;
      }
    },
    async stop() { await Promise.all(drivers.map((driver) => driver.stop())); },
    async cleanup() {
      await experiment.stop();
      await rm(root, { recursive: true, force: true });
    },
  };
  await experiment.setScript(script);
  return experiment;
}

// A driver is stopped at most once; exited children must never receive a signal by stale PGID.
export function guardStop(driver) {
  const stop = driver.stop.bind(driver);
  let stopping;
  driver.stop = (...args) => {
    stopping ??= Promise.resolve().then(() =>
      driver.child.exitCode != null || driver.child.signalCode != null ? driver.exit : stop(...args));
    return stopping;
  };
  return driver;
}
