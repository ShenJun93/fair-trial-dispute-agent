import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";
import { fingerprintDisputeDecision, validateDisputeSnapshot, type DisputeSnapshot } from "../spike/dispute-engine.ts";
import { createDecisionCertificate, verifyDecisionCertificate } from "../spike/decision-certificate.ts";
import { DisputeReviewStore } from "../spike/dispute-review-store.ts";
import { createDisputeReviewHandler } from "../spike/dispute-review-server.ts";
import { createDecisionProofSnapshot, DECISION_PROOF_CASE_ID } from "../spike/dispute-workflow.ts";

const now = Date.parse("2026-10-29T00:00:00.000Z");

async function handlerCall(handler: ReturnType<typeof createDisputeReviewHandler>, method: string, url: string, body?: unknown,
  headers: Record<string, string> = {}) {
  const request = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  Object.assign(request, { method, url, headers: { host: "127.0.0.1:4243", ...headers } });
  const response: { status?: number; body?: string; headers?: Record<string, string> } = {};
  const serverResponse = { writeHead(status: number, headers?: Record<string, string>) { response.status = status; response.headers = headers; return this; }, end(value?: string | Buffer) { response.body = value?.toString(); } } as unknown as ServerResponse;
  await handler(request, serverResponse);
  return { ...response, json: response.body?.startsWith("{") ? JSON.parse(response.body) as Record<string, unknown> : {} };
}

test("synthetic decision proof reset is deterministic and consistently labeled", () => {
  const first = createDecisionProofSnapshot(now), second = createDecisionProofSnapshot(now);
  assert.deepEqual(first, second);
  assert.ok(first.evidence.every((item) => item.provenance.source === "OPERATOR" && item.provenance.reference.startsWith("offline-fixture:")));
});

test("same scoped claim conflict fails closed; unrelated claim is not a false conflict", () => {
  const base = createDecisionProofSnapshot(now), anchor = base.evidence[0]!;
  const unrelated = { ...anchor, id: "other-claim", supportsMerchant: false,
    provenance: { ...anchor.provenance, subject: "payment:other", reference: "offline-fixture:other" } };
  assert.ok(!validateDisputeSnapshot({ ...base, evidence: [...base.evidence, unrelated] }).includes("CONFLICTING_VERIFIED_EVIDENCE"));
  const opposing = { ...anchor, id: "contradiction", supportsMerchant: false,
    provenance: { ...anchor.provenance, reference: "offline-fixture:contradiction" } };
  const conflicted = { ...base, evidence: [...base.evidence, opposing] };
  assert.ok(validateDisputeSnapshot(conflicted).includes("CONFLICTING_VERIFIED_EVIDENCE"));
  const unscoped = { ...opposing, id: "unscoped-opposing", provenance: { ...opposing.provenance, subject: undefined, context: undefined } };
  const uncertain = { ...base, evidence: [{ ...anchor, provenance: { ...anchor.provenance, subject: undefined, context: undefined } }, unscoped] };
  assert.ok(validateDisputeSnapshot(uncertain).includes("UNSCOPED_CONFLICT_CANNOT_BE_EXCLUDED"));
});

test("persisted conflict invalidates the old approval; corrected revision changes fingerprint and certificate", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fair-trial-proof-"));
  const store = await DisputeReviewStore.open(join(dir, "proof.sqlite"), undefined, now);
  try {
    const token = "proof-review-token-that-is-at-least-32-characters";
    store.createSession(token, "csrf-token", "OFFLINE_DEMO_OPERATOR", now);
    const original = store.dashboard().cases.find((item) => item.caseId === DECISION_PROOF_CASE_ID)!;
    const approval = store.issueAuthorizations(token, now).cases[DECISION_PROOF_CASE_ID]!.approve;
    const conflicted = store.advanceDecisionProof(token, "INJECT_CONFLICT", now + 1);
    assert.equal(conflicted.recommendation, "NO_ACTION");
    const conflictCase = store.dashboard().cases.find((item) => item.caseId === DECISION_PROOF_CASE_ID)!;
    assert.ok((conflictCase.recommendation as { reasonCodes: string[] }).reasonCodes.includes("CONFLICTING_VERIFIED_EVIDENCE"));
    assert.ok((conflictCase.evidence as Array<{ provenance: { source: string; reference: string } }>).every((item) =>
      item.provenance.source === "OPERATOR" && item.provenance.reference.startsWith("offline-fixture:")));
    assert.throws(() => store.decide(token, DECISION_PROOF_CASE_ID, "APPROVE", approval, now + 2), /CASE_REVISION_CONFLICT/);
    const resolved = store.advanceDecisionProof(token, "RESOLVE_CONFLICT", now + 3);
    assert.equal(resolved.recommendation, "CHALLENGE");
    const current = store.dashboard().cases.find((item) => item.caseId === DECISION_PROOF_CASE_ID)!;
    const snapshot = current.snapshot as DisputeSnapshot;
    const initialFingerprint = fingerprintDisputeDecision(original.snapshot as DisputeSnapshot, original.recommendation as never);
    const revisedFingerprint = fingerprintDisputeDecision(snapshot, current.recommendation as never);
    assert.notEqual(initialFingerprint, revisedFingerprint);
    assert.equal(Number(current.revision), Number(original.revision) + 2);
    const certificate = createDecisionCertificate({ revision: Number(current.revision), snapshot,
      economics: { disputeFeeCurrency: "USD", disputeFeeMinor: store.dashboard().feeMinor, lowValueCeilingMinor: 5000,
        highValueFloorMinor: 10000, weakEvidenceWinProbabilityBps: 1500, strongFraudWinProbabilityBps: 8000,
        stageAdjustments: { RFI: { additionalDefenseCostMinor: 0 }, CHARGEBACK: { additionalDefenseCostMinor: 0 } } },
      createdAt: new Date(now + 4).toISOString() });
    assert.equal(certificate.snapshotFingerprint, revisedFingerprint);
    assert.equal(verifyDecisionCertificate(certificate, Number(current.revision)).ok, true);
    const tampered = structuredClone(certificate); tampered.snapshot.amountMinor++;
    assert.equal(verifyDecisionCertificate(tampered, Number(current.revision), certificate.digest).ok, false);
    assert.ok((store.dashboard().history as Array<{ note: string }>).some((entry) => entry.note.includes("provider action NOT_EXECUTED")));
    store.advanceDecisionProof(token, "RESET", now + 5);
    const reset = store.dashboard().cases.find((item) => item.caseId === DECISION_PROOF_CASE_ID)!;
    assert.deepEqual(reset.snapshot, createDecisionProofSnapshot(now + 5));
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test("existing dashboard serves the OFFLINE DEMO and API smoke creates and rejects certificates", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fair-trial-proof-ui-"));
  const store = await DisputeReviewStore.open(join(dir, "proof.sqlite"), undefined, now);
  try {
    const operatorSecret = "local-only-unused-token-long-enough";
    const origin = "http://127.0.0.1:4243";
    const handler = createDisputeReviewHandler({ store, operatorToken: operatorSecret, actor: "OFFLINE_DEMO_OPERATOR",
      origin, providerMode: "MOCK", now: () => now, bootstrapCsrf: "proof-ui-csrf" });
    const page = await handlerCall(handler, "GET", "/");
    assert.equal(page.status, 200);
    assert.match(page.body!, /OFFLINE DEMO · SYNTHETIC CASE/);
    assert.match(page.body!, /Inject scoped contradiction/);
    assert.match(page.body!, /case is read-only in the review controls/);
    const login = await handlerCall(handler, "POST", "/api/session", { operatorToken: operatorSecret },
      { host: "127.0.0.1:4243", origin, "x-csrf-token": "proof-ui-csrf", "content-type": "application/json" });
    const sessionHeaders = { cookie: String(login.headers?.["set-cookie"]).split(";")[0], origin,
      "x-csrf-token": String(login.json.csrfToken), "content-type": "application/json" };
    const certificateResponse = await handlerCall(handler, "POST", "/api/decision-proof/certificate", {}, sessionHeaders);
    assert.equal((certificateResponse.json.verification as { ok: boolean } | undefined)?.ok, true, JSON.stringify(certificateResponse));
    const certificate = certificateResponse.json.certificate as ReturnType<typeof createDecisionCertificate>;
    const tampered = structuredClone(certificate); tampered.snapshot.amountMinor++;
    const verify = await handlerCall(handler, "POST", "/api/decision-proof/verify", { certificate: tampered, expectedRevision: tampered.revision,
      pinnedDigest: certificate.digest }, sessionHeaders);
    assert.equal(verify.status, 422);
    assert.equal((verify.json.verification as { ok: boolean }).ok, false);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});
