import {
  createOfflineRfiFixture,
  createScenarioEvidence,
  DEFAULT_DISPUTE_ECONOMICS,
  recommendDisputeAction,
  simulateIssuerRejectionToChargeback,
  simulateMerchantChallenge,
  type DisputeEconomics,
  type DisputeSnapshot,
  type OfflineDisputeFixture,
} from "./dispute-engine.ts";

export interface Kit04ReviewCase {
  snapshot: DisputeSnapshot;
  recommendation: ReturnType<typeof recommendDisputeAction>;
}

export const DECISION_PROOF_CASE_ID = "kit04-decision-proof";

/** Small, deterministic offline case used by the judge walkthrough. */
export function createDecisionProofSnapshot(asOf = Date.now()): DisputeSnapshot {
  const responseDeadline = new Date(asOf + 72 * 60 * 60_000).toISOString();
  const claim = (id: string, reference: string) => Object.freeze({
    id, kind: "DEVICE_AND_3DS_MATCH" as const, supportsMerchant: true, strength: "STRONG" as const,
    summary: "Synthetic device and 3DS signals match the customer profile.",
    provenance: Object.freeze({ source: "OPERATOR" as const, reference, observedAt: "2026-10-27T00:00:00.000Z",
      verified: true, subject: "payment:synthetic-001", context: "cardholder-authentication" }),
  });
  return Object.freeze({ caseId: DECISION_PROOF_CASE_ID, amountMinor: 12_000, currency: "USD", reason: "FRAUDULENT",
    reasonCode: "10.4", stage: "CHARGEBACK", status: "REQUIRES_RESPONSE", responseDeadline,
    evidence: Object.freeze([claim("proof-device-signal", "offline-fixture:device"), claim("proof-3ds-signal", "offline-fixture:3ds")]) });
}

export function createKit04ReviewCases(feeMinor = DEFAULT_DISPUTE_ECONOMICS.disputeFeeMinor, asOf = Date.now()): readonly Kit04ReviewCase[] {
  const economics: DisputeEconomics = { ...DEFAULT_DISPUTE_ECONOMICS, disputeFeeMinor: feeMinor };
  const responseDeadline = new Date(asOf + 72 * 60 * 60_000).toISOString(); // synthetic fixture
  const snapshots: DisputeSnapshot[] = [
    { caseId: "kit04-high-value-fraud", amountMinor: 12_000, currency: "USD", reason: "FRAUDULENT", reasonCode: "10.4",
      stage: "CHARGEBACK", status: "REQUIRES_RESPONSE", responseDeadline, evidence: createScenarioEvidence("fraud-high-value") },
    { caseId: "kit04-low-value-delivery", amountMinor: 2_000, currency: "USD", reason: "PRODUCT_NOT_RECEIVED", reasonCode: "13.1",
      stage: "RFI", status: "REQUIRES_RESPONSE", responseDeadline, evidence: createScenarioEvidence("delivery-low-value") },
    { caseId: "kit04-evidence-lab", amountMinor: 12_000, currency: "USD", reason: "FRAUDULENT", reasonCode: "10.4",
      stage: "CHARGEBACK", status: "REQUIRES_RESPONSE", responseDeadline, evidence: createScenarioEvidence("fraud-high-value").slice(0, 1) },
    { caseId: "kit04-credit-not-processed", amountMinor: 6_000, currency: "USD", reason: "CREDIT_NOT_PROCESSED", reasonCode: "13.6",
      stage: "RFI", status: "REQUIRES_RESPONSE", responseDeadline, evidence: createScenarioEvidence("credit-unanswered") },
  ];
  return Object.freeze(snapshots.map((snapshot) => Object.freeze({ snapshot, recommendation: recommendDisputeAction(snapshot, economics, asOf) })));
}

export function createKit04OfflineLifecycle(): OfflineDisputeFixture {
  return simulateIssuerRejectionToChargeback(simulateMerchantChallenge(createOfflineRfiFixture("kit04-offline-rfi-lifecycle")));
}
