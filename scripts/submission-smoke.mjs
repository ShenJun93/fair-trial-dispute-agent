import { spawnSync } from 'node:child_process';
import { access, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const evidenceDir = path.join(root, 'submission', 'evidence', 'g2-004');
const required = [
  'README.md', 'docs/hackathon/BASELINE.md', 'docs/hackathon/PRIZE_EVIDENCE_MATRIX.md',
  'docs/hackathon/DECISION_PROOF_WALKTHROUGH.md', 'docs/hackathon/EXECUTION_LOG.md',
  'submission/FT_AGENTIC_002_REAL_MODEL_VALIDATION.md',
  'submission/evidence/ft-agentic-002-grounding-audit.json',
  'submission/FOUNDER_BUSINESS_CASE.md', 'submission/DEMO_SCRIPT_UNDER_5_MIN.md',
  'submission/benchmark/financial-decision-scenarios.json', 'submission/benchmark/financial-decision-results.json',
  'submission/evidence/dispute-list-read.json',
  'submission/FT_PREVIDEO_QUALITY_REVIEW.md',
  'submission/evidence/ft-prevideo-quality/browser-acceptance-sanitized.json',
  'submission/evidence/ft-browser-recovery-001/browser-rehearsal-prevideo-20261029.json',
  'submission/FT_PREVIDEO_STABILIZATION_002.md',
  'submission/evidence/ft-prevideo-stabilization-002/verification-sanitized.json',
  'submission/FT_030_VERIFICATION.md', 'submission/FT_030_MODEL_EVALUATION.md', 'submission/FT_030_DEMO_READINESS.md',
  'submission/evidence/ft030-agent-demonstration.json',
  'submission/FT_031_AI_CAPABILITY.md', 'submission/FT_031_MODEL_BENCHMARK.md',
  'submission/FT_031_DECISION_INTELLIGENCE.md', 'submission/FT_031_AGENT_EVALUATION.md',
  'submission/FT_031_SECURITY_REVIEW.md', 'submission/FT_031_VERIFICATION.md',
  'submission/FT_031_COMPETITIVE_SCORE.md', 'submission/FT_031_NEXT_ACTION.md',
  'submission/evidence/ft031-agent-demonstration.json', 'submission/evidence/ft031-model-evaluation.json',
  'submission/evidence/ft031-voi-scenarios.json',
  'JUDGE_QUICKSTART.md', 'submission/FT_032_UX_AUDIT.md', 'submission/FT_032_JUDGE_EXPERIENCE.md',
  'submission/FT_032_VISUAL_ACCEPTANCE.md', 'submission/FT_032_QUICKSTART_VERIFICATION.md',
  'submission/FT_032_PACKAGE_HYGIENE.md', 'submission/FT_032_COMPETITIVE_SCORE.md',
  'submission/FT_032_VERIFICATION.md', 'submission/FT_032_NEXT_ACTION.md',
  'submission/evidence/ft032-agent-demonstration.json', 'submission/evidence/ft032-voi-scenarios.json',
  'submission/evidence/ft032-model-availability.json',
];
for (const relative of required) await access(path.join(root, relative));
const benchmark = JSON.parse(await readFile(path.join(root, 'submission/benchmark/financial-decision-results.json'), 'utf8'));
if (!benchmark.passed || benchmark.metrics.policyDecisionCorrectness !== '10/10' || benchmark.metrics.deterministicScenarios !== 10)
  throw new Error('BENCHMARK_RESULT_INVALID');
const grounding = JSON.parse(await readFile(path.join(root, 'submission/evidence/ft-agentic-002-grounding-audit.json'), 'utf8'));
if (grounding.schemaVersion !== 'fair-trial-grounding-policy-audit/v1' || grounding.counts.total !== 50 ||
    grounding.counts.supportedGrounded !== 25 || grounding.counts.unsupportedRejected !== 25 ||
    grounding.counts.unsupportedAccidentallyGrounded !== 0)
  throw new Error('GROUNDING_AUDIT_INVALID');
const browser = JSON.parse(await readFile(path.join(evidenceDir, 'browser-acceptance.json'), 'utf8'));
if (browser.status !== 'PASS' || browser.server.providerMode !== 'MOCK' || browser.server.bind !== '127.0.0.1' ||
    browser.server.operatorTokenRecorded !== false || browser.checks.some((check) => check.passed !== true) ||
    browser.recording?.file !== 'submission/video/fair-trial-g2-004-browser-demo.mp4' || browser.recording.audio !== 'none')
  throw new Error('BROWSER_EVIDENCE_INVALID');
const initial = JSON.parse(await readFile(path.join(evidenceDir, 'initial-decision-certificate.json'), 'utf8'));
const revised = JSON.parse(await readFile(path.join(evidenceDir, 'revised-decision-certificate.json'), 'utf8'));
const tamperedPath = path.join(evidenceDir, 'tampered-decision-certificate.json');
if (initial.snapshotFingerprint === revised.snapshotFingerprint || revised.revision <= initial.revision)
  throw new Error('CERTIFICATE_CHANGE_NOT_PROVEN');
function verify(file) {
  return spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx',
    'scripts/verify-decision-certificate.ts', file], { cwd: root, encoding: 'utf8', windowsHide: true });
}
for (const name of ['initial-decision-certificate.json', 'revised-decision-certificate.json']) {
  const result = verify(path.join(evidenceDir, name));
  if (result.status !== 0 || !result.stdout.includes('"ok":true')) throw new Error(`CERTIFICATE_VERIFICATION_FAILED:${name}`);
}
const tampered = verify(tamperedPath);
if (tampered.status === 0 || !tampered.stdout.includes('"ok":false')) throw new Error('TAMPERED_CERTIFICATE_ACCEPTED');
const shots = browser.screenshots;
for (const name of shots) {
  if (!(await stat(path.join(evidenceDir, name))).size) throw new Error(`SCREENSHOT_EMPTY:${name}`);
}
const receipts = (await readdir(path.join(root, 'submission/evidence'))).filter((name) => name.startsWith('airwallex-readonly-20261029T011612Z-'));
if (!receipts.length) throw new Error('SANDBOX_READ_RECEIPT_MISSING');
const preVideoBrowser = JSON.parse(await readFile(path.join(root, 'submission/evidence/ft-prevideo-quality/browser-acceptance-sanitized.json'), 'utf8'));
if (preVideoBrowser.status !== 'PASS' || preVideoBrowser.checks?.passed !== 14 || preVideoBrowser.checks?.total !== 14 ||
    preVideoBrowser.financialProvider !== 'MOCK' || preVideoBrowser.modelInference !== false ||
    preVideoBrowser.providerMutationCount !== 0 || preVideoBrowser.providerAction !== 'NOT_EXECUTED' ||
    preVideoBrowser.operatorTokenRecorded !== false || preVideoBrowser.finalRemotionVideo !== 'DEFERRED')
  throw new Error('PREVIDEO_BROWSER_RECEIPT_INVALID');
const preVideoShots = preVideoBrowser.screenshots;
for (const name of preVideoShots) {
  if (!(await stat(path.join(root, 'submission/evidence/ft-prevideo-quality', name))).size)
    throw new Error(`PREVIDEO_SCREENSHOT_EMPTY:${name}`);
}
const rehearsal = JSON.parse(await readFile(path.join(root, 'submission/evidence/ft-browser-recovery-001/browser-rehearsal-prevideo-20261029.json'), 'utf8'));
if (rehearsal.status !== 'PASS' || rehearsal.summary?.passed !== 9 || rehearsal.summary?.total !== 9 ||
    rehearsal.modelStartup !== false || rehearsal.providerMutation !== false || rehearsal.cloudInference !== false)
  throw new Error('PREVIDEO_REHEARSAL_RECEIPT_INVALID');
if (!rehearsal.scenarios?.some((scenario) => scenario.classification === 'RECORDED_REPLAY_GROUNDED_NOT_LIVE_INFERENCE' && scenario.liveInference === false))
  throw new Error('RECORDED_REPLAY_NOT_LABELED');
const stabilization = JSON.parse(await readFile(path.join(root, 'submission/evidence/ft-prevideo-stabilization-002/verification-sanitized.json'), 'utf8'));
if (stabilization.classification !== 'MOCK_AND_SYNTHETIC_ACCEPTANCE_ONLY; NOT_REAL_MODEL_INFERENCE_OR_PROVIDER_EXECUTION' ||
    stabilization.qwenStartup !== false || stabilization.providerMutation !== false || stabilization.cloudInference !== false ||
    stabilization.rootCause?.restrictedSandbox?.tcpConnect !== 'EACCES' ||
    stabilization.rootCause?.approvedLoopbackContext?.rawHttpStatus !== 200 ||
    stabilization.rootCause?.approvedLoopbackContext?.nodeFetchStatus !== 200 ||
    stabilization.rootCause?.approvedLoopbackContext?.curlHttpStatus !== 200 ||
    stabilization.fakeProviderEdgeRehearsal?.length !== 2 ||
    stabilization.fakeProviderEdgeRehearsal.some((run) => run.preflight !== 'PASS' || run.passed !== 9 || run.total !== 9) ||
    stabilization.independentEdgeAcceptance?.status !== 'PASS' || stabilization.independentEdgeAcceptance?.checks !== '14/14' ||
    stabilization.independentEdgeAcceptance?.providerMutationCount !== 0 ||
    stabilization.independentEdgeAcceptance?.challengePacket !== 'NOT_SUBMITTED / NOT_EXECUTED' ||
    stabilization.independentEdgeAcceptance?.validCertificate !== 'VERIFIED' || stabilization.independentEdgeAcceptance?.tamperedCertificate !== 'REJECTED' ||
    Object.values(stabilization.feeChangeInvalidation ?? {}).some((value) => value !== true && value !== 'NOT_SUBMITTED / NOT_EXECUTED'))
  throw new Error('STABILIZATION_EVIDENCE_INVALID');
const ft030 = JSON.parse(await readFile(path.join(root, 'submission/evidence/ft030-agent-demonstration.json'), 'utf8'));
const expectedAgentRuns = new Map([
  ['provider-rfi', ['PROVIDER_BACKED_SAVED_RECEIPTS', 'HOLD / REQUEST_EVIDENCE / HUMAN_REVIEW']],
  ['synthetic-high-fraud', ['OFFLINE_SYNTHETIC_FIXTURE', 'CHALLENGE_RECOMMENDED']],
  ['synthetic-low-value', ['OFFLINE_SYNTHETIC_FIXTURE', 'ACCEPT_RECOMMENDED']],
  ['synthetic-credit-not-processed', ['OFFLINE_SYNTHETIC_FIXTURE', 'ESCALATE_FOR_REVIEW']],
]);
if (ft030.schemaVersion !== 'fair-trial-agent-demo-receipt/v1' || ft030.runs?.length !== 4 ||
    ft030.runs.some((run) => !expectedAgentRuns.has(run.scenario) || run.dataLabel !== expectedAgentRuns.get(run.scenario)?.[0] ||
      run.final.action !== expectedAgentRuns.get(run.scenario)?.[1] || run.providerAction !== 'NOT_EXECUTED' ||
      run.modelPlanning !== 'NOT_IMPLEMENTED' || run.modelInvestigation?.status !== 'NOT_RUN' ||
      run.trace.some((entry) => entry.tool === 'submit_provider_action' || entry.tool === 'execute_refund')))
  throw new Error('FT030_AGENT_DEMO_RECEIPT_INVALID');
const ft031 = JSON.parse(await readFile(path.join(root, 'submission/evidence/ft031-agent-demonstration.json'), 'utf8'));
const ft031Model = JSON.parse(await readFile(path.join(root, 'submission/evidence/ft031-model-evaluation.json'), 'utf8'));
const ft031Voi = JSON.parse(await readFile(path.join(root, 'submission/evidence/ft031-voi-scenarios.json'), 'utf8'));
if (ft031.schemaVersion !== 'fair-trial-ft031-agent-evaluation/v1' || ft031.runs?.length !== 4 ||
    ft031.runs.some((run) => run.providerAction !== 'NOT_EXECUTED' || run.modelPlanning !== 'NOT_IMPLEMENTED') ||
    ft031Model.schemaVersion !== 'fair-trial-ft031-model-evaluation/v1' ||
    (ft031Model.status === 'NOT_RUN' && (ft031Model.inferenceCalls !== 0 || ft031Model.modelIdentity !== null)) ||
    ft031Model.providerAction !== 'NOT_EXECUTED' || ft031Voi.schemaVersion !== 'fair-trial-ft031-value-of-information/v1' ||
    ft031Voi.scenarios?.length !== 5 || ft031Voi.scenarios.some((item) => item.providerAction !== 'NOT_EXECUTED' ||
      item.probabilityModel !== 'NONE_BOUNDED_SCENARIOS_ONLY'))
  throw new Error('FT031_EVIDENCE_INVALID');
const ft032 = JSON.parse(await readFile(path.join(root, 'submission/evidence/ft032-agent-demonstration.json'), 'utf8'));
const ft032Voi = JSON.parse(await readFile(path.join(root, 'submission/evidence/ft032-voi-scenarios.json'), 'utf8'));
const ft032Model = JSON.parse(await readFile(path.join(root, 'submission/evidence/ft032-model-availability.json'), 'utf8'));
if (ft032.schemaVersion !== 'fair-trial-ft032-demo-sequence/v1' || ft032.runs?.length !== 4 ||
    ft032.runs.some((run) => run.providerAction !== 'NOT_EXECUTED' || run.modelPlanning !== 'NOT_IMPLEMENTED') ||
    ft032.runs[0]?.dataLabel !== 'PROVIDER_BACKED_SAVED_RECEIPTS' ||
    ft032.runs[1]?.final.action !== 'CHALLENGE_RECOMMENDED' || ft032.runs[1]?.initial.revision !== 1 ||
    ft032.runs[1]?.final.revision !== 2 || ft032.runs[1]?.replan?.staleCertificateInvalidated !== true ||
    ft032.runs[2]?.final.action !== 'ACCEPT_RECOMMENDED' || ft032.runs[3]?.final.action !== 'ESCALATE_FOR_REVIEW' ||
    ft032Voi.schemaVersion !== 'fair-trial-ft032-value-of-information/v1' || ft032Voi.scenarios?.length !== 5 ||
    ft032Voi.scenarios.some((item) => item.providerAction !== 'NOT_EXECUTED' || item.probabilityModel !== 'NONE_BOUNDED_SCENARIOS_ONLY') ||
    ft032Model.schemaVersion !== 'fair-trial-ft032-model-availability/v1' || ft032Model.status !== 'MODEL_NOT_AVAILABLE' ||
    ft032Model.ft032?.inferenceCalls !== 0 || ft032Model.ft032?.providerAction !== 'NOT_EXECUTED')
  throw new Error('FT032_EVIDENCE_INVALID');
console.log(JSON.stringify({ smoke: 'PASS', docs: required.length, benchmarkScenarios: benchmark.scenarios.length,
  browserChecks: browser.checks.length, screenshots: shots.length, certificates: '2 verified, tampered copy rejected',
  preVideoBrowserChecks: preVideoBrowser.checks.total, preVideoScreenshots: preVideoShots.length,
  fakeBrowserRehearsals: `${rehearsal.summary.passed}/${rehearsal.summary.total}`,
  stabilizationRehearsals: stabilization.fakeProviderEdgeRehearsal.map((run) => `${run.passed}/${run.total}`).join(',') ,
  feeChangeInvalidation: stabilization.feeChangeInvalidation?.oldPacketRejected === true,
  airwallexReadReceipts: receipts.length, ft030AgentScenarios: ft030.runs.length,
  ft031AgentScenarios: ft031.runs.length, ft031VoiScenarios: ft031Voi.scenarios.length,
  ft032AgentScenarios: ft032.runs.length, ft032VoiScenarios: ft032Voi.scenarios.length,
  ft032ModelStatus: ft032Model.status,
  ft031ModelStatus: ft031Model.status, finalVideo: 'DEFERRED', videoScriptUnderFiveMinutes: true }));
