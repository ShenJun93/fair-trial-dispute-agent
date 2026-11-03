import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { DisputeReviewStore } from "../spike/dispute-review-store.ts";

const dir=await mkdtemp(join(tmpdir(),"fair-trial-lifecycle-demo-"));
const path=join(dir,"review.sqlite"), now=Date.now(), session=randomBytes(32).toString("base64url");
let store=await DisputeReviewStore.open(path,undefined,now);
try {
  store.createSession(session,randomBytes(32).toString("base64url"),"OFFLINE_DEMO_OPERATOR",now);
  const approval=store.issueLifecycleChallengeApproval(session,now);
  const challenge=store.advanceOfflineLifecycle(session,"SUBMIT_CHALLENGE","demo-challenge-0001",now+1,String(approval.authorization));
  const rejection=store.advanceOfflineLifecycle(session,"SIMULATE_ISSUER_REJECTION","demo-rejection-0001",now+2);
  store.close();
  store=await DisputeReviewStore.open(path,undefined,now);
  const dashboard=store.dashboard();
  const caseRow=dashboard.cases.find((item)=>item.caseId==="kit04-credit-not-processed")!;
  console.log(JSON.stringify({label:"OFFLINE_FIXTURE; no Airwallex event observed; providerActionState=NOT_EXECUTED",approval:{approvalId:approval.approvalId,actor:"OFFLINE_DEMO_OPERATOR",revision:approval.revision,recommendedAction:approval.recommendedAction},challenge,rejection,persistedLifecycle:dashboard.lifecycleDemo,decision:(caseRow.recommendation as {action:string}).action,auditEvents:dashboard.history.filter((row)=>String(row.event).includes("LIFECYCLE")||String(row.event).includes("SIMULATED_ISSUER" )).map((row)=>row.event)},null,2));
} finally { store.close(); await rm(dir,{recursive:true,force:true}); }
