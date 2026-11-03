import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { HppSqliteStore } from "../spike/hpp-storage.ts";
import { HppGate, HppGateError, HppService } from "../spike/hpp.ts";
import { requireFreshRecoveryAuthentication } from "../spike/recovery-policy.ts";

const actor = "offline-admin-a";
const now = Date.now();
const requestId = "request_offline_123";
const intentId = "int_offline_123";

async function fixture(options: { phase?: string; status?: string; intent?: boolean; expiry?: number; verifiedAt?: number; legacy?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "fairtrial-hpp-"));
  const dbPath = join(dir, "gate.sqlite");
  const legacyPath = join(dir, "gate.json");
  const checkout = {
    id: "checkout_offline_123", sessionHash: "session-hash-only", orderId: "ft-hpp-offline-order",
    createdAt: now - 100_000, sessionExpiresAt: options.expiry ?? now - 1, revision: 1, released: false, attempts: [{
      requestId, merchantOrderId: "ft-hpp-offline-order", dispatchPhase: options.phase ?? (options.intent ? "RESPONSE_RECORDED" : "NOT_DISPATCHED"),
      ...(options.intent ? { paymentIntentId: intentId } : {}), ...(options.status ? { status: options.status } : {}),
      ...(options.verifiedAt ? { statusVerifiedAt: options.verifiedAt } : {}), returnStateHash: "hashed-return-state", returnStateExpiresAt: now + 10_000,
    }],
  };
  const state = { revision: 1, sessions: [{ sessionHash: "session-hash-only", csrfHashes: ["hashed-csrf"], expiresAt: options.expiry ?? now - 1 }], checkout };
  if (options.legacy) await writeFile(legacyPath, JSON.stringify(state));
  const store = await HppSqliteStore.open(dbPath, legacyPath);
  if (!options.legacy) store.save(state, 0);
  return { dir, dbPath, legacyPath, store, state };
}

async function approved(store: HppSqliteStore, state: { checkout: { id: string }; revision: number }, admin = actor) {
  const code = `approval-${Math.random().toString(36).slice(2)}`;
  const digest = (await import("../spike/hpp.ts")).hashSecret(code);
  store.createApproval(state.checkout.id, state.revision, admin, now + 60_000, digest);
  return digest;
}

async function clean(dir: string, store?: HppSqliteStore): Promise<void> { store?.close(); await rm(dir, { recursive: true, force: true }); }

test("expired session with durable NOT_DISPATCHED releases and survives restart", async () => {
  const f = await fixture();
  try {
    const approval = await approved(f.store, f.state);
    assert.equal(f.store.release(1, actor, "ABANDONED_BEFORE_DISPATCH", approval, now, "NOT_DISPATCHED"), "RELEASED");
    f.store.close();
    const reopened = await HppSqliteStore.open(f.dbPath, f.legacyPath);
    try { assert.equal(reopened.read().checkout?.released, true); assert.equal(reopened.read().checkout?.attempts[0]?.revoked, true); }
    finally { reopened.close(); }
  } finally { await clean(f.dir); }
});

test("ambiguous timeout, dispatched-without-ID, and ambiguous legacy state stay locked", async () => {
  for (const phase of ["DISPATCHED", "LEGACY_AMBIGUOUS"]) {
    const f = await fixture({ phase });
    try {
      const approval = await approved(f.store, f.state);
      assert.throws(() => f.store.release(1, actor, "ABANDONED_BEFORE_DISPATCH", approval, now, "UNKNOWN"), /not eligible/);
    } finally { await clean(f.dir, f.store); }
  }
});

test("restart preserves ambiguous dispatch and blocks another dispatch attempt", async () => {
  const f = await fixture({ phase: "DISPATCHED" });
  try {
    f.store.close();
    const reopened = await HppSqliteStore.open(f.dbPath, f.legacyPath);
    try {
      const state = reopened.read();
      assert.equal(state.checkout?.attempts[0]?.dispatchPhase, "DISPATCHED");
      const gate = new HppGate("x".repeat(40), state);
      await assert.rejects(gate.markDispatched("session-hash-only", requestId), (e: unknown) => e instanceof HppGateError && e.code === "dispatch_state_conflict");
    } finally { reopened.close(); }
  } finally { await clean(f.dir); }
});

test("active session cannot be released even when durable journal says NOT_DISPATCHED", async () => {
  const f = await fixture({ expiry: now + 60_000 });
  try {
    const approval = await approved(f.store, f.state);
    assert.throws(() => f.store.release(1, actor, "ABANDONED_BEFORE_DISPATCH", approval, now, "NOT_DISPATCHED"), /not eligible/);
  } finally { await clean(f.dir, f.store); }
});

test("legacy migration keeps an immutable backup and does not infer NOT_DISPATCHED", async () => {
  const f = await fixture({ legacy: true });
  try {
    const backup = await readFile(`${f.legacyPath}.immutable-backup`, "utf8");
    assert.equal(backup, await readFile(f.legacyPath, "utf8"));
    assert.equal(f.store.read().checkout?.attempts[0]?.dispatchPhase, "LEGACY_AMBIGUOUS");
  } finally { await clean(f.dir, f.store); }
});

test("legacy migration refuses a pre-existing backup that differs from the source", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fairtrial-hpp-mismatch-"));
  const dbPath = join(dir, "gate.sqlite"); const legacyPath = join(dir, "gate.json");
  try {
    await writeFile(legacyPath, JSON.stringify({ sessions: [], revision: 0 }));
    await writeFile(`${legacyPath}.immutable-backup`, "different backup");
    await assert.rejects(HppSqliteStore.open(dbPath, legacyPath), /backup does not match/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("recovery inspect can read an initialized database without changing reservation state", async () => {
  const f = await fixture({ phase: "DISPATCHED" });
  try {
    const before = f.store.read();
    f.store.close();
    const inspect = await HppSqliteStore.openForRecovery(f.dbPath, true);
    try { assert.deepEqual(inspect.recoverySnapshot(), before); }
    finally { inspect.close(); }
    const reopened = await HppSqliteStore.openForRecovery(f.dbPath, true);
    try { assert.deepEqual(reopened.read(), before); }
    finally { reopened.close(); }
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("CANCELLED can release only with an expired owner and a fresh matching receipt", async () => {
  const f = await fixture({ intent: true, status: "CANCELLED", verifiedAt: now - 1_000 });
  try {
    const approval = await approved(f.store, f.state);
    assert.equal(f.store.release(1, actor, "ALL_ATTEMPTS_VERIFIED_CANCELLED", approval, now, "CANCELLED"), "RELEASED");
  } finally { await clean(f.dir, f.store); }
  const stale = await fixture({ intent: true, status: "CANCELLED", verifiedAt: now - 60_000 });
  try {
    const approval = await approved(stale.store, stale.state);
    assert.throws(() => stale.store.release(1, actor, "ALL_ATTEMPTS_VERIFIED_CANCELLED", approval, now, "CANCELLED"), /not eligible/);
  } finally { await clean(stale.dir, stale.store); }
});

test("fresh receipt advances the revision before a one-use release approval is created", async () => {
  const f = await fixture({ intent: true, status: "CANCELLED" });
  try {
    const nextRevision = f.store.recordVerifiedStatus(intentId, "CANCELLED", now, 1);
    const { hashSecret } = await import("../spike/hpp.ts");
    const approval = hashSecret("fresh-approval");
    f.store.createApproval(f.state.checkout.id, nextRevision, actor, now + 60_000, approval);
    assert.equal(f.store.release(nextRevision, actor, "ALL_ATTEMPTS_VERIFIED_CANCELLED", approval, now, "CANCELLED"), "RELEASED");
  } finally { await clean(f.dir, f.store); }
});

test("succeeded, pending, 3DS, capture, payment-method, unknown and conflicting/API-failure states fail closed", async () => {
  for (const status of ["SUCCEEDED", "PENDING", "PENDING_REVIEW", "REQUIRES_CUSTOMER_ACTION", "REQUIRES_CAPTURE", "REQUIRES_PAYMENT_METHOD", "UNKNOWN"]) {
    const f = await fixture({ intent: true, status, verifiedAt: now - 1_000 });
    try {
      const approval = await approved(f.store, f.state);
      assert.throws(() => f.store.release(1, actor, "ALL_ATTEMPTS_VERIFIED_CANCELLED", approval, now, status), /not eligible/, status);
    } finally { await clean(f.dir, f.store); }
  }
  const unavailable = await fixture({ phase: "DISPATCHED" });
  try {
    const approval = await approved(unavailable.store, unavailable.state);
    assert.throws(() => unavailable.store.release(1, actor, "ABANDONED_BEFORE_DISPATCH", approval, now, "UNKNOWN"), /not eligible/);
  } finally { await clean(unavailable.dir, unavailable.store); }
});

test("mismatched PaymentIntent read-back identity cannot authorize downstream recovery", async () => {
  const service = new HppService(async () => ({
    id: intentId, request_id: "different-request-id", merchant_order_id: "ft-hpp-offline-order",
    amount: 1, currency: "USD", status: "SUCCEEDED",
  }));
  const readback = await service.status(intentId, { amount: 1, currency: "USD", merchantOrderId: "ft-hpp-offline-order", requestId });
  assert.deepEqual(readback, { id: intentId, status: "UNKNOWN", succeeded: false, stateKnown: false });
  const f = await fixture({ intent: true, status: readback.status, verifiedAt: now - 1_000 });
  try {
    const approval = await approved(f.store, f.state);
    assert.throws(() => f.store.release(1, actor, "ALL_ATTEMPTS_VERIFIED_CANCELLED", approval, now, readback.status), /not eligible/);
    assert.equal(f.store.auditCount(), 0);
  } finally { await clean(f.dir, f.store); }
});

test("release approval is bound to actor, revision, order and one-time use", async () => {
  const f = await fixture();
  try {
    const approval = await approved(f.store, f.state);
    assert.throws(() => f.store.release(1, "different-admin", "ABANDONED_BEFORE_DISPATCH", approval, now, "NOT_DISPATCHED"), /Invalid recovery approval/);
    assert.throws(() => f.store.release(2, actor, "ABANDONED_BEFORE_DISPATCH", approval, now, "NOT_DISPATCHED"), /Invalid recovery approval/);
    assert.throws(() => f.store.release(1, actor, "ABANDONED_BEFORE_DISPATCH", approval, now + 120_000, "NOT_DISPATCHED"), /Invalid recovery approval/);
    assert.equal(f.store.release(1, actor, "ABANDONED_BEFORE_DISPATCH", approval, now, "NOT_DISPATCHED"), "RELEASED");
    assert.equal(f.store.release(1, actor, "ABANDONED_BEFORE_DISPATCH", approval, now, "NOT_DISPATCHED"), "ALREADY_RELEASED");
    assert.equal(f.store.auditCount(), 1);
    assert.throws(() => f.store.release(1, actor, "ABANDONED_BEFORE_DISPATCH", "wrong-approval", now, "NOT_DISPATCHED"), /Invalid recovery approval/);
  } finally { await clean(f.dir, f.store); }
});

test("two separate recovery processes cannot release the same revision twice", async () => {
  const f = await fixture();
  try {
    const approvalA = await approved(f.store, f.state, "admin-a");
    const approvalB = await approved(f.store, f.state, "admin-b");
    const worker = resolve(process.cwd(), "scripts", "hpp-recovery-worker.ts");
    const run = (admin: string, approval: string) => new Promise<string>((resolveOutput, reject) => {
      const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "--import", "tsx", worker, f.dbPath, "1", admin, approval, "NOT_DISPATCHED"], { stdio: ["ignore", "pipe", "pipe"] });
      let out = ""; let err = ""; child.stdout.setEncoding("utf8").on("data", (chunk: string) => { out += chunk; }); child.stderr.setEncoding("utf8").on("data", (chunk: string) => { err += chunk; });
      child.once("error", reject); child.once("close", (code) => code === 0 ? resolveOutput(out.trim()) : reject(new Error(`${err} ${out} worker exited ${code}`)));
    });
    const outputs = (await Promise.all([run("admin-a", approvalA), run("admin-b", approvalB)])).sort();
    assert.deepEqual(outputs, ["REJECTED", "RELEASED"]);
    assert.equal(f.store.auditCount(), 1);
  } finally { await clean(f.dir, f.store); }
});

test("uncommitted SQLite recovery work rolls back after process exit", async () => {
  const f = await fixture();
  try {
    const script = `import {DatabaseSync} from 'node:sqlite'; const d=new DatabaseSync(process.argv[1]); d.exec('BEGIN IMMEDIATE'); d.prepare('UPDATE gate_state SET revision=99,payload=? WHERE singleton=1').run('{}'); process.exit(0);`;
    const crashed = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", script, f.dbPath], { encoding: "utf8", timeout: 10_000 });
    assert.equal(crashed.status, 0);
    assert.equal(f.store.read().revision, 1);
    const approval = await approved(f.store, f.state);
    assert.equal(f.store.release(1, actor, "ABANDONED_BEFORE_DISPATCH", approval, now, "NOT_DISPATCHED"), "RELEASED");
  } finally { await clean(f.dir, f.store); }
});

test("crash after fresh verification but before release leaves reservation locked across restart", async () => {
  const f = await fixture({ intent: true, status: "CANCELLED" });
  try {
    f.store.recordVerifiedStatus(intentId, "CANCELLED", now, 1);
    f.store.close();
    const reopened = await HppSqliteStore.open(f.dbPath, f.legacyPath);
    try {
      const state = reopened.read();
      assert.equal(state.checkout?.released, false);
      assert.equal(state.checkout?.attempts[0]?.status, "CANCELLED");
      assert.equal(state.checkout?.attempts[0]?.statusVerifiedAt, now);
    } finally { reopened.close(); }
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("late browser return cannot restore launch rights after release", async () => {
  const f = await fixture();
  try {
    const approval = await approved(f.store, f.state);
    f.store.release(1, actor, "ABANDONED_BEFORE_DISPATCH", approval, now, "NOT_DISPATCHED");
    const released = f.store.read();
    assert.equal(released.checkout?.attempts[0]?.returnStateHash, undefined);
    assert.equal(released.checkout?.attempts[0]?.revoked, true);
    const gate = new HppGate("x".repeat(40), released);
    assert.throws(() => gate.checkoutForSession("session-hash-only"), (e: unknown) => e instanceof HppGateError && e.code === "checkout_not_found");
  } finally { await clean(f.dir, f.store); }
});

test("unauthorized recovery attempt fails before any database mutation", async () => {
  const f = await fixture();
  try {
    const before = f.store.read();
    assert.throws(() => requireFreshRecoveryAuthentication(false), /authentication required/);
    assert.deepEqual(f.store.read(), before);
    assert.doesNotMatch(await readFile(resolve(process.cwd(), "scripts", "recovery-admin.ps1"), "utf8"), /Write-Output.*\$right|Write-Output.*\$secret/);
  } finally { await clean(f.dir, f.store); }
});

test("late legacy backup is never overwritten", async () => {
  const f = await fixture({ legacy: true });
  try {
    const original = await readFile(`${f.legacyPath}.immutable-backup`, "utf8");
    await writeFile(f.legacyPath, "different legacy state");
    // The original migrated DB remains authoritative and the backup remains byte-for-byte unchanged.
    assert.equal(await readFile(`${f.legacyPath}.immutable-backup`, "utf8"), original);
  } finally { await clean(f.dir, f.store); }
});
