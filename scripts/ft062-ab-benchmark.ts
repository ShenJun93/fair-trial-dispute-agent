/** FT062 local LLM A/B; source-only synthetic holdout; no provider access. */
import {createHash} from "node:crypto";
import {mkdir,writeFile,rename,rm} from "node:fs/promises";
import {resolve,dirname} from "node:path";
import {FT062_HOLDOUT} from "./fixtures/ft062-holdout.ts";
import {ingestOfflineTextEvidence} from "../spike/dispute-evidence.ts";
import {LocalRuntimeProposalProvider,enrichModelProposals,type ModelEvidenceClaim} from "../spike/evidence-proposals.ts";
import {runAnchoredLocalInference} from "./ft062-anchored-inference.ts";
const args=process.argv.slice(2);
function arg(n:string,def:string){const p=args.indexOf(n);return p<0?def:args[p+1]!}
const limit=Number(arg("--limit","20")),model=arg("--model","qwen3-4b-instruct-2507");
if(!Number.isSafeInteger(limit)||limit<2||limit>20||limit%2!==0)throw Error("FT062_LIMIT_INVALID");
const corpus=limit===20?FT062_HOLDOUT:[
  ...FT062_HOLDOUT.filter(x=>x.expected==="SUPPORTED").slice(0,limit/2),
  ...FT062_HOLDOUT.filter(x=>x.expected==="UNSUPPORTED").slice(0,limit/2)];
const endpoint="http://127.0.0.1:1234/v1/chat/completions",now=new Date().toISOString();
const dir=resolve(arg("--output-dir","out/ft062-ab"));
await mkdir(dir,{recursive:true});
const provider=new LocalRuntimeProposalProvider({model,endpoint,enabled:true,timeoutMs:90000});
const rows:Array<{id:string;category:string;expected:string;v2:"GROUNDED"|"NOT_GROUNDED"|"ERROR";v3:"GROUNDED"|"NOT_GROUNDED"|"ERROR";v2Latency:number|null;v3Latency:number|null;v2Reasons:string[];v3Reasons:string[];v2Error?:string;v3Error?:string}>=[];
const digest=createHash("sha256").update(JSON.stringify(FT062_HOLDOUT)).digest("hex");
function summarize(version:"v2"|"v3"){
 let tp=0,fp=0,fn=0,tn=0,errors=0;
 const latency:number[]=[];
 for(const x of rows){
  const val=x[version];
  const t=version==="v2"?x.v2Latency:x.v3Latency;
  if(t!==null)latency.push(t);
  if(val==="ERROR"){errors++;continue}
  if(x.expected==="SUPPORTED"){if(val==="GROUNDED")tp++;else fn++}
  else{if(val==="GROUNDED")fp++;else tn++}
 }
 latency.sort((a,b)=>a-b);
 return {tp,fp,fn,tn,errors,precision:tp+fp?tp/(tp+fp):null,
  recall:tp+fn?tp/(tp+fn):null,unsafePositiveCount:fp,
  p50:latency.length?latency[Math.ceil(latency.length*.5)-1]:null,
  p95:latency.length?latency[Math.ceil(latency.length*.95)-1]:null};
}
async function checkpoint(){
 const state={schema:"FT062_AB_CHECKPOINT_V1",status:"INCOMPLETE_NO_QUALITY_CLAIM",
  model,corpusDigest:digest,evaluated:rows.length,target:corpus.length,
  v2:summarize("v2"),v3:summarize("v3"),rows};
 const temp=resolve(dir,"checkpoint.tmp.json"),target=resolve(dir,"checkpoint.json");
 await writeFile(temp,JSON.stringify(state,null,2)+"\n",{mode:0o600});
 await rename(temp,target);
}
for(const item of corpus){
 const doc=ingestOfflineTextEvidence("ft062-holdout",item.id,item.text,now);
 const row:{id:string;category:string;expected:string;v2:"GROUNDED"|"NOT_GROUNDED"|"ERROR";v3:"GROUNDED"|"NOT_GROUNDED"|"ERROR";v2Latency:number|null;v3Latency:number|null;v2Reasons:string[];v3Reasons:string[];v2Error?:string;v3Error?:string}={
  id:item.id,category:item.category,expected:item.expected,v2:"ERROR",v3:"ERROR",
  v2Latency:null,v3Latency:null,v2Reasons:[],v3Reasons:[]};
 try{
  const out=await provider.propose(doc,now) as {proposals:ModelEvidenceClaim[]};
  const got=enrichModelProposals(out.proposals,doc,provider.actualModelId,now);
  row.v2=got.some(x=>x.groundingReasonCode==="GROUNDED")?"GROUNDED":"NOT_GROUNDED";
  row.v2Reasons=[...new Set(got.filter(x=>x.groundingReasonCode!=="GROUNDED").map(x=>x.groundingReasonCode))];
 }catch(e){row.v2Error=e instanceof Error?e.message:"UNKNOWN"}
 row.v2Latency=provider.lastModelLatencyMs;
 try{
  const out=await runAnchoredLocalInference(doc,model,endpoint,90000);
  row.v3=out.grounding.proposals.some(x=>x.groundingReasonCode==="GROUNDED")?"GROUNDED":"NOT_GROUNDED";
  row.v3Reasons=[...new Set(out.grounding.proposals.filter(x=>x.groundingReasonCode!=="GROUNDED").map(x=>x.groundingReasonCode))];
  row.v3Latency=out.latencyMs;
 }catch(e){row.v3Error=e instanceof Error?e.message:"UNKNOWN"}
 rows.push(row);await checkpoint();
 console.log(JSON.stringify({completed:rows.length,total:corpus.length,id:item.id,v2:row.v2,v3:row.v3}));
}
const complete=rows.length===corpus.length&&rows.every(r=>r.v2!=="ERROR"&&r.v3!=="ERROR");
const report={schema:"FT062_AB_REAL_MODEL_V1",status:complete?"MEASURED_COMPLETE":"INCOMPLETE_NO_QUALITY_CLAIM",
 model,source:"SYNTHETIC_HOLDOUT_ONLY",corpusDigest:digest,
 cases:rows.length,positive:corpus.filter(x=>x.expected==="SUPPORTED").length,
 negative:corpus.filter(x=>x.expected==="UNSUPPORTED").length,
 localInference:true,providerCalls:0,mutations:0,
 v2:summarize("v2"),v3:summarize("v3"),rows};
const output=resolve(dir,"result.json");
await writeFile(output,JSON.stringify(report,null,2)+"\n",{flag:"wx",mode:0o600});
console.log(JSON.stringify({output,status:report.status,cases:report.cases,v2:report.v2,v3:report.v3}));
if(!complete)process.exitCode=1;
