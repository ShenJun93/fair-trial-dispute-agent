import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rootReal = await realpath(root);
const baseList = path.join(root, "submission/FT_RELEASE_HARDENING_025_ALLOWLIST.txt");
const additionsList = path.join(root, "submission/FT_JUDGE_ACCEPTANCE_026_ALLOWLIST.txt");
const suffix = process.argv[2] ?? "final";
if (!/^(preflight|final)$/.test(suffix)) throw new Error("CANDIDATE_SUFFIX_INVALID");
const output = path.join(root, `out/ft-judge-acceptance-026/candidate-${suffix}`);
const manifestPath = path.join(root, `out/ft-judge-acceptance-026/sha256-manifest-${suffix}.json`);

const parseList = (content) => content.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
const base = parseList(await readFile(baseList, "utf8"));
const additions = parseList(await readFile(additionsList, "utf8"));
const duplicateBase = base.filter((entry, index) => base.indexOf(entry) !== index);
const duplicateAdditions = additions.filter((entry, index) => additions.indexOf(entry) !== index);
const inheritedDuplicates = additions.filter((entry) => base.includes(entry));
if (duplicateBase.length || duplicateAdditions.length || inheritedDuplicates.length) throw new Error("ALLOWLIST_DUPLICATE_PATH");
const entries = [...base, ...additions];
for (const entry of entries) {
  if (path.isAbsolute(entry) || entry.split(/[\\/]/).includes("..")) throw new Error("ALLOWLIST_PATH_INVALID");
  const source = path.resolve(root, entry);
  if (!source.startsWith(`${root}${path.sep}`)) throw new Error("ALLOWLIST_PATH_ESCAPE");
  const sourceInfo = await lstat(source);
  const resolvedSource = await realpath(source);
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink() || !resolvedSource.startsWith(`${rootReal}${path.sep}`)) throw new Error("ALLOWLIST_SOURCE_NOT_REGULAR_FILE");
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
  const [sourceBytes, destinationBytes] = await Promise.all([readFile(source), readFile(destination)]);
  const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
  const destinationHash = createHash("sha256").update(destinationBytes).digest("hex");
  if (sourceHash !== destinationHash) throw new Error("CANDIDATE_HASH_MISMATCH");
  files.push({ path: entry, sha256: sourceHash });
}

const candidateFiles = [];
async function walk(dir, prefix = "") {
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const relative = path.posix.join(prefix, item.name);
    const absolute = path.join(dir, item.name);
    if (item.isDirectory()) await walk(absolute, relative);
    else if (item.isFile()) candidateFiles.push(relative);
    else throw new Error("CANDIDATE_NON_REGULAR_ENTRY");
  }
}
await walk(output);
const expected = new Set(entries.map((entry) => entry.replaceAll("\\", "/")));
const actual = new Set(candidateFiles);
const missing = [...expected].filter((entry) => !actual.has(entry));
const unexpected = [...actual].filter((entry) => !expected.has(entry));
if (missing.length || unexpected.length || files.length !== expected.size) throw new Error("CANDIDATE_FILE_SET_MISMATCH");

const manifest = { source: "FT-025 allowlist + explicit FT-026 additions", candidateRelativePath: `out/ft-judge-acceptance-026/candidate-${suffix}`, fileCount: files.length, files };
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
console.log(JSON.stringify({ candidate: manifest.candidateRelativePath, files: files.length, hashMatches: files.length, missing: 0, unexpected: 0,
  manifest: path.relative(root, manifestPath).replaceAll("\\", "/") }, null, 2));
