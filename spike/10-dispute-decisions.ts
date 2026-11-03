import {
  createOfflineRfiFixture,
  createScenarioEvidence,
  DEFAULT_DISPUTE_ECONOMICS,
  DisputeAuditTrail,
  recommendDisputeAction,
  recordRecommendation,
  simulateIssuerRejectionToChargeback,
  simulateMerchantChallenge,
  type DisputeSnapshot,
} from "./dispute-engine.ts";

const responseDeadline = new Date(Date.now() + 72 * 60 * 60_000).toISOString(); // synthetic fixture
const examples: DisputeSnapshot[] = [
  { caseId: "offline-fraud-high", amountMinor: 12_000, currency: "USD", reason: "FRAUDULENT", reasonCode: "10.4",
    stage: "CHARGEBACK", status: "REQUIRES_RESPONSE", responseDeadline, evidence: createScenarioEvidence("fraud-high-value") },
  { caseId: "offline-delivery-low", amountMinor: 2_000, currency: "USD", reason: "PRODUCT_NOT_RECEIVED", reasonCode: "13.1",
    stage: "CHARGEBACK", status: "REQUIRES_RESPONSE", responseDeadline, evidence: createScenarioEvidence("delivery-low-value") },
  { caseId: "offline-credit-unanswered", amountMinor: 6_000, currency: "USD", reason: "CREDIT_NOT_PROCESSED", reasonCode: "13.6",
    stage: "RFI", status: "REQUIRES_RESPONSE", responseDeadline, evidence: createScenarioEvidence("credit-unanswered") },
];

const audit = new DisputeAuditTrail();
const decisions = examples.map((snapshot) => {
  const recommendation = recommendDisputeAction(snapshot, DEFAULT_DISPUTE_ECONOMICS);
  recordRecommendation(snapshot, recommendation, audit);
  return { caseId: snapshot.caseId, recommendation };
});
let lifecycle = createOfflineRfiFixture("offline-lifecycle-13");
lifecycle = simulateMerchantChallenge(lifecycle);
lifecycle = simulateIssuerRejectionToChargeback(lifecycle);

console.log(JSON.stringify({ evidenceSource: "SIMULATED_OFFLINE_FIXTURE", providerResults: false, decisions, lifecycle, audit: audit.entries }, null, 2));
