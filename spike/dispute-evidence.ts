import { createHash } from "node:crypto";
import { fingerprintDisputeDecision, recommendDisputeAction, type DisputeEvidence, type DisputeEconomics,
  type DisputeRecommendation, type DisputeSnapshot } from "./dispute-engine.ts";

/** Offline synthetic text-evidence lab. No model, external I/O or provider verification. */
export interface TextEvidenceDocument {
  readonly caseId: string;
  readonly documentId: string;
  readonly source: "OFFLINE_OPERATOR_TEXT";
  readonly mediaType: "text/plain";
  readonly text: string;
  readonly sha256: string;
  readonly receivedAt: string;
}
export interface ExtractedEvidenceFact {
  readonly documentId: string;
  readonly documentSha256: string;
  readonly factId: string;
  readonly kind: "DEVICE_AND_3DS_MATCH";
  readonly quote: string;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly verified: false;
}
const maxTextBytes = 4096;
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
// Anchored on a complete line; a negated or quoted prefix is never promoted to a fact.
const signalPattern = /^3DS authenticated; device matches customer profile$/gim;

export function ingestOfflineTextEvidence(caseId: string, documentId: string, text: string, at: string): TextEvidenceDocument {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(caseId) || !/^[a-zA-Z0-9_-]{1,128}$/.test(documentId))
    throw new Error("INVALID_DOCUMENT_IDENTITY");
  if (!text || Buffer.byteLength(text, "utf8") > maxTextBytes || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text))
    throw new Error("INVALID_DOCUMENT_CONTENT");
  if (!Number.isFinite(Date.parse(at)) || !/Z$|[+-]\d\d:\d\d$/.test(at)) throw new Error("INVALID_OBSERVED_TIME");
  return Object.freeze({ caseId, documentId, source: "OFFLINE_OPERATOR_TEXT", mediaType: "text/plain",
    text, sha256: sha256(text), receivedAt: at });
}

/** Strict phrase matcher, NOT an LLM. Claims remain unverified until separately attested. */
export function extractOfflineEvidenceFacts(document: TextEvidenceDocument): readonly ExtractedEvidenceFact[] {
  if (sha256(document.text) !== document.sha256) throw new Error("DOCUMENT_HASH_MISMATCH");
  // One attested risk signal per document; repeating a phrase cannot manufacture independent evidence.
  return Object.freeze([...document.text.matchAll(signalPattern)].slice(0, 1).map((match, index) => {
    const startOffset = match.index ?? -1, endOffset = startOffset + match[0].length;
    return Object.freeze({ documentId: document.documentId, documentSha256: document.sha256,
      factId: sha256(document.sha256 + ":" + startOffset + ":" + endOffset + ":" + index).slice(0, 24),
      kind: "DEVICE_AND_3DS_MATCH" as const, quote: document.text.slice(startOffset, endOffset),
      startOffset, endOffset, verified: false as const });
  }));
}

/** Operator attestation is local only, not provider or cryptographic source verification. */
export function attestOfflineFact(document: TextEvidenceDocument, fact: ExtractedEvidenceFact,
  actor: string, expectedDocumentSha256: string): DisputeEvidence {
  if (!actor.trim() || actor.length > 128) throw new Error("ATTESTING_OPERATOR_REQUIRED");
  if (document.sha256 !== expectedDocumentSha256 || sha256(document.text) !== document.sha256 ||
      fact.documentId !== document.documentId || fact.documentSha256 !== document.sha256 ||
      fact.startOffset < 0 || fact.endOffset > document.text.length || fact.endOffset <= fact.startOffset ||
      document.text.slice(fact.startOffset, fact.endOffset) !== fact.quote ||
      !/^3DS authenticated; device matches customer profile$/i.test(fact.quote) ||
      !extractOfflineEvidenceFacts(document).some((actual) => actual.factId === fact.factId &&
        actual.startOffset === fact.startOffset && actual.endOffset === fact.endOffset && actual.quote === fact.quote))
    throw new Error("EVIDENCE_CITATION_NOT_GROUNDED");
  return Object.freeze({ id: "local-fact-" + fact.factId, kind: "DEVICE_AND_3DS_MATCH",
    supportsMerchant: true, strength: "STRONG",
    summary: "Operator-attested claim (not provider-verified): " + fact.quote,
    provenance: Object.freeze({ source: "OPERATOR",
      reference: "offline-text:" + document.documentId + ":sha256:" + document.sha256 +
        ":chars:" + fact.startOffset + "-" + fact.endOffset + ":actor:" + sha256(actor).slice(0,12),
      observedAt: document.receivedAt, verified: true }) });
}

export interface OfflineReplan {
  readonly before: DisputeRecommendation;
  readonly after: DisputeRecommendation;
  readonly beforeFingerprint: string;
  readonly afterFingerprint: string;
  readonly changed: boolean;
  readonly source: "OFFLINE_FIXTURE";
}
export function replanWithOfflineEvidence(snapshot: DisputeSnapshot, newEvidence: DisputeEvidence,
  economics: DisputeEconomics, now: number): OfflineReplan {
  if (snapshot.evidence.some((entry) => entry.id === newEvidence.id)) throw new Error("DUPLICATE_EVIDENCE_ID");
  const before = recommendDisputeAction(snapshot, economics, now);
  const afterSnapshot = { ...snapshot, evidence: [...snapshot.evidence, newEvidence] };
  const after = recommendDisputeAction(afterSnapshot, economics, now);
  const beforeFingerprint = fingerprintDisputeDecision(snapshot, before);
  const afterFingerprint = fingerprintDisputeDecision(afterSnapshot, after);
  return Object.freeze({ before, after, beforeFingerprint, afterFingerprint,
    changed: before.action !== after.action || beforeFingerprint !== afterFingerprint, source: "OFFLINE_FIXTURE" });
}
