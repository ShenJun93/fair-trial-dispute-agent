/** Synthetic-only local model evaluation. Every model response, malformed output and grounding failure is retained. */
import { createHash } from "node:crypto";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { ingestOfflineTextEvidence } from "../spike/dispute-evidence.ts";
import { DEFAULT_LOCAL_MODEL_TIMEOUT_MS, enrichModelProposals, MODEL_OUTPUT_CONTRACT_VERSION, LocalRuntimeProposalProvider,
  parseModelProposalResponse, PROMPT_VERSION, PROPOSAL_VERSION, type EnrichedModelProposal } from "../spike/evidence-proposals.ts";
import { INDEPENDENT_EVIDENCE_CORPUS } from "./fixtures/evidence-independent-corpus.ts";

const model = process.env.LOCAL_MODEL_ID;
if (!model?.trim()) throw new Error("LOCAL_MODEL_ID is required; no mock fallback is used by this evaluator");
const endpoint=process.env.LOCAL_MODEL_ENDPOINT ?? "http://127.0.0.1:12345/v1/chat/completions";
const timeoutMs=Number(process.env.LOCAL_MODEL_TIMEOUT_MS ?? DEFAULT_LOCAL_MODEL_TIMEOUT_MS);
const runtimeId=process.env.LOCAL_MODEL_RUNTIME_ID?.trim() || "UNSPECIFIED";
const quantization=process.env.LOCAL_MODEL_QUANTIZATION?.trim() || "UNSPECIFIED";
const provider = new LocalRuntimeProposalProvider({ endpoint, model, enabled:true, timeoutMs });
const negativeSmoke = INDEPENDENT_EVIDENCE_CORPUS.filter(item => item.expected === "UNSUPPORTED" &&
  ["CONFLICTING_EVIDENCE", "NEGATION", "AMBIGUOUS", "IRRELEVANT_DELIVERY_REFUND", "FALSE_ISSUER_INSTRUCTION"].includes(item.category))
  .filter((item, index, all) => all.findIndex(other => other.category === item.category) === index);
const injectionSmoke = INDEPENDENT_EVIDENCE_CORPUS.filter(item => item.expected === "SUPPORTED" && item.category === "PROMPT_INJECTION_WITH_CLAIM").slice(0,1);
const args=process.argv.slice(2);
const items = args.includes("--one") ? INDEPENDENT_EVIDENCE_CORPUS.slice(0,1) :
  args.includes("--smoke") ? INDEPENDENT_EVIDENCE_CORPUS.slice(0,5) :
  args.includes("--negative-smoke") ? negativeSmoke :
  args.includes("--balanced-adversarial-smoke") ? [...INDEPENDENT_EVIDENCE_CORPUS.slice(0,5),...negativeSmoke,...injectionSmoke] :
  args.includes("--balanced-smoke") ? [...INDEPENDENT_EVIDENCE_CORPUS.slice(0,5),...negativeSmoke] : INDEPENDENT_EVIDENCE_CORPUS;
if(items.length===INDEPENDENT_EVIDENCE_CORPUS.length&&(runtimeId==="UNSPECIFIED"||quantization==="UNSPECIFIED"))
  throw new Error("LOCAL_MODEL_RUNTIME_ID_AND_QUANTIZATION_REQUIRED_FOR_FULL_EVALUATION");
const outputIndex=args.indexOf("--output");
if(outputIndex>=0&&!args[outputIndex+1])throw new Error("OUTPUT_PATH_REQUIRED");
const outputPath=resolve(outputIndex>=0?args[outputIndex+1]!:"out/evidence-real-evaluation-v5.json");
const corpusDigest=createHash("sha256").update(JSON.stringify(INDEPENDENT_EVIDENCE_CORPUS)).digest("hex");
const runConfiguration={evaluatorContractVersion:"ft-agentic-real-evaluation-v5",modelOutputContractVersion:MODEL_OUTPUT_CONTRACT_VERSION,
  adapterContractVersion:"local-runtime-model-identity-v2",modelIdentityPolicy:"exact-model-list-and-completion-match",
  redirectPolicy:"error",groundingPolicyVersion:"risk-claim-ground-v1",model,quantization,runtimeId,endpoint,timeoutMs,
  promptVersion:PROMPT_VERSION,proposalVersion:PROPOSAL_VERSION,contextLength:Number(process.env.LOCAL_MODEL_CONTEXT_LENGTH)||null,
  gpuLayers:Number(process.env.LOCAL_MODEL_GPU_LAYERS)||0,corpusDigest,caseIds:items.map(item=>item.id),responseSchema:MODEL_OUTPUT_CONTRACT_VERSION};
const runConfigurationDigest=createHash("sha256").update(JSON.stringify(runConfiguration)).digest("hex");
type EnrichedRecord={factType:string;exactQuote:string;startOffset:number;endOffset:number;groundingReasonCode:string;groundingStatus:"GROUNDED"|"REJECTED"};
type Result={id:string;category:string;expected:string;stage:"MODEL_DISCOVERY"|"CHAT_COMPLETION"|"COMPACT_SCHEMA"|"ENRICHMENT"|"COMPLETE";
  compactSchemaValid:boolean;rawModelProposalCount:number;rawModelProposals:Array<{factType:string;exactQuote:string}>;
  locallyEnrichedProposals:EnrichedRecord[];quoteUniquenessFailures:number;groundingFailures:number;semanticFalsePositives:number;
  rawPredicted:boolean;groundedPredicted:boolean;modelLatencyMs:number|null;validationLatencyMs:number|null;
  operationalFailure:boolean;rawResponse:string|null;error:string|null};
mkdirSync(resolve(outputPath,".."),{recursive:true});
let results:Result[]=[];
if(args.includes("--resume")&&existsSync(outputPath)){
  const prior=JSON.parse(readFileSync(outputPath,"utf8")) as {runConfigurationDigest?:string;actualModelIdentity?:{verifiedModelId?:string|null};results:Result[]};
  if(prior.runConfigurationDigest!==runConfigurationDigest)throw new Error("RESUME_MODEL_OR_CONFIGURATION_MISMATCH");
  if(prior.actualModelIdentity?.verifiedModelId===model)provider.actualModelId=model;
  results=prior.results;
}
function percentile(values:number[],p:number):number|null{
  if(!values.length)return null; const ordered=[...values].sort((a,b)=>a-b);
  return Number(ordered[Math.min(ordered.length-1,Math.ceil(p*ordered.length)-1)]!.toFixed(2));
}
function metric(tp:number,fp:number,fn:number){
  const precision=tp+fp?tp/(tp+fp):null,recall=tp+fn?tp/(tp+fn):null;
  return {truePositive:tp,falsePositive:fp,falseNegative:fn,precision,recall,
    f1:precision!==null&&recall!==null&&precision+recall>0?2*precision*recall/(precision+recall):null,
    precisionDenominator:tp+fp,recallDenominator:tp+fn};
}
function summarize(){
  const positives=results.filter(row=>row.expected==="SUPPORTED"), negatives=results.filter(row=>row.expected==="UNSUPPORTED");
  const completed=results.filter(row=>row.compactSchemaValid), validPositives=completed.filter(row=>row.expected==="SUPPORTED"), validNegatives=completed.filter(row=>row.expected==="UNSUPPORTED");
  const rawTp=validPositives.filter(row=>row.rawPredicted).length,rawFp=validNegatives.filter(row=>row.rawPredicted).length;
  const groundedTp=validPositives.filter(row=>row.groundedPredicted).length,groundedFp=validNegatives.filter(row=>row.groundedPredicted).length;
  const enriched=results.flatMap(row=>row.locallyEnrichedProposals);
  return {schemaVersion:"fair-trial-local-model-evaluation/v5",model,endpointBoundary:"numeric loopback HTTP only",corpus:"INDEPENDENT_EVIDENCE_CORPUS_V1",
    actualModelIdentity:{requested:model,verifiedModelId:provider.actualModelId,verified:provider.actualModelId===model},
    runConfiguration,runConfigurationDigest,corpusDigest,attempted:results.length,target:items.length,corpusSize:INDEPENDENT_EVIDENCE_CORPUS.length,
    rawModelProposalCount:results.reduce((sum,row)=>sum+row.rawModelProposalCount,0),
    compactSchema:{validResponses:completed.length,invalidResponses:results.filter(row=>row.stage==="COMPACT_SCHEMA").length,
      responseDenominator:results.length,validRate:results.length?completed.length/results.length:null},
    locallyEnrichedProposalCount:enriched.length,
    rawProposalClassification:{scope:"syntactically valid compact model responses before local quote/grounding checks",...metric(rawTp,rawFp,validPositives.length-rawTp)},
    groundedClassification:{scope:"locally enriched claims passing unique quote, source hash, contradiction and semantic checks",...metric(groundedTp,groundedFp,validPositives.length-groundedTp)},
    supportedClaimRecall:{raw:{numerator:rawTp,denominator:positives.length,value:positives.length?rawTp/positives.length:null},
      grounded:{numerator:groundedTp,denominator:positives.length,value:positives.length?groundedTp/positives.length:null},
      scope:"end-to-end over all expected-supported cases; invalid/unavailable output remains a miss"},
    unsupportedClaims:{denominator:negatives.length,semanticFalsePositives:groundedFp,groundedFalsePositiveRate:negatives.length?groundedFp/negatives.length:null,
      rawFalsePositives:rawFp,unavailableOrInvalid:negatives.length-validNegatives.length},
    quoteUniquenessFailures:results.reduce((sum,row)=>sum+row.quoteUniquenessFailures,0),
    groundingFailures:results.reduce((sum,row)=>sum+row.groundingFailures,0),
    semanticFalsePositives:results.reduce((sum,row)=>sum+row.semanticFalsePositives,0),
    operationalFailures:results.filter(row=>row.operationalFailure).length,
    contradictions:{attempted:results.filter(row=>row.category==="CONFLICTING_EVIDENCE").length,
      rawProposals:results.filter(row=>row.category==="CONFLICTING_EVIDENCE"&&row.rawPredicted).length,
      groundedProposals:results.filter(row=>row.category==="CONFLICTING_EVIDENCE"&&row.groundedPredicted).length},
    promptInjection:{attempted:results.filter(row=>/INJECTION|FALSE_ISSUER_INSTRUCTION/.test(row.category)).length,
      groundedClaims:results.filter(row=>/INJECTION|FALSE_ISSUER_INSTRUCTION/.test(row.category)&&row.groundedPredicted).length,
      unsafeActionsPossible:false,explanation:"The model schema contains only factType and exactQuote; no tools, policy or execution fields exist."},
    latencyMs:{model:{p50:percentile(results.map(row=>row.modelLatencyMs).filter((value):value is number=>value!==null),0.5),
      p95:percentile(results.map(row=>row.modelLatencyMs).filter((value):value is number=>value!==null),0.95),unit:"milliseconds; completion HTTP round-trip"},
      validation:{p50:percentile(results.map(row=>row.validationLatencyMs).filter((value):value is number=>value!==null),0.5),
        p95:percentile(results.map(row=>row.validationLatencyMs).filter((value):value is number=>value!==null),0.95),unit:"milliseconds; schema parse + trusted enrichment + grounding"}},
    executionCost:{currency:"USD",measured:null,note:"Local inference cost was not measured; no cloud/API billing is inferred."},results};
}
function save(){writeFileSync(outputPath,JSON.stringify(summarize(),null,2)+"\n");}
for(const item of items){
  if(results.some(row=>row.id===item.id))continue;
  const document=ingestOfflineTextEvidence("kit04-evidence-lab",item.id,item.text,"2026-10-28T08:00:00.000Z");
  let result:Result={id:item.id,category:item.category,expected:item.expected,stage:"MODEL_DISCOVERY",compactSchemaValid:false,
    rawModelProposalCount:0,rawModelProposals:[],locallyEnrichedProposals:[],quoteUniquenessFailures:0,groundingFailures:0,
    semanticFalsePositives:0,rawPredicted:false,groundedPredicted:false,modelLatencyMs:null,validationLatencyMs:null,
    operationalFailure:false,rawResponse:null,error:null};
  try{
    const output=await provider.propose(document,"2026-10-28T08:00:00.000Z") as {proposals:unknown;extractionContractVersion?:unknown};
    result.stage="COMPACT_SCHEMA";
    const validationStarted=performance.now();
    if(output.extractionContractVersion!==MODEL_OUTPUT_CONTRACT_VERSION)throw new Error("MODEL_EXTRACTION_CONTRACT_VERSION_MISMATCH");
    const claims=parseModelProposalResponse({proposals:output.proposals});
    result.compactSchemaValid=true;
    result.rawModelProposalCount=claims.length;
    result.rawModelProposals=claims.map(claim=>({factType:claim.factType,exactQuote:claim.exactQuote}));
    result.rawPredicted=claims.length>0;
    result.stage="ENRICHMENT";
    const enriched:EnrichedModelProposal[]=enrichModelProposals(claims,document,provider.actualModelId,"2026-10-28T08:00:00.000Z");
    result.validationLatencyMs=Number((performance.now()-validationStarted+(provider.lastValidationLatencyMs??0)).toFixed(2));
    result.modelLatencyMs=provider.lastModelLatencyMs;
    result.locallyEnrichedProposals=enriched.map(({proposal,groundingReasonCode})=>({factType:proposal.factType,exactQuote:proposal.exactQuote,
      startOffset:proposal.startOffset,endOffset:proposal.endOffset,groundingReasonCode,groundingStatus:groundingReasonCode==="GROUNDED"?"GROUNDED":"REJECTED"}));
    result.quoteUniquenessFailures=enriched.filter(row=>row.groundingReasonCode==="QUOTE_NOT_FOUND"||row.groundingReasonCode==="QUOTE_NOT_UNIQUE").length;
    result.groundingFailures=enriched.filter(row=>row.groundingReasonCode!=="GROUNDED").length;
    result.groundedPredicted=enriched.some(row=>row.groundingReasonCode==="GROUNDED");
    result.semanticFalsePositives=item.expected==="UNSUPPORTED"?enriched.filter(row=>row.groundingReasonCode==="GROUNDED").length:0;
    result.stage="COMPLETE";
  }catch(error){
    const code=error instanceof Error?error.message:"UNKNOWN_MODEL_EVALUATION_FAILURE";
    result.error=code;
    result.rawResponse=provider.lastRawResponse;
    result.modelLatencyMs=provider.lastModelLatencyMs;
    result.validationLatencyMs=provider.lastValidationLatencyMs;
    result.operationalFailure=result.stage==="MODEL_DISCOVERY"||code.startsWith("LOCAL_MODEL_COMPLETION")||code==="LOCAL_MODEL_REQUEST_FAILED";
    if(code.startsWith("LOCAL_MODEL_COMPLETION")||code==="LOCAL_MODEL_REQUEST_FAILED")result.stage="CHAT_COMPLETION";
    else if(code.includes("SCHEMA")||code.includes("JSON")||code==="PROPOSAL_RESPONSE_TOO_LARGE")result.stage="COMPACT_SCHEMA";
    else if(result.stage!=="MODEL_DISCOVERY")result.stage="ENRICHMENT";
    if(provider.lastRawResponse)result.rawResponse=provider.lastRawResponse;
  }
  result.rawResponse ??= provider.lastRawResponse;
  results.push(result); save();
  console.log(`${results.length}/${items.length} ${item.id}: ${result.error??(result.groundedPredicted?"GROUNDED":"REJECTED_OR_NO_CLAIM")}`);
}
save();
console.log(JSON.stringify({output:outputPath,...summarize()},null,2));
