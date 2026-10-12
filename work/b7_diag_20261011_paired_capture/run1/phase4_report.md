APEX — PHASE 4 PAIRED-OVERHEAD EVIDENCE REPORT
status: single authorized execution completed; CSV capture failure documented.
date_utc: 2026-10-12T10:05:04Z
cwd during execution: /e/My Local AI/stark
capture root: /e/My Local AI/work/b7_diag_20261011_paired_capture/run1/

========================================================================
1. IDENTITY AND PROVENANCE (STEP 1 — PASS)
========================================================================

File identity (SHA-256), all MATCH the expected values:
  executable : expected 5894d2e23f17248692dcd17a2a7a7e3e4033dfb90d4ea24f046ae84df37dfcec
               actual   5894d2e23f17248692dcd17a2a7a7e3e4033dfb90d4ea24f046ae84df37dfcec  MATCH
               path     stark/build-b7diag-20261011/bm_b7_diagnostic.exe
  source     : expected d09c0c29d27c3d42c4bff9fb9597af618fd58dda259c1048a1ef1d694e37ee53
               actual   d09c0c29d27c3d42c4bff9fb9597af618fd58dda259c1048a1ef1d694e37ee53  MATCH
               path     stark/src/phase1/diagnostics/bm_b7_diagnostic.cpp
  cmake      : expected 575fe264921512f41d30267c1c659e3662bbcfd92e71623720f9d047b7dddcc8
               actual   575fe264921512f41d30267c1c659e3662bbcfd92e71623720f9d047b7dddcc8  MATCH
               path     stark/CMakeLists.txt

Build provenance (build.ninja + .ninja_log + CMakeCache.txt in
stark/build-b7diag-20261011/):
  - executable depends ONLY on these 4 .obj:
        CMakeFiles/bm_b7_diagnostic.dir/src/phase1/diagnostics/bm_b7_diagnostic.cpp.obj
        CMakeFiles/bm_b7_diagnostic.dir/src/phase1/bench/TinyDenseModel.cpp.obj
        CMakeFiles/bm_b7_diagnostic.dir/src/phase1/bench/ParameterAccounting.cpp.obj
        CMakeFiles/bm_b7_diagnostic.dir/src/phase1/common/ExperimentRecord.cpp.obj
  - each .obj is compiled from the corresponding .cpp under stark/src/.
  - compiler identity recorded in CMakeCache.txt:
        CMAKE_CXX_COMPILER:STRING=C:/Users/rahul/AppData/Local/Microsoft/WinGet/Packages/BrechtSanders.WinLibs.POSIX.UCRT_Microsoft.Winget.Source_8wekyb3d8bbwe/mingw64/bin/g++.exe
  - build config: CMAKE_BUILD_TYPE=Release; Ninja generator.
  - build.ninja link line (verbatim):
        build bm_b7_diagnostic.exe: CXX_EXECUTABLE_LINKER__bm_b7_diagnostic_Release \
          CMakeFiles/bm_b7_diagnostic.dir/src/phase1/diagnostics/bm_b7_diagnostic.cpp.obj \
          CMakeFiles/bm_b7_diagnostic.dir/src/phase1/bench/TinyDenseModel.cpp.obj \
          CMakeFiles/bm_b7_diagnostic.dir/src/phase1/bench/ParameterAccounting.cpp.obj \
          CMakeFiles/bm_b7_diagnostic.dir/src/phase1/common/ExperimentRecord.cpp.obj
  - .ninja_log records the object blob 98ee4f9291597bda for bm_b7_diagnostic.cpp.obj
    and the final exe blob 987b9f1252d0b7a1.

Provenance conclusion: file identity is confirmed, and the executable is tied to the
intended source/dependencies/compiler via the build system artifacts. A hash match
establishes file identity; build provenance is supported, not established solely by the
hash. No stop condition triggered.

========================================================================
2. EXECUTION (STEP 3 — ONE RUN)
========================================================================

Command (POSIX, from /e/My Local AI/stark):
  /e/My Local AI/stark/build-b7diag-20261011/bm_b7_diagnostic.exe

Captured artifacts (all under work/b7_diag_20261011_paired_capture/run1/):
  stdout.txt        4623 bytes
  stderr.txt         0 bytes
  exitcode.txt       2 bytes  (content: "0")
  exec_meta.json    89 bytes  (created pre-run, patched post-run)
  paired_samples.csv ABSENT (not written)

Run metadata:
  start_utc: 2026-10-12T10:04:59Z
  end_utc  : 2026-10-12T10:05:04Z  (exec_meta patched after run)
  exit_code: 0
  stderr   : empty
  run-owned blob: build/bm_b7_diagnostic/run_1791799501127597800_0/bm_b7_diagnostic_weights.bin
                 bytes=1051664
  cleanup   : run-owned blob removed; run dir kept (not empty or remove failed)
  paired_csv_present: false  (exec_meta)

Execution exit status captured explicitly: 0.

Preservation: stdout, stderr, exitcode, and exec_meta were all preserved. The one
artifact that was anticipated but NOT produced is paired_samples.csv. That is reported as
a capture failure, not a successful capture.

========================================================================
3. CSV CAPTURE FAILURE — ROOT ANALYSIS
========================================================================

Where the diagnostic is coded to write the CSV (source):
  stark/src/phase1/diagnostics/bm_b7_diagnostic.cpp
    - PairedSample struct: replicate, iteration, minimal_sec, instrumented_sec, signed_overhead_pct
    - make_paired_artifact_path(run_dir) -> run_dir + "/" + "paired_samples.csv"
    - PairedArtifact::write(run_dir, minimal, instrumented):
        * guards: minimal.size()==instrumented.size()
        * guards: every replicate in BOTH conditions valid
        * path = make_paired_artifact_path(run_dir)
        * validate_diagnostic_path(path) must be empty
        * exclusive_create_file(path) must return fd >= 0
        * fdopen/fopen of that fd; write header + 300 data rows with fprintf(
              "%u,%zu,%#.9g,%#.9g,%#.9g\n", minimal[i].index, j, a[j], b[j], pct)
          where pct = 100.0*(b[j]-a[j])/a[j]
        * fflush then _commit/fsync; on success sets written=true, path set, note cleared
        * on failure sets path, note, written=false
    - call site (in run_bm_b7_diagnostic, AFTER pairing data exists, BEFORE cleanup + stdout):
        write_paired_artifact_if_valid(paired, blob.run_dir, rep.minimal, rep.instrumented);
    - PairedArtifact lives inside try{}; cleanup.perform() runs after.

What this means operationally:
  - The CSV is written into blob.run_dir, NOT into the host capture directory
    work/b7_diag_20261011_paired_capture/run1/. The host directory was never a legal
    target for the CSV under this binary's existing code.
  - blob.run_dir is the run-owned directory under build/bm_b7_diagnostic/
    (here: run_1791799501127597800_0).
  - The diagnostic's cleanup removed the run-owned blob. The kept-run-dir note
    ("run dir kept (not empty or remove failed)") indicates the run dir was NOT removed,
    which is consistent with something remaining inside it (the CSV, if written).

Evidence about what actually happened:
  - After the run: build/bm_b7_diagnostic/ is EMPTY (0 files). So if a run dir was kept,
    it is not present under build/bm_b7_diagnostic now, and no paired_samples.csv is
    visible anywhere under the repo via the paths checked.
  - The current on-disk source includes the paired-capture wiring; the executed binary
    was built from that source. So the binary SHOULD have attempted the write.
  - But the run-owned run dir that would contain the CSV (run_1791799501127597800_0) is
    not present now, and no paired_samples.csv is present anywhere checked.
  - Therefore the most likely outcomes, in order, are:
       (a) the CSV was written into the run dir and then the run dir was later removed or
           became unreachable (e.g. cleanup on a later operation, or the "kept" note is
           stale vs current state), or
       (b) the write was refused by one of the PairedArtifact guards (e.g. a validation
           path check, exclusive-create failure, fdopen/commit failure), in which case
           note would have been set — but that note is NOT rendered in stdout (the report
           renders cleanup note only), so the refusal reason is currently unobservable
           from the preserved artifacts.

Unfortunately the run-owned run directory that should have contained the CSV is not
present in the preserved state, so (a) vs (b) cannot be distinguished from the captured
evidence. The stdout report does not carry the PairedArtifact note, and the run dir that
should have held the CSV is absent now.

Interim verification artifact (exec_meta) confirms the run finished and that
paired_csv_present=false at the time exec_meta was patched (post-run). It does not
contain a CSV path field because no successful write was detected at patch time.

So STEP 3's capture requirement ("paired_samples.csv under work/.../run1/") was NOT
met by the binary as built; the binary writes into the run-owned directory, and that
run-owned directory is not present in the preserved state. This is a genuine capture
gap, not a skipped step.

========================================================================
4. WHAT CAN AND CANNOT BE VERIFIED WITHOUT THE CSV
========================================================================

CAN be verified from stdout (which IS present, 4623 bytes, stderr empty, exit 0):

  Protocol (verbatim):
    warmup=10 (untimed), measured=50, macro_replicates_per_condition=6

  Both conditions fully valid, 6 replicates each:
    MINIMAL   : 6/6 VALID
    INSTRUMENTED: 6/6 VALID

  Pooled summary (INSTRUMENTED condition, from stdout):
    n=300 median=3014.650 us  mean=3151.721 us  stdev=519.572 us  cv=16.49 %
    min=2344.500 us  p95=4091.055 us  max=5938.600 us  iqr=431.375 us

  Pooled summary (MINIMAL condition, from stdout):
    n=300 median=2977.200 us  mean=3045.738 us  stdev=550.830 us  cv=18.09 %
    min=2324.200 us  p95=3705.670 us  max=10072.100 us  iqr=374.775 us

  Component decomposition (INSTRUMENTED, pooled, from stdout):
    open       median=123.950 us  mean=127.530 us
    read       median=2716.500 us mean=2848.087 us
    deserialize median=74.450 us  mean=78.678 us
    residual   median=92.650 us  mean=97.427 us

  Calibration (printed by the process, from stdout):
    mean_overhead_pct        = 3.4797 %   (threshold <= 2.0000 %)
    worst_case_overhead_pct  = 87.9306 %  (threshold <= 10.0000 %)
    median_deviation_pct     = 1.2579 %   (threshold <= 2.0000 %)
    threshold checks: mean NOT OK, worst-case NOT OK, median-deviation OK
    status: FAIL — instrumentation overhead exceeds threshold(s): mean worst-case

  Classification (from stdout):
    classification: NOT_ELEVATED
    historical comparison reference: 5721.90 us (G7CAM-B7-E5-11933807) — comparison datum only

CANNOT be verified without the CSV (the requested STEP 4 items):
  - exact 300-row CSV with columns replicate, iteration, minimal_sec, instrumented_sec,
    signed_overhead_pct — NOT available
  - top 10 largest absolute paired overheads with replicate/iteration identifiers and both
    underlying timings — NOT available
  - maximum positive and negative overhead values — NOT available from data; only the
    SIGNED worst-case (max signed) is available from stdout, and it is 87.9306 %
  - mean and median OF THE PER-PAIR OVERHEADS — NOT available (stdout gives pooled-mean
    and pooled-median-based deviation, which are different quantities)
  - absolute-overhead concentration for largest 1/3/5/10 pairs — NOT available
  - independent recomputation of the calibration from raw pairs — NOT possible; only a
    conceptual recomputation is possible from the pooled summary numbers, and that is not
    equivalent to recomputing from the 300 pairs

So the requested STEP 4 data-grade analysis is blocked by the missing CSV. The stdout
gives the derived calibration + classification + pooled summaries, but not the 300 paired
observations.

========================================================================
5. CALIBRATION / CLASSIFICATION CONSISTENCY CHECK (from stdout, no CSV)
========================================================================

The process printed:
  mean_overhead_pct        = 3.4797 %
  worst_case_overhead_pct  = 87.9306 %
  median_deviation_pct     = 1.2579 %

Thresholds (from source, unchanged):
  kCalibMeanOverheadThresholdPct       = 2.0
  kCalibWorstOverheadThresholdPct      = 10.0
  kCalibMedianDeviationThresholdPct    = 2.0

Checks (signed worst-case, per source):
  mean_ok      = |3.4797| <= 2.0  -> FALSE
  worst_ok     = 87.9306 <= 10.0   -> FALSE
  median_ok    = 1.2579 <= 2.0     -> TRUE

Status per source logic:
  PASS iff mean_ok && worst_ok && median_ok
  FAIL iff (computable) && !(PASS)
  => FAIL, with note listing the failing checks: "mean worst-case"
  => This matches the printed note exactly.

Classification:
  Sufficient replication? Yes — 6 valid replicates in each condition.
  Calibration PASS? No.
  All replicates elevated in both conditions? No — pooled medians ~3014.65 / 2977.20 us,
  both below 5721.90 us, and per-replicate medians are also below 5721.90 us.
  none_elevated? Yes — zero replicates elevated in either condition.
  => Rule 4 applies -> NOT_ELEVATED.
  => This is consistent with the printed classification.

So the calibration FAIL and the NOT_ELEVATED classification are internally consistent
with the printed numbers and the unchanged thresholds and rules. No discrepancy between
printed values and the documented implementation — but this is a consistency check on the
printed summary values, not an independent recomputation from the 300 pairs, because the
pairs were not captured.

========================================================================
6. CONCENTRATION / OUTLIER QUESTION — ANSWERABLE ONLY PARTIALLY
========================================================================

What is confirmable from stdout:
  - The reported worst_case_overhead_pct is the SIGNED maximum over the 300 aligned pairs
    (per source). It is 87.9306 %. That is a single extreme signed observation or a few
    large positive ones setting the signed maximum; the source makes the statistic
    structurally vulnerable to a single extreme positive pair.
  - The mean overhead (pooled) is +3.4797 % and the median-deviation is 1.2579 %, both
    small; that pattern is consistent with a worst-case driven by a relatively small
    number of large positive pairs, but it is not sufficient to confirm concentration
    quantitatively.
  - The pooled stdev (519.572 us INSTR, 550.830 us MIN) and max/min ranges (MIN max
    10072.100 us vs median 2977.200 us) indicate substantial per-iteration variability,
    but that is pooled timing variability, not per-pair overhead concentration.

What is NOT confirmable without the CSV:
  - the top 10 absolute paired overheads and their identifiers
  - the max positive and max negative per-pair overheads (separately)
  - mean/median per-pair overhead
  - absolute-overhead concentration for top 1/3/5/10 pairs
  - rank needed to reach 50% of total absolute overhead
  - how many of the 300 pairs exceed 1/5/10/20/100% absolute overhead

Conclusion on concentration: the evidence is consistent with an outlier-driven worst-case
(because the signed max is large while pooled mean/median-deviation are small), but the
quantitative concentration requested in STEP 4 cannot be established because the 300
paired observations were not preserved.

========================================================================
7. IMMUTABLE BOUNDARIES — CONFIRMED RESPECTED
========================================================================

  - No second execution: exactly one run performed.
  - No rebuild: the existing binary was used; no source edit, no rebuild.
  - No new benchmark campaign, no G7 campaign, no G7CAM modification.
  - No production change, no threshold change, no rule/formula change.
  - Frozen evidence not modified (no write to reports/ evidence manifests / records).
  - M0 remains FAIL; M1 remains LOCKED (not changed by this run or report).

The only new artifact writes were the run's own run-owned blob (later removed by cleanup),
the host-capture artifacts (stdout/stderr/exitcode/exec_meta), and this report file. No
change to source, cmake, build config, evidence manifests, or records.

========================================================================
8. EVIDENCE INVENTORY (preserved)
========================================================================

  work/b7_diag_20261011_paired_capture/run1/
    stdout.txt       4623 bytes  (complete report; includes calibration + classification)
    stderr.txt         0 bytes  (empty)
    exitcode.txt       2 bytes  ("0")
    exec_meta.json    89 bytes  (run metadata; paired_csv_present=false)
    paired_samples.csv ABSENT

  stark/build/bm_b7_diagnostic/
    (empty after cleanup; no run dir present now)

  stark/build-b7diag-20261011/
    bm_b7_diagnostic.exe            3162878 bytes  sha256 5894...dfcec
    CMakeCache.txt, build.ninja, .ninja_log, CMakeFiles/...  (build provenance)

========================================================================
9. CONCLUSIONS
========================================================================

Confirmed:
  1. The executable, source, and cmake hashes all match the expected values.
  2. The executable is tied to the intended source/dependency set/compiler via
     build.ninja + .ninja_log + CMakeCache.txt.
  3. One execution was performed under the documented working directory/protocol.
  4. The run produced a complete stdout report (calibration + classification +
     component decomposition + pooled summaries), empty stderr, and exit code 0.
  5. The calibration printed values (mean 3.4797%, worst-case 87.9306%, median-deviation
     1.2579%) produce a FAIL under the unchanged thresholds, and the printed FAIL note
     matches the documented note logic exactly.
  6. The classification NOT_ELEVATED is consistent with the printed numbers and unchanged
     rules (no replicate elevated; zero-elevated rule applies).
  7. The single authorized execution did NOT produce the requested paired_samples.csv at
     the requested host path, and the run-owned directory that should have contained it is
     not present in the preserved state, so the capture requirement for paired_samples.csv
     was not met.

Cannot be determined from the evidence this run preserved:
  1. The 300 raw paired observations and all quantities that depend on them (top-10
     absolute overheads with identifiers, max positive/negative per-pair overheads,
     mean/median per-pair overhead, absolute-overhead concentration for top 1/3/5/10,
     rank-to-50%-of-total-absolute-overhead).
  2. Whether the CSV was actually written and then lost/removed, or whether the write was
     refused by a PairedArtifact guard — the current preserved state does not contain the
     run-owned run directory and the stdout report does not render the artifact-write note.

Best evidence-based next action (if any):
  If the goal is to answer the concentration/outlier question quantitatively, the smallest
  change that would close the gap is to capture the 300 paired observations under a
  host-visible path (not solely inside the auto-cleaned run-owned directory) from one
  authorized run. That would be a capture-path change only (output artifact location),
  not a change to formulas, thresholds, pairing, or classification, and it would require
  separate authorization because this run already used the single authorized execution and
  did not preserve the CSV.

Report written to:
  work/b7_diag_20261011_paired_capture/run1/phase4_report.md
