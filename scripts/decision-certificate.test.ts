import assert from "node:assert/strict";
import test from "node:test";
import { createScenarioEvidence } from "../spike/dispute-engine.ts";
import { createDecisionCertificate, verifyDecisionCertificate, canonicalJson } from "../spike/decision-certificate.ts";

const snapshot = { caseId: "synthetic-case", amountMinor: 12000, currency: "USD", reason: "FRAUDULENT", reasonCode: "10.4",
  stage: "RFI", status: "REQUIRES_RESPONSE", responseDeadline: "2030-01-01T00:00:00.000Z",
  evidence: createScenarioEvidence("fraud-high-value") };
const economics = { disputeFeeCurrency: "USD", disputeFeeMinor: 2500, lowValueCeilingMinor: 5000,
  highValueFloorMinor: 10000, weakEvidenceWinProbabilityBps: 1500, strongFraudWinProbabilityBps: 8000,
  stageAdjustments: { RFI: { additionalDefenseCostMinor: 0 } } };
const make = () => createDecisionCertificate({ revision: 2, snapshot, economics, createdAt: "2026-10-29T00:00:00.000Z" });

test("certificate verifies with canonical property ordering and pinned digest", () => {
  const c = make();
  assert.equal(verifyDecisionCertificate(c, 2, c.digest).ok, true);
  const reordered = Object.fromEntries(Object.entries(c).reverse());
  assert.equal(canonicalJson(reordered), canonicalJson(c));
});
test("tampering evidence, decision, money, revision, schema, duplicate refs or missing evidence fails closed", () => {
  const c = make();
  const cases = [
    { ...c, evidence: [{ ...c.evidence[0]!, sha256: "0".repeat(64) }, ...c.evidence.slice(1)] },
    { ...c, recommendation: { ...c.recommendation, action: "ACCEPT" as const } },
    { ...c, economics: { ...c.economics, disputeFeeMinor: 2600 } },
    { ...c, revision: 3 },
    { ...c, schemaVersion: "future/v9" as never },
    { ...c, evidence: [c.evidence[0]!, c.evidence[0]!] },
    { ...c, snapshot: { ...c.snapshot, amountMinor: 11000 } },
    { ...c, snapshot: { ...c.snapshot, evidence: [] } },
  ];
  for (const item of cases) assert.equal(verifyDecisionCertificate(item).ok, false);
  assert.equal(verifyDecisionCertificate(c, 3).reasonCodes[0], "REVISION_MISMATCH");
});
test("coordinated artifact and embedded hashes still fail a separately pinned digest", () => {
  const c = make();
  const modified = { ...c, snapshot: { ...c.snapshot, amountMinor: 11000 } };
  const resealed = createDecisionCertificate({ revision: modified.revision, snapshot: modified.snapshot as typeof snapshot,
    economics: modified.economics, createdAt: modified.createdAt });
  assert.equal(verifyDecisionCertificate(resealed, 2, c.digest).reasonCodes[0], "ANCHOR_MISMATCH");
});
test("synthetic evidence cannot be relabeled as provider verified without breaking its digest", () => {
  const c = make();
  const modified = structuredClone(c);
  modified.snapshot.evidence[0]!.provenance.source = "MERCHANT_SYSTEM";
  modified.snapshot.evidence[0]!.provenance.reference = "airwallex:verified_sandbox";
  assert.equal(verifyDecisionCertificate(modified).reasonCodes[0], "EVIDENCE_HASH_MISMATCH");
});
