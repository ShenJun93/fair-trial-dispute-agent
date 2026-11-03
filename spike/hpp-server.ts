import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, AirwallexClient } from "../src/airwallex.ts";
import { HppGate, HppGateError, HppService, HPP_AMOUNT, HPP_CURRENCY, loadHppGate, type HppAttempt } from "./hpp.ts";
import { createAirwallexW1Provider, resolveW2Handoff, W1Journal, type W1Provider } from "../scripts/w1-safe-path.ts";

const COOKIE = "__Host-fairtrial_session";
const BODY_LIMIT = 2048;
const STATUS_TEXT: Record<string, string> = {
  REQUIRES_PAYMENT_METHOD: "Payment method is still required. No new attempt was started.",
  REQUIRES_CUSTOMER_ACTION: "Additional customer authentication is required. Continue only in the existing Airwallex checkout.",
  PENDING: "Payment is pending. Recheck status; do not start another checkout.",
  PENDING_REVIEW: "Payment is under review. Recheck status; do not start another checkout.",
  REQUIRES_CAPTURE: "Payment requires capture. No success is claimed; operator review is required.",
  SUCCEEDED: "SUCCEEDED — confirmed by a fresh Airwallex API retrieval.",
  CANCELLED: "PaymentIntent is cancelled. A replacement is allowed only after this status is freshly confirmed.",
  UNKNOWN: "Payment status is unknown or could not be verified. No success is claimed.",
};

export class HppRateLimiter {
  private readonly buckets = new Map<string, number[]>();
  constructor(private readonly now: () => number = Date.now) {}
  allow(key: string, maximum: number, windowMs: number): boolean {
    const threshold = this.now() - windowMs;
    const recent = (this.buckets.get(key) ?? []).filter((time) => time > threshold);
    if (recent.length >= maximum) { this.buckets.set(key, recent); return false; }
    recent.push(this.now()); this.buckets.set(key, recent);
    if (this.buckets.size > 5000) for (const [bucket, times] of this.buckets) if (!times.some((time) => time > threshold)) this.buckets.delete(bucket);
    return true;
  }
}

function cookieValue(req: IncomingMessage): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === COOKIE) return value.join("=");
  }
  return undefined;
}

function sendJson(res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", ...headers });
  res.end(JSON.stringify(value));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const contentType = (req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
  if (contentType !== "application/json") throw new HppGateError("invalid_content_type");
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > BODY_LIMIT) throw new HppGateError("body_too_large");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw new HppGateError("body_too_large");
    chunks.push(Buffer.from(chunk));
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new HppGateError("invalid_body");
  return parsed as Record<string, unknown>;
}

function stateHashForAttempt(attempt: HppAttempt): { amount: number; currency: string; merchantOrderId: string; requestId: string } {
  return { amount: HPP_AMOUNT, currency: HPP_CURRENCY, merchantOrderId: attempt.merchantOrderId, requestId: attempt.requestId };
}

function responseForStatus(result: Awaited<ReturnType<HppService["status"]>>) {
  return { status: result.status, succeeded: result.succeeded, message: STATUS_TEXT[result.status] ?? STATUS_TEXT.UNKNOWN };
}

export interface HppHttpDeps {
  gate: HppGate;
  service: HppService;
  publicOrigin: string;
  now?: () => number;
  limiter?: HppRateLimiter;
  /** When present, W1 handoff reuses this exact journaled intent; it never creates one. */
  w1Journal?: W1Journal;
  w1Provider?: W1Provider;
  /** Production server never falls back to its legacy create route, even if W1 journal is absent. */
  w1Only?: boolean;
}

export function createHppHandler(deps: HppHttpDeps, bootstrapCsrf = randomBytes(32).toString("base64url")) {
  const { gate, service, publicOrigin } = deps;
  const now = deps.now ?? Date.now;
  const limiter = deps.limiter ?? new HppRateLimiter(now);
  const parsed = new URL(publicOrigin);
  if (parsed.protocol !== "https:" || parsed.origin !== publicOrigin) throw new Error("HPP_PUBLIC_ORIGIN must be an exact HTTPS origin");
  const cspNonce = randomBytes(18).toString("base64");
  const contentSecurityPolicy = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${cspNonce}' https://static.airwallex.com https://checkout.airwallex.com https://static-demo.airwallex.com https://checkout-demo.airwallex.com`,
    `style-src 'self' 'nonce-${cspNonce}'`,
    "connect-src 'self'",
    "frame-src https://checkout.airwallex.com https://checkout-demo.airwallex.com",
    "form-action 'self'",
    "base-uri 'none'", "object-src 'none'", "frame-ancestors 'none'",
  ].join("; ");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fair Trial HPP preflight</title><script src="https://static.airwallex.com/components/sdk/v1/index.js"></script><style nonce="${cspNonce}">body{font:16px system-ui;max-width:36rem;margin:8vh auto;padding:1rem;color:#17202a}button,input{padding:.7rem;font:inherit}#status{margin-top:1rem}</style></head><body><h1>Fair Trial sandbox checkout</h1><p>USD $${HPP_AMOUNT.toFixed(2)}. This page only hands off an existing verified W1 PaymentIntent.</p><section id="login"><label>Operator access token <input id="operator" type="password" autocomplete="current-password"></label><button id="authorize">Authorize</button></section><section id="checkout" hidden><button id="pay" disabled>Continue verified W1 checkout</button><button id="recheck">Recheck existing payment</button></section><p id="status" role="status" aria-live="polite"></p><script nonce="${cspNonce}">
const csrfBootstrap=${JSON.stringify(bootstrapCsrf)}, statusEl=document.getElementById('status'), payButton=document.getElementById('pay');let csrfToken=csrfBootstrap;
let sdkInitPromise=null,paymentsApi=null,sdkFailed=false,checkoutPromise=null;
function say(text){statusEl.textContent=text}function showAuthorized(){document.getElementById('login').hidden=true;document.getElementById('checkout').hidden=false}
async function api(url,method='GET',body){const headers={};if(method!=='GET'){headers['Content-Type']='application/json';headers['Origin']=location.origin;headers['X-CSRF-Token']=csrfToken}const r=await fetch(url,{method,headers,body:body===undefined?undefined:JSON.stringify(body),cache:'no-store',credentials:'same-origin'});const data=await r.json();if(!r.ok)throw new Error(data.error||'request_failed');return data}
function initializeSdkOnce(){if(sdkInitPromise)return sdkInitPromise;payButton.disabled=true;sdkInitPromise=(async()=>{const sdk=window.AirwallexComponentsSDK;if(!sdk||typeof sdk.init!=='function')throw new Error('sdk_unavailable');let timer;try{const result=await Promise.race([Promise.resolve().then(()=>sdk.init({env:'demo',enabledElements:['payments']})),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('sdk_init_timeout')),8000)})]);if(!result||!result.payments||typeof result.payments.redirectToCheckout!=='function')throw new Error('sdk_redirect_unavailable');paymentsApi=result.payments;return paymentsApi}finally{if(timer!==undefined)clearTimeout(timer)}})();return sdkInitPromise}
initializeSdkOnce().then(()=>{payButton.disabled=false}).catch(()=>{sdkFailed=true;payButton.disabled=true;say('Airwallex checkout could not initialize. No PaymentIntent request was sent.')});
async function refreshSession(){try{const s=await api('/api/session');csrfToken=s.csrfToken;showAuthorized()}catch{document.getElementById('login').hidden=false;return}const callback=new URL(location.href);const state=new URLSearchParams(callback.hash.slice(1)).get('state');if(state){history.replaceState(null,'',callback.pathname+callback.search);try{const result=await api('/api/checkout/return','POST',{state});say(result.message)}catch{say('Return could not be verified. Recheck the existing payment; no new checkout was started.');await recheck()}}else await recheck()}
async function recheck(){try{const s=await api('/api/checkout');if(sdkFailed&&s.status==='NOT_CREATED')say('Airwallex checkout initialization failed. No PaymentIntent request was sent from this page.');else say(s.message)}catch(e){if(e.message==='checkout_not_found')say(${JSON.stringify(deps.w1Only || deps.w1Journal ? "Authorized, but no verified W1 PaymentIntent is available. HPP will not create one; complete the separately authorized W1 step first." : "Authorized. Start the single USD 1.00 checkout when ready.")});else say('Status could not be verified. No new checkout was started.')}}
document.getElementById('authorize').onclick=async()=>{const b=document.getElementById('authorize');b.disabled=true;try{await api('/api/session','POST',{operatorToken:document.getElementById('operator').value});document.getElementById('operator').value='';await refreshSession()}catch{say('Authorization failed.');b.disabled=false}};
payButton.onclick=async()=>{if(payButton.disabled||!paymentsApi||typeof paymentsApi.redirectToCheckout!=='function'||sdkFailed)return;if(checkoutPromise)return checkoutPromise;payButton.disabled=true;say('Opening the previously verified PaymentIntent…');checkoutPromise=(async()=>{const intent=await api('/api/checkout/w1-handoff','POST',{});return paymentsApi.redirectToCheckout({env:'demo',mode:'payment',intent_id:intent.id,client_secret:intent.client_secret,currency:intent.currency,successUrl:intent.successUrl})})();try{return await checkoutPromise}catch(e){say(e.message==='launch_permission_consumed'?'This checkout launch was already used. Recheck status.':'The existing PaymentIntent could not be securely handed off. No new payment attempt was started.');await recheck()}};
document.getElementById('recheck').onclick=()=>recheck();
refreshSession();</script></body></html>`;

  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || "/", publicOrigin);
    const jsonError = (status: number, code: string) => sendJson(res, status, { error: code });
    const checkOrigin = (): boolean => req.headers.origin === publicOrigin;
      const checkMutation = async (sessionHash?: string): Promise<Record<string, unknown> | undefined> => {
      if (!checkOrigin()) throw new HppGateError("invalid_origin");
      const body = await readJson(req);
      const csrf = req.headers["x-csrf-token"];
        const csrfHeader = Array.isArray(csrf) ? csrf[0] : csrf;
      if (!sessionHash) {
          if (csrfHeader !== bootstrapCsrf) throw new HppGateError("invalid_csrf");
        } else if (!gate.csrfValid(sessionHash, csrfHeader)) throw new HppGateError("invalid_csrf");
      return body;
    };
    const sessionHash = (): string => gate.authenticate(cookieValue(req));
    try {
      if (req.headers.host !== parsed.host) return jsonError(400, "invalid_host");
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": contentSecurityPolicy, "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" });
        res.end(html); return;
      }
      if (req.method === "POST" && url.pathname === "/api/session") {
        if (!limiter.allow("global:session", 8, 15 * 60_000)) return jsonError(429, "rate_limited");
        const body = await checkMutation();
        if (typeof body?.operatorToken !== "string") return jsonError(400, "invalid_request");
        const created = await gate.createSession(body.operatorToken);
        return sendJson(res, 200, { authorized: true }, { "set-cookie": `${COOKIE}=${created.sessionToken}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=3600` });
      }
      if (req.method === "GET" && url.pathname === "/api/session") {
        const current = sessionHash();
        return sendJson(res, 200, { csrfToken: await gate.rotateCsrf(current) });
      }
      if (req.method === "POST" && url.pathname === "/api/checkout") {
        if (deps.w1Only || deps.w1Journal) return jsonError(409, "w1_handoff_required");
        const current = sessionHash();
        if (!await checkMutation(current)) return jsonError(400, "invalid_request");
        if (!limiter.allow("global:checkout", 5, 60_000) || !limiter.allow(`session:checkout:${current}`, 3, 60_000)) return jsonError(429, "rate_limited");
        const { checkout, attempt } = await gate.reserveCheckout(current);
        if (attempt.paymentIntentId || attempt.dispatchPhase !== "NOT_DISPATCHED") return jsonError(409, "existing_attempt_requires_manual_recovery");
        await gate.markDispatched(current, attempt.requestId);
        const intent = await service.create(attempt.requestId, attempt.merchantOrderId);
        await gate.attachIntent(current, intent.id);
        const fresh = await service.status(intent.id, stateHashForAttempt(attempt));
        await gate.recordStatus(current, fresh.status);
        if (!fresh.stateKnown || fresh.status !== "REQUIRES_PAYMENT_METHOD") return jsonError(409, "checkout_not_ready");
        const launch = await gate.claimLaunch(current);
        if (!launch.claimed || !launch.state) return jsonError(409, "checkout_already_launched");
        const successUrl = `${publicOrigin}/#state=${encodeURIComponent(launch.state)}`;
        return sendJson(res, 200, { id: intent.id, client_secret: intent.client_secret, currency: intent.currency, successUrl });
      }
      if (req.method === "GET" && url.pathname === "/api/checkout") {
        const current = sessionHash();
        if (!limiter.allow("global:status", 180, 60_000) || !limiter.allow(`session:status:${current}`, 30, 60_000)) return jsonError(429, "rate_limited");
        const { attempt } = gate.checkoutForSession(current);
        if (!attempt.paymentIntentId) return sendJson(res, 200, { status: "NOT_CREATED", succeeded: false, message: "Authorized. Start the single USD 1.00 checkout when ready." });
        const status = await service.status(attempt.paymentIntentId, stateHashForAttempt(attempt));
        await gate.recordStatus(current, status.status);
        return sendJson(res, 200, responseForStatus(status));
      }
      if (req.method === "POST" && url.pathname === "/api/checkout/w1-handoff") {
        const current = sessionHash();
        if (!await checkMutation(current)) return jsonError(400, "invalid_request");
        if (!deps.w1Journal || !deps.w1Provider) return jsonError(409, "w1_handoff_not_configured");
        if (!limiter.allow("global:w1-handoff", 5, 60_000) || !limiter.allow(`session:w1-handoff:${current}`, 3, 60_000)) return jsonError(429, "rate_limited");
        const attempt = deps.w1Journal.readHandoffAttempt();
        if (!attempt) return jsonError(409, "w1_attempt_not_verified");
        const bound = await gate.bindExistingW1(current, attempt);
        if (bound.attempt.paymentIntentId !== attempt.id || bound.attempt.requestId !== attempt.request_id ||
            bound.attempt.merchantOrderId !== attempt.merchant_order_id || bound.attempt.dispatchPhase !== "RESPONSE_RECORDED") return jsonError(409, "w1_session_binding_mismatch");
        // Consume both durable launch fences before the fresh GET. Any error is non-replayable.
        if (!deps.w1Journal.claimW2Launch(attempt)) return jsonError(409, "launch_permission_consumed");
        const launch = await gate.claimLaunch(current);
        if (!launch.claimed || !launch.state) return jsonError(409, "launch_permission_consumed");
        const result = await resolveW2Handoff({ request: { origin: req.headers.origin, sessionBound: true, csrfValid: true },
          expectedOrigin: publicOrigin, attempt, retrieve: (id) => deps.w1Provider!.retrieve(id, { retry: false }),
          now: deps.now ? () => new Date(deps.now!()) : undefined });
        if (result.status !== 200 || !result.body.intent_id || !result.body.client_secret) return jsonError(result.status, result.body.error ?? "handoff_failed");
        const successUrl = `${publicOrigin}/#state=${encodeURIComponent(launch.state)}`;
        return sendJson(res, 200, { id: result.body.intent_id, client_secret: result.body.client_secret, currency: HPP_CURRENCY, successUrl });
      }
      if (req.method === "POST" && url.pathname === "/api/checkout/return") {
        const current = sessionHash();
        const body = await checkMutation(current);
        if (typeof body?.state !== "string") return jsonError(400, "invalid_return_state");
        const { attempt } = await gate.consumeReturn(current, body.state);
        if (!attempt.paymentIntentId) return jsonError(404, "checkout_not_found");
        const status = await service.status(attempt.paymentIntentId, stateHashForAttempt(attempt));
        await gate.recordStatus(current, status.status);
        return sendJson(res, 200, responseForStatus(status));
      }
      return jsonError(404, "not_found");
    } catch (error) {
      const code = error instanceof HppGateError ? error.code : "request_failed";
      const status = code === "unauthorized" ? 401 : code === "active_order_owned_by_other_session" ? 409 : code === "checkout_not_found" ? 404 : code === "invalid_origin" || code === "invalid_csrf" || code === "invalid_content_type" ? 403 : code === "body_too_large" ? 413 : code === "replacement_requires_confirmed_cancel" ? 409 : 400;
      return jsonError(status, code);
    }
  };
}

export function createHppServer(deps: HppHttpDeps): Server {
  return createServer(createHppHandler(deps));
}

async function main(): Promise<void> {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  if (resolve(process.cwd()) !== repositoryRoot) throw new Error("HPP_REPOSITORY_ROOT_REQUIRED");
  const config = loadConfig();
  if (config.dryRun) throw new Error("The checkout server cannot run in dry-run mode.");
  const operatorToken = process.env.HPP_OPERATOR_TOKEN ?? "";
  if (operatorToken.length < 32) throw new Error("Set HPP_OPERATOR_TOKEN to a private random value of at least 32 characters.");
  const publicOrigin = process.env.HPP_PUBLIC_ORIGIN || "";
  const gate = await loadHppGate(resolve(repositoryRoot, "out", "hpp-gate-state.sqlite"), operatorToken, resolve(repositoryRoot, "out", "hpp-gate-state.json"));
  const client = new AirwallexClient(config);
  const w1JournalPath = resolve(repositoryRoot, "out", "w1-journal.sqlite");
  // Server startup must not create the one-shot W1 journal. The authorized W1 CLI owns first creation.
  const w1Journal = existsSync(w1JournalPath) ? await W1Journal.open(w1JournalPath) : undefined;
  const server = createHppServer({ gate, service: HppService.fromClient(client), publicOrigin, w1Journal,
    ...(w1Journal ? { w1Provider: createAirwallexW1Provider(client) } : {}), w1Only: true });
  const port = Number(process.env.HPP_PORT || 4242);
  if (port !== 4242) throw new Error("HPP_PORT is fixed at 4242 so only one server process can own persisted checkout state.");
  server.listen(port, "127.0.0.1", () => console.log(`HPP server listening on loopback port ${port}`));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void main();
