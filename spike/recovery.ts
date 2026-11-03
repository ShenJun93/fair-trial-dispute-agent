import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig, AirwallexClient } from "../src/airwallex.ts";
import { HppService, hashSecret } from "./hpp.ts";
import { HppSqliteStore } from "./hpp-storage.ts";
import { requireFreshRecoveryAuthentication } from "./recovery-policy.ts";

const DATA = resolve(process.cwd(), "out", "hpp-gate-state.sqlite");
const CREDENTIAL = resolve(process.cwd(), "out", "recovery-admin.dpapi");
const APPROVAL_TTL = 5 * 60_000;
const STATUS_MAX_AGE = 30_000;
const actor = `win-${createHash("sha256").update(`${process.env.COMPUTERNAME ?? "host"}\\${process.env.USERNAME ?? "operator"}`).digest("hex").slice(0, 16)}`;

function credential(action: "setup" | "auth"): boolean {
  if (process.platform !== "win32") throw new Error("Recovery administrator DPAPI authentication requires Windows");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-File", resolve(process.cwd(), "scripts", "recovery-admin.ps1"), action, CREDENTIAL], { encoding: "utf8", stdio: ["inherit", "pipe", "inherit"] });
  const marker = result.stdout.trim();
  if (action === "setup") {
    if (result.status !== 0 || marker !== "CREATED") throw new Error(`Credential setup failed (${marker || "unavailable"})`);
    return true;
  }
  return result.status === 0 && marker === "AUTH_OK";
}

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  try { return (await rl.question(question)).trim(); } finally { rl.close(); }
}

async function main(): Promise<void> {
  const [command] = process.argv.slice(2);
  if (command === "setup-credential") {
    credential("setup");
    console.log("Recovery credential stored with current-user Windows DPAPI; expires after 30 days.");
    return;
  }
  if (command !== "inspect" && command !== "release") throw new Error("Usage: node --import tsx spike/recovery.ts <setup-credential|inspect|release>");
  requireFreshRecoveryAuthentication(credential("auth"));

  const store = await HppSqliteStore.openForRecovery(DATA, command === "inspect");
  try {
    let state = store.recoverySnapshot();
    const checkout = state.checkout;
    if (checkout?.released && command === "release") { console.log("ALREADY_COMPLETED"); return; }
    if (!checkout || checkout.released) throw new Error("No active recoverable reservation");
    const attempt = checkout.attempts.at(-1);
    if (!attempt) throw new Error("Reservation has no attempt");
    const inspectedRevision = state.revision ?? 0;
    const initialFingerprint = createHash("sha256").update(checkout.orderId).digest("hex").slice(0, 12).toUpperCase();
    if (command === "release") {
      const reviewedFingerprint = await ask("Order fingerprint from recovery inspect: ");
      if (reviewedFingerprint !== initialFingerprint) throw new Error("Order fingerprint did not match");
    }

    const verified = new Map<string, { status: string; at: number }>();
    let verificationRevision = state.revision ?? 0;
    let service: HppService | undefined;
    for (const item of checkout.attempts) {
      if (!item.paymentIntentId) {
        verified.set(item.requestId, { status: item.dispatchPhase === "NOT_DISPATCHED" ? "NOT_DISPATCHED" : "UNKNOWN", at: Date.now() });
        continue;
      }
      if (!service) {
        const config = loadConfig();
        if (config.dryRun) throw new Error("Recovery status verification must not use dry-run responses");
        service = HppService.fromClient(new AirwallexClient(config));
      }
      const result = await service.status(item.paymentIntentId, {
        amount: 1, currency: "USD", merchantOrderId: item.merchantOrderId, requestId: item.requestId,
      });
      const status = result.stateKnown ? result.status : "UNKNOWN";
      verified.set(item.requestId, { status, at: Date.now() });
    }
    if (command === "release") {
      for (const item of checkout.attempts) {
        const receipt = verified.get(item.requestId)!;
        if (item.paymentIntentId) {
          store.recordVerifiedStatus(item.paymentIntentId, receipt.status, receipt.at, verificationRevision);
          verificationRevision++;
        }
      }
      state = store.recoverySnapshot();
    }
    const refreshedCheckout = state.checkout!;
    const refreshedLast = refreshedCheckout.attempts.at(-1)!;
    const statusReadCount = checkout.attempts.filter((item) => item.paymentIntentId).length;
    if (command === "release" && ((state.revision ?? 0) !== verificationRevision || statusReadCount !== verificationRevision - inspectedRevision)) throw new Error("Reservation changed during status verification; inspect again");
    const verifiedStatus = verified.get(refreshedLast.requestId)?.status ?? "UNKNOWN";
    const sessionExpired = typeof refreshedCheckout.sessionExpiresAt === "number" && refreshedCheckout.sessionExpiresAt <= Date.now();
    const attemptsResolved = refreshedCheckout.attempts.every((item) => item.paymentIntentId
      ? item.dispatchPhase === "RESPONSE_RECORDED" && verified.get(item.requestId)?.status === "CANCELLED"
      : item.dispatchPhase === "NOT_DISPATCHED");
    const latestSafe = refreshedLast.paymentIntentId ? verifiedStatus === "CANCELLED" : verifiedStatus === "NOT_DISPATCHED" && refreshedLast.dispatchPhase === "NOT_DISPATCHED";
    const eligible = sessionExpired && attemptsResolved && latestSafe;
    const orderFingerprint = createHash("sha256").update(refreshedCheckout.orderId).digest("hex").slice(0, 12).toUpperCase();
    const preview = {
      reservation: createHash("sha256").update(refreshedCheckout.id).digest("hex").slice(0, 12), order: orderFingerprint,
      attempt: refreshedCheckout.attempts.length, phase: refreshedLast.dispatchPhase ?? "LEGACY_AMBIGUOUS",
      intentKnown: !!refreshedLast.paymentIntentId, persistedStatus: refreshedLast.status ?? "UNKNOWN",
      lastVerificationUtc: refreshedLast.statusVerifiedAt ? new Date(refreshedLast.statusVerifiedAt).toISOString() : null,
      currentVerifiedStatus: verifiedStatus,
      currentVerificationUtc: verified.get(refreshedLast.requestId)?.at ? new Date(verified.get(refreshedLast.requestId)!.at).toISOString() : null,
      sessionExpired, replacementCount: Math.max(0, refreshedCheckout.attempts.length - 1), eligible,
    };
    if (!eligible) throw new Error(`Recovery blocked; redacted preview: ${JSON.stringify(preview)}`);

    if (command === "inspect") {
      console.log(JSON.stringify({ preview }, null, 2));
      return;
    }

    const currentRevision = refreshedCheckout.revision ?? state.revision ?? 0;
    console.log(`Current redacted preview: ${JSON.stringify(preview)}`);
    if (refreshedCheckout.attempts.some((item) => item.paymentIntentId &&
      (!item.statusVerifiedAt || Date.now() - item.statusVerifiedAt < 0 || Date.now() - item.statusVerifiedAt > STATUS_MAX_AGE ||
       Date.now() - (verified.get(item.requestId)?.at ?? 0) > STATUS_MAX_AGE))) {
      throw new Error("Verification receipt expired; inspect and release again");
    }
    const approvalHash = hashSecret(randomBytes(32).toString("base64url"));
    store.createApproval(refreshedCheckout.id, currentRevision, actor, Date.now() + APPROVAL_TTL, approvalHash);
    const reason = refreshedCheckout.attempts.some((item) => item.paymentIntentId) ? "ALL_ATTEMPTS_VERIFIED_CANCELLED" : "ABANDONED_BEFORE_DISPATCH";
    if (await ask(`Type audit reason ${reason}: `) !== reason) throw new Error("Recovery reason did not match");
    const confirmation = await ask(`Type RELEASE ${orderFingerprint} to release: `);
    if (confirmation !== `RELEASE ${orderFingerprint}`) throw new Error("Confirmation did not match");
    const result = store.release(currentRevision, actor, reason, approvalHash, Date.now(), verifiedStatus);
    console.log(result === "RELEASED" ? "Reservation released. No PaymentIntent was created or cancelled." : "ALREADY_COMPLETED");
  } finally { store.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error("Recovery failed closed. No new PaymentIntent was created or cancelled."); process.exitCode = 1; });
}
