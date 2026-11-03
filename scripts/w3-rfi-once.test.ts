import assert from "node:assert/strict";
import test from "node:test";
import { buildRfiRequest } from "./w3-rfi-once.ts";

test("W3 request is limited to one synthetic Mastercard RFI on the bound PaymentIntent", () => {
  const now = new Date("2026-10-30T01:00:00.000Z");
  const request = buildRfiRequest("int_testSyntheticIntent", now);
  assert.deepEqual(Object.keys(request).sort(), ["comment", "due_at", "payment_intent_id", "reason_code", "stage"]);
  assert.equal(request.payment_intent_id, "int_testSyntheticIntent");
  assert.equal(request.stage, "RFI");
  assert.equal(request.reason_code, "4837");
  assert.equal(request.due_at, "2026-11-06T01:00:00.000Z");
  assert.equal(request.comment, "Fair Trial Starter Kit 04 — synthetic sandbox request for information.");
  assert.equal("amount" in request, false);
  assert.equal("documents" in request, false);
});

test("W3 request builder rejects malformed or guessed PaymentIntent identifiers", () => {
  assert.throws(() => buildRfiRequest("dst_not-a-payment-intent"), /W3_INTENT_ID_INVALID/);
  assert.throws(() => buildRfiRequest("int_"), /W3_INTENT_ID_INVALID/);
});
