import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = resolve(root, "submission/evidence/airwallex-rfi-021-normalized.json");
const casePath = resolve(root, "submission/evidence/airwallex-rfi-022-case.json");
const matrixPath = resolve(root, "submission/evidence/airwallex-rfi-022-evidence-matrix.json");
const recommendationPath = resolve(root, "submission/evidence/airwallex-rfi-022-recommendation.md");
const snapshot023Path = resolve(root, "submission/evidence/airwallex-rfi-023-provider-snapshot.json");
const case023Path = resolve(root, "submission/evidence/airwallex-rfi-023-case.json");
const decision023Path = resolve(root, "submission/evidence/airwallex-rfi-023-decision.md");
const snapshot024Path = resolve(root, "submission/evidence/airwallex-rfi-024-provider-snapshot.json");
type Receipt = {
  schemaVersion: number; label: string; mode: string; retrievedAt: string;
  paymentIntentFingerprint: string; disputeFingerprint: string;
  normalized: { origin: string; stage: string; status: string; amountMinor: number; currency: string;
    reasonType: string; reasonCode: string; evidenceAvailability: string; evidenceReferenceCount: number;
    actionable: boolean; nonActionableReasons: string[] };
  providerLifecycle: { paymentIntentFreshGetHttpStatus: number; paymentIntentFreshStatus: string;
    duplicateDisputeListHttpStatus: number; duplicateDisputesBeforeCreate: number; createPostCount: number;
    createHttpStatus: number; retryCount: number; disputeReadbackHttpStatus: number; w3JournalRows: number;
    w3JournalPhase: string; w4Actions: number };
  writesDuringIngestion: number; rawProviderIdentifiersIncluded: boolean; rawProviderPayloadIncluded: boolean;
};
const isFp = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{16}$/.test(value);
function validProviderDueAt(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) return false;
  const normalized = /[+-]\d{4}$/.test(value) ? `${value.slice(0, -2)}:${value.slice(-2)}` : value;
  if (!Number.isFinite(Date.parse(normalized))) return false;
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  const calendar = new Date(Date.UTC(year!, month! - 1, day!));
  return calendar.getUTCFullYear() === year && calendar.getUTCMonth() + 1 === month && calendar.getUTCDate() === day;
}

type Snapshot023 = {
  schemaVersion: 2;
  label: "PROVIDER_EXECUTED_SANDBOX_SIMULATION_READONLY_SNAPSHOT";
  caseClassification: "PROVIDER_EXECUTED_SANDBOX_SIMULATION";
  mode: string;
  environment: "AIRWALLEX_SANDBOX";
  readStatus: "VERIFIED" | "BLOCKED";
  retrievedAt: string | null;
  attemptedAt: string | null;
  identity: { paymentIntentFingerprint: string; disputeFingerprint: string; paymentIntentLinked: boolean; exactHistoricalIdentityMatch: boolean };
  providerDispute: { stage: string; status: string; amountMinor: number; currency: string; reasonType: string | null; reasonCode: string;
    stageStatusMatchesHistorical?: boolean;
    dueAt: string | null; dueAtClassification: string; dueAtTimezoneExplicit: boolean; dueAtParses: boolean;
    createdAt: string | null; updatedAt: string | null; cardBrand: string | null; paymentMethodType: string | null;
    disputeMode: string | null; evidenceAvailability: string; evidenceReferenceCount: number; evidenceDocumentsSanitized: boolean };
  provenance: { endpoint: string; httpStatus: number | null; getCount: number; mutationCount: number;
    rawProviderIdentifiersIncluded: false; rawProviderPayloadIncluded: false; sourceJournal: string };
  blocker?: string;
  lastVerifiedAt?: string;
};

export function buildRfi023(snapshot: Snapshot023, snapshotSource = "submission/evidence/airwallex-rfi-023-provider-snapshot.json") {
  const identity = snapshot.identity, dispute = snapshot.providerDispute, provenance = snapshot.provenance;
  if (snapshot.schemaVersion !== 2 || snapshot.label !== "PROVIDER_EXECUTED_SANDBOX_SIMULATION_READONLY_SNAPSHOT" ||
      snapshot.caseClassification !== "PROVIDER_EXECUTED_SANDBOX_SIMULATION" || snapshot.environment !== "AIRWALLEX_SANDBOX" ||
      !isFp(identity.paymentIntentFingerprint) || !isFp(identity.disputeFingerprint) || identity.paymentIntentLinked !== true ||
      identity.exactHistoricalIdentityMatch !== true || provenance.rawProviderIdentifiersIncluded !== false ||
      provenance.rawProviderPayloadIncluded !== false || provenance.mutationCount !== 0 ||
      (snapshot.readStatus === "VERIFIED" && (provenance.httpStatus !== 200 || provenance.getCount !== 1 || !snapshot.retrievedAt)) ||
      (snapshot.readStatus === "BLOCKED" && (provenance.getCount !== 0 || !snapshot.blocker)) ||
      !Number.isSafeInteger(dispute.amountMinor) || dispute.amountMinor <= 0 || dispute.currency !== "USD" ||
      dispute.reasonCode !== "4837" || !Number.isInteger(dispute.evidenceReferenceCount) || dispute.evidenceReferenceCount < 0)
    throw new Error("RFI_023_PROVIDER_SNAPSHOT_NOT_ACCEPTED");
  const live = snapshot.readStatus === "VERIFIED";
  const deadlineKnown = live && dispute.dueAtClassification === "PROVIDER_DUE_AT_EXPLICIT_TIMEZONE" &&
    dispute.dueAtTimezoneExplicit && dispute.dueAtParses && validProviderDueAt(dispute.dueAt);
  const evidence = [
    { id: "provider-payment-status", classification: "VERIFIED", finding: "Historical PaymentIntent status SUCCEEDED, USD 1.00.",
      source: "submission/evidence/airwallex-rfi-021-normalized.json#/providerLifecycle", limitation: "Payment success does not prove cardholder authorization." },
    { id: "provider-dispute-state", classification: "VERIFIED", finding: `Provider dispute ${dispute.stage} / ${dispute.status}, USD 1.00, reason code 4837.`,
      source: live ? "submission/evidence/airwallex-rfi-023-provider-snapshot.json#/providerDispute" : "submission/evidence/airwallex-rfi-021-normalized.json#/normalized",
      limitation: live ? "Fresh detail GET verified exact historical dispute and PaymentIntent linkage." : "Last-known state only; new provider detail GET was blocked before retrieval." },
    { id: "response-deadline", classification: deadlineKnown ? "VERIFIED" : "MISSING", finding: deadlineKnown ? `Provider due_at: ${dispute.dueAt}.` : "No fresh provider deadline is available.",
      source: live ? "submission/evidence/airwallex-rfi-023-provider-snapshot.json#/providerDispute/dueAt" : "Fresh dispute GET did not complete",
      limitation: deadlineKnown ? "Exact timezone-bearing provider field preserved." : "Deadline remains unknown; action must fail closed." },
    { id: "provider-evidence-references", classification: dispute.evidenceReferenceCount ? "VERIFIED" : "VERIFIED", finding: `Provider evidence reference count: ${dispute.evidenceReferenceCount}.`,
      source: live ? "submission/evidence/airwallex-rfi-023-provider-snapshot.json#/providerDispute" : "submission/evidence/airwallex-rfi-021-normalized.json#/normalized",
      limitation: dispute.evidenceReferenceCount ? "Presence does not establish admissibility until documents are inspected." : "No provider evidence documents were present." },
    { id: "cardholder-authorization", classification: "MISSING", finding: "No source-linked cardholder authorization or authentication evidence is available in the sanitized case.", source: "No provider evidence references or merchant records supplied", limitation: "Do not infer from SUCCEEDED." },
    { id: "customer-history", classification: "MISSING", finding: "No linked prior purchase history or customer footprint evidence is available.", source: "No provider evidence references or merchant records supplied", limitation: "Do not claim compelling evidence." },
    { id: "customer-communication", classification: "MISSING", finding: "No consent, customer communication, or dispute-withdrawal record is available.", source: "No provider evidence references or merchant records supplied", limitation: "Do not invent communications or consent." },
    { id: "transaction-fulfillment", classification: "MISSING", finding: "No order, transaction description, delivery, access, service, or booking evidence is available.", source: "No provider evidence references or merchant records supplied", limitation: "Do not claim fulfillment." },
    { id: "offline-fixtures", classification: "SYNTHETIC", finding: "Repository offline examples are separate from this provider-backed case.", source: "spike/dispute-workflow.ts and tests", limitation: "Never attach as customer evidence." },
    { id: "authorization-inference", classification: "UNSUPPORTED", finding: "Payment success proves cardholder authorization.", source: "No supporting source record", limitation: "Reject the inference." },
  ];
  const caseRecord = {
    schemaVersion: 2,
    caseKey: "airwallex-rfi-021",
    caseClassification: "PROVIDER_EXECUTED_SANDBOX_SIMULATION",
    labels: ["AIRWALLEX_SANDBOX", "SIMULATED_DISPUTE_LIFECYCLE", "SYNTHETIC_USD_1_PAYMENT", "NO_W4_ACTION"],
    providerProvenance: { snapshot: snapshotSource, readStatus: snapshot.readStatus,
      retrievedAt: snapshot.retrievedAt, lastVerifiedAt: snapshot.lastVerifiedAt ?? null,
      paymentIntentFingerprint: identity.paymentIntentFingerprint, disputeFingerprint: identity.disputeFingerprint,
      exactHistoricalIdentityMatch: identity.exactHistoricalIdentityMatch, mutationCount: provenance.mutationCount,
      rawProviderIdentifiersIncluded: false, rawProviderPayloadIncluded: false },
    payment: { status: "SUCCEEDED", amountMinor: 100, currency: "USD", source: "submission/evidence/airwallex-rfi-021-normalized.json",
      meaning: "Payment completed; this alone does not prove cardholder authorization." },
    dispute: { stage: dispute.stage, status: dispute.status, reasonType: dispute.reasonType, reasonCode: dispute.reasonCode,
      reasonDescription: "Mastercard 4837 — No cardholder authorization", amountMinor: dispute.amountMinor, currency: dispute.currency,
      responseDeadline: deadlineKnown ? dispute.dueAt : null,
      responseDeadlineClassification: deadlineKnown ? "PROVIDER_DUE_AT_EXPLICIT_TIMEZONE" : dispute.dueAtClassification,
      evidenceAvailability: dispute.evidenceAvailability, evidenceReferenceCount: dispute.evidenceReferenceCount,
      stageStatusMatchesHistorical: dispute.stageStatusMatchesHistorical ?? null,
      cardBrand: dispute.cardBrand, paymentMethodType: dispute.paymentMethodType, createdAt: dispute.createdAt, updatedAt: dispute.updatedAt,
      freshness: live ? "FRESH_PROVIDER_DETAIL_GET" : "HISTORICAL_RECEIPT_ONLY_FRESH_READ_BLOCKED", actionable: false },
    provenance: { endpoint: provenance.endpoint, httpStatus: provenance.httpStatus, getCount: provenance.getCount, mutationCount: provenance.mutationCount,
      w4Actions: 0 },
  };
  const decision = `# Decision — Airwallex Sandbox simulated RFI\n\n`+
    `**Classification:** PROVIDER_EXECUTED_SANDBOX_SIMULATION. This is not a production Mastercard issuer RFI.\n`+
    `**Recommendation:** HOLD · REQUEST_EVIDENCE · HUMAN_REVIEW. **Provider action:** NOT_EXECUTED.\n\n`+
    `## Verified and freshness-labeled facts\n\n`+
    `- PaymentIntent: historical verified status SUCCEEDED; USD 1.00; fingerprint \`${identity.paymentIntentFingerprint}\`. This does not establish cardholder authorization.\n`+
    `- Dispute: ${dispute.stage} / ${dispute.status}; Mastercard 4837; USD 1.00; fingerprint \`${identity.disputeFingerprint}\`.\n`+
    `${live && dispute.status !== "REQUIRES_RESPONSE" ? `- Current provider status is not response-required; do not imply an action is pending.\n` : ""}`+
    `- Fresh dispute read: ${live ? `HTTP 200 at ${snapshot.retrievedAt}; exact identity/linkage matched.` : `BLOCKED before dispute GET; HTTP state was not captured. Last-known values are from the older sanitized receipt (${snapshot.lastVerifiedAt ?? "timestamp recorded in source receipt"}).`}\n`+
    `- Deadline: ${deadlineKnown ? `provider due_at \`${dispute.dueAt}\` was returned with explicit timezone. Check remaining time before any later action.` : `UNKNOWN (${dispute.dueAtClassification}); treat as a hard stop.`}\n`+
    `- Provider evidence references: ${dispute.evidenceReferenceCount}.\n\n`+
    `## Evidence and action policy\n\n`+
    `No authenticated cardholder/3DS evidence, linked purchase history, customer communication, order context, or applicable fulfillment/access/service evidence is available. Synthetic repository examples are not evidence for this case. Do not infer authorization from payment success. Therefore no challenge or accept recommendation is supported.\n\n`+
    `Airwallex documentation says RFI is no longer used by Visa/Mastercard in the real card-network dispute flow; the RFI here was created through an Airwallex Sandbox simulation API. Mastercard 4837 remains accurately mapped to “No cardholder authorization.” A realistic current Mastercard scenario would need a separate eligible chargeback record, not another synthetic RFI. See [Airwallex dispute flow](https://www.airwallex.com/docs/payments/manage-payments/disputes/dispute-flow) and [Payment Disputes API](https://www.airwallex.com/docs/api/payments/payment_disputes/api).\n\n`+
    `## Next step\n\n`+
    `${live ? "Obtain source-linked merchant records, inspect admissibility, and independently recheck provider status/deadline before deciding whether to seek a separately authorized W4 action." : "Do not retry through a different network path. Restore an ordinarily authorized Airwallex sandbox authentication context, then separately authorize one read-only dispute GET. No W4 authorization is implied."}\n`;
  return { caseRecord, matrix: { schemaVersion: 2, caseKey: caseRecord.caseKey, items: evidence }, decision };
}

export function buildRfi022(receipt: Receipt) {
  const n = receipt.normalized, p = receipt.providerLifecycle;
  if (receipt.schemaVersion !== 1 || receipt.label !== "AIRWALLEX_SANDBOX_READ_ONLY_NORMALIZATION" || receipt.mode !== "LIVE_READONLY" ||
      !isFp(receipt.paymentIntentFingerprint) || !isFp(receipt.disputeFingerprint) || n.origin !== "AIRWALLEX" ||
      n.stage !== "RFI" || n.status !== "REQUIRES_RESPONSE" || n.amountMinor !== 100 || n.currency !== "USD" ||
      n.reasonCode !== "4837" || n.evidenceReferenceCount !== 0 || n.actionable !== false ||
      p.paymentIntentFreshGetHttpStatus !== 200 || p.paymentIntentFreshStatus !== "SUCCEEDED" ||
      p.duplicateDisputeListHttpStatus !== 200 || p.duplicateDisputesBeforeCreate !== 0 || p.createPostCount !== 1 ||
      p.createHttpStatus !== 201 || p.retryCount !== 0 || p.disputeReadbackHttpStatus !== 200 ||
      p.w3JournalRows !== 1 || p.w3JournalPhase !== "READBACK_VERIFIED" || p.w4Actions !== 0 ||
      receipt.writesDuringIngestion !== 0 || receipt.rawProviderIdentifiersIncluded || receipt.rawProviderPayloadIncluded)
    throw new Error("SANITIZED_RFI_RECEIPT_NOT_ACCEPTED");

  const evidence = [
    { id: "provider-payment-status", classification: "VERIFIED", category: "payment status", finding: "PaymentIntent status SUCCEEDED.",
      source: "submission/evidence/airwallex-rfi-021-normalized.json#/providerLifecycle", implication: "Confirms payment state only; does not establish cardholder authorization." },
    { id: "provider-dispute-state", classification: "VERIFIED", category: "dispute state", finding: "Airwallex origin; RFI / REQUIRES_RESPONSE; USD 1.00; Mastercard reason code 4837.",
      source: "submission/evidence/airwallex-rfi-021-normalized.json#/normalized", implication: "Provider-backed case facts from sanitized read-only normalization." },
    { id: "provider-evidence-references", classification: "VERIFIED", category: "provider evidence references", finding: "Evidence availability NONE; 0 references; non-actionable reason EVIDENCE_MISSING.",
      source: "submission/evidence/airwallex-rfi-021-normalized.json#/normalized", implication: "No dispute supporting documents were ingested." },
    { id: "response-deadline", classification: "MISSING", category: "deadline", finding: "No response deadline is present in the sanitized normalized receipt.",
      source: "submission/evidence/airwallex-rfi-021-normalized.json#/normalized", implication: "Do not infer a deadline from the W3 creation request; obtain a fresh provider read before any future action." },
    { id: "cardholder-authentication", classification: "MISSING", category: "cardholder authorization", finding: "No 3DS/authentication result, issuer authorization evidence, or identity match record is present.",
      source: "No source record in the normalized receipt; evidenceReferenceCount=0", implication: "Required gap for a 4837 response; payment success alone is not proof of authorization." },
    { id: "purchase-history", classification: "MISSING", category: "customer history", finding: "No linked prior undisputed purchases or customer footprint records are present.",
      source: "No source record in the normalized receipt; evidenceReferenceCount=0", implication: "Cannot claim a history or apply a compelling-evidence pathway." },
    { id: "customer-communications", classification: "MISSING", category: "customer communication", finding: "No customer correspondence, consent, withdrawal, or support records are present.",
      source: "No source record in the normalized receipt; evidenceReferenceCount=0", implication: "Do not assert consent, contact, or dispute withdrawal." },
    { id: "transaction-and-fulfillment", classification: "MISSING", category: "transaction / fulfillment", finding: "No order, product, delivery, digital access, service, or booking records are present.",
      source: "No source record in the normalized receipt; evidenceReferenceCount=0", implication: "Transaction context and fulfillment cannot be claimed." },
    { id: "offline-fixtures", classification: "SYNTHETIC", category: "offline demo examples", finding: "Other OFFLINE_FIXTURE examples exist in the repository but are not linked to this Airwallex dispute.",
      source: "spike/dispute-workflow.ts and offline fixture tests", implication: "Keep separate; never attach or describe as this customer's evidence." },
    { id: "authorization-inference", classification: "UNSUPPORTED", category: "unsupported inference", finding: "‘PaymentIntent SUCCEEDED proves the cardholder authorized the purchase.’",
      source: "No supporting record; contradicted by the distinction in Mastercard reason 4837", implication: "Reject this inference; success proves payment status, not the disputed cardholder identity/authorization." },
  ] as const;

  const caseRecord = {
    schemaVersion: 1,
    caseKey: "airwallex-rfi-021",
    labels: ["REAL_PROVIDER_BACKED_CASE", "AIRWALLEX_SANDBOX", "SYNTHETIC_USD_1_TRANSACTION", "READ_ONLY_INGESTION"],
    providerProvenance: { origin: "AIRWALLEX", environment: "SANDBOX", ingestionMode: "LIVE_READONLY",
      sourceReceipt: "submission/evidence/airwallex-rfi-021-normalized.json", observedAt: receipt.retrievedAt,
      paymentIntentFingerprint: receipt.paymentIntentFingerprint, disputeFingerprint: receipt.disputeFingerprint,
      rawProviderIdentifiersIncluded: false, rawProviderPayloadIncluded: false },
    payment: { status: "SUCCEEDED", amountMinor: 100, currency: "USD", meaning: "Payment completed; this alone does not prove cardholder authorization." },
    dispute: { stage: n.stage, status: n.status, reasonType: n.reasonType, reasonCode: n.reasonCode,
      reasonDescription: "Mastercard 4837 — No cardholder authorization", responseDeadline: null,
      responseDeadlineClassification: "MISSING_FROM_SANITIZED_RECEIPT", evidenceAvailability: n.evidenceAvailability,
      evidenceReferenceCount: n.evidenceReferenceCount, actionable: n.actionable },
    provenance: { freshPaymentIntentGetHttpStatus: p.paymentIntentFreshGetHttpStatus, disputeListHttpStatus: p.duplicateDisputeListHttpStatus,
      disputeCreateHttpStatus: p.createHttpStatus, disputeReadbackHttpStatus: p.disputeReadbackHttpStatus,
      ingestionWrites: receipt.writesDuringIngestion, w4Actions: p.w4Actions },
  };
  const matrix = { schemaVersion: 1, caseKey: caseRecord.caseKey, sourceOfTruth: caseRecord.providerProvenance.sourceReceipt, items: evidence };
  const recommendation = `# Explainable recommendation — Airwallex RFI 021\n\n`+
    `**Decision: HOLD · REQUEST_EVIDENCE · HUMAN_REVIEW**\n`+
    `**Confidence:** low / insufficient evidence (qualitative; not a probability).\n`+
    `**Provider action:** NOT_EXECUTED. Explicit human approval is required for any future action.\n\n`+
    `## Verified provider facts\n\n`+
    `- Airwallex Sandbox PaymentIntent status: **SUCCEEDED**, USD 1.00; fingerprint \`${receipt.paymentIntentFingerprint}\`.\n`+
    `- Airwallex dispute: **RFI / REQUIRES_RESPONSE**, Mastercard **4837 — No cardholder authorization**, USD 1.00; fingerprint \`${receipt.disputeFingerprint}\`.\n`+
    `- Read-only ingestion found **0 evidence references**; the normalized record is non-actionable with \`EVIDENCE_MISSING\`.\n`+
    `- The sanitized receipt contains **no response deadline**. Treat deadline as unknown.\n\n`+
    `## Why no challenge is supported\n\n`+
    `A successful payment status is not proof that the cardholder authorized the transaction. The available receipt contains no authentication result, issuer authorization details, customer history, transaction context, customer communication, or fulfillment record. There are no citations or documents to support those claims.\n\n`+
    `Airwallex maps Mastercard 4837 to “No cardholder authorization.” Its best-practice guidance describes a prior-purchase footprint workflow (two prior transactions with qualifying age, no active fraud dispute, and matching core data elements) for compelling evidence; it also cautions there is no guaranteed reversal for non-Visa schemes. This case has no such history records. See [Airwallex dispute response best practices](https://www.airwallex.com/docs/payments/manage-payments/disputes/dispute-response-best-practices).\n\n`+
    `## Risk indicators and evidence gaps\n\n`+
    `- Missing: exact provider response deadline; cardholder authentication/3DS or other issuer authorization records; customer history; transaction/order details; customer communications; and applicable delivery/access/service records.\n`+
    `- Unsupported: treating payment success as authorization proof, asserting consent, or claiming fulfillment.\n`+
    `- Synthetic repository scenarios are not evidence for this provider-backed case and must not be submitted.\n\n`+
    `## Next action\n\n`+
    `Preserve the case in HOLD. A human should obtain admissible source records through the merchant's authorized systems, verify the current provider dispute and deadline, and reassess. Do not challenge, accept, refund, upload evidence, or otherwise mutate provider state on this record.\n\n`+
    `Evidence matrix: [airwallex-rfi-022-evidence-matrix.json](airwallex-rfi-022-evidence-matrix.json).\n`;
  return { caseRecord, matrix, recommendation };
}

export async function generateRfi022(): Promise<void> {
  if (existsSync(snapshot024Path)) {
    const snapshot = JSON.parse(await readFile(snapshot024Path, "utf8")) as Snapshot023;
    const source = "submission/evidence/airwallex-rfi-024-provider-snapshot.json";
    const result = buildRfi023(snapshot, source);
    await Promise.all([
      writeFile(resolve(root, "submission/evidence/airwallex-rfi-024-case.json"), JSON.stringify(result.caseRecord, null, 2) + "\n", { mode: 0o600 }),
      writeFile(resolve(root, "submission/evidence/airwallex-rfi-024-evidence-matrix.json"), JSON.stringify(result.matrix, null, 2) + "\n", { mode: 0o600 }),
      writeFile(resolve(root, "submission/evidence/airwallex-rfi-024-decision.md"), result.decision, { mode: 0o600 }),
    ]);
    console.log(JSON.stringify({ result: "OFFLINE_CASE_BUILT", mode: "VERSIONED_SAVED_SNAPSHOT_ONLY", providerRequests: 0,
      sourceSchemaVersion: snapshot.schemaVersion, readStatus: snapshot.readStatus, deadline: result.caseRecord.dispute.responseDeadlineClassification,
      recommendation: "HOLD_REQUEST_EVIDENCE_HUMAN_REVIEW", outputs: [
        source, "submission/evidence/airwallex-rfi-024-case.json", "submission/evidence/airwallex-rfi-024-evidence-matrix.json",
        "submission/evidence/airwallex-rfi-024-decision.md" ] }));
    return;
  }
  if (existsSync(snapshot023Path)) {
    const snapshot = JSON.parse(await readFile(snapshot023Path, "utf8")) as Snapshot023;
    const result = buildRfi023(snapshot);
    await Promise.all([
      writeFile(case023Path, JSON.stringify(result.caseRecord, null, 2) + "\n", { mode: 0o600 }),
      writeFile(resolve(root, "submission/evidence/airwallex-rfi-023-evidence-matrix.json"), JSON.stringify(result.matrix, null, 2) + "\n", { mode: 0o600 }),
      writeFile(decision023Path, result.decision, { mode: 0o600 }),
    ]);
    console.log(JSON.stringify({ result: "OFFLINE_CASE_BUILT", mode: "VERSIONED_SAVED_SNAPSHOT_ONLY", providerRequests: 0,
      sourceSchemaVersion: snapshot.schemaVersion, readStatus: snapshot.readStatus, deadline: result.caseRecord.dispute.responseDeadlineClassification,
      recommendation: "HOLD_REQUEST_EVIDENCE_HUMAN_REVIEW", outputs: [
        "submission/evidence/airwallex-rfi-023-provider-snapshot.json", "submission/evidence/airwallex-rfi-023-case.json",
        "submission/evidence/airwallex-rfi-023-evidence-matrix.json", "submission/evidence/airwallex-rfi-023-decision.md" ] }));
    return;
  }
  const receipt = JSON.parse(await readFile(sourcePath, "utf8")) as Receipt;
  const result = buildRfi022(receipt);
  await mkdir(dirname(casePath), { recursive: true });
  await Promise.all([
    writeFile(casePath, JSON.stringify(result.caseRecord, null, 2) + "\n", { mode: 0o600 }),
    writeFile(matrixPath, JSON.stringify(result.matrix, null, 2) + "\n", { mode: 0o600 }),
    writeFile(recommendationPath, result.recommendation, { mode: 0o600 }),
  ]);
  console.log(JSON.stringify({ result: "OFFLINE_CASE_BUILT", mode: "SAVED_SANITIZED_RECEIPT_ONLY", providerRequests: 0,
    providerAction: "NOT_EXECUTED", evidenceReferences: receipt.normalized.evidenceReferenceCount,
    deadline: "MISSING", recommendation: "HOLD_REQUEST_EVIDENCE_HUMAN_REVIEW",
    outputs: ["submission/evidence/airwallex-rfi-022-case.json", "submission/evidence/airwallex-rfi-022-evidence-matrix.json",
      "submission/evidence/airwallex-rfi-022-recommendation.md"] }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await generateRfi022();
