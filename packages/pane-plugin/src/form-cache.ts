import { mkdir, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { FormSpec } from "@pi-pane/plugin-api";

export const MAX_FORM_CACHE_BYTES = 8 * 1024 * 1024;
export const MAX_FORM_CACHE_ITEMS = 4096;
export const FORM_CACHE_FILE = "forms-cache.json";
export interface FormRecord { form: FormSpec; kind: string; id: string }

type Check = (value: any) => any;
const invalid = (): never => { throw new Error("agora 表单缓存格式无效"); };
const string: Check = value => typeof value === "string" ? value : invalid();
const boolean: Check = value => typeof value === "boolean" ? value : invalid();
const integer: Check = value => Number.isSafeInteger(value) && value >= 0 ? value : invalid();
const date: Check = value => typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : invalid();
function array(check: Check, max = MAX_FORM_CACHE_ITEMS): Check {
  return value => Array.isArray(value) && value.length <= max ? value.map(check) : invalid();
}
function object(value: any, required: Record<string, Check>, optional: Record<string, Check>, strict: boolean): any {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const checks = { ...required, ...optional }, result: Record<string, unknown> = {};
  if (strict && Object.keys(value).some(key => !Object.hasOwn(checks, key))) return invalid();
  for (const [key, check] of Object.entries(checks)) {
    if (value[key] === undefined && !Object.hasOwn(required, key)) continue;
    result[key] = check(value[key]);
  }
  return result;
}
function displayForm(value: any, strict: boolean): FormSpec {
  const option: Check = value => object(value, { label: string }, { description: string, recommended: boolean, preview: string }, strict);
  const question: Check = value => object(value, { id: string, question: string }, {
    header: string, detail: string, multiSelect: boolean, allowCustom: boolean, options: array(option),
    dependsOn: value => object(value, { questionId: string }, { value: value => typeof value === "string" ? value : array(string)(value) }, strict),
  }, strict);
  const field = (depth: number): Check => value => {
    if (depth > 16) return invalid();
    return object(value, { id: string, label: string, type: value => ["text", "textarea", "number", "select", "checkbox", "group"].includes(value) ? value : invalid() }, {
      description: string, required: boolean, options: array(string), default: string, fields: array(field(depth + 1)), min: integer, max: integer,
    }, strict);
  };
  return object(value, { id: string, source: string, revision: value => integer(value) > 0 ? value : invalid(), title: string, createdAt: date }, {
    description: string, questions: array(question, 5), fields: array(field(0)), submitLabel: string,
    cancel: value => object(value, { label: string }, {}, strict), expiresAt: date, nodeId: string,
  }, strict);
}
export function displayRecord(value: any, strict = false): FormRecord {
  const result = object(value, {
    kind: value => ["request", "confirmation", "device", "decision"].includes(value) ? value : invalid(),
    id: value => typeof value === "string" && value && !value.includes("/") ? value : invalid(),
    form: value => displayForm(value, strict),
  }, {}, strict) as FormRecord;
  if (result.form.source !== "agora" || result.form.id !== `agora:${result.kind}:${result.id}`) return invalid();
  return result;
}
function encode(records: Iterable<FormRecord>): string {
  const items: FormRecord[] = [];
  let bytes = Buffer.byteLength('{"version":1,"records":[]}');
  const ids = new Set<string>();
  for (const value of records) {
    if (items.length >= MAX_FORM_CACHE_ITEMS) throw new Error("agora 表单缓存事项超过限制");
    const item = displayRecord(value, true);
    if (ids.has(item.form.id)) return invalid();
    ids.add(item.form.id);
    bytes += Buffer.byteLength(JSON.stringify(item)) + (items.length ? 1 : 0);
    if (bytes > MAX_FORM_CACHE_BYTES) throw new Error("agora 表单缓存超过 8 MiB 限制");
    items.push(item);
  }
  return JSON.stringify({ version: 1, records: items });
}

export function createFormCache(dataDir: string | undefined, active: () => void) {
  let writes: Promise<void> = Promise.resolve();
  return {
    async load(): Promise<Map<string, FormRecord>> {
      active();
      if (!dataDir) return new Map();
      let file;
      try { file = await open(join(dataDir, FORM_CACHE_FILE), "r"); }
      catch (error) {
        active();
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
        throw error;
      }
      let bytes: Buffer;
      try {
        active();
        const stat = await file.stat();
        active();
        if (!stat.isFile() || stat.size > MAX_FORM_CACHE_BYTES) throw new Error("agora 表单缓存超过限制或不是普通文件");
        const buffer = Buffer.alloc(MAX_FORM_CACHE_BYTES + 1);
        let size = 0;
        while (size < buffer.length) {
          active();
          const read = await file.read(buffer, size, buffer.length - size, null);
          active();
          if (!read.bytesRead) break;
          size += read.bytesRead;
        }
        if (size > MAX_FORM_CACHE_BYTES) throw new Error("agora 表单缓存超过 8 MiB 限制");
        bytes = buffer.subarray(0, size);
      } finally { await file.close(); }
      active();
      const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      const envelope = object(value, { version: value => value === 1 ? value : invalid(), records: array(value => displayRecord(value, true)) }, {}, true);
      const items: FormRecord[] = envelope.records;
      if (new Set(items.map(item => item.form.id)).size !== items.length) return invalid();
      return new Map(items.map(item => [item.form.id, item]));
    },
    save(records: Iterable<FormRecord>): Promise<void> {
      // 在入队时固定快照，所有写盘按调用顺序执行。
      active();
      const payload = encode(records);
      const write = writes.then(async () => {
        active();
        if (!dataDir) return;
        await mkdir(dataDir, { recursive: true, mode: 0o700 });
        active();
        const temporary = join(dataDir, `${FORM_CACHE_FILE}.${randomUUID()}.tmp`);
        try {
          const file = await open(temporary, "wx", 0o600);
          try {
            active();
            await file.writeFile(payload, "utf8");
            active();
            await file.sync();
          } finally { await file.close(); }
          active();
          await rename(temporary, join(dataDir, FORM_CACHE_FILE));
          active();
        } finally { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
      });
      writes = write.catch(() => {});
      return write;
    },
  };
}
