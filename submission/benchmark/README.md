# Synthetic financial decision benchmark

This benchmark checks the deterministic policy engine against ten declared synthetic scenarios. It is a regression fixture, not a sample of real disputes and not evidence that configured recovery probabilities predict outcomes.

## Reproduce

From the repository root on Node.js 22.5 or later:

```powershell
node --disable-warning=ExperimentalWarning --import tsx scripts/financial-decision-benchmark.ts
```

The runner reads [`financial-decision-scenarios.json`](financial-decision-scenarios.json), evaluates every scenario 101 times with a fixed clock, and writes [`financial-decision-results.json`](financial-decision-results.json). A nonzero exit means an expected action, expected reason, approval behavior, determinism check, or evidence-grounding check failed. To write to another location, pass a result-file path as the first argument.

## Coverage

The dataset covers a valid challenge, negative challenge economics, missing evidence, scoped and unscoped contradictions, snapshot-stale approval, changed stage assumptions, a near deadline, one-time approval replay, and an unverified model-shaped claim. “Duplicate execution prevention” measures one-time local approval replay rejection; no provider execution interface is exercised.

Evidence grounding checks that every evidence ID used by the recommendation appears in the verified input set. Determinism compares the serialized decision from all 101 runs with the first result. Latency is the local engine call only; it excludes UI, database, network, provider, and model latency. Runner elapsed time is not a production capacity estimate.

## Current result

The checked-in result records the local machine/runtime and measured run. Scenario pass rates and latency are reproducible regression observations for this checkout, not general performance or recovery estimates. The policy inputs include illustrative assumptions from `spike/dispute-engine.ts`; those assumptions are not calibrated against historical outcomes.
