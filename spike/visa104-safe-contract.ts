/**
 * FT055: PURE OFFLINE CONTRACT for a Visa 10.4 RFI, not an Airwallex execution adapter.
 * No provider credentials, URLs, network calls, or mutating endpoints.
 * Verified flags in externally supplied objects are NOT sufficient proof of authenticity:
 * final execution requires separately attested provider receipts and its own implementation.
 */
import { createHash } from "node:crypto";
import type { HistoricalProviderCase } from "./historical-provider-portfolio.ts";

export interface Visa104Identity {
  disputeFingerprint: string;
  paymentFingerprint: string;
  reasonCode: "10.4";
  reasonType: "FRAUDULENT";
  stage: "RFI";
  status: "REQUIRES_RESPONSE";
  currency: "USD";
  amountMinor: number;
  dueAt: string;
}
export type EvidenceCategory =
  | "CARDHOLDER_AUTHORIZATION" | "TRANSACTION_DETAILS" | "FULFILLMENT"
  | "DEVICE_IP" | "CUSTOMER_COMMUNICATION" | "PRIOR_TRANSACTION_HISTORY";
export interface Visa104Evidence {
  category: EvidenceCategory;
  classification: "VERIFIED" | "UNVERIFIED" | "SYNTHETIC" | "UNSUPPORTED";
  sourceSha256: string;
  sourceReference: string;
  contradictsCase: boolean;
  airwallexFileId?: string;
  fileUploadReceiptSha256?: string;
  verifiedFileServiceReadback?: boolean;
  mimeType?: string;
  sizeBytes?: number;
}
export interface Visa104FreshRead {
  origin: "AIRWALLEX_SANDBOX";
  readOnly: true;
  retrievedAt: number;
  identity: Visa104Identity;
  identityMatched: boolean;
  // Raw dispute IDs are deliberately NOT permitted in public receipts.
}
export interface Visa104OwnerApproval {
  action: "CHALLENGE";
  identityAndEvidenceDigest: string;
  approvedAt: number;
  expiresAt: number;
  actor: string;
  approvalId: string;
  consumed: boolean;
}
export interface Visa104Preflight {
  identity: Visa104Identity;
  freshRead?: Visa104FreshRead;
  evidence: readonly Visa104Evidence[];
  ownerApproval?: Visa104OwnerApproval;
  dispatchState: "NONE" | "RESERVED" | "AMBIGUOUS" | "COMPLETE";
  alreadySubmitted: boolean;
  ce30Claimed: boolean;
  now: number;
}
export interface Visa104ContractResult {
  schema: "FT055_VISA_104_OFFLINE_PREFLIGHT_V1";
  intendedAction: "CHALLENGE";
  environment: "SANDBOX_ONLY";
  allowed: false;
  providerAction: "NOT_EXECUTED";
  providerCallCount: 0;
  evidenceUploadCount: 0;
  reasons: readonly string[];
  outputClassification: "OFFLINE_REVIEW_ONLY";
  ce30Certified: false;
  // Never includes raw provider IDs or an executable request payload.
  draftChallengePayload: null;
}
const hex16 = (s: unknown): s is string => typeof s === "string" && /^[a-f0-9]{16}$/.test(s);
const hex64 = (s: unknown): s is string => typeof s === "string" && /^[a-f0-9]{64}$/.test(s);
const validZonedTime = (x: unknown): x is string =>
  typeof x === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(x) &&
  Number.isFinite(Date.parse(x)) && new Date(Date.parse(x)).toISOString().startsWith("20");
function identityDigest(identity: Visa104Identity): string {
  return createHash("sha256").update(JSON.stringify([
    identity.disputeFingerprint,identity.paymentFingerprint,identity.reasonCode,identity.reasonType,
    identity.stage,identity.status,identity.amountMinor,identity.currency,identity.dueAt
  ])).digest("hex");
}
function validIdentity(i: Visa104Identity): boolean {
  return !!i && hex16(i.disputeFingerprint) && hex16(i.paymentFingerprint) &&
    i.reasonCode === "10.4" && i.reasonType === "FRAUDULENT" && i.stage === "RFI" &&
    i.status === "REQUIRES_RESPONSE" && i.currency === "USD" && i.amountMinor === 12000 &&
    validZonedTime(i.dueAt);
}
/** Approval is tied to the case AND every evidence fingerprint/File ID; any change invalidates it. */
export function visa104ReviewDigest(identity: Visa104Identity, evidence: readonly Visa104Evidence[]): string {
  const records = Array.isArray(evidence) ? evidence.map(e => [
    e?.category,e?.classification,e?.sourceSha256,e?.sourceReference,e?.contradictsCase,
    e?.airwallexFileId,e?.fileUploadReceiptSha256,e?.verifiedFileServiceReadback,e?.mimeType,e?.sizeBytes
  ]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))) : ["INVALID"];
  return createHash("sha256").update(JSON.stringify([identityDigest(identity),records])).digest("hex");
}
export function visa104FromHistoricalCase(item: HistoricalProviderCase): Visa104Identity {
  if (item.caseKey !== "historical-visa-fraud-rfi" || item.brand !== "VISA" ||
      item.reasonCode !== "10.4" || item.stage !== "RFI" ||
      item.providerStatus !== "REQUIRES_RESPONSE" || item.amountMinor !== 12000 ||
      item.currency !== "USD" || !item.responseDeadline || !hex16(item.paymentFingerprint) ||
      !hex16(item.disputeFingerprint)) {
    throw new Error("FT055_INVALID_HISTORICAL_CASE");
  }
  return {
    disputeFingerprint: item.disputeFingerprint, paymentFingerprint: item.paymentFingerprint,
    reasonCode:"10.4", reasonType:"FRAUDULENT", stage:"RFI",status:"REQUIRES_RESPONSE",
    currency:"USD",amountMinor:item.amountMinor,dueAt:item.responseDeadline
  };
}
export function evaluateVisa104OfflinePreflight(input: Visa104Preflight): Visa104ContractResult {
  const reasons:string[] = [];
  const identity = input?.identity;
  const clockValid = Number.isFinite(input?.now);
  const identityOk = validIdentity(identity);
  if(!identityOk) reasons.push("CASE_IDENTITY_NOT_VERIFIED");
  if(!clockValid) reasons.push("CLOCK_INVALID");
  if(identityOk && clockValid) {
    const timeLeft = Date.parse(identity.dueAt)-input.now;
    if(timeLeft <= 0) reasons.push("PROVIDER_DEADLINE_EXPIRED");
    else if(timeLeft <= 15*60_000) reasons.push("PROVIDER_DEADLINE_TOO_CLOSE");
  }
  const read = input?.freshRead;
  const readOk = !!read && read.origin==="AIRWALLEX_SANDBOX" && read.readOnly===true &&
    read.identityMatched===true && identityOk && validIdentity(read.identity) &&
    identityDigest(read.identity)===identityDigest(identity) && clockValid &&
    Number.isFinite(read.retrievedAt) && read.retrievedAt<=input.now &&
    input.now-read.retrievedAt<=2*60_000;
  if(!readOk) reasons.push("FRESH_MATCHED_PROVIDER_READ_REQUIRED");

  const evidence = Array.isArray(input?.evidence) ? input.evidence : [];
  if(!Array.isArray(input?.evidence)) reasons.push("EVIDENCE_INPUT_INVALID");
  const admissible = evidence.filter(e=>e && e.classification==="VERIFIED" &&
    hex64(e.sourceSha256) && typeof e.sourceReference==="string" && e.sourceReference.length>4 &&
    e.contradictsCase===false);
  if(!admissible.some(e=>e.category==="CARDHOLDER_AUTHORIZATION"))
    reasons.push("VERIFIED_AUTHORIZATION_EVIDENCE_MISSING");
  if(!admissible.some(e=>e.category==="TRANSACTION_DETAILS"))
    reasons.push("VERIFIED_TRANSACTION_EVIDENCE_MISSING");
  if(!admissible.some(e=>e.category==="FULFILLMENT" || e.category==="DEVICE_IP" || e.category==="CUSTOMER_COMMUNICATION"))
    reasons.push("INDEPENDENT_FULFILLMENT_OR_CUSTOMER_SIGNAL_MISSING");

  if(evidence.some(e=>!e || e.classification==="SYNTHETIC"||e.classification==="UNSUPPORTED"))
    reasons.push("SYNTHETIC_OR_UNSUPPORTED_EVIDENCE_REJECTED");
  if(evidence.some(e=>e && e.contradictsCase===true))
    reasons.push("CONTRADICTORY_EVIDENCE_REQUIRES_HUMAN_REVIEW");

  // Airwallex RFI challenge expects File Service evidence IDs from an authenticated upload.
  // Merely passing arbitrary strings is insufficient to prove these IDs came from Airwallex.
  const uploaded = admissible.filter(e=>typeof e.airwallexFileId==="string" &&
    e.airwallexFileId.trim().length>=8 && hex64(e.fileUploadReceiptSha256) &&
    e.verifiedFileServiceReadback===true);
  if(uploaded.length===0) reasons.push("FILE_SERVICE_UPLOAD_AND_READBACK_EVIDENCE_MISSING");
  // Conservative Visa evidence limits from Airwallex's documented dispute guidance.
  // This check is necessary but not sufficient: the provider must independently validate the files.
  const limits:Record<string,number>={"application/pdf":2_000_000,"image/jpeg":10_000_000,"image/tiff":10_000_000};
  if(uploaded.some(e=>!(typeof e.mimeType==="string" && limits[e.mimeType] &&
     Number.isSafeInteger(e.sizeBytes) && Number(e.sizeBytes)>0 &&
     Number(e.sizeBytes)<=(limits[e.mimeType]??0))))
    reasons.push("VISA_FILE_FORMAT_OR_SIZE_UNVERIFIED");
  if(uploaded.reduce((sum,e)=>sum+(Number.isSafeInteger(e.sizeBytes)?Number(e.sizeBytes):0),0)>15_000_000)
    reasons.push("VISA_TOTAL_FILE_SIZE_LIMIT_EXCEEDED");
  // Even verified-looking test records cannot authorize real submission by this pure module.
  if(uploaded.length) reasons.push("EXTERNAL_FILE_ID_PROVENANCE_REQUIRES_INDEPENDENT_ATTESTATION");
  if(input?.ce30Claimed) reasons.push("VISA_CE30_NOT_INDEPENDENTLY_VERIFIED");
  if(input?.alreadySubmitted!==false) reasons.push("ACTION_ALREADY_SUBMITTED_OR_UNKNOWN");
  if(input?.dispatchState==="AMBIGUOUS") reasons.push("AMBIGUOUS_DISPATCH_MANUAL_RECONCILIATION");
  if(input?.dispatchState!=="NONE") reasons.push("DURABLE_DISPATCH_FENCE_BLOCKED");
  const approval = input?.ownerApproval;
  const approvalOk=identityOk && !!approval && approval.action==="CHALLENGE" &&
    approval.identityAndEvidenceDigest===visa104ReviewDigest(identity,evidence) &&
    typeof approval.actor==="string"&&approval.actor.trim().length>0 &&
    typeof approval.approvalId==="string"&&approval.approvalId.trim().length>0 &&
    Number.isFinite(approval.approvedAt)&&clockValid &&
    approval.approvedAt<=input.now && Number.isFinite(approval.expiresAt) &&
    approval.expiresAt>input.now && approval.consumed===false;
  if(!approvalOk) reasons.push("ACTION_SPECIFIC_OWNER_APPROVAL_REQUIRED");

  reasons.push("PROVIDER_EXECUTION_NOT_IMPLEMENTED");
  return Object.freeze({
    schema:"FT055_VISA_104_OFFLINE_PREFLIGHT_V1",intendedAction:"CHALLENGE",
    environment:"SANDBOX_ONLY",allowed:false,providerAction:"NOT_EXECUTED",
    providerCallCount:0,evidenceUploadCount:0,
    reasons:Object.freeze([...new Set(reasons)]),outputClassification:"OFFLINE_REVIEW_ONLY",
    ce30Certified:false,draftChallengePayload:null
  });
}
