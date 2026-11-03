import assert from "node:assert/strict";
import test from "node:test";
import { createScenarioEvidence, recommendDisputeAction, validateDisputeSnapshot, type DisputeSnapshot } from "../spike/dispute-engine.ts";

const base: DisputeSnapshot = { caseId: "g2-evidence", amountMinor: 12000, currency: "USD", reason: "FRAUDULENT", reasonCode: "10.4",
  stage: "RFI", status: "REQUIRES_RESPONSE", responseDeadline: "2030-01-01T00:00:00.000Z", evidence: createScenarioEvidence("fraud-high-value") };

test("unknown or missing evidence provenance fails closed before decision economics", () => {
  const evidence = [...base.evidence];
  evidence[0] = { ...evidence[0]!, provenance: { ...evidence[0]!.provenance, source: "UNKNOWN" as never } };
  const invalid = { ...base, evidence };
  assert.ok(validateDisputeSnapshot(invalid).includes("INVALID_EVIDENCE_PROVENANCE"));
  assert.equal(recommendDisputeAction(invalid).action, "NO_ACTION");
});

test("conflicting verified evidence of the same claim kind blocks financial recommendation", () => {
  const first = base.evidence[0]!;
  const scoped = { ...first, provenance: { ...first.provenance, subject: "txn-1", context: "cardholder-authentication" } };
  const conflict = { ...scoped, id: "conflicting-signal", supportsMerchant: false, provenance: { ...scoped.provenance, reference: "independent-ref" } };
  const invalid = { ...base, evidence: [scoped, ...base.evidence.slice(1), conflict] };
  assert.ok(validateDisputeSnapshot(invalid).includes("CONFLICTING_VERIFIED_EVIDENCE"));
  const recommendation = recommendDisputeAction(invalid);
  assert.equal(recommendation.action, "NO_ACTION");
  assert.ok(recommendation.reasonCodes.includes("CONFLICTING_VERIFIED_EVIDENCE"));
});

test("same-kind evidence about different subjects is not conflated as a conflict", () => {
  const first = base.evidence[0]!;
  const one = { ...first, provenance: { ...first.provenance, subject: "txn-1", context: "auth" } };
  const other = { ...first, id: "other-subject", supportsMerchant: false,
    provenance: { ...first.provenance, subject: "txn-2", context: "auth" } };
  assert.ok(!validateDisputeSnapshot({ ...base, evidence: [one, other] }).includes("CONFLICTING_VERIFIED_EVIDENCE"));
});
