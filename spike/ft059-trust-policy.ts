/** FT059: release-pinned public key manifest; no default trust root in test candidate. */
import {createHash,createPublicKey,type KeyObject} from "node:crypto";
import type {TrustedKeys} from "./ft058-attestation-gate.ts";
export interface KeyPolicy {
 schema:"FT059_RELEASE_TRUST_POLICY_V1";
 environment:"AIRWALLEX_SANDBOX";
 owner:{keyId:string;publicKeyPem:string};
 reviewer:{keyId:string;publicKeyPem:string};
}
const hash=(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest("hex");
export function verifyPinnedTrustPolicy(bytes:Uint8Array,expectedReleaseSha256:string):TrustedKeys {
 if(!/^[a-f0-9]{64}$/.test(expectedReleaseSha256)||
    hash(bytes)!==expectedReleaseSha256)throw Error("FT059_RELEASE_TRUST_PIN_MISMATCH");
 if(bytes.byteLength>8192)throw Error("FT059_TRUST_POLICY_TOO_LARGE");
 const data=JSON.parse(Buffer.from(bytes).toString("utf8")) as KeyPolicy;
 if(data.schema!=="FT059_RELEASE_TRUST_POLICY_V1"||data.environment!=="AIRWALLEX_SANDBOX"||
    !data.owner||!data.reviewer||data.owner.keyId===data.reviewer.keyId||
    !/^[a-zA-Z0-9_-]{6,70}$/.test(data.owner.keyId)||
    !/^[a-zA-Z0-9_-]{6,70}$/.test(data.reviewer.keyId))
    throw Error("FT059_TRUST_POLICY_INVALID");
 const owner:KeyObject=createPublicKey(data.owner.publicKeyPem);
 const reviewer:KeyObject=createPublicKey(data.reviewer.publicKeyPem);
 if(owner.type!=="public"||reviewer.type!=="public"||
    owner.asymmetricKeyType!=="ed25519"||reviewer.asymmetricKeyType!=="ed25519"||
    hash(owner.export({type:"spki",format:"der"}) as Buffer)===
    hash(reviewer.export({type:"spki",format:"der"}) as Buffer))
    throw Error("FT059_TRUST_POLICY_INVALID");
 return Object.freeze({
   ownerKeyId:data.owner.keyId,evidenceKeyId:data.reviewer.keyId,
   ownerPublicKey:owner,evidencePublicKey:reviewer
 });
}
/** This release is not provisioned with a production trust anchor. */
export const FT059_DEPLOYED_TRUST_ANCHOR: null = null;
export function isProductionAttestationEnabled():false{return false;}
