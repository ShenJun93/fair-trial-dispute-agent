# FT-069 — Judge video capture, narration and claim/privacy gate

**Recorded:** 2026-11-03 (Asia/Ho_Chi_Minh). **Source:** Git `aa040df` (FT-068).
**Worktree:** `[LOCAL_REPO_ROOT]\out\ft069-judge-video`
**Branch:** `integration/ft069-judge-video-20261103`.

## Artifact boundary

The reproducible capture and render **source** is committed; no video, credentials, cookies, raw provider ID, original merchant evidence or recording DB is put in Git.

- Local QA/output folder (ignored): `out/ft069-video/`.
- Primary captioned candidate: `fair-trial-ft069-judge-demo-captioned.mp4`.
- Local SHA-256 (captioned candidate): `ef233119eb0fbd21bada3a94ff50942cf08c961071d7c6255773fd3a52d734e4`.
- Codec/duration: H.264 + AAC, **1920×1080, 25 fps, 141.48 seconds, 7,677,855 bytes**.
- Alternate MP4 without burned subtitles, sidecar `.srt`, source `.webm`, selected actual browser screenshots and QA manifests are retained **locally**.
- The first and last scenes are authored title cards. Between them, scene source is the **actual** Playwright-recorded app, not a mocked-up UI reconstruction.
- Narration uses Windows local TTS (Microsoft Zira Desktop), not the optional local inference model. No copyrighted music.
- Twenty-eight caption cues are burned in; sidecar SRT included for further editing.

## Reproduction on authorized MAIN-PC

1. `npm ci --offline --ignore-scripts --no-audit --no-fund`
2. `node --disable-warning=ExperimentalWarning --import tsx scripts/ft069-capture.mjs`
3. `python scripts/ft069-build-video.py` ? outputs both plain and captioned MP4 plus SRT and hash manifest.
4. `python scripts/ft069-validate-render.py` ? verifies the exact captioned artifact and source boundaries.

Capture uses a fresh temporary SQLite DB, a generated ephemeral reviewer token, localhost HTTP, and providerMode `MOCK`. The private token is never printed, written to Git or included in the published cut. Recorded video begins with the authenticated app after trimming the initial sign-in sequence. There is no real provider network session in this capture.

## Claim-by-claim evidence ledger

| Video statement | Evidence and honest limit |
| --- | --- |
| Airwallex Sandbox Visa 10.4 RFI / USD 120 / REQUIRES_RESPONSE | One authorized FT-064 historical case detail GET at **2026-11-02 23:50:31.968 UTC**, separately SHA-256 pinned in FT-067; not a continuous provider session |
| Visa policy recommendation HOLD | Actual bounded application workflow in the browser; **not** an Airwallex dispute status |
| Agent calls bounded tools and applies financial policy | Browser shows tool names and deterministic policy. Planner is explicitly rule-based, model inference `NOT_RUN` |
| Additional evidence changes a recommendation | **Synthetic** high-value scenario, revision 1 → 2, local replan; not genuine customer or cardholder proof |
| Human review is required | Application returns local-only request, no durable provider action queue |
| No financial action occurred | Capture manifest records **0 external network requests and 0 provider mutations**; no evidence upload/challenge/accept/refund or issuer outcome is claimed |

## QA evidence

- Playwright capture: two workflows, actual UI interactions, **no page errors**, **no non-local HTTP requests**; marks and raw SHA in `capture-manifest.json`.
- Source frame montage: `out/ft069-video/qa-contact-sheet.jpg`; reviewed samples at 1, 9, 18, 34, 49, 66, 86, 110, 125 and 138 seconds.
- Selected frames show correct distinction between saved provider history, synthetic replan and human review / provider NOT_EXECUTED.
- Automated QA: `python scripts/ft069-validate-render.py` reports `AUTOMATED_CHECKS_PASS_HUMAN_REVIEW_PENDING`; 28 subtitle cues, AAC audio present, H.264 1080p, under 5 minutes and output digest matches.
- FFmpeg silence detection at a continuous **4 second / -45 dB** threshold produced no detected long silences.
- Gitleaks directory scan reported no leaks found (scan covers local worktree, including ignored outputs).
- Gitleaks exit code: **0**.
- `npm run typecheck`: **PASS**.
- `npm test`: **309/309 PASS** (237 dispute + 72 HPP).
- Rebuilt end-to-end from versioned narration/capture/render sources; captioned SHA-256 reproduced identically.
- FT-069 source does not modify the application engine or provider capabilities; FT-068 tests remain the regression baseline.

## Actual release gates — not cleared

1. **Human-watch the entire video with audio** and verify pronunciation, subtitles, focus/scroll cadence, and text legibility at typical mobile viewing size. Automated metadata checks do not establish polished media quality.
2. Verify privacy of *every* frame and final artifact before any public upload; the source browser video stays in ignored local QA folder. Do not upload terminal tokens, raw provider IDs, or unredacted receipts.
3. Confirm actual HackerEarth upload/video link and final size limits inside the entrant account. Third-party listings describe a **under-five-minute** demo requirement, but the official HackerEarth portal was not directly accessible through research.
4. Confirm submission eligibility, project release packaging, distribution path and valid evidence; release remains **NO-GO**. FT-064 authorizes only its completed historical GET, **not** follow-up reads or financial actions.

**No upload, push, external video publishing, or Airwallex provider mutation performed in FT-069.**
