/** Targeted real-model evidence-quote recovery pilot; synthetic data, no provider calls. */
import {mkdir,writeFile} from "node:fs/promises";
import {resolve} from "node:path";
import {FT062_HOLDOUT} from "./fixtures/ft062-holdout.ts";
import {ingestOfflineTextEvidence} from "../spike/dispute-evidence.ts";
import {LocalRuntimeProposalProvider,enrichModelProposals,type ModelEvidenceClaim} from "../spike/evidence-proposals.ts";
import {recoverIdenticalRepeatedLine} from "./ft062-duplicate-recovery.ts";
const model="qwen3-4b-instruct-2507",now=new Date().toISOString();
const provider=new LocalRuntimeProposalProvider({model,
 endpoint:"http://127.0.0.1:1234/v1/chat/completions",enabled:true,timeoutMs:90000});
const cases=FT062_HOLDOUT.filter(x=>x.category==="POS_REPEATED");
const rows=[];
for(const x of cases){
 const doc=ingestOfflineTextEvidence("ft062-duplicate-pilot",x.id,x.text,now);
 let original=false,recovered=false;
 let error:string|null=null;
 let reasons:string[]=[];
 try{
  const r=await provider.propose(doc,now) as {proposals:ModelEvidenceClaim[]};
  const before=enrichModelProposals(r.proposals,doc,provider.actualModelId,now);
  original=before.some(x=>x.groundingReasonCode==="GROUNDED");
  reasons=before.map(x=>x.groundingReasonCode);
  recovered=original||r.proposals.some(x=>recoverIdenticalRepeatedLine(x,doc,model,now)!==null);
 }catch(e){error=e instanceof Error?e.message:"UNKNOWN"}
 rows.push({id:x.id,expected:x.expected,original,recovered,modelLatencyMs:provider.lastModelLatencyMs,
  reasons,error});
 console.log(JSON.stringify({id:x.id,original,recovered,error}));
}
const complete=rows.every(x=>x.error===null);
const report={schema:"FT062_DUPLICATE_MODEL_PILOT_V1",
 status:complete?"MEASURED_COMPLETE":"INCOMPLETE",model,
 scope:"3_SYNTHETIC_REPEATED_QUOTE_CASES_ONLY",
 count:rows.length,beforeGrounded:rows.filter(x=>x.original).length,
 afterGrounded:rows.filter(x=>x.recovered).length,
 falsePositiveAssessed:false,providerCalls:0,financialMutations:0,rows};
const path=resolve("out/ft062-ab/duplicate-recovery-pilot.json");
await mkdir(resolve("out/ft062-ab"),{recursive:true});
await writeFile(path,JSON.stringify(report,null,2)+"\n",{flag:"wx",mode:0o600});
console.log(JSON.stringify({path,status:report.status,count:rows.length,
 before:report.beforeGrounded,after:report.afterGrounded}));
if(!complete)process.exitCode=1;
