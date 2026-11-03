import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createScenarioEvidence } from "../spike/dispute-engine.ts";
import { createDecisionCertificate } from "../spike/decision-certificate.ts";

const snapshot = { caseId: "demo-synthetic-case", amountMinor: 12000, currency: "USD", reason: "FRAUDULENT",
  reasonCode: "10.4", stage: "RFI", status: "REQUIRES_RESPONSE", responseDeadline: "2030-01-01T00:00:00.000Z",
  evidence: createScenarioEvidence("fraud-high-value") };
const economics = { disputeFeeCurrency: "USD", disputeFeeMinor: 2500, lowValueCeilingMinor: 5000,
  highValueFloorMinor: 10000, weakEvidenceWinProbabilityBps: 1500, strongFraudWinProbabilityBps: 8000,
  stageAdjustments: { RFI: { additionalDefenseCostMinor: 0 } } };
const valid = createDecisionCertificate({ revision: 1, snapshot, economics, createdAt: "2026-10-29T00:00:00.000Z" });
const tampered = structuredClone(valid);
tampered.snapshot.amountMinor++;
const dir = resolve("submission/evidence");
mkdirSync(dir, { recursive: true });
for (const [name, value] of [["valid", valid], ["tampered", tampered]] as const)
  writeFileSync(resolve(dir, "decision-certificate-" + name + ".json"), JSON.stringify(value, null, 2), { flag: "w", mode: 0o600 });
console.log(JSON.stringify({ fixtureFiles: ["decision-certificate-valid.json", "decision-certificate-tampered.json"], source: "synthetic offline fixture" }));
