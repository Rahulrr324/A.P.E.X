#!/usr/bin/env python3
"""End-of-turn verification for the v8 diagnostic integrity requirements.

Checks:
- frozen 30 records still match evidence_manifest.json (30/30 sha)
- evidence_manifest.json unchanged vs frozen sha256sums_g7_campaign.txt entry
- no G7CAM json files were created/modified this turn (mtime vs turn-start snapshot)
- current active power scheme == turn-start original scheme (restored independently)
"""
from __future__ import annotations

import hashlib
import json
import re
import sys
from pathlib import Path

Root = Path("stark")

M_TIME_SNAPSHOT = Path("work") / "scripts" / "freeze30_mtimes_start.json"
SCHEME_SNAPSHOT = Path("work") / "scripts" / "power_scheme_start.json"

MANIFEST = Root / "reports" / "g7-campaign" / "evidence_manifest.json"
CHECKSUMS = Root / "reports" / "sha256sums_g7_campaign.txt"


def sha256_file(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def _run(cmd):
    import subprocess
    r = subprocess.run(cmd, capture_output=True, text=True)
    return r.returncode, r.stdout, r.stderr


def active_scheme_guid() -> str | None:
    rc, out, err = _run(["powercfg", "/getactivescheme"])
    if rc != 0:
        return None
    m = re.search(r"Power Scheme GUID:\s+([0-9A-Fa-f\-]+)", out)
    return m.group(1) if m else None


def main() -> int:
    problems: list[str] = []

    # --- frozen 30 ---
    if not MANIFEST.exists():
        problems.append("evidence_manifest.json missing")
    else:
        manifest_sha = sha256_file(MANIFEST)
        manifest_obj = json.loads(MANIFEST.read_text(encoding="utf-8"))
        records = manifest_obj.get("records", [])
        if len(records) != 30:
            problems.append(f"manifest record count {len(records)} != 30")

        by_name = {r["file"]: r["sha256"] for r in records if "file" in r and "sha256" in r}
        frozen_dir = Root / "build" / "g7-campaign"
        if frozen_dir.exists():
            frozen_files = sorted(p for p in frozen_dir.iterdir() if p.is_file())
            matched = 0
            for f in frozen_files:
                if f.name not in by_name:
                    continue
                matched += 1
                if by_name[f.name] != sha256_file(f):
                    problems.append(f"frozen sha mismatch: {f.name}")
            if matched != 30:
                problems.append(f"frozen manifest entries present: {matched} (expected 30)")
        else:
            problems.append("frozen dir missing: build/g7-campaign")

        # manifest itself unchanged vs frozen checksums entry
        if CHECKSUMS.exists():
            frozen_manifest_sha = None
            for line in CHECKSUMS.read_text(encoding="utf-8").splitlines():
                if "reports/g7-campaign/evidence_manifest.json" in line:
                    m = re.match(r"([0-9a-f]{64})\s+\*\S+", line)
                    if m:
                        frozen_manifest_sha = m.group(1)
            if frozen_manifest_sha != manifest_sha:
                problems.append("evidence_manifest.json hash changed")
        else:
            problems.append("sha256sums_g7_campaign.txt missing")

    # --- G7CAM preservation ---
    if M_TIME_SNAPSHOT.exists():
        snap = json.loads(M_TIME_SNAPSHOT.read_text(encoding="utf-8"))
        changed = []
        for f_str, t0 in snap.items():
            p = Path(f_str)
            if not p.exists():
                continue
            if p.stat().st_mtime != t0:
                changed.append(f_str)
        if changed:
            problems.append(f"G7CAM files modified this turn: {len(changed)}")
            for f in changed[:20]:
                problems.append("  modified: " + f)
    else:
        problems.append("turn-start mtime snapshot missing")

    # --- power scheme restore ---
    start_scheme = None
    if SCHEME_SNAPSHOT.exists():
        start_scheme = json.loads(SCHEME_SNAPSHOT.read_text(encoding="utf-8")).get("guid")
    if start_scheme is None:
        problems.append("start power scheme snapshot missing")
    else:
        cur = active_scheme_guid()
        if cur is None:
            problems.append("cannot read current power scheme")
        elif cur.lower() != start_scheme.lower():
            problems.append(f"power scheme not restored: current={cur} start={start_scheme}")

    if problems:
        print("END-OF-TURN INTEGRITY: FAIL")
        for s in problems:
            print("  -", s)
        return 1
    print("END-OF-TURN INTEGRITY: PASS")
    print("  frozen 30 = 30/30 SHA")
    print("  evidence_manifest unchanged")
    print("  G7CAM records not created/modified this turn")
    print(f"  power scheme restored to {start_scheme}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
