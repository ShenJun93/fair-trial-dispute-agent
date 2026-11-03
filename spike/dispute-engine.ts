import { createHash } from "node:crypto";

/** Deterministic offline dispute guidance. This module has no Airwallex client or network code. */

export type DisputeStage = "RFI" | "PRE_CHARGEBACK" | "CHARGEBACK" | "PRE_ARBITRATION" | "ARBITRATION";
export type DisputeStatus =
  | "REQUIRES_RESPONSE" | "CHALLENGED" | "ACCEPTED" | "REVERSED" | "WON" | "LOST"
  | "PENDING_CLOSURE" | "EXPIRED" | "PENDING_DECISION";
export type DisputeReason = "FRAUDULENT" | "PRODUCT_NOT_RECEIVED" | "CREDIT_NOT_PROCESSED" | string;
export type EvidenceKind = "DEVICE_AND_3DS_MATCH" | "DELIVERY_SCAN" | "SUPPORT_REQUEST_UNANSWERED" | "OTHER";
export type EvidenceSource = "PAYMENT_RISK_SYSTEM" | "DELIVERY_CARRIER" | "CUSTOMER_SUPPORT" | "MERCHANT_SYSTEM" | "OPERATOR";
export type RecommendationAction = "CHALLENGE" | "ACCEPT" | "ESCALATE_FOR_REVIEW" | "NO_ACTION";
export type FinancialAction = Extract<RecommendationAction, "CHALLENGE" | "ACCEPT">;

export interface EvidenceProvenance {
  source: EvidenceSource;
  reference: string;
  observedAt: string;
  verified: boolean;
  /** Stable claim subject/context; opposing signals are comparable only when both are present and equal. */
  subject?: string;
  context?: string;
}

export interface DisputeEvidence {
  id: string;
  kind: EvidenceKind;
  supportsMerchant: boolean;
  strength: "STRONG" | "WEAK" | "NEUTRAL";
  summary: string;
  provenance: EvidenceProvenance;
}

/** Amounts are integer minor currency units, e.g. 100 USD cents = USD 1.00. */
export interface DisputeSnapshot {
  caseId: string;
  amountMinor: number;
  currency: string;
  reason: DisputeReason;
  reasonCode: string;
  stage: string;
  status: string;
  /** Explicit timezone-aware deadline. Missing deadlines fail closed at recommendation time. */
  responseDeadline?: string;
  evidence: readonly DisputeEvidence[];
}

export interface DisputeEconomics {
  /** Currency of disputeFeeMinor; never perform implicit FX conversion. */
  disputeFeeCurrency: string;
  disputeFeeMinor: number;
  lowValueCeilingMinor: number;
  highValueFloorMinor: number;
  weakEvidenceWinProbabilityBps: number;
  strongFraudWinProbabilityBps: number;
  /** Optional scenario assumptions by response stage; these are not calibrated forecasts. */
  stageAdjustments?: Partial<Record<"RFI" | "CHARGEBACK", { additionalDefenseCostMinor: number;
    strongFraudWinProbabilityBps?: number; weakEvidenceWinProbabilityBps?: number }>>;
}

export const DEFAULT_DISPUTE_ECONOMICS: Readonly<DisputeEconomics> = Object.freeze({
  disputeFeeCurrency: "USD",
  disputeFeeMinor: 2_500,
  lowValueCeilingMinor: 5_000,
  highValueFloorMinor: 10_000,
  weakEvidenceWinProbabilityBps: 1_500,
  strongFraudWinProbabilityBps: 8_000,
  stageAdjustments: Object.freeze({ RFI: Object.freeze({ additionalDefenseCostMinor: 0 }),
    CHARGEBACK: Object.freeze({ additionalDefenseCostMinor: 0 }) }),
});

export interface DisputeRecommendation {
  action: RecommendationAction;
  reasonCodes: readonly string[];
  explanation: string;
  disputeFeeMinor: number;
  expectedRecoveryMinor: number | null;
  expectedNetValueMinor: number | null;
  evidenceIds: readonly string[];
  humanReviewRequired: boolean;
}

const validStages = new Set<DisputeStage>(["RFI", "PRE_CHARGEBACK", "CHARGEBACK", "PRE_ARBITRATION", "ARBITRATION"]);
const validStatuses = new Set<DisputeStatus>([
  "REQUIRES_RESPONSE", "CHALLENGED", "ACCEPTED", "REVERSED", "WON", "LOST",
  "PENDING_CLOSURE", "EXPIRED", "PENDING_DECISION",
]);
const validResponseStages = new Set(["RFI", "PRE_CHARGEBACK", "CHARGEBACK", "PRE_ARBITRATION"]);

const statusStages: Record<DisputeStatus, ReadonlySet<DisputeStage>> = {
  REQUIRES_RESPONSE: new Set(["RFI", "PRE_CHARGEBACK", "CHARGEBACK", "PRE_ARBITRATION"]),
  CHALLENGED: new Set(["RFI", "PRE_CHARGEBACK", "CHARGEBACK", "PRE_ARBITRATION"]),
  ACCEPTED: new Set(["RFI", "PRE_CHARGEBACK", "CHARGEBACK", "PRE_ARBITRATION"]),
  REVERSED: new Set(["PRE_CHARGEBACK", "CHARGEBACK", "PRE_ARBITRATION"]),
  WON: new Set(["CHARGEBACK", "PRE_ARBITRATION", "ARBITRATION"]),
  LOST: new Set(["PRE_ARBITRATION", "ARBITRATION"]),
  PENDING_CLOSURE: new Set(["PRE_ARBITRATION"]),
  EXPIRED: new Set(["RFI"]),
  PENDING_DECISION: new Set(["PRE_ARBITRATION", "ARBITRATION"]),
};

export function validateDisputeSnapshot(snapshot: DisputeSnapshot): readonly string[] {
  const errors: string[] = [];
  if (!Number.isSafeInteger(snapshot.amountMinor) || snapshot.amountMinor <= 0) errors.push("INVALID_AMOUNT");
  if (!/^[A-Z]{3}$/.test(snapshot.currency)) errors.push("INVALID_CURRENCY");
  if (!validStages.has(snapshot.stage as DisputeStage) || !validStatuses.has(snapshot.status as DisputeStatus)) {
    errors.push("UNKNOWN_STAGE_OR_STATUS");
  } else if (!statusStages[snapshot.status as DisputeStatus].has(snapshot.stage as DisputeStage)) {
    errors.push("INCONSISTENT_STAGE_STATUS");
  }
  const sources = new Set<EvidenceSource>(["PAYMENT_RISK_SYSTEM", "DELIVERY_CARRIER", "CUSTOMER_SUPPORT", "MERCHANT_SYSTEM", "OPERATOR"]);
  const evidenceIds = new Set<string>();
  const sourceAssertions = new Set<string>();
  for (const item of snapshot.evidence) {
    if (!item || !item.id || !item.provenance || !sources.has(item.provenance.source) ||
        typeof item.provenance.reference !== "string" || !item.provenance.reference.trim() ||
        typeof item.provenance.verified !== "boolean" || !Number.isFinite(Date.parse(item.provenance.observedAt))) {
      errors.push("INVALID_EVIDENCE_PROVENANCE");
      break;
    }
    const sourceAssertion = `${item.kind}\u0000${item.provenance.source}\u0000${item.provenance.reference.trim()}`;
    if (evidenceIds.has(item.id) || sourceAssertions.has(sourceAssertion)) {
      errors.push("DUPLICATE_EVIDENCE_PROVENANCE");
      break;
    }
    evidenceIds.add(item.id);
    sourceAssertions.add(sourceAssertion);
  }
  if (!errors.includes("INVALID_EVIDENCE_PROVENANCE")) {
    const verified = snapshot.evidence.filter((item) => item.provenance.verified);
    for (let leftIndex = 0; leftIndex < verified.length; leftIndex++) {
      for (let rightIndex = leftIndex + 1; rightIndex < verified.length; rightIndex++) {
        const left = verified[leftIndex]!, right = verified[rightIndex]!;
        if (left.kind !== right.kind || left.supportsMerchant === right.supportsMerchant) continue;
        const leftSubject = left.provenance.subject?.trim(), leftContext = left.provenance.context?.trim();
        const rightSubject = right.provenance.subject?.trim(), rightContext = right.provenance.context?.trim();
        if (!leftSubject || !leftContext || !rightSubject || !rightContext) {
          errors.push("UNSCOPED_CONFLICT_CANNOT_BE_EXCLUDED");
          break;
        }
        if (leftSubject === rightSubject && leftContext === rightContext) {
          errors.push("CONFLICTING_VERIFIED_EVIDENCE");
          break;
        }
      }
      if (errors.includes("CONFLICTING_VERIFIED_EVIDENCE") || errors.includes("UNSCOPED_CONFLICT_CANNOT_BE_EXCLUDED")) break;
    }
  }
  return Object.freeze(errors);
}

function validEconomics(value: DisputeEconomics): boolean {
  const stages = value.stageAdjustments ?? {};
  const validStages = Object.entries(stages).every(([stage, adjustment]) =>
    (stage === "RFI" || stage === "CHARGEBACK") && adjustment !== undefined &&
    Number.isSafeInteger(adjustment.additionalDefenseCostMinor) && adjustment.additionalDefenseCostMinor >= 0 &&
    (adjustment.strongFraudWinProbabilityBps === undefined ||
      Number.isInteger(adjustment.strongFraudWinProbabilityBps) && adjustment.strongFraudWinProbabilityBps >= 0 && adjustment.strongFraudWinProbabilityBps <= 10_000) &&
    (adjustment.weakEvidenceWinProbabilityBps === undefined ||
      Number.isInteger(adjustment.weakEvidenceWinProbabilityBps) && adjustment.weakEvidenceWinProbabilityBps >= 0 && adjustment.weakEvidenceWinProbabilityBps <= 10_000));
  return validStages && /^[A-Z]{3}$/.test(value.disputeFeeCurrency) && Number.isSafeInteger(value.disputeFeeMinor) && value.disputeFeeMinor >= 0 &&
    Number.isSafeInteger(value.lowValueCeilingMinor) && value.lowValueCeilingMinor >= 0 &&
    Number.isSafeInteger(value.highValueFloorMinor) && value.highValueFloorMinor > 0 &&
    Number.isInteger(value.weakEvidenceWinProbabilityBps) && value.weakEvidenceWinProbabilityBps >= 0 && value.weakEvidenceWinProbabilityBps <= 10_000 &&
    Number.isInteger(value.strongFraudWinProbabilityBps) && value.strongFraudWinProbabilityBps >= 0 && value.strongFraudWinProbabilityBps <= 10_000;
}

/** Unknown or unsafe deadlines must never authorize a financial recommendation. */
export function disputeDeadlineError(snapshot: DisputeSnapshot, nowMs: number): string | null {
  if (!Number.isFinite(nowMs)) return "INVALID_CLOCK";
  if (!snapshot.responseDeadline) return "RESPONSE_DEADLINE_UNKNOWN";
  const raw = snapshot.responseDeadline;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(raw)) return "INVALID_RESPONSE_DEADLINE";
  // Date.parse can normalize impossible dates (e.g. February 30); validate calendar components first.
  const [yearText, monthText, dayText] = raw.slice(0, 10).split("-");
  const year = Number(yearText), month = Number(monthText), day = Number(dayText);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() + 1 !== month || calendar.getUTCDate() !== day)
    return "INVALID_RESPONSE_DEADLINE";
  const deadline = Date.parse(raw);
  if (!Number.isFinite(deadline)) return "INVALID_RESPONSE_DEADLINE";
  if (nowMs >= deadline) return "DEADLINE_PASSED";
  if (deadline - nowMs <= 15 * 60_000) return "DEADLINE_TOO_CLOSE";
  return null;
}

export function recommendDisputeAction(
  snapshot: DisputeSnapshot,
  economics: DisputeEconomics = DEFAULT_DISPUTE_ECONOMICS,
  nowMs = Date.now(),
): DisputeRecommendation {
  const base = { disputeFeeMinor: economics.disputeFeeMinor, expectedRecoveryMinor: null, expectedNetValueMinor: null };
  const errors = validateDisputeSnapshot(snapshot);
  if (errors.length || !validEconomics(economics)) {
    return Object.freeze({ action: "NO_ACTION", reasonCodes: Object.freeze(errors.length ? [...errors] : ["INVALID_ECONOMICS"]),
      explanation: "The dispute snapshot or fee configuration is invalid. Stop for review.", evidenceIds: Object.freeze([]), humanReviewRequired: true, ...base });
  }
  if (snapshot.status !== "REQUIRES_RESPONSE" || !validResponseStages.has(snapshot.stage)) {
    return Object.freeze({ action: "NO_ACTION", reasonCodes: Object.freeze(["NOT_ACTIONABLE_STATE"]),
      explanation: "Only a documented response-required dispute stage can be considered for action.", evidenceIds: Object.freeze([]), humanReviewRequired: true, ...base });
  }

  if (snapshot.currency !== economics.disputeFeeCurrency) {
    return Object.freeze({ action: "NO_ACTION", reasonCodes: Object.freeze(["FEE_CURRENCY_MISMATCH"]),
      explanation: "Dispute and fee currencies differ; no FX conversion is configured.",
      evidenceIds: Object.freeze([]), humanReviewRequired: true, ...base });
  }
  const deadlineError = disputeDeadlineError(snapshot, nowMs);
  if (deadlineError) {
    return Object.freeze({ action: "NO_ACTION", reasonCodes: Object.freeze([deadlineError]),
      explanation: "Response deadline is unknown, invalid, elapsed, or too close for a safe action.",
      evidenceIds: Object.freeze([]), humanReviewRequired: true, ...base });
  }

  if (snapshot.stage !== "RFI" && snapshot.stage !== "CHARGEBACK") {
    return Object.freeze({ action: "ESCALATE_FOR_REVIEW", reasonCodes: Object.freeze(["STAGE_ECONOMICS_UNKNOWN", "HUMAN_REVIEW_REQUIRED"]),
      explanation: "This stage has no configured defense economics; a human must review it before a response.",
      evidenceIds: Object.freeze([]), humanReviewRequired: true, ...base });
  }
  const adjustment = economics.stageAdjustments?.[snapshot.stage];
  const defenseCostMinor = economics.disputeFeeMinor + (adjustment?.additionalDefenseCostMinor ?? 0);
  if (!Number.isSafeInteger(defenseCostMinor)) {
    return Object.freeze({ action: "NO_ACTION", reasonCodes: Object.freeze(["INVALID_STAGE_ECONOMICS"]),
      explanation: "The configured stage cost is invalid.", evidenceIds: Object.freeze([]), humanReviewRequired: true, ...base });
  }
  const strongFraudProbability = adjustment?.strongFraudWinProbabilityBps ?? economics.strongFraudWinProbabilityBps;
  const weakDeliveryProbability = adjustment?.weakEvidenceWinProbabilityBps ?? economics.weakEvidenceWinProbabilityBps;

  const verifiedEvidence = snapshot.evidence.filter((item) => item.provenance.verified);
  const strongFraud = snapshot.reason === "FRAUDULENT" && snapshot.amountMinor >= economics.highValueFloorMinor &&
    verifiedEvidence.filter((item) => item.supportsMerchant && item.strength === "STRONG" && item.kind === "DEVICE_AND_3DS_MATCH").length >= 2;
  if (strongFraud) {
    const expectedRecoveryMinor = Math.round(snapshot.amountMinor * strongFraudProbability / 10_000);
    const expectedNetValueMinor = expectedRecoveryMinor - defenseCostMinor;
    if (expectedNetValueMinor <= 0) {
      return Object.freeze({ action: "ESCALATE_FOR_REVIEW", reasonCodes: Object.freeze(["FRAUD_CLAIM", "TWO_VERIFIED_STRONG_RISK_SIGNALS", "DEFENSE_VALUE_NOT_ABOVE_FEE", "HUMAN_REVIEW_REQUIRED"]),
        explanation: "Strong fraud evidence is present, but configured expected recovery does not exceed the dispute fee. A human must review the economics before a response.",
        evidenceIds: Object.freeze(verifiedEvidence.filter((item) => item.supportsMerchant && item.strength === "STRONG").map((item) => item.id)),
        expectedRecoveryMinor, expectedNetValueMinor, disputeFeeMinor: defenseCostMinor, humanReviewRequired: true });
    }
    return Object.freeze({ action: "CHALLENGE", reasonCodes: Object.freeze(["FRAUD_CLAIM", "HIGH_VALUE", "TWO_VERIFIED_STRONG_RISK_SIGNALS"]),
      explanation: "The high-value fraud claim has two verified, merchant-supporting device and 3DS signals. Prepare a challenge for human approval.",
      evidenceIds: Object.freeze(verifiedEvidence.filter((item) => item.supportsMerchant && item.strength === "STRONG").map((item) => item.id)),
      expectedRecoveryMinor, expectedNetValueMinor,
      disputeFeeMinor: defenseCostMinor, humanReviewRequired: true });
  }

  const weakDelivery = snapshot.reason === "PRODUCT_NOT_RECEIVED" && snapshot.amountMinor <= economics.lowValueCeilingMinor &&
    verifiedEvidence.some((item) => item.kind === "DELIVERY_SCAN" && item.supportsMerchant && item.strength === "WEAK");
  if (weakDelivery) {
    const expectedRecoveryMinor = Math.round(snapshot.amountMinor * weakDeliveryProbability / 10_000);
    const expectedNetValueMinor = expectedRecoveryMinor - defenseCostMinor;
    if (expectedNetValueMinor <= 0) {
      return Object.freeze({ action: "ACCEPT", reasonCodes: Object.freeze(["LOW_VALUE_DISPUTE", "WEAK_DELIVERY_EVIDENCE", "DEFENSE_VALUE_NOT_ABOVE_FEE"]),
        explanation: "Weak delivery evidence gives a configured expected recovery no greater than the dispute fee. Acceptance is proposed for human approval.",
        evidenceIds: Object.freeze(verifiedEvidence.filter((item) => item.kind === "DELIVERY_SCAN").map((item) => item.id)),
        expectedRecoveryMinor, expectedNetValueMinor, disputeFeeMinor: defenseCostMinor, humanReviewRequired: true });
    }
  }

  if (snapshot.reason === "CREDIT_NOT_PROCESSED" && verifiedEvidence.some((item) => item.kind === "SUPPORT_REQUEST_UNANSWERED")) {
    return Object.freeze({ action: "ESCALATE_FOR_REVIEW", reasonCodes: Object.freeze(["CREDIT_NOT_PROCESSED", "CUSTOMER_SUPPORT_UNANSWERED", "HUMAN_REVIEW_REQUIRED"]),
      explanation: "An unanswered customer support request needs a human to reconcile the claimed credit before any financial response.",
      evidenceIds: Object.freeze(verifiedEvidence.filter((item) => item.kind === "SUPPORT_REQUEST_UNANSWERED").map((item) => item.id)),
      expectedRecoveryMinor: null, expectedNetValueMinor: null, disputeFeeMinor: defenseCostMinor, humanReviewRequired: true });
  }

  return Object.freeze({ action: "ESCALATE_FOR_REVIEW", reasonCodes: Object.freeze(["INSUFFICIENT_SCENARIO_EVIDENCE", "HUMAN_REVIEW_REQUIRED"]),
    explanation: "Available verified evidence does not meet a deterministic challenge or acceptance rule.",
    evidenceIds: Object.freeze(verifiedEvidence.map((item) => item.id)), humanReviewRequired: true,
    expectedRecoveryMinor: null, expectedNetValueMinor: null, disputeFeeMinor: defenseCostMinor });
}

export const DISPUTE_POLICY_VERSION = "4.1B";
function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  const data = value as Record<string, unknown>;
  return "{" + Object.keys(data).filter((key) => data[key] !== undefined).sort()
    .map((key) => JSON.stringify(key) + ":" + stableJson(data[key])).join(",") + "}";
}
export function fingerprintDisputeDecision(snapshot: DisputeSnapshot, recommendation: DisputeRecommendation,
  storedEvidence: readonly DisputeEvidence[] = snapshot.evidence): string {
  return createHash("sha256").update(stableJson({ policyVersion: DISPUTE_POLICY_VERSION, snapshot,
    recommendation, storedEvidence })).digest("hex");
}

export interface HumanApproval {
  snapshotFingerprint?: string;
  approvalId: string;
  caseId: string;
  action: FinancialAction;
  actor: string;
  approvedAt: number;
  expiresAt: number;
}

export interface DisputeAuditEntry {
  sequence: number;
  at: number;
  caseId: string;
  event: "RECOMMENDATION_RECORDED" | "APPROVAL_ACCEPTED" | "APPROVAL_REJECTED" | "SIMULATED_TRANSITION";
  action: RecommendationAction | null;
  reasonCodes: readonly string[];
  source: "LOCAL_DECISION_ENGINE" | "SIMULATED_OFFLINE_FIXTURE";
  detail: string;
}

export class DisputeAuditTrail {
  #entries: DisputeAuditEntry[] = [];
  get entries(): readonly DisputeAuditEntry[] {
    return Object.freeze(this.#entries.map((entry) => Object.freeze({ ...entry, reasonCodes: Object.freeze([...entry.reasonCodes]) })));
  }
  append(input: Omit<DisputeAuditEntry, "sequence">): DisputeAuditEntry {
    if (!input.caseId || !Number.isFinite(input.at)) throw new Error("AUDIT_WRITE_REJECTED");
    const entry = Object.freeze({ ...input, sequence: this.#entries.length + 1, reasonCodes: Object.freeze([...input.reasonCodes]) });
    this.#entries.push(entry);
    return entry;
  }
}

export function recordRecommendation(snapshot: DisputeSnapshot, recommendation: DisputeRecommendation, audit: DisputeAuditTrail, now = Date.now()): void {
  audit.append({ at: now, caseId: snapshot.caseId, event: "RECOMMENDATION_RECORDED", action: recommendation.action,
    reasonCodes: recommendation.reasonCodes, source: "LOCAL_DECISION_ENGINE", detail: "Offline recommendation only; no provider action executed." });
}

/** Validates and audits human authorization. It does not call or execute any financial API. */
export function authorizeFinancialAction(
  snapshot: DisputeSnapshot,
  recommendation: DisputeRecommendation,
  approval: HumanApproval,
  audit: DisputeAuditTrail,
  consumedApprovals: Set<string>,
  now = Date.now(),
): void {
  const action = recommendation.action;
  const valid = (action === "CHALLENGE" || action === "ACCEPT") && approval.action === action &&
    approval.caseId === snapshot.caseId && !!approval.approvalId && !!approval.actor &&
    Number.isFinite(approval.approvedAt) && approval.approvedAt <= now && approval.expiresAt > now &&
    !consumedApprovals.has(approval.approvalId) && approval.snapshotFingerprint === fingerprintDisputeDecision(snapshot, recommendation) &&
    snapshot.status === "REQUIRES_RESPONSE" &&
    validResponseStages.has(snapshot.stage) && validateDisputeSnapshot(snapshot).length === 0 &&
    disputeDeadlineError(snapshot, now) === null;
  if (!valid) {
    audit.append({ at: now, caseId: snapshot.caseId, event: "APPROVAL_REJECTED", action: action === "CHALLENGE" || action === "ACCEPT" ? action : null,
      reasonCodes: Object.freeze(["APPROVAL_INVALID_OR_REPLAYED"]), source: "LOCAL_DECISION_ENGINE", detail: "No financial operation was executed." });
    throw new Error("HUMAN_APPROVAL_REQUIRED_OR_INVALID");
  }
  // Consume before the audit write. If auditing fails, this approval stays unusable and no caller gets authorization.
  consumedApprovals.add(approval.approvalId);
  audit.append({ at: now, caseId: snapshot.caseId, event: "APPROVAL_ACCEPTED", action,
    reasonCodes: Object.freeze(["HUMAN_APPROVAL_VERIFIED"]), source: "LOCAL_DECISION_ENGINE", detail: `Approved by ${approval.actor}; no financial operation was executed.` });
}

export interface OfflineDisputeEvent {
  sequence: number;
  event: "DISPUTE_OPENED" | "MERCHANT_CHALLENGE_SUBMITTED" | "ISSUER_REJECTED_EVIDENCE";
  stage: DisputeStage;
  status: DisputeStatus;
  source: "SIMULATED_OFFLINE_FIXTURE";
}

export interface OfflineDisputeFixture {
  caseId: string;
  stage: DisputeStage;
  status: DisputeStatus;
  events: readonly OfflineDisputeEvent[];
  simulated: true;
}

function simulatedEvent(sequence: number, event: OfflineDisputeEvent["event"], stage: DisputeStage, status: DisputeStatus): OfflineDisputeEvent {
  return Object.freeze({ sequence, event, stage, status, source: "SIMULATED_OFFLINE_FIXTURE" });
}

export function createOfflineRfiFixture(caseId: string): OfflineDisputeFixture {
  if (!caseId) throw new Error("CASE_ID_REQUIRED");
  return Object.freeze({ caseId, stage: "RFI", status: "REQUIRES_RESPONSE", simulated: true,
    events: Object.freeze([simulatedEvent(1, "DISPUTE_OPENED", "RFI", "REQUIRES_RESPONSE")]) });
}

export function simulateMerchantChallenge(fixture: OfflineDisputeFixture): OfflineDisputeFixture {
  if (fixture.status !== "REQUIRES_RESPONSE" || fixture.stage !== "RFI") throw new Error("MOCK_CHALLENGE_STATE_INVALID");
  return Object.freeze({ ...fixture, status: "CHALLENGED", events: Object.freeze([...fixture.events,
    simulatedEvent(fixture.events.length + 1, "MERCHANT_CHALLENGE_SUBMITTED", "RFI", "CHALLENGED")]) });
}

/** Offline stand-in for issuer rejection; deliberately distinct from the agent action ESCALATE_FOR_REVIEW. */
export function simulateIssuerRejectionToChargeback(fixture: OfflineDisputeFixture): OfflineDisputeFixture {
  if (fixture.status !== "CHALLENGED" || fixture.stage !== "RFI") throw new Error("MOCK_ISSUER_TRANSITION_STATE_INVALID");
  return Object.freeze({ ...fixture, stage: "CHARGEBACK", status: "REQUIRES_RESPONSE", events: Object.freeze([...fixture.events,
    simulatedEvent(fixture.events.length + 1, "ISSUER_REJECTED_EVIDENCE", "CHARGEBACK", "REQUIRES_RESPONSE")]) });
}

export function createScenarioEvidence(caseId: "fraud-high-value" | "delivery-low-value" | "credit-unanswered"): readonly DisputeEvidence[] {
  const source: Record<typeof caseId, { kind: EvidenceKind; source: EvidenceSource; strength: DisputeEvidence["strength"]; supportsMerchant: boolean; summary: string }[]> = {
    "fraud-high-value": [
      { kind: "DEVICE_AND_3DS_MATCH", source: "PAYMENT_RISK_SYSTEM", strength: "STRONG", supportsMerchant: true, summary: "Device and authenticated 3DS signals match the customer profile." },
      { kind: "DEVICE_AND_3DS_MATCH", source: "PAYMENT_RISK_SYSTEM", strength: "STRONG", supportsMerchant: true, summary: "Independent session telemetry supports cardholder authentication." },
    ],
    "delivery-low-value": [
      { kind: "DELIVERY_SCAN", source: "DELIVERY_CARRIER", strength: "WEAK", supportsMerchant: true, summary: "Carrier scan exists but does not confirm delivery to recipient." },
    ],
    "credit-unanswered": [
      { kind: "SUPPORT_REQUEST_UNANSWERED", source: "CUSTOMER_SUPPORT", strength: "NEUTRAL", supportsMerchant: false, summary: "Customer credit request has no recorded response." },
    ],
  };
  return Object.freeze(source[caseId].map((entry, i) => Object.freeze({ id: `${caseId}-evidence-${i + 1}`, ...entry,
    provenance: Object.freeze({ source: entry.source, reference: `fixture:${caseId}:${i + 1}`, observedAt: "2026-10-27T00:00:00.000Z", verified: true }) })));
}
