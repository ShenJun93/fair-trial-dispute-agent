import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rootReal = await realpath(root);
const lists = [
  "submission/FT_RELEASE_HARDENING_025_ALLOWLIST.txt",
  "submission/FT_JUDGE_ACCEPTANCE_026_ALLOWLIST.txt",
  "submission/FT_JUDGE_ACCEPTANCE_026A_ALLOWLIST.txt",
];
const output = path.join(root, "out/ft-package-repair-026a/candidate");
const manifestPath = path.join(root, "out/ft-package-repair-026a/sha256-manifest.json");
const parseList = (content) => content.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
const entries = [];
for (const list of lists) entries.push(...parseList(await readFile(path.join(root, list), "utf8")));
const duplicates = entries.filter((entry, index) => entries.indexOf(entry) !== index);
if (duplicates.length) throw new Error("ALLOWLIST_DUPLICATE_PATH");
for (const entry of entries) {
  if (path.isAbsolute(entry) || entry.split(/[\\/]/).includes("..")) throw new Error("ALLOWLIST_PATH_INVALID");
  const source = path.resolve(root, entry);
  if (!source.startsWith(`${root}${path.sep}`)) throw new Error("ALLOWLIST_PATH_ESCAPE");
  const info = await lstat(source);
  const resolved = await realpath(source);
  if (!info.isFile() || info.isSymbolicLink() || !resolved.startsWith(`${rootReal}${path.sep}`)) throw new Error("ALLOWLIST_SOURCE_NOT_REGULAR_FILE");
}
try { await readdir(output); throw new Error("CANDIDATE_ALREADY_EXISTS"); }
catch (error) { if (error.code !== "ENOENT") throw error; }
await mkdir(output, { recursive: true });
const files = [];
for (const entry of entries) {
  const source = path.resolve(root, entry);
  const destination = path.join(output, entry);
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination);
  const [sourceBytes, candidateBytes] = await Promise.all([readFile(source), readFile(destination)]);
  const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
  const candidateHash = createHash("sha256").update(candidateBytes).digest("hex");
  if (sourceHash !== candidateHash) throw new Error("CANDIDATE_HASH_MISMATCH");
  files.push({ path: entry.replaceAll("\\", "/"), sha256: sourceHash });
}
const actual = [];
async function walk(dir, prefix = "") {
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const relative = path.posix.join(prefix, item.name);
    if (item.isDirectory()) await walk(path.join(dir, item.name), relative);
    else if (item.isFile()) actual.push(relative);
    else throw new Error("CANDIDATE_NON_REGULAR_ENTRY");
  }
}
await walk(output);
const expected = new Set(entries.map((entry) => entry.replaceAll("\\", "/")));
const actualSet = new Set(actual);
if (actual.length !== expected.size || [...expected].some((x) => !actualSet.has(x)) || actual.some((x) => !expected.has(x))) {
  throw new Error("CANDIDATE_FILE_SET_MISMATCH");
}
const manifest = { source: "FT-025 allowlist + FT-026 and FT-026A explicit additions", candidateRelativePath: "out/ft-package-repair-026a/candidate", fileCount: files.length, files };
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
console.log(JSON.stringify({ status: "PASS", candidate: manifest.candidateRelativePath, fileCount: files.length, missing: 0, duplicates: 0, unexpected: 0, manifest: "out/ft-package-repair-026a/sha256-manifest.json" }));
