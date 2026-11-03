import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  AirwallexClient,
  AirwallexError,
  DEFAULT_BASE,
  DEFAULT_FILES_BASE,
  loadConfig,
  type AirwallexDiagnosticMetadata,
  type Config,
  type TraceEntry,
} from "./airwallex.ts";
import {
  AirwallexDisputeReadTransport,
  createDisputeReadAdapter,
  DisputeReadError,
} from "../spike/dispute-read-adapter.ts";

export const READONLY_CONFIRM_ENV = "FT_AIRWALLEX_READONLY_CONFIRM";
export const READONLY_ACTOR_ENV = "FT_AIRWALLEX_READONLY_ACTOR";
export const READONLY_APPROVAL_ENV = "FT_AIRWALLEX_READONLY_APPROVAL";

export interface ReadonlyProbeReceipt {
  task: "FT-G1A-001";
  outcome: "VERIFIED" | "FAILED";
  environment: "sandbox";
  baseHost: "api.sandbox.airwallex.com";
  request: "GET /api/v1/pa/payment_disputes?page=0&size=1";
  startedAtUtc: string;
  finishedAtUtc: string;
  elapsedMs: number;
  authentication: { attempted: boolean; httpStatus?: number; responseReceived?: boolean };
  disputeList: {
    attempted: boolean;
    httpStatus?: number;
    responseReceived?: boolean;
    schemaValidated: boolean;
    returnedItemCount?: number;
  };
  providerOperations: readonly SafeOperation[];
  providerMutationCount: 0;
  failure?: { stage: string; category: string; httpStatus?: number };
}

interface SafeOperation {
  operation: "AUTHENTICATION_LOGIN" | "DISPUTE_LIST_GET";
  method: "POST" | "GET";
  at: string;
  elapsedMs?: number;
  httpStatus?: number;
  responseReceived?: boolean;
  diagnostic?: AirwallexDiagnosticMetadata;
}

const authPath = "/api/v1/authentication/login";
const listPath = "/api/v1/pa/payment_disputes";

function summarizeOperations(trace: readonly TraceEntry[]): SafeOperation[] | undefined {
  const safe: SafeOperation[] = [];
  for (const entry of trace) {
    let url: URL;
    try { url = new URL(entry.url); } catch { return undefined; }
    if (url.origin !== DEFAULT_BASE || url.search || url.hash) return undefined;
    const operation = entry.method === "POST" && url.pathname === authPath
      ? "AUTHENTICATION_LOGIN"
      : entry.method === "GET" && url.pathname === listPath
        ? "DISPUTE_LIST_GET"
        : undefined;
    if (!operation) return undefined;
    safe.push({
      operation,
      method: operation === "AUTHENTICATION_LOGIN" ? "POST" : "GET",
      at: entry.at,
      ...(entry.ms === undefined ? {} : { elapsedMs: entry.ms }),
      ...(entry.status === undefined ? {} : { httpStatus: entry.status }),
      ...(entry.response_received === undefined ? {} : { responseReceived: entry.response_received }),
      ...(entry.diagnostic === undefined ? {} : { diagnostic: entry.diagnostic }),
    });
  }
  return safe;
}

function safeFailure(error: unknown): { stage: string; category: string; httpStatus?: number } {
  if (error instanceof DisputeReadError) {
    return {
      stage: error.diagnostic?.stage ?? "ADAPTER",
      category: error.diagnostic?.errorCategory ?? error.code,
      ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }),
    };
  }
  if (error instanceof AirwallexError) {
    return {
      stage: error.diagnostic?.stage ?? "UNKNOWN",
      category: error.diagnostic?.errorCategory ?? "AIRWALLEX_ERROR",
      ...(error.status === undefined ? {} : { httpStatus: error.status }),
    };
  }
  return { stage: "CONFIG_OR_PROBE", category: "PROBE_FAILED" };
}

function assertProbeConfig(config: Config): void {
  if (config.dryRun) throw new Error("DRY_RUN_REFUSED");
  if (!config.clientId || !config.apiKey) throw new Error("CREDENTIALS_MISSING");
  if (config.base !== DEFAULT_BASE || config.filesBase !== DEFAULT_FILES_BASE) throw new Error("SANDBOX_ORIGIN_MISMATCH");
}

/** One authenticated sandbox dispute-list read through the existing GET-only adapter. */
export async function runAirwallexReadonlyProbe(
  config: Config,
  authorization: { actor: string; approvalReference: string },
  now: () => Date = () => new Date(),
): Promise<ReadonlyProbeReceipt> {
  const started = now();
  let client: AirwallexClient | undefined;
  let page: Awaited<ReturnType<ReturnType<typeof createDisputeReadAdapter>["listPage"]>> | undefined;
  let error: unknown;
  try {
    assertProbeConfig(config);
    if (!authorization.actor.trim() || !authorization.approvalReference.trim()) throw new Error("READONLY_AUTHORIZATION_REQUIRED");
    client = new AirwallexClient(config);
    const adapter = createDisputeReadAdapter("LIVE_READONLY", {
      transport: new AirwallexDisputeReadTransport(client),
      authorization: {
        explicitlyConfigured: true,
        approvalReference: authorization.approvalReference,
        actor: authorization.actor,
        authorizedAt: started.getTime(),
        expiresAt: started.getTime() + 60_000,
      },
    });
    page = await adapter.listPage({ page: "0", size: 1 });
  } catch (caught) {
    error = caught;
  }

  const operations = client ? summarizeOperations(client.trace) : [];
  const exactReadShape = operations !== undefined &&
    (operations.length === 1 && operations[0]?.operation === "AUTHENTICATION_LOGIN" ||
      operations.length === 2 && operations[0]?.operation === "AUTHENTICATION_LOGIN" && operations[1]?.operation === "DISPUTE_LIST_GET");
  if (!exactReadShape && error === undefined) error = new Error("UNEXPECTED_PROVIDER_OPERATION_SHAPE");

  const auth = operations?.find((item) => item.operation === "AUTHENTICATION_LOGIN");
  const list = operations?.find((item) => item.operation === "DISPUTE_LIST_GET");
  const finished = now();
  const verified = error === undefined && page?.origin === "AIRWALLEX" && list?.httpStatus === 200;
  return {
    task: "FT-G1A-001",
    outcome: verified ? "VERIFIED" : "FAILED",
    environment: "sandbox",
    baseHost: "api.sandbox.airwallex.com",
    request: "GET /api/v1/pa/payment_disputes?page=0&size=1",
    startedAtUtc: started.toISOString(),
    finishedAtUtc: finished.toISOString(),
    elapsedMs: Math.max(0, finished.getTime() - started.getTime()),
    authentication: {
      attempted: auth !== undefined,
      ...(auth?.httpStatus === undefined ? {} : { httpStatus: auth.httpStatus }),
      ...(auth?.responseReceived === undefined ? {} : { responseReceived: auth.responseReceived }),
    },
    disputeList: {
      attempted: list !== undefined,
      ...(list?.httpStatus === undefined ? {} : { httpStatus: list.httpStatus }),
      ...(list?.responseReceived === undefined ? {} : { responseReceived: list.responseReceived }),
      schemaValidated: verified,
      ...(verified && page ? { returnedItemCount: page.items.length } : {}),
    },
    providerOperations: operations ?? [],
    providerMutationCount: 0,
    ...(error === undefined ? {} : { failure: safeFailure(error) }),
  };
}

function writeReceipt(receipt: ReadonlyProbeReceipt): string {
  const directory = resolve(process.cwd(), "submission/evidence");
  mkdirSync(directory, { recursive: true });
  const stamp = receipt.startedAtUtc.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const path = resolve(directory, `airwallex-readonly-${stamp}-${randomUUID()}.json`);
  writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  return path;
}

export async function main(): Promise<void> {
  if (process.env[READONLY_CONFIRM_ENV] !== "YES") {
    console.error(`Refused: set ${READONLY_CONFIRM_ENV}=YES in the reviewed host PowerShell session.`);
    process.exitCode = 2;
    return;
  }
  const actor = process.env[READONLY_ACTOR_ENV] ?? "";
  const approvalReference = process.env[READONLY_APPROVAL_ENV] ?? "";
  if (!actor.trim() || !approvalReference.trim()) {
    console.error(`Refused: set ${READONLY_ACTOR_ENV} and ${READONLY_APPROVAL_ENV}.`);
    process.exitCode = 2;
    return;
  }

  let config: Config;
  try { config = loadConfig(); }
  catch {
    console.error("Probe refused: configuration is missing or not sandbox-only. No provider request was sent.");
    process.exitCode = 2;
    return;
  }

  const receipt = await runAirwallexReadonlyProbe(config, { actor, approvalReference });
  try {
    const evidencePath = writeReceipt(receipt);
    console.log(JSON.stringify({ ...receipt, evidencePath }, null, 2));
  } catch {
    console.log(JSON.stringify(receipt, null, 2));
    console.error("Sanitized receipt could not be saved; preserve the console output securely.");
  }
  if (receipt.outcome !== "VERIFIED") process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch(() => {
    console.error("Probe failed unexpectedly. No exception details were emitted.");
    process.exitCode = 1;
  });
}
