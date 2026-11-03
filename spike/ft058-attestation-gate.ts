/**
 * FT058 public-key evidence + owner-action verifier.
 * Performs NO network calls, signatures are NOT provider receipts.
 * Private signing keys never enter this module. Distinct trusted verifiers
 * must separately attest the evidence and an action-scoped owner approval.
 */
import { createHash, createPublicKey, timingSafeEqual, verify, type KeyObject } from "node:crypto";
import { intentDigest, type IndependentGate, type OwnerOneShot, type VerifiedIntent } from "./ft057-sandbox-boundary.ts";

type Canonical = null | boolean | number | string | Canonical[] | {readonly [name:string]:Canonical};
export interface Signed<T> {
  keyId:string;
  payload:T;
  signature:string;
}
export interface EvidenceAttestation {
  schema:"FT058_EVIDENCE_ATTESTATION_V1";
  intentDigest:string;
  fileIds:string[];
  evidenceSha256:string;
  providerUploadReadbackReceiptSha256:string;
  providerEnvironment:"AIRWALLEX_SANDBOX";
  sourceKind:"OWNER_REVIEWED_FILE_SERVICE_READBACK";
  issuedAt:number;
  expiresAt:number;
  reviewerId:string;
}
export interface OwnerActionAttestation {
  schema:"FT058_OWNER_APPROVAL_ATTESTATION_V1";
  intentDigest:string;
  approvalId:string;
  actor:string;
  action:"CHALLENGE";
  issuedAt:number;
  expiresAt:number;
  ownerId:string;
}
export interface SignedAttestations{
  owner:Signed<OwnerActionAttestation>;
  evidence:Signed<EvidenceAttestation>;
}
export interface TrustedKeys{
  ownerKeyId:string;
  evidenceKeyId:string;
  ownerPublicKey:string|KeyObject;
  evidencePublicKey:string|KeyObject;
}
const sha=(value:string)=>createHash("sha256").update(value).digest("hex");
const hex64=(value:unknown)=>typeof value==="string"&&/^[a-f0-9]{64}$/.test(value);
const same=(a:string,b:string)=>a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
export function canonicalJson(value:unknown):string {
  function walk(v:unknown,depth:number):Canonical{
    if(depth>20)throw Error("FT058_DOCUMENT_TOO_DEEP");
    if(v===null||typeof v==="string"||typeof v==="boolean")return v;
    if(typeof v==="number"&&Number.isSafeInteger(v))return v;
    if(Array.isArray(v))return v.map(x=>walk(x,depth+1));
    if(v&&typeof v==="object"&&Object.getPrototypeOf(v)===Object.prototype){
      const raw=v as Record<string,unknown>;
      const out:Record<string,Canonical>=Object.create(null);
      for(const k of Object.keys(raw).sort()){
        if(k==="__proto__"||k==="constructor"||k==="prototype")throw Error("FT058_UNSAFE_PROPERTY");
        out[k]=walk(raw[k],depth+1);
      }
      return out;
    }
    throw Error("FT058_INVALID_SIGNED_PAYLOAD");
  }
  return JSON.stringify(walk(value,0));
}
export function envelopeMessage(domain:"owner"|"evidence",payload:unknown):Buffer {
  return Buffer.from("FairTrial-FT058-"+domain+"\n"+canonicalJson(payload),"utf8");
}
function verifyEd25519<T>(x:Signed<T>,keyId:string,pub:KeyObject,domain:"owner"|"evidence"):boolean{
  if(!x||x.keyId!==keyId||typeof x.signature!=="string"||!/^[A-Za-z0-9_-]{86}$/.test(x.signature))return false;
  try {
    const signature=Buffer.from(x.signature,"base64url");
    return signature.length===64&&verify(null,envelopeMessage(domain,x.payload),pub,signature);
  }catch{return false;}
}
export function createTrustedAttestationGate(
  keys:TrustedKeys,
  claims:SignedAttestations,
  at:()=>number,
):IndependentGate {
  if(!keys || keys.ownerKeyId===keys.evidenceKeyId ||
     !/^[\w-]{5,70}$/.test(keys.ownerKeyId) || !/^[\w-]{5,70}$/.test(keys.evidenceKeyId))
    throw Error("FT058_SIGNER_ROLES_NOT_SEPARATE");
  const ownerKey=typeof keys.ownerPublicKey==="string"?
    createPublicKey(keys.ownerPublicKey):keys.ownerPublicKey;
  const evidenceKey=typeof keys.evidencePublicKey==="string"?
    createPublicKey(keys.evidencePublicKey):keys.evidencePublicKey;
  if(ownerKey.type!=="public"||evidenceKey.type!=="public")
    throw Error("FT058_SIGNER_ROLES_NOT_SEPARATE");
  if(ownerKey.asymmetricKeyType!=="ed25519"||evidenceKey.asymmetricKeyType!=="ed25519"||
     same(sha(ownerKey.export({format:"pem",type:"spki"}).toString()),
          sha(evidenceKey.export({format:"pem",type:"spki"}).toString())))
    throw Error("FT058_SIGNER_ROLES_NOT_SEPARATE");
  return {
    async authenticate(intent:Readonly<VerifiedIntent>,approval:Readonly<OwnerOneShot>):Promise<boolean>{
      try {
        const now=at();
        if(!Number.isSafeInteger(now)||!intent||!approval||!claims?.owner||!claims?.evidence)return false;
        if(!verifyEd25519(claims.owner,keys.ownerKeyId,ownerKey,"owner") ||
           !verifyEd25519(claims.evidence,keys.evidenceKeyId,evidenceKey,"evidence"))return false;
        const a=claims.owner.payload,e=claims.evidence.payload,d=intentDigest(intent);
        if(a.schema!=="FT058_OWNER_APPROVAL_ATTESTATION_V1" ||
           e.schema!=="FT058_EVIDENCE_ATTESTATION_V1"||
           a.action!=="CHALLENGE"||e.providerEnvironment!=="AIRWALLEX_SANDBOX"||
           e.sourceKind!=="OWNER_REVIEWED_FILE_SERVICE_READBACK")return false;
        if(!hex64(a.intentDigest)||!hex64(e.intentDigest)||
           !same(a.intentDigest,d)||!same(e.intentDigest,d)||
           !same(a.intentDigest,approval.intentDigest)||!same(e.evidenceSha256,intent.evidenceSha256))return false;
        if(a.approvalId!==approval.approvalId||a.actor!==intent.actor||a.actor!==approval.actor||
           typeof a.ownerId!=="string"||a.ownerId.length<5||
           typeof e.reviewerId!=="string"||e.reviewerId.length<5||
           a.ownerId===e.reviewerId)return false;
        if(!hex64(e.providerUploadReadbackReceiptSha256) ||
           !Array.isArray(e.fileIds) || e.fileIds.length!==intent.evidenceFileIds.length ||
           new Set(e.fileIds).size!==e.fileIds.length ||
           [...e.fileIds].sort().join("\n")!==[...intent.evidenceFileIds].sort().join("\n"))return false;
        if(a.issuedAt!==approval.approvedAt||a.expiresAt!==approval.expiresAt||
           !Number.isSafeInteger(a.issuedAt)||a.issuedAt>now||
           !Number.isSafeInteger(a.expiresAt)||a.expiresAt<=now||
           a.expiresAt-a.issuedAt>5*60_000 ||
           !Number.isSafeInteger(e.issuedAt)||e.issuedAt>now||
           !Number.isSafeInteger(e.expiresAt)||e.expiresAt<=now||
           now-e.issuedAt>2*60_000||e.expiresAt-e.issuedAt>2*60_000)return false;
        return true;
      }catch{return false;}
    }
  };
}
