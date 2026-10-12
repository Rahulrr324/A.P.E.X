#!/usr/bin/env python3
"""Frozen-30 G7 record integrity verification (read-only).

Verifies:
  - exactly 30 records present in build/g7-campaign
  - evidence_manifest.json record_count == 30
  - every record SHA256 matches the manifest entry
  - no missing records, no unexpected replacements
  - evidence_manifest.json itself matches its hash in sha256sums_g7_campaign.txt
"""
import hashlib
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
RECORD_DIR = os.path.join(ROOT, "build", "g7-campaign")
MANIFEST = os.path.join(ROOT, "reports", "g7-campaign", "evidence_manifest.json")
SUMS = os.path.join(ROOT, "reports", "sha256sums_g7_campaign.txt")

failures = []


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


with open(MANIFEST, "r", encoding="utf-8") as f:
    manifest = json.load(f)

count_field = manifest.get("record_count")
records = manifest.get("records", [])
print(f"manifest record_count = {count_field}")
print(f"manifest records list length = {len(records)}")
if count_field != 30:
    failures.append(f"manifest record_count is {count_field}, expected 30")
if len(records) != 30:
    failures.append(f"manifest records list length {len(records)} != 30")

# Files actually on disk
disk_files = sorted(fn for fn in os.listdir(RECORD_DIR) if fn.endswith(".json"))
print(f"records on disk = {len(disk_files)}")
if len(disk_files) != 30:
    failures.append(f"disk record count {len(disk_files)} != 30")

manifest_files = sorted(r["file"] for r in records)
missing = [f for f in manifest_files if f not in disk_files]
extra = [f for f in disk_files if f not in manifest_files]
if missing:
    failures.append(f"missing records: {missing}")
if extra:
    failures.append(f"unexpected extra records: {extra}")

# SHA check
ok = 0
for r in records:
    path = os.path.join(RECORD_DIR, r["file"])
    if not os.path.isfile(path):
        continue
    actual = sha256_file(path)
    if actual != r["sha256"]:
        failures.append(f"SHA MISMATCH {r['file']}: manifest={r['sha256']} actual={actual}")
    else:
        ok += 1
print(f"SHA matches: {ok}/{len(records)}")

# Manifest file's own hash vs the frozen sums file
manifest_sha = sha256_file(MANIFEST)
expected_manifest_sha = None
with open(SUMS, "r", encoding="utf-8") as f:
    for line in f:
        m = re.match(r"^([0-9a-f]{64}) \*(.+)$", line.strip())
        if m and m.group(2) == "reports/g7-campaign/evidence_manifest.json":
            expected_manifest_sha = m.group(1)
print(f"evidence_manifest.json sha actual   = {manifest_sha}")
print(f"evidence_manifest.json sha (frozen) = {expected_manifest_sha}")
if expected_manifest_sha is None:
    failures.append("no frozen hash for evidence_manifest.json in sha256sums_g7_campaign.txt")
elif expected_manifest_sha != manifest_sha:
    failures.append(
        "evidence_manifest.json hash CHANGED "
        f"(frozen={expected_manifest_sha} actual={manifest_sha})"
    )

print()
if failures:
    print("FROZEN RECORD VERIFICATION: FAILED")
    for fmsg in failures:
        print(f"  - {fmsg}")
    sys.exit(1)
print("FROZEN RECORD VERIFICATION: PASSED")
print("  - 30 records present")
print("  - manifest count = 30")
print("  - every SHA matches (30/30)")
print("  - no missing records")
print("  - no unexpected replacements")
print("  - evidence_manifest.json unchanged")
sys.exit(0)
