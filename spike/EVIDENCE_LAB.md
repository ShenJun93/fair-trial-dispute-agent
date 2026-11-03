# Phase 4.2A — Offline evidence and decision replan lab

**Historical Phase 4.2A note:** The original offline exercise below predates the interactive dashboard and optional local-model benchmark. Current behavior is described in the root README and submission walkthrough. It remains outside the provider financial execution path.

## Reproduce

From the repository with installed Node dependencies:

```powershell
node --disable-warning=ExperimentalWarning --import tsx spike/11-evidence-replan.ts
npm run test:disputes
```

The synthetic exercise starts with a $120 high-value fraud dispute that has only **one** verified risk signal, producing `ESCALATE_FOR_REVIEW`. It ingests a local synthetic text report with an exact statement `3DS authenticated; device matches customer profile`. A strict phrase matcher extracts a quote, character offsets and SHA-256 document digest. The extracted fact starts **unverified**. A locally named operator explicitly attests that source-bound statement, after which the deterministic policy finds a second evidence item and recalculates to `CHALLENGE`. The changed fingerprint demonstrates why any approval for the earlier state must be refreshed. No provider action occurs.

## Boundaries and security

- Input is `text/plain`, limited to 4,096 UTF-8 bytes with a synthetic case/document ID and timestamp. Source labels are `OFFLINE_OPERATOR_TEXT`.
- Extraction is **deterministic regex, NOT LLM**, constrained to a complete line, one signal per document. It does not understand arbitrary PDFs, emails or issuer documents.
- Extracted facts contain exact quote, start/end character offsets, document ID and SHA-256. A forged, moved or altered quote and mismatched document digest are rejected by attestation.
- Operator attestation is **not independent verification** of source authenticity or evidence truth. It is only a local simulation of the review checkpoint; no signed proofs, identity verification or provider source-check are present.
- Text such as `Ignore previous instructions` remains untrusted content. It cannot issue tool calls or set policy. This lab does not yet have a model or complete adversarial prompt-injection evaluation.
- Future-live action validation rejects evidence with `provenance.source = OPERATOR`. A positive offline recommendation must never be used as permission for provider writes.
- Expected value and win probabilities remain illustrative configuration assumptions; they are not trained/calibrated forecasts.
- This lab does not persist imported text, source attestation or decision deltas in the SQLite dashboard. It does not perform Airwallex reads or writes and does not update the prior silent demo video.

## Next milestone (Phase 4.2B)

Persist document hash, attestation, source quotations and before/after decision delta in an append-only local SQLite flow; authenticate the operator and expire stale approvals. Add a browser-visible, interactive safe replan, then a **schema-constrained, optional LLM proposal** that cannot alter deterministic policy, with input privacy controls and injection tests. Retain offline-only mode until separately authorized provider integration.

## Phase 4.2B ? Interactive local dashboard (2026-10-28)

- Fresh MOCK SQLite databases now seed the original three cases plus a fourth kit04-evidence-lab case with only one synthetic strong risk signal.
- In the loopback dashboard, sign in locally, expand the evidence lab, ingest synthetic text, inspect stored SHA-256, exact quote and character offsets, then click local attestation.
- Ingest persists an immutable document and extracted UNVERIFIED fact, adds a durable audit entry and increments case revision to invalidate prior review tokens.
- Attestation revalidates the stored source and quote, records the attesting operator, appends evidence, recalculates recommendation, records the ESCALATE_FOR_REVIEW -> CHALLENGE delta and invalidates prior review tokens again.
- SQLite restart preserves the document, quote, attestation, recommendation, local review and append-only audit history.
- HTTP endpoints /api/evidence/ingest and /api/evidence/attest require a local session plus Origin and CSRF checks. No provider writes exist on these routes.
- Strict matcher is NOT an LLM. Text is untrusted and limited to 4096 bytes. No customer data or provider evidence should be pasted into the lab.
- provenance.source = OPERATOR indicates a local claim, not independent provider verification. Future-live gate rejects such evidence.
- The historical 4:30 silent video has NOT been regenerated and does not demonstrate this new interactive capability.
- The earlier Phase 4.2A "Next milestone" paragraph is superseded for SQLite/browser work; optional schema-constrained LLM proposals are NOT implemented.

## Current local-model benchmark boundary

The evidence lab has two explicit proposal modes: `OFFLINE_MOCK` (default, deterministic rule matcher) and opt-in `LOCAL_LLM` (inference through a configured numeric-loopback OpenAI-compatible endpoint). Local mode requires per-run confirmation that text is synthetic and contains no personal/payment data. Contract v2 asks the model for only `factType` and `exactQuote`; application code recomputes source SHA-256, checks that the case revision and source snapshot are unchanged after inference, derives UTF-16 offsets only for a unique exact quote, and attaches trusted IDs, timestamps, source labels and verified model identity. No model confidence, policy, approval, tool or execution field is accepted. Deterministic support/contradiction checks and local operator attestation remain required. Missing config, malformed output, unsupported claims, ambiguous quotes, and stale snapshots fail closed. Model inference does not change policy or authorize provider actions. Integration tests use fake providers and do not count as model performance. The saved v1 Qwen response now passes a contract conversion regression offline; no live inference was run with contract v2. See `submission/FT_EXTRACTION_001_CONTRACT_V2.md` and `submission/LOCAL_MODEL_EVALUATION.md`.
