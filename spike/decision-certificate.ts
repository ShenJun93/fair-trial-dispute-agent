import { createHash } from "node:crypto";
import { DISPUTE_POLICY_VERSION, fingerprintDisputeDecision, recommendDisputeAction, validateDisputeSnapshot,
  type DisputeEconomics, type DisputeRecommendation, type DisputeSnapshot } from "./dispute-engine.ts";

export const CERTIFICATE_VERSION = "fair-trial-decision/v1" as const;
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const record = value as Record<string, unknown>;
  return "{" + Object.keys(record).filter(k => record[k] !== undefined).sort()
    .map(k => JSON.stringify(k) + ":" + canonicalJson(record[k])).join(",") + "}";
}
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
export interface DecisionCertificate {
  schemaVersion: typeof CERTIFICATE_VERSION;
  caseRef: string; revision: number; snapshot: DisputeSnapshot; snapshotFingerprint: string;
  evidence: Array<{ id: string; sha256: string }>;
  recommendation: DisputeRecommendation; policyVersion: string; economics: DisputeEconomics;
  approvalRef?: string; createdAt: string; limitations: string[]; digest: string;
}
type Unsigned = Omit<DecisionCertificate, "digest">;
export function createDecisionCertificate(input: { revision: number; snapshot: DisputeSnapshot; economics: DisputeEconomics;
  approvalRef?: string; createdAt?: string }): DecisionCertificate {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const recommendation = recommendDisputeAction(input.snapshot, input.economics, Date.parse(createdAt));
  const unsigned: Unsigned = { schemaVersion: CERTIFICATE_VERSION, caseRef: input.snapshot.caseId, revision: input.revision,
    snapshot: input.snapshot, snapshotFingerprint: fingerprintDisputeDecision(input.snapshot, recommendation),
    evidence: input.snapshot.evidence.map(item => ({ id: item.id, sha256: sha256(canonicalJson(item)) })),
    recommendation, policyVersion: DISPUTE_POLICY_VERSION, economics: input.economics,
    ...(input.approvalRef ? { approvalRef: input.approvalRef } : {}), createdAt,
    limitations: ["Digest proves artifact integrity only when compared with a separately trusted anchor.",
      "It does not prove evidence source authenticity, factual truth, provider state, or provider execution."] };
  return { ...unsigned, digest: sha256(canonicalJson(unsigned)) };
}
export function verifyDecisionCertificate(value: unknown, expectedRevision?: number, pinnedDigest?: string): { ok: boolean; reasonCodes: string[]; digest?: string } {
  try {
    const c = value as DecisionCertificate;
    if (!c || c.schemaVersion !== CERTIFICATE_VERSION) return { ok: false, reasonCodes: ["UNSUPPORTED_VERSION"] };
    if (!Number.isSafeInteger(c.revision) || c.revision < 1 || (expectedRevision !== undefined && c.revision !== expectedRevision)) return { ok: false, reasonCodes: ["REVISION_MISMATCH"] };
    if (!c.snapshot || c.caseRef !== c.snapshot.caseId || validateDisputeSnapshot(c.snapshot).length) return { ok: false, reasonCodes: ["SNAPSHOT_INVALID"] };
    if (!Array.isArray(c.evidence) || new Set(c.evidence.map(e => e?.id)).size !== c.evidence.length) return { ok: false, reasonCodes: ["EVIDENCE_REFERENCES_INVALID"] };
    const refs = c.snapshot.evidence.map(item => ({ id: item.id, sha256: sha256(canonicalJson(item)) }));
    if (canonicalJson(refs) !== canonicalJson(c.evidence)) return { ok: false, reasonCodes: ["EVIDENCE_HASH_MISMATCH"] };
    if (c.policyVersion !== DISPUTE_POLICY_VERSION) return { ok: false, reasonCodes: ["POLICY_VERSION_UNSUPPORTED"] };
    const expected = recommendDisputeAction(c.snapshot, c.economics, Date.parse(c.createdAt));
    if (canonicalJson(expected) !== canonicalJson(c.recommendation)) return { ok: false, reasonCodes: ["DECISION_MISMATCH"] };
    if (fingerprintDisputeDecision(c.snapshot, expected) !== c.snapshotFingerprint) return { ok: false, reasonCodes: ["SNAPSHOT_FINGERPRINT_MISMATCH"] };
    const { digest, ...unsigned } = c;
    const computed = sha256(canonicalJson(unsigned));
    if (digest !== computed) return { ok: false, reasonCodes: ["DIGEST_MISMATCH"], digest: computed };
    if (pinnedDigest !== undefined && pinnedDigest !== computed) return { ok: false, reasonCodes: ["ANCHOR_MISMATCH"], digest: computed };
    return { ok: true, reasonCodes: [], digest: computed };
  } catch { return { ok: false, reasonCodes: ["MALFORMED_CERTIFICATE"] }; }
}
