import assert from "node:assert/strict";
import test from "node:test";
import { createApplicationSourceSpanAnchors, enrichAnchoredModelProposals } from "../spike/evidence-proposals.ts";
import { ingestOfflineTextEvidence } from "../spike/dispute-evidence.ts";

const quote = "The enrolled device matches the account profile and the 3DS authentication succeeded.";
const at = "2030-01-01T00:00:00.000Z";

test("application-owned span IDs distinguish repeated exact text without granting duplicate weight", () => {
  const document = ingestOfflineTextEvidence("anchor-case", "duplicate-source", `${quote}\n${quote}`, at);
  const anchors = createApplicationSourceSpanAnchors(document);
  assert.equal(anchors.length, 2);
  assert.notEqual(anchors[0]!.anchorId, anchors[1]!.anchorId);
  const result = enrichAnchoredModelProposals([
    { factType: "DEVICE_AND_3DS_MATCH", exactQuote: quote, sourceSpanId: anchors[1]!.anchorId },
    { factType: "DEVICE_AND_3DS_MATCH", exactQuote: quote, sourceSpanId: anchors[0]!.anchorId },
  ], document, "OFFLINE_ANCHOR_TEST", at);
  assert.equal(result.proposals.length, 1);
  assert.equal(result.proposals[0]!.groundingReasonCode, "GROUNDED");
  assert.equal(result.proposals[0]!.proposal.startOffset, quote.length + 1);
  assert.equal(result.duplicateClaimsSuppressed, 1);
});

test("span anchors fail closed on forged IDs and do not bypass document contradiction checks", () => {
  const document = ingestOfflineTextEvidence("anchor-case", "contradictory-source",
    `${quote}\nThe device fingerprint belongs to a different account.`, at);
  const anchors = createApplicationSourceSpanAnchors(document);
  const forged = enrichAnchoredModelProposals([{ factType: "DEVICE_AND_3DS_MATCH", exactQuote: quote, sourceSpanId: "span-forged" }], document, "TEST", at);
  assert.equal(forged.proposals[0]!.groundingReasonCode, "INVALID_SOURCE_SPAN_ANCHOR");
  const valid = enrichAnchoredModelProposals([{ factType: "DEVICE_AND_3DS_MATCH", exactQuote: quote, sourceSpanId: anchors[0]!.anchorId }], document, "TEST", at);
  assert.equal(valid.proposals[0]!.groundingReasonCode, "CONTRADICTORY_SOURCE");
});
