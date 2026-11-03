// Purely offline endpoint safety checks. No real credentials and no fetch() calls.
// Run: node --import tsx --test scripts/host-validation.test.ts
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { AirwallexClient, assertSandboxHost, DEFAULT_BASE, DEFAULT_FILES_BASE } from "../src/airwallex.ts";

const allowed: [string, string][] = [
  ["AIRWALLEX_BASE", DEFAULT_BASE],
  ["AIRWALLEX_FILES_BASE", DEFAULT_FILES_BASE],
];

test("exact documented sandbox API and file service origins are allowed", () => {
  for (const [name, origin] of allowed) {
    assert.equal(assertSandboxHost(origin, name), origin);
    assert.equal(assertSandboxHost(origin + "/", name), origin);
  }
});

test("rejects non-Airwallex sandbox lookalikes and suffix/prefix spoofing", () => {
  const samples = [
    "https://api.sandbox.example.com",
    "https://files.sandbox.example.net",
    "https://sandbox.airwallex.com.evil.invalid",
    "https://api.sandbox.airwallex.com.attacker.invalid",
    "https://sandbox-api.airwallex.evil.invalid",
    "https://my-demo.example.org",
    "https://api.sandbox-airwallex.com",
  ];
  for (const url of samples) {
    for (const [name] of allowed) {
      assert.throws(() => assertSandboxHost(url, name), { message: /permitted Airwallex sandbox endpoint/ });
    }
  }
});

test("rejects production, wrong service and downgrade to plain HTTP", () => {
  assert.throws(() => assertSandboxHost("https://api.airwallex.com", "AIRWALLEX_BASE"));
  assert.throws(() => assertSandboxHost("https://files.airwallex.com", "AIRWALLEX_FILES_BASE"));
  assert.throws(() => assertSandboxHost(DEFAULT_FILES_BASE, "AIRWALLEX_BASE"));
  assert.throws(() => assertSandboxHost(DEFAULT_BASE, "AIRWALLEX_FILES_BASE"));
  assert.throws(() => assertSandboxHost("http://api.sandbox.airwallex.com", "AIRWALLEX_BASE"));
});

test("rejects credentials, custom port, path, query and fragment in configured bases", () => {
  const invalid = [
    "https://user:pass@api.sandbox.airwallex.com",
    "https://api.sandbox.airwallex.com:8443",
    "https://api.sandbox.airwallex.com/private",
    "https://api.sandbox.airwallex.com/?redirect=1",
    "https://api.sandbox.airwallex.com/#frag",
  ];
  for (const url of invalid) assert.throws(() => assertSandboxHost(url, "AIRWALLEX_BASE"));
});

test("rejects structurally invalid configured origins", () => {
  for (const value of ["invalid", "", "file:///etc/passwd"]) {
    assert.throws(() => assertSandboxHost(value, "AIRWALLEX_BASE"));
  }
});

test("unverified legacy demo endpoints are not silently trusted", () => {
  assert.throws(() => assertSandboxHost("https://api-demo.airwallex.com", "AIRWALLEX_BASE"));
  assert.throws(() => assertSandboxHost("https://files-demo.airwallex.com", "AIRWALLEX_FILES_BASE"));
});

const mockConfig = {
  clientId: "",
  apiKey: "",
  base: DEFAULT_BASE,
  filesBase: DEFAULT_FILES_BASE,
  webhookSecret: "",
  dryRun: true,
};
test("legitimate relative API paths still work in network-free mode", async () => {
  const c = new AirwallexClient(mockConfig);
  await c.request("GET", "/api/v1/billing/subscriptions/test_001");
  assert.equal(c.trace.length, 1);
  assert.equal(c.trace[0]?.url, DEFAULT_BASE + "/api/v1/billing/subscriptions/test_001");
  assert.equal(c.trace[0]?.dry_run, true);
});

test("absolute or scheme-relative API paths cannot redirect a bearer-authenticated request to another origin", async () => {
  for (const path of [
    "https://untrusted.invalid/steal",
    "//untrusted.invalid/steal",
  ]) {
    const c = new AirwallexClient(mockConfig);
    await assert.rejects(c.request("GET", path), /path|relative|sandbox|origin|permitted/i);
    assert.equal(c.trace.length, 0, "unsafe URL must be blocked before network access and trace");
  }
});

test("directly constructed client configs cannot evade the sandbox guard", () => {
  assert.throws(() => new AirwallexClient({ ...mockConfig, base: "https://api.sandbox.attacker.invalid" }));
  assert.throws(() => new AirwallexClient({ ...mockConfig, filesBase: "https://files.airwallex.com" }));
});

test("credentialed login and authorized GET both disable HTTP redirects (mock fetch; no network)", async () => {
  const previousFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    assert.equal(init?.redirect, "error", "automatic redirects could escape verified sandbox host");
    const url = String(input);
    assert.ok(url.startsWith(DEFAULT_BASE + "/"), "real request must retain exact configured host");
    calls.push(url);
    if (url.endsWith("/api/v1/authentication/login")) {
      return new Response(JSON.stringify({
        token: "synthetic-token-only",
        expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ id: "synthetic-subscription" }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  try {
    const c = new AirwallexClient({
      ...mockConfig, clientId: "fake-client-id", apiKey: "fake-test-api-key", dryRun: false,
    });
    await c.login();
    await c.request("GET", "/api/v1/billing/subscriptions/for-test");
    assert.equal(calls.length, 2);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
