import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";
import { createKit04OfflineLifecycle, createKit04ReviewCases } from "../spike/dispute-workflow.ts";
import { DisputeReviewStore } from "../spike/dispute-review-store.ts";
import { createDisputeReviewHandler } from "../spike/dispute-review-server.ts";
import { DEFAULT_DISPUTE_ECONOMICS, fingerprintDisputeDecision, recommendDisputeAction } from "../spike/dispute-engine.ts";
import {
  createDisputeProviderAdapter,
  MockDisputeProviderAdapter,
  LiveDisputeProviderAdapter,
  validateLiveActionGate,
  type LiveActionGateInput,
} from "../spike/dispute-provider.ts";

const now = 1_800_000_000_000;
const operatorToken = randomBytes(32).toString("base64url");
const origin = "http://127.0.0.1:4243";

async function fixture(fee?: number) {
  const dir = await mkdtemp(join(tmpdir(), "fair-trial-dispute-"));
  const path = join(dir, "review.sqlite");
  const store = await DisputeReviewStore.open(path, fee, now);
  return { dir, path, store, close: async () => { store.close(); await rm(dir, { recursive: true, force: true }); } };
}

function session(store: DisputeReviewStore, actor: string, at = now) {
  const sessionToken = randomBytes(32).toString("base64url");
  const csrf = randomBytes(32).toString("base64url");
  store.createSession(sessionToken, csrf, actor, at);
  return { sessionToken, csrf, actor };
}

function makeRequest(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
  const request = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  Object.assign(request, { method, url, headers });
  return request;
}

async function call(handler: ReturnType<typeof createDisputeReviewHandler>, method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
  const req = makeRequest(method, url, body, { host: "127.0.0.1:4243", ...headers });
  const result: { status?: number; headers?: Record<string, string>; body?: string } = {};
  const res = {
    writeHead(status: number, responseHeaders: Record<string, string>) { result.status = status; result.headers = responseHeaders; return this; },
    end(value?: string | Buffer) { result.body = value?.toString(); },
  } as unknown as ServerResponse;
  await handler(req, res);
  return { ...result, json: result.body ? JSON.parse(result.body) as Record<string, unknown> : {} };
}

test("dashboard seeds the review cases and offline decision proof, evidence provenance, fee, and simulated lifecycle", async () => {
  const f = await fixture();
  try {
    const page = f.store.dashboard();
    assert.equal(page.cases.length, 5);
    assert.deepEqual(page.cases.map((item) => (item.recommendation as { action: string }).action).sort(), ["ACCEPT", "CHALLENGE", "CHALLENGE", "ESCALATE_FOR_REVIEW", "ESCALATE_FOR_REVIEW"]);
    assert.equal(page.feeMinor, 2_500);
    assert.ok((page.cases[0]!.evidence as Array<{ provenance: { reference: string } }>).every((e) => e.provenance.reference));
    assert.deepEqual(page.lifecycle.map((e) => [e.event, e.stage, e.status]), [
      ["DISPUTE_OPENED", "RFI", "REQUIRES_RESPONSE"],
      ["MERCHANT_CHALLENGE_SUBMITTED", "RFI", "CHALLENGED"],
      ["ISSUER_REJECTED_EVIDENCE", "CHARGEBACK", "REQUIRES_RESPONSE"],
    ]);
    assert.ok(page.lifecycle.every((e) => e.source === "SIMULATED_OFFLINE_FIXTURE"));
  } finally { await f.close(); }
});

test("review authorization is actor-bound, one-time, replay-safe, and expires", async () => {
  const f = await fixture();
  try {
    const alice = session(f.store, "LOCAL\\alice"); const bob = session(f.store, "LOCAL\\bob");
    const aliceTokens = f.store.issueAuthorizations(alice.sessionToken, now);
    const bobTokens = f.store.issueAuthorizations(bob.sessionToken, now);
    const caseId = "kit04-high-value-fraud";
    assert.throws(() => f.store.decide(bob.sessionToken, caseId, "APPROVE", aliceTokens.cases[caseId]!.approve, now), /REVIEW_AUTHORIZATION_INVALID/);
    assert.equal(f.store.decide(alice.sessionToken, caseId, "APPROVE", aliceTokens.cases[caseId]!.approve, now), "RECORDED");
    assert.throws(() => f.store.decide(alice.sessionToken, caseId, "APPROVE", aliceTokens.cases[caseId]!.approve, now), /REPLAYED/);
    assert.throws(() => f.store.decide(bob.sessionToken, "kit04-low-value-delivery", "APPROVE", bobTokens.cases["kit04-low-value-delivery"]!.approve, now + 5 * 60_000), /EXPIRED/);
    const recorded = f.store.dashboard().cases.find((item) => item.caseId === caseId)!.decision as Record<string, unknown>;
    assert.equal(recorded.actor, alice.actor);
  } finally { await f.close(); }
});

test("duplicate same-choice submissions are idempotent; contradictory choice is rejected", async () => {
  const f = await fixture();
  try {
    const operator = session(f.store, "operator-a");
    const first = f.store.issueAuthorizations(operator.sessionToken, now);
    const second = f.store.issueAuthorizations(operator.sessionToken, now + 1);
    const id = "kit04-low-value-delivery";
    assert.equal(f.store.decide(operator.sessionToken, id, "APPROVE", first.cases[id]!.approve, now + 2), "RECORDED");
    assert.equal(f.store.decide(operator.sessionToken, id, "APPROVE", second.cases[id]!.approve, now + 3), "ALREADY_RECORDED");
    assert.equal(f.store.decide(operator.sessionToken, id, "REJECT", first.cases[id]!.reject, now + 4), "CONFLICT");
    assert.equal(f.store.dashboard().history.filter((item) => item.case_id === id).length, 3);
  } finally { await f.close(); }
});

test("two separate operator processes cannot finalize the same case twice", async () => {
  const f = await fixture();
  try {
    const a = session(f.store, "LOCAL\\alice"); const b = session(f.store, "LOCAL\\bob");
    const tokensA = f.store.issueAuthorizations(a.sessionToken, now); const tokensB = f.store.issueAuthorizations(b.sessionToken, now);
    const worker = resolve("scripts/dispute-review-worker.ts");
    const run = (operator: typeof a, choice: "APPROVE" | "REJECT", authorization: string) => new Promise<string>((resolveOutput, reject) => {
      const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "--import", "tsx", worker, f.path], { stdio: ["pipe", "pipe", "pipe"] });
      let output = ""; let errors = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => { errors += chunk; });
      child.once("error", reject);
      child.once("close", (code) => code === 0 ? resolveOutput(output.trim()) : reject(new Error(`${errors} worker exited ${code}`)));
      child.stdin.end(JSON.stringify({ path: f.path, sessionToken: operator.sessionToken, caseId: "kit04-credit-not-processed", choice,
        authorization, now: now + 10 }));
    });
    const results = (await Promise.all([
      run(a, "APPROVE", tokensA.cases["kit04-credit-not-processed"]!.approve),
      run(b, "REJECT", tokensB.cases["kit04-credit-not-processed"]!.reject),
    ])).sort();
    assert.deepEqual(results, ["CONFLICT", "RECORDED"]);
    assert.equal(f.store.dashboard().cases.filter((item) => item.decision !== null).length, 1);
  } finally { await f.close(); }
});

test("decision and evidence persist after restart; crash before SQLite commit rolls back", async () => {
  const f = await fixture();
  try {
    const operator = session(f.store, "LOCAL\\reviewer");
    const auth = f.store.issueAuthorizations(operator.sessionToken, now);
    f.store.decide(operator.sessionToken, "kit04-low-value-delivery", "APPROVE", auth.cases["kit04-low-value-delivery"]!.approve, now);
    const countBefore = f.store.dashboard().history.length;
    const code = "import {DatabaseSync} from 'node:sqlite'; const d=new DatabaseSync(process.argv[1]); d.exec('BEGIN IMMEDIATE'); d.prepare(\"UPDATE review_settings SET dispute_fee_minor=7777 WHERE singleton=1\").run(); process.exit(0);";
    const crash = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", code, f.path], { encoding: "utf8", timeout: 10_000 });
    assert.equal(crash.status, 0);
    f.store.close();
    const reopened = await DisputeReviewStore.open(f.path);
    try {
      const data = reopened.dashboard();
      assert.equal(data.feeMinor, 2_500);
      assert.equal(data.history.length, countBefore);
      const accepted = data.cases.find((item) => item.caseId === "kit04-low-value-delivery")!;
      assert.ok(accepted.evidence.length > 0);
      assert.equal((accepted.decision as Record<string, unknown>).providerActionState, "NOT_EXECUTED");
      assert.equal((accepted.decision as Record<string, unknown>).refundState, "NOT_CONFIRMED");
    } finally { reopened.close(); }
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("fee updates persist, recalculate undecided recommendations, and invalid values fail closed", async () => {
  const f = await fixture();
  try {
    const operator = session(f.store, "operator-fee");
    const auth = f.store.issueAuthorizations(operator.sessionToken, now);
    assert.throws(() => f.store.setFee(operator.sessionToken, -1, auth.fee, now), /INVALID_DISPUTE_FEE/);
    assert.throws(() => f.store.setFee(operator.sessionToken, 10_000_001, auth.fee, now), /INVALID_DISPUTE_FEE/);
    f.store.setFee(operator.sessionToken, 3_500, auth.fee, now);
    const data = f.store.dashboard();
    assert.equal(data.feeMinor, 3_500);
    assert.ok(data.cases.every((item) => (item.recommendation as { disputeFeeMinor: number }).disputeFeeMinor === 3_500));
    assert.throws(() => f.store.setFee(operator.sessionToken, 3_600, auth.fee, now + 1), /FEE_AUTHORIZATION_INVALID/);
    f.store.close();
    const reopened = await DisputeReviewStore.open(f.path);
    try { assert.equal(reopened.dashboard().feeMinor, 3_500); }
    finally { reopened.close(); }
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("local RFI acceptance is only a review decision and never confirms a refund", async () => {
  const f = await fixture();
  try {
    const operator = session(f.store, "LOCAL\\reviewer"); const auth = f.store.issueAuthorizations(operator.sessionToken, now);
    f.store.decide(operator.sessionToken, "kit04-low-value-delivery", "APPROVE", auth.cases["kit04-low-value-delivery"]!.approve, now);
    const entry = f.store.dashboard().cases.find((item) => item.caseId === "kit04-low-value-delivery")!;
    assert.equal((entry.snapshot as { stage: string }).stage, "RFI");
    assert.equal((entry.recommendation as { action: string }).action, "ACCEPT");
    assert.equal((entry.decision as Record<string, unknown>).providerActionState, "NOT_EXECUTED");
    assert.equal((entry.decision as Record<string, unknown>).refundState, "NOT_CONFIRMED");
    assert.ok(f.store.dashboard().history.at(-1)!.note.toLowerCase().includes("no provider action"));
  } finally { await f.close(); }
});

test("durable future-live claim reserves an approval and action idempotency key once", async () => {
  const f = await fixture();
  try {
    const caseId = "kit04-high-value-fraud";
    assert.equal(f.store.claimProviderAction(caseId, "CHALLENGE", "operator", "approval-unique", "intent-action-1", now), true);
    assert.equal(f.store.claimProviderAction(caseId, "CHALLENGE", "operator", "approval-unique", "intent-action-1", now + 1), false);
    assert.equal(f.store.claimProviderAction(caseId, "CHALLENGE", "operator", "approval-new", "intent-action-2", now + 2), false);
    assert.equal(f.store.dashboard().history.filter((entry) => entry.event === "PROVIDER_ACTION_RESERVED").length, 1);
  } finally { await f.close(); }
});

test("missing and invalid evidence and invalid fee configuration fail closed", async () => {
  const scenarios = createKit04ReviewCases();
  const challenge = scenarios.find((item) => item.recommendation.action === "CHALLENGE")!;
  const noEvidence = { ...challenge.snapshot, evidence: [] };
  assert.equal(recommendDisputeAction(noEvidence).action, "ESCALATE_FOR_REVIEW");
  const invalidEvidence = { ...challenge.snapshot, evidence: challenge.snapshot.evidence.map((item) => ({ ...item, provenance: { ...item.provenance, reference: "" } })) };
  assert.equal(recommendDisputeAction(invalidEvidence).action, "NO_ACTION");
  assert.equal(recommendDisputeAction(challenge.snapshot, { ...DEFAULT_DISPUTE_ECONOMICS, disputeFeeMinor: -1 }).action, "NO_ACTION");
  const f = await fixture();
  try { await assert.rejects(DisputeReviewStore.open(join(f.dir, "invalid.sqlite"), 10_000_001), /INVALID_DISPUTE_FEE/); }
  finally { await f.close(); }
});

test("offline provider is deterministic, LIVE fails closed, and neither mode makes network requests", async () => {
  const originalFetch = globalThis.fetch; let fetches = 0;
  globalThis.fetch = async () => { fetches++; throw new Error("unexpected network"); };
  try {
    const mock = new MockDisputeProviderAdapter({ example: { stage: "RFI", status: "REQUIRES_RESPONSE" } }, () => now);
    assert.deepEqual(await mock.retrieveStatus("example"), { caseId: "example", source: "MOCK_FIXTURE", available: true, stage: "RFI", status: "REQUIRES_RESPONSE", retrievedAt: now });
    assert.equal((await mock.executeAction({ caseId: "example", action: "ACCEPT", idempotencyKey: "mock-1" })).providerConfirmed, false);
    const live = createDisputeProviderAdapter("LIVE");
    await assert.rejects(live.retrieveStatus("example"), /LIVE_PROVIDER_DISABLED/);
    await assert.rejects(live.executeAction({ caseId: "example", action: "ACCEPT", idempotencyKey: "live-1" }), /LIVE_PROVIDER_DISABLED/);
    assert.throws(() => createDisputeProviderAdapter("something-else"), /DISPUTE_PROVIDER_MODE_INVALID/);
    assert.equal(fetches, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test("future live gate rejects unavailable, mocked, stale, unknown, mismatched, unapproved, missing-evidence and replayed states", () => {
  const scenario = createKit04ReviewCases().find((item) => item.recommendation.action === "CHALLENGE")!;
  const evidence = scenario.snapshot.evidence;
  const approval = { approvalId: "approval-1", caseId: scenario.snapshot.caseId, action: "CHALLENGE" as const, actor: "LOCAL\\operator", approvedAt: now - 10, expiresAt: now + 10_000,
    snapshotFingerprint: fingerprintDisputeDecision({ ...scenario.snapshot, responseDeadline: new Date(now + 72 * 60 * 60_000).toISOString() }, scenario.recommendation, scenario.snapshot.evidence) };
  const base: LiveActionGateInput = { separatelyAuthorized: true, configured: true, expectedActor: "LOCAL\\operator", snapshot: { ...scenario.snapshot, responseDeadline: new Date(now + 72 * 60 * 60_000).toISOString() },
    recommendation: scenario.recommendation, providerReceipt: { caseId: scenario.snapshot.caseId, source: "AIRWALLEX_AUTHENTICATED", available: true,
      stage: scenario.snapshot.stage, status: scenario.snapshot.status, retrievedAt: now - 10, snapshotFingerprint: approval.snapshotFingerprint }, approval, evidence, consumedApprovalIds: new Set(), idempotencyKey: "provider-action-1", usedIdempotencyKeys: new Set(), now };
  assert.deepEqual(validateLiveActionGate(base), []);
  assert.ok(validateLiveActionGate({ ...base, separatelyAuthorized: false }).includes("LIVE_NOT_SEPARATELY_AUTHORIZED"));
  assert.ok(validateLiveActionGate({ ...base, providerReceipt: { ...base.providerReceipt, source: "MOCK_FIXTURE" } }).includes("LIVE_PROVIDER_STATUS_UNAVAILABLE"));
  assert.ok(validateLiveActionGate({ ...base, providerReceipt: { ...base.providerReceipt, available: false } }).includes("LIVE_PROVIDER_STATUS_UNAVAILABLE"));
  assert.ok(validateLiveActionGate({ ...base, providerReceipt: { ...base.providerReceipt, retrievedAt: now - 60_000 } }).includes("PROVIDER_RECEIPT_STALE"));
  assert.ok(validateLiveActionGate({ ...base, providerReceipt: { ...base.providerReceipt, status: "UNKNOWN" } }).includes("PROVIDER_STATE_MISMATCH"));
  assert.ok(validateLiveActionGate({ ...base, approval: { ...approval, actor: "LOCAL\\other" } }).includes("HUMAN_APPROVAL_INVALID"));
  assert.ok(validateLiveActionGate({ ...base, consumedApprovalIds: new Set([approval.approvalId]) }).includes("HUMAN_APPROVAL_INVALID"));
  assert.ok(validateLiveActionGate({ ...base, evidence: [] }).includes("REQUIRED_EVIDENCE_MISSING_OR_UNVERIFIED"));
  assert.ok(validateLiveActionGate({ ...base, usedIdempotencyKeys: new Set(["provider-action-1"]) }).includes("ACTION_IDEMPOTENCY_CONFLICT"));
});

test("local dashboard rejects missing authentication, invalid origin, content type, and CSRF", async () => {
  const f = await fixture();
  try {
    const handler = createDisputeReviewHandler({ store: f.store, operatorToken, actor: "LOCAL\\operator", origin, providerMode: "MOCK", now: () => now, bootstrapCsrf: "test-csrf" });
    const unauthorized = await call(handler, "GET", "/api/dashboard"); assert.equal(unauthorized.status, 401);
    const badOrigin = await call(handler, "POST", "/api/session", { operatorToken }, { origin: "https://attacker.example", "content-type": "application/json", "x-csrf-token": "test-csrf" });
    assert.equal(badOrigin.status, 403);
    const badType = await call(handler, "POST", "/api/session", { operatorToken }, { origin, "content-type": "text/plain", "x-csrf-token": "test-csrf" });
    assert.equal(badType.status, 415);
    const badCsrf = await call(handler, "POST", "/api/session", { operatorToken }, { origin, "content-type": "application/json", "x-csrf-token": "wrong" });
    assert.equal(badCsrf.status, 403);
    const login = await call(handler, "POST", "/api/session", { operatorToken }, { origin, "content-type": "application/json", "x-csrf-token": "test-csrf" });
    assert.equal(login.status, 200);
    assert.ok(String(login.headers?.["set-cookie"]).includes("HttpOnly"));
    assert.ok(String(login.headers?.["set-cookie"]).includes("SameSite=Strict"));
    assert.ok(String(login.headers?.["set-cookie"]).includes("Secure"));
    const cookie = String(login.headers?.["set-cookie"]).split(";")[0]!;
    const csrfToken = String(login.json.csrfToken);
    const authorizedSession = await call(handler, "GET", "/api/session", undefined, { cookie });
    assert.equal(authorizedSession.status, 200);
    assert.equal(authorizedSession.json.csrfToken, csrfToken);
    const mutationHeaders = { origin, cookie, "content-type": "application/json", "x-csrf-token": csrfToken };
    const authz = await call(handler, "POST", "/api/authorizations", {}, mutationHeaders);
    assert.equal(authz.status, 200);
    const caseId = "kit04-low-value-delivery";
    const tokens = authz.json.cases as Record<string, { approve: string }>;
    const decision = await call(handler, "POST", "/api/review", { caseId, choice: "APPROVE", authorization: tokens[caseId]!.approve }, mutationHeaders);
    assert.equal(decision.status, 200);
    assert.equal(decision.json.providerActionState, "NOT_EXECUTED");
    assert.equal(decision.json.refundState, "NOT_CONFIRMED");
    const page = await call(handler, "GET", "/api/dashboard", undefined, { cookie });
    assert.equal(page.status, 200);
    assert.equal(page.json.providerActionEnabled, false);
    const accepted = (page.json.dashboard as { cases: Array<{ caseId: string; decision: { providerActionState: string } }> }).cases.find((item) => item.caseId === caseId)!;
    assert.equal(accepted.decision.providerActionState, "NOT_EXECUTED");
  } finally { await f.close(); }
});

test("mocked lifecycle independently marks issuer rejection and chargeback; no provider result is asserted", () => {
  const lifecycle = createKit04OfflineLifecycle();
  assert.equal(lifecycle.simulated, true);
  assert.equal(lifecycle.stage, "CHARGEBACK");
  assert.equal(lifecycle.status, "REQUIRES_RESPONSE");
  assert.ok(lifecycle.events.every((event) => event.source === "SIMULATED_OFFLINE_FIXTURE"));
});

test("snapshot-bound local token refuses altered case content without revision bump", async () => {
  const f = await fixture();
  try {
    const operator = session(f.store, "LOCAL\\reviewer");
    const token = f.store.issueAuthorizations(operator.sessionToken, now).cases["kit04-high-value-fraud"]!.approve;
    const code = [
      "import { DatabaseSync } from \"node:sqlite\";",
      "const db = new DatabaseSync(process.argv[1]);",
      "const row = db.prepare(\"SELECT snapshot_json FROM review_cases WHERE case_id=?\").get(\"kit04-high-value-fraud\");",
      "const value = JSON.parse(row.snapshot_json); value.amountMinor += 100;",
      "db.prepare(\"UPDATE review_cases SET snapshot_json=? WHERE case_id=?\").run(JSON.stringify(value), \"kit04-high-value-fraud\");",
      "db.close();",
    ].join("\n");
    const altered = spawnSync(process.execPath, ["--input-type=module", "-e", code, f.path], { encoding: "utf8", timeout: 10_000 });
    assert.equal(altered.status, 0, altered.stderr);
    assert.throws(() => f.store.decide(operator.sessionToken, "kit04-high-value-fraud", "APPROVE", token, now + 1), /REVIEW_SNAPSHOT_MISMATCH/);
    assert.equal(f.store.dashboard().cases.filter((c) => c.decision).length, 0);
  } finally { await f.close(); }
});

test("legacy tokens with no snapshot fingerprint fail closed", async () => {
  const f = await fixture();
  try {
    const operator = session(f.store, "LOCAL\\reviewer");
    const token = f.store.issueAuthorizations(operator.sessionToken, now).cases["kit04-low-value-delivery"]!.approve;
    const code = "import { DatabaseSync } from \"node:sqlite\"; const db=new DatabaseSync(process.argv[1]); db.prepare(\"UPDATE review_tokens SET case_fingerprint=NULL WHERE case_id=?\").run(\"kit04-low-value-delivery\"); db.close();";
    const edited = spawnSync(process.execPath, ["--input-type=module", "-e", code, f.path], { encoding: "utf8", timeout: 10_000 });
    assert.equal(edited.status, 0, edited.stderr);
    assert.throws(() => f.store.decide(operator.sessionToken, "kit04-low-value-delivery", "APPROVE", token, now + 1), /REVIEW_SNAPSHOT_MISMATCH/);
  } finally { await f.close(); }
});

test("new local approval token issued after the response deadline still refuses stale recommendation", async () => {
  const f = await fixture();
  try {
    const late = now + 80 * 60 * 60_000;
    const reviewer = session(f.store, "LOCAL\\late", late);
    const token = f.store.issueAuthorizations(reviewer.sessionToken, late).cases["kit04-high-value-fraud"]!.approve;
    assert.throws(() => f.store.decide(reviewer.sessionToken, "kit04-high-value-fraud", "APPROVE", token, late), /REVIEW_RECOMMENDATION_STALE_OR_NOT_ACTIONABLE/);
    assert.equal(f.store.dashboard().cases.filter((c) => c.decision).length, 0);
  } finally { await f.close(); }
});

test("future-live gate binds actor-approved content and provider snapshot fingerprint", () => {
  const scenario = createKit04ReviewCases(2_500, now).find((c) => c.recommendation.action === "CHALLENGE")!;
  const fingerprint = fingerprintDisputeDecision(scenario.snapshot, scenario.recommendation);
  const approval = { approvalId: "bound-approval", caseId: scenario.snapshot.caseId, actor: "operator", action: "CHALLENGE" as const,
    approvedAt: now - 10, expiresAt: now + 10_000, snapshotFingerprint: fingerprint };
  const receipt = { caseId: scenario.snapshot.caseId, source: "AIRWALLEX_AUTHENTICATED" as const, available: true,
    stage: scenario.snapshot.stage, status: scenario.snapshot.status, retrievedAt: now, snapshotFingerprint: fingerprint };
  const base: LiveActionGateInput = { separatelyAuthorized: true, configured: true, expectedActor: "operator", snapshot: scenario.snapshot,
    recommendation: scenario.recommendation, providerReceipt: receipt, approval, evidence: scenario.snapshot.evidence,
    consumedApprovalIds: new Set(), idempotencyKey: "bound-1", usedIdempotencyKeys: new Set(), now };
  assert.deepEqual(validateLiveActionGate(base), []);
  for (const changed of [
    { ...scenario.snapshot, amountMinor: scenario.snapshot.amountMinor + 1 },
    { ...scenario.snapshot, currency: "EUR" },
    { ...scenario.snapshot, reasonCode: "13.1" },
    { ...scenario.snapshot, responseDeadline: new Date(now + 48 * 60 * 60_000).toISOString() },
    { ...scenario.snapshot, evidence: scenario.snapshot.evidence.map((e, i) => i ? e : { ...e, summary: "CHANGED" }) },
  ]) {
    const codes = validateLiveActionGate({ ...base, snapshot: changed, evidence: changed.evidence });
    assert.ok(codes.includes("APPROVAL_SNAPSHOT_MISMATCH"), JSON.stringify(codes));
    assert.ok(codes.includes("PROVIDER_SNAPSHOT_MISMATCH"), JSON.stringify(codes));
  }
  assert.ok(validateLiveActionGate({ ...base, approval: { ...approval, snapshotFingerprint: undefined } }).includes("APPROVAL_SNAPSHOT_MISMATCH"));
  assert.ok(validateLiveActionGate({ ...base, providerReceipt: { ...receipt, snapshotFingerprint: undefined } }).includes("PROVIDER_SNAPSHOT_MISMATCH"));
});

test("existing pre-upgrade SQLite token schema migrates additively", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fair-trial-legacy-"));
  const path = join(dir, "legacy.sqlite");
  try {
    const code = [
      "import { DatabaseSync } from \"node:sqlite\";",
      "const db=new DatabaseSync(process.argv[1]);",
      "db.exec(\"CREATE TABLE review_tokens(token_hash TEXT PRIMARY KEY,session_hash TEXT NOT NULL,case_id TEXT NOT NULL,actor TEXT NOT NULL,action TEXT NOT NULL,revision INTEGER NOT NULL,expires_at INTEGER NOT NULL,consumed_at INTEGER)\");",
      "db.close();" 
    ].join("\n");
    const made = spawnSync(process.execPath, ["--input-type=module", "-e", code, path], { encoding: "utf8", timeout: 10_000 });
    assert.equal(made.status, 0, made.stderr);
    const store = await DisputeReviewStore.open(path, undefined, now);
    try {
      const operator = session(store, "LOCAL\\migrated");
      const token = store.issueAuthorizations(operator.sessionToken, now).cases["kit04-high-value-fraud"]!.approve;
      assert.equal(store.decide(operator.sessionToken, "kit04-high-value-fraud", "APPROVE", token, now), "RECORDED");
    } finally { store.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("NO_ACTION cannot be approved locally, but can be explicitly rejected", async () => {
  const f = await fixture();
  try {
    const id = "kit04-high-value-fraud";
    const current = f.store.dashboard().cases.find((c) => c.caseId === id)!;
    const snapshot = { ...(current.snapshot as import("../spike/dispute-engine.ts").DisputeSnapshot), responseDeadline: undefined };
    const recommendation = recommendDisputeAction(snapshot, DEFAULT_DISPUTE_ECONOMICS, now);
    assert.equal(recommendation.action, "NO_ACTION");
    const code = [
      "import { DatabaseSync } from \"node:sqlite\";",
      "import fs from \"node:fs\";",
      "const payload=JSON.parse(fs.readFileSync(0,\"utf8\"));",
      "const db=new DatabaseSync(process.argv[1]);",
      "db.prepare(\"UPDATE review_cases SET snapshot_json=?,recommendation_json=? WHERE case_id=?\").run(JSON.stringify(payload.snapshot), JSON.stringify(payload.recommendation), payload.id);",
      "db.close();" 
    ].join("\n");
    const edited = spawnSync(process.execPath, ["--input-type=module", "-e", code, f.path], { encoding: "utf8", timeout: 10_000, input: JSON.stringify({ id, snapshot, recommendation }) });
    assert.equal(edited.status, 0, edited.stderr);
    const operator = session(f.store, "LOCAL\\reviewer");
    const tokens = f.store.issueAuthorizations(operator.sessionToken, now).cases[id]!;
    assert.throws(() => f.store.decide(operator.sessionToken, id, "APPROVE", tokens.approve, now), /REVIEW_RECOMMENDATION_STALE_OR_NOT_ACTIONABLE/);
    assert.equal(f.store.decide(operator.sessionToken, id, "REJECT", tokens.reject, now), "RECORDED");
  } finally { await f.close(); }
});
