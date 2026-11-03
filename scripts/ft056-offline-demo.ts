/** FT056 judge-facing offline rehearsal — all activity mocked and explicitly labeled. */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runDisputeAgent } from "../spike/dispute-agent.ts";
import { mockPlanDigest,type MockChallengePlan } from "../spike/ft056-standard-challenge.ts";
import { runMockVisa104Rehearsal,type MockOwnerConsent } from "../spike/ft056-rehearsal.ts";
import { loadHistoricalProviderPortfolio } from "../spike/historical-provider-portfolio.ts";
import {evaluateVisa104OfflinePreflight,visa104FromHistoricalCase} from "../spike/visa104-safe-contract.ts";
const now=Date.parse("2026-11-02T12:00:00Z");
const digest=(s:string)=>createHash("sha256").update(s).digest("hex");
const output=resolve("out/ft056-qa");
await mkdir(output,{recursive:true});
const agent=await runDisputeAgent("synthetic-high-fraud",{now:()=>now});
if(agent.final.action!=="CHALLENGE_RECOMMENDED" || !agent.replan.occurred ||
  agent.providerAction!=="NOT_EXECUTED")throw Error("MOCK_AGENT_DECISION_FAILED_CLOSED");
const history=await loadHistoricalProviderPortfolio();
const realCaseGate=evaluateVisa104OfflinePreflight({
  identity:visa104FromHistoricalCase(history.cases[0]!),evidence:[],
  dispatchState:"NONE",alreadySubmitted:false,ce30Claimed:false,now,
});
if(realCaseGate.allowed!==false)throw Error("REAL_VISA_GATE_MUST_REMAIN_CLOSED");
const mockPlan:MockChallengePlan={
  caseKey:"mock_case_visa104",disputeId:"mock_dst_visa104a",stage:"RFI",
  status:"REQUIRES_RESPONSE",reasonCode:"10.4",currency:"USD",amountMinor:12000,
  dueAt:"2026-11-09T05:55:12Z",
  documents:[
    {type:"PRIMARY",fileId:"mock_file_authorization01",sourceHash:digest("synthetic-auth"),
      description:"Synthetic cardholder authorization fixture",synthetic:true},
    {type:"OTHER",fileId:"mock_file_delivery02",sourceHash:digest("synthetic-delivery"),
      description:"Synthetic delivery event fixture for offline rehearsal",synthetic:true},
  ],
};
const consent:MockOwnerConsent={
  action:"MOCK_CHALLENGE",caseDigest:mockPlanDigest(mockPlan),owner:"mock_owner_local",
  issuedAt:now-3000,expiresAt:now+90000,consumed:false,
};
const demo=await runMockVisa104Rehearsal({
  plan:mockPlan,consent,journalDir:resolve(output,"durable-fence"),now,
  simulateIssuerRejection:true
});
if(demo.execution!=="SIMULATED_ONLY" || demo.replan!=="HUMAN_REVIEW_NO_AUTOMATIC_RECHALLENGE" ||
  demo.simulatedPostCount!==1 || demo.realProviderCalls!==0)throw Error("SIMULATION_ASSERTIONS_FAILED");
const receipt={
  schema:"FT056_OFFLINE_DEMO_RECEIPT_V1",
  generatedAtUtc:new Date().toISOString(),
  scope:"AGENT_SYNTHETIC_DECISION_PLUS_SEPARATE_VISA_104_MOCK_EXECUTION_REHEARSAL",
  linkage:"TWO_INDEPENDENT_OFFLINE_FIXTURES_NOT_A_SINGLE_VERIFIED_PROVIDER_CASE",
  agent:{scenario:agent.scenario,planner:agent.plannerLabel,modelPlanning:agent.modelPlanning,
    initialAction:agent.initial.action,finalAction:agent.final.action,
    replan:agent.replan.occurred,providerAction:agent.providerAction},
  historicalVisa:{status:history.cases[0]!.providerStatus,
    action:"HOLD_REQUEST_EVIDENCE",challengeSubmitted:false,
    providerCallCountDuringFt056:0,preflightAllowed:realCaseGate.allowed,
    blockers:realCaseGate.reasons},
  mock:{...demo, requestShape:demo.requestShape?{
    request_id:"REDACTED_MOCK_REQUEST_ID",
    challenge_method:demo.requestShape.challenge_method,
    reason:demo.requestShape.reason,
    supporting_documents:{documents:demo.requestShape.supporting_documents.documents.map(d=>({
      type:d.type,file_ids:d.file_ids.map(()=>"MOCK_FILE_ID_REDACTED"),description:d.description
    }))}
  }:null},
  realAirwallexCalls:0,realEvidenceUploads:0,realFinancialActions:0,
  sandboxMutationApprovalNotRequested:true,
  submissionReady:false,
};
const file=resolve(output,"FT056_OFFLINE_DEMO_RECEIPT.json");
await writeFile(file,JSON.stringify(receipt,null,2)+"\n",{flag:"wx"});
console.log(JSON.stringify({file,status:"PASS_OFFLINE_ONLY",
  mockChallenge:demo.readback,mockIssuer:demo.simulatedIssuerOutcome,
  mockPostCount:demo.simulatedPostCount,realAirwallexCalls:0,realVisaHold:realCaseGate.allowed===false}));
