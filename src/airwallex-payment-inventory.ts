import { createHash } from "node:crypto";
import { AirwallexClient, DEFAULT_BASE } from "./airwallex.ts";
import { AirwallexDisputeReadTransport } from "../spike/dispute-read-adapter.ts";

export interface PaymentIntentCandidate { id: string; status: string; amount: number; currency: string; created_at?: string }
export interface PaymentInventoryReceipt {
  environment: "sandbox"; outcome: "INVENTORY_COMPLETE"; paymentIntentsExamined: number;
  succeededCount: number; eligibleCount: number; candidates: Array<{ ref: string; status: string; amount: number; currency: string; disputeCount: number; eligible: boolean }>;
  providerMutations: 0; startedAtUtc: string; finishedAtUtc: string;
}

/** Bounded, read-only inventory. Eligibility is deliberately conservative: SUCCEEDED and no linked dispute. */
export async function inventoryPaymentIntents(client: AirwallexClient, pageSize = 10): Promise<PaymentInventoryReceipt> {
  if (client.cfg.dryRun || client.cfg.base !== DEFAULT_BASE) throw new Error("LIVE_SANDBOX_CLIENT_REQUIRED");
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 10) throw new Error("PAGE_SIZE_OUT_OF_RANGE");
  const startedAtUtc = new Date().toISOString();
  const list = await client.request<{ items?: PaymentIntentCandidate[] }>("GET", "/api/v1/pa/payment_intents", {
    query: { page_num: 0, page_size: pageSize, status: "SUCCEEDED" }, sensitivePaymentIntentRead: true,
  });
  if (!list || !Array.isArray(list.items) || list.items.length > pageSize) throw new Error("PAYMENT_INTENT_LIST_SCHEMA_INVALID");
  const succeeded = list.items.filter((p) => typeof p?.id === "string" && p.status === "SUCCEEDED" && Number.isFinite(p.amount) && typeof p.currency === "string");
  const disputes = new AirwallexDisputeReadTransport(client);
  const candidates = [];
  for (const payment of succeeded) {
    const fresh = await client.request<PaymentIntentCandidate>("GET", `/api/v1/pa/payment_intents/${encodeURIComponent(payment.id)}`, { sensitivePaymentIntentRead: true });
    if (fresh.id !== payment.id || fresh.status !== "SUCCEEDED" || fresh.amount !== payment.amount || fresh.currency !== payment.currency) throw new Error("PAYMENT_INTENT_READBACK_MISMATCH");
    const linked = await disputes.listPage({ paymentIntentId: payment.id, page: "0", size: 1 }) as { items: readonly unknown[] };
    const disputeCount = linked.items.length;
    candidates.push({ ref: createHash("sha256").update(payment.id).digest("hex").slice(0, 16), status: fresh.status,
      amount: fresh.amount, currency: fresh.currency, disputeCount, eligible: disputeCount === 0 });
  }
  return { environment: "sandbox", outcome: "INVENTORY_COMPLETE", paymentIntentsExamined: list.items.length,
    succeededCount: succeeded.length, eligibleCount: candidates.filter((p) => p.eligible).length, candidates, providerMutations: 0,
    startedAtUtc, finishedAtUtc: new Date().toISOString() };
}
