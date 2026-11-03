import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer as createNetServer } from "node:net";
import { DisputeReviewStore } from "../spike/dispute-review-store.ts";
import { createDisputeReviewServer } from "../spike/dispute-review-server.ts";
const require = createRequire(import.meta.url);
const { chromium } = (()=>{ try{return require("playwright")}catch{return require(process.env.FT054_PLAYWRIGHT_MODULE ?? resolve(process.env.APPDATA ?? "", "npm/node_modules/@playwright/cli/node_modules/playwright"))} })();
const dir = await mkdtemp(join(tmpdir(), "ft054-ui-"));
const qa = resolve("out/ft054-qa");
await mkdir(qa,{recursive:true});
const token = randomBytes(48).toString("base64url");
const actor = "LOCAL\\ft054-browser-review";
const now = Date.now();
let store, server, browser;
try {
  const finder = createNetServer();
  await new Promise((ok,reject)=>finder.once("error",reject).listen(0,"127.0.0.1",ok));
  const port = finder.address().port;
  await new Promise(ok=>finder.close(ok));
  const origin = "http://127.0.0.1:"+port;
  store = await DisputeReviewStore.open(join(dir,"review.sqlite"),undefined,now);
  server = createDisputeReviewServer({store,operatorToken:token,actor,origin,providerMode:"MOCK",now:()=>now});
  await new Promise((ok,reject)=>server.once("error",reject).listen(port,"127.0.0.1",ok));
  browser = await chromium.launch({headless:true});
  const page = await browser.newPage({viewport:{width:1280,height:800}});
  const errors=[], external=[];
  page.on("pageerror",error=>errors.push(error.message.slice(0,180)));
  page.on("console",msg=>{if(msg.type()==="error"&&!msg.text().includes("status of 401"))errors.push(msg.text().slice(0,180))});
  page.on("request",req=>{if(!req.url().startsWith(origin))external.push(req.url().split("?")[0])});
  await page.goto(origin,{waitUntil:"domcontentloaded",timeout:30000});
  await page.locator("#token").fill(token);
  await page.locator("#loginButton").click();
  await page.locator(".portfolio-case").first().waitFor({timeout:15000});
  const names = await page.locator(".portfolio-case-head strong").allTextContents();
  const statuses = await page.locator(".portfolio-case-state").allTextContents();
  const fullText = await page.locator("#providerPortfolio").innerText();
  if(names.length!==2 || statuses.join("|")!=="REQUIRES_RESPONSE|ACCEPTED" ||
    !fullText.includes("request evidence (offline)") ||
    !fullText.includes("Separately owner-executed") ||
    !fullText.includes("No agent has submitted"))throw Error("FT054_UI_EVIDENCE_MISMATCH");
  const viewports=[];
  for(const [width,height] of [[1280,800],[768,1024],[390,844]]){
    await page.setViewportSize({width,height});
    await page.locator("#providerPortfolio").screenshot({path:join(qa,"portfolio-"+width+".png"),timeout:20000});
    const metrics=await page.locator("#providerPortfolio").evaluate(el=>({w:el.clientWidth,scroll:el.scrollWidth}));
    viewports.push({width,height,visible:true,localOverflow:metrics.scroll>metrics.w+2});
  }
  if(errors.length || external.length || viewports.some(x=>!x.visible||x.localOverflow)){console.error("QA_DIAGNOSTICS",JSON.stringify({errors,external,viewports}));throw Error("FT054_BROWSER_ACCEPTANCE_FAILED");}
  const result = {schema:"FT054_BROWSER_ACCEPTANCE_V1",status:"PASS",providerMode:"MOCK",
    screenshots:viewports.map(x=>"portfolio-"+x.width+".png"),cases:names,statuses,
    viewports,consoleErrors:errors,externalRequests:external,providerAction:"NOT_EXECUTED",
    authentication:"GENERATED_EPHEMERAL_TOKEN_NOT_RECORDED"};
  await writeFile(join(qa,"browser-acceptance.json"),JSON.stringify(result,null,2)+"\n");
  console.log(JSON.stringify(result));
} finally {
  if(browser)await browser.close();
  if(server)await new Promise(resolve=>server.close(resolve));
  if(store)store.close();
  await rm(dir,{recursive:true,force:true});
}
