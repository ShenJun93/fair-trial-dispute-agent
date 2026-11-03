import { readFile, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import {
  authorizeFinancialAction, DEFAULT_DISPUTE_ECONOMICS, DisputeAuditTrail,
  fingerprintDisputeDecision, recommendDisputeAction, type DisputeEvidence, type DisputeSnapshot,
} from "../spike/dispute-engine.ts";

type Scenario = {
  id: string; description: string; evidence: string; economics?: string; deadline: string;
  authorization?: "stale" | "replay"; expectedAction: string; expectedAuthorization?: string;
  expectedReasons: string[]; grounding: string;
};
const inputPath = resolve("submission/benchmark/financial-decision-scenarios.json");
const outputPath = resolve(process.argv[2] ?? "submission/benchmark/financial-decision-results.json");
const runnerStartedAt = performance.now();
const dataset = JSON.parse(await readFile(inputPath, "utf8")) as { schemaVersion: string; disclosure: string; scenarios: Scenario[] };
const now = Date.parse("2026-10-29T00:00:00.000Z");
const stamp = new Date(now).toISOString();

function evidence(id: string, supports: boolean, strength: DisputeEvidence["strength"], verified: boolean,
  subject = "payment-123", context = "transaction-123"): DisputeEvidence {
  return { id, kind: "DEVICE_AND_3DS_MATCH", supportsMerchant: supports, strength, summary: `Synthetic ${id}`,
    provenance: { source: "PAYMENT_RISK_SYSTEM", reference: `synthetic:${id}`, observedAt: stamp, verified, subject, context } };
}
function evidenceFor(mode: string): DisputeEvidence[] {
  if (mode === "none") return [];
  if (mode === "strong-two") return [evidence("risk-device", true, "STRONG", true), evidence("risk-3ds", true, "STRONG", true, "payment-123", "authentication-123")];
  if (mode === "scoped-conflict") return [evidence("risk-positive", true, "STRONG", true), evidence("risk-opposing", false, "STRONG", true)];
  if (mode === "unscoped-conflict") return [evidence("risk-positive", true, "STRONG", true, "", ""), evidence("risk-opposing", false, "STRONG", true, "", "")];
  if (mode === "unverified-two") return [evidence("model-device-claim", true, "STRONG", false), evidence("model-3ds-claim", true, "STRONG", false, "payment-123", "authentication-123")];
  throw new Error(`Unknown evidence profile: ${mode}`);
}
function makeSnapshot(s: Scenario, amountMinor = 12_000): DisputeSnapshot {
  const deadline = s.deadline === "too-close" ? new Date(now + 10 * 60_000).toISOString() : new Date(now + 24 * 60 * 60_000).toISOString();
  return { caseId: s.id, amountMinor, currency: "USD", reason: "FRAUDULENT", reasonCode: "10.4", stage: "RFI",
    status: "REQUIRES_RESPONSE", responseDeadline: deadline, evidence: evidenceFor(s.evidence) };
}
function economicsFor(s: Scenario) {
  if (s.economics === "zero-recovery") return { ...DEFAULT_DISPUTE_ECONOMICS, stageAdjustments: { RFI: { additionalDefenseCostMinor: 2_500, strongFraudWinProbabilityBps: 0 } } };
  if (s.economics === "low-stage-recovery") return { ...DEFAULT_DISPUTE_ECONOMICS, stageAdjustments: { RFI: { additionalDefenseCostMinor: 3_000, strongFraudWinProbabilityBps: 2_000 } } };
  return DEFAULT_DISPUTE_ECONOMICS;
}
function authResult(s: Scenario, result: ReturnType<typeof recommendDisputeAction>): string | null {
  if (!s.authorization) return null;
  const original = makeSnapshot(s);
  const originalResult = recommendDisputeAction(original, economicsFor(s), now);
  const snapshot = s.authorization === "stale" ? makeSnapshot(s, original.amountMinor + 500) : original;
  const recommendation = recommendDisputeAction(snapshot, economicsFor(s), now);
  const fingerprint = fingerprintDisputeDecision(original, originalResult);
  const consumed = new Set<string>();
  const approval = { approvalId: `benchmark:${s.id}`, caseId: s.id, action: "CHALLENGE" as const, actor: "synthetic-operator",
    approvedAt: now - 1, expiresAt: now + 60_000, snapshotFingerprint: fingerprint };
  try {
    authorizeFinancialAction(snapshot, recommendation, approval, new DisputeAuditTrail(), consumed, now);
    if (s.authorization === "replay") {
      try { authorizeFinancialAction(snapshot, recommendation, approval, new DisputeAuditTrail(), consumed, now); }
      catch { return "REPLAY_REJECTED"; }
      return "REPLAY_ACCEPTED";
    }
    return "AUTHORIZATION_ACCEPTED";
  } catch {
    return s.authorization === "stale" ? "STALE_APPROVAL_REJECTED" : "AUTHORIZATION_REJECTED";
  }
}

const rows = dataset.scenarios.map((scenario) => {
  const snapshot = makeSnapshot(scenario);
  const economics = economicsFor(scenario);
  const durations: number[] = [];
  const decisions = Array.from({ length: 101 }, () => {
    const started = performance.now();
    const value = recommendDisputeAction(snapshot, economics, now);
    durations.push(performance.now() - started);
    return value;
  });
  const decision = decisions[0]!;
  const deterministic = decisions.every((item) => JSON.stringify(item) === JSON.stringify(decision));
  const sortedDurations = [...durations].sort((a, b) => a - b);
  const latency = { p50: Number(sortedDurations[50]!.toFixed(4)), p95: Number(sortedDurations[95]!.toFixed(4)),
    mean: Number((durations.reduce((sum, value) => sum + value, 0) / durations.length).toFixed(4)) };
  const authorization = authResult(scenario, decision);
  const evidenceIds = new Set(snapshot.evidence.filter((item) => item.provenance.verified).map((item) => item.id));
  const grounded = decision.evidenceIds.every((id) => evidenceIds.has(id));
  const passed = decision.action === scenario.expectedAction && scenario.expectedReasons.every((reason) => decision.reasonCodes.includes(reason)) &&
    (scenario.expectedAuthorization === undefined || authorization === scenario.expectedAuthorization) && deterministic && grounded;
  return { id: scenario.id, expectedAction: scenario.expectedAction, actualAction: decision.action,
    expectedReasonCodes: scenario.expectedReasons, actualReasonCodes: decision.reasonCodes,
    expectedAuthorization: scenario.expectedAuthorization ?? null, actualAuthorization: authorization,
    grounding: scenario.grounding, groundingCheck: grounded, determinism101Runs: deterministic,
    decisionLatencyMs: latency, passed };
});
const elapsedMs = Number((performance.now() - runnerStartedAt).toFixed(3));
const output = { schemaVersion: "fair-trial-synthetic-benchmark-results/v1", dataset: "submission/benchmark/financial-decision-scenarios.json",
  disclosure: dataset.disclosure, generatedAt: new Date().toISOString(), runtime: { node: process.version, platform: process.platform, arch: process.arch },
  policyVersion: "4.1B", repetitionsPerScenario: 101, executionCost: { scenarioCount: rows.length, decisionEvaluations: rows.length * 101,
    runnerElapsedMs: elapsedMs }, metrics: { policyDecisionCorrectness: `${rows.filter((r) => r.passed).length}/${rows.length}`,
    unsafeActionRejections: rows.filter((r) => r.actualAction === "NO_ACTION" && r.passed).length,
    failClosedScenarios: rows.filter((r) => ["NO_ACTION", "ESCALATE_FOR_REVIEW"].includes(r.actualAction) && r.passed).length,
    evidenceGroundingPasses: rows.filter((r) => r.groundingCheck).length,
    deterministicScenarios: rows.filter((r) => r.determinism101Runs).length,
    latencyMs: { p50AcrossScenarios: Number((rows.reduce((sum, r) => sum + r.decisionLatencyMs.p50, 0) / rows.length).toFixed(4)),
      p95WorstScenario: Number(Math.max(...rows.map((r) => r.decisionLatencyMs.p95)).toFixed(4)) } },
  scenarios: rows, passed: rows.every((row) => row.passed) };
await writeFile(outputPath, JSON.stringify(output, null, 2) + "\n", "utf8");
console.log(JSON.stringify({ output: outputPath, passed: output.passed, metrics: output.metrics }));
if (!output.passed) process.exitCode = 1;
