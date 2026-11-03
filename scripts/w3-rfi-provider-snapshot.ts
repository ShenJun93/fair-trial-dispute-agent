import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AirwallexClient, AirwallexError, loadConfig, type Config } from "../src/airwallex.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const w3Path = resolve(root, "out/w3-rfi-journal.sqlite");
const outputPath = resolve(root, "submission/evidence/airwallex-rfi-024-provider-snapshot.json");
const baseUrl = "https://api.sandbox.airwallex.com";
type Db = { prepare(sql: string): { get(...args: unknown[]): Record<string, unknown> | undefined; all(...args: unknown[]): Record<string, unknown>[] }; close(): void };
type DbCtor = new (path: string, options?: { readOnly?: boolean; timeout?: number }) => Db;
type Rec = Record<string, unknown>;
const asRecord = (value: unknown): Rec | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Rec : undefined;
const fingerprint = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16);
const safeText = (value: unknown, max = 256): value is string => typeof value === "string" && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
const safeLocalFailureCodes = new Set(["SNAPSHOT_ALREADY_EXISTS", "W3_VERIFIED_JOURNAL_MISSING", "W3_JOURNAL_CARDINALITY_INVALID",
  "SANITIZED_SOURCE_RECEIPT_MISMATCH", "W3_JOURNAL_NOT_EXPECTED_VERIFIED_DISPUTE", "SANDBOX_ACCOUNT_CONFIGURATION_INVALID",
  "FRESH_PROVIDER_DISPUTE_IDENTITY_MISMATCH", "FRESH_PROVIDER_STAGE_OR_STATUS_INVALID", "AUTH_TOKEN_NOT_VALID_FOR_SINGLE_READ"]);
export interface SnapshotAttemptCounts { authenticationAttempts: number; disputeGetAttempts: number; }
export function safeSnapshotFailureDiagnostic(error: unknown, counts: SnapshotAttemptCounts) {
  const diagnostic = error instanceof AirwallexError ? error.diagnostic : undefined;
  return Object.freeze({
    stage: diagnostic?.stage ?? "LOCAL_PREFLIGHT",
    responseReceived: diagnostic?.responseReceived ?? false,
    httpStatus: diagnostic?.httpStatus ?? (error instanceof AirwallexError ? error.status ?? null : null),
    errorCategory: diagnostic?.errorCategory ?? "LOCAL_PREFLIGHT_ERROR",
    retryCount: diagnostic?.retryCount ?? 0,
    authenticationAttemptCount: counts.authenticationAttempts,
    disputeGetAttemptCount: counts.disputeGetAttempts,
    mutationCount: 0,
  });
}
export function safeSnapshotConfiguration(config: Config) {
  return Object.freeze({ environment: "AIRWALLEX_SANDBOX", originValidated: config.base === baseUrl,
    loginAsHeaderConfigured: Boolean(config.loginAsTarget),
    sourcePolicy: "process environment > .env.local > .env; AIRWALLEX_BASE defaults to exact sandbox origin",
    credentialsOrConfigurationValuesIncluded: false });
}

function deadline(raw: unknown): { value: string | null; classification: string; timezoneExplicit: boolean; parses: boolean } {
  if (!safeText(raw)) return { value: null, classification: "DEADLINE_NOT_RETURNED", timezoneExplicit: false, parses: false };
  const timezoneExplicit = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw);
  const normalized = /[+-]\d{4}$/.test(raw) ? `${raw.slice(0, -2)}:${raw.slice(-2)}` : raw;
  const parsed = timezoneExplicit && Number.isFinite(Date.parse(normalized));
  return { value: raw, classification: parsed ? "PROVIDER_DUE_AT_EXPLICIT_TIMEZONE" : "PROVIDER_DUE_AT_INVALID_OR_TIMEZONE_MISSING", timezoneExplicit, parses: parsed };
}

async function databaseCtor(): Promise<DbCtor> {
  return (await import("node:sqlite" as string) as { DatabaseSync: DbCtor }).DatabaseSync;
}

export async function captureRfi024ProviderSnapshot(argv = process.argv.slice(2)): Promise<number> {
  if (argv.length !== 1 || argv[0] !== "--owner-authorized-readonly-refresh") {
    console.error(JSON.stringify({ result: "PROVIDER_SNAPSHOT_BLOCKED", code: "OWNER_AUTHORIZATION_FLAG_REQUIRED",
      authenticationAttemptCount: 0, disputeGetAttemptCount: 0, mutationCount: 0 }));
    return 2;
  }
  let db: Db | undefined;
  let disputeGetCount = 0;
  let authenticationAttemptCount = 0;
  let runtimeConfig: ReturnType<typeof safeSnapshotConfiguration> | undefined;
  const attemptedAt = new Date().toISOString();
  try {
    if (existsSync(outputPath)) throw new Error("SNAPSHOT_ALREADY_EXISTS");
    if (!existsSync(w3Path)) throw new Error("W3_VERIFIED_JOURNAL_MISSING");
    const DatabaseSync = await databaseCtor();
    db = new DatabaseSync(w3Path, { readOnly: true, timeout: 5000 });
    const rows = db.prepare("SELECT * FROM w3_attempt").all();
    if (rows.length !== 1) throw new Error("W3_JOURNAL_CARDINALITY_INVALID");
    const sourceReceipt = JSON.parse(await readFile(resolve(root, "submission/evidence/airwallex-rfi-021-normalized.json"), "utf8")) as Rec;
    if (sourceReceipt.paymentIntentFingerprint !== "5739cecdeb96b009" || sourceReceipt.disputeFingerprint !== "a5507580bf710c5e" ||
        typeof sourceReceipt.retrievedAt !== "string") throw new Error("SANITIZED_SOURCE_RECEIPT_MISMATCH");
    const journal = rows[0]!;
    if (journal.phase !== "READBACK_VERIFIED" || journal.intent_fingerprint !== "5739cecdeb96b009" ||
        journal.dispute_fingerprint !== "a5507580bf710c5e" || typeof journal.dispute_id !== "string" ||
        typeof journal.payment_intent_id !== "string" || journal.provider_stage !== "RFI" ||
        journal.provider_status !== "REQUIRES_RESPONSE" || journal.provider_amount !== 1 ||
        journal.provider_currency !== "USD" || journal.provider_reason_code !== "4837") {
      throw new Error("W3_JOURNAL_NOT_EXPECTED_VERIFIED_DISPUTE");
    }

    const config = loadConfig([]);
    if (config.dryRun || config.base !== baseUrl || config.loginAsTarget) throw new Error("SANDBOX_ACCOUNT_CONFIGURATION_INVALID");
    runtimeConfig = safeSnapshotConfiguration(config);
    const client = new AirwallexClient(config);
    authenticationAttemptCount++;
    await client.login(false, true);
    if (!client.hasValidToken()) throw new Error("AUTH_TOKEN_NOT_VALID_FOR_SINGLE_READ");
    const dispute = await client.request<unknown>("GET", `/api/v1/pa/payment_disputes/${encodeURIComponent(journal.dispute_id as string)}`,
      { sensitiveDisputeRead: true, retry: false, existingAuthenticationOnly: true,
        onRequestAttempt: () => { disputeGetCount++; } });
    const value = asRecord(dispute);
    const reason = asRecord(value?.reason);
    const expectedAmount = Number(journal.provider_amount);
    const exactIdentity = !!value && value.id === journal.dispute_id && value.payment_intent_id === journal.payment_intent_id && value.amount === expectedAmount &&
      value.currency === journal.provider_currency && reason?.original_code === journal.provider_reason_code;
    if (!exactIdentity) throw new Error("FRESH_PROVIDER_DISPUTE_IDENTITY_MISMATCH");
    const validStages = new Set(["RFI", "PRE_CHARGEBACK", "CHARGEBACK", "PRE_ARBITRATION", "ARBITRATION"]);
    const validStatuses = new Set(["REQUIRES_RESPONSE", "CHALLENGED", "ACCEPTED", "REVERSED", "WON", "LOST", "PENDING_CLOSURE", "EXPIRED", "PENDING_DECISION"]);
    if (typeof value.stage !== "string" || !validStages.has(value.stage) || typeof value.status !== "string" || !validStatuses.has(value.status))
      throw new Error("FRESH_PROVIDER_STAGE_OR_STATUS_INVALID");
    const stageStatusMatchesHistorical = value.stage === journal.provider_stage && value.status === journal.provider_status;

    const due = deadline(value.due_at);
    const createdAt = safeText(value.created_at) && Number.isFinite(Date.parse(value.created_at)) ? value.created_at : null;
    const updatedAt = safeText(value.updated_at) && Number.isFinite(Date.parse(value.updated_at)) ? value.updated_at : null;
    const reasonType = safeText(reason?.type, 96) ? reason.type : null;
    const cardBrandRaw = value.card_brand ?? value.payment_method_brand ?? asRecord(value.payment_method)?.card_brand ?? asRecord(value.payment_method)?.brand;
    const cardBrand = typeof cardBrandRaw === "string" && ["VISA", "MASTERCARD", "AMEX", "JCB", "DISCOVER", "UNIONPAY"].includes(cardBrandRaw.toUpperCase())
      ? cardBrandRaw.toUpperCase() : null;
    const paymentMethodRaw = value.payment_method_type;
    const paymentMethodType = typeof paymentMethodRaw === "string" && /^[A-Z0-9_-]{1,40}$/i.test(paymentMethodRaw) ? paymentMethodRaw.toUpperCase() : null;
    const mode = value.mode;
    const disputeMode = typeof mode === "string" && /^[A-Z_]{1,40}$/.test(mode) ? mode : null;
    const receipt = {
      schemaVersion: 2,
      label: "PROVIDER_EXECUTED_SANDBOX_SIMULATION_READONLY_SNAPSHOT",
      caseClassification: "PROVIDER_EXECUTED_SANDBOX_SIMULATION",
      mode: "LIVE_READONLY",
      environment: "AIRWALLEX_SANDBOX",
      readStatus: "VERIFIED",
      attemptedAt,
      retrievedAt: new Date().toISOString(),
      lastVerifiedAt: sourceReceipt.retrievedAt,
      identity: {
        paymentIntentFingerprint: fingerprint(journal.payment_intent_id as string),
        disputeFingerprint: fingerprint(journal.dispute_id as string),
        paymentIntentLinked: true,
        exactHistoricalIdentityMatch: true,
      },
      providerDispute: {
        stage: value.stage,
        status: value.status,
        stageStatusMatchesHistorical,
        amountMinor: Math.round(Number(value.amount) * 100),
        currency: value.currency,
        reasonType,
        reasonCode: reason?.original_code,
        dueAt: due.value,
        dueAtClassification: due.classification,
        dueAtTimezoneExplicit: due.timezoneExplicit,
        dueAtParses: due.parses,
        createdAt,
        updatedAt,
        cardBrand,
        paymentMethodType,
        disputeMode,
        evidenceAvailability: Array.isArray(value.issuer_documents) || Array.isArray(value.challenge_details)
          ? ((value.issuer_documents?.length ?? 0) + (value.challenge_details?.length ?? 0) > 0 ? "PRESENT" : "NONE")
          : "UNKNOWN",
        evidenceReferenceCount: (Array.isArray(value.issuer_documents) ? value.issuer_documents.length : 0) +
          (Array.isArray(value.challenge_details) ? value.challenge_details.length : 0),
        evidenceDocumentsSanitized: true,
      },
      provenance: {
        endpoint: "GET /api/v1/pa/payment_disputes/{id}",
        httpStatus: 200,
        configuration: runtimeConfig,
        getCount: disputeGetCount,
        authenticationAttemptCount,
        authenticationRetryCount: 0,
        disputeGetAttemptCount: disputeGetCount,
        disputeGetRetryCount: 0,
        mutationCount: 0,
        rawProviderIdentifiersIncluded: false,
        rawProviderPayloadIncluded: false,
        sourceJournal: "out/w3-rfi-journal.sqlite (read-only; excluded from package)",
      },
    };
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify({ result: "FRESH_PROVIDER_DISPUTE_READ_VERIFIED", environment: "AIRWALLEX_SANDBOX",
      configuration: runtimeConfig, authenticationAttemptCount, authenticationRetryCount: 0,
      getCount: disputeGetCount, disputeGetRetryCount: 0, mutationCount: 0, paymentIntentFingerprint: receipt.identity.paymentIntentFingerprint,
      disputeFingerprint: receipt.identity.disputeFingerprint, stage: receipt.providerDispute.stage,
      status: receipt.providerDispute.status, reasonCode: receipt.providerDispute.reasonCode,
      dueAt: receipt.providerDispute.dueAt, dueAtClassification: receipt.providerDispute.dueAtClassification,
      evidenceReferenceCount: receipt.providerDispute.evidenceReferenceCount,
      receiptPath: "submission/evidence/airwallex-rfi-024-provider-snapshot.json" }));
    return 0;
  } catch (error) {
    const code = error instanceof Error && safeLocalFailureCodes.has(error.message) ? error.message : "PROVIDER_SNAPSHOT_FAILED_CLOSED";
    console.error(JSON.stringify({ result: "PROVIDER_SNAPSHOT_BLOCKED", code, configuration: runtimeConfig ?? null,
      diagnostic: safeSnapshotFailureDiagnostic(error, { authenticationAttempts: authenticationAttemptCount, disputeGetAttempts: disputeGetCount }) }));
    return 4;
  } finally { db?.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  process.exitCode = await captureRfi024ProviderSnapshot();
