import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildRfi022, buildRfi023 } from "./w3-rfi-case.ts";

const receipt = JSON.parse(await readFile(resolve("submission/evidence/airwallex-rfi-021-normalized.json"), "utf8"));

test("sanitized provider receipt builds a traceable RFI case and evidence HOLD", () => {
  const built = buildRfi022(receipt);
  assert.equal(built.caseRecord.dispute.reasonCode, "4837");
  assert.equal(built.caseRecord.dispute.responseDeadline, null);
  assert.equal(built.caseRecord.providerProvenance.disputeFingerprint, "a5507580bf710c5e");
  assert.equal(built.matrix.items.find((item) => item.id === "cardholder-authentication")?.classification, "MISSING");
  assert.equal(built.recommendation.includes("HOLD · REQUEST_EVIDENCE · HUMAN_REVIEW"), true);
  assert.equal(built.recommendation.includes("Provider action:** NOT_EXECUTED"), true);
});

test("receipt mutations, including invented evidence references, are rejected", () => {
  assert.throws(() => buildRfi022({ ...receipt, normalized: { ...receipt.normalized, evidenceReferenceCount: 1 } }), /SANITIZED_RFI_RECEIPT_NOT_ACCEPTED/);
  assert.throws(() => buildRfi022({ ...receipt, paymentIntentFingerprint: "raw-provider-id" }), /SANITIZED_RFI_RECEIPT_NOT_ACCEPTED/);
});

test("schema v2 blocked snapshot labels old facts as historical and keeps deadline unknown", async () => {
  const snapshot = JSON.parse(await readFile(resolve("submission/evidence/airwallex-rfi-023-provider-snapshot.json"), "utf8"));
  const built = buildRfi023(snapshot);
  assert.equal(built.caseRecord.caseClassification, "PROVIDER_EXECUTED_SANDBOX_SIMULATION");
  assert.equal(built.caseRecord.dispute.freshness, "HISTORICAL_RECEIPT_ONLY_FRESH_READ_BLOCKED");
  assert.equal(built.caseRecord.dispute.responseDeadline, null);
  assert.equal(built.caseRecord.dispute.responseDeadlineClassification, "NOT_REFRESHED_AUTHENTICATION_BLOCKED");
  assert.equal(built.caseRecord.provenance.getCount, 0);
  assert.match(built.decision, /BLOCKED before dispute GET/);
  assert.match(built.decision, /HOLD · REQUEST_EVIDENCE · HUMAN_REVIEW/);
});

test("schema v2 rejects false mutation claims and malformed timezone-bearing due_at", async () => {
  const snapshot = JSON.parse(await readFile(resolve("submission/evidence/airwallex-rfi-023-provider-snapshot.json"), "utf8"));
  assert.throws(() => buildRfi023({ ...snapshot, provenance: { ...snapshot.provenance, mutationCount: 1 } }), /RFI_023_PROVIDER_SNAPSHOT_NOT_ACCEPTED/);
  const fresh = { ...snapshot, readStatus: "VERIFIED", retrievedAt: new Date().toISOString(), blocker: undefined,
    provenance: { ...snapshot.provenance, httpStatus: 200, getCount: 1 },
    providerDispute: { ...snapshot.providerDispute, dueAt: "2026-11-06T12:00:00", dueAtClassification: "PROVIDER_DUE_AT_INVALID_OR_TIMEZONE_MISSING" } };
  const built = buildRfi023(fresh);
  assert.equal(built.caseRecord.dispute.responseDeadline, null);
  assert.equal(built.caseRecord.dispute.responseDeadlineClassification, "PROVIDER_DUE_AT_INVALID_OR_TIMEZONE_MISSING");
});
