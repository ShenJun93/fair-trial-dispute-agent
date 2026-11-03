import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { evaluateValueOfInformation } from "../spike/dispute-planning.ts";

const now = Date.parse("2026-10-31T00:00:00.000Z");
const base = { stage: "RFI" as const, feeMinor: 2_500, addedDefenseCostMinor: 0, recoveryRateBps: 8_000,
  deadline: "SAFE" as const, evidence: "ONE_VERIFIED" as const };
const scenarios = [
  { id: "obtainable-second-signal", whatIf: base, collectionCostMinor: 500, collectionTimeMinutes: 30, availableTimeMinutes: 240 },
  { id: "collection-cost-exceeds-upside", whatIf: base, collectionCostMinor: 8_000, collectionTimeMinutes: 30, availableTimeMinutes: 240 },
  { id: "deadline-window-too-short", whatIf: base, collectionCostMinor: 500, collectionTimeMinutes: 30, availableTimeMinutes: 40 },
  { id: "contradictory-current-evidence", whatIf: { ...base, evidence: "CONTRADICTORY" as const }, collectionCostMinor: 500,
    collectionTimeMinutes: 30, availableTimeMinutes: 240 },
  { id: "evidence-already-sufficient", whatIf: { ...base, evidence: "TWO_VERIFIED" as const }, collectionCostMinor: 500,
    collectionTimeMinutes: 30, availableTimeMinutes: 240 },
];
const result = { schemaVersion: "fair-trial-ft031-value-of-information/v1", generatedAtUtc: new Date().toISOString(),
  evaluatedAtUtc: new Date(now).toISOString(),
  disclosure: "Synthetic bounded policy scenarios only. Scenario assumptions are not forecasts. No probability distribution, case mutation, human approval, or provider action.",
  scenarios: scenarios.map((scenario) => ({ id: scenario.id, ...evaluateValueOfInformation({ whatIf: scenario.whatIf,
    collectionCostMinor: scenario.collectionCostMinor, collectionTimeMinutes: scenario.collectionTimeMinutes,
    availableTimeMinutes: scenario.availableTimeMinutes }, now) })) };
const outputPath = resolve(process.argv[2] ?? "submission/evidence/ft031-voi-scenarios.json");
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, JSON.stringify(result, null, 2) + "\n", "utf8");
console.log(JSON.stringify({ output: outputPath, scenarios: result.scenarios.length,
  conclusions: result.scenarios.map(({ id, conclusion }) => ({ id, conclusion })), providerAction: "NOT_EXECUTED" }));
