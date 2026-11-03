import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { evaluateW4Preflight, type W4EvidenceItem } from "../spike/w4-preflight.ts";

type CaseFile = {
  providerProvenance: { readStatus: string; paymentIntentFingerprint: string; disputeFingerprint: string };
  dispute: { stage: string; status: string; reasonCode: string; amountMinor: number; currency: string; responseDeadline: string | null };
};
type Matrix = { items: Array<{ id: string; classification: W4EvidenceItem["classification"]; finding: string }> };

const disputeCase = JSON.parse(await readFile(resolve("submission/evidence/airwallex-rfi-023-case.json"), "utf8")) as CaseFile;
const matrix = JSON.parse(await readFile(resolve("submission/evidence/airwallex-rfi-023-evidence-matrix.json"), "utf8")) as Matrix;
const evidence: W4EvidenceItem[] = matrix.items.map((item) => ({
  classification: item.classification,
  category: item.id === "cardholder-authorization" ? "CARDHOLDER_AUTHORIZATION" :
    item.id === "transaction-fulfillment" ? "TRANSACTION_DETAILS" :
    item.id === "customer-history" ? "CUSTOMER_HISTORY" : "OTHER",
  sourceReference: item.id,
  supportsResponse: item.classification === "SYNTHETIC" || item.classification === "UNSUPPORTED",
  contradicted: item.classification === "UNSUPPORTED",
}));
const result = evaluateW4Preflight({
  expectedIdentity: {
    paymentIntentFingerprint: disputeCase.providerProvenance.paymentIntentFingerprint,
    disputeFingerprint: disputeCase.providerProvenance.disputeFingerprint,
    stage: disputeCase.dispute.stage,
    status: disputeCase.dispute.status,
    reasonCode: disputeCase.dispute.reasonCode,
    amountMinor: disputeCase.dispute.amountMinor,
    currency: disputeCase.dispute.currency,
    responseDeadline: disputeCase.dispute.responseDeadline as string,
  },
  freshRead: undefined,
  evidence,
  requestedAction: "CHALLENGE",
  approval: undefined,
  alreadySubmitted: false,
  ambiguousPriorSubmission: false,
  durableDispatchState: "NONE",
  now: Date.now(),
});
console.log(JSON.stringify({
  label: "OFFLINE_PREFLIGHT_OF_SAVED_SANDBOX_SIMULATION_RECEIPT",
  providerRequests: 0,
  providerAction: result.providerAction,
  providerReadStatus: disputeCase.providerProvenance.readStatus,
  recommendation: "HOLD_REQUEST_EVIDENCE_HUMAN_REVIEW",
  humanApprovalRecorded: false,
  requestedAction: result.action,
  allowed: result.allowed,
  blockedReasons: result.reasons,
}, null, 2));
