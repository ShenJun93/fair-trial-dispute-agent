import { createHash } from "node:crypto";
import { fingerprintDisputeDecision, recommendDisputeAction, type DisputeEconomics, type DisputeRecommendation,
  type DisputeSnapshot } from "./dispute-engine.ts";

export type WhatIfDeadline = "SAFE" | "CLOSE" | "PASSED" | "UNKNOWN";
export type WhatIfEvidence = "TWO_VERIFIED" | "ONE_VERIFIED" | "UNVERIFIED" | "CONTRADICTORY";
export interface WhatIfInput {
  stage: "RFI" | "CHARGEBACK";
  feeMinor: number;
  addedDefenseCostMinor: number;
  recoveryRateBps: number;
  deadline: WhatIfDeadline;
  evidence: WhatIfEvidence;
}
export interface WhatIfResult {
  label: "OFFLINE_SYNTHETIC_WHAT_IF";
  evaluatedAtUtc: string;
  input: WhatIfInput;
  recommendation: DisputeRecommendation;
  snapshotFingerprint: string;
  providerAction: "NOT_EXECUTED";
}

export interface ValueOfInformationInput {
  whatIf: WhatIfInput;
  collectionCostMinor: number;
  collectionTimeMinutes: number;
  availableTimeMinutes: number;
}

export interface ValueOfInformationResult {
  label: "OFFLINE_SYNTHETIC_CONDITIONAL_SCENARIOS";
  conclusion: "CONDITIONAL_UPSIDE_REVIEW_OBTAINABILITY" | "NO_POLICY_CHANGE_FROM_MORE_EVIDENCE" |
    "COST_EXCEEDS_CONDITIONAL_UPSIDE" | "TIME_WINDOW_INSUFFICIENT" | "NO_ESTIMATED_FINANCIAL_VALUE";
  baselineAction: DisputeRecommendation["action"];
  positiveFinding: { action: DisputeRecommendation["action"]; changesAction: boolean; expectedNetValueMinor: number | null;
    conditionalNetAfterCollectionCostMinor: number | null };
  noFinding: { action: DisputeRecommendation["action"]; expectedNetValueMinor: number | null };
  assumptions: { collectionCostMinor: number; collectionTimeMinutes: number; availableTimeMinutes: number;
    positiveFindingAssumption: "TWO_VERIFIED_INDEPENDENT_SUPPORTING_SIGNALS";
    noFindingAssumption: "NO_ADDITIONAL_VERIFIED_EVIDENCE" };
  probabilityModel: "NONE_BOUNDED_SCENARIOS_ONLY";
  providerAction: "NOT_EXECUTED";
}

const MAX_FEE_MINOR = 25_000;
const MAX_COST_MINOR = 50_000;
const allowedDeadline = new Set<WhatIfDeadline>(["SAFE", "CLOSE", "PASSED", "UNKNOWN"]);
const allowedEvidence = new Set<WhatIfEvidence>(["TWO_VERIFIED", "ONE_VERIFIED", "UNVERIFIED", "CONTRADICTORY"]);

export function validateWhatIfInput(value: unknown): WhatIfInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_WHAT_IF_INPUT");
  const input = value as Record<string, unknown>;
  if ((input.stage !== "RFI" && input.stage !== "CHARGEBACK") ||
      !Number.isSafeInteger(input.feeMinor) || Number(input.feeMinor) < 0 || Number(input.feeMinor) > MAX_FEE_MINOR ||
      !Number.isSafeInteger(input.addedDefenseCostMinor) || Number(input.addedDefenseCostMinor) < 0 || Number(input.addedDefenseCostMinor) > MAX_COST_MINOR ||
      !Number.isInteger(input.recoveryRateBps) || Number(input.recoveryRateBps) < 0 || Number(input.recoveryRateBps) > 10_000 ||
      !allowedDeadline.has(input.deadline as WhatIfDeadline) || !allowedEvidence.has(input.evidence as WhatIfEvidence) ||
      Object.keys(input).some((key) => !["stage", "feeMinor", "addedDefenseCostMinor", "recoveryRateBps", "deadline", "evidence"].includes(key)))
    throw new Error("INVALID_WHAT_IF_INPUT");
  return Object.freeze({ stage: input.stage, feeMinor: Number(input.feeMinor), addedDefenseCostMinor: Number(input.addedDefenseCostMinor),
    recoveryRateBps: Number(input.recoveryRateBps), deadline: input.deadline as WhatIfDeadline, evidence: input.evidence as WhatIfEvidence });
}

/** Uses the production deterministic policy against a bounded synthetic snapshot; it never persists or executes. */
export function evaluateWhatIf(inputValue: unknown, nowMs: number): WhatIfResult {
  const input = validateWhatIfInput(inputValue);
  if (!Number.isFinite(nowMs)) throw new Error("INVALID_WHAT_IF_CLOCK");
  const deadline = input.deadline === "SAFE" ? new Date(nowMs + 72 * 60 * 60_000).toISOString()
    : input.deadline === "CLOSE" ? new Date(nowMs + 10 * 60_000).toISOString()
      : input.deadline === "PASSED" ? new Date(nowMs - 60_000).toISOString() : undefined;
  const evidence = [
    { id: "what-if-device-1", kind: "DEVICE_AND_3DS_MATCH" as const, supportsMerchant: true, strength: "STRONG" as const,
      summary: "Synthetic device and 3DS signal 1", provenance: { source: "PAYMENT_RISK_SYSTEM" as const, reference: "what-if:device-1",
        observedAt: new Date(nowMs).toISOString(), verified: input.evidence !== "UNVERIFIED", subject: "synthetic-cardholder", context: "synthetic-payment" } },
    { id: "what-if-device-2", kind: "DEVICE_AND_3DS_MATCH" as const, supportsMerchant: true, strength: "STRONG" as const,
      summary: "Synthetic device and 3DS signal 2", provenance: { source: "PAYMENT_RISK_SYSTEM" as const, reference: "what-if:device-2",
        observedAt: new Date(nowMs).toISOString(), verified: input.evidence !== "UNVERIFIED", subject: "synthetic-cardholder", context: "synthetic-payment" } },
  ];
  if (input.evidence === "ONE_VERIFIED") evidence.pop();
  if (input.evidence === "CONTRADICTORY") evidence.push({ ...evidence[0]!, id: "what-if-opposing-signal", supportsMerchant: false,
    summary: "Synthetic opposing signal", provenance: { ...evidence[0]!.provenance, reference: "what-if:opposing-signal" } });
  const snapshot: DisputeSnapshot = { caseId: "synthetic-what-if", amountMinor: 12_000, currency: "USD", reason: "FRAUDULENT", reasonCode: "10.4",
    stage: input.stage, status: "REQUIRES_RESPONSE", ...(deadline ? { responseDeadline: deadline } : {}), evidence };
  const economics: DisputeEconomics = { disputeFeeCurrency: "USD", disputeFeeMinor: input.feeMinor, lowValueCeilingMinor: 5_000,
    highValueFloorMinor: 10_000, weakEvidenceWinProbabilityBps: 1_500, strongFraudWinProbabilityBps: input.recoveryRateBps,
    stageAdjustments: { RFI: { additionalDefenseCostMinor: 0 }, CHARGEBACK: { additionalDefenseCostMinor: input.addedDefenseCostMinor } } };
  const recommendation = recommendDisputeAction(snapshot, economics, nowMs);
  const snapshotFingerprint = fingerprintDisputeDecision(snapshot, recommendation);
  return Object.freeze({ label: "OFFLINE_SYNTHETIC_WHAT_IF", evaluatedAtUtc: new Date(nowMs).toISOString(), input,
    recommendation, snapshotFingerprint, providerAction: "NOT_EXECUTED" });
}

/**
 * Compares the live deterministic policy with bounded hypothetical evidence outcomes.
 * It reports conditional upside only: no likelihood or expected value is inferred.
 */
export function evaluateValueOfInformation(value: unknown, nowMs: number): ValueOfInformationResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_VALUE_OF_INFORMATION_INPUT");
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !["whatIf", "collectionCostMinor", "collectionTimeMinutes", "availableTimeMinutes"].includes(key)) ||
      !Number.isSafeInteger(raw.collectionCostMinor) || Number(raw.collectionCostMinor) < 0 || Number(raw.collectionCostMinor) > MAX_COST_MINOR ||
      !Number.isSafeInteger(raw.collectionTimeMinutes) || Number(raw.collectionTimeMinutes) < 0 || Number(raw.collectionTimeMinutes) > 10_080 ||
      !Number.isSafeInteger(raw.availableTimeMinutes) || Number(raw.availableTimeMinutes) < 0 || Number(raw.availableTimeMinutes) > 10_080)
    throw new Error("INVALID_VALUE_OF_INFORMATION_INPUT");
  const whatIf = validateWhatIfInput(raw.whatIf);
  if (!Number.isFinite(nowMs)) throw new Error("INVALID_WHAT_IF_CLOCK");
  const collectionCostMinor = Number(raw.collectionCostMinor);
  const collectionTimeMinutes = Number(raw.collectionTimeMinutes);
  const availableTimeMinutes = Number(raw.availableTimeMinutes);
  const baseline = evaluateWhatIf(whatIf, nowMs).recommendation;
  const timeAvailable = availableTimeMinutes > collectionTimeMinutes && availableTimeMinutes - collectionTimeMinutes > 15;
  const positive = timeAvailable && whatIf.evidence !== "CONTRADICTORY"
    ? evaluateWhatIf({ ...whatIf, evidence: "TWO_VERIFIED" }, nowMs).recommendation : baseline;
  const noFinding = baseline;
  const changesAction = positive.action !== baseline.action;
  const conditionalNet = positive.expectedNetValueMinor === null ? null : positive.expectedNetValueMinor - collectionCostMinor;
  let conclusion: ValueOfInformationResult["conclusion"];
  if (!timeAvailable) conclusion = "TIME_WINDOW_INSUFFICIENT";
  else if (!changesAction) conclusion = "NO_POLICY_CHANGE_FROM_MORE_EVIDENCE";
  else if (positive.expectedNetValueMinor === null || conditionalNet === null) conclusion = "NO_ESTIMATED_FINANCIAL_VALUE";
  else if (conditionalNet <= 0) conclusion = "COST_EXCEEDS_CONDITIONAL_UPSIDE";
  else conclusion = "CONDITIONAL_UPSIDE_REVIEW_OBTAINABILITY";
  return Object.freeze({ label: "OFFLINE_SYNTHETIC_CONDITIONAL_SCENARIOS", conclusion,
    baselineAction: baseline.action,
    positiveFinding: Object.freeze({ action: positive.action, changesAction, expectedNetValueMinor: positive.expectedNetValueMinor,
      conditionalNetAfterCollectionCostMinor: conditionalNet }),
    noFinding: Object.freeze({ action: noFinding.action, expectedNetValueMinor: noFinding.expectedNetValueMinor }),
    assumptions: Object.freeze({ collectionCostMinor, collectionTimeMinutes, availableTimeMinutes,
      positiveFindingAssumption: "TWO_VERIFIED_INDEPENDENT_SUPPORTING_SIGNALS",
      noFindingAssumption: "NO_ADDITIONAL_VERIFIED_EVIDENCE" }),
    probabilityModel: "NONE_BOUNDED_SCENARIOS_ONLY", providerAction: "NOT_EXECUTED" });
}

export interface ChallengeEvidencePacketInput {
  caseId: string;
  revision: number;
  snapshot: DisputeSnapshot;
  recommendation: DisputeRecommendation;
  evidence: DisputeSnapshot["evidence"];
  decision: { choice: "APPROVE" | "REJECT"; recommendedAction: string; actor: string; createdAt: number;
    idempotencyKey: string; revision: number } | null;
}

/** Produces a local preview only. The packet is permanently marked not submitted and carries the approval snapshot binding. */
export function createChallengeEvidencePacket(input: ChallengeEvidencePacketInput) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.caseId) || !Number.isSafeInteger(input.revision) || input.revision < 1 ||
      input.snapshot.caseId !== input.caseId || !["RFI", "CHARGEBACK"].includes(input.snapshot.stage) || input.snapshot.status !== "REQUIRES_RESPONSE" ||
      input.recommendation.action !== "CHALLENGE" || !input.decision || input.decision.choice !== "APPROVE" ||
      input.decision.recommendedAction !== "CHALLENGE" || input.decision.revision !== input.revision || !input.decision.idempotencyKey)
    throw new Error("CURRENT_SNAPSHOT_CHALLENGE_APPROVAL_REQUIRED");
  const snapshotFingerprint = fingerprintDisputeDecision(input.snapshot, input.recommendation, input.evidence);
  const evidence = input.evidence.map((item) => ({ id: item.id, kind: item.kind, supportsMerchant: item.supportsMerchant,
    strength: item.strength, summary: item.summary, provenance: item.provenance }));
  const payload = { schemaVersion: "fair-trial-challenge-evidence-packet/v1" as const, label: "OFFLINE_SYNTHETIC_PREVIEW" as const,
    caseId: input.caseId, revision: input.revision, stage: input.snapshot.stage, status: input.snapshot.status,
    amountMinor: input.snapshot.amountMinor, currency: input.snapshot.currency, reasonCode: input.snapshot.reasonCode,
    recommendation: { action: input.recommendation.action, reasonCodes: input.recommendation.reasonCodes,
      expectedRecoveryMinor: input.recommendation.expectedRecoveryMinor, expectedNetValueMinor: input.recommendation.expectedNetValueMinor,
      disputeFeeMinor: input.recommendation.disputeFeeMinor },
    evidence, snapshotFingerprint,
    localApproval: { state: "APPROVED_FOR_LOCAL_REVIEW" as const,
      actorReferenceSha256: createHash("sha256").update(input.decision.actor, "utf8").digest("hex"),
      approvedAt: new Date(input.decision.createdAt).toISOString(),
      approvalReference: input.decision.idempotencyKey, revision: input.decision.revision, snapshotFingerprint },
    submission: { state: "NOT_SUBMITTED" as const, provider: "Airwallex", providerAction: "NOT_EXECUTED" as const } };
  const packetSha256 = createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
  return Object.freeze({ ...payload, packetSha256 });
}
