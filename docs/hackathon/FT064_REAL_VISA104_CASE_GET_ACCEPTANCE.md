# FT-064 — Verified Visa 10.4 Sandbox case-specific readback

**Observation:** 2026-11-02T23:50:31.968Z (2026-11-03 06:50:31, Asia/Ho_Chi_Minh).

**Authorization:** user approved continuing with **one read-only Visa 10.4 case-specific lookup**. This authorization is consumed. It does **not** authorize evidence upload, challenge, accept, refund, escalation, or a follow-up GET.

## Evidence — verified on MAIN-PC
- Private sanitized receipt: `[LOCAL_REPO_ROOT]\out\ft063-adversarial-readiness\out\ft063-real-readonly\FT064_VISA_CASE_GET_SANITIZED.json`.
- SHA-256: `98f5a627cf2b2d3a16875652a37b7856f2be2f7927c5ca4e882659460c891909`.
- Receipt schema: `FT064_REAL_SANDBOX_VISA_DETAIL_READ_V1`.
- Provider read outcome: `PROVIDER_DETAIL_ID_VERIFIED`; failure: `null`.
- The provider dispute ID was decrypted from owner-local DPAPI on MAIN-PC and verified against the FT-049 fingerprint. The provider payment intent ID also matches the historical payment fingerprint. **Neither full ID nor credential/token is written into this report or the sanitized receipt.**

## Exactly observed request count
| Step | Operation | HTTP | Retries |
|---|---|---:|---:|
| 1 | POST /api/v1/authentication/login (nonfinancial authentication) | 201 | 0 |
| 2 | GET /api/v1/pa/payment_disputes/[REDACTED] | 200 | 0 |

- Total outbound attempts: **2**.
- Financial mutations: **0**.
- No provider POST challenge, evidence upload, accept, refund, or issuer escalation.
- No second case detail request.
- The earlier FT-063 list probe was a different, completed one-shot authorization.

## Provider snapshot — exact case
| Field | Verified returned value |
|---|---|
| Stage | `RFI` |
| Status | `REQUIRES_RESPONSE` |
| Reason | `10.4`, `FRAUDULENT` |
| Amount | USD 120 |
| Deadline | `2026-11-09T05:55:12Z` (2026-11-09 12:55:12 Asia/Ho_Chi_Minh) |
| Deadline in future at GET | true |
| Challenge details observed | 0 |
| Dispute ID matches pinned DPAPI | true |
| Payment ID matches FT-049 historical source | true |

This establishes **provider-backed case identity and a still-open RFI at the observation time**. It does not guarantee that the status will remain open until another operation. A future authorized preflight must re-read the exact dispute immediately before any permitted action.

## Release gate
**Provider detail read GO; Challenge and competition submission NO-GO.**
- No independently audited merchant evidence bytes, reliable owner provenance, provider File Service readback IDs or attested evidence source.
- FT-057/058 have only injected/disabled transport; FT-059 trust anchor remains unprovisioned.
- No owner one-shot authorization for challenge. A GET approval cannot be reused as a challenge approval.
- No issuer result, win proof, or real challenge acceptance.
- Historical synthetic evidence does NOT count as genuine merchant evidence, even if a test source has a plausible quote.

## Next responsible steps
1. Offline merchant-evidence inventory and provenance review. For each candidate proof, distinguish simulated fixtures from owner-confirmed source, hash the original bytes and verify dispute/payment/account linkage.
2. Prepare evidence completeness and reviewer gate. If no legitimate evidence exists, **preserve the HOLD** instead of uploading synthetic documents.
3. Only with a separately authorized scope, inspect Airwallex File Service readbacks and build a case-specific, account-bound one-shot challenge approval.
4. Do not record the final judge video/voice as if a live challenge or issuer resolution had already occurred.

**Custody:** this Git report contains no tokens or raw dispute IDs. The detailed JSON receipt remains local inside ignored `out/`; no Git push, no original worktree modification.
