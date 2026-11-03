// Airwallex HMAC contract: offline only, synthetic secret, no API access.
// Run: node --import tsx --test scripts/webhook-signature.test.ts
import { createHmac } from "node:crypto";
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { verifyAirwallexSignature } from "../src/webhook.ts";

const SECRET = "synthetic-webhook-test-only";
const AT = 1800000000000;
const TS = String(AT);
const RAW = '{"id":"evt_test_001","name":"payment_dispute.requires_response","data":{"object":{"status":"REQUIRES_RESPONSE"}}}';
const sign = (body = RAW, timestamp = TS, secret = SECRET) =>
  createHmac("sha256", secret).update(timestamp + body).digest("hex");
const valid = (opts: Partial<Parameters<typeof verifyAirwallexSignature>[0]> = {}) => ({
  rawBody: RAW, timestamp: TS, signature: sign(), secret: SECRET, now: AT, ...opts,
});

test("valid timestamp + exact raw body HMAC", () => {
  assert.deepEqual(verifyAirwallexSignature(valid()), { ok: true });
});
test("tampered event content and reserialized whitespace are rejected", () => {
  for (const rawBody of [RAW.replace("REQUIRES_RESPONSE", "WON"), JSON.stringify(JSON.parse(RAW), null, 2)]) {
    assert.deepEqual(verifyAirwallexSignature(valid({ rawBody })), { ok: false, reason: "bad_signature" });
  }
});
test("wrong secret and signed timestamp mismatch fail", () => {
  assert.equal(verifyAirwallexSignature(valid({ secret: "different-test-secret" })).ok, false);
  assert.equal(verifyAirwallexSignature(valid({ timestamp: String(AT + 1) })).ok, false);
});
test("missing secret returns no_secret", () => {
  assert.deepEqual(verifyAirwallexSignature(valid({ secret: "" })), { ok: false, reason: "no_secret" });
});
test("malformed signature lengths and nonhex signatures rejected", () => {
  for (const signature of ["", "wrong", sign().slice(0, 61), "z".repeat(64)]) {
    assert.deepEqual(verifyAirwallexSignature(valid({ signature })), { ok: false, reason: "bad_signature" });
  }
});
test("absent HTTP signature/timestamp headers must refuse safely, not throw", () => {
  assert.deepEqual(verifyAirwallexSignature(valid({ signature: undefined as unknown as string })),
    { ok: false, reason: "bad_signature" });
  assert.equal(verifyAirwallexSignature(valid({ timestamp: undefined as unknown as string })).ok, false);
});
test("timestamp older or ahead of tolerance is rejected", () => {
  for (const now of [AT + 300001, AT - 300001]) {
    assert.deepEqual(verifyAirwallexSignature(valid({ now })), { ok: false, reason: "stale_timestamp" });
  }
});
test("exact five-minute threshold passes", () => {
  assert.deepEqual(verifyAirwallexSignature(valid({ now: AT + 300000 })), { ok: true });
});
test("nonnumeric timestamp is rejected even if HMAC valid", () => {
  const timestamp = "not-a-number";
  assert.deepEqual(verifyAirwallexSignature(valid({ timestamp, signature: sign(RAW, timestamp) })),
    { ok: false, reason: "stale_timestamp" });
});
test("verifier alone does not deduplicate a retried event ID", () => {
  // Valid signatures for duplicate events pass twice: handler must dedupe event IDs separately.
  assert.equal(verifyAirwallexSignature(valid()).ok, true);
  assert.equal(verifyAirwallexSignature(valid()).ok, true);
});
