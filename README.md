# Fair Trial — Evidence-First Dispute Decisions

**Airwallex Agentic Banking Hackathon 2026, Kit 04 — Dispute Response Agent**

Fair Trial is a reproducible **offline dispute-decision prototype**. It inspects a historically verified Airwallex Sandbox dispute snapshot, checks evidence provenance, runs a bounded tool workflow and applies conservative financial policy. When original merchant evidence is missing, it recommends **HOLD / REQUEST_EVIDENCE / HUMAN_REVIEW** rather than fabricating a chargeback challenge.

## Run it

Requirements: Node.js >=22.5 and npm. Windows PowerShell is used for the interactive Judge Demo. No Airwallex credentials, provider actions, cloud LLM or live dispute access are required.

```powershell
npm ci --no-audit --no-fund
npm run typecheck
npm test
npm run demo
```

Expected baseline: **237 dispute tests + 72 HPP tests = 309 passing**. The offline demos emit typed tool / economics traces and mark provider actions `NOT_EXECUTED`.

### Interactive Judge Demo (Inspect → Run → Explain)

```powershell
$bytes = [byte[]]::new(32)
$rng = [Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($bytes)
$rng.Dispose()
$env:DISPUTE_REVIEW_TOKEN = [Convert]::ToBase64String($bytes)
$env:DISPUTE_PROVIDER_MODE = 'MOCK'
$env:DISPUTE_REVIEW_DB = "$PWD/out/judge-demo.sqlite"
npm run dispute:review
```

Open **http://127.0.0.1:4243** on the same computer and enter the temporary token from the PowerShell environment (avoid recording or sharing it). The server binds only to loopback. See [JUDGE_QUICKSTART.md](JUDGE_QUICKSTART.md) for local token handling and expected screen actions.

The four runnable paths:

| Case / source | Actual application outcome | Important boundary |
| --- | --- | --- |
| Visa 10.4 simulated Sandbox RFI, saved authorized readback | HOLD / request genuine evidence | **HISTORICAL**, not refreshed |
| Synthetic high-value fraud with second fixture signal | CHALLENGE_RECOMMENDED after evidence replan | Recommendation only |
| Synthetic low-value delivery | ACCEPT_RECOMMENDED from unfavorable costs | No dispute accepted |
| Synthetic credit-not-processed | ESCALATE_FOR_REVIEW | Local human review only |

Use **Inspect** to see case identity and missing evidence; **Run** to execute the selected bounded workflow; **Explain** to inspect result, reason codes and tools actually called.

## Real integration versus simulation

- On **2026-11-02 23:50:31.968 UTC**, one owner-authorized Airwallex **Sandbox** case detail GET returned HTTP 200 for a test Visa 10.4 / FRAUDULENT / RFI / REQUIRES_RESPONSE dispute of USD 120. Identity fingerprints were verified. **This is an archived observation**, not current status or real cardholder proof. Some providers' production Visa/Mastercard lifecycle flows may differ from the simulated RFI; do not generalize its stage.
- The application's HOLD is its **own deterministic policy recommendation**, not an Airwallex decision.
- Three other scenario outcomes use **synthetic repository fixtures**; they do not represent genuine merchant authorization, device evidence or fulfillment.
- The default planner is deterministic, not a model directing tools. Optional local model investigation is experimental, synthetic-only, and **not used in the judge video**.
- No challenge, accept, refund, evidence upload, issuer adjudication or money recovery is performed or claimed. Any local approval is **not** an external financial action.

## Architecture and safeguards

TypeScript/Node.js, SQLite, local HTML/CSS dashboard, a bounded typed-tool registry, source-linked evidence references, case/revision-bound local approvals, deterministic policy economics and an inspectable execution trace. The recorded video uses actual browser interactions in MOCK mode. Historical technical evidence is in `docs/hackathon/` and the sanitized demonstration sources under `submission/evidence/`.

## Judge-only command boundary

The release npm scripts expose **only** typecheck, tests, offline CLI demonstrations and `dispute:review`. The interactive dashboard is launched through `scripts/judge-only-server.mjs`: it rejects any `DISPUTE_PROVIDER_MODE=LIVE` or `FAIR_TRIAL_MODEL_MODE=LOCAL_LLM`, strips payment credentials from its child environment, and runs locally in MOCK mode. Some W1 integration source remains **for unit-test imports**, but `w1:execute` and other non-judge operational npm commands are **not exposed**. Do not directly execute historical integration source or provide payment credentials to the source.

## Security, rights, limitations

The launch configuration uses a disposable local reviewer token and loopback server. This package deliberately excludes standalone direct provider-write experiments and the full development Git history.

This is a contest review candidate; **no license grant is represented by the package** until the copyright holder approves the final license. Third-party rights and evidence disclosure still require owner approval. Do not upload historical provider snapshots publicly without permission.

## Build provenance

This source bundle is derived from the 175-file FT-072 clean-room-tested Judge-only candidate. Automated regression is 309 tests plus browser acceptance at 1280, 768 and 390 pixels. No provider network request is made by the tests.
