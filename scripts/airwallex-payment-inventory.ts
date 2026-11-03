import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { AirwallexClient, loadConfig } from "../src/airwallex.ts";
import { inventoryPaymentIntents } from "../src/airwallex-payment-inventory.ts";

if (process.argv.includes("--execute-readonly")) {
  const config = loadConfig([]);
  const receipt = await inventoryPaymentIntents(new AirwallexClient(config), 10);
  const dir = resolve("submission/evidence"); mkdirSync(dir, { recursive: true });
  const path = resolve(dir, `airwallex-payment-inventory-${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15)}-${randomUUID()}.json`);
  writeFileSync(path, JSON.stringify(receipt, null, 2), { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ ...receipt, evidencePath: path }, null, 2));
} else {
  console.log(JSON.stringify({ mode: "PREVIEW", environment: "sandbox", maximumPaymentIntents: 10,
    calls: ["GET /api/v1/pa/payment_intents?status=SUCCEEDED&page_num=0&page_size=10", "GET /api/v1/pa/payment_intents/{id}", "GET /api/v1/pa/payment_disputes?payment_intent_id={id}"], providerMutations: 0 }));
}
