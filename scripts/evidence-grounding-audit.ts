/** Model-independent audit of deterministic proposal grounding against synthetic gold quotes. */
import { createHash } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { ingestOfflineTextEvidence } from "../spike/dispute-evidence.ts";
import { explainProposalGrounding, PROMPT_VERSION, PROPOSAL_VERSION, type EvidenceProposal } from "../spike/evidence-proposals.ts";
import { INDEPENDENT_EVIDENCE_CORPUS } from "./fixtures/evidence-independent-corpus.ts";

const corpusDigest=createHash("sha256").update(JSON.stringify(INDEPENDENT_EVIDENCE_CORPUS)).digest("hex");
const outputIndex=process.argv.indexOf("--output");
if(outputIndex>=0&&!process.argv[outputIndex+1])throw new Error("OUTPUT_PATH_REQUIRED");
const outputPath=resolve(outputIndex>=0?process.argv[outputIndex+1]!:
  "submission/evidence/ft-agentic-002-grounding-audit.json");
const at="2026-10-29T00:00:00.000Z";
const rows=INDEPENDENT_EVIDENCE_CORPUS.map(item=>{
  const document=ingestOfflineTextEvidence("ft-agentic-grounding-audit",item.id,item.text,at);
  const quote=item.expected==="SUPPORTED"?item.goldQuote:item.text;
  if(!quote)throw new Error(`GOLD_QUOTE_MISSING:${item.id}`);
  const startOffset=document.text.indexOf(quote);
  const proposal:EvidenceProposal={caseId:document.caseId,documentId:document.documentId,documentSha256:document.sha256,
    factType:"DEVICE_AND_3DS_MATCH",exactQuote:quote,startOffset,endOffset:startOffset+quote.length,confidence:1,
    sourceType:"OFFLINE_OPERATOR_TEXT",proposedAt:at,model:"GOLD_GROUNDING_AUDIT",promptVersion:PROMPT_VERSION,
    proposalVersion:PROPOSAL_VERSION};
  const reasonCode=explainProposalGrounding(proposal,document);
  const exactOffset=startOffset>=0&&document.text.slice(startOffset,startOffset+quote.length)===quote;
  return {id:item.id,category:item.category,expected:item.expected,candidate:"GOLD_QUOTE" as const,reasonCode,
    exactQuoteOffsetValid:exactOffset,quoteOccurrenceCount:document.text.split(quote).length-1,
    quoteLength:quote.length,quoteSha256:createHash("sha256").update(quote,"utf8").digest("hex")};
});
const supported=rows.filter(row=>row.expected==="SUPPORTED"),unsupported=rows.filter(row=>row.expected==="UNSUPPORTED");
const result={schemaVersion:"fair-trial-grounding-policy-audit/v1",provider:"NONE_MODEL_INDEPENDENT_GOLD_CHECK",
  policyVersion:"risk-claim-ground-v1",corpus:"INDEPENDENT_EVIDENCE_CORPUS_V1",corpusDigest,
  counts:{total:rows.length,supported:supported.length,unsupported:unsupported.length,
    supportedExactOffsetsValid:supported.filter(row=>row.exactQuoteOffsetValid).length,
    supportedGrounded:supported.filter(row=>row.reasonCode==="GROUNDED").length,
    supportedSemanticFalseNegatives:supported.filter(row=>row.reasonCode!=="GROUNDED").length,
    unsupportedRejected:unsupported.filter(row=>row.reasonCode!=="GROUNDED").length,
    unsupportedAccidentallyGrounded:unsupported.filter(row=>row.reasonCode==="GROUNDED").length},
  method:{positive:"exact synthetic goldQuote with UTF-16 offsets computed from the hash-bound document",
    negative:"entire unsupported synthetic source offered as an affirmative claim",
    limitation:"This tests deterministic grounding on this corpus, not model extraction, prompt-injection behavior, evidence truth, or real dispute outcomes."},
  categories:Object.fromEntries([...new Set(rows.map(row=>row.category))].map(category=>{
    const subset=rows.filter(row=>row.category===category);
    return [category,{attempted:subset.length,grounded:subset.filter(row=>row.reasonCode==="GROUNDED").length,
      rejected:subset.filter(row=>row.reasonCode!=="GROUNDED").length,
      reasonCodes:Object.fromEntries([...new Set(subset.map(row=>row.reasonCode))].map(reason=>
        [reason,subset.filter(row=>row.reasonCode===reason).length]))}];
  })),results:rows};
mkdirSync(resolve(outputPath,".."),{recursive:true});
writeFileSync(outputPath,JSON.stringify(result,null,2)+"\n");
console.log(JSON.stringify({output:outputPath,...result.counts},null,2));
if(result.counts.total!==50||result.counts.supported!==25||result.counts.unsupported!==25||
  result.counts.supportedExactOffsetsValid!==25||result.counts.supportedGrounded!==25||
  result.counts.unsupportedRejected!==25||result.counts.unsupportedAccidentallyGrounded!==0)process.exitCode=1;
