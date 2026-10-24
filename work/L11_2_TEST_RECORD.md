# STARK-L11.2 — Test and Validation Record

All commands were executed in this workspace on 2026-10-24 from the repository
root unless stated. Environment: Debian 12, g++ (Debian 12.2.0-14+deb12u1) 12.2.0, no cmake.
The build and all runs happened in /tmp/l112 (outside the repository); the
repository was not modified by any of them.

## E1 — build of the UNMODIFIED harness

```
$ cd /tmp/l112 && g++ -O2 -std=c++17 -Isrc -c src/learning/l10_validation_harness.cpp -o h.o
exit=0
$ for f in ContextConditionedMemory RelevanceRouting Network NeuralCell Synapse; do g++ -O2 -std=c++17 -Isrc -c src/**/$f.cpp; done
exit=0
$ g++ h.o *.o -o l11harness
exit=0
```
Six translation units: l10_validation_harness, ContextConditionedMemory,
RelevanceRouting, Network, NeuralCell, Synapse. No cmake is available, so the
build is explicit g++ — the same workaround recorded in L10.6/L11.1.

## E2 — legacy determinism (two independent runs)

```
$ mkdir -p runA runB && (cd runA && ../l11harness) && (cd runB && ../l11harness)
$ for f in $(ls runA); do cmp -s runA/$f runB/$f && echo IDENTICAL $f; done
RESULT: 18/18 files byte-identical
```
Full listing: work/L11_2_EVIDENCE/determinism_legacy.txt

## E3 — feasibility probe

```
$ g++ -O2 -std=c++17 -Isrc probe.cpp *.o -o probe && ./probe
exit=0
```
Output: work/L11_2_EVIDENCE/feasibility_probe_output.txt
Source: work/L11_2_EVIDENCE/feasibility_probe.cpp (not part of any build target)

## E4/E5 — metric reconstruction

```
$ python3 work/l11_2_prototype/recompute_metrics.py /tmp/l112/runA/trials_ccm_123456789.csv \
    --calls /tmp/l112/runA/calls_ccm_123456789.csv --eval-kind 0 \
    --metrics /tmp/l112/runA/metrics_ccm_123456789.csv --metrics-column acquisition
exit=0  -> 6 calls, 120 rows each, no ragged sizes, published_comparison.match=true

$ for s in 123456789 218213831 171473193; do python3 work/l11_2_prototype/recompute_metrics.py \
    work/l10_raw/context_contribution_20261024/KC_cross/trials_ctxnovel_T3_K3_${s}_KX.csv.gz \
    --calls .../calls_ctxnovel_T3_K3_${s}_KX.csv --eval-kind 4 --metrics .../metrics_...csv --metrics-column cross_novel
done
exit=0,0,0 -> pooled 0.6306 / 0.5583 / 0.4944 (mean 0.5611); routing mean 0.5019
```
Outputs: work/L11_2_EVIDENCE/reconstruction_fresh_evalkind0.json,
work/L11_2_EVIDENCE/reconstruction_L103_cross_*.json

## E6/E7/E8 — explicit-failure and sentinel tests

```
$ ... --metrics-column cross_novel        -> status NOT_MEASURED_in_harness (not compared against -1)
$ python3 .../recompute_metrics.py /tmp/l112/neg/dup2.csv --calls ...
  {"status":"RECONSTRUCTION_FAILED","reason":"duplicate trial key (0, 0, 720)"}  exit=2
$ python3 .../recompute_metrics.py ... --eval-kind 99
  {"status":"RECONSTRUCTION_FAILED","reason":"no rows selected"}  exit=2
```
## E9 — protocol hash integrity

```
$ sha256sum stark/design/l11_1_protocol.md
322078c8345b5c72c4954a6de529329065d8875f2a103626039e92f09a810c32
(matches work/L11_1_PREREGISTRATION.json)
```
## NOT RUN

- per-trial non-interference on/off (blocked: R3)
- writer round-trip, instrumented determinism, checkpoint/resume, R-majority unit test (blocked: R3)
- L10.4 26/26 battery (inherited, not rerun; no source changed)
- test_phase1_affinity (UNKNOWN/UNEXECUTED; R2 unresolved)
- any L11 arm / official evaluation (prohibited)

## Artifact hashes

```
fc0f94b7a3ca0edb79f33a01bbd9a0fbea2e8f27cd493d4e8895ff047c9a6de1  work/L11_2_EVIDENCE/determinism_legacy.txt
0239f7e6f71749b4666396bafcc16b4a037ffd8ee613180f8d2fda36275dfc5e  work/L11_2_EVIDENCE/feasibility_probe_output.txt
bc9d13811b0da2dcecae2d7136f24b15efe2298dd2bf47e843084979207310c6  work/L11_2_EVIDENCE/reconstruction_L103_cross_123456789.json
f9871e6f7379837511a54f8029afd77b76c3c549f317f1a77e26fb8c96f940f8  work/L11_2_EVIDENCE/reconstruction_L103_cross_171473193.json
fd6dffc7fa8a5b9d54b6934b67bb001667b3191957661dfa24de2fed1f908e40  work/L11_2_EVIDENCE/reconstruction_L103_cross_218213831.json
2d378964211c5a8dbba5962214ae4ea0de4fec525e4a991c81f4eed55b9837ac  work/L11_2_EVIDENCE/reconstruction_fresh_evalkind0.json
e59a610f8db8b5f99a1e9d6db3284297d98a2f61388cb507beffa034a0c92d91  work/L11_2_EVIDENCE/feasibility_probe.cpp
652f457b14f30821aea2afc07defee5a3de39851636b8b5ff794e75f02f872a9  work/l11_2_prototype/recompute_metrics.py
```
