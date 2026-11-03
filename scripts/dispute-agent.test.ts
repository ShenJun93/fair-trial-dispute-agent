import assert from "node:assert/strict";
import test from "node:test";
import { assertModelFindingCurrent, runDisputeAgent } from "../spike/dispute-agent.ts";
import { createHash } from "node:crypto";
import { MODEL_OUTPUT_CONTRACT_VERSION, type EvidenceProposalProvider } from "../spike/evidence-proposals.ts";

const NOW = Date.parse("2026-10-31T12:00:00.000Z");

test("provider saved-receipt path reports seven blockers and keeps W4 unexecuted", async () => {
  const result = await runDisputeAgent("provider-rfi", { now: () => NOW });
  assert.equal(result.dataLabel, "PROVIDER_BACKED_SAVED_RECEIPTS");
  assert.equal(result.final.action, "HOLD / REQUEST_EVIDENCE / HUMAN_REVIEW");
  assert.equal(result.final.reasonCodes.length, 7);
  assert.equal(result.providerAction, "NOT_EXECUTED");
  assert.equal(result.trace.some((entry) => entry.tool === "request_missing_information"), true);
  assert.equal(result.trace.some((entry) => entry.output?.freshness === "NOT_REFRESHED"), true);
});

test("high-value synthetic evidence is acquired through a tool and causes a revision-bound replan", async () => {
  const result = await runDisputeAgent("synthetic-high-fraud", { now: () => NOW });
  assert.equal(result.dataLabel, "OFFLINE_SYNTHETIC_FIXTURE");
  assert.equal(result.initial.action, "ESCALATE_FOR_REVIEW");
  assert.equal(result.final.action, "CHALLENGE_RECOMMENDED");
  assert.equal(result.initial.revision, 1);
  assert.equal(result.final.revision, 2);
  assert.notEqual(result.initial.snapshotFingerprint, result.final.snapshotFingerprint);
  assert.equal(result.replan.occurred, true);
  assert.equal(result.replan.staleCertificateInvalidated, true);
  assert.equal(result.replan.staleApprovalInvalidated, false);
  assert.equal(result.certificate?.revision, 2);
  assert.equal(result.certificate?.verified, true);
  assert.equal(result.certificate?.snapshotFingerprint, result.final.snapshotFingerprint);
  assert.equal(result.trace.some((entry) => entry.tool === "acquire_synthetic_evidence"), true);
  assert.equal(result.trace.filter((entry) => entry.tool === "calculate_economics").length, 2);
  assert.equal(result.trace.some((entry) => entry.tool === "request_human_review"), true);
  assert.ok(result.trace.filter((entry) => entry.tool).length <= 8);
  assert.equal(result.providerAction, "NOT_EXECUTED");
  assert.ok(result.trace.length <= 20);
});

test("low-value synthetic path uses existing economics and recommends acceptance", async () => {
  const result = await runDisputeAgent("synthetic-low-value", { now: () => NOW });
  assert.equal(result.final.action, "ACCEPT_RECOMMENDED");
  assert.equal(result.final.expectedRecoveryMinor, 300);
  assert.equal(result.final.expectedNetValueMinor, -2_200);
  assert.equal(result.certificate?.verified, true);
  assert.equal(result.providerAction, "NOT_EXECUTED");
});

test("synthetic credit-not-processed path escalates for human review without claiming an outcome", async () => {
  const result = await runDisputeAgent("synthetic-credit-not-processed", { now: () => NOW });
  assert.equal(result.dataLabel, "OFFLINE_SYNTHETIC_FIXTURE");
  assert.equal(result.caseId, "kit04-credit-not-processed");
  assert.equal(result.final.action, "ESCALATE_FOR_REVIEW");
  assert.equal(result.final.reasonCodes.includes("CUSTOMER_SUPPORT_UNANSWERED"), true);
  assert.equal(result.certificate, null);
  assert.equal(result.providerAction, "NOT_EXECUTED");
});

function syntheticModelProvider(claims: unknown, modelId = "Qwen3-SYNTHETIC-TEST"): EvidenceProposalProvider {
  return { mode: "LOCAL_LLM", model: modelId, actualModelId: modelId, lastModelLatencyMs: 321.5,
    propose: async () => ({ proposals: claims, extractionContractVersion: MODEL_OUTPUT_CONTRACT_VERSION, modelLatencyMs: 321.5 }) };
}

test("model evidence analysis accepts only exact semantically grounded synthetic quote then recomputes policy", async () => {
  const result = await runDisputeAgent("synthetic-high-fraud", { now: () => NOW, modelInvestigation: "LOCAL_LLM",
    modelProvider: syntheticModelProvider([{ factType: "DEVICE_AND_3DS_MATCH", exactQuote: "3DS authenticated; device matches customer profile" }]) });
  assert.equal(result.plannerLabel, "DETERMINISTIC_RULE_PLANNER");
  assert.equal(result.modelPlanning, "NOT_IMPLEMENTED");
  assert.equal(result.modelInvestigation.status, "ACCEPTED");
  assert.equal(result.modelInvestigation.modelIdentity, "Qwen3-SYNTHETIC-TEST");
  assert.equal(result.modelInvestigation.latencyMs, 321.5);
  assert.equal(result.modelInvestigation.calls, 1);
  assert.equal(result.modelInvestigation.acceptedFindings, 1);
  assert.equal(result.modelInvestigation.groundedEvidence[0]?.sha256.length, 64);
  assert.equal(result.modelInvestigation.groundedEvidence[0]?.endOffset - result.modelInvestigation.groundedEvidence[0]?.startOffset,
    result.modelInvestigation.groundedEvidence[0]?.quote.length);
  assert.equal(result.initial.action, "ESCALATE_FOR_REVIEW");
  assert.equal(result.final.action, "CHALLENGE_RECOMMENDED");
  assert.equal(result.initial.revision, 1);
  assert.equal(result.final.revision, 2);
  assert.equal(result.replan.occurred, true);
  assert.equal(result.trace.some((entry) => entry.tool === "investigate_synthetic_text_with_model"), true);
  assert.equal(result.providerAction, "NOT_EXECUTED");
});

test("unsupported, ambiguous, and absent model findings fail closed without triggering a model-based replan", async () => {
  const unsupported = await runDisputeAgent("synthetic-high-fraud", { now: () => NOW, modelInvestigation: "LOCAL_LLM",
    modelProvider: syntheticModelProvider([{ factType: "DEVICE_AND_3DS_MATCH", exactQuote: "A customer was pleased with the product" }]) });
  assert.equal(unsupported.modelInvestigation.status, "REJECTED");
  assert.equal(unsupported.modelInvestigation.acceptedFindings, 0);
  assert.equal(unsupported.final.action, "ESCALATE_FOR_REVIEW");
  assert.equal(unsupported.final.revision, 1);
  assert.equal(unsupported.providerAction, "NOT_EXECUTED");

  const ambiguous = await runDisputeAgent("synthetic-high-fraud", { now: () => NOW, modelInvestigation: "LOCAL_LLM",
    modelProvider: syntheticModelProvider([
      { factType: "DEVICE_AND_3DS_MATCH", exactQuote: "3DS authenticated; device matches customer profile" },
      { factType: "DEVICE_AND_3DS_MATCH", exactQuote: "3DS authenticated; device matches customer profile" },
    ]) });
  assert.equal(ambiguous.modelInvestigation.status, "REJECTED");
  assert.equal(ambiguous.modelInvestigation.rejectedFindings[0]?.reason, "AMBIGUOUS_MULTIPLE_FINDINGS");
  assert.equal(ambiguous.final.action, "ESCALATE_FOR_REVIEW");

  const absent = await runDisputeAgent("synthetic-high-fraud", { now: () => NOW, modelInvestigation: "LOCAL_LLM",
    modelProvider: syntheticModelProvider([]) });
  assert.equal(absent.modelInvestigation.status, "NO_FINDING");
  assert.equal(absent.final.action, "ESCALATE_FOR_REVIEW");
});

test("malformed model contract, source mutation, stale revision, and tool budget fail closed", async () => {
  const wrongContract = syntheticModelProvider([{ factType: "DEVICE_AND_3DS_MATCH", exactQuote: "3DS authenticated; device matches customer profile" }]);
  wrongContract.propose = async () => ({ proposals: [{ factType: "DEVICE_AND_3DS_MATCH", exactQuote: "3DS authenticated; device matches customer profile" }], extractionContractVersion: "wrong" });
  await assert.rejects(runDisputeAgent("synthetic-high-fraud", { now: () => NOW, modelInvestigation: "LOCAL_LLM", modelProvider: wrongContract }),
    /MODEL_EXTRACTION_CONTRACT_VERSION_MISMATCH/);
  const text = "synthetic source";
  const hash = createHash("sha256").update(text).digest("hex");
  assert.throws(() => assertModelFindingCurrent({ expectedRevision: 1, currentRevision: 2, expectedSourceSha256: hash, sourceText: text }),
    /CASE_REVISION_CHANGED_DURING_MODEL_RUN/);
  assert.throws(() => assertModelFindingCurrent({ expectedRevision: 1, currentRevision: 1, expectedSourceSha256: hash, sourceText: text + " changed" }),
    /STALE_OR_INVALID_MODEL_EVIDENCE/);
  await assert.rejects(runDisputeAgent("synthetic-high-fraud", { now: () => NOW, maxToolCalls: 7,
    modelInvestigation: "LOCAL_LLM", modelProvider: syntheticModelProvider([{ factType: "DEVICE_AND_3DS_MATCH", exactQuote: "3DS authenticated; device matches customer profile" }]) }),
    /AGENT_TOOL_BUDGET_EXHAUSTED/);
});

test("actual-model tool has a bounded inference timeout and does not retry or accept late results", async () => {
  const provider = syntheticModelProvider([]);
  provider.propose = async () => { await new Promise((resolve) => setTimeout(resolve, 30)); return {
    proposals: [], extractionContractVersion: MODEL_OUTPUT_CONTRACT_VERSION,
  }; };
  await assert.rejects(runDisputeAgent("synthetic-high-fraud", { now: () => NOW, modelInvestigation: "LOCAL_LLM",
    modelProvider: provider, modelTimeoutMs: 5 }), /AGENT_TOOL_TIMEOUT/);
});

test("untrusted prompt text and forged caller supplied evidence cannot enter the tool contract", async () => {
  const injected = await runDisputeAgent("synthetic-high-fraud", { now: () => NOW });
  const traceJson = JSON.stringify(injected.trace);
  assert.equal(traceJson.includes("Ignore all rules"), false);
  assert.equal(traceJson.includes("authorized_provider_write"), false);
  assert.equal(traceJson.includes("forged-evidence"), false);
  await assert.rejects(runDisputeAgent({ scenario: "synthetic-high-fraud", evidence: [{ verified: true }] }), /INVALID_AGENT_SCENARIO/);
  await assert.rejects(runDisputeAgent("synthetic-high-fraud", { timeoutMs: 2_001 }), /INVALID_AGENT_TIMEOUT/);
});

test("tool-call budget exhaustion stops before the next tool and never falls back", async () => {
  await assert.rejects(runDisputeAgent("synthetic-low-value", { now: () => NOW, maxToolCalls: 1 }), /AGENT_TOOL_BUDGET_EXHAUSTED/);
});

test("failed and timed out saved-context tools stop safely after the single read retry", async () => {
  let attempts = 0;
  await assert.rejects(runDisputeAgent("provider-rfi", { now: () => NOW, providerCaseLoader: async () => {
    attempts++;
    throw new Error("SAVED_CONTEXT_UNAVAILABLE");
  } }), /SAVED_CONTEXT_UNAVAILABLE/);
  assert.equal(attempts, 2);
  attempts = 0;
  await assert.rejects(runDisputeAgent("provider-rfi", { now: () => NOW, timeoutMs: 1, providerCaseLoader: async () => {
    attempts++;
    await new Promise((resolve) => setTimeout(resolve, 15));
    throw new Error("LATE_READ_FAILED");
  } }), /AGENT_TOOL_TIMEOUT/);
  assert.equal(attempts, 2);
});
