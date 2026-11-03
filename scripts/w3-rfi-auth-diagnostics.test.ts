import assert from "node:assert/strict";
import test from "node:test";
import { AirwallexClient, AirwallexError, DEFAULT_BASE, DEFAULT_FILES_BASE, type Config } from "../src/airwallex.ts";
import { safeSnapshotConfiguration, safeSnapshotFailureDiagnostic } from "./w3-rfi-provider-snapshot.ts";

const secrets = { clientId: "synthetic-client-id-secret", apiKey: "synthetic-api-key-secret", token: "synthetic-access-token-secret" };
const config: Config = { ...secrets, base: DEFAULT_BASE, filesBase: DEFAULT_FILES_BASE, webhookSecret: "synthetic-webhook-secret", dryRun: false };
type FetchResult = { error?: Error; response?: Response };

async function attemptLogin(result: FetchResult) {
  const oldFetch = globalThis.fetch;
  const oldLog = { log: console.log, warn: console.warn, error: console.error };
  const logs: string[] = [];
  const calls: Array<{ url: string; method?: string }> = [];
  const client = new AirwallexClient(config);
  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method });
    if (result.error) throw result.error;
    return result.response!;
  }) as typeof fetch;
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  console.warn = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  console.error = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  try {
    let failure: unknown;
    try { await client.login(false, true); } catch (error) { failure = error; }
    return { client, calls, logs, failure };
  } finally {
    globalThis.fetch = oldFetch;
    console.log = oldLog.log; console.warn = oldLog.warn; console.error = oldLog.error;
  }
}

const metadata = (error: unknown) => safeSnapshotFailureDiagnostic(error, { authenticationAttempts: 1, disputeGetAttempts: 0 });

test("authentication transport failure preserves safe AUTH diagnostics and one attempt", async () => {
  const run = await attemptLogin({ error: new TypeError(`transport leaked ${secrets.apiKey} ${secrets.token}`) });
  assert.ok(run.failure instanceof AirwallexError);
  assert.deepEqual(metadata(run.failure), { stage: "AUTH", responseReceived: false, httpStatus: null,
    errorCategory: "TRANSPORT_ERROR", retryCount: 0, authenticationAttemptCount: 1, disputeGetAttemptCount: 0, mutationCount: 0 });
  assert.equal(run.calls.length, 1);
  assert.equal(new URL(run.calls[0]!.url).origin, DEFAULT_BASE);
  assert.equal(new URL(run.calls[0]!.url).pathname, "/api/v1/authentication/login");
  const safe = JSON.stringify({ diagnostic: metadata(run.failure), logs: run.logs, trace: run.client.trace });
  for (const secret of Object.values(secrets)) assert.equal(safe.includes(secret), false);
});

test("authentication timeout is distinct from transport failure", async () => {
  const error = new Error(`timeout leaked ${secrets.apiKey}`); error.name = "TimeoutError";
  const run = await attemptLogin({ error });
  assert.ok(run.failure instanceof AirwallexError);
  assert.deepEqual(metadata(run.failure), { stage: "AUTH", responseReceived: false, httpStatus: null,
    errorCategory: "TIMEOUT", retryCount: 0, authenticationAttemptCount: 1, disputeGetAttemptCount: 0, mutationCount: 0 });
  assert.equal(run.calls.length, 1);
});

test("authentication 401 and 403 preserve received status without retry", async () => {
  for (const status of [401, 403]) {
    const run = await attemptLogin({ response: new Response(JSON.stringify({ message: `private ${secrets.apiKey}` }), { status }) });
    assert.ok(run.failure instanceof AirwallexError);
    assert.deepEqual(metadata(run.failure), { stage: "AUTH", responseReceived: true, httpStatus: status,
      errorCategory: "HTTP_ERROR", retryCount: 0, authenticationAttemptCount: 1, disputeGetAttemptCount: 0, mutationCount: 0 });
    assert.equal(run.calls.length, 1);
    assert.equal(run.client.trace.some((entry) => entry.method === "GET"), false);
  }
});

test("malformed authentication JSON and schema fail closed with distinct safe categories", async () => {
  const malformedJson = await attemptLogin({ response: new Response(`not-json ${secrets.token}`, { status: 200 }) });
  assert.ok(malformedJson.failure instanceof AirwallexError);
  assert.deepEqual(metadata(malformedJson.failure), { stage: "AUTH", responseReceived: true, httpStatus: 200,
    errorCategory: "MALFORMED_JSON", retryCount: 0, authenticationAttemptCount: 1, disputeGetAttemptCount: 0, mutationCount: 0 });
  const malformedSchema = await attemptLogin({ response: new Response(JSON.stringify({ access_token: secrets.token }), { status: 200 }) });
  assert.ok(malformedSchema.failure instanceof AirwallexError);
  assert.deepEqual(metadata(malformedSchema.failure), { stage: "AUTH", responseReceived: true, httpStatus: 200,
    errorCategory: "AUTH_RESPONSE_INVALID", retryCount: 0, authenticationAttemptCount: 1, disputeGetAttemptCount: 0, mutationCount: 0 });
  for (const run of [malformedJson, malformedSchema]) {
    const safe = JSON.stringify({ diagnostic: metadata(run.failure), logs: run.logs, trace: run.client.trace });
    for (const secret of Object.values(secrets)) assert.equal(safe.includes(secret), false);
  }
});

test("successful authentication emits safe status metadata but never token or configuration values", async () => {
  const run = await attemptLogin({ response: new Response(JSON.stringify({ token: secrets.token,
    expires_at: new Date(Date.now() + 60_000).toISOString() }), { status: 200 }) });
  assert.equal(run.failure, undefined);
  assert.equal(run.calls.length, 1);
  assert.equal(run.client.trace[0]?.status, 200);
  assert.equal(run.client.trace[0]?.diagnostic?.stage, "AUTH");
  assert.equal(run.client.trace[0]?.diagnostic?.responseReceived, true);
  const safe = JSON.stringify({ logs: run.logs, trace: run.client.trace });
  for (const secret of Object.values(secrets)) assert.equal(safe.includes(secret), false);
});

test("runtime configuration summary verifies sandbox/source policy without exposing values", () => {
  const summary = safeSnapshotConfiguration(config);
  assert.equal(summary.environment, "AIRWALLEX_SANDBOX");
  assert.equal(summary.originValidated, true);
  assert.equal(summary.sourcePolicy, "process environment > .env.local > .env; AIRWALLEX_BASE defaults to exact sandbox origin");
  assert.equal(summary.credentialsOrConfigurationValuesIncluded, false);
  const serialized = JSON.stringify(summary);
  for (const secret of Object.values(secrets)) assert.equal(serialized.includes(secret), false);
  const unsafeException = new Error(`never serialize ${secrets.apiKey} or ${secrets.token}`);
  const safeFailure = JSON.stringify(safeSnapshotFailureDiagnostic(unsafeException, { authenticationAttempts: 0, disputeGetAttempts: 0 }));
  for (const secret of Object.values(secrets)) assert.equal(safeFailure.includes(secret), false);
});

test("authorized refresh performs one authenticated dispute GET without relogin or replay", async () => {
  const oldFetch = globalThis.fetch;
  const calls: Array<{ url: string; method?: string }> = [];
  const client = new AirwallexClient(config);
  let getDispatches = 0;
  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method });
    if (calls.length === 1) return new Response(JSON.stringify({ token: secrets.token,
      expires_at: new Date(Date.now() + 20 * 60_000).toISOString() }), { status: 200 });
    return new Response(JSON.stringify({ id: "private-dispute-id", status: "REQUIRES_RESPONSE" }), { status: 200 });
  }) as typeof fetch;
  try {
    await client.login(false, true);
    const result = await client.request<{ status: string }>("GET", "/api/v1/pa/payment_disputes/private-dispute-id", {
      sensitiveDisputeRead: true, retry: false, existingAuthenticationOnly: true,
      onRequestAttempt: () => { getDispatches++; },
    });
    assert.equal(result.status, "REQUIRES_RESPONSE");
    assert.equal(getDispatches, 1);
    assert.deepEqual(calls.map((call) => call.method), ["POST", "GET"]);
    assert.equal(calls.filter((call) => call.method === "POST").length, 1);
    assert.equal(calls.filter((call) => call.method === "GET").length, 1);
    assert.equal(client.trace.length, 2);
    assert.equal(JSON.stringify(client.trace).includes("private-dispute-id"), false);
    for (const secret of Object.values(secrets)) assert.equal(JSON.stringify(client.trace).includes(secret), false);
  } finally { globalThis.fetch = oldFetch; }
});

test("expired authentication refuses the dispute GET without a second login", async () => {
  const oldFetch = globalThis.fetch;
  const calls: Array<{ url: string; method?: string }> = [];
  const client = new AirwallexClient(config);
  let getDispatches = 0;
  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method });
    return new Response(JSON.stringify({ token: secrets.token,
      expires_at: new Date(Date.now() + 60_000).toISOString() }), { status: 200 });
  }) as typeof fetch;
  try {
    await client.login(false, true);
    await assert.rejects(client.request("GET", "/api/v1/pa/payment_disputes/private-dispute-id", {
      sensitiveDisputeRead: true, retry: false, existingAuthenticationOnly: true,
      onRequestAttempt: () => { getDispatches++; },
    }), /EXISTING_AUTHENTICATION_REQUIRED/);
    assert.equal(getDispatches, 0);
    assert.deepEqual(calls.map((call) => call.method), ["POST"]);
    assert.equal(calls.filter((call) => call.method === "POST").length, 1);
    assert.equal(calls.filter((call) => call.method === "GET").length, 0);
  } finally { globalThis.fetch = oldFetch; }
});
