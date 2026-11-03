import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AirwallexClient, loadConfig } from "../src/airwallex.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(root, "out");
const w1Path = resolve(out, "w1-journal.sqlite");
const hppPath = resolve(out, "hpp-gate-state.sqlite");
const w3Path = resolve(out, "w3-rfi-journal.sqlite");
const BASE = "https://api.sandbox.airwallex.com";
const REASON_CODE = "4837";

type Db = {
  exec(sql: string): void;
  prepare(sql: string): { get(...args: unknown[]): Record<string, unknown> | undefined; run(...args: unknown[]): { changes: number } };
  close(): void;
};
type DbCtor = new (path: string, options?: { readOnly?: boolean; timeout?: number }) => Db;
type Identity = { id: string; request_id: string; merchant_order_id: string; amount: number; currency: string };

function fingerprint(value: string): string { return createHash("sha256").update(value).digest("hex").slice(0, 16); }
function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function identity(value: unknown): Identity | undefined {
  const v = record(value);
  if (!v || typeof v.id !== "string" || typeof v.request_id !== "string" || typeof v.merchant_order_id !== "string" ||
      typeof v.amount !== "number" || !Number.isFinite(v.amount) || typeof v.currency !== "string") return undefined;
  return { id: v.id, request_id: v.request_id, merchant_order_id: v.merchant_order_id, amount: v.amount, currency: v.currency };
}
function sameIdentity(a: unknown, b: Identity): boolean {
  const x = identity(a);
  return !!x && x.id === b.id && x.request_id === b.request_id && x.merchant_order_id === b.merchant_order_id &&
    x.amount === b.amount && x.currency === b.currency;
}

export function buildRfiRequest(intentId: string, now = new Date()): Record<string, string> {
  if (!/^int_[A-Za-z0-9_-]{1,128}$/.test(intentId)) throw new Error("W3_INTENT_ID_INVALID");
  const due = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  due.setUTCMilliseconds(0);
  return {
    payment_intent_id: intentId,
    stage: "RFI",
    reason_code: REASON_CODE,
    due_at: due.toISOString(),
    comment: "Fair Trial Starter Kit 04 — synthetic sandbox request for information.",
  };
}

async function openSqlite(): Promise<DbCtor> {
  return (await import("node:sqlite" as string) as { DatabaseSync: DbCtor }).DatabaseSync;
}

async function loadBaseline(): Promise<{ intent: Identity; providerCreatedAt: string; fingerprint: string }> {
  if (!existsSync(w1Path) || !existsSync(hppPath)) throw new Error("W1_W2_STATE_MISSING");
  const DatabaseSync = await openSqlite();
  const w1 = new DatabaseSync(w1Path, { readOnly: true, timeout: 5000 });
  const hpp = new DatabaseSync(hppPath, { readOnly: true, timeout: 5000 });
  try {
    const attempts = w1.prepare("SELECT * FROM w1_attempt").get();
    const w2 = w1.prepare("SELECT * FROM w2_launch").get();
    const attemptCount = Number(w1.prepare("SELECT count(*) AS n FROM w1_attempt").get()?.n);
    const w2Count = Number(w1.prepare("SELECT count(*) AS n FROM w2_launch").get()?.n);
    if (attemptCount !== 1 || w2Count !== 1 || !attempts || !w2 || attempts.phase !== "READBACK_VERIFIED" ||
        attempts.amount !== 1 || attempts.currency !== "USD" || attempts.provider_status !== "REQUIRES_PAYMENT_METHOD" ||
        typeof attempts.intent_id !== "string" || typeof attempts.request_id !== "string" ||
        typeof attempts.merchant_order_id !== "string" || typeof attempts.provider_created_at !== "string" ||
        w2.intent_id !== attempts.intent_id || w2.request_id !== attempts.request_id || w2.merchant_order_id !== attempts.merchant_order_id) {
      throw new Error("W1_BASELINE_MISMATCH");
    }
    const intent: Identity = { id: attempts.intent_id, request_id: attempts.request_id, merchant_order_id: attempts.merchant_order_id,
      amount: 1, currency: "USD" };
    const payloadRow = hpp.prepare("SELECT payload FROM gate_state WHERE singleton=1").get();
    if (!payloadRow || typeof payloadRow.payload !== "string") throw new Error("W2_STATE_MISSING");
    let payload: Record<string, unknown>;
    try { payload = JSON.parse(payloadRow.payload) as Record<string, unknown>; } catch { throw new Error("W2_STATE_INVALID"); }
    const checkout = record(payload.checkout);
    const hppAttempts = checkout && Array.isArray(checkout.attempts) ? checkout.attempts : [];
    if (hppAttempts.length !== 1) throw new Error("W2_ATTEMPT_COUNT_MISMATCH");
    const hppAttempt = record(hppAttempts[0]);
    if (!hppAttempt || hppAttempt.paymentIntentId !== intent.id || hppAttempt.requestId !== intent.request_id ||
        hppAttempt.merchantOrderId !== intent.merchant_order_id || hppAttempt.status !== "SUCCEEDED" ||
        hppAttempt.launchIssued !== true || typeof hppAttempt.statusVerifiedAt !== "number") throw new Error("W2_SUCCESS_NOT_VERIFIED");
    const hppLaunch = hpp.prepare("SELECT * FROM attempts").get();
    const hppLaunchCount = Number(hpp.prepare("SELECT count(*) AS n FROM attempts").get()?.n);
    if (hppLaunchCount !== 1 || !hppLaunch || hppLaunch.intent_id !== intent.id || hppLaunch.request_id !== intent.request_id ||
        hppLaunch.merchant_order_id !== intent.merchant_order_id || hppLaunch.status !== "SUCCEEDED") {
      throw new Error("W2_JOURNAL_MISMATCH");
    }
    const expectedFp = fingerprint(intent.id);
    if (expectedFp !== "5739cecdeb96b009") throw new Error("W1_FINGERPRINT_MISMATCH");
    return { intent, providerCreatedAt: attempts.provider_created_at, fingerprint: expectedFp };
  } finally { w1.close(); hpp.close(); }
}

async function createJournal(dbPath: string, request: Record<string, string>, intentFp: string): Promise<Db> {
  if (existsSync(dbPath)) throw new Error("W3_JOURNAL_ALREADY_EXISTS");
  await mkdir(dirname(dbPath), { recursive: true });
  const DatabaseSync = await openSqlite();
  const db = new DatabaseSync(dbPath, { timeout: 5000 });
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS w3_attempt (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1), intent_fingerprint TEXT NOT NULL, payment_intent_id TEXT NOT NULL,
      request_json TEXT NOT NULL, dispatched_at TEXT NOT NULL, phase TEXT NOT NULL, http_status INTEGER,
      dispute_id TEXT, dispute_fingerprint TEXT, provider_stage TEXT, provider_status TEXT, provider_amount REAL,
      provider_currency TEXT, provider_reason_code TEXT, reason TEXT
    );`);
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`INSERT INTO w3_attempt(singleton,intent_fingerprint,payment_intent_id,request_json,dispatched_at,phase)
      VALUES(1,?,?,?,?, 'DISPATCHED')`).run(intentFp, request.payment_intent_id, JSON.stringify(request), new Date().toISOString());
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); db.close(); throw error; }
  return db;
}

function journalUpdate(db: Db, phase: string, fields: Record<string, unknown> = {}): void {
  const keys = Object.keys(fields);
  const assignments = ["phase=?", ...keys.map((key) => `${key}=?`)].join(",");
  const values = [phase, ...keys.map((key) => fields[key])];
  db.prepare(`UPDATE w3_attempt SET ${assignments} WHERE singleton=1`).run(...values);
}

async function providerGet<T>(client: AirwallexClient, method: "GET", path: string, options: Parameters<AirwallexClient["request"]>[2]): Promise<T> {
  return client.request<T>(method, path, options);
}

/** A single irreversible sandbox dispatch. All diagnostics are intentionally metadata-only. */
export async function executeW3Once(argv = process.argv.slice(2)): Promise<number> {
  if (argv.length !== 1 || argv[0] !== "--execute-once") {
    console.error("Usage: npm run w3:rfi -- --execute-once");
    return 2;
  }
  if (resolve(process.cwd()) !== root) { console.error(JSON.stringify({ phase: "BLOCKED", code: "REPOSITORY_ROOT_REQUIRED" })); return 3; }
  if (existsSync(w3Path)) { console.error(JSON.stringify({ phase: "BLOCKED", code: "W3_JOURNAL_ALREADY_EXISTS" })); return 3; }

  let dispatchDb: Db | undefined;
  let createPostAttempted = false;
  try {
    const baseline = await loadBaseline();
    const cfg = loadConfig([]);
    if (cfg.dryRun || cfg.base !== BASE || cfg.loginAsTarget) throw new Error("SINGLE_ACCOUNT_SANDBOX_CONFIG_REQUIRED");
    const client = new AirwallexClient(cfg);
    const auth = await client.login(false, true);

    // Mandatory fresh, identity-bound reads occur before the permanent W3 dispatch fence.
    const payment = await providerGet<Record<string, unknown>>(client, "GET", `/api/v1/pa/payment_intents/${encodeURIComponent(baseline.intent.id)}`,
      { sensitivePaymentIntentRead: true, retry: false });
    if (!sameIdentity(payment, baseline.intent) || payment.status !== "SUCCEEDED" ||
        typeof payment.created_at !== "string" || Date.parse(payment.created_at) !== Date.parse(baseline.providerCreatedAt)) {
      throw new Error("FRESH_PAYMENT_INTENT_VERIFICATION_FAILED");
    }
    const disputes = await providerGet<Record<string, unknown>>(client, "GET", "/api/v1/pa/payment_disputes",
      { sensitiveDisputeRead: true, retry: false,
        query: { payment_intent_id: baseline.intent.id, size: 100, page: "0" } });
    if (!Array.isArray(disputes.items) || disputes.items.length !== 0) throw new Error("EXISTING_DISPUTE_OR_INVALID_LIST_RESPONSE");

    const request = buildRfiRequest(baseline.intent.id);
    dispatchDb = await createJournal(w3Path, request, baseline.fingerprint);
    // No retry or redirect. Timeout/ambiguous result permanently consumes this one-shot journal.
    createPostAttempted = true;
    let response: Response;
    try {
      response = await fetch(`${BASE}/api/v1/simulation/pa/payment_disputes/create`, {
        method: "POST", headers: { Authorization: `Bearer ${auth.token}`, "Content-Type": "application/json" },
        body: JSON.stringify(request), redirect: "error", signal: AbortSignal.timeout(30_000),
      });
    } catch {
      journalUpdate(dispatchDb, "SENT_UNKNOWN", { reason: "CREATE_TRANSPORT_OR_RESPONSE_UNKNOWN" });
      console.error(JSON.stringify({ phase: "SENT_UNKNOWN", createPostCount: 1, retryCount: 0, intentFingerprint: baseline.fingerprint }));
      return 4;
    }
    const status = response.status;
    let created: unknown;
    try { created = await response.json(); } catch { created = undefined; }
    if (status !== 201) {
      journalUpdate(dispatchDb, "FAILED", { http_status: status, reason: "CREATE_HTTP_REFUSED" });
      console.error(JSON.stringify({ phase: "FAILED", createPostCount: 1, retryCount: 0, httpStatus: status, intentFingerprint: baseline.fingerprint }));
      return 4;
    }
    const createdObj = record(created);
    if (!createdObj || typeof createdObj.id !== "string" || !/^dst_[A-Za-z0-9_-]{1,128}$/.test(createdObj.id)) {
      journalUpdate(dispatchDb, "SENT_UNKNOWN", { http_status: status, reason: "CREATE_RESPONSE_ID_INVALID" });
      console.error(JSON.stringify({ phase: "SENT_UNKNOWN", createPostCount: 1, retryCount: 0, httpStatus: status, intentFingerprint: baseline.fingerprint }));
      return 4;
    }
    const disputeId = createdObj.id;
    journalUpdate(dispatchDb, "CREATE_VERIFIED", { http_status: status, dispute_id: disputeId, dispute_fingerprint: fingerprint(disputeId) });

    let verified: Record<string, unknown>;
    try {
      verified = await providerGet<Record<string, unknown>>(client, "GET", `/api/v1/pa/payment_disputes/${encodeURIComponent(disputeId)}`,
        { sensitiveDisputeRead: true, retry: false });
    } catch {
      journalUpdate(dispatchDb, "READBACK_UNKNOWN", { reason: "DISPUTE_READBACK_TRANSPORT_UNKNOWN" });
      console.error(JSON.stringify({ phase: "READBACK_UNKNOWN", createPostCount: 1, retryCount: 0,
        createHttpStatus: status, intentFingerprint: baseline.fingerprint, disputeFingerprint: fingerprint(disputeId) }));
      return 5;
    }
    const reason = record(verified.reason);
    const amountMatches = verified.amount === baseline.intent.amount;
    const exact = verified.id === disputeId && verified.payment_intent_id === baseline.intent.id && verified.stage === "RFI" &&
      verified.currency === "USD" && amountMatches && reason?.original_code === REASON_CODE && verified.status === "REQUIRES_RESPONSE";
    journalUpdate(dispatchDb, exact ? "READBACK_VERIFIED" : "READBACK_MISMATCH", {
      dispute_fingerprint: fingerprint(disputeId), provider_stage: typeof verified.stage === "string" ? verified.stage : null,
      provider_status: typeof verified.status === "string" ? verified.status : null,
      provider_amount: typeof verified.amount === "number" ? verified.amount : null,
      provider_currency: typeof verified.currency === "string" ? verified.currency : null,
      provider_reason_code: typeof reason?.original_code === "string" ? reason.original_code : null,
      reason: exact ? null : "PROVIDER_READBACK_DID_NOT_MATCH_EXPECTED_RFI",
    });
    console.log(JSON.stringify({ phase: exact ? "READBACK_VERIFIED" : "READBACK_MISMATCH", createPostCount: 1,
      retryCount: 0, createHttpStatus: status, retrieveHttpStatus: 200, intentFingerprint: baseline.fingerprint,
      disputeFingerprint: fingerprint(disputeId), stage: verified.stage ?? null, status: verified.status ?? null,
      amount: verified.amount ?? null, currency: verified.currency ?? null, reasonCode: reason?.original_code ?? null }));
    return exact ? 0 : 5;
  } catch (error) {
    const e = record(error);
    const rawCode = typeof e?.code === "string" && /^[a-z0-9_]+$/.test(e.code) ? e.code.toUpperCase() : undefined;
    const diagnostic = record(e?.diagnostic);
    const directCode = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : undefined;
    console.error(JSON.stringify({ phase: "BLOCKED", code: directCode ?? rawCode ?? "W3_STOPPED_FAIL_CLOSED",
      providerStage: typeof diagnostic?.stage === "string" ? diagnostic.stage : undefined,
      providerHttpStatus: typeof e?.status === "number" ? e.status : undefined,
      providerErrorCategory: typeof diagnostic?.errorCategory === "string" ? diagnostic.errorCategory : undefined,
      createPostCount: createPostAttempted ? 1 : 0, retryCount: 0 }));
    return 3;
  } finally { dispatchDb?.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await executeW3Once();
