/**
 * FT067 — Judge-first read-only Visa 10.4 evidence brief.
 * Pinned solely to the owner-approved FT064 sanitized provider receipt.
 * Static product storytelling, NOT a live provider refresh or authorization.
 */
export const FT067_PROVIDER_RECEIPT_SHA256 =
  "98f5a627cf2b2d3a16875652a37b7856f2be2f7927c5ca4e882659460c891909";
export const FT067_PROVIDER_OBSERVED_UTC = "2026-11-02T23:50:31.968Z";
export const FT067_PROVIDER_DEADLINE_UTC = "2026-11-09T05:55:12.000Z";
export const FT067_CASE_FINGERPRINT16 = "89fa24ab5b2cae89";

export function judgeEvidenceBriefHtml(): string {
  return `<section id="judgeEvidenceBrief" hidden class="panel judge-brief" aria-labelledby="judgeBriefTitle">
  <div class="judge-brief-top">
    <span class="eyebrow">JUDGE BRIEF · SANDBOX CASE READBACK</span>
    <span class="judge-brief-snapshot">Verified 03 Nov 2026, 06:50 ICT · HISTORICAL SNAPSHOT</span>
  </div>
  <div class="judge-brief-lead">
    <div>
      <p class="judge-brief-category">VISA 10.4 · USD 120 · RFI</p>
      <h2 id="judgeBriefTitle">The safe decision is HOLD.</h2>
      <p>Airwallex confirms this sandbox dispute was <strong>REQUIRES_RESPONSE</strong> at the recorded GET. Fair Trial does not present a test transaction as genuine customer evidence.</p>
    </div>
    <div class="judge-brief-decision" aria-label="Application policy result">
      <span>APPLICATION DECISION</span>
      <strong>HOLD</strong>
      <small>Not a provider status</small>
    </div>
  </div>
  <ol class="judge-brief-chain" aria-label="Provider-to-decision evidence chain">
    <li><span>01 · PROVIDER</span><strong>Payment verified</strong><small>FT-048 · test Visa transaction</small></li>
    <li><span>02 · PROVIDER</span><strong>Dispute created</strong><small>FT-049 · simulated RFI</small></li>
    <li><span>03 · READ-ONLY</span><strong>Identity matched</strong><small>FT-064 · HTTP 200 detail GET</small></li>
    <li><span>04 · POLICY</span><strong>Action blocked</strong><small>No challenge or upload</small></li>
  </ol>
  <div class="judge-brief-columns">
    <section aria-label="Confirmed from Sandbox">
      <h3>Verified by provider</h3>
      <p>Visa 10.4 · FRAUDULENT; USD 120; RFI / REQUIRES_RESPONSE at the recorded GET. The dispute and payment IDs matched pinned historical fingerprints.</p>
    </section>
    <section aria-label="Evidence provenance gaps">
      <h3>Not verified</h3>
      <p>Genuine merchant order, cardholder 3DS/device history, fulfillment, and Airwallex File Service evidence IDs. Demo material is synthetic, not merchant proof.</p>
    </section>
    <section aria-label="Next safe action">
      <h3>Next safe action</h3>
      <p>Review the FT-066 synthetic packet offline (NOT FOR UPLOAD). Obtain a fresh, separately authorized pre-challenge GET and a distinct action approval only after evidence verification.</p>
    </section>
  </div>
  <p class="judge-brief-proof">SOURCE · FT-064 SANITIZED GET · 2026-11-02 23:50 UTC · SHA-256 98f5a627cf2b2d3a… · Due at snapshot: 09 Nov 2026, 05:55 UTC. <strong>NO LIVE REFRESH · NO PROVIDER MUTATION · NO ISSUER OUTCOME.</strong></p>
  </section>`;
}
