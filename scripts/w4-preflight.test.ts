import test from "node:test";
import assert from "node:assert/strict";
import { evaluateW4Preflight, fingerprintW4CaseIdentity, type W4PreflightInput } from "../spike/w4-preflight.ts";

const now = Date.parse("2026-10-30T03:00:00.000Z");
const identity = Object.freeze({ paymentIntentFingerprint: "5739cecdeb96b009", disputeFingerprint: "a5507580bf710c5e",
  stage: "RFI", status: "REQUIRES_RESPONSE", reasonCode: "4837", amountMinor: 100, currency: "USD",
  responseDeadline: "2026-11-06T03:00:00.000Z" });
const baseline = (): W4PreflightInput => ({ expectedIdentity: identity,
  freshRead: { source: "AIRWALLEX", retrievedAt: now, identity, identityMatched: true },
  evidence: [{ classification: "VERIFIED", category: "CARDHOLDER_AUTHORIZATION", sourceReference: "record:auth", supportsResponse: true, contradicted: false },
    { classification: "VERIFIED", category: "TRANSACTION_DETAILS", sourceReference: "record:transaction", supportsResponse: true, contradicted: false }],
  requestedAction: "CHALLENGE", approval: { action: "CHALLENGE", caseIdentityFingerprint: fingerprintW4CaseIdentity(identity),
    actor: "owner", approvalId: "approval-1", approvedAt: now - 1000, expiresAt: now + 60_000, consumed: false },
  alreadySubmitted: false, ambiguousPriorSubmission: false, durableDispatchState: "NONE", now });

test("current verified RFI receipt is blocked because provider execution is not implemented", () => {
  const input = baseline();
  input.evidence = [];
  input.freshRead = undefined;
  input.approval = undefined;
  const result = evaluateW4Preflight(input);
  assert.equal(result.allowed, false);
  assert.equal(result.providerAction, "NOT_EXECUTED");
  assert.ok(result.reasons.includes("FRESH_PROVIDER_IDENTITY_READ_REQUIRED"));
  assert.ok(result.reasons.includes("VERIFIED_CARDHOLDER_AUTHORIZATION_EVIDENCE_REQUIRED"));
  assert.ok(result.reasons.includes("ACTION_SPECIFIC_OWNER_APPROVAL_REQUIRED"));
});

test("synthetic evidence never qualifies for challenge", () => {
  const input = baseline();
  input.evidence[0] = { ...input.evidence[0]!, classification: "SYNTHETIC" };
  const result = evaluateW4Preflight(input);
  assert.equal(result.allowed, false);
  assert.ok(result.reasons.includes("VERIFIED_CARDHOLDER_AUTHORIZATION_EVIDENCE_REQUIRED"));
  assert.ok(result.reasons.includes("SYNTHETIC_EVIDENCE_NOT_ADMISSIBLE"));
});

test("identity changes, stale approval, duplicate or ambiguous dispatch fail closed", () => {
  const input = baseline();
  input.freshRead = { ...input.freshRead!, identity: { ...identity, amountMinor: 101 } };
  input.approval = { ...input.approval!, expiresAt: now };
  input.alreadySubmitted = true;
  input.ambiguousPriorSubmission = true;
  input.durableDispatchState = "AMBIGUOUS";
  const reasons = evaluateW4Preflight(input).reasons;
  assert.ok(reasons.includes("FRESH_PROVIDER_IDENTITY_READ_REQUIRED"));
  assert.ok(reasons.includes("ACTION_SPECIFIC_OWNER_APPROVAL_REQUIRED"));
  assert.ok(reasons.includes("ACTION_ALREADY_SUBMITTED"));
  assert.ok(reasons.includes("AMBIGUOUS_PRIOR_DISPATCH_REQUIRES_MANUAL_RECONCILIATION"));
  assert.ok(reasons.includes("DURABLE_DISPATCH_FENCE_NOT_CLEAR"));
});

test("accept and refund also require their own action-specific authorization", () => {
  for (const action of ["ACCEPT", "REFUND"] as const) {
    const input = baseline(); input.requestedAction = action; input.approval = undefined;
    assert.ok(evaluateW4Preflight(input).reasons.includes("ACTION_SPECIFIC_OWNER_APPROVAL_REQUIRED"));
    assert.equal(evaluateW4Preflight(input).providerAction, "NOT_EXECUTED");
  }
});

test("malformed evidence and missing dispatch status fail closed without throwing", () => {
  const input = baseline();
  input.evidence = null as unknown as W4PreflightInput["evidence"];
  input.durableDispatchState = null as unknown as W4PreflightInput["durableDispatchState"];
  assert.doesNotThrow(() => evaluateW4Preflight(input));
  const result = evaluateW4Preflight(input);
  assert.equal(result.allowed, false);
  assert.ok(result.reasons.includes("EVIDENCE_INPUT_INVALID"));
  assert.ok(result.reasons.includes("DURABLE_DISPATCH_FENCE_NOT_CLEAR"));
});

test("missing or expired deadline and an unsupported response claim fail closed", () => {
  const expired = baseline();
  expired.expectedIdentity = { ...identity, responseDeadline: "2026-10-30T02:59:00.000Z" };
  expired.freshRead = { ...expired.freshRead!, identity: expired.expectedIdentity };
  expired.approval = { ...expired.approval!, caseIdentityFingerprint: fingerprintW4CaseIdentity(expired.expectedIdentity) };
  assert.ok(evaluateW4Preflight(expired).reasons.includes("RESPONSE_DEADLINE_EXPIRED"));
  const missing = baseline();
  missing.expectedIdentity = { ...identity, responseDeadline: "" };
  assert.ok(evaluateW4Preflight(missing).reasons.includes("CASE_IDENTITY_INCOMPLETE_OR_INVALID"));
  const unsupported = baseline();
  unsupported.evidence = [...unsupported.evidence, { classification: "UNSUPPORTED", category: "OTHER",
    sourceReference: "unsupported-claim", supportsResponse: true, contradicted: false }];
  assert.ok(evaluateW4Preflight(unsupported).reasons.includes("UNSUPPORTED_EVIDENCE_CLAIM_PRESENT"));
});

test("4837 challenge requires a qualifying two-transaction merchant history", () => {
  const input = baseline();
  input.evidence = [...input.evidence, { classification: "VERIFIED", category: "CUSTOMER_HISTORY", sourceReference: "history:verified",
    supportsResponse: true, contradicted: false, qualifyingPriorTransactionAgesDays: [120, 365], sameMerchant: true,
    noActiveFraudDispute: true, matchedCoreDataElementCount: 2, matchingIncludesIpOrDevice: true }];
  const withHistory = evaluateW4Preflight(input);
  assert.equal(withHistory.allowed, false);
  assert.equal(withHistory.reasons.includes("QUALIFYING_CUSTOMER_HISTORY_REQUIRED_FOR_4837"), false);
  assert.ok(withHistory.reasons.includes("PROVIDER_EXECUTION_NOT_IMPLEMENTED"));
  input.evidence = input.evidence.map((item) => item.category === "CUSTOMER_HISTORY"
    ? { ...item, qualifyingPriorTransactionAgesDays: [119, 365] } : item);
  assert.ok(evaluateW4Preflight(input).reasons.includes("QUALIFYING_CUSTOMER_HISTORY_REQUIRED_FOR_4837"));
});
