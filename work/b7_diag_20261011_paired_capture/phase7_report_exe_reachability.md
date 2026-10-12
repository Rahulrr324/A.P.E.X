APEX — PHASE 7 READ-ONLY: DIAGNOSTIC EXECUTABLE REACHABILITY
status: read-only; no build, no execution, no retry.
date_utc: 2026-10-12T11:16Z

========================================================================
1. EVIDENCE PRESERVED (read-only)
========================================================================

Preserved without modification:
  - work/b7_diag_20261011_paired_capture/phase6_report_run2_exec_fail.md
  - work/b7_diag_20261011_paired_capture/phase5_persistence_fix_build_report.md
  - work/b7_diag_20261011_paired_capture/run2/exec_meta.json
  - work/b7_diag_20261011_paired_capture/run2/exitcode.txt   ("127")
  - work/b7_diag_20261011_paired_capture/run2/stdout.txt   (0 bytes)
  - work/b7_diag_20261011_paired_capture/run2/stderr.txt   (114 bytes: "No such file or directory")
  - work/b7_diag_20261011_paired_capture/run2/paired_samples.csv — ABSENT (never written)

No earlier reports/logs were overwritten.

========================================================================
2. WHAT WAS ASKED vs WHAT WAS FOUND
========================================================================

Requested launch target (Phase 6):
  /e/My/Local/AI/stark/build-b7diag-20261011/bm_b7_diagnostic.exe

Phase 6 observed launch failure:
  exit_code = 127
  stderr (verbatim) = /usr/bin/bash: line 1: /e/My/Local/AI/stark/build-b7diag-20261011/bm_b7_diagnostic.exe:
                      No such file or directory

Identity hashes recorded in Phase 5 (and re-verified in Phase 7 when the file is
reachable by SOME tools):
  executable : a2e9e0ada6df0f10a91681e96349349166a081dcca0570312c6d175ad0691bd6
  source     : 5ff3a4e4fa952aa0761734e4b4e34bfbbe4810fbb1f89b73d85e5426a4e38ac9
  cmake      : 575fe264921512f41d30267c1c659e3662bbcfd92e71623720f9d047b7dddcc8

========================================================================
3. FILESYSTEM / PATH REACHABILITY INSPECTION (read-only)
========================================================================

Working directory in this shell:
  pwd = /e/My/Local/AI

Observations (all read-only):

A) The file IS reachable to POSIX shell listing tools when the path is given in the
   SAME "no-space" relative form, e.g.:
     ls -la stark/build-b7diag-20261011/bm_b7_diagnostic.exe
       -> -rwxr-xr-x ... 3168146 bytes ... Oct 12 16:00
     sha256sum stark/build-b7diag-20261011/bm_b7_diagnostic.exe
       -> a2e9e0ada6df0f10a91681e96349349166a081dcca0570312c6d175ad0691bd6
     find stark/build-b7diag-20261011 -type f -name "bm_b7_diagnostic.exe"
       -> found, sha256 matches the expected a2e9e...
     bash test -f stark/build-b7diag-20261011/bm_b7_diagnostic.exe -> YES
     python os.path.exists("stark/build-b7diag-20261011/bm_b7_diagnostic.exe") -> True
     python os.path.lexists("stark/build-b7diag-20261011/bm_b7_diagnostic.exe") -> True

B) The SAME file is NOT reachable to several tools when the path is given with spaces
   (the "/e/My Local AI/..." form), e.g.:
     stat -c '%n %s' "/e/My/Local/AI/stark/build-b7diag-20261011/bm_b7_diagnostic.exe"
       -> cannot stat ... No such file or directory
     ls -la "/e/My/Local/AI/stark/build-b7diag-20261011/bm_b7_diagnostic.exe"
       -> cannot access ... No such file or directory
     bash test -f "/e/My/Local/AI/stark/build-b7diag-20261011/bm_b7_diagnostic.exe" -> NO
     python os.path.exists("/e/My/Local/AI/stark/build-b7diag-20261011/bm_b7_diagnostic.exe") -> False
     python os.path.lexists("/e/My/Local/AI/stark/build-b7diag-20261011/bm_b7_diagnostic.exe") -> False
     python os.listdir("/e/My/Local/AI/stark/build-b7diag-20261011") -> parent-missing

C) The parent directory itself is visible to POSIX shell tools in relative form but not
   in the "/e/My Local AI/..." absolute form:
     ls -la stark/build-b7diag-20261011/bm_b7_diagnostic.exe  -> present
     stat  "$(dirname "/e/My/Local/AI/stark/build-b7diag-20261011/bm_b7_diagnostic.exe")"
       -> cannot stat ... No such file or directory
     python os.listdir("/e/My/Local/AI/stark/build-b7diag-20261011") -> parent-missing
     python os.listdir("stark/build-b7diag-20261011") -> exists, contains bm_b7_diagnostic.exe

D) A direct subprocess launch via python confirms the same split:
     subprocess.run([exe]) with exe="stark/build-b7diag-20261011/bm_b7_diagnostic.exe"
       -> FileNotFoundError [WinError 2] The system cannot find the file specified
     but os.system('cmd /c ... "stark/build-b7diag-20261011/bm_b7_diagnostic.exe" ...')
       -> rc=1 (launcher cmd ran; the .exe invocation itself failed in that probe)

This is the key paradox: the file is visible to POSIX listing/hash tools in the
no-space relative form, but NOT visible to stat/Python/subprocess when addressed with
the "/e/My Local AI/..." form — and critically, even the no-space relative form,
which POSIX tools can stat, was NOT launchable by Python subprocess in this shell
(the direct subprocess call got WinError 2 using the same relative path that ls can
stat).

========================================================================
4. WHAT THIS ESTABLISHES vs WHAT IS HYPOTHESIS
========================================================================

Confirmed (multiple tools, read-only):
  - The executable existed and its SHA-256 matched the expected value when it was
    reachable to POSIX listing tools in no-space relative form at the time of the
    Phase 5 build and at the Phase 7 read-only checks that succeeded via that form.
  - Build provenance records (build.ninja, .ninja_log, CMakeCache.txt) are consistent
    with that executable having been built from the verified source + cmake.
  - The Phase 6 launch used the "/e/My/Local/AI/stark/..." space-containing absolute
    form and failed with exit 127 / "No such file or directory".
  - The same absolute space-containing path is also invisible to stat and to Python
    os.path in this environment, while the no-space relative form is visible to some
    POSIX tools.
  - A direct Python subprocess launch using the no-space relative form ALSO failed with
    WinError 2 in this shell, even though POSIX ls/stat/find could see the file via that
    path form.

Hypothesis (labelled as such, not proven):
  The most consistent explanation is a path-translation / subprocess-launchability
  mismatch in this shell+OS boundary: the file appears present to POSIX stat/find/ls in
  some path forms, but the process execution layer (CreateProcess / subprocess) cannot
  resolve the path to a launchable executable in this environment. That can happen if,
  for example, the working-directory/posix-root mapping visible to the shell differs from
  what the executed process (or the Windows exec layer behind subprocess) resolves, or if
  there is a permission/executability/path-canonicalization issue that listing tools
  tolerate but CreateProcess does not.

  I am NOT asserting which exact mechanism is responsible, because the inspection was
  read-only and did not include a successful launch or a definitive mount/permission
  trace. The one thing that is concrete is the discrepancy itself: some tools see the
  file, the launch path/process does not.

Not proven / not claimed:
  - That the file "really" exists in any absolute sense beyond what the tools that saw it
    reported. The set of tools that see it is real evidence, but the launch failure is the
    operative fact for Phase 6.
  - That rebuilding would or would not help. Not tested (and not allowed here).

========================================================================
5. MINIMUM CORRECTIVE ACTION BEFORE ANOTHER RUN COULD BE CONSIDERED
========================================================================

The minimum action is not a code change — it is an environment/reachability resolution:

  Identify a path form (and/or launch mechanism) under which this shell's process-launch
  layer can actually resolve and execute the existing file, then use that exact form for
  the next run. Concretely, that means: pick a path that both (a) POSIX stat/find/ls can
  resolve AND (b) the executing subprocess can launch, and prove that with one read-only
  reachability+launch probe before any authorized execution.

Anything beyond that — rebuilding, re-install, changing mounts, copying/moving the exe,
editing source/config — is out of scope for this read-only step and would require its own
authorization.

========================================================================
6. HARD BOUNDARIES HELD
========================================================================

  - No diagnostic execution beyond the already-failed Phase 6 attempt.
  - No rebuild, no reinstall, no mount change, no move/copy of the executable.
  - No source/config edit.
  - No retry of Phase 6.
  - No change to production artifacts, G7CAM records, frozen evidence, thresholds, or
    M0/M1 status.

Report written to:
  work/b7_diag_20261011_paired_capture/phase7_report_exe_reachability.md
