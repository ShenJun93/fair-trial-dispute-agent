import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTrustedAttestationGate,envelopeMessage,type SignedAttestations,type TrustedKeys } from "../spike/ft058-attestation-gate.ts";
import { buildPrivateSandboxPort,FT058_API_SCHEMA_VERSION,FT058_SANDBOX_ORIGIN_FOR_TEST_ASSERTION,
  type InjectedFetch,type SessionBearer } from "../spike/ft058-private-http.ts";
import { executeSandboxRfiChallenge,intentDigest,type VerifiedIntent,type OwnerOneShot,type HttpRequest } from "../spike/ft057-sandbox-boundary.ts";

const now=Date.parse("2026-11-02T14:00:00Z");
const sha=(s:string)=>createHash("sha256").update(s).digest("hex");
const original=():VerifiedIntent=>({
 disputeId:"dst_offline_visa10401",reasonCode:"10.4",stage:"RFI",status:"REQUIRES_RESPONSE",
 cardBrand:"visa",currency:"USD",amount:120,dueAt:"2026-11-09T05:55:12Z",
 actor:"sandbox_owner_01",evidenceFileIds:["file_pinned_test01"],evidenceSha256:sha("source")
});
const approval=(i:VerifiedIntent):OwnerOneShot=>({
 intendedAction:"CHALLENGE",intentDigest:intentDigest(i),expiresAt:now+60_000,
 approvedAt:now-1000,approvalId:"owner-ticket-00001",actor:i.actor,consumed:false
});
function attest(i:VerifiedIntent,a:OwnerOneShot){
 const owner=generateKeyPairSync("ed25519"),reviewer=generateKeyPairSync("ed25519");
 const keys:TrustedKeys={ownerKeyId:"owner-key-001",evidenceKeyId:"reviewer-key-001",
   ownerPublicKey:owner.publicKey,evidencePublicKey:reviewer.publicKey};
 const claims:SignedAttestations={
   owner:{keyId:keys.ownerKeyId,payload:{
     schema:"FT058_OWNER_APPROVAL_ATTESTATION_V1",intentDigest:intentDigest(i),
     approvalId:a.approvalId,actor:i.actor,action:"CHALLENGE",
     issuedAt:a.approvedAt,expiresAt:a.expiresAt,ownerId:"merchant-operator-1"
   },signature:""},
   evidence:{keyId:keys.evidenceKeyId,payload:{
     schema:"FT058_EVIDENCE_ATTESTATION_V1",intentDigest:intentDigest(i),
     fileIds:[...i.evidenceFileIds],evidenceSha256:i.evidenceSha256,
     providerUploadReadbackReceiptSha256:sha("REVIEWED_TEST_RECEIPT"),
     providerEnvironment:"AIRWALLEX_SANDBOX",
     sourceKind:"OWNER_REVIEWED_FILE_SERVICE_READBACK",
     issuedAt:now-1000,expiresAt:now+60_000,reviewerId:"independent-reviewer-1"
   },signature:""}
 };
 const reseal=()=>{
   claims.owner.signature=sign(null,envelopeMessage("owner",claims.owner.payload),owner.privateKey).toString("base64url");
   claims.evidence.signature=sign(null,envelopeMessage("evidence",claims.evidence.payload),reviewer.privateKey).toString("base64url");
 };
 reseal();
 return {keys,claims,reseal};
}
const response=(status:number,body:unknown)=>new Response(JSON.stringify(body),{status,headers:{"content-type":"application/json"}});
const bearer=():Promise<SessionBearer>=>Promise.resolve({
 value:"ephemeral_fake_bearer_value_for_tests",expiresAt:now+300_000,
 accountBinding:"INDEPENDENTLY_VERIFIED_SANDBOX_ACCOUNT"
});
async function tmp(fn:(dir:string)=>Promise<void>){
 const dir=await mkdtemp(join(tmpdir(),"ft058-"));
 try{await fn(dir)}finally{await rm(dir,{recursive:true,force:true})}
}
test("separate Ed25519 owner and evidence signatures verify only same intent and approval",async()=>{
 const i=original(),a=approval(i),{keys,claims}=attest(i,a);
 const gate=createTrustedAttestationGate(keys,claims,()=>now);
 assert.equal(await gate.authenticate(i,a),true);
 assert.equal(await gate.authenticate({...i,amount:1 as 120},a),false);
 assert.equal(await gate.authenticate(i,{...a,approvalId:"different_approval"}),false);
});
test("signed payload tampering, role switching and mismatched reviewer block",async()=>{
 const i=original(),a=approval(i),{keys,claims,reseal}=attest(i,a);
 const gate=createTrustedAttestationGate(keys,claims,()=>now);
 claims.evidence.payload.evidenceSha256=sha("tamper");
 assert.equal(await gate.authenticate(i,a),false);
 reseal();assert.equal(await gate.authenticate(i,a),false);
 claims.evidence.payload.evidenceSha256=i.evidenceSha256;
 claims.evidence.keyId=keys.ownerKeyId;
 assert.equal(await gate.authenticate(i,a),false);
});
test("owner approval expiration, stale evidence and changed File Service ID block",async()=>{
 const i=original(),a=approval(i),{keys,claims,reseal}=attest(i,a);
 const gate=createTrustedAttestationGate(keys,claims,()=>now);
 claims.owner.payload.expiresAt=now;reseal();
 assert.equal(await gate.authenticate(i,a),false);
 claims.owner.payload.expiresAt=a.expiresAt;
 claims.evidence.payload.issuedAt=now-121_000;claims.evidence.payload.expiresAt=now+59_000;
 reseal();assert.equal(await gate.authenticate(i,a),false);
 claims.evidence.payload.issuedAt=now-1000;
 claims.evidence.payload.expiresAt=now+60_000;
 claims.evidence.payload.fileIds=["file_other_upload_ref"];reseal();
 assert.equal(await gate.authenticate(i,a),false);
});
test("same key for both signer roles is rejected at construction",()=>{
 const pair=generateKeyPairSync("ed25519");
 assert.throws(()=>createTrustedAttestationGate({
   ownerKeyId:"owner_01",evidenceKeyId:"reviewer_02",
   ownerPublicKey:pair.publicKey,evidencePublicKey:pair.publicKey,
 },{} as SignedAttestations,()=>now),/FT058_SIGNER_ROLES_NOT_SEPARATE/);
});
test("attestation canonicalizer is order-independent, rejects undefined",async()=>{
 const {canonicalJson}=await import("../spike/ft058-attestation-gate.ts");
 assert.equal(canonicalJson({b:1,a:2}),canonicalJson({a:2,b:1}));
 assert.throws(()=>canonicalJson({value:undefined}),/FT058_INVALID_SIGNED_PAYLOAD/);
});
test("private port uses ONLY sandbox origin, pinned version, bearer, no redirects/retries",async()=>{
 const events:Array<{url:string;init:unknown}>=[];
 const i=original();
 let get=0;
 const fake:InjectedFetch=async(url,init)=>{
   events.push({url,init});
   if(init.method==="POST")return response(200,{ok:true});
   get++;
   if(get===1)return response(200,{
     id:i.disputeId,stage:i.stage,status:"REQUIRES_RESPONSE",card_brand:"visa",
     currency:"USD",amount:120,reason:{original_code:"10.4",type:"FRAUDULENT"},due_at:i.dueAt
   });
   return response(200,{id:i.disputeId,stage:"RFI",status:"CHALLENGED",
     card_brand:"visa",currency:"USD",amount:120,
     reason:{original_code:"10.4",type:"FRAUDULENT"},due_at:i.dueAt,
     challenge_details:[{stage:"RFI",challenge_method:"STANDARD",
       challenged_by:i.actor,supporting_documents:{documents:[{file_ids:[...i.evidenceFileIds]}]}}]});
 };
 const port=buildPrivateSandboxPort({injectedFetch:fake,getVerifiedBearer:bearer,now:()=>now});
 const {keys,claims}=attest(i,approval(i));
 await tmp(async journalDir=>{
   const r=await executeSandboxRfiChallenge({
     intent:i,approval:approval(i),port,
     gate:createTrustedAttestationGate(keys,claims,()=>now),journalDir,now
   });
   assert.equal(r.state,"SUBMISSION_OBSERVED");
 });
 assert.deepEqual(events.map(x=>(x.init as {method:string}).method),["GET","POST","GET"]);
 assert.ok(events.every(x=>x.url.startsWith(FT058_SANDBOX_ORIGIN_FOR_TEST_ASSERTION+"/api/v1/pa/payment_disputes/")));
 assert.ok(events.every(x=>(x.init as {redirect:string}).redirect==="error"));
 assert.ok(events.every(x=>(x.init as {headers:Record<string,string>}).headers["x-api-version"]===FT058_API_SCHEMA_VERSION));
 assert.ok(events.every(x=>(x.init as {headers:Record<string,string>}).headers.authorization.startsWith("Bearer ")));
 assert.equal(events.some(x=>JSON.stringify(x).includes("api.airwallex.com/api/v1/authentication/login")),false);
});
test("bad paths, wrong method and challenge payload fail before bearer resolution",async()=>{
 let called=0,authed=0;
 const port=buildPrivateSandboxPort({
   injectedFetch:async()=>{called++;return response(200,{})},
   getVerifiedBearer:async()=>{authed++;return bearer()},
   now:()=>now
 });
 const requests=[
   {method:"POST",path:"/api/v1/pa/payment_disputes/dst_fake01/accept",retry:false,body:{}},
   {method:"GET",path:"https://api.airwallex.com/api/v1/pa/payment_disputes/abc1234",retry:false},
   {method:"GET",path:"/api/v1/pa/payment_disputes/dst_fake01/challenge",retry:false},
   {method:"POST",path:"/api/v1/pa/payment_disputes/dst_fake01/challenge",retry:false},
 ];
 for(const x of requests)await assert.rejects(port.send(x as HttpRequest),/FT058_OPERATION_NOT_ALLOWLISTED/);
 assert.equal(called,0);assert.equal(authed,0);
});
test("expired, unbound or malformed token blocks before any network",async()=>{
 let called=0;
 const port=buildPrivateSandboxPort({
   injectedFetch:async()=>{called++;return response(200,{})},
   getVerifiedBearer:async()=>({...await bearer(),expiresAt:now+1}),
   now:()=>now
 });
 await assert.rejects(port.send({method:"GET",path:"/api/v1/pa/payment_disputes/dst_fake01",retry:false}),/FT058_VERIFIED_BEARER_UNAVAILABLE/);
 assert.equal(called,0);
});
test("HTTP 429 and 5xx return response once, never auto-login or retry",async()=>{
 let calls=0;
 const port=buildPrivateSandboxPort({
   injectedFetch:async()=>{calls++;return response(429,{code:"rate_limit"})},
   getVerifiedBearer:bearer,now:()=>now
 });
 const x=await port.send({method:"GET",path:"/api/v1/pa/payment_disputes/dst_fake01",retry:false});
 assert.equal(x.status,429);assert.equal(calls,1);
});
test("response JSON, body size, and transport errors fail closed",async()=>{
 let calls=0;
 const port=buildPrivateSandboxPort({
   injectedFetch:async()=>{calls++;return new Response("X".repeat(3000),{status:200})},
   getVerifiedBearer:bearer,now:()=>now,maxResponseBytes:1024,
 });
 await assert.rejects(port.send({method:"GET",path:"/api/v1/pa/payment_disputes/dst_fake01",retry:false}),/FT058_RESPONSE_TOO_LARGE/);
 assert.equal(calls,1);
});
test("FT058 cannot be constructed without explicit transport and token provider",()=>{
 assert.throws(()=>buildPrivateSandboxPort({} as never),/FT058_PRIVATE_CAPABILITIES_REQUIRED/);
});
