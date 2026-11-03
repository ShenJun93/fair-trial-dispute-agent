/**
 * FT062 offline-only application citation repair, not an AI or provider action.
 * Can recover a repeated full-line quote by choosing a canonical source anchor,
 * without treating copies as independent corroboration.
 */
import type {TextEvidenceDocument} from "../spike/dispute-evidence.ts";
import {createApplicationSourceSpanAnchors,enrichAnchoredModelProposals,enrichModelProposals,
  type EnrichedModelProposal,type ModelEvidenceClaim} from "../spike/evidence-proposals.ts";
export function recoverIdenticalRepeatedLine(
 claim:ModelEvidenceClaim,doc:TextEvidenceDocument,modelId:string,at:string
):EnrichedModelProposal|null{
 const base=enrichModelProposals([claim],doc,modelId,at)[0]!;
 if(base.groundingReasonCode!=="QUOTE_NOT_UNIQUE")return null;
 const quote=claim.exactQuote;
 const anchors=createApplicationSourceSpanAnchors(doc);
 const identical=anchors.filter(a=>a.text===quote);
 if(identical.length<2)return null;
 const occurrences=doc.text.split(quote).length-1;
 if(occurrences!==identical.length)return null;
 const anchored=enrichAnchoredModelProposals([{...claim,sourceSpanId:identical[0]!.anchorId}],
  doc,modelId,at).proposals[0]!;
 return anchored.groundingReasonCode==="GROUNDED"?anchored:null;
}
