#!/usr/bin/env python3
"""Phase 49 - r01 single B7 diagnostic capture launcher.

Launches the already-built, verified diagnostic EXACTLY ONCE, with full
pre-launch provenance written into r01 before the process is spawned, and
stdout/stderr/exit code captured to files. No retry, no second launch.
"""
import hashlib
import json
import os
import pathlib
import subprocess
import sys
import time
from datetime import datetime, timezone

ROOT = pathlib.Path(r"E:\My Local AI")
EXE_REL = pathlib.Path("stark/build-b7diag-fresh-p39b/Release/bm_b7_diagnostic.exe")
EXE = ROOT / EXE_REL
R01 = ROOT / pathlib.Path("work/b7_diag_20261011_paired_capture/phase49_single_capture/r01")

DIAG_DIR = "build/bm_b7_diagnostic"
HOST_DIR = "work/b7_diag_20261011_paired_capture/phase49_single_capture/r01"
ARGV = [DIAG_DIR, "--host-capture-dir", HOST_DIR]

BUILD_CONFIG_TEXT = (
    "=== build_config.txt - Phase 49 r01 ===\n"
    "executable (relative to repo root): stark/build-b7diag-fresh-p39b/Release/bm_b7_diagnostic.exe\n"
    "resolved: E:\\My Local AI\\stark\\build-b7diag-fresh-p39b\\Release\\bm_b7_diagnostic.exe\n"
    "build directory: stark/build-b7diag-fresh-p39b/\n"
    "CMake generator (from CMakeCache.txt): Visual Studio 16 2019\n"
    "CMAKE_CONFIGURATION_TYPES: Release\n"
    "generator-derived: MSVC toolset (VS 2019). Compiler version NOT re-derived "
    "without a rebuild; the frozen executable is used as-is. No rebuild performed.\n"
    "build artifacts date: executable mtime 2026-10-18 19:24 local\n"
)

SYSTEM_STATE_TEXT = (
    "=== system_state.txt - Phase 49 r01 (observed at launch, best effort) ===\n"
    "platform: Windows-11-10.0.26300-SP0\n"
    "machine: AMD64\n"
    "processor (platform.platform): Intel64 Family 6 Model 154 Stepping 3, GenuineIntel\n"
    "os.cpu_count(): 12 logical processors\n"
    "powercfg /getactivescheme: Power Scheme GUID dfe97760-471c-4d01-bd06-b8b04c50ecd8 (Performance Mode)\n"
    "wmic cpu: unavailable (wm via WinError 2 - command not present in this environment)\n"
    "LIMITATIONS: CPU affinity of the launched process is NOT controlled; cache "
    "state is warm-cache (not controlled); these are documented differences from "
    "the historical campaign and remain uncontrolled factors, recorded only as "
    "observed, not claimed as controlled.\n"
)


def sha256_file(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def git(args):
    return subprocess.run(["git"] + args, cwd=str(ROOT), capture_output=True,
                          text=True).stdout.strip()


def main():
    # ---- pre-launch provenance (persisted before the process spawns) ----
    (R01 / "argv.txt").write_text(
        "command_line (argv vector, one per line):\n" +
        "\n".join([str(EXE)] + ARGV) + "\n", encoding="utf-8")
    (R01 / "cwd.txt").write_text(
        "cwd_at_launch=" + str(ROOT) + "\n", encoding="utf-8")

    launch_local = time.strftime("%Y-%m-%dT%H:%M:%S%z", time.localtime())
    launch_utc = datetime.now(timezone.utc).isoformat(timespec="microseconds")
    mon = time.monotonic()
    (R01 / "launch_ts.txt").write_text(
        "launch_local=" + launch_local + "\n"
        "launch_utc=" + launch_utc + "\n"
        "monotonic_before_launch=" + repr(mon) + "\n", encoding="utf-8")

    if not EXE.is_file():
        (R01 / "exec_sha256_before.txt").write_text(
            "MISSING_EXECUTABLE\n", encoding="utf-8")
        print("FATAL: executable missing; no launch.")
        sys.exit(90)
    before = sha256_file(EXE)
    (R01 / "exec_sha256_before.txt").write_text(before + "\n", encoding="utf-8")

    head = git(["rev-parse", "HEAD"])
    porcelain = git(["status", "--porcelain"])
    (R01 / "source_rev.txt").write_text(
        "git HEAD: " + head + "\n"
        "note: 'committed vs uncommitted' reflects the working tree at launch.\n"
        "--- git status --porcelain ---\n" + porcelain, encoding="utf-8")

    (R01 / "build_config.txt").write_text(BUILD_CONFIG_TEXT, encoding="utf-8")
    (R01 / "system_state.txt").write_text(SYSTEM_STATE_TEXT, encoding="utf-8")
    (R01 / "condition_order.json").write_text(
        json.dumps({"populated_after_run": False, "note": "to be filled from stdout after run"}) + "\n",
        encoding="utf-8")

    meta = {
        "run_id": "phase49_single_capture/r01",
        "launch_local": launch_local,
        "launch_utc": launch_utc,
        "executable": str(EXE),
        "executable_exists": True,
        "executable_bytes": EXE.stat().st_size,
        "exec_sha256_before": before,
        "cwd": str(ROOT),
        "diagnostic_dir": DIAG_DIR,
        "host_capture_dir": HOST_DIR,
        "argv": ARGV,
        "command_line": [str(EXE)] + ARGV,
    }

    # ---- exactly one launch ----
    t0 = time.time()
    with open(R01 / "stdout.txt", "wb") as fo, open(R01 / "stderr.txt", "wb") as fe:
        proc = subprocess.Popen([str(EXE)] + ARGV, cwd=str(ROOT),
                                stdout=fo, stderr=fe, shell=False)
        meta["child_pid"] = proc.pid
        meta["create_ok"] = True
        rc = proc.wait()
    t1 = time.time()
    meta["exit_code"] = rc
    meta["elapsed_sec"] = round(t1 - t0, 3)
    meta["end_local"] = time.strftime("%Y-%m-%dT%H:%M:%S%z", time.localtime(t1))

    (R01 / "exitcode.txt").write_text(str(rc) + "\n", encoding="utf-8")

    # Best-effort immediate CSV presence/hash (final verification happens after).
    csv_p = ROOT / HOST_DIR / "paired_samples.csv"
    meta["host_csv_exists"] = csv_p.is_file()
    if csv_p.is_file():
        meta["host_csv_bytes"] = csv_p.stat().st_size
        meta["host_csv_sha256"] = sha256_file(csv_p)

    (R01 / "exec_meta.json").write_text(json.dumps(meta, indent=2) + "\n",
                                        encoding="utf-8")
    print(json.dumps(meta, indent=2))


if __name__ == "__main__":
    main()
