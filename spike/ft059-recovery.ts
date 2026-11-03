/**
 * FT059: read-only recovery adjudication after interrupted sandbox operations.
 * No automatic POST replay, journal deletion or mutation. No network calls.
 */
import {inspectSandboxJournal,type VerifiedIntent} from "./ft057-sandbox-boundary.ts";
export type RecoveryDecision="MANUAL_REVIEW_REQUIRED"|"COMPLETED_NO_REPLAY"|"CORRUPT_LOCKED"|"NO_JOURNAL_NO_AUTHORIZATION";
export interface RecoveryAssessment{
 schema:"FT059_CRASH_RECOVERY_REVIEW_V1";
 decision:RecoveryDecision;
 automaticReplayAllowed:false;
 providerCalls:0;
 caseLocked:boolean;
 journalState:string|null;
 reasons:string[];
}
export async function reviewCrashRecovery(dir:string,intent:VerifiedIntent):Promise<RecoveryAssessment>{
 let state:string|null=null;
 try{state=(await inspectSandboxJournal(dir,intent))?.state??null}
 catch{return {
  schema:"FT059_CRASH_RECOVERY_REVIEW_V1",decision:"CORRUPT_LOCKED",
  automaticReplayAllowed:false,providerCalls:0,caseLocked:true,journalState:null,
  reasons:["JOURNAL_UNREADABLE_OR_IDENTITY_MISMATCH_MANUAL_RECOVERY_REQUIRED"]
 }}
 const base={schema:"FT059_CRASH_RECOVERY_REVIEW_V1" as const,
   automaticReplayAllowed:false as const,providerCalls:0 as const,journalState:state};
 if(!state)return {...base,decision:"NO_JOURNAL_NO_AUTHORIZATION",caseLocked:true,
   reasons:["NO_EXISTING_JOURNAL_REQUIRES_NEW_EXTERNAL_AUTHORIZATION"]};
 if(state==="READBACK_OBSERVED")
   return {...base,decision:"COMPLETED_NO_REPLAY",caseLocked:true,
     reasons:["RECORDED_SUBMISSION_MUST_NEVER_BE_REPLAYED"]};
 return {...base,decision:"MANUAL_REVIEW_REQUIRED",caseLocked:true,
   reasons:["POSSIBLE_PROVIDER_ACTION_RECONCILE_BY_READ_ONLY_GET_FIRST"]};
}
