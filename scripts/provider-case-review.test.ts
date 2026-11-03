import assert from "node:assert/strict";
import test from "node:test";
import { createSyntheticDifferential, loadProviderCaseReview, providerCaseResponse, renderProviderCaseReview } from "../spike/provider-case-review.ts";

test("provider-backed judge view derives only sanitized W1/W2/W3 receipt fields", async () => {
  const model = await loadProviderCaseReview();
  assert.equal(model.paymentFingerprint, "5739cecdeb96b009");
  assert.equal(model.disputeFingerprint, "a5507580bf710c5e");
  assert.equal(model.reasonCode, "4837");
  assert.match(model.w1CreatedAt, /2026-10-30/);
  assert.match(model.w2VerifiedAt, /2026-10-30/);
  assert.equal(model.w3ReadAt, "2026-10-30T01:58:16.634Z");
  assert.ok(model.evidenceItems.some((item) => item.classification === "MISSING"));
  assert.ok(model.evidenceItems.some((item) => item.classification === "UNSUPPORTED"));
  assert.equal(model.decisionTrace.policy, "evaluateW4Preflight");
  assert.equal(model.decisionTrace.decision, "HOLD · REQUEST_EVIDENCE · HUMAN_REVIEW");
  assert.equal(model.decisionTrace.providerAction, "NOT_EXECUTED");
  assert.ok(model.decisionTrace.reasons.includes("CASE_IDENTITY_INCOMPLETE_OR_INVALID"));
  assert.ok(model.decisionTrace.reasons.includes("FRESH_PROVIDER_IDENTITY_READ_REQUIRED"));
  assert.ok(model.decisionTrace.reasons.includes("VERIFIED_CARDHOLDER_AUTHORIZATION_EVIDENCE_REQUIRED"));
  assert.ok(model.decisionTrace.reasons.includes("QUALIFYING_CUSTOMER_HISTORY_REQUIRED_FOR_4837"));
  assert.ok(model.decisionTrace.reasons.includes("ACTION_SPECIFIC_OWNER_APPROVAL_REQUIRED"));
  assert.equal(model.decisionTrace.provenance.length, 4);
});

test("provider case browser view is read-only, has a restrictive CSP, and exposes no mutation route", async () => {
  const page = renderProviderCaseReview(await loadProviderCaseReview());
  const get = providerCaseResponse("GET", "/", page);
  assert.equal(get.status, 200);
  assert.equal(get.headers["Content-Security-Policy"].includes("script-src 'none'"), true);
  assert.equal(get.headers["Content-Security-Policy"].includes("connect-src 'none'"), true);
  for (const text of ["PROVIDER_EXECUTED_SANDBOX_SIMULATION", "NOT REFRESHED", "UNKNOWN", "Provider evidence reference count: 0.", "HISTORICAL VERIFIED", "HOLD · REQUEST_EVIDENCE · HUMAN_REVIEW", "W4 · NOT_EXECUTED", "Challenge · disabled", "evaluateW4Preflight", "No LLM decision was run."]) {
    assert.ok(page.includes(text), `expected page to include ${text}`);
  }
  assert.equal(/<script\b/i.test(page), false);
  assert.equal(/\b(?:src|href)\s*=/i.test(page), false);
  assert.equal(/<form\b/i.test(page), false);
  assert.equal(page.includes("<html lang=\"en\">"), true);
  assert.equal(page.includes("aria-label=\"Verified provider lifecycle\""), true);
  assert.equal(page.includes("client_secret"), false);
  assert.equal(page.includes("api_key"), false);
  const post = providerCaseResponse("POST", "/", page);
  assert.equal(post.status, 405);
  assert.equal(post.headers.Allow, "GET");
  assert.equal(providerCaseResponse("GET", "/api/provider/action", page).status, 404);
  assert.match(page, /@media\(max-width:800px\)/);
  assert.match(page, /summary:focus-visible/);
});

test("synthetic differential is separate, inadmissible, and cannot unblock the real case", async () => {
  const model = await loadProviderCaseReview();
  const differential = createSyntheticDifferential(model.decisionTrace);
  assert.equal(differential.label, "OFFLINE_SYNTHETIC_DIFFERENTIAL_ONLY");
  assert.equal(differential.isolatedFromProviderCase, true);
  assert.equal(differential.providerAction, "NOT_EXECUTED");
  assert.ok(differential.newlyAddedReasons.includes("SYNTHETIC_EVIDENCE_NOT_ADMISSIBLE"));
  assert.ok(differential.reasonsWithSyntheticRecords.includes("VERIFIED_CARDHOLDER_AUTHORIZATION_EVIDENCE_REQUIRED"));
  assert.ok(differential.reasonsWithSyntheticRecords.includes("VERIFIED_TRANSACTION_DETAILS_REQUIRED"));
  assert.ok(differential.reasonsWithSyntheticRecords.includes("QUALIFYING_CUSTOMER_HISTORY_REQUIRED_FOR_4837"));
});
