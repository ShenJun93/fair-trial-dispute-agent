import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizeFinancialAction,
  createOfflineRfiFixture,
  createScenarioEvidence,
  DEFAULT_DISPUTE_ECONOMICS,
  DisputeAuditTrail,
  recommendDisputeAction,
  recordRecommendation,
  simulateIssuerRejectionToChargeback,
  simulateMerchantChallenge,
  validateDisputeSnapshot,
  type DisputeSnapshot,
  type HumanApproval,
  fingerprintDisputeDecision,
} from "../spike/dispute-engine.ts";

function snapshot(overrides: Partial<DisputeSnapshot> = {}): DisputeSnapshot {
  return {
    caseId: "case-test-001", amountMinor: 12_000, currency: "USD", reason: "FRAUDULENT", reasonCode: "10.4",
    stage: "CHARGEBACK", status: "REQUIRES_RESPONSE", responseDeadline: "2030-01-01T00:00:00.000Z", evidence: createScenarioEvidence("fraud-high-value"), ...overrides,
  };
}

test("high-value fraud with two verified strong signals recommends challenge", () => {
  const result = recommendDisputeAction(snapshot());
  assert.equal(result.action, "CHALLENGE");
  assert.deepEqual(result.reasonCodes, ["FRAUD_CLAIM", "HIGH_VALUE", "TWO_VERIFIED_STRONG_RISK_SIGNALS"]);
  assert.equal(result.disputeFeeMinor, DEFAULT_DISPUTE_ECONOMICS.disputeFeeMinor);
  assert.equal(result.expectedRecoveryMinor, 9_600);
  assert.equal(result.expectedNetValueMinor, 7_100);
  assert.equal(result.humanReviewRequired, true);
});

test("strong fraud evidence does not recommend a money-losing challenge", () => {
  const result = recommendDisputeAction(snapshot(), { ...DEFAULT_DISPUTE_ECONOMICS, disputeFeeMinor: 9_600 });
  assert.equal(result.action, "ESCALATE_FOR_REVIEW");
  assert.equal(result.expectedRecoveryMinor, 9_600);
  assert.equal(result.expectedNetValueMinor, 0);
  assert.ok(result.reasonCodes.includes("DEFENSE_VALUE_NOT_ABOVE_FEE"));
});

test("stage-specific recovery assumptions can change a challenge into human review", () => {
  const economics = { ...DEFAULT_DISPUTE_ECONOMICS, stageAdjustments: {
    RFI: { additionalDefenseCostMinor: 0, strongFraudWinProbabilityBps: 8_000 },
    CHARGEBACK: { additionalDefenseCostMinor: 3_000, strongFraudWinProbabilityBps: 4_000 },
  } };
  const rfi = recommendDisputeAction(snapshot({stage:"RFI"}),economics);
  const chargeback = recommendDisputeAction(snapshot({stage:"CHARGEBACK"}),economics);
  assert.equal(rfi.action,"CHALLENGE");
  assert.equal(chargeback.action,"ESCALATE_FOR_REVIEW");
  assert.equal(chargeback.disputeFeeMinor,5_500);
  assert.equal(chargeback.expectedNetValueMinor,-700);
  assert.ok(chargeback.reasonCodes.includes("DEFENSE_VALUE_NOT_ABOVE_FEE"));
  assert.equal(recommendDisputeAction(snapshot({stage:"PRE_ARBITRATION"}),economics).action,"ESCALATE_FOR_REVIEW");
});

test("stage cost remains visible when the scenario has insufficient evidence", () => {
  const result = recommendDisputeAction(snapshot({ evidence: [] }), { ...DEFAULT_DISPUTE_ECONOMICS,
    stageAdjustments: { CHARGEBACK: { additionalDefenseCostMinor: 1_000 } } });
  assert.equal(result.action, "ESCALATE_FOR_REVIEW");
  assert.equal(result.disputeFeeMinor, DEFAULT_DISPUTE_ECONOMICS.disputeFeeMinor + 1_000);
});

test("low-value missing-delivery case recommends acceptance when expected recovery is below configured fee", () => {
  const result = recommendDisputeAction(snapshot({ amountMinor: 2_000, reason: "PRODUCT_NOT_RECEIVED", reasonCode: "13.1",
    evidence: createScenarioEvidence("delivery-low-value") }));
  assert.equal(result.action, "ACCEPT");
  assert.equal(result.expectedRecoveryMinor, 300);
  assert.equal(result.expectedNetValueMinor, -2_200);
  assert.ok(result.reasonCodes.includes("DEFENSE_VALUE_NOT_ABOVE_FEE"));
});

test("credit-not-processed with unanswered support is escalated to human review", () => {
  const result = recommendDisputeAction(snapshot({ amountMinor: 6_000, reason: "CREDIT_NOT_PROCESSED", reasonCode: "13.6",
    evidence: createScenarioEvidence("credit-unanswered") }));
  assert.equal(result.action, "ESCALATE_FOR_REVIEW");
  assert.equal(result.humanReviewRequired, true);
  assert.ok(result.reasonCodes.includes("CUSTOMER_SUPPORT_UNANSWERED"));
});

test("evidence provenance, stage and status contracts fail closed", () => {
  assert.deepEqual(validateDisputeSnapshot(snapshot()), []);
  assert.ok(recommendDisputeAction(snapshot({ stage: "ARBITRATION", status: "REQUIRES_RESPONSE" })).reasonCodes.includes("INCONSISTENT_STAGE_STATUS"));
  assert.ok(recommendDisputeAction(snapshot({ status: "UNRECOGNIZED" })).reasonCodes.includes("UNKNOWN_STAGE_OR_STATUS"));
  const invalidEvidence = createScenarioEvidence("fraud-high-value").map((item) => ({ ...item, provenance: { ...item.provenance, reference: "" } }));
  assert.ok(recommendDisputeAction(snapshot({ evidence: invalidEvidence })).reasonCodes.includes("INVALID_EVIDENCE_PROVENANCE"));
});

test("duplicate source assertions cannot count as independent evidence", () => {
  const distinct = createScenarioEvidence("fraud-high-value");
  const duplicated = [{ ...distinct[0]!, id: "copied-evidence-row", summary: "Copied row with a different evidence id" }, ...distinct];
  const result = recommendDisputeAction(snapshot({ evidence: duplicated }));
  assert.equal(result.action, "NO_ACTION");
  assert.ok(result.reasonCodes.includes("DUPLICATE_EVIDENCE_PROVENANCE"));
});

test("financial recommendation needs matching, fresh, single-use human approval", () => {
  const current = snapshot();
  const recommendation = recommendDisputeAction(current);
  const audit = new DisputeAuditTrail();
  const consumed = new Set<string>();
  recordRecommendation(current, recommendation, audit, 100);
  const approval: HumanApproval = { snapshotFingerprint: fingerprintDisputeDecision(current, recommendation), approvalId: "approval-1", caseId: current.caseId, action: "CHALLENGE", actor: "operator-1", approvedAt: 101, expiresAt: 200 };
  assert.throws(() => authorizeFinancialAction(current, recommendation, { ...approval, action: "ACCEPT" }, audit, consumed, 110), /HUMAN_APPROVAL_REQUIRED/);
  authorizeFinancialAction(current, recommendation, approval, audit, consumed, 110);
  assert.throws(() => authorizeFinancialAction(current, recommendation, approval, audit, consumed, 120), /HUMAN_APPROVAL_REQUIRED/);
  assert.throws(() => authorizeFinancialAction(current, recommendation, { ...approval, approvalId: "expired", expiresAt: 109 }, audit, consumed, 110), /HUMAN_APPROVAL_REQUIRED/);
  assert.deepEqual(audit.entries.map((entry) => entry.event), ["RECOMMENDATION_RECORDED", "APPROVAL_REJECTED", "APPROVAL_ACCEPTED", "APPROVAL_REJECTED", "APPROVAL_REJECTED"]);
  assert.deepEqual(audit.entries.map((entry) => entry.sequence), [1, 2, 3, 4, 5]);
});

test("audit append failure prevents authorization and any financial action", () => {
  const audit = new DisputeAuditTrail();
  audit.append = () => { throw new Error("AUDIT_UNAVAILABLE"); };
  const current = snapshot();
  const result = recommendDisputeAction(current);
  const consumed = new Set<string>();
  assert.throws(() => authorizeFinancialAction(current, result,
    { snapshotFingerprint: fingerprintDisputeDecision(current, result), approvalId: "approval-fail", caseId: current.caseId, action: "CHALLENGE", actor: "operator", approvedAt: 1, expiresAt: 100 }, audit, consumed, 2), /AUDIT_UNAVAILABLE/);
  assert.equal(consumed.has("approval-fail"), true);
});

test("offline RFI challenge and simulated issuer rejection advance to chargeback", () => {
  const opened = createOfflineRfiFixture("mock-case-13");
  const challenged = simulateMerchantChallenge(opened);
  const rejected = simulateIssuerRejectionToChargeback(challenged);
  assert.deepEqual(rejected.events.map((event) => [event.event, event.stage, event.status]), [
    ["DISPUTE_OPENED", "RFI", "REQUIRES_RESPONSE"],
    ["MERCHANT_CHALLENGE_SUBMITTED", "RFI", "CHALLENGED"],
    ["ISSUER_REJECTED_EVIDENCE", "CHARGEBACK", "REQUIRES_RESPONSE"],
  ]);
  assert.ok(rejected.events.every((event) => event.source === "SIMULATED_OFFLINE_FIXTURE"));
  assert.equal(rejected.simulated, true);
  assert.throws(() => simulateMerchantChallenge(rejected), /MOCK_CHALLENGE_STATE_INVALID/);
});

test("human ESCALATE recommendation is distinct from simulator issuer transition", () => {
  const recommendation = recommendDisputeAction(snapshot({ reason: "CREDIT_NOT_PROCESSED", reasonCode: "13.6",
    evidence: createScenarioEvidence("credit-unanswered") }));
  assert.equal(recommendation.action, "ESCALATE_FOR_REVIEW");
  assert.throws(() => simulateIssuerRejectionToChargeback(createOfflineRfiFixture("still-rfi")), /MOCK_ISSUER_TRANSITION_STATE_INVALID/);
});


test("fee currency must match dispute currency before any recovery arithmetic", () => {
  const result = recommendDisputeAction(snapshot({ currency: "EUR" }));
  assert.equal(result.action, "NO_ACTION");
  assert.deepEqual(result.reasonCodes, ["FEE_CURRENCY_MISMATCH"]);
  assert.equal(result.expectedNetValueMinor, null);
});

test("missing, timezone-naive and invalid deadlines fail closed", () => {
  assert.deepEqual(recommendDisputeAction(snapshot({ responseDeadline: undefined })).reasonCodes, ["RESPONSE_DEADLINE_UNKNOWN"]);
  for (const deadline of ["not-a-date", "2030-01-01T00:00:00", "2030-99-01T00:00:00Z", "2030-02-30T00:00:00Z"]) {
    assert.deepEqual(recommendDisputeAction(snapshot({ responseDeadline: deadline })).reasonCodes, ["INVALID_RESPONSE_DEADLINE"]);
  }
});

test("deadline safety margin uses an injected clock", () => {
  const time = Date.parse("2026-10-28T08:00:00Z");
  const value = "2026-10-28T08:15:00.000Z";
  assert.deepEqual(recommendDisputeAction(snapshot({ responseDeadline: value }), DEFAULT_DISPUTE_ECONOMICS, time).reasonCodes, ["DEADLINE_TOO_CLOSE"]);
  assert.deepEqual(recommendDisputeAction(snapshot({ responseDeadline: value }), DEFAULT_DISPUTE_ECONOMICS, time + 15 * 60_000).reasonCodes, ["DEADLINE_PASSED"]);
  assert.equal(recommendDisputeAction(snapshot({ responseDeadline: value }), DEFAULT_DISPUTE_ECONOMICS, time - 1).action, "CHALLENGE");
});

test("late local approval is rejected after snapshot response deadline", () => {
  const current = snapshot({ responseDeadline: "2026-10-28T08:00:00Z" });
  const time = Date.parse("2026-10-28T08:00:00Z");
  const recommendation = recommendDisputeAction(current, DEFAULT_DISPUTE_ECONOMICS, time - 86_400_000);
  assert.throws(() => authorizeFinancialAction(current, recommendation,
    { approvalId: "late", caseId: current.caseId, action: "CHALLENGE", actor: "operator", approvedAt: time - 86_400_000, expiresAt: time + 86_400_000 },
    new DisputeAuditTrail(), new Set(), time), /HUMAN_APPROVAL_REQUIRED/);
});

test("invalid fee-currency configuration fails closed", () => {
  assert.deepEqual(recommendDisputeAction(snapshot(), { ...DEFAULT_DISPUTE_ECONOMICS, disputeFeeCurrency: "INVALID" }).reasonCodes, ["INVALID_ECONOMICS"]);
});
