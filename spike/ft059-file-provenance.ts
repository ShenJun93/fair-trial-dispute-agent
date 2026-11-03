/** FT059: offline File Service response validation. No API calls. */
import { createHash } from "node:crypto";
export interface FileMeta {file_id:string;content_type:string;filename:string;size:number}
export interface EvidenceSource {fileId:string;sha256:string;bytes:Uint8Array;contentType:string;filename:string}
export function sourceHash(bytes:Uint8Array):string{
  return createHash("sha256").update(bytes).digest("hex");
}
export function evaluateFileEvidence(input:{
  ids:readonly string[];
  local:readonly EvidenceSource[];
  metadata:readonly FileMeta[];
  remoteBytes:ReadonlyArray<{fileId:string;bytes:Uint8Array}>;
  absentFiles:readonly string[];
}):{status:"OFFLINE_MATCH_ONLY"|"BLOCKED";failures:string[];liveProviderVerified:false}{
 const failures:string[]=[];
 const {ids,local,metadata,remoteBytes,absentFiles}=input;
 if(!ids.length||ids.length>12||new Set(ids).size!==ids.length)failures.push("FILE_ID_SET_INVALID");
 if(absentFiles.length)failures.push("PROVIDER_REPORTS_ABSENT");
 if(local.length!==ids.length||metadata.length!==ids.length||remoteBytes.length!==ids.length)failures.push("FILE_COUNT_MISMATCH");
 for(const id of ids){
  const s=local.filter(x=>x.fileId===id),m=metadata.filter(x=>x.file_id===id),r=remoteBytes.filter(x=>x.fileId===id);
  if(s.length!==1||m.length!==1||r.length!==1){failures.push("SOURCE_OR_READBACK_MISSING");continue;}
  if(!(s[0]!.bytes instanceof Uint8Array)||!(r[0]!.bytes instanceof Uint8Array)||
    !/^[a-f0-9]{64}$/.test(s[0]!.sha256)||
    sourceHash(s[0]!.bytes)!==s[0]!.sha256 ||
    sourceHash(r[0]!.bytes)!==s[0]!.sha256||
    m[0]!.size!==s[0]!.bytes.length||m[0]!.filename!==s[0]!.filename||
    m[0]!.content_type!==s[0]!.contentType)failures.push("SOURCE_HASH_OR_PROVIDER_METADATA_MISMATCH");
 }
 return {status:failures.length?"BLOCKED":"OFFLINE_MATCH_ONLY",failures:[...new Set(failures)],liveProviderVerified:false};
}