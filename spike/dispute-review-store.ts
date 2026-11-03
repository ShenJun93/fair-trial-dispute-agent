import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_DISPUTE_ECONOMICS, fingerprintDisputeDecision, recommendDisputeAction, type DisputeEconomics, type DisputeRecommendation, type DisputeSnapshot } from "./dispute-engine.ts";
import { attestOfflineFact, extractOfflineEvidenceFacts, ingestOfflineTextEvidence, type TextEvidenceDocument, type ExtractedEvidenceFact } from "./dispute-evidence.ts";
import { createKit04OfflineLifecycle, createKit04ReviewCases, createDecisionProofSnapshot, DECISION_PROOF_CASE_ID } from "./dispute-workflow.ts";
import { createOfflineRfiFixture } from "./dispute-engine.ts";
import { MODEL_OUTPUT_CONTRACT_VERSION, enrichModelProposals, explainProposalGrounding, groundProposal, OfflineMockProposalProvider,
  parseModelProposalResponse, parseProposalResponse, type EvidenceProposal, type EvidenceProposalProvider } from "./evidence-proposals.ts";

type SqlParam = string | number | bigint | null | Uint8Array;
interface SqlResult { changes: number; lastInsertRowid: number | bigint }
interface SqlStatement {
  get(...values: SqlParam[]): Record<string, unknown> | undefined;
  all(...values: SqlParam[]): Record<string, unknown>[];
  run(...values: SqlParam[]): SqlResult;
}
interface SqlDatabase { exec(sql: string): void; prepare(sql: string): SqlStatement; close(): void }
type DatabaseCtor = new (path: string, options?: { timeout?: number }) => SqlDatabase;

export type ReviewChoice = "APPROVE" | "REJECT";
export type ReviewAction = "APPROVE" | "REJECT" | "SET_FEE";
export type DecisionResult = "RECORDED" | "ALREADY_RECORDED" | "CONFLICT";

export interface ReviewDecisionRecord {
  caseId: string;
  choice: ReviewChoice;
  recommendedAction: string;
  actor: string;
  createdAt: number;
  revision: number;
  idempotencyKey: string;
  providerActionState: "NOT_EXECUTED";
  refundState: "NOT_CONFIRMED";
}

function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function recommendStoredCase(caseId: string, snapshot: DisputeSnapshot, economics: DisputeEconomics, now: number): DisputeRecommendation {
  const baseline = recommendDisputeAction(snapshot, economics, now);
  if (caseId !== "kit04-credit-not-processed" || snapshot.stage !== "CHARGEBACK" || snapshot.status !== "REQUIRES_RESPONSE" || baseline.action === "NO_ACTION") return baseline;
  return Object.freeze({ action: "ESCALATE_FOR_REVIEW", reasonCodes: Object.freeze(["STAGE_ECONOMICS_UNKNOWN", "HUMAN_REVIEW_REQUIRED"]),
    explanation: "The synthetic issuer rejection requires a fresh human review; chargeback-stage recovery assumptions have not been validated for this fixture.",
    disputeFeeMinor: economics.disputeFeeMinor, expectedRecoveryMinor: null, expectedNetValueMinor: null,
    evidenceIds: Object.freeze(snapshot.evidence.filter((e) => e.provenance.verified).map((e) => e.id)), humanReviewRequired: true });
}

export class DisputeReviewStore {
  private constructor(private readonly db: SqlDatabase) {}

  static async open(path: string, initialFeeMinor?: number, seedNow = Date.now()): Promise<DisputeReviewStore> {
    if (initialFeeMinor !== undefined && (!Number.isSafeInteger(initialFeeMinor) || initialFeeMinor < 0 || initialFeeMinor > 10_000_000)) throw new Error("INVALID_DISPUTE_FEE");
    mkdirSync(dirname(path), { recursive: true });
    const { DatabaseSync } = await import("node:sqlite" as string) as { DatabaseSync: DatabaseCtor };
    const db = new DatabaseSync(path, { timeout: 5000 });
    try {
      db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;");
      db.exec(`
        CREATE TABLE IF NOT EXISTS review_settings(singleton INTEGER PRIMARY KEY CHECK(singleton=1), dispute_fee_minor INTEGER NOT NULL CHECK(dispute_fee_minor>=0 AND dispute_fee_minor<=10000000), revision INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS review_sessions(session_hash TEXT PRIMARY KEY, actor TEXT NOT NULL, csrf_hash TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER);
        CREATE TABLE IF NOT EXISTS review_cases(case_id TEXT PRIMARY KEY, snapshot_json TEXT NOT NULL, recommendation_json TEXT NOT NULL, revision INTEGER NOT NULL, created_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS evidence_refs(case_id TEXT NOT NULL REFERENCES review_cases(case_id), evidence_id TEXT NOT NULL, provenance_json TEXT NOT NULL, evidence_json TEXT NOT NULL, PRIMARY KEY(case_id,evidence_id));
        CREATE TABLE IF NOT EXISTS review_tokens(token_hash TEXT PRIMARY KEY, session_hash TEXT NOT NULL REFERENCES review_sessions(session_hash), case_id TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL CHECK(action IN ('APPROVE','REJECT','SET_FEE')), revision INTEGER NOT NULL, expires_at INTEGER NOT NULL, consumed_at INTEGER);
        CREATE TABLE IF NOT EXISTS review_decisions(case_id TEXT PRIMARY KEY REFERENCES review_cases(case_id), choice TEXT NOT NULL CHECK(choice IN ('APPROVE','REJECT')), recommended_action TEXT NOT NULL, actor TEXT NOT NULL, created_at INTEGER NOT NULL, revision INTEGER NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, provider_action_state TEXT NOT NULL DEFAULT 'NOT_EXECUTED' CHECK(provider_action_state='NOT_EXECUTED'), refund_state TEXT NOT NULL DEFAULT 'NOT_CONFIRMED' CHECK(refund_state='NOT_CONFIRMED'));
        CREATE TABLE IF NOT EXISTS review_decision_events(decision_event_id INTEGER PRIMARY KEY AUTOINCREMENT,case_id TEXT NOT NULL REFERENCES review_cases(case_id),choice TEXT NOT NULL CHECK(choice IN ('APPROVE','REJECT')),recommended_action TEXT NOT NULL,actor TEXT NOT NULL,created_at INTEGER NOT NULL,revision INTEGER NOT NULL,idempotency_key TEXT NOT NULL UNIQUE,provider_action_state TEXT NOT NULL DEFAULT 'NOT_EXECUTED' CHECK(provider_action_state='NOT_EXECUTED'),refund_state TEXT NOT NULL DEFAULT 'NOT_CONFIRMED' CHECK(refund_state='NOT_CONFIRMED'));
        CREATE TABLE IF NOT EXISTS review_decision_invalidations(case_id TEXT NOT NULL REFERENCES review_cases(case_id),revision INTEGER NOT NULL,invalidated_at INTEGER NOT NULL,invalidated_by TEXT NOT NULL,reason TEXT NOT NULL,PRIMARY KEY(case_id,revision));
        CREATE TABLE IF NOT EXISTS provider_action_claims(idempotency_key TEXT PRIMARY KEY, approval_id TEXT NOT NULL UNIQUE, case_id TEXT NOT NULL REFERENCES review_cases(case_id), action TEXT NOT NULL CHECK(action IN ('CHALLENGE','ACCEPT')), actor TEXT NOT NULL, claimed_at INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('RESERVED','AMBIGUOUS','RESPONSE_RECORDED')), UNIQUE(case_id,action));
        CREATE TABLE IF NOT EXISTS action_history(id INTEGER PRIMARY KEY AUTOINCREMENT, case_id TEXT NOT NULL, actor TEXT NOT NULL, event TEXT NOT NULL, choice TEXT, action TEXT, created_at INTEGER NOT NULL, idempotency_key TEXT, note TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS offline_text_documents(
          document_id TEXT PRIMARY KEY,case_id TEXT NOT NULL REFERENCES review_cases(case_id),
          content TEXT NOT NULL,sha256 TEXT NOT NULL,received_at TEXT NOT NULL,actor TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS offline_text_facts(
          fact_id TEXT PRIMARY KEY,document_id TEXT NOT NULL REFERENCES offline_text_documents(document_id),
          case_id TEXT NOT NULL REFERENCES review_cases(case_id),
          quote TEXT NOT NULL,start_offset INTEGER NOT NULL,end_offset INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS evidence_proposals(
          proposal_id TEXT PRIMARY KEY,case_id TEXT NOT NULL REFERENCES review_cases(case_id),document_id TEXT NOT NULL REFERENCES offline_text_documents(document_id),
          proposal_json TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(document_id,proposal_id));
        CREATE TABLE IF NOT EXISTS proposal_attestations(
          proposal_id TEXT PRIMARY KEY REFERENCES evidence_proposals(proposal_id),actor TEXT NOT NULL,attested_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS proposal_rejections(proposal_id TEXT PRIMARY KEY REFERENCES evidence_proposals(proposal_id),actor TEXT NOT NULL,rejected_at INTEGER NOT NULL);
        CREATE TRIGGER IF NOT EXISTS evidence_proposals_no_update BEFORE UPDATE ON evidence_proposals BEGIN SELECT RAISE(ABORT,'immutable proposal'); END;
        CREATE TRIGGER IF NOT EXISTS evidence_proposals_no_delete BEFORE DELETE ON evidence_proposals BEGIN SELECT RAISE(ABORT,'immutable proposal'); END;
        CREATE TRIGGER IF NOT EXISTS proposal_attestations_no_update BEFORE UPDATE ON proposal_attestations BEGIN SELECT RAISE(ABORT,'immutable proposal attestation'); END;
        CREATE TRIGGER IF NOT EXISTS proposal_attestations_no_delete BEFORE DELETE ON proposal_attestations BEGIN SELECT RAISE(ABORT,'immutable proposal attestation'); END;
        CREATE TRIGGER IF NOT EXISTS proposal_rejections_no_update BEFORE UPDATE ON proposal_rejections BEGIN SELECT RAISE(ABORT,'immutable proposal rejection'); END;
        CREATE TRIGGER IF NOT EXISTS proposal_rejections_no_delete BEFORE DELETE ON proposal_rejections BEGIN SELECT RAISE(ABORT,'immutable proposal rejection'); END;
        CREATE TABLE IF NOT EXISTS offline_text_attestations(
          fact_id TEXT PRIMARY KEY REFERENCES offline_text_facts(fact_id),
          actor TEXT NOT NULL,attested_at INTEGER NOT NULL,evidence_id TEXT NOT NULL UNIQUE);
        CREATE TRIGGER IF NOT EXISTS offline_documents_no_update BEFORE UPDATE ON offline_text_documents
          BEGIN SELECT RAISE(ABORT,'immutable offline document'); END;
        CREATE TRIGGER IF NOT EXISTS offline_documents_no_delete BEFORE DELETE ON offline_text_documents
          BEGIN SELECT RAISE(ABORT,'immutable offline document'); END;
        CREATE TRIGGER IF NOT EXISTS offline_facts_no_update BEFORE UPDATE ON offline_text_facts
          BEGIN SELECT RAISE(ABORT,'immutable offline fact'); END;
        CREATE TRIGGER IF NOT EXISTS offline_facts_no_delete BEFORE DELETE ON offline_text_facts
          BEGIN SELECT RAISE(ABORT,'immutable offline fact'); END;
        CREATE TRIGGER IF NOT EXISTS offline_attestation_no_update BEFORE UPDATE ON offline_text_attestations
          BEGIN SELECT RAISE(ABORT,'immutable offline attestation'); END;
        CREATE TRIGGER IF NOT EXISTS offline_attestation_no_delete BEFORE DELETE ON offline_text_attestations
          BEGIN SELECT RAISE(ABORT,'immutable offline attestation'); END;
        CREATE TABLE IF NOT EXISTS mock_lifecycle(fixture_id TEXT NOT NULL, sequence INTEGER NOT NULL, event TEXT NOT NULL, stage TEXT NOT NULL, status TEXT NOT NULL, source TEXT NOT NULL CHECK(source='SIMULATED_OFFLINE_FIXTURE'), event_id TEXT, rejection_reason TEXT, response_deadline TEXT, previous_revision INTEGER, new_revision INTEGER, recommendation TEXT, PRIMARY KEY(fixture_id,sequence));
        CREATE TABLE IF NOT EXISTS lifecycle_approvals(approval_id TEXT PRIMARY KEY,token_hash TEXT NOT NULL UNIQUE,case_id TEXT NOT NULL,actor TEXT NOT NULL,revision INTEGER NOT NULL,stage TEXT NOT NULL,status TEXT NOT NULL,snapshot_fingerprint TEXT NOT NULL,recommended_action TEXT NOT NULL,evidence_digest TEXT NOT NULL,expires_at INTEGER NOT NULL,idempotency_key TEXT NOT NULL UNIQUE,consumed_at INTEGER);
        CREATE TABLE IF NOT EXISTS lifecycle_approval_audit(id INTEGER PRIMARY KEY AUTOINCREMENT,approval_id TEXT NOT NULL,actor TEXT NOT NULL,event TEXT NOT NULL,at INTEGER NOT NULL,note TEXT NOT NULL);
        CREATE TRIGGER IF NOT EXISTS lifecycle_approval_audit_no_update BEFORE UPDATE ON lifecycle_approval_audit BEGIN SELECT RAISE(ABORT,'immutable lifecycle approval audit'); END;
        CREATE TRIGGER IF NOT EXISTS lifecycle_approval_audit_no_delete BEFORE DELETE ON lifecycle_approval_audit BEGIN SELECT RAISE(ABORT,'immutable lifecycle approval audit'); END;
        CREATE TRIGGER IF NOT EXISTS history_no_update BEFORE UPDATE ON action_history BEGIN SELECT RAISE(ABORT,'append-only action history'); END;
        CREATE TRIGGER IF NOT EXISTS history_no_delete BEFORE DELETE ON action_history BEGIN SELECT RAISE(ABORT,'append-only action history'); END;
        CREATE TRIGGER IF NOT EXISTS decisions_no_update BEFORE UPDATE ON review_decisions BEGIN SELECT RAISE(ABORT,'immutable review decisions'); END;
        CREATE TRIGGER IF NOT EXISTS decisions_no_delete BEFORE DELETE ON review_decisions BEGIN SELECT RAISE(ABORT,'immutable review decisions'); END;
        CREATE TRIGGER IF NOT EXISTS decision_events_no_update BEFORE UPDATE ON review_decision_events BEGIN SELECT RAISE(ABORT,'immutable review decision events'); END;
        CREATE TRIGGER IF NOT EXISTS decision_events_no_delete BEFORE DELETE ON review_decision_events BEGIN SELECT RAISE(ABORT,'immutable review decision events'); END;
        CREATE TRIGGER IF NOT EXISTS decision_invalidations_no_update BEFORE UPDATE ON review_decision_invalidations BEGIN SELECT RAISE(ABORT,'immutable review decision invalidations'); END;
        CREATE TRIGGER IF NOT EXISTS decision_invalidations_no_delete BEFORE DELETE ON review_decision_invalidations BEGIN SELECT RAISE(ABORT,'immutable review decision invalidations'); END;
        CREATE TRIGGER IF NOT EXISTS evidence_no_update BEFORE UPDATE ON evidence_refs BEGIN SELECT RAISE(ABORT,'immutable evidence references'); END;
        CREATE TRIGGER IF NOT EXISTS evidence_no_delete BEFORE DELETE ON evidence_refs BEGIN SELECT RAISE(ABORT,'immutable evidence references'); END;
        CREATE TRIGGER IF NOT EXISTS lifecycle_no_update BEFORE UPDATE ON mock_lifecycle BEGIN SELECT RAISE(ABORT,'immutable mock lifecycle'); END;
        CREATE TRIGGER IF NOT EXISTS lifecycle_no_delete BEFORE DELETE ON mock_lifecycle BEGIN SELECT RAISE(ABORT,'immutable mock lifecycle'); END;
      `);
      // Additive migration: old NULL-bound tokens are invalid after upgrading.
      const names = db.prepare("PRAGMA table_info(review_tokens)").all().map((row) => String(row.name));
      if (!names.includes("case_fingerprint")) db.exec("ALTER TABLE review_tokens ADD COLUMN case_fingerprint TEXT");
      const lifecycleNames = db.prepare("PRAGMA table_info(mock_lifecycle)").all().map((row) => String(row.name));
      for (const [name, type] of [["event_id","TEXT"],["rejection_reason","TEXT"],["response_deadline","TEXT"],["previous_revision","INTEGER"],["new_revision","INTEGER"],["recommendation","TEXT"]] as const)
        if (!lifecycleNames.includes(name)) db.exec(`ALTER TABLE mock_lifecycle ADD COLUMN ${name} ${type}`);
      const store = new DisputeReviewStore(db);
      store.seed(initialFeeMinor, seedNow);
      return store;
    } catch (error) { db.close(); throw error; }
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  private seed(initialFeeMinor?: number, seedNow = Date.now()): void {
    this.transaction(() => {
      const settings = this.db.prepare("SELECT dispute_fee_minor FROM review_settings WHERE singleton=1").get();
      if (settings && initialFeeMinor !== undefined && Number(settings.dispute_fee_minor) !== initialFeeMinor) throw new Error("PERSISTED_DISPUTE_FEE_DIFFERS_FROM_STARTUP_CONFIGURATION");
      const feeMinor = settings ? Number(settings.dispute_fee_minor) : initialFeeMinor ?? DEFAULT_DISPUTE_ECONOMICS.disputeFeeMinor;
      if (!settings) this.db.prepare("INSERT INTO review_settings(singleton,dispute_fee_minor,revision) VALUES(1,?,1)").run(feeMinor);
      const existing = this.db.prepare("SELECT COUNT(*) AS n FROM review_cases").get();
      const now = seedNow;
      if (Number(existing?.n ?? 0) === 0) {
        for (const item of createKit04ReviewCases(feeMinor, now)) {
          const { snapshot, recommendation } = item;
          this.db.prepare("INSERT INTO review_cases(case_id,snapshot_json,recommendation_json,revision,created_at) VALUES(?,?,?,?,?)")
            .run(snapshot.caseId, JSON.stringify(snapshot), JSON.stringify(recommendation), 1, now);
          for (const evidence of snapshot.evidence) this.db.prepare("INSERT INTO evidence_refs(case_id,evidence_id,provenance_json,evidence_json) VALUES(?,?,?,?)")
            .run(snapshot.caseId, evidence.id, JSON.stringify(evidence.provenance), JSON.stringify(evidence));
        }
      }
      const proofExists = this.db.prepare("SELECT case_id FROM review_cases WHERE case_id=?").get(DECISION_PROOF_CASE_ID);
      if (!proofExists) {
        const proofSnapshot = createDecisionProofSnapshot(now);
        const proofRecommendation = recommendDisputeAction(proofSnapshot, { ...DEFAULT_DISPUTE_ECONOMICS, disputeFeeMinor: feeMinor }, now);
        this.db.prepare("INSERT INTO review_cases(case_id,snapshot_json,recommendation_json,revision,created_at) VALUES(?,?,?,?,?)")
          .run(proofSnapshot.caseId, JSON.stringify(proofSnapshot), JSON.stringify(proofRecommendation), 1, now);
        for (const evidence of proofSnapshot.evidence) this.db.prepare("INSERT INTO evidence_refs(case_id,evidence_id,provenance_json,evidence_json) VALUES(?,?,?,?)")
          .run(proofSnapshot.caseId, evidence.id, JSON.stringify(evidence.provenance), JSON.stringify(evidence));
      }
      if (!this.db.prepare("SELECT fixture_id FROM mock_lifecycle WHERE fixture_id='kit04-offline-rfi-lifecycle'").get()) {
        const lifecycle = createKit04OfflineLifecycle();
        for (const event of lifecycle.events) this.db.prepare("INSERT INTO mock_lifecycle(fixture_id,sequence,event,stage,status,source) VALUES(?,?,?,?,?,?)")
          .run(lifecycle.caseId, event.sequence, event.event, event.stage, event.status, event.source);
      }
      if (!this.db.prepare("SELECT fixture_id FROM mock_lifecycle WHERE fixture_id='kit04-stateful-lifecycle'").get()) {
        const interactive = createOfflineRfiFixture("kit04-stateful-lifecycle");
        for (const event of interactive.events) this.db.prepare("INSERT INTO mock_lifecycle(fixture_id,sequence,event,stage,status,source) VALUES(?,?,?,?,?,?)")
          .run(interactive.caseId,event.sequence,event.event,event.stage,event.status,event.source);
      }
    });
  }

  /** Binds stored case snapshot, policy output, and separate immutable evidence rows. */
  private caseFingerprint(caseId: string, snapshotJson: string, recommendationJson: string): string {
    const snapshot = JSON.parse(snapshotJson) as import("./dispute-engine.ts").DisputeSnapshot;
    const recommendation = JSON.parse(recommendationJson) as DisputeRecommendation;
    const evidence = this.db.prepare("SELECT evidence_json FROM evidence_refs WHERE case_id=? ORDER BY evidence_id")
      .all(caseId).map((row) => JSON.parse(String(row.evidence_json)) as import("./dispute-engine.ts").DisputeEvidence);
    return fingerprintDisputeDecision(snapshot, recommendation, evidence);
  }

  /** Local deterministic walkthrough controls. They cannot call a provider and only modify the dedicated synthetic case. */
  advanceDecisionProof(sessionToken: string, step: "RESET" | "INJECT_CONFLICT" | "RESOLVE_CONFLICT", now: number): Record<string, unknown> {
    return this.transaction(() => {
      const operator = this.session(sessionToken, now);
      if (!operator) throw new Error("SESSION_EXPIRED_OR_INVALID");
      const row = this.db.prepare("SELECT snapshot_json,revision FROM review_cases WHERE case_id=?").get(DECISION_PROOF_CASE_ID);
      if (!row) throw new Error("DECISION_PROOF_CASE_NOT_FOUND");
      if (this.db.prepare("SELECT case_id FROM review_decisions WHERE case_id=? UNION ALL SELECT case_id FROM review_decision_events WHERE case_id=? LIMIT 1").get(DECISION_PROOF_CASE_ID, DECISION_PROOF_CASE_ID))
        throw new Error("DECISION_PROOF_CASE_CLOSED");
      const previous = JSON.parse(String(row.snapshot_json)) as DisputeSnapshot;
      let next: DisputeSnapshot;
      if (step === "RESET") next = createDecisionProofSnapshot(now);
      else if (step === "INJECT_CONFLICT") {
        if (previous.evidence.some((item) => item.id === "proof-contradiction")) throw new Error("DECISION_PROOF_CONFLICT_ALREADY_PRESENT");
        const anchor = previous.evidence[0]!;
        const contradictory = Object.freeze({ ...anchor, id: "proof-contradiction", supportsMerchant: false,
          summary: "Synthetic opposing claim: device and 3DS do not match the customer profile.",
          provenance: Object.freeze({ ...anchor.provenance, reference: "offline-fixture:opposing-claim" }) });
        next = { ...previous, evidence: [...previous.evidence, contradictory] };
        this.db.prepare("INSERT INTO evidence_refs(case_id,evidence_id,provenance_json,evidence_json) VALUES(?,?,?,?)")
          .run(DECISION_PROOF_CASE_ID, contradictory.id, JSON.stringify(contradictory.provenance), JSON.stringify(contradictory));
      } else {
        if (!previous.evidence.some((item) => item.id === "proof-contradiction")) throw new Error("DECISION_PROOF_CONFLICT_NOT_PRESENT");
        // Keep the contradiction in the immutable ledger, remove it from the active snapshot, and add an explicit
        // scoped correction record so the new snapshot has its own verifiable fingerprint.
        const anchor = previous.evidence.find((item) => item.id !== "proof-contradiction")!;
        const correction = Object.freeze({ ...anchor, id: "proof-correction", summary: "Synthetic correction record: the opposing fixture assertion is withdrawn; authentication signals remain consistent.",
          provenance: Object.freeze({ ...anchor.provenance, reference: "offline-fixture:documented-correction" }) });
        next = { ...previous, evidence: [...previous.evidence.filter((item) => item.id !== "proof-contradiction"), correction] };
        this.db.prepare("INSERT INTO evidence_refs(case_id,evidence_id,provenance_json,evidence_json) VALUES(?,?,?,?)")
          .run(DECISION_PROOF_CASE_ID, correction.id, JSON.stringify(correction.provenance), JSON.stringify(correction));
      }
      const fee = Number(this.db.prepare("SELECT dispute_fee_minor FROM review_settings WHERE singleton=1").get()?.dispute_fee_minor);
      const recommendation = recommendDisputeAction(next, { ...DEFAULT_DISPUTE_ECONOMICS, disputeFeeMinor: fee }, now);
      const revision = Number(row.revision) + 1;
      this.db.prepare("UPDATE review_cases SET snapshot_json=?,recommendation_json=?,revision=? WHERE case_id=?")
        .run(JSON.stringify(next), JSON.stringify(recommendation), revision, DECISION_PROOF_CASE_ID);
      this.appendHistory(DECISION_PROOF_CASE_ID, operator.actor, "DECISION_PROOF_" + step, null, recommendation.action, now,
        "decision-proof:" + revision, `OFFLINE_DEMO only; revision ${Number(row.revision)} -> ${revision}; ${step}; provider action NOT_EXECUTED.`);
      return { caseId: DECISION_PROOF_CASE_ID, step, previousRevision: Number(row.revision), revision,
        recommendation: recommendation.action, reasonCodes: recommendation.reasonCodes, providerActionState: "NOT_EXECUTED" };
    });
  }

  close(): void { this.db.close(); }

  issueLifecycleChallengeApproval(sessionToken: string, now: number, ttlMs = 60_000): Record<string, unknown> {
    return this.transaction(() => {
      const operator = this.session(sessionToken,now); if (!operator) throw new Error("SESSION_EXPIRED_OR_INVALID");
      if (ttlMs < 1_000 || ttlMs > 60_000) throw new Error("INVALID_LIFECYCLE_APPROVAL_TTL");
      const fixture = this.db.prepare("SELECT * FROM mock_lifecycle WHERE fixture_id='kit04-stateful-lifecycle' ORDER BY sequence DESC LIMIT 1").get();
      if (!fixture || fixture.stage !== "RFI" || fixture.status !== "REQUIRES_RESPONSE") throw new Error("LIFECYCLE_APPROVAL_STATE_INVALID");
      const caseId = "kit04-credit-not-processed";
      const row = this.db.prepare("SELECT snapshot_json,recommendation_json,revision FROM review_cases WHERE case_id=?").get(caseId);
      if (!row) throw new Error("UNKNOWN_DISPUTE_CASE");
      const snapshot = JSON.parse(String(row.snapshot_json)) as import("./dispute-engine.ts").DisputeSnapshot;
      const evidenceDigest = hash(JSON.stringify(snapshot.evidence));
      const revision = Number(row.revision);
      const snapshotFingerprint = hash(JSON.stringify({caseId,revision,stage:fixture.stage,status:fixture.status,snapshot:row.snapshot_json,recommendation:row.recommendation_json,recommendedAction:"SIMULATE_CHALLENGE_SUBMISSION",evidenceDigest}));
      const approvalId = randomBytes(16).toString("hex"), token = randomBytes(32).toString("base64url"), idempotencyKey = `lifecycle:${approvalId}`;
      this.db.prepare(`INSERT INTO lifecycle_approvals(approval_id,token_hash,case_id,actor,revision,stage,status,snapshot_fingerprint,recommended_action,evidence_digest,expires_at,idempotency_key)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(approvalId,hash(token),caseId,operator.actor,revision,String(fixture.stage),String(fixture.status),snapshotFingerprint,"SIMULATE_CHALLENGE_SUBMISSION",evidenceDigest,now+ttlMs,idempotencyKey);
      this.db.prepare("INSERT INTO lifecycle_approval_audit(approval_id,actor,event,at,note) VALUES(?,?,?,?,?)").run(approvalId,operator.actor,"LIFECYCLE_CHALLENGE_APPROVAL_ISSUED",now,"One-time authorization for OFFLINE_FIXTURE simulation only; no provider permission.");
      this.appendHistory(caseId,operator.actor,"LIFECYCLE_CHALLENGE_APPROVAL_ISSUED",null,"SIMULATE_CHALLENGE_SUBMISSION",now,idempotencyKey,`Approval ${approvalId}; revision ${revision}; expires ${now+ttlMs}; OFFLINE_FIXTURE only.`);
      return { approvalId,authorization:token,idempotencyKey,caseId,revision,stage:fixture.stage,status:fixture.status,recommendedAction:"SIMULATE_CHALLENGE_SUBMISSION",evidenceDigest,expiresAt:now+ttlMs,source:"OFFLINE_FIXTURE" };
    });
  }

  /** Appends one strictly ordered offline lifecycle event. This is a fixture simulation, never a provider confirmation. */
  advanceOfflineLifecycle(sessionToken: string, event: "SUBMIT_CHALLENGE" | "SIMULATE_ISSUER_REJECTION", eventId: string, now: number, authorization?: string): Record<string, unknown> {
    return this.transaction(() => {
      const operator = this.session(sessionToken, now);
      if (!operator) throw new Error("SESSION_EXPIRED_OR_INVALID");
      if (!/^[A-Za-z0-9_-]{8,80}$/.test(eventId)) throw new Error("INVALID_LIFECYCLE_EVENT_ID");
      const fixtureId = "kit04-stateful-lifecycle";
      const latest = this.db.prepare("SELECT * FROM mock_lifecycle WHERE fixture_id=? ORDER BY sequence DESC LIMIT 1").get(fixtureId);
      if (!latest) throw new Error("LIFECYCLE_NOT_SEEDED");
      if (this.db.prepare("SELECT event_id FROM mock_lifecycle WHERE event_id=?").get(eventId)) throw new Error("DUPLICATE_LIFECYCLE_EVENT");
      const sequence = Number(latest.sequence) + 1;
      let stage: string; let status: string; let nextEvent: string; let rejectionReason: string | null = null;
      if (event === "SUBMIT_CHALLENGE") {
        if (latest.stage !== "RFI" || latest.status !== "REQUIRES_RESPONSE") throw new Error("LIFECYCLE_TRANSITION_INVALID");
        if (!authorization) throw new Error("LIFECYCLE_APPROVAL_REQUIRED");
        const approval = this.db.prepare("SELECT * FROM lifecycle_approvals WHERE token_hash=?").get(hash(authorization));
        const caseRow = this.db.prepare("SELECT snapshot_json,recommendation_json,revision FROM review_cases WHERE case_id='kit04-credit-not-processed'").get();
        if (!approval || !caseRow || approval.actor !== operator.actor || Number(approval.expires_at) <= now || approval.consumed_at !== null) throw new Error("LIFECYCLE_APPROVAL_INVALID_OR_EXPIRED");
        const snapshot = JSON.parse(String(caseRow.snapshot_json)) as import("./dispute-engine.ts").DisputeSnapshot;
        const evidenceDigest = hash(JSON.stringify(snapshot.evidence));
        const fingerprint = hash(JSON.stringify({caseId:String(approval.case_id),revision:Number(caseRow.revision),stage:latest.stage,status:latest.status,snapshot:String(caseRow.snapshot_json),recommendation:String(caseRow.recommendation_json),recommendedAction:"SIMULATE_CHALLENGE_SUBMISSION",evidenceDigest}));
        if (Number(approval.revision)!==Number(caseRow.revision) || approval.stage!==latest.stage || approval.status!==latest.status || approval.recommended_action!=="SIMULATE_CHALLENGE_SUBMISSION" || approval.evidence_digest!==evidenceDigest || approval.snapshot_fingerprint!==fingerprint) throw new Error("LIFECYCLE_APPROVAL_STALE_OR_MISMATCHED");
        this.db.prepare("UPDATE lifecycle_approvals SET consumed_at=? WHERE approval_id=? AND consumed_at IS NULL").run(now,String(approval.approval_id));
        this.db.prepare("INSERT INTO lifecycle_approval_audit(approval_id,actor,event,at,note) VALUES(?,?,?,?,?)").run(String(approval.approval_id),operator.actor,"LIFECYCLE_CHALLENGE_APPROVAL_CONSUMED",now,`idempotency ${approval.idempotency_key}; synthetic submission only.`);
        this.appendHistory(String(approval.case_id),operator.actor,"LIFECYCLE_CHALLENGE_APPROVAL_CONSUMED",null,"SIMULATE_CHALLENGE_SUBMISSION",now,String(approval.idempotency_key),`Approval ${approval.approval_id} consumed once; no provider action.`);
        stage = "RFI"; status = "CHALLENGED"; nextEvent = "SIMULATED_CHALLENGE_SUBMITTED";
      } else {
        if (latest.stage !== "RFI" || latest.status !== "CHALLENGED") throw new Error("LIFECYCLE_TRANSITION_INVALID");
        stage = "CHARGEBACK"; status = "REQUIRES_RESPONSE"; nextEvent = "SIMULATED_ISSUER_REJECTION";
        rejectionReason = "Synthetic issuer rejected evidence; Kit 04 sandbox escalation scenario returns CHARGEBACK / REQUIRES_RESPONSE. No provider event was observed.";
      }
      const caseRow = this.db.prepare("SELECT revision FROM review_cases WHERE case_id='kit04-credit-not-processed'").get();
      const previousRevision = Number(caseRow?.revision ?? 0); const newRevision = previousRevision + 1;
      const deadline = status === "REQUIRES_RESPONSE" && stage !== "RFI" ? new Date(now + 72 * 60 * 60_000).toISOString() : null;
      this.db.prepare(`INSERT INTO mock_lifecycle(fixture_id,sequence,event,stage,status,source,event_id,rejection_reason,response_deadline,previous_revision,new_revision,recommendation)
        VALUES(?,?,?,?,?,'SIMULATED_OFFLINE_FIXTURE',?,?,?,?,?,?)`).run(fixtureId, sequence, nextEvent, stage, status, eventId, rejectionReason, deadline, previousRevision, newRevision,
        stage === "CHARGEBACK" ? "ESCALATE_FOR_REVIEW: chargeback-stage recovery assumptions are unvalidated for this synthetic case" : "Awaiting next simulated lifecycle event");
      if (caseRow) {
        const snapRow = this.db.prepare("SELECT snapshot_json FROM review_cases WHERE case_id='kit04-credit-not-processed'").get()!;
        const snap = JSON.parse(String(snapRow.snapshot_json)) as import("./dispute-engine.ts").DisputeSnapshot;
        const updated = { ...snap, stage, status, ...(deadline ? { responseDeadline: deadline } : {}) };
        const fee = Number(this.db.prepare("SELECT dispute_fee_minor FROM review_settings WHERE singleton=1").get()?.dispute_fee_minor ?? DEFAULT_DISPUTE_ECONOMICS.disputeFeeMinor);
        const recommendation = recommendStoredCase("kit04-credit-not-processed", updated, { ...DEFAULT_DISPUTE_ECONOMICS, disputeFeeMinor: fee }, now);
        this.db.prepare("UPDATE review_cases SET snapshot_json=?,recommendation_json=?,revision=? WHERE case_id='kit04-credit-not-processed'").run(JSON.stringify(updated), JSON.stringify(recommendation), newRevision);
      }
      this.appendHistory("kit04-credit-not-processed", operator.actor, nextEvent, null, null, now, eventId,
        `OFFLINE_FIXTURE only; ${latest.stage}/${latest.status} -> ${stage}/${status}; revision ${previousRevision}->${newRevision}; no provider request.`);
      return { event: nextEvent, source: "SIMULATED_OFFLINE_FIXTURE", stage, status, responseDeadline: deadline, previousRevision, newRevision };
    });
  }

  createSession(sessionToken: string, csrfToken: string, actor: string, now: number, ttlMs = 15 * 60_000): number {
    if (!sessionToken || !csrfToken || !actor || !Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 60 * 60_000) throw new Error("INVALID_SESSION");
    const expiresAt = now + ttlMs;
    this.db.prepare("INSERT INTO review_sessions(session_hash,actor,csrf_hash,created_at,expires_at) VALUES(?,?,?,?,?)")
      .run(hash(sessionToken), actor, hash(csrfToken), now, expiresAt);
    return expiresAt;
  }

  session(sessionToken: string, now: number): { actor: string; csrfHash: string; expiresAt: number } | undefined {
    const row = this.db.prepare("SELECT actor,csrf_hash,expires_at,revoked_at FROM review_sessions WHERE session_hash=?").get(hash(sessionToken));
    if (!row || row.revoked_at !== null || Number(row.expires_at) <= now) return undefined;
    return { actor: String(row.actor), csrfHash: String(row.csrf_hash), expiresAt: Number(row.expires_at) };
  }

  validateCsrf(sessionToken: string, csrfToken: string, now: number): boolean {
    const session = this.session(sessionToken, now);
    return !!session && safeEqual(session.csrfHash, hash(csrfToken));
  }

  issueAuthorizations(sessionToken: string, now: number, ttlMs = 5 * 60_000): {
    cases: Record<string, { approve: string; reject: string; revision: number }>;
    fee: string;
  } {
    if (ttlMs < 1_000 || ttlMs > 5 * 60_000) throw new Error("INVALID_AUTHORIZATION_TTL");
    return this.transaction(() => {
      const session = this.session(sessionToken, now);
      if (!session) throw new Error("SESSION_EXPIRED_OR_INVALID");
      const sessionHash = hash(sessionToken);
      const cases: Record<string, { approve: string; reject: string; revision: number }> = {};
      const rows = this.db.prepare("SELECT c.case_id,c.revision,c.snapshot_json,c.recommendation_json FROM review_cases c ORDER BY c.case_id").all()
        .filter((row) => !this.currentDecision(String(row.case_id), Number(row.revision)));
      for (const row of rows) {
        const caseId = String(row.case_id); const revision = Number(row.revision);
        const fingerprint = this.caseFingerprint(caseId, String(row.snapshot_json), String(row.recommendation_json));
        const approve = randomBytes(32).toString("base64url"); const reject = randomBytes(32).toString("base64url");
        this.db.prepare("INSERT INTO review_tokens(token_hash,session_hash,case_id,actor,action,revision,expires_at,case_fingerprint) VALUES(?,?,?,?,?,?,?,?)")
          .run(hash(approve), sessionHash, caseId, session.actor, "APPROVE", revision, now + ttlMs, fingerprint);
        this.db.prepare("INSERT INTO review_tokens(token_hash,session_hash,case_id,actor,action,revision,expires_at,case_fingerprint) VALUES(?,?,?,?,?,?,?,?)")
          .run(hash(reject), sessionHash, caseId, session.actor, "REJECT", revision, now + ttlMs, fingerprint);
        cases[caseId] = { approve, reject, revision };
      }
      const fee = randomBytes(32).toString("base64url");
      const settings = this.db.prepare("SELECT revision FROM review_settings WHERE singleton=1").get();
      this.db.prepare("INSERT INTO review_tokens(token_hash,session_hash,case_id,actor,action,revision,expires_at) VALUES(?,?,?,?,?,?,?)")
        .run(hash(fee), sessionHash, "settings", session.actor, "SET_FEE", Number(settings?.revision ?? 0), now + ttlMs);
      return { cases, fee };
    });
  }

  decide(sessionToken: string, caseId: string, choice: ReviewChoice, authorization: string, now: number): DecisionResult {
    if (choice !== "APPROVE" && choice !== "REJECT") throw new Error("INVALID_REVIEW_CHOICE");
    return this.transaction(() => {
      const sessionHash = hash(sessionToken); const session = this.session(sessionToken, now);
      if (!session) throw new Error("SESSION_EXPIRED_OR_INVALID");
      const tokenHash = hash(authorization);
      const token = this.db.prepare("SELECT * FROM review_tokens WHERE token_hash=?").get(tokenHash);
      if (!token || token.session_hash !== sessionHash || token.case_id !== caseId || token.actor !== session.actor || token.action !== choice || Number(token.expires_at) <= now) throw new Error("REVIEW_AUTHORIZATION_INVALID_OR_EXPIRED");
      if (token.consumed_at !== null) throw new Error("REVIEW_AUTHORIZATION_REPLAYED");
      const caseRow = this.db.prepare("SELECT snapshot_json,recommendation_json,revision FROM review_cases WHERE case_id=?").get(caseId);
      if (!caseRow || Number(caseRow.revision) !== Number(token.revision)) throw new Error("CASE_REVISION_CONFLICT");
      const snapshot = JSON.parse(String(caseRow.snapshot_json)) as import("./dispute-engine.ts").DisputeSnapshot;
      const storedRecommendation = JSON.parse(String(caseRow.recommendation_json)) as DisputeRecommendation;
      const currentFingerprint = this.caseFingerprint(caseId, String(caseRow.snapshot_json), String(caseRow.recommendation_json));
      if (typeof token.case_fingerprint !== "string" || !safeEqual(String(token.case_fingerprint), currentFingerprint))
        throw new Error("REVIEW_SNAPSHOT_MISMATCH");
      if (choice === "APPROVE") {
        const settings = this.db.prepare("SELECT dispute_fee_minor FROM review_settings WHERE singleton=1").get();
        const economics = { ...DEFAULT_DISPUTE_ECONOMICS, disputeFeeMinor: Number(settings?.dispute_fee_minor) };
        const updated = recommendStoredCase(caseId, snapshot, economics, now);
        if (updated.action === "NO_ACTION" || updated.action !== storedRecommendation.action ||
            fingerprintDisputeDecision(snapshot, updated) !== fingerprintDisputeDecision(snapshot, storedRecommendation))
          throw new Error("REVIEW_RECOMMENDATION_STALE_OR_NOT_ACTIONABLE");
      }
      const consume = this.db.prepare("UPDATE review_tokens SET consumed_at=? WHERE token_hash=? AND consumed_at IS NULL AND expires_at>?").run(now, tokenHash, now);
      if (consume.changes !== 1) throw new Error("REVIEW_AUTHORIZATION_REPLAYED");
      const existing = this.currentDecision(caseId, Number(caseRow.revision));
      if (existing) {
        const same = existing.choice === choice;
        this.appendHistory(caseId, session.actor, same ? "DUPLICATE_DECISION_REQUEST" : "CONFLICTING_DECISION_REQUEST", choice,
          String(JSON.parse(String(caseRow.recommendation_json)).action), now, String(existing.idempotency_key), "Local review only; provider action remains unexecuted.");
        return same ? "ALREADY_RECORDED" : "CONFLICT";
      }
      const recommendation = storedRecommendation;
      const idempotencyKey = `review:${caseId}:${Number(caseRow.revision)}:${choice}`;
      const historicalDecision = this.db.prepare("SELECT case_id FROM review_decisions WHERE case_id=?").get(caseId);
      if (historicalDecision) {
        this.db.prepare(`INSERT INTO review_decision_events(case_id,choice,recommended_action,actor,created_at,revision,idempotency_key,provider_action_state,refund_state)
          VALUES(?,?,?,?,?,?,?,'NOT_EXECUTED','NOT_CONFIRMED')`).run(caseId, choice, recommendation.action, session.actor, now, Number(caseRow.revision), idempotencyKey);
      } else {
        this.db.prepare(`INSERT INTO review_decisions(case_id,choice,recommended_action,actor,created_at,revision,idempotency_key,provider_action_state,refund_state)
          VALUES(?,?,?,?,?,?,?,'NOT_EXECUTED','NOT_CONFIRMED')`).run(caseId, choice, recommendation.action, session.actor, now, Number(caseRow.revision), idempotencyKey);
      }
      const escalation=choice==="APPROVE"&&recommendation.action==="ESCALATE_FOR_REVIEW";
      this.appendHistory(caseId, session.actor, escalation?"HUMAN_ESCALATION_RECORDED":choice === "APPROVE" ? "RECOMMENDATION_APPROVED" : "RECOMMENDATION_REJECTED", choice,
        recommendation.action, now, idempotencyKey, escalation?"Operator recorded a local human escalation for follow-up; no provider request, financial action, or refund was executed.":
          choice === "APPROVE" ? "Local approval only; no provider action or refund was executed." : "Local rejection only; no provider action was executed.");
      return "RECORDED";
    });
  }

  /** Offline-only: source text is untrusted; no provider or model operation. */
  ingestOfflineText(sessionToken: string, caseId: string, documentId: string, text: string, now: number): { sha256: string; facts: readonly ExtractedEvidenceFact[] } {
    return this.transaction(() => {
      const operator = this.session(sessionToken, now);
      if (!operator) throw new Error("SESSION_EXPIRED_OR_INVALID");
      if (caseId !== "kit04-evidence-lab") throw new Error("OFFLINE_LAB_CASE_ONLY");
      const row = this.db.prepare("SELECT case_id,revision FROM review_cases WHERE case_id=?").get(caseId);
      if (!row || this.currentDecision(caseId, Number(row.revision)))
        throw new Error("OFFLINE_LAB_CASE_CLOSED");
      const document = ingestOfflineTextEvidence(caseId, documentId, text, new Date(now).toISOString());
      const facts = extractOfflineEvidenceFacts(document);
      const existing = this.db.prepare("SELECT sha256 FROM offline_text_documents WHERE case_id=?").all(caseId);
      if (existing.length >= 3 || existing.some((entry) => entry.sha256 === document.sha256))
        throw new Error("OFFLINE_DOCUMENT_LIMIT_OR_DUPLICATE");
      if (this.db.prepare("SELECT document_id FROM offline_text_documents WHERE document_id=?").get(documentId))
        throw new Error("OFFLINE_DOCUMENT_ID_ALREADY_USED");
      this.db.prepare("INSERT INTO offline_text_documents(document_id,case_id,content,sha256,received_at,actor) VALUES(?,?,?,?,?,?)")
        .run(documentId, caseId, document.text, document.sha256, document.receivedAt, operator.actor);
      for (const fact of facts) this.db.prepare("INSERT INTO offline_text_facts(fact_id,document_id,case_id,quote,start_offset,end_offset) VALUES(?,?,?,?,?,?)")
        .run(fact.factId, fact.documentId, caseId, fact.quote, fact.startOffset, fact.endOffset);
      this.db.prepare("UPDATE review_cases SET revision=revision+1 WHERE case_id=?").run(caseId);
      this.appendHistory(caseId, operator.actor, "OFFLINE_TEXT_INGESTED", null, null, now, null,
        "Offline text hash " + document.sha256 + "; extracted fact count " + facts.length + "; UNVERIFIED; no provider action.");
      return { sha256: document.sha256, facts };
    });
  }

  /** Explicit operator action; provenance is OPERATOR, never trusted as Airwallex evidence. */
  attestOfflineTextFact(sessionToken: string, caseId: string, documentId: string, factId: string,
    expectedSha256: string, now: number): { before: string; after: string; revision: number } {
    return this.transaction(() => {
      const operator = this.session(sessionToken, now);
      if (!operator) throw new Error("SESSION_EXPIRED_OR_INVALID");
      if (caseId !== "kit04-evidence-lab") throw new Error("OFFLINE_LAB_CASE_ONLY");
      if (this.hasCurrentDecision(caseId))
        throw new Error("OFFLINE_LAB_CASE_CLOSED");
      if (this.hasTextEvidenceAttestation(caseId))
        throw new Error("OFFLINE_LAB_ATTESTATION_LIMIT");
      const raw = this.db.prepare("SELECT * FROM offline_text_documents WHERE case_id=? AND document_id=?").get(caseId, documentId);
      const stored = this.db.prepare("SELECT * FROM offline_text_facts WHERE case_id=? AND document_id=? AND fact_id=?").get(caseId, documentId, factId);
      if (!raw || !stored) throw new Error("OFFLINE_FACT_NOT_FOUND");
      const document: TextEvidenceDocument = { caseId, documentId, source: "OFFLINE_OPERATOR_TEXT",
        mediaType: "text/plain", text: String(raw.content), sha256: String(raw.sha256), receivedAt: String(raw.received_at) };
      const extracted = extractOfflineEvidenceFacts(document).find((fact) => fact.factId === factId);
      if (!extracted || stored.quote !== extracted.quote || Number(stored.start_offset) !== extracted.startOffset ||
          Number(stored.end_offset) !== extracted.endOffset) throw new Error("OFFLINE_CITATION_CHANGED");
      const evidence = attestOfflineFact(document, extracted, operator.actor, expectedSha256);
      const row = this.db.prepare("SELECT snapshot_json,recommendation_json,revision FROM review_cases WHERE case_id=?").get(caseId);
      if (!row) throw new Error("OFFLINE_LAB_CASE_CLOSED");
      const snapshot = JSON.parse(String(row.snapshot_json)) as import("./dispute-engine.ts").DisputeSnapshot;
      if (snapshot.evidence.some((entry) => entry.id === evidence.id)) throw new Error("DUPLICATE_EVIDENCE_ID");
      const settings = this.db.prepare("SELECT dispute_fee_minor FROM review_settings WHERE singleton=1").get();
      const economics = { ...DEFAULT_DISPUTE_ECONOMICS, disputeFeeMinor: Number(settings?.dispute_fee_minor) };
      const before = recommendDisputeAction(snapshot, economics, now);
      const updated = { ...snapshot, evidence: [...snapshot.evidence, evidence] };
      const after = recommendDisputeAction(updated, economics, now);
      this.db.prepare("INSERT INTO offline_text_attestations(fact_id,actor,attested_at,evidence_id) VALUES(?,?,?,?)")
        .run(factId, operator.actor, now, evidence.id);
      this.db.prepare("INSERT INTO evidence_refs(case_id,evidence_id,provenance_json,evidence_json) VALUES(?,?,?,?)")
        .run(caseId, evidence.id, JSON.stringify(evidence.provenance), JSON.stringify(evidence));
      this.db.prepare("UPDATE review_cases SET snapshot_json=?,recommendation_json=?,revision=revision+1 WHERE case_id=?")
        .run(JSON.stringify(updated), JSON.stringify(after), caseId);
      this.appendHistory(caseId, operator.actor, "OFFLINE_EVIDENCE_REPLAN", null, after.action, now,
        "offline-replan:" + factId, "OFFLINE_FIXTURE: " + before.action + " -> " + after.action +
        "; cited sha256 " + document.sha256 + "; case revision advanced; all older approvals stale; NOT_EXECUTED.");
      return { before: before.action, after: after.action, revision: Number(row.revision) + 1 };
    });
  }

  private hasTextEvidenceAttestation(caseId: string): boolean {
    return !!this.db.prepare(`SELECT 1 AS present FROM offline_text_attestations a
      JOIN offline_text_facts f ON f.fact_id=a.fact_id WHERE f.case_id=?
      UNION ALL SELECT 1 AS present FROM proposal_attestations a
      JOIN evidence_proposals p ON p.proposal_id=a.proposal_id WHERE p.case_id=? LIMIT 1`).get(caseId,caseId);
  }

  /** Runs the selected proposal provider outside a SQLite transaction, then stores only schema-valid outputs.
   * Ungrounded outputs are retained as explicitly rejected audit records and cannot be attested.
   */
  async requestEvidenceProposal(sessionToken: string, caseId: string, documentId: string,
    provider: EvidenceProposalProvider, now: number): Promise<{ modelMode: string; model: string; extractionContractVersion: string | null;
      rawModelProposalCount: number; locallyEnrichedProposalCount: number; modelLatencyMs: number | null; validationLatencyMs: number | null;
      locallyDerivedOffsets: number; quoteUniquenessFailures: number; groundingFailures: number; semanticFalsePositives: number;
      proposals: Array<EvidenceProposal & { proposalId: string; groundingStatus: string; groundingReasonCode: string }> }> {
    const requestSnapshot = this.transaction(() => {
      if (!this.session(sessionToken,now)) throw new Error("SESSION_EXPIRED_OR_INVALID");
      if (caseId !== "kit04-evidence-lab") throw new Error("OFFLINE_LAB_CASE_ONLY");
      if (this.hasCurrentDecision(caseId)) throw new Error("OFFLINE_LAB_CASE_CLOSED");
      const raw = this.db.prepare(`SELECT d.*,c.revision AS case_revision,c.snapshot_json,c.recommendation_json FROM offline_text_documents d
        JOIN review_cases c ON c.case_id=d.case_id WHERE d.case_id=? AND d.document_id=?`).get(caseId,documentId);
      if (!raw) throw new Error("OFFLINE_DOCUMENT_NOT_FOUND");
      const doc = ingestOfflineTextEvidence(caseId,documentId,String(raw.content),String(raw.received_at));
      if (doc.sha256 !== String(raw.sha256)) throw new Error("SOURCE_HASH_INVALID");
      const caseSnapshotDigest=createHash("sha256").update(JSON.stringify([raw.snapshot_json,raw.recommendation_json]),"utf8").digest("hex");
      return { document:doc, caseRevision:Number(raw.case_revision), caseSnapshotDigest };
    });

    const document = requestSnapshot.document;
    const output = await provider.propose(document,new Date(now).toISOString());
    let results: Array<{proposal:EvidenceProposal;groundingReasonCode:string}>;
    let extractionContractVersion: string | null = null;
    let rawModelProposalCount = 0;
    let locallyDerivedOffsets = 0;
    let validationLatencyMs = provider.lastValidationLatencyMs ?? null;
    if (provider.mode === "LOCAL_LLM") {
      const metadata = output && typeof output === "object" && !Array.isArray(output)
        ? output as {proposals?:unknown;extractionContractVersion?:unknown;validationLatencyMs?:unknown}
        : null;
      if (!metadata || metadata.extractionContractVersion !== MODEL_OUTPUT_CONTRACT_VERSION) throw new Error("MODEL_EXTRACTION_CONTRACT_VERSION_MISMATCH");
      if (!provider.actualModelId || provider.actualModelId !== provider.model) throw new Error("LOCAL_MODEL_IDENTITY_NOT_VERIFIED");
      const claims = parseModelProposalResponse({proposals:metadata.proposals});
      rawModelProposalCount = claims.length;
      extractionContractVersion = MODEL_OUTPUT_CONTRACT_VERSION;
      if (typeof metadata.validationLatencyMs === "number" && Number.isFinite(metadata.validationLatencyMs) && metadata.validationLatencyMs >= 0)
        validationLatencyMs = metadata.validationLatencyMs;
      const enriched = enrichModelProposals(claims,document,provider.actualModelId,new Date(now).toISOString());
      results = enriched.map(({proposal,groundingReasonCode})=>({proposal,groundingReasonCode}));
      locallyDerivedOffsets = enriched.filter(item=>item.groundingReasonCode!=="QUOTE_NOT_FOUND"&&item.groundingReasonCode!=="QUOTE_NOT_UNIQUE").length;
    } else {
      const payload = output && typeof output === "object" && !Array.isArray(output) && Array.isArray((output as {proposals?:unknown}).proposals)
        ? {proposals:(output as {proposals:unknown}).proposals} : output;
      const parsed = parseProposalResponse(payload);
      results = parsed.map(proposal => ({proposal, groundingReasonCode:explainProposalGrounding(proposal,document)}));
      rawModelProposalCount = parsed.length;
    }
    return this.transaction(() => {
      const operator = this.session(sessionToken,now);
      if (!operator) throw new Error("SESSION_EXPIRED_OR_INVALID");
      if (this.hasCurrentDecision(caseId)) throw new Error("OFFLINE_LAB_CASE_CLOSED");
      const current = this.db.prepare(`SELECT d.content,d.sha256,c.revision AS case_revision,c.snapshot_json,c.recommendation_json FROM offline_text_documents d
        JOIN review_cases c ON c.case_id=d.case_id WHERE d.case_id=? AND d.document_id=?`).get(caseId,documentId);
      if (!current || String(current.sha256)!==document.sha256 || String(current.content)!==document.text ||
        createHash("sha256").update(String(current.content),"utf8").digest("hex")!==String(current.sha256)) throw new Error("SOURCE_CHANGED_DURING_MODEL_RUN");
      if (Number(current.case_revision)!==requestSnapshot.caseRevision) throw new Error("CASE_REVISION_CHANGED_DURING_MODEL_RUN");
      if (createHash("sha256").update(JSON.stringify([current.snapshot_json,current.recommendation_json]),"utf8").digest("hex")!==requestSnapshot.caseSnapshotDigest)
        throw new Error("CASE_SNAPSHOT_CHANGED_DURING_MODEL_RUN");
      const stored: Array<EvidenceProposal & { proposalId:string; groundingStatus:string; groundingReasonCode:string }> = [];
      for (const {proposal,groundingReasonCode} of results) {
        const proposalId = hash([proposal.caseId,proposal.documentId,proposal.documentSha256,proposal.factType,
          proposal.startOffset,proposal.endOffset,proposal.exactQuote].join("\u0000"));
        const record = { ...proposal, groundingStatus:groundingReasonCode==="GROUNDED" ? "GROUNDED" : "REJECTED",
          groundingReasonCode };
        const existing = this.db.prepare("SELECT proposal_json FROM evidence_proposals WHERE proposal_id=?").get(proposalId);
        if (!existing) this.db.prepare("INSERT INTO evidence_proposals(proposal_id,case_id,document_id,proposal_json,created_at) VALUES(?,?,?,?,?)")
          .run(proposalId,caseId,documentId,JSON.stringify(record),now);
        if (groundingReasonCode==="GROUNDED") {
          this.appendHistory(caseId,operator.actor,"EVIDENCE_MODEL_PROPOSAL",null,null,now,proposalId,
            `mode=${provider.mode}; model=${provider.model}; grounded proposal awaits human attestation; no policy action.`);
        } else {
          this.appendHistory(caseId,operator.actor,"EVIDENCE_PROPOSAL_REJECTED",null,null,now,proposalId,
            `mode=${provider.mode}; model proposal rejected by source grounding: ${groundingReasonCode}; no decision effect.`);
        }
        stored.push({ ...proposal, proposalId, groundingStatus:record.groundingStatus, groundingReasonCode });
      }
      if (!results.length) this.appendHistory(caseId,operator.actor,"EVIDENCE_MODEL_NO_CLAIM",null,null,now,null,
        `mode=${provider.mode}; model=${provider.model}; no structured claims returned; no decision effect.`);
      const rejected=results.filter(item=>item.groundingReasonCode!=="GROUNDED");
      return { modelMode:provider.mode, model:provider.mode==="LOCAL_LLM"?provider.actualModelId!:provider.model,
        extractionContractVersion, rawModelProposalCount, locallyEnrichedProposalCount:results.length,
        modelLatencyMs:provider.lastModelLatencyMs??null, validationLatencyMs,
        locallyDerivedOffsets, quoteUniquenessFailures:rejected.filter(item=>item.groundingReasonCode==="QUOTE_NOT_FOUND"||item.groundingReasonCode==="QUOTE_NOT_UNIQUE").length,
        groundingFailures:rejected.length, semanticFalsePositives:rejected.filter(item=>item.groundingReasonCode==="QUOTE_DOES_NOT_SUPPORT_CLAIM").length,
        proposals:stored };
    });
  }

  recordEvidenceModelFailure(sessionToken:string,caseId:string,mode:string,errorCode:string,now:number):void {
    this.transaction(()=>{
      const operator=this.session(sessionToken,now);
      if(!operator)throw new Error("SESSION_EXPIRED_OR_INVALID");
      if(caseId!=="kit04-evidence-lab")throw new Error("OFFLINE_LAB_CASE_ONLY");
      const safeCode=/^[A-Z0-9_]{1,64}$/.test(errorCode)?errorCode:"LOCAL_MODEL_RUN_FAILED";
      this.appendHistory(caseId,operator.actor,"EVIDENCE_MODEL_RUN_FAILED",null,null,now,null,
        `mode=${mode}; failure=${safeCode}; no proposal was accepted and no provider action occurred.`);
    });
  }

  /** Deterministic OFFLINE_MOCK proposal creation. It never performs model inference. */
  requestMockProposal(sessionToken: string, caseId: string, documentId: string, now: number): EvidenceProposal[] {
    return this.transaction(() => {
      if (!this.session(sessionToken, now)) throw new Error("SESSION_EXPIRED_OR_INVALID");
      if (caseId !== "kit04-evidence-lab") throw new Error("OFFLINE_LAB_CASE_ONLY");
      const raw = this.db.prepare("SELECT * FROM offline_text_documents WHERE case_id=? AND document_id=?").get(caseId, documentId);
      if (!raw) throw new Error("OFFLINE_DOCUMENT_NOT_FOUND");
      const doc: TextEvidenceDocument = { caseId, documentId, source: "OFFLINE_OPERATOR_TEXT", mediaType: "text/plain", text: String(raw.content), sha256: String(raw.sha256), receivedAt: String(raw.received_at) };
      const provider = new OfflineMockProposalProvider();
      const proposals = parseProposalResponse(provider.propose(doc, new Date(now).toISOString()));
      const accepted: EvidenceProposal[] = [];
      for (const p of proposals) {
        if (!groundProposal(p, doc)) { this.appendHistory(caseId, this.session(sessionToken, now)!.actor, "EVIDENCE_PROPOSAL_REJECTED", null, null, now, null, "Ungrounded mock proposal rejected; no decision effect."); continue; }
        const proposalId = hash([p.caseId,p.documentId,p.documentSha256,p.factType,p.startOffset,p.endOffset,p.exactQuote].join("\u0000"));
        if (this.db.prepare("SELECT proposal_id FROM evidence_proposals WHERE proposal_id=?").get(proposalId)) continue;
        this.db.prepare("INSERT INTO evidence_proposals(proposal_id,case_id,document_id,proposal_json,created_at) VALUES(?,?,?,?,?)").run(proposalId, caseId, documentId, JSON.stringify(p), now);
        accepted.push(p);
      }
      return accepted;
    });
  }

  /** A local operator may attest any persisted proposal only after rechecking source grounding. */
  attestGroundedProposal(sessionToken: string, caseId: string, documentId: string, proposalHash: string, now: number): { before: string; after: string; revision: number; citations: string[] } {
    return this.transaction(()=>{
      const operator=this.session(sessionToken,now);
      if(!operator)throw new Error("SESSION_EXPIRED_OR_INVALID");
      if(caseId!=="kit04-evidence-lab")throw new Error("OFFLINE_LAB_CASE_ONLY");
      if(this.hasCurrentDecision(caseId))throw new Error("OFFLINE_LAB_CASE_CLOSED");
      const row=this.db.prepare(`SELECT p.proposal_json,p.proposal_id,d.content,d.sha256,d.received_at
        FROM evidence_proposals p JOIN offline_text_documents d ON d.document_id=p.document_id
        WHERE p.case_id=? AND p.document_id=? AND p.proposal_id=?`).get(caseId,documentId,proposalHash);
      if(!row)throw new Error("PROPOSAL_NOT_FOUND");
      const stored=JSON.parse(String(row.proposal_json)) as EvidenceProposal & {groundingStatus?:string;groundingReasonCode?:string};
      const {groundingStatus:_storedGroundingStatus,groundingReasonCode:_storedGroundingReason,...candidate}=stored;
      const p=parseProposalResponse({proposals:[candidate]})[0]!;
      const doc:TextEvidenceDocument={caseId,documentId,source:"OFFLINE_OPERATOR_TEXT",mediaType:"text/plain",
        text:String(row.content),sha256:String(row.sha256),receivedAt:String(row.received_at)};
      if(this.db.prepare("SELECT proposal_id FROM proposal_attestations WHERE proposal_id=?").get(proposalHash))throw new Error("PROPOSAL_ALREADY_ATTESTED");
      if(this.db.prepare("SELECT proposal_id FROM proposal_rejections WHERE proposal_id=?").get(proposalHash))throw new Error("PROPOSAL_ALREADY_REJECTED");
      if(this.hasTextEvidenceAttestation(caseId))throw new Error("OFFLINE_LAB_ATTESTATION_LIMIT");
      if(!groundProposal(p,doc))throw new Error("EVIDENCE_CITATION_NOT_GROUNDED");
      const evidenceId="local-fact-"+hash(p.documentSha256+":"+p.startOffset+":"+p.endOffset+":0").slice(0,24);
      const evidence=Object.freeze({id:evidenceId,kind:p.factType,supportsMerchant:true,strength:"STRONG" as const,
        summary:"Operator-attested local model proposal (not provider-verified): "+p.exactQuote,
        provenance:Object.freeze({source:"OPERATOR",reference:"offline-text:"+documentId+":sha256:"+doc.sha256+
          ":chars:"+p.startOffset+"-"+p.endOffset+":actor:"+hash(operator.actor).slice(0,12),
          observedAt:doc.receivedAt,verified:true})});
      const caseRow=this.db.prepare("SELECT snapshot_json,revision FROM review_cases WHERE case_id=?").get(caseId);
      if(!caseRow)throw new Error("OFFLINE_LAB_CASE_CLOSED");
      const snapshot=JSON.parse(String(caseRow.snapshot_json)) as DisputeSnapshot;
      if(snapshot.evidence.some(item=>item.id===evidenceId))throw new Error("DUPLICATE_EVIDENCE_ID");
      const settings=this.db.prepare("SELECT dispute_fee_minor FROM review_settings WHERE singleton=1").get();
      const economics={...DEFAULT_DISPUTE_ECONOMICS,disputeFeeMinor:Number(settings?.dispute_fee_minor)};
      const before=recommendStoredCase(caseId,snapshot,economics,now);
      const updated={...snapshot,evidence:[...snapshot.evidence,evidence]};
      const after=recommendStoredCase(caseId,updated,economics,now);
      this.db.prepare("INSERT INTO proposal_attestations(proposal_id,actor,attested_at) VALUES(?,?,?)").run(proposalHash,operator.actor,now);
      this.db.prepare("INSERT INTO evidence_refs(case_id,evidence_id,provenance_json,evidence_json) VALUES(?,?,?,?)")
        .run(caseId,evidenceId,JSON.stringify(evidence.provenance),JSON.stringify(evidence));
      this.db.prepare("UPDATE review_cases SET snapshot_json=?,recommendation_json=?,revision=revision+1 WHERE case_id=?")
        .run(JSON.stringify(updated),JSON.stringify(after),caseId);
      this.appendHistory(caseId,operator.actor,"EVIDENCE_PROPOSAL_ATTESTED",null,after.action,now,
        "model-attestation:"+proposalHash,"Operator attested a grounded local model claim; deterministic policy recalculated; all older approvals stale; provider action NOT_EXECUTED.");
      return {before:before.action,after:after.action,revision:Number(caseRow.revision)+1,
        citations:[`${documentId} sha256:${p.documentSha256} UTF-16 chars ${p.startOffset}-${p.endOffset}`]};
    });
  }

  rejectEvidenceProposal(sessionToken: string, caseId: string, proposalId: string, now: number): void {
    this.transaction(() => {
      const operator = this.session(sessionToken, now); if (!operator) throw new Error("SESSION_EXPIRED_OR_INVALID");
      const exists = this.db.prepare("SELECT proposal_id FROM evidence_proposals WHERE proposal_id=? AND case_id=?").get(proposalId,caseId);
      if (!exists) throw new Error("PROPOSAL_NOT_FOUND");
      if (this.db.prepare("SELECT proposal_id FROM proposal_attestations WHERE proposal_id=?").get(proposalId)) throw new Error("PROPOSAL_ALREADY_ATTESTED");
      if (this.db.prepare("SELECT proposal_id FROM proposal_rejections WHERE proposal_id=?").get(proposalId)) throw new Error("PROPOSAL_ALREADY_REJECTED");
      this.db.prepare("INSERT INTO proposal_rejections(proposal_id,actor,rejected_at) VALUES(?,?,?)").run(proposalId,operator.actor,now);
      this.appendHistory(caseId,operator.actor,"EVIDENCE_PROPOSAL_REJECTED",null,null,now,proposalId,"Operator rejected an unverified proposal; no policy or provider effect.");
    });
  }

  setFee(sessionToken: string, feeMinor: number, authorization: string, now: number): void {
    if (!Number.isSafeInteger(feeMinor) || feeMinor < 0 || feeMinor > 10_000_000) throw new Error("INVALID_DISPUTE_FEE");
    this.transaction(() => {
      const sessionHash = hash(sessionToken); const session = this.session(sessionToken, now);
      if (!session) throw new Error("SESSION_EXPIRED_OR_INVALID");
      const tokenHash = hash(authorization);
      const token = this.db.prepare("SELECT * FROM review_tokens WHERE token_hash=?").get(tokenHash);
      const setting = this.db.prepare("SELECT dispute_fee_minor,revision FROM review_settings WHERE singleton=1").get();
      if (!token || token.action !== "SET_FEE" || token.case_id !== "settings" || token.session_hash !== sessionHash || token.actor !== session.actor ||
          Number(token.revision) !== Number(setting?.revision) || Number(token.expires_at) <= now || token.consumed_at !== null) throw new Error("FEE_AUTHORIZATION_INVALID_OR_EXPIRED");
      if (Number(setting?.dispute_fee_minor) === feeMinor) {
        this.db.prepare("UPDATE review_tokens SET consumed_at=? WHERE token_hash=? AND consumed_at IS NULL").run(now, tokenHash);
        return;
      }
      this.db.prepare("UPDATE review_tokens SET consumed_at=? WHERE token_hash=? AND consumed_at IS NULL").run(now, tokenHash);
      const nextRevision = Number(setting?.revision ?? 0) + 1;
      this.db.prepare("UPDATE review_settings SET dispute_fee_minor=?,revision=? WHERE singleton=1").run(feeMinor, nextRevision);
      const cases = this.db.prepare("SELECT case_id,snapshot_json,revision FROM review_cases").all();
      const economics = { ...DEFAULT_DISPUTE_ECONOMICS, disputeFeeMinor: feeMinor };
      for (const row of cases) {
        const caseId = String(row.case_id);
        const decision = this.currentDecision(caseId, Number(row.revision));
        if (decision) {
          this.db.prepare("INSERT INTO review_decision_invalidations(case_id,revision,invalidated_at,invalidated_by,reason) VALUES(?,?,?,?,?)")
            .run(caseId, Number(decision.decision_revision), now, session.actor, "DISPUTE_FEE_CHANGED");
          this.appendHistory(caseId, session.actor, "RECOMMENDATION_APPROVAL_INVALIDATED_BY_FEE_CHANGE",
            decision.choice as ReviewChoice, String(decision.recommended_action), now, String(decision.idempotency_key),
            `Approved revision ${Number(decision.decision_revision)} was invalidated by a dispute-fee change; fresh review required.`);
        }
        const snapshot = JSON.parse(String(row.snapshot_json)) as import("./dispute-engine.ts").DisputeSnapshot;
        this.db.prepare("UPDATE review_cases SET recommendation_json=?,revision=revision+1 WHERE case_id=?")
          .run(JSON.stringify(recommendStoredCase(caseId, snapshot, economics, now)), caseId);
      }
      this.appendHistory("settings", session.actor, "DISPUTE_FEE_UPDATED", null, null, now, `fee:${nextRevision}`, "Fee updated in integer minor units; pending recommendations recalculated.");
    });
  }

  /** Durable idempotency reservation for a future live adapter; creating this row does not dispatch anything. */
  claimProviderAction(caseId: string, action: "CHALLENGE" | "ACCEPT", actor: string, approvalId: string, idempotencyKey: string, now: number): boolean {
    if (!caseId || !actor || !approvalId || !idempotencyKey) return false;
    return this.transaction(() => {
      if (!this.db.prepare("SELECT case_id FROM review_cases WHERE case_id=?").get(caseId)) throw new Error("UNKNOWN_DISPUTE_CASE");
      try {
        this.db.prepare("INSERT INTO provider_action_claims(idempotency_key,approval_id,case_id,action,actor,claimed_at,state) VALUES(?,?,?,?,?,?,'RESERVED')")
          .run(idempotencyKey, approvalId, caseId, action, actor, now);
      } catch { return false; }
      this.appendHistory(caseId, actor, "PROVIDER_ACTION_RESERVED", null, action, now, idempotencyKey,
        "Durable idempotency reservation only; no provider request was sent.");
      return true;
    });
  }

  private currentDecision(caseId: string, revision: number): Record<string, unknown> | undefined {
    return this.db.prepare(`SELECT d.case_id,d.choice,d.recommended_action,d.actor,d.created_at,d.idempotency_key,
      d.decision_revision,d.provider_action_state,d.refund_state FROM (
        SELECT case_id,choice,recommended_action,actor,created_at,idempotency_key,revision AS decision_revision,
          provider_action_state,refund_state,0 AS source_order FROM review_decisions WHERE case_id=?
        UNION ALL
        SELECT case_id,choice,recommended_action,actor,created_at,idempotency_key,revision AS decision_revision,
          provider_action_state,refund_state,1 AS source_order FROM review_decision_events WHERE case_id=?
      ) d WHERE d.decision_revision=? AND NOT EXISTS (
        SELECT 1 FROM review_decision_invalidations i WHERE i.case_id=d.case_id AND i.revision=d.decision_revision
      ) ORDER BY d.created_at DESC,d.source_order DESC LIMIT 1`).get(caseId, caseId, revision);
  }

  private hasCurrentDecision(caseId: string): boolean {
    const row = this.db.prepare("SELECT revision FROM review_cases WHERE case_id=?").get(caseId);
    return !!row && !!this.currentDecision(caseId, Number(row.revision));
  }

  private appendHistory(caseId: string, actor: string, event: string, choice: ReviewChoice | null, action: string | null, at: number, key: string | null, note: string): void {
    this.db.prepare("INSERT INTO action_history(case_id,actor,event,choice,action,created_at,idempotency_key,note) VALUES(?,?,?,?,?,?,?,?)")
      .run(caseId, actor, event, choice, action, at, key, note);
  }

  dashboard(): { feeMinor: number; settingsRevision: number; cases: Array<Record<string, unknown>>; history: Array<Record<string, unknown>>; lifecycle: Array<Record<string, unknown>>; lifecycleDemo: Array<Record<string, unknown>> } {
    const settings = this.db.prepare("SELECT dispute_fee_minor,revision FROM review_settings WHERE singleton=1").get();
    const rows = this.db.prepare(`SELECT c.case_id,c.snapshot_json,c.recommendation_json,c.revision
      FROM review_cases c ORDER BY c.case_id`).all();
    const cases = rows.map((row) => {
      const currentDecision = this.currentDecision(String(row.case_id), Number(row.revision));
      return ({
      caseId: row.case_id, snapshot: JSON.parse(String(row.snapshot_json)), recommendation: JSON.parse(String(row.recommendation_json)), revision: Number(row.revision),
      decision: currentDecision ? { choice: currentDecision.choice, recommendedAction: currentDecision.recommended_action,
        actor: currentDecision.actor, createdAt: Number(currentDecision.created_at), idempotencyKey: currentDecision.idempotency_key,
        revision: Number(currentDecision.decision_revision), providerActionState: currentDecision.provider_action_state,
        refundState: currentDecision.refund_state } : null,
      evidence: this.db.prepare("SELECT evidence_json FROM evidence_refs WHERE case_id=? ORDER BY evidence_id").all(String(row.case_id)).map((item) => JSON.parse(String(item.evidence_json))),
      documents: this.db.prepare("SELECT document_id,sha256,received_at,actor,content FROM offline_text_documents WHERE case_id=? ORDER BY received_at,document_id")
        .all(String(row.case_id)).map((doc) => ({
          documentId: doc.document_id, sha256: doc.sha256, receivedAt: doc.received_at, source: "OFFLINE_OPERATOR_TEXT",
          text: doc.content,
          facts: this.db.prepare("SELECT f.fact_id,f.quote,f.start_offset,f.end_offset,a.actor AS attested_by,a.attested_at FROM offline_text_facts f LEFT JOIN offline_text_attestations a ON a.fact_id=f.fact_id WHERE f.document_id=? ORDER BY f.fact_id")
            .all(String(doc.document_id)).map((f) => ({ factId: f.fact_id, quote: f.quote, startOffset: f.start_offset,
              endOffset: f.end_offset, attested: f.attested_at !== null && f.attested_at !== undefined, attestedBy: f.attested_by }))
        })),
      proposals: this.db.prepare("SELECT proposal_id,proposal_json,created_at FROM evidence_proposals WHERE case_id=? ORDER BY created_at,proposal_id").all(String(row.case_id)).map((p) => ({ proposalId:p.proposal_id, ...JSON.parse(String(p.proposal_json)), attested: !!this.db.prepare("SELECT proposal_id FROM proposal_attestations WHERE proposal_id=?").get(String(p.proposal_id)), rejected: !!this.db.prepare("SELECT proposal_id FROM proposal_rejections WHERE proposal_id=?").get(String(p.proposal_id)) })),
      });
    });
    const history = this.db.prepare("SELECT id,case_id,actor,event,choice,action,created_at,idempotency_key,note FROM action_history ORDER BY id").all();
    const lifecycle = this.db.prepare("SELECT fixture_id,sequence,event,stage,status,source FROM mock_lifecycle WHERE fixture_id='kit04-offline-rfi-lifecycle' ORDER BY sequence").all();
    const lifecycleDemo = this.db.prepare("SELECT fixture_id,sequence,event,stage,status,source,event_id,rejection_reason,response_deadline,previous_revision,new_revision,recommendation FROM mock_lifecycle WHERE fixture_id='kit04-stateful-lifecycle' ORDER BY sequence").all();
    return { feeMinor: Number(settings?.dispute_fee_minor), settingsRevision: Number(settings?.revision), cases, history, lifecycle, lifecycleDemo };
  }

  async closeAndCheckpoint(): Promise<void> { this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); this.db.close(); }
}

