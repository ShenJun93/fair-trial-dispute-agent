from pathlib import Path
from hashlib import sha256
import json, sys, zipfile

default = Path(__file__).resolve().parents[1] / "out/ft-final-submission-031"
base = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else default
candidate, manifest_path, zip_path = base / "candidate", base / "sha256-manifest.json", base / "fair-trial-source-031.zip"
manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
if manifest.get("schemaVersion") != 1 or manifest.get("fileCount") != len(manifest.get("files", [])):
    raise SystemExit("FT031_MANIFEST_SCHEMA_INVALID")
for item in manifest["files"]:
    path = candidate / item["path"]
    if not path.is_file():
        raise SystemExit("FT031_MANIFEST_FILE_MISSING:" + item["path"])
    data = path.read_bytes()
    if len(data) != item["bytes"] or sha256(data).hexdigest() != item["sha256"]:
        raise SystemExit("FT031_MANIFEST_HASH_MISMATCH:" + item["path"])
with zipfile.ZipFile(zip_path) as archive:
    names, expected = sorted(archive.namelist()), sorted(item["path"] for item in manifest["files"])
    if names != expected:
        raise SystemExit("FT031_ZIP_MANIFEST_FILESET_MISMATCH")
    for item in manifest["files"]:
        data = archive.read(item["path"])
        if len(data) != item["bytes"] or sha256(data).hexdigest() != item["sha256"]:
            raise SystemExit("FT031_ZIP_HASH_MISMATCH:" + item["path"])
print(json.dumps({"status": "PASS", "manifest": str(manifest_path), "fileCount": len(manifest["files"]),
    "hashMismatches": 0, "zipFiles": len(names), "zipHashMismatches": 0}, indent=2))
