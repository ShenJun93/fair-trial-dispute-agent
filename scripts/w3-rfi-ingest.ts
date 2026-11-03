import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AirwallexClient, loadConfig } from "../src/airwallex.ts";
import { AirwallexDisputeReadTransport, LiveReadonlyDisputeAdapter } from "../spike/dispute-read-adapter.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const w3Path = resolve(root, "out", "w3-rfi-journal.sqlite");
const receiptPath = resolve(root, "submission", "evidence", "airwallex-rfi-021-normalized.json");
type SqlDb = { prepare(sql: string): { get(...args: unknown[]): Record<string, unknown> | undefined; all(...args: unknown[]): Record<string, unknown>[] }; close(): void };
type SqlCtor = new (path: string, options?: { readOnly?: boolean; timeout?: number }) => SqlDb;
const fp = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16);

async function dbCtor(): Promise<SqlCtor> {
  return (await import("node:sqlite" as string) as { DatabaseSync: SqlCtor }).DatabaseSync;
}

export async function ingestVerifiedW3(): Promise<number> {
  let db: SqlDb | undefined;
  try {
    const DatabaseSync = await dbCtor();
    db = new DatabaseSync(w3Path, { readOnly: true, timeout: 5000 });
    const rows = db.prepare("SELECT * FROM w3_attempt").all();
    if (rows.length !== 1) throw new Error("W3_JOURNAL_CARDINALITY_INVALID");
    const journal = rows[0]!;
    if (journal.phase !== "READBACK_VERIFIED" || typeof journal.payment_intent_id !== "string" ||
        typeof journal.dispute_id !== "string" || journal.intent_fingerprint !== "5739cecdeb96b009" ||
        journal.provider_stage !== "RFI" || journal.provider_status !== "REQUIRES_RESPONSE") {
      throw new Error("W3_PROVIDER_READBACK_NOT_VERIFIED");
    }
    const config = loadConfig([]);
    if (config.dryRun || config.base !== "https://api.sandbox.airwallex.com") throw new Error("SANDBOX_CONFIG_REQUIRED");
    const client = new AirwallexClient(config);
    await client.login(false, true);
    const now = Date.now();
    const adapter = new LiveReadonlyDisputeAdapter(new AirwallexDisputeReadTransport(client), {
      explicitlyConfigured: true,
      approvalReference: "FT-AIRWALLEX-RFI-021-OWNER-APPROVED-READONLY-INGESTION",
      actor: "local-operator",
      authorizedAt: now,
      expiresAt: now + 60_000,
    });
    const page = await adapter.listPage({ paymentIntentId: journal.payment_intent_id, page: "0", size: 100 });
    const listed = page.items.filter((item) => item.disputeId === journal.dispute_id);
    if (page.origin !== "AIRWALLEX" || listed.length !== 1) throw new Error("W3_NOT_VISIBLE_IN_READONLY_INGESTION");
    const normalized = await adapter.retrieve(journal.dispute_id);
    if (normalized.origin !== "AIRWALLEX" || normalized.disputeId !== journal.dispute_id ||
        normalized.paymentIntentId !== journal.payment_intent_id || normalized.stage !== "RFI" ||
        normalized.status !== "REQUIRES_RESPONSE" || normalized.amountMinor !== 100 || normalized.currency !== "USD" ||
        normalized.reasonCode !== "4837") throw new Error("W3_NORMALIZATION_MISMATCH");
    const receipt = {
      schemaVersion: 1,
      label: "AIRWALLEX_SANDBOX_READ_ONLY_NORMALIZATION",
      mode: "LIVE_READONLY",
      retrievedAt: new Date().toISOString(),
      listOrigin: page.origin,
      listedItemCount: page.items.length,
      matchingDisputeCount: listed.length,
      paymentIntentFingerprint: fp(journal.payment_intent_id),
      disputeFingerprint: fp(journal.dispute_id),
      normalized: {
        origin: normalized.origin,
        stage: normalized.stage,
        status: normalized.status,
        amountMinor: normalized.amountMinor,
        currency: normalized.currency,
        reasonType: normalized.reasonType,
        reasonCode: normalized.reasonCode,
        evidenceAvailability: normalized.evidence.availability,
        evidenceReferenceCount: normalized.evidence.referenceCount,
        actionable: normalized.actionable,
        nonActionableReasons: normalized.nonActionableReasons,
      },
      writesDuringIngestion: 0,
      rawProviderIdentifiersIncluded: false,
      rawProviderPayloadIncluded: false,
    };
    await mkdir(dirname(receiptPath), { recursive: true });
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify({ result: "INGESTED_AND_NORMALIZED", listOrigin: page.origin,
      listedItemCount: page.items.length, matchingDisputeCount: listed.length,
      paymentIntentFingerprint: receipt.paymentIntentFingerprint, disputeFingerprint: receipt.disputeFingerprint,
      stage: normalized.stage, status: normalized.status, amountMinor: normalized.amountMinor,
      currency: normalized.currency, reasonCode: normalized.reasonCode,
      evidenceAvailability: normalized.evidence.availability, evidenceReferenceCount: normalized.evidence.referenceCount,
      actionable: normalized.actionable, nonActionableReasons: normalized.nonActionableReasons,
      writesDuringIngestion: 0, receiptPath: "submission/evidence/airwallex-rfi-021-normalized.json" }));
    return 0;
  } catch (error) {
    const message = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : "READONLY_INGESTION_FAILED";
    console.error(JSON.stringify({ result: "INGESTION_BLOCKED", code: message, writesDuringIngestion: 0 }));
    return 4;
  } finally { db?.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await ingestVerifiedW3();
