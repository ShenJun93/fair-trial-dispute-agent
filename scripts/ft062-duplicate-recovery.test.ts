import assert from "node:assert/strict";
import test from "node:test";
import {ingestOfflineTextEvidence} from "../spike/dispute-evidence.ts";
import {recoverIdenticalRepeatedLine} from "./ft062-duplicate-recovery.ts";
const quote="The registered device matches the account and 3DS authentication succeeded.";
const at="2026-11-02T16:00:00.000Z";
const claim={factType:"DEVICE_AND_3DS_MATCH" as const,exactQuote:quote};
const doc=(id:string,text:string)=>ingestOfflineTextEvidence("ft062-repair",id,text,at);
test("identical repeated full-line citation recovers one anchored fact",()=>{
 const d=doc("repeat",quote+"\n"+quote);
 const r=recoverIdenticalRepeatedLine(claim,d,"LOCAL_MODEL",at);
 assert.equal(r?.groundingReasonCode,"GROUNDED");
 assert.equal(r?.proposal.startOffset,0);
 assert.equal(r?.proposal.endOffset,quote.length);
});
test("contradiction anywhere blocks duplicate recovery",()=>{
 const d=doc("contradiction",quote+"\n"+quote+"\nLater audit: device fingerprint belongs to a different account.");
 assert.equal(recoverIdenticalRepeatedLine(claim,d,"LOCAL_MODEL",at),null);
});
test("partial repeated phrases embedded in prose are not unambiguously grounded",()=>{
 const d=doc("partial","Reporter wrote: "+quote+"\nAnother wrote: "+quote);
 assert.equal(recoverIdenticalRepeatedLine(claim,d,"LOCAL_MODEL",at),null);
});
test("single mention is never treated as repeated",()=>{
 const d=doc("single",quote);
 assert.equal(recoverIdenticalRepeatedLine(claim,d,"LOCAL_MODEL",at),null);
});
test("tampered hash is rejected instead of repaired",()=>{
 const d=doc("altered",quote+"\n"+quote);
 assert.throws(()=>recoverIdenticalRepeatedLine(claim,{...d,sha256:"0".repeat(64)},"LOCAL_MODEL",at),/SOURCE_HASH_INVALID/);
});
