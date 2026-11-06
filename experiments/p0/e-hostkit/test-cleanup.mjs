import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { createExperiment } from '../harness/index.mjs';
import { ProcessTracker, snapshot, signalIdentity, delay } from './prototype.mjs';

const key = id => `${id.pid}:${id.startTime}`;
const validIdentity = id => id && Number.isInteger(id.pid) && id.pid > 1 && id.pid !== process.pid && typeof id.startTime === 'string';

// Test-only recovery. Oracle identities never enter the measured ProcessTracker.
export class FixtureCleanup {
  identities = new Map();
  trackers = new Set();
  constructor(native, root, onIdentity = () => {}) {
    this.native = native; this.root = root; this.onIdentity = onIdentity;
  }
  remember(id) {
    if (!validIdentity(id)) throw new Error(`Invalid cleanup identity: ${JSON.stringify(id)}`);
    this.identities.set(key(id), id); this.onIdentity(id); return id;
  }
  collectOracles() {
    const errors = [];
    for (const name of ['oracle.jsonl', 'cleanup-oracle.jsonl']) {
      const file = join(this.root, name);
      if (!existsSync(file)) continue;
      for (const line of readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
        try { this.remember(JSON.parse(line)); } catch (error) { errors.push(`${name}: ${error.message}`); }
      }
    }
    const file = join(this.root, 'daemon.json');
    if (existsSync(file)) {
      try { const value = JSON.parse(readFileSync(file, 'utf8')); this.remember(value.daemon); this.remember(value.child); }
      catch (error) { errors.push(`daemon.json: ${error.message}`); }
    }
    return errors;
  }
  collectDescendants(table) {
    const reachable = new Set(table.filter(p => this.identities.has(key(p))).map(p => p.pid));
    let added;
    do {
      added = false;
      for (const p of table) if (reachable.has(p.ppid) && !reachable.has(p.pid)) {
        this.remember(p); reachable.add(p.pid); added = true;
      }
    } while (added);
  }
  run() { return this.promise ??= this.clean(); }
  async clean() {
    for (const tracker of this.trackers) {
      tracker.pause();
      for (const id of tracker.records.values()) this.remember(id);
    }
    const deadline = Date.now() + 5000;
    let quietSince, parseErrors = [], remaining = [];
    do {
      const count = this.identities.size;
      parseErrors = this.collectOracles();
      const table = snapshot(this.native);
      this.collectDescendants(table);
      const active = table.filter(p => p.status !== 5 && this.identities.has(key(p)));
      // Stop known spawners and children by identity, then reread journals for late arrivals.
      for (const id of active) signalIdentity(this.native, id, 'SIGKILL');
      remaining = snapshot(this.native).filter(p => this.identities.has(key(p)));
      if (remaining.length || parseErrors.length || count !== this.identities.size) quietSince = undefined;
      else quietSince ??= Date.now();
      if (quietSince !== undefined && Date.now() - quietSince >= 250) break;
      await delay(50);
    } while (Date.now() < deadline);
    const report = { identities: [...this.identities.values()], remaining, parseErrors, trackersPaused: this.trackers.size };
    writeFileSync(join(this.root, 'emergency-cleanup.json'), JSON.stringify(report, null, 2));
    if (remaining.length || parseErrors.length) throw new Error(`Emergency cleanup incomplete: ${this.root}; ${JSON.stringify({ remaining, parseErrors })}`);
    return report;
  }
}

export function daemonExtensionSource({ addonPath, worker, log, info, oracle }) {
  return `import {spawn} from 'node:child_process';
import {appendFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const native=createRequire(import.meta.url)(${JSON.stringify(addonPath)});
export default function(pi){pi.on('session_start',()=>{
  const d=spawn(process.execPath,${JSON.stringify([worker, 'daemon', addonPath, log, info])},{detached:true,windowsHide:true,stdio:'ignore',env:process.env});
  const id=JSON.parse(native.snapshot()).find(p=>p.pid===d.pid);
  if(id)appendFileSync(${JSON.stringify(oracle)},JSON.stringify(id)+'\\n');
  d.unref();
});}`;
}

export function writeEvidence(root, target, records, record = process.env.P0_RECORD === '1') {
  const data = records.map(row => JSON.stringify(row)).join('\n') + '\n';
  writeFileSync(join(root, 'evidence.jsonl'), data);
  if (record) {
    const staging = `${target}.${process.pid}.next`;
    writeFileSync(staging, data); renameSync(staging, target);
  }
}

export async function createSafeFixture(t, native, options, onIdentity) {
  const e = await createExperiment(options);
  e.emergency = new FixtureCleanup(native, e.root, onIdentity);
  // Register before returning the fixture or performing any additional I/O.
  t.after(() => e.emergency.run());
  return e;
}

export async function withCleanup(scopes, action) {
  try { return await action(); }
  finally {
    const results = await Promise.allSettled(scopes().map(scope => scope.run()));
    const errors = results.filter(r => r.status === 'rejected').map(r => r.reason);
    if (errors.length) throw new AggregateError(errors, 'Test fixture cleanup failed');
  }
}

export async function withTracker(e, native, root, action) {
  const tracker = new ProcessTracker(native, root);
  e.emergency.remember(root);
  e.emergency.trackers.add(tracker);
  try { return await action(tracker); }
  finally {
    tracker.pause();
    for (const id of tracker.records.values()) e.emergency.remember(id);
  }
}
