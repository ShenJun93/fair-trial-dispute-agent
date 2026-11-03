import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runDisputeAgent } from "../spike/dispute-agent.ts";
import { LocalRuntimeProposalProvider, DEFAULT_LOCAL_MODEL_TIMEOUT_MS } from "../spike/evidence-proposals.ts";

const outputPath = resolve("submission/evidence/ft030-model-evaluation.json");
const requestedModel = process.env.LOCAL_MODEL_ID ?? "";
const endpoint = process.env.LOCAL_MODEL_ENDPOINT ?? "http://127.0.0.1:12345/v1/chat/completions";
const timeoutMs = Number(process.env.LOCAL_MODEL_TIMEOUT_MS ?? DEFAULT_LOCAL_MODEL_TIMEOUT_MS);
let receipt: Record<string, unknown>;

if (!requestedModel.trim()) {
  receipt = {
    schemaVersion: "fair-trial-ft030-model-evaluation/v1", status: "NOT_RUN",
    reason: "LOCAL_MODEL_ID_UNSET", inferenceCalls: 0, modelIdentity: null, latencyMs: null,
    acceptedFindings: 0, rejectedFindings: [], groundedEvidence: [], providerAction: "NOT_EXECUTED",
    note: "No test double or historical completion is counted as current inference evidence.",
  };
} else {
  const provider = new LocalRuntimeProposalProvider({ endpoint, model: requestedModel, enabled: true, timeoutMs });
  try {
    const run = await runDisputeAgent("synthetic-high-fraud", { modelInvestigation: "LOCAL_LLM", modelProvider: provider });
    receipt = {
      schemaVersion: "fair-trial-ft030-model-evaluation/v1", status: run.modelInvestigation.status,
      scenario: run.scenario, dataLabel: run.dataLabel, modelIdentity: run.modelInvestigation.modelIdentity,
      latencyMs: run.modelInvestigation.latencyMs, inferenceCalls: run.modelInvestigation.calls,
      acceptedFindings: run.modelInvestigation.acceptedFindings, rejectedFindings: run.modelInvestigation.rejectedFindings,
      groundedEvidence: run.modelInvestigation.groundedEvidence, initialAction: run.initial.action,
      finalAction: run.final.action, initialRevision: run.initial.revision, finalRevision: run.final.revision,
      replanOccurred: run.replan.occurred, plannerLabel: run.plannerLabel, modelPlanning: run.modelPlanning,
      providerAction: run.providerAction,
    };
  } catch (error) {
    receipt = {
      schemaVersion: "fair-trial-ft030-model-evaluation/v1", status: "FAILED_CLOSED",
      reason: error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : "LOCAL_MODEL_RUN_FAILED",
      inferenceCalls: provider.actualModelId ? 1 : 0, modelIdentity: provider.actualModelId,
      latencyMs: provider.lastModelLatencyMs, acceptedFindings: 0, rejectedFindings: [], groundedEvidence: [],
      providerAction: "NOT_EXECUTED",
    };
  }
}
await writeFile(outputPath, JSON.stringify({ generatedAtUtc: new Date().toISOString(), ...receipt }, null, 2) + "\n", "utf8");
console.log(JSON.stringify({ outputPath, status: receipt.status, inferenceCalls: receipt.inferenceCalls,
  modelIdentity: receipt.modelIdentity, latencyMs: receipt.latencyMs, acceptedFindings: receipt.acceptedFindings,
  rejectedFindingCount: Array.isArray(receipt.rejectedFindings) ? receipt.rejectedFindings.length : null,
  providerAction: receipt.providerAction }, null, 2));
