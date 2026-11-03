import test from "node:test";
import assert from "node:assert/strict";
import {judgeEvidenceBriefHtml,FT067_PROVIDER_RECEIPT_SHA256,
 FT067_PROVIDER_OBSERVED_UTC,FT067_PROVIDER_DEADLINE_UTC} from "../spike/judge-evidence-brief.ts";
test("judge brief is authentication-gated and provenance snapshot is explicit",()=>{
 const s=judgeEvidenceBriefHtml();
 assert.match(s,/<section id="judgeEvidenceBrief" hidden /);
 assert.match(s,/HISTORICAL SNAPSHOT/);
 assert.match(s,/NO LIVE REFRESH/);
 assert.match(s,/Not a provider status/);
 assert.match(s,/No challenge or upload/);
 assert.match(s,/Demo material is synthetic/);
});
test("historical FT064 public receipt is pinned without raw identifiers",()=>{
 assert.equal(FT067_PROVIDER_RECEIPT_SHA256,"98f5a627cf2b2d3a16875652a37b7856f2be2f7927c5ca4e882659460c891909");
 assert.equal(FT067_PROVIDER_OBSERVED_UTC,"2026-11-02T23:50:31.968Z");
 assert.equal(FT067_PROVIDER_DEADLINE_UTC,"2026-11-09T05:55:12.000Z");
 const s=judgeEvidenceBriefHtml();
 assert.doesNotMatch(s,/Bearer |x-api-key|x-client-id|payment_intent_id|dispute_id/i);
 assert.match(s,/FT-064/);
});
test("provider facts, evidence gaps and review action are separate accessible regions",()=>{
 const s=judgeEvidenceBriefHtml();
 assert.match(s,/aria-label="Confirmed from Sandbox"/);
 assert.match(s,/aria-label="Evidence provenance gaps"/);
 assert.match(s,/aria-label="Next safe action"/);
 assert.match(s,/REQUIRES_RESPONSE/);
 assert.match(s,/APPLICATION DECISION/);
 assert.match(s,/merchant order/);
 assert.match(s,/No challenge or upload/);
});
