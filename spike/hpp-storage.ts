import { chmod, copyFile, mkdir, open, readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import type { HppGateState, HppAttempt } from "./hpp.ts";

interface SqlStatement {
  get(...args: unknown[]): Record<string, unknown> | undefined;
  all(...args: unknown[]): Record<string, unknown>[];
  run(...args: unknown[]): { changes: number; lastInsertRowid: number | bigint };
}
interface SqlDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  close(): void;
}
type DatabaseCtor = new (path: string, options?: { timeout?: number; readOnly?: boolean }) => SqlDatabase;

export class HppSqliteStore {
  private constructor(private readonly db: SqlDatabase, readonly path: string) {}

  static async open(path: string, legacyJsonPath: string): Promise<HppSqliteStore> {
    const { DatabaseSync } = await import("node:sqlite" as string) as { DatabaseSync: DatabaseCtor };
    await mkdir(dirname(path), { recursive: true });
    const db = new DatabaseSync(path, { timeout: 5000 });
    const store = new HppSqliteStore(db, path);
    try {
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS gate_state (singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS reservations (checkout_id TEXT PRIMARY KEY, order_id TEXT NOT NULL UNIQUE, session_hash TEXT NOT NULL, session_expires_at INTEGER, revision INTEGER NOT NULL, replacement_count INTEGER NOT NULL DEFAULT 0, released INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS attempts (request_id TEXT PRIMARY KEY, merchant_order_id TEXT NOT NULL UNIQUE, checkout_id TEXT NOT NULL REFERENCES reservations(checkout_id), attempt_no INTEGER NOT NULL, dispatch_phase TEXT NOT NULL, intent_id TEXT UNIQUE, status TEXT, status_verified_at INTEGER, return_state_hash TEXT, return_state_expires_at INTEGER, return_consumed INTEGER NOT NULL DEFAULT 0, return_revoked INTEGER NOT NULL DEFAULT 0, UNIQUE(checkout_id, attempt_no));
      CREATE TABLE IF NOT EXISTS recovery_approvals (approval_hash TEXT PRIMARY KEY, checkout_id TEXT NOT NULL, revision INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, expires_at INTEGER NOT NULL, consumed_at INTEGER);
      CREATE TABLE IF NOT EXISTS recovery_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, actor TEXT NOT NULL, order_fingerprint TEXT NOT NULL, prior_revision INTEGER NOT NULL, prior_state TEXT NOT NULL, verified_state TEXT NOT NULL, approval_hash TEXT NOT NULL, reason TEXT NOT NULL, action TEXT NOT NULL, outcome TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON recovery_audit BEGIN SELECT RAISE(ABORT, 'append-only audit'); END;
      CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON recovery_audit BEGIN SELECT RAISE(ABORT, 'append-only audit'); END;`);
    for (const [table, column, definition] of [
      ["reservations", "session_expires_at", "INTEGER"], ["reservations", "replacement_count", "INTEGER NOT NULL DEFAULT 0"],
      ["attempts", "return_consumed", "INTEGER NOT NULL DEFAULT 0"], ["attempts", "return_revoked", "INTEGER NOT NULL DEFAULT 0"],
    ]) {
      if (!db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
    if (!db.prepare("SELECT singleton FROM gate_state WHERE singleton=1").get()) {
      let state: HppGateState = { sessions: [], revision: 0 };
      try {
        const info = await stat(legacyJsonPath);
        if (info.isFile()) {
          const backup = `${legacyJsonPath}.immutable-backup`;
          try { await copyFile(legacyJsonPath, backup, 1); } catch (error) {
            if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
              const [sourceBytes, backupBytes] = await Promise.all([readFile(legacyJsonPath), readFile(backup)]);
              if (!sourceBytes.equals(backupBytes)) throw new Error("Immutable legacy backup does not match source; refusing migration");
            } else throw error;
          }
          await chmod(backup, 0o600).catch(() => undefined);
          const backupHandle = await open(backup, "r+");
          try { await backupHandle.sync(); } finally { await backupHandle.close(); }
          await chmod(backup, 0o444).catch(() => undefined);
          const loaded = JSON.parse(await readFile(legacyJsonPath, "utf8")) as HppGateState;
          if (!Array.isArray(loaded.sessions)) throw new Error("Legacy HPP data is invalid; refusing migration");
          state = loaded;
          if (state.checkout) {
            state.checkout.sessionExpiresAt ??= state.sessions.find((s) => s.sessionHash === state.checkout!.sessionHash)?.expiresAt;
            for (const attempt of state.checkout.attempts) {
            // Old snapshots did not journal dispatch. Missing intent IDs cannot prove no request was sent.
            attempt.dispatchPhase = attempt.paymentIntentId ? "RESPONSE_RECORDED" : "LEGACY_AMBIGUOUS";
            attempt.revoked = attempt.returnConsumed ?? false;
            }
          }
          state.revision = Math.max(1, state.revision ?? 0);
        }
      } catch (error) {
        if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
      }
      store.save(state, 0);
    }
    return store;
    } catch (error) {
      try { db.close(); } catch { /* preserve initialization error */ }
      throw error;
    }
  }

  static async openForRecovery(path: string, readOnly: boolean): Promise<HppSqliteStore> {
    const { DatabaseSync } = await import("node:sqlite" as string) as { DatabaseSync: DatabaseCtor };
    const db = new DatabaseSync(path, { timeout: 5000, readOnly });
    const store = new HppSqliteStore(db, path);
    db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    if (!readOnly) db.exec("PRAGMA synchronous=FULL;");
    const names = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => String(row.name)));
    for (const required of ["gate_state", "reservations", "attempts", "recovery_approvals", "recovery_audit"]) {
      if (!names.has(required)) { db.close(); throw new Error("Recovery database is not initialized; run local HPP initialization first"); }
    }
    store.read();
    return store;
  }

  read(): HppGateState {
    const row = this.db.prepare("SELECT revision, payload FROM gate_state WHERE singleton=1").get();
    if (!row) throw new Error("HPP SQLite state missing");
    const state = JSON.parse(String(row.payload)) as HppGateState;
    if (!Array.isArray(state.sessions) || Number(row.revision) !== (state.revision ?? 0) ||
        (state.checkout && state.checkout.revision !== Number(row.revision))) throw new Error("HPP SQLite state inconsistent; failing closed");
    if (state.checkout) {
      const reservation = this.db.prepare("SELECT order_id,session_hash,session_expires_at,revision,replacement_count,released FROM reservations WHERE checkout_id=?").get(state.checkout.id);
      if (!reservation || reservation.order_id !== state.checkout.orderId || reservation.session_hash !== state.checkout.sessionHash ||
          (reservation.session_expires_at ?? undefined) !== state.checkout.sessionExpiresAt ||
          Number(reservation.revision) !== Number(state.revision) || Number(reservation.replacement_count) !== Math.max(0, state.checkout.attempts.length - 1) ||
          Number(reservation.released) !== (state.checkout.released ? 1 : 0)) throw new Error("HPP reservation index inconsistent; failing closed");
      for (const attempt of state.checkout.attempts) {
        const indexed = this.db.prepare("SELECT merchant_order_id,dispatch_phase,intent_id,status,status_verified_at,return_state_hash,return_state_expires_at,return_consumed,return_revoked FROM attempts WHERE request_id=?").get(attempt.requestId);
        if (!indexed || indexed.merchant_order_id !== attempt.merchantOrderId || indexed.dispatch_phase !== (attempt.dispatchPhase ?? "LEGACY_AMBIGUOUS") ||
            (indexed.intent_id ?? undefined) !== attempt.paymentIntentId || (indexed.status ?? undefined) !== attempt.status ||
            (indexed.status_verified_at ?? undefined) !== attempt.statusVerifiedAt || (indexed.return_state_hash ?? undefined) !== attempt.returnStateHash ||
            (indexed.return_state_expires_at ?? undefined) !== attempt.returnStateExpiresAt || Number(indexed.return_consumed) !== (attempt.returnConsumed ? 1 : 0) ||
            Number(indexed.return_revoked) !== (attempt.revoked ? 1 : 0)) {
          throw new Error("HPP attempt index inconsistent; failing closed");
        }
      }
    }
    return state;
  }

  save(state: HppGateState, expectedRevision: number): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT revision FROM gate_state WHERE singleton=1").get();
      if ((!row && expectedRevision !== 0) || (row && Number(row.revision) !== expectedRevision)) throw new Error("HPP SQLite revision conflict");
      const rev = state.revision ?? expectedRevision + 1;
      if (state.checkout) state.checkout.revision = rev;
      if (!row) this.db.prepare("INSERT INTO gate_state(singleton,revision,payload) VALUES(1,?,?)").run(rev, JSON.stringify(state));
      else this.db.prepare("UPDATE gate_state SET revision=?, payload=? WHERE singleton=1 AND revision=?").run(rev, JSON.stringify(state), expectedRevision);
      const c = state.checkout;
      if (c) {
        this.db.prepare(`INSERT INTO reservations(checkout_id,order_id,session_hash,session_expires_at,revision,replacement_count,released) VALUES(?,?,?,?,?,?,?)
          ON CONFLICT(checkout_id) DO UPDATE SET session_hash=excluded.session_hash,session_expires_at=excluded.session_expires_at,revision=excluded.revision,replacement_count=excluded.replacement_count,released=excluded.released`).run(c.id, c.orderId, c.sessionHash, c.sessionExpiresAt ?? null, rev, Math.max(0, c.attempts.length - 1), c.released ? 1 : 0);
        c.attempts.forEach((a: HppAttempt, index) => this.db.prepare(`INSERT INTO attempts(request_id,merchant_order_id,checkout_id,attempt_no,dispatch_phase,intent_id,status,status_verified_at,return_state_hash,return_state_expires_at,return_consumed,return_revoked)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(request_id) DO UPDATE SET dispatch_phase=excluded.dispatch_phase,intent_id=excluded.intent_id,status=excluded.status,status_verified_at=excluded.status_verified_at,return_state_hash=excluded.return_state_hash,return_state_expires_at=excluded.return_state_expires_at,return_consumed=excluded.return_consumed,return_revoked=excluded.return_revoked`)
          .run(a.requestId, a.merchantOrderId, c.id, index + 1, a.dispatchPhase ?? "LEGACY_AMBIGUOUS", a.paymentIntentId ?? null, a.status ?? null, a.statusVerifiedAt ?? null, a.returnStateHash ?? null, a.returnStateExpiresAt ?? null, a.returnConsumed ? 1 : 0, a.revoked ? 1 : 0));
      }
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  recoverySnapshot(): HppGateState { return this.read(); }

  recordVerifiedStatus(intentId: string, status: string, at: number, expectedRevision?: number): number {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT revision,payload FROM gate_state WHERE singleton=1").get();
      if (!row) throw new Error("HPP SQLite state missing");
      if (expectedRevision !== undefined && Number(row.revision) !== expectedRevision) throw new Error("HPP SQLite revision conflict");
      const state = JSON.parse(String(row.payload)) as HppGateState;
      const attempt = state.checkout?.attempts.find((a) => a.paymentIntentId === intentId);
      if (!attempt) throw new Error("Intent does not belong to a reservation");
      const revision = Number(row.revision) + 1;
      attempt.status = status; attempt.statusVerifiedAt = at; state.revision = revision; state.checkout!.revision = revision;
      this.db.prepare("UPDATE gate_state SET revision=?,payload=? WHERE singleton=1 AND revision=?").run(revision, JSON.stringify(state), Number(row.revision));
      this.db.prepare("UPDATE attempts SET status=?,status_verified_at=? WHERE intent_id=?").run(status, at, intentId);
      this.db.prepare("UPDATE reservations SET revision=? WHERE checkout_id=?").run(revision, state.checkout!.id);
      this.db.exec("COMMIT"); return revision;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  createApproval(checkoutId: string, revision: number, actor: string, expiresAt: number, approvalHash: string): void {
    const row = this.db.prepare("SELECT revision FROM gate_state WHERE singleton=1").get();
    if (!row || Number(row.revision) !== revision) throw new Error("Reservation changed; inspect again");
    this.db.prepare("INSERT INTO recovery_approvals(approval_hash,checkout_id,revision,actor,action,expires_at) VALUES(?,?,?,?,?,?)")
      .run(approvalHash, checkoutId, revision, actor, "RELEASE", expiresAt);
  }

  release(expectedRevision: number, actor: string, reason: string, approvalHash: string, now: number, verifiedStatus: string): "RELEASED" | "ALREADY_RELEASED" {
    if (reason !== "ABANDONED_BEFORE_DISPATCH" && reason !== "ALL_ATTEMPTS_VERIFIED_CANCELLED") throw new Error("Invalid recovery reason");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT revision,payload FROM gate_state WHERE singleton=1").get();
      if (!row) throw new Error("HPP SQLite state missing");
      const state = JSON.parse(String(row.payload)) as HppGateState;
      if (!state.checkout) throw new Error("No reservation");
      const c = state.checkout;
      const approval = this.db.prepare("SELECT checkout_id,revision,actor,action,expires_at,consumed_at FROM recovery_approvals WHERE approval_hash=?").get(approvalHash);
      if (!approval || approval.checkout_id !== c.id || Number(approval.revision) !== expectedRevision || approval.actor !== actor || approval.action !== "RELEASE") throw new Error("Invalid recovery approval");
      if (state.checkout.released) {
        if (approval.consumed_at == null) throw new Error("Conflicting recovery approval");
        this.db.exec("COMMIT"); return "ALREADY_RELEASED";
      }
      if (Number(row.revision) !== expectedRevision || (state.revision ?? 0) !== expectedRevision) throw new Error("Recovery revision conflict");
      const reservation = this.db.prepare("SELECT order_id,session_hash,session_expires_at,revision,replacement_count,released FROM reservations WHERE checkout_id=?").get(c.id);
      if (!reservation || reservation.order_id !== c.orderId || reservation.session_hash !== c.sessionHash || Number(reservation.revision) !== expectedRevision ||
          (reservation.session_expires_at ?? undefined) !== c.sessionExpiresAt ||
          Number(reservation.replacement_count) !== Math.max(0, c.attempts.length - 1) || Number(reservation.released) !== 0) throw new Error("Reservation index conflict");
      if (approval.consumed_at != null || Number(approval.expires_at) <= now) throw new Error("Invalid recovery approval");
      const a = c.attempts.at(-1);
      if (!a) throw new Error("Missing attempt");
      for (const attempt of c.attempts) {
        const indexedAttempt = this.db.prepare("SELECT merchant_order_id,dispatch_phase,intent_id,status,status_verified_at,return_state_hash,return_state_expires_at,return_consumed FROM attempts WHERE request_id=?").get(attempt.requestId);
        if (!indexedAttempt || indexedAttempt.merchant_order_id !== attempt.merchantOrderId || indexedAttempt.dispatch_phase !== attempt.dispatchPhase ||
            (indexedAttempt.intent_id ?? undefined) !== attempt.paymentIntentId || (indexedAttempt.status ?? undefined) !== attempt.status ||
            (indexedAttempt.status_verified_at ?? undefined) !== attempt.statusVerifiedAt || (indexedAttempt.return_state_hash ?? undefined) !== attempt.returnStateHash ||
            (indexedAttempt.return_state_expires_at ?? undefined) !== attempt.returnStateExpiresAt || Number(indexedAttempt.return_consumed) !== (attempt.returnConsumed ? 1 : 0)) throw new Error("Attempt index conflict");
      }
      const eligibleNoDispatch = c.attempts.length === 1 && a.dispatchPhase === "NOT_DISPATCHED" && !a.paymentIntentId && verifiedStatus === "NOT_DISPATCHED";
      const sessionExpired = typeof c.sessionExpiresAt === "number" && c.sessionExpiresAt <= now;
      const attemptsResolved = c.attempts.every((attempt) => {
        if (attempt.status === "SUCCEEDED") return false;
        if (!attempt.paymentIntentId) return attempt.dispatchPhase === "NOT_DISPATCHED";
        const age = attempt.statusVerifiedAt === undefined ? Number.POSITIVE_INFINITY : now - attempt.statusVerifiedAt;
        return attempt.dispatchPhase === "RESPONSE_RECORDED" && attempt.status === "CANCELLED" && age >= 0 && age <= 30_000;
      });
      const latestCancelled = a.paymentIntentId && verifiedStatus === "CANCELLED" && a.status === verifiedStatus;
      const eligibleCancelled = attemptsResolved && !!latestCancelled && sessionExpired;
      if (!(eligibleNoDispatch && sessionExpired) && !eligibleCancelled) throw new Error("Reservation is not eligible for release");
      const priorRevision = expectedRevision;
      a.revoked = true; a.returnConsumed = true; a.returnStateHash = undefined; a.returnStateExpiresAt = undefined;
      c.released = true; c.revision = priorRevision + 1; state.revision = priorRevision + 1;
      this.db.prepare("UPDATE recovery_approvals SET consumed_at=? WHERE approval_hash=? AND consumed_at IS NULL").run(now, approvalHash);
      this.db.prepare("UPDATE gate_state SET revision=?,payload=? WHERE singleton=1 AND revision=?").run(state.revision, JSON.stringify(state), expectedRevision);
      this.db.prepare("UPDATE reservations SET revision=?,released=1 WHERE checkout_id=?").run(state.revision, c.id);
      this.db.prepare("UPDATE attempts SET return_revoked=1,return_consumed=1,return_state_hash=NULL,return_state_expires_at=NULL WHERE checkout_id=?").run(c.id);
      this.db.prepare("INSERT INTO recovery_audit(at,actor,order_fingerprint,prior_revision,prior_state,verified_state,approval_hash,reason,action,outcome) VALUES(?,?,?,?,?,?,?,?,?,?)")
        .run(now, actor, createHash("sha256").update(c.orderId).digest("hex").slice(0, 12), priorRevision, a.status ?? "UNKNOWN", verifiedStatus, approvalHash, reason.replace(/[\r\n\t]/g, " ").slice(0, 240), "RELEASE", "RELEASED");
      this.db.exec("COMMIT");
      return "RELEASED";
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  auditCount(): number { return Number(this.db.prepare("SELECT COUNT(*) AS count FROM recovery_audit").get()?.count ?? 0); }

  close(): void { this.db.close(); }
}
