import { stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { runDisputeAgent, type AgentScenario } from "../spike/dispute-agent.ts";
import { LocalRuntimeProposalProvider, DEFAULT_LOCAL_MODEL_TIMEOUT_MS } from "../spike/evidence-proposals.ts";

const outputPath = resolve(process.argv[2] ?? "submission/evidence/ft031-agent-demonstration.json");
const scenarios: AgentScenario[] = ["provider-rfi", "synthetic-high-fraud", "synthetic-low-value", "synthetic-credit-not-processed"];
const runs = [];
for (const scenario of scenarios) runs.push(await runDisputeAgent(scenario));
const result = { schemaVersion: "fair-trial-ft031-agent-evaluation/v1", generatedAtUtc: new Date().toISOString(),
  disclosure: "The saved provider case uses historical receipts. Other cases are synthetic. No provider action executed; model-directed planning is not implemented.", runs };
await writeFile(outputPath, JSON.stringify(result, null, 2) + "\n", "utf8");
console.log(JSON.stringify({ outputPath, runs: runs.map((run) => ({ scenario: run.scenario, initial: run.initial.action,
  final: run.final.action, revision: `${run.initial.revision}->${run.final.revision}`, replan: run.replan.occurred,
  model: run.modelInvestigation.status, providerAction: run.providerAction })) }));

const modelOutput = resolve("submission/evidence/ft031-model-evaluation.json");
const configuredModel = process.env.LOCAL_MODEL_ID?.trim() ?? "";
const endpoint = process.env.LOCAL_MODEL_ENDPOINT ?? "http://127.0.0.1:12345/v1/chat/completions";
const expectedExistingModel = "Qwen3-4B-Instruct-2507-Q4_K_M.gguf";
let installedModelBytes: number | null = null;
try {
  const modelStat = await stat(resolve(homedir(), ".lmstudio/models/lmstudio-community/Qwen3-4B-Instruct-2507-GGUF", expectedExistingModel));
  if (modelStat.isFile()) installedModelBytes = modelStat.size;
} catch { /* Machine-local runtime discovery is optional; do not expose its local path. */ }
const modelsEndpoint = new URL(endpoint);
modelsEndpoint.pathname = "/v1/models";
let runtimeHealth: "AVAILABLE" | "UNAVAILABLE" = "UNAVAILABLE";
let runtimeError: string | null = null;
let discoveredModels: string[] = [];
if (modelsEndpoint.protocol !== "http:" || modelsEndpoint.hostname !== "127.0.0.1") {
  runtimeError = "NUMERIC_LOOPBACK_HTTP_REQUIRED";
} else {
  try {
    const response = await fetch(modelsEndpoint, { signal: AbortSignal.timeout(2_000) });
    if (!response.ok) runtimeError = `MODEL_LIST_HTTP_${response.status}`;
    else {
      const payload = await response.json() as { data?: Array<{ id?: unknown }> };
      discoveredModels = Array.isArray(payload.data) ? payload.data.flatMap((item) => typeof item.id === "string" ? [item.id] : []) : [];
      runtimeHealth = discoveredModels.length ? "AVAILABLE" : "UNAVAILABLE";
      if (!discoveredModels.length) runtimeError = "NO_MODELS_LISTED";
    }
  } catch (error) {
    const causeCode = error && typeof error === "object" && "cause" in error && error.cause && typeof error.cause === "object" &&
      "code" in error.cause && typeof error.cause.code === "string" ? error.cause.code : "";
    runtimeError = causeCode === "EACCES" ? "SANDBOX_LOOPBACK_ACCESS_DENIED" : error instanceof Error ? error.name : "LOCAL_MODEL_ENDPOINT_UNAVAILABLE";
  }
}
const requestedModel = configuredModel || (discoveredModels.includes(expectedExistingModel) ? expectedExistingModel : "");
if (!requestedModel) {
  await writeFile(modelOutput, JSON.stringify({ schemaVersion: "fair-trial-ft031-model-evaluation/v1", generatedAtUtc: new Date().toISOString(),
    status: "NOT_RUN", reason: runtimeError === "SANDBOX_LOOPBACK_ACCESS_DENIED" ? "SANDBOX_LOOPBACK_ACCESS_DENIED"
      : runtimeHealth === "UNAVAILABLE" ? "LOCAL_RUNTIME_UNAVAILABLE" : "EXACT_APPROVED_MODEL_ID_NOT_AVAILABLE",
    runtime: { provider: "LOCAL_LOOPBACK_ONLY", endpoint: modelsEndpoint.origin, health: runtimeHealth, error: runtimeError,
      discoveredModelIds: discoveredModels, installedModelFile: installedModelBytes === null ? null : expectedExistingModel,
      installedModelBytes },
    inferenceCalls: 0, modelIdentity: null, latencyMs: null,
    acceptedFindings: 0, rejectedFindings: [], groundedEvidence: [], providerAction: "NOT_EXECUTED",
    note: "No test double or historical result is counted as FT-031 inference." }, null, 2) + "\n", "utf8");
} else {
  const provider = new LocalRuntimeProposalProvider({ endpoint,
    model: requestedModel, enabled: true, timeoutMs: Number(process.env.LOCAL_MODEL_TIMEOUT_MS ?? DEFAULT_LOCAL_MODEL_TIMEOUT_MS) });
  let modelResult: Record<string, unknown>;
  try {
    const run = await runDisputeAgent("synthetic-high-fraud", { modelInvestigation: "LOCAL_LLM", modelProvider: provider });
    modelResult = { status: run.modelInvestigation.status, scenario: run.scenario, dataLabel: run.dataLabel,
      modelIdentity: run.modelInvestigation.modelIdentity, latencyMs: run.modelInvestigation.latencyMs,
      inferenceCalls: run.modelInvestigation.calls, acceptedFindings: run.modelInvestigation.acceptedFindings,
      rejectedFindings: run.modelInvestigation.rejectedFindings, groundedEvidence: run.modelInvestigation.groundedEvidence,
      initialAction: run.initial.action, finalAction: run.final.action, initialRevision: run.initial.revision,
      finalRevision: run.final.revision, replanOccurred: run.replan.occurred, providerAction: run.providerAction };
  } catch (error) {
    modelResult = { status: "FAILED_CLOSED", reason: error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
      ? error.message : "LOCAL_MODEL_RUN_FAILED", inferenceCalls: provider.actualModelId ? 1 : 0,
      modelIdentity: provider.actualModelId, latencyMs: provider.lastModelLatencyMs, acceptedFindings: 0,
      rejectedFindings: [], groundedEvidence: [], providerAction: "NOT_EXECUTED" };
  }
  await writeFile(modelOutput, JSON.stringify({ schemaVersion: "fair-trial-ft031-model-evaluation/v1",
    generatedAtUtc: new Date().toISOString(), runtime: { provider: "LOCAL_LOOPBACK_ONLY", endpoint: modelsEndpoint.origin,
      health: runtimeHealth, discoveredModelIds: discoveredModels }, ...modelResult }, null, 2) + "\n", "utf8");
}
console.log(JSON.stringify({ modelOutput, modelStatus: JSON.parse(await (await import("node:fs/promises")).readFile(modelOutput, "utf8")).status }));
