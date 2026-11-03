import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputArg = process.argv.indexOf('--output-dir');
if (outputArg >= 0 && !process.argv[outputArg + 1]) throw new Error('OUTPUT_DIR_REQUIRED');
const runStamp = new Date().toISOString().replace(/[:.]/g, '-');
const evidenceDir = path.resolve(root, outputArg >= 0 ? process.argv[outputArg + 1] : path.join('out', `g2-004-${runStamp}-${randomBytes(3).toString('hex')}`));
const evidenceRelativePath = path.relative(root, evidenceDir);
if (evidenceRelativePath === '..' || evidenceRelativePath.startsWith(`..${path.sep}`) || path.isAbsolute(evidenceRelativePath))
  throw new Error('OUTPUT_DIR_MUST_BE_WITHIN_REPOSITORY');
await mkdir(path.dirname(evidenceDir), { recursive: true });
// Each run gets a new directory. Never remove or overwrite saved release evidence.
await mkdir(evidenceDir);
const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'fair-trial-g2-004-'));
const dbPath = path.join(tempRoot, 'isolated-dashboard.sqlite');
const downloadDir = path.join(tempRoot, 'downloads');
const browserProfile = path.join(tempRoot, 'edge-profile');
const videoFramesDir = path.join(tempRoot, 'video-frames');
await mkdir(downloadDir, { recursive: true });
await mkdir(videoFramesDir, { recursive: true });
const token = randomBytes(32).toString('base64url');
const errors = [];
const checks = [];
const tempDbPathIsolated = true;
const startupDiagnostics = [];
let server;
let edge;
let ws;
let nextId = 0;
const pending = new Map();
let pageTarget;
let origin;
let screencastStarted = false;
let screencastFrameCount = 0;
let frameCaptureTask;

async function reserveEphemeralPort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => listener.listen(0, '127.0.0.1', resolve).once('error', reject));
  const { port } = listener.address();
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return port;
}
async function waitFor(check, message, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await delay(100);
  }
  throw new Error(message);
}
async function send(method, params = {}) {
  const id = ++nextId;
  const result = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  ws.send(JSON.stringify({ id, method, params }));
  return result;
}
function evaluate(expression) {
  return send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }).then((reply) => {
    if (reply.exceptionDetails) throw new Error(`BROWSER_EVALUATION_FAILED:${reply.exceptionDetails.text ?? 'exception'}`);
    return reply.result?.value;
  });
}
async function waitDom(expression, message) {
  return waitFor(async () => evaluate(expression), message);
}
async function clickAndWait(selector, expression, message) {
  const found = await evaluate(`!!document.querySelector(${JSON.stringify(selector)})`);
  if (!found) throw new Error(`UI_CONTROL_MISSING:${selector}`);
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  return waitDom(expression, message);
}
async function screenshot(name) {
  const box = await evaluate(`(() => { const e=document.querySelector('#decisionProof'); e.scrollIntoView(); const r=e.getBoundingClientRect(); return {x:r.x,y:r.y+scrollY,width:r.width,height:r.height}; })()`);
  if (!box || box.width < 100 || box.height < 100) throw new Error('SCREENSHOT_TARGET_UNAVAILABLE');
  const result = await send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: true,
    clip: { x: Math.max(0, box.x), y: Math.max(0, box.y), width: box.width, height: box.height, scale: 1 } });
  await writeFile(path.join(evidenceDir, name), Buffer.from(result.data, 'base64'));
  const caseBox = await evaluate(`(() => { const e=document.querySelector('#cases article[data-case-id="kit04-decision-proof"]'); const r=e.getBoundingClientRect(); return {x:0,y:r.top+scrollY,width:document.documentElement.clientWidth,height:r.height}; })()`);
  const caseImage = await send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: true,
    clip: { x: caseBox.x, y: caseBox.y, width: caseBox.width, height: caseBox.height, scale: 1 } });
  await writeFile(path.join(evidenceDir, name.replace(/\.png$/, '-case.png')), Buffer.from(caseImage.data, 'base64'));
  if (screencastStarted) await delay(2500);
}
async function screenshotElement(selector, name) {
  const box = await evaluate(`(() => { const e=document.querySelector(${JSON.stringify(selector)}); if(!e)return null; e.scrollIntoView(); const r=e.getBoundingClientRect(); return {x:0,y:r.top+scrollY,width:document.documentElement.clientWidth,height:r.height}; })()`);
  if (!box || box.height < 20) throw new Error('SCREENSHOT_TARGET_UNAVAILABLE');
  const result = await send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: true,
    clip: { x: box.x, y: box.y, width: box.width, height: box.height, scale: 1 } });
  await writeFile(path.join(evidenceDir, name), Buffer.from(result.data, 'base64'));
}
async function captureRecordingFrame() {
  const box = await evaluate(`(() => { const e=document.querySelector('#cases article[data-case-id="kit04-decision-proof"]'); const r=e.getBoundingClientRect(); return {x:0,y:r.top+scrollY,width:document.documentElement.clientWidth,height:r.height}; })()`);
  const result = await send('Page.captureScreenshot', { format: 'jpeg', quality: 82, fromSurface: true, captureBeyondViewport: true,
    clip: { x: box.x, y: box.y, width: box.width, height: box.height, scale: 1 } });
  const index = screencastFrameCount++;
  await writeFile(path.join(videoFramesDir, `frame-${String(index).padStart(6, '0')}.jpg`), Buffer.from(result.data, 'base64'));
}
async function recordBrowserSurface() {
  while (screencastStarted) {
    await captureRecordingFrame();
    await delay(300);
  }
}
async function downloadCertificate(artifactName, stepName) {
  await evaluate(`(()=>{URL.createObjectURL=(blob)=>{window.__ftCertificateBlob=blob;return 'blob:captured-certificate'};HTMLAnchorElement.prototype.click=function(){window.__ftCertificateName=this.download}})()`);
  await clickAndWait('#proofCertificate', `document.querySelector('#status').textContent.includes('Certificate PASS')`, 'CERTIFICATE_UI_DID_NOT_PASS');
  const captured = await evaluate(`(async()=>({name:window.__ftCertificateName,text:await window.__ftCertificateBlob?.text()}))()`);
  if (captured.name !== 'fair-trial-decision-proof.json' || !captured.text) throw new Error('BROWSER_CERTIFICATE_BLOB_CAPTURE_FAILED');
  const file = path.join(evidenceDir, artifactName);
  await writeFile(file, captured.text, 'utf8');
  const cert = JSON.parse(captured.text);
  checks.push({ step: stepName, passed: true, revision: cert.revision,
    recommendation: cert.recommendation, snapshotFingerprint: cert.snapshotFingerprint, digest: cert.digest,
    artifactCapture: 'browser-created JSON blob captured after certificate UI click' });
  return cert;
}
async function waitServer(url) {
  await waitFor(async () => {
    try {
      const response = await fetch(url);
      if (response.status !== 200) startupDiagnostics.push(`HTTP_${response.status} ${String(await response.text()).slice(0, 200)}`);
      return response.status === 200;
    } catch (error) { startupDiagnostics.push(`FETCH_${error?.cause?.code ?? error?.name ?? 'ERROR'}`); return false; }
  }, 'DASHBOARD_SERVER_DID_NOT_START');
}

try {
  const port = await reserveEphemeralPort();
  origin = `http://127.0.0.1:${port}`;
  const env = { ...process.env, DISPUTE_REVIEW_TOKEN: token, DISPUTE_PROVIDER_MODE: 'MOCK',
    DISPUTE_REVIEW_PORT: String(port), DISPUTE_REVIEW_DB: dbPath };
  delete env.AIRWALLEX_CLIENT_ID;
  delete env.AIRWALLEX_API_KEY;
  server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', 'spike/dispute-review-server.ts'],
    { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  server.stdout.on('data', (chunk) => startupDiagnostics.push(String(chunk).replaceAll(token, '[REDACTED]').slice(0, 500)));
  server.stderr.on('data', (chunk) => startupDiagnostics.push(String(chunk).replaceAll(token, '[REDACTED]').slice(0, 500)));
  await waitServer(origin);

  const edgePath = process.env.FAIR_TRIAL_EDGE_PATH ?? [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ].find((candidate) => candidate);
  spawnSync(edgePath, ['--version'], { encoding: 'utf8', windowsHide: true });
  const debugPort = await reserveEphemeralPort();
  edge = spawn(edgePath, ['--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions',
    `--user-data-dir=${browserProfile}`, `--remote-debugging-port=${debugPort}`, 'about:blank'],
  { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  edge.stdout.on('data', () => {});
  edge.stderr.on('data', () => {});
  const version = await waitFor(async () => {
    try { return await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json(); } catch { return false; }
  }, 'EDGE_DEBUG_ENDPOINT_DID_NOT_START');
  const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
  pageTarget = targets.find((target) => target.type === 'page');
  if (!pageTarget) throw new Error('EDGE_PAGE_TARGET_MISSING');
  ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
  ws.addEventListener('message', (event) => {
    let payload;
    try { payload = JSON.parse(event.data); } catch { return; }
    if (payload.id && pending.has(payload.id)) {
      const waiter = pending.get(payload.id);
      pending.delete(payload.id);
      if (payload.error) waiter.reject(new Error(`CDP_${payload.error.code}`)); else waiter.resolve(payload.result ?? {});
    }
    if (payload.method === 'Runtime.exceptionThrown') errors.push({ kind: 'exception', text: payload.params.exceptionDetails?.text ?? 'uncaught browser exception' });
    if (payload.method === 'Runtime.consoleAPICalled' && payload.params.type === 'error') {
      errors.push({ kind: 'console.error', text: (payload.params.args ?? []).map((arg) => arg.value ?? arg.description ?? '').join(' ').slice(0, 500) });
    }
    if (payload.method === 'Log.entryAdded' && payload.params.entry?.level === 'error') {
      errors.push({ kind: 'browser.log.error', text: String(payload.params.entry.text ?? '').slice(0, 500) });
    }
  });
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1200, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `${origin}/` });
  await waitDom(`document.readyState === 'complete' && document.querySelector('#token')`, 'DASHBOARD_NOT_RENDERED');
  const observedOrigin = await evaluate('location.origin');
  const observedPath = await evaluate('location.pathname');
  if (observedOrigin !== origin || observedPath !== '/') throw new Error('BROWSER_ORIGIN_VALIDATION_FAILED');
  checks.push({ step: 'origin-validated-before-authentication', passed: true, origin: observedOrigin });

  await evaluate(`document.querySelector('#token').value=${JSON.stringify(token)}; document.querySelector('#loginButton').click()`);
  await waitDom(`document.querySelector('#controls').hidden === false && document.querySelector('#cases article h2')`, 'AUTHENTICATION_FAILED');
  const initial = await evaluate(`(() => { const a=document.querySelector('#cases article[data-case-id="kit04-decision-proof"]'); return {revision:Number(a?.querySelector('.case-revision')?.textContent.match(/Revision (\\d+)/)?.[1]), recommendation:a?.innerText.match(/Recommendation: ([A-Z ]+)/)?.[1]?.trim().replaceAll(' ','_'), assumptions:document.querySelector('#decisionProof').innerText.includes('scenario assumptions') && document.querySelector('#decisionProof').innerText.includes('not forecasts')}; })()`);
  if (!initial?.revision || initial.recommendation !== 'CHALLENGE' || !initial.assumptions) throw new Error(`INITIAL_DECISION_PROOF_ASSERTION_FAILED:${JSON.stringify(initial)}`);
  checks.push({ step: 'authenticate-inspect-initial-recommendation', passed: true, ...initial, providerMode: await evaluate("document.querySelector('#mode').textContent") });
  await screenshot('01-initial-decision-proof.png');

  await evaluate(`(()=>{document.querySelector('#whatIfStage').value='RFI';document.querySelector('#whatIfFee').value='25';document.querySelector('#whatIfCost').value='0';document.querySelector('#whatIfRate').value='80';document.querySelector('#whatIfDeadline').value='SAFE';document.querySelector('#whatIfEvidence').value='TWO_VERIFIED';document.querySelector('#runWhatIf').click()})()`);
  await waitDom(`document.querySelector('#whatIfResult').textContent.includes('OFFLINE_SYNTHETIC_WHAT_IF')`, 'WHAT_IF_BASELINE_DID_NOT_RENDER');
  const whatIfBase = await evaluate("document.querySelector('#whatIfResult').textContent");
  await evaluate(`(()=>{document.querySelector('#whatIfStage').value='CHARGEBACK';document.querySelector('#whatIfFee').value='25';document.querySelector('#whatIfCost').value='30';document.querySelector('#whatIfRate').value='40';document.querySelector('#whatIfDeadline').value='UNKNOWN';document.querySelector('#whatIfEvidence').value='CONTRADICTORY';document.querySelector('#runWhatIf').click()})()`);
  await waitDom(`document.querySelector('#whatIfResult').textContent.includes('CONFLICTING_VERIFIED_EVIDENCE')`, 'WHAT_IF_RISK_REPLAN_DID_NOT_RENDER');
  const whatIfAfter = await evaluate("document.querySelector('#whatIfResult').textContent");
  if (!whatIfBase.includes('CHALLENGE') || !whatIfBase.includes('71.00 USD') || !whatIfAfter.includes('NO ACTION') ||
      !whatIfAfter.includes('CONFLICTING_VERIFIED_EVIDENCE') || !whatIfAfter.includes('NOT_EXECUTED')) throw new Error('WHAT_IF_POLICY_REPLAN_ASSERTION_FAILED');
  checks.push({ step: 'what-if-stage-fee-deadline-risk-replan-without-case-write', passed: true,
    basePreview: whatIfBase, constrainedPreview: whatIfAfter, savedFeeUnchanged: await evaluate("document.querySelector('#fee').value==='25.00'") });
  await screenshotElement('#economicsPanel', '08-what-if-replan.png');

  await evaluate(`(()=>{URL.createObjectURL=(blob)=>{window.__ftPacketBlob=blob;return 'blob:captured-packet'};HTMLAnchorElement.prototype.click=function(){window.__ftPacketName=this.download}})()`);
  const highValue = await evaluate(`(()=>{const c=document.querySelector('#cases article[data-case-id="kit04-high-value-fraud"]');return {action:c?.dataset.action,buttons:[...(c?.querySelectorAll('button')||[])].map(b=>b.textContent.trim())}})()`);
  if (highValue.action !== 'CHALLENGE' || !highValue.buttons.includes('Approve recommendation')) throw new Error('CHALLENGE_APPROVAL_CONTROL_MISSING');
  await evaluate(`(()=>{const c=document.querySelector('#cases article[data-case-id="kit04-high-value-fraud"]');[...c.querySelectorAll('button')].find(b=>b.textContent.trim()==='Approve recommendation').click()})()`);
  await waitDom(`document.querySelector('#status').textContent.includes('Local review decision recorded')`, 'LOCAL_CHALLENGE_APPROVAL_FAILED');
  await waitDom(`document.querySelector('#cases article[data-case-id="kit04-high-value-fraud"] button')?.textContent.includes('Prepare approved challenge packet')`, 'CHALLENGE_PACKET_CONTROL_MISSING');
  await evaluate(`(()=>{const c=document.querySelector('#cases article[data-case-id="kit04-high-value-fraud"]');[...c.querySelectorAll('button')].find(b=>b.textContent.includes('Prepare approved challenge packet')).click()})()`);
  await waitDom(`document.querySelector('#status').textContent.includes('NOT_SUBMITTED')`, 'CHALLENGE_PACKET_NOT_PREPARED');
  const packetCheck = await evaluate(`(async()=>{const p=JSON.parse(await window.__ftPacketBlob.text());return {label:p.label,state:p.submission?.state,providerAction:p.submission?.providerAction,revision:p.revision,approvalRevision:p.localApproval?.revision,approvalSnapshot:p.localApproval?.snapshotFingerprint,packetSnapshot:p.snapshotFingerprint,evidence:p.evidence?.length,filename:window.__ftPacketName}})()`);
  if (packetCheck.label !== 'OFFLINE_SYNTHETIC_PREVIEW' || packetCheck.state !== 'NOT_SUBMITTED' || packetCheck.providerAction !== 'NOT_EXECUTED' ||
      packetCheck.revision !== packetCheck.approvalRevision || packetCheck.approvalSnapshot !== packetCheck.packetSnapshot || packetCheck.evidence !== 2 ||
      packetCheck.filename !== 'fair-trial-challenge-packet-not-submitted.json') throw new Error('CHALLENGE_PACKET_BOUNDARY_ASSERTION_FAILED');
  checks.push({ step: 'approved-snapshot-bound-challenge-packet-remains-not-submitted', passed: true, ...packetCheck });
  await screenshotElement('#cases article[data-case-id="kit04-high-value-fraud"]', '09-challenge-packet-not-submitted.png');

  await evaluate(`document.querySelector('#status').textContent=''; document.querySelector('#proofReset').click()`);
  let reset;
  try { reset = await waitFor(async () => evaluate(`document.querySelector('#status').textContent || null`), 'RESET_UI_STEP_NO_STATUS'); }
  catch (error) {
    const debug = await evaluate(`({href:location.href, connected:document.querySelector('#proofReset')?.isConnected, disabled:document.querySelector('#proofReset')?.disabled, handler:typeof document.querySelector('#proofReset')?.onclick, state:document.querySelector('#status')?.textContent, ready:document.readyState, cases:document.querySelectorAll('#cases article').length})`);
    throw new Error(`${error.message}:${JSON.stringify(debug)}`);
  }
  if (!reset.includes('OFFLINE_DEMO reset')) throw new Error(`RESET_UI_STEP_FAILED:${reset.slice(0, 240)}`);
  checks.push({ step: 'reset-synthetic-case', passed: true, uiState: reset });
  await screenshot('02-reset-case.png');

  const initialCertificate = await downloadCertificate('initial-decision-certificate.json', 'generate-download-initial-valid-certificate');
  const resetRevision = Number(reset.match(/→ (\d+)/)?.[1]);
  if (initialCertificate.revision !== resetRevision || initialCertificate.recommendation?.action !== 'CHALLENGE')
    throw new Error('INITIAL_CERTIFICATE_ASSERTION_FAILED');
  checks.push({ step: 'initial-certificate-baseline-matches-reset', passed: true,
    revision: initialCertificate.revision, snapshotFingerprint: initialCertificate.snapshotFingerprint });
  await screenshot('03-initial-valid-certificate.png');

  await clickAndWait('#proofConflict', `document.querySelector('#status').textContent.includes('CONFLICTING_VERIFIED_EVIDENCE')`, 'CONFLICT_UI_STEP_FAILED');
  const conflict = await evaluate(`document.querySelector('#status').textContent`);
  if (!conflict.includes('NO_ACTION') || !conflict.includes('old approval rejected')) throw new Error('FAIL_CLOSED_OR_STALE_APPROVAL_ASSERTION_FAILED');
  checks.push({ step: 'scoped-contradiction-and-stale-approval-rejection', passed: true, uiState: conflict });
  await screenshot('04-conflict-stale-approval.png');

  await clickAndWait('#proofResolve', `document.querySelector('#status').textContent.includes('OFFLINE_DEMO fixture correction')`, 'CORRECTION_UI_STEP_FAILED');
  const corrected = await evaluate(`(() => { const a=document.querySelector('#cases article[data-case-id="kit04-decision-proof"]'); return {revision:Number(a?.querySelector('.case-revision')?.textContent.match(/Revision (\\d+)/)?.[1]), recommendation:a?.innerText.match(/Recommendation: ([A-Z ]+)/)?.[1]?.trim().replaceAll(' ','_'), message:document.querySelector('#status').textContent}; })()`);
  if (!(corrected.revision > initial.revision) || corrected.recommendation !== 'CHALLENGE') throw new Error('CORRECTION_REVISION_ASSERTION_FAILED');
  const correctionFromRevision = Number(corrected.message.match(/revision (\d+) →/)?.[1]);
  checks.push({ step: 'local-fixture-correction-revision-fingerprint-change', passed: true, previousRevision: correctionFromRevision,
    revision: corrected.revision, recommendation: corrected.recommendation, uiState: corrected.message });
  await screenshot('05-corrected-case.png');

  const cert = await downloadCertificate('revised-decision-certificate.json', 'generate-download-revised-certificate');
  if (cert.revision !== corrected.revision || cert.recommendation?.action !== 'CHALLENGE' ||
      cert.snapshotFingerprint === initialCertificate.snapshotFingerprint) throw new Error('CERTIFICATE_REVISION_ASSERTION_FAILED');
  checks.push({ step: 'revision-and-fingerprint-changed', passed: true, initialRevision: initialCertificate.revision,
    revisedRevision: cert.revision, initialFingerprint: initialCertificate.snapshotFingerprint,
    revisedFingerprint: cert.snapshotFingerprint });
  await screenshot('06-revised-certificate.png');
  const cli = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', 'scripts/verify-decision-certificate.ts',
    path.join(evidenceDir, 'revised-decision-certificate.json')], { cwd: root, encoding: 'utf8', windowsHide: true });
  const cliOutput = `${cli.stdout}${cli.stderr}`.trim();
  if (cli.status !== 0 || !cliOutput.includes('"ok":true')) throw new Error('STANDALONE_CERTIFICATE_CLI_FAILED');
  checks.push({ step: 'standalone-cli-verifies-downloaded-certificate', passed: true, exitCode: cli.status, output: cliOutput });

  await clickAndWait('#proofTamper', `document.querySelector('#status').textContent.includes('Tampered certificate rejected')`, 'BROWSER_TAMPER_REJECTION_FAILED');
  const tamperUi = await evaluate(`document.querySelector('#status').textContent`);
  checks.push({ step: 'browser-tampered-certificate-rejected', passed: true, uiState: tamperUi });
  await screenshot('07-tampered-certificate-rejected.png');

  const tampered = structuredClone(cert);
  tampered.snapshot.amountMinor += 1;
  const tamperedPath = path.join(evidenceDir, 'tampered-decision-certificate.json');
  await writeFile(tamperedPath, JSON.stringify(tampered, null, 2) + '\n', 'utf8');
  const tamperedCli = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', 'scripts/verify-decision-certificate.ts',
    tamperedPath], { cwd: root, encoding: 'utf8', windowsHide: true });
  const tamperedOutput = `${tamperedCli.stdout}${tamperedCli.stderr}`.trim();
  if (tamperedCli.status === 0 || !tamperedOutput.includes('"ok":false')) throw new Error('TAMPERED_CERTIFICATE_CLI_ACCEPTED');
  checks.push({ step: 'standalone-cli-rejects-tampered-certificate', passed: true, exitCode: tamperedCli.status, output: tamperedOutput });
  const report = { schemaVersion: 'fair-trial-g2-004-browser-evidence/v1', status: 'PASS', createdAt: new Date().toISOString(),
    browser: { product: 'Microsoft Edge', version: version.Browser, headless: true,
      isolatedProfile: true, origin: observedOrigin, viewport: '1440x1200' },
    server: { providerMode: 'MOCK', bind: '127.0.0.1', ephemeralPort: true, separateTemporarySqliteDatabase: tempDbPathIsolated,
      providerMutationCount: 0, operatorTokenRecorded: false },
    checks, consoleErrors: errors.map((entry) => ({ ...entry, classification:
      entry.text.includes('401') ? 'unauthenticated-bootstrap-probe' : entry.text.includes('409') ? 'expected-stale-approval-rejection' :
      entry.text.includes('422') ? 'expected-tampered-certificate-rejection' : 'unclassified' })),
    screenshots: (await readdir(evidenceDir)).filter((name) => name.endsWith('.png')).sort(),
    certificateArtifacts: ['initial-decision-certificate.json', 'revised-decision-certificate.json', 'tampered-decision-certificate.json'],
    recording: { status: 'DEFERRED_FINAL_REMOTION' },
    limitation: 'Synthetic local workflow and certificate consistency only; no provider case, provider mutation, factual authenticity, external signing key, or recovery outcome is proved.' };
  await writeFile(path.join(evidenceDir, 'browser-acceptance.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify({ status: report.status, evidenceDir, checks: checks.length, consoleErrors: errors.length,
    certificateRevision: cert.revision, screenshotCount: report.screenshots.length }));
} catch (error) {
  const report = { schemaVersion: 'fair-trial-g2-004-browser-evidence/v1', status: 'PARTIAL', createdAt: new Date().toISOString(),
    checks, consoleErrors: errors, blocker: error instanceof Error ? error.message : 'BROWSER_ACCEPTANCE_FAILED',
    startupDiagnostics: startupDiagnostics.join('').slice(0, 1200), operatorTokenRecorded: false };
  await writeFile(path.join(evidenceDir, 'browser-acceptance.json'), JSON.stringify(report, null, 2) + '\n', 'utf8').catch(() => {});
  console.error(JSON.stringify({ status: report.status, evidenceDir, blocker: report.blocker, checks: checks.length }));
  process.exitCode = 1;
} finally {
  try { ws?.close(); } catch {}
  for (const child of [edge, server]) if (child && !child.killed) child.kill();
  await delay(500);
  await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
}
