import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runDisputeAgent, type AgentScenario } from "../spike/dispute-agent.ts";

const scenarios: AgentScenario[] = ["provider-rfi", "synthetic-high-fraud", "synthetic-low-value", "synthetic-credit-not-processed"];
const runs = [];
for (const scenario of scenarios) runs.push(await runDisputeAgent(scenario));
const evidence = {
  schemaVersion: "fair-trial-ft032-demo-sequence/v1",
  generatedAtUtc: new Date().toISOString(),
  disclosure: "Application controller traces. One provider-backed historical saved receipt path and three synthetic fixture paths. Deterministic rule planner; no current model inference. Every provider action is NOT_EXECUTED.",
  runs,
};
const output = resolve(process.argv[2] ?? "submission/evidence/ft032-agent-demonstration.json");
await writeFile(output, JSON.stringify(evidence, null, 2) + "\n", "utf8");
console.log(JSON.stringify({ output, scenarios: runs.map((run) => ({ scenario: run.scenario,
  dataLabel: run.dataLabel, initial: run.initial.action, final: run.final.action,
  revision: `${run.initial.revision}->${run.final.revision}`, tools: run.trace.filter((event) => event.tool).length,
  providerAction: run.providerAction })), providerAction: "NOT_EXECUTED", modelInference: "NOT_RUN" }, null, 2));
