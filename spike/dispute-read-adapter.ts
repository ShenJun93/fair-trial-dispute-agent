import { AirwallexClient, AirwallexError, type AirwallexDiagnosticMetadata, type AirwallexOperationStage } from "../src/airwallex.ts";
import { validateDisputeSnapshot, type DisputeStage, type DisputeStatus } from "./dispute-engine.ts";

export type DisputeDataOrigin = "AIRWALLEX" | "OFFLINE_FIXTURE";
export type EvidenceAvailability = "PRESENT" | "NONE" | "UNKNOWN";

export interface NormalizedDispute {
  origin: DisputeDataOrigin;
  disputeId: string;
  paymentIntentId: string;
  paymentAttemptId?: string;
  merchantOrderId?: string;
  stage: string;
  status: string;
  amountMinor: number;
  currency: string;
  reasonType: string;
  reasonCode: string;
  responseDeadline?: string;
  evidence: {
    availability: EvidenceAvailability;
    referenceCount: number;
    provenance: { origin: DisputeDataOrigin; observedAt: string };
  };
  actionable: boolean;
  nonActionableReasons: readonly string[];
}

export interface DisputeListFilters {
  paymentIntentId?: string;
  merchantOrderId?: string;
  stage?: string;
  status?: string;
  reasonCode?: string;
  fromDueAt?: string;
  toDueAt?: string;
  fromUpdatedAt?: string;
  toUpdatedAt?: string;
}

export interface DisputePageRequest extends DisputeListFilters { page?: string; size?: number }
export interface DisputePage {
  origin: DisputeDataOrigin;
  items: readonly NormalizedDispute[];
  nextPage?: string;
  retrievedAt: string;
}

export interface DisputeReadTransport {
  listPage(request: DisputePageRequest): Promise<unknown>;
  retrieve(disputeId: string): Promise<unknown>;
}

export class DisputeReadError extends Error {
  constructor(readonly code: string, readonly httpStatus?: number, readonly diagnostic?: DisputeReadDiagnostic) {
    super(code);
    this.name = "DisputeReadError";
  }
}

export type DisputeReadDiagnosticStage = AirwallexOperationStage | "ADAPTER_VALIDATION";
export type DisputeReadDiagnosticCategory = "HTTP_ERROR" | "TRANSPORT_ERROR" | "TIMEOUT" | "BODY_READ_ERROR" | "MALFORMED_JSON" | "AUTH_RESPONSE_INVALID" | "ADAPTER_VALIDATION_ERROR" | "UNKNOWN";
export interface DisputeReadDiagnostic {
  stage: DisputeReadDiagnosticStage;
  responseReceived: boolean | "unknown";
  httpStatus?: number;
  errorCategory: DisputeReadDiagnosticCategory;
  retryCount: number;
  timestampUtc: string;
}

const responseEnvelope = Symbol("airwallex-read-response");
interface ProviderReadEnvelope { [responseEnvelope]: true; data: unknown; diagnostic: DisputeReadDiagnostic }

function toReadDiagnostic(metadata?: AirwallexDiagnosticMetadata, fallbackStage: DisputeReadDiagnosticStage = "GET"): DisputeReadDiagnostic {
  return metadata ? { ...metadata } : {
    stage: fallbackStage, responseReceived: "unknown", errorCategory: "UNKNOWN", retryCount: 0, timestampUtc: new Date().toISOString(),
  };
}

function unwrapResponse(value: unknown): { data: unknown; diagnostic?: DisputeReadDiagnostic } {
  if (value && typeof value === "object" && (value as ProviderReadEnvelope)[responseEnvelope] === true) {
    const envelope = value as ProviderReadEnvelope;
    return { data: envelope.data, diagnostic: envelope.diagnostic };
  }
  return { data: value };
}

function validationError(error: unknown, metadata?: DisputeReadDiagnostic): DisputeReadError {
  if (error instanceof DisputeReadError && error.diagnostic) return error;
  const code = error instanceof DisputeReadError ? error.code : "MALFORMED_PROVIDER_RESPONSE";
  const base = metadata ?? { stage: "ADAPTER_VALIDATION" as const, responseReceived: "unknown" as const, errorCategory: "UNKNOWN" as const, retryCount: 0, timestampUtc: new Date().toISOString() };
  return new DisputeReadError(code, metadata?.httpStatus, { ...base, stage: "ADAPTER_VALIDATION", errorCategory: "ADAPTER_VALIDATION_ERROR" });
}

type WireDispute = Record<string, unknown>;
const stages = new Set<DisputeStage>(["RFI", "PRE_CHARGEBACK", "CHARGEBACK", "PRE_ARBITRATION", "ARBITRATION"]);
const statuses = new Set<DisputeStatus>(["REQUIRES_RESPONSE", "CHALLENGED", "ACCEPTED", "REVERSED", "WON", "LOST", "PENDING_CLOSURE", "EXPIRED", "PENDING_DECISION"]);
const listPath = "/api/v1/pa/payment_disputes";
const maxPageSize = 1000;

function validatePageRequest(request: DisputePageRequest): void {
  if (request.size !== undefined && (!Number.isInteger(request.size) || request.size < 1 || request.size > maxPageSize)) {
    throw new DisputeReadError("INVALID_PAGE_SIZE");
  }
  if (request.page !== undefined && (!request.page || request.page.length > 1024 || /[\x00-\x1f\x7f]/.test(request.page))) {
    throw new DisputeReadError("INVALID_PAGE_CURSOR");
  }
  for (const value of Object.values(request)) {
    if (typeof value === "string" && (value.length > 512 || /[\x00-\x1f\x7f]/.test(value))) throw new DisputeReadError("INVALID_DISPUTE_FILTER");
  }
}

function object(value: unknown): WireDispute | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as WireDispute : undefined;
}
function requiredString(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= 512; }
function isoCurrencyDigits(currency: string): number | undefined {
  if (!/^[A-Z]{3}$/.test(currency)) return undefined;
  try { return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits; }
  catch { return undefined; }
}
function toMinorUnits(amount: unknown, currency: string): number | undefined {
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) return undefined;
  const digits = isoCurrencyDigits(currency);
  if (digits === undefined) return undefined;
  const scale = 10 ** digits;
  const minor = Math.round(amount * scale);
  if (!Number.isSafeInteger(minor) || Math.abs(amount * scale - minor) > 1e-7) return undefined;
  return minor;
}
function evidenceCount(raw: WireDispute): { availability: EvidenceAvailability; count: number } {
  const hasIssuer = Object.hasOwn(raw, "issuer_documents");
  const hasChallenge = Object.hasOwn(raw, "challenge_details");
  if ((hasIssuer && !Array.isArray(raw.issuer_documents)) || (hasChallenge && !Array.isArray(raw.challenge_details))) {
    return { availability: "UNKNOWN", count: 0 };
  }
  if (!hasIssuer && !hasChallenge) return { availability: "UNKNOWN", count: 0 };
  const issuerDocuments = Array.isArray(raw.issuer_documents) ? raw.issuer_documents : [];
  const challengeDetails = Array.isArray(raw.challenge_details) ? raw.challenge_details : [];
  if ([...issuerDocuments, ...challengeDetails].some((entry) => !object(entry))) return { availability: "UNKNOWN", count: 0 };
  const count = issuerDocuments.length + challengeDetails.length;
  return { availability: count ? "PRESENT" : "NONE", count };
}

function normalize(rawValue: unknown, origin: DisputeDataOrigin, observedAt: string, expectedId?: string): NormalizedDispute {
  const raw = object(rawValue);
  const reason = object(raw?.reason);
  const reasonCode = raw?.reason_code ?? reason?.original_code;
  if (!raw || !requiredString(raw.id) || !requiredString(raw.payment_intent_id) ||
      (expectedId !== undefined && raw.id !== expectedId) || !requiredString(raw.stage) || !requiredString(raw.status) ||
      !requiredString(raw.currency) || !requiredString(reasonCode) || !reason || !requiredString(reason.type)) {
    throw new DisputeReadError("MALFORMED_DISPUTE_RESPONSE");
  }
  const amountMinor = toMinorUnits(raw.amount, raw.currency);
  if (amountMinor === undefined) throw new DisputeReadError("MALFORMED_DISPUTE_RESPONSE");
  if (raw.due_at !== undefined && (!requiredString(raw.due_at) || !Number.isFinite(Date.parse(raw.due_at)))) {
    throw new DisputeReadError("MALFORMED_DISPUTE_RESPONSE");
  }
  const evidence = evidenceCount(raw);
  const reasons: string[] = [];
  const status = raw.status.toUpperCase();
  const stage = raw.stage.toUpperCase();
  if (!stages.has(stage as DisputeStage) || !statuses.has(status as DisputeStatus)) reasons.push("UNKNOWN_STAGE_OR_STATUS");
  if (!evidence.count) reasons.push(evidence.availability === "UNKNOWN" ? "EVIDENCE_AVAILABILITY_UNKNOWN" : "EVIDENCE_MISSING");
  const linked = {
    caseId: raw.id, amountMinor, currency: raw.currency, reason: reason.type as string,
    reasonCode, stage, status, evidence: [],
  };
  if (!reasons.includes("UNKNOWN_STAGE_OR_STATUS") && validateDisputeSnapshot(linked).length) reasons.push("INCONSISTENT_STAGE_STATUS");
  const record: NormalizedDispute = {
    origin, disputeId: raw.id, paymentIntentId: raw.payment_intent_id,
    ...(requiredString(raw.payment_attempt_id) ? { paymentAttemptId: raw.payment_attempt_id } : {}),
    ...(requiredString(raw.merchant_order_id) ? { merchantOrderId: raw.merchant_order_id } : {}),
    stage, status, amountMinor, currency: raw.currency,
    reasonType: reason.type as string, reasonCode,
    ...(typeof raw.due_at === "string" ? { responseDeadline: raw.due_at } : {}),
    evidence: { availability: evidence.availability, referenceCount: evidence.count, provenance: { origin, observedAt } },
    actionable: reasons.length === 0 && status === "REQUIRES_RESPONSE",
    nonActionableReasons: Object.freeze(reasons),
  };
  return Object.freeze(record);
}

function apiError(error: unknown, fallbackStage: DisputeReadDiagnosticStage = "GET"): DisputeReadError {
  if (error instanceof DisputeReadError) return error;
  if (error instanceof AirwallexError) {
    const meta = toReadDiagnostic(error.diagnostic, fallbackStage);
    const code = error.status === 401 ? "UNAUTHORIZED" : error.status === 403 ? "FORBIDDEN" :
      error.status === 404 ? "NOT_FOUND" : error.status === 408 || error.status === 504 || meta.errorCategory === "TIMEOUT" ? "TIMEOUT" :
      meta.errorCategory === "MALFORMED_JSON" ? "MALFORMED_JSON" : "PROVIDER_READ_FAILED";
    return new DisputeReadError(code, error.status ?? meta.httpStatus, meta);
  }
  const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
  const meta: DisputeReadDiagnostic = {
    stage: fallbackStage, responseReceived: "unknown", errorCategory: timedOut ? "TIMEOUT" : "UNKNOWN",
    retryCount: 0, timestampUtc: new Date().toISOString(),
  };
  return new DisputeReadError(timedOut ? "TIMEOUT" : "PROVIDER_READ_FAILED", undefined, meta);
}

/** Uses the established AirwallexClient login/token cache and sandbox host validation. GET only. */
export class AirwallexDisputeReadTransport implements DisputeReadTransport {
  constructor(private readonly client: AirwallexClient) {
    if (client.cfg.dryRun) throw new DisputeReadError("DRY_RUN_CLIENT_CANNOT_BE_PROVIDER_SOURCE");
  }

  async listPage(request: DisputePageRequest): Promise<unknown> {
    validatePageRequest(request);
    const query: Record<string, string | number | undefined> = {
      page: request.page ?? "0", size: request.size ?? 100,
      payment_intent_id: request.paymentIntentId, merchant_order_id: request.merchantOrderId,
      stage: request.stage, status: request.status, reason_code: request.reasonCode,
      from_due_at: request.fromDueAt, to_due_at: request.toDueAt,
      from_updated_at: request.fromUpdatedAt, to_updated_at: request.toUpdatedAt,
    };
    if (!Number.isInteger(query.size) || Number(query.size) < 1 || Number(query.size) > maxPageSize) throw new DisputeReadError("INVALID_PAGE_SIZE");
    try {
      let metadata: AirwallexDiagnosticMetadata | undefined;
      const data = await this.client.request<unknown>("GET", listPath, { query, sensitiveDisputeRead: true, onDiagnostic: (value) => { metadata = value; } });
      return { [responseEnvelope]: true, data, diagnostic: toReadDiagnostic(metadata) } satisfies ProviderReadEnvelope;
    } catch (error) { throw apiError(error, "GET"); }
  }

  async retrieve(disputeId: string): Promise<unknown> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(disputeId)) throw new DisputeReadError("INVALID_DISPUTE_ID");
    try {
      let metadata: AirwallexDiagnosticMetadata | undefined;
      const data = await this.client.request<unknown>("GET", `${listPath}/${encodeURIComponent(disputeId)}`, { sensitiveDisputeRead: true, onDiagnostic: (value) => { metadata = value; } });
      return { [responseEnvelope]: true, data, diagnostic: toReadDiagnostic(metadata) } satisfies ProviderReadEnvelope;
    } catch (error) { throw apiError(error, "GET"); }
  }
}

export interface DisputeReadAdapter {
  readonly mode: "MOCK" | "LIVE_READONLY";
  listPage(request?: DisputePageRequest): Promise<DisputePage>;
  listAll(request?: Omit<DisputePageRequest, "page">, maxPages?: number): Promise<readonly NormalizedDispute[]>;
  retrieve(disputeId: string): Promise<NormalizedDispute>;
}

export class MockDisputeReadAdapter implements DisputeReadAdapter {
  readonly mode = "MOCK" as const;
  constructor(private readonly pages: Readonly<Record<string, unknown>>, private readonly records: Readonly<Record<string, unknown>>, private readonly now = Date.now) {}
  async listPage(request: DisputePageRequest = {}): Promise<DisputePage> {
    validatePageRequest(request);
    const page = request.page ?? "0";
    const response = this.pages[page];
    if (response === undefined) throw new DisputeReadError("NOT_FOUND", 404);
    return parsePage(response, "OFFLINE_FIXTURE", new Date(this.now()).toISOString());
  }
  async listAll(request: Omit<DisputePageRequest, "page"> = {}, maxPages = 10): Promise<readonly NormalizedDispute[]> {
    return collectPages((page) => this.listPage({ ...request, page }), maxPages);
  }
  async retrieve(disputeId: string): Promise<NormalizedDispute> {
    const response = this.records[disputeId];
    if (response === undefined) throw new DisputeReadError("NOT_FOUND", 404);
    return normalize(response, "OFFLINE_FIXTURE", new Date(this.now()).toISOString(), disputeId);
  }
}

export interface LiveReadonlyAuthorization {
  explicitlyConfigured: boolean;
  approvalReference: string;
  actor: string;
  authorizedAt: number;
  expiresAt: number;
}

/** Read-only provider mode. It cannot be constructed by default and has no mutation method. */
export class LiveReadonlyDisputeAdapter implements DisputeReadAdapter {
  readonly mode = "LIVE_READONLY" as const;
  constructor(private readonly transport: DisputeReadTransport, private readonly authorization: LiveReadonlyAuthorization, private readonly now = Date.now) {
    this.assertAuthorized();
  }
  private assertAuthorized(): void {
    const now = this.now();
    if (!this.authorization.explicitlyConfigured || !requiredString(this.authorization.approvalReference) ||
        !requiredString(this.authorization.actor) || !Number.isFinite(this.authorization.authorizedAt) ||
        !Number.isFinite(this.authorization.expiresAt) || this.authorization.authorizedAt > now ||
        this.authorization.expiresAt <= now || this.authorization.expiresAt - this.authorization.authorizedAt > 15 * 60_000) {
      throw new DisputeReadError("LIVE_READONLY_NOT_AUTHORIZED");
    }
  }
  async listPage(request: DisputePageRequest = {}): Promise<DisputePage> {
    this.assertAuthorized();
    validatePageRequest(request);
    try {
      const response = unwrapResponse(await this.transport.listPage(request));
      try { return parsePage(response.data, "AIRWALLEX", new Date().toISOString()); }
      catch (error) { throw validationError(error, response.diagnostic); }
    } catch (error) { throw apiError(error); }
  }
  async listAll(request: Omit<DisputePageRequest, "page"> = {}, maxPages = 10): Promise<readonly NormalizedDispute[]> {
    return collectPages((page) => this.listPage({ ...request, page }), maxPages);
  }
  async retrieve(disputeId: string): Promise<NormalizedDispute> {
    this.assertAuthorized();
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(disputeId)) throw new DisputeReadError("INVALID_DISPUTE_ID");
    try {
      const response = unwrapResponse(await this.transport.retrieve(disputeId));
      try { return normalize(response.data, "AIRWALLEX", new Date().toISOString(), disputeId); }
      catch (error) { throw validationError(error, response.diagnostic); }
    } catch (error) { throw apiError(error); }
  }
}

function parsePage(value: unknown, origin: DisputeDataOrigin, retrievedAt: string): DisputePage {
  const data = object(value);
  if (!data || !Array.isArray(data.items) || (data.page_after !== undefined && data.page_after !== null && !requiredString(data.page_after))) {
    throw new DisputeReadError("MALFORMED_DISPUTE_LIST");
  }
  const items = data.items.map((item) => normalize(item, origin, retrievedAt));
  const ids = new Set<string>();
  for (const item of items) {
    if (ids.has(item.disputeId)) throw new DisputeReadError("DUPLICATE_DISPUTE_ID");
    ids.add(item.disputeId);
  }
  return Object.freeze({ origin, items: Object.freeze(items), ...(typeof data.page_after === "string" && data.page_after ? { nextPage: data.page_after } : {}), retrievedAt });
}

async function collectPages(getPage: (page: string) => Promise<DisputePage>, maxPages: number): Promise<readonly NormalizedDispute[]> {
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100) throw new DisputeReadError("INVALID_MAX_PAGES");
  const all: NormalizedDispute[] = [];
  const cursors = new Set<string>();
  let page = "0";
  for (let count = 0; count < maxPages; count++) {
    const result = await getPage(page);
    all.push(...result.items);
    const next = result.nextPage;
    if (!next) {
      const ids = new Set<string>();
      for (const item of all) {
        if (ids.has(item.disputeId)) throw new DisputeReadError("DUPLICATE_DISPUTE_ID");
        ids.add(item.disputeId);
      }
      return Object.freeze(all);
    }
    if (cursors.has(next) || next === page) throw new DisputeReadError("PAGINATION_CURSOR_REPLAYED");
    cursors.add(next);
    page = next;
  }
  throw new DisputeReadError("PAGINATION_LIMIT_REACHED");
}

export function createDisputeReadAdapter(
  mode: "MOCK" | "LIVE_READONLY" = "MOCK",
  options: { pages?: Readonly<Record<string, unknown>>; records?: Readonly<Record<string, unknown>>; transport?: DisputeReadTransport; authorization?: LiveReadonlyAuthorization } = {},
): DisputeReadAdapter {
  if (mode === "MOCK") return new MockDisputeReadAdapter(options.pages ?? {}, options.records ?? {});
  if (!options.transport || !options.authorization) throw new DisputeReadError("LIVE_READONLY_NOT_CONFIGURED");
  return new LiveReadonlyDisputeAdapter(options.transport, options.authorization);
}
