import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtemp,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {reviewCrashRecovery} from "../spike/ft059-recovery.ts";
import {intentDigest,type VerifiedIntent} from "../spike/ft057-sandbox-boundary.ts";
const hash=(s:string)=>createHash("sha256").update(s).digest("hex");
const i:VerifiedIntent={disputeId:"dst_visa_recovery01",reasonCode:"10.4",stage:"RFI",
 status:"REQUIRES_RESPONSE",cardBrand:"visa",currency:"USD",amount:120,
 dueAt:"2026-11-09T05:55:12Z",actor:"merchant_owner_01",
 evidenceFileIds:["file_ref_recovery_01"],evidenceSha256:hash("source")};
async function scratch(f:(p:string)=>Promise<void>){
 const p=await mkdtemp(join(tmpdir(),"ft059-review-"));
 try{await f(p)}finally{await rm(p,{recursive:true,force:true})}
}
test("no journal always requires external authorization",()=>scratch(async dir=>{
 const v=await reviewCrashRecovery(dir,i);
 assert.equal(v.decision,"NO_JOURNAL_NO_AUTHORIZATION");
 assert.equal(v.automaticReplayAllowed,false);
}));
test("corrupted journal and completed journal prohibit replay",()=>scratch(async dir=>{
 const path=join(dir,hash("FT057_CASE:"+i.disputeId)+".json");
 await writeFile(path,"not-json");
 assert.equal((await reviewCrashRecovery(dir,i)).decision,"CORRUPT_LOCKED");
 await writeFile(path,JSON.stringify({schema:"FT057_SANDBOX_JOURNAL_V1",
  state:"READBACK_OBSERVED",intentDigest:intentDigest(i),requestId:"test",approvalDigest:hash("owner")}));
 const v=await reviewCrashRecovery(dir,i);
 assert.equal(v.decision,"COMPLETED_NO_REPLAY");
 assert.equal(v.automaticReplayAllowed,false);
}));
test("reserved journal means manual reconciliation and no automatic retry",()=>scratch(async dir=>{
 const path=join(dir,hash("FT057_CASE:"+i.disputeId)+".json");
 await writeFile(path,JSON.stringify({schema:"FT057_SANDBOX_JOURNAL_V1",
  state:"RESERVED",intentDigest:intentDigest(i),requestId:"test",approvalDigest:hash("owner")}));
 const v=await reviewCrashRecovery(dir,i);
 assert.equal(v.decision,"MANUAL_REVIEW_REQUIRED");
 assert.equal(v.caseLocked,true);
}));
