import assert from "node:assert/strict";
import test from "node:test";
import { createScenarioEvidence, DEFAULT_DISPUTE_ECONOMICS, recommendDisputeAction, type DisputeSnapshot } from "../spike/dispute-engine.ts";
import { createChallengeEvidencePacket, evaluateValueOfInformation, evaluateWhatIf, validateWhatIfInput } from "../spike/dispute-planning.ts";

const now = Date.parse("2030-01-01T00:00:00.000Z");
const base = { stage: "RFI" as const, feeMinor: 2_500, addedDefenseCostMinor: 0, recoveryRateBps: 8_000,
  deadline: "SAFE" as const, evidence: "TWO_VERIFIED" as const };

test("bounded what-if uses deterministic production policy without persisting or executing", () => {
  const first = evaluateWhatIf(base, now), second = evaluateWhatIf(base, now);
  assert.deepEqual(first, second);
  assert.equal(first.recommendation.action, "CHALLENGE");
  assert.equal(first.recommendation.expectedNetValueMinor, 7_100);
  assert.equal(first.label, "OFFLINE_SYNTHETIC_WHAT_IF");
  assert.equal(first.providerAction, "NOT_EXECUTED");
});

test("stage, fee, deadline and evidence risk changes replan through deterministic policy", () => {
  assert.equal(evaluateWhatIf({ ...base, stage: "CHARGEBACK", addedDefenseCostMinor: 3_000,
    recoveryRateBps: 4_000 }, now).recommendation.action, "ESCALATE_FOR_REVIEW");
  assert.equal(evaluateWhatIf({ ...base, feeMinor: 10_000 }, now).recommendation.action, "ESCALATE_FOR_REVIEW");
  assert.ok(evaluateWhatIf({ ...base, deadline: "CLOSE" }, now).recommendation.reasonCodes.includes("DEADLINE_TOO_CLOSE"));
  assert.ok(evaluateWhatIf({ ...base, deadline: "PASSED" }, now).recommendation.reasonCodes.includes("DEADLINE_PASSED"));
  assert.ok(evaluateWhatIf({ ...base, deadline: "UNKNOWN" }, now).recommendation.reasonCodes.includes("RESPONSE_DEADLINE_UNKNOWN"));
  assert.equal(evaluateWhatIf({ ...base, evidence: "ONE_VERIFIED" }, now).recommendation.action, "ESCALATE_FOR_REVIEW");
  assert.ok(evaluateWhatIf({ ...base, evidence: "CONTRADICTORY" }, now).recommendation.reasonCodes.includes("CONFLICTING_VERIFIED_EVIDENCE"));
  assert.equal(evaluateWhatIf({ ...base, evidence: "UNVERIFIED" }, now).recommendation.action, "ESCALATE_FOR_REVIEW");
});

test("what-if rejects unknown fields, invalid ranges and non-finite assumptions", () => {
  assert.throws(() => validateWhatIfInput({ ...base, amountMinor: 1 }), /INVALID_WHAT_IF_INPUT/);
  assert.throws(() => validateWhatIfInput({ ...base, feeMinor: 25_001 }), /INVALID_WHAT_IF_INPUT/);
  assert.throws(() => validateWhatIfInput({ ...base, recoveryRateBps: 10_001 }), /INVALID_WHAT_IF_INPUT/);
  assert.throws(() => evaluateWhatIf(base, Number.NaN), /INVALID_WHAT_IF_CLOCK/);
});

test("value-of-information shows conditional policy-changing upside without inventing likelihoods", () => {
  const result = evaluateValueOfInformation({ whatIf: { ...base, evidence: "ONE_VERIFIED" }, collectionCostMinor: 500,
    collectionTimeMinutes: 30, availableTimeMinutes: 240 }, now);
  assert.equal(result.conclusion, "CONDITIONAL_UPSIDE_REVIEW_OBTAINABILITY");
  assert.equal(result.baselineAction, "ESCALATE_FOR_REVIEW");
  assert.equal(result.positiveFinding.action, "CHALLENGE");
  assert.equal(result.positiveFinding.expectedNetValueMinor, 7_100);
  assert.equal(result.positiveFinding.conditionalNetAfterCollectionCostMinor, 6_600);
  assert.equal(result.noFinding.action, "ESCALATE_FOR_REVIEW");
  assert.equal(result.probabilityModel, "NONE_BOUNDED_SCENARIOS_ONLY");
  assert.equal(result.providerAction, "NOT_EXECUTED");
});

test("value-of-information handles cost, time, already-sufficient evidence and contradictions conservatively", () => {
  const args = (input: unknown, cost = 500, collection = 30, available = 240) => evaluateValueOfInformation({
    whatIf: input, collectionCostMinor: cost, collectionTimeMinutes: collection, availableTimeMinutes: available,
  }, now);
  assert.equal(args({ ...base, evidence: "ONE_VERIFIED" }, 8_000).conclusion, "COST_EXCEEDS_CONDITIONAL_UPSIDE");
  assert.equal(args({ ...base, evidence: "ONE_VERIFIED" }, 500, 30, 40).conclusion, "TIME_WINDOW_INSUFFICIENT");
  assert.equal(args(base).conclusion, "NO_POLICY_CHANGE_FROM_MORE_EVIDENCE");
  assert.equal(args({ ...base, evidence: "CONTRADICTORY" }).conclusion, "NO_POLICY_CHANGE_FROM_MORE_EVIDENCE");
  assert.throws(() => args({ ...base, currency: "EUR" }), /INVALID_WHAT_IF_INPUT/);
  assert.throws(() => evaluateValueOfInformation({ whatIf: base, collectionCostMinor: -1,
    collectionTimeMinutes: 30, availableTimeMinutes: 240 }, now), /INVALID_VALUE_OF_INFORMATION_INPUT/);
  assert.throws(() => evaluateValueOfInformation({ whatIf: base, collectionCostMinor: 1,
    collectionTimeMinutes: 30, availableTimeMinutes: 240, probability: 0.9 }, now), /INVALID_VALUE_OF_INFORMATION_INPUT/);
});

test("challenge packet carries provenance and a current revision-bound approval but is never submitted", () => {
  const snapshot: DisputeSnapshot = { caseId: "packet-case", amountMinor: 12_000, currency: "USD", reason: "FRAUDULENT",
    reasonCode: "10.4", stage: "CHARGEBACK", status: "REQUIRES_RESPONSE", responseDeadline: "2030-01-03T00:00:00.000Z",
    evidence: createScenarioEvidence("fraud-high-value") };
  const recommendation = recommendDisputeAction(snapshot, DEFAULT_DISPUTE_ECONOMICS, now);
  const decision = { choice: "APPROVE" as const, recommendedAction: "CHALLENGE", actor: "local-operator", createdAt: now,
    idempotencyKey: "review:packet-case:4:APPROVE", revision: 4 };
  const packet = createChallengeEvidencePacket({ caseId: snapshot.caseId, revision: 4, snapshot, recommendation,
    evidence: snapshot.evidence, decision });
  assert.equal(packet.submission.state, "NOT_SUBMITTED");
  assert.equal(packet.submission.providerAction, "NOT_EXECUTED");
  assert.equal(packet.localApproval.snapshotFingerprint, packet.snapshotFingerprint);
  assert.equal(packet.evidence.length, 2);
  assert.ok(/^[a-f0-9]{64}$/.test(packet.packetSha256));
  assert.throws(() => createChallengeEvidencePacket({ caseId: snapshot.caseId, revision: 5, snapshot, recommendation,
    evidence: snapshot.evidence, decision }), /CURRENT_SNAPSHOT_CHALLENGE_APPROVAL_REQUIRED/);
  assert.throws(() => createChallengeEvidencePacket({ caseId: snapshot.caseId, revision: 4, snapshot, recommendation,
    evidence: snapshot.evidence, decision: { ...decision, choice: "REJECT" } }), /CURRENT_SNAPSHOT_CHALLENGE_APPROVAL_REQUIRED/);
});

test("fee, deadline, evidence and revision changes reject a packet approval from the prior snapshot", () => {
  const snapshot: DisputeSnapshot = { caseId: "packet-case", amountMinor: 12_000, currency: "USD", reason: "FRAUDULENT",
    reasonCode: "10.4", stage: "CHARGEBACK", status: "REQUIRES_RESPONSE", responseDeadline: "2030-01-03T00:00:00.000Z",
    evidence: createScenarioEvidence("fraud-high-value") };
  const oldDecision = { choice: "APPROVE" as const, recommendedAction: "CHALLENGE", actor: "local-operator", createdAt: now,
    idempotencyKey: "review:packet-case:4:APPROVE", revision: 4 };
  const variants = [
    { name: "revision", snapshot, revision: 5, economics: DEFAULT_DISPUTE_ECONOMICS },
    { name: "fee", snapshot, revision: 5, economics: { ...DEFAULT_DISPUTE_ECONOMICS, disputeFeeMinor: 3_000 } },
    { name: "deadline", snapshot: { ...snapshot, responseDeadline: "2030-01-04T00:00:00.000Z" }, revision: 5,
      economics: DEFAULT_DISPUTE_ECONOMICS },
    { name: "evidence", snapshot: { ...snapshot, evidence: snapshot.evidence.map((item, index) => index === 0
      ? { ...item, summary: `${item.summary}; revised synthetic evidence` } : item) }, revision: 5,
      economics: DEFAULT_DISPUTE_ECONOMICS },
  ];
  for (const variant of variants) {
    const recommendation = recommendDisputeAction(variant.snapshot, variant.economics, now);
    assert.throws(() => createChallengeEvidencePacket({ caseId: snapshot.caseId, revision: variant.revision,
      snapshot: variant.snapshot, recommendation, evidence: variant.snapshot.evidence, decision: oldDecision }),
    /CURRENT_SNAPSHOT_CHALLENGE_APPROVAL_REQUIRED/, variant.name);
  }
});
