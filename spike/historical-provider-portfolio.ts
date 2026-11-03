import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const receipts = [
  {
    file: "ft044a-sandbox-dispute-accepted.json",
    sha256: "450a3921e5c73661c651fc34cd431105bf263bde2251c9378b6ea79cd13b20f2",
  },
  {
    file: "ft050a-visa-rfi-sandbox-proof.json",
    sha256: "8d58032924537fe731562da533b9909681c1c1944931531aa0c321947625b36e",
  },
] as const;
type Obj = Record<string, unknown>;
const obj = (value: unknown): Obj => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("HISTORICAL_PORTFOLIO_RECEIPT_INVALID");
  return value as Obj;
};
function requireTrue(test: unknown): asserts test {
  if (test !== true) throw new Error("HISTORICAL_PORTFOLIO_RECEIPT_INVALID");
}
function fingerprint(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{16}$/.test(value)) throw new Error("HISTORICAL_PORTFOLIO_RECEIPT_INVALID");
  return value;
}
function date(value: unknown): string {
  if (typeof value !== "string" || !/(Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value)))
    throw new Error("HISTORICAL_PORTFOLIO_RECEIPT_INVALID");
  return value;
}
function ops(value: unknown, expected: ReadonlyArray<readonly [string, number]>, phaseKey: "operation" | "phase"): boolean {
  if (!Array.isArray(value) || value.length !== expected.length) return false;
  return expected.every(([phase, http], i) => {
    const row = obj(value[i]);
    return row[phaseKey] === phase && row.http === http;
  });
}

export interface HistoricalProviderCase {
  caseKey: "historical-mastercard-accepted" | "historical-visa-fraud-rfi";
  /** Sanitized 16-character fingerprints only; not provider IDs. */
  paymentFingerprint: string;
  disputeFingerprint: string;
  brand: "MASTERCARD" | "VISA";
  amountMinor: number;
  currency: "USD";
  reasonCode: "4853" | "10.4";
  reasonType: "CONSUMER_DISPUTE" | "FRAUDULENT";
  stage: "CHARGEBACK" | "RFI";
  providerStatus: "ACCEPTED" | "REQUIRES_RESPONSE";
  providerStatusObservedAt: string;
  responseDeadline: string | null;
  localRecommendation: "NONE_HISTORICAL_ACCEPTANCE" | "HOLD_REQUEST_EVIDENCE";
  localRecommendationIsProviderStatus: false;
  actionOrigin: "SEPARATELY_OWNER_EXECUTED" | "NONE";
  agentProviderAction: "NOT_EXECUTED";
  evidenceUploads: 0;
  challengeSubmitted: false;
  issuerRejectionObserved: false;
  refundSettlementVerified: false;
  verifiedDeliveryEvidence: false;
  qualifyingVisaHistoryVerified: false;
  evidenceGaps: readonly string[];
  receiptFile: string;
  receiptSha256: string;
}
export interface HistoricalProviderPortfolio {
  schema: "fair-trial-historical-provider-portfolio/v1";
  classification: "HISTORICAL_OWNER_EXECUTED_SANDBOX_SNAPSHOTS";
  freshProviderRead: false;
  modelInference: false;
  providerNetworkCalls: 0;
  providerMutations: 0;
  actionInterface: "READ_ONLY_NO_ACTION_ENDPOINT";
  cases: readonly HistoricalProviderCase[];
  sourceDigests: ReadonlyArray<{ file: string; sha256: string }>;
}

/** Receipt-backed history only. No credentials, network imports, provider actions, or inference. */
export async function loadHistoricalProviderPortfolio(baseDir = root): Promise<HistoricalProviderPortfolio> {
  const raw = await Promise.all(receipts.map(async (r) => {
    const bytes = await readFile(resolve(baseDir, "submission", "evidence", r.file));
    if (bytes.length > 16_384 || createHash("sha256").update(bytes).digest("hex") !== r.sha256)
      throw new Error("HISTORICAL_PORTFOLIO_EVIDENCE_MISMATCH");
    return obj(JSON.parse(bytes.toString("utf8")) as unknown);
  }));
  const mastercard = raw[0]!;
  const visa = raw[1]!;
  const mcAttempts = obj(mastercard.attempts);
  const payment = obj(visa.payment);
  const dispute = obj(visa.dispute);
  const viOps = obj(visa.operations);
  const viAttempts = obj(visa.attempts);
  const viRestrictions = obj(visa.restrictions);
  const viProvenance = obj(visa.provenance);

  requireTrue(mastercard.schema === "FT044A_PROVIDER_ACCEPT_READBACK_V1" &&
    mastercard.origin === "OWNER_APPROVED_ONE_SHOT_AIRWALLEX_SANDBOX_FT043B" &&
    mastercard.environment === "SANDBOX_ONLY" && mastercard.cardBrand === "MASTERCARD" &&
    mastercard.amountMajor === 1 && mastercard.currency === "USD" &&
    mastercard.reasonCode === "4853" && mastercard.reasonType === "CONSUMER_DISPUTE" &&
    mastercard.stage === "CHARGEBACK" && mastercard.priorStatus === "REQUIRES_RESPONSE" &&
    mastercard.providerAcceptResponseStatus === "ACCEPTED" && mastercard.providerGetReadbackStatus === "ACCEPTED" &&
    mastercard.acceptReason === "LOW_VALUE_TRANSACTION" &&
    mastercard.refundPostExecuted === false && mastercard.refundSettlementVerified === false &&
    mastercard.issuerRejectionObserved === false && mastercard.realCardholderClaim === false &&
    mastercard.automatedAgentMadeDecision === false && mastercard.rawIdsOrCredentialsIncluded === false &&
    ops(mastercard.operations, [["loginPOST", 201], ["preGET", 200], ["acceptPOST", 200], ["postGET", 200]], "operation") &&
    mcAttempts.acceptPOST === 1 && mcAttempts.postGET === 1 && mcAttempts.retries === 0 &&
    mcAttempts.challenges === 0 && mcAttempts.uploads === 0 && mcAttempts.refunds === 0);

  requireTrue(visa.schema === "FT050A_VISA_FRAUD_RFI_SANDBOX_PROOF_V1" &&
    visa.origin === "OWNER_EXECUTED_FT048_FT049_ONESHOTS" &&
    visa.environment === "AIRWALLEX_SANDBOX_ONLY" && visa.caseNature === "SYNTHETIC_SANDBOX_SIMULATION" &&
    payment.cardBrand === "VISA" && payment.amountMajor === 120 && payment.currency === "USD" &&
    payment.status === "SUCCEEDED" && dispute.status === "REQUIRES_RESPONSE" &&
    dispute.stage === "RFI" && dispute.providerReasonCode === "10.4" &&
    dispute.providerReasonType === "FRAUDULENT" && dispute.amountMajor === 120 && dispute.currency === "USD" &&
    dispute.paymentFingerprint16 === payment.fingerprint16 &&
    dispute.orderFingerprint16 === payment.orderFingerprint16 &&
    ops(viOps.payment, [["loginPOST", 201], ["createPOST", 201], ["confirmPOST", 200], ["readbackGET", 200]], "phase") &&
    ops(viOps.dispute, [["loginPOST", 201], ["paymentPreGET", 200], ["disputeCreatePOST", 201], ["disputeDetailGET", 200]], "phase") &&
    viAttempts.paymentRetries === 0 && viAttempts.disputeRetries === 0 &&
    viAttempts.disputeCreates === 1 && viAttempts.evidenceUploads === 0 &&
    viAttempts.challengePOST === 0 && viAttempts.acceptPOST === 0 &&
    viAttempts.issuerEscalationPOST === 0 && viAttempts.refundPOST === 0 &&
    viProvenance.privateDPAPIIdsOutsideSource === true && viRestrictions.agentExecutedProviderActions === false &&
    viRestrictions.merchantDeliveryEvidenceEstablished === false &&
    viRestrictions.priorVisaUndisputedOrdersEstablished === false &&
    viRestrictions.airwallexFileServiceUploaded === false &&
    viRestrictions.issuerRejectionObserved === false && viRestrictions.visaCE3EligibilityEstablished === false &&
    viRestrictions.genuineCardholderClaim === false && viRestrictions.refundSettlementProven === false &&
    viRestrictions.rawIdsOrSecretsIncluded === false && visa.releaseApproved === false);

  const mcCase: HistoricalProviderCase = {
    caseKey: "historical-mastercard-accepted",
    paymentFingerprint: fingerprint(mastercard.paymentFingerprint16),
    disputeFingerprint: fingerprint(mastercard.disputeFingerprint16),
    brand: "MASTERCARD", amountMinor: 100, currency: "USD",
    reasonCode: "4853", reasonType: "CONSUMER_DISPUTE", stage: "CHARGEBACK",
    providerStatus: "ACCEPTED", providerStatusObservedAt: date(mastercard.verifiedUtc),
    responseDeadline: null, localRecommendation: "NONE_HISTORICAL_ACCEPTANCE",
    localRecommendationIsProviderStatus: false, actionOrigin: "SEPARATELY_OWNER_EXECUTED",
    agentProviderAction: "NOT_EXECUTED", evidenceUploads: 0, challengeSubmitted: false,
    issuerRejectionObserved: false, refundSettlementVerified: false,
    verifiedDeliveryEvidence: false, qualifyingVisaHistoryVerified: false, evidenceGaps: [],
    receiptFile: receipts[0].file, receiptSha256: receipts[0].sha256,
  };
  const viCase: HistoricalProviderCase = {
    caseKey: "historical-visa-fraud-rfi",
    paymentFingerprint: fingerprint(payment.fingerprint16),
    disputeFingerprint: fingerprint(dispute.fingerprint16),
    brand: "VISA", amountMinor: 12_000, currency: "USD",
    reasonCode: "10.4", reasonType: "FRAUDULENT", stage: "RFI",
    providerStatus: "REQUIRES_RESPONSE", providerStatusObservedAt: date(dispute.observedUtc),
    responseDeadline: date(dispute.dueAtUtc), localRecommendation: "HOLD_REQUEST_EVIDENCE",
    localRecommendationIsProviderStatus: false, actionOrigin: "NONE",
    agentProviderAction: "NOT_EXECUTED", evidenceUploads: 0, challengeSubmitted: false,
    issuerRejectionObserved: false, refundSettlementVerified: false,
    verifiedDeliveryEvidence: false, qualifyingVisaHistoryVerified: false,
    evidenceGaps: ["Verified delivery / fulfillment", "Corroborated device / IP history",
      "Prior eligible Visa transaction history", "Airwallex File Service evidence IDs"],
    receiptFile: receipts[1].file, receiptSha256: receipts[1].sha256,
  };
  fingerprint(mastercard.paymentFingerprint16);
  fingerprint(mastercard.disputeFingerprint16);
  fingerprint(payment.fingerprint16);
  fingerprint(dispute.fingerprint16);
  return Object.freeze({
    schema: "fair-trial-historical-provider-portfolio/v1",
    classification: "HISTORICAL_OWNER_EXECUTED_SANDBOX_SNAPSHOTS",
    freshProviderRead: false, modelInference: false, providerNetworkCalls: 0,
    providerMutations: 0, actionInterface: "READ_ONLY_NO_ACTION_ENDPOINT",
    cases: Object.freeze([viCase, mcCase]),
    sourceDigests: receipts.map((r) => ({ ...r })),
  });
}
