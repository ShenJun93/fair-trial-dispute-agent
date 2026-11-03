import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { AirwallexClient, AirwallexError, redact, type Config } from "../src/airwallex.ts";
import { createHppHandler, HppRateLimiter } from "../spike/hpp-server.ts";
import { HPP_AMOUNT, HppGate, HppGateError, HppService } from "../spike/hpp.ts";

const checkoutKey = "synthetic-test-checkout-key";
const operatorToken = "synthetic-operator-token-which-is-long-enough-123456";
const cfg: Config = {
  clientId: "synthetic-client-id", apiKey: "synthetic-api-key",
  base: "https://api.sandbox.airwallex.com", filesBase: "https://files.sandbox.airwallex.com",
  webhookSecret: "synthetic-webhook-secret", dryRun: false,
};

test("authentication errors remain typed and redact credentials", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ code: "unauthorized", message: "synthetic failure" }), { status: 401 });
  try {
    const client = new AirwallexClient(cfg);
    await assert.rejects(client.login(), (error: unknown) => {
      assert.ok(error instanceof AirwallexError);
      assert.equal(error.status, 401);
      assert.doesNotMatch(JSON.stringify(error.toJSON()), /synthetic-api-key|synthetic-client-id/);
      return true;
    });
  } finally { globalThis.fetch = original; }
});

test("PaymentIntent creation errors are handled without exposing API details", async () => {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input); calls.push(url);
    if (url.endsWith("/authentication/login")) return new Response(JSON.stringify({ token: "synthetic-bearer-token", expires_at: "2099-01-01T00:00:00Z" }), { status: 201 });
    return new Response(JSON.stringify({ code: "configuration_error", message: "synthetic account error" }), { status: 400 });
  };
  try {
    const service = HppService.fromClient(new AirwallexClient(cfg));
    await assert.rejects(service.create(checkoutKey, "order-1"), (error: unknown) => error instanceof AirwallexError && error.status === 400);
    assert.equal(calls.length, 2);
  } finally { globalThis.fetch = original; }
});

for (const providerStatus of [401, 429]) {
  test(`sensitive W1 PaymentIntent GET returns HTTP ${providerStatus} without retry`, async () => {
    const original = globalThis.fetch;
    let authCalls = 0, getCalls = 0;
    globalThis.fetch = async (input) => {
      if (String(input).endsWith("/authentication/login")) {
        authCalls++;
        return new Response(JSON.stringify({ token: "synthetic-bearer-token", expires_at: "2099-01-01T00:00:00Z" }), { status: 201 });
      }
      getCalls++;
      return new Response(JSON.stringify({ code: "synthetic_error" }), { status: providerStatus });
    };
    try {
      const client = new AirwallexClient(cfg);
      await assert.rejects(client.request("GET", "/api/v1/pa/payment_intents/int_synthetic", {
        retry: false, sensitivePaymentIntentRead: true,
      }), (error: unknown) => error instanceof AirwallexError && error.status === providerStatus);
      assert.equal(authCalls, 1);
      assert.equal(getCalls, 1, "provider error must not trigger an automatic second read");
    } finally { globalThis.fetch = original; }
  });
}

test("HPP SDK uses the documented demo env and only required browser payment fields", async () => {
  const html = await readFile(new URL("../spike/hpp-server.ts", import.meta.url), "utf8");
  assert.match(html, /env:'demo',enabledElements:\['payments'\]/);
  assert.match(html, /paymentsApi\.redirectToCheckout\(/);
  assert.match(html, /redirectToCheckout\(\{env:'demo'/);
  assert.match(html, /intent_id:intent\.id,client_secret:intent\.client_secret,currency:intent\.currency/);
  assert.match(html, /successUrl:intent\.successUrl/);
  assert.match(html, /https:\/\/static\.airwallex\.com\/components\/sdk\/v1\/index\.js/);
  assert.match(html, /id="pay" disabled/);
  assert.match(html, /if\(payButton\.disabled\|\|!paymentsApi\|\|typeof paymentsApi\.redirectToCheckout!=='function'\|\|sdkFailed\)return/);
});

test("HPP CSP uses nonce-bound inline code and narrow Airwallex sources with negative origin checks", async () => {
  await withHttpGate(async ({ call }) => {
    const page = await call("/");
    const csp = page.headers["content-security-policy"]!;
    assert.match(csp, /script-src 'self' 'nonce-[A-Za-z0-9+/]+=*' https:\/\/static\.airwallex\.com https:\/\/checkout\.airwallex\.com https:\/\/static-demo\.airwallex\.com https:\/\/checkout-demo\.airwallex\.com/);
    assert.match(csp, /style-src 'self' 'nonce-[A-Za-z0-9+/]+=*'/);
    assert.match(csp, /connect-src 'self'/);
    assert.match(csp, /frame-src https:\/\/checkout\.airwallex\.com https:\/\/checkout-demo\.airwallex\.com/);
    assert.match(csp, /form-action 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /object-src 'none'/);
    assert.match(csp, /base-uri 'none'/);
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|https:\/\/\*\.airwallex\.com|o11y-demo/);
    const nonce = csp.match(/'nonce-([^']+)'/)?.[1];
    assert.ok(nonce);
    assert.ok(page.body.includes(`<script nonce="${nonce}">`));
    assert.ok(page.body.includes(`<style nonce="${nonce}">`));
  });
});

test("HPP rejects a mismatched Host header before serving UI or session APIs", async () => {
  await withHttpGate(async ({ call }) => {
    const page = await call("/", { headers: { host: "attacker.example.test" } });
    assert.equal(page.status, 400);
    assert.equal(JSON.parse(page.body).error, "invalid_host");
    const session = await call("/api/session", { headers: { host: "attacker.example.test" } });
    assert.equal(session.status, 400);
    assert.equal(JSON.parse(session.body).error, "invalid_host");
  });
});

test("SDK initialization failure leaves checkout disabled and makes zero PaymentIntent requests", async () => {
  const browser = await browserCheckoutHarness(undefined);
  assert.equal(browser.elements.get("pay")?.disabled, true);
  await browser.elements.get("pay")?.onclick?.();
  assert.equal(browser.getCreateRequests(), 0);
  assert.equal(browser.calls.some((call) => call.url === "/api/checkout" && call.method === "POST"), false);
  assert.match(String(browser.elements.get("status")?.textContent), /No PaymentIntent request was sent/);
});

test("SDK success initializes once and redirects only after W1 handoff returns the existing intent", async () => {
  const initConfigs: unknown[] = [], redirectOptions: unknown[] = [];
  const sdk = { init: async (config: unknown) => { initConfigs.push(config); return { payments: { redirectToCheckout: async (options: unknown) => { redirectOptions.push(options); } } }; } };
  const currentBrowser = await browserCheckoutHarness(sdk);
  assert.equal(currentBrowser.elements.get("pay")?.disabled, false);
  await currentBrowser.elements.get("pay")?.onclick?.();
  assert.equal(currentBrowser.getCreateRequests(), 0);
  assert.equal(currentBrowser.getW1HandoffRequests(), 1);
  assert.deepEqual(JSON.parse(JSON.stringify(initConfigs)), [{ env: "demo", enabledElements: ["payments"] }]);
  assert.deepEqual(JSON.parse(JSON.stringify(redirectOptions)), [{ env: "demo", mode: "payment", intent_id: "int_offline", client_secret: "secret_offline", currency: "USD", successUrl: "https://checkout.example.test/#state=state" }]);
});

test("SDK initialization timeout and missing redirect method cause zero PaymentIntent requests", async () => {
  const timeout = await browserCheckoutHarness({ init: () => new Promise(() => {}) }, { immediateSdkTimeout: true });
  assert.equal(timeout.elements.get("pay")?.disabled, true);
  await timeout.elements.get("pay")?.onclick?.();
  assert.equal(timeout.getCreateRequests(), 0);

  const missingRedirect = await browserCheckoutHarness({ init: async () => ({ payments: {} }) });
  assert.equal(missingRedirect.elements.get("pay")?.disabled, true);
  await missingRedirect.elements.get("pay")?.onclick?.();
  assert.equal(missingRedirect.getCreateRequests(), 0);
});

test("repeated checkout clicks share one request and SDK initialization is not repeated", async () => {
  let initCount = 0;
  const sdk = { init: async () => { initCount++; return { payments: { redirectToCheckout: () => {} } }; } };
  const browser = await browserCheckoutHarness(sdk, { holdCreate: true });
  const click = browser.elements.get("pay")?.onclick;
  assert.ok(click);
  const first = click();
  const second = click();
  assert.equal(browser.getW1HandoffRequests(), 1);
  browser.getReleaseCreate()?.();
  await Promise.all([first, second]);
  assert.equal(initCount, 1);
  assert.equal(browser.getW1HandoffRequests(), 1);
});

test("create uses major currency units and rejects request, order, amount or currency mismatch", async () => {
  const seen: Record<string, unknown>[] = [];
  const service = new HppService(async (_method, _path, options) => {
    const body = options?.body ?? {}; seen.push(body);
    return { id: "int_test_123", client_secret: "synthetic-client-secret-value", ...body };
  });
  const intent = await service.create(checkoutKey, "fair-trial-order-1");
  assert.equal(seen[0]?.amount, 1);
  assert.equal(seen[0]?.currency, "USD");
  assert.deepEqual(Object.keys(intent).sort(), ["amount", "client_secret", "currency", "descriptor", "id", "merchant_order_id", "request_id"].sort());
  for (const mismatch of [{ request_id: "other" }, { merchant_order_id: "other" }, { amount: 100 }, { currency: "EUR" }]) {
    const bad = new HppService(async () => ({ id: "int_test_123", client_secret: "secret", request_id: checkoutKey, merchant_order_id: "fair-trial-order-1", amount: 1, currency: "USD", ...mismatch }));
    await assert.rejects(bad.create(checkoutKey, "fair-trial-order-1"), /mismatch/);
  }
});

test("ambiguous timeout retries the same request ID and does not start another intent", async () => {
  const requestIds: unknown[] = []; let calls = 0;
  const service = new HppService(async (_method, _path, options) => {
    requestIds.push(options?.body?.request_id); calls++;
    if (calls === 1) throw new TypeError("synthetic timeout after possible server acceptance");
    return { id: "int_retry_123", client_secret: "synthetic-client-secret-value", request_id: checkoutKey, merchant_order_id: "fair-trial-order", amount: HPP_AMOUNT, currency: "USD" };
  });
  await assert.rejects(service.create(checkoutKey, "fair-trial-order"));
  assert.equal((await service.create(checkoutKey, "fair-trial-order")).id, "int_retry_123");
  assert.equal(calls, 2); assert.deepEqual(requestIds, [checkoutKey, checkoutKey]);
});

test("PaymentIntent status requires exact five-field identity before recognizing provider state", async () => {
  let response: unknown = { id: "int_test_123", request_id: "request-1", amount: 1, currency: "USD", merchant_order_id: "order-1", status: "PENDING" };
  const expected = { amount: 1, currency: "USD", merchantOrderId: "order-1", requestId: "request-1" };
  const service = new HppService(async () => response);
  for (const known of ["REQUIRES_PAYMENT_METHOD", "REQUIRES_CUSTOMER_ACTION", "PENDING", "PENDING_REVIEW", "REQUIRES_CAPTURE", "CANCELLED"]) {
    response = { ...(response as Record<string, unknown>), status: known }; const result = await service.status("int_test_123", expected);
    assert.equal(result.status, known); assert.equal(result.succeeded, false);
  }
  response = { ...(response as Record<string, unknown>), status: "SUCCEEDED" };
  assert.deepEqual(await service.status("int_test_123", expected), { id: "int_test_123", status: "SUCCEEDED", succeeded: true, stateKnown: true });
  const identityMismatches: Array<Record<string, unknown>> = [
    { request_id: "other-request" }, { request_id: undefined }, { request_id: null }, { request_id: 1 },
    { id: "int_other_123" }, { id: undefined }, { merchant_order_id: "other-order" }, { merchant_order_id: null },
    { amount: 1.01 }, { amount: "1" }, { currency: "EUR" }, { currency: null },
  ];
  for (const mismatch of identityMismatches) {
    response = { id: "int_test_123", request_id: "request-1", amount: 1, currency: "USD", merchant_order_id: "order-1", status: "SUCCEEDED", ...mismatch };
    assert.deepEqual(await service.status("int_test_123", expected), { id: "int_test_123", status: "UNKNOWN", succeeded: false, stateKnown: false }, JSON.stringify(mismatch));
  }
  for (const malformed of [null, [], "not-an-object"]) {
    response = malformed;
    assert.deepEqual(await service.status("int_test_123", expected), { id: "int_test_123", status: "UNKNOWN", succeeded: false, stateKnown: false });
  }
  response = { id: "int_test_123", request_id: "request-1", amount: 1, currency: "USD", merchant_order_id: "order-1", status: "PENDING" };
  const pending = await service.status("int_test_123", expected);
  assert.deepEqual(pending, { id: "int_test_123", status: "PENDING", succeeded: false, stateKnown: true });
  for (const unsupported of ["FAILED", "EXPIRED", "UNRECOGNIZED"]) {
    response = { ...(response as Record<string, unknown>), status: unsupported };
    assert.deepEqual(await service.status("int_test_123", expected), { id: "int_test_123", status: "UNKNOWN", succeeded: false, stateKnown: false });
  }
});

test("operator sessions, CSRF, return replay and expiry are bound", async () => {
  let now = 1000; let persisted = "";
  const gate = new HppGate(operatorToken, undefined, async (state) => { persisted = JSON.stringify(state); }, () => now);
  await assert.rejects(gate.createSession("wrong"), (e: unknown) => e instanceof HppGateError && e.code === "unauthorized");
  const a = await gate.createSession(operatorToken); const b = await gate.createSession(operatorToken);
  const ah = gate.authenticate(a.sessionToken); const bh = gate.authenticate(b.sessionToken);
  assert.equal(gate.csrfValid(ah, a.csrfToken), true); assert.equal(gate.csrfValid(ah, b.csrfToken), false);
  const { checkout, attempt } = await gate.reserveCheckout(ah);
  await assert.rejects(gate.reserveCheckout(bh), (e: unknown) => e instanceof HppGateError && e.code === "active_order_owned_by_other_session");
  await gate.attachIntent(ah, "int_test_123");
  const launch = await gate.claimLaunch(ah); assert.equal(launch.claimed, true);
  assert.equal((await gate.claimLaunch(ah)).claimed, false);
  await gate.consumeReturn(ah, launch.state);
  await assert.rejects(gate.consumeReturn(ah, launch.state));
  const expiring = await gate.claimLaunch(ah);
  for (const secret of [a.sessionToken, a.csrfToken, b.sessionToken, expiring.state!]) assert.equal(persisted.includes(secret), false);
  const restored = new HppGate(operatorToken, JSON.parse(persisted), async () => {}, () => now);
  assert.equal(restored.authenticate(a.sessionToken), ah);
  assert.equal(restored.checkoutForSession(ah).checkout.orderId, checkout.orderId);
  now += 61 * 60_000;
  assert.throws(() => gate.authenticate(a.sessionToken), (e: unknown) => e instanceof HppGateError && e.code === "unauthorized");
  await assert.rejects(gate.consumeReturn(ah, expiring.state));
});

type OfflineCall = (path: string, options?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ status: number; headers: Record<string, string>; body: string }>;

async function withHttpGate<T>(fn: (ctx: { call: OfflineCall; gate: HppGate; setApiStatus: (status: string) => void; setReadbackRequestId: (id: string) => void }) => Promise<T>, flags: { w1Only?: boolean } = {}): Promise<T> {
  const gate = new HppGate(operatorToken); let orderId = ""; let requestId = ""; let readbackRequestId: string | undefined; let apiStatus = "REQUIRES_PAYMENT_METHOD";
  const service = new HppService(async (method, _path, options) => {
    if (method === "POST") {
      assert.equal(gate.state.checkout?.attempts.at(-1)?.dispatchPhase, "DISPATCHED", "dispatch journal must commit before POST leaves the process");
      const body = options?.body ?? {}; orderId = String(body.merchant_order_id); requestId = String(body.request_id); apiStatus = "REQUIRES_PAYMENT_METHOD"; await new Promise((resolve) => setTimeout(resolve, 20));
      return { id: "int_test_123", client_secret: "synthetic-client-secret-value", ...body, status: "REQUIRES_PAYMENT_METHOD" };
    }
    return { id: "int_test_123", request_id: readbackRequestId ?? requestId, amount: 1, currency: "USD", merchant_order_id: orderId, status: apiStatus };
  });
  const bootstrap = "synthetic-bootstrap-csrf-token-12345678901234567890";
  const handler = createHppHandler({ gate, service, publicOrigin: "https://checkout.example.test", ...flags }, bootstrap);
  const call: OfflineCall = async (path, options = {}) => {
    const req = Readable.from(options.body === undefined ? [] : [Buffer.from(options.body)]) as unknown as IncomingMessage;
    const requestHeaders = Object.fromEntries(Object.entries(options.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    requestHeaders.host ??= "checkout.example.test";
    Object.assign(req, { method: options.method ?? "GET", url: path, headers: requestHeaders });
    let status = 0; const headers: Record<string, string> = {}; let body = "";
    const res = { writeHead(code: number, fields: Record<string, string> = {}) { status = code; Object.assign(headers, fields); return this; }, end(content?: string) { body = String(content ?? ""); } } as unknown as ServerResponse;
    await handler(req, res);
    return { status, headers, body };
  };
  return fn({ call, gate, setApiStatus: (status) => { apiStatus = status; }, setReadbackRequestId: (id) => { readbackRequestId = id; } });
}

async function authorize(call: OfflineCall): Promise<{ cookie: string; csrf: string }> {
  const login = await call("/api/session", { method: "POST", headers: { origin: "https://checkout.example.test", "content-type": "application/json", "x-csrf-token": "synthetic-bootstrap-csrf-token-12345678901234567890" }, body: JSON.stringify({ operatorToken }) });
  assert.equal(login.status, 200); const cookie = login.headers["set-cookie"]!.split(";")[0]!;
  assert.match(login.headers["set-cookie"]!, /HttpOnly; Secure; SameSite=Lax; Path=\//);
  const session = await call("/api/session", { headers: { cookie } });
  return { cookie, csrf: (JSON.parse(session.body) as { csrfToken: string }).csrfToken };
}

async function browserCheckoutHarness(sdk: unknown, options: { immediateSdkTimeout?: boolean; holdCreate?: boolean } = {}) {
  return withHttpGate(async ({ call }) => {
    const page = await call("/");
    assert.equal(page.status, 200);
    const inlineScripts = [...page.body.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)];
    const browserScript = inlineScripts.at(-1)?.[1];
    assert.ok(browserScript, "served page has its checkout controller script");
    const elements = new Map<string, { disabled?: boolean; hidden?: boolean; value?: string; textContent?: string; onclick?: (...args: unknown[]) => unknown }>();
    for (const id of ["status", "login", "checkout", "pay", "authorize", "operator", "recheck"]) elements.set(id, {});
    elements.get("pay")!.disabled = true;
    elements.get("operator")!.value = "synthetic-operator-token";
    const calls: Array<{ url: string; method: string }> = [];
    const initConfigs: unknown[] = [];
    const redirectOptions: unknown[] = [];
    let createRequests = 0, w1HandoffRequests = 0;
    let releaseCreate: (() => void) | undefined;
    const mockFetch = async (url: string, init: { method?: string } = {}) => {
      const method = init.method ?? "GET";
      calls.push({ url, method });
      if (url === "/api/session" && method === "GET") return { ok: true, status: 200, json: async () => ({ csrfToken: "synthetic-csrf-token" }) };
      if (url === "/api/checkout" && method === "GET") return { ok: true, status: 200, json: async () => ({ status: "NOT_CREATED", message: "not created" }) };
      if (url === "/api/checkout/w1-handoff" && method === "POST") {
        w1HandoffRequests++;
        const response = { ok: true, status: 200, json: async () => ({ id: "int_offline", client_secret: "secret_offline", currency: "USD", successUrl: "https://checkout.example.test/#state=state" }) };
        if (options.holdCreate) return new Promise<typeof response>((resolve) => { releaseCreate = () => resolve(response); });
        return response;
      }
      throw new Error(`unexpected offline browser request ${method} ${url}`);
    };
    const context = {
      document: { getElementById: (id: string) => elements.get(id) },
      window: { AirwallexComponentsSDK: sdk },
      location: { origin: "https://checkout.example.test", href: "https://checkout.example.test/" },
      history: { replaceState: () => {} }, fetch: mockFetch, URL, URLSearchParams, Promise,
      queueMicrotask,
      setTimeout: (callback: () => void, ms: number) => options.immediateSdkTimeout && ms === 8000 ? (queueMicrotask(callback), 1 as unknown as NodeJS.Timeout) : setTimeout(callback, ms),
      clearTimeout: (timer: NodeJS.Timeout) => { if (!(options.immediateSdkTimeout && timer === (1 as unknown as NodeJS.Timeout))) clearTimeout(timer); },
      console: { log: () => {}, warn: () => {}, error: () => {} },
    };
    runInNewContext(browserScript, context);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await Promise.resolve(); await Promise.resolve();
    return { elements, calls, initConfigs, redirectOptions, getCreateRequests: () => createRequests,
      getW1HandoffRequests: () => w1HandoffRequests, getReleaseCreate: () => releaseCreate };
  });
}

test("HTTP layer rejects unauthorized requests, missing Origin/CSRF, wrong content type and oversized body", async () => {
  await withHttpGate(async ({ call, setApiStatus }) => {
    assert.equal((await call("/api/session")).status, 401);
    const { cookie, csrf } = await authorize(call); const body = "{}";
    assert.equal((await call("/api/checkout", { method: "POST", headers: { cookie, "content-type": "application/json", "x-csrf-token": csrf }, body })).status, 403);
    assert.equal((await call("/api/checkout", { method: "POST", headers: { cookie, origin: "https://evil.test", "content-type": "application/json", "x-csrf-token": csrf }, body })).status, 403);
    assert.equal((await call("/api/checkout", { method: "POST", headers: { cookie, origin: "https://checkout.example.test", "content-type": "text/plain", "x-csrf-token": csrf }, body })).status, 403);
    assert.equal((await call("/api/checkout", { method: "POST", headers: { cookie, origin: "https://checkout.example.test", "content-type": "application/json", "x-csrf-token": csrf }, body: "x".repeat(3000) })).status, 413);
  });
});

test("HTTP checkout fails closed when verified status has a mismatched request_id", async () => {
  await withHttpGate(async ({ call, gate, setReadbackRequestId }) => {
    const owner = await authorize(call);
    setReadbackRequestId("different-request-id");
    const response = await call("/api/checkout", { method: "POST", headers: { cookie: owner.cookie, origin: "https://checkout.example.test", "content-type": "application/json", "x-csrf-token": owner.csrf }, body: "{}" });
    assert.equal(response.status, 409);
    assert.deepEqual(JSON.parse(response.body), { error: "checkout_not_ready" });
    const attempt = gate.state.checkout?.attempts.at(-1);
    assert.equal(attempt?.status, "UNKNOWN");
    assert.equal(attempt?.returnStateHash, undefined, "no browser launch state is issued for an unverified intent");
    assert.doesNotMatch(response.body, /client_secret|int_test_123|different-request-id/);
  });
});

test("production W1-only checkout refuses legacy create even before the W1 journal exists", async () => {
  await withHttpGate(async ({ call }) => {
    const page = await call("/");
    assert.equal(page.status, 200, "the HPP page does not require a W1 journal");
    assert.match(page.body, /sdk\.init\(\{env:'demo',enabledElements:\['payments'\]\}\)/);
    assert.match(page.body, /no verified W1 PaymentIntent is available\. HPP will not create one/);
    const owner = await authorize(call);
    const status = await call("/api/checkout", { headers:{ cookie:owner.cookie } });
    assert.equal(status.status, 404, "no journal means there is no verified intent to hand off");
    const response = await call("/api/checkout", { method:"POST", headers:{ cookie:owner.cookie, origin:"https://checkout.example.test", "content-type":"application/json", "x-csrf-token":owner.csrf }, body:"{}" });
    assert.equal(response.status,409);
    assert.deepEqual(JSON.parse(response.body), { error:"w1_handoff_required" });
  }, { w1Only:true });
});

test("concurrent tabs share one active checkout; return state is one-use and URL contains no intent ID", async () => {
  await withHttpGate(async ({ call, gate, setApiStatus }) => {
    const { cookie, csrf } = await authorize(call);
    const options = { method: "POST", headers: { cookie, origin: "https://checkout.example.test", "content-type": "application/json", "x-csrf-token": csrf }, body: "{}" };
    const [a, b] = await Promise.all([call("/api/checkout", options), call("/api/checkout", options)]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    const response = a.status === 200 ? a : b; const launch = JSON.parse(response.body) as Record<string, unknown>;
    assert.deepEqual(Object.keys(launch).sort(), ["client_secret", "currency", "id", "successUrl"].sort());
    assert.equal(launch.currency, "USD");
    assert.match(String(launch.successUrl), /^https:\/\/checkout\.example\.test\/#state=[A-Za-z0-9_-]+$/);
    assert.doesNotMatch(String(launch.successUrl), /int_test_123|client_secret|session/i);
    const u = new URL(String(launch.successUrl));
    const state = new URLSearchParams(u.hash.slice(1)).get("state")!;
    setApiStatus("REQUIRES_CUSTOMER_ACTION");
    const callbackHeaders = { cookie, origin: "https://checkout.example.test", "content-type": "application/json", "x-csrf-token": csrf };
    const callback = await call("/api/checkout/return", { method: "POST", headers: callbackHeaders, body: JSON.stringify({ state }) });
    assert.equal(callback.status, 200);
    assert.equal((await call("/api/checkout/return", { method: "POST", headers: callbackHeaders, body: JSON.stringify({ state }) })).status, 400);
    assert.equal((JSON.parse((await call("/api/checkout", { headers: { cookie } })).body) as { status: string }).status, "REQUIRES_CUSTOMER_ACTION");
    assert.equal(gate.state.checkout?.attempts.length, 1);
  });
});

test("cross-session checkout access is denied and rate limits work", async () => {
  const limiter = new HppRateLimiter(() => 1000); assert.equal(limiter.allow("x", 1, 1000), true); assert.equal(limiter.allow("x", 1, 1000), false);
  await withHttpGate(async ({ call, setApiStatus }) => {
    const owner = await authorize(call); const other = await authorize(call);
    const create = (a: { cookie: string; csrf: string }) => call("/api/checkout", { method: "POST", headers: { cookie: a.cookie, origin: "https://checkout.example.test", "content-type": "application/json", "x-csrf-token": a.csrf }, body: "{}" });
    assert.equal((await create(owner)).status, 200);
    assert.equal((await call("/api/checkout", { headers: { cookie: other.cookie } })).status, 404);
    assert.equal((await create(other)).status, 409);
    assert.equal((await create(owner)).status, 409);
    assert.equal((await create(owner)).status, 409);
    assert.equal((await create(owner)).status, 429);
  });
});

test("cancelled return is verified and public checkout cannot create a replacement", async () => {
  await withHttpGate(async ({ call, setApiStatus }) => {
    const owner = await authorize(call);
    const headers = { cookie: owner.cookie, origin: "https://checkout.example.test", "content-type": "application/json", "x-csrf-token": owner.csrf };
    const launchResponse = await call("/api/checkout", { method: "POST", headers, body: "{}" });
    assert.equal(launchResponse.status, 200);
    const launch = JSON.parse(launchResponse.body) as { successUrl: string };
    setApiStatus("CANCELLED");
    const state = new URLSearchParams(new URL(launch.successUrl).hash.slice(1)).get("state")!;
    setApiStatus("CANCELLED");
    const callbackHeaders = { cookie: owner.cookie, origin: "https://checkout.example.test", "content-type": "application/json", "x-csrf-token": owner.csrf };
    assert.equal((await call("/api/checkout/return", { method: "POST", headers: callbackHeaders, body: JSON.stringify({ state }) })).status, 200);
    const current = await call("/api/checkout", { headers: { cookie: owner.cookie } });
    assert.equal((JSON.parse(current.body) as { status: string }).status, "CANCELLED");
    const recovered = await call("/api/checkout/recover", { method: "POST", headers, body: "{}" });
    assert.equal(recovered.status, 404);
  });
});

test("redaction removes client secret, operator/session tokens and API credentials", () => {
  const output = JSON.stringify(redact({ client_secret: "synthetic-client-secret-value", authorization: "Bearer synthetic-token", api_key: "synthetic-api-key", session_token: "synthetic-session-token" }));
  assert.doesNotMatch(output, /synthetic-client-secret-value|synthetic-token|synthetic-api-key|synthetic-session-token/);
  assert.match(output, /REDACTED/);
});

test("retrieved PaymentIntent IDs are redacted from API request logs", async () => {
  const originalFetch = globalThis.fetch; const originalLog = console.log; const logs: string[] = [];
  globalThis.fetch = async (input) => String(input).endsWith("/authentication/login")
    ? new Response(JSON.stringify({ token: "synthetic-bearer-token", expires_at: "2099-01-01T00:00:00Z" }), { status: 201 })
    : new Response(JSON.stringify({ id: "int_sensitive_123", request_id: "private-request-123", amount: 1, currency: "USD", merchant_order_id: "private-order-123", status: "PENDING" }), { status: 200 });
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  try {
    const service = HppService.fromClient(new AirwallexClient(cfg));
    const status = await service.status("int_sensitive_123", { amount: 1, currency: "USD", merchantOrderId: "private-order-123", requestId: "private-request-123" });
    assert.equal(status.status, "PENDING");
    assert.doesNotMatch(logs.join("\n"), /int_sensitive_123|private-order-123|private-request-123|synthetic-bearer-token/);
  } finally { globalThis.fetch = originalFetch; console.log = originalLog; }
});
