#!/usr/bin/env python3
"""
Phase 19 - external CPU-affinity launch wrapper for the B7 diagnostic.

PURPOSE
    Run the *existing, unmodified* bm_b7_diagnostic.exe under two conditions
    (unpinned / pinned-to-one-logical-CPU) while changing nothing inside the
    measured workload. No source file and no executable is edited: affinity is
    imposed from OUTSIDE the process, before it executes a single instruction.

MECHANISM (race-free)
    CreateProcessW(..., CREATE_SUSPENDED)          <- child created, NOT running
    [pinned only] SetProcessAffinityMask(child)    <- applied while suspended
    GetProcessAffinityMask(child)                  <- VERIFIED, fail closed
    ResumeThread(child)                            <- first child instruction is
                                                      already under the mask
    This is the only way to guarantee affinity is in effect "before the timed
    process begins": there is no window in which the child can run unpinned.

USAGE
    python phase19_runner.py --dry-run  --run-id p19r1 --condition unpinned --order 1
    python phase19_runner.py --self-test
    python phase19_runner.py --probe-child
    python phase19_runner.py --run-id p19r1 --condition unpinned --order 1
    python phase19_runner.py --run-id p19r2 --condition pinned --mask 0x1 --order 2

    --self-test and --probe-child use a HARMLESS child (this same script in
    --probe-child mode). They never launch the diagnostic and never create a
    paired_samples.csv.
"""

import argparse
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

# --------------------------------------------------------------------------
# Frozen, pre-existing objects. None of these is modified by this script.
# --------------------------------------------------------------------------
ROOT = pathlib.Path(r"E:\My Local AI")

# The exact executable that produced the authoritative paired CSV (Phase 16).
EXE_REL = "stark/build-b7diag-vs2019b/Release/bm_b7_diagnostic.exe"
EXE_SHA256_EXPECTED = "86ee9f3ee2c1daac8f2815be4516e2ea03fd19273166978cbf09e6d69ca09d88"

# The historical, hand-verified CSV. Must never be touched.
B7_CSV_REL = "work/b7_diag_20261011_paired_capture/run2/paired_samples.csv"
B7_CSV_SHA256_EXPECTED = "818bf1a541b8115f2393a3da2b912eb3757b7f187199d5e9b60beca4e167998f"

# Output roots for the six planned runs.
RUNS_BASE_REL = "work/b7_diag_20261011_paired_capture/phase19_runs"
DIAG_BASE_REL = "build/bm_b7_diagnostic"   # kDiagnosticDir in the diagnostic

# Frozen thresholds (unchanged; used only by the separate validator).
THRESHOLDS = {"mean_overhead_pct": 2.0, "worst_overhead_pct": 10.0,
              "median_deviation_pct": 2.0}

# Evidence of CPU selection (see phase19_report_affinity_experiment_plan.md).
PIN_MASK_DEFAULT = 0x1          # logical CPU 0 -> P-core, matches the historical campaign
PIN_CPU_DEFAULT = 0

# --------------------------------------------------------------------------
# Win32
# --------------------------------------------------------------------------
k32 = ctypes.WinDLL("kernel32", use_last_error=True)

CREATE_SUSPENDED = 0x00000004
STARTF_USESTDHANDLES = 0x00000100
HANDLE_FLAG_INHERIT = 0x00000001
STILL_ACTIVE = 259
INFINITE = 0xFFFFFFFF
TH32CS_SNAPALL = 0x0F


class STARTUPINFOW(ctypes.Structure):
    _fields_ = [("cb", wt.DWORD), ("lpReserved", wt.LPWSTR), ("lpDesktop", wt.LPWSTR),
                ("lpTitle", wt.LPWSTR), ("dwX", wt.DWORD), ("dwY", wt.DWORD),
                ("dwXSize", wt.DWORD), ("dwYSize", wt.DWORD), ("dwXCountChars", wt.DWORD),
                ("dwYCountChars", wt.DWORD), ("dwFillAttribute", wt.DWORD),
                ("dwFlags", wt.DWORD), ("wShowWindow", wt.WORD), ("cbReserved2", wt.WORD),
                ("lpReserved2", ctypes.POINTER(ctypes.c_byte)),
                ("hStdInput", wt.HANDLE), ("hStdOutput", wt.HANDLE), ("hStdError", wt.HANDLE)]


class PROCESS_INFORMATION(ctypes.Structure):
    _fields_ = [("hProcess", wt.HANDLE), ("hThread", wt.HANDLE),
                ("dwProcessId", wt.DWORD), ("dwThreadId", wt.DWORD)]


class SYSTEM_POWER_STATUS(ctypes.Structure):
    _fields_ = [("ACLineStatus", ctypes.c_byte), ("BatteryFlag", ctypes.c_byte),
                ("BatteryLifePercent", ctypes.c_byte), ("SystemStatusFlag", ctypes.c_byte),
                ("BatteryLifeTime", wt.DWORD), ("BatteryFullLifeTime", wt.DWORD)]


k32.CreateProcessW.argtypes = [wt.LPCWSTR, wt.LPWSTR, ctypes.c_void_p, ctypes.c_void_p,
                               wt.BOOL, wt.DWORD, ctypes.c_void_p, wt.LPCWSTR,
                               ctypes.POINTER(STARTUPINFOW), ctypes.POINTER(PROCESS_INFORMATION)]
k32.CreateProcessW.restype = wt.BOOL
k32.SetProcessAffinityMask.argtypes = [wt.HANDLE, ctypes.c_size_t]
k32.SetProcessAffinityMask.restype = wt.BOOL
k32.GetProcessAffinityMask.argtypes = [wt.HANDLE, ctypes.POINTER(ctypes.c_size_t),
                                       ctypes.POINTER(ctypes.c_size_t)]
k32.GetProcessAffinityMask.restype = wt.BOOL
k32.ResumeThread.argtypes = [wt.HANDLE]
k32.ResumeThread.restype = wt.DWORD
k32.WaitForSingleObject.argtypes = [wt.HANDLE, wt.DWORD]
k32.WaitForSingleObject.restype = wt.DWORD
k32.GetExitCodeProcess.argtypes = [wt.HANDLE, ctypes.POINTER(wt.DWORD)]
k32.GetExitCodeProcess.restype = wt.BOOL
k32.CloseHandle.argtypes = [wt.HANDLE]
k32.GetCurrentProcess.restype = wt.HANDLE
k32.SetHandleInformation.argtypes = [wt.HANDLE, wt.DWORD, wt.DWORD]
k32.GetSystemTimes.argtypes = [ctypes.POINTER(ctypes.c_ulonglong)] * 3
k32.GetSystemPowerStatus.argtypes = [ctypes.POINTER(SYSTEM_POWER_STATUS)]
k32.QueryFullProcessImageNameW.argtypes = [wt.HANDLE, wt.DWORD, wt.LPWSTR,
                                           ctypes.POINTER(wt.DWORD)]
k32.GetLogicalProcessorInformationEx.argtypes = [ctypes.c_int, ctypes.c_void_p,
                                                 ctypes.POINTER(wt.DWORD)]
k32.GetLogicalProcessorInformationEx.restype = wt.BOOL


def own_mask():
    """Affinity mask of THIS process, as (process, system)."""
    p = ctypes.c_size_t()
    s = ctypes.c_size_t()
    if not k32.GetProcessAffinityMask(k32.GetCurrentProcess(), ctypes.byref(p), ctypes.byref(s)):
        raise OSError(ctypes.get_last_error(), "GetProcessAffinityMask(self)")
    return int(p.value), int(s.value)


def masks_of(handle):
    p = ctypes.c_size_t()
    s = ctypes.c_size_t()
    if not k32.GetProcessAffinityMask(handle, ctypes.byref(p), ctypes.byref(s)):
        return None, None
    return int(p.value), int(s.value)


def cpus_of(mask):
    return [i for i in range(64) if (mask >> i) & 1]


RELATION_PROCESSOR_CORE = 0
RELATION_CACHE = 2


def _lpiex(relation):
    """Raw buffer from GetLogicalProcessorInformationEx, or None."""
    n = wt.DWORD(0)
    k32.GetLogicalProcessorInformationEx(relation, None, ctypes.byref(n))
    size = int(n.value)
    if size <= 0:
        return None
    buf = (ctypes.c_byte * size)()
    if not k32.GetLogicalProcessorInformationEx(relation, ctypes.byref(buf), ctypes.byref(n)):
        return None
    return bytes(buf)[:int(n.value)]


def _records(raw):
    off = 0
    while raw is not None and off < len(raw):
        rel, sz = struct.unpack_from("<ii", raw, off)
        if sz <= 0:
            return
        yield rel, off + 8
        off += sz


def topology():
    """CPU topology AS SEEN NOW: per-core cpus and OS EfficiencyClass (P/E),
    plus shared caches. Recorded inside every run's pre/post snapshot so each
    run's record is self-contained."""
    craw = _lpiex(RELATION_PROCESSOR_CORE)
    if craw is None:
        return {"error": "RelationProcessorCore query failed",
                "last_error": ctypes.get_last_error()}
    cores = []
    for rel, pay in _records(craw):
        if rel != RELATION_PROCESSOR_CORE:
            continue
        eff = craw[pay + 1]
        gc = struct.unpack_from("<H", craw, pay + 22)[0]
        for g in range(gc):
            mask = struct.unpack_from("<Q", craw, pay + 24 + g * 16)[0]
            cores.append({"mask": mask, "cpus": cpus_of(mask),
                          "efficiency_class": eff,
                          "class": "P-core" if eff > 0 else "E-core",
                          "smt_threads": len(cpus_of(mask))})

    # Caches live under a DIFFERENT relation type; query it separately or the
    # L3 field would silently stay null in every run record.
    araw = _lpiex(RELATION_CACHE)
    caches = []
    for rel, pay in _records(araw):
        if rel != RELATION_CACHE:
            continue
        lvl = araw[pay]
        csz = struct.unpack_from("<I", araw, pay + 4)[0]
        cty = struct.unpack_from("<i", araw, pay + 8)[0]
        gc = struct.unpack_from("<H", araw, pay + 30)[0]
        shared = []
        for g in range(gc):
            shared += cpus_of(struct.unpack_from("<Q", araw, pay + 32 + g * 16)[0])
        caches.append({"level": lvl, "size_bytes": csz, "type": cty,
                       "shared_cpus": sorted(shared)})

    pcs = sorted(x for c in cores if c["class"] == "P-core" for x in c["cpus"])
    ecs = sorted(x for c in cores if c["class"] == "E-core" for x in c["cpus"])
    l3 = [c for c in caches if c["level"] == 3]
    return {"cores": cores, "p_core_logical_cpus": pcs, "e_core_logical_cpus": ecs,
            "l3_caches": l3,
            "l3_shared_cpus": (l3[0]["shared_cpus"] if l3 else None),
            "cache_record_count": len(caches),
            "note": "EfficiencyClass is reported by the OS; P/E is not assumed"}


def sha256_file(p, chunk=1 << 20):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(chunk), b""):
            h.update(b)
    return h.hexdigest()


def system_cpu_busy_fraction(window_sec=0.30):
    """Busy fraction of the whole machine over a short window. No child spawned."""
    idle = ctypes.c_ulonglong()
    kern = ctypes.c_ulonglong()
    user = ctypes.c_ulonglong()
    k32.GetSystemTimes(ctypes.byref(idle), ctypes.byref(kern), ctypes.byref(user))
    i0, k0, u0 = idle.value, kern.value, user.value
    time.sleep(window_sec)
    k32.GetSystemTimes(ctypes.byref(idle), ctypes.byref(kern), ctypes.byref(user))
    di, dk, du = idle.value - i0, kern.value - k0, user.value - u0
    total = dk + du
    if total <= 0:
        return None
    return round(max(0.0, min(1.0, 1.0 - (di / total))), 4)


def active_power_scheme():
    try:
        r = subprocess.run(["powercfg", "/getactivescheme"], capture_output=True,
                           text=True, timeout=20)
        return {"cmd": "powercfg /getactivescheme", "rc": r.returncode,
                "stdout": r.stdout.strip(), "stderr": r.stderr.strip()}
    except Exception as e:  # pragma: no cover
        return {"cmd": "powercfg /getactivescheme", "error": repr(e)}


def ac_line_status():
    st = SYSTEM_POWER_STATUS()
    if not k32.GetSystemPowerStatus(ctypes.byref(st)):
        return None
    return {"ACLineStatus": st.ACLineStatus, "BatteryLifePercent": st.BatteryLifePercent,
            "note": "ACLineStatus: 1=AC, 0=battery, 255=unknown"}


def thermal_probe():
    """Best effort; many laptops do not expose this. Never fatal."""
    try:
        r = subprocess.run(
            ["powershell.exe", "-NoProfile", "-Command",
             "(Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature "
             "-ErrorAction Stop | Select-Object -ExpandProperty CurrentTemperature) -join ','"],
            capture_output=True, text=True, timeout=25)
        return {"rc": r.returncode, "stdout": r.stdout.strip(), "stderr": r.stderr.strip()[:400],
                "note": "tenths of Kelvin if present"}
    except Exception as e:
        return {"error": repr(e)}


def snapshot(label):
    return {"label": label,
            "at_local": datetime.datetime.now().isoformat(timespec="milliseconds"),
            "system_cpu_busy_fraction": system_cpu_busy_fraction(),
            "self_process_mask": own_mask()[0],
            "system_mask": own_mask()[1],
            "ac": ac_line_status(),
            "power_scheme": active_power_scheme(),
            "thermal": thermal_probe(),
            "topology": topology()}


# --------------------------------------------------------------------------
# The launch primitive
# --------------------------------------------------------------------------
def launch_suspended(exe, argv, mask, stdout_path, stderr_path):
    """
    Create `exe argv...` SUSPENDED, optionally pin it, verify, then resume.
    Returns a result dict. Raises RuntimeError on any verification failure
    (fail closed: the child is terminated, never resumed unpinned).
    """
    info = {"exe": str(exe), "argv": list(argv), "mask_intended": mask}
    self_p, self_s = own_mask()
    info["self_process_mask"] = self_p
    info["system_mask"] = self_s
    info["system_cpu_count"] = len(cpus_of(self_s))

    out_f = open(stdout_path, "wb")
    err_f = open(stderr_path, "wb")
    h_out = ctypes.c_void_p(_osfhandle(out_f))
    h_err = ctypes.c_void_p(_osfhandle(err_f))
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

    cmdline = ctypes.create_unicode_buffer(subprocess.list2cmdline([str(exe)] + list(argv)))
    info["command_line"] = cmdline.value

    ok = k32.CreateProcessW(str(exe), cmdline, None, None, True, CREATE_SUSPENDED,
                            None, str(ROOT), ctypes.byref(si), ctypes.byref(pi))
    if not ok:
        e = ctypes.get_last_error()
        out_f.close()
        err_f.close()
        raise OSError(e, "CreateProcessW failed")
    info["create_ok"] = True
    info["child_pid"] = int(pi.dwProcessId)
    info["child_tid"] = int(pi.dwThreadId)

    try:
        # Confirm the kernel image really is the intended binary.
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

        # --- the enforcement point: child is suspended here ---
        if mask is not None:
            if not k32.SetProcessAffinityMask(pi.hProcess, ctypes.c_size_t(mask)):
                raise OSError(ctypes.get_last_error(),
                              f"SetProcessAffinityMask({mask:#x}) failed")
        pre_p, pre_s = masks_of(pi.hProcess)
        info["mask_observed_suspended"] = pre_p
        info["system_mask_observed"] = pre_s

        expected = mask if mask is not None else pre_s
        if pre_p != expected:
            raise RuntimeError(
                f"affinity verification FAILED before resume: observed {pre_p!r} "
                f"({hex(pre_p) if pre_p is not None else 'n/a'}) != expected "
                f"{expected!r} ({hex(expected) if expected is not None else 'n/a'})")

        info["affinity_verified_before_resume"] = True
        info["mask_cpus"] = cpus_of(pre_p) if pre_p is not None else None

        rc_resume = k32.ResumeThread(pi.hThread)
        info["resume_thread_rc"] = int(rc_resume)
        info["resume_ok"] = int(rc_resume) != 0xFFFFFFFF

        post_p, _ = masks_of(pi.hProcess)
        info["mask_observed_after_resume"] = post_p
        if post_p != pre_p:
            info["affinity_drifted"] = True
        else:
            info["affinity_drifted"] = False

        k32.WaitForSingleObject(pi.hProcess, INFINITE)
        code = wt.DWORD()
        k32.GetExitCodeProcess(pi.hProcess, ctypes.byref(code))
        info["exit_code"] = int(code.value)
        post2_p, _ = masks_of(pi.hProcess)
        info["mask_observed_at_exit"] = post2_p
        return info
    finally:
        if pi.hThread:
            k32.CloseHandle(pi.hThread)
        if pi.hProcess:
            k32.CloseHandle(pi.hProcess)
        out_f.close()
        err_f.close()


def _osfhandle(f):
    import msvcrt
    return msvcrt.get_osfhandle(f.fileno())


# --------------------------------------------------------------------------
# modes
# --------------------------------------------------------------------------
def probe_child():
    p, s = own_mask()
    print(json.dumps({"probe": "child", "pid": os.getpid(), "process_mask": p,
                      "system_mask": s, "cpus": cpus_of(p)}), flush=True)


def self_test():
    """Prove the mechanism on a HARMLESS child (no diagnostic, no CSV)."""
    out_dir = pathlib.Path(ROOT) / "work/b7_diag_20261011_paired_capture/phase19_planning"
    out_dir.mkdir(parents=True, exist_ok=True)
    cases = [("unpinned", None), ("pinned_cpu0", 0x1), ("pinned_cpu8", 0x100)]
    results = []
    for name, mask in cases:
        sp = out_dir / f"self_test_{name}_stdout.txt"
        ep = out_dir / f"self_test_{name}_stderr.txt"
        rec = {"case": name, "mask_intended": mask}
        try:
            rec.update(launch_suspended(sys.executable, [__file__, "--probe-child"],
                                        mask, sp, ep))
            child = json.loads(sp.read_text(encoding="utf-8").strip().splitlines()[-1])
            rec["child_reported_mask"] = child["process_mask"]
            rec["child_reported_cpus"] = child["cpus"]
            expected = mask if mask is not None else rec.get("system_mask")
            rec["expected"] = expected
            rec["CHILD_MASK_MATCHES_EXPECTED"] = (child["process_mask"] == expected)
        except Exception as e:
            rec["error"] = repr(e)
            rec["CHILD_MASK_MATCHES_EXPECTED"] = False
        results.append(rec)
        print(f"[{name}] intended={mask} child_reported={rec.get('child_reported_mask')} "
              f"match={rec.get('CHILD_MASK_MATCHES_EXPECTED')}")
    allok = all(r["CHILD_MASK_MATCHES_EXPECTED"] for r in results)
    (out_dir / "self_test.json").write_text(json.dumps(
        {"all_cases_passed": allok, "results": results,
         "note": "harmless child = this script in --probe-child mode; "
                 "no diagnostic was launched and no CSV was created"},
        indent=2), encoding="utf-8")
    print(f"self-test all cases passed: {allok}")
    return 0 if allok else 1


def build_plan(run_id, condition, mask, order):
    host_rel = f"{RUNS_BASE_REL}/{run_id}"
    diag_rel = f"{DIAG_BASE_REL}/{run_id}"
    argv = [diag_rel, "--host-capture-dir", host_rel]
    return {
        "run_id": run_id, "order": order, "condition": condition,
        "cwd": str(ROOT),
        "exe_rel": EXE_REL,
        "diag_dir_rel": diag_rel,
        "host_dir_rel": host_rel,
        "host_csv_rel": f"{host_rel}/paired_samples.csv",
        "argv": argv,
        "mask": mask,
        "expected_mask": mask if condition == "pinned" else "system mask (all logical CPUs)",
    }


def do_run(run_id, condition, mask, order, dry_run):
    plan = build_plan(run_id, condition, mask, order)
    exe = (ROOT / EXE_REL).resolve()
    host_dir = ROOT / plan["host_dir_rel"]
    ops = host_dir / "ops"
    csv_p = host_dir / "paired_samples.csv"

    print(json.dumps({"planned": plan, "exe": str(exe),
                      "exe_exists": exe.is_file()}, indent=2))

    # ---- preconditions (fail closed) ----
    problems = []
    if not exe.is_file():
        problems.append(f"executable missing: {exe}")
    else:
        got = sha256_file(exe)
        if got != EXE_SHA256_EXPECTED:
            problems.append(f"executable hash {got} != expected {EXE_SHA256_EXPECTED}")
    if host_dir.exists():
        problems.append(f"host dir already exists: {host_dir} (must be previously absent)")
    if csv_p.exists():
        problems.append(f"paired_samples.csv already exists: {csv_p}")
    self_p, self_s = own_mask()
    if self_p != self_s:
        problems.append("this wrapper is itself pinned; child inheritance would be ambiguous")
    if condition == "pinned" and (mask & self_s) != mask:
        problems.append(f"requested mask {mask:#x} is not inside the system mask {self_s:#x}")
    if problems:
        print("PRECONDITION FAILURE(S):", json.dumps(problems, indent=2))
        return 2

    if dry_run:
        print("DRY RUN: no process launched, no directory created.")
        return 0

    host_dir.mkdir(parents=True, exist_ok=False)
    ops.mkdir(parents=True, exist_ok=False)

    pre = snapshot("pre_run")
    meta = {"run": run_id, "order": order, "condition": condition,
            "plan": plan, "exe_sha256": sha256_file(exe),
            "pre_run_snapshot": pre}
    (ops / "pre_state.json").write_text(json.dumps(pre, indent=2), encoding="utf-8")

    t0 = time.perf_counter()
    meta["start_local"] = datetime.datetime.now().isoformat(timespec="milliseconds")
    res = launch_suspended(exe, plan["argv"], mask, ops / "stdout.txt", ops / "stderr.txt")
    t1 = time.perf_counter()
    meta["end_local"] = datetime.datetime.now().isoformat(timespec="milliseconds")
    meta["elapsed_sec"] = round(t1 - t0, 3)
    meta["launch"] = res

    post = snapshot("post_run")
    meta["post_run_snapshot"] = post
    (ops / "post_state.json").write_text(json.dumps(post, indent=2), encoding="utf-8")

    for name in ("stdout.txt", "stderr.txt"):
        p = ops / name
        meta[f"{name}_bytes"] = p.stat().st_size
        meta[f"{name}_sha256"] = sha256_file(p)

    meta["host_csv_exists"] = csv_p.is_file()
    if csv_p.is_file():
        meta["host_csv_bytes"] = csv_p.stat().st_size
        meta["host_csv_sha256"] = sha256_file(csv_p)

    meta["historical_csv_sha256_now"] = sha256_file(ROOT / B7_CSV_REL)
    meta["historical_csv_unchanged"] = (
        meta["historical_csv_sha256_now"] == B7_CSV_SHA256_EXPECTED)
    meta["frozen_thresholds"] = THRESHOLDS

    (ops / "exec_meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    (ops / "exitcode.txt").write_text(f"{res['exit_code']}\n", encoding="utf-8")

    # build/ is diagnostic-owned and auto-cleaned; leave an explicit record.
    print(json.dumps({"run_id": run_id, "condition": condition,
                      "mask_intended": mask,
                      "mask_cpus": res.get("mask_cpus"),
                      "affinity_verified_before_resume": res.get("affinity_verified_before_resume"),
                      "affinity_drifted": res.get("affinity_drifted"),
                      "exit_code": res.get("exit_code"),
                      "elapsed_sec": meta["elapsed_sec"],
                      "csv": meta.get("host_csv_sha256"),
                      "historical_csv_unchanged": meta["historical_csv_unchanged"]}, indent=2))
    return 0


def main():
    ap = argparse.ArgumentParser(description="Phase 19 affinity launch wrapper")
    ap.add_argument("--probe-child", action="store_true")
    ap.add_argument("--self-test", action="store_true")
    ap.add_argument("--topology", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--run-id")
    ap.add_argument("--condition", choices=["pinned", "unpinned"])
    ap.add_argument("--mask", default=hex(PIN_MASK_DEFAULT))
    ap.add_argument("--order", type=int)
    a = ap.parse_args()

    if a.topology:
        print(json.dumps(topology(), indent=2))
        return 0
    if a.probe_child:
        probe_child()
        return 0
    if a.self_test:
        return self_test()
    if not a.run_id or not a.condition:
        ap.error("--run-id and --condition are required (or use --self-test/--probe-child)")

    mask = None if a.condition == "unpinned" else int(a.mask, 16)
    order = a.order if a.order is not None else -1
    return do_run(a.run_id, a.condition, mask, order, a.dry_run)


if __name__ == "__main__":
    sys.exit(main())
