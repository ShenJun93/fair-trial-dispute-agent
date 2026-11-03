# FT-068 ? Guided Judge Demo (Inspect ? Run ? Explain)

Date: 2026-11-03 ICT. Base: FT-067 commit `a771d3e`.
Branch: `integration/ft068-judge-demo-flow-20261103`.
Worktree: `[LOCAL_REPO_ROOT]\out\ft068-judge-demo-flow`.

## Implementation

- Introduced keyboard-focusable, labeled three-step local navigation: **Inspect** takes the authenticated reviewer to the historical Visa 10.4 evidence brief; **Run** opens the existing deterministic bounded agent; **Explain** is unavailable until a workflow returns a result and then moves focus to the actual result summary.
- Preserved the existing agent, policy, historical receipts, authorization, server API and full case workbench.
- Moved the existing agent panel above the verbose historical portfolio so the demo path is contiguous. No automatic execution on navigation.
- The judge brief and navigation remain hidden until authenticated `/api/dashboard` content is successfully rendered.
- The action remains **HOLD**. Provider status is a historical snapshot, **not live**, and cannot be confused with application policy or provider execution.
- No provider write endpoint added; no live Airwallex call is required for the UI or test.

## Verified / bounded evidence

- `npm run typecheck` PASS.
- `npm test` PASS: 235 dispute tests + 72 HPP tests at initial regression, then add two FT-068 tests to default suite.
- `node --disable-warning=ExperimentalWarning --import tsx scripts/ft068-browser-acceptance.mjs` PASS in MOCK mode with automated click-through, focus assertions, desktop/tablet/mobile widths of 1280, 768 and 390.
- Browser snapshot files and structured acceptance result: ignored `out/ft068-qa/`. No runtime credentials or source merchant evidence in Git.
- No Airwallex network request or financial mutation, no issuer outcome, no evidence upload.

## Release and next action

This is an **offline judging workflow**, not an authorized live challenge. Historic FT-064 receipt is SHA pinned in FT-067. The synthetic FT-066 packet must never be passed as merchant proof. Preserve authentication gate: static HTML visibility is not data security. Final hackathon submission remains separately gated by evidence authenticity, public demo privacy audit, rules and release readiness.

Next: independently review keyboard/assistive-technology behavior, record a truthful short walkthrough, audit exported video and submission package. Do not claim WCAG certification based on DOM tests.
