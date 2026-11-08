import { createHash, createPublicKey, randomBytes, verify, type KeyObject } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { acquireInstanceLock } from "pi-hostkit";
import type { Connection } from "./auth.js";
import { budgetConfig } from "./budgets.js";
import { AgoraError, invalid, text } from "./errors.js";
import { Store, id, now, openStore } from "./store.js";

export const SIGNATURE_ALGORITHM = "ECDSA-P256-SHA256";
export interface UserChallenge {
  action: string; target: string; paramsHash: string; nonce: string; expiresAt: string;
}
export interface DeviceProof {
  deviceId: string; confirmationId: string; requestedBy: string; confirmedBy: "device";
}
export interface SignatureBody {
  deviceId: string; publicKey: string; alg: string; signature: string;
}
export type Execute = (action: string, target: string, params: Record<string, unknown>, proof: DeviceProof) => unknown;
export interface Device {
  deviceId: string; publicKey: string; fingerprint: string; label: string;
  state: "pending" | "paired"; createdAt: string;
}
interface DeviceRow { id: string; public_key: string; label: string; state: "pending" | "paired"; created_at: string }
interface ConfirmationRow {
  id: string; action: string; target: string; params: string; challenge: string; nonce: string;
  expires_at: string; requested_by: string; state: string; consumed_at: string | null;
  confirmed_by: string | null; result: string | null; failure_reason: string | null; created_at: string;
}
interface AlertRow {
  id: string; kind: string; revision: number; details: string; acknowledged_at: string | null;
  acknowledged_by: string | null; created_at: string;
}
export type LimitSettings = number | Record<string, number>;
export type ConfigKey = "userConfirmation" | "agentLimitCap" | "meetingLimitDefaults" | "taskLimitDefaults" | "tokenAccounting";
const meetingDefaults = { maxTokens: 2_000_000, maxModelCalls: 200, maxDurationMinutes: 90, maxCycles: 6, diagnosticReserveTokens: 60_000 };
const INTERNAL_ACTIONS = [
  "agora.device.pair", "agora.device.approve", "agora.device.revoke", "agora.device.reset",
  "agora.settings.set", "agora.security.acknowledge",
] as const;
export type InternalAction = typeof INTERNAL_ACTIONS[number];
const internalActions: ReadonlySet<string> = new Set(INTERNAL_ACTIONS);
function isInternalAction(action: string): action is InternalAction { return internalActions.has(action); }
// 外部动作的参数由 HTTP 层逐项校验；此处只允许明确的用户级动作。
const EXTERNAL_ACTIONS = [
  "agora.request.answer", "agora.request.cancel", "agora.task.spawn", "agora.task.limits",
  "agora.task.recover", "agora.task.takeover", "agora.principal.takeover",
] as const;
export type ExternalAction = typeof EXTERNAL_ACTIONS[number];
const externalActions: ReadonlySet<string> = new Set(EXTERNAL_ACTIONS);
function isExternalAction(action: string): action is ExternalAction { return externalActions.has(action); }
const AUDIT_REASONS = new Set([
  "not_found", "already_handled", "confirmation_expired", "challenge_mismatch", "invalid_signature",
  "device_mismatch", "invalid_params", "invalid_action", "forbidden", "token_expired", "lease_required",
  "conflict", "confirmation_required", "invalid_proof", "transaction_active", "operation_interrupted",
]);
function auditReason(error: unknown): string {
  return error instanceof AgoraError && AUDIT_REASONS.has(error.code) ? error.code : "execution_failed";
}
function fail(code: string, message: string, status = 403): never { throw new AgoraError(status, code, message); }
function validString(value: string): void {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) invalid("JSON 字符串包含孤立代理项");
    } else if (c >= 0xdc00 && c <= 0xdfff) invalid("JSON 字符串包含孤立代理项");
  }
}
/** RFC 8785：数值使用 ECMAScript 序列化，键按 UTF-16 码元排序，拒绝非 JSON 值。 */
export function jcs(value: unknown): string {
  const ancestors = new Set<object>();
  function encode(item: unknown): string {
    if (item === null) return "null";
    if (typeof item === "string") { validString(item); return JSON.stringify(item); }
    if (typeof item === "boolean") return String(item);
    if (typeof item === "number") { if (!Number.isFinite(item)) invalid("JSON 数值必须有限"); return JSON.stringify(item); }
    if (typeof item !== "object") invalid("参数必须是 JSON 值");
    const obj = item as object;
    if (ancestors.has(obj)) invalid("JSON 参数不能循环引用");
    if (!Array.isArray(obj) && Object.getPrototypeOf(obj) !== Object.prototype && Object.getPrototypeOf(obj) !== null) invalid("参数必须是普通 JSON 对象");
    if (Object.getOwnPropertySymbols(obj).length) invalid("JSON 参数不能包含 Symbol");
    ancestors.add(obj);
    try {
      if (Array.isArray(obj)) {
        if (Object.keys(obj).length !== obj.length || Object.getOwnPropertyNames(obj).length !== obj.length + 1) invalid("JSON 数组不能包含空位或额外属性");
        const values: string[] = [];
        for (let i = 0; i < obj.length; i++) {
          const descriptor = Object.getOwnPropertyDescriptor(obj, String(i));
          if (!descriptor || !("value" in descriptor)) invalid("JSON 参数不能包含访问器");
          values.push(encode(descriptor.value));
        }
        return `[${values.join(",")}]`;
      }
      const keys = Object.getOwnPropertyNames(obj).sort();
      return `{${keys.map(key => {
        validString(key);
        const descriptor = Object.getOwnPropertyDescriptor(obj, key)!;
        if (!descriptor.enumerable || !("value" in descriptor)) invalid("JSON 参数不能包含访问器或不可枚举属性");
        return `${JSON.stringify(key)}:${encode(descriptor.value)}`;
      }).join(",")}}`;
    } finally { ancestors.delete(obj); }
  }
  return encode(value);
}
export function paramsHash(value: unknown): string { return createHash("sha256").update(jcs(value), "utf8").digest("base64url"); }
export function signingData(challenge: UserChallenge): Buffer {
  return Buffer.from(jcs({ domain: "pi-pane/user-presence/v1", payload: challenge }), "utf8");
}
function decode(value: unknown, name: string, max: number): Buffer {
  const encoded = text(value, name, max);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) invalid(`${name} 必须是 base64url`);
  const buffer = Buffer.from(encoded, "base64url");
  if (buffer.toString("base64url") !== encoded) invalid(`${name} 编码无效`);
  return buffer;
}
function publicKey(value: unknown): { encoded: string; key: KeyObject } {
  const der = decode(value, "publicKey", 1024);
  let key: KeyObject;
  try { key = createPublicKey({ key: der, type: "spki", format: "der" }); }
  catch { return invalid("设备公钥必须是 SPKI P-256 公钥"); }
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") invalid("设备公钥必须使用 P-256");
  const encoded = (key.export({ type: "spki", format: "der" }) as Buffer).toString("base64url");
  if (encoded !== value) invalid("设备公钥必须采用规范 SPKI 编码");
  return { encoded, key };
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("参数必须是 JSON 对象");
  jcs(value);
  return value as Record<string, unknown>;
}
function exact(params: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(params).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(params, key))) invalid("动作参数不匹配");
}

export class Security {
  private activeProof?: DeviceProof;
  private activeOperation?: { action: string; target: string; params: string };
  constructor(readonly store: Store) {
    this.store.transaction(() => {
      for (const [key, value] of [["userConfirmation", "device"], ["everPaired", false], ["reTofuArmed", false]] as const) {
        this.store.run("INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)", key, jcs(value));
      }
      for (const row of this.store.all<ConfirmationRow>("SELECT * FROM pending_confirmations WHERE state='executing'")) {
        this.store.run("UPDATE pending_confirmations SET state='failed',failure_reason='operation_interrupted' WHERE id=?", row.id);
        this.settleOperations(row.id, "failed", undefined, "operation_interrupted");
        this.log(row.action, row.target, row.requested_by, "device", "failed", { reason: "operation_interrupted", proof: row.confirmed_by ? { deviceId: row.confirmed_by, confirmationId: row.id, requestedBy: row.requested_by, confirmedBy: "device" } : undefined, confirmationId: row.id });
        this.store.change("confirmation", row.id);
      }
    });
    this.checkState();
  }
  static async offline(home: string, words: string[]): Promise<unknown> {
    const runDirectory = path.join(home, "run");
    await mkdir(runDirectory, { recursive: true });
    const lock = await acquireInstanceLock("daemon", runDirectory);
    if (!lock) throw new AgoraError(409, "daemon_running", "请先停止 daemon 再运行离线命令");
    let store: Store | undefined;
    try {
      store = await openStore(home);
      return new Security(store).applyOffline(words);
    } finally {
      try { store?.close(); } finally { await lock.release(); }
    }
  }
  private setting<T>(key: string, fallback: T): T {
    const row = this.store.get<{ value: string }>("SELECT value FROM settings WHERE key=?", key);
    return row ? JSON.parse(row.value) as T : fallback;
  }
  private put(key: string, value: unknown): void {
    this.store.run("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", key, jcs(value));
  }
  private actor(conn: Connection): string {
    if (conn.type === "agent:child") fail("forbidden", "子代理不能发起或确认用户级操作");
    if (conn.expiresAt <= Date.now()) fail("token_expired", "连接已过期", 401);
    if (conn.type === "host:cli" || conn.type === "host:pane") return conn.type;
    if (conn.type !== "agent:main") fail("forbidden", "连接身份无效");
    const principal = conn.principalId ? this.store.principal(conn.principalId) : undefined;
    if (!principal || principal.type !== "agent:main" || principal.lease_connection_id !== conn.connectionId || (principal.lease_expires_at ?? 0) <= Date.now()) fail("lease_required", "请先取得主会话控制租约", 409);
    return principal.id;
  }
  private fingerprint(): string {
    return paramsHash(this.store.all<DeviceRow>("SELECT id,public_key,label,state,created_at FROM devices ORDER BY id").map(row => ({ ...row })));
  }
  private rememberDevices(): void {
    const fingerprint = this.fingerprint();
    this.put("devicesFingerprint", fingerprint); this.put("devicesObservedFingerprint", fingerprint);
  }
  recordExecution(action: string, target: string, requestedBy: string, confirmedBy: "none", outcome: "applied" | "rejected", reason?: string): void {
    this.log(action, target, requestedBy, confirmedBy, outcome, { reason });
  }
  private log(action: string, target: string, requestedBy: string, confirmedBy: string, outcome: string,
    options: { proof?: DeviceProof; reason?: string; via?: string; details?: unknown; confirmationId?: string } = {}): void {
    this.store.run("INSERT INTO security_audit(action,target,requested_by,confirmed_by,device_id,confirmation_id,outcome,reason,via,details,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      action, target, requestedBy, confirmedBy, options.proof?.deviceId ?? null,
      options.proof?.confirmationId ?? options.confirmationId ?? null, outcome, options.reason ?? null, options.via ?? "online",
      options.details === undefined ? null : jcs(options.details), now());
  }
  private alert(kind: string, details: unknown, via: "online" | "offline" = "online"): void {
    const previous = this.store.get<AlertRow>("SELECT * FROM security_alerts WHERE kind=?", kind);
    const alertId = previous?.id ?? id("sa"), revision = (previous?.revision ?? 0) + 1;
    this.store.run("INSERT INTO security_alerts(id,kind,revision,details,created_at) VALUES(?,?,?,?,?) ON CONFLICT(kind) DO UPDATE SET revision=excluded.revision,details=excluded.details,acknowledged_at=NULL,acknowledged_by=NULL",
      alertId, kind, revision, jcs(details), now());
    this.log("security.state_alert", alertId, "system", "none", "alert", { via, details: { kind, revision, ...record(details) } });
    this.store.change("security_alert", alertId);
  }
  checkState(): void {
    this.store.transaction(() => {
      const current = this.fingerprint();
      const expected = this.setting<string | null>("devicesFingerprint", null);
      const observed = this.setting<string | null>("devicesObservedFingerprint", null);
      if (this.setting("everPaired", false) && current !== observed && (observed !== null || current !== expected)) this.alert("devices-reset", { expected, observed: current });
      if (expected === null && !this.setting("everPaired", false)) this.put("devicesFingerprint", current);
      this.put("devicesObservedFingerprint", current);
      if (this.setting<"device" | "off">("userConfirmation", "device") === "off") {
        const alert = this.store.get<AlertRow>("SELECT * FROM security_alerts WHERE kind='protection-off'");
        if (!alert || alert.acknowledged_at) this.alert("protection-off", { userConfirmation: "off" });
      } else {
        const alert = this.store.get<AlertRow>("SELECT * FROM security_alerts WHERE kind='protection-off' AND acknowledged_at IS NULL");
        if (alert) {
          this.store.run("UPDATE security_alerts SET acknowledged_at=?,acknowledged_by='protection-enabled' WHERE id=?", now(), alert.id);
          this.log("security.state_alert", alert.id, "system", "none", "cleared", { details: { kind: alert.kind, revision: alert.revision, userConfirmation: "device" } });
          this.store.change("security_alert", alert.id);
        }
      }
    });
  }
  state() {
    this.checkState();
    return {
      userConfirmation: this.setting<"device" | "off">("userConfirmation", "device"),
      everPaired: this.setting("everPaired", false), reTofuArmed: this.setting("reTofuArmed", false),
      devices: this.devices(), alerts: this.store.all<AlertRow>("SELECT * FROM security_alerts WHERE acknowledged_at IS NULL ORDER BY created_at,id").map(row => ({
        alertId: row.id, kind: row.kind, revision: row.revision, details: JSON.parse(row.details), createdAt: row.created_at,
      })),
      config: {
        userConfirmation: this.setting<"device" | "off">("userConfirmation", "device"),
        agentLimitCap: this.setting("agentLimitCap", { ...budgetConfig(this.store).cap, perMeetingFactor: 2 }),
        taskLimitDefaults: budgetConfig(this.store).defaults,
        tokenAccounting: budgetConfig(this.store).accounting,
        meetingLimitDefaults: this.setting("meetingLimitDefaults", meetingDefaults),
      },
    };
  }
  devices(): Device[] {
    return this.store.all<DeviceRow>("SELECT * FROM devices ORDER BY created_at,id").map(row => ({
      deviceId: row.id, publicKey: row.public_key, fingerprint: createHash("sha256").update(Buffer.from(row.public_key, "base64url")).digest("base64url"),
      label: row.label, state: row.state, createdAt: row.created_at,
    }));
  }
  audit(limit = 50, cursor = 0, target?: string) { return this.store.all("SELECT * FROM security_audit WHERE seq>? AND (? IS NULL OR target=?) ORDER BY seq LIMIT ?", cursor, target ?? null, target ?? null, limit); }
  private settleOperations(confirmationId: string, state: string, result?: unknown, reason?: string): void {
    const succeeded = state === "confirmed";
    const status = succeeded ? 200 : state === "expired" ? 410 : reason === "execution_failed" ? 500 : 409;
    const body = succeeded ? result : { error: { code: reason ?? `confirmation_${state}`, message: "待确认未执行，请重新核对操作" } };
    this.store.run("UPDATE operations SET state=?,status=?,result=? WHERE state='awaiting_confirmation' AND json_extract(result,'$.confirmation.confirmationId')=?", succeeded ? "succeeded" : "failed", status, JSON.stringify(body) ?? "null", confirmationId);
  }
  private expire(): void {
    this.store.transaction(() => {
      for (const row of this.store.all<ConfirmationRow>("SELECT * FROM pending_confirmations WHERE state='pending' AND expires_at<=? LIMIT 200", now())) {
        this.store.run("UPDATE pending_confirmations SET state='expired' WHERE id=?", row.id);
        this.log(row.action, row.target, row.requested_by, "none", "expired", { confirmationId: row.id, reason: "confirmation_expired" });
        this.settleOperations(row.id, "expired", undefined, "confirmation_expired");
        this.store.change("confirmation", row.id);
      }
    });
  }
  private view(row: ConfirmationRow) {
    return { confirmationId: row.id, challenge: JSON.parse(row.challenge) as UserChallenge,
      title: this.title(row.action, row.target, JSON.parse(row.params)),
      summary: `${row.action} → ${row.target}；发起方 ${row.requested_by}；参数 ${row.params}`,
      action: row.action, target: row.target, requestedBy: row.requested_by, state: row.state,
      expiresAt: row.expires_at, createdAt: row.created_at, confirmedBy: row.confirmed_by,
      result: row.result === null ? null : JSON.parse(row.result), failureReason: row.failure_reason };
  }
  listConfirmations(limit = 50, cursor = 0, requestedBy?: string) { this.expire(); return this.store.all<ConfirmationRow>("SELECT rowid AS cursor,* FROM pending_confirmations WHERE rowid>? AND (? IS NULL OR requested_by=?) ORDER BY rowid LIMIT ?", cursor, requestedBy ?? null, requestedBy ?? null, limit).map(row => this.view(row)); }
  confirmation(confirmationId: string) {
    this.expire(); const row = this.store.get<ConfirmationRow>("SELECT * FROM pending_confirmations WHERE id=?", confirmationId);
    if (!row) fail("not_found", "待确认不存在", 404);
    return this.view(row);
  }
  private title(action: string, target: string, params: Record<string, unknown>): string {
    if (action === "agora.device.pair") return `配对设备：${target}`;
    if (action === "agora.device.approve") return `批准设备：${target}`;
    if (action === "agora.device.revoke") return `撤销设备 ${target}：若这是最后一台设备，撤销后没有设备可以批准新设备，只能离线重置再配对`;
    if (action === "agora.device.reset") return "重置设备配对：保留签名设备，删除其余设备";
    if (action === "agora.security.acknowledge") return `确认知悉设备重置警告：${target}，revision ${params.revision}`;
    if (action === "agora.settings.set" && target === "userConfirmation" && params.value === "off") return "关闭用户确认保护：任何可运行 CLI 的进程都可执行用户操作";
    if (action === "agora.settings.set") return `设置 ${target}：${jcs(params.value)}`;
    return `${action}：${target}`;
  }
  private validate(action: string, target: string, params: Record<string, unknown>): void {
    text(target, "target", 256);
    record(params);
    if (!isInternalAction(action) && !isExternalAction(action)) fail("invalid_action", "不支持此用户级动作", 400);
    switch (action) {
      case "agora.device.pair":
        exact(params, ["deviceId", "publicKey", "label"]);
        if (text(params.deviceId, "deviceId", 128) !== target) invalid("设备与目标不匹配");
        publicKey(params.publicKey); if (typeof params.label !== "string" || params.label.length > 200) invalid("设备标签无效"); break;
      case "agora.device.approve": case "agora.device.revoke": case "agora.device.reset": exact(params, []); break;
      case "agora.security.acknowledge":
        exact(params, ["revision"]);
        if (!Number.isSafeInteger(params.revision) || Number(params.revision) < 1) invalid("警告 revision 无效"); break;
      case "agora.settings.set":
        exact(params, ["value"]);
        if (target === "userConfirmation") { if (params.value !== "off" && params.value !== "device") invalid("userConfirmation 必须是 off 或 device"); }
        else if (target === "tokenAccounting") { if (!["all", "uncached"].includes(String(params.value))) invalid("tokenAccounting 必须是 all 或 uncached"); }
        else if (target === "agentLimitCap" || target === "meetingLimitDefaults" || target === "taskLimitDefaults") {
          const value = record(params.value);
          const fields = target === "agentLimitCap" ? ["perTaskFactor", "perMeetingFactor", "dailyTokens"] : target === "taskLimitDefaults" ? ["maxTokens"] : Object.keys(meetingDefaults);
          const required = target === "agentLimitCap" ? ["perTaskFactor", "dailyTokens"] : fields;
          if (Object.keys(value).some(key => !fields.includes(key)) || required.some(key => !Object.hasOwn(value, key))) invalid("预算配置字段不完整或不受支持");
          for (const [key, number] of Object.entries(value)) if (typeof number !== "number" || !Number.isSafeInteger(number) || number < (key === "diagnosticReserveTokens" ? 0 : 1)) invalid("预算配置必须是有界整数");
          if (target === "meetingLimitDefaults" && Number(value.diagnosticReserveTokens) > Number(value.maxTokens)) invalid("纪要预留不能超过会议总预算");
        }
        else invalid("不支持此安全配置"); break;
    }
  }
  request(conn: Connection, action: string, target: string, params: Record<string, unknown>, ttlMs?: number) {
    const requestedBy = this.actor(conn); this.validate(action, target, params); this.checkState();
    const duration = ttlMs ?? (conn.type === "host:cli" ? 86_400_000 : 300_000);
    if (!Number.isSafeInteger(duration) || duration <= 0 || duration > 86_400_000) invalid("待确认有效期无效");
    const confirmationId = id("cf"), expiresAt = new Date(Date.now() + duration).toISOString();
    const challenge: UserChallenge = { action, target, paramsHash: paramsHash(params), nonce: randomBytes(32).toString("base64url"), expiresAt };
    this.store.transaction(() => {
      this.store.run("INSERT INTO pending_confirmations(id,action,target,params,challenge,nonce,expires_at,requested_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
        confirmationId, action, target, jcs(params), jcs(challenge), challenge.nonce, expiresAt, requestedBy, now());
      this.store.change("confirmation", confirmationId);
      this.log(action, target, requestedBy, "none", "requested", { confirmationId });
      this.store.notice("user", `confirmation:${confirmationId}:created`, "confirmation:created", { confirmationId, action, target, requestedBy, expiresAt });
    });
    return this.confirmation(confirmationId);
  }
  pairChallenge(conn: Connection, body: { deviceId: string; publicKey: string; label?: string }) {
    return this.request(conn, "agora.device.pair", body.deviceId, { deviceId: body.deviceId, publicKey: body.publicKey, label: body.label ?? "" });
  }
  private verified(row: ConfirmationRow | undefined, body: SignatureBody) {
    if (!row) fail("not_found", "待确认不存在", 404);
    if (row.state !== "pending" || row.consumed_at !== null) fail("already_handled", "待确认已处理", 409);
    if (row.expires_at <= now()) fail("confirmation_expired", "待确认已过期", 410);
    const params = record(JSON.parse(row.params)), challenge = JSON.parse(row.challenge) as UserChallenge;
    this.validate(row.action, row.target, params);
    exact(challenge as unknown as Record<string, unknown>, ["action", "target", "paramsHash", "nonce", "expiresAt"]);
    if (challenge.action !== row.action || challenge.target !== row.target || challenge.nonce !== row.nonce || challenge.expiresAt !== row.expires_at || challenge.paramsHash !== paramsHash(params)) fail("challenge_mismatch", "挑战与操作参数不匹配");
    if (body.alg !== SIGNATURE_ALGORITHM) fail("invalid_signature", "签名算法不支持");
    const deviceId = text(body.deviceId, "deviceId", 128), key = publicKey(body.publicKey);
    if (row.action === "agora.device.pair") {
      if (deviceId !== row.target || key.encoded !== params.publicKey) fail("device_mismatch", "配对签名与新设备不匹配");
    } else {
      const device = this.store.get<DeviceRow>("SELECT * FROM devices WHERE id=? AND state='paired'", deviceId);
      if (!device || device.public_key !== key.encoded) fail("device_mismatch", "设备未配对或公钥不符");
    }
    const signature = decode(body.signature, "signature", 128);
    if (signature.length !== 64 || !verify("sha256", signingData(challenge), { key: key.key, dsaEncoding: "ieee-p1363" }, signature)) fail("invalid_signature", "设备签名无效");
    const proof: DeviceProof = Object.freeze({ deviceId, confirmationId: row.id, requestedBy: row.requested_by, confirmedBy: "device" });
    return { params, proof };
  }
  private rejected(conn: Connection, confirmationId: string, row: ConfirmationRow | undefined, error: unknown): void {
    // 只保存拒绝码，不记录签名、凭证、回调错误文本或完整答复。
    const reason = auditReason(error);
    this.store.transaction(() => {
      this.log(row?.action ?? "confirmation.sign", row?.target ?? confirmationId, conn.principalId ?? conn.type, "none", "rejected", { reason, confirmationId });
      if (reason === "confirmation_expired") {
        this.store.run("UPDATE pending_confirmations SET state='expired' WHERE id=? AND state='pending'", confirmationId);
        this.settleOperations(confirmationId, "expired", undefined, reason);
      }
    });
  }
  sign(conn: Connection, confirmationId: string, body: SignatureBody, execute: Execute): unknown {
    let row: ConfirmationRow | undefined;
    try {
      this.actor(conn); this.checkState();
      if (execute.constructor.name === "AsyncFunction") invalid("签名执行回调必须同步");
      return this.store.transaction(() => {
        row = this.store.get<ConfirmationRow>("SELECT * FROM pending_confirmations WHERE id=?", confirmationId);
        const { params, proof } = this.verified(row, body);
        if (!row) throw new Error("待确认读取失败");
        const updated = this.store.run("UPDATE pending_confirmations SET consumed_at=? WHERE id=? AND state='pending' AND consumed_at IS NULL", now(), confirmationId);
        if (!updated.changes) fail("already_handled", "待确认已处理", 409);
        const previousProof = this.activeProof, previousOperation = this.activeOperation;
        this.activeProof = proof; this.activeOperation = { action: row.action, target: row.target, params: jcs(params) };
        let result: unknown;
        try {
          result = isInternalAction(row.action) ? this.apply(conn, row.action, row.target, params, proof) : execute(row.action, row.target, params, proof);
          if (result && typeof (result as { then?: unknown }).then === "function") invalid("签名执行回调必须同步");
        } finally { this.activeProof = previousProof; this.activeOperation = previousOperation; }
        this.store.run("UPDATE pending_confirmations SET state='confirmed',confirmed_by=?,result=? WHERE id=?", proof.deviceId, JSON.stringify(result) ?? "null", confirmationId);
        this.log(row.action, row.target, row.requested_by, "device", "confirmed", { proof });
        this.settleOperations(confirmationId, "confirmed", result);
        this.store.change("confirmation", confirmationId);
        return result;
      });
    } catch (error) {
      this.rejected(conn, confirmationId, row, error);
      throw error;
    }
  }
  async signAsync(conn: Connection, confirmationId: string, body: SignatureBody, execute: Execute): Promise<unknown> {
    let row: ConfirmationRow | undefined;
    let verified: ReturnType<Security["verified"]>;
    try {
      if (this.store.db.isTransaction) fail("transaction_active", "异步签名不能在数据库事务中发起", 409);
      this.actor(conn); this.checkState();
      verified = this.store.transaction(() => {
        row = this.store.get<ConfirmationRow>("SELECT * FROM pending_confirmations WHERE id=?", confirmationId);
        const checked = this.verified(row, body);
        if (!row || !isExternalAction(row.action)) fail("invalid_action", "安全自身动作必须同步签名执行", 400);
        const changed = this.store.run("UPDATE pending_confirmations SET state='executing',consumed_at=?,confirmed_by=? WHERE id=? AND state='pending' AND consumed_at IS NULL", now(), checked.proof.deviceId, confirmationId);
        if (!changed.changes) fail("already_handled", "待确认已处理", 409);
        this.log(row.action, row.target, row.requested_by, "device", "executing", { proof: checked.proof });
        this.store.change("confirmation", confirmationId);
        return checked;
      });
    } catch (error) {
      this.rejected(conn, confirmationId, row, error); throw error;
    }
    const operation = row!;
    try {
      // nonce 已提交；文件和进程操作不能占用 SQLite 事务，也不能在失败后重放。
      const result = await execute(operation.action, operation.target, verified.params, verified.proof);
      const encoded = JSON.stringify(result) ?? "null";
      this.store.transaction(() => {
        const changed = this.store.run("UPDATE pending_confirmations SET state='confirmed',result=? WHERE id=? AND state='executing'", encoded, confirmationId);
        if (!changed.changes) fail("already_handled", "操作已结束或被标记中断", 409);
        this.log(operation.action, operation.target, operation.requested_by, "device", "confirmed", { proof: verified.proof });
        this.settleOperations(confirmationId, "confirmed", result);
        this.store.change("confirmation", confirmationId);
      });
      return result;
    } catch (error) {
      const reason = auditReason(error);
      this.store.transaction(() => {
        const changed = this.store.run("UPDATE pending_confirmations SET state='failed',failure_reason=? WHERE id=? AND state='executing'", reason, confirmationId);
        if (changed.changes) {
          this.log(operation.action, operation.target, operation.requested_by, "device", "failed", { proof: verified.proof, reason });
          this.settleOperations(confirmationId, "failed", undefined, reason);
          this.store.change("confirmation", confirmationId);
        }
      });
      throw error;
    }
  }
  cancel(conn: Connection, confirmationId: string) {
    const actor = this.actor(conn);
    return this.store.transaction(() => {
      const row = this.store.get<ConfirmationRow>("SELECT * FROM pending_confirmations WHERE id=?", confirmationId);
      if (!row) fail("not_found", "待确认不存在", 404);
      if (row.requested_by !== actor && !conn.type.startsWith("host:")) fail("forbidden", "只能取消自己发起的待确认");
      if (row.state !== "pending" || row.expires_at <= now()) fail("already_handled", "待确认已处理或过期", 409);
      this.store.run("UPDATE pending_confirmations SET state='cancelled' WHERE id=?", confirmationId);
      this.log(row.action, row.target, actor, "none", "cancelled", { confirmationId });
      this.settleOperations(confirmationId, "cancelled");
      this.store.change("confirmation", confirmationId);
      return { cancelled: true };
    });
  }
  apply(conn: Connection, action: string, target: string, params: Record<string, unknown>, proof?: DeviceProof): unknown {
    const actor = this.actor(conn); this.validate(action, target, params); this.checkState();
    if (!isInternalAction(action)) fail("invalid_action", "外部动作只能通过签名回调执行", 400);
    return this.store.transaction(() => {
      const signed = !!proof && proof === this.activeProof && this.activeOperation?.action === action && this.activeOperation.target === target && this.activeOperation.params === jcs(params);
      if (proof && !signed) fail("invalid_proof", "操作证明必须来自当前签名事务");
      if (!signed && !this.canApplyWithoutSignature(action, target, params)) fail("confirmation_required", "此操作必须由已配对设备签名", 409);
      let result: unknown;
      switch (action) {
        case "agora.device.pair": {
          const existing = this.store.get<DeviceRow>("SELECT * FROM devices WHERE id=? OR public_key=?", target, String(params.publicKey));
          if (existing && (existing.id !== target || existing.public_key !== params.publicKey)) fail("device_mismatch", "设备标识或公钥已被使用");
          if (!existing) {
            const accepted = !this.setting("everPaired", false) || this.setting("reTofuArmed", false);
            this.store.run("INSERT INTO devices(id,public_key,label,state,created_at) VALUES(?,?,?,?,?)", target, String(params.publicKey), String(params.label), accepted ? "paired" : "pending", now());
            if (accepted) { this.put("everPaired", true); this.put("reTofuArmed", false); }
          }
          this.rememberDevices(); result = this.devices().find(device => device.deviceId === target); break;
        }
        case "agora.device.approve": {
          const changed = this.store.run("UPDATE devices SET state='paired' WHERE id=? AND state='pending'", target);
          if (!changed.changes) fail("conflict", "设备不是待批准状态", 409);
          this.put("everPaired", true); this.rememberDevices(); result = this.devices().find(device => device.deviceId === target); break;
        }
        case "agora.device.revoke":
          if (!this.store.run("DELETE FROM devices WHERE id=?", target).changes) fail("not_found", "设备不存在", 404);
          this.rememberDevices(); result = { revoked: true }; break;
        case "agora.device.reset":
          this.store.run("DELETE FROM devices WHERE id<>?", proof!.deviceId);
          this.rememberDevices(); result = { reset: true, retainedDeviceId: proof!.deviceId }; break;
        case "agora.settings.set": this.put(target, params.value); this.checkState(); result = { key: target, value: params.value }; break;
        case "agora.security.acknowledge": {
          const alert = this.store.get<AlertRow>("SELECT * FROM security_alerts WHERE id=?", target);
          if (!alert || alert.kind !== "devices-reset") fail("forbidden", "只有设备重置警告可以确认知悉");
          if (alert.acknowledged_at || alert.revision !== params.revision) fail("conflict", "警告已变化，请重新确认", 409);
          this.store.run("UPDATE security_alerts SET acknowledged_at=?,acknowledged_by=? WHERE id=?", now(), proof!.deviceId, target);
          this.store.change("security_alert", target); result = { acknowledged: true }; break;
        }
      }
      if (!signed) this.log(action, target, actor, "none", "applied");
      this.store.change("security", target);
      return result;
    });
  }
  private canApplyWithoutSignature(action: string, target: string, params: Record<string, unknown>): boolean {
    if (action !== "agora.settings.set") return false;
    if (target === "userConfirmation") return params.value === "device";
    if (target === "tokenAccounting") return params.value === this.setting("tokenAccounting", "all");
    const config = this.state().config;
    const fallback = target === "agentLimitCap" ? config.agentLimitCap : target === "taskLimitDefaults" ? config.taskLimitDefaults : config.meetingLimitDefaults;
    const next = params.value as Record<string, number>, current = this.setting<LimitSettings>(target, fallback);
    if (typeof current === "number" || typeof next === "number") return typeof current === "number" && typeof next === "number" && next <= current;
    // 增加维度或移除限制都不能当作调低；默认预算由预算模块决定。
    return Object.keys(current).every(key => Object.hasOwn(next, key)) && Object.entries(next).every(([key, value]) => typeof current[key] === "number" && value <= current[key]);
  }
  /** 仅由取得单实例锁后的离线入口调用，不暴露给在线动作分发。 */
  private applyOffline(words: string[]): unknown {
    return this.store.transaction(() => {
      if (words.length === 1 && words[0] === "pair-reset") {
        this.store.run("DELETE FROM devices"); this.put("reTofuArmed", true);
        const observed = this.fingerprint();
        this.alert("devices-reset", { via: "offline", observed }, "offline");
        this.put("devicesObservedFingerprint", observed);
        this.log("agora.device.reset", "devices", "offline", "none", "applied", { via: "offline" });
        return { reset: true, reTofuArmed: true };
      }
      if (words.length === 3 && words[0] === "set" && words[1] === "userConfirmation" && (words[2] === "off" || words[2] === "device")) {
        this.put("userConfirmation", words[2]); this.checkState();
        this.log("agora.settings.set", "userConfirmation", "offline", "none", "applied", { via: "offline", details: { value: words[2] } });
        this.store.change("security", "userConfirmation");
        return { key: "userConfirmation", value: words[2] };
      }
      return invalid("离线命令仅支持 pair-reset 或 set userConfirmation off|device");
    });
  }
}
