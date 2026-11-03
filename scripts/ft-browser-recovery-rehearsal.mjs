import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const runId=`ft-browser-recovery-${new Date().toISOString().replaceAll(':','').replaceAll('.','')}-${process.pid}`;
const output=path.join(root,'out',runId);
await mkdir(output,{recursive:true});
const readiness=spawnSync(process.execPath,['scripts/ft-dashboard-readiness-preflight.mjs'],{cwd:root,encoding:'utf8',timeout:25_000,windowsHide:true});
let readinessReceipt=null;
try{
  const lastLine=(readiness.stdout??'').trim().split(/\r?\n/).at(-1);
  if(lastLine)readinessReceipt=JSON.parse(lastLine);
}catch{}
if(readiness.status!==0||readinessReceipt?.status!=='PASS'){
  const summary={schemaVersion:'fair-trial-ft-browser-recovery-rehearsal/v1',createdAt:new Date().toISOString(),status:'BLOCKED',
    provider:'FAKE_PROVIDER except recorded saved semantic output labeled RECORDED_REPLAY',modelStartup:false,providerMutation:false,
    cloudInference:false,syntheticOnly:true,runId,preflight:{status:readinessReceipt?.status??'NO_RECEIPT',
      runId:readinessReceipt?.runId??null,exitCode:readiness.status,stderrClass:readiness.error?.code??null,
      scenariosSkipped:9,reason:readinessReceipt?.status==='BLOCKED'?'DASHBOARD_LOOPBACK_READINESS_FAILED':'READINESS_PREFLIGHT_DID_NOT_PASS'}};
  await writeFile(path.join(output,'rehearsal-summary.json'),JSON.stringify(summary,null,2)+'\n');
  console.log(JSON.stringify({status:'BLOCKED',runId,preflight:summary.preflight,output}));
  process.exitCode=2;
}else{
const cases=[
  {name:'fake-positive',scenario:'positive',outcome:'grounded-positive',expected:'FAKE_PROVIDER_GROUNDED_POSITIVE'},
  {name:'fake-empty',scenario:'positive',outcome:'empty',expected:'SAFE_NO_PROPOSAL_SUPPORTED_MISS'},
  {name:'fake-unsupported-quote',scenario:'positive',outcome:'unsupported-quote',expected:'SAFE_REJECTED_UNSUPPORTED_QUOTE'},
  {name:'fake-malformed',scenario:'positive',outcome:'malformed',expected:'SAFE_MALFORMED_RESPONSE_REJECTED'},
  {name:'recorded-replay',scenario:'positive',outcome:'recorded-replay',expected:'RECORDED_REPLAY_GROUNDED_NOT_LIVE_INFERENCE'},
  {name:'fake-adversarial',scenario:'adversarial',outcome:'empty',expected:'SAFE_NO_PROPOSAL_SUPPORTED_MISS'},
  {name:'fake-adversarial-grounded-supported',scenario:'adversarial',outcome:'grounded-positive',expected:'SAFE_GROUNDED_SUPPORTED_CLAIM'},
  {name:'fake-timeout',scenario:'positive',outcome:'timeout',expected:'SAFE_TIMEOUT_FAIL_CLOSED'},
];
const results=[];
for(const item of cases){
  const dir=path.join(output,item.name);
  const args=['scripts/ft-agentic-005-browser-acceptance.mjs','--provider','FAKE_PROVIDER','--scenario',item.scenario,'--fake-outcome',item.outcome,'--output-dir',dir];
  const run=spawnSync(process.execPath,args,{cwd:root,encoding:'utf8',timeout:240_000,windowsHide:true});
  let receipt=null;try{receipt=JSON.parse(await readFile(path.join(dir,'browser-acceptance.json'),'utf8'))}catch{}
  const groundedAdversarial=item.expected==='SAFE_GROUNDED_SUPPORTED_CLAIM';
  const pass=run.status===0&&receipt?.status==='PASS'&&receipt.classification===item.expected&&receipt.providerAction==='NOT_EXECUTED'&&
    receipt.providerMutation===false&&receipt.cloudInference===false&&receipt.evidenceLabel===(item.outcome==='recorded-replay'?'RECORDED_REPLAY':'FAKE_PROVIDER')&&
    receipt.observation?.uiLoadingObserved===true&&receipt.observation?.evidenceIngestion?.status===200&&!!receipt.observation?.source?.digest&&
    receipt.observation?.unsupportedQuoteAccepted===false&&(!groundedAdversarial||(
      receipt.observation?.rawCompactProposalCount===1&&receipt.observation?.locallyEnrichedProposalCount===1&&
      receipt.observation?.groundedCount===1&&receipt.observation?.rejectedCount===0&&
      receipt.observation?.proposalRequest?.requestBoundary==='LOCAL_LOOPBACK_ONLY'&&
      receipt.observation?.proposalRequest?.providerActionState==='NOT_EXECUTED'&&
      receipt.fakeProviderRequest?.toolsPresent===false&&receipt.fakeProviderRequest?.requestedModel==='FAKE_PROVIDER_EVIDENCE_V2'))&&
      (!groundedAdversarial||(receipt.fakeProviderRequest?.injectionDetected===true&&receipt.fakeProviderRequest?.injectionAuthorityGranted===false))&&
    (item.outcome!=='recorded-replay'||receipt.fakeProviderRequest?.replaySource?.includes('not live inference'));
  results.push({name:item.name,expected:item.expected,exitCode:run.status,status:receipt?.status??'MISSING',classification:receipt?.classification??null,
    pass,requestStatus:receipt?.observation?.proposalRequest?.status??null,loadingObserved:receipt?.observation?.uiLoadingObserved??false,
    modelTimeout:receipt?.observation?.modelTimeout??false,renderedProposalCount:receipt?.observation?.renderedProposalCount??null,
    groundedProposalCount:receipt?.observation?.groundedCount??null,rejectedProposalCount:receipt?.observation?.rejectedCount??null,
    groundingRejectionReasons:receipt?.observation?.groundingRejectionReasons??[],supportedClaimMisses:receipt?.observation?.supportedClaimMisses??0,
    unsupportedProposalRejections:receipt?.observation?.unsupportedProposalRejections??0,
    unsupportedQuoteAccepted:receipt?.observation?.unsupportedQuoteAccepted??false,
    validAdversarialClaimGrounded:groundedAdversarial?receipt?.observation?.groundedCount===1:false,
    injectionDetected:receipt?.fakeProviderRequest?.injectionDetected??false,
    injectionAuthorityGranted:receipt?.fakeProviderRequest?.injectionAuthorityGranted??false});
}
const partialDir=path.join(output,'partial-receipt-preservation');
const partialRun=spawnSync(process.execPath,['scripts/ft-agentic-005-browser-acceptance.mjs','--provider','FAKE_PROVIDER','--scenario','positive','--fake-outcome','empty','--simulate-harness-failure','true','--output-dir',partialDir],
  {cwd:root,encoding:'utf8',timeout:240_000,windowsHide:true});
let partialReceipt=null;try{partialReceipt=JSON.parse(await readFile(path.join(partialDir,'browser-acceptance.json'),'utf8'))}catch{}
const partialPreserved=partialRun.status!==0&&partialReceipt?.status==='PARTIAL'&&partialReceipt.observation?.proposalRequest?.status===200;
results.push({name:'partial-receipt-preservation',exitCode:partialRun.status,status:partialReceipt?.status??'MISSING',pass:partialPreserved,
  observationPreserved:!!partialReceipt?.observation?.proposalRequest,screenshotPreserved:(await import('node:fs')).existsSync(path.join(partialDir,'failure-point.png'))});
const summary={schemaVersion:'fair-trial-ft-browser-recovery-rehearsal/v1',createdAt:new Date().toISOString(),status:results.every(x=>x.pass)?'PASS':'PARTIAL',
  provider:'FAKE_PROVIDER except recorded saved semantic output labeled RECORDED_REPLAY',modelStartup:false,providerMutation:false,cloudInference:false,syntheticOnly:true,
  runId,results};
await writeFile(path.join(output,'rehearsal-summary.json'),JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify({status:summary.status,runId,passed:results.filter(x=>x.pass).length,total:results.length,output}));
if(summary.status!=='PASS')process.exitCode=1;
}
