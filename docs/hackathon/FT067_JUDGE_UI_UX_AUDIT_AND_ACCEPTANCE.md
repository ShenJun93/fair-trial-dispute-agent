# FT-067 — Judge UI/UX audit and targeted upgrade

**Date:** 2026-11-03 (Asia/Ho_Chi_Minh). **Recommendation: DO NOT rebuild the entire frontend. Refactor Judge Mode incrementally.**

## Authority and scope

- Base: local Git commit `fb3d4581a273`, from the FT-064 provider-detail readback integration.
- Branch: `integration/ft067-judge-evidence-ui-20261103`.
- Isolated source worktree: `[LOCAL_REPO_ROOT]\out\ft067-judge-evidence-ui`.
- Browser mode: **MOCK**; session token was generated ephemerally by QA. No Airwallex network call or mutation.
- UI summary is a **static, owner-verified FT-064 historical snapshot**, observed at `2026-11-02T23:50:31.968Z`, not a fresh or continuous connection.
- FT-064 sanitized receipt SHA256: `98f5a627cf2b2d3a16875652a37b7856f2be2f7927c5ca4e882659460c891909`.
- FT-066 PDF is a separate **synthetic review-only packet**, not supporting documents authenticated for upload. This UI references it honestly; the PDF was not added to Git.

## Screenshot-grounded audit

Screenshots captured and inspected **during this audit**, not recycled from old conversations:

- Initial original provider view desktop/mobile: `[LOCAL_REPO_ROOT]\out\ft065-evidence-provenance\out\ft055-qa\portfolio-1280.png` and `portfolio-390.png`.
- New first viewport: `out/ft067-qa/first-viewport-1280.png`, `out/ft067-qa/first-viewport-390.png`.
- New summary: `out/ft067-qa/judge-brief-1280.png`, `judge-brief-768.png`, `judge-brief-390.png`.
- Agent run result: `out/ft067-qa/agent-provider-rfi-1280.png`.

| Step | Evaluated surface | Health | Finding / evidence |
|---|---|---|---|
| 1 | Entry, session authorization | **PASS with UX friction** | Existing masthead consistent, but reviewer needs a terminal-issued token. New evidence brief remains hidden before successful session authorization. |
| 2 | Visa case and provenance | **IMPROVED / PASS** | Previously Visa and Mastercard had equal prominence, while HOLD was below their verbose data cards. New judge-first brief opens with Visa 10.4, USD 120, RFI, application HOLD and a four-step FT-048/049/064/policy chain. |
| 3 | Explanation and safe next action | **IMPROVED / PASS** | Evidence provenance explicitly separates provider-verified case, missing genuine merchant evidence/File Service IDs, and owner-approved next action. Date/receipt-hash reference, NO LIVE REFRESH, and no issuer outcome are prominent. |
| 4 | Execute bounded demo workflow | **FIXED / PASS** | The existing `#runAgent` button was permanently disabled following successful login. Fixed only after session authentication; Playwright clicks and observes HOLD in provider-RFI scenario. This remains local application workflow, not financial execution. |
| 5 | Responsive design 1280, 768, 390 | **PASS** | Summary has no local horizontal overflow. Mobile initially showed only an oversized masthead and disclaimer; the new order and compact masthead place the HOLD narrative in the first viewport. |

## Design decision

**Keep** the existing CSS tokens, server-rendered TypeScript page, application sessions, case review store, policy engine and mock/provider isolation.

**Replace only the judge story hierarchy:**
1. Read-only case brief (shown after auth; pinned to FT-064).
2. Provider chain → verified facts → evidence gaps → HOLD.
3. Run the existing deterministic bounded agent workflow.
4. Keep detailed Mastercard/Visa receipts and lifecycle/what-if tools below as supporting material.

A wholesale rewrite would create major regression and maintenance risk without solving the blocker: no genuine merchant evidence, no verified Airwallex File Service upload, no owner-approved challenge and no issuer outcome.

## Implemented changes

- `spike/judge-evidence-brief.ts`: sanitized FT-064 proof summary, timestamp, SHA pin and obvious stale-snapshot disclosure.
- `spike/judge-evidence-brief.css`: responsive hierarchy, semantic cards, four-stage chain, first-viewport mobile compactness.
- `spike/dispute-review-server.ts`: render new section **before** long legacy panels, reveal only after authorized session/valid offline portfolio; enable the intended bounded workflow button after successful login.
- `scripts/ft067-judge-brief.test.ts`: proof disclosure, sanitized source, accessible section structure.
- `scripts/ft067-browser-acceptance.mjs`: screenshot-based auth gate, actual click-through agent workflow, mock-only network and 1280/768/390 overflow check.
- `package.json`: include FT-067 unit tests in `npm test`.

## Verified on isolated worktree

- `npm ci --offline --ignore-scripts --no-audit --no-fund`: PASS.
- `npm test`: **307 / 307 PASS** (235 dispute + 72 HPP).
- `npm run typecheck`: PASS.
- `node scripts/submission-smoke.mjs`: PASS. Video deferred.
- Legacy `ft055-browser-acceptance.mjs`: PASS at 1280/768/390.
- New `ft067-browser-acceptance.mjs`: PASS; no JS errors, no external requests; before-auth hidden, after-auth visible; actual mock bounded agent run returns HOLD; no local horizontal overflow.
- `gitleaks dir . --redact=100 --no-banner`: **0 findings** on ~2.92 MB.
- Financial/provider mutations and Airwallex requests: **0**.

## Remaining UX/accessibility work — do not equate visual QA with accessibility certification

**P1:** Make legacy provider case detail tables progressively disclosed on mobile, while leaving the judge brief always visible. This reduces scrolling but requires keyboard/focus and screen-reader acceptance tests.

**P1:** Package a safe judge onboarding path; token currently comes from terminal. Avoid insecure token shortcuts or unreviewed bypass of the existing authentication gate.

**P1:** Add an explicit navigable handoff from brief to case workflow and accessible reading order, then run keyboard-only and actual screen reader tests. Screenshot/DOM checks alone do not establish WCAG compliance.

**P2:** Consider a three-step judge flow (Inspect → Run → Explain) and add polished video after product release gates. Avoid investing in decorative animations ahead of evidence authenticity.

## Release boundary

The existing dashboard displays a historical Sandbox case and locally generated policy outcomes. This is **not** Airwallex real-time case status, uploaded evidence, submitted challenge, issuer decision or proven refund settlement. Do not publicly push historical evidence screenshots until privacy audit. **Final competition/product release remains NO-GO.**
