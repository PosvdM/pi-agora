import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { JsonlDecoder } from './jsonl.mjs';

export class DeadlineError extends Error {
  constructor(label, timeoutMs) {
    super(`${label} exceeded ${timeoutMs}ms`);
    this.name = 'DeadlineError';
    this.timeoutMs = timeoutMs;
  }
}

/** Returning undefined leaves a dialog unanswered; notifications never consume steps. */
export function scriptedUi(steps = []) {
  let index = 0;
  return async (request) => {
    const step = steps[index++];
    if (!step) return undefined;
    if (step.method && step.method !== request.method) {
      throw new Error(`UI expected ${step.method}, received ${request.method}`);
    }
    if (step.delayMs) await new Promise((resolve) => setTimeout(resolve, step.delayMs));
    return step.response;
  };
}

export class RpcDriver {
  events = [];
  stderr = '';
  #pending = new Map();
  #waiters = new Set();
  #listeners = new Set();
  #counter = 0;
  #writeQueue = Promise.resolve();
  #failure;
  #closed = false;
  #start = performance.now();

  constructor({ executable = 'pi', args = [], env, cwd, logPath, stderrPath, ui }) {
    this.logPath = logPath;
    this.stderrPath = stderrPath;
    this.ui = ui;
    this.child = spawn(executable, ['--mode', 'rpc', ...args], {
      cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.exit = new Promise((resolve) => {
      this.child.once('close', (code, signal) => {
        this.#closed = true;
        this.exitInfo = { code, signal };
        this.#fail(new Error(`pi closed: ${JSON.stringify(this.exitInfo)}; stderr=${this.stderr}`));
        resolve(this.exitInfo);
      });
    });
    this.child.on('error', (error) => this.#fail(error));
    this.child.stdin.on('error', (error) => this.#fail(error));
    const decoder = new JsonlDecoder((event) => this.#record(event));
    this.child.stdout.on('data', (chunk) => {
      try { decoder.push(chunk); } catch (error) { this.#protocolFailure(error, chunk); }
    });
    this.child.stdout.on('end', () => {
      try { decoder.end(); } catch (error) { this.#protocolFailure(error); }
    });
    this.child.stderr.on('data', (chunk) => {
      this.stderr += chunk.toString('utf8');
      if (stderrPath) appendFileSync(stderrPath, chunk);
    });
  }

  get cursor() { return this.events.length; }

  #record(event) {
    const record = {
      seq: this.events.length, timestamp: new Date().toISOString(),
      elapsedMs: performance.now() - this.#start, event,
    };
    this.events.push(record);
    if (this.logPath) appendFileSync(this.logPath, `${JSON.stringify(record)}\n`);
    if (event.type === 'response') this.#pending.get(event.id)?.resolve(event);
    for (const listener of this.#listeners) listener(event, record);
    for (const waiter of [...this.#waiters]) waiter.check(record);
    if (event.type === 'extension_ui_request' &&
        ['select', 'confirm', 'input', 'editor'].includes(event.method) && this.ui) {
      Promise.resolve().then(() => this.ui(event, this)).then((response) => {
        if (response !== undefined) return this.respondUi(event.id, response);
      }).catch((error) => this.#fail(error));
    }
  }

  #protocolFailure(error, chunk) {
    if (this.logPath) appendFileSync(this.logPath, `${JSON.stringify({
      timestamp: new Date().toISOString(), kind: 'protocol_error',
      error: String(error), rawBase64: chunk?.toString('base64'),
    })}\n`);
    this.#fail(error);
  }

  #fail(error) {
    this.#failure ??= error;
    for (const pending of [...this.#pending.values()]) pending.reject(error);
    for (const waiter of [...this.#waiters]) waiter.reject(error);
  }

  onEvent(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Serialize writes, waiting for each write callback before queuing more bytes. */
  send(record) {
    const write = this.#writeQueue.then(() => new Promise((resolve, reject) => {
      if (this.#failure) return reject(this.#failure);
      this.child.stdin.write(`${JSON.stringify(record)}\n`, (error) => error ? reject(error) : resolve());
    }));
    this.#writeQueue = write.catch(() => {});
    return write;
  }

  respondUi(id, response) {
    return this.send({ ...response, type: 'extension_ui_response', id });
  }

  /** RPC errors are returned as success:false; transport/deadline errors reject. */
  command(command, { timeoutMs = 10_000 } = {}) {
    if (this.#failure) return Promise.reject(this.#failure);
    const id = command.id ?? `p0-${++this.#counter}`;
    if (this.#pending.has(id)) return Promise.reject(new Error(`Duplicate pending id: ${id}`));
    return new Promise((resolve, reject) => {
      const finish = (fn, value) => {
        clearTimeout(timer);
        this.#pending.delete(id);
        fn(value);
      };
      const timer = setTimeout(() => finish(reject, new DeadlineError(`RPC ${command.type} (${id})`, timeoutMs)), timeoutMs);
      this.#pending.set(id, {
        resolve: (value) => finish(resolve, value),
        reject: (error) => finish(reject, error),
      });
      this.send({ ...command, id }).catch((error) => this.#pending.get(id)?.reject(error));
    });
  }

  /** from is an event-array cursor; historical records are checked before waiting. */
  waitFor(typeOrPredicate, { from = 0, timeoutMs = 10_000 } = {}) {
    const predicate = typeof typeOrPredicate === 'string'
      ? (event) => event.type === typeOrPredicate : typeOrPredicate;
    const match = (record) => record.seq >= from && predicate(record.event, record);
    try {
      const found = this.events.find(match);
      if (found) return Promise.resolve(found.event);
    } catch (error) { return Promise.reject(error); }
    if (this.#failure) return Promise.reject(this.#failure);
    return new Promise((resolve, reject) => {
      const finish = (fn, value) => {
        clearTimeout(timer);
        this.#waiters.delete(waiter);
        fn(value);
      };
      const waiter = {
        check: (record) => {
          try { if (match(record)) finish(resolve, record.event); }
          catch (error) { finish(reject, error); }
        },
        reject: (error) => finish(reject, error),
      };
      const timer = setTimeout(() => finish(reject, new DeadlineError(`Event ${String(typeOrPredicate)}`, timeoutMs)), timeoutMs);
      this.#waiters.add(waiter);
    });
  }

  async promptAndWait(message, { images, timeoutMs = 10_000, ...fields } = {}) {
    const from = this.cursor;
    const response = await this.command({ ...fields, type: 'prompt', message, images }, { timeoutMs });
    if (!response.success || response.data?.disposition === 'handled') return { response };
    const settled = await this.waitFor('agent_settled', { from, timeoutMs });
    return { response, settled };
  }

  killGroup(signal = 'SIGTERM') {
    if (!this.child.pid) return;
    try { process.kill(-this.child.pid, signal); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }

  async stop({ graceMs = 700 } = {}) {
    this.killGroup('SIGTERM');
    if (this.#closed) return this.exitInfo;
    let timer;
    try {
      const exited = await Promise.race([
        this.exit.then(() => true),
        new Promise((resolve) => { timer = setTimeout(() => resolve(false), graceMs); }),
      ]);
      if (!exited) this.killGroup('SIGKILL');
      return await this.exit;
    } finally { clearTimeout(timer); }
  }
}
