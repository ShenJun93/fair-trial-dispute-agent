import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AirwallexClient } from "../src/airwallex.ts";

const verifiedBindingToken = Symbol("local-account-binding-verification");
export interface LocalAccountBindingVerification {
  readonly result: "MATCH" | "MISMATCH" | "UNKNOWN";
  readonly origin: typeof W1_ORIGIN;
  readonly clientIdFingerprint?: string;
  readonly targetAccountFingerprint?: string;
  readonly keyAccountScope: "SINGLE_ACCOUNT" | "MULTIPLE_ACCOUNTS" | "UNKNOWN";
  readonly documentedLoginAs: "NOT_REQUIRED_BY_DOCUMENTATION" | "REQUIRED_BY_DOCUMENTATION" | "UNKNOWN";
  readonly operatorException: "NONE" | "REPORTED_REQUIRED" | "REPORTED_NOT_REQUIRED" | "UNKNOWN";
  readonly conflict: "OPERATOR_REPORT_CONFLICTS_WITH_DOCUMENTATION" | "TARGET_ACCOUNT_UNVERIFIED" | "TARGET_ACCOUNT_MISMATCH" | "TARGET_CONFIGURED_FOR_SINGLE_ACCOUNT" | null;
  readonly provenance: "LOCAL_INTERACTIVE_COMPARISON";
  readonly challenge?: string;
  readonly [verifiedBindingToken]: true;
}

/** Compares values locally; the output deliberately excludes both Client IDs and raw dashboard/account identifiers. */
export function verifyLocalAccountBinding(input: {
  configuredClientId: string;
  dashboardClientId: string;
  keyAppliesToSelectedUsAccount: boolean | "UNKNOWN";
  keyAccountScope: LocalAccountBindingVerification["keyAccountScope"];
  operatorReportedLoginAs: "REQUIRED" | "NOT_REQUIRED" | "NONE" | "UNKNOWN";
  configuredTargetAccountId?: string;
  dashboardTargetAccountId?: string;
}): LocalAccountBindingVerification {
  const valid = input.configuredClientId.length > 0 && input.dashboardClientId.length > 0;
  const same = valid && input.configuredClientId === input.dashboardClientId;
  const result = !valid || input.keyAppliesToSelectedUsAccount === "UNKNOWN" || input.keyAccountScope === "UNKNOWN"
    ? "UNKNOWN"
    : !same || input.keyAppliesToSelectedUsAccount === false ? "MISMATCH" : "MATCH";
  const documentedLoginAs = input.keyAccountScope === "SINGLE_ACCOUNT" ? "NOT_REQUIRED_BY_DOCUMENTATION"
    : input.keyAccountScope === "MULTIPLE_ACCOUNTS" ? "REQUIRED_BY_DOCUMENTATION" : "UNKNOWN";
  const expectedOperator = documentedLoginAs === "NOT_REQUIRED_BY_DOCUMENTATION" ? "NOT_REQUIRED"
    : documentedLoginAs === "REQUIRED_BY_DOCUMENTATION" ? "REQUIRED" : undefined;
  const operatorException = input.operatorReportedLoginAs === "UNKNOWN" ? "UNKNOWN"
    : input.operatorReportedLoginAs === "NONE" || input.operatorReportedLoginAs === expectedOperator ? "NONE"
      : input.operatorReportedLoginAs === "REQUIRED" ? "REPORTED_REQUIRED" : "REPORTED_NOT_REQUIRED";
  const targetMatches = !!input.configuredTargetAccountId && !!input.dashboardTargetAccountId &&
    input.configuredTargetAccountId === input.dashboardTargetAccountId;
  const targetMismatch = !!input.configuredTargetAccountId && !!input.dashboardTargetAccountId && !targetMatches;
  const scopeMismatch = input.keyAccountScope === "MULTIPLE_ACCOUNTS" && targetMismatch;
  const singleTargetConflict = input.keyAccountScope === "SINGLE_ACCOUNT" && !!input.configuredTargetAccountId;
  const finalResult = result === "MATCH" && scopeMismatch ? "MISMATCH" : result;
  const conflict = operatorException === "REPORTED_REQUIRED" || operatorException === "REPORTED_NOT_REQUIRED"
    ? "OPERATOR_REPORT_CONFLICTS_WITH_DOCUMENTATION"
    : scopeMismatch ? "TARGET_ACCOUNT_MISMATCH"
      : input.keyAccountScope === "MULTIPLE_ACCOUNTS" && !targetMatches ? "TARGET_ACCOUNT_UNVERIFIED"
        : singleTargetConflict ? "TARGET_CONFIGURED_FOR_SINGLE_ACCOUNT" : null;
  return Object.freeze({ result: finalResult, origin: W1_ORIGIN,
    ...(finalResult === "MATCH" ? { clientIdFingerprint: fingerprint(input.configuredClientId) } : {}),
    ...(targetMatches ? { targetAccountFingerprint: fingerprint(input.configuredTargetAccountId!) } : {}),
    keyAccountScope: input.keyAccountScope, documentedLoginAs, operatorException, conflict,
    provenance: "LOCAL_INTERACTIVE_COMPARISON", [verifiedBindingToken]: true as const });
}

/** Reissues an in-memory gate from a fresh local utility response, bound to this process challenge and current credentials. */
export function acceptFreshBindingReceipt(input: {
  receipt: Record<string, unknown>;
  challenge: string;
  currentClientId: string;
  currentTargetAccountId?: string;
}): LocalAccountBindingVerification {
  const r = input.receipt;
  const scope = r.keyAccountScope;
  const documented = scope === "SINGLE_ACCOUNT" ? "NOT_REQUIRED_BY_DOCUMENTATION"
    : scope === "MULTIPLE_ACCOUNTS" ? "REQUIRED_BY_DOCUMENTATION" : "UNKNOWN";
  if (r.result !== "MATCH" || r.provenance !== "LOCAL_INTERACTIVE_COMPARISON" || r.origin !== W1_ORIGIN ||
      r.challenge !== input.challenge || r.documentedXLoginAs !== documented || !input.currentClientId ||
      r.clientIdFingerprint !== fingerprint(input.currentClientId) || !Array.isArray(r.conflicts) || r.conflicts.length !== 0 ||
      r.operatorException !== "NONE" || r.selectedUsSandboxAccountConfirmed !== true || r.keyAppliesToSelectedUsAccount !== true ||
      r.liveW1Enabled !== false || r.networkRequests !== 0 || r.rawIdentifiersEmitted !== false) throw new Error("ACCOUNT_UNVERIFIED");
  const targetFingerprint = typeof input.currentTargetAccountId === "string" && input.currentTargetAccountId
    ? fingerprint(input.currentTargetAccountId) : undefined;
  if (scope === "SINGLE_ACCOUNT") {
    if (input.currentTargetAccountId || r.targetAccountBinding !== "NOT_APPLICABLE") throw new Error("ACCOUNT_SCOPE_CONFLICT");
  } else if (scope === "MULTIPLE_ACCOUNTS") {
    if (!targetFingerprint || r.targetAccountBinding !== "MATCH" || r.targetAccountFingerprint !== targetFingerprint) throw new Error("ACCOUNT_TARGET_UNVERIFIED");
  } else throw new Error("ACCOUNT_SCOPE_UNKNOWN");
  return Object.freeze({ result: "MATCH", origin: W1_ORIGIN,
    clientIdFingerprint: fingerprint(input.currentClientId), ...(targetFingerprint ? { targetAccountFingerprint: targetFingerprint } : {}),
    keyAccountScope: scope, documentedLoginAs: documented, operatorException: "NONE", conflict: null,
    provenance: "LOCAL_INTERACTIVE_COMPARISON", challenge: input.challenge, [verifiedBindingToken]: true as const });
}

export const W1_AMOUNT = 1;
export const W1_CURRENCY = "USD";
export const W1_ORIGIN = "https://api.sandbox.airwallex.com";
export const CLIENT_SECRET_TTL_MS = 60 * 60 * 1000;
export const CLIENT_SECRET_SAFETY_MARGIN_MS = 5 * 60 * 1000;

export type W1Mode = "FAKE" | "LIVE";
export type W1Phase = "DISPATCHED" | "SENT_UNKNOWN" | "CREATE_VERIFIED" | "READBACK_VERIFIED" | "FAILED";
export interface W1Identity {
  id: string;
  request_id: string;
  merchant_order_id: string;
  amount: number;
  currency: string;
}
export interface W1Intent extends W1Identity {
  status: string;
  client_secret?: string;
  created_at?: string;
}
export interface W1Response { httpStatus: number; body: unknown }
export interface W1CreateRequest {
  request_id: string;
  merchant_order_id: string;
  amount: number;
  currency: string;
  descriptor: "FAIR TRIAL TEST";
}
export interface W1Provider {
  /** Live adapters must self-identify to prevent a real transport being labeled FAKE by default. */
  readonly providerKind?: "FAKE" | "AIRWALLEX_SANDBOX";
  readonly clientIdFingerprint?: string;
  readonly loginAsTargetFingerprint?: string;
  create(input: W1CreateRequest, options: { retry: false }): Promise<W1Response>;
  retrieve(id: string, options: { retry: false }): Promise<W1Response>;
}

/** Narrow live adapter: only the one create route and PaymentIntent GET are exposed; every call sets retry:false. */
export function createAirwallexW1Provider(client: Pick<AirwallexClient, "cfg" | "trace" | "request">): W1Provider {
  if (client.cfg.base !== W1_ORIGIN || client.cfg.dryRun) throw new Error("W1_LIVE_PROVIDER_REQUIRES_REAL_SANDBOX_CONFIG");
  async function request(method: "GET" | "POST", path: string, options: Record<string, unknown>): Promise<W1Response> {
    let status: number | undefined;
    const instrumented = { ...options, onDiagnostic(metadata: { httpStatus?: number }) { status = metadata.httpStatus; } };
    try {
      const body = await client.request(method, path, instrumented as Parameters<AirwallexClient["request"]>[2]);
      if (typeof status !== "number") throw new Error("W1_PROVIDER_HTTP_STATUS_UNAVAILABLE");
      return { httpStatus: status, body };
    } catch {
      if (typeof status === "number") return { httpStatus: status, body: undefined };
      throw new Error("W1_PROVIDER_TRANSPORT_UNKNOWN");
    }
  }
  return {
    providerKind: "AIRWALLEX_SANDBOX" as const,
    clientIdFingerprint: fingerprint(client.cfg.clientId),
    loginAsTargetFingerprint: client.cfg.loginAsTarget ? fingerprint(client.cfg.loginAsTarget) : undefined,
    create(input, options) {
      if (options.retry !== false) throw new Error("W1_RETRY_MUST_BE_DISABLED");
      return request("POST", "/api/v1/pa/payment_intents/create", { body: input, retry: false, sensitivePaymentIntentCreate: true });
    },
    retrieve(id, options) {
      if (options.retry !== false || !/^int_[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error("W1_RETRIEVE_INVALID");
      return request("GET", `/api/v1/pa/payment_intents/${encodeURIComponent(id)}`,
        { retry: false, sensitivePaymentIntentRead: true });
    },
  };
}
export interface W1Receipt {
  mode: W1Mode;
  phase: W1Phase;
  postCount: number;
  retryCount: 0;
  retrieveCount: number;
  httpStatus?: number;
  retrieveHttpStatus?: number;
  intentFingerprint?: string;
  status?: string;
  reason?: string;
}

interface SqlStatement {
  get(...args: unknown[]): Record<string, unknown> | undefined;
  run(...args: unknown[]): { changes: number; lastInsertRowid: number | bigint };
}
interface SqlDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  close(): void;
}
type DatabaseCtor = new (path: string, options?: { timeout?: number; readOnly?: boolean }) => SqlDatabase;

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function strictIdentity(value: unknown): W1Identity | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== "string" || !/^int_[A-Za-z0-9_-]{1,128}$/.test(v.id) ||
      typeof v.request_id !== "string" || typeof v.merchant_order_id !== "string" ||
      typeof v.amount !== "number" || !Number.isFinite(v.amount) ||
      typeof v.currency !== "string") return undefined;
  return { id: v.id, request_id: v.request_id, merchant_order_id: v.merchant_order_id,
    amount: v.amount, currency: v.currency };
}

export function identityMatches(actual: unknown, expected: W1Identity): actual is W1Intent {
  const parsed = strictIdentity(actual);
  return !!parsed && parsed.id === expected.id && parsed.request_id === expected.request_id &&
    parsed.merchant_order_id === expected.merchant_order_id && parsed.amount === expected.amount &&
    parsed.currency === expected.currency;
}

/** Private, metadata-only SQLite journal. The one-row key is the permanent dispatch fence. */
export class W1Journal {
  private constructor(private readonly db: SqlDatabase) {}

  static async open(path: string): Promise<W1Journal> {
    await mkdir(dirname(path), { recursive: true });
    const { DatabaseSync } = await import("node:sqlite" as string) as { DatabaseSync: DatabaseCtor };
    const db = new DatabaseSync(path, { timeout: 5000 });
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS w1_attempt (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1),
        request_id TEXT NOT NULL,
        merchant_order_id TEXT NOT NULL,
        amount REAL NOT NULL CHECK(amount=1),
        currency TEXT NOT NULL CHECK(currency='USD'),
        dispatched_at TEXT NOT NULL,
        provider_created_at TEXT,
        phase TEXT NOT NULL,
        intent_id TEXT,
        provider_status TEXT,
        http_status INTEGER,
        retrieve_http_status INTEGER,
        reason TEXT
      );
      CREATE TABLE IF NOT EXISTS w2_launch (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1),
        intent_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        merchant_order_id TEXT NOT NULL,
        consumed_at TEXT NOT NULL
      );`);
    return new W1Journal(db);
  }

  /** INSERT under BEGIN IMMEDIATE is atomic across processes and remains as a permanent no-replay fence. */
  dispatch(input: { requestId: string; merchantOrderId: string; createdAt: string }): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.db.prepare("SELECT singleton FROM w1_attempt WHERE singleton=1").get()) {
        throw new Error("W1_ALREADY_DISPATCHED");
      }
      this.db.prepare(`INSERT INTO w1_attempt(singleton,request_id,merchant_order_id,amount,currency,dispatched_at,phase)
        VALUES(1,?,?,?,?,?,'DISPATCHED')`).run(input.requestId, input.merchantOrderId,
          W1_AMOUNT, W1_CURRENCY, input.createdAt);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  transition(expected: W1Phase, next: W1Phase, fields: {
    intentId?: string; providerStatus?: string; providerCreatedAt?: string; httpStatus?: number;
    retrieveHttpStatus?: number; reason?: string;
  } = {}): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT phase FROM w1_attempt WHERE singleton=1").get();
      if (!row || row.phase !== expected) throw new Error("W1_JOURNAL_STATE_CONFLICT");
      const changed = this.db.prepare(`UPDATE w1_attempt SET phase=?,intent_id=COALESCE(?,intent_id),
        provider_status=COALESCE(?,provider_status),provider_created_at=COALESCE(?,provider_created_at),http_status=COALESCE(?,http_status),
        retrieve_http_status=COALESCE(?,retrieve_http_status),reason=COALESCE(?,reason)
        WHERE singleton=1 AND phase=?`).run(next, fields.intentId ?? null, fields.providerStatus ?? null, fields.providerCreatedAt ?? null,
          fields.httpStatus ?? null, fields.retrieveHttpStatus ?? null, fields.reason ?? null, expected);
      if (changed.changes !== 1) throw new Error("W1_JOURNAL_STATE_CONFLICT");
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  read(): Record<string, unknown> | undefined {
    return this.db.prepare(`SELECT request_id,merchant_order_id,amount,currency,dispatched_at,provider_created_at,phase,
      intent_id,provider_status,http_status,retrieve_http_status,reason FROM w1_attempt WHERE singleton=1`).get();
  }

  /** Internal continuation data for W2; caller must not publish this object. */
  readHandoffAttempt(): HandoffAttempt | undefined {
    const row = this.read();
    if (!row || row.phase !== "READBACK_VERIFIED" || typeof row.intent_id !== "string" ||
        typeof row.request_id !== "string" || typeof row.merchant_order_id !== "string" ||
        typeof row.provider_created_at !== "string") return undefined;
    return { id: row.intent_id, request_id: row.request_id, merchant_order_id: row.merchant_order_id,
      amount: W1_AMOUNT, currency: W1_CURRENCY, createdAt: row.provider_created_at, phase: "READBACK_VERIFIED" };
  }

  /** Durable one-use W2 permission. The exact verified W1 attempt is atomically consumed before provider GET. */
  claimW2Launch(attempt: HandoffAttempt, consumedAt = new Date().toISOString()): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare(`SELECT intent_id,request_id,merchant_order_id,amount,currency,provider_created_at,phase
        FROM w1_attempt WHERE singleton=1`).get();
      if (!row || row.phase !== "READBACK_VERIFIED" || row.intent_id !== attempt.id ||
          row.request_id !== attempt.request_id || row.merchant_order_id !== attempt.merchant_order_id ||
          row.amount !== attempt.amount || row.currency !== attempt.currency || row.provider_created_at !== attempt.createdAt ||
          this.db.prepare("SELECT singleton FROM w2_launch WHERE singleton=1").get()) {
        this.db.exec("ROLLBACK"); return false;
      }
      this.db.prepare(`INSERT INTO w2_launch(singleton,intent_id,request_id,merchant_order_id,consumed_at)
        VALUES(1,?,?,?,?)`).run(attempt.id, attempt.request_id, attempt.merchant_order_id, consumedAt);
      this.db.exec("COMMIT"); return true;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  close(): void { this.db.close(); }
}

export interface RunW1Options {
  /** Defaults to FAKE. LIVE requires explicit account-binding proof and the exact official sandbox origin. */
  mode?: W1Mode;
  provider?: W1Provider;
  journal: W1Journal;
  accountBinding?: LocalAccountBindingVerification;
  now?: () => Date;
}

/** One dispatch only. This function does no implicit fallback, retry, compensation, or replacement. */
export async function runW1Once(options: RunW1Options): Promise<W1Receipt> {
  const mode = options.mode ?? "FAKE";
  if (!options.provider) throw new Error("W1_PROVIDER_REQUIRED");
  if (mode === "LIVE" && (!options.accountBinding || options.accountBinding[verifiedBindingToken] !== true || options.accountBinding.provenance !== "LOCAL_INTERACTIVE_COMPARISON" || options.accountBinding.result !== "MATCH" ||
      options.accountBinding.conflict !== null || options.accountBinding.operatorException !== "NONE" ||
      (options.accountBinding.keyAccountScope === "SINGLE_ACCOUNT" &&
        (options.accountBinding.documentedLoginAs !== "NOT_REQUIRED_BY_DOCUMENTATION" || !!options.provider.loginAsTargetFingerprint)) ||
      (options.accountBinding.keyAccountScope === "MULTIPLE_ACCOUNTS" &&
        (options.accountBinding.documentedLoginAs !== "REQUIRED_BY_DOCUMENTATION" ||
          !options.accountBinding.targetAccountFingerprint || options.accountBinding.targetAccountFingerprint !== options.provider.loginAsTargetFingerprint)) ||
      !["SINGLE_ACCOUNT", "MULTIPLE_ACCOUNTS"].includes(options.accountBinding.keyAccountScope) ||
      options.accountBinding.origin !== W1_ORIGIN || typeof options.accountBinding.clientIdFingerprint !== "string" ||
      !/^[a-f0-9]{12,64}$/i.test(options.accountBinding.clientIdFingerprint) ||
      options.accountBinding.clientIdFingerprint !== options.provider.clientIdFingerprint)) {
    throw new Error("ACCOUNT_UNVERIFIED");
  }
  const providerKind = options.provider.providerKind ?? "FAKE";
  if ((mode === "FAKE" && providerKind !== "FAKE") || (mode === "LIVE" && providerKind !== "AIRWALLEX_SANDBOX")) {
    throw new Error("W1_PROVIDER_MODE_MISMATCH");
  }

  const requestId = randomUUID();
  const merchantOrderId = `ft-w1-${randomUUID()}`;
  const createdAt = (options.now ?? (() => new Date()))().toISOString();
  const request: W1CreateRequest = { request_id: requestId, merchant_order_id: merchantOrderId,
    amount: W1_AMOUNT, currency: W1_CURRENCY, descriptor: "FAIR TRIAL TEST" };

  // Commit before any provider call. A crash at any point leaves the permanent fence in place.
  options.journal.dispatch({ requestId, merchantOrderId, createdAt });
  let created: W1Response;
  try {
    created = await options.provider.create(request, { retry: false });
  } catch {
    options.journal.transition("DISPATCHED", "SENT_UNKNOWN", { reason: "CREATE_TRANSPORT_UNKNOWN" });
    return { mode, phase: "SENT_UNKNOWN", postCount: 1, retryCount: 0, retrieveCount: 0, reason: "CREATE_TRANSPORT_UNKNOWN" };
  }

  if (created.httpStatus !== 201) {
    options.journal.transition("DISPATCHED", "FAILED", { httpStatus: created.httpStatus, reason: "CREATE_HTTP_REFUSED" });
    return { mode, phase: "FAILED", postCount: 1, retryCount: 0, retrieveCount: 0,
      httpStatus: created.httpStatus, reason: "CREATE_HTTP_REFUSED" };
  }

  const createdIdentity = strictIdentity(created.body);
  const clientSecret = created.body && typeof created.body === "object" && !Array.isArray(created.body)
    ? (created.body as Record<string, unknown>).client_secret : undefined;
  const createMatches = !!createdIdentity && createdIdentity.request_id === requestId &&
    createdIdentity.merchant_order_id === merchantOrderId && createdIdentity.amount === W1_AMOUNT &&
    createdIdentity.currency === W1_CURRENCY && typeof clientSecret === "string" && clientSecret.length > 0 &&
    typeof (created.body as Record<string, unknown> | null)?.created_at === "string" &&
    Number.isFinite(Date.parse(String((created.body as Record<string, unknown>).created_at)));
  if (!createMatches || !createdIdentity) {
    options.journal.transition("DISPATCHED", "SENT_UNKNOWN", { httpStatus: created.httpStatus, reason: "CREATE_IDENTITY_UNKNOWN" });
    return { mode, phase: "SENT_UNKNOWN", postCount: 1, retryCount: 0, retrieveCount: 0,
      httpStatus: created.httpStatus, reason: "CREATE_IDENTITY_UNKNOWN" };
  }

  options.journal.transition("DISPATCHED", "CREATE_VERIFIED", {
    intentId: createdIdentity.id, httpStatus: created.httpStatus,
    providerCreatedAt: String((created.body as Record<string, unknown>).created_at),
  });
  let readback: W1Response;
  try {
    readback = await options.provider.retrieve(createdIdentity.id, { retry: false });
  } catch {
    options.journal.transition("CREATE_VERIFIED", "FAILED", { reason: "READBACK_TRANSPORT_UNKNOWN" });
    return { mode, phase: "FAILED", postCount: 1, retryCount: 0, retrieveCount: 1,
      httpStatus: created.httpStatus, intentFingerprint: fingerprint(createdIdentity.id), reason: "READBACK_TRANSPORT_UNKNOWN" };
  }
  if (readback.httpStatus !== 200 || !identityMatches(readback.body, createdIdentity)) {
    options.journal.transition("CREATE_VERIFIED", "FAILED", {
      retrieveHttpStatus: readback.httpStatus, reason: readback.httpStatus === 200 ? "READBACK_IDENTITY_MISMATCH" : "READBACK_HTTP_FAILED",
    });
    return { mode, phase: "FAILED", postCount: 1, retryCount: 0, retrieveCount: 1,
      httpStatus: created.httpStatus, retrieveHttpStatus: readback.httpStatus,
      intentFingerprint: fingerprint(createdIdentity.id), reason: readback.httpStatus === 200 ? "READBACK_IDENTITY_MISMATCH" : "READBACK_HTTP_FAILED" };
  }
  const status = (readback.body as W1Intent).status;
  if (status !== "REQUIRES_PAYMENT_METHOD") {
    options.journal.transition("CREATE_VERIFIED", "FAILED", { retrieveHttpStatus: readback.httpStatus, providerStatus: typeof status === "string" ? status.slice(0, 64) : undefined, reason: "UNEXPECTED_POST_CREATE_STATUS" });
    return { mode, phase: "FAILED", postCount: 1, retryCount: 0, retrieveCount: 1,
      httpStatus: created.httpStatus, retrieveHttpStatus: readback.httpStatus,
      intentFingerprint: fingerprint(createdIdentity.id), ...(typeof status === "string" ? { status: status.slice(0, 64) } : {}), reason: "UNEXPECTED_POST_CREATE_STATUS" };
  }
  options.journal.transition("CREATE_VERIFIED", "READBACK_VERIFIED", {
    retrieveHttpStatus: readback.httpStatus, providerStatus: status,
  });
  return { mode, phase: "READBACK_VERIFIED", postCount: 1, retryCount: 0, retrieveCount: 1,
    httpStatus: created.httpStatus, retrieveHttpStatus: readback.httpStatus,
    intentFingerprint: fingerprint(createdIdentity.id), status };
}

export interface HandoffAttempt extends W1Identity { createdAt: string; phase: W1Phase }
export interface HandoffRequest { origin?: string; sessionBound: boolean; csrfValid: boolean }
export interface HandoffResponse { status: number; headers: { "cache-control": "no-store" }; body: { error?: string; intent_id?: string; client_secret?: string } }

/** Offline prototype for an authenticated W2 endpoint. Secret stays in memory and is returned only on success. */
export async function resolveW2Handoff(input: {
  request: HandoffRequest;
  expectedOrigin: string;
  attempt: HandoffAttempt;
  retrieve(id: string): Promise<W1Response>;
  now?: () => Date;
}): Promise<HandoffResponse> {
  const headers = { "cache-control": "no-store" as const };
  if (!input.request.sessionBound) return { status: 401, headers, body: { error: "unauthorized" } };
  if (input.request.origin !== input.expectedOrigin || !input.request.csrfValid) return { status: 403, headers, body: { error: "invalid_origin_or_csrf" } };
  if (input.attempt.phase !== "READBACK_VERIFIED") return { status: 409, headers, body: { error: "attempt_not_verified" } };
  const created = Date.parse(input.attempt.createdAt);
  const now = (input.now ?? (() => new Date()))().getTime();
  if (!Number.isFinite(created) || now < created || now - created >= CLIENT_SECRET_TTL_MS - CLIENT_SECRET_SAFETY_MARGIN_MS) {
    return { status: 410, headers, body: { error: "intent_expired" } };
  }
  let response: W1Response;
  try { response = await input.retrieve(input.attempt.id); }
  catch { return { status: 503, headers, body: { error: "provider_read_failed" } }; }
  if (response.httpStatus !== 200 || !identityMatches(response.body, input.attempt)) {
    return { status: 409, headers, body: { error: "identity_mismatch" } };
  }
  const providerCreatedAt = Date.parse(String((response.body as W1Intent).created_at ?? ""));
  if (!Number.isFinite(providerCreatedAt) || providerCreatedAt !== created) {
    return { status: 409, headers, body: { error: "creation_time_mismatch" } };
  }
  if ((response.body as W1Intent).status !== "REQUIRES_PAYMENT_METHOD") {
    return { status: 409, headers, body: { error: "intent_not_checkout_ready" } };
  }
  const secret = (response.body as W1Intent).client_secret;
  if (typeof secret !== "string" || secret.length < 16 || secret.length > 8192) {
    return { status: 410, headers, body: { error: "client_secret_unavailable" } };
  }
  return { status: 200, headers, body: { intent_id: input.attempt.id, client_secret: secret } };
}

export interface W2HandoffHttpDeps {
  expectedOrigin: string;
  attempt: HandoffAttempt;
  /** Must authenticate the exact checkout session that owns/binds this approved attempt. */
  sessionBound(req: IncomingMessage, attempt: HandoffAttempt): boolean | Promise<boolean>;
  csrfValid(req: IncomingMessage): boolean | Promise<boolean>;
  /** Must atomically persist a one-use claim (for example W1Journal.claimW2Launch). */
  claimLaunch(attempt: HandoffAttempt): boolean | Promise<boolean>;
  retrieve(id: string): Promise<W1Response>;
  now?: () => Date;
}

/** Isolated endpoint prototype. Auth/session and CSRF validation are supplied by the host application. */
export function createW2HandoffHandler(deps: W2HandoffHttpDeps) {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("cache-control", "no-store");
    res.setHeader("pragma", "no-cache");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("content-type", "application/json; charset=utf-8");
    if (req.method !== "POST" || req.url !== "/api/w2/handoff") {
      res.writeHead(404).end(JSON.stringify({ error: "not_found" })); return;
    }
    if (!await deps.sessionBound(req, deps.attempt)) {
      res.writeHead(401).end(JSON.stringify({ error: "unauthorized" })); return;
    }
    if (req.headers.origin !== deps.expectedOrigin || !await deps.csrfValid(req)) {
      res.writeHead(403).end(JSON.stringify({ error: "invalid_origin_or_csrf" })); return;
    }
    // Reserve durably before provider GET; even failed/ambiguous attempts cannot replay the launch permission.
    if (!await deps.claimLaunch(deps.attempt)) {
      res.writeHead(409).end(JSON.stringify({ error: "launch_permission_consumed" })); return;
    }
    const result = await resolveW2Handoff({ request: { origin: req.headers.origin, sessionBound: true, csrfValid: true },
      expectedOrigin: deps.expectedOrigin, attempt: deps.attempt, retrieve: deps.retrieve, now: deps.now });
    res.writeHead(result.status).end(JSON.stringify(result.body));
  });
}
