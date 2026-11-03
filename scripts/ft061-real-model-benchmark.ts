/**
 * FT061 — real-model independent evidence-grounding evaluation (local loopback ONLY).
 * Never calls Airwallex. No fallback to mock. Never stores raw model output or source text.
 *
 * Example:
 * node --disable-warning=ExperimentalWarning --import tsx scripts/ft061-real-model-benchmark.ts
 *   --model ft061-qwen3-4b --limit 50
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { INDEPENDENT_EVIDENCE_CORPUS } from "./fixtures/evidence-independent-corpus.ts";
import { ingestOfflineTextEvidence } from "../spike/dispute-evidence.ts";
import {
  LocalRuntimeProposalProvider, enrichModelProposals, PROMPT_VERSION, PROPOSAL_VERSION,
  type ModelEvidenceClaim,
} from "../spike/evidence-proposals.ts";

const args = process.argv.slice(2);
const value = (name:string):string|undefined => {
  const i=args.indexOf(name);
  if(i<0) return undefined;
  if(i+1>=args.length || args[i+1]!.startsWith("--"))throw Error("FT061_MISSING_"+name.slice(2).toUpperCase());
  return args[i+1];
};
const model=value("--model");
const endpoint=value("--endpoint")??"http://127.0.0.1:1234/v1/chat/completions";
const count=Number(value("--limit")??"50");
const timeout=Number(value("--timeout-ms")??"60000");
if(!model || !/^[a-zA-Z0-9._/-]{3,100}$/.test(model))throw Error("FT061_REAL_MODEL_ID_REQUIRED");
if(!Number.isSafeInteger(count)||count<1||count>50)throw Error("FT061_INVALID_LIMIT");
if(!Number.isSafeInteger(timeout)||timeout<1000||timeout>180000)throw Error("FT061_TIMEOUT_INVALID");
const output=resolve(value("--output")??"out/ft061-real-model/evaluation.json");
const provider=new LocalRuntimeProposalProvider({model,endpoint,enabled:true,timeoutMs:timeout});
const corpus=count===50?INDEPENDENT_EVIDENCE_CORPUS:Array.from({length:count},(_,i)=>INDEPENDENT_EVIDENCE_CORPUS[Math.floor(i*50/count)]!);
const corpusDigest=createHash("sha256").update(JSON.stringify(INDEPENDENT_EVIDENCE_CORPUS),"utf8").digest("hex");
const now=new Date().toISOString();
const rows:Array<{
  id:string;category:string;expected:"SUPPORTED"|"UNSUPPORTED";
  result:"GROUNDED"|"NOT_GROUNDED"|"MODEL_ERROR";
  modelLatencyMs:number|null;rejectionReasons:string[];errorCode?:string;
}>=[];
let tp=0,fp=0,fn=0,tn=0,errors=0,totalLatency=0;
for(const entry of corpus){
  const doc=ingestOfflineTextEvidence("ft061-independent-evaluation",entry.id,entry.text,now);
  let result:"GROUNDED"|"NOT_GROUNDED"|"MODEL_ERROR"="MODEL_ERROR";
  let errorCode:string|undefined;
  let rejectionReasons:string[]=[];
  try{
    const response=await provider.propose(doc,now) as {proposals?:ModelEvidenceClaim[]};
    if(!response || !Array.isArray(response.proposals))throw Error("FT061_INVALID_PROVIDER_ENVELOPE");
    const enriched=enrichModelProposals(response.proposals,doc,provider.actualModelId,now);
    const grounded=enriched.some(e=>e.groundingReasonCode==="GROUNDED");
    result=grounded?"GROUNDED":"NOT_GROUNDED";
    rejectionReasons=[...new Set(enriched.filter(e=>e.groundingReasonCode!=="GROUNDED").map(e=>e.groundingReasonCode))];
    if(entry.expected==="SUPPORTED"){if(grounded)tp++;else fn++}
    else{if(grounded)fp++;else tn++}
  }catch(e){
    errors++;
    const message=e instanceof Error?e.message:"UNKNOWN";
    errorCode=/^[A-Z0-9_]+$/.test(message)?message:"FT061_UNCLASSIFIED_PROVIDER_ERROR";
  }
  totalLatency+=provider.lastModelLatencyMs??0;
  rows.push({id:entry.id,category:entry.category,expected:entry.expected,result,
    modelLatencyMs:provider.lastModelLatencyMs,rejectionReasons,...(errorCode?{errorCode}:{})});
}
const complete=errors===0&&rows.length===count;
const latency=rows.map(r=>r.modelLatencyMs).filter((v):v is number=>typeof v==="number").sort((a,b)=>a-b);
const percentile=(p:number)=>latency.length?latency[Math.min(latency.length-1,Math.ceil(latency.length*p)-1)]:null;
const receipt={
 schema:"FT061_REAL_LOCAL_MODEL_EVIDENCE_BENCHMARK_V1",
 dateUtc:new Date().toISOString(),
 provenance:"LOCAL_LLM_INFERENCE_NOT_AIRWALLEX_NOT_ISSUER",
 modelRequested:model, modelIdentityObserved:provider.actualModelId,
 endpointOrigin:new URL(endpoint).origin,
 corpus:"INDEPENDENT_PARAPHRASE_SET_V1",fullCorpusSha256:corpusDigest,
 evaluatedCases:count,fullCorpusSize:INDEPENDENT_EVIDENCE_CORPUS.length, sampling:count===50?"FULL":"DETERMINISTIC_STRATIFIED_PILOT",
 promptVersion:PROMPT_VERSION,proposalVersion:PROPOSAL_VERSION,
 complete,status:complete?"MEASURED_COMPLETE":"INCOMPLETE_NO_QUALITY_CLAIM",
 counts:{tp,fp,fn,tn,errors},
 metrics:complete?{
   precision:tp+fp?tp/(tp+fp):null,
   recall:tp+fn?tp/(tp+fn):null,
   falsePositiveRate:fp+tn?fp/(fp+tn):null,
   groundedUnsafePositiveCount:fp,
 }:null,
 latencyMs:{p50:percentile(.5),p95:percentile(.95),total:totalLatency},
 realProviderCalls:0,financialMutations:0,
 rows,
};
await mkdir(dirname(output),{recursive:true});
await writeFile(output,JSON.stringify(receipt,null,2)+"\n",{flag:"wx",encoding:"utf8",mode:0o600});
console.log(JSON.stringify({output,status:receipt.status,complete,modelIdentityObserved:provider.actualModelId,
  counts:receipt.counts,metrics:receipt.metrics,latencyMs:receipt.latencyMs}));
if(!complete)process.exitCode=1;
