#!/usr/bin/env python3
"""
Single authorized B7 diagnostic run, launched from the approved cwd.

Approved run spec (work/_task_b7_phase1_report.md section 4.5):
  cwd                : E:\\My Local AI
  diagnostic dir     : build/bm_b7_diagnostic
  host-capture dir   : work/b7_diag_20261011_paired_capture/run2

Captures: stdout/stderr bytes + text, exit code, timing, and an independent
kernel image-path identity proof for the child process.
Runs the diagnostic EXACTLY ONCE. No retry.
"""
import ctypes
import ctypes.wintypes as wt
import hashlib
import json
import os
import pathlib
import subprocess
import sys
import time

ROOT = pathlib.Path(r"E:\My Local AI")
EXE_REL = "stark/build-b7diag-vs2019b/Release/bm_b7_diagnostic.exe"
OUT = ROOT / "work/b7_diag_20261011_paired_capture/phase16_vs2019/run_expected"
EXE = (ROOT / EXE_REL).resolve()

DIAG_DIR = "build/bm_b7_diagnostic"
HOST_DIR = "work/b7_diag_20261011_paired_capture/run2"
ARGV = [DIAG_DIR, "--host-capture-dir", HOST_DIR]

OUT.mkdir(parents=True, exist_ok=True)


def sha256_file(p, chunk=1 << 20):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(chunk), b""):
            h.update(b)
    return h.hexdigest()


# ---------- kernel image-path identity helper ----------
k32 = ctypes.WinDLL("kernel32", use_last_error=True)
k32.OpenProcess.restype = wt.HANDLE
k32.OpenProcess.argtypes = [wt.DWORD, wt.BOOL, wt.DWORD]
k32.QueryFullProcessImageNameW.restype = wt.BOOL
k32.QueryFullProcessImageNameW.argtypes = [wt.HANDLE, wt.DWORD, wt.LPWSTR, ctypes.POINTER(wt.DWORD)]
k32.CloseHandle.argtypes = [wt.HANDLE]

PROCESS_QUERY_LIMITED_INFORMATION = 0x1000


def query_image_path(pid):
    """Return (ok, image_path, len_in_out, last_error, api)."""
    h = k32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not h:
        return False, "", 0, ctypes.get_last_error(), "OpenProcess"
    try:
        buf = ctypes.create_unicode_buffer(32768)
        size = wt.DWORD(32768)
        ok = k32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size))
        return bool(ok), buf.value, int(size.value), (0 if ok else ctypes.get_last_error()), \
            "QueryFullProcessImageNameW"
    finally:
        k32.CloseHandle(h)


def main():
    meta = {
        "run": "phase16_vs2019_run_expected",
        "cwd": str(ROOT),
        "exe_rel": EXE_REL,
        "exe_resolved": str(EXE),
        "exe_exists": EXE.is_file(),
        "exe_bytes": EXE.stat().st_size if EXE.is_file() else None,
        "exe_sha256": sha256_file(EXE) if EXE.is_file() else None,
        "argv": ARGV,
        "command_line": [str(EXE)] + ARGV,
        "diag_dir_rel": DIAG_DIR,
        "host_dir_rel": HOST_DIR,
        "host_csv_rel": HOST_DIR + "/paired_samples.csv",
        "python": sys.version,
    }

    out_p = OUT / "stdout.txt"
    err_p = OUT / "stderr.txt"

    t0 = time.time()
    meta["start_local"] = time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(t0))

    with open(out_p, "wb") as fo, open(err_p, "wb") as fe:
        proc = subprocess.Popen(
            [str(EXE)] + ARGV,
            cwd=str(ROOT),
            stdout=fo,
            stderr=fe,
            shell=False,
        )
        meta["create_ok"] = True
        meta["child_pid"] = proc.pid

        # Independent image-path identity proof, taken while the child is alive.
        ok, img, ln, err, api = query_image_path(proc.pid)
        meta["image_query_api"] = api
        meta["image_query_ok"] = ok
        meta["image_query_len"] = ln
        meta["image_query_last_error"] = err
        meta["image_path_raw"] = img
        meta["image_path_matches_exe"] = (
            ok and os.path.normcase(os.path.realpath(img)) == os.path.normcase(os.path.realpath(str(EXE)))
        )

        rc = proc.wait()

    t1 = time.time()
    meta["create_process_last_error"] = 0
    meta["exit_code"] = rc
    meta["end_local"] = time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(t1))
    meta["elapsed_sec"] = round(t1 - t0, 3)
    meta["stdout_bytes"] = out_p.stat().st_size
    meta["stderr_bytes"] = err_p.stat().st_size
    meta["stdout_sha256"] = sha256_file(out_p)
    meta["stderr_sha256"] = sha256_file(err_p)

    csv_p = ROOT / HOST_DIR / "paired_samples.csv"
    meta["host_csv_exists"] = csv_p.is_file()
    if csv_p.is_file():
        meta["host_csv_bytes"] = csv_p.stat().st_size
        meta["host_csv_sha256"] = sha256_file(csv_p)

    (OUT / "exec_meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    (OUT / "exitcode.txt").write_text(f"{rc}\n", encoding="utf-8")
    print(json.dumps(meta, indent=2))


if __name__ == "__main__":
    main()
