/** Pure fail-closed W4 gate evaluation. This module has no provider or network client. */
export type W4Action = "CHALLENGE" | "ACCEPT" | "REFUND";
export interface W4CaseIdentity {
  paymentIntentFingerprint: string;
  disputeFingerprint: string;
  stage: string;
  status: string;
  reasonCode: string;
  amountMinor: number;
  currency: string;
  responseDeadline: string;
}
export interface W4FreshRead {
  source: "AIRWALLEX";
  retrievedAt: number;
  identity: W4CaseIdentity;
  identityMatched: boolean;
}
export interface W4EvidenceItem {
  classification: "VERIFIED" | "SYNTHETIC" | "MISSING" | "UNSUPPORTED";
  category: "CARDHOLDER_AUTHORIZATION" | "CUSTOMER_HISTORY" | "TRANSACTION_DETAILS" | "CUSTOMER_COMMUNICATION" | "FULFILLMENT" | "OTHER";
  sourceReference: string;
  supportsResponse: boolean;
  contradicted: boolean;
  /** Required only for a 4837 prior-purchase footprint; values must come from source records. */
  qualifyingPriorTransactionAgesDays?: readonly number[];
  sameMerchant?: boolean;
  noActiveFraudDispute?: boolean;
  matchedCoreDataElementCount?: number;
  matchingIncludesIpOrDevice?: boolean;
}
export interface W4ActionApproval {
  action: W4Action;
  caseIdentityFingerprint: string;
  actor: string;
  approvalId: string;
  approvedAt: number;
  expiresAt: number;
  consumed: boolean;
}
export interface W4PreflightInput {
  expectedIdentity: W4CaseIdentity;
  freshRead?: W4FreshRead;
  evidence: readonly W4EvidenceItem[];
  requestedAction: W4Action;
  approval?: W4ActionApproval;
  alreadySubmitted: boolean;
  ambiguousPriorSubmission: boolean;
  durableDispatchState: "NONE" | "RESERVED" | "AMBIGUOUS" | "COMPLETE";
  now: number;
}
export interface W4PreflightResult {
  allowed: false;
  action: W4Action;
  reasons: readonly string[];
  providerAction: "NOT_EXECUTED";
}

function stableIdentity(value: W4CaseIdentity): string {
  return JSON.stringify([value.paymentIntentFingerprint, value.disputeFingerprint, value.stage,
    value.status, value.reasonCode, value.amountMinor, value.currency, value.responseDeadline]);
}
function validDeadline(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) return false;
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  const calendar = new Date(Date.UTC(year!, month! - 1, day!));
  return calendar.getUTCFullYear() === year && calendar.getUTCMonth() + 1 === month && calendar.getUTCDate() === day;
}

/** This gate intentionally never returns allowed=true: provider execution is not implemented here. */
export function evaluateW4Preflight(input: W4PreflightInput): W4PreflightResult {
  const reasons: string[] = [];
  const expected = input.expectedIdentity;
  const identityValid = !!expected && typeof expected.paymentIntentFingerprint === "string" &&
    typeof expected.disputeFingerprint === "string" && typeof expected.stage === "string" && typeof expected.status === "string" &&
    typeof expected.reasonCode === "string" && typeof expected.currency === "string" && validDeadline(expected.responseDeadline) &&
    /^[a-f0-9]{16}$/.test(expected.paymentIntentFingerprint) &&
    /^[a-f0-9]{16}$/.test(expected.disputeFingerprint) && expected.stage === "RFI" &&
    expected.status === "REQUIRES_RESPONSE" && expected.reasonCode === "4837" &&
    Number.isSafeInteger(expected.amountMinor) && expected.amountMinor > 0 && expected.currency === "USD" &&
    Number.isFinite(Date.parse(expected.responseDeadline));
  if (!identityValid) reasons.push("CASE_IDENTITY_INCOMPLETE_OR_INVALID");
  if (identityValid) {
    if (!Number.isFinite(input.now)) reasons.push("INVALID_CLOCK");
    else {
      const deadlineMs = Date.parse(expected.responseDeadline);
      if (input.now >= deadlineMs) reasons.push("RESPONSE_DEADLINE_EXPIRED");
      else if (deadlineMs - input.now <= 15 * 60_000) reasons.push("RESPONSE_DEADLINE_TOO_CLOSE");
    }
  }

  const read = input.freshRead;
  const readFresh = !!read && read.source === "AIRWALLEX" && read.identityMatched === true &&
    Number.isFinite(read.retrievedAt) && Number.isFinite(input.now) && read.retrievedAt <= input.now &&
    input.now - read.retrievedAt <= 2 * 60_000 && !!read.identity && identityValid &&
    stableIdentity(read.identity) === stableIdentity(expected) && read.identity.status === "REQUIRES_RESPONSE";
  if (!readFresh) reasons.push("FRESH_PROVIDER_IDENTITY_READ_REQUIRED");

  if (input.requestedAction === "CHALLENGE") {
    const evidence = Array.isArray(input.evidence) ? input.evidence.filter((item) => !!item && typeof item === "object") : [];
    if (!Array.isArray(input.evidence)) reasons.push("EVIDENCE_INPUT_INVALID");
    const admissible = evidence.filter((item) => item.classification === "VERIFIED" &&
      item.supportsResponse === true && item.contradicted === false && typeof item.sourceReference === "string" && !!item.sourceReference.trim());
    if (!admissible.some((item) => item.category === "CARDHOLDER_AUTHORIZATION"))
      reasons.push("VERIFIED_CARDHOLDER_AUTHORIZATION_EVIDENCE_REQUIRED");
    if (!admissible.some((item) => item.category === "TRANSACTION_DETAILS"))
      reasons.push("VERIFIED_TRANSACTION_DETAILS_REQUIRED");
    const qualifyingHistory = admissible.find((item) => item.category === "CUSTOMER_HISTORY" &&
      Array.isArray(item.qualifyingPriorTransactionAgesDays) && item.qualifyingPriorTransactionAgesDays.length >= 2 &&
      item.qualifyingPriorTransactionAgesDays.every((age: number) => Number.isInteger(age) && age >= 120 && age <= 365) &&
      item.sameMerchant === true && item.noActiveFraudDispute === true &&
      Number.isInteger(item.matchedCoreDataElementCount) && Number(item.matchedCoreDataElementCount) >= 2 &&
      item.matchingIncludesIpOrDevice === true);
    if (!qualifyingHistory) reasons.push("QUALIFYING_CUSTOMER_HISTORY_REQUIRED_FOR_4837");
    if (evidence.some((item) => item.classification === "SYNTHETIC" && item.supportsResponse === true))
      reasons.push("SYNTHETIC_EVIDENCE_NOT_ADMISSIBLE");
    if (evidence.some((item) => item.classification === "UNSUPPORTED" && item.supportsResponse === true))
      reasons.push("UNSUPPORTED_EVIDENCE_CLAIM_PRESENT");
    if (evidence.some((item) => item.classification === "VERIFIED" && item.contradicted === true))
      reasons.push("CONTRADICTORY_VERIFIED_EVIDENCE");
  }

  const approval = input.approval;
  if (!approval || approval.action !== input.requestedAction || typeof approval.actor !== "string" || !approval.actor.trim() ||
      typeof approval.approvalId !== "string" || !approval.approvalId.trim() ||
      approval.caseIdentityFingerprint !== stableIdentity(expected) || !Number.isFinite(approval.approvedAt) ||
      approval.approvedAt > input.now || !Number.isFinite(approval.expiresAt) || approval.expiresAt <= input.now || approval.consumed)
    reasons.push("ACTION_SPECIFIC_OWNER_APPROVAL_REQUIRED");

  if (input.alreadySubmitted !== false) reasons.push("ACTION_ALREADY_SUBMITTED");
  if (input.ambiguousPriorSubmission !== false || input.durableDispatchState === "AMBIGUOUS") reasons.push("AMBIGUOUS_PRIOR_DISPATCH_REQUIRES_MANUAL_RECONCILIATION");
  if (input.durableDispatchState !== "NONE") reasons.push("DURABLE_DISPATCH_FENCE_NOT_CLEAR");
  if (!reasons.length) reasons.push("PROVIDER_EXECUTION_NOT_IMPLEMENTED");
  return Object.freeze({ allowed: false, action: input.requestedAction, reasons: Object.freeze([...new Set(reasons)]), providerAction: "NOT_EXECUTED" });
}

export function fingerprintW4CaseIdentity(identity: W4CaseIdentity): string { return stableIdentity(identity); }
