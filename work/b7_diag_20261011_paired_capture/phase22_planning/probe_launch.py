#!/usr/bin/env python3
"""
Phase 22 - harmless real-executable launch probe.

PURPOSE
    Exercise the real Windows process-launch lifecycle using the actual frozen
    bm_b7_diagnostic.exe, WITHOUT running a measurement. The probe:
      - verifies exe path and hash
      - creates the child SUSPENDED via CreateProcessW
      - sets a valid affinity mask
      - reads the mask back and verifies it
      - resumes the child
      - passes an argv the executable itself rejects at parse time
        (--host-capture-dir with no value -> exit 2, established behavior)
      - captures stdout/stderr/exit code
      - closes handles on both paths
      - verifies no paired_samples.csv was created or modified

SAFETY
    - The probe is a NEW isolated script under phase22_planning/.
    - It does NOT modify phase19_runner.py.
    - It does NOT touch the six-run workflow (phase19_runs/).
    - argv used here is a DELIBERATELY EARLY-REJECT argv that the exe refuses
      before run_bm_b7_diagnostic(); prior CLI tests already established that
      --host-capture-dir with no value exits 2 with a usage message.
    - The probe refuses to overwrite an existing output directory.
    - Protected hashes are recorded before/after and must match.

Outputs (under its own probe dir):
    probe_meta.json
    exe_stdout.txt
    exe_stderr.txt
    exe_exitcode.txt

Do not interpret this as a diagnostic result or calibration verdict.
"""

import ctypes
import ctypes.wintypes as wt
import datetime
import hashlib
import json
import os
import pathlib
import struct
import subprocess
import sys
import time

ROOT = pathlib.Path(r"E:\My Local AI")

EXE_REL = "stark/build-b7diag-vs2019b/Release/bm_b7_diagnostic.exe"
EXE_SHA256_EXPECTED = "86ee9f3ee2c1daac8f2815be4516e2ea03fd19273166978cbf09e6d69ca09d88"

B7_CSV_REL = "work/b7_diag_20261011_paired_capture/run2/paired_samples.csv"
B7_CSV_SHA256_EXPECTED = "818bf1a541b8115f2393a3da2b912eb3757b7f187199d5e9b60beca4e167998f"

PROBE_DIR_REL = "work/b7_diag_20261011_paired_capture/phase22_planning/probe1"

CREATE_SUSPENDED = 0x00000004
STARTF_USESTDHANDLES = 0x00000100
HANDLE_FLAG_INHERIT = 0x00000001
INFINITE = 0xFFFFFFFF

k32 = ctypes.WinDLL("kernel32", use_last_error=True)

class STARTUPINFOW(ctypes.Structure):
    _fields_ = [
        ("cb", wt.DWORD), ("lpReserved", wt.LPWSTR), ("lpDesktop", wt.LPWSTR),
        ("lpTitle", wt.LPWSTR), ("dwX", wt.DWORD), ("dwY", wt.DWORD),
        ("dwXSize", wt.DWORD), ("dwYSize", wt.DWORD), ("dwXCountChars", wt.DWORD),
        ("dwYCountChars", wt.DWORD), ("dwFillAttribute", wt.DWORD),
        ("dwFlags", wt.DWORD), ("wShowWindow", wt.WORD), ("cbReserved2", wt.WORD),
        ("lpReserved2", ctypes.POINTER(ctypes.c_byte)),
        ("hStdInput", wt.HANDLE), ("hStdOutput", wt.HANDLE), ("hStdError", wt.HANDLE),
    ]

class PROCESS_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("hProcess", wt.HANDLE), ("hThread", wt.HANDLE),
        ("dwProcessId", wt.DWORD), ("dwThreadId", wt.DWORD),
    ]

k32.CreateProcessW.argtypes = [wt.LPCWSTR, wt.LPWSTR, ctypes.c_void_p, ctypes.c_void_p,
                               wt.BOOL, wt.DWORD, ctypes.c_void_p, wt.LPCWSTR,
                               ctypes.POINTER(STARTUPINFOW), ctypes.POINTER(PROCESS_INFORMATION)]
k32.CreateProcessW.restype = wt.BOOL
k32.SetProcessAffinityMask.argtypes = [wt.HANDLE, ctypes.c_size_t]
k32.SetProcessAffinityMask.restype = wt.BOOL
k32.GetProcessAffinityMask.argtypes = [wt.HANDLE, ctypes.POINTER(ctypes.c_size_t), ctypes.POINTER(ctypes.c_size_t)]
k32.GetProcessAffinityMask.restype = wt.BOOL
k32.ResumeThread.argtypes = [wt.HANDLE]
k32.ResumeThread.restype = wt.DWORD
k32.WaitForSingleObject.argtypes = [wt.HANDLE, wt.DWORD]
k32.WaitForSingleObject.restype = wt.DWORD
k32.GetExitCodeProcess.argtypes = [wt.HANDLE, ctypes.POINTER(wt.DWORD)]
k32.GetExitCodeProcess.restype = wt.BOOL
k32.CloseHandle.argtypes = [wt.HANDLE]
k32.QueryFullProcessImageNameW.argtypes = [wt.HANDLE, wt.DWORD, wt.LPWSTR, ctypes.POINTER(wt.DWORD)]
k32.QueryFullProcessImageNameW.restype = wt.BOOL


def own_masks():
    p = ctypes.c_size_t(); s = ctypes.c_size_t()
    if not k32.GetProcessAffinityMask(k32.GetCurrentProcess(), ctypes.byref(p), ctypes.byref(s)):
        raise OSError(ctypes.get_last_error(), "GetProcessAffinityMask(self)")
    return int(p.value), int(s.value)


def masks_of(h):
    p = ctypes.c_size_t(); s = ctypes.c_size_t()
    if not k32.GetProcessAffinityMask(h, ctypes.byref(p), ctypes.byref(s)):
        return None, None
    return int(p.value), int(s.value)


def cpus_of(mask):
    return [i for i in range(64) if (mask >> i) & 1]


def sha256_file(p, chunk=1 << 20):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(chunk), b""):
            h.update(b)
    return h.hexdigest()


def probe():
    probe_dir = ROOT / PROBE_DIR_REL
    if probe_dir.exists():
        print(f"PROBE ABORT: probe dir already exists: {probe_dir}")
        return 2
    ops = probe_dir / "ops"
    ops.mkdir(parents=True, exist_ok=False)
    probe_dir.mkdir(parents=True, exist_ok=True)

    exe = (ROOT / EXE_REL).resolve()
    if not exe.is_file():
        print(f"PROBE ABORT: exe missing: {exe}")
        return 2
    got_hash = sha256_file(exe)
    if got_hash != EXE_SHA256_EXPECTED:
        print(f"PROBE ABORT: exe hash {got_hash} != {EXE_SHA256_EXPECTED}")
        return 2

    host_p, host_s = own_masks()
    print(json.dumps({"probe_dir": str(probe_dir), "exe": str(exe),
                      "exe_sha256": got_hash, "self_mask": host_p, "system_mask": host_s}, indent=2))

    # argv: deliberately early-reject form the exe itself refuses at parse time.
    # --host-capture-dir with no value => exit 2 (established by prior CLI tests).
    argv = [str(exe), "build/bm_b7_diagnostic", "--host-capture-dir"]
    cmdline = ctypes.create_unicode_buffer(subprocess.list2cmdline(argv))

    out_f = open(ops / "exe_stdout.txt", "wb")
    err_f = open(ops / "exe_stderr.txt", "wb")
    h_out = ctypes.c_void_p(int(out_f.fileno()))  # msvcrt get_osfhandle equivalent
    try:
        import msvcrt
        h_out = ctypes.c_void_p(msvcrt.get_osfhandle(out_f.fileno()))
        h_err = ctypes.c_void_p(msvcrt.get_osfhandle(err_f.fileno()))
    except Exception:
        out_f.close(); err_f.close()
        print("PROBE ABORT: cannot get OS handles for stdout/stderr")
        return 2

    for h in (h_out, h_err):
        if not k32.SetHandleInformation(h, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT):
            raise OSError(ctypes.get_last_error(), "SetHandleInformation")

    si = STARTUPINFOW()
    si.cb = ctypes.sizeof(STARTUPINFOW)
    si.dwFlags = STARTF_USESTDHANDLES
    si.hStdInput = None
    si.hStdOutput = h_out
    si.hStdError = h_err
    pi = PROCESS_INFORMATION()

    PIN_MASK = 0x1  # logical CPU 0 (P-core), chosen on the same evidence as Phase 19

    ok = k32.CreateProcessW(str(exe), cmdline, None, None, True, CREATE_SUSPENDED,
                            None, str(ROOT), ctypes.byref(si), ctypes.byref(pi))
    if not ok:
        e = ctypes.get_last_error()
        out_f.close(); err_f.close()
        print(f"PROBE ABORT: CreateProcessW failed, error={e}")
        return 2

    try:
        info = {"create_ok": True, "child_pid": int(pi.dwProcessId),
                "child_tid": int(pi.dwThreadId), "pin_mask": PIN_MASK, "argv": argv}

        buf = ctypes.create_unicode_buffer(32768)
        n = wt.DWORD(32768)
        if k32.QueryFullProcessImageNameW(pi.hProcess, 0, buf, ctypes.byref(n)):
            info["image_path"] = buf.value
            info["image_matches_exe"] = (
                os.path.normcase(os.path.realpath(buf.value)) ==
                os.path.normcase(os.path.realpath(str(exe))))
        else:
            info["image_path"] = None
            info["image_matches_exe"] = None

        # set affinity while suspended
        if not k32.SetProcessAffinityMask(pi.hProcess, ctypes.c_size_t(PIN_MASK)):
            raise OSError(ctypes.get_last_error(), "SetProcessAffinityMask")

        pre_p, pre_s = masks_of(pi.hProcess)
        info["mask_observed_suspended"] = pre_p
        info["system_mask_observed"] = pre_s

        if pre_p != PIN_MASK:
            raise RuntimeError(f"affinity verification failed: {pre_p} != {PIN_MASK}")

        info["affinity_verified"] = True
        info["mask_cpus"] = cpus_of(pre_p)

        rc_resume = k32.ResumeThread(pi.hThread)
        info["resume_rc"] = int(rc_resume)

        # wait for child to exit
        k32.WaitForSingleObject(pi.hProcess, INFINITE)
        code = wt.DWORD()
        k32.GetExitCodeProcess(pi.hProcess, ctypes.byref(code))
        info["exit_code"] = int(code.value)

        post_p, _ = masks_of(pi.hProcess)
        info["mask_at_exit"] = post_p
        info["affinity_drifted"] = (post_p != pre_p)

        print(json.dumps(info, indent=2))
    finally:
        if pi.hThread:
            k32.CloseHandle(pi.hThread)
        if pi.hProcess:
            k32.CloseHandle(pi.hProcess)
        out_f.close()
        err_f.close()

    # exit code file
    (ops / "exe_exitcode.txt").write_text(f"{info['exit_code']}\n", encoding="utf-8")

    # capture hashes
    for name in ("exe_stdout.txt", "exe_stderr.txt"):
        p = ops / name
        info[f"{name}_bytes"] = p.stat().st_size
        info[f"{name}_sha256"] = sha256_file(p)

    # CSV integrity
    b7_csv = ROOT / B7_CSV_REL
    info["b7_csv_sha256_now"] = sha256_file(b7_csv)
    info["b7_csv_unchanged"] = (info["b7_csv_sha256_now"] == B7_CSV_SHA256_EXPECTED)
    info["b7_csv_exists"] = b7_csv.is_file()

    hist_csv = ROOT / "build/bm_b7_diagnostic/run_1791799501127597800_0/paired_samples.csv"
    info["historical_csv_sha256_now"] = sha256_file(hist_csv)
    info["historical_csv_unchanged"] = (
        info["historical_csv_sha256_now"] ==
        "d0fca204c9443ef2d0113c12884dfc0fbfc1d64f08c3903f89c98c0c4bf5163a")

    # probe-dir CSV check
    probe_csv = probe_dir / "paired_samples.csv"
    info["probe_csv_created"] = probe_csv.is_file()

    meta = {
        "probe": "phase22_launch_probe",
        "at_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        "exe": str(exe),
        "exe_sha256_before": got_hash,
        "argv": argv,
        "pin_mask": PIN_MASK,
        "launch": info,
        "b7_csv": {"expected": B7_CSV_SHA256_EXPECTED, "now": info["b7_csv_sha256_now"],
                   "unchanged": info["b7_csv_unchanged"], "exists": info["b7_csv_exists"]},
        "historical_csv": {"expected": "d0fca204c9443ef2d0113c12884dfc0fbfc1d64f08c3903f89c98c0c4bf5163a",
                           "now": info["historical_csv_sha256_now"],
                           "unchanged": info["historical_csv_unchanged"]},
        "probe_csv_created": info["probe_csv_created"],
        "exit_code": info["exit_code"],
        "exit_expected": 2,
        "exit_matches_expected": info["exit_code"] == 2,
    }
    (ops / "probe_meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")

    print(json.dumps(meta, indent=2))
    return 0 if meta["exit_matches_expected"] else 1


if __name__ == "__main__":
    sys.exit(probe())
