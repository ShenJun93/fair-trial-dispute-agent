# Hosted Payment Page Phase 1.1 — security preflight

## FT-W1-EXECUTION-READY-014 integration status

**FT-HPP-LAST-MILE-015 update (2026-10-29):** the 2026-10-27 CDN fingerprint/init observation below is historical, not a current SDK check. An isolated Edge attempt could not reach the local preflight origin, and browser policy blocked the alternate diagnostic page; no current script hash/init was recorded and `redirectToCheckout()` was not called. The W1 journal is absent. See [the last-mile preflight](../submission/FT_HPP_LAST_MILE_015.md) for the current W1 GO-conditional / W2 HOLD assessment.

The current live HPP server is wired to `out/w1-journal.sqlite`. Its browser action calls `/api/checkout/w1-handoff`, which requires a durable `READBACK_VERIFIED` W1 row, binds that exact five-field intent to the authenticated checkout session, consumes both durable one-use launch fences, performs a fresh server-side GET, and returns the secret only in a `no-store` response. The production server now rejects the legacy `/api/checkout` create route with `w1_handoff_required`; it cannot create a second PaymentIntent from the browser. `scripts/w1-execute.ts` is a separate narrow entrypoint containing W1 create + read-back only. Neither live path was run in FT-W1-EXECUTION-READY-014.

The environment discrepancy is not fully resolved for the exact floating CDN build. The current official [Payment quickstart](https://www.airwallex.com/docs/payments/get-started/quickstart) uses `env: 'demo'` in both SDK initialization and `redirectToCheckout()`, documents `intent_id`, `client_secret`, and `currency` as required, and says `successUrl` must be HTTPS. The separate [Airwallex.js HPP API reference](https://www.airwallex.com/docs/js/payments/hosted-payment-page) still shows `env: 'sandbox'` in its example. This repository does not install `@airwallex/components-sdk`; the page loads floating `https://static.airwallex.com/components/sdk/v1/index.js`. A prior local browser observation fingerprinted that served script and verified `env: 'demo'` initialization plus availability of `payments.redirectToCheckout`, but did not invoke the redirect. As the floating build cannot be matched to a fixed SDK release and the redirect was not exercised, keep HPP authorization/execution on HOLD pending Airwallex confirmation and a separately approved non-payment compatibility rehearsal.

This is a local-only Airwallex sandbox checkout. Amount is fixed server-side at USD 1.00 (`1` major unit). The operator gate issues a server-generated short-lived session cookie; checkout/order/request IDs and return-state hashes are server-generated and persisted in ignored `out/hpp-gate-state.sqlite`. SQLite uses WAL, foreign keys, a 5-second busy timeout and FULL synchronous commits. Every PaymentIntent create is durably marked `DISPATCHED` before the HTTP request can leave the process. A timeout remains ambiguous and cannot be retried through the public checkout flow. The HPP return carries only a one-use random `state` in the URL fragment. The page removes it from browser history and submits it in a CSRF-protected same-origin request; the server binds it to the session/order and retrieves the PaymentIntent before status is shown. Only that API retrieval can establish `SUCCEEDED`.

The current HPP quickstart uses `env: 'demo'` for both initialization and `redirectToCheckout()`; the HPP API reference still types the redirect call's `env` as `'sandbox' | 'prod'` and includes a sandbox example. The checkout now follows the flow-specific quickstart and uses `demo` in both calls. The official script URL remains `https://static.airwallex.com/components/sdk/v1/index.js`, a floating major-version path. On 2026-10-27 the official npm listing showed `@airwallex/components-sdk` 1.36.0, but the registry request from this machine timed out, so that package tarball and its runtime dependencies remain unverified. CDN script loading, payments initialization and the observed CSP behavior were separately verified in disposable MAIN-PC Chrome as recorded below. No package or lockfile dependency was added without compatibility evidence.

## Local run instructions — HOLD until GO

**Current decision: NO-GO for opening a public HTTPS tunnel.** Local Chrome verified Airwallex.js loading and payments-element initialization under the enforced least-privilege CSP. Sponsor permission for HPP remains unresolved, the CDN remains floating, and a future tunnel test still requires explicit owner authorization.

When authorized, prerequisites are Node.js 22.5+, installed dependencies, existing sandbox API credentials in `<REPOSITORY_ROOT>/.env.local`, and `cloudflared` on PATH. Do not print, commit, or paste the Airwallex credentials. `HPP_OPERATOR_TOKEN` must be a new private random value of at least 32 characters; it is separate from Airwallex credentials.

1. In PowerShell window 1, start the loopback tunnel:

   ```powershell
   Set-Location '<REPOSITORY_ROOT>'
   cloudflared tunnel --url http://127.0.0.1:4242
   ```

   Copy only the generated HTTPS origin.

2. In PowerShell window 2, enter a private operator token without printing it, set the tunnel origin, and start the server:

   ```powershell
   Set-Location '<REPOSITORY_ROOT>'
   $tokenBytes = [byte[]]::new(32)
   [Security.Cryptography.RandomNumberGenerator]::Fill($tokenBytes)
   $env:HPP_OPERATOR_TOKEN = [Convert]::ToBase64String($tokenBytes)
   Set-Clipboard -Value $env:HPP_OPERATOR_TOKEN
   $env:HPP_PUBLIC_ORIGIN = 'https://YOUR-UNIQUE-NAME.trycloudflare.com'
   npx tsx spike/hpp-server.ts
   ```

   Paste the clipboard token only into the operator password field on the HTTPS page. The server also loads Airwallex credentials from `.env.local` and rejects non-sandbox API hosts.

3. Stop before completing a hosted payment unless separate owner approval is granted. The server is loopback-only; the HTTPS tunnel is the only public route. Stop both processes with Ctrl+C and clear the clipboard afterward.

The session cookie is `HttpOnly`, `Secure`, `SameSite=Lax`, path `/`, and expires after 60 minutes. SQLite persists the order, attempt, dispatch phase, status receipt, session expiry and return-state revocation. The database contains hashes and identifiers, never the operator token, cookie token, CSRF token, bearer token, or client secret. The HPP client secret is returned only to the authorized browser and is redacted from client logs.

### Local manual recovery (never exposed through the checkout server)

Recovery commands run only on the repository host and require a separate recovery-admin credential protected by the current Windows user’s DPAPI profile. One-time setup requires an elevated PowerShell process under that same Windows account; the Windows Administrators group is checked:

```powershell
Set-Location '<REPOSITORY_ROOT>'
node --import tsx spike/recovery.ts setup-credential
```

Stop the HPP server before recovery. Each `inspect` and `release` invocation prompts again for recovery-admin authentication. `inspect` is read-only and prints a redacted preview using fresh GETs for known intents; it never writes an approval or creates/cancels an intent. For an eligible release, run:

```powershell
node --import tsx spike/recovery.ts inspect
node --import tsx spike/recovery.ts release
```

Enter the order fingerprint shown by `inspect`. `release` performs fresh GETs for every known intent, persists the receipts, prints an updated redacted preview, creates a five-minute one-use approval bound to the current reservation revision and actor, then requires typing the state-derived audit reason and exact `RELEASE <order fingerprint>` confirmation. The release transaction consumes the approval and appends the audit entry atomically. Release is allowed only when every known attempt is freshly verified `CANCELLED` (or the sole attempt is durably `NOT_DISPATCHED`) and the owning session is expired. All other cases stay locked. Recovery never transfers old session authorization or return state, and never creates, cancels or confirms a PaymentIntent. Restart the HPP server after recovery so it reloads the committed database revision. The legacy `out/hpp-gate-state.json` is preserved as `out/hpp-gate-state.json.immutable-backup`; missing intent IDs migrate as `LEGACY_AMBIGUOUS`, never as `NOT_DISPATCHED`.

## Offline verification

From the repository root:

```powershell
npm run typecheck
npm run test:hpp
npm run spike:dry
git diff --check
```

All are offline. The HPP tests call the request handler with synthetic request/response objects and stub API responses; no listener, tunnel, or Airwallex request is made.

## Airwallex.js build and CSP compatibility

On 2026-10-27, disposable MAIN-PC Chrome 155.0.8059.85 loaded `https://static.airwallex.com/components/sdk/v1/index.js` with HTTP 200 and initialized `{ env: 'demo', enabledElements: ['payments'] }`. Initialization resolved and `payments.redirectToCheckout` was present; it was not called. No credentials, PaymentIntent creation, payment operation, HPP backend, or tunnel were used. The CDN script fingerprint captured from Chrome's response body was SHA-256 `e762d2fd7565642564850f25a56b1bd5e26146da7351652183b42ce364e5500e`. This fingerprints the observed floating CDN build; it does not pin it.

The initial enforced policy included the three script origins observed in Report-Only: `https://checkout.airwallex.com`, `https://static-demo.airwallex.com`, and `https://checkout-demo.airwallex.com`. With `https://o11y-demo.airwallex.com` allowed in `connect-src`, initialization passed with no CSP violations. A second enforced run without the o11y origin still initialized successfully and exposed `redirectToCheckout`; Chrome reported the o11y connection blocked by `connect-src`. This establishes that the connection is not required for initialization. Its precise purpose was not independently established, so it is not allowlisted. Final `connect-src` remains `'self'`. The enforced diagnostic reported one expected optional o11y violation; no other CSP violations or Airwallex resource failures were observed.

## Future USD 1.00 sandbox test — requires separate owner approval

After the tunnel gate is cleared, confirm the existing US sandbox account and scoped key are authorized for Airwallex HPP. Then perform exactly one USD 1.00 hosted checkout with an owner-approved sandbox test method and retrieve that same PaymentIntent server-side. Retain a redacted response showing `status: SUCCEEDED`. Do not call Native Card API or create disputes/refunds as part of this test. This proposal does not authorize its execution.

## Remaining limitations

- The official CDN is floating at `/v1/`; no official build-pinned URL was found in the HPP installation guidance. Pin an audited npm release/build or explicitly accept and monitor this risk before tunnel testing.
- A checkout reservation is global and one active order at a time. If its 60-minute operator session expires, a new session cannot claim it; the local recovery CLI can release it only when its durable dispatch and latest status evidence meet the manual recovery policy.
- Public replacement is disabled. `REQUIRES_PAYMENT_METHOD` after an expired client secret does not permit replacement automatically. A reservation may be manually released only after the recovery rules pass; starting any later checkout requires a fresh operator session and a separate operator action. Ambiguous attempts, including legacy records without intent IDs, remain locked for reconciliation.
- `FAILED`/`EXPIRED` values outside the explicitly recognized PaymentIntent status set are presented as `UNKNOWN`, never success or release eligibility. 3DS is delegated to Airwallex HPP; `REQUIRES_CUSTOMER_ACTION` directs the operator to continue only the existing checkout.
- Existing project notes say support confirmation for hosted checkout in this hackathon is pending. Resolve that sponsor permission before any live HPP flow.
