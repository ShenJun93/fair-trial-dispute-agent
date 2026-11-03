/**
 * FT057 - a transport-agnostic sandbox payment-dispute challenge adapter.
 *
 * No fetch(), credentials, login, network URL, file upload or auto-executable CLI.
 * The caller MUST provide independently verified approvals/evidence and an
 * authenticated transport. Default production attachment remains DISABLED.
 *
 * Challenge API contract:
 * GET  /api/v1/pa/payment_disputes/{id}
 * POST /api/v1/pa/payment_disputes/{id}/challenge
 * version: 2026-06-30; https://www.airwallex.com/docs/api/payments/payment_disputes/api
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export type Method="GET"|"POST";
export interface HttpRequest {
  method:Method;
  path:string;
  body?:Readonly<ChallengeBody>;
  retry:false;
}
export interface HttpReply { status:number; body:unknown }
export interface AuthenticatedSandboxPort {
  readonly environment:"AIRWALLEX_SANDBOX";
  /** Implementations may only be injected by the owner-controlled entrypoint. */
  send(request:Readonly<HttpRequest>):Promise<HttpReply>;
}
export interface ChallengeBody {
  request_id:string;
  challenge_method:"STANDARD";
  reason:"OTHER_REASONS";
  challenged_by:string;
  supporting_documents:{
    documents:ReadonlyArray<{type:"PRIMARY"|"ORDER"|"CUSTOMER"|"OTHER";file_ids:readonly string[];description:string}>;
  };
}
export interface VerifiedIntent {
  disputeId:string; // Must be furnished by a private credentialed adapter, not a public receipt.
  reasonCode:"10.4";
  stage:"RFI";
  status:"REQUIRES_RESPONSE";
  cardBrand:"visa";
  currency:"USD";
  amount:120;
  dueAt:string;
  evidenceFileIds:readonly string[];
  actor:string;
  evidenceSha256:string;
}
export interface OwnerOneShot {
  intendedAction:"CHALLENGE";
  intentDigest:string;
  expiresAt:number;
  approvedAt:number;
  approvalId:string;
  actor:string;
  consumed:false;
}
export interface IndependentGate {
  /** Only return true after verifying source receipts AND independently authenticated approval. */
  authenticate(intent:Readonly<VerifiedIntent>,approval:Readonly<OwnerOneShot>):Promise<boolean>;
}
interface JournalRecord {
  schema:"FT057_SANDBOX_JOURNAL_V1";
  state:"RESERVED"|"POST_OBSERVED"|"READBACK_OBSERVED"|"RECONCILE_REQUIRED";
  intentDigest:string;
  requestId:string;
  approvalDigest:string;
}
export interface SandboxExecutionResult {
  schema:"FT057_SANDBOX_BOUNDARY_V1";
  state:"BLOCKED"|"AMBIGUOUS"|"SUBMISSION_OBSERVED";
  postAttempts:0|1;
  getAttempts:0|1|2;
  liveOutcomeVerified:false;
  challengeAcceptedByProvider:boolean;
  caseReadbackVerified:boolean;
  journalState:JournalRecord["state"]|"NONE";
  classification:"SANDBOX_ONLY_NOT_ISSUER_RESULT";
  reasons:string[];
}
const base="/api/v1/pa/payment_disputes/";
const fail=(reason:string):SandboxExecutionResult=>({
  schema:"FT057_SANDBOX_BOUNDARY_V1",state:"BLOCKED",postAttempts:0,getAttempts:0,
  liveOutcomeVerified:false,challengeAcceptedByProvider:false,caseReadbackVerified:false,
  journalState:"NONE",classification:"SANDBOX_ONLY_NOT_ISSUER_RESULT",reasons:[reason],
});
const sha=(s:string)=>createHash("sha256").update(s).digest("hex");
export function intentDigest(i:VerifiedIntent):string {
  return sha(JSON.stringify([i.disputeId,i.reasonCode,i.stage,i.status,i.cardBrand,
    i.currency,i.amount,i.dueAt,[...i.evidenceFileIds].sort(),i.evidenceSha256,i.actor]));
}
function isValid(i:VerifiedIntent,now:number):boolean {
  return !!i && typeof i.disputeId==="string" &&
    /^[a-zA-Z0-9][a-zA-Z0-9_-]{5,127}$/.test(i.disputeId) &&
    i.reasonCode==="10.4"&&i.stage==="RFI"&&i.status==="REQUIRES_RESPONSE"&&
    i.cardBrand==="visa"&&i.currency==="USD"&&i.amount===120&&
    typeof i.actor==="string" && /^[a-zA-Z0-9_-]{5,70}$/.test(i.actor) &&
    /^[a-f0-9]{64}$/.test(i.evidenceSha256)&&
    typeof i.dueAt==="string" && Number.isFinite(Date.parse(i.dueAt)) &&
    Date.parse(i.dueAt)>now+15*60_000 &&
    Array.isArray(i.evidenceFileIds) && i.evidenceFileIds.length>0&&i.evidenceFileIds.length<=12 &&
    i.evidenceFileIds.every(x=>typeof x==="string"&&/^[a-zA-Z0-9_-]{6,128}$/.test(x))&&
    new Set(i.evidenceFileIds).size===i.evidenceFileIds.length;
}
function asObj(v:unknown):Record<string,unknown>|null {
  return v && typeof v==="object"&&!Array.isArray(v)?v as Record<string,unknown>:null;
}
function matchesFreshRead(raw:unknown,i:VerifiedIntent):boolean {
  const x=asObj(raw);if(!x)return false;
  return x.id===i.disputeId && x.stage===i.stage && x.status==="REQUIRES_RESPONSE" &&
    x.card_brand==="visa" && x.currency===i.currency &&
    x.amount===i.amount && asObj(x.reason)?.original_code===i.reasonCode &&
    asObj(x.reason)?.type==="FRAUDULENT" &&
    typeof x.due_at==="string" && Number.isFinite(Date.parse(x.due_at)) &&
    Date.parse(x.due_at)===Date.parse(i.dueAt);
}
function challengeObserved(raw:unknown,i:VerifiedIntent):boolean {
  const x=asObj(raw);
  if(!x || x.id!==i.disputeId || x.stage!=="RFI" || x.status!=="CHALLENGED" ||
     x.card_brand!=="visa" || x.currency!==i.currency || x.amount!==i.amount ||
     asObj(x.reason)?.original_code!==i.reasonCode || asObj(x.reason)?.type!=="FRAUDULENT" ||
     typeof x.due_at!=="string" || !Number.isFinite(Date.parse(x.due_at)) ||
     Date.parse(x.due_at)!==Date.parse(i.dueAt) ||
     !Array.isArray(x.challenge_details))return false;
  return x.challenge_details.some((v:unknown)=>{
    const c=asObj(v);if(!c||c.stage!=="RFI"||c.challenge_method!=="STANDARD"||
       c.challenged_by!==i.actor)return false;
    const docs=asObj(c.supporting_documents)?.documents;
    if(!Array.isArray(docs))return false;
    const ids=docs.flatMap((d:unknown)=>{
      const fs=asObj(d)?.file_ids;return Array.isArray(fs)?fs:[];
    });
    return i.evidenceFileIds.every(id=>ids.includes(id));
  });
}
function journalFile(dir:string,i:VerifiedIntent):string {
  return join(resolve(dir),sha("FT057_CASE:"+i.disputeId)+".json");
}
async function reserve(path:string,record:JournalRecord):Promise<boolean>{
  await mkdir(dirname(path),{recursive:true});
  let handle;
  try{handle=await open(path,"wx",0o600)}
  catch(e){if((e as NodeJS.ErrnoException).code==="EEXIST")return false;throw e}
  try{await handle.writeFile(JSON.stringify(record)+"\n");await handle.sync()}
  finally{await handle.close()}
  return true;
}
async function persist(path:string,rec:JournalRecord):Promise<void>{
  const temp=path+"."+randomUUID()+".tmp";
  const h=await open(temp,"wx",0o600);
  try{await h.writeFile(JSON.stringify(rec)+"\n");await h.sync()}finally{await h.close()}
  await rename(temp,path);
}
export async function inspectSandboxJournal(dir:string,i:VerifiedIntent):Promise<JournalRecord|null>{
  try {
    const raw=JSON.parse(await readFile(journalFile(dir,i),"utf8")) as JournalRecord;
    if(raw.schema!=="FT057_SANDBOX_JOURNAL_V1"||
      !["RESERVED","POST_OBSERVED","READBACK_OBSERVED","RECONCILE_REQUIRED"].includes(raw.state)||
      raw.intentDigest!==intentDigest(i))throw Error("FT057_JOURNAL_INVALID_OR_STALE");
    return raw;
  }catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return null;throw e}
}
/**
 * This cannot execute by itself. It requires an externally provided authenticated
 * port, trusted gate and one-shot owner approval. No default transport exists.
 * Any failure after reservation is ambiguous; it never retries POST.
 */
export async function executeSandboxRfiChallenge(input:{
  intent:VerifiedIntent;approval:OwnerOneShot;port:AuthenticatedSandboxPort;
  gate:IndependentGate;journalDir:string;now:number;
}):Promise<SandboxExecutionResult>{
  const {intent,approval,port,gate,journalDir,now}=input;
  if(!isValid(intent,now))return fail("INTENT_INVALID_OR_INCOMPLETE");
  const digest=intentDigest(intent);
  if(!approval || approval.intendedAction!=="CHALLENGE" || approval.intentDigest!==digest ||
     approval.actor!==intent.actor ||approval.consumed!==false ||
     typeof approval.approvalId!=="string"||approval.approvalId.length<8||
     !Number.isFinite(approval.approvedAt)||approval.approvedAt>now ||
     !Number.isFinite(approval.expiresAt)||approval.expiresAt<=now)
    return fail("OWNER_APPROVAL_INVALID");
  if(!port || port.environment!=="AIRWALLEX_SANDBOX" || typeof port.send!=="function")
    return fail("AUTHENTICATED_SANDBOX_PORT_REQUIRED");
  if(!gate || typeof gate.authenticate!=="function")return fail("INDEPENDENT_AUTHORITY_REQUIRED");
  // May itself validate evidence File Service IDs and authenticated owner action.
  if(await gate.authenticate(intent,approval)!==true)return fail("INDEPENDENT_ATTESTATION_REJECTED");

  const path=base+encodeURIComponent(intent.disputeId);
  const j=journalFile(journalDir,intent);
  const rec:JournalRecord={schema:"FT057_SANDBOX_JOURNAL_V1",state:"RESERVED",
    intentDigest:digest,requestId:randomUUID(),
    approvalDigest:sha(approval.approvalId+":"+digest)};
  // Atomic first-use reservation must precede any network request.
  if(!(await reserve(j,rec)))return fail("DURABLE_FENCE_ALREADY_USED");
  let gets:0|1|2=0,posts:0|1=0,confirmed=false,observed=false;
  try{
    gets=1;
    const before=await port.send({method:"GET",path,retry:false});
    if(before.status!==200||!matchesFreshRead(before.body,intent))throw Error("PRE_GET_MISMATCH_OR_UNAVAILABLE");
    if(Date.parse(intent.dueAt)-now<=15*60_000)throw Error("DEADLINE_NO_LONGER_SAFE");
    const body:ChallengeBody={
      request_id:rec.requestId,challenge_method:"STANDARD",reason:"OTHER_REASONS",
      challenged_by:intent.actor,supporting_documents:{documents:[
        {type:"PRIMARY",file_ids:[...intent.evidenceFileIds],
          description:"Evidence attached and independently attested by merchant"}]}
    };
    // One attempt only. A timeout/5xx leaves the journal locked.
    posts=1;
    const post=await port.send({method:"POST",path:path+"/challenge",body,retry:false});
    if(post.status!==200)throw Error("POST_UNCONFIRMED_HTTP_STATUS");
    rec.state="POST_OBSERVED";await persist(j,rec);
    confirmed=true;
    gets=2;
    const after=await port.send({method:"GET",path,retry:false});
    observed=after.status===200 && challengeObserved(after.body,intent);
    if(!observed)throw Error("POST_GET_CHALLENGE_NOT_ATTESTED");
    rec.state="READBACK_OBSERVED";await persist(j,rec);
    return {schema:"FT057_SANDBOX_BOUNDARY_V1",state:"SUBMISSION_OBSERVED",
      postAttempts:posts,getAttempts:gets,liveOutcomeVerified:false,
      challengeAcceptedByProvider:confirmed,caseReadbackVerified:true,
      journalState:rec.state,classification:"SANDBOX_ONLY_NOT_ISSUER_RESULT",reasons:[]};
  }catch{
    rec.state="RECONCILE_REQUIRED";
    try{await persist(j,rec)}catch{/* old RESERVED remains a non-replay fence */}
    return {schema:"FT057_SANDBOX_BOUNDARY_V1",state:"AMBIGUOUS",postAttempts:posts,
      getAttempts:gets,liveOutcomeVerified:false,challengeAcceptedByProvider:confirmed,
      caseReadbackVerified:observed,journalState:"RECONCILE_REQUIRED",
      classification:"SANDBOX_ONLY_NOT_ISSUER_RESULT",
      reasons:["MANUAL_PROVIDER_RECONCILIATION_REQUIRED_NO_AUTO_RETRY"]};
  }
}
