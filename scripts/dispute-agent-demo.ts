import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runDisputeAgent } from "../spike/dispute-agent.ts";

const scenarios = ["provider-rfi", "synthetic-high-fraud", "synthetic-low-value", "synthetic-credit-not-processed"] as const;
const runs = [];
for (const scenario of scenarios) runs.push(await runDisputeAgent(scenario));
const outputPath = resolve("submission/evidence/ft030-agent-demonstration.json");
await writeFile(outputPath, JSON.stringify({ schemaVersion: "fair-trial-agent-demo-receipt/v1", generatedAtUtc: new Date().toISOString(),
  runs }, null, 2) + "\n", "utf8");
console.log(JSON.stringify({ outputPath, scenarios: runs.map((run) => ({ scenario: run.scenario, dataLabel: run.dataLabel,
  initial: run.initial.action, final: run.final.action, reasonCount: run.final.reasonCodes.length, replan: run.replan,
  modelInvestigation: run.modelInvestigation.status, providerAction: run.providerAction,
  toolCalls: run.trace.filter((entry) => entry.tool).length })) }, null, 2));
