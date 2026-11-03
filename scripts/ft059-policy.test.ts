import test from "node:test";
import assert from "node:assert/strict";
import {generateKeyPairSync} from "node:crypto";
import {verifyPinnedTrustPolicy,FT059_DEPLOYED_TRUST_ANCHOR,isProductionAttestationEnabled} from "../spike/ft059-trust-policy.ts";
import {evaluateFileEvidence,sourceHash} from "../spike/ft059-file-provenance.ts";
test("pinned release policy binds distinct Ed25519 keys",()=>{
 const a=generateKeyPairSync("ed25519"),b=generateKeyPairSync("ed25519");
 const encoded=Buffer.from(JSON.stringify({
  schema:"FT059_RELEASE_TRUST_POLICY_V1",environment:"AIRWALLEX_SANDBOX",
  owner:{keyId:"merchant-owner-01",publicKeyPem:a.publicKey.export({type:"spki",format:"pem"}).toString()},
  reviewer:{keyId:"merchant-reviewer-01",publicKeyPem:b.publicKey.export({type:"spki",format:"pem"}).toString()}
 }));
 const pin=sourceHash(encoded);
 const parsed=verifyPinnedTrustPolicy(encoded,pin);
 assert.equal(parsed.ownerKeyId,"merchant-owner-01");
 assert.throws(()=>verifyPinnedTrustPolicy(Buffer.from(encoded.toString().replace("merchant-reviewer-01","forged-reviewer-01")),pin),
   /FT059_RELEASE_TRUST_PIN_MISMATCH/);
 assert.throws(()=>verifyPinnedTrustPolicy(encoded,sourceHash(Buffer.from("wrong"))),
   /FT059_RELEASE_TRUST_PIN_MISMATCH/);
 assert.equal(FT059_DEPLOYED_TRUST_ANCHOR,null);
 assert.equal(isProductionAttestationEnabled(),false);
});
const fixture=()=>{
 const bytes=Buffer.from("SYNTHETIC OFFLINE EVIDENCE");
 return {
  ids:["sandbox_file_ref_01"],
  local:[{fileId:"sandbox_file_ref_01",sha256:sourceHash(bytes),bytes,
    contentType:"application/pdf",filename:"test.pdf"}],
  metadata:[{file_id:"sandbox_file_ref_01",content_type:"application/pdf",filename:"test.pdf",size:bytes.length}],
  remoteBytes:[{fileId:"sandbox_file_ref_01",bytes:Buffer.from(bytes)}],
  absentFiles:[]
 };
};
test("matching local and injected readback is OFFLINE_MATCH, never provider verification",()=>{
 const r=evaluateFileEvidence(fixture());
 assert.equal(r.status,"OFFLINE_MATCH_ONLY");
 assert.equal(r.liveProviderVerified,false);
 assert.deepEqual(r.failures,[]);
});
test("content mismatch, absent file, duplicate metadata, invalid size all block",()=>{
 const a=fixture();
 assert.equal(evaluateFileEvidence({...a,remoteBytes:[{fileId:a.ids[0]!,bytes:Buffer.from("MISMATCH")}] }).status,"BLOCKED");
 assert.equal(evaluateFileEvidence({...a,absentFiles:["sandbox_file_ref_01"]}).status,"BLOCKED");
 assert.equal(evaluateFileEvidence({...a,metadata:[...a.metadata,...a.metadata]}).status,"BLOCKED");
 assert.equal(evaluateFileEvidence({...a,metadata:[{...a.metadata[0]!,size:1}]}).status,"BLOCKED");
});
