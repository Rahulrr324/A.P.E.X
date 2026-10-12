#!/usr/bin/env python3
"""v8 post-run integrity gate with explicit exit codes:
- independent power-scheme restore verification (powercfg, == pre-run original)
- frozen 30 (verify_frozen30.py)
- records_sha256.txt contents + its own sha
- evidence_manifest.json sha
- 5 production binary hashes vs work/scripts/prod_bin_hashes_before.txt
- no G7CAM record created/modified (mtime comparison vs turn-start snapshot)
Outputs work/scripts/v8_postrun_integrity.json.
"""
from __future__ import annotations

import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path("stark")
WORK = Path("work") / "scripts"
EXPECTED_MANIFEST_SHA = "7a8dd9de17c4effdc9153ac4505a6f6f95ed662ef204cab52ad279c4bf01fc5a"
EXPECTED_RECORDS_LIST_SHA = (
    "bf479cbcf08eef94bfd6481f16e6a881e0e15b52cbec05aaed0377afe2edc6ae"
)


def sha256_file(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def run(cmd, cwd=None):
    r = subprocess.run(cmd, capture_output=True, text=True, cwd=cwd)
    return r.returncode, r.stdout, r.stderr


def main() -> int:
    summary: dict = {"checks": {}}
    ok_all = True

    # 1. power scheme restored == pre-run original (independent of wrapper claim)
    before = json.loads((WORK / "power_status_before.json").read_text(encoding="utf-8"))
    rc, out, err = run(["powercfg", "/getactivescheme"])
    guid = None
    if rc == 0:
        m = re.search(r"Power Scheme GUID:\s+([0-9A-Fa-f\-]+)", out)
        guid = m.group(1) if m else None
    restored_ok = (
        rc == 0
        and guid is not None
        and guid.lower() == before.get("guid", "").lower()
    )
    summary["checks"]["power_restore"] = {
        "exit": rc, "guid": guid, "expected": before.get("guid"), "match": restored_ok
    }
    print(f"[1] power restore: exit={rc} guid={guid} match={restored_ok}")
    if not restored_ok:
        ok_all = False

    # 2. frozen 30
    rc, out, err = run([sys.executable, "reports/g7-campaign/verify_frozen30.py"], cwd=ROOT)
    summary["checks"]["verify_frozen30"] = {"exit": rc, "stdout_tail": out[-400:]}
    print(f"[2] verify_frozen30.py exit={rc}")
    if rc != 0:
        ok_all = False
        print(out)

    # 3. records_sha256.txt contents
    rc, out, err = run(
        ["sha256sum", "-c", "reports/g7-campaign-affinityfix/records_sha256.txt"], cwd=ROOT
    )
    summary["checks"]["records_sha256_c"] = {"exit": rc, "stdout_tail": out[-400:]}
    print(f"[3] sha256sum -c records_sha256.txt exit={rc}")
    if rc != 0:
        ok_all = False
        print(out)

    # 4. records_sha256.txt own sha
    rlist = ROOT / "reports" / "g7-campaign-affinityfix" / "records_sha256.txt"
    got = sha256_file(rlist)
    match = got == EXPECTED_RECORDS_LIST_SHA
    summary["checks"]["records_sha256_own_sha"] = {"match": match, "actual": got}
    print(f"[4] records_sha256.txt own sha match={match}")
    if not match:
        ok_all = False

    # 5. evidence_manifest.json sha
    man = ROOT / "reports" / "g7-campaign" / "evidence_manifest.json"
    got_m = sha256_file(man)
    match_m = got_m == EXPECTED_MANIFEST_SHA
    summary["checks"]["evidence_manifest_sha"] = {"match": match_m, "actual": got_m}
    print(f"[5] evidence_manifest.json sha match={match_m}")
    if not match_m:
        ok_all = False

    # 6. production binaries unchanged vs before snapshot
    before_file = WORK / "prod_bin_hashes_before.txt"
    if not before_file.exists():
        ok_all = False
        summary["checks"]["prod_bins"] = {"error": "before snapshot missing"}
        print("[6] FAIL: before snapshot missing")
    else:
        expected = {}
        for line in before_file.read_text(encoding="utf-8").splitlines():
            if " *" in line:
                h, b = line.split(" *", 1)
                expected[b] = h
        bin_dir = ROOT / "build-v24-release"
        changed = []
        for b, h in expected.items():
            p = bin_dir / b
            if not p.exists():
                changed.append(b + " (missing)")
            elif sha256_file(p) != h:
                changed.append(b)
        summary["checked"] = len(expected)
        summary["checks"]["prod_bins"] = {
            "checked": len(expected), "changed": changed
        }
        print(f"[6] production binaries checked={len(expected)} changed={changed}")
        if changed:
            ok_all = False

    # 7. no G7CAM record created/modified this turn (turn-start snapshot)
    snap_path = WORK / "freeze30_mtimes_start.json"
    if snap_path.exists():
        snap = json.loads(snap_path.read_text(encoding="utf-8"))
        changed = []
        for f_str, t0 in snap.items():
            p = Path(f_str)
            if not p.exists():
                continue
            if p.stat().st_mtime != t0:
                changed.append(f_str)
        # new files in the two G7CAM dirs
        for d in (ROOT / "build" / "g7-campaign", ROOT / "build" / "g7-campaign-affinityfix"):
            for p in d.glob("*.json"):
                if str(p.resolve()) not in snap:
                    changed.append("NEW: " + str(p))
        summary["checks"]["g7cam_unchanged"] = {"changed": changed}
        print(f"[7] G7CAM created/modified={len(changed)}")
        if changed:
            ok_all = False
            for c in changed:
                print("    " + c)
    else:
        ok_all = False
        print("[7] FAIL: turn-start snapshot missing")

    summary["all_ok"] = ok_all
    (WORK / "v8_postrun_integrity.json").write_text(
        json.dumps(summary, indent=2), encoding="utf-8"
    )
    print("POST-RUN INTEGRITY:", "PASS" if ok_all else "FAIL")
    return 0 if ok_all else 1


if __name__ == "__main__":
    sys.exit(main())
