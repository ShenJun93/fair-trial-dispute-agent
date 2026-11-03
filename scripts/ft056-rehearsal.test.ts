import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp,readFile,writeFile,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mockPlanDigest,buildMockStandardChallenge,type MockChallengePlan } from "../spike/ft056-standard-challenge.ts";
import { inspectMockJournal,runMockVisa104Rehearsal,type MockOwnerConsent } from "../spike/ft056-rehearsal.ts";
const now=Date.parse("2026-11-02T12:00:00Z");
const hash=(s:string)=>createHash("sha256").update(s).digest("hex");
const plan=():MockChallengePlan=>({
 caseKey:"mock_case_visa104",
 disputeId:"mock_dst_visa104a",
 dueAt:"2026-11-09T05:55:12Z",stage:"RFI",status:"REQUIRES_RESPONSE",
 reasonCode:"10.4",currency:"USD",amountMinor:12000,
 documents:[
  {type:"PRIMARY",fileId:"mock_file_proof_01",sourceHash:hash("sample-fixture-proof"),
    description:"Synthetic authenticated transaction fixture",synthetic:true},
  {type:"CUSTOMER",fileId:"mock_file_customer_02",sourceHash:hash("sample-fixture-customer"),
    description:"Synthetic customer correspondence fixture",synthetic:true},
 ]
});
function consent(p:MockChallengePlan):MockOwnerConsent {
 return {action:"MOCK_CHALLENGE",caseDigest:mockPlanDigest(p),
  owner:"mock_owner_local",issuedAt:now-1000,expiresAt:now+90_000,consumed:false};
}
async function withScratch(fn:(dir:string)=>Promise<void>){
 const dir=await mkdtemp(join(tmpdir(),"ft056-mock-only-"));
 try{await fn(dir)}finally{await rm(dir,{recursive:true,force:true})}
}
test("official STANDARD RFI challenge request structure generated only with explicit mock IDs",()=>{
 const p=plan();const body=buildMockStandardChallenge(p,now,"mock_owner_local");
 assert.deepEqual(Object.keys(body).sort(),["challenge_method","challenged_by","reason","request_id","supporting_documents"]);
 assert.equal(body.challenge_method,"STANDARD");
 assert.equal(body.reason,"OTHER_REASONS");
 assert.equal(body.supporting_documents.documents.length,2);
 assert.equal(body.supporting_documents.documents[0]?.type,"PRIMARY");
 assert.ok(body.supporting_documents.documents.every(d=>d.file_ids.every(id=>id.startsWith("mock_file_"))));
 assert.equal("evidence" in body,false);
 assert.equal(JSON.stringify(body).includes("api-demo.airwallex"),false);
});
test("real-looking IDs and spoofed non-mock evidence fail before any dispatch",()=>{
 const p=plan();p.disputeId="dst_live_explicit" as typeof p.disputeId;
 assert.throws(()=>buildMockStandardChallenge(p,now,"mock_owner_local"),/MOCK_CHALLENGE_PLAN_REJECTED/);
 p.disputeId="mock_dst_visa104a";p.documents=[{...p.documents[0]!,fileId:"file_real_2026"}];
 assert.throws(()=>buildMockStandardChallenge(p,now,"mock_owner_local"),/MOCK_CHALLENGE_PLAN_REJECTED/);
});
test("rehearsal completes mock preGET → one fake POST → mock postGET and durable fence",async()=>withScratch(async journalDir=>{
 const p=plan(),first=await runMockVisa104Rehearsal({plan:p,consent:consent(p),now,journalDir});
 assert.equal(first.execution,"SIMULATED_ONLY");
 assert.equal(first.simulatedGetCount,2);
 assert.equal(first.simulatedPostCount,1);
 assert.equal(first.realProviderCalls,0);
 assert.equal(first.realFinancialMutations,0);
 assert.equal(first.readback,"MOCK_CHALLENGED");
 assert.equal(first.journalState,"SIMULATED_CONFIRMED");
 assert.equal((await inspectMockJournal(journalDir,p))?.state,"SIMULATED_CONFIRMED");
 const second=await runMockVisa104Rehearsal({plan:p,consent:consent(p),now,journalDir});
 assert.equal(second.execution,"BLOCKED");
 assert.equal(second.simulatedPostCount,0);
 assert.ok(second.failureReasons.includes("DURABLE_CASE_FENCE_ALREADY_EXISTS"));
}));
test("concurrent approvals cannot execute mock POST twice for the same case",async()=>withScratch(async journalDir=>{
 const p=plan();const both=await Promise.all(Array.from({length:8},()=>runMockVisa104Rehearsal({plan:p,consent:consent(p),now,journalDir})));
 assert.equal(both.filter(x=>x.execution==="SIMULATED_ONLY").length,1);
 assert.equal(both.reduce((s,x)=>s+x.simulatedPostCount,0),1);
 assert.equal(both.every(x=>x.realFinancialMutations===0),true);
}));
test("missing, expired or changed owner consent blocks without reserving a case",async()=>withScratch(async journalDir=>{
 const p=plan();
 const missing=await runMockVisa104Rehearsal({plan:p,now,journalDir});
 assert.equal(missing.execution,"BLOCKED");
 const bad=consent(p);bad.expiresAt=now;
 const expired=await runMockVisa104Rehearsal({plan:p,consent:bad,now,journalDir});
 assert.equal(expired.simulatedPostCount,0);
 const modified=consent(p);p.documents=[...p.documents,{...p.documents[0]!,fileId:"mock_file_new_0009"}];
 const change=await runMockVisa104Rehearsal({plan:p,consent:modified,now,journalDir});
 assert.equal(change.execution,"BLOCKED");
 assert.equal(await inspectMockJournal(journalDir,p),null);
}));
test("ambiguous timeout after mock POST never auto-retries and requires manual reconciliation",async()=>withScratch(async journalDir=>{
 const p=plan();
 const first=await runMockVisa104Rehearsal({plan:p,consent:consent(p),now,journalDir,failure:"TIMEOUT_AFTER_MOCK_POST"});
 assert.equal(first.execution,"AMBIGUOUS");
 assert.equal(first.simulatedPostCount,1);
 assert.equal(first.journalState,"RECONCILE_REQUIRED");
 const second=await runMockVisa104Rehearsal({plan:p,consent:consent(p),now,journalDir});
 assert.equal(second.execution,"BLOCKED");
 assert.equal(second.simulatedPostCount,0);
 assert.equal((await inspectMockJournal(journalDir,p))?.state,"RECONCILE_REQUIRED");
}));
test("timeout before mock POST still reserves case; no unsafe retry",async()=>withScratch(async journalDir=>{
 const p=plan();
 const first=await runMockVisa104Rehearsal({plan:p,consent:consent(p),now,journalDir,failure:"TIMEOUT_BEFORE_MOCK_POST"});
 assert.equal(first.simulatedPostCount,0);
 assert.equal(first.execution,"AMBIGUOUS");
 assert.equal((await runMockVisa104Rehearsal({plan:p,consent:consent(p),now,journalDir})).execution,"BLOCKED");
}));
test("failed mock postGET is not misreported as confirmed",async()=>withScratch(async journalDir=>{
 const p=plan();
 const r=await runMockVisa104Rehearsal({plan:p,consent:consent(p),now,journalDir,failure:"READBACK_UNAVAILABLE"});
 assert.equal(r.readback,"NOT_AVAILABLE");assert.equal(r.execution,"AMBIGUOUS");
 assert.equal(r.journalState,"RECONCILE_REQUIRED");
}));
test("synthetic issuer rejection causes human replan, never automatic second challenge",async()=>withScratch(async journalDir=>{
 const p=plan();
 const r=await runMockVisa104Rehearsal({plan:p,consent:consent(p),now,journalDir,simulateIssuerRejection:true});
 assert.equal(r.execution,"SIMULATED_ONLY");
 assert.equal(r.simulatedIssuerOutcome,"MOCK_PRE_ARBITRATION_LOST");
 assert.equal(r.replan,"HUMAN_REVIEW_NO_AUTOMATIC_RECHALLENGE");
 assert.equal(r.simulatedPostCount,1);
 assert.equal(r.simulatedGetCount,3);
}));
test("tampered journal never becomes authorization for reuse",async()=>withScratch(async journalDir=>{
 const p=plan(),r=await runMockVisa104Rehearsal({plan:p,consent:consent(p),now,journalDir});
 assert.equal(r.execution,"SIMULATED_ONLY");
 const {readdir}=await import("node:fs/promises");const files=await readdir(journalDir);
 assert.equal(files.length,1);
 const file=join(journalDir,files[0]!);
 const existing=JSON.parse(await readFile(file,"utf8"));
 await writeFile(file,JSON.stringify({...existing,caseDigest:hash("tamper")}));
 await assert.rejects(inspectMockJournal(journalDir,p),/JOURNAL_CORRUPTED_OR_PLAN_CHANGED/);
 const next=await runMockVisa104Rehearsal({plan:p,consent:consent(p),now,journalDir});
 assert.equal(next.execution,"BLOCKED");
}));
test("evidence gap in real FT055 remains closed and cannot be bypassed by mock rehearsal",async()=>{
 const {evaluateVisa104OfflinePreflight}=await import("../spike/visa104-safe-contract.ts");
 const {loadHistoricalProviderPortfolio}=await import("../spike/historical-provider-portfolio.ts");
 const {visa104FromHistoricalCase}=await import("../spike/visa104-safe-contract.ts");
 const portfolio=await loadHistoricalProviderPortfolio();
 const r=evaluateVisa104OfflinePreflight({identity:visa104FromHistoricalCase(portfolio.cases[0]!),
   evidence:[],dispatchState:"NONE",alreadySubmitted:false,ce30Claimed:false,now});
 assert.equal(r.allowed,false);
 assert.ok(r.reasons.includes("PROVIDER_EXECUTION_NOT_IMPLEMENTED"));
});
