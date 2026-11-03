import { DisputeReviewStore, type ReviewChoice } from "../spike/dispute-review-store.ts";

let input = "";
for await (const chunk of process.stdin) input += Buffer.from(chunk).toString("utf8");
const data = JSON.parse(input) as { path: string; sessionToken: string; caseId: string; choice: ReviewChoice; authorization: string; now: number };
if (!data.path || !data.sessionToken || !data.caseId || (data.choice !== "APPROVE" && data.choice !== "REJECT") || !data.authorization) process.exit(2);
const store = await DisputeReviewStore.open(data.path);
try { console.log(store.decide(data.sessionToken, data.caseId, data.choice, data.authorization, data.now)); }
catch (error) { console.log(error instanceof Error ? error.message : "REJECTED"); process.exitCode = 1; }
finally { store.close(); }
