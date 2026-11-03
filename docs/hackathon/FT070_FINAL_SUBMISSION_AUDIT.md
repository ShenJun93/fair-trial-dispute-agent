# FT-070 — Final Submission Audit and Release Gate

**Date:** 2026-11-03, Asia/Ho_Chi_Minh.
**Competition:** Airwallex Agentic Banking Hackathon 2026 (HackerEarth), Starter Kit 04.
**Source baseline:** `4d1cfc9` (FT-069), plus FT-070 isolated documentation/package changes.
**Branch:** `integration/ft070-submission-audit-20261103`.
**Status:** **TECHNICAL DEMO PASS / EXTERNAL SUBMISSION NO-GO**.

## Executive decision

Do not rebuild the application. The existing FT-068 guided Judge Demo and FT-069 narrated 2:21 video are technically credible. The remaining risks are the delivery path, up-to-date product story, copyright/license provenance, public privacy review, accessible judge links and final HackerEarth form.

**No Airwallex provider read, mutation, challenge, upload, accept, refund or issuer escalation was authorized or executed in FT-070. No Git push or external project/video publication.**

## Verified on local FT-070 source worktree

| Gate | Result | Evidence |
|---|---|---|
| Git baseline | PASS | Source starts at `4d1cfc9`, isolated worktree; no main worktree modifications |
| Clean dependencies | PASS | `npm ci --offline --ignore-scripts --no-audit --no-fund` |
| TypeScript | PASS | `npm run typecheck` |
| Test suites | PASS | **309/309** = 237 dispute tests + 72 HPP tests |
| Playwright guided UI | PASS | Auth gate, provider RFI HOLD, desktop 1280 / tablet 768 / mobile 390; 0 external requests, 0 provider mutation, 0 JS errors |
| Historical submission smoke | PASS | 44 historical required docs and evidence, 10 benchmark scenarios, certificate tamper rejection; its `finalVideo: DEFERRED` field is historical and **must not** be cited as FT-069 status |
| Current FT-069 video | PASS on automated checks | Local `fair-trial-ft069-judge-demo-captioned.mp4`: 141.48 s, 1920x1080, H.264/AAC, 28 burned-in caption cues, SHA-256 `ef233119eb0fbd21bada3a94ff50942cf08c961071d7c6255773fd3a52d734e4`. Source FT-069 report documents human playback still pending |
| Legacy release allowlist | **INVALID FOR CURRENT RELEASE** | 204 old allowlist entries vs 666 tracked source files at the FT-069 baseline; **463 tracked paths are absent**, including FT-067/068/069 |
| New local minimal candidate | PASS technical, pending owner privacy and license | Explicit selected-source policy yielded **197 files / ~1.5 MB**. Independent `npm ci`, typecheck, **309/309 tests**, FT-068 browser acceptance, and Gitleaks directory scan PASS. Candidate is **INTERNAL ONLY** |
| Public repository / hosted video | BLOCKED | `git remote -v` empty; no verified hosted video URL |
| License | BLOCKED | Root contains `LICENSE.DRAFT` with copyright holder placeholder; no valid completed root `LICENSE` |
| HackerEarth entrant form | NOT VERIFIED | Exact deadline time/time zone, selected idea, account submission status, access/URL and required fields need confirmation in logged-in account |

## Fresh source narrative

- FT-048: test Visa USD 120 payment within Airwallex Sandbox.
- FT-049: simulated Visa 10.4 fraud RFI created/read back.
- FT-064: one owner-approved case-specific `GET` HTTP 200, response time `2026-11-02T23:50:31.968Z`; `RFI / REQUIRES_RESPONSE`, historical dispute/payment fingerprints matched, no provider mutation. The exact case details are **not guaranteed current** now.
- FT-067: one-screen authenticated Judge Evidence Brief that separates provider identity, missing merchant evidence, HOLD and next safe action; SHA-256 pin to the sanitized historical receipt.
- FT-068: **Inspect → Run → Explain** guided navigation, local deterministic tool workflow, actual trace.
- FT-069: actual local browser capture of provider-backed HOLD plus separate **synthetic** high-value evidence replan, edited into an English narrated captioned video. The title and end cards are designed slides, not browser footage.

**Do not claim:** genuine issuer dispute, current live Airwallex status, uploaded evidence, submitted challenge, issuer win, refund settlement, model-directed financial planning, real customer adoption, measured win rate, or the synthetic replan as merchant evidence.

## Official/general submission guidance and remaining uncertainty

- Organizer/event public entry: https://airwallex.hackerearth.com/ — direct portal fetch was not available in this audit.
- Official HackerEarth help, `https://help.hackerearth.com/submitting-a-prototype`, describes prototype fields including title, description, screenshots, **hosted video link (YouTube/Vimeo/Youku)**, repository, source file and setup instructions. It also describes saving drafts, publishing and an inability to edit after publishing; **specific event form overrides generic guidance**.
- The public event deadline is **2026-11-13**, corroborated by dated project documentation and third-party event listings. One third-party listing claims 23:59 IST; this is **not verified as the exact event's portal cutoff**. Treat the deadline as 13 November but confirm directly; do not anchor a submission plan to the third-party cutoff time.
- No real repository or video URL should be fabricated or inserted into the form.

## External release blockers — owner-controlled

1. **Copyright and licensing:** confirm the legal copyright holder, intended software license and third-party notice accuracy; replace `LICENSE.DRAFT` with an owner-approved root `LICENSE`. Do not commit guessed ownership.
2. **Git hosting:** choose an authorized GitHub/GitLab repository and its visibility. Review the *exact* candidate allowlist; publish only after a privacy/code rights review. Current local Git history and release allowlist do not imply an accessible judge URL.
3. **Video publishing:** human-watch the *entire* FT-069 captioned MP4 with audio. Confirm every frame, visible content, subtitles, pronunciation and source labeling, then host and test the URL from an unauthenticated judge perspective.
4. **HackerEarth account:** confirm shortlist/Build Phase eligibility, exact submission form, cutoff time/time zone, image/video formats, URL accessibility and other required fields. Do not publish until all fields are complete; record official confirmation.
5. **Candidate privacy signoff:** Gitleaks PASS is a secret-pattern check, **not** a guarantee of no personal data, licensed material, case identifiers or sensitive historical evidence. Judge source ZIP is not approved for upload until human review.

## Competition positioning

Target **Founder's Choice / Judges' Choice** first unless the active form clarifies another category. Using a Visa 10.4 simulated dispute does **not** by itself establish Visa sponsor eligibility or compliance with required Visa tools. Metal tooling is not evidenced. The value proposition is verifiable uncertainty, conservative policy and human-bound execution—not a claim that the agent autonomously won an issuer dispute.

Biggest qualitative weakness: the default agent planner is deterministic and `MODEL: OFFLINE_MOCK`. The optional local model's historical grounded recall was limited (6/25 supported in a small synthetic corpus); it is not the live judge demo. Do not oversell AI autonomy. Adding more unsafe financial flows solely to impress judges would weaken credibility. Prioritize an honest, reproducible narrative and delivery links; consider separate evidence-backed model improvements only if release gates are secured.

## Handoff and artifacts

- Current copy: `submission/FT070_JUDGE_SUBMISSION_DRAFT.md`, supersedes historical `submission/PROJECT_SUBMISSION.md`.
- Refreshed `README.md` and `JUDGE_QUICKSTART.md` lead to FT-064–069 and correct test totals.
- **Frozen source package:** `submission/FT070_JUDGE_SOURCE_ALLOWLIST.txt` pins **197** reviewed candidate paths. The source archiver emits a deterministic internal ZIP `out/ft070-audit/fair-trial-ft070-INTERNAL-DO-NOT-UPLOAD.zip` with per-file SHA256 manifest and archive SHA256 in ignored local output. After extraction into a separate clean folder: `npm ci --offline` **PASS**, `npm run typecheck` **PASS**, `npm test` **309/309 PASS**, `scripts/ft068-browser-acceptance.mjs` **PASS** at 1280/768/390 px, `gitleaks dir .` **0 findings**. This still requires human privacy and ownership review.
- Automated local preflight: `python scripts/ft070-audit.py --video <local-FT069-captioned-MP4>`. Writes ignored `out/ft070-audit/readiness.json`, returns NO-GO while external links/license/portal approval are missing.
- Minimal source candidate creator: `python scripts/ft070-build-candidate.py`, writes **ignored** `out/ft070-audit/judge-source-candidate/` plus per-file SHA-256, deterministic internal ZIP and the frozen candidate allowlist. The candidate excludes screenshots, video, runtime data and historical superfluous reports.
- Final publication decision requires an owner-approved repository URL, hosted video URL, license, exact portal configuration and human privacy signoff. These are not inferred from successful local tests.

**Next action:** close the 5 external release gates, then validate that a clean third party can clone/open the *published* links and run the guide. Only after that should the form be published. No submission occurred in FT-070.
