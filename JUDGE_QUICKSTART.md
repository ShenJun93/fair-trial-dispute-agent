# Fair Trial — Judge quickstart

This guide is for the **offline MOCK-only** demonstration. The `npm run dispute:review` launcher rejects LIVE provider/model mode and does not pass Airwallex credentials to its child process. The Airwallex Sandbox readback is historical. No real provider action is allowed by the demo path.

1. On Windows with Node.js 22.5+ and npm, run `npm ci --no-audit --no-fund`, then `npm run typecheck` and `npm test`.
2. In a fresh PowerShell window, create a local reviewer token and start the app:

```powershell
$bytes = [byte[]]::new(32)
$rng = [Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($bytes)
$rng.Dispose()
$env:DISPUTE_REVIEW_TOKEN = [Convert]::ToBase64String($bytes)
$env:DISPUTE_PROVIDER_MODE = 'MOCK'
$env:DISPUTE_REVIEW_DB = "$PWD/out/judge-demo.sqlite"
Set-Clipboard -Value $env:DISPUTE_REVIEW_TOKEN
npm run dispute:review
```

3. Open `http://127.0.0.1:4243` on the same machine. Paste the token from the clipboard into **Review access token**. Do **not** film the login. Clear clipboard after authentication: `Set-Clipboard -Value ''`.
4. **Inspect:** Visa 10.4 sandbox snapshot, verified identity, missing genuine evidence, offline HOLD.
5. **Run:** select the *provider-backed saved Sandbox RFI*, run the bounded workflow and read the actual HOLD trace.
6. **Run / Explain:** select *synthetic high-value fraud* and observe evidence replan to `CHALLENGE_RECOMMENDED`.
7. **Run / Explain:** select *synthetic low-value delivery* and see `ACCEPT_RECOMMENDED`; select *synthetic credit-not-processed* for `ESCALATE_FOR_REVIEW`.
8. Expand **Structured execution trace** to inspect typed tools and reason codes. Confirm `NOT_EXECUTED`.

At the end, stop the server with Ctrl+C, run `$env:DISPUTE_REVIEW_TOKEN=$null` and `Set-Clipboard -Value ''`. The database under `out/` is a local runtime artifact and must not be submitted.

**Terminology:** `PROVIDER_BACKED_SAVED_RECEIPTS` = old sanitized Sandbox readback, not a new GET. `OFFLINE_SYNTHETIC_FIXTURE` = test data. `OFFLINE_MOCK` = deterministic rule planner, no inference or external request. No submitted challenge, acceptance, refund, issuer win, durable task queue or real merchant proof.
