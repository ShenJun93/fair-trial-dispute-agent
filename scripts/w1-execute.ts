import { randomBytes } from "node:crypto";
import { lstatSync } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AirwallexClient, loadConfig } from "../src/airwallex.ts";
import { acceptFreshBindingReceipt, createAirwallexW1Provider, runW1Once, W1Journal } from "./w1-safe-path.ts";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const journalPath = resolve(repositoryRoot, "out", "w1-journal.sqlite");
const outPath = resolve(repositoryRoot, "out");
const verifierPath = resolve(repositoryRoot, "scripts/verify-w1-account-binding.local.ps1");

/** Run the interactive verifier while forwarding each prompt immediately to the local operator. */
export async function runVisibleAccountVerifier(challenge: string): Promise<Record<string, unknown>> {
  const child = spawn("pwsh.exe", ["-NoProfile", "-File", verifierPath], {
    cwd: repositoryRoot, windowsHide: false,
    stdio: ["inherit", "pipe", "inherit"],
    env: { ...process.env, FT_W1_BINDING_CHALLENGE: challenge,
      FT_W1_BINDING_CONFIG_PATH: process.env.FT_W1_BINDING_CONFIG_PATH ?? resolve(repositoryRoot, ".env.local") },
  });
  let output = "";
  let outputOverflow = false;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    if (!outputOverflow) {
      output += chunk;
      if (Buffer.byteLength(output, "utf8") > 256 * 1024) {
        outputOverflow = true;
        child.kill();
      }
    }
    // PowerShell verifier output contains visible prompts and a sanitized receipt only.
    process.stdout.write(chunk);
  });
  const [code] = await once(child, "close") as [number | null, NodeJS.Signals | null];
  if (code !== 0 || outputOverflow) throw new Error("FRESH_LOCAL_ACCOUNT_VERIFICATION_FAILED");
  const lines = output.trim().split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed: unknown = JSON.parse(lines[i]!);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch { /* Continue past the interactive prompt transcript. */ }
  }
  throw new Error("ACCOUNT_RECEIPT_INVALID");
}

/** Authentication is intentionally before opening the journal or committing its permanent dispatch fence. */
export async function withW1AuthenticationPreflight<T>(authenticate: () => Promise<unknown>, dispatch: () => Promise<T>): Promise<T> {
  await authenticate();
  return dispatch();
}

function assertFreshJournalPath(): void {
  try {
    const out = lstatSync(outPath);
    if (out.isSymbolicLink() || !out.isDirectory()) throw new Error("W1_OUT_DIRECTORY_UNSAFE");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  try {
    lstatSync(journalPath);
    throw new Error("W1_JOURNAL_ALREADY_EXISTS");
  } catch (error) {
    if (error instanceof Error && error.message === "W1_JOURNAL_ALREADY_EXISTS") throw error;
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}

/** Narrow one-shot entrypoint. It has no W2/W3/W4 calls and requires a fresh local account comparison. */
export async function executeOneW1(argv = process.argv.slice(2)): Promise<number> {
  if (argv.length !== 1 || argv[0] !== "--execute-once") {
    console.error("Usage: npm run w1:execute -- --execute-once (fresh interactive account verification required)");
    return 2;
  }
  let journal: W1Journal | undefined;
  try {
    if (resolve(process.cwd()) !== repositoryRoot) throw new Error("W1_REPOSITORY_ROOT_REQUIRED");
    assertFreshJournalPath();
    const config = loadConfig([]);
    if (config.dryRun || config.base !== "https://api.sandbox.airwallex.com") throw new Error("SANDBOX_CONFIG_REQUIRED");
    const challenge = randomBytes(24).toString("base64url");
    const receipt = await runVisibleAccountVerifier(challenge);
    const binding = acceptFreshBindingReceipt({ receipt, challenge, currentClientId: config.clientId,
      currentTargetAccountId: config.loginAsTarget });
    const client = new AirwallexClient(config);
    const result = await withW1AuthenticationPreflight(
      () => client.login(false, true),
      async () => {
        const provider = createAirwallexW1Provider(client);
        assertFreshJournalPath();
        journal = await W1Journal.open(journalPath);
        return runW1Once({ mode: "LIVE", provider, journal, accountBinding: binding });
      },
    );
    console.log(JSON.stringify({ mode: result.mode, phase: result.phase, postCount: result.postCount,
      retrieveCount: result.retrieveCount, retryCount: result.retryCount, httpStatus: result.httpStatus,
      retrieveHttpStatus: result.retrieveHttpStatus, intentFingerprint: result.intentFingerprint, reason: result.reason }));
    return result.phase === "READBACK_VERIFIED" ? 0 : 3;
  } catch (error) {
    const code = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : "W1_STOPPED_FAIL_CLOSED";
    console.error(JSON.stringify({ mode: "LIVE", phase: "BLOCKED", code, providerActions: "W1_CREATE_AND_GET_ONLY" }));
    return 3;
  } finally { journal?.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await executeOneW1();
}
