/**
 * FT056: durable, non-network, mock-only Airwallex RFI execution rehearsal.
 * NEVER use as a live provider transport. Mock statuses are not Airwallex receipts.
 */
import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { buildMockStandardChallenge, mockPlanDigest, type MockChallengePlan, type StandardChallengeBody } from "./ft056-standard-challenge.ts";

type MockStatus="REQUIRES_RESPONSE"|"CHALLENGED"|"LOST";
type MockStage="RFI"|"PRE_ARBITRATION";
type JournalState="RESERVED"|"MOCK_POST_RECORDED"|"SIMULATED_CONFIRMED"|"RECONCILE_REQUIRED";
export interface MockOwnerConsent {
  action:"MOCK_CHALLENGE";
  caseDigest:string;
  owner:"mock_owner_local";
  issuedAt:number;
  expiresAt:number;
  consumed:false;
}
export interface RehearsalInput {
  plan:MockChallengePlan;
  consent?:MockOwnerConsent;
  journalDir:string;
  now:number;
  failure?:"NONE"|"TIMEOUT_BEFORE_MOCK_POST"|"TIMEOUT_AFTER_MOCK_POST"|"READBACK_UNAVAILABLE";
  simulateIssuerRejection?:boolean;
}
export interface RehearsalResult{
  schema:"FT056_MOCK_REHEARSAL_V1";
  classification:"MOCK_ONLY_NOT_AIRWALLEX";
  execution:"SIMULATED_ONLY"|"BLOCKED"|"AMBIGUOUS";
  challengeRequestPrepared:boolean;
  simulatedPostCount:0|1;
  simulatedGetCount:number;
  realProviderCalls:0;
  realFinancialMutations:0;
  journalState:JournalState|"NONE";
  readback:"NOT_AVAILABLE"|"MOCK_CHALLENGED";
  simulatedIssuerOutcome:"NONE"|"MOCK_PRE_ARBITRATION_LOST";
  replan:"NONE"|"HUMAN_REVIEW_NO_AUTOMATIC_RECHALLENGE";
  failureReasons:readonly string[];
  requestShape?:StandardChallengeBody;
}
interface JournalRecord {
  schema:"FT056_DISPATCH_JOURNAL_V1";
  state:JournalState;
  caseDigest:string;
  mockRequestId:string;
  updatedAt:number;
}
const validConsent=(input:RehearsalInput)=>!!input.consent &&
  input.consent.action==="MOCK_CHALLENGE" &&
  input.consent.owner==="mock_owner_local" && input.consent.consumed===false &&
  input.consent.caseDigest===mockPlanDigest(input.plan) &&
  Number.isFinite(input.consent.issuedAt) && input.consent.issuedAt<=input.now &&
  Number.isFinite(input.consent.expiresAt) && input.consent.expiresAt>input.now;
const fileFor=(plan:MockChallengePlan,dir:string)=>join(resolve(dir),
  createHash("sha256").update("MOCK_JOURNAL:"+plan.caseKey).digest("hex")+".json");
async function reserve(path:string,record:JournalRecord):Promise<boolean>{
  await mkdir(resolve(path,".."),{recursive:true});
  let handle;
  try {handle=await open(path,"wx",0o600);} catch(error){
    if((error as NodeJS.ErrnoException).code==="EEXIST")return false;
    throw error;
  }
  try{await handle.writeFile(JSON.stringify(record)+"\n");await handle.sync();}
  finally{await handle.close();}
  return true;
}
async function update(path:string,record:JournalRecord):Promise<void>{
  const temp=path+"."+process.pid+".tmp";
  try{
    await writeFile(temp,JSON.stringify(record)+"\n",{mode:0o600,flag:"wx"});
    await rename(temp,path);
  }finally{
    // A failed rename cannot be treated as success; leave original RESERVED as evidence.
  }
}
export async function inspectMockJournal(dir:string,plan:MockChallengePlan):Promise<Readonly<JournalRecord>|null>{
  const file=fileFor(plan,dir);
  try {
    const raw=await readFile(file,"utf8");
    const record=JSON.parse(raw) as JournalRecord;
    if(record.schema!=="FT056_DISPATCH_JOURNAL_V1" ||
       record.caseDigest!==mockPlanDigest(plan) ||
       !["RESERVED","MOCK_POST_RECORDED","SIMULATED_CONFIRMED","RECONCILE_REQUIRED"].includes(record.state))
      throw new Error("JOURNAL_CORRUPTED_OR_PLAN_CHANGED");
    return Object.freeze(record);
  } catch(error){
    if((error as NodeJS.ErrnoException).code==="ENOENT")return null;
    throw error;
  }
}
class InMemoryVisaMock{
  private status:MockStatus="REQUIRES_RESPONSE";
  private stage:MockStage="RFI";
  getCount=0;
  postCount=0;
  async get(available=true):Promise<{status:MockStatus;stage:MockStage}|null>{
    this.getCount++;
    return available?{status:this.status,stage:this.stage}:null;
  }
  async post(_body:StandardChallengeBody):Promise<void>{
    this.postCount++;
    if(this.status!=="REQUIRES_RESPONSE")throw Error("MOCK_PROVIDER_NOT_ACTIONABLE");
    this.status="CHALLENGED";
  }
  escalate(){
    if(this.status!=="CHALLENGED")throw Error("MOCK_ESCALATION_PRECONDITION");
    this.stage="PRE_ARBITRATION";this.status="LOST";
  }
}
const result=(data:Partial<RehearsalResult>):RehearsalResult=>({
  schema:"FT056_MOCK_REHEARSAL_V1",
  classification:"MOCK_ONLY_NOT_AIRWALLEX",
  execution:"BLOCKED",challengeRequestPrepared:false,
  simulatedPostCount:0,simulatedGetCount:0,
  realProviderCalls:0,realFinancialMutations:0,
  journalState:"NONE",readback:"NOT_AVAILABLE",simulatedIssuerOutcome:"NONE",
  replan:"NONE",failureReasons:[],
  ...data,
});
export async function runMockVisa104Rehearsal(input:RehearsalInput):Promise<RehearsalResult>{
  // Validate through builder: fixture MUST have explicit synthetic IDs, never real dispute IDs.
  let body:StandardChallengeBody;
  try{body=buildMockStandardChallenge(input.plan,input.now,"mock_owner_local");}
  catch(error){return result({failureReasons:[String(error)]});}
  if(!validConsent(input))return result({failureReasons:["EXPLICIT_MOCK_OWNER_CONSENT_REQUIRED"]});
  const file=fileFor(input.plan,input.journalDir);
  const digest=mockPlanDigest(input.plan);
  const record:JournalRecord={
    schema:"FT056_DISPATCH_JOURNAL_V1",state:"RESERVED",caseDigest:digest,
    mockRequestId:body.request_id,updatedAt:input.now,
  };
  if(!(await reserve(file,record)))return result({
    failureReasons:["DURABLE_CASE_FENCE_ALREADY_EXISTS"],
    journalState:"RECONCILE_REQUIRED"
  });
  const provider=new InMemoryVisaMock();
  let readback:RehearsalResult["readback"]="NOT_AVAILABLE";
  let issuer:RehearsalResult["simulatedIssuerOutcome"]="NONE";
  let replan:RehearsalResult["replan"]="NONE";
  try{
    const before=await provider.get();
    if(before?.stage!=="RFI"||before.status!=="REQUIRES_RESPONSE")
      throw Error("MOCK_PRE_GET_FAILED");
    if(input.failure==="TIMEOUT_BEFORE_MOCK_POST")throw Error("SIMULATED_TIMEOUT_BEFORE_POST");
    await provider.post(body);
    if(input.failure==="TIMEOUT_AFTER_MOCK_POST")throw Error("SIMULATED_TIMEOUT_AFTER_POST");
    record.state="MOCK_POST_RECORDED";await update(file,record);
    const after=await provider.get(input.failure!=="READBACK_UNAVAILABLE");
    if(after?.status!=="CHALLENGED"||after.stage!=="RFI")throw Error("MOCK_POST_GET_MISMATCH");
    readback="MOCK_CHALLENGED";
    if(input.simulateIssuerRejection){
      provider.escalate();
      const simulated=await provider.get();
      if(simulated?.status!=="LOST"||simulated.stage!=="PRE_ARBITRATION")
        throw Error("MOCK_ISSUER_READBACK_MISMATCH");
      issuer="MOCK_PRE_ARBITRATION_LOST";
      replan="HUMAN_REVIEW_NO_AUTOMATIC_RECHALLENGE";
    }
    record.state="SIMULATED_CONFIRMED";await update(file,record);
    return result({
      execution:"SIMULATED_ONLY",challengeRequestPrepared:true,
      simulatedPostCount:1,simulatedGetCount:provider.getCount,journalState:record.state,
      readback,simulatedIssuerOutcome:issuer,replan,failureReasons:[],
      requestShape:body
    });
  }catch(error){
    record.state="RECONCILE_REQUIRED";await update(file,record);
    return result({
      execution:"AMBIGUOUS",challengeRequestPrepared:true,
      simulatedPostCount:provider.postCount as 0|1,simulatedGetCount:provider.getCount,
      journalState:record.state,readback,
      failureReasons:[String(error)],
      requestShape:body
    });
  }
}
