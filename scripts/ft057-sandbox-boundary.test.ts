import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp,readdir,rm,readFile,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeSandboxRfiChallenge,inspectSandboxJournal,intentDigest,
  type VerifiedIntent,type OwnerOneShot,type HttpRequest,type AuthenticatedSandboxPort,
  type IndependentGate } from "../spike/ft057-sandbox-boundary.ts";

const now=Date.parse("2026-11-02T13:00:00Z");
const hash=(s:string)=>createHash("sha256").update(s).digest("hex");
const intent=():VerifiedIntent=>({
 disputeId:"dst_visa_demo_1234",reasonCode:"10.4",stage:"RFI",
 status:"REQUIRES_RESPONSE",cardBrand:"visa",currency:"USD",amount:120,
 dueAt:"2026-11-09T05:55:12Z",actor:"merchant_owner_01",
 evidenceFileIds:["file_id_credentialed_01"],evidenceSha256:hash("verified-evidence")
});
const consent=(i:VerifiedIntent):OwnerOneShot=>({
 intendedAction:"CHALLENGE",intentDigest:intentDigest(i),approvedAt:now-1000,
 expiresAt:now+60000,approvalId:"authorization-owner-123456",actor:i.actor,consumed:false
});
const authenticated:IndependentGate={authenticate:async()=>true};
const read=(i:VerifiedIntent,details=false)=>({
 id:i.disputeId,stage:"RFI",status:details?"CHALLENGED":"REQUIRES_RESPONSE",
 card_brand:"visa",currency:"USD",amount:120,
 reason:{original_code:"10.4",type:"FRAUDULENT"},
 due_at:i.dueAt,challenge_details:details?[{stage:"RFI",challenge_method:"STANDARD",
 challenged_by:i.actor,supporting_documents:{documents:[{file_ids:[...i.evidenceFileIds]}]}}]:[]
});
class FakeTransport implements AuthenticatedSandboxPort{
 readonly environment="AIRWALLEX_SANDBOX" as const;
 requests:HttpRequest[]=[];
 constructor(private i:VerifiedIntent,private behavior:"normal"|"timeout-post"|"unverified-readback"|"preget-mismatch"|"post500"="normal"){}
 async send(req:Readonly<HttpRequest>){
  this.requests.push(req as HttpRequest);
  if(req.method==="POST"){
   if(this.behavior==="timeout-post")throw Error("network lost");
   if(this.behavior==="post500")return {status:500,body:{}};
   return {status:200,body:{status:"RECEIVED"}};
  }
  const count=this.requests.filter(r=>r.method==="GET").length;
  if(count===1)return {status:200,body:this.behavior==="preget-mismatch"?{...read(this.i),amount:1}:read(this.i)};
  return {status:200,body:read(this.i,this.behavior!=="unverified-readback")};
 }
}
async function scratch(fn:(dir:string)=>Promise<void>){
 const dir=await mkdtemp(join(tmpdir(),"ft057-protocol-"));
 try{await fn(dir)}finally{await rm(dir,{recursive:true,force:true})}
}
test("provider GET uses documented nested reason; legacy flat reason_code never authorizes POST",()=>scratch(async journalDir=>{
 const i=intent();
 const port=new FakeTransport(i);
 const sent=port.send.bind(port);
 port.send=async req=>{
   const reply=await sent(req);
   if(req.method==="GET" && port.requests.filter(x=>x.method==="GET").length===1){
     const body={...(reply.body as object),reason_code:"10.4"};
     delete (body as Record<string,unknown>).reason;
     return {status:200,body};
   }
   return reply;
 };
 const x=await executeSandboxRfiChallenge({intent:i,approval:consent(i),port,gate:authenticated,journalDir,now});
 assert.equal(x.state,"AMBIGUOUS");
 assert.equal(x.postAttempts,0);
 assert.equal(port.requests.filter(req=>req.method==="POST").length,0);
}));
test("matching dispute with different reason type is rejected, even when original_code matches",()=>scratch(async journalDir=>{
 const i=intent(),port=new FakeTransport(i);
 const sent=port.send.bind(port);
 port.send=async req=>{
   const reply=await sent(req);
   if(req.method==="GET" && port.requests.filter(x=>x.method==="GET").length===1)
     return {status:200,body:{...(reply.body as object),reason:{original_code:"10.4",type:"PRODUCT_NOT_RECEIVED"}}};
   return reply;
 };
 const x=await executeSandboxRfiChallenge({intent:i,approval:consent(i),port,gate:authenticated,journalDir,now});
 assert.equal(x.state,"AMBIGUOUS");assert.equal(x.postAttempts,0);
}));
test("postGET challenge_details without CHALLENGED dispute status must not confirm submission",()=>scratch(async journalDir=>{
 const i=intent(),port=new FakeTransport(i);
 const sent=port.send.bind(port);
 port.send=async req=>{
   const reply=await sent(req);
   if(req.method==="GET" && port.requests.filter(x=>x.method==="GET").length===2)
      return {status:200,body:{...(reply.body as object),status:"REQUIRES_RESPONSE"}};
   return reply;
 };
 const x=await executeSandboxRfiChallenge({intent:i,approval:consent(i),port,gate:authenticated,journalDir,now});
 assert.equal(x.state,"AMBIGUOUS");assert.equal(x.postAttempts,1);assert.equal(x.caseReadbackVerified,false);
}));
test("timezone-equivalent provider deadlines remain valid and not rejected by formatting",()=>scratch(async journalDir=>{
 const i=intent(),port=new FakeTransport(i);
 const sent=port.send.bind(port);
 port.send=async req=>{
   const reply=await sent(req);
   if(req.method==="GET")return {status:200,body:{...(reply.body as object),due_at:"2026-11-09T05:55:12+00:00"}};
   return reply;
 };
 const x=await executeSandboxRfiChallenge({intent:i,approval:consent(i),port,gate:authenticated,journalDir,now});
 assert.equal(x.state,"SUBMISSION_OBSERVED");
}));
test("injected port: authenticated preGET → exactly one POST → verifiable postGET",()=>scratch(async journalDir=>{
 const i=intent(),port=new FakeTransport(i);
 const x=await executeSandboxRfiChallenge({intent:i,approval:consent(i),port,gate:authenticated,journalDir,now});
 assert.equal(x.state,"SUBMISSION_OBSERVED");assert.equal(x.postAttempts,1);assert.equal(x.getAttempts,2);
 assert.equal(x.liveOutcomeVerified,false);assert.equal(x.caseReadbackVerified,true);
 assert.deepEqual(port.requests.map(r=>r.method),["GET","POST","GET"]);
 assert.ok(port.requests.every(r=>r.retry===false));
 assert.equal(port.requests[1]?.path,"/api/v1/pa/payment_disputes/"+i.disputeId+"/challenge");
 const body=port.requests[1]?.body!;
 assert.equal(body.challenge_method,"STANDARD");
 assert.equal(body.supporting_documents.documents[0]?.file_ids[0],i.evidenceFileIds[0]);
 assert.equal((await inspectSandboxJournal(journalDir,i))?.state,"READBACK_OBSERVED");
}));
test("approval mismatch or expired approval rejects before any I/O",()=>scratch(async journalDir=>{
 const i=intent(),port=new FakeTransport(i),a=consent(i);
 a.intentDigest=hash("wrong");
 assert.equal((await executeSandboxRfiChallenge({intent:i,approval:a,port,gate:authenticated,journalDir,now})).state,"BLOCKED");
 a.intentDigest=intentDigest(i);a.expiresAt=now;
 assert.equal((await executeSandboxRfiChallenge({intent:i,approval:a,port,gate:authenticated,journalDir,now})).state,"BLOCKED");
 assert.equal(port.requests.length,0);
}));
test("independent check can veto before reservation and network",()=>scratch(async journalDir=>{
 const i=intent(),port=new FakeTransport(i),gate:IndependentGate={authenticate:async()=>false};
 const x=await executeSandboxRfiChallenge({intent:i,approval:consent(i),port,gate,journalDir,now});
 assert.equal(x.state,"BLOCKED");assert.equal(port.requests.length,0);
 assert.equal(await inspectSandboxJournal(journalDir,i),null);
}));
test("case identity mismatch fails before challenge POST",()=>scratch(async journalDir=>{
 const i=intent(),port=new FakeTransport(i,"preget-mismatch");
 const x=await executeSandboxRfiChallenge({intent:i,approval:consent(i),port,gate:authenticated,journalDir,now});
 assert.equal(x.state,"AMBIGUOUS");assert.equal(x.postAttempts,0);
 assert.equal(port.requests.filter(r=>r.method==="POST").length,0);
 assert.equal((await inspectSandboxJournal(journalDir,i))?.state,"RECONCILE_REQUIRED");
}));
test("timeout after POST: no retry and second entry cannot duplicate",()=>scratch(async journalDir=>{
 const i=intent(),port=new FakeTransport(i,"timeout-post");
 const x=await executeSandboxRfiChallenge({intent:i,approval:consent(i),port,gate:authenticated,journalDir,now});
 assert.equal(x.state,"AMBIGUOUS");assert.equal(x.postAttempts,1);
 const second=await executeSandboxRfiChallenge({intent:i,approval:consent(i),port,gate:authenticated,journalDir,now});
 assert.equal(second.state,"BLOCKED");
 assert.equal(port.requests.filter(r=>r.method==="POST").length,1);
}));
test("HTTP 500 is ambiguous not POST confirmed",()=>scratch(async journalDir=>{
 const i=intent(),port=new FakeTransport(i,"post500");
 const x=await executeSandboxRfiChallenge({intent:i,approval:consent(i),port,gate:authenticated,journalDir,now});
 assert.equal(x.state,"AMBIGUOUS");assert.equal(x.challengeAcceptedByProvider,false);
}));
test("HTTP 200 without challenge_details is not sufficient evidence",()=>scratch(async journalDir=>{
 const i=intent(),port=new FakeTransport(i,"unverified-readback");
 const x=await executeSandboxRfiChallenge({intent:i,approval:consent(i),port,gate:authenticated,journalDir,now});
 assert.equal(x.state,"AMBIGUOUS");assert.equal(x.challengeAcceptedByProvider,true);
 assert.equal(x.caseReadbackVerified,false);
}));
test("simultaneous executions for same case only one POST",()=>scratch(async journalDir=>{
 const i=intent(),port=new FakeTransport(i),a=consent(i);
 const results=await Promise.all(Array.from({length:8},()=>executeSandboxRfiChallenge({
   intent:i,approval:a,port,gate:authenticated,journalDir,now
 })));
 assert.equal(results.filter(x=>x.state==="SUBMISSION_OBSERVED").length,1);
 assert.equal(port.requests.filter(r=>r.method==="POST").length,1);
}));
test("tampered journal never permits second POST",()=>scratch(async journalDir=>{
 const i=intent(),port=new FakeTransport(i);
 await executeSandboxRfiChallenge({intent:i,approval:consent(i),port,gate:authenticated,journalDir,now});
 const [name]=await readdir(journalDir);assert.ok(name);
 const p=join(journalDir,name!);
 const raw=JSON.parse(await readFile(p,"utf8"));
 await writeFile(p,JSON.stringify({...raw,intentDigest:hash("tamper")}));
 await assert.rejects(inspectSandboxJournal(journalDir,i),/FT057_JOURNAL_INVALID_OR_STALE/);
 const again=await executeSandboxRfiChallenge({intent:i,approval:consent(i),port,gate:authenticated,journalDir,now});
 assert.equal(again.state,"BLOCKED");assert.equal(port.requests.filter(r=>r.method==="POST").length,1);
}));
test("invalid identity and missing file IDs blocked before port activity",()=>scratch(async journalDir=>{
 const i=intent();i.stage="CHARGEBACK" as "RFI";i.evidenceFileIds=[];
 const port=new FakeTransport(i);
 const r=await executeSandboxRfiChallenge({intent:i,approval:consent(i),port,gate:authenticated,journalDir,now});
 assert.equal(r.state,"BLOCKED");assert.equal(port.requests.length,0);
}));
