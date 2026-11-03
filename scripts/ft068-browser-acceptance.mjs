import {createRequire} from "node:module";
import {randomBytes} from "node:crypto";
import {mkdtemp,mkdir,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {createServer as createNetServer} from "node:net";
import {DisputeReviewStore} from "../spike/dispute-review-store.ts";
import {createDisputeReviewServer} from "../spike/dispute-review-server.ts";
const require=createRequire(import.meta.url);
const {chromium}=(()=>{try{return require("playwright")}catch{return require(process.env.FT054_PLAYWRIGHT_MODULE??resolve(process.env.APPDATA??"","npm/node_modules/@playwright/cli/node_modules/playwright"))}})();
const dir=await mkdtemp(join(tmpdir(),"ft068-judge-ui-"));
const output=resolve("out/ft068-qa");await mkdir(output,{recursive:true});
const token=randomBytes(48).toString("base64url");
const actor="LOCAL\\ft067-judge-ui";
const now=Date.now();
let store,server,browser;
try{
 const finder=createNetServer();
 await new Promise((ok,reject)=>finder.once("error",reject).listen(0,"127.0.0.1",ok));
 const port=finder.address().port;
 await new Promise(ok=>finder.close(ok));
 const origin="http://127.0.0.1:"+port;
 store=await DisputeReviewStore.open(join(dir,"store.sqlite"),undefined,now);
 server=createDisputeReviewServer({store,operatorToken:token,actor,origin,providerMode:"MOCK",now:()=>now});
 await new Promise((ok,reject)=>server.once("error",reject).listen(port,"127.0.0.1",ok));
 browser=await chromium.launch({headless:true});
 const page=await browser.newPage({viewport:{width:1280,height:800}});
 const errors=[],external=[];
 page.on("pageerror",e=>errors.push(e.message.slice(0,250)));
 page.on("request",r=>{if(!r.url().startsWith(origin))external.push(r.url().split("?")[0])});
 await page.goto(origin,{waitUntil:"domcontentloaded",timeout:30000});
 const brief=page.locator("#judgeEvidenceBrief");
 if(await brief.isVisible())throw Error("FT068_BRIEF_LEAKS_BEFORE_AUTH");
 if(await page.locator("#judgeFlowNav").isVisible())throw Error("FT068_NAV_LEAKS_BEFORE_AUTH");
 await page.locator("#token").fill(token);
 await page.locator("#loginButton").click();
 await brief.waitFor({state:"visible",timeout:15000});
 const nav=page.locator("#judgeFlowNav");
 if(!await nav.isVisible())throw Error("FT068_NAV_NOT_VISIBLE");
 if(await page.locator("#judgeExplainLink").getAttribute("aria-disabled")!=="true")throw Error("FT068_EXPLAIN_PREMATURE");
 await page.locator("#judgeRunLink").click();
 if(await page.evaluate(()=>document.activeElement?.id)!=="agentPanel")throw Error("FT068_RUN_FOCUS");

 const summary=await brief.innerText();
 for(const phrase of ["The safe decision is HOLD.","HISTORICAL SNAPSHOT","NO LIVE REFRESH","Not verified","FT-064","No challenge or upload"])
  if(!summary.includes(phrase))throw Error("FT068_BRIEF_MISSING_"+phrase);
 if(!await page.locator("#runAgent").isEnabled())throw Error("FT068_AGENT_WORKFLOW_REGRESSED");
 await page.locator("#runAgent").click();
 await page.waitForFunction(() => {
  const t=document.querySelector("#agentSummary")?.textContent ?? "";
  return t.includes("Recommendation") && t.includes("HOLD");
 },{timeout:30000});
 if(await page.locator("#judgeExplainLink").getAttribute("aria-disabled")==="true")throw Error("FT068_EXPLAIN_NOT_ENABLED");
 await page.locator("#judgeExplainLink").click();
 if(await page.evaluate(()=>document.activeElement?.id)!=="agentSummary")throw Error("FT068_EXPLAIN_FOCUS");
 const agentSummary=await page.locator("#agentSummary").innerText();
 if(!agentSummary.includes("NOT EXECUTED") && !agentSummary.includes("NOT_EXECUTED"))
    throw Error("FT068_AGENT_PROVIDER_BOUNDARY_MISSING");
 await page.locator("#agentPanel").screenshot({path:join(output,"agent-provider-rfi-1280.png")});

 const viewports=[];
 for(const [width,height] of [[1280,800],[768,1024],[390,844]]){
  await page.setViewportSize({width,height});
  await brief.screenshot({path:join(output,"judge-brief-"+width+".png"),timeout:20000});
  if(width===390)await nav.screenshot({path:join(output,"judge-flow-390.png"),timeout:20000});
  if(width===1280||width===390){
   await page.evaluate(()=>scrollTo(0,0));
   await page.screenshot({path:join(output,"first-viewport-"+width+".png"),timeout:20000});
  }
  const metrics=await brief.evaluate(e=>({clientWidth:e.clientWidth,scrollWidth:e.scrollWidth,visible:e.getBoundingClientRect().height>0}));
  const navMetrics=await nav.evaluate(e=>({clientWidth:e.clientWidth,scrollWidth:e.scrollWidth}));
  if(navMetrics.scrollWidth>navMetrics.clientWidth+2)throw Error("FT068_NAV_OVERFLOW_"+width);
  if(metrics.scrollWidth>metrics.clientWidth+2||!metrics.visible)throw Error("FT068_BRIEF_OVERFLOW_"+width);
  viewports.push({width,height,...metrics});
 }
 if(errors.length||external.length)throw Error("FT068_BROWSER_CONSOLE_OR_NETWORK_ERROR");
 const result={schema:"FT068_JUDGE_EVIDENCE_UI_ACCEPTANCE_V1",status:"PASS",mode:"MOCK",
  hiddenBeforeAuthentication:true,visibleAfterAuthentication:true,
  receiptSnapshot:"2026-11-02T23:50:31.968Z",providerMutationCount:0,
  actualNetworkRequestsToAirwallex:0,viewports,errors,external};
 await writeFile(join(output,"ft067-acceptance.json"),JSON.stringify(result,null,2)+"\n");
 console.log(JSON.stringify(result));
}finally{
 if(browser)await browser.close();
 if(server)await new Promise(ok=>server.close(ok));
 if(store)store.close();
 await rm(dir,{recursive:true,force:true});
}
