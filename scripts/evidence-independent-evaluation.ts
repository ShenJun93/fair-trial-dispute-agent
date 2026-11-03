import assert from "node:assert/strict";
import { OfflineMockProposalProvider, parseProposalResponse, groundProposal } from "../spike/evidence-proposals.ts";
import { ingestOfflineTextEvidence } from "../spike/dispute-evidence.ts";
import { INDEPENDENT_EVIDENCE_CORPUS } from "./fixtures/evidence-independent-corpus.ts";

const signal="3DS authenticated; device matches customer profile";
assert.equal(INDEPENDENT_EVIDENCE_CORPUS.length,50);
assert.ok(INDEPENDENT_EVIDENCE_CORPUS.every(row=>!row.text.includes(signal)),"Corpus must be independent of the exact-phrase matcher");
let tp=0,fp=0,fn=0,validGoldCitations=0,positive=0,unsupportedRejected=0;
const mock=new OfflineMockProposalProvider();
for(const item of INDEPENDENT_EVIDENCE_CORPUS){
  const doc=ingestOfflineTextEvidence("kit04-evidence-lab",item.id,item.text,"2026-10-28T08:00:00.000Z");
  const raw=mock.propose(doc,"2026-10-28T08:00:00.000Z");
  const proposals=parseProposalResponse(raw).filter(p=>groundProposal(p,doc));
  const predicted=proposals.length>0,expected=item.expected==="SUPPORTED";
  if(expected){positive++;if(predicted)tp++;else fn++;}else if(predicted)fp++;
  if(item.goldQuote){const start=item.text.indexOf(item.goldQuote),end=start+item.goldQuote.length;
    assert.ok(start>=0&&item.text.slice(start,end)===item.goldQuote);validGoldCitations++;}
}
try{parseProposalResponse({proposals:[{caseId:"x",documentId:"x",documentSha256:"0".repeat(64),factType:"REFUND_NOW"}]});}catch{unsupportedRejected++;}
console.log(JSON.stringify({suite:"INDEPENDENT_PARAPHRASE_SET_V1",provider:mock.model,documents:50,positiveLabels:positive,
 categories:Object.fromEntries([...new Set(INDEPENDENT_EVIDENCE_CORPUS.map(x=>x.category))].map(k=>[k,INDEPENDENT_EVIDENCE_CORPUS.filter(x=>x.category===k).length])),
 extraction:{truePositive:tp,falsePositive:fp,falseNegative:fn,precision:tp+fp?tp/(tp+fp):null,recall:positive?tp/positive:null},
 goldCitationOffsets:{valid:validGoldCitations,total:INDEPENDENT_EVIDENCE_CORPUS.filter(x=>x.goldQuote).length,semantics:"UTF-16 code units; start inclusive, end exclusive"},
 unsupportedFactPayloadRejected:unsupportedRejected,realModel:{executed:false,metrics:null},verifiedEvidenceCreated:0},null,2));
