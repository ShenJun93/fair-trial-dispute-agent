import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { AirwallexClient } from "../src/airwallex.ts";
import { withW1AuthenticationPreflight } from "./w1-execute.ts";
import {
  CLIENT_SECRET_SAFETY_MARGIN_MS, CLIENT_SECRET_TTL_MS, W1Journal, W1_ORIGIN,
  acceptFreshBindingReceipt, createAirwallexW1Provider, createW2HandoffHandler, resolveW2Handoff, runW1Once, verifyLocalAccountBinding,
  type W1CreateRequest, type W1Intent, type W1Provider,
} from "./w1-safe-path.ts";

const SECRET = "fake-provider-client-secret-do-not-persist";
const NOW = new Date("2026-10-29T12:00:00.000Z");

test("narrow Airwallex adapter exposes only sandbox create/retrieve and passes retry:false", async () => {
  const calls: Array<{ method: string; path: string; options: Record<string, unknown> }> = [];
  const trace: Array<{ method: string; url: string; status: number }> = [];
  const client = {
    cfg: { base: W1_ORIGIN, filesBase: "https://files.sandbox.airwallex.com", clientId: "fake", apiKey: "fake", webhookSecret: "", dryRun: false },
    trace,
    async request(method: string, path: string, options: Record<string, unknown> = {}) {
      calls.push({ method, path, options });
      const status = method === "POST" ? 201 : 200;
      (options.onDiagnostic as ((metadata: { httpStatus: number }) => void) | undefined)?.({ httpStatus: status });
      trace.push({ method, url: `${W1_ORIGIN}${path}`, status });
      return method === "POST" ? { fake: "create" } : { fake: "retrieve" };
    },
  } as unknown as Parameters<typeof createAirwallexW1Provider>[0];
  const provider = createAirwallexW1Provider(client);
  const input = { request_id: "req", merchant_order_id: "order", amount: 1, currency: "USD", descriptor: "FAIR TRIAL TEST" as const };
  assert.equal((await provider.create(input, { retry: false })).httpStatus, 201);
  assert.equal((await provider.retrieve("int_fake_123", { retry: false })).httpStatus, 200);
  assert.deepEqual(calls.map(c => [c.method, c.path, c.options.retry]), [
    ["POST", "/api/v1/pa/payment_intents/create", false],
    ["GET", "/api/v1/pa/payment_intents/int_fake_123", false],
  ]);
  assert.equal(calls[0].options.sensitivePaymentIntentCreate, true);
  assert.throws(() => createAirwallexW1Provider({ ...client, cfg: { ...client.cfg, base: "https://api.airwallex.com" } }), /REAL_SANDBOX_CONFIG/);
});

test("authentication failure occurs before journal creation or dispatch", async (t) => {
  const dir = await temp(t), journalPath = join(dir, "must-not-exist.sqlite");
  let dispatchCalled = false;
  await assert.rejects(withW1AuthenticationPreflight(async () => {
    assert.equal(existsSync(journalPath), false);
    throw new Error("synthetic auth failure");
  }, async () => { dispatchCalled = true; throw new Error("dispatch must not run"); }), /synthetic auth failure/);
  assert.equal(existsSync(journalPath), false);
  assert.equal(dispatchCalled, false);
});

test("local account verifier completes with fake credentials and emits only a sanitized receipt", { skip: process.platform !== "win32" }, async (t) => {
  const dir = await temp(t), configPath = join(dir, "fake.env");
  const fakeClientId = "fake-client-id-never-publish";
  await writeFile(configPath, `AIRWALLEX_CLIENT_ID=${fakeClientId}\n`, "utf8");
  const verifier = resolve(process.cwd(), "scripts/verify-w1-account-binding.local.ps1");
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const command = `$script:fakeInputs = [System.Collections.Generic.Queue[string]]::new(); @('yes',${quote(fakeClientId)},'yes','1','no') | ForEach-Object { $script:fakeInputs.Enqueue($_) }; function Read-Host { param([string]$Prompt,[switch]$AsSecureString); $value=$script:fakeInputs.Dequeue(); if($AsSecureString){ ConvertTo-SecureString $value -AsPlainText -Force } else { $value } }; . ${quote(verifier)} -ConfigPath ${quote(configPath)}`;
  const result = spawnSync("pwsh.exe", ["-NoProfile", "-Command", command], {
    cwd: process.cwd(), encoding: "utf8",
    env: { ...process.env, FT_W1_BINDING_CHALLENGE: "synthetic-challenge" }, windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /LOCAL-ONLY account verifier/);
  assert.match(result.stdout, /"result":"MATCH"/);
  assert.match(result.stdout, /"keyAccountScope":"SINGLE_ACCOUNT"/);
  assert.match(result.stdout, /"networkRequests":0/);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(fakeClientId));
});

function intent(input: W1CreateRequest, overrides: Record<string, unknown> = {}): W1Intent {
  return { id: "int_fake_123", request_id: input.request_id, merchant_order_id: input.merchant_order_id,
    amount: 1, currency: "USD", status: "REQUIRES_PAYMENT_METHOD", client_secret: SECRET,
    created_at: NOW.toISOString(), ...overrides } as W1Intent;
}

async function temp(t: test.TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ft-w1-safe-"));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  return dir;
}

function spawnWorker(cwd: string, db: string, marker: string): Promise<{ code: number | null; output: string }> {
  const code = `
    import { open } from 'node:fs/promises';
    import { W1Journal, runW1Once } from './scripts/w1-safe-path.ts';
    const journal = await W1Journal.open(process.argv[1]);
    const provider = {
      async create(input, options) {
        if (options.retry !== false) throw new Error('retry flag missing');
        const f = await open(process.argv[2], 'wx');
        await f.writeFile('one create'); await f.close();
        await new Promise(r => setTimeout(r, 180));
        return { httpStatus: 201, body: { id: 'int_child_123', ...input, status: 'REQUIRES_PAYMENT_METHOD', client_secret: 'child-secret', created_at: new Date().toISOString() } };
      },
      async retrieve(id) { return { httpStatus: 200, body: { id: 'int_child_123', request_id: journal.read().request_id,
        merchant_order_id: journal.read().merchant_order_id, amount: 1, currency: 'USD', status: 'REQUIRES_PAYMENT_METHOD' } }; }
    };
    try { await runW1Once({ journal, provider }); process.stdout.write('RUN_OK'); process.exitCode=0; }
    catch (e) { process.stdout.write(e.message === 'W1_ALREADY_DISPATCHED' ? 'FENCED' : 'ERROR'); process.exitCode=e.message === 'W1_ALREADY_DISPATCHED' ? 0 : 2; }
    finally { journal.close(); }
  `;
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "--import", "tsx", "--input-type=module", "-e", code, db, marker], { cwd, windowsHide: true });
  return new Promise((resolvePromise, reject) => {
    let output = "";
    child.stdout.on("data", (b: Buffer) => { output += b.toString(); });
    child.stderr.on("data", () => {});
    child.once("error", reject);
    child.once("close", (code) => resolvePromise({ code, output }));
  });
}

test("FAKE default fences before one POST, disables retries, and verifies all five fields", async (t) => {
  const dir = await temp(t), journal = await W1Journal.open(join(dir, "attempt.sqlite"));
  let posts = 0, gets = 0;
  const provider: W1Provider = {
    async create(input, options) {
      posts++;
      assert.equal(options.retry, false);
      assert.equal(journal.read()?.phase, "DISPATCHED");
      assert.equal(input.amount, 1); assert.equal(input.currency, "USD");
      assert.ok(input.request_id.length > 0); assert.ok(input.merchant_order_id.length <= 64);
      assert.equal(input.request_id, journal.read()?.request_id);
      assert.equal(input.merchant_order_id, journal.read()?.merchant_order_id);
      return { httpStatus: 201, body: intent(input) };
    },
    async retrieve(id, options) {
      gets++; assert.equal(options.retry, false); assert.equal(id, "int_fake_123");
      const row = journal.read()!;
      return { httpStatus: 200, body: { id, request_id: row.request_id, merchant_order_id: row.merchant_order_id,
        amount: 1, currency: "USD", status: "REQUIRES_PAYMENT_METHOD" } };
    },
  };
  const receipt = await runW1Once({ journal, provider });
  assert.equal(receipt.mode, "FAKE"); assert.equal(receipt.phase, "READBACK_VERIFIED");
  assert.equal(receipt.postCount, 1); assert.equal(receipt.retryCount, 0); assert.equal(receipt.retrieveCount, 1);
  assert.equal(posts, 1); assert.equal(gets, 1);
  assert.equal(journal.read()?.phase, "READBACK_VERIFIED");
  assert.equal(JSON.stringify(journal.read()).includes(SECRET), false);
  assert.equal(JSON.stringify(receipt).includes(SECRET), false);
  assert.equal(JSON.stringify(receipt).includes("int_fake_123"), false);
  journal.close();
});

for (const status of [401, 429]) {
  test(`HTTP ${status} create refusal never replays POST`, async (t) => {
    const dir = await temp(t), journal = await W1Journal.open(join(dir, "attempt.sqlite"));
    let posts = 0, gets = 0;
    const provider: W1Provider = {
      async create(_input, options) { posts++; assert.equal(options.retry, false); return { httpStatus: status, body: {} }; },
      async retrieve() { gets++; return { httpStatus: 200, body: {} }; },
    };
    const receipt = await runW1Once({ journal, provider });
    assert.equal(receipt.phase, "FAILED"); assert.equal(receipt.postCount, 1); assert.equal(receipt.retryCount, 0);
    assert.equal(posts, 1); assert.equal(gets, 0); assert.equal(journal.read()?.phase, "FAILED");
    journal.close();
  });
}

test("create timeout remains SENT_UNKNOWN; restart/re-entry cannot create again", async (t) => {
  const dir = await temp(t), db = join(dir, "attempt.sqlite"), journal = await W1Journal.open(db);
  let posts = 0;
  const provider: W1Provider = { async create(_input, options) { posts++; assert.equal(options.retry, false); throw new Error("simulated timeout"); }, async retrieve() { throw new Error("unexpected GET"); } };
  const receipt = await runW1Once({ journal, provider });
  assert.equal(receipt.phase, "SENT_UNKNOWN"); assert.equal(posts, 1); journal.close();
  const restarted = await W1Journal.open(db);
  await assert.rejects(runW1Once({ journal: restarted, provider }), /W1_ALREADY_DISPATCHED/);
  assert.equal(posts, 1); assert.equal(restarted.read()?.phase, "SENT_UNKNOWN"); restarted.close();
});

test("malformed or mismatched create response fails closed and never retrieves/replays", async (t) => {
  const dir = await temp(t), journal = await W1Journal.open(join(dir, "attempt.sqlite"));
  let posts = 0, gets = 0;
  const provider: W1Provider = {
    async create(input) { posts++; return { httpStatus: 201, body: intent(input, { request_id: "wrong-request" }) }; },
    async retrieve() { gets++; return { httpStatus: 200, body: {} }; },
  };
  const receipt = await runW1Once({ journal, provider });
  assert.equal(receipt.phase, "SENT_UNKNOWN"); assert.equal(posts, 1); assert.equal(gets, 0);
  assert.equal(journal.read()?.phase, "SENT_UNKNOWN"); journal.close();
});

test("read-back identity mismatch is rejected after exactly one create", async (t) => {
  const dir = await temp(t), journal = await W1Journal.open(join(dir, "attempt.sqlite"));
  let posts = 0, gets = 0;
  const provider: W1Provider = {
    async create(input) { posts++; return { httpStatus: 201, body: intent(input) }; },
    async retrieve(id) { gets++; const row = journal.read()!; return { httpStatus: 200, body: { id,
      request_id: row.request_id, merchant_order_id: row.merchant_order_id, amount: 1, currency: "EUR", status: "SUCCEEDED" } }; },
  };
  const receipt = await runW1Once({ journal, provider });
  assert.equal(receipt.phase, "FAILED"); assert.equal(receipt.reason, "READBACK_IDENTITY_MISMATCH");
  assert.equal(posts, 1); assert.equal(gets, 1); assert.equal(receipt.postCount, 1); journal.close();
});

test("LIVE mode refuses account identity not proven before dispatch", async (t) => {
  const dir = await temp(t), journal = await W1Journal.open(join(dir, "attempt.sqlite"));
  let posts = 0;
  const provider: W1Provider = { async create() { posts++; return { httpStatus: 201, body: {} }; }, async retrieve() { return { httpStatus: 200, body: {} }; } };
  await assert.rejects(runW1Once({ mode: "LIVE", journal, provider }), /ACCOUNT_UNVERIFIED/);
  assert.equal(posts, 0); assert.equal(journal.read(), undefined); journal.close();
});

test("live adapter cannot be run under the FAKE default label", async (t) => {
  const dir = await temp(t), journal = await W1Journal.open(join(dir, "attempt.sqlite"));
  const client = { cfg: { base: W1_ORIGIN, filesBase: "https://files.sandbox.airwallex.com", clientId: "fake", apiKey: "fake", webhookSecret: "", dryRun: false },
    trace: [], async request() { throw new Error("must not reach transport"); } } as unknown as Parameters<typeof createAirwallexW1Provider>[0];
  const provider = createAirwallexW1Provider(client);
  await assert.rejects(runW1Once({ journal, provider }), /W1_PROVIDER_MODE_MISMATCH/);
  assert.equal(journal.read(), undefined); journal.close();
});

test("separate runner processes cannot dispatch two creates against the same SQLite journal", async (t) => {
  const dir = await temp(t), db = join(dir, "attempt.sqlite"), marker = join(dir, "one-post.marker");
  const repo = resolve(process.cwd());
  const results = await Promise.all([spawnWorker(repo, db, marker), spawnWorker(repo, db, marker)]);
  assert.deepEqual(results.map(x => x.code), [0, 0]);
  assert.deepEqual(results.map(x => x.output).sort(), ["FENCED", "RUN_OK"]);
  const markerText = await readFile(marker, "utf8"); assert.equal(markerText, "one create");
  const journal = await W1Journal.open(db); assert.equal(journal.read()?.phase, "READBACK_VERIFIED"); journal.close();
});

const handoffAttempt = {
  id: "int_fake_123", request_id: "req_fake_123", merchant_order_id: "ft-w1-order",
  amount: 1, currency: "USD", createdAt: NOW.toISOString(), phase: "READBACK_VERIFIED" as const,
};
const handoffIntent = (overrides: Record<string, unknown> = {}) => ({ ...handoffAttempt,
  status: "REQUIRES_PAYMENT_METHOD", client_secret: SECRET, created_at: NOW.toISOString(), ...overrides });
const allowedRequest = { origin: "https://fair-trial.example.test", sessionBound: true, csrfValid: true };
const now = () => new Date(NOW.getTime() + 5_000);

test("W2 handoff serves a fresh secret only after auth, origin, CSRF and five-field GET proof", async () => {
  let gets = 0;
  const result = await resolveW2Handoff({ request: allowedRequest, expectedOrigin: allowedRequest.origin,
    attempt: handoffAttempt, now, async retrieve(id) { gets++; return { httpStatus: 200, body: handoffIntent({ id }) }; } });
  assert.equal(result.status, 200); assert.equal(result.headers["cache-control"], "no-store");
  assert.equal(result.body.client_secret, SECRET); assert.equal(gets, 1);
});

test("HTTP W2 prototype enforces session, exact Origin, CSRF and no-store before secret delivery", async () => {
  let gets = 0, claimed = false;
  const origin = "https://fair-trial.example.test";
  const server = createW2HandoffHandler({
    expectedOrigin: origin, attempt: handoffAttempt,
    sessionBound(req) { return req.headers.cookie === "session=synthetic-session"; },
    csrfValid(req) { return req.headers["x-csrf-token"] === "synthetic-csrf"; },
    claimLaunch() { if (claimed) return false; claimed = true; return true; },
    async retrieve(id) { gets++; return { httpStatus: 200, body: handoffIntent({ id }) }; }, now,
  });
  const listener = server.listeners("request")[0] as (req: EventEmitter & { method: string; url: string; headers: Record<string, string> }, res: {
    headers: Record<string, string>; status?: number; body?: string;
    setHeader(name: string, value: string): void; writeHead(status: number): this; end(body?: string): void;
  }) => Promise<void>;
  const call = async (headers: Record<string, string>) => {
    const req = Object.assign(new EventEmitter(), { method: "POST", url: "/api/w2/handoff", headers });
    const res = { headers: {} as Record<string, string>, setHeader(name: string, value: string) { this.headers[name] = value; },
      writeHead(status: number) { this.status = status; return this; }, end(body?: string) { this.body = body; } };
    await listener(req, res);
    return { ...res, json: JSON.parse(res.body ?? "{}") as { client_secret?: string } };
  };
  const denied = await call({ origin, cookie: "session=wrong", "x-csrf-token": "synthetic-csrf" });
  assert.equal(denied.status, 401); assert.equal(denied.headers["cache-control"], "no-store");
  const wrongOrigin = await call({ origin: "https://attacker.example.test", cookie: "session=synthetic-session", "x-csrf-token": "synthetic-csrf" });
  assert.equal(wrongOrigin.status, 403);
  const wrongCsrf = await call({ origin, cookie: "session=synthetic-session", "x-csrf-token": "wrong" });
  assert.equal(wrongCsrf.status, 403); assert.equal(gets, 0);
  const allowed = await call({ origin, cookie: "session=synthetic-session", "x-csrf-token": "synthetic-csrf" });
  assert.equal(allowed.status, 200); assert.equal(allowed.headers["cache-control"], "no-store");
  assert.equal(allowed.json.client_secret, SECRET); assert.equal(gets, 1);
  const replay = await call({ origin, cookie: "session=synthetic-session", "x-csrf-token": "synthetic-csrf" });
  assert.equal(replay.status, 409); assert.equal(gets, 1);
});

test("unauthorized session, wrong Origin and invalid CSRF never retrieve or receive a secret", async () => {
  let gets = 0;
  for (const request of [
    { ...allowedRequest, sessionBound: false },
    { ...allowedRequest, origin: "https://attacker.example.test" },
    { ...allowedRequest, csrfValid: false },
  ]) {
    const result = await resolveW2Handoff({ request, expectedOrigin: allowedRequest.origin,
      attempt: handoffAttempt, now, async retrieve() { gets++; return { httpStatus: 200, body: handoffIntent() }; } });
    assert.notEqual(result.status, 200); assert.equal(result.body.client_secret, undefined);
  }
  assert.equal(gets, 0);
});

test("GET identity mismatch prevents secret delivery", async () => {
  const result = await resolveW2Handoff({ request: allowedRequest, expectedOrigin: allowedRequest.origin,
    attempt: handoffAttempt, now, async retrieve() { return { httpStatus: 200, body: handoffIntent({ merchant_order_id: "other" }) }; } });
  assert.equal(result.status, 409); assert.equal(result.body.client_secret, undefined);
});

test("creation-time mismatch or unexpected payment status blocks the W2 secret", async () => {
  for (const overrides of [
    { created_at: new Date(NOW.getTime() - 60_000).toISOString() },
    { status: "SUCCEEDED" },
  ]) {
    const result = await resolveW2Handoff({ request: allowedRequest, expectedOrigin: allowedRequest.origin,
      attempt: handoffAttempt, now, async retrieve() { return { httpStatus: 200, body: handoffIntent(overrides) }; } });
    assert.equal(result.status, 409); assert.equal(result.body.client_secret, undefined);
  }
});

test("expired intent, absent secret, or unverified attempt never triggers replacement create", async () => {
  let creates = 0, gets = 0;
  const expired = await resolveW2Handoff({ request: allowedRequest, expectedOrigin: allowedRequest.origin,
    attempt: { ...handoffAttempt, createdAt: new Date(NOW.getTime() - CLIENT_SECRET_TTL_MS + CLIENT_SECRET_SAFETY_MARGIN_MS).toISOString() },
    now, async retrieve() { gets++; return { httpStatus: 200, body: handoffIntent() }; } });
  assert.equal(expired.status, 410); assert.equal(gets, 0);
  const absent = await resolveW2Handoff({ request: allowedRequest, expectedOrigin: allowedRequest.origin,
    attempt: handoffAttempt, now, async retrieve() { gets++; return { httpStatus: 200, body: handoffIntent({ client_secret: undefined }) }; } });
  assert.equal(absent.status, 410); assert.equal(absent.body.client_secret, undefined);
  const unverified = await resolveW2Handoff({ request: allowedRequest, expectedOrigin: allowedRequest.origin,
    attempt: { ...handoffAttempt, phase: "CREATE_VERIFIED" }, now, async retrieve() { gets++; throw new Error("must not GET"); } });
  assert.equal(unverified.status, 409); assert.equal(unverified.body.client_secret, undefined);
  assert.equal(creates, 0); assert.equal(gets, 1);
});

test("provider response secret is never written to the metadata journal or sanitized result", async (t) => {
  const dir = await temp(t), journal = await W1Journal.open(join(dir, "attempt.sqlite"));
  const provider: W1Provider = {
    async create(input) { return { httpStatus: 201, body: intent(input) }; },
    async retrieve(id) { const row = journal.read()!; return { httpStatus: 200, body: { id,
      request_id: row.request_id, merchant_order_id: row.merchant_order_id, amount: 1, currency: "USD", status: "REQUIRES_PAYMENT_METHOD" } }; },
  };
  const receipt = await runW1Once({ journal, provider });
  const bytes = await readFile(join(dir, "attempt.sqlite"));
  assert.equal(bytes.includes(Buffer.from(SECRET)), false);
  assert.equal(JSON.stringify(receipt).includes(SECRET), false);
  journal.close();
});

test("local binding comparison derives status without accepting a MATCH flag or exposing identifiers", () => {
  const same = verifyLocalAccountBinding({ configuredClientId: "client-private-value", dashboardClientId: "client-private-value",
    keyAppliesToSelectedUsAccount: true, keyAccountScope: "SINGLE_ACCOUNT", operatorReportedLoginAs: "NONE" });
  assert.equal(same.result, "MATCH"); assert.equal(same.provenance, "LOCAL_INTERACTIVE_COMPARISON");
  assert.equal(same.documentedLoginAs, "NOT_REQUIRED_BY_DOCUMENTATION"); assert.equal(same.conflict, null);
  const mismatch = verifyLocalAccountBinding({ configuredClientId: "configured-private", dashboardClientId: "dashboard-private",
    keyAppliesToSelectedUsAccount: true, keyAccountScope: "MULTIPLE_ACCOUNTS", operatorReportedLoginAs: "REQUIRED" });
  assert.equal(mismatch.result, "MISMATCH");
  const wrongAccount = verifyLocalAccountBinding({ configuredClientId: "same-value", dashboardClientId: "same-value",
    keyAppliesToSelectedUsAccount: false, keyAccountScope: "SINGLE_ACCOUNT", operatorReportedLoginAs: "NONE" });
  assert.equal(wrongAccount.result, "MISMATCH");
  const unknown = verifyLocalAccountBinding({ configuredClientId: "configured-private", dashboardClientId: "dashboard-private",
    keyAppliesToSelectedUsAccount: "UNKNOWN", keyAccountScope: "UNKNOWN", operatorReportedLoginAs: "UNKNOWN" });
  assert.equal(unknown.result, "UNKNOWN");
  for (const result of [same, mismatch, wrongAccount, unknown]) {
    const text = JSON.stringify(result);
    assert.equal(text.includes("configured-private"), false); assert.equal(text.includes("dashboard-private"), false);
  }
  assert.equal(Object.keys(same).includes("result"), true);
});

test("W1 execution accepts only a challenge-bound receipt matching credentials loaded now", () => {
  const challenge = "current-process-challenge";
  const receipt = { result:"MATCH", provenance:"LOCAL_INTERACTIVE_COMPARISON", origin:W1_ORIGIN, challenge,
    keyAccountScope:"SINGLE_ACCOUNT", documentedXLoginAs:"NOT_REQUIRED_BY_DOCUMENTATION", operatorException:"NONE",
    targetAccountBinding:"NOT_APPLICABLE", clientIdFingerprint:createHash("sha256").update("current-client-id").digest("hex").slice(0,16),
    conflicts:[], selectedUsSandboxAccountConfirmed:true, keyAppliesToSelectedUsAccount:true,
    liveW1Enabled:false, networkRequests:0, rawIdentifiersEmitted:false };
  const accepted = acceptFreshBindingReceipt({ receipt, challenge, currentClientId:"current-client-id" });
  assert.equal(accepted.result,"MATCH");
  assert.throws(() => acceptFreshBindingReceipt({ receipt:{...receipt, challenge:"old"}, challenge, currentClientId:"current-client-id" }), /ACCOUNT_UNVERIFIED/);
  assert.throws(() => acceptFreshBindingReceipt({ receipt, challenge, currentClientId:"rotated-client-id" }), /ACCOUNT_UNVERIFIED/);
});

test("LIVE remains blocked when scoped key needs x-login-as or is linked to multiple accounts", async (t) => {
  const dir = await temp(t), journal = await W1Journal.open(join(dir, "attempt.sqlite"));
  const binding = verifyLocalAccountBinding({ configuredClientId: "same-value", dashboardClientId: "same-value",
    keyAppliesToSelectedUsAccount: true, keyAccountScope: "MULTIPLE_ACCOUNTS", operatorReportedLoginAs: "REQUIRED" });
  assert.equal(binding.result, "MATCH");
  let posts = 0;
  const provider: W1Provider = { providerKind: "AIRWALLEX_SANDBOX", clientIdFingerprint: binding.clientIdFingerprint,
    async create() { posts++; return { httpStatus: 201, body: {} }; }, async retrieve() { return { httpStatus: 200, body: {} }; } };
  await assert.rejects(runW1Once({ mode: "LIVE", journal, provider, accountBinding: binding }), /ACCOUNT_UNVERIFIED/);
  assert.equal(posts, 0); assert.equal(journal.read(), undefined); journal.close();
});

test("scope-derived x-login-as supports verified multi-account target and preserves single-account conflict", () => {
  const multi = verifyLocalAccountBinding({ configuredClientId: "client-safe", dashboardClientId: "client-safe",
    keyAppliesToSelectedUsAccount: true, keyAccountScope: "MULTIPLE_ACCOUNTS", operatorReportedLoginAs: "REQUIRED",
    configuredTargetAccountId: "acct-private-target", dashboardTargetAccountId: "acct-private-target" });
  assert.equal(multi.result, "MATCH"); assert.equal(multi.documentedLoginAs, "REQUIRED_BY_DOCUMENTATION");
  assert.equal(multi.operatorException, "NONE"); assert.equal(multi.conflict, null); assert.ok(multi.targetAccountFingerprint);
  assert.equal(JSON.stringify(multi).includes("acct-private-target"), false);

  const singleConflict = verifyLocalAccountBinding({ configuredClientId: "client-safe", dashboardClientId: "client-safe",
    keyAppliesToSelectedUsAccount: true, keyAccountScope: "SINGLE_ACCOUNT", operatorReportedLoginAs: "REQUIRED" });
  assert.equal(singleConflict.result, "MATCH");
  assert.equal(singleConflict.documentedLoginAs, "NOT_REQUIRED_BY_DOCUMENTATION");
  assert.equal(singleConflict.operatorException, "REPORTED_REQUIRED");
  assert.equal(singleConflict.conflict, "OPERATOR_REPORT_CONFLICTS_WITH_DOCUMENTATION");
  const conflictingConfig = verifyLocalAccountBinding({ configuredClientId: "client-safe", dashboardClientId: "client-safe",
    keyAppliesToSelectedUsAccount: true, keyAccountScope: "SINGLE_ACCOUNT", operatorReportedLoginAs: "NONE",
    configuredTargetAccountId: "acct-unexpected-config" });
  assert.equal(conflictingConfig.result, "MATCH");
  assert.equal(conflictingConfig.conflict, "TARGET_CONFIGURED_FOR_SINGLE_ACCOUNT");
  const mismatchedTarget = verifyLocalAccountBinding({ configuredClientId: "client-safe", dashboardClientId: "client-safe",
    keyAppliesToSelectedUsAccount: true, keyAccountScope: "MULTIPLE_ACCOUNTS", operatorReportedLoginAs: "REQUIRED",
    configuredTargetAccountId: "acct-configured", dashboardTargetAccountId: "acct-dashboard" });
  assert.equal(mismatchedTarget.result, "MISMATCH"); assert.equal(mismatchedTarget.conflict, "TARGET_ACCOUNT_MISMATCH");
});

test("LIVE gate accepts only a verified multi-account target and blocks unresolved single-account exception", async (t) => {
  const dir = await temp(t), journal = await W1Journal.open(join(dir, "attempt.sqlite"));
  let posts = 0, gets = 0;
  const multi = verifyLocalAccountBinding({ configuredClientId: "client-safe", dashboardClientId: "client-safe",
    keyAppliesToSelectedUsAccount: true, keyAccountScope: "MULTIPLE_ACCOUNTS", operatorReportedLoginAs: "REQUIRED",
    configuredTargetAccountId: "acct-private-target", dashboardTargetAccountId: "acct-private-target" });
  const provider: W1Provider = {
    providerKind: "AIRWALLEX_SANDBOX", clientIdFingerprint: multi.clientIdFingerprint,
    loginAsTargetFingerprint: multi.targetAccountFingerprint,
    async create(input, options) { posts++; assert.equal(options.retry, false); return { httpStatus: 201, body: intent(input) }; },
    async retrieve(id, options) { gets++; assert.equal(options.retry, false); const row = journal.read()!;
      return { httpStatus: 200, body: { id, request_id: row.request_id, merchant_order_id: row.merchant_order_id,
        amount: 1, currency: "USD", status: "REQUIRES_PAYMENT_METHOD" } }; },
  };
  const ready = await runW1Once({ mode: "LIVE", journal, provider, accountBinding: multi, now: () => NOW });
  assert.equal(ready.phase, "READBACK_VERIFIED"); assert.equal(posts, 1); assert.equal(gets, 1);
  journal.close();

  const singleJournal = await W1Journal.open(join(dir, "single.sqlite"));
  const singleException = verifyLocalAccountBinding({ configuredClientId: "client-safe", dashboardClientId: "client-safe",
    keyAppliesToSelectedUsAccount: true, keyAccountScope: "SINGLE_ACCOUNT", operatorReportedLoginAs: "REQUIRED" });
  let singlePosts = 0;
  const singleProvider: W1Provider = { ...provider, loginAsTargetFingerprint: undefined,
    async create() { singlePosts++; return { httpStatus: 201, body: {} }; } };
  await assert.rejects(runW1Once({ mode: "LIVE", journal: singleJournal, provider: singleProvider, accountBinding: singleException }), /ACCOUNT_UNVERIFIED/);
  assert.equal(singlePosts, 0); assert.equal(singleJournal.read(), undefined); singleJournal.close();
});

test("configured x-login-as is sent only on authentication and never appears in logs or trace", async (t) => {
  const accountId = "acct_private_not_for_output", apiKey = "test-api-key";
  const capturedHeaders: Array<Record<string, string>> = [], output: string[] = [];
  const oldFetch = globalThis.fetch, oldLog = console.log, oldWarn = console.warn, oldError = console.error;
  t.after(() => { globalThis.fetch = oldFetch; console.log = oldLog; console.warn = oldWarn; console.error = oldError; });
  console.log = (...args: unknown[]) => output.push(args.join(" "));
  console.warn = (...args: unknown[]) => output.push(args.join(" "));
  console.error = (...args: unknown[]) => output.push(args.join(" "));
  globalThis.fetch = (async (_input: URL | RequestInfo, init?: RequestInit) => {
    capturedHeaders.push(Object.fromEntries(new Headers(init?.headers).entries()));
    return new Response(JSON.stringify(capturedHeaders.length === 1
      ? { token: "synthetic-access-token", expires_at: "2026-10-29T13:00:00Z" }
      : { ok: true }), { status: capturedHeaders.length === 1 ? 201 : 200 });
  }) as typeof fetch;
  const client = new AirwallexClient({ clientId: "local-client", apiKey, loginAsTarget: accountId, base: W1_ORIGIN,
    filesBase: "https://files.sandbox.airwallex.com", webhookSecret: "", dryRun: false });
  await client.request("GET", "/api/v1/account", { retry: false });
  assert.equal(capturedHeaders[0]["x-login-as"], accountId);
  assert.equal(capturedHeaders[1]["x-login-as"], undefined);
  assert.equal(JSON.stringify({ output, trace: client.trace }).includes(accountId), false);
});

test("PaymentIntent create redacts every observable surface on provider refusal", async (t) => {
  const markerRequest = "req_secret_marker_0123456789", markerOrder = "ft-order-secret-marker", markerIntent = "int_private_marker_123";
  const markerSecret = "client_secret_private_marker_abcdefghijklmnopqrstuvwxyz", markerKey = "test-api-key";
  const stdout: string[] = [], stderr: string[] = [];
  const oldFetch = globalThis.fetch, oldLog = console.log, oldWarn = console.warn, oldError = console.error;
  t.after(() => { globalThis.fetch = oldFetch; console.log = oldLog; console.warn = oldWarn; console.error = oldError; });
  console.log = (...args: unknown[]) => stdout.push(args.join(" "));
  console.warn = (...args: unknown[]) => stderr.push(args.join(" "));
  console.error = (...args: unknown[]) => stderr.push(args.join(" "));
  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/v1/authentication/login")) return new Response(JSON.stringify({ token: "eyJfake.access.token", expires_at: "2026-10-29T13:00:00Z" }), { status: 201 });
    assert.equal(init?.method, "POST");
    const sent = JSON.parse(String(init?.body));
    assert.equal(sent.request_id, markerRequest); assert.equal(sent.merchant_order_id, markerOrder);
    return new Response(JSON.stringify({ id: markerIntent, request_id: markerRequest, merchant_order_id: markerOrder,
      client_secret: markerSecret, api_key: markerKey, message: `${markerIntent} ${markerSecret} ${markerKey}` }), { status: 400 });
  }) as typeof fetch;
  const client = new AirwallexClient({ clientId: "client-id-private", apiKey: markerKey, base: W1_ORIGIN,
    filesBase: "https://files.sandbox.airwallex.com", webhookSecret: "", dryRun: false });
  let thrown = "";
  await assert.rejects(client.request("POST", "/api/v1/pa/payment_intents/create", {
    body: { request_id: markerRequest, merchant_order_id: markerOrder, amount: 1, currency: "USD" },
    sensitivePaymentIntentCreate: true, retry: false,
  }), (err: unknown) => { thrown = JSON.stringify(err instanceof Error ? { message: err.message, json: (err as { toJSON?: () => unknown }).toJSON?.() } : err); return true; });
  const allSurfaces = JSON.stringify({ stdout, stderr, trace: client.trace, thrown });
  for (const marker of [markerRequest, markerOrder, markerIntent, markerSecret, markerKey, "eyJfake.access.token"]) {
    assert.equal(allSurfaces.includes(marker), false, `sensitive marker leaked: ${marker}`);
  }
  assert.equal(client.trace.some(entry => entry.request === undefined && entry.error !== undefined && entry.url.includes("[REDACTED]")), true);
});

test("offline W1 restart to one-use W2 handoff reuses exactly one intent and never invokes SDK redirect", async (t) => {
  const dir = await temp(t), db = join(dir, "attempt.sqlite");
  const binding = verifyLocalAccountBinding({ configuredClientId: "synthetic-client-id", dashboardClientId: "synthetic-client-id",
    keyAppliesToSelectedUsAccount: true, keyAccountScope: "SINGLE_ACCOUNT", operatorReportedLoginAs: "NONE" });
  assert.equal(binding.result, "MATCH"); // Local synthetic comparison for the rehearsal only.
  let posts = 0, gets = 0, redirectCalls = 0;
  let stored: W1Intent | undefined;
  const provider: W1Provider = {
    async create(input, options) { posts++; assert.equal(options.retry, false); stored = intent(input); return { httpStatus: 201, body: stored }; },
    async retrieve(id, options) { gets++; assert.equal(options.retry, false); assert.equal(id, stored?.id);
      return { httpStatus: 200, body: { ...stored!, client_secret: SECRET } }; },
  };
  let journal = await W1Journal.open(db);
  const created = await runW1Once({ journal, provider });
  assert.equal(created.phase, "READBACK_VERIFIED"); assert.equal(posts, 1); journal.close();

  // Simulate process restart; attempt identity is recovered from the same durable journal.
  journal = await W1Journal.open(db);
  const attempt = journal.readHandoffAttempt(); assert.ok(attempt); assert.equal(attempt.id, stored?.id);
  assert.equal(attempt.request_id, stored?.request_id); assert.equal(attempt.merchant_order_id, stored?.merchant_order_id);
  assert.equal(attempt.createdAt, stored?.created_at);
  journal.close();
  const restartedJournal = await W1Journal.open(db);

  const origin = "https://fair-trial.example.test";
  const handoffServer = createW2HandoffHandler({ expectedOrigin: origin, attempt: attempt!,
    sessionBound: () => true, csrfValid: () => true,
    claimLaunch: (candidate) => restartedJournal.claimW2Launch(candidate, NOW.toISOString()),
    retrieve: (id) => provider.retrieve(id, { retry: false }), now,
  });
  // Invoke the handler through a synthetic request/response without opening a socket.
  const listener = handoffServer.listeners("request")[0] as (req: EventEmitter & { method: string; url: string; headers: Record<string, string> }, res: {
    setHeader(name: string, value: string): void; writeHead(status: number): this; end(body?: string): void;
  }) => Promise<void>;
  const req = Object.assign(new EventEmitter(), { method: "POST", url: "/api/w2/handoff", headers: { origin } });
  let responseStatus = 0, responseBody = "";
  const res = { setHeader() {}, writeHead(status: number) { responseStatus = status; return this; }, end(body?: string) { responseBody = body ?? ""; } };
  await listener(req, res);
  assert.equal(responseStatus, 200);
  const handoff = JSON.parse(responseBody) as { intent_id: string; client_secret: string };
  assert.equal(handoff.intent_id, attempt!.id); assert.equal(handoff.client_secret, SECRET);

  // Offline fake redirect contract observes same intent only; no redirectToCheckout code is called.
  const fakeRedirectContract = (intentId: string) => { redirectCalls++; return { kind: "FAKE_REDIRECT_CONTRACT", intentId }; };
  const fakeLaunch = fakeRedirectContract(handoff.intent_id);
  assert.equal(fakeLaunch.intentId, stored?.id); assert.equal(redirectCalls, 1);
  const replayReq = Object.assign(new EventEmitter(), { method: "POST", url: "/api/w2/handoff", headers: { origin } });
  responseStatus = 0; responseBody = "";
  await listener(replayReq, res);
  assert.equal(responseStatus, 409); assert.equal(redirectCalls, 1);
  const afterReplayRestart = await W1Journal.open(db);
  assert.equal(afterReplayRestart.claimW2Launch(attempt!, NOW.toISOString()), false, "restart/replay must not reclaim launch");
  afterReplayRestart.close();
  const finalReadback = await provider.retrieve(handoff.intent_id, { retry: false });
  assert.equal(finalReadback.httpStatus, 200); assert.equal(identityMatchesForTest(finalReadback.body, attempt!), true);
  assert.equal(posts, 1); assert.equal(gets, 3); assert.equal(restartedJournal.read()?.intent_id, attempt!.id);
  restartedJournal.close(); handoffServer.close();
});

function identityMatchesForTest(body: unknown, expected: { id: string; request_id: string; merchant_order_id: string; amount: number; currency: string }): boolean {
  if (!body || typeof body !== "object") return false;
  const value = body as Record<string, unknown>;
  return value.id === expected.id && value.request_id === expected.request_id && value.merchant_order_id === expected.merchant_order_id && value.amount === expected.amount && value.currency === expected.currency;
}
