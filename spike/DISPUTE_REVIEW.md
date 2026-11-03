# Kit 04 offline dispute review

This dashboard is an offline demonstration. It seeds four cases: three decision fixtures plus one synthetic evidence-lab case. Their evidence and the RFI → CHALLENGE → simulated issuer rejection → CHARGEBACK lifecycle are fixtures, not Airwallex records or outcomes. Approve and reject actions create local review decisions only. No provider dispute action or refund is called or confirmed.

For the timed judge walkthrough, use [`DEMO_SCRIPT.md`](DEMO_SCRIPT.md). It includes an isolated database setup and the saved, redacted live read receipt.

## Run locally

Requirements: Node.js 22.5 or later and npm dependencies already installed.

From PowerShell at the repository root:

```powershell
$tokenBytes = [byte[]]::new(32)
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($tokenBytes)
$rng.Dispose()
$env:DISPUTE_REVIEW_TOKEN = [Convert]::ToBase64String($tokenBytes)
npm run dispute:review
```

Open `http://127.0.0.1:4243` in a browser on the same machine. Paste the generated token into the local access form. The dashboard binds only to `127.0.0.1`; do not expose it with a tunnel or reverse proxy. Stop it with Ctrl+C, then clear the token from the current shell:

```powershell
$env:DISPUTE_REVIEW_TOKEN = $null
```

The default SQLite database is `out/dispute-review.sqlite` (with SQLite WAL sidecar files). It persists decisions, evidence references, fee settings and append-only history across restarts. To use a different database, set `DISPUTE_REVIEW_DB` before starting. Set `DISPUTE_FEE_MINOR` only when initializing a new database; on an existing database, a different startup value is rejected. The stored fee can be changed from the authenticated dashboard in integer cents. `DISPUTE_PROVIDER_MODE` defaults to `MOCK`; setting it to `LIVE` does not enable live integration and instead displays that live mode is disabled.

## Safety and test scope

Operator identity is derived from the current Windows account and SID (or Unix UID). The access token is provided through the process environment, not command-line arguments. Sessions are short-lived, stored as hashes, and paired with CSRF protection. Review authorizations are single-use, short-lived, actor/session/case/revision bound. A local approval does not cause provider execution. The provider action adapter has no configured live transport and exposes no dashboard action route.

Offline verification:

```powershell
npm run typecheck
npm run test:hpp
npm run test:disputes
git diff --check
```

These tests use temporary SQLite databases, deterministic fixtures, and network-call spies. They do not execute live payment or dispute operations.

## Live integration blockers

- Read-only provider access was verified once: the saved receipt records an authenticated US sandbox dispute-list `GET`, HTTP 200, schema `PASS`, and zero returned disputes. This proves list-read access for that request only; it does not provide a live dispute to review.
- No live RFI acceptance, challenge, or refund transport is implemented or enabled.
- The saved list receipt establishes read access for the one recorded list request. Write permissions for provider challenge, acceptance or refund actions, and account-specific action-stage behavior, have not been established.
- Evidence in the demo is synthetic fixture data; a live workflow needs authenticated, durable evidence references and provenance.
- The provider contract must be confirmed for whether an accepted RFI is separate from, or itself triggers, refund handling. This demo deliberately records neither provider acceptance nor refund completion.
- The future live gate needs an authenticated fresh status read, evidence validation, separately authorized execution, and durable approval/idempotency reservation. No dashboard path can invoke it today.

## Read-only Airwallex adapter (Phase 2.1)

The isolated adapter is in `spike/dispute-read-adapter.ts`. `MOCK` remains the default and reports `OFFLINE_FIXTURE`. `LIVE_READONLY` requires explicit configuration plus a fresh authorization record containing actor, approval reference and an expiry no more than 15 minutes after authorization. Its transport permits only the list/retrieve GET endpoints and refuses a dry-run `AirwallexClient`; it does not expose an action method. It reuses the existing client’s sandbox-only host validation, in-memory authentication token cache and login flow. Sensitive-read logging omits query values, dispute identifiers and raw provider response/error bodies. The adapter returns only normalized fields and evidence counts, not customer details or file identifiers. The saved verification receipt is `out/dispute-read-receipt-2026-10-27T13-38-38-035Z.json`; it is labeled `LIVE_VERIFIED` for that authenticated read only. These routes and their response fields are documented in Airwallex’s [Payment Disputes API reference](https://www.airwallex.com/docs/api/payments/payment_disputes/list).

The list API uses `page` as its cursor and returns `page_after`; pagination is bounded (default 10 pages, hard maximum 100). Amounts are normalized to integer minor units based on the ISO currency exponent. Unknown or inconsistent stage/status and absent/unreadable evidence are non-actionable. The vendor docs describe `page` and `page_after` cursor semantics and list the required dispute API access; the [dispute integration guide](https://www.airwallex.com/docs/payments/manage-payments/disputes/handle-disputes-using-our-apis) says to confirm API access with the account manager/support if blocked.

**No read-only adapter is activated by the dashboard or a CLI command.** Offline usage and regression tests:

```powershell
npm run typecheck
npm run test:disputes
```

No sandbox request is required or performed by these commands. The `LIVE_READONLY` constructor is a code-level gate only; do not set it up for a live request without separate owner authorization.

Required sandbox permission: a scoped API key with **Payment Disputes → Read** access for the target account. Airwallex's [API key scopes](https://www.airwallex.com/docs/developer-tools/api/api-key-scopes) lists that read scope for both “Retrieve a PaymentDispute” and “Get list of PaymentDisputes.” The dispute integration guide also directs merchants to confirm that the key is configured for dispute endpoints; ask the account owner or Airwallex support if access is missing. Do not grant Payment Disputes Write for this adapter. If this merchant operates as a platform against connected accounts, account selection / `x-login-as` requirements are not implemented here and must be separately verified.

## Next minimal live test proposal

Only after separate owner approval and the required read-only dispute API permission is established, retrieve the status of one already-existing sandbox dispute and compare the authenticated response with the expected merchant order and stage. Do not submit an RFI response, challenge, acceptance, refund, or other mutation as part of that first test. If no existing sandbox dispute is available, stop and obtain separate approval for whatever sandbox setup action is needed.
