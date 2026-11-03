import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { evaluateW4Preflight, type W4CaseIdentity, type W4EvidenceItem } from "./w4-preflight.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const normalizedPath = resolve(root, "submission/evidence/airwallex-rfi-021-normalized.json");
const snapshotPath = resolve(root, "submission/evidence/airwallex-rfi-023-provider-snapshot.json");
const casePath = resolve(root, "submission/evidence/airwallex-rfi-023-case.json");
const matrixPath = resolve(root, "submission/evidence/airwallex-rfi-023-evidence-matrix.json");
const executionReportPath = resolve(root, "submission/FT_AIRWALLEX_LIVE_SANDBOX_020.md");
const staticExportPath = resolve(root, "submission/evidence/airwallex-rfi-provider-case-026.html");
const decisionTracePath = resolve(root, "submission/evidence/airwallex-rfi-decision-trace-026.json");
const syntheticDifferentialPath = resolve(root, "submission/evidence/airwallex-rfi-synthetic-differential-026.json");

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined;
const html = (value: unknown): string => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const dateText = (value: unknown): string => typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : "NOT RECORDED";

interface ReviewModel {
  paymentFingerprint: string;
  disputeFingerprint: string;
  w1CreatedAt: string;
  w2VerifiedAt: string;
  w3ReadAt: string;
  reasonCode: string;
  evidenceItems: Array<{ id: string; classification: string; finding: string; source: string; limitation: string }>;
  decisionTrace: DecisionTrace;
}

export interface DecisionTrace {
  policy: "evaluateW4Preflight";
  policyVersion: "repository-source";
  decision: "HOLD · REQUEST_EVIDENCE · HUMAN_REVIEW";
  reasons: readonly string[];
  reasonSupport: readonly { code: string; explanation: string; source: string }[];
  evidence: readonly { classification: string; category: string; source: string; supportsResponse: boolean }[];
  providerAction: "NOT_EXECUTED";
  provenance: readonly { source: string; sha256: string }[];
  deterministicClock: string;
}

function digest(text: string): string { return createHash("sha256").update(text, "utf8").digest("hex"); }

const reasonSupport = (reasons: readonly string[]): DecisionTrace["reasonSupport"] => {
  const descriptions: Record<string, { explanation: string; source: string }> = {
    CASE_IDENTITY_INCOMPLETE_OR_INVALID: { explanation: "The response deadline is absent, so the case identity is incomplete.", source: "airwallex-rfi-023-case.json#/dispute/responseDeadline" },
    FRESH_PROVIDER_IDENTITY_READ_REQUIRED: { explanation: "No fresh provider detail read is available; the latest refresh stopped before GET.", source: "airwallex-rfi-023-provider-snapshot.json#/provenance" },
    VERIFIED_CARDHOLDER_AUTHORIZATION_EVIDENCE_REQUIRED: { explanation: "No verified cardholder authorization or authentication record is present.", source: "airwallex-rfi-023-evidence-matrix.json#/items/cardholder-authorization" },
    VERIFIED_TRANSACTION_DETAILS_REQUIRED: { explanation: "No admissible order-level transaction detail is present; payment success alone does not satisfy this requirement.", source: "airwallex-rfi-023-evidence-matrix.json#/items/transaction-fulfillment" },
    QUALIFYING_CUSTOMER_HISTORY_REQUIRED_FOR_4837: { explanation: "No verified qualifying prior-purchase history is available for reason code 4837.", source: "airwallex-rfi-023-evidence-matrix.json#/items/customer-history" },
    UNSUPPORTED_EVIDENCE_CLAIM_PRESENT: { explanation: "The assertion that payment success proves authorization has no supporting source and is rejected.", source: "airwallex-rfi-023-evidence-matrix.json#/items/authorization-inference" },
    SYNTHETIC_EVIDENCE_NOT_ADMISSIBLE: { explanation: "Offline fixture records are synthetic and cannot support a real provider case.", source: "OFFLINE_SYNTHETIC_DIFFERENTIAL_ONLY" },
    ACTION_SPECIFIC_OWNER_APPROVAL_REQUIRED: { explanation: "No action-specific W4 owner approval exists.", source: "W4 authorization state: NOT AUTHORIZED" },
  };
  return Object.freeze(reasons.map((code) => Object.freeze({ code,
    explanation: descriptions[code]?.explanation ?? "The policy gate blocked this action.",
    source: descriptions[code]?.source ?? "evaluateW4Preflight result",
  })));
};

function categoryFor(id: unknown): W4EvidenceItem["category"] {
  switch (id) {
    case "cardholder-authorization": return "CARDHOLDER_AUTHORIZATION";
    case "customer-history": return "CUSTOMER_HISTORY";
    case "transaction-fulfillment": return "FULFILLMENT";
    case "customer-communication": return "CUSTOMER_COMMUNICATION";
    case "provider-payment-status": return "TRANSACTION_DETAILS";
    default: return "OTHER";
  }
}

function makeDecisionTrace(args: {
  paymentFingerprint: string; disputeFingerprint: string; reasonCode: string; evidenceItems: ReviewModel["evidenceItems"];
  normalizedRetrievedAt: string; hashes: Record<string, string>;
}): DecisionTrace {
  const clock = Date.parse(args.normalizedRetrievedAt);
  const evidence: W4EvidenceItem[] = args.evidenceItems.map((item) => {
    const category = categoryFor(item.id);
    return {
      classification: item.classification as W4EvidenceItem["classification"], category,
    sourceReference: item.source, supportsResponse: item.classification === "UNSUPPORTED", contradicted: false,
    };
  });
  const expectedIdentity: W4CaseIdentity = {
    paymentIntentFingerprint: args.paymentFingerprint, disputeFingerprint: args.disputeFingerprint,
    stage: "RFI", status: "REQUIRES_RESPONSE", reasonCode: args.reasonCode, amountMinor: 100,
    currency: "USD", responseDeadline: "",
  };
  const result = evaluateW4Preflight({
    expectedIdentity, evidence, requestedAction: "CHALLENGE", alreadySubmitted: false,
    ambiguousPriorSubmission: false, durableDispatchState: "NONE", now: Number.isFinite(clock) ? clock : Number.NaN,
  });
  return Object.freeze({
    policy: "evaluateW4Preflight", policyVersion: "repository-source",
    decision: "HOLD · REQUEST_EVIDENCE · HUMAN_REVIEW", reasons: result.reasons, reasonSupport: reasonSupport(result.reasons),
    evidence: Object.freeze(evidence.map((item) => Object.freeze({ classification: item.classification, category: item.category,
      source: item.sourceReference, supportsResponse: item.supportsResponse }))),
    providerAction: result.providerAction,
    provenance: Object.freeze(Object.entries(args.hashes).map(([source, sha256]) => Object.freeze({ source, sha256 }))),
    deterministicClock: args.normalizedRetrievedAt,
  });
}

export function createSyntheticDifferential(trace: DecisionTrace) {
  const syntheticEvidence: W4EvidenceItem[] = ["CARDHOLDER_AUTHORIZATION", "TRANSACTION_DETAILS", "CUSTOMER_HISTORY"].map((category) => ({
    classification: "SYNTHETIC", category: category as W4EvidenceItem["category"],
    sourceReference: `offline-fixture:synthetic-${category.toLowerCase()}`, supportsResponse: true, contradicted: false,
  }));
  const result = evaluateW4Preflight({
    expectedIdentity: { paymentIntentFingerprint: "5739cecdeb96b009", disputeFingerprint: "a5507580bf710c5e", stage: "RFI",
      status: "REQUIRES_RESPONSE", reasonCode: "4837", amountMinor: 100, currency: "USD", responseDeadline: "" },
    evidence: [...trace.evidence.map((item): W4EvidenceItem => ({
      classification: item.classification as W4EvidenceItem["classification"], category: item.category as W4EvidenceItem["category"],
      sourceReference: item.source, supportsResponse: item.supportsResponse, contradicted: false,
    })), ...syntheticEvidence],
    requestedAction: "CHALLENGE", alreadySubmitted: false, ambiguousPriorSubmission: false,
    durableDispatchState: "NONE", now: Date.parse(trace.deterministicClock),
  });
  return Object.freeze({
    label: "OFFLINE_SYNTHETIC_DIFFERENTIAL_ONLY",
    isolatedFromProviderCase: true,
    syntheticRecords: syntheticEvidence.map((item) => ({ classification: item.classification, category: item.category, source: item.sourceReference })),
    baselineReasons: trace.reasons,
    reasonsWithSyntheticRecords: result.reasons,
    newlyAddedReasons: result.reasons.filter((reason) => !trace.reasons.includes(reason)),
    removedReasons: trace.reasons.filter((reason) => !result.reasons.includes(reason)),
    providerAction: result.providerAction,
    note: "Synthetic inputs remain isolated and inadmissible; they cannot change the real provider-backed case or execute a provider action.",
  });
}

export async function loadProviderCaseReview(): Promise<ReviewModel> {
  const [normalizedRaw, snapshotRaw, caseRaw, matrixRaw, report] = await Promise.all([
    readFile(normalizedPath, "utf8"), readFile(snapshotPath, "utf8"), readFile(casePath, "utf8"), readFile(matrixPath, "utf8"), readFile(executionReportPath, "utf8"),
  ]);
  const normalized = record(JSON.parse(normalizedRaw));
  const lifecycle = record(normalized?.providerLifecycle);
  const facts = record(normalized?.normalized);
  const snapshot = record(JSON.parse(snapshotRaw));
  const identity = record(snapshot?.identity);
  const dispute = record(snapshot?.providerDispute);
  const provenance = record(snapshot?.provenance);
  const caseRecord = record(JSON.parse(caseRaw));
  const payment = record(caseRecord?.payment);
  const disputeCase = record(caseRecord?.dispute);
  const providerProvenance = record(caseRecord?.providerProvenance);
  const matrix = record(JSON.parse(matrixRaw));
  const items = Array.isArray(matrix?.items) ? matrix.items.map(record) : [];
  const w1Match = report.match(/W1 created at `([^`]+)`/);
  const w2Match = report.match(/HPP recorded final status verification at `([^`]+)`/);
  const paymentFingerprint = identity?.paymentIntentFingerprint;
  const disputeFingerprint = identity?.disputeFingerprint;

  if (normalized?.label !== "AIRWALLEX_SANDBOX_READ_ONLY_NORMALIZATION" || normalized?.mode !== "LIVE_READONLY" ||
      facts?.origin !== "AIRWALLEX" || facts?.stage !== "RFI" || facts?.status !== "REQUIRES_RESPONSE" || facts?.amountMinor !== 100 ||
      facts?.currency !== "USD" || facts?.reasonCode !== "4837" || facts?.evidenceReferenceCount !== 0 ||
      lifecycle?.paymentIntentFreshStatus !== "SUCCEEDED" || lifecycle?.paymentIntentFreshGetHttpStatus !== 200 ||
      lifecycle?.createPostCount !== 1 || lifecycle?.createHttpStatus !== 201 || lifecycle?.disputeReadbackHttpStatus !== 200 || lifecycle?.w4Actions !== 0 ||
      snapshot?.caseClassification !== "PROVIDER_EXECUTED_SANDBOX_SIMULATION" || snapshot?.readStatus !== "BLOCKED" ||
      snapshot?.retrievedAt !== null || dispute?.dueAt !== null || provenance?.getCount !== 0 || provenance?.mutationCount !== 0 ||
      identity?.paymentIntentLinked !== true || identity?.exactHistoricalIdentityMatch !== true ||
      typeof paymentFingerprint !== "string" || !/^[a-f0-9]{16}$/.test(paymentFingerprint) ||
      typeof disputeFingerprint !== "string" || !/^[a-f0-9]{16}$/.test(disputeFingerprint) ||
      payment?.status !== "SUCCEEDED" || payment?.amountMinor !== 100 || disputeCase?.actionable !== false ||
      normalized?.paymentIntentFingerprint !== paymentFingerprint || normalized?.disputeFingerprint !== disputeFingerprint ||
      caseRecord?.providerProvenance && (providerProvenance?.paymentIntentFingerprint !== paymentFingerprint || providerProvenance?.disputeFingerprint !== disputeFingerprint) ||
      providerProvenance?.rawProviderIdentifiersIncluded !== false || providerProvenance?.rawProviderPayloadIncluded !== false ||
      !w1Match || !w2Match || caseRecord?.caseClassification !== "PROVIDER_EXECUTED_SANDBOX_SIMULATION") {
    throw new Error("SANITIZED_PROVIDER_CASE_RECEIPTS_NOT_ACCEPTED");
  }
  const validItems = items.filter((item): item is RecordValue => !!item &&
    ["VERIFIED", "SYNTHETIC", "MISSING", "UNSUPPORTED"].includes(String(item.classification)) &&
    typeof item.id === "string" && typeof item.finding === "string" && typeof item.source === "string" && typeof item.limitation === "string");
  if (validItems.length < 8 || dispute?.reasonCode !== "4837" || dispute?.evidenceReferenceCount !== 0) {
    throw new Error("SANITIZED_PROVIDER_EVIDENCE_MATRIX_NOT_ACCEPTED");
  }
  const evidenceItems = validItems.map((item) => ({ id: String(item.id), classification: String(item.classification), finding: String(item.finding), source: String(item.source), limitation: String(item.limitation) }));
  const evidenceHashes = {
    "airwallex-rfi-021-normalized.json": digest(normalizedRaw),
    "airwallex-rfi-023-provider-snapshot.json": digest(snapshotRaw),
    "airwallex-rfi-023-case.json": digest(await readFile(casePath, "utf8")),
    "airwallex-rfi-023-evidence-matrix.json": digest(matrixRaw),
  };
  const w3ReadAt = dateText(normalized?.retrievedAt);
  const decisionTrace = makeDecisionTrace({ paymentFingerprint, disputeFingerprint, reasonCode: "4837", evidenceItems,
    normalizedRetrievedAt: w3ReadAt, hashes: evidenceHashes });
  return {
    paymentFingerprint,
    disputeFingerprint,
    w1CreatedAt: w1Match[1]!,
    w2VerifiedAt: w2Match[1]!,
    w3ReadAt,
    reasonCode: "4837",
    evidenceItems,
    decisionTrace,
  };
}

export function renderProviderCaseReview(model: ReviewModel): string {
  const evidenceRows = model.evidenceItems.map((item) => `<article class="evidence-row">
    <div class="evidence-class ${html(item.classification.toLowerCase())}">${html(item.classification)}</div>
    <div><h3>${html(item.finding)}</h3><p class="source">Source · ${html(item.source)}</p><p class="limitation">${html(item.limitation)}</p></div>
  </article>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; connect-src 'none'; img-src 'none'; font-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none';">
  <title>Fair Trial · Provider case review</title>
  <style>
    :root{color-scheme:light;--ink:#172334;--muted:#647184;--paper:#f4f6f8;--white:#fff;--line:#dce2e8;--blue:#2862e8;--blue-soft:#eaf0ff;--amber:#9c6720;--amber-soft:#fbf2df;--red:#9e4141;--red-soft:#faeaea;--green:#246e58;--green-soft:#e5f3ed;--shadow:0 22px 65px #17233412}
    *{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font-family:"Segoe UI",Arial,sans-serif;font-size:15px;line-height:1.55}a{color:inherit}.shell{max-width:1220px;margin:auto;padding:30px 38px 64px}
    .topbar{display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #cad2dd;padding:0 0 18px;margin-bottom:30px}.brand{display:flex;align-items:center;gap:12px;font-weight:750;letter-spacing:-.03em;font-size:19px}.mark{width:34px;height:34px;border-radius:10px;background:var(--ink);color:#fff;display:grid;place-items:center;font:700 13px Consolas,monospace}.top-note{font:600 11px Consolas,monospace;letter-spacing:.1em;color:var(--muted)}
    .case-head{display:flex;align-items:flex-end;justify-content:space-between;gap:28px;margin:18px 0 24px}.eyebrow,.micro{font:700 11px Consolas,monospace;letter-spacing:.12em;text-transform:uppercase;color:var(--muted)}h1{font-size:clamp(30px,4vw,48px);line-height:1.06;letter-spacing:-.055em;margin:8px 0 10px}.lede{max-width:690px;margin:0;color:#566376}.verdict{min-width:245px;padding:16px 18px;border-left:3px solid var(--amber);background:var(--amber-soft)}.verdict strong{display:block;font-size:17px;letter-spacing:.015em}.verdict small{color:#6b5838}
    .sandbox-banner{display:flex;align-items:center;gap:12px;padding:12px 16px;background:#18283b;color:#fff;border-radius:9px;margin:24px 0 18px}.sandbox-banner b{font:700 11px Consolas,monospace;letter-spacing:.08em}.sandbox-banner span{color:#c7d0dc;font-size:13px}.dot{width:8px;height:8px;border-radius:50%;background:#e1a949;box-shadow:0 0 0 4px #e1a94925}
    .timeline{display:grid;grid-template-columns:repeat(3,1fr);background:var(--white);border:1px solid var(--line);border-radius:12px;box-shadow:var(--shadow);overflow:hidden}.step{padding:22px 24px 20px;position:relative;min-height:183px}.step+.step{border-left:1px solid var(--line)}.step-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:18px}.step-tag{font:700 12px Consolas,monospace;color:var(--blue);letter-spacing:.08em}.step-state{font:700 10px Consolas,monospace;color:var(--green);background:var(--green-soft);padding:5px 8px;border-radius:99px}.step h2{font-size:18px;margin:0 0 6px;letter-spacing:-.025em}.step p{font-size:13px;color:var(--muted);margin:0}.stamp{font:11px Consolas,monospace;color:#546174;margin-top:14px}.fp{font:12px Consolas,monospace;letter-spacing:.035em;color:#243550}
    .freshness{margin-top:18px;display:grid;grid-template-columns:1fr 1fr;gap:14px}.fresh-box{background:var(--amber-soft);border:1px solid #ead9b3;border-radius:10px;padding:16px 18px}.fresh-box.deadline{background:#f7f0ef;border-color:#ead2ce}.fresh-box .micro{color:#78592c}.fresh-box.deadline .micro{color:var(--red)}.fresh-value{font-size:19px;font-weight:700;margin:6px 0 1px}.fresh-box p{font-size:12px;color:#695c48;margin:0}.fresh-box.deadline p{color:#765d5b}
    .section-head{display:flex;align-items:end;justify-content:space-between;margin:38px 0 14px;gap:20px}.section-head h2{font-size:23px;letter-spacing:-.04em;margin:0}.section-head p{color:var(--muted);font-size:12px;margin:0}.evidence-card,.decision-card,.audit-card{background:var(--white);border:1px solid var(--line);border-radius:12px;box-shadow:0 8px 24px #17233408}.evidence-card{padding:2px 20px}.evidence-row{display:grid;grid-template-columns:122px 1fr;gap:14px;padding:15px 0;border-bottom:1px solid #edf0f3}.evidence-row:last-child{border:0}.evidence-class{width:max-content;align-self:start;font:700 10px Consolas,monospace;letter-spacing:.06em;padding:5px 8px;border-radius:5px;color:#334156;background:#edf0f4}.evidence-class.missing{background:var(--amber-soft);color:var(--amber)}.evidence-class.unsupported{background:var(--red-soft);color:var(--red)}.evidence-class.verified{background:var(--green-soft);color:var(--green)}.evidence-class.synthetic{background:var(--blue-soft);color:#365da9}.evidence-row h3{font-size:14px;margin:0 0 3px}.evidence-row p{margin:0;font-size:12px;color:var(--muted)}.evidence-row .source{font:11px Consolas,monospace;overflow-wrap:anywhere;margin-bottom:4px}
    .bottom-grid{display:grid;grid-template-columns:1.15fr .85fr;gap:16px;margin-top:16px}.decision-card{padding:22px 24px;border-top:4px solid var(--amber);background:linear-gradient(118deg,#fff 58%,#fbf2df 160%)}.decision-card h2{font-size:clamp(21px,2.2vw,28px);line-height:1.2;margin:8px 0 8px;letter-spacing:-.035em}.decision-card>p{color:var(--muted);font-size:14px;margin:0 0 17px}.blocked-list{padding:0;margin:0;list-style:none;display:grid;gap:11px}.blocked-list li{display:flex;gap:9px;font-size:14px;line-height:1.45}.blocked-list li:before{content:"×";font:700 14px Consolas,monospace;color:var(--red);flex:none}.blocked-list li b{font-weight:650}.reason-source{display:block;margin-top:3px;color:var(--muted);font:11px Consolas,monospace;overflow-wrap:anywhere}.reason-source code{white-space:normal}.action-row{display:flex;align-items:center;gap:12px;margin-top:20px}.disabled-action{border:0;border-radius:7px;background:#e8ebef;color:#687486;padding:11px 15px;font:700 12px "Segoe UI",sans-serif;cursor:not-allowed}.action-row span{font:10px Consolas,monospace;letter-spacing:.08em;color:var(--red)}details{margin-top:15px;border-top:1px solid var(--line);padding-top:12px}summary{cursor:pointer;font-weight:650;font-size:14px}summary:focus-visible{outline:3px solid #2862e866;outline-offset:3px}.audit-card{padding:21px 23px}.audit-card h2{font-size:18px;margin:7px 0 14px}.audit-list{list-style:none;padding:0;margin:0;display:grid;gap:14px}.audit-list li{display:grid;grid-template-columns:56px 1fr;gap:8px;font-size:13px;color:var(--muted)}.audit-list b{color:var(--ink);font:700 11px Consolas,monospace}.audit-list code{font:11px Consolas,monospace;color:#334156}.audit-foot{margin-top:18px;padding-top:12px;border-top:1px solid var(--line);font:10px Consolas,monospace;letter-spacing:.06em;color:var(--muted)}
    .policy-card{margin-top:16px;background:#172334;color:#edf2f8;border-radius:12px;padding:20px 24px}.policy-card h2{margin:5px 0 8px;font-size:18px}.policy-card p,.policy-card li{color:#c4cedb;font-size:13px}.policy-card code{color:#fff;font:12px Consolas,monospace;overflow-wrap:anywhere}.policy-grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}.policy-card ul{padding-left:20px;margin:8px 0}.policy-note{border-top:1px solid #ffffff24;padding-top:12px;margin-top:14px}
    .footer{margin-top:26px;border-top:1px solid #cad2dd;padding-top:14px;color:var(--muted);font-size:11px;display:flex;justify-content:space-between;gap:18px}.footer strong{color:var(--ink)}
    button:focus-visible,summary:focus-visible{outline:3px solid #2862e8;outline-offset:3px}@media(max-width:800px){.shell{padding:20px 16px 44px}.case-head{align-items:stretch;flex-direction:column}.verdict{min-width:0}.timeline{grid-template-columns:1fr}.step{min-height:0;padding:19px}.step+.step{border-left:0;border-top:1px solid var(--line)}.freshness,.bottom-grid,.policy-grid{grid-template-columns:1fr}.section-head{align-items:start;flex-direction:column}.evidence-row{grid-template-columns:1fr;gap:8px}.footer{flex-direction:column}.step-state{font-size:10px}.top-note{font-size:9px;letter-spacing:.04em}.policy-card{padding:18px}}@media(max-width:380px){.shell{padding-inline:12px}.step-top{align-items:flex-start;gap:8px;flex-direction:column}.fp{overflow-wrap:anywhere}}@media(prefers-reduced-motion:reduce){*,*:before,*:after{scroll-behavior:auto!important}}
  </style></head><body><main class="shell">
    <header class="topbar"><div class="brand"><span class="mark">FT</span><span>Fair Trial</span></div><span class="top-note">CASE REVIEW · READ ONLY</span></header>
    <section class="case-head"><div><div class="eyebrow">Provider-backed case · Airwallex Sandbox</div><h1>Payment completed.<br>Dispute evidence is missing.</h1><p class="lede">A traceable, synthetic USD 1.00 sandbox lifecycle. The payment state is verified; cardholder authorization and a response deadline are not. This record is a Sandbox simulation, not a real Mastercard issuer dispute.</p></div><aside class="verdict"><div class="micro">Decision state</div><strong>HOLD · REQUEST EVIDENCE</strong><small>Human review required before any later action.</small></aside></section>
    <div class="sandbox-banner"><i class="dot"></i><b>PROVIDER_EXECUTED_SANDBOX_SIMULATION</b><span>Read-only saved receipts · no live connection</span></div>
    <section class="timeline" aria-label="Verified provider lifecycle">
      <article class="step"><div class="step-top"><span class="step-tag">W1 · CREATE + READ-BACK</span><span class="step-state">HISTORICAL VERIFIED</span></div><h2>PaymentIntent · USD 1.00</h2><p>Sandbox create returned 201; exact identity read-back returned 200.</p><div class="stamp">${html(model.w1CreatedAt)}</div><div class="fp">FP · ${html(model.paymentFingerprint)}</div></article>
      <article class="step"><div class="step-top"><span class="step-tag">W2 · CHECKOUT</span><span class="step-state">HISTORICAL · SUCCEEDED</span></div><h2>Payment status confirmed</h2><p>Historical server-side provider retrieval; browser return alone did not establish success.</p><div class="stamp">${html(model.w2VerifiedAt)}</div><div class="fp">Same PaymentIntent fingerprint</div></article>
      <article class="step"><div class="step-top"><span class="step-tag">W3 · SIMULATION</span><span class="step-state">HISTORICAL VERIFIED</span></div><h2>RFI · REQUIRES_RESPONSE</h2><p>Sandbox simulated RFI · Mastercard reason ${html(model.reasonCode)} · USD 1.00.</p><div class="stamp">${html(model.w3ReadAt)} · historical provider read</div><div class="fp">FP · ${html(model.disputeFingerprint)}</div></article>
    </section>
    <section class="freshness" aria-label="Current status and deadline"><article class="fresh-box"><div class="micro">Provider freshness</div><div class="fresh-value">NOT REFRESHED</div><p>The 024 auth attempt ended with a transport error before any HTTP response; dispute GET count was 0. The values above are historical.</p></article><article class="fresh-box deadline"><div class="micro">Response deadline</div><div class="fresh-value">UNKNOWN</div><p>No current provider deadline is available. Treat this as a hard stop for response actions.</p></article></section>
    <section><div class="section-head"><h2>Evidence ledger</h2><p>Receipt-backed facts are separate from absent records and rejected inferences.</p></div><div class="evidence-card">${evidenceRows}</div></section>
    <section class="bottom-grid"><article class="decision-card"><div class="micro">Explainable recommendation · deterministic policy</div><h2>HOLD · REQUEST_EVIDENCE · HUMAN_REVIEW</h2><p>Payment success is not proof of cardholder authorization. The actual W4 preflight logic evaluates the saved case and returns the blocking reasons below. No LLM decision was run.</p><ul class="blocked-list">${model.decisionTrace.reasonSupport.map((item) => `<li><span><b>${html(item.explanation)}</b><small class="reason-source">${html(item.source)} · <code>${html(item.code)}</code></small></span></li>`).join("")}</ul><div class="action-row"><button class="disabled-action" type="button" disabled aria-disabled="true">Challenge · disabled</button><span>W4 · NOT_EXECUTED</span></div><details><summary>Why is the challenge blocked?</summary><p>The deadline is unknown, provider status is not fresh, required admissible evidence is missing, and action-specific approval is absent. This page has no provider-action API.</p></details></article>
      <aside class="audit-card"><div class="micro">Source trail</div><h2>What this view is built from</h2><ol class="audit-list"><li><b>W1 / W2</b><span>Historical execution report and local journals; statuses are confirmed by saved provider read-back.</span></li><li><b>W3</b><span><code>airwallex-rfi-021-normalized.json</code> · provider list/read-back receipt.</span></li><li><b>Freshness</b><span><code>airwallex-rfi-023-provider-snapshot.json</code> · blocked before detail GET; the later 024 auth attempt also stopped before GET.</span></li><li><b>Decision</b><span><code>airwallex-rfi-023-evidence-matrix.json</code> · missing evidence remains missing.</span></li><li><b>Action gate</b><span>W4 preflight remains local and disabled; no provider action was executed.</span></li></ol><div class="audit-foot">SANITIZED FINGERPRINTS ONLY · NO RAW PROVIDER IDS · NO MUTATING ROUTES</div></aside></section>
    <section class="policy-card" aria-labelledby="policy-title"><div class="micro" style="color:#aebdd0">Auditable decision trace</div><h2 id="policy-title">Repository policy executed against the saved case</h2><div class="policy-grid"><div><p>Policy: <code>evaluateW4Preflight</code> · clock anchored to the historical normalized receipt · provider action: <code>NOT_EXECUTED</code>.</p><ul>${model.decisionTrace.evidence.map((item) => `<li>${html(item.classification)} · ${html(item.category)} · supports response: ${item.supportsResponse ? "yes" : "no"}</li>`).join("")}</ul></div><div><p>Blocking reasons are emitted by the same pure policy gate used by W4 preflight. Input receipt digests:</p><ul>${model.decisionTrace.provenance.map((item) => `<li><code>${html(item.source)} · SHA-256 ${html(item.sha256)}</code></li>`).join("")}</ul></div></div><p class="policy-note">Offline synthetic differential is separate from this provider-backed case. Synthetic evidence is never treated as VERIFIED or submitted.</p></section>
    <footer class="footer"><span><strong>Evidence boundary:</strong> USD 1.00 is synthetic Sandbox data. No genuine card-network dispute or successful W4 outcome is claimed.</span><span>LOCAL READ-ONLY REVIEW</span></footer>
  </main></body></html>`;
}

export function providerCaseResponse(method: string, requestUrl: string | undefined, page: string) {
  const securityHeaders = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; connect-src 'none'; img-src 'none'; font-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
  };
  if (method === "GET" && requestUrl === "/") return { status: 200, headers: { ...securityHeaders, "Content-Type": "text/html; charset=utf-8" }, body: page };
  if (method !== "GET") return { status: 405, headers: { ...securityHeaders, "Content-Type": "text/plain; charset=utf-8", Allow: "GET" }, body: "Method not allowed" };
  return { status: 404, headers: { ...securityHeaders, "Content-Type": "text/plain; charset=utf-8" }, body: "Not found" };
}

export async function createProviderCaseReviewServer() {
  const model = await loadProviderCaseReview();
  const page = renderProviderCaseReview(model);
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const response = providerCaseResponse(req.method ?? "", req.url, page);
    res.writeHead(response.status, response.headers); res.end(response.body);
  });
}

export async function exportProviderCaseReview(path = staticExportPath) {
  const page = renderProviderCaseReview(await loadProviderCaseReview());
  await writeFile(path, page, { encoding: "utf8", flag: "w", mode: 0o600 });
  return path;
}

export async function exportDecisionArtifacts() {
  const model = await loadProviderCaseReview();
  const differential = createSyntheticDifferential(model.decisionTrace);
  await writeFile(decisionTracePath, `${JSON.stringify(model.decisionTrace, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await writeFile(syntheticDifferentialPath, `${JSON.stringify(differential, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return { tracePath: decisionTracePath, differentialPath: syntheticDifferentialPath, trace: model.decisionTrace, differential };
}

async function main() {
  if (process.argv[2] === "--export-static") {
    const path = await exportProviderCaseReview();
    console.log(`Sanitized provider case review exported: ${path.replace(root + "\\", "")}`);
    return;
  }
  if (process.argv[2] === "--export-decision") {
    const result = await exportDecisionArtifacts();
    console.log(JSON.stringify({ providerAction: result.trace.providerAction, reasonCount: result.trace.reasons.length,
      syntheticNewReasons: result.differential.newlyAddedReasons.length }));
    return;
  }
  if (process.argv.length > 2) throw new Error("PROVIDER_CASE_REVIEW_ARGUMENT_INVALID");
  const port = Number(process.env.FT_PROVIDER_CASE_PORT ?? "4381");
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("FT_PROVIDER_CASE_PORT_INVALID");
  const server = await createProviderCaseReviewServer();
  server.listen(port, "127.0.0.1", () => console.log(`Read-only provider case review: http://127.0.0.1:${port}/`));
  const close = () => server.close(() => process.exit(0));
  process.once("SIGINT", close); process.once("SIGTERM", close);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
