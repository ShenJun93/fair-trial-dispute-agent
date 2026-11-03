import test from "node:test";
import assert from "node:assert/strict";
import {ingestOfflineTextEvidence} from "../spike/dispute-evidence.ts";
import {recoverIdenticalRepeatedLine} from "./ft062-duplicate-recovery.ts";
const at="2026-11-03T00:00:00.000Z";
const quote="The enrolled device matches the account and 3DS authentication succeeded.";
const claim={factType:"DEVICE_AND_3DS_MATCH" as const,exactQuote:quote};
const doc=(id:string,text:string)=>ingestOfflineTextEvidence("ft063-qa",id,text,at);
const repeat=quote+"\n"+quote;
test("repeated exact line yields one source-grounded citation, never independent facts",()=>{
 const d=doc("normal",repeat),r=recoverIdenticalRepeatedLine(claim,d,"LOCAL_QWEN",at);
 assert.equal(r?.groundingReasonCode,"GROUNDED");
 assert.equal(r?.proposal.startOffset,0);
 assert.equal(r?.proposal.endOffset,quote.length);
});
test("three exact lines still yield one citation",()=>{
 const d=doc("tripled",[quote,quote,quote].join("\n"));
 const r=recoverIdenticalRepeatedLine(claim,d,"LOCAL_QWEN",at);
 assert.equal(r?.groundingReasonCode,"GROUNDED");
 assert.equal(r?.proposal.startOffset,0);
});
test("CRLF and unicode prefix retain correct UTF-16 offset",()=>{
 const d=doc("unicode","📱 case header\r\n"+quote+"\r\n"+quote);
 const r=recoverIdenticalRepeatedLine(claim,d,"LOCAL_QWEN",at);
 assert.equal(r?.groundingReasonCode,"GROUNDED");
 assert.equal(d.text.slice(r!.proposal.startOffset,r!.proposal.endOffset),quote);
});
for(const [id,text] of [
 ["embedded", "A says "+quote+"\nB says "+quote],
 ["surrounded",quote+" extra claim\n"+quote],
 ["whitespace",quote+"\n "+quote],
 ["punctuation",quote+"\n"+quote+" extra note"],
 ["one",quote+"\nAn unrelated note with no authentication facts"],
 ["contradict",repeat+"\nLater audit: device differs and belongs to a different account."],
 ["negate",repeat+"\nLater audit: 3DS failed and the handset was not authenticated."],
 ["mismatch","Different quote\n"+quote+"\nOther quote"]
] as const){
 test("adversarial duplicated citation fails closed: "+id,()=>{
  assert.equal(recoverIdenticalRepeatedLine(claim,doc(id,text),"LOCAL_QWEN",at),null);
 });
}
test("missing quote and forged fact type are rejected, never promoted",()=>{
 const d=doc("absent",repeat);
 assert.equal(recoverIdenticalRepeatedLine({...claim,exactQuote:"fabricated quote"},d,"LOCAL_QWEN",at),null);
 assert.equal(recoverIdenticalRepeatedLine({...claim,factType:"REFUND_NOW" as never},d,"LOCAL_QWEN",at),null);
});
test("modified source hash fails closed instead of being repaired",()=>{
 const d=doc("tamper",repeat);
 assert.throws(()=>recoverIdenticalRepeatedLine(claim,{...d,sha256:"f".repeat(64)},"LOCAL_QWEN",at),/SOURCE_HASH_INVALID/);
});
test("forged source type cannot be promoted as offline operator evidence",()=>{
 const d=doc("source",repeat);
 assert.throws(()=>recoverIdenticalRepeatedLine(claim,{...d,source:"PROVIDER_CONFIRMED" as never},"LOCAL_QWEN",at),/UNSUPPORTED_EVIDENCE_SOURCE/);
});
test("forged media type cannot be promoted as plain text evidence",()=>{
 const d=doc("media",repeat);
 assert.throws(()=>recoverIdenticalRepeatedLine(claim,{...d,mediaType:"application/pdf" as never},"LOCAL_QWEN",at),/UNSUPPORTED_EVIDENCE_SOURCE/);
});
