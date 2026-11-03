/**
 * Minimal Airwallex sandbox client for the Fair Trial spike.
 *
 * - login: POST /api/v1/authentication/login with x-client-id / x-api-key headers, no body.
 *   Token lives 30 min per the API reference; we cache it for at most 25 min (in memory only,
 *   never written to disk).
 * - request: JSON helper. `idempotent: true` adds a UUID `request_id` to the body if missing and
 *   reuses the same id on 429/401 retries (same operation), as the builder guide requires.
 * - upload: multipart helper for the files host (POST /api/v1/files/upload).
 * - AirwallexError: typed error carrying HTTP status, Airwallex `code`, `source`, `details`.
 * - log / redact: everything printed or written goes through redact(), which removes credentials,
 *   bearer tokens (JWT-shaped strings), the live secret values themselves, and masks card numbers.
 * - --dry-run (or DRY_RUN=1): no network at all; requests are printed (method, path, redacted
 *   body) and a mock response is returned so scripts can chain.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface Config {
  clientId: string;
  apiKey: string;
  /** Required only for scoped keys linked to multiple accounts; never log this account ID. */
  loginAsTarget?: string;
  base: string;
  filesBase: string;
  webhookSecret: string;
  dryRun: boolean;
}

/** Minimal .env parser (KEY=VALUE, # comments, optional quotes). Does not override real env. */
function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export const DEFAULT_BASE = "https://api.sandbox.airwallex.com";
export const DEFAULT_FILES_BASE = "https://files.sandbox.airwallex.com";

/** Exact vendor-owned sandbox endpoints. A 'sandbox' label anywhere in the hostname is NOT sufficient. */
const SANDBOX_HOSTS: Record<string, ReadonlySet<string>> = {
  AIRWALLEX_BASE: new Set(["api.sandbox.airwallex.com"]),
  AIRWALLEX_FILES_BASE: new Set(["files.sandbox.airwallex.com"]),
};

/** Refuse external, production, ambiguous and URL-with-credentials endpoints before loading keys. */
export function assertSandboxHost(url: string, name: string): string {
  const u = new URL(url);
  if (u.protocol !== "https:") throw new Error(`${name} must be https (got ${u.protocol})`);
  if (!SANDBOX_HOSTS[name]?.has(u.hostname)) {
    throw new Error(`${name} host "${u.hostname}" is not a permitted Airwallex sandbox endpoint; refusing to run.`);
  }
  if (u.username || u.password || u.port || u.pathname !== "/" || u.search || u.hash) {
    throw new Error(`${name} must be the bare HTTPS origin without credentials, custom port, path, query or fragment.`);
  }
  return u.origin;
}

export function isDryRun(argv: string[] = process.argv): boolean {
  return argv.includes("--dry-run") || process.env.DRY_RUN === "1";
}

export function loadConfig(argv: string[] = process.argv): Config {
  const root = process.cwd();
  loadEnvFile(resolve(root, ".env.local"));
  loadEnvFile(resolve(root, ".env"));
  const dryRun = isDryRun(argv);
  const clientId = process.env.AIRWALLEX_CLIENT_ID ?? "";
  const apiKey = process.env.AIRWALLEX_API_KEY ?? "";
  if (!dryRun && (!clientId || !apiKey)) {
    throw new Error(
      "AIRWALLEX_CLIENT_ID / AIRWALLEX_API_KEY are empty. Paste sandbox keys into .env.local (see spike/README.md), or pass --dry-run.",
    );
  }
  return {
    clientId,
    apiKey,
    ...(process.env.AIRWALLEX_LOGIN_AS ? { loginAsTarget: process.env.AIRWALLEX_LOGIN_AS } : {}),
    base: assertSandboxHost(process.env.AIRWALLEX_BASE || DEFAULT_BASE, "AIRWALLEX_BASE"),
    filesBase: assertSandboxHost(process.env.AIRWALLEX_FILES_BASE || DEFAULT_FILES_BASE, "AIRWALLEX_FILES_BASE"),
    webhookSecret: process.env.WEBHOOK_SECRET ?? "",
    dryRun,
  };
}

// ---------------------------------------------------------------------------
// Redaction + logger
// ---------------------------------------------------------------------------

const SECRET_KEYS =
  /^(authorization|x-api-key|x-client-id|x-login-as|api[-_]?key|client[-_]?id|token|access[-_]?token|refresh[-_]?token|session[-_]?token|csrf[-_]?token|return[-_]?state|secret|client[-_]?secret|webhook[-_]?secret|password|cvc|cvv)$/i;
const JWT = /eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g;
const BEARER = /Bearer\s+[A-Za-z0-9._~+/=-]+/g;
const PAN = /\b\d{13,19}\b/g;

const liveSecrets = new Set<string>();
/** Register a value (key, token) so it is scrubbed from any string that is logged or saved. */
export function registerSecret(value: string | undefined): void {
  if (value && value.length >= 6) liveSecrets.add(value);
}

function scrubString(s: string): string {
  let out = s;
  for (const secret of liveSecrets) out = out.split(secret).join("[REDACTED]");
  return out
    .replace(BEARER, "Bearer [REDACTED]")
    .replace(JWT, "[REDACTED_JWT]")
    .replace(PAN, (m) => `************${m.slice(-4)}`);
}

export function redact<T>(value: T): T {
  const walk = (v: unknown, key?: string): unknown => {
    if (key !== undefined && SECRET_KEYS.test(key)) return v === "" || v == null ? v : "[REDACTED]";
    if (key === "number" && (typeof v === "string" || typeof v === "number")) {
      const s = String(v);
      return s.length >= 12 ? `************${s.slice(-4)}` : s;
    }
    if (typeof v === "string") return scrubString(v);
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (v && typeof v === "object") {
      if (v instanceof Uint8Array) return `<${v.byteLength} bytes>`;
      const o: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) o[k] = walk(x, k);
      return o;
    }
    return v;
  };
  return walk(value) as T;
}

export const log = {
  info(msg: string, data?: unknown): void {
    console.log(scrubString(msg) + (data === undefined ? "" : " " + JSON.stringify(redact(data), null, 2)));
  },
  warn(msg: string, data?: unknown): void {
    console.warn("WARN " + scrubString(msg) + (data === undefined ? "" : " " + JSON.stringify(redact(data))));
  },
  error(msg: string, data?: unknown): void {
    console.error("ERROR " + scrubString(msg) + (data === undefined ? "" : " " + JSON.stringify(redact(data))));
  },
};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Airwallex error body: { code, message, source?, details? } (see API reference "Errors" sections). */
export type AirwallexOperationStage = "AUTH" | "GET" | "REQUEST";
export type AirwallexErrorCategory = "HTTP_ERROR" | "TRANSPORT_ERROR" | "TIMEOUT" | "BODY_READ_ERROR" | "MALFORMED_JSON" | "AUTH_RESPONSE_INVALID" | "UNKNOWN";
export interface AirwallexDiagnosticMetadata {
  stage: AirwallexOperationStage;
  responseReceived: boolean | "unknown";
  httpStatus?: number;
  errorCategory: AirwallexErrorCategory;
  retryCount: number;
  timestampUtc: string;
}

function diagnostic(stage: AirwallexOperationStage, responseReceived: boolean | "unknown", errorCategory: AirwallexErrorCategory, httpStatus?: number, retryCount = 0): AirwallexDiagnosticMetadata {
  return { stage, responseReceived, ...(httpStatus === undefined ? {} : { httpStatus }), errorCategory, retryCount, timestampUtc: new Date().toISOString() };
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

export class AirwallexError extends Error {
  constructor(
    readonly status: number | undefined,
    readonly code: string,
    message: string,
    readonly method: string,
    readonly path: string,
    readonly source?: string,
    readonly details?: unknown,
    readonly requestId?: string,
    readonly diagnostic?: AirwallexDiagnosticMetadata,
  ) {
    super(`${method} ${path} -> ${status} ${code}: ${message}`);
    this.name = "AirwallexError";
  }
  toJSON() {
    return redact({
      name: this.name,
      status: this.status,
      code: this.code,
      message: this.message,
      source: this.source,
      details: this.details,
      method: this.method,
      path: this.path,
      request_id: this.requestId,
      diagnostic: this.diagnostic,
    });
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export type Host = "api" | "files";
export type Json = Record<string, unknown>;

export interface RequestOptions {
  body?: Json;
  query?: Record<string, string | number | undefined>;
  /** Add a UUID request_id to the body when absent (create/confirm/accept/challenge/refund calls). */
  idempotent?: boolean;
  host?: Host;
  /** Restrict to dispute GET routes and omit identifiers, query values, and response bodies from logs/traces. */
  sensitiveDisputeRead?: boolean;
  /** Allowlisted PaymentIntent GETs with response, identifier, and query redaction. */
  sensitivePaymentIntentRead?: boolean;
  /** The one-shot W1 create route; suppress all operation identifiers and provider payloads from diagnostics. */
  sensitivePaymentIntentCreate?: boolean;
  /** Receives safe, request-local metadata as soon as response status is available. */
  onDiagnostic?: (metadata: AirwallexDiagnosticMetadata) => void;
  /** Counts each actual fetch attempt immediately before dispatch. */
  onRequestAttempt?: () => void;
  /** Disable HTTP 401/429 replay for operations without a provider idempotency key. */
  retry?: boolean;
  /** For a caller that already performed its one permitted login; refuse instead of authenticating again. GET-only. */
  existingAuthenticationOnly?: boolean;
  /** Fields merged into the generic dry-run mock response. */
  mock?: Json;
}

export interface TraceEntry {
  at: string;
  method: string;
  url: string;
  request_id?: string;
  request?: unknown;
  status?: number;
  ms?: number;
  response?: unknown;
  error?: unknown;
  dry_run?: boolean;
  response_received?: boolean;
  diagnostic?: AirwallexDiagnosticMetadata;
}

export interface UploadFile {
  filename: string;
  bytes: Uint8Array;
  contentType: string;
}

const TOKEN_TTL_CAP_MS = 25 * 60 * 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class AirwallexClient {
  readonly trace: TraceEntry[] = [];
  private token?: { value: string; validUntil: number };
  private mockSeq = 0;

  constructor(readonly cfg: Config) {
    // Reject unsafe directly constructed Config values too, not only values from loadConfig().
    // The normalized origin is used below for every request.
    if (cfg.base !== assertSandboxHost(cfg.base, "AIRWALLEX_BASE") ||
        cfg.filesBase !== assertSandboxHost(cfg.filesBase, "AIRWALLEX_FILES_BASE")) {
      throw new Error("Airwallex client config must use exact normalized sandbox origins");
    }
    registerSecret(cfg.clientId);
    registerSecret(cfg.apiKey);
    registerSecret(cfg.webhookSecret);
    registerSecret(cfg.loginAsTarget);
    if (cfg.loginAsTarget && (cfg.loginAsTarget.trim() !== cfg.loginAsTarget || /[\r\n\x00]/.test(cfg.loginAsTarget))) {
      throw new Error("AIRWALLEX_LOGIN_AS must be a single-line target account ID");
    }
  }

  private urlFor(host: Host, path: string, query?: RequestOptions["query"]): string {
    const base = host === "files" ? this.cfg.filesBase : this.cfg.base;
    // A path supplied as an absolute/scheme-relative URL would override the configured
    // sandbox host. Validate before URL resolution to keep credentials off untrusted sites.
    if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\") || /[\x00-\x1f\x7f]/.test(path)) {
      throw new Error("Airwallex request path must be a clean absolute path on the configured sandbox origin");
    }
    const u = new URL(path, base);
    if (u.origin !== base || u.protocol !== "https:") {
      throw new Error("Airwallex request URL escaped the configured sandbox origin");
    }
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) u.searchParams.set(k, String(v));
    return u.toString();
  }

  /** True when a cached token exists and is still inside the 25-minute window. */
  hasValidToken(): boolean {
    return !!this.token && Date.now() < this.token.validUntil;
  }

  async login(force = false, sensitive = false): Promise<{ token: string; expires_at: string; cached: boolean }> {
    if (!force && this.token && Date.now() < this.token.validUntil) {
      return { token: this.token.value, expires_at: new Date(this.token.validUntil).toISOString(), cached: true };
    }
    const path = "/api/v1/authentication/login";
    const url = this.urlFor("api", path);
    const entry: TraceEntry = { at: new Date().toISOString(), method: "POST", url,
      request: { headers: ["x-client-id", "x-api-key", ...(this.cfg.loginAsTarget ? ["x-login-as"] : [])] } };
    this.trace.push(entry);
    log.info(`-> POST ${path}${this.cfg.dryRun ? " [dry-run]" : ""} (headers: x-client-id, x-api-key${this.cfg.loginAsTarget ? ", x-login-as configured" : ""}; no body)`);

    if (this.cfg.dryRun) {
      const expires = new Date(Date.now() + 30 * 60 * 1000).toISOString();
      const value = `dryrun-token-${randomUUID()}`;
      registerSecret(value);
      this.token = { value, validUntil: Date.now() + TOKEN_TTL_CAP_MS };
      entry.dry_run = true;
      entry.response = { token: "[REDACTED]", expires_at: expires };
      return { token: value, expires_at: expires, cached: false };
    }

    const t0 = Date.now();
    let res: Response;
    try {
      const authHeaders: Record<string, string> = { "x-client-id": this.cfg.clientId, "x-api-key": this.cfg.apiKey, "Content-Type": "application/json" };
      if (this.cfg.loginAsTarget) authHeaders["x-login-as"] = this.cfg.loginAsTarget;
      res = await fetch(url, {
        method: "POST",
        headers: authHeaders,
        redirect: "error", // never forward login credentials across an HTTP redirect
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      const meta = diagnostic("AUTH", false, isTimeout(error) ? "TIMEOUT" : "TRANSPORT_ERROR");
      entry.diagnostic = meta;
      entry.error = meta;
      const safeMessage = sensitive ? "Airwallex authentication request failed" : error instanceof Error ? error.message : "authentication request failed";
      throw new AirwallexError(undefined, meta.errorCategory.toLowerCase(), safeMessage, "POST", path, undefined, undefined, undefined, meta);
    }
    // Fetch has resolved: capture status before reading any response bytes.
    const receivedMeta = diagnostic("AUTH", true, "UNKNOWN", res.status);
    entry.status = res.status;
    entry.response_received = true;
    entry.diagnostic = receivedMeta;
    let body: unknown;
    try {
      body = await readBody(res, sensitive);
    } catch (error) {
      const category = error instanceof SafeResponseReadError ? error.category : "BODY_READ_ERROR";
      const meta = diagnostic("AUTH", true, category, res.status);
      entry.ms = Date.now() - t0;
      entry.diagnostic = meta;
      entry.error = meta;
      throw new AirwallexError(res.status, category.toLowerCase(), "Airwallex authentication response could not be read", "POST", path, undefined, undefined, undefined, meta);
    }
    entry.status = res.status;
    entry.ms = Date.now() - t0;
    if (!res.ok) {
      const meta = diagnostic("AUTH", true, "HTTP_ERROR", res.status);
      entry.diagnostic = meta;
      const err = sensitive
        ? new AirwallexError(res.status, `http_${res.status}`, "Airwallex authentication failed", "POST", path, undefined, undefined, undefined, meta)
        : toError(res.status, body, "POST", path, undefined, meta);
      entry.error = sensitive ? meta : err.toJSON();
      throw err;
    }
    const b = body && typeof body === "object" && !Array.isArray(body) ? body as { token?: unknown; expires_at?: unknown } : {};
    if (typeof b.token !== "string" || !b.token || (b.expires_at !== undefined && (typeof b.expires_at !== "string" || !Number.isFinite(Date.parse(b.expires_at.replace(/([+-]\d{2})(\d{2})$/, "$1:$2")))))) {
      const meta = diagnostic("AUTH", true, "AUTH_RESPONSE_INVALID", res.status);
      entry.diagnostic = meta;
      entry.error = meta;
      throw new AirwallexError(res.status, "auth_response_invalid", "Airwallex authentication response was invalid", "POST", path, undefined, undefined, undefined, meta);
    }
    registerSecret(b.token);
    const expiresAt = b.expires_at as string | undefined;
    const serverExpiry = expiresAt ? Date.parse(expiresAt.replace(/([+-]\d{2})(\d{2})$/, "$1:$2")) : NaN;
    const cap = Date.now() + TOKEN_TTL_CAP_MS;
    const validUntil = Number.isFinite(serverExpiry) ? Math.min(serverExpiry - 5 * 60 * 1000, cap) : cap;
    this.token = { value: b.token, validUntil };
    entry.response = sensitive ? "[REDACTED]" : redact(b);
    entry.diagnostic = diagnostic("AUTH", true, "UNKNOWN", res.status);
    return { token: b.token, expires_at: expiresAt ?? "", cached: false };
  }

  async request<T = Json>(method: "GET" | "POST", path: string, opts: RequestOptions = {}): Promise<T> {
    if (opts.sensitiveDisputeRead && (method !== "GET" || !/^\/api\/v1\/pa\/payment_disputes(?:\/[^/?#]+)?$/.test(path))) {
      throw new Error("Sensitive dispute reads are restricted to GET list/retrieve routes");
    }
    if (opts.sensitivePaymentIntentRead && (method !== "GET" || !/^\/api\/v1\/pa\/payment_intents(?:\/[A-Za-z0-9_-]{1,128})?$/.test(path))) {
      throw new Error("Sensitive PaymentIntent reads are restricted to GET list/retrieve routes");
    }
    if (opts.sensitivePaymentIntentCreate && (method !== "POST" || path !== "/api/v1/pa/payment_intents/create" || opts.retry !== false)) {
      throw new Error("Sensitive PaymentIntent create is restricted to the one-shot create route with retry disabled");
    }
    const sensitiveRead = opts.sensitiveDisputeRead || opts.sensitivePaymentIntentRead;
    if (opts.existingAuthenticationOnly && (method !== "GET" || !sensitiveRead))
      throw new Error("Existing authentication-only mode is restricted to sensitive GET reads");
    if (opts.existingAuthenticationOnly && !this.hasValidToken())
      throw new Error("EXISTING_AUTHENTICATION_REQUIRED");
    const sensitivePaymentIntentCreate = opts.sensitivePaymentIntentCreate === true;
    const sensitiveOperation = sensitiveRead || sensitivePaymentIntentCreate;
    const host = opts.host ?? "api";
    const body = opts.body ? { ...opts.body } : undefined;
    if (opts.idempotent && body && !body.request_id) body.request_id = randomUUID();
    const requestId = typeof body?.request_id === "string" ? body.request_id : undefined;
    const url = this.urlFor(host, path, opts.query);
    const shownPath = url.replace(host === "files" ? this.cfg.filesBase : this.cfg.base, "");
    const safePath = sensitiveOperation
      ? (path.endsWith("payment_disputes") ? path : path.endsWith("payment_intents") ? path : path.startsWith("/api/v1/pa/payment_disputes/") ? "/api/v1/pa/payment_disputes/[REDACTED]" : "/api/v1/pa/payment_intents/[REDACTED]")
      : shownPath;
    log.info(`-> ${method} ${host === "files" ? "[files] " : ""}${safePath}${this.cfg.dryRun ? " [dry-run]" : ""}`,
      sensitiveOperation ? undefined : body);

    if (this.cfg.dryRun) {
      const mock = this.mockFor(path, opts.mock);
      this.trace.push({ at: new Date().toISOString(), method, url: sensitiveOperation ? `${this.cfg.base}${safePath}` : url,
        request_id: sensitiveOperation ? undefined : requestId, request: sensitiveOperation ? undefined : redact(body), dry_run: true,
        response: sensitiveOperation ? "[REDACTED]" : mock });
      return mock as T;
    }

    if (!opts.existingAuthenticationOnly) await this.login(false, sensitiveRead);
    // Replay a mutation only when its provider request_id binds the retry to the same operation.
    const replaySafe = method === "GET" || requestId !== undefined;
    return this.send<T>(method, url, safePath, sensitiveOperation ? undefined : requestId, body,
      () => (body ? JSON.stringify(body) : undefined), "application/json", sensitiveOperation, opts.onDiagnostic,
      opts.retry !== false && replaySafe, opts.onRequestAttempt);
  }

  async upload<T = Json>(path: string, file: UploadFile, fields: Record<string, string> = {}, mock?: Json): Promise<T> {
    const url = this.urlFor("files", path);
    const shown = { file: { filename: file.filename, contentType: file.contentType, bytes: file.bytes.byteLength }, ...fields };
    log.info(`-> POST [files] ${path} multipart/form-data${this.cfg.dryRun ? " [dry-run]" : ""}`, shown);
    if (this.cfg.dryRun) {
      const m = this.mockFor(path, { file_id: `dryrun_file_${++this.mockSeq}`, filename: file.filename, size: file.bytes.byteLength, ...mock });
      this.trace.push({ at: new Date().toISOString(), method: "POST", url, request: shown, dry_run: true, response: m });
      return m as T;
    }
    await this.login();
    const makeForm = () => {
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(file.bytes)], { type: file.contentType }), file.filename);
      for (const [k, v] of Object.entries(fields)) form.append(k, v);
      return form;
    };
    return this.send<T>("POST", url, path, undefined, shown, makeForm, undefined, false, undefined, false);
  }

  private async send<T>(
    method: string,
    url: string,
    shownPath: string,
    requestId: string | undefined,
    shownBody: unknown,
    makeBody: () => BodyInit | undefined,
    contentType: string | undefined,
    sensitive = false,
    onDiagnostic?: (metadata: AirwallexDiagnosticMetadata) => void,
    retryHttp = true,
    onRequestAttempt?: () => void,
  ): Promise<T> {
    const entry: TraceEntry = { at: new Date().toISOString(), method,
      url: sensitive ? `${this.cfg.base}${shownPath}` : url, request_id: sensitive ? undefined : requestId,
      request: sensitive ? undefined : redact(shownBody) };
    this.trace.push(entry);
    let relogged = false;
    for (let attempt = 0; ; attempt++) {
      const headers: Record<string, string> = { Authorization: `Bearer ${this.token!.value}` };
      if (contentType) headers["Content-Type"] = contentType;
      const t0 = Date.now();
      let res: Response;
      try {
        onRequestAttempt?.();
        res = await fetch(url, { method, headers, body: makeBody(), redirect: "error", signal: AbortSignal.timeout(30_000) });
      } catch (error) {
        const meta = diagnostic(sensitive && method === "GET" ? "GET" : "REQUEST", false, isTimeout(error) ? "TIMEOUT" : "TRANSPORT_ERROR", undefined, attempt);
        entry.response_received = false;
        entry.diagnostic = meta;
        entry.error = sensitive ? meta : redact(error instanceof Error ? error.message : "request failed");
        const safeMessage = sensitive ? "Sensitive Airwallex request failed before a response" : error instanceof Error ? error.message : "request failed";
        log.error(safeMessage);
        throw new AirwallexError(undefined, meta.errorCategory.toLowerCase(), safeMessage, method, shownPath, undefined, undefined, requestId, meta);
      }
      // Capture the response as soon as fetch resolves, before body consumption.
      entry.status = res.status;
      entry.response_received = true;
      entry.ms = Date.now() - t0;
      let meta = diagnostic(sensitive && method === "GET" ? "GET" : "REQUEST", true, "UNKNOWN", res.status, attempt);
      entry.diagnostic = meta;
      onDiagnostic?.(meta);
      let responseBody: unknown;
      try {
        responseBody = await readBody(res, sensitive);
      } catch (error) {
        const category = error instanceof SafeResponseReadError ? error.category : "BODY_READ_ERROR";
        meta = diagnostic(sensitive && method === "GET" ? "GET" : "REQUEST", true, category, res.status, attempt);
        entry.diagnostic = meta;
        entry.error = sensitive ? meta : redact(error instanceof Error ? error.message : "response read failed");
        onDiagnostic?.(meta);
        throw new AirwallexError(res.status, category.toLowerCase(), "Airwallex response could not be read", method, shownPath, undefined, undefined, requestId, meta);
      }
      entry.ms = Date.now() - t0;
      // A live dispute verification is explicitly a single read attempt. Do not
      // hide a throttling response by issuing automatic follow-up requests.
      if (res.status === 429 && attempt < 3 && !sensitive && retryHttp) {
        const wait = 1000 * 2 ** attempt;
        log.warn(`429 on ${method} ${shownPath}; retrying in ${wait} ms with the same request_id`);
        await sleep(wait);
        continue;
      }
      // Sensitive dispute reads must return the first auth result to the caller
      // for review; do not refresh credentials and replay the GET automatically.
      if (res.status === 401 && !relogged && !sensitive && retryHttp) {
        relogged = true;
        log.warn(`401 on ${method} ${shownPath}; refreshing token once`);
        await this.login(true);
        continue;
      }
      if (!res.ok) {
        meta = diagnostic(sensitive && method === "GET" ? "GET" : "REQUEST", true, "HTTP_ERROR", res.status, attempt);
        entry.diagnostic = meta;
        onDiagnostic?.(meta);
        const err = sensitive
          ? new AirwallexError(res.status, `http_${res.status}`,
            "Sensitive Airwallex request failed", method, shownPath, undefined, undefined, undefined, meta)
          : toError(res.status, responseBody, method, shownPath, requestId, meta);
        entry.error = sensitive ? meta : err.toJSON();
        log.error(err.message);
        throw err;
      }
      entry.response = sensitive ? "[REDACTED]" : redact(responseBody);
      meta = diagnostic(sensitive && method === "GET" ? "GET" : "REQUEST", true, "UNKNOWN", res.status, attempt);
      entry.diagnostic = meta;
      onDiagnostic?.(meta);
      log.info(`<- ${res.status} ${method} ${shownPath} (${entry.ms} ms)`);
      return responseBody as T;
    }
  }

  private mockFor(path: string, extra?: Json): Json {
    const slug = path.replace(/^\/api\/v1\//, "").replace(/[^a-z0-9]+/gi, "_").replace(/_+$/, "");
    return { dry_run: true, id: `dryrun_${slug}_${++this.mockSeq}`, ...extra };
  }
}

class SafeResponseReadError extends Error {
  constructor(readonly category: "BODY_READ_ERROR" | "MALFORMED_JSON") { super(category); }
}

async function readBody(res: Response, strict = false): Promise<unknown> {
  let text: string;
  try { text = await res.text(); }
  catch { throw new SafeResponseReadError("BODY_READ_ERROR"); }
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    if (strict) throw new SafeResponseReadError("MALFORMED_JSON");
    return { raw: text.slice(0, 2000) };
  }
}

function toError(status: number, body: unknown, method: string, path: string, requestId?: string, meta?: AirwallexDiagnosticMetadata): AirwallexError {
  const b = (body ?? {}) as { code?: string; message?: string; source?: string; details?: unknown; raw?: string };
  return new AirwallexError(status, b.code ?? `http_${status}`, b.message ?? b.raw ?? "request failed", method, path, b.source, b.details, requestId, meta);
}

// ---------------------------------------------------------------------------
// Small helpers shared by the spikes
// ---------------------------------------------------------------------------

/** Timestamp in the format the API reference examples use: 2025-05-20T13:14:00+0000 (UTC). */
export function awxTime(offsetDays = 0, from = new Date()): string {
  const d = new Date(from.getTime() + offsetDays * 86_400_000);
  return d.toISOString().replace(/\.\d{3}Z$/, "+0000");
}
