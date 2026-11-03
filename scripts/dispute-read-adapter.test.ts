import assert from "node:assert/strict";
import test from "node:test";
import { AirwallexClient, AirwallexError, type Config } from "../src/airwallex.ts";
import {
  AirwallexDisputeReadTransport,
  createDisputeReadAdapter,
  DisputeReadError,
  LiveReadonlyDisputeAdapter,
  MockDisputeReadAdapter,
  type DisputeReadTransport,
} from "../spike/dispute-read-adapter.ts";

const providerDispute = {
  id: "dst_fixture_100",
  payment_intent_id: "int_fixture_200",
  payment_attempt_id: "att_fixture_300",
  merchant_order_id: "merchant-order-400",
  stage: "CHARGEBACK",
  status: "REQUIRES_RESPONSE",
  amount: 100,
  currency: "USD",
  reason: { type: "FRAUDULENT", original_code: "4837", description: "Synthetic fraud reason" },
  due_at: "2026-11-01T10:00:00+00:00",
  issuer_documents: [{ file_id: "private-file-id" }],
  challenge_details: [],
  customer_name: "Private Customer",
};

class FixtureTransport implements DisputeReadTransport {
  readonly calls: Array<{ method: "GET"; operation: string; argument?: unknown }> = [];
  constructor(private readonly responses: Readonly<Record<string, unknown>>, private readonly errors: Readonly<Record<string, Error>> = {}) {}
  async listPage(request: { page?: string }): Promise<unknown> {
    this.calls.push({ method: "GET", operation: "list", argument: request.page ?? "0" });
    const key = request.page ?? "0";
    if (this.errors[key]) throw this.errors[key];
    if (!Object.hasOwn(this.responses, key)) throw new DisputeReadError("NOT_FOUND", 404);
    return this.responses[key];
  }
  async retrieve(id: string): Promise<unknown> {
    this.calls.push({ method: "GET", operation: "retrieve", argument: id });
    if (this.errors[id]) throw this.errors[id];
    if (!Object.hasOwn(this.responses, id)) throw new DisputeReadError("NOT_FOUND", 404);
    return this.responses[id];
  }
}

function live(transport: DisputeReadTransport): LiveReadonlyDisputeAdapter {
  const at = Date.now();
  return createDisputeReadAdapter("LIVE_READONLY", { transport, authorization: {
    explicitlyConfigured: true, approvalReference: "offline-test-approval", actor: "offline-test-operator", authorizedAt: at, expiresAt: at + 60_000,
  } }) as LiveReadonlyDisputeAdapter;
}

test("successful provider retrieval normalizes linkage, amount, deadline, evidence provenance, and excludes PII", async () => {
  const transport = new FixtureTransport({ [providerDispute.id]: providerDispute });
  const dispute = await live(transport).retrieve(providerDispute.id);
  assert.equal(dispute.origin, "AIRWALLEX");
  assert.equal(dispute.disputeId, providerDispute.id);
  assert.equal(dispute.paymentIntentId, providerDispute.payment_intent_id);
  assert.equal(dispute.paymentAttemptId, providerDispute.payment_attempt_id);
  assert.equal(dispute.merchantOrderId, providerDispute.merchant_order_id);
  assert.equal(dispute.amountMinor, 10_000);
  assert.equal(dispute.reasonCode, "4837");
  assert.equal(dispute.responseDeadline, providerDispute.due_at);
  assert.equal(dispute.evidence.availability, "PRESENT");
  assert.equal(dispute.evidence.referenceCount, 1);
  assert.equal(dispute.evidence.provenance.origin, "AIRWALLEX");
  assert.equal(dispute.actionable, true);
  assert.equal(JSON.stringify(dispute).includes("Private Customer"), false);
  assert.equal(JSON.stringify(dispute).includes("private-file-id"), false);
});

test("list accepts an empty items array and preserves provider provenance", async () => {
  const page = await live(new FixtureTransport({ "0": { items: [] } })).listPage();
  assert.deepEqual(page.items, []);
  assert.equal(page.origin, "AIRWALLEX");
});

test("list and retrieve expose safe typed 401, 403, and 404 failures", async () => {
  for (const [key, status, code] of [["401", 401, "UNAUTHORIZED"], ["403", 403, "FORBIDDEN"], ["404", 404, "NOT_FOUND"]] as const) {
    const adapter = live(new FixtureTransport({}, { [key]: new AirwallexError(status, "provider_error", "private provider text", "GET", "/private") }));
    await assert.rejects(adapter.retrieve(key), (error: unknown) => error instanceof DisputeReadError && error.code === code && error.httpStatus === status);
    await assert.rejects(adapter.listPage({ page: key }), (error: unknown) => error instanceof DisputeReadError && error.code === code && error.httpStatus === status);
  }
});

test("transport timeouts are normalized without exposing provider text", async () => {
  const timeout = new Error("timed out with customer@example.test and private intent id");
  timeout.name = "TimeoutError";
  await assert.rejects(live(new FixtureTransport({}, { "0": timeout })).listPage(),
    (error: unknown) => error instanceof DisputeReadError && error.code === "TIMEOUT" && !error.message.includes("customer@example.test"));
});

test("malformed list, malformed dispute and retrieve identifier mismatch fail closed", async () => {
  const adapter = live(new FixtureTransport({
    badList: { results: [] }, malformed: { ...providerDispute, amount: "100" }, mismatch: { ...providerDispute, id: "different" },
  }));
  await assert.rejects(adapter.listPage({ page: "badList" }), { code: "MALFORMED_DISPUTE_LIST" });
  await assert.rejects(adapter.retrieve("malformed"), { code: "MALFORMED_DISPUTE_RESPONSE" });
  await assert.rejects(adapter.retrieve("mismatch"), { code: "MALFORMED_DISPUTE_RESPONSE" });
});

test("Airwallex cursor pagination follows page_after and prevents replay or unbounded paging", async () => {
  const first = { ...providerDispute, id: "dst_page_one" };
  const second = { ...providerDispute, id: "dst_page_two" };
  const adapter = live(new FixtureTransport({
    "0": { items: [first], page_after: "Y3Vyc29yLTE=" },
    "Y3Vyc29yLTE=": { items: [second] },
  }));
  const all = await adapter.listAll({}, 2);
  assert.deepEqual(all.map((item) => item.disputeId), [first.id, second.id]);
  const replay = live(new FixtureTransport({ "0": { items: [first], page_after: "Y3Vyc29yLTE=" }, "Y3Vyc29yLTE=": { items: [second], page_after: "Y3Vyc29yLTE=" } }));
  await assert.rejects(replay.listAll({}, 4), { code: "PAGINATION_CURSOR_REPLAYED" });
  const capped = live(new FixtureTransport({ "0": { items: [first], page_after: "Y3Vyc29yLTE=" } }));
  await assert.rejects(capped.listAll({}, 1), { code: "PAGINATION_LIMIT_REACHED" });
  await assert.rejects(adapter.listPage({ size: 1001 }), { code: "INVALID_PAGE_SIZE" });
});

test("unknown or inconsistent stage/status, absent evidence, and malformed evidence are non-actionable", async () => {
  const adapter = live(new FixtureTransport({
    unknown: { ...providerDispute, id: "unknown", status: "NEW_PROVIDER_STATE" },
    inconsistent: { ...providerDispute, id: "inconsistent", stage: "RFI", status: "WON" },
    "no-evidence": { ...providerDispute, id: "no-evidence", issuer_documents: [], challenge_details: [] },
    "unknown-evidence": { ...providerDispute, id: "unknown-evidence", issuer_documents: null },
  }));
  const unknown = await adapter.retrieve("unknown");
  assert.equal(unknown.actionable, false);
  assert.ok(unknown.nonActionableReasons.includes("UNKNOWN_STAGE_OR_STATUS"));
  const inconsistent = await adapter.retrieve("inconsistent");
  assert.ok(inconsistent.nonActionableReasons.includes("INCONSISTENT_STAGE_STATUS"));
  assert.equal((await adapter.retrieve("no-evidence")).actionable, false);
  assert.equal((await adapter.retrieve("unknown-evidence")).evidence.availability, "UNKNOWN");
});

test("LIVE_READONLY requires explicit config and separate authorization; MOCK remains fixture-labeled", async () => {
  const transport = new FixtureTransport({ "0": { items: [] } });
  const at = Date.now();
  assert.throws(() => createDisputeReadAdapter("LIVE_READONLY", { transport, authorization: {
    explicitlyConfigured: false, approvalReference: "offline-test-approval", actor: "operator", authorizedAt: at, expiresAt: at + 60_000,
  } }), { code: "LIVE_READONLY_NOT_AUTHORIZED" });
  assert.throws(() => createDisputeReadAdapter("LIVE_READONLY", { transport }), { code: "LIVE_READONLY_NOT_CONFIGURED" });
  assert.throws(() => new LiveReadonlyDisputeAdapter(transport, { explicitlyConfigured: true, approvalReference: "approval", actor: "operator", authorizedAt: at - 20 * 60_000, expiresAt: at - 1 }, () => at), { code: "LIVE_READONLY_NOT_AUTHORIZED" });
  assert.equal(transport.calls.length, 0);
  assert.equal(createDisputeReadAdapter().mode, "MOCK");
  const mock = new MockDisputeReadAdapter({ "0": { items: [providerDispute] } }, { [providerDispute.id]: providerDispute }, () => Date.parse("2026-10-27T00:00:00Z"));
  assert.equal((await mock.listPage()).origin, "OFFLINE_FIXTURE");
  assert.equal((await mock.retrieve(providerDispute.id)).origin, "OFFLINE_FIXTURE");
  assert.equal(transport.calls.length, 0);
});

test("read-only adapter exposes no mutation method and all transport operations are GET reads", async () => {
  const transport = new FixtureTransport({ "0": { items: [] }, [providerDispute.id]: providerDispute });
  const adapter = live(transport);
  await adapter.listPage();
  await adapter.retrieve(providerDispute.id);
  assert.equal("executeAction" in adapter, false);
  assert.ok(transport.calls.every((call) => call.method === "GET"));
  assert.deepEqual(transport.calls.map((call) => call.operation), ["list", "retrieve"]);
});

test("shared client sensitive reads redact identifiers, query values, response fields and error payloads from logs/traces", async () => {
  const cfg: Config = { clientId: "client-secret-marker", apiKey: "api-secret-marker", base: "https://api.sandbox.airwallex.com", filesBase: "https://files.sandbox.airwallex.com", webhookSecret: "", dryRun: true };
  const client = new AirwallexClient(cfg);
  const logs: string[] = [];
  const oldLog = console.log;
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  try {
    await client.request("GET", `${"/api/v1/pa/payment_disputes"}/dst_sensitive-id`, {
      query: { payment_intent_id: "private-intent-id" }, sensitiveDisputeRead: true,
      mock: { customer_name: "Private Customer", payment_intent_id: "private-intent-id" },
    });
  } finally { console.log = oldLog; }
  const diagnostic = JSON.stringify(client.trace) + logs.join(" ");
  for (const secret of ["dst_sensitive-id", "private-intent-id", "Private Customer", "client-secret-marker", "api-secret-marker"]) assert.equal(diagnostic.includes(secret), false);
  assert.ok(diagnostic.includes("[REDACTED]"));
  await assert.rejects(client.request("POST", "/api/v1/pa/payment_disputes/dst_id", { sensitiveDisputeRead: true }), /restricted to GET/);
  assert.throws(() => new AirwallexDisputeReadTransport(client), { code: "DRY_RUN_CLIENT_CANNOT_BE_PROVIDER_SOURCE" });
});

test("sensitive dispute GET returns first 401/429 without automatic replay", async () => {
  const cfg: Config = { clientId: "offline-client", apiKey: "offline-key", base: "https://api.sandbox.airwallex.com", filesBase: "https://files.sandbox.airwallex.com", webhookSecret: "", dryRun: false };
  const client = new AirwallexClient(cfg);
  const oldFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url.endsWith("/api/v1/authentication/login")) return new Response(JSON.stringify({ token: "offline-bearer", expires_at: new Date(Date.now() + 60_000).toISOString() }), { status: 200 });
    return new Response(JSON.stringify({ code: "denied" }), { status: calls.length === 2 ? 401 : 429 });
  }) as typeof fetch;
  try {
    await assert.rejects(client.request("GET", "/api/v1/pa/payment_disputes", { query: { size: 1 }, sensitiveDisputeRead: true }), (error: unknown) => error instanceof AirwallexError && error.status === 401);
    assert.equal(calls.length, 2, "only the login and one dispute-list GET should be sent");
    assert.equal(calls.filter((call) => call.includes("/api/v1/pa/payment_disputes")).length, 1);
  } finally { globalThis.fetch = oldFetch; }
});

test("a mutation without provider request_id is never replayed on HTTP 429", async () => {
  const cfg: Config = { clientId: "offline-client", apiKey: "offline-key", base: "https://api.sandbox.airwallex.com", filesBase: "https://files.sandbox.airwallex.com", webhookSecret: "", dryRun: false };
  const client = new AirwallexClient(cfg);
  const oldFetch = globalThis.fetch;
  let mutationCalls = 0;
  globalThis.fetch = (async (input: URL | RequestInfo) => {
    if (String(input).endsWith("/api/v1/authentication/login")) return new Response(JSON.stringify({ token: "offline-bearer", expires_at: new Date(Date.now() + 60_000).toISOString() }), { status: 200 });
    mutationCalls++;
    return new Response(JSON.stringify({ code: "throttled" }), { status: 429 });
  }) as typeof fetch;
  try {
    await assert.rejects(client.request("POST", "/api/v1/example/action", { body: { source: "synthetic" } }),
      (error: unknown) => error instanceof AirwallexError && error.status === 429);
    assert.equal(mutationCalls, 1);
  } finally { globalThis.fetch = oldFetch; }
});

const diagnosticConfig: Config = { clientId: "offline-client-secret", apiKey: "offline-api-key-secret", base: "https://api.sandbox.airwallex.com", filesBase: "https://files.sandbox.airwallex.com", webhookSecret: "offline-webhook-secret", dryRun: false };

async function runMockedList(fetchMock: (url: string, init?: RequestInit) => Promise<Response>) {
  const oldFetch = globalThis.fetch;
  const logs: string[] = [];
  const oldLog = { log: console.log, warn: console.warn, error: console.error };
  const calls: string[] = [];
  const client = new AirwallexClient(diagnosticConfig);
  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    return fetchMock(url, init);
  }) as typeof fetch;
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  console.warn = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  console.error = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  try {
    const adapter = createDisputeReadAdapter("LIVE_READONLY", { transport: new AirwallexDisputeReadTransport(client), authorization: {
      explicitlyConfigured: true, approvalReference: "offline-diagnostic-approval", actor: "offline-diagnostic-actor", authorizedAt: Date.now(), expiresAt: Date.now() + 30_000,
    } });
    try { return { page: await adapter.listPage({ size: 1 }), client, calls, logs }; }
    catch (error) { return { error: error as DisputeReadError, client, calls, logs }; }
  } finally {
    globalThis.fetch = oldFetch;
    console.log = oldLog.log; console.warn = oldLog.warn; console.error = oldLog.error;
  }
}

function loginOk(): Response {
  return new Response(JSON.stringify({ token: "offline-access-token-marker", expires_at: new Date(Date.now() + 60 * 60_000).toISOString() }), { status: 201 });
}
function bodyStreamFailure(status: number): Response {
  return new Response(new ReadableStream({ start(controller) { controller.error(new Error("private body stream detail")); } }), { status });
}
function assertDiagnostic(error: DisputeReadError, expected: { stage: string; received: boolean | "unknown"; status?: number; category: string; retries?: number }) {
  assert.deepEqual(error.diagnostic && {
    stage: error.diagnostic.stage, responseReceived: error.diagnostic.responseReceived, httpStatus: error.diagnostic.httpStatus,
    errorCategory: error.diagnostic.errorCategory, retryCount: error.diagnostic.retryCount,
  }, {
    stage: expected.stage, responseReceived: expected.received, httpStatus: expected.status,
    errorCategory: expected.category, retryCount: expected.retries ?? 0,
  });
  assert.ok(Number.isFinite(Date.parse(error.diagnostic!.timestampUtc)));
}

test("diagnostics distinguish auth/get DNS failure and pre-response timeout", async () => {
  for (const [where, expectedStage] of [["AUTH", "AUTH"], ["GET", "GET"]] as const) {
    const dns = await runMockedList(async (url) => {
      if (url.endsWith("/authentication/login") && where === "AUTH" || url.includes("/api/v1/pa/payment_disputes") && where === "GET") throw new TypeError("getaddrinfo ENOTFOUND sensitive.internal");
      return url.endsWith("/authentication/login") ? loginOk() : new Response(JSON.stringify({ items: [] }), { status: 200 });
    });
    assertDiagnostic(dns.error!, { stage: expectedStage, received: false, category: "TRANSPORT_ERROR" });
    const timeout = await runMockedList(async (url) => {
      if (url.endsWith("/authentication/login") && where === "AUTH" || url.includes("/api/v1/pa/payment_disputes") && where === "GET") { const error = new Error("private timeout detail"); error.name = "TimeoutError"; throw error; }
      return url.endsWith("/authentication/login") ? loginOk() : new Response(JSON.stringify({ items: [] }), { status: 200 });
    });
    assertDiagnostic(timeout.error!, { stage: expectedStage, received: false, category: "TIMEOUT" });
  }
});

test("authentication HTTP 401/403 preserve AUTH stage and status without sending GET", async () => {
  for (const status of [401, 403]) {
    const run = await runMockedList(async () => new Response(JSON.stringify({ code: "sensitive-provider-code", message: "customer@example.test" }), { status }));
    assert.equal(run.error?.code, status === 401 ? "UNAUTHORIZED" : "FORBIDDEN");
    assertDiagnostic(run.error!, { stage: "AUTH", received: true, status, category: "HTTP_ERROR" });
    assert.equal(run.calls.length, 1);
    assert.equal(run.client.trace.some((entry) => entry.method === "GET"), false);
  }
});

test("authentication body-read failure records received HTTP 200", async () => {
  const run = await runMockedList(async (url) => url.endsWith("/authentication/login") ? bodyStreamFailure(200) : new Response(JSON.stringify({ items: [] }), { status: 200 }));
  assertDiagnostic(run.error!, { stage: "AUTH", received: true, status: 200, category: "BODY_READ_ERROR" });
  assert.equal(run.calls.length, 1);
});

test("dispute GET HTTP 401/403/429 preserve GET stage and do not retry", async () => {
  for (const status of [401, 403, 429]) {
    const run = await runMockedList(async (url) => url.endsWith("/authentication/login") ? loginOk() : new Response(JSON.stringify({ message: "Private customer body" }), { status }));
    assertDiagnostic(run.error!, { stage: "GET", received: true, status, category: "HTTP_ERROR" });
    assert.equal(run.calls.filter((call) => call.includes("/payment_disputes")).length, 1);
  }
});

test("dispute GET body-read failure records received HTTP 200", async () => {
  const run = await runMockedList(async (url) => url.endsWith("/authentication/login") ? loginOk() : bodyStreamFailure(200));
  assertDiagnostic(run.error!, { stage: "GET", received: true, status: 200, category: "BODY_READ_ERROR" });
});

test("HTTP 200 malformed JSON and schema-invalid data preserve GET or adapter-validation metadata", async () => {
  const malformed = await runMockedList(async (url) => url.endsWith("/authentication/login") ? loginOk() : new Response("not-json customer@example.test", { status: 200 }));
  assert.equal(malformed.error?.code, "MALFORMED_JSON");
  assertDiagnostic(malformed.error!, { stage: "GET", received: true, status: 200, category: "MALFORMED_JSON" });

  const invalidSchema = await runMockedList(async (url) => url.endsWith("/authentication/login") ? loginOk() : new Response(JSON.stringify({ items: [{ id: "private-dispute-id" }] }), { status: 200 }));
  assert.equal(invalidSchema.error?.code, "MALFORMED_DISPUTE_RESPONSE");
  assertDiagnostic(invalidSchema.error!, { stage: "ADAPTER_VALIDATION", received: true, status: 200, category: "ADAPTER_VALIDATION_ERROR" });
});

test("HTTP 200 empty dispute list reports response metadata and remains successful", async () => {
  const run = await runMockedList(async (url) => url.endsWith("/authentication/login") ? loginOk() : new Response(JSON.stringify({ items: [] }), { status: 200 }));
  assert.deepEqual(run.page?.items, []);
  const getTrace = run.client.trace.find((entry) => entry.method === "GET")!;
  assert.equal(getTrace.response_received, true);
  assert.equal(getTrace.status, 200);
  assert.equal(getTrace.diagnostic?.stage, "GET");
});

test("error wrapping and diagnostics do not retain credentials, tokens, URLs with query, or customer data", async () => {
  const run = await runMockedList(async (url) => url.endsWith("/authentication/login") ? loginOk() : new Response(JSON.stringify({ customer_name: "Private Customer", email: "customer@example.test", secret: "raw-provider-secret" }), { status: 500 }));
  const diagnostic = JSON.stringify({ error: run.error, trace: run.client.trace, logs: run.logs });
  for (const secret of ["offline-client-secret", "offline-api-key-secret", "offline-webhook-secret", "offline-access-token-marker", "Private Customer", "customer@example.test", "raw-provider-secret", "sensitive-provider-code"]) assert.equal(diagnostic.includes(secret), false);
  assert.equal(run.error?.diagnostic?.stage, "GET");
  assert.equal(run.error?.diagnostic?.httpStatus, 500);
  assert.ok(run.error?.diagnostic?.timestampUtc);
  assert.ok(!JSON.stringify(run.client.trace).includes("?size=1"));
});

test("real transport uses only the established client GET endpoints and refuses writes", async () => {
  const calls: Array<{ method: string; path: string; options?: unknown }> = [];
  const fakeClient = {
    cfg: { dryRun: false },
    async request(method: string, path: string, options?: unknown) {
      calls.push({ method, path, options });
      return path.endsWith("payment_disputes") ? { items: [] } : providerDispute;
    },
  } as unknown as AirwallexClient;
  const transport = new AirwallexDisputeReadTransport(fakeClient);
  await transport.listPage({ paymentIntentId: "private-intent" });
  await transport.retrieve(providerDispute.id);
  assert.deepEqual(calls.map(({ method, path }) => [method, path]), [
    ["GET", "/api/v1/pa/payment_disputes"], ["GET", `/api/v1/pa/payment_disputes/${providerDispute.id}`],
  ]);
  assert.ok(calls.every(({ options }) => (options as { sensitiveDisputeRead?: boolean }).sensitiveDisputeRead === true));
  assert.throws(() => new AirwallexDisputeReadTransport({ cfg: { dryRun: true } } as unknown as AirwallexClient), { code: "DRY_RUN_CLIENT_CANNOT_BE_PROVIDER_SOURCE" });
});
