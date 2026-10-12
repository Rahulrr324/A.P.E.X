APEX — B7 PAIRED-CAPTURE PERSISTENCE FIX (BUILD-ONLY)
status: build complete; no execution performed.
date_utc: 2026-10-12T16:00Z

1) PRESERVED BEFORE EDITING
   snapshot: work/b7_diag_20261011_paired_capture/snapshot_pre_fix_20261012T101312Z/
     - bm_b7_diagnostic.cpp  (copy of pre-edit source)
     - CMakeLists.txt
     - hashes_before.txt
   pre-edit backup (in-tree): stark/src/phase1/diagnostics/bm_b7_diagnostic.cpp.pre_edit
   existing reports/artifacts under work/b7_diag_20261011_paired_capture/run1/ preserved unchanged.

2) HASHES
   changed file:
     stark/src/phase1/diagnostics/bm_b7_diagnostic.cpp
       pre-edit  : d09c0c29d27c3d42c4bff9fb9597af618fd58dda259c1048a1ef1d694e37ee53
       post-edit : 5ff3a4e4fa952aa0761734e4b4e34bfbbe4810fbb1f89b73d85e5426a4e38ac9
   unchanged:
     stark/CMakeLists.txt : 575fe264921512f41d30267c1c659e3662bbcfd92e71623720f9d047b7dddcc8
   built artifact:
     stark/build-b7diag-20261011/bm_b7_diagnostic.exe
       sha256 : a2e9e0ada6df0f10a91681e96349349166a081dcca0570312c6d175ad0691bd6

3) BUILD
   toolchain:
     g++   : g++.exe (MinGW-W64 x86_64-ucrt-posix-seh, built by Brecht Sanders, r1) 16.2.0
     cmake : cmake version 4.4.2
     ninja : 1.13.2.git.kitware.jobserver-pipe-1
   command (verbatim):
     cd "stark" && cmake --build build-b7diag-20261011 --target bm_b7_diagnostic -- -v
   build exit: 0
   notes: build-only; binary was NOT executed.

4) WHAT CHANGED (surgical; paired-artifact persistence only)
   - PairedArtifact::write signature changed from
       write(run_dir, minimal, instrumented)
     to
       write(minimal, instrumented)
     Host path is now configured via set_host_path() before calling write(); if not
     configured, write records a note and returns without writing (backward-compatible).
   - New helper: validate_host_capture_path(const std::string& raw)
       Rejects absolute paths, drive letters/schemes, ".." traversal, and the usual
       campaign/historical/production markers (g7-campaign, g7cam, reports, records,
       .jsonl, evidence_manifest, gate_results, tiny_dense_2l_weights.bin).
       By design it does NOT enforce the build/bm_b7_diagnostic/ prefix, because the
       host work area is intentionally outside that directory.
   - New method: PairedArtifact::set_host_path(const std::string&)
   - Call site updated:
       write_paired_artifact_if_valid(paired, rep.minimal, rep.instrumented);
     (run_dir arg removed; host path expected to be configured before this call.)
   - Re-added: abort_report(DiagnosticReport&, const std::string&) definition (was
     dropped during the rewrite).
   - Added: forward declarations for validate_host_capture_path and abort_report before
     PairedArtifact (they are used before their definitions).
   - No change to measurement timing, benchmark operations, pairing, calibration,
     classification, thresholds, warmups, sample counts, exit codes, BlobCleanup, or
     validate_diagnostic_path/ensure_directory/exclusive_create_file semantics.

5) WHAT DID NOT CHANGE
   - stark/CMakeLists.txt (hash above unchanged).
   - frozen evidence under stark/reports/ (hashes match pre-Phase-3 records; see section 7).
   - build system, compiler flags, dependency set, or target linkage.

6) CSV DESTINATION (persistence fix intent)
   When configured, host CSV is written to:
     <host_path>/paired_samples.csv
   with exclusive no-overwrite creation (O_CREAT|O_EXCL), and the intended run-specific
   host path is:
     work/b7_diag_20261011_paired_capture/run2/paired_samples.csv
   This path:
     - is relative (no drive letter, no absolute prefix, no ".."),
     - does NOT start with build/bm_b7_diagnostic/, and
     - is therefore outside the directories removed by BlobCleanup.
   Confirmed (separate verification script, same logic as validate_host_capture_path):
     work/b7_diag_20261011_paired_capture/run2/paired_samples.csv -> OK
     reports/evidence_manifest.json -> REJECT (forbidden:reports)
     reports/g7-campaign/evidence_manifest.json -> REJECT (forbidden:g7-campaign)
     reports/g7-campaign-affinityfix/records_sha256.txt -> REJECT (forbidden:g7-campaign)
     reports/v2.4/evidence_manifest.json -> REJECT (forbidden:reports)
     reports/g7-campaign/tiny_dense_2l_weights.bin -> REJECT (forbidden:g7-campaign)
     /absolute/path/paired_samples.csv -> REJECT (absolute)
     work/../evidence_manifest.json -> REJECT (traversal)
     work:g7cam/paired_samples.csv -> REJECT (drive/scheme)

7) FROZEN-EVIDENCE INTEGRITY (unchanged; matches pre-Phase-3 records)
   stark/reports/evidence_manifest.json                                   14975fa285362d4bb6f92f08840841de6edfad88b29dfd101107075731d473d3
   stark/reports/g7-campaign/evidence_manifest.json                       7a8dd9de17c4effdc9153ac4505a6f6f95ed662ef204cab52ad279c4bf01fc5a
   stark/reports/g7-campaign-affinityfix/records_sha256.txt               bf479cbcf08eef94bfd6481f16e6a881e0e15b52cbec05aaed0377afe2edc6ae
   stark/reports/v2.1/evidence_manifest.json                              38007605eb7f4de3c95c9a8596aefaa36d6936ebb68617b5a86f7eb85efab929
   stark/reports/v2.2/evidence_manifest.json                              539f1e5a4ab7d44332ebf756bc5b97ea5fdf43335b7eb13e7f2a34d6836ac9ea
   stark/reports/v2.3/evidence_manifest.json                              991a345b186a2ec20ae5bb7e013b378a0a66e1a9bf1c904fe0c43483e4cb6cab
   stark/reports/v2.4/evidence_manifest.json                              d3c01a9287b4510fde3d10c27a507cece28b21278da21b4495f4ac8c1137b54b
   These match work/b7_diag_20261011/hashes_evidence_before.txt exactly.

8) HALTED AS REQUESTED
   No diagnostic execution, retry, another benchmark run, G7 campaign, G7CAM change,
   production change, threshold change, or M0/M1 status change was performed.
   Waiting for separate explicit authorization for one diagnostic run using the rebuilt
   binary and the configured host path work/b7_diag_20261011_paired_capture/run2/.
