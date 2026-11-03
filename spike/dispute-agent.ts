import { createHash } from "node:crypto";
import { createScenarioEvidence, DEFAULT_DISPUTE_ECONOMICS, fingerprintDisputeDecision, recommendDisputeAction, validateDisputeSnapshot,
  type DisputeRecommendation, type DisputeSnapshot } from "./dispute-engine.ts";
import { createKit04ReviewCases } from "./dispute-workflow.ts";
import { createDecisionCertificate, verifyDecisionCertificate } from "./decision-certificate.ts";
import { loadProviderCaseReview } from "./provider-case-review.ts";
import { ingestOfflineTextEvidence } from "./dispute-evidence.ts";
import { enrichModelProposals, explainProposalGrounding, MODEL_OUTPUT_CONTRACT_VERSION, parseModelProposalResponse,
  type EvidenceProposalProvider } from "./evidence-proposals.ts";

export type AgentScenario = "provider-rfi" | "synthetic-high-fraud" | "synthetic-low-value" | "synthetic-credit-not-processed";
export type AgentToolName = "fetch_dispute_context" | "inspect_evidence" | "calculate_economics" |
  "acquire_synthetic_evidence" | "investigate_synthetic_text_with_model" | "generate_decision_certificate" | "request_missing_information" | "request_human_review";
export type AgentState = "OBSERVE" | "PLAN" | "TOOL_USE" | "VALIDATE" | "REPLAN" | "RECOMMEND" | "ESCALATE";
export interface AgentToolInputMap {
  fetch_dispute_context: { scenario: AgentScenario; source: "authorized_saved_snapshot" | "repository_synthetic_fixture" };
  inspect_evidence: { caseId: string; revision: number; source: "saved_evidence_matrix" | "synthetic_fixture" };
  calculate_economics: { caseId: string; revision: number; policy: "evaluateW4Preflight" | "recommendDisputeAction";
    requestedAction?: "CHALLENGE"; evidenceCount?: number };
  acquire_synthetic_evidence: { caseId: string; revision: number; requested: "second_independent_fraud_signal" };
  investigate_synthetic_text_with_model: { caseId: string; revision: number; source: "synthetic_unstructured_fixture"; sourceSha256: string };
  generate_decision_certificate: { caseId: string; revision: number; purpose?: "pre-replan-baseline"; fingerprint?: string };
  request_missing_information: { caseId: string; revision: number; reasonCodes: string[] };
  request_human_review: { caseId: string; revision: number; reasonCodes: string[]; action?: string };
}

export interface AgentTraceEntry {
  sequence: number;
  state: AgentState;
  atUtc: string;
  tool?: AgentToolName;
  validatedInput?: Record<string, unknown>;
  output?: Record<string, unknown>;
  evidenceReferences?: string[];
  reasonCodes?: string[];
  transition?: string;
}
export interface AgentRunResult {
  schemaVersion: "fair-trial-agent-run/v1";
  controller: "BOUNDED_RULE_PLANNER";
  plannerLabel: "DETERMINISTIC_RULE_PLANNER";
  modelPlanning: "NOT_IMPLEMENTED";
  scenario: AgentScenario;
  dataLabel: "PROVIDER_BACKED_SAVED_RECEIPTS" | "OFFLINE_SYNTHETIC_FIXTURE";
  caseId: string;
  initial: { revision: number; snapshotFingerprint: string; action: string; reasonCodes: string[]; expectedRecoveryMinor: number | null; expectedNetValueMinor: number | null };
  final: { revision: number; snapshotFingerprint: string; action: string; reasonCodes: string[]; disputeFeeMinor: number | null; expectedRecoveryMinor: number | null; expectedNetValueMinor: number | null };
  replan: { occurred: boolean; cause: string | null; staleApprovalInvalidated: boolean; staleCertificateInvalidated: boolean };
  modelInvestigation: { status: "NOT_RUN" | "ACCEPTED" | "NO_FINDING" | "REJECTED" | "FAILED_CLOSED";
    modelIdentity: string | null; latencyMs: number | null; calls: number; acceptedFindings: number;
    rejectedFindings: Array<{ quote: string | null; reason: string }>; groundedEvidence: Array<{ sha256: string; startOffset: number; endOffset: number; quote: string }> };
  certificate: { digest: string; revision: number; snapshotFingerprint: string; verified: boolean } | null;
  approvalRequired: true;
  providerAction: "NOT_EXECUTED";
  trace: AgentTraceEntry[];
}

const MAX_TOOL_CALLS = 9;
const TOOL_TIMEOUT_MS = 2_000;
const MODEL_TOOL_TIMEOUT_MS = 180_000;
const MAX_RETRIES = 1;
const scenarios = new Set<AgentScenario>(["provider-rfi", "synthetic-high-fraud", "synthetic-low-value", "synthetic-credit-not-processed"]);
function sha256(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function validScenario(value: unknown): value is AgentScenario { return typeof value === "string" && scenarios.has(value as AgentScenario); }
export function assertModelFindingCurrent(input: { expectedRevision: number; currentRevision: number; expectedSourceSha256: string; sourceText: string }): void {
  if (input.expectedRevision !== input.currentRevision) throw new Error("CASE_REVISION_CHANGED_DURING_MODEL_RUN");
  if (!/^[a-f0-9]{64}$/.test(input.expectedSourceSha256) || sha256(input.sourceText) !== input.expectedSourceSha256)
    throw new Error("STALE_OR_INVALID_MODEL_EVIDENCE");
}
function validateToolInput<K extends AgentToolName>(name: K, input: AgentToolInputMap[K]): void {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("INVALID_AGENT_TOOL_INPUT");
  const values = input as Record<string, unknown>;
  const keys: Record<AgentToolName, readonly string[]> = {
    fetch_dispute_context: ["scenario", "source"], inspect_evidence: ["caseId", "revision", "source"],
    calculate_economics: ["caseId", "revision", "policy", "requestedAction", "evidenceCount"],
    acquire_synthetic_evidence: ["caseId", "revision", "requested"],
    investigate_synthetic_text_with_model: ["caseId", "revision", "source", "sourceSha256"],
    generate_decision_certificate: ["caseId", "revision", "purpose", "fingerprint"],
    request_missing_information: ["caseId", "revision", "reasonCodes"],
    request_human_review: ["caseId", "revision", "reasonCodes", "action"],
  };
  if (Object.keys(values).some((key) => !keys[name].includes(key)) ||
      ("caseId" in values && (typeof values.caseId !== "string" || values.caseId.length > 128)) ||
      ("revision" in values && (!Number.isSafeInteger(values.revision) || Number(values.revision) < 1)) ||
      ("reasonCodes" in values && (!Array.isArray(values.reasonCodes) || values.reasonCodes.some((code) => typeof code !== "string"))) ||
      (name === "fetch_dispute_context" && (!validScenario(values.scenario) ||
        !["authorized_saved_snapshot", "repository_synthetic_fixture"].includes(String(values.source))) ) ||
      (name === "inspect_evidence" && !["saved_evidence_matrix", "synthetic_fixture"].includes(String(values.source))) ||
      (name === "calculate_economics" && (!new Set(["evaluateW4Preflight", "recommendDisputeAction"]).has(String(values.policy)) ||
        (values.requestedAction !== undefined && values.requestedAction !== "CHALLENGE") ||
        (values.evidenceCount !== undefined && (!Number.isSafeInteger(values.evidenceCount) || Number(values.evidenceCount) < 0))) ) ||
      (name === "acquire_synthetic_evidence" && values.requested !== "second_independent_fraud_signal") ||
      (name === "investigate_synthetic_text_with_model" && (values.source !== "synthetic_unstructured_fixture" || typeof values.sourceSha256 !== "string" || !/^[a-f0-9]{64}$/.test(values.sourceSha256))) ||
      (name === "generate_decision_certificate" && values.purpose !== undefined && values.purpose !== "pre-replan-baseline") ||
      ("reasonCodes" in values && (values.reasonCodes as unknown[]).length > 32) ||
      ("action" in values && (typeof values.action !== "string" || values.action.length > 64)) ||
      ("fingerprint" in values && (typeof values.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(values.fingerprint))))
    throw new Error("INVALID_AGENT_TOOL_INPUT");
}
/** A local, bounded controller. It calls only these typed tools; it has no provider or model credentials. */
export async function runDisputeAgent(scenarioValue: unknown, options: { now?: () => number; timeoutMs?: number; maxToolCalls?: number;
  providerCaseLoader?: typeof loadProviderCaseReview; modelInvestigation?: "LOCAL_LLM"; modelProvider?: EvidenceProposalProvider;
  modelTimeoutMs?: number } = {}): Promise<AgentRunResult> {
  if (!validScenario(scenarioValue)) throw new Error("INVALID_AGENT_SCENARIO");
  const scenario = scenarioValue;
  if (options.modelInvestigation && scenario !== "synthetic-high-fraud") throw new Error("MODEL_INVESTIGATION_SYNTHETIC_FRAUD_ONLY");
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? TOOL_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > TOOL_TIMEOUT_MS) throw new Error("INVALID_AGENT_TIMEOUT");
  const modelTimeoutMs = options.modelTimeoutMs ?? MODEL_TOOL_TIMEOUT_MS;
  if (!Number.isSafeInteger(modelTimeoutMs) || modelTimeoutMs < 1 || modelTimeoutMs > MODEL_TOOL_TIMEOUT_MS) throw new Error("INVALID_MODEL_TOOL_TIMEOUT");
  const maxToolCalls = options.maxToolCalls ?? MAX_TOOL_CALLS;
  if (!Number.isSafeInteger(maxToolCalls) || maxToolCalls < 1 || maxToolCalls > MAX_TOOL_CALLS) throw new Error("INVALID_AGENT_TOOL_BUDGET");
  const trace: AgentTraceEntry[] = [];
  let calls = 0;
  const transition = (state: AgentState, note: string) => {
    trace.push({ sequence: trace.length + 1, state, atUtc: new Date(now()).toISOString(), transition: note });
  };
  const tool = async <K extends AgentToolName, T extends Record<string, unknown>>(name: K, input: AgentToolInputMap[K], work: () => Promise<T> | T,
    executionTimeoutMs = timeoutMs): Promise<T> => {
    if (++calls > maxToolCalls) throw new Error("AGENT_TOOL_BUDGET_EXHAUSTED");
    validateToolInput(name, input);
    trace.push({ sequence: trace.length + 1, state: "TOOL_USE", atUtc: new Date(now()).toISOString(), tool: name,
      validatedInput: structuredClone(input) as Record<string, unknown> });
    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([Promise.resolve().then(work), new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("AGENT_TOOL_TIMEOUT")), executionTimeoutMs);
        })]);
        trace[trace.length - 1]!.output = structuredClone(result);
        return result;
      } catch (error) {
        lastError = error;
        if (attempt === MAX_RETRIES || name !== "fetch_dispute_context") break;
      } finally { if (timer) clearTimeout(timer); }
    }
    trace[trace.length - 1]!.output = { error: lastError instanceof Error ? lastError.message : "AGENT_TOOL_FAILED" };
    throw lastError instanceof Error ? lastError : new Error("AGENT_TOOL_FAILED");
  };
  const validateStep = (note: string, snapshot?: DisputeSnapshot, revision?: number) => {
    if (snapshot && validateDisputeSnapshot(snapshot).length) throw new Error("AGENT_SNAPSHOT_VALIDATION_FAILED");
    if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1)) throw new Error("AGENT_REVISION_INVALID");
    trace.push({ sequence: trace.length + 1, state: "VALIDATE", atUtc: new Date(now()).toISOString(),
      output: { valid: true, revision: revision ?? null, note } });
  };
  transition("OBSERVE", "Read the requested saved case source; no network refresh.");

  let snapshot: DisputeSnapshot | undefined;
  let revision = 1;
  let providerResult: Awaited<ReturnType<typeof loadProviderCaseReview>> | undefined;
  const modelInvestigation: AgentRunResult["modelInvestigation"] = { status: options.modelInvestigation ? "FAILED_CLOSED" : "NOT_RUN",
    modelIdentity: null, latencyMs: null, calls: 0, acceptedFindings: 0, rejectedFindings: [], groundedEvidence: [] };
  if (options.modelInvestigation && (!options.modelProvider || options.modelProvider.mode !== "LOCAL_LLM")) throw new Error("LOCAL_MODEL_PROVIDER_REQUIRED");
  const context = await tool("fetch_dispute_context", { scenario, source: scenario === "provider-rfi" ? "authorized_saved_snapshot" : "repository_synthetic_fixture" }, async () => {
    if (scenario === "provider-rfi") {
      providerResult = await (options.providerCaseLoader ?? loadProviderCaseReview)();
      if (providerResult.decisionTrace.providerAction !== "NOT_EXECUTED") throw new Error("PROVIDER_ACTION_BOUNDARY_BROKEN");
      if (providerResult.decisionTrace.reasons.length !== 7) throw new Error("PROVIDER_SAVED_REASON_COUNT_UNEXPECTED");
      return { caseId: "airwallex-saved-rfi-023", source: "saved-sanitized-receipts", freshness: "NOT_REFRESHED",
        w4ReasonCount: providerResult.decisionTrace.reasons.length, providerAction: providerResult.decisionTrace.providerAction };
    }
    const fixtureCaseId = scenario === "synthetic-high-fraud" ? "kit04-high-value-fraud" : scenario === "synthetic-low-value" ? "kit04-low-value-delivery" : "kit04-credit-not-processed";
    const fixture = createKit04ReviewCases(undefined, now()).find((item) => item.snapshot.caseId === fixtureCaseId)!;
    snapshot = fixture.snapshot;
    if (scenario === "synthetic-high-fraud") snapshot = { ...fixture.snapshot, evidence: fixture.snapshot.evidence.slice(0, 1) };
    return { caseId: snapshot.caseId, source: "repository-fixture", snapshotSha256: sha256(JSON.stringify(snapshot)), revision };
  });
  transition("PLAN", scenario === "synthetic-high-fraud" ? "Inspect available evidence, calculate with policy, then acquire only the next saved fixture record if the policy asks for review." : "Inspect evidence, calculate with existing deterministic policy, then recommend or escalate.");

  let initial: DisputeRecommendation;
  let final: DisputeRecommendation;
  let initialFingerprint = "";
  let finalFingerprint = "";
  let initialRevision = revision;
  let replan = false;
  let initialCertificate: ReturnType<typeof createDecisionCertificate> | undefined;
  let cert: AgentRunResult["certificate"] = null;
  if (scenario === "provider-rfi") {
    const provider = providerResult!;
    const inspected = await tool("inspect_evidence", { caseId: context.caseId, source: "saved_evidence_matrix", revision }, () => ({
      items: provider.evidenceItems.map((item) => ({ id: item.id, classification: item.classification, source: item.source, limitation: item.limitation })),
      references: provider.decisionTrace.provenance.map((item) => item.source), verifiedSourceSpans: 0,
    }));
    trace[trace.length - 1]!.evidenceReferences = [...inspected.references];
    validateStep("Saved receipt hashes and evidence classifications inspected; live freshness is unavailable.", undefined, revision);
    const calculated = await tool("calculate_economics", { caseId: context.caseId, policy: "evaluateW4Preflight", requestedAction: "CHALLENGE", revision }, () => ({
      action: "HOLD · REQUEST_EVIDENCE · HUMAN_REVIEW", reasonCodes: [...provider.decisionTrace.reasons],
      expectedRecoveryMinor: null, expectedNetValueMinor: null, providerAction: provider.decisionTrace.providerAction,
    }));
    initial = final = { action: "ESCALATE_FOR_REVIEW", reasonCodes: calculated.reasonCodes, explanation: calculated.action,
      disputeFeeMinor: 0, expectedRecoveryMinor: null, expectedNetValueMinor: null, evidenceIds: [], humanReviewRequired: true };
    const missing = await tool("request_missing_information", { caseId: context.caseId, reasonCodes: calculated.reasonCodes, revision }, () => ({
      requested: ["fresh provider identity and deadline read", "verified cardholder authorization", "transaction details", "qualifying customer history"],
      reasonCount: calculated.reasonCodes.length, providerAction: "NOT_EXECUTED",
    }));
    trace[trace.length - 1]!.reasonCodes = [...calculated.reasonCodes];
    validateStep("W4 remains fail-closed with seven saved-receipt blockers; no fresh read or submission attempted.", undefined, revision);
    await tool("request_human_review", { caseId: context.caseId, revision, reasonCodes: [...calculated.reasonCodes] }, () => ({
      requested: true, localOnly: true, durableQueue: false, approvalRequired: true,
    }));
    transition("ESCALATE", `Request missing information (${missing.reasonCount} blocking reasons); human review required.`);
  } else {
    const initialSnapshot = snapshot!;
    const inspected = await tool("inspect_evidence", { caseId: context.caseId, revision, source: "synthetic_fixture" }, () => ({
      evidence: initialSnapshot.evidence.map((item) => ({ id: item.id, kind: item.kind, verifiedInFixture: item.provenance.verified,
        source: item.provenance.source, reference: item.provenance.reference })), references: initialSnapshot.evidence.map((item) => item.id),
    }));
    trace[trace.length - 1]!.evidenceReferences = [...inspected.references];
    validateStep("Fixture provenance is valid and explicitly synthetic.", initialSnapshot, revision);
    const calcInitial = await tool("calculate_economics", { caseId: context.caseId, revision, policy: "recommendDisputeAction",
      evidenceCount: initialSnapshot.evidence.length }, () => ({ ...recommendDisputeAction(initialSnapshot,
      { ...DEFAULT_DISPUTE_ECONOMICS }, now()) }));
    initial = calcInitial;
    initialFingerprint = fingerprintDisputeDecision(initialSnapshot, initial);
    final = initial;
    if (scenario === "synthetic-high-fraud" && initial.action === "ESCALATE_FOR_REVIEW") {
      const baselineCertificate = await tool("generate_decision_certificate", { caseId: context.caseId, revision, purpose: "pre-replan-baseline" }, () => {
        initialCertificate = createDecisionCertificate({ revision, snapshot: initialSnapshot,
          economics: { ...DEFAULT_DISPUTE_ECONOMICS }, createdAt: new Date(now()).toISOString() });
        return { digest: initialCertificate.digest, revision, verified: verifyDecisionCertificate(initialCertificate, revision).ok };
      });
      if (!baselineCertificate.verified) throw new Error("BASELINE_CERTIFICATE_VALIDATION_FAILED");
      transition("REPLAN", "Policy requires human review because only one qualifying signal is present; inspect the remaining saved synthetic fixture evidence.");
      let additionalEvidence: DisputeSnapshot["evidence"][number] | undefined;
      if (options.modelInvestigation === "LOCAL_LLM") {
        const modelDocument = ingestOfflineTextEvidence(context.caseId, "synthetic-risk-note-1",
          "Synthetic risk analyst note: the 3DS authenticated; device matches customer profile. All text here is generated for demonstration and is not a real customer record.", new Date(now()).toISOString());
        const inferenceRevision = revision;
        const investigation = await tool("investigate_synthetic_text_with_model", { caseId: context.caseId, revision,
          source: "synthetic_unstructured_fixture", sourceSha256: modelDocument.sha256 }, async () => {
          modelInvestigation.calls++;
          const raw = await options.modelProvider!.propose(modelDocument, new Date(now()).toISOString()) as {
            proposals?: unknown; extractionContractVersion?: string; modelLatencyMs?: number | null;
          };
          assertModelFindingCurrent({ expectedRevision: inferenceRevision, currentRevision: revision,
            expectedSourceSha256: modelDocument.sha256, sourceText: modelDocument.text });
          if (raw.extractionContractVersion !== MODEL_OUTPUT_CONTRACT_VERSION) throw new Error("MODEL_EXTRACTION_CONTRACT_VERSION_MISMATCH");
          const modelId = options.modelProvider!.actualModelId;
          modelInvestigation.modelIdentity = modelId ?? null;
          modelInvestigation.latencyMs = options.modelProvider!.lastModelLatencyMs ?? raw.modelLatencyMs ?? null;
          const claims = parseModelProposalResponse({ proposals: raw.proposals });
          if (claims.length === 0) {
            modelInvestigation.status = "NO_FINDING";
            return { status: modelInvestigation.status, modelIdentity: modelId ?? null, latencyMs: modelInvestigation.latencyMs,
              acceptedFindings: 0, rejectedFindings: [] };
          }
          if (claims.length !== 1) {
            modelInvestigation.status = "REJECTED";
            modelInvestigation.rejectedFindings = claims.map((claim) => ({ quote: claim.exactQuote, reason: "AMBIGUOUS_MULTIPLE_FINDINGS" }));
            return { status: modelInvestigation.status, modelIdentity: modelId ?? null, latencyMs: modelInvestigation.latencyMs,
              acceptedFindings: 0, rejectedFindings: modelInvestigation.rejectedFindings };
          }
          const enriched = enrichModelProposals(claims, modelDocument, modelId ?? null, new Date(now()).toISOString());
          const finding = enriched[0]!;
          if (finding.groundingReasonCode !== "GROUNDED" || explainProposalGrounding(finding.proposal, modelDocument) !== "GROUNDED") {
            modelInvestigation.status = "REJECTED";
            modelInvestigation.rejectedFindings = [{ quote: finding.proposal.exactQuote, reason: finding.groundingReasonCode }];
            return { status: modelInvestigation.status, modelIdentity: modelId ?? null, latencyMs: modelInvestigation.latencyMs,
              acceptedFindings: 0, rejectedFindings: modelInvestigation.rejectedFindings };
          }
          assertModelFindingCurrent({ expectedRevision: inferenceRevision, currentRevision: revision,
            expectedSourceSha256: modelDocument.sha256, sourceText: modelDocument.text });
          if (snapshot !== initialSnapshot) throw new Error("CASE_SNAPSHOT_CHANGED_DURING_MODEL_RUN");
          additionalEvidence = Object.freeze({ id: `model-grounded-${modelDocument.sha256.slice(0, 16)}`, kind: "DEVICE_AND_3DS_MATCH",
            supportsMerchant: true, strength: "STRONG", summary: "Synthetic unstructured evidence; model-proposed claim passed application grounding checks.",
            provenance: Object.freeze({ source: "OPERATOR", reference: `synthetic-text:${modelDocument.sha256}:${finding.proposal.startOffset}-${finding.proposal.endOffset}`,
              observedAt: modelDocument.receivedAt, verified: true }) });
          modelInvestigation.status = "ACCEPTED";
          modelInvestigation.acceptedFindings = 1;
          modelInvestigation.groundedEvidence = [{ sha256: modelDocument.sha256, startOffset: finding.proposal.startOffset,
            endOffset: finding.proposal.endOffset, quote: finding.proposal.exactQuote }];
          return { status: modelInvestigation.status, modelIdentity: modelId, latencyMs: modelInvestigation.latencyMs,
            acceptedFindings: 1, groundedEvidence: modelInvestigation.groundedEvidence };
        }, modelTimeoutMs);
        if (additionalEvidence) trace[trace.length - 1]!.evidenceReferences = [additionalEvidence.id];
        else trace[trace.length - 1]!.reasonCodes = [modelInvestigation.status];
        void investigation;
      } else {
        const acquired = await tool("acquire_synthetic_evidence", { caseId: context.caseId, revision, requested: "second_independent_fraud_signal" }, () => {
          const all = createScenarioEvidence("fraud-high-value");
          const next = all.find((item) => !initialSnapshot.evidence.some((prior) => prior.id === item.id));
          if (!next) throw new Error("NO_NEW_FIXTURE_EVIDENCE");
          return { item: next, source: "repository-fixture", synthetic: true };
        });
        additionalEvidence = acquired.item;
        trace[trace.length - 1]!.evidenceReferences = [acquired.item.id];
      }
      if (additionalEvidence) {
        snapshot = { ...initialSnapshot, evidence: [...initialSnapshot.evidence, additionalEvidence] };
        revision++;
        replan = true;
        validateStep("New evidence is unique, synthetic, grounded to its source, and bound to a new revision.", snapshot, revision);
        const calcFinal = await tool("calculate_economics", { caseId: context.caseId, revision, policy: "recommendDisputeAction",
          evidenceCount: snapshot.evidence.length }, () => ({ ...recommendDisputeAction(snapshot!, { ...DEFAULT_DISPUTE_ECONOMICS }, now()) }));
        final = calcFinal;
        trace.push({ sequence: trace.length + 1, state: "VALIDATE", atUtc: new Date(now()).toISOString(),
          output: { valid: final.action === "CHALLENGE", previousRevision: initialRevision, currentRevision: revision,
            staleApproval: "NONE_ISSUED", staleCertificate: verifyDecisionCertificate(initialCertificate, revision).reasonCodes[0] ?? "INVALIDATED_BY_REVISION_CHANGE" },
          reasonCodes: [...final.reasonCodes] });
      }
    }
    finalFingerprint = fingerprintDisputeDecision(snapshot!, final);
    const certificate = final.action === "ESCALATE_FOR_REVIEW" || final.action === "NO_ACTION" ? null : await tool("generate_decision_certificate", { caseId: context.caseId, revision, fingerprint: finalFingerprint }, () => {
      if (!snapshot || final.action === "ESCALATE_FOR_REVIEW" || final.action === "NO_ACTION") throw new Error("CERTIFICATE_REQUIRES_FINAL_RECOMMENDATION");
      const value = createDecisionCertificate({ revision, snapshot, economics: { ...DEFAULT_DISPUTE_ECONOMICS }, createdAt: new Date(now()).toISOString() });
      const verification = verifyDecisionCertificate(value, revision);
      if (!verification.ok) throw new Error("AGENT_CERTIFICATE_VALIDATION_FAILED");
      return { digest: value.digest, revision, snapshotFingerprint: value.snapshotFingerprint, verified: verification.ok };
    });
    cert = certificate;
    if (certificate) validateStep("Certificate validates against the final case revision; it is not an approval or provider action.", snapshot, revision);
    await tool("request_human_review", { caseId: context.caseId, revision, action: displayRecommendation(final.action),
      reasonCodes: [...final.reasonCodes] }, () => ({ requested: true, localOnly: true, durableQueue: false, approvalRequired: true }));
    if (final.action === "ESCALATE_FOR_REVIEW") transition("ESCALATE", modelInvestigation.status === "NO_FINDING" || modelInvestigation.status === "REJECTED" || modelInvestigation.status === "FAILED_CLOSED"
      ? "Model finding was unavailable or rejected; deterministic policy kept the case at human review." : "Policy requires a human decision.");
    else transition("RECOMMEND", "Validated recommendation and certificate are ready for human approval; no financial action executed.");
  }
  if (scenario === "provider-rfi") {
    initialRevision = 1;
    initialFingerprint = sha256(JSON.stringify(providerResult!.decisionTrace));
    finalFingerprint = initialFingerprint;
  }
  return {
    schemaVersion: "fair-trial-agent-run/v1", controller: "BOUNDED_RULE_PLANNER", plannerLabel: "DETERMINISTIC_RULE_PLANNER",
    modelPlanning: "NOT_IMPLEMENTED", scenario,
    dataLabel: scenario === "provider-rfi" ? "PROVIDER_BACKED_SAVED_RECEIPTS" : "OFFLINE_SYNTHETIC_FIXTURE",
    caseId: context.caseId,
    initial: { revision: initialRevision, snapshotFingerprint: initialFingerprint,
      action: scenario === "provider-rfi" ? "HOLD / REQUEST_EVIDENCE / HUMAN_REVIEW" : displayRecommendation(initial.action), reasonCodes: [...initial.reasonCodes],
      expectedRecoveryMinor: initial.expectedRecoveryMinor, expectedNetValueMinor: initial.expectedNetValueMinor },
    final: { revision, snapshotFingerprint: finalFingerprint,
      action: scenario === "provider-rfi" ? "HOLD / REQUEST_EVIDENCE / HUMAN_REVIEW" : displayRecommendation(final.action), reasonCodes: [...final.reasonCodes], expectedRecoveryMinor: final.expectedRecoveryMinor,
      disputeFeeMinor: scenario === "provider-rfi" ? null : final.disputeFeeMinor, expectedNetValueMinor: final.expectedNetValueMinor },
    replan: { occurred: replan, cause: replan ? modelInvestigation.status === "ACCEPTED" ? "A source-hash-bound model-proposed synthetic evidence finding passed exact-quote and semantic grounding, then triggered deterministic policy recomputation." : "A second independent synthetic fixture signal changed policy eligibility." : null,
      staleApprovalInvalidated: false, staleCertificateInvalidated: replan },
    modelInvestigation,
    certificate: cert, approvalRequired: true, providerAction: "NOT_EXECUTED", trace,
  };
}

function displayRecommendation(action: DisputeRecommendation["action"]): string {
  if (action === "CHALLENGE") return "CHALLENGE_RECOMMENDED";
  if (action === "ACCEPT") return "ACCEPT_RECOMMENDED";
  return action;
}
