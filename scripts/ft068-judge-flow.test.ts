import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const source=readFileSync(new URL("../spike/dispute-review-server.ts",import.meta.url),"utf8");
test("FT068 step navigation is session-gated and cannot explain before workflow",()=>{
 assert.match(source,/<nav id="judgeFlowNav"[^>]* hidden /);
 assert.match(source,/judgeFlowNav'\)\.hidden=document\.getElementById\('judgeEvidenceBrief'\)\.hidden/);
 assert.match(source,/id="judgeExplainLink" href="#agentSummary" aria-disabled="true"/);
 assert.match(source,/judgeExplainLink'\)\.removeAttribute\('aria-disabled'\)/);
});
test("FT068 walkthrough precedes legacy portfolio and preserves historical caveats",()=>{
 assert.ok(source.indexOf('<section id="agentPanel"')<source.indexOf('<section id="providerPortfolio"'));
 assert.match(source,/HISTORICAL · MOCK WORKFLOW · NO PROVIDER ACTION/);
 assert.match(source,/id="agentPanel" class="panel agent-panel"/);
});
