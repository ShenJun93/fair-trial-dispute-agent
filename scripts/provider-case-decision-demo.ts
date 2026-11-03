import { exportDecisionArtifacts } from "../spike/provider-case-review.ts";

const result = await exportDecisionArtifacts();
if (result.trace.providerAction !== "NOT_EXECUTED" || result.differential.providerAction !== "NOT_EXECUTED") {
  throw new Error("PROVIDER_ACTION_BOUNDARY_BROKEN");
}
console.log(JSON.stringify({
  mode: "OFFLINE_SAVED_RECEIPTS",
  policy: result.trace.policy,
  decision: result.trace.decision,
  reasonCount: result.trace.reasons.length,
  providerAction: result.trace.providerAction,
  sourceReceiptCount: result.trace.provenance.length,
  syntheticDifferential: {
    label: result.differential.label,
    newlyAddedReasons: result.differential.newlyAddedReasons,
    removedReasons: result.differential.removedReasons,
    providerAction: result.differential.providerAction,
  },
  outputs: [
    result.tracePath.replaceAll("\\", "/").split("/").slice(-2).join("/"),
    result.differentialPath.replaceAll("\\", "/").split("/").slice(-2).join("/"),
  ],
}, null, 2));
