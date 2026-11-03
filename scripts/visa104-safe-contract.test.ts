import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { loadHistoricalProviderPortfolio } from "../spike/historical-provider-portfolio.ts";
import { evaluateVisa104OfflinePreflight, visa104FromHistoricalCase, visa104ReviewDigest,
  type Visa104Evidence, type Visa104Preflight } from "../spike/visa104-safe-contract.ts";

const now=Date.parse("2026-11-02T12:00:00Z");
const h=(s:string)=>createHash("sha256").update(s).digest("hex");
async function baseline():Promise<Visa104Preflight>{
 const portfolio=await loadHistoricalProviderPortfolio();
 return {identity:visa104FromHistoricalCase(portfolio.cases[0]!),evidence:[],
   dispatchState:"NONE",alreadySubmitted:false,ce30Claimed:false,now};
}
function signals():Visa104Evidence[]{
 return [
  {category:"CARDHOLDER_AUTHORIZATION",classification:"VERIFIED",sourceSha256:h("auth"),
   sourceReference:"attested-source:auth",contradictsCase:false},
  {category:"TRANSACTION_DETAILS",classification:"VERIFIED",sourceSha256:h("transaction"),
   sourceReference:"attested-source:transaction",contradictsCase:false},
  {category:"FULFILLMENT",classification:"VERIFIED",sourceSha256:h("delivery"),
   sourceReference:"attested-source:delivery",contradictsCase:false},
 ];
}
const withOwnerApproval=(x:Visa104Preflight)=>({
 action:"CHALLENGE" as const, identityAndEvidenceDigest:visa104ReviewDigest(x.identity,x.evidence),
 actor:"local-owner",approvalId:"owner-approval",approvedAt:now-1000,expiresAt:now+60_000,consumed:false,
});
test("historical Visa 10.4 is readable but never executable; reports missing evidence + fresh read",async()=>{
 const x=await baseline();
 const y=evaluateVisa104OfflinePreflight(x);
 assert.equal(y.allowed,false);
 assert.equal(y.providerAction,"NOT_EXECUTED");
 assert.equal(y.providerCallCount,0);
 assert.equal(y.evidenceUploadCount,0);
 assert.equal(y.draftChallengePayload,null);
 assert.equal(y.ce30Certified,false);
 assert.ok(y.reasons.includes("VERIFIED_AUTHORIZATION_EVIDENCE_MISSING"));
 assert.ok(y.reasons.includes("VERIFIED_TRANSACTION_EVIDENCE_MISSING"));
 assert.ok(y.reasons.includes("INDEPENDENT_FULFILLMENT_OR_CUSTOMER_SIGNAL_MISSING"));
 assert.ok(y.reasons.includes("FILE_SERVICE_UPLOAD_AND_READBACK_EVIDENCE_MISSING"));
 assert.ok(y.reasons.includes("FRESH_MATCHED_PROVIDER_READ_REQUIRED"));
 assert.ok(y.reasons.includes("ACTION_SPECIFIC_OWNER_APPROVAL_REQUIRED"));
 assert.ok(y.reasons.includes("PROVIDER_EXECUTION_NOT_IMPLEMENTED"));
 assert.equal(x.identity.reasonCode,"10.4");
 assert.equal(x.identity.dueAt,"2026-11-09T05:55:12.0000000Z");
});
test("even all verified-looking evidence, fresh read and owner approval cannot enable mutation",async()=>{
 const x=await baseline();
 x.evidence=signals().map((e,i)=>({...e,airwallexFileId:"file-"+String(i).padStart(6,"0"),
   fileUploadReceiptSha256:h("file-receipt-"+i),verifiedFileServiceReadback:true,mimeType:"application/pdf",sizeBytes:250_000}));
 x.freshRead={origin:"AIRWALLEX_SANDBOX",readOnly:true,retrievedAt:now-3_000,
   identity:{...x.identity},identityMatched:true};
 x.ownerApproval=withOwnerApproval(x);
 const y=evaluateVisa104OfflinePreflight(x);
 assert.equal(y.allowed,false);
 assert.deepEqual(y.reasons,["EXTERNAL_FILE_ID_PROVENANCE_REQUIRES_INDEPENDENT_ATTESTATION","PROVIDER_EXECUTION_NOT_IMPLEMENTED"]);
});
test("injected fresh read with changed amount, case identity, stale timestamp is rejected",async()=>{
 const x=await baseline();x.evidence=signals();
 x.freshRead={origin:"AIRWALLEX_SANDBOX",readOnly:true,retrievedAt:now-3_000,identity:{...x.identity},identityMatched:true};
 assert.equal(evaluateVisa104OfflinePreflight(x).reasons.includes("FRESH_MATCHED_PROVIDER_READ_REQUIRED"),false);
 x.freshRead.identity={...x.identity,amountMinor:1};
 assert.ok(evaluateVisa104OfflinePreflight(x).reasons.includes("FRESH_MATCHED_PROVIDER_READ_REQUIRED"));
 x.freshRead.identity={...x.identity};
 x.freshRead.retrievedAt=now-121_000;
 assert.ok(evaluateVisa104OfflinePreflight(x).reasons.includes("FRESH_MATCHED_PROVIDER_READ_REQUIRED"));
 x.freshRead.retrievedAt=now+5;
 assert.ok(evaluateVisa104OfflinePreflight(x).reasons.includes("FRESH_MATCHED_PROVIDER_READ_REQUIRED"));
});
test("synthetic, unsupported, contradictory and missing file provenance fail closed",async()=>{
 const x=await baseline();x.evidence=signals();
 x.evidence=[...x.evidence,{...x.evidence[0]!,classification:"SYNTHETIC",category:"PRIOR_TRANSACTION_HISTORY"},
   {...x.evidence[1]!,classification:"UNSUPPORTED",category:"DEVICE_IP"},
   {...x.evidence[2]!,contradictsCase:true}];
 const y=evaluateVisa104OfflinePreflight(x);
 assert.ok(y.reasons.includes("SYNTHETIC_OR_UNSUPPORTED_EVIDENCE_REJECTED"));
 assert.ok(y.reasons.includes("CONTRADICTORY_EVIDENCE_REQUIRES_HUMAN_REVIEW"));
 assert.ok(y.reasons.includes("FILE_SERVICE_UPLOAD_AND_READBACK_EVIDENCE_MISSING"));
});
test("CE3 self-claim cannot certify 10.4 under changed Visa rules",async()=>{
 const x=await baseline(); x.ce30Claimed=true;
 const y=evaluateVisa104OfflinePreflight(x);
 assert.equal(y.ce30Certified,false);assert.ok(y.reasons.includes("VISA_CE30_NOT_INDEPENDENTLY_VERIFIED"));
});
test("expiry, near deadline, malformed deadline or invalid clock block",async()=>{
 const x=await baseline();
 x.now=Date.parse("2026-11-09T05:55:12Z");
 assert.ok(evaluateVisa104OfflinePreflight(x).reasons.includes("PROVIDER_DEADLINE_EXPIRED"));
 x.now-=5*60_000;
 assert.ok(evaluateVisa104OfflinePreflight(x).reasons.includes("PROVIDER_DEADLINE_TOO_CLOSE"));
 x.now=Number.NaN;
 assert.ok(evaluateVisa104OfflinePreflight(x).reasons.includes("CLOCK_INVALID"));
 x.now=now;x.identity={...x.identity,dueAt:"2026-11-09T05:55:12"};
 assert.ok(evaluateVisa104OfflinePreflight(x).reasons.includes("CASE_IDENTITY_NOT_VERIFIED"));
});
test("approval digest changes when source or File Service IDs change",async()=>{
 const x=await baseline();x.evidence=signals();
 x.ownerApproval=withOwnerApproval(x);
 assert.equal(evaluateVisa104OfflinePreflight(x).reasons.includes("ACTION_SPECIFIC_OWNER_APPROVAL_REQUIRED"),false);
 x.evidence=x.evidence.map((e,i)=>i===1?{...e,sourceSha256:h("tamper")}:e);
 assert.ok(evaluateVisa104OfflinePreflight(x).reasons.includes("ACTION_SPECIFIC_OWNER_APPROVAL_REQUIRED"));
 x.ownerApproval=withOwnerApproval(x);
 x.ownerApproval.consumed=true;
 assert.ok(evaluateVisa104OfflinePreflight(x).reasons.includes("ACTION_SPECIFIC_OWNER_APPROVAL_REQUIRED"));
 x.ownerApproval=withOwnerApproval(x);
 x.ownerApproval.expiresAt=now;
 assert.ok(evaluateVisa104OfflinePreflight(x).reasons.includes("ACTION_SPECIFIC_OWNER_APPROVAL_REQUIRED"));
});
test("ambiguous dispatch, already-submitted and reserved fences always block",async()=>{
 const x=await baseline();x.dispatchState="AMBIGUOUS";x.alreadySubmitted=true;
 const y=evaluateVisa104OfflinePreflight(x);
 assert.ok(y.reasons.includes("ACTION_ALREADY_SUBMITTED_OR_UNKNOWN"));
 assert.ok(y.reasons.includes("AMBIGUOUS_DISPATCH_MANUAL_RECONCILIATION"));
 assert.ok(y.reasons.includes("DURABLE_DISPATCH_FENCE_BLOCKED"));
});
test("non-10.4 identity and Mastercard case do not silently route through Visa contract",async()=>{
 const portfolio=await loadHistoricalProviderPortfolio();
 assert.throws(()=>visa104FromHistoricalCase(portfolio.cases[1]!),/FT055_INVALID_HISTORICAL_CASE/);
 const x=await baseline(); x.identity={...x.identity,reasonCode:"4837" as "10.4"};
 assert.ok(evaluateVisa104OfflinePreflight(x).reasons.includes("CASE_IDENTITY_NOT_VERIFIED"));
});
test("null evidence and invalid dispatch fail closed without throwing",async()=>{
 const x=await baseline();
 x.evidence=null as unknown as Visa104Evidence[];
 x.dispatchState=null as unknown as Visa104Preflight["dispatchState"];
 assert.doesNotThrow(()=>evaluateVisa104OfflinePreflight(x));
 const result=evaluateVisa104OfflinePreflight(x);
 assert.ok(result.reasons.includes("EVIDENCE_INPUT_INVALID"));
 assert.ok(result.reasons.includes("DURABLE_DISPATCH_FENCE_BLOCKED"));
 assert.equal(result.allowed,false);
});
test("forged file format and excessive size cannot masquerade as an admissible Visa upload", async()=>{
 const x=await baseline();
 x.evidence=signals().map((e,i)=>({...e,airwallexFileId:"file-"+String(i).padStart(6,"0"),
   fileUploadReceiptSha256:h("document-"+i),verifiedFileServiceReadback:true,
   mimeType:i===0?"image/png":"application/pdf",sizeBytes:i===2?2_500_000:100_000}));
 const reasons=evaluateVisa104OfflinePreflight(x).reasons;
 assert.ok(reasons.includes("VISA_FILE_FORMAT_OR_SIZE_UNVERIFIED"));
 assert.equal(evaluateVisa104OfflinePreflight(x).allowed,false);
});
test("a completely invalid identity with a fabricated approval fails closed without exception", async()=>{
 const x=await baseline();
 x.identity=null as unknown as Visa104Preflight["identity"];
 x.ownerApproval={action:"CHALLENGE",identityAndEvidenceDigest:"a".repeat(64),
   actor:"owner",approvalId:"x",approvedAt:now-1000,expiresAt:now+1000,consumed:false};
 const result=evaluateVisa104OfflinePreflight(x);
 assert.equal(result.allowed,false);
 assert.ok(result.reasons.includes("CASE_IDENTITY_NOT_VERIFIED"));
 assert.ok(result.reasons.includes("ACTION_SPECIFIC_OWNER_APPROVAL_REQUIRED"));
});
