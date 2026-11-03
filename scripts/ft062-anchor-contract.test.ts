import assert from "node:assert/strict";
import test from "node:test";
import { FT062_HOLDOUT } from "./fixtures/ft062-holdout.ts";
import { ingestOfflineTextEvidence } from "../spike/dispute-evidence.ts";
import { createApplicationSourceSpanAnchors,enrichAnchoredModelProposals,enrichModelProposals } from "../spike/evidence-proposals.ts";
import {buildAnchorPrompt,validateAnchoredClaims} from "./ft062-anchored-inference.ts";
const at="2026-11-02T16:00:00.000Z";
const doc=(id:string,text:string)=>ingestOfflineTextEvidence("ft062-lab",id,text,at);
test("holdout labels and categories are separate from prior 50-case suite",()=>{
 assert.equal(FT062_HOLDOUT.length,20);
 assert.equal(FT062_HOLDOUT.filter(x=>x.expected==="SUPPORTED").length,10);
 assert.equal(FT062_HOLDOUT.filter(x=>x.expected==="UNSUPPORTED").length,10);
 assert.equal(new Set(FT062_HOLDOUT.map(x=>x.id)).size,20);
});
test("app anchors disambiguate repeated exact quotes but keep one factual signal",()=>{
 const row=FT062_HOLDOUT.find(x=>x.id==="fresh-p04")!;
 const d=doc(row.id,row.text),spans=createApplicationSourceSpanAnchors(d);
 const old=enrichModelProposals([{factType:"DEVICE_AND_3DS_MATCH",exactQuote:row.goldQuote!}],d,"OFFLINE_TEST",at);
 assert.equal(old[0]?.groundingReasonCode,"QUOTE_NOT_UNIQUE");
 const evidence=enrichAnchoredModelProposals(
  spans.map(x=>({factType:"DEVICE_AND_3DS_MATCH",exactQuote:row.goldQuote!,sourceSpanId:x.anchorId})),
  d,"OFFLINE_TEST",at);
 assert.equal(evidence.proposals.length,1);
 assert.equal(evidence.duplicateClaimsSuppressed,1);
 assert.equal(evidence.proposals[0]?.groundingReasonCode,"GROUNDED");
});
test("invalid source span, changed document and contradictory text stay rejected",()=>{
 const row=FT062_HOLDOUT.find(x=>x.id==="fresh-n01")!;
 const d=doc(row.id,row.text),span=createApplicationSourceSpanAnchors(d)[0]!;
 const a={factType:"DEVICE_AND_3DS_MATCH" as const,exactQuote:span.text,sourceSpanId:span.anchorId};
 assert.equal(enrichAnchoredModelProposals([a],d,"TEST",at).proposals[0]?.groundingReasonCode,"CONTRADICTORY_SOURCE");
 assert.equal(enrichAnchoredModelProposals([{...a,sourceSpanId:"span-"+"0".repeat(24)}],d,"TEST",at).proposals[0]?.groundingReasonCode,"INVALID_SOURCE_SPAN_ANCHOR");
 assert.throws(()=>enrichAnchoredModelProposals([a],{...d,text:d.text+" changed"}, "TEST",at),/SOURCE_HASH_INVALID/);
});
test("strict compact parser rejects forged provenance and financial fields",()=>{
 const row=FT062_HOLDOUT[0]!,d=doc(row.id,row.text);
 const span=createApplicationSourceSpanAnchors(d)[0]!;
 const claim={factType:"DEVICE_AND_3DS_MATCH",exactQuote:row.goldQuote!,sourceSpanId:span.anchorId};
 assert.deepEqual(validateAnchoredClaims(JSON.stringify({proposals:[claim]})),[claim]);
 for(const forged of [{...claim,startOffset:0},{...claim,providerAction:"CHALLENGE"},{...claim,sourceSpanId:"bad"}])
  assert.throws(()=>validateAnchoredClaims({proposals:[forged]}),/INVALID_ANCHOR_CLAIM/);
 assert.throws(()=>validateAnchoredClaims({proposals:[] ,approved:true}),/INVALID_ANCHOR_RESPONSE/);
});
test("injection-noise positive quote can be grounded without accepting instructions",()=>{
 const row=FT062_HOLDOUT.find(x=>x.id==="fresh-p07")!;
 const d=doc(row.id,row.text),span=createApplicationSourceSpanAnchors(d)[1]!;
 const r=enrichAnchoredModelProposals([{factType:"DEVICE_AND_3DS_MATCH",sourceSpanId:span.anchorId,
 exactQuote:row.goldQuote!}],d,"TEST",at);
 assert.equal(r.proposals[0]?.groundingReasonCode,"GROUNDED");
 assert.equal("providerAction" in r.proposals[0]!.proposal,false);
 assert.equal(buildAnchorPrompt(d).spans.length,2);
});
