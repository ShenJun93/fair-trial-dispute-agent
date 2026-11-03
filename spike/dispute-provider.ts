import { disputeDeadlineError, fingerprintDisputeDecision, validateDisputeSnapshot, type DisputeEvidence, type DisputeRecommendation, type DisputeSnapshot, type FinancialAction, type HumanApproval } from "./dispute-engine.ts";

export type DisputeProviderMode = "MOCK" | "LIVE";

export interface ProviderStatusReceipt {
  caseId: string;
  source: "MOCK_FIXTURE" | "AIRWALLEX_AUTHENTICATED";
  available: boolean;
  stage: string;
  status: string;
  retrievedAt: number;
  snapshotFingerprint?: string;
}

export interface ProviderActionRequest {
  caseId: string;
  action: FinancialAction;
  idempotencyKey: string;
}

export type ProviderActionResult =
  | { mode: "MOCK"; outcome: "SIMULATED_ONLY"; providerActionStatus: "NOT_EXECUTED"; refundStatus: "NOT_CONFIRMED"; providerConfirmed: false }
  | { mode: "LIVE"; outcome: "RESPONSE_RECEIVED"; providerActionStatus: string; refundStatus: string; providerConfirmed: true };

export interface DisputeProviderAdapter {
  readonly mode: DisputeProviderMode;
  retrieveStatus(caseId: string): Promise<ProviderStatusReceipt>;
  executeAction(request: ProviderActionRequest, liveGate?: LiveActionGateContext): Promise<ProviderActionResult>;
}

/** Deterministic fixtures only. It contains no fetch/client import and never claims provider success. */
export class MockDisputeProviderAdapter implements DisputeProviderAdapter {
  readonly mode = "MOCK" as const;
  constructor(private readonly fixtures: Readonly<Record<string, Pick<ProviderStatusReceipt, "stage" | "status">>>, private readonly now = Date.now) {}

  async retrieveStatus(caseId: string): Promise<ProviderStatusReceipt> {
    const fixture = this.fixtures[caseId];
    if (!fixture) return { caseId, source: "MOCK_FIXTURE", available: false, stage: "UNKNOWN", status: "UNKNOWN", retrievedAt: this.now() };
    return { caseId, source: "MOCK_FIXTURE", available: true, ...fixture, retrievedAt: this.now() };
  }

  async executeAction(_request: ProviderActionRequest, _liveGate?: LiveActionGateContext): Promise<ProviderActionResult> {
    return { mode: "MOCK", outcome: "SIMULATED_ONLY", providerActionStatus: "NOT_EXECUTED", refundStatus: "NOT_CONFIRMED", providerConfirmed: false };
  }
}

export interface LiveActionGateInput {
  separatelyAuthorized: boolean;
  configured: boolean;
  expectedActor: string;
  snapshot: DisputeSnapshot;
  recommendation: DisputeRecommendation;
  providerReceipt: ProviderStatusReceipt;
  approval: HumanApproval;
  evidence: readonly DisputeEvidence[];
  consumedApprovalIds: ReadonlySet<string>;
  idempotencyKey: string;
  usedIdempotencyKeys: ReadonlySet<string>;
  now: number;
  maxReceiptAgeMs?: number;
}

export interface LiveActionGateContext {
  input: LiveActionGateInput;
  /** Must atomically consume the approval ID and reserve the idempotency key in durable storage. */
  reserveOneTimeAction: (approvalId: string, idempotencyKey: string) => boolean;
}

/** Future-live gate. All checks are fail-closed and this function itself performs no I/O. */
export function validateLiveActionGate(input: LiveActionGateInput): readonly string[] {
  const errors: string[] = [];
  if (!input.separatelyAuthorized) errors.push("LIVE_NOT_SEPARATELY_AUTHORIZED");
  if (!input.configured) errors.push("LIVE_PROVIDER_NOT_CONFIGURED");
  const receipt = input.providerReceipt;
  const maxAge = input.maxReceiptAgeMs ?? 30_000;
  if (!receipt.available || receipt.source !== "AIRWALLEX_AUTHENTICATED") errors.push("LIVE_PROVIDER_STATUS_UNAVAILABLE");
  if (receipt.caseId !== input.snapshot.caseId || receipt.stage !== input.snapshot.stage || receipt.status !== input.snapshot.status) errors.push("PROVIDER_STATE_MISMATCH");
  const currentFingerprint = fingerprintDisputeDecision(input.snapshot, input.recommendation, input.evidence);
  if (!input.approval.snapshotFingerprint || input.approval.snapshotFingerprint !== currentFingerprint) errors.push("APPROVAL_SNAPSHOT_MISMATCH");
  if (!receipt.snapshotFingerprint || receipt.snapshotFingerprint !== currentFingerprint) errors.push("PROVIDER_SNAPSHOT_MISMATCH");
  if (!Number.isFinite(receipt.retrievedAt) || input.now - receipt.retrievedAt < 0 || input.now - receipt.retrievedAt > maxAge) errors.push("PROVIDER_RECEIPT_STALE");
  if (validateDisputeSnapshot(input.snapshot).length || input.snapshot.status !== "REQUIRES_RESPONSE" ||
      disputeDeadlineError(input.snapshot, input.now) !== null) errors.push("DISPUTE_NOT_ACTIONABLE");
  if ((input.recommendation.action !== "CHALLENGE" && input.recommendation.action !== "ACCEPT") ||
      input.approval.action !== input.recommendation.action || input.approval.caseId !== input.snapshot.caseId ||
      !input.approval.approvalId || input.consumedApprovalIds.has(input.approval.approvalId) || !input.expectedActor ||
      input.approval.actor !== input.expectedActor || input.approval.approvedAt > input.now || input.approval.expiresAt <= input.now) errors.push("HUMAN_APPROVAL_INVALID");
  const suppliedEvidence = new Map(input.evidence.filter((e) => e.provenance.verified).map((e) => [e.id, e]));
  if (!input.recommendation.evidenceIds.length || input.recommendation.evidenceIds.some((id) => !suppliedEvidence.has(id))) errors.push("REQUIRED_EVIDENCE_MISSING_OR_UNVERIFIED");
  if (input.recommendation.evidenceIds.some((id) => suppliedEvidence.get(id)?.provenance.source === "OPERATOR"))
    errors.push("LOCAL_ATTESTATION_NOT_PROVIDER_EVIDENCE");
  if (!input.idempotencyKey || input.usedIdempotencyKeys.has(input.idempotencyKey)) errors.push("ACTION_IDEMPOTENCY_CONFLICT");
  return Object.freeze(errors);
}

export interface LiveProviderOptions {
  separatelyAuthorized?: boolean;
  configured?: boolean;
  retrieve?: (caseId: string) => Promise<ProviderStatusReceipt>;
  execute?: (request: ProviderActionRequest) => Promise<ProviderActionResult>;
}

/** Live is disabled unless explicit configuration, separate authorization, and a gated transport are supplied. */
export class LiveDisputeProviderAdapter implements DisputeProviderAdapter {
  readonly mode = "LIVE" as const;
  private readonly enabled: boolean;
  constructor(private readonly options: LiveProviderOptions = {}) {
    this.enabled = options.separatelyAuthorized === true && options.configured === true && !!options.retrieve && !!options.execute;
  }
  async retrieveStatus(caseId: string): Promise<ProviderStatusReceipt> {
    if (!this.enabled || !this.options.retrieve) throw new Error("LIVE_PROVIDER_DISABLED_OR_UNCONFIGURED");
    return this.options.retrieve(caseId);
  }
  async executeAction(request: ProviderActionRequest, context?: LiveActionGateContext): Promise<ProviderActionResult> {
    if (!this.enabled || !this.options.execute) throw new Error("LIVE_PROVIDER_DISABLED_OR_UNCONFIGURED");
    if (!context) throw new Error("LIVE_ACTION_GATE_REQUIRED");
    const gateInput = context.input;
    if (gateInput.snapshot.caseId !== request.caseId || gateInput.recommendation.action !== request.action || gateInput.idempotencyKey !== request.idempotencyKey) {
      throw new Error("LIVE_ACTION_GATE_REQUEST_MISMATCH");
    }
    const errors = validateLiveActionGate(gateInput);
    if (errors.length) throw new Error(`LIVE_ACTION_GATE_REJECTED:${errors.join(",")}`);
    if (!context.reserveOneTimeAction(gateInput.approval.approvalId, request.idempotencyKey)) throw new Error("LIVE_ACTION_APPROVAL_REPLAY_OR_IDEMPOTENCY_CONFLICT");
    const result = await this.options.execute(request);
    if (result.mode !== "LIVE" || result.providerConfirmed !== true) throw new Error("LIVE_RESPONSE_NOT_PROVIDER_CONFIRMED");
    return result;
  }
}

export function createDisputeProviderAdapter(mode: string, fixtures: Readonly<Record<string, Pick<ProviderStatusReceipt, "stage" | "status">>> = {}): DisputeProviderAdapter {
  if (mode === "MOCK") return new MockDisputeProviderAdapter(fixtures);
  if (mode === "LIVE") return new LiveDisputeProviderAdapter();
  throw new Error("DISPUTE_PROVIDER_MODE_INVALID");
}
