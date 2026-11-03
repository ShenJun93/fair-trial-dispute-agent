/**
 * FT056: Airwallex STANDARD challenge request-shape rehearsal.
 * This module intentionally supports MOCK_* identifiers only and has NO network dependency.
 * Schema source: https://www.airwallex.com/docs/api/payments/payment_disputes/api
 * POST /api/v1/pa/payment_disputes/{id}/challenge
 */
import { createHash, randomUUID } from "node:crypto";

export type DocumentType = "PRIMARY" | "ORDER" | "CUSTOMER" | "OTHER";
export interface MockDocument {
  type: DocumentType;
  fileId: string;
  sourceHash: string;
  description: string;
  synthetic: true;
}
export interface MockChallengePlan {
  caseKey: string;
  disputeId: string;
  dueAt: string;
  stage: "RFI";
  status: "REQUIRES_RESPONSE";
  reasonCode: "10.4";
  amountMinor: 12000;
  currency: "USD";
  documents: readonly MockDocument[];
}
export interface StandardChallengeBody {
  request_id: string;
  challenge_method: "STANDARD";
  reason: "OTHER_REASONS";
  challenged_by: string;
  supporting_documents: {
    documents: { type: DocumentType; file_ids: string[]; description: string }[];
  };
}
const safeCase = (s:unknown)=>typeof s==="string" && /^mock_case_[a-z0-9_-]{6,45}$/.test(s);
const sha64 = (s:unknown)=>typeof s==="string" && /^[a-f0-9]{64}$/.test(s);
const validDoc = (d:MockDocument)=>d && d.synthetic===true &&
  ["PRIMARY","ORDER","CUSTOMER","OTHER"].includes(d.type) &&
  typeof d.fileId==="string" && /^mock_file_[a-z0-9_-]{5,45}$/.test(d.fileId) &&
  sha64(d.sourceHash) && typeof d.description==="string" &&
  d.description.length>=8 && d.description.length<=180;
export function validateMockChallengePlan(plan:MockChallengePlan,now:number):readonly string[] {
  const errors:string[]=[];
  if(!plan || !safeCase(plan.caseKey) || !/^mock_dst_[a-z0-9_-]{6,50}$/.test(plan.disputeId) ||
    plan.stage!=="RFI" || plan.status!=="REQUIRES_RESPONSE" ||
    plan.reasonCode!=="10.4" || plan.amountMinor!==12000 || plan.currency!=="USD")
    errors.push("MOCK_CASE_IDENTITY_INVALID");
  if(!Number.isFinite(now) || typeof plan?.dueAt!=="string" ||
    !Number.isFinite(Date.parse(plan.dueAt)) ||
    Date.parse(plan.dueAt)-now<=15*60_000)
    errors.push("MOCK_DEADLINE_INVALID_OR_TOO_CLOSE");
  if(!Array.isArray(plan?.documents) || plan.documents.length<1 ||
    plan.documents.length>12 || plan.documents.some(d=>!validDoc(d)))
    errors.push("MOCK_DOCUMENTS_INVALID");
  if(Array.isArray(plan?.documents) && new Set(plan.documents.map(d=>d?.fileId)).size !== plan.documents.length)
    errors.push("DUPLICATE_MOCK_FILE_IDS");
  return Object.freeze(errors);
}
export function mockPlanDigest(plan:MockChallengePlan):string {
  return createHash("sha256").update(JSON.stringify([
    plan.caseKey,plan.disputeId,plan.dueAt,plan.stage,plan.status,
    plan.reasonCode,plan.amountMinor,plan.currency,
    [...plan.documents].map(d=>[d.type,d.fileId,d.sourceHash,d.description,d.synthetic])
      .sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))
  ])).digest("hex");
}
export function buildMockStandardChallenge(plan:MockChallengePlan,now:number,actor:string,requestId=randomUUID()):StandardChallengeBody{
  const failures=validateMockChallengePlan(plan,now);
  if(failures.length)throw new Error("MOCK_CHALLENGE_PLAN_REJECTED:"+failures.join(","));
  if(typeof actor!=="string" || !/^mock_owner_[a-z0-9_-]{4,35}$/.test(actor))throw new Error("MOCK_ACTOR_REQUIRED");
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId))
    throw new Error("INVALID_REQUEST_ID");
  return {
    request_id:requestId,challenge_method:"STANDARD",reason:"OTHER_REASONS",
    challenged_by:actor,
    supporting_documents:{documents:plan.documents.map(d=>({
      type:d.type,file_ids:[d.fileId],description:d.description
    }))}
  };
}
