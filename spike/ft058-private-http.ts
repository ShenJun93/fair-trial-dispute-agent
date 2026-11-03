/**
 * FT058 private HTTP boundary / explicit dependency injection.
 * No default fetch, credential reader, OAuth login, CLI, environment lookup,
 * or runtime wiring. MUST NOT be connected to the real network before
 * separate one-shot approval, evidence review and independent security review.
 *
 * Docs: Airwallex API access token, Payment Disputes and Versioning.
 */
import type { AuthenticatedSandboxPort, HttpReply, HttpRequest } from "./ft057-sandbox-boundary.ts";

const ORIGIN="https://api.sandbox.airwallex.com";
const API_VERSION="2026-06-30"; // Dispute API schema reviewed at this version; revalidate before activation.
const route=/^\/api\/v1\/pa\/payment_disputes\/[A-Za-z0-9][A-Za-z0-9_-]{5,127}(?:\/challenge)?$/;
type HeadersMap=Record<string,string>;
export interface NetworkReply {
  readonly ok:boolean;
  readonly status:number;
  readonly headers:{get(name:string):string|null};
  text():Promise<string>;
}
export interface HttpCall{
  method:"GET"|"POST";
  headers:HeadersMap;
  body?:string;
  redirect:"error";
  cache:"no-store";
  signal:AbortSignal;
}
export type InjectedFetch=(url:string,init:Readonly<HttpCall>)=>Promise<NetworkReply>;
export interface SessionBearer{
  value:string;
  expiresAt:number; // epoch milliseconds
  // A token scoped to another merchant must never be used.
  accountBinding:"INDEPENDENTLY_VERIFIED_SANDBOX_ACCOUNT";
}
export interface PrivatePortConfig{
  injectedFetch:InjectedFetch;
  getVerifiedBearer():Promise<SessionBearer|null>;
  now():number;
  maxResponseBytes?:number;
  timeoutMs?:number;
  /** No default: runtime integration must supply and review all capabilities. */
}
export function buildPrivateSandboxPort(cfg:PrivatePortConfig):AuthenticatedSandboxPort{
  if(!cfg||typeof cfg.injectedFetch!=="function"||
     typeof cfg.getVerifiedBearer!=="function"||typeof cfg.now!=="function")
    throw Error("FT058_PRIVATE_CAPABILITIES_REQUIRED");
  const maxBytes=cfg.maxResponseBytes??128*1024,timeout=cfg.timeoutMs??9000;
  if(!Number.isSafeInteger(maxBytes)||maxBytes<1024||maxBytes>1024*1024||
     !Number.isSafeInteger(timeout)||timeout<100||timeout>15_000)
    throw Error("FT058_BOUNDARY_LIMITS_INVALID");
  return Object.freeze({
    environment:"AIRWALLEX_SANDBOX" as const,
    async send(req:Readonly<HttpRequest>):Promise<HttpReply>{
      if(!req||req.retry!==false||!route.test(req.path)||
         (req.method!=="GET"&&req.method!=="POST")||
         (req.method==="GET"&&(req.path.endsWith("/challenge")||req.body!==undefined))||
         (req.method==="POST"&&(!req.path.endsWith("/challenge")||!req.body)))
        throw Error("FT058_OPERATION_NOT_ALLOWLISTED");
      if(req.method==="POST"){
        const b=req.body;
        if(!b||b.challenge_method!=="STANDARD"||
           typeof b.request_id!=="string"||
           !/^[0-9a-fA-F-]{36}$/.test(b.request_id) ||
           !b.supporting_documents?.documents?.length)
          throw Error("FT058_CHALLENGE_BODY_INVALID");
      }
      const now=cfg.now();
      if(!Number.isSafeInteger(now))throw Error("FT058_CLOCK_INVALID");
      const bearer=await cfg.getVerifiedBearer();
      if(!bearer||bearer.accountBinding!=="INDEPENDENTLY_VERIFIED_SANDBOX_ACCOUNT"||
         typeof bearer.value!=="string"||bearer.value.length<16||
         /[\s\r\n]/.test(bearer.value)||!Number.isSafeInteger(bearer.expiresAt)||
         bearer.expiresAt-now<=60_000)
        throw Error("FT058_VERIFIED_BEARER_UNAVAILABLE");
      const headers:HeadersMap={
        "authorization":"Bearer "+bearer.value,
        "x-api-version":API_VERSION,
        "accept":"application/json",
        "content-type":"application/json",
      };
      const init:HttpCall={
        method:req.method,headers,
        redirect:"error",cache:"no-store",
        signal:AbortSignal.timeout(timeout),
        ...(req.method==="POST"?{body:JSON.stringify(req.body)}:{})
      };
      // No retry even for 429, 5xx, or timeout; upstream journal must reconcile.
      const response=await cfg.injectedFetch(ORIGIN+req.path,init);
      if(!response||!Number.isInteger(response.status)||response.status<100||response.status>599 ||
         typeof response.text!=="function"||typeof response.headers?.get!=="function")
        throw Error("FT058_INVALID_TRANSPORT_RESPONSE");
      const length=Number(response.headers.get("content-length"));
      if(Number.isFinite(length)&&length>maxBytes)throw Error("FT058_RESPONSE_TOO_LARGE");
      const text=await response.text();
      if(Buffer.byteLength(text,"utf8")>maxBytes)throw Error("FT058_RESPONSE_TOO_LARGE");
      if(response.status===204 && text==="")return {status:204,body:{}};
      let parsed:unknown;
      try{parsed=JSON.parse(text)}catch{throw Error("FT058_INVALID_JSON_RESPONSE")}
      if(!parsed||typeof parsed!=="object"||Array.isArray(parsed))throw Error("FT058_INVALID_JSON_RESPONSE");
      return {status:response.status,body:parsed};
    }
  });
}
export const FT058_SANDBOX_ORIGIN_FOR_TEST_ASSERTION=ORIGIN;
export const FT058_API_SCHEMA_VERSION=API_VERSION;
