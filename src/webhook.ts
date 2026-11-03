/**
 * Webhook signature check, per "Listen for webhook events" > "Check webhook signatures":
 * HMAC-SHA256 hex digest, key = the notification URL's secret,
 * message = x-timestamp header (as received) + raw request body (unparsed bytes as string).
 * https://www.airwallex.com/docs/developer-tools/webhooks/listen-for-webhook-events.md
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyAirwallexSignature(opts: {
  rawBody: string;
  timestamp: string;
  signature: string;
  secret: string;
  toleranceMs?: number;
  now?: number;
}): { ok: boolean; reason?: string } {
  const { rawBody, timestamp, signature, secret } = opts;
  if (!secret) return { ok: false, reason: "no_secret" };
  // HTTP request headers are optional at runtime even when TS callers use required strings.
  // Reject missing/malformed values BEFORE Buffer.from() or HMAC construction; never crash on untrusted input.
  if (typeof signature !== "string" || !/^[0-9a-fA-F]{64}$/.test(signature)) {
    return { ok: false, reason: "bad_signature" };
  }
  if (typeof timestamp !== "string" || !timestamp) return { ok: false, reason: "stale_timestamp" };
  if (typeof rawBody !== "string") return { ok: false, reason: "bad_signature" };
  const expected = createHmac("sha256", secret).update(timestamp + rawBody).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "bad_signature" };
  const tolerance = opts.toleranceMs ?? 5 * 60 * 1000;
  const ts = Number(timestamp); // milliseconds per the docs
  if (!Number.isFinite(ts) || Math.abs((opts.now ?? Date.now()) - ts) > tolerance) return { ok: false, reason: "stale_timestamp" };
  return { ok: true };
}

/**
 * Dispute and refund event names listed in the Payments webhooks reference
 * (https://www.airwallex.com/docs/payments/reference/payments-webhooks.md), fetched 2026-10-11.
 * Not yet observed on a live sandbox delivery: capture one during the first real run.
 */
export const DISPUTE_EVENTS = [
  "payment_dispute.requires_response",
  "payment_dispute.challenged",
  "payment_dispute.accepted",
  "payment_dispute.expired",
  "payment_dispute.pending_decision",
  "payment_dispute.pending_closure",
  "payment_dispute.won",
  "payment_dispute.lost",
  "payment_dispute.reversed",
] as const;

export const REFUND_EVENTS = ["refund.received", "refund.accepted", "refund.settled", "refund.failed"] as const;
