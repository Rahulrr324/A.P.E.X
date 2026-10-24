# STARK-L11.2 — Provenance Manifest

Branch `validation/l11-2-instrumentation-readiness`, parent commit
`6a43974433a0396f756536817f88421eb86edf8c`.

Format: `<64-hex sha256>` + two spaces + path relative to the repository root.

**No source, harness, test or build-configuration file was modified.** Every
artifact below is new. No official L11 evaluation was run; nothing here is a result.

## Artifacts

6aa257791d181494fbe886a54d0113275829788d3ea4505771bf14fcd9e552fc  work/L11_2_INSTRUMENTATION_IMPLEMENTATION.md
752c2a961219f60c25169d1ea8a357ee7f9e5d3ddd6c0dd04c62511316d26ff2  work/L11_2_INSTRUMENTATION_IMPLEMENTATION.json
a2cfb93f2cacb978b5292930533476579a353d661b0be921b4455fa4084b7656  work/L11_2_PREPARED_DIFF.md
627134d783810c31c48f04066c92fa7d2f626bab9825412961bff5f58173c06d  work/L11_2_FIELD_PROVENANCE.md
507d43a465db4d90ee5a434edf150b3a43e41a8bc5c4ae479a58ffdc3f3b0a1f  work/L11_2_TEST_RECORD.md
652f457b14f30821aea2afc07defee5a3de39851636b8b5ff794e75f02f872a9  work/l11_2_prototype/recompute_metrics.py
fc0f94b7a3ca0edb79f33a01bbd9a0fbea2e8f27cd493d4e8895ff047c9a6de1  work/L11_2_EVIDENCE/determinism_legacy.txt
e59a610f8db8b5f99a1e9d6db3284297d98a2f61388cb507beffa034a0c92d91  work/L11_2_EVIDENCE/feasibility_probe.cpp
0239f7e6f71749b4666396bafcc16b4a037ffd8ee613180f8d2fda36275dfc5e  work/L11_2_EVIDENCE/feasibility_probe_output.txt
2d378964211c5a8dbba5962214ae4ea0de4fec525e4a991c81f4eed55b9837ac  work/L11_2_EVIDENCE/reconstruction_fresh_evalkind0.json
bc9d13811b0da2dcecae2d7136f24b15efe2298dd2bf47e843084979207310c6  work/L11_2_EVIDENCE/reconstruction_L103_cross_123456789.json
fd6dffc7fa8a5b9d54b6934b67bb001667b3191957661dfa24de2fed1f908e40  work/L11_2_EVIDENCE/reconstruction_L103_cross_218213831.json
f9871e6f7379837511a54f8029afd77b76c3c549f317f1a77e26fb8c96f940f8  work/L11_2_EVIDENCE/reconstruction_L103_cross_171473193.json

## Classification

- `work/L11_2_INSTRUMENTATION_IMPLEMENTATION.md` — DESCRIPTIVE (readiness report)
- `work/L11_2_INSTRUMENTATION_IMPLEMENTATION.json` — DESCRIPTIVE (readiness report, machine-readable)
- `work/L11_2_PREPARED_DIFF.md` — PROPOSED / NOT APPLIED (implementation description)
- `work/L11_2_FIELD_PROVENANCE.md` — DESCRIPTIVE (35-field provenance matrix)
- `work/L11_2_TEST_RECORD.md` — DESCRIPTIVE (commands, exit codes, artifact hashes)
- `work/l11_2_prototype/recompute_metrics.py` — PROTOTYPE_ONLY (call-aware reconstruction)
- `work/L11_2_EVIDENCE/determinism_legacy.txt` — EVIDENCE (18/18 byte-identical)
- `work/L11_2_EVIDENCE/feasibility_probe.cpp` — PROTOTYPE_ONLY (read-only API probe, not a build target)
- `work/L11_2_EVIDENCE/feasibility_probe_output.txt` — EVIDENCE (probe output)
- `work/L11_2_EVIDENCE/reconstruction_fresh_evalkind0.json` — EVIDENCE (fresh-run reconstruction)
- `work/L11_2_EVIDENCE/reconstruction_L103_cross_123456789.json` — EVIDENCE (L10.3 reconstruction)
- `work/L11_2_EVIDENCE/reconstruction_L103_cross_218213831.json` — EVIDENCE (L10.3 reconstruction)
- `work/L11_2_EVIDENCE/reconstruction_L103_cross_171473193.json` — EVIDENCE (L10.3 reconstruction)

## Explicit non-deliverables

- No `trials11_*.csv` exists: implementation is not authorized (R3).
- No L11 evidence directory exists: zero L11 arms were run.
- No `stark/src/**` change: `git diff 6a43974 -- stark/` is empty.
- This manifest does not list itself.
