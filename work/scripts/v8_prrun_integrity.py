#!/usr/bin/env python3
"""v8 pre-run integrity gate. Captures/verifies, with explicit exit codes:
- frozen 30 (verify_frozen30.py)
- records_sha256.txt contents (30 affinityfix records) + its own sha
- evidence_manifest.json sha vs frozen checksums entry
- 5 production binary hashes -> work/scripts/prod_bin_hashes_before.txt
- active power scheme -> work/scripts/power_status_before.json
Outputs a JSON summary to work/scripts/v8_prrun_integrity.json.
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
PROD_BINS = [
    "g7_campaign.exe",
    "aggregate.exe",
    "run_baseline.exe",
    "libstark_phase1.a",
    "power_scheme_control.exe",
]


def sha256_file(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def run(cmd, cwd=None):
    r = subprocess.run(cmd, capture_output=True, text=True, cwd=cwd)
    return r.returncode, r.stdout, r.stderr


def main() -> int:
    summary: dict = {"checks": {}}
    ok_all = True

    # 1. frozen 30
    rc, out, err = run([sys.executable, "reports/g7-campaign/verify_frozen30.py"], cwd=ROOT)
    summary["checks"]["verify_frozen30"] = {"exit": rc, "stdout_tail": out[-400:]}
    print(f"[1] verify_frozen30.py exit={rc}")
    if rc != 0:
        ok_all = False
        print(out)

    # 2. records_sha256.txt contents
    rc, out, err = run(["sha256sum", "-c", "reports/g7-campaign-affinityfix/records_sha256.txt"], cwd=ROOT)
    summary["checks"]["records_sha256_c"] = {"exit": rc, "stdout_tail": out[-400:], "stderr": err[-200:]}
    print(f"[2] sha256sum -c records_sha256.txt exit={rc}")
    if rc != 0:
        ok_all = False
        print(out, err)

    # 3. records_sha256.txt own sha
    rlist = ROOT / "reports" / "g7-campaign-affinityfix" / "records_sha256.txt"
    got = sha256_file(rlist)
    match = got == EXPECTED_RECORDS_LIST_SHA
    summary["checks"]["records_sha256_own_sha"] = {"expected": EXPECTED_RECORDS_LIST_SHA, "actual": got, "match": match}
    print(f"[3] records_sha256.txt own sha match={match}")
    if not match:
        ok_all = False

    # 4. evidence_manifest.json sha vs frozen entry
    man = ROOT / "reports" / "g7-campaign" / "evidence_manifest.json"
    got_m = sha256_file(man)
    match_m = got_m == EXPECTED_MANIFEST_SHA
    summary["checks"]["evidence_manifest_sha"] = {"expected": EXPECTED_MANIFEST_SHA, "actual": got_m, "match": match_m}
    print(f"[4] evidence_manifest.json sha match={match_m}")
    if not match_m:
        ok_all = False

    # 5. production binary hashes
    bin_dir = ROOT / "build-v24-release"
    lines = []
    for b in PROD_BINS:
        p = bin_dir / b
        if not p.exists():
            ok_all = False
            lines.append(f"MISSING {b}")
            continue
        lines.append(f"{sha256_file(p)} *{b}")
    before_path = WORK / "prod_bin_hashes_before.txt"
    before_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    summary["checks"]["prod_bins_before"] = {"exit": 0 if ok_all else 1, "file": str(before_path)}
    print(f"[5] production hashes captured -> {before_path}")
    for ln in lines:
        print("    " + ln)

    # 6. active power scheme
    rc, out, err = run(["powercfg", "/getactivescheme"])
    guid = None
    if rc == 0:
        m = re.search(r"Power Scheme GUID:\s+([0-9A-Fa-f\-]+)", out)
        guid = m.group(1) if m else None
    status = {"exit": rc, "guid": guid, "raw": out.strip()}
    (WORK / "power_status_before.json").write_text(json.dumps(status, indent=2), encoding="utf-8")
    summary["checks"]["power_scheme_before"] = status
    print(f"[6] powercfg /getactivescheme exit={rc} guid={guid}")
    if rc != 0 or guid is None:
        ok_all = False

    summary["all_ok"] = ok_all
    (WORK / "v8_prrun_integrity.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print("PRE-RUN INTEGRITY:", "PASS" if ok_all else "FAIL")
    return 0 if ok_all else 1


if __name__ == "__main__":
    sys.exit(main())
