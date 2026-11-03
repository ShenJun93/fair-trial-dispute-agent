# FT-AIRWALLEX-LIVE-SANDBOX-020 — Live Sandbox Checkout Evidence

**Status at 2026-10-30: W1 READBACK_VERIFIED; W2 SUCCEEDED.** The owner completed the one authorized hosted sandbox checkout. Fair Trial displayed `SUCCEEDED — confirmed by a fresh Airwallex API retrieval`; the corresponding persisted status is tied to the same PaymentIntent fingerprint as W1. One W2 launch claim was consumed. No W3/W4 action was authorized or performed.

## Gate evidence

| Gate | Result | Evidence |
|---|---|---|
| HTTPS / Caddy | **PASS in Edge; shell probe unavailable** | Edge opened `https://localhost:8443/__preflight/health` and displayed `FAIR_TRIAL_LOCAL_HTTPS_READY`; the browser showed no certificate warning. The homepage initially returned HTTP 502 while the backend was down. After the owner started HPP, the homepage loaded successfully. A separate PowerShell `curl.exe --noproxy "*"` probe could not connect (exit 7 / HTTP 000); shell listener inspection did not expose a PID. No second Caddy process was started. |
| HPP page / operator session | **PASS in Edge** | Owner started the existing launcher and privately entered the operator token. The local HPP page loads over HTTPS and the authorized session is visible. The SDK initialization uses `demo` and did not show its failure state. |
| W1 handoff adapter | **PASS** | Owner restarted HPP after W1 journal creation. Source startup logic loaded the existing journal and provider adapter. The same W1 intent was handed off; the W2 claim count is exactly one. |
| HPP persisted state | **PASS (read-only inspection)** | One active operator session, one HPP attempt, one W2 launch, same W1/HPP intent fingerprint, and persisted `SUCCEEDED` status with a server-verification timestamp. The return-state flag was not consumed; success is therefore attributed to provider read-back, not a browser redirect. |
| W1 journal | **ONE VERIFIED ATTEMPT** | Read-only journal inspection found exactly one W1 row and exactly one W2 launch claim for that same intent; no replacement or second W1 row exists. |
| Account binding | **FRESH GATE PASSED** | The owner completed the fresh challenge-bound local comparison in the one-shot runner. Only the sanitized `READBACK_VERIFIED` result was relayed. No identifiers or credentials were shared in chat. |
| W1 create/read-back | **READBACK_VERIFIED** | The durable record shows one USD 1.00 sandbox attempt, create HTTP 201, exact GET HTTP 200, status `REQUIRES_PAYMENT_METHOD`, and identity fields verified by the runner. Intent fingerprint: `5739cecdeb96b009`. The narrow adapter disables retries; the one-shot runner records one create and one retrieve. |
| W2 checkout | **SUCCEEDED** | The owner performed the one checkout. W1 and HPP journals show exactly one W2 launch claim for the same intent. At 2026-10-30 08:20:27.733 +07:00, HPP recorded a fresh provider retrieval as `SUCCEEDED`; Edge displayed the matching confirmation. Card values and provider identifiers are not included. |
| W3/W4 | **NOT AUTHORIZED / NOT RUN** | No dispute, refund, or disposition operation occurred. |

The official [Airwallex Quickstart](https://www.airwallex.com/docs/payments/get-started/quickstart) requires an HTTPS success URL. The [HPP reference](https://www.airwallex.com/docs/js/payments/hosted-payment-page) describes the success URL as HTTPS. Neither page reviewed establishes that `localhost` is generally accepted as a success host. This one sandbox checkout reached provider-verified `SUCCEEDED`, but HPP's persisted return-state flag remains unconsumed; do not claim the localhost success callback itself was verified.

## Verified local safety boundary

- `out/w1-journal.sqlite` contains exactly one read-back-verified attempt. Its intent ID, request ID, merchant order ID, and client secret were not printed. Its one W2 launch row matches the same intent, request and order internally.
- HPP SQLite state was queried read-only after completion. One persisted HPP attempt matches W1's intent fingerprint and records `SUCCEEDED` with a fresh verification timestamp. No raw identifiers were emitted.
- The production server initializes `w1Only: true`, opens a W1 journal only if it already exists, and refuses the legacy HPP PaymentIntent-create route. The W1 CLI is the only entrypoint for the authorized one-create/exact-readback operation.
- `npm run test:hpp`: **72/72 PASS** (fake/local regression suite; not live provider evidence).
- W1 and W2 evidence is present in the local durable journals. The owner manually completed the Airwallex-hosted sandbox card interaction; the assistant did not click the transaction button or handle card data. No dispute, refund, disposition, or security-setting change occurred.

## Completion evidence

- W1 created at `2026-10-30 08:02:22 +07:00`; one create returned HTTP 201 and the exact identity/status GET returned HTTP 200 with `REQUIRES_PAYMENT_METHOD`.
- W2 launch fence consumed once at `2026-10-30 08:14:38.636 +07:00` for the same intent. The W1 and HPP journals each reference the same redacted fingerprint, `5739cecdeb96b009`.
- HPP recorded final status verification at `2026-10-30 08:20:27.733 +07:00`; status `SUCCEEDED`. The API adapter validates the exact five identity fields (intent ID, request ID, merchant order ID, amount, currency) before it accepts the provider status.
- Edge displayed “SUCCEEDED — confirmed by a fresh Airwallex API retrieval.” A clean status screenshot was inspected; it contains no payment identifiers, card details, or secrets. The state indicates the return callback was not consumed, so the verified result comes from server-side status retrieval, not the browser redirect.
- For any later judge capture, screenshot only the Fair Trial HPP status page after final read-back; exclude the hosted checkout/card-entry screen. The screenshot inspected in this session was not saved as a submission artifact.
- Do not run W1, restart HPP, or attempt a second W2 launch. W3/W4 remain unauthorized.

## Current outcome

- **HTTPS:** PASS in Edge for the Caddy health route and HPP page; not confirmed from the shell probe.
- **HPP:** PASS in Edge; backend restarted after W1 and the same intent was handed off once.
- **W1:** READBACK_VERIFIED — one create (201), one exact read-back (200), no retry; status `REQUIRES_PAYMENT_METHOD`.
- **W2:** SUCCEEDED — provider status verified by a fresh server-side Airwallex retrieval.
- **Provider evidence:** redacted intent fingerprint `5739cecdeb96b009`; pre-checkout status `REQUIRES_PAYMENT_METHOD`; final status `SUCCEEDED` at `2026-10-30 08:20:27.733 +07:00`.
- **Next action:** preserve the sanitized evidence. W3 dispute simulation and W4 dispositions remain unauthorized and require separate authorization.
