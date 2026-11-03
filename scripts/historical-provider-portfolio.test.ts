import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { loadHistoricalProviderPortfolio } from "../spike/historical-provider-portfolio.ts";
import { DisputeReviewStore } from "../spike/dispute-review-store.ts";
import { createDisputeReviewHandler } from "../spike/dispute-review-server.ts";

const now = Date.parse("2026-11-02T10:00:00Z");
const origin = "http://127.0.0.1:4243";
const source = resolve("submission/evidence");
const names = ["ft044a-sandbox-dispute-accepted.json", "ft050a-visa-rfi-sandbox-proof.json"];

async function scratch(): Promise<string> {
  const tmp = await mkdtemp(join(tmpdir(), "ft054-provider-portfolio-"));
  await mkdir(join(tmp, "submission/evidence"), { recursive: true });
  for (const name of names) await writeFile(join(tmp, "submission/evidence", name), await readFile(join(source, name)));
  return tmp;
}
test("FT054 validated historical provider portfolio: two distinct real Sandbox receipt paths, zero agent actions", async () => {
  const result = await loadHistoricalProviderPortfolio();
  assert.equal(result.schema, "fair-trial-historical-provider-portfolio/v1");
  assert.equal(result.classification, "HISTORICAL_OWNER_EXECUTED_SANDBOX_SNAPSHOTS");
  assert.equal(result.freshProviderRead, false);
  assert.equal(result.providerNetworkCalls, 0);
  assert.equal(result.providerMutations, 0);
  assert.equal(result.actionInterface, "READ_ONLY_NO_ACTION_ENDPOINT");
  assert.equal(result.cases.length, 2);
  const visa = result.cases[0]!;
  const mastercard = result.cases[1]!;
  assert.equal(visa.caseKey, "historical-visa-fraud-rfi");
  assert.equal(visa.providerStatus, "REQUIRES_RESPONSE");
  assert.equal(visa.localRecommendation, "HOLD_REQUEST_EVIDENCE");
  assert.equal(visa.localRecommendationIsProviderStatus, false);
  assert.equal(visa.responseDeadline, "2026-11-09T05:55:12.0000000Z");
  assert.equal(visa.evidenceGaps.length, 4);
  assert.equal(visa.challengeSubmitted, false);
  assert.equal(mastercard.caseKey, "historical-mastercard-accepted");
  assert.equal(mastercard.providerStatus, "ACCEPTED");
  assert.equal(mastercard.actionOrigin, "SEPARATELY_OWNER_EXECUTED");
  assert.equal(mastercard.refundSettlementVerified, false);
  assert.equal(mastercard.agentProviderAction, "NOT_EXECUTED");
  assert.equal(result.sourceDigests.length, 2);
  assert.doesNotMatch(JSON.stringify(result), /client_secret|api_key|testCardLast4|orderFingerprint/i);
});
test("FT054 refuses tampered, missing, and mislinked provider receipts", async () => {
  const tmp = await scratch();
  try {
    const valid = await loadHistoricalProviderPortfolio(tmp);
    assert.equal(valid.cases.length, 2);
    const file = join(tmp, "submission/evidence", names[1]!);
    const raw = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    const dispute = raw.dispute as Record<string, unknown>;
    dispute.status = "ACCEPTED";
    await writeFile(file, JSON.stringify(raw));
    await assert.rejects(loadHistoricalProviderPortfolio(tmp), /HISTORICAL_PORTFOLIO_EVIDENCE_MISMATCH/);
    await rm(file);
    await assert.rejects(loadHistoricalProviderPortfolio(tmp), /ENOENT/);
  } finally { await rm(tmp, { recursive: true, force: true }); }
});
test("FT054 authenticated dashboard includes read-only receipts; no provider portfolio action route", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ft054-provider-api-"));
  const operatorToken = randomBytes(40).toString("base64url");
  const store = await DisputeReviewStore.open(join(dir, "db.sqlite"), undefined, now);
  const actor = "LOCAL\\portfolio-reviewer";
  const session = randomBytes(32).toString("base64url");
  const csrf = randomBytes(32).toString("base64url");
  store.createSession(session, csrf, actor, now);
  const handler = createDisputeReviewHandler({ store, operatorToken, actor, origin, providerMode: "MOCK", now: () => now });
  async function request(method: string, path: string, authorized: boolean) {
    const req = Readable.from([]) as unknown as IncomingMessage;
    Object.assign(req, { method, url: path, headers: { host: "127.0.0.1:4243",
      ...(authorized ? { cookie: "dispute_review_session=" + session } : {}) } });
    let status = 0; let body = "";
    const res = { writeHead(n: number) { status = n; return this; }, end(text?: string) { body = text ?? ""; } } as unknown as ServerResponse;
    await handler(req, res);
    return { status, body };
  }
  try {
    const unauth = await request("GET", "/api/dashboard", false);
    assert.equal(unauth.status, 401);
    const auth = await request("GET", "/api/dashboard", true);
    assert.equal(auth.status, 200, auth.body.slice(0, 120));
    const payload = JSON.parse(auth.body) as Record<string, any>;
    assert.equal(payload.providerPortfolio.cases.length, 2);
    assert.equal(payload.providerActionEnabled, false);
    assert.equal(payload.visa104Preflight.schema, "FT055_VISA_104_OFFLINE_PREFLIGHT_V1");
    assert.equal(payload.visa104Preflight.allowed, false);
    assert.equal(payload.visa104Preflight.providerAction, "NOT_EXECUTED");
    assert.ok(payload.visa104Preflight.reasons.includes("FILE_SERVICE_UPLOAD_AND_READBACK_EVIDENCE_MISSING"));
    assert.ok(payload.visa104Preflight.reasons.includes("PROVIDER_EXECUTION_NOT_IMPLEMENTED"));
    assert.equal(payload.providerPortfolio.providerMutations, 0);
    const page = await request("GET", "/", false);
    assert.equal(page.status, 200);
    assert.match(page.body, /providerPortfolioList/);
    assert.match(page.body, /visa104Gate/);
    assert.match(page.body, /function renderHistoricalPortfolio/);
    const action = await request("POST", "/api/provider-portfolio/action", true);
    assert.equal(action.status, 404);
    const rejectAction = await request("POST", "/api/visa104/challenge", true);
    assert.equal(rejectAction.status, 404);
    assert.doesNotMatch(auth.body, /"api_key"|"client_secret"/);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});
