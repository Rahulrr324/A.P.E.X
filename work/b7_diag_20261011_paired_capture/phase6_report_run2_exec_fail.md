APEX — PHASE 6 SINGLE AUTHORIZED RUN: EXECUTION FAILED (NO RETRY)
status: execution failed; evidence preserved; halted as required.
date_utc: 2026-10-12T11:04Z

========================================================================
1. PREFLIGHT — identity/hashes/provenance/destination/uniqueness
========================================================================

Hashes (quoted absolute paths; verified twice):
  executable : expected a2e9e0ada6df0f10a91681e96349349166a081dcca0570312c6d175ad0691bd6
               actual   a2e9e0ada6df0f10a91681e96349349166a081dcca0570312c6d175ad0691bd6   MATCH (when file present)
  source     : expected 5ff3a4e4fa952aa0761734e4b4e34bfbbe4810fbb1f89b73d85e5426a4e38ac9
               actual   5ff3a4e4fa952aa0761734e4b4e34bfbbe4810fbb1f89b73d85e5426a4e38ac9   MATCH
  cmake      : expected 575fe264921512f41d30267c1c659e3662bbcfd92e71623720f9d047b7dddcc8
               actual   575fe264921512f41d30267c1c659e3662bbcfd92e71623720f9d047b7dddcc8   MATCH

Build provenance (build.ninja + .ninja_log + CMakeCache.txt under
stark/build-b7diag-20261011/):
  - build.ninja link line exists:
      build bm_b7_diagnostic.exe: CXX_EXECUTABLE_LINKER__bm_b7_diagnostic_Release \
        .../bm_b7_diagnostic.cpp.obj .../TinyDenseModel.cpp.obj \
        .../ParameterAccounting.cpp.obj .../ExperimentRecord.cpp.obj
  - .ninja_log records object blob 98ee4f9291597bda for bm_b7_diagnostic.cpp.obj and
    exe blob 987b9f1252d0b7a1.
  - CMakeCache.txt records compiler:
      CMAKE_CXX_COMPILER:STRING=.../mingw64/bin/g++.exe
  These are consistent with the build that produced the executable in the prior turn.
  Caveat: build provenance is supported by these records; it is not a substitute for the
  executable being on disk at execution time.

Host capture destination (configured):
  work/b7_diag_20261011_paired_capture/run2/paired_samples.csv
  - relative (no drive letter, no absolute prefix, no ".."),
  - does NOT start with build/bm_b7_diagnostic/,
  - survives diagnostic run-owned cleanup by construction.

Uniqueness:
  At capture time the host directory did not yet exist and was created by the runner;
  the CSV did not previously exist, so no overwrite was possible. (See failure below:
  the run never reached the point of writing it.)

========================================================================
2. EXECUTION — what happened
========================================================================

Attempted execution target:
  /e/My/Local/AI/stark/build-b7diag-20261011/bm_b7_diagnostic.exe

Result:
  exit_code = 127
  stderr (verbatim):
    /usr/bin/bash: line 1: /e/My/Local/AI/stark/build-b7diag-20261011/bm_b7_diagnostic.exe:
    No such file or directory

  stdout: empty (0 bytes)
  paired_samples.csv: ABSENT

Note on the failure mode: the executable was present and its hash matched at preflight in
one verification pass, but when the actual execution subprocess ran, the kernel/Posix-layer
file lookup returned "No such file or directory" (POSIX ENXDEV/ENOENT-style failure raised
by CreateProcess). This is a real execution blocker, not a build failure: the file was not
reachable by the executing process at run time.

Multiple independent checks agree the file is not currently present at that path now:
  - stat: "cannot stat ... No such file or directory"
  - ls -la (current): "cannot access ... No such file or directory"
  - find -type f (current): not found
  - bash test -f (current): NO
  - python os.path.exists / os.path.lexists (current): False
  - python os.listdir(parent): parent path not found

So the executable that was built and hash-verified in the prior turn is not available to
this execution. That is the proximate cause of exit_code 127.

One possible contributor (environment caveat, not asserted as the cause): earlier
verification passes showed a transient inconsistency where `ls` claimed the file existed
while `stat`/python did not. That kind of discrepancy can arise from path-translation or
visibility differences between tools/processes; here it does not change the conclusion,
because every method that matters for execution (stat, python, find, bash test -f) agrees
the file is absent when the runner attempted to start it.

========================================================================
3. CAPTURED EVIDENCE (preserved; nothing retried)
========================================================================

work/b7_diag_20261011_paired_capture/run2/
  exec_meta.json   — run metadata, start/end, hashes, exit_code=127, csv_present=false
  exitcode.txt     — "127"
  stdout.txt       — empty (0 bytes)
  stderr.txt       — 114 bytes (the "No such file or directory" message)
  paired_samples.csv — ABSENT (never written; run failed before any artifact write)

No retry was performed. The single authorized execution is exhausted by this failure.

========================================================================
4. VALIDATION — not applicable as executed
========================================================================

Because the run failed before producing any output or CSV, the requested validation steps
could not be performed:

  - 300 data rows / 5 columns / finite values / positive minimal timings / formula check:
    NOT APPLICABLE (no CSV produced)
  - independent recomputation vs stdout: NOT APPLICABLE (no stdout calibration numbers from
    this run; the prior successful run's numbers are from a different binary/run and are not
    this authorized execution's evidence)
  - top 10 absolute overheads, max pos/neg, mean/median per-pair overhead, concentration:
    NOT APPLICABLE (no paired observations captured)

The only thing that can be reported for this execution is the failure itself and the
preserved evidence of that failure.

========================================================================
5. FROZEN-EVIDENCE / BOUNDARY INTEGRITY
========================================================================

No source edits, no rebuild, no additional execution, no G7 campaign, no G7CAM change, no
production change, no threshold change, no frozen-evidence modification.

Frozen evidence hashes (stark/reports/) remain as previously recorded:
  evidence_manifest.json                                   14975fa285362d4bb6f92f08840841de6edfad88b29dfd101107075731d473d3
  g7-campaign/evidence_manifest.json                       7a8dd9de17c4effdc9153ac4505a6f6f95ed662ef204cab52ad279c4bf01fc5a
  g7-campaign-affinityfix/records_sha256.txt               bf479cbcf08eef94bfd6481f16e6a881e0e15b52cbec05aaed0377afe2edc6ae
  v2.1/evidence_manifest.json                              38007605eb7f4de3c95c9a8596aefaa36d6936ebb68617b5a86f7eb85efab929
  v2.2/evidence_manifest.json                              539f1e5a4ab7d44332ebf756bc5b97ea5fdf43335b7eb13e7f2a34d6836ac9ea
  v2.3/evidence_manifest.json                              991a345b186a2ec20ae5bb7e013b378a0a66e1a9bf1c904fe0c43483e4cb6cab
  v2.4/evidence_manifest.json                              d3c01a9287b4510fde3d10c27a507cece28b21278da21b4495f4ac8c1137b54b

M0 remains FAIL; M1 remains LOCKED.

========================================================================
6. CONCLUSION
========================================================================

Confirmed:
  - Preflight identity hashes for source and cmake match the expected values.
  - Build provenance records are consistent with the rebuilt binary from the prior turn.
  - Host capture destination is valid and survives cleanup by construction.
  - The single authorized execution failed with exit_code 127 because the executable was
    not reachable at run time, so no stdout/stderr/CSV evidence from this execution exists.
  - All available evidence of the failure is preserved; no retry was performed.

Not established / not deliverable from this execution:
  - CSV contents, row count, columns, formula validation, per-pair overhead statistics,
    concentration analysis — none applies because the run did not produce a CSV.

Best next action (if any), only if separately authorized:
  - Reconcile why the built executable is not currently reachable at the expected path at
    run time (environment/path-translation/visibility), then re-run exactly once under the
    same host-capture destination. Any such re-run would be a new authorization, not a
    continuation of this one.

Report written to:
  work/b7_diag_20261011_paired_capture/phase6_report_run2_exec_fail.md
