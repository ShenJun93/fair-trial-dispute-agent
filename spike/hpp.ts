import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { registerSecret, type AirwallexClient, type Json } from "../src/airwallex.ts";

export const HPP_AMOUNT = 1;
export const HPP_CURRENCY = "USD";
export const SESSION_TTL_MS = 60 * 60 * 1000;
export const RETURN_TTL_MS = 55 * 60 * 1000;

const PAYMENT_STATES = new Set([
  "REQUIRES_PAYMENT_METHOD", "REQUIRES_CUSTOMER_ACTION", "PENDING", "PENDING_REVIEW",
  "REQUIRES_CAPTURE", "SUCCEEDED", "CANCELLED",
]);

export interface HppIntent {
  id: string;
  request_id: string;
  client_secret: string;
  currency: string;
  amount: number;
  status: string;
  merchant_order_id: string;
}

export interface HppIntentResult {
  id: string;
  client_secret: string;
  currency: string;
  successUrl: string;
}

export interface HppStatusResult {
  id: string;
  status: string;
  succeeded: boolean;
  stateKnown: boolean;
}

export interface HppAttempt {
  requestId: string;
  merchantOrderId: string;
  paymentIntentId?: string;
  returnStateHash?: string;
  returnStateExpiresAt?: number;
  returnConsumed?: boolean;
  launchIssued?: boolean;
  status?: string;
  dispatchPhase?: "NOT_DISPATCHED" | "DISPATCHED" | "RESPONSE_RECORDED" | "LEGACY_AMBIGUOUS";
  statusVerifiedAt?: number;
  revoked?: boolean;
}

export interface HppCheckout {
  id: string;
  sessionHash: string;
  orderId: string;
  createdAt: number;
  sessionExpiresAt?: number;
  attempts: HppAttempt[];
  revision?: number;
  released?: boolean;
}

export interface StoredHppSession {
  sessionHash: string;
  csrfHashes: string[];
  expiresAt: number;
}

export interface HppGateState {
  sessions: StoredHppSession[];
  checkout?: HppCheckout;
  revision?: number;
}

export type HppStateWriter = (state: HppGateState) => Promise<void>;
type CreateRequest = (method: "GET" | "POST", path: string, options?: { body?: Json }) => Promise<unknown>;

export const hashSecret = (value: string): string => createHash("sha256").update(value).digest("hex");
const randomToken = (): string => randomBytes(32).toString("base64url");
function constantEqual(a: string, b: string): boolean {
  return timingSafeEqual(Buffer.from(hashSecret(a)), Buffer.from(hashSecret(b)));
}

export class HppGateError extends Error {
  constructor(readonly code: string) { super(code); }
}

/** Session and checkout state contains hashes/IDs only; never persist operator, cookie, CSRF or HPP secrets. */
export class HppGate {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly operatorToken: string,
    readonly state: HppGateState = { sessions: [] },
    private readonly writeState: HppStateWriter = async () => {},
    private readonly now: () => number = Date.now,
  ) {
    if (operatorToken.length < 32) throw new Error("HPP_OPERATOR_TOKEN must contain at least 32 characters");
  }

  private mutate<T>(fn: () => T): Promise<T> {
    const run = this.queue.then(async () => {
      const before = this.state.revision ?? 0;
      const result = fn();
      this.state.revision = before + 1;
      if (this.state.checkout) this.state.checkout.revision = this.state.revision;
      await this.writeState(this.state);
      return result;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  async createSession(operatorToken: string): Promise<{ sessionToken: string; csrfToken: string; sessionHash: string }> {
    if (!constantEqual(operatorToken, this.operatorToken)) throw new HppGateError("unauthorized");
    const sessionToken = randomToken();
    const csrfToken = randomToken();
    const sessionHash = hashSecret(sessionToken);
    await this.mutate(() => {
      this.state.sessions = this.state.sessions.filter((s) => s.expiresAt > this.now());
      this.state.sessions.push({ sessionHash, csrfHashes: [hashSecret(csrfToken)], expiresAt: this.now() + SESSION_TTL_MS });
    });
    return { sessionToken, csrfToken, sessionHash };
  }

  authenticate(sessionToken: string | undefined): string {
    if (!sessionToken || !/^[A-Za-z0-9_-]{40,60}$/.test(sessionToken)) throw new HppGateError("unauthorized");
    const sessionHash = hashSecret(sessionToken);
    const session = this.state.sessions.find((item) => item.sessionHash === sessionHash && item.expiresAt > this.now());
    if (!session) throw new HppGateError("unauthorized");
    return sessionHash;
  }

  async rotateCsrf(sessionHash: string): Promise<string> {
    const csrfToken = randomToken();
    await this.mutate(() => {
      const session = this.state.sessions.find((item) => item.sessionHash === sessionHash && item.expiresAt > this.now());
      if (!session) throw new HppGateError("unauthorized");
      session.csrfHashes = [...session.csrfHashes, hashSecret(csrfToken)].slice(-8);
    });
    return csrfToken;
  }

  csrfValid(sessionHash: string, csrfToken: string | undefined): boolean {
    if (!csrfToken) return false;
    const session = this.state.sessions.find((item) => item.sessionHash === sessionHash && item.expiresAt > this.now());
    return !!session && session.csrfHashes.some((saved) => constantEqual(saved, hashSecret(csrfToken)));
  }

  async reserveCheckout(sessionHash: string): Promise<{ checkout: HppCheckout; attempt: HppAttempt }> {
    return this.mutate(() => {
      let checkout = this.state.checkout;
      if (checkout?.released) checkout = undefined;
      if (checkout && checkout.sessionHash !== sessionHash) throw new HppGateError("active_order_owned_by_other_session");
      if (!checkout) {
        const orderId = `ft-hpp-${randomUUID()}`;
        const session = this.state.sessions.find((item) => item.sessionHash === sessionHash && item.expiresAt > this.now());
        if (!session) throw new HppGateError("unauthorized");
        checkout = {
          id: randomBytes(24).toString("base64url"), sessionHash, orderId, createdAt: this.now(), sessionExpiresAt: session.expiresAt,
          attempts: [{ requestId: randomUUID(), merchantOrderId: orderId, dispatchPhase: "NOT_DISPATCHED" }],
        };
        this.state.checkout = checkout;
      }
      return { checkout, attempt: checkout.attempts.at(-1)! };
    });
  }

  /** Bind the authenticated checkout session to an already-created and verified W1 intent. */
  async bindExistingW1(sessionHash: string, input: {
    id: string; request_id: string; merchant_order_id: string; amount: number; currency: string;
  }): Promise<{ checkout: HppCheckout; attempt: HppAttempt }> {
    if (!/^int_[A-Za-z0-9_-]{1,128}$/.test(input.id) || input.amount !== HPP_AMOUNT || input.currency !== HPP_CURRENCY ||
        !input.request_id || !input.merchant_order_id) throw new HppGateError("invalid_w1_binding");
    return this.mutate(() => {
      const session = this.state.sessions.find((item) => item.sessionHash === sessionHash && item.expiresAt > this.now());
      if (!session) throw new HppGateError("unauthorized");
      const prior = this.state.checkout;
      if (prior?.released) throw new HppGateError("checkout_released");
      if (prior && (prior.sessionHash !== sessionHash || prior.attempts.at(-1)?.paymentIntentId !== input.id)) {
        throw new HppGateError("active_order_owned_by_other_session");
      }
      if (prior && prior.sessionHash === sessionHash && prior.attempts.at(-1)?.paymentIntentId === input.id) {
        return { checkout: prior, attempt: prior.attempts.at(-1)! };
      }
      const checkout: HppCheckout = {
        id: randomBytes(24).toString("base64url"), sessionHash, orderId: input.merchant_order_id,
        createdAt: this.now(), sessionExpiresAt: session.expiresAt,
        attempts: [{ requestId: input.request_id, merchantOrderId: input.merchant_order_id,
          paymentIntentId: input.id, dispatchPhase: "RESPONSE_RECORDED", status: "REQUIRES_PAYMENT_METHOD" }],
      };
      this.state.checkout = checkout;
      return { checkout, attempt: checkout.attempts[0]! };
    });
  }

  checkoutForSession(sessionHash: string): { checkout: HppCheckout; attempt: HppAttempt } {
    const checkout = this.state.checkout;
    if (!checkout || checkout.released || checkout.sessionHash !== sessionHash) throw new HppGateError("checkout_not_found");
    return { checkout, attempt: checkout.attempts.at(-1)! };
  }

  async attachIntent(sessionHash: string, intentId: string): Promise<void> {
    await this.mutate(() => {
      const { attempt } = this.checkoutForSession(sessionHash);
      if (attempt.paymentIntentId && attempt.paymentIntentId !== intentId) throw new HppGateError("intent_already_bound");
      attempt.paymentIntentId = intentId;
      attempt.dispatchPhase = "RESPONSE_RECORDED";
    });
  }

  async markDispatched(sessionHash: string, requestId: string): Promise<void> {
    await this.mutate(() => {
      const { attempt } = this.checkoutForSession(sessionHash);
      if (attempt.requestId !== requestId || attempt.dispatchPhase !== "NOT_DISPATCHED") throw new HppGateError("dispatch_state_conflict");
      attempt.dispatchPhase = "DISPATCHED";
    });
  }

  async claimLaunch(sessionHash: string): Promise<{ claimed: boolean; state?: string }> {
    return this.mutate(() => {
      const { attempt } = this.checkoutForSession(sessionHash);
      if (!attempt.paymentIntentId) throw new HppGateError("intent_not_ready");
      if (attempt.launchIssued) return { claimed: false };
      const state = randomToken();
      attempt.returnStateHash = hashSecret(state);
      attempt.returnStateExpiresAt = this.now() + RETURN_TTL_MS;
      attempt.returnConsumed = false;
      attempt.launchIssued = true;
      return { claimed: true, state };
    });
  }

  async consumeReturn(sessionHash: string, state: string | undefined): Promise<{ checkout: HppCheckout; attempt: HppAttempt }> {
    if (!state) throw new HppGateError("invalid_return_state");
    return this.mutate(() => {
      const { checkout, attempt } = this.checkoutForSession(sessionHash);
      if (!attempt.returnStateHash || attempt.returnConsumed || !attempt.returnStateExpiresAt || attempt.returnStateExpiresAt <= this.now() ||
          !constantEqual(attempt.returnStateHash, hashSecret(state))) throw new HppGateError("invalid_return_state");
      attempt.returnConsumed = true;
      return { checkout, attempt };
    });
  }

  async recordStatus(sessionHash: string, status: string): Promise<void> {
    await this.mutate(() => { const a = this.checkoutForSession(sessionHash).attempt; a.status = status; a.statusVerifiedAt = this.now(); });
  }

}

export interface HppExpectedIntent { amount: number; currency: string; merchantOrderId: string; requestId: string }
export class HppService {
  private readonly createAttempts = new Map<string, Promise<HppIntent>>();
  constructor(private readonly request: CreateRequest) {}

  static fromClient(client: Pick<AirwallexClient, "request">): HppService {
    return new HppService((method, path, options) => client.request(method, path, options));
  }

  create(requestId: string, merchantOrderId: string): Promise<HppIntent> {
    registerSecret(requestId);
    registerSecret(merchantOrderId);
    const prior = this.createAttempts.get(requestId);
    if (prior) return prior;
    const pending = this.request("POST", "/api/v1/pa/payment_intents/create", {
      body: { request_id: requestId, amount: HPP_AMOUNT, currency: HPP_CURRENCY, merchant_order_id: merchantOrderId, descriptor: "FAIR TRIAL HPP" },
    }).then((raw) => {
      const intent = raw as Partial<HppIntent>;
      if (!intent.id || !intent.client_secret || intent.request_id !== requestId || intent.merchant_order_id !== merchantOrderId ||
          intent.amount !== HPP_AMOUNT || intent.currency !== HPP_CURRENCY) throw new Error("PaymentIntent create response mismatch");
      registerSecret(intent.id);
      return intent as HppIntent;
    });
    this.createAttempts.set(requestId, pending);
    void pending.catch(() => { if (this.createAttempts.get(requestId) === pending) this.createAttempts.delete(requestId); });
    return pending;
  }

  async status(id: string, expected: HppExpectedIntent): Promise<HppStatusResult> {
    if (!/^int_[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error("Invalid PaymentIntent ID");
    registerSecret(id);
    registerSecret(expected.merchantOrderId);
    registerSecret(expected.requestId);
    const raw = await this.request("GET", `/api/v1/pa/payment_intents/${encodeURIComponent(id)}`);
    const intent: Partial<HppIntent> = raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? raw as Partial<HppIntent>
      : {};
    const verified = intent.id === id && intent.request_id === expected.requestId &&
      intent.amount === expected.amount && intent.currency === expected.currency &&
      intent.merchant_order_id === expected.merchantOrderId;
    const rawStatus = typeof intent.status === "string" ? intent.status : "UNKNOWN";
    const stateKnown = PAYMENT_STATES.has(rawStatus);
    const status = verified && stateKnown ? rawStatus : "UNKNOWN";
    return { id, status, succeeded: verified && rawStatus === "SUCCEEDED", stateKnown: verified && stateKnown };
  }
}

export async function loadHppGate(path: string, operatorToken: string, legacyJsonPath = path.replace(/\.sqlite$/i, ".json")): Promise<HppGate> {
  const { HppSqliteStore } = await import("./hpp-storage.ts");
  const store = await HppSqliteStore.open(path, legacyJsonPath);
  const state = store.read();
  const writeState: HppStateWriter = async (next) => store.save(next, (next.revision ?? 1) - 1);
  return new HppGate(operatorToken, state, writeState);
}
