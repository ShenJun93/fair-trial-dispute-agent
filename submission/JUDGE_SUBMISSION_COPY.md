# Fair Trial — Submission copy

**Title:** Fair Trial — Evidence-First Dispute Decisions

**Tagline:** A bounded dispute-review agent that makes uncertainty and missing evidence visible before a human authorizes any financial action.

**Problem.** Fraud and delivery disputes require decisions within deadlines, but an AI agent may create plausible narratives from unsupported evidence. Merchants need an auditable path to HOLD, challenge recommendation, accept recommendation, or escalation.

**Solution.** Fair Trial combines an owner-authorized **historical Airwallex Sandbox** case read with typed tools, evidence provenance, deterministic policy economics and a human review boundary. The Visa 10.4 Sandbox snapshot proves identity and an RFI stage **at its original observation time**, while absent genuine merchant proof forces the local recommendation **HOLD**. This saved test-case status is **not a live production Visa lifecycle claim**.

**What judges can try.** Authenticate to the local dashboard (see `JUDGE_QUICKSTART.md`), then Inspect → Run → Explain. Run the historical saved provider case (HOLD), synthetic high-value fraud evidence replan (CHALLENGE_RECOMMENDED), synthetic low-value delivery economics (ACCEPT_RECOMMENDED) and synthetic credit-not-processed (ESCALATE_FOR_REVIEW). Each path shows actual policy reason codes, tool trace and a `NOT_EXECUTED` financial boundary.

**Technology.** TypeScript / Node.js, SQLite, custom deterministic rule planner, typed tools, revision-bound evidence/approval checking, HTML/CSS, Playwright tests, Airwallex Sandbox historical case details. The default judge flow runs no model inference and no provider action.

**Reproducibility.** Node.js >=22.5, `npm ci`, `npm test` (309 tests), `npm run typecheck`, `npm run demo`, and the local dashboard. No Airwallex credentials are required. Browser acceptance covers 1280/768/390 pixels.

**Limitations.** Saved Sandbox observations are not realtime provider data. Synthetic case evidence is not real merchant/cardholder evidence. No dispute challenge, acceptance, refund, evidence upload, issuer decision or actual recovery has been performed. Financial policy recommendations are **not** autonomous provider actions.

**Video URL:** https://youtu.be/m1CF5ci8Rk4 (YouTube, 3:16; verified public metadata 2026-11-03)

**Repository URL:** https://github.com/ShenJun93/fair-trial-dispute-agent (public)

**Submission:** must be confirmed within the actual entrant HackerEarth account; this text is not proof of submission.
