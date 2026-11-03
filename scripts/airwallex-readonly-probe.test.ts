import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_BASE, DEFAULT_FILES_BASE, type Config } from "../src/airwallex.ts";
import { runAirwallexReadonlyProbe } from "../src/airwallex-readonly-probe.ts";

const config: Config = {
  clientId: "offline-client-id-secret",
  apiKey: "offline-api-key-secret",
  base: DEFAULT_BASE,
  filesBase: DEFAULT_FILES_BASE,
  webhookSecret: "offline-webhook-secret",
  dryRun: false,
};
const accessTokenFixture = "offline-bearer-" + "token-private";

const dispute = {
  id: "dst_private_dispute_123",
  payment_intent_id: "int_private_payment_456",
  merchant_order_id: "private-merchant-order",
  stage: "RFI",
  status: "REQUIRES_RESPONSE",
  amount: 12.34,
  currency: "USD",
  reason: { type: "FRAUDULENT", original_code: "4837", description: "private raw provider detail" },
  issuer_documents: [],
  challenge_details: [{ private: "raw provider PII" }],
};

test("host probe performs only login plus one validated dispute-list GET and returns sanitized metadata", async () => {
  const oldFetch = globalThis.fetch;
  const calls: Array<{ method: string; url: string; headers: Headers }> = [];
  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    calls.push({ method: init?.method ?? "GET", url: String(input), headers: new Headers(init?.headers) });
    if (String(input).endsWith("/api/v1/authentication/login")) {
      return new Response(JSON.stringify({ token: accessTokenFixture, expires_at: new Date(Date.now() + 60_000).toISOString() }), { status: 200 });
    }
    return new Response(JSON.stringify({ items: [dispute] }), { status: 200 });
  }) as typeof fetch;
  try {
    const result = await runAirwallexReadonlyProbe(config, { actor: "offline-operator", approvalReference: "offline-approval" });
    assert.equal(result.outcome, "VERIFIED");
    assert.equal(result.authentication.httpStatus, 200);
    assert.equal(result.disputeList.httpStatus, 200);
    assert.equal(result.disputeList.schemaValidated, true);
    assert.equal(result.disputeList.returnedItemCount, 1);
    assert.equal(result.providerMutationCount, 0);
    assert.deepEqual(calls.map(({ method, url }) => [method, new URL(url).pathname]), [
      ["POST", "/api/v1/authentication/login"],
      ["GET", "/api/v1/pa/payment_disputes"],
    ]);
    assert.equal(calls[1]?.url, `${DEFAULT_BASE}/api/v1/pa/payment_disputes?page=0&size=1`);
    const serialized = JSON.stringify(result);
    for (const secret of [config.clientId, config.apiKey, config.webhookSecret, accessTokenFixture,
      dispute.id, dispute.payment_intent_id, dispute.merchant_order_id, dispute.reason.type, dispute.challenge_details[0]!.private]) {
      assert.equal(serialized.includes(secret), false);
    }
  } finally { globalThis.fetch = oldFetch; }
});

test("host probe reports first HTTP failure without replaying the dispute-list GET", async () => {
  const oldFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: URL | RequestInfo) => {
    const url = String(input);
    calls.push(url);
    return url.endsWith("/api/v1/authentication/login")
      ? new Response(JSON.stringify({ token: "offline-bearer-token", expires_at: new Date(Date.now() + 60_000).toISOString() }), { status: 200 })
      : new Response(JSON.stringify({ message: "private account detail" }), { status: 403 });
  }) as typeof fetch;
  try {
    const result = await runAirwallexReadonlyProbe(config, { actor: "offline-operator", approvalReference: "offline-approval" });
    assert.equal(result.outcome, "FAILED");
    assert.equal(result.authentication.httpStatus, 200);
    assert.equal(result.disputeList.httpStatus, 403);
    assert.equal(result.disputeList.schemaValidated, false);
    assert.equal(calls.filter((url) => url.includes("/api/v1/pa/payment_disputes")).length, 1);
    assert.equal(JSON.stringify(result).includes("private account detail"), false);
  } finally { globalThis.fetch = oldFetch; }
});

test("host probe refuses dry-run and nonofficial origins before any provider request", async () => {
  const oldFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return new Response("{}", { status: 200 }); }) as typeof fetch;
  try {
    const dryRun = await runAirwallexReadonlyProbe({ ...config, dryRun: true }, { actor: "operator", approvalReference: "approval" });
    const wrongHost = await runAirwallexReadonlyProbe({ ...config, base: "https://api.airwallex.com" }, { actor: "operator", approvalReference: "approval" });
    assert.equal(dryRun.outcome, "FAILED");
    assert.equal(wrongHost.outcome, "FAILED");
    assert.equal(calls, 0);
    assert.equal(dryRun.providerOperations.length, 0);
    assert.equal(wrongHost.providerOperations.length, 0);
  } finally { globalThis.fetch = oldFetch; }
});
