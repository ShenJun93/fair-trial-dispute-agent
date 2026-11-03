import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createScenarioEvidence, DEFAULT_DISPUTE_ECONOMICS, recommendDisputeAction, type DisputeSnapshot } from "./dispute-engine.ts";
import { createDecisionCertificate, verifyDecisionCertificate } from "./decision-certificate.ts";
import { DECISION_PROOF_CASE_ID } from "./dispute-workflow.ts";
import { createDisputeProviderAdapter } from "./dispute-provider.ts";
import { DisputeReviewStore, type ReviewChoice } from "./dispute-review-store.ts";
import { DEFAULT_LOCAL_MODEL_TIMEOUT_MS, LocalRuntimeProposalProvider, OfflineMockProposalProvider, type EvidenceProposalProvider, type EvidenceProposalMode } from "./evidence-proposals.ts";
import { createChallengeEvidencePacket, evaluateValueOfInformation, evaluateWhatIf, type WhatIfInput } from "./dispute-planning.ts";
import { runDisputeAgent, type AgentScenario } from "./dispute-agent.ts";
import { loadHistoricalProviderPortfolio } from "./historical-provider-portfolio.ts";
import { visa104FromHistoricalCase, evaluateVisa104OfflinePreflight } from "./visa104-safe-contract.ts";
import { judgeEvidenceBriefHtml } from "./judge-evidence-brief.ts";

const SESSION_COOKIE = "dispute_review_session";
const BODY_LIMIT = 8 * 1024;
const SESSION_TTL = 15 * 60_000;
const AUTH_TTL = 5 * 60_000;
const DASHBOARD_STYLES = ["./tokens.css", "./base.css", "./dispute-review.css", "./judge-evidence-brief.css"]
  .map((file) => readFileSync(new URL(file, import.meta.url), "utf8"))
  .join("\n");

function digest(value: string): Buffer { return createHash("sha256").update(value).digest(); }
function secureEqual(left: string, right: string): boolean {
  const a = digest(left); const b = digest(right);
  return timingSafeEqual(a, b);
}
function csrfForSession(sessionToken: string): string {
  return createHmac("sha256", sessionToken).update("fair-trial-dispute-review-csrf-v1").digest("base64url");
}
function cookie(req: IncomingMessage): string | undefined {
  const line = req.headers.cookie ?? "";
  const part = line.split(";").map((value) => value.trim()).find((value) => value.startsWith(`${SESSION_COOKIE}=`));
  return part?.slice(SESSION_COOKIE.length + 1);
}
function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers });
  res.end(JSON.stringify(body));
}
async function bodyJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json") throw new Error("INVALID_CONTENT_TYPE");
  if (Number(req.headers["content-length"] ?? 0) > BODY_LIMIT) throw new Error("BODY_TOO_LARGE");
  const chunks: Buffer[] = []; let length = 0;
  for await (const chunk of req) {
    length += chunk.length; if (length > BODY_LIMIT) throw new Error("BODY_TOO_LARGE");
    chunks.push(Buffer.from(chunk));
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_BODY");
  return value as Record<string, unknown>;
}

function dashboardHtml(bootstrapCsrf: string, nonce: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Kit 04 Dispute Review</title>
<style nonce="${nonce}">${DASHBOARD_STYLES}</style></head><body>
<div class="app-shell">
<header class="app-topbar"><div class="brand-lockup"><p class="brand-name">FAIR TRIAL <span>·</span> DISPUTE OPERATIONS</p><h1>Evidence first.<br>Decisions stay human.</h1><p class="topbar-note">Review the facts, understand the cost, record a local decision.</p></div><div class="topbar-context"><span class="workspace-label"><span class="live-dot"></span> Local review workspace</span><span id="mode" class="mode-chip">PROVIDER: MOCK</span><span id="modelMode" class="mode-chip">MODEL: OFFLINE_MOCK</span></div></header>
${judgeEvidenceBriefHtml()}
<nav id="judgeFlowNav" class="judge-flow-nav" hidden aria-label="Guided judge demo navigation">
 <span class="judge-flow-label">JUDGE DEMO · THREE STEPS</span>
 <a id="judgeInspectLink" href="#judgeEvidenceBrief" aria-current="step"><b>01</b><span><strong>Inspect</strong><small>Provider readback &amp; evidence gaps</small></span></a>
 <a id="judgeRunLink" href="#agentPanel"><b>02</b><span><strong>Run</strong><small>Bounded local policy workflow</small></span></a>
 <a id="judgeExplainLink" href="#agentSummary" aria-disabled="true"><b>03</b><span><strong>Explain</strong><small>Review the actual HOLD trace</small></span></a>
 <span class="judge-flow-boundary">HISTORICAL · MOCK WORKFLOW · NO PROVIDER ACTION</span>
</nav>
<p class="app-context"><span>WHAT THIS DEMO USES</span> One provider-backed Airwallex Sandbox RFI from saved historical receipts (NOT_REFRESHED), plus three synthetic fixtures. Recommendations use the deterministic policy. Optional model evidence analysis is local only; the model does not plan tools. Human review is local, and financial actions remain NOT_EXECUTED.</p>
<div class="warn safety-boundary"><span class="boundary-mark" aria-hidden="true">!</span><div><strong>No provider action is executed by this dashboard.</strong><span>Approving records a local review decision only. It does not accept a dispute, issue or verify a refund, challenge a case, or prove a provider outcome.</span></div><span class="boundary-state">PROVIDER ACTION · NOT EXECUTED</span></div>
<section id="agentPanel" class="panel agent-panel"><div class="panel-kicker"><span class="eyebrow">JUDGE WALKTHROUGH · 4 SCENARIOS</span><span class="time-chip">Typed tools · max 9 calls</span></div><h2>Follow evidence into a decision</h2><p class="panel-lede">The application runs a bounded deterministic rule planner and the existing financial policy. Pick an application path below. Model inference is optional, local and unavailable unless separately configured; the model does not plan tools or decide policy.</p><div class="agent-controls"><label>Choose a scenario<select id="agentScenario"><option value="provider-rfi">1 · Provider-backed Airwallex Sandbox RFI → HOLD</option><option value="synthetic-high-fraud">2 · Synthetic high-value fraud → acquire evidence, replan</option><option value="synthetic-low-value">3 · Synthetic low-value delivery → ACCEPT_RECOMMENDED</option><option value="synthetic-credit-not-processed">4 · Synthetic credit-not-processed → ESCALATE_FOR_REVIEW</option></select></label><button id="runAgent" disabled>Run bounded workflow</button></div><p class="agent-boundary">Provider-backed means saved receipts only (NOT_REFRESHED). The other three paths use synthetic fixtures. Sign in below to run one. A local review request is not a durable queue. Provider action: NOT_EXECUTED.</p><label class="agent-model-option"><input id="agentUseModel" type="checkbox" disabled> Use actual local model evidence analysis (synthetic high-value case only)</label><label class="agent-model-option"><input id="agentSyntheticConsent" type="checkbox" disabled> I confirm the model source is synthetic text with no personal or payment data</label><p id="agentModeNotice" class="agent-boundary">DETERMINISTIC_RULE_PLANNER · no model inference · local review request only · financial action NOT_EXECUTED</p><div id="agentSummary" tabindex="-1" role="status" aria-live="polite">The selector previews four paths. Sign in below, then run the selected application workflow.</div><details><summary>Structured execution trace</summary><pre id="agentTrace">No agent run yet.</pre></details></section>
<section id="providerPortfolio" class="panel provider-portfolio" aria-label="Historical provider cases"><div class="panel-kicker"><span class="eyebrow">AIRWALLEX SANDBOX · HISTORICAL READBACK</span><span class="time-chip">Owner-executed · NOT LIVE</span></div><h2>Two provider-verified case outcomes</h2><p class="panel-lede">Read-only receipts from separately owner-executed sandbox sessions. They are historical, not refreshed by this page, and are not the synthetic case decisions below. No agent has submitted a provider action.</p><div id="providerPortfolioList" class="provider-portfolio-grid" aria-live="polite">Sign in to inspect the sanitized readbacks.</div><div id="visa104Gate" class="visa104-gate" role="status" aria-live="polite">Visa 10.4 challenge remains blocked until verified evidence, fresh provider status and separate authorization.</div><p class="panel-footnote">The Visa HOLD is an offline policy recommendation, not an Airwallex status. Mastercard ACCEPTED is a provider readback, not a verified refund settlement or an agent action.</p></section>
<section id="login"><div class="access-copy"><span class="eyebrow">REVIEWER ACCESS</span><h2>Open the local workspace</h2><p>Enter the one-time access token from the server terminal.</p></div><label>Review access token <input id="token" type="password" autocomplete="current-password"></label><button id="loginButton">Authorize session</button></section>
<section id="controls" hidden><p>Authenticated local operator: <strong id="actor"></strong></p><label>Dispute fee (USD) <input id="fee" type="number" min="0" step="0.01"></label><button id="saveFee">Save fee</button><button id="refresh">Refresh</button></section>
<p id="status" role="status" aria-live="polite"></p>
<div class="workspace-grid overview-grid">
<section id="decisionProof" class="panel"><div class="panel-kicker"><span class="eyebrow">GUIDED WALKTHROUGH</span><span class="time-chip">90 sec</span></div><h2>See why the decision changes</h2><p class="panel-lede">Follow one synthetic case as conflicting evidence changes the snapshot and invalidates the earlier approval.</p><p class="warn"><strong>OFFLINE DEMO · SYNTHETIC CASE</strong><span>No provider read or mutation. No recovery result is promised.</span></p><p>Case <code>kit04-decision-proof</code> · USD 120 dispute · USD 25 example fee. Probabilities and costs are scenario assumptions, not forecasts. Delivery evidence is missing.</p><ol class="proof-steps"><li>Review evidence and the current recommendation.</li><li>Add a scoped contradiction; the policy must stop.</li><li>Correct the local fixture; the old approval becomes stale.</li><li>Verify the certificate, then confirm tampering is rejected.</li></ol><div class="button-row"><button id="proofReset">Reset walkthrough</button><button id="proofConflict">Inject scoped contradiction</button><button id="proofResolve">Apply local correction</button><button id="proofCertificate">Verify decision certificate</button><button id="proofTamper" disabled>Test tampered copy</button></div><p id="proofState" role="status" aria-live="polite"></p><pre id="proofCertificateView"></pre><p class="panel-footnote">The digest checks internal consistency only. It does not prove source authenticity, factual truth or provider execution.</p></section>
<section id="economicsPanel" class="panel"><div class="panel-kicker"><span class="eyebrow">DECISION CONTEXT</span><span class="time-chip">Example inputs</span></div><h2>Cost changes with the case stage</h2><p class="panel-lede">Same synthetic USD 120 fraud case. Example recovery rates and added costs are not calibrated forecasts.</p><ul id="stageSensitivity"></ul>
<div class="what-if"><span class="eyebrow">WHAT-IF · NO CASE CHANGE</span><p>Change bounded synthetic assumptions. The deterministic policy recalculates a preview only; it does not save, approve or submit anything.</p><div class="what-if-grid"><label>Stage<select id="whatIfStage"><option value="RFI">RFI</option><option value="CHARGEBACK">Chargeback</option></select></label><label>Dispute fee (USD)<input id="whatIfFee" type="number" min="0" max="250" step="0.01" value="25"></label><label>Added defense cost (USD)<input id="whatIfCost" type="number" min="0" max="500" step="0.01" value="0"></label><label>Illustrative recovery assumption (%)<input id="whatIfRate" type="number" min="0" max="100" step="1" value="80"></label><label>Deadline scenario<select id="whatIfDeadline"><option value="SAFE">More than 15 minutes</option><option value="CLOSE">Within 15 minutes</option><option value="PASSED">Elapsed</option><option value="UNKNOWN">Unknown</option></select></label><label>Evidence state<select id="whatIfEvidence"><option value="TWO_VERIFIED">Two verified signals</option><option value="ONE_VERIFIED">One verified signal</option><option value="UNVERIFIED">Unverified signals</option><option value="CONTRADICTORY">Contradictory signals</option></select></label></div><button id="runWhatIf" class="button-secondary">Recalculate preview</button><div id="whatIfResult" role="status" aria-live="polite" class="what-if-result">Preview uses the policy engine and current clock. No workflow state changes.</div>
<div class="what-if-voi"><span class="eyebrow">VALUE OF INFORMATION · CONDITIONAL SCENARIOS</span><p>Compare the current policy result with a hypothetical second independent verified signal. Set collection effort explicitly. No outcome probabilities are assumed; this cannot change the case.</p><div class="what-if-grid"><label>Evidence collection cost (USD)<input id="voiCost" type="number" min="0" max="500" step="0.01" value="5"></label><label>Collection time (minutes)<input id="voiCollectionTime" type="number" min="0" max="10080" step="1" value="30"></label><label>Time remaining (minutes)<input id="voiAvailableTime" type="number" min="0" max="10080" step="1" value="240"></label></div><button id="runVoi" class="button-secondary">Compare evidence scenarios</button><div id="voiResult" role="status" aria-live="polite" class="what-if-result">A positive result means conditional upside warrants human review of evidence availability, not automatic investigation.</div></div></div></section>
</div>
<div id="case-workspace"><div class="section-heading"><div><span class="eyebrow">LOCAL CASE REVIEW</span><h2>Cases and recommendations</h2></div><p>Evidence → policy → human review</p></div><p class="warn queue-boundary"><strong>OFFLINE FIXTURES</strong><span>These cases are synthetic. Provider action is <b>NOT EXECUTED</b>.</span></p><section id="proposalPanel"><div><span class="eyebrow">EVIDENCE WORKBENCH</span><h2>Investigate a source</h2></div><p id="proposalModeNotice"><strong>OFFLINE_MOCK mode by default.</strong> Local model mode is opt-in. Model output is untrusted until source-grounded and attested.</p></section><main id="cases"></main></div>
<div class="workspace-grid supporting-grid"><section id="lifecyclePanel" class="panel"><h2>Offline lifecycle demonstration</h2><p class="warn">OFFLINE_FIXTURE. No Airwallex event was observed, no provider request was sent, and no action was executed. Provider action: NOT_EXECUTED.</p><ol id="lifecycle"></ol><div class="button-row"><button id="lifeApprove">Authorize simulated challenge</button><button id="lifeSubmit">Simulate local challenge submission</button><button id="lifeReject">Simulate issuer rejection</button></div></section><section id="historyPanel" class="panel"><h2>Persistent audit history</h2><ol id="history"></ol></section></div>
</div><script nonce="${nonce}">
const bootstrap=${JSON.stringify(bootstrapCsrf)};let csrf=bootstrap,authz=null;const statusNode=document.getElementById('status');
function say(s){statusNode.textContent=String(s).replaceAll(' · ', ', ')}async function api(path,method='GET',data){const headers={};if(method!=='GET'){headers['Content-Type']='application/json';headers['Origin']=location.origin;headers['X-CSRF-Token']=csrf}const r=await fetch(path,{method,headers,body:data===undefined?undefined:JSON.stringify(data),credentials:'same-origin',cache:'no-store'});const d=await r.json();if(!r.ok)throw new Error(d.error||'request_failed');return d}
function node(tag,text,cls){const n=document.createElement(tag);if(text!==undefined)n.textContent=String(text).replaceAll(' · ', ', ');if(cls)n.className=cls;return n}
function displayCaseTitle(caseId){return ({'kit04-high-value-fraud':'High-value fraud','kit04-low-value-delivery':'Low-value delivery','kit04-credit-not-processed':'Credit not processed','kit04-evidence-lab':'Evidence investigation','kit04-decision-proof':'Decision proof walkthrough'})[caseId]||caseId}
function renderHistoricalPortfolio(portfolio,visa104Preflight){
 const list=document.getElementById('providerPortfolioList');
 list.replaceChildren();
 const gate=document.getElementById('visa104Gate');
 gate.replaceChildren();
 const failures=visa104Preflight&&visa104Preflight.schema==='FT055_VISA_104_OFFLINE_PREFLIGHT_V1'&&visa104Preflight.allowed===false?visa104Preflight.reasons:null;
 if(failures){
  gate.append(node('strong','Visa 10.4 · challenge is BLOCKED'));
  const labels={
   'FRESH_MATCHED_PROVIDER_READ_REQUIRED':'Fresh, identity-matched Airwallex dispute GET required',
   'VERIFIED_AUTHORIZATION_EVIDENCE_MISSING':'Verified cardholder authorization evidence missing',
   'VERIFIED_TRANSACTION_EVIDENCE_MISSING':'Verified transaction details missing',
   'INDEPENDENT_FULFILLMENT_OR_CUSTOMER_SIGNAL_MISSING':'Independent fulfillment / device / customer signal missing',
   'FILE_SERVICE_UPLOAD_AND_READBACK_EVIDENCE_MISSING':'Airwallex File Service evidence upload/readback missing',
   'ACTION_SPECIFIC_OWNER_APPROVAL_REQUIRED':'New owner approval for this exact evidence snapshot required',
   'PROVIDER_EXECUTION_NOT_IMPLEMENTED':'Provider challenge execution is intentionally not implemented'
  };
  const ul=node('ul');
  for(const code of failures){ul.append(node('li',labels[code]||code.replaceAll('_',' ').toLowerCase()))}
  gate.append(ul,node('p','Read-only decision gate · No evidence uploaded · No challenge or refund submitted.','visa104-boundary'))
 }else gate.append(node('p','Visa 10.4 preflight unavailable; provider action disabled.'));

 if(!portfolio||portfolio.schema!=='fair-trial-historical-provider-portfolio/v1'||portfolio.freshProviderRead!==false||portfolio.providerNetworkCalls!==0||portfolio.providerMutations!==0){list.append(node('p','Historical evidence unavailable; no provider status inferred.'));return}
 for(const item of portfolio.cases){
  const card=node('article',undefined,'portfolio-case');
  const head=node('div',undefined,'portfolio-case-head');
  head.append(node('strong',item.brand+' · USD '+(item.amountMinor/100).toFixed(2)),node('span',item.providerStatus,'portfolio-case-state'));
  card.append(head);
  const info=node('dl',undefined,'portfolio-case-facts');
  const utc=value=>value?new Date(value).toLocaleString('en-GB',{timeZone:'UTC',day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'})+' UTC':'Not in saved receipt';
  for(const [key,val] of [['Provider status',item.providerStatus+' ('+item.stage+')'],['Reason code',item.reasonCode+' · '+item.reasonType],['Observed',utc(item.providerStatusObservedAt)],['Response deadline',utc(item.responseDeadline)],['Local recommendation',item.localRecommendation==='HOLD_REQUEST_EVIDENCE'?'HOLD · request evidence (offline)':'No local recommendation for owner action'],['Action origin',item.actionOrigin==='NONE'?'No action submitted':'Separately owner-executed'],['Agent action','NOT_EXECUTED'],['Evidence uploads',String(item.evidenceUploads)],['Challenge submitted',item.challengeSubmitted?'Yes':'No'],['Refund settled',item.refundSettlementVerified?'Verified':'Not verified']]){
   info.append(node('dt',key),node('dd',val))
  }
  card.append(info);
  if(item.evidenceGaps&&item.evidenceGaps.length)card.append(node('p','Evidence gaps: '+item.evidenceGaps.join(' · '),'portfolio-gaps'));
  card.append(node('p','Sanitized receipt: '+item.receiptFile+' · SHA256 '+item.receiptSha256.slice(0,14)+'…','portfolio-proof'));
  list.append(card)
 }
}
function render(data){
  renderHistoricalPortfolio(data.providerPortfolio,data.visa104Preflight);
  document.getElementById("judgeEvidenceBrief").hidden=!(data.providerPortfolio&&data.providerPortfolio.schema==="fair-trial-historical-provider-portfolio/v1"&&data.providerPortfolio.freshProviderRead===false&&data.providerPortfolio.providerNetworkCalls===0&&data.providerPortfolio.providerMutations===0);
  document.getElementById('judgeFlowNav').hidden=document.getElementById('judgeEvidenceBrief').hidden;
  document.getElementById('agentPanel').hidden=false;
  const agentScenario=document.getElementById('agentScenario'),useAgentModel=document.getElementById('agentUseModel'),agentConsent=document.getElementById('agentSyntheticConsent');
  const agentModelAvailable=data.modelMode==='LOCAL_LLM'&&data.modelConfigured;
  useAgentModel.disabled=!agentModelAvailable;agentConsent.disabled=!agentModelAvailable;
  document.getElementById('agentModeNotice').textContent=agentModelAvailable?'LOCAL_LLM available · actual inference runs only after selecting the synthetic high-value path and confirming synthetic input. The planner and deterministic policy remain application-controlled.':'DETERMINISTIC_RULE_PLANNER · no model inference configured · local review request only; no durable task is queued.';
  agentScenario.onchange=()=>{const eligible=agentScenario.value==='synthetic-high-fraud'&&agentModelAvailable;useAgentModel.disabled=!eligible;agentConsent.disabled=!eligible;if(!eligible){useAgentModel.checked=false;agentConsent.checked=false}};
  useAgentModel.onchange=()=>{agentConsent.disabled=!agentModelAvailable||!useAgentModel.checked;if(!useAgentModel.checked)agentConsent.checked=false};
  document.getElementById('actor').textContent=data.actor;
  document.getElementById('mode').textContent='PROVIDER: '+data.providerMode+(data.providerMode==='LIVE'?' (DISABLED)':'');
  document.getElementById('modelMode').textContent='MODEL: '+data.modelMode+(data.modelName?' · '+data.modelName:'');
  const modeNotice=document.getElementById('proposalModeNotice');
  modeNotice.textContent=data.modelMode==='LOCAL_LLM'?(data.modelConfigured?'REAL LOCAL MODEL · Loopback only. Runtime availability and returned model identity are checked for each run. Use synthetic text only; provider actions remain disabled.':'LOCAL_LLM selected, but no model is configured. There is no silent OFFLINE_MOCK fallback.'):'OFFLINE_MOCK · Deterministic rule mode. No model inference or external request occurs. Proposals remain untrusted until source-grounded and attested.';
  document.getElementById('fee').value=(data.dashboard.feeMinor/100).toFixed(2);
  const sensitivity=document.getElementById('stageSensitivity');sensitivity.replaceChildren();
  for(const row of data.stageSensitivity){const item=node('li',undefined,'sensitivity-row');const top=node('div',undefined,'sensitivity-top');top.append(node('span',row.stage,'sensitivity-stage'),node('strong',row.action.replaceAll('_',' '),'sensitivity-action'));const net=row.expectedNetValueMinor===null?'Not estimated':(row.expectedNetValueMinor/100).toFixed(2)+' USD expected net';item.append(top,node('strong',net,'sensitivity-net'),node('p',row.reasonCodes.join(' · '),'sensitivity-reason'));sensitivity.append(item)}
  const root=document.getElementById('cases');root.replaceChildren();
  for(const c of data.dashboard.cases){
    const a=node('article');a.className='case-record';a.dataset.caseId=c.caseId;
    const s=c.snapshot,r=c.recommendation,d=c.decision;a.dataset.action=r.action;a.dataset.stage=s.stage;a.dataset.reviewState=d?'RECORDED':'PENDING';
    const heading=node('div',undefined,'case-heading');const identity=node('div',undefined,'case-identity');identity.append(node('h2',displayCaseTitle(c.caseId)),node('code',c.caseId,'case-id'));heading.append(identity,node('span',r.action.replaceAll('_',' '),'decision-badge'));a.append(heading);
    if(c.caseId==='kit04-evidence-lab'||c.caseId==='kit04-decision-proof')a.append(node('p','Revision '+c.revision+(d?' · Local review recorded':' · Awaiting local review'),'case-revision'));
    a.append(node('p',s.reason+' ('+s.reasonCode+') · '+s.stage+' / '+s.status,'case-stage'));
    a.append(node('p',(s.amountMinor/100).toFixed(2)+' '+s.currency+' dispute amount · Fee '+(r.disputeFeeMinor/100).toFixed(2)+' USD · Estimated recovery '+(r.expectedRecoveryMinor===null?'requires review':(r.expectedRecoveryMinor/100).toFixed(2)+' USD'),'case-financials'));
    const recommendation=node('div',undefined,'recommendation-card');recommendation.append(node('span','DETERMINISTIC POLICY','eyebrow'),node('p','Recommendation: '+r.action.replaceAll('_',' ')+' · Expected net value '+(r.expectedNetValueMinor===null?'not estimated':(r.expectedNetValueMinor/100).toFixed(2)+' USD'),'recommendation-value'),node('p',r.explanation,'recommendation-explanation'));a.append(recommendation);
    a.append(node('p','Reason codes: '+r.reasonCodes.join(', '),'reason-codes'));
    const ev=node('div',undefined,'evidence-list');ev.append(node('h3','Evidence and provenance','case-subheading'));
    for(const e of c.evidence){const item=node('div',e.kind+' · '+e.strength+' · '+e.summary+' Source: '+e.provenance.source+' / '+e.provenance.reference+' · observed '+e.provenance.observedAt+' · verified '+e.provenance.verified+(e.provenance.subject?' · subject '+e.provenance.subject+' · context '+e.provenance.context:' · scope unavailable'),'evidence');ev.append(item)}a.append(ev);
    if(s.stage==='RFI'&&r.action==='ACCEPT')a.append(node('p','RFI acceptance and refund completion are separate provider states. This local review cannot confirm either.','warn'));
if(c.caseId==='kit04-evidence-lab'){
  const panel=node('section',undefined,'evidence-investigation');panel.append(node('h2','Evidence investigation — synthetic only, not Airwallex'));
  panel.append(node('p',data.modelMode==='LOCAL_LLM'?'LOCAL_LLM mode sends this synthetic text only to the configured loopback inference endpoint. The model is not trusted to decide or execute financial actions.':'OFFLINE_MOCK mode uses a deterministic phrase matcher; no model inference or external request occurs. Local attestation does not prove provider authenticity.','warn'));
  for(const doc of c.documents||[]){
    const details=node('details'),summary=node('summary','Source '+doc.documentId+' ? SHA-256 '+doc.sha256+' ? '+doc.source);details.append(summary);
    details.append(node('pre',doc.text));
    const consentWrap=document.createElement('label'),consent=document.createElement('input');consent.type='checkbox';consent.setAttribute('aria-label','Confirm source is synthetic and has no personal or payment data');consentWrap.append(consent,document.createTextNode(' I confirm this source is synthetic and contains no personal or payment data.'));if(data.modelMode==='LOCAL_LLM')details.append(consentWrap);
    const propose=node('button',data.modelMode==='LOCAL_LLM'?'Run local model investigation':'Request offline mock proposal');propose.disabled=data.modelMode==='LOCAL_LLM'&&(!consent.checked||!data.modelConfigured);consent.onchange=()=>{propose.disabled=!data.modelConfigured||!consent.checked};propose.onclick=async()=>{propose.disabled=true;say(data.modelMode==='LOCAL_LLM'?'Local inference running; bounded by LOCAL_MODEL_TIMEOUT_MS. No MOCK fallback.':'Requesting explicitly labelled OFFLINE_MOCK output.');try{const result=await api('/api/evidence/propose','POST',{caseId:c.caseId,documentId:doc.documentId,confirmSynthetic:consent.checked});const reasons=[...new Set(result.proposals.filter(p=>p.groundingStatus==='REJECTED').map(p=>p.groundingReasonCode))];say(result.modelMode+' / '+result.model+': '+result.rawModelProposalCount+' compact claim(s), '+result.locallyEnrichedProposalCount+' locally enriched, '+result.groundingFailures+' rejected'+(reasons.length?' ('+reasons.join(', ')+')':'')+'. Provider action: NOT_EXECUTED.');await load()}catch(error){say('Model run failed safely: '+(error.message||'request rejected'));propose.disabled=data.modelMode==='LOCAL_LLM'&&(!consent.checked||!data.modelConfigured)}};details.append(propose);
    for(const p of (c.proposals||[]).filter(x=>x.documentId===doc.documentId)){
      details.append(node('p',(p.rejected?'OPERATOR REJECTED':p.attested?'OPERATOR ATTESTED':p.groundingStatus==='REJECTED'?'REJECTED BY GROUNDING':'GROUNDED · UNVERIFIED')+' · '+p.factType+' · '+p.model+' · quote: “'+p.exactQuote+'” · '+(p.startOffset<0?'no unique source offset':'UTF-16 chars '+p.startOffset+'-'+p.endOffset)+' · '+(p.confidence===null?'no model confidence supplied':'confidence '+p.confidence+' (not calibrated)')+' · '+p.groundingReasonCode));
      if(p.groundingStatus!=='REJECTED'&&!p.rejected&&!p.attested&&!d){const reject=node('button','Reject proposal');reject.onclick=async()=>{reject.disabled=true;try{await api('/api/evidence/proposal-reject','POST',{caseId:c.caseId,proposalId:p.proposalId});say('Proposal rejected and audited; no decision effect.');await load()}catch{say('Proposal rejection failed.');reject.disabled=false}};details.append(reject)}
      if(p.groundingStatus!=='REJECTED'&&!p.attested&&!p.rejected&&!d){const att=node('button','Attest grounded proposal (operator review)');att.onclick=async()=>{att.disabled=true;try{const delta=await api('/api/evidence/proposal-attest','POST',{caseId:c.caseId,documentId:doc.documentId,proposalId:p.proposalId});say('Operator-attested at persisted revision '+delta.revision+'. Previous approvals are stale. Deterministic policy: '+delta.before+' → '+delta.after+'. Provider action: NOT_EXECUTED. Citation: '+delta.citations.join('; '));await load()}catch(error){say('Proposal attestation rejected: '+(error.message||'grounding check failed'));att.disabled=false}};details.append(att)}
    }
    for(const fact of doc.facts){
      details.append(node('p','Quote: '+fact.quote+' ? offsets '+fact.startOffset+'-'+fact.endOffset+' ? '+(fact.attested?'OPERATOR_ATTESTED':'UNVERIFIED')));
      if(!fact.attested&&!d){
        const confirm=node('button','Attest quoted fact (local only)');
        confirm.onclick=async()=>{confirm.disabled=true;try{
          await api('/api/evidence/attest','POST',{caseId:c.caseId,documentId:doc.documentId,factId:fact.factId,sha256:doc.sha256});
          say('Local attestation and replan saved. Prior approvals invalidated. No provider action.');await load();
        }catch{say('Attestation rejected; refresh or check source hash.');confirm.disabled=false}};
        details.append(confirm);
      }
    }
    panel.append(details);
  }
  if(!d&&(c.documents||[]).length<3){
    const input=node('textarea');input.placeholder='Paste synthetic source text only; no personal or payment data.';
    input.setAttribute('aria-label','Offline synthetic text evidence');
    const add=node('button','Ingest synthetic evidence (unverified)');
    add.onclick=async()=>{add.disabled=true;try{
      const documentId='lab-'+crypto.randomUUID();
      await api('/api/evidence/ingest','POST',{caseId:c.caseId,documentId,text:input.value});
      say('Offline text stored as UNVERIFIED. Review its exact citation before attesting.');await load();
    }catch{say('Evidence rejected. Only local synthetic text up to 4096 bytes is accepted.');add.disabled=false}};
    panel.append(input,add);
  }
  const certificateButton=node('button','Generate and verify current decision certificate');
  certificateButton.onclick=async()=>{certificateButton.disabled=true;try{
    const result=await api('/api/evidence/certificate','POST',{caseId:c.caseId});
    if(!result.verification.ok)throw new Error('CERTIFICATE_VERIFICATION_FAILED');
    const certificate=result.certificate;
    const link=document.createElement('a');link.href=URL.createObjectURL(new Blob([JSON.stringify(certificate,null,2)],{type:'application/json'}));
    link.download='fair-trial-investigation-certificate.json';link.click();setTimeout(()=>URL.revokeObjectURL(link.href),1000);
    say('Current revision '+certificate.revision+' certificate verified; digest '+certificate.digest+'. Provider action: NOT_EXECUTED. Digest is integrity-only, not an external signature.');
  }catch(error){say('Certificate generation failed: '+(error.message||'verification rejected'));certificateButton.disabled=false}};
  panel.append(certificateButton);
  a.append(panel);
}
    if(c.caseId==='kit04-high-value-fraud'&&r.action==='CHALLENGE'){
      const packetButton=node('button','Prepare approved challenge packet (local preview)','button-secondary');
      packetButton.disabled=!(d&&d.choice==='APPROVE'&&d.recommendedAction==='CHALLENGE'&&d.revision===c.revision);
      packetButton.title=packetButton.disabled?'Approve the current case revision locally first.':'Creates a snapshot-bound local packet marked NOT_SUBMITTED.';
      packetButton.onclick=async()=>{packetButton.disabled=true;try{const result=await api('/api/challenge-packet','POST',{caseId:c.caseId});const blob=new Blob([JSON.stringify(result.packet,null,2)+'\\n'],{type:'application/json'});const link=document.createElement('a');link.href=URL.createObjectURL(blob);link.download='fair-trial-challenge-packet-not-submitted.json';link.click();setTimeout(()=>URL.revokeObjectURL(link.href),1000);say('Local challenge packet prepared at revision '+result.packet.revision+'. Snapshot-bound approval verified. State: NOT_SUBMITTED; provider action: NOT_EXECUTED.');}catch(error){say('Challenge packet blocked: '+(error.message||'current approval required'));packetButton.disabled=false}};
      const packetState=node('p','Packet preview available only after a current-revision local approval. It remains NOT_SUBMITTED.','packet-state');a.append(packetButton,packetState);
    }
    if(d){a.append(node('p',(d.recommendedAction==='ESCALATE_FOR_REVIEW'?'Local human escalation recorded by ':'Local review '+d.choice+' by ')+d.actor+' at '+new Date(d.createdAt).toISOString()+'. Provider action: '+d.providerActionState+'. Refund: '+d.refundState+'.','pill'))}else if(c.caseId==='kit04-decision-proof'){a.append(node('p','Walkthrough case is read-only in the review controls. No approval can execute a provider action.','warn'))}else{const approveLabel=r.action==='ESCALATE_FOR_REVIEW'?'Record local human escalation':'Approve recommendation';for(const [choice,label] of [['APPROVE',approveLabel],['REJECT','Reject recommendation']]){const b=node('button',label,choice==='APPROVE'?'button-primary':'button-secondary');b.onclick=async()=>{b.disabled=true;try{const token=authz.cases[c.caseId][choice==='APPROVE'?'approve':'reject'];await api('/api/review','POST',{caseId:c.caseId,choice,authorization:token});say(r.action==='ESCALATE_FOR_REVIEW'?'Local human escalation recorded. No provider request was sent.':'Local review decision recorded. No provider action was executed.');await load()}catch{say('Review action failed or its authorization expired. Refresh to obtain a new one-time authorization.');b.disabled=false}};a.append(b)}}root.append(a)}
const life=document.getElementById('lifecycle');life.replaceChildren();for(const e of data.dashboard.lifecycleDemo){const item=node('li');const stageLabel=e.event==='SIMULATED_ISSUER_REJECTION'?' '+e.stage+' (SYNTHETIC SANDBOX SCENARIO)':e.stage;item.append(node('strong',e.event+' → '+stageLabel+' / '+e.status+' [OFFLINE_FIXTURE; provider action: NOT_EXECUTED]'));if(e.rejection_reason)item.append(node('p','Persisted simulator rejection reason: '+e.rejection_reason));if(e.response_deadline)item.append(node('p','Response deadline (fixture): '+e.response_deadline));if(e.recommendation)item.append(node('p','Recommendation: '+e.recommendation));life.append(item)}document.getElementById('lifeApprove').onclick=async()=>{try{const result=await api('/api/lifecycle/authorization','POST',{});authz.lifecycle=result.authorization;say('Fresh lifecycle approval issued for revision '+result.revision)}catch{say('Lifecycle approval unavailable for this state.')}};document.getElementById('lifeSubmit').onclick=()=>advanceLife('SUBMIT_CHALLENGE');document.getElementById('lifeReject').onclick=()=>advanceLife('SIMULATE_ISSUER_REJECTION');const hist=document.getElementById('history');hist.replaceChildren();if(data.dashboard.history.length===0)hist.append(node('li','No local review decisions yet. Record a review choice to add one here.','empty-state'));for(const e of data.dashboard.history){hist.append(node('li',new Date(e.created_at).toISOString()+' · '+e.actor+' · '+e.event+' · '+e.note))}}
async function advanceLife(event){try{const eventId='fixture-'+crypto.randomUUID();const result=await api('/api/lifecycle/advance','POST',{event,eventId,authorization:event==='SUBMIT_CHALLENGE'?authz.lifecycle:undefined});authz.lifecycle=null;say(result.event+' recorded as OFFLINE_FIXTURE; revision '+result.previousRevision+' → '+result.newRevision+'. Provider action: NOT_EXECUTED.');await load()}catch{say('Lifecycle transition rejected; refresh and check the current stage.')}}
async function load(){const data=await api('/api/dashboard');authz=await api('/api/authorizations','POST',{});render(data)}
document.getElementById('loginButton').onclick=async()=>{const b=document.getElementById('loginButton');b.disabled=true;try{const result=await api('/api/session','POST',{operatorToken:document.getElementById('token').value});csrf=result.csrfToken;document.getElementById('token').value='';document.getElementById('login').hidden=true;document.getElementById('controls').hidden=false;await load();document.getElementById('runAgent').disabled=false;say('Authorized for local review. Provider mode: '+result.providerMode+'.')}catch{say('Authorization failed.');b.disabled=false}};
document.getElementById('saveFee').onclick=async()=>{try{const feeMinor=Math.round(Number(document.getElementById('fee').value)*100);await api('/api/fee','POST',{feeMinor,authorization:authz.fee});say('Fee saved. Pending recommendations were recalculated.');await load()}catch{say('Fee update rejected. Check the value and refresh to renew authorization.')}};
document.getElementById('runWhatIf').onclick=async()=>{const b=document.getElementById('runWhatIf'),result=document.getElementById('whatIfResult');b.disabled=true;result.textContent='Recalculating deterministic synthetic preview…';try{const preview=await api('/api/what-if','POST',{stage:document.getElementById('whatIfStage').value,feeMinor:Math.round(Number(document.getElementById('whatIfFee').value)*100),addedDefenseCostMinor:Math.round(Number(document.getElementById('whatIfCost').value)*100),recoveryRateBps:Math.round(Number(document.getElementById('whatIfRate').value)*100),deadline:document.getElementById('whatIfDeadline').value,evidence:document.getElementById('whatIfEvidence').value});const r=preview.recommendation;result.textContent=preview.label+' · '+r.action.replaceAll('_',' ')+' · '+(r.expectedNetValueMinor===null?'net value not estimated':(r.expectedNetValueMinor/100).toFixed(2)+' USD expected net')+' · '+r.reasonCodes.join(', ')+' · inputs evaluated '+preview.evaluatedAtUtc+' · '+preview.providerAction; }catch(error){result.textContent='Preview rejected safely: '+(error.message||'invalid scenario');}finally{b.disabled=false}};
function renderVoiReport(report){const p=report.positiveFinding,a=report.assumptions,money=n=>n===null?'Not estimated':(n/100).toFixed(2)+' USD',margin=a.availableTimeMinutes-a.collectionTimeMinutes;const rows=[['Current recommendation',report.baselineAction.replaceAll('_',' ')],['If a second independent signal is verified',p.action.replaceAll('_',' ')+' ('+(p.changesAction?'policy changes':'no policy change')+')'],['Missing decision-relevant evidence',report.baselineAction==='ESCALATE_FOR_REVIEW'?'A second independent verified supporting signal':'No additional signal is needed to preserve the current recommendation'],['Evidence collection cost',money(a.collectionCostMinor)],['Time required / available',a.collectionTimeMinutes+' / '+a.availableTimeMinutes+' minutes'],['Deadline margin after collection',Math.max(0,margin)+' minutes; policy requires more than 15 minutes'],['Conditional net after collection cost',money(p.conditionalNetAfterCollectionCostMinor)],['Why investigation may not help',report.conclusion.replaceAll('_',' ').toLowerCase()+'. If no supported finding is obtained, the recommendation stays '+report.noFinding.action.replaceAll('_',' ')+'.'],['Evidence likelihood','Not estimated; no probabilities are used'],['Execution state','Provider action '+report.providerAction]];const list=document.createElement('dl');list.className='voi-result-grid';for(const [term,value] of rows){list.append(node('dt',term),node('dd',value))}const result=document.getElementById('voiResult');result.replaceChildren(node('p','OFFLINE SYNTHETIC CONDITIONAL SCENARIO · not expected VOI, realized ROI or a case change.','voi-result-label'),list)}
document.getElementById('runVoi').onclick=async()=>{const b=document.getElementById('runVoi'),result=document.getElementById('voiResult');b.disabled=true;result.textContent='Comparing bounded evidence outcomes…';try{const report=await api('/api/value-of-information','POST',{whatIf:{stage:document.getElementById('whatIfStage').value,feeMinor:Math.round(Number(document.getElementById('whatIfFee').value)*100),addedDefenseCostMinor:Math.round(Number(document.getElementById('whatIfCost').value)*100),recoveryRateBps:Math.round(Number(document.getElementById('whatIfRate').value)*100),deadline:document.getElementById('whatIfDeadline').value,evidence:document.getElementById('whatIfEvidence').value},collectionCostMinor:Math.round(Number(document.getElementById('voiCost').value)*100),collectionTimeMinutes:Number(document.getElementById('voiCollectionTime').value),availableTimeMinutes:Number(document.getElementById('voiAvailableTime').value)});renderVoiReport(report);}catch(error){result.textContent='Scenario rejected safely: '+(error.message||'invalid assumptions');}finally{b.disabled=false}};
function renderAgentRun(result){
 document.getElementById('judgeExplainLink').removeAttribute('aria-disabled');
 document.getElementById('judgeExplainLink').setAttribute('aria-current','step');
 document.getElementById('judgeInspectLink').removeAttribute('aria-current');
 document.getElementById('judgeRunLink').removeAttribute('aria-current');
const summary=document.getElementById('agentSummary'),money=n=>n===null?'Not estimated':(n/100).toFixed(2)+' USD',finding=result.modelInvestigation,tools=[...new Set(result.trace.flatMap(item=>item.tool?[item.tool]:[]))];const status=finding.status+' · '+(finding.modelIdentity||'identity unavailable')+' · '+(finding.calls||0)+' call(s) · '+(finding.latencyMs===null?'latency not measured':finding.latencyMs+' ms')+' · '+finding.acceptedFindings+' accepted / '+finding.rejectedFindings.length+' rejected';const grounded=(finding.groundedEvidence||[]).map(item=>item.sha256+':'+item.startOffset+'-'+item.endOffset+' “'+item.quote+'”').join(' · ')||'No model-derived evidence accepted';const rows=[['Data source',result.dataLabel.replaceAll('_',' ')],['Decision path',result.plannerLabel.replaceAll('_',' ')+' → deterministic policy'],['Recommendation',result.initial.action.replaceAll('_',' ')+' → '+result.final.action.replaceAll('_',' ')+' · revision '+result.initial.revision+' → '+result.final.revision],['Tools actually run',tools.join(' → ')||'No tools reported'],['Evidence replan',result.replan.occurred?'Yes · earlier certificate invalidated at the new revision':'No · policy kept the current evidence decision'],['Model status',status],['Grounded model evidence',grounded],['Financial assumption',money(result.final.expectedRecoveryMinor)+' recovery less '+money(result.final.disputeFeeMinor)+' fee = '+money(result.final.expectedNetValueMinor)+' net'],['Policy reason codes',result.final.reasonCodes.join(', ')||'No blockers reported'],['Review / execution','Human review required; local request only, no durable queue. Provider action '+result.providerAction]];const list=document.createElement('dl');list.className='voi-result-grid';for(const [term,value] of rows){list.append(node('dt',term),node('dd',value))}summary.replaceChildren(list);document.getElementById('agentTrace').textContent=JSON.stringify(result,null,2)}
for(const [id,focusId] of [['judgeInspectLink','judgeEvidenceBrief'],['judgeRunLink','agentPanel'],['judgeExplainLink','agentSummary']]){
 const link=document.getElementById(id);
 link.addEventListener('click',event=>{
  if(link.getAttribute('aria-disabled')==='true'){event.preventDefault();return}
  event.preventDefault();const target=document.getElementById(focusId);
  target.scrollIntoView({behavior:'auto',block:'start'});if(target.tabIndex<0)target.tabIndex=-1;target.focus({preventScroll:true});
  for(const current of document.querySelectorAll('#judgeFlowNav a'))current.removeAttribute('aria-current');
  link.setAttribute('aria-current','step');
 });
}
document.getElementById('runAgent').onclick=async()=>{const button=document.getElementById('runAgent'),summary=document.getElementById('agentSummary'),trace=document.getElementById('agentTrace'),model=document.getElementById('agentUseModel').checked,consent=document.getElementById('agentSyntheticConsent').checked;button.disabled=true;document.getElementById('judgeExplainLink').setAttribute('aria-disabled','true');summary.textContent='OBSERVE → PLAN → TOOL USE → VALIDATE…';trace.textContent='Running bounded application tools…';try{const result=await api('/api/agent/run','POST',{scenario:document.getElementById('agentScenario').value,modelInvestigation:model,confirmSynthetic:consent});renderAgentRun(result)}catch(error){summary.textContent='Agent run stopped safely: '+(error.message||'tool failure');trace.textContent=summary.textContent}finally{button.disabled=false}};
let proofCertificate=null,proofAnchor=null;
async function proofStep(step){const result=await api('/api/decision-proof/step','POST',{step});await load();return result}
document.getElementById('proofReset').onclick=async()=>{try{proofCertificate=null;document.getElementById('proofTamper').disabled=true;const r=await proofStep('RESET');say('OFFLINE_DEMO reset · revision '+r.previousRevision+' → '+r.revision+' · '+r.recommendation+' · provider action NOT_EXECUTED')}catch{say('Synthetic case reset failed.')}};
document.getElementById('proofConflict').onclick=async()=>{try{const old=authz.cases['kit04-decision-proof']?.approve;const r=await proofStep('INJECT_CONFLICT');const error=await api('/api/review','POST',{caseId:'kit04-decision-proof',choice:'APPROVE',authorization:old}).then(()=> 'UNEXPECTEDLY_ACCEPTED').catch(e=>e.message);say('Scoped opposing claim · '+r.recommendation+' / '+r.reasonCodes.join(', ')+' · old approval rejected: '+error+' · validation failure is distinct from financial economics.')}catch{say('Conflict step failed; reset the scenario and try again.')}};
document.getElementById('proofResolve').onclick=async()=>{try{proofCertificate=null;document.getElementById('proofTamper').disabled=true;const r=await proofStep('RESOLVE_CONFLICT');say('OFFLINE_DEMO fixture correction · revision '+r.previousRevision+' → '+r.revision+' · contradictory assertion remains in immutable audit evidence; removed from active snapshot · '+r.recommendation)}catch{say('No conflict to resolve; inject the scoped contradiction first.')}};
document.getElementById('proofCertificate').onclick=async()=>{try{const r=await api('/api/decision-proof/certificate','POST',{});proofCertificate=r.certificate;proofAnchor=r.certificate.digest;document.getElementById('proofCertificateView').textContent=JSON.stringify({schemaVersion:proofCertificate.schemaVersion,caseRef:proofCertificate.caseRef,revision:proofCertificate.revision,snapshotFingerprint:proofCertificate.snapshotFingerprint,recommendation:proofCertificate.recommendation,economics:proofCertificate.economics,verification:r.verification,digest:proofCertificate.digest},null,2);const link=document.createElement('a');link.href=URL.createObjectURL(new Blob([JSON.stringify(proofCertificate,null,2)],{type:'application/json'}));link.download='fair-trial-decision-proof.json';link.click();setTimeout(()=>URL.revokeObjectURL(link.href),1000);document.getElementById('proofTamper').disabled=false;say('Certificate '+(r.verification.ok?'PASS':'FAIL')+' · revision '+proofCertificate.revision+' · downloaded fair-trial-decision-proof.json · anchor is run-local, not externally trusted.')}catch{say('Certificate generation or verification failed.')}};
  document.getElementById('proofTamper').onclick=async()=>{if(!proofCertificate)return;const tampered=structuredClone(proofCertificate);tampered.snapshot.amountMinor++;try{const r=await api('/api/decision-proof/verify','POST',{certificate:tampered,expectedRevision:tampered.revision,pinnedDigest:proofAnchor});say('Tampered certificate rejected · '+r.verification.reasonCodes.join(', '))}catch(e){say('Tampered certificate rejected · '+e.message)}};
document.getElementById('refresh').onclick=async()=>{try{await load();say('Review data refreshed.')}catch{say('Refresh failed. Reauthorize if the session expired.')}};
api('/api/session').then(async s=>{csrf=s.csrfToken;document.getElementById('login').hidden=true;document.getElementById('controls').hidden=false;await load();say('Session restored for '+s.actor+'.')}).catch(()=>{});
</script></body></html>`;
}

export interface DisputeReviewHttpDeps {
  store: DisputeReviewStore;
  operatorToken: string;
  actor: string;
  origin: string;
  providerMode: string;
  proposalMode?: EvidenceProposalMode;
  proposalProvider?: EvidenceProposalProvider;
  agentModelProvider?: EvidenceProposalProvider;
  proposalModelName?: string;
  proposalConfigError?: string;
  now?: () => number;
  bootstrapCsrf?: string;
}

function stageSensitivityPreview(feeMinor: number, nowMs: number) {
  const base: DisputeSnapshot = {
    caseId: "synthetic-stage-sensitivity-example", amountMinor: 12_000, currency: "USD",
    reason: "FRAUDULENT", reasonCode: "10.4", stage: "RFI", status: "REQUIRES_RESPONSE",
    responseDeadline: new Date(nowMs + 72 * 60 * 60_000).toISOString(),
    evidence: createScenarioEvidence("fraud-high-value"),
  };
  const economics = {
    ...DEFAULT_DISPUTE_ECONOMICS,
    disputeFeeMinor: feeMinor,
    stageAdjustments: {
      RFI: { additionalDefenseCostMinor: 0, strongFraudWinProbabilityBps: 8_000 },
      CHARGEBACK: { additionalDefenseCostMinor: 3_000, strongFraudWinProbabilityBps: 4_000 },
    },
  };
  return (["RFI", "CHARGEBACK"] as const).map((stage) => {
    const result = recommendDisputeAction({ ...base, stage }, economics, nowMs);
    return { stage, action: result.action, expectedNetValueMinor: result.expectedNetValueMinor,
      reasonCodes: result.reasonCodes };
  });
}

export function createDisputeReviewHandler(deps: DisputeReviewHttpDeps) {
  const now = deps.now ?? Date.now;
  const bootstrapCsrf = deps.bootstrapCsrf ?? randomBytes(32).toString("base64url");
  if (deps.operatorToken.length < 32) throw new Error("DISPUTE_REVIEW_TOKEN must contain at least 32 characters");
  if (new URL(deps.origin).origin !== deps.origin || !deps.origin.startsWith("http://127.0.0.1:")) throw new Error("Review dashboard must use an exact loopback origin");
  const provider = createDisputeProviderAdapter(deps.providerMode);
  const proposalMode = deps.proposalMode ?? "OFFLINE_MOCK";
  const proposalProvider = deps.proposalProvider ?? (proposalMode === "OFFLINE_MOCK" ? new OfflineMockProposalProvider() : undefined);
  const proposalModelName = deps.proposalModelName ?? proposalProvider?.model ?? "UNCONFIGURED_LOCAL_MODEL";
  const actor = deps.actor;

  async function mutation(req: IncomingMessage, sessionToken?: string): Promise<Record<string, unknown>> {
    if (req.headers.origin !== deps.origin) throw new Error("INVALID_ORIGIN");
    const csrf = req.headers["x-csrf-token"];
    const csrfValue = Array.isArray(csrf) ? csrf[0] : csrf;
    if (csrfValue !== (sessionToken ? csrfForSession(sessionToken) : bootstrapCsrf)) throw new Error("INVALID_CSRF");
    if (sessionToken && !deps.store.validateCsrf(sessionToken, csrfValue, now())) throw new Error("INVALID_CSRF");
    return bodyJson(req);
  }

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const host = req.headers.host;
    if (host !== new URL(deps.origin).host) { send(res, 403, { error: "local_host_only" }); return; }
    const url = new URL(req.url ?? "/", deps.origin);
    const sessionToken = cookie(req);
    const genericError = (error: unknown): void => {
      const message = error instanceof Error ? error.message : "request_failed";
      const status = message === "INVALID_CONTENT_TYPE" ? 415 : message.includes("EXPIRED") || message.includes("INVALID") || message.includes("REPLAYED") ? 403 :
        message === "CASE_REVISION_CONFLICT" ? 409 : message === "BODY_TOO_LARGE" ? 413 : 400;
      send(res, status, { error: message.replace(/[^A-Z0-9_]/gi, "_").slice(0, 64) || "request_failed" });
    };
    try {
      if (req.method === "GET" && url.pathname === "/") {
        const pageNonce = randomBytes(18).toString("base64");
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
          "content-security-policy": `default-src 'self'; script-src 'nonce-${pageNonce}'; style-src 'nonce-${pageNonce}'; connect-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'`,
          "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" });
        res.end(dashboardHtml(bootstrapCsrf, pageNonce)); return;
      }
      if (req.method === "POST" && url.pathname === "/api/session") {
        const body = await mutation(req);
        if (typeof body.operatorToken !== "string" || !secureEqual(body.operatorToken, deps.operatorToken)) { send(res, 401, { error: "authorization_failed" }); return; }
        const rawSession = randomBytes(32).toString("base64url");
        const csrfToken = csrfForSession(rawSession);
        deps.store.createSession(rawSession, csrfToken, actor, now(), SESSION_TTL);
        send(res, 200, { authorized: true, actor, csrfToken, providerMode: provider.mode }, { "set-cookie": `${SESSION_COOKIE}=${rawSession}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=900` });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/session") {
        if (!sessionToken) { send(res, 401, { error: "authorization_required" }); return; }
        const session = deps.store.session(sessionToken, now());
        if (!session || session.actor !== actor) { send(res, 401, { error: "authorization_required" }); return; }
        send(res, 200, { actor: session.actor, csrfToken: csrfForSession(sessionToken), expiresAt: session.expiresAt }); return;
      }
      if (!sessionToken) { send(res, 401, { error: "authorization_required" }); return; }
      const session = deps.store.session(sessionToken, now());
      if (!session || session.actor !== actor) { send(res, 401, { error: "authorization_required" }); return; }
      if (req.method === "GET" && url.pathname === "/api/dashboard") {
        const providerPortfolio = await loadHistoricalProviderPortfolio();
        const visa104Preflight=evaluateVisa104OfflinePreflight({
          identity:visa104FromHistoricalCase(providerPortfolio.cases[0]!),
          evidence:[],dispatchState:"NONE",alreadySubmitted:false,ce30Claimed:false,now:now(),
        });
        const dashboard = deps.store.dashboard();
        send(res, 200, { actor, providerMode: provider.mode, providerActionEnabled: false,
          modelMode: proposalMode, modelName: proposalModelName, modelConfigured: !!proposalProvider && !deps.proposalConfigError, dashboard,
          stageSensitivity: stageSensitivityPreview(dashboard.feeMinor, now()), providerPortfolio, visa104Preflight }); return;
      }
      if (req.method === "POST" && url.pathname === "/api/what-if") {
        const body = await mutation(req, sessionToken);
        const preview = evaluateWhatIf(body as unknown as WhatIfInput, now());
        send(res, 200, preview); return;
      }
      if (req.method === "POST" && url.pathname === "/api/value-of-information") {
        const body = await mutation(req, sessionToken);
        send(res, 200, evaluateValueOfInformation(body, now())); return;
      }
      if (req.method === "POST" && url.pathname === "/api/agent/run") {
        const body = await mutation(req, sessionToken);
        if (!new Set(["provider-rfi", "synthetic-high-fraud", "synthetic-low-value", "synthetic-credit-not-processed"]).has(String(body.scenario))) {
          send(res, 400, { error: "invalid_agent_scenario" }); return;
        }
        if (body.modelInvestigation !== undefined && typeof body.modelInvestigation !== "boolean") { send(res,400,{error:"invalid_model_investigation"}); return; }
        if (body.modelInvestigation === true && (body.scenario !== "synthetic-high-fraud" || body.confirmSynthetic !== true)) {
          send(res,400,{error:"SYNTHETIC_MODEL_CONFIRMATION_REQUIRED"}); return;
        }
        if (body.modelInvestigation === true && (proposalMode !== "LOCAL_LLM" || !deps.agentModelProvider)) {
          send(res,503,{error:deps.proposalConfigError ?? "LOCAL_MODEL_NOT_CONFIGURED",providerAction:"NOT_EXECUTED"}); return;
        }
        const result = await runDisputeAgent(body.scenario as AgentScenario, { now,
          ...(body.modelInvestigation === true ? { modelInvestigation:"LOCAL_LLM" as const, modelProvider:deps.agentModelProvider } : {}) });
        if (result.providerAction !== "NOT_EXECUTED") throw new Error("PROVIDER_ACTION_BOUNDARY_BROKEN");
        send(res, 200, result); return;
      }
      if (req.method === "POST" && url.pathname === "/api/challenge-packet") {
        const body = await mutation(req, sessionToken);
        if (body.caseId !== "kit04-high-value-fraud") { send(res, 400, { error: "invalid_challenge_packet_case" }); return; }
        const current = deps.store.dashboard().cases.find((item) => item.caseId === body.caseId);
        if (!current) { send(res, 404, { error: "challenge_packet_case_not_found" }); return; }
        const decision = current.decision as { choice: "APPROVE" | "REJECT"; recommendedAction: string; actor: string;
          createdAt: number; idempotencyKey: string; revision: number } | null;
        const packet = createChallengeEvidencePacket({ caseId: String(current.caseId), revision: Number(current.revision),
          snapshot: current.snapshot as DisputeSnapshot, recommendation: current.recommendation as ReturnType<typeof recommendDisputeAction>,
          evidence: current.evidence as DisputeSnapshot["evidence"], decision });
        send(res, 200, { packet, providerAction: "NOT_EXECUTED" }); return;
      }
      if (req.method === "POST" && url.pathname === "/api/decision-proof/step") {
        const body = await mutation(req, sessionToken);
        if (body.step !== "RESET" && body.step !== "INJECT_CONFLICT" && body.step !== "RESOLVE_CONFLICT") {
          send(res, 400, { error: "invalid_decision_proof_step" }); return;
        }
        send(res, 200, deps.store.advanceDecisionProof(sessionToken, body.step, now())); return;
      }
      if (req.method === "POST" && url.pathname === "/api/decision-proof/certificate") {
        await mutation(req, sessionToken);
        const item = deps.store.dashboard().cases.find((candidate) => candidate.caseId === DECISION_PROOF_CASE_ID);
        if (!item) { send(res, 404, { error: "decision_proof_case_not_found" }); return; }
        const certificate = createDecisionCertificate({ revision: Number(item.revision), snapshot: item.snapshot as DisputeSnapshot,
          economics: { ...DEFAULT_DISPUTE_ECONOMICS, disputeFeeMinor: deps.store.dashboard().feeMinor }, createdAt: new Date(now()).toISOString() });
        const verification = verifyDecisionCertificate(certificate, Number(item.revision));
        send(res, 200, { certificate, verification, providerActionState: "NOT_EXECUTED", evidenceLabel: "OFFLINE_DEMO" }); return;
      }
      if (req.method === "POST" && url.pathname === "/api/decision-proof/verify") {
        const body = await mutation(req, sessionToken);
        const result = verifyDecisionCertificate(body.certificate, Number.isSafeInteger(body.expectedRevision) ? Number(body.expectedRevision) : undefined,
          typeof body.pinnedDigest === "string" ? body.pinnedDigest : undefined);
        send(res, result.ok ? 200 : 422, { verification: result, evidenceLabel: "OFFLINE_DEMO" }); return;
      }
      if (req.method === "POST" && url.pathname === "/api/authorizations") {
        await mutation(req, sessionToken);
        send(res, 200, deps.store.issueAuthorizations(sessionToken, now(), AUTH_TTL)); return;
      }
      if (req.method === "POST" && url.pathname === "/api/evidence/ingest") {
        const body = await mutation(req, sessionToken);
        if (typeof body.caseId !== "string" || typeof body.documentId !== "string" || typeof body.text !== "string") {
          send(res, 400, { error: "invalid_evidence_ingest_request" }); return;
        }
        const outcome = deps.store.ingestOfflineText(sessionToken, body.caseId, body.documentId, body.text, now());
        send(res, 200, { result: "OFFLINE_UNVERIFIED_DOCUMENT_STORED", documentId: body.documentId, sha256: outcome.sha256,
          facts: outcome.facts, providerActionState: "NOT_EXECUTED" }); return;
      }
      if (req.method === "POST" && url.pathname === "/api/evidence/attest") {
        const body = await mutation(req, sessionToken);
        if (typeof body.caseId !== "string" || typeof body.documentId !== "string" ||
            typeof body.factId !== "string" || typeof body.sha256 !== "string") {
          send(res, 400, { error: "invalid_evidence_attestation_request" }); return;
        }
        const outcome = deps.store.attestOfflineTextFact(sessionToken, body.caseId, body.documentId, body.factId, body.sha256, now());
        send(res, 200, { result: "OFFLINE_REPLAN_RECORDED", ...outcome, providerActionState: "NOT_EXECUTED" }); return;
      }
      if (req.method === "POST" && url.pathname === "/api/evidence/propose") {
        const body = await mutation(req, sessionToken);
        if (typeof body.caseId !== "string" || typeof body.documentId !== "string") { send(res,400,{error:"invalid_proposal_request"}); return; }
        if (proposalMode === "OFFLINE_MOCK") {
          const proposals=deps.store.requestMockProposal(sessionToken,body.caseId,body.documentId,now());
          send(res,200,{result:"OFFLINE_MOCK_PROPOSALS_STORED",modelMode:proposalMode,model:new OfflineMockProposalProvider().model,
            proposals,offsetRepairs:0,modelInference:false,requestBoundary:"NO_MODEL_REQUEST",providerActionState:"NOT_EXECUTED"}); return;
        }
        if (body.confirmSynthetic !== true) { send(res,400,{error:"SYNTHETIC_SOURCE_CONFIRMATION_REQUIRED"}); return; }
        if (!proposalProvider || deps.proposalConfigError) {
          const code=deps.proposalConfigError ?? "LOCAL_MODEL_NOT_CONFIGURED";
          deps.store.recordEvidenceModelFailure(sessionToken,body.caseId,proposalMode,code,now());
          send(res,503,{error:code,modelMode:proposalMode,providerActionState:"NOT_EXECUTED"}); return;
        }
        try {
          const result=await deps.store.requestEvidenceProposal(sessionToken,body.caseId,body.documentId,proposalProvider,now());
          send(res,200,{result:"LOCAL_MODEL_PROPOSALS_STORED",...result,modelInference:true,requestBoundary:"LOCAL_LOOPBACK_ONLY",providerActionState:"NOT_EXECUTED"});
        } catch(error) {
          const candidate=error instanceof Error?error.message:"";
          const known=new Set(["MALFORMED_PROPOSAL_JSON","INVALID_PROPOSAL_SCHEMA","MALFORMED_MODEL_PROPOSAL_JSON","INVALID_MODEL_PROPOSAL_SCHEMA",
            "PROPOSAL_RESPONSE_TOO_LARGE","INVALID_LOCAL_MODEL_RESPONSE","MODEL_OR_PROMPT_ID_MISMATCH",
            "MODEL_EXTRACTION_CONTRACT_VERSION_MISMATCH","LOCAL_MODEL_RESPONSE_ID_MISMATCH","LOCAL_MODEL_IDENTITY_NOT_VERIFIED","SOURCE_HASH_INVALID",
            "LOCAL_MODEL_COMPLETION_TIMEOUT","LOCAL_MODEL_COMPLETION_REQUEST_FAILED","LOCAL_MODEL_DISCOVERY_REQUEST_FAILED"]);
          const conflict=new Set(["SOURCE_CHANGED_DURING_MODEL_RUN","CASE_REVISION_CHANGED_DURING_MODEL_RUN","CASE_SNAPSHOT_CHANGED_DURING_MODEL_RUN"]);
          const code=known.has(candidate)?candidate:"LOCAL_MODEL_UNAVAILABLE";
          deps.store.recordEvidenceModelFailure(sessionToken,body.caseId,proposalMode,code,now());
          const transportFailure=code.startsWith("LOCAL_MODEL_COMPLETION_")||code.startsWith("LOCAL_MODEL_DISCOVERY_");
          send(res,conflict.has(candidate)?409:known.has(code)&&!transportFailure?422:503,{error:conflict.has(candidate)?candidate:code,modelMode:proposalMode,providerActionState:"NOT_EXECUTED"});
        }
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/evidence/proposal-attest") {
        const body = await mutation(req, sessionToken);
        if (typeof body.caseId !== "string" || typeof body.documentId !== "string" || typeof body.proposalId !== "string") { send(res,400,{error:"invalid_proposal_attestation_request"}); return; }
        send(res,200,{result:"PROPOSAL_ATTESTED_AND_REPLANNED",...deps.store.attestGroundedProposal(sessionToken,body.caseId,body.documentId,body.proposalId,now()),providerActionState:"NOT_EXECUTED"}); return;
      }
      if (req.method === "POST" && url.pathname === "/api/evidence/proposal-reject") {
        const body = await mutation(req, sessionToken);
        if (typeof body.caseId !== "string" || typeof body.proposalId !== "string") { send(res,400,{error:"invalid_proposal_rejection_request"}); return; }
        deps.store.rejectEvidenceProposal(sessionToken,body.caseId,body.proposalId,now());
        send(res,200,{result:"PROPOSAL_REJECTED",providerActionState:"NOT_EXECUTED"}); return;
      }
      if (req.method === "POST" && url.pathname === "/api/evidence/certificate") {
        const body=await mutation(req,sessionToken);
        if(body.caseId!=="kit04-evidence-lab"){send(res,400,{error:"invalid_evidence_certificate_case"});return;}
        const dashboard=deps.store.dashboard();
        const item=dashboard.cases.find(candidate=>candidate.caseId===body.caseId);
        if(!item){send(res,404,{error:"evidence_case_not_found"});return;}
        const decision=item.decision as {idempotencyKey?:string}|null;
        const certificate=createDecisionCertificate({revision:Number(item.revision),snapshot:item.snapshot as DisputeSnapshot,
          economics:{...DEFAULT_DISPUTE_ECONOMICS,disputeFeeMinor:dashboard.feeMinor},
          ...(decision?.idempotencyKey?{approvalRef:decision.idempotencyKey}:{}),createdAt:new Date(now()).toISOString()});
        const verification=verifyDecisionCertificate(certificate,Number(item.revision));
        send(res,verification.ok?200:422,{certificate,verification,providerActionState:"NOT_EXECUTED",evidenceLabel:"OFFLINE_DEMO",
          modelMode:proposalMode,modelInference:proposalMode==="LOCAL_LLM"});return;
      }
      if (req.method === "POST" && url.pathname === "/api/evidence/certificate/verify") {
        const body=await mutation(req,sessionToken);
        const result=verifyDecisionCertificate(body.certificate,Number.isSafeInteger(body.expectedRevision)?Number(body.expectedRevision):undefined,
          typeof body.pinnedDigest==="string"?body.pinnedDigest:undefined);
        send(res,result.ok?200:422,{verification:result,evidenceLabel:"OFFLINE_DEMO",providerActionState:"NOT_EXECUTED"});return;
      }
      if (req.method === "POST" && url.pathname === "/api/lifecycle/authorization") {
        await mutation(req, sessionToken);
        send(res,200,deps.store.issueLifecycleChallengeApproval(sessionToken,now())); return;
      }
      if (req.method === "POST" && url.pathname === "/api/lifecycle/advance") {
        const body = await mutation(req, sessionToken);
        if ((body.event !== "SUBMIT_CHALLENGE" && body.event !== "SIMULATE_ISSUER_REJECTION") || typeof body.eventId !== "string") { send(res,400,{error:"invalid_lifecycle_request"}); return; }
        send(res,200,{result:"OFFLINE_FIXTURE_ADVANCED",...deps.store.advanceOfflineLifecycle(sessionToken,body.event,body.eventId,now(),typeof body.authorization === "string" ? body.authorization : undefined),providerActionState:"NOT_EXECUTED"}); return;
      }
      if (req.method === "POST" && url.pathname === "/api/review") {
        const body = await mutation(req, sessionToken);
        if (typeof body.caseId !== "string" || (body.choice !== "APPROVE" && body.choice !== "REJECT") || typeof body.authorization !== "string") {
          send(res, 400, { error: "invalid_review_request" }); return;
        }
        const result = deps.store.decide(sessionToken, body.caseId, body.choice as ReviewChoice, body.authorization, now());
        send(res, result === "CONFLICT" ? 409 : 200, { result, providerActionState: "NOT_EXECUTED", refundState: "NOT_CONFIRMED" }); return;
      }
      if (req.method === "POST" && url.pathname === "/api/fee") {
        const body = await mutation(req, sessionToken);
        if (typeof body.feeMinor !== "number" || typeof body.authorization !== "string") { send(res, 400, { error: "invalid_fee_request" }); return; }
        deps.store.setFee(sessionToken, body.feeMinor, body.authorization, now());
        send(res, 200, { result: "FEE_UPDATED", providerActionState: "NOT_EXECUTED" }); return;
      }
      send(res, 404, { error: "not_found" });
    } catch (error) { genericError(error); }
  };
}

export function createDisputeReviewServer(deps: DisputeReviewHttpDeps): Server {
  return createServer(createDisputeReviewHandler(deps));
}

function currentActor(): string {
  if (process.platform === "win32") {
    const identity = execFileSync("whoami.exe", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true });
    const sid = identity.match(/S-\d(?:-\d+)+/i)?.[0];
    if (!sid) throw new Error("Could not determine the Windows operator identity.");
    const account = identity.trim().split(",")[0]?.replaceAll('"', "").trim();
    return `${account || "windows-user"} [${sid}]`;
  }
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("Could not determine the local operator identity.");
  return `uid:${uid}`;
}

async function main(): Promise<void> {
  const operatorToken = process.env.DISPUTE_REVIEW_TOKEN ?? "";
  if (operatorToken.length < 32) throw new Error("Set DISPUTE_REVIEW_TOKEN to a private random token of at least 32 characters.");
  const mode = process.env.DISPUTE_PROVIDER_MODE ?? "MOCK";
  if (mode !== "MOCK" && mode !== "LIVE") throw new Error("DISPUTE_PROVIDER_MODE must be MOCK or LIVE.");
  const proposalModeValue = process.env.FAIR_TRIAL_MODEL_MODE ?? "OFFLINE_MOCK";
  if (proposalModeValue !== "OFFLINE_MOCK" && proposalModeValue !== "LOCAL_LLM")
    throw new Error("FAIR_TRIAL_MODEL_MODE must be OFFLINE_MOCK or LOCAL_LLM.");
  const proposalMode:EvidenceProposalMode=proposalModeValue;
  const localModelId=process.env.LOCAL_MODEL_ID ?? "";
  const localModelEndpoint=process.env.LOCAL_MODEL_ENDPOINT ?? "http://127.0.0.1:12345/v1/chat/completions";
  const localModelTimeoutMs=Number(process.env.LOCAL_MODEL_TIMEOUT_MS ?? DEFAULT_LOCAL_MODEL_TIMEOUT_MS);
  let proposalProvider:EvidenceProposalProvider|undefined;
  let proposalConfigError:string|undefined;
  if(proposalMode==="OFFLINE_MOCK")proposalProvider=new OfflineMockProposalProvider();
  else if(!localModelId.trim() || localModelId.length>128 || /[\x00-\x1f]/.test(localModelId))proposalConfigError="LOCAL_MODEL_NOT_CONFIGURED";
  else {
    try { proposalProvider=new LocalRuntimeProposalProvider({endpoint:localModelEndpoint,model:localModelId,enabled:true,timeoutMs:localModelTimeoutMs}); }
    catch { proposalConfigError="LOCAL_MODEL_CONFIGURATION_INVALID"; }
  }
  const port = Number(process.env.DISPUTE_REVIEW_PORT ?? 4243);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("DISPUTE_REVIEW_PORT is invalid.");
  const path = resolve(process.env.DISPUTE_REVIEW_DB ?? "out/dispute-review.sqlite");
  const initialFee = process.env.DISPUTE_FEE_MINOR === undefined ? undefined : Number(process.env.DISPUTE_FEE_MINOR);
  const store = await DisputeReviewStore.open(path, initialFee);
  const server = createDisputeReviewServer({ store, operatorToken, actor: currentActor(), origin: `http://127.0.0.1:${port}`,
    providerMode: mode, proposalMode, proposalProvider, agentModelProvider:proposalProvider, proposalModelName:proposalProvider?.model ?? (localModelId || "UNCONFIGURED_LOCAL_MODEL"), proposalConfigError });
  server.on("error", () => console.error("Dispute review server failed to start."));
  server.listen(port, "127.0.0.1", () => console.log(`Offline dispute review dashboard listening at http://127.0.0.1:${port}`));
  const close = () => { server.close(); store.close(); };
  process.once("SIGINT", close); process.once("SIGTERM", close);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void main();
