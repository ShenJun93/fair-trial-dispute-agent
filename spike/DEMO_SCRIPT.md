# Fair Trial judge demo — 4:30 narration and shot list

## Local preparation

Use Node.js 22.5 or later. In PowerShell:

```powershell
Set-Location '<REPOSITORY_ROOT>'
$env:DISPUTE_PROVIDER_MODE = 'MOCK'
$tokenBytes = [byte[]]::new(32)
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($tokenBytes)
$rng.Dispose()
$env:DISPUTE_REVIEW_TOKEN = [Convert]::ToBase64String($tokenBytes)
$env:DISPUTE_REVIEW_DB = Join-Path $env:TEMP ("fair-trial-demo-" + [guid]::NewGuid().ToString("N") + ".sqlite")
npm run dispute:review
```

Open `http://127.0.0.1:4243` on the same computer and enter the token at the prompt. Keep the server terminal available. Do not expose this loopback dashboard through a tunnel. The fresh database seeds the original three deterministic fixtures plus a separate fourth OFFLINE_FIXTURE evidence lab case. The 4:30 historical video shows only the original three. To demonstrate persistence, keep the same `DISPUTE_REVIEW_DB` value when restarting the server. Clear `DISPUTE_REVIEW_TOKEN`, `DISPUTE_REVIEW_DB` and `DISPUTE_PROVIDER_MODE` from the shell when finished.

## Timed walkthrough and narration

### 0:00–0:30 — Problem

**Show:** title card or dashboard header.

**Say:** “Merchants spend time deciding whether a dispute is worth fighting. A weak case can cost more to pursue than the amount recovered, while strong evidence can justify a response. Fair Trial puts evidence, deadlines and dispute economics in one review.”

### 0:30–1:00 — Dashboard and decision criteria

**Show:** dashboard overview, fee setting, stage/status, provenance labels.

**Say:** “This dashboard combines the dispute stage, available evidence and a configurable dispute fee. The recommendations are decision support. Every case on screen is an `OFFLINE_FIXTURE`; the examples do not represent actual Airwallex disputes.”

### 1:00–1:35 — CHALLENGE

**Show:** USD 120 fraud fixture and evidence panel.

**Say:** “This `OFFLINE_FIXTURE` is a USD 120 fraud claim. Its synthetic evidence includes strong device and 3DS signals. At the configured USD 25 fee, the example estimates USD 96 recovery and USD 71 net. Fair Trial recommends CHALLENGE because the evidence and estimated economics support a response. I’ll record a local approval; no provider action is sent.”

**Action:** approve recommendation; show local decision and audit entry.

### 1:35–2:00 — ACCEPT recommendation

**Show:** USD 20 delivery fixture.

**Say:** “This `OFFLINE_FIXTURE` is a USD 20 delivery claim with a weak carrier scan that does not establish recipient delivery. The example estimates USD 3 recovery, less the USD 25 fee, for negative USD 22 net. Fair Trial recommends ACCEPT on the economics. I’ll reject this recommendation locally to show the human control.”

**Action:** reject recommendation; show local rejection and audit entry. Clarify: “This records a decision only. It neither accepts an RFI with Airwallex nor completes a refund.”

### 2:00–2:20 — ESCALATE_FOR_REVIEW

**Show:** USD 60 credit-not-processed fixture and unanswered support request.

**Say:** “This `OFFLINE_FIXTURE` is a USD 60 credit-not-processed case with an unanswered customer-support issue. The evidence is incomplete, so Fair Trial routes it to `ESCALATE_FOR_REVIEW` without inventing a recovery estimate.”

### 2:20–3:10 — Human decision and durable audit

**Show:** local approval/rejection controls, then audit history with actor and timestamps.

**Say:** “A person can approve or reject a recommendation. These are `LOCAL_ONLY` decisions protected by one-time, expiring authorization. The SQLite audit history records the actor and decision. It survives a server restart when the same database is reused. Provider action remains `NOT_EXECUTED`; a local approval is not a provider confirmation.”

**Action:** point to the audit rows; optionally refresh after restarting with the same DB.

### 3:10–3:45 — Simulated lifecycle

**Show:** lifecycle section.

**Say:** “This sequence is explicitly simulated: RFI, CHALLENGE, issuer rejection, then CHARGEBACK. Each transition is an `OFFLINE_FIXTURE`, included to demonstrate how a case can progress. It is not a real issuer decision or Airwallex event.”

### 3:45–4:10 — Live read evidence

**Show:** sanitized receipt at `submission/evidence/dispute-list-read.json`.

**Say:** “The only `LIVE_VERIFIED` integration evidence here is one authenticated Airwallex US sandbox dispute-list GET. It returned HTTP 200, passed schema validation and returned zero disputes. It was read-only. No live dispute was available to inspect.”

### 4:10–4:30 — Architecture and close

**Show:** architecture summary or README integration boundaries.

**Say:** “The local dashboard uses a deterministic decision engine and durable SQLite audit history. Provider-side challenge, acceptance and refund execution are `NOT_IMPLEMENTED`. Fair Trial demonstrates how to make a more informed human decision while keeping fixture evidence, local actions and verified provider reads distinct.”

## Recording checklist

- Target length: 4:30; acceptable range 4:00–4:30.
- Show the `OFFLINE_FIXTURE`, `LOCAL_ONLY` and `NOT_IMPLEMENTED` labels when relevant.
- Keep the sanitized receipt visible only for its 25-second segment.
- Do not show tokens, `.env.local`, credentials, customer information or the original unsanitized receipt.
- Do not click any payment or provider-action controls. No provider writes are enabled in this demo.
- Record locally and review the final video before any manual submission.

## Evidence boundary

- `LIVE_VERIFIED`: one authenticated read-only dispute-list request, with an empty result.
- `OFFLINE_FIXTURE`: all three disputes, synthetic evidence and lifecycle transitions.
- `LOCAL_ONLY`: approvals, rejections and audit history.
- `NOT_IMPLEMENTED`: provider-side challenge, accept and refund execution.
