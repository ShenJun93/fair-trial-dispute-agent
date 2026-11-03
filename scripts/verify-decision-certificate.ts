import { readFileSync } from "node:fs";
import { verifyDecisionCertificate } from "../spike/decision-certificate.ts";

const [, , file, ...args] = process.argv;
const anchorArg = args.indexOf("--anchor");
const revisionArg = args.indexOf("--revision");
try {
  if (!file) throw new Error("CERTIFICATE_PATH_REQUIRED");
  const input = JSON.parse(readFileSync(file, "utf8")) as unknown;
  const result = verifyDecisionCertificate(input,
    revisionArg >= 0 ? Number(args[revisionArg + 1]) : undefined,
    anchorArg >= 0 ? args[anchorArg + 1] : undefined);
  console.log(JSON.stringify(result));
  if (!result.ok) process.exitCode = 1;
} catch (error) {
  console.log(JSON.stringify({ ok: false, reasonCodes: [error instanceof Error ? error.message : "MALFORMED_CERTIFICATE"] }));
  process.exitCode = 1;
}
