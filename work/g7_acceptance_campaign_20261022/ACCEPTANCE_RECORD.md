# M0 Acceptance Campaign — Round 1 Acceptance Record (2026-10-22)

**Verdict: FAIL (G7). M0 remains FAIL. M1 remains LOCKED.**
This record is complete and truthful as executed; it is NOT a PASS record and is not yet signed.

## 0. Authorization and scope

- Scope rulings: project owner, authorized Q&A channel, 2026-10-22 (U1–U10 + E3), recorded in `work/ACCEPTANCE_SCOPE_ADDENDUM_DRAFT_20261022.md` §5 (document unsigned; rulings cited from the Q&A record).
- Campaign execution authorization: project owner, authorized channel, 2026-10-22 ("I authorize the A.P.E.X M0 acceptance campaign as scoped by the signed acceptance addendum (U1–U10 and E3)" — six enumerated components).
- Approved scope applied: U1 Linux Xeon container · U2 both variants (single-thread evidence reused; all-core generated) · U3 external pinning + run-log attestation · U4 current-machine store only (historical nine outside, untouched) · E3 disposition-only (never executed) · U5 manual G8 + test_phase1_records · U6 distinct invocations · U7 production evaluator arithmetic · U8 designated clean `build/results/` · U9 flip definition · U10 M1 = Phase-2 boundary work.

## 1. Machine (U1)

Linux 6.1.158+ x86_64 container, Intel Xeon @ 2.60GHz, 4,131,278,848 bytes RAM, 2 logical CPUs. PROFILE record `P1-PROFILE-24-0` (transferred).

## 2. Store assembly (U4, U8) — transfer step

- Pre-conditions verified: archive manifest 41/41 OK; `build/results/` absent (clean).
- Transfer: 24 JSONs copied bit-identically from `build/results-g7pair-20261022/` (archive preserved; `tiny_dense_2l_weights.bin` intentionally not copied).
- Post-transfer: `sha256sum -c` against `DRYRUN_TRANSFER_MANIFEST.sha256` = **24/24 OK**; archive manifest re-check = **41/41 OK**; historical store `stark/build/results/` untouched (6 files).
- Snapshot `logs/SNAP0_after_transfer.sha256` (25 entries incl. E3) verified OK after both all-core passes — **zero overwrites** (append-only preserved).
- Historical nine (G7-C failures) remain outside the designated store, preserved, not co-evaluated (U4).

## 3. E3 disposition record (approved E3 ruling)

- Command: `taskset -c 0 build/preflight_20261022/bin/run_baseline --baseline E3 --disposition --out build/results` → exit 0.
- Record `P1-E3-notattempted.json` (sha256 `f868c7b5c7d275efd7fb290550ae8559217f64d49a975df152eb6d5792abb51c`): status NOT_ATTEMPTED, **no statistics field** (no fabricated measurements), status_reason cites the ruling. E3 was **not executed**.

## 4. All-core pair (U2, U3, U6)

Commands (each run a distinct process invocation; full log `logs/run_log.txt` with timestamps and exit codes):
`taskset -c 0,1 build/preflight_20261022/bin/run_baseline --baseline {E1,E5,B1,B2,B3} --out build/results --threads 2`, PASS 1 then identical PASS 2. All 10 invocations exit 0.
Printed medians (µs): E1 B6 P1=238.939, P2=253.351 · E5 B6 P1=**199.668**, P2=254.581 · bit_identical=true on all determinism-declared runs. Store: 43 JSONs total (24 transferred + 1 E3 + 18 new).

## 5. Production evaluator (U7) — `aggregate` normal + strict

`aggregate --out build/results` and `--strict`, exit **1** both (`logs/aggregate_normal.txt`, `logs/aggregate_strict.txt`).

- G1 PASS · G2 PASS · G3 PASS (B5 SKIPPED, cuda_unavailable, structured attestation) · G4 PASS · G5 PASS · G6 PASS.
- **G7 FAIL — verbatim:**
  `B6 medians differ 16.44% (allowed 15.00%) between runs 1 and 4`
  `B6 medians differ 21.19% (allowed 15.00%) between runs 2 and 4`
  `B6 medians differ 21.57% (allowed 15.00%) between runs 3 and 4`
  `B7 medians differ 17.63% / 22.20% / 21.86% (allowed 15.00%) between runs 1-3 and 4`
  `B9 medians differ 17.64% / 22.45% / 22.78% (allowed 15.00%) between runs 1-3 and 4`
  `OVERALL: FAIL (1 gate(s) failed)`
- Failure shape (fact from evaluator arithmetic): each all-core B6/B7/B9 group has 4 records; the same single record (median 199.668 µs on B6 — the PASS-1 E5 invocation) deviates 16.4–22.8% from the other three, which agree pairwise within tolerance. No record was excluded, clipped, or re-run.
- U7 annotations (stated, not corrected): operative arithmetic = production evaluator (frozen); divergences vs spec text (symmetric all-pairs vs recorded-referenced, time-median vs bandwidth, B5 20%) noted; under the recorded-referenced form the same outcome holds (the outlier record violates against every reference), so the FAIL is robust to the arithmetic choice.

## 6. §K tests (required) — 5/5 PASS

| Test | Result |
|---|---|
| test_phase1_profiler | PASS (34 assertions) |
| test_phase1_accounting | PASS (67 assertions) |
| test_phase1_budget | PASS (55 assertions) |
| test_phase1_records | PASS (72 assertions) |
| test_phase1_reproducibility | PASS (37 assertions) |

## 7. §M audit (V009 §M, M1–M10) — all PASS as standing properties

M1 units · M2 budget↔demand dimensions · M3 theoretical/measured separated (B3 evidence) · M4 exact parameter counts (accounting tests) · M5 quantized overhead representable · M6 no machine-specific assumptions · M7 CPU-first/offline (all runs local) · M8 STARK-001..007 untouched (diff audit: only `run_baseline.cpp` + addendum) · M9 determinism triple present; bit-identity observed on declared runs · M10 optimizer zero-state — each verified against this campaign's evidence.

## 8. Manual G8 checklist (U5)

| # | Item | Result |
|---|---|---|
| 1 | Every executed benchmark/baseline/profiler capture has a record in `build/results/` | PASS — 19 campaign records + 24 transferred = 43; inventory: 1 PROFILE, 1 TELEMETRY, 3 SKIPPED (E2/B4/B5), 2 NOT_ATTEMPTED (E3/E4), 36 measured |
| 2 | Every record parseable by the production ExperimentRecord reader | PASS — `aggregate` enumerated 43/43 (PASSED=38, FAILED=0, SKIPPED=3, NOT_ATTEMPTED=2) |
| 3 | Schema-valid | PASS — no malformed-record errors in normal or strict mode |
| 4 | Append-only integrity | PASS — SNAP0 (25 hashes) OK after all 12 appends; no id reuse |
| 5 | Records at the designated path (G8 literal) | PASS — all in `build/results/` |

**G8: PASS (manual checklist per U5).** G7 FAIL stands independently.

## 9. Final verdict and sign-off

**Campaign round 1: FAIL on G7 (1 gate). G1–G6 + G8 pass.** Acceptance conditions of U9 are NOT satisfied → **M0 stays FAIL; M1 stays LOCKED.** All artifacts preserved: `build/results/` (43 records), `build/results-g7pair-20261022/` (archive, 41/41 intact), `logs/` (run log, aggregate outputs, SNAP0, test outputs). No threshold, validator, or historical record was modified. No repeat or re-run was executed.

**Sign-off block — blank (this is a FAIL record; the owner signs only an acceptance PASS record):**
- Acceptance decision: ☐ ACCEPTED / ☐ REJECTED / ☐ REMEDIATION AUTHORIZED
- Project owner: ______________________  Date: __________  Signature: ______________________

## 10. POST-EXECUTION NOTE (2026-10-23) — evidence-store persistence loss

After this record was written, the sandbox environment rebuilt the checkout
(git re-clone at base `563395f1` + working-tree patch re-applied; commits
`f250d73`/`460f295` remained safe on the remote and local HEAD was restored to
`460f2954`). Untracked content under the directory name `build/` is excluded
from the environment's persisted snapshots, so the round-1 store
`build/results/` (43 records) and the preflight binaries **no longer exist on
disk**. Consequences, stated exactly:

- **Lost irrecoverably:** the 18 all-core measurement records (per-sample data).
  Their aggregates survive only as printed medians in `logs/run_log.txt` and the
  evaluator output in `logs/aggregate_normal.txt` / `aggregate_strict.txt`
  (quoted verbatim in §5). Their individual file hashes were never snapshotted.
- **Lost, re-creatable with disclosure:** `P1-E3-notattempted.json`
  (original sha256 `f868c7b5c7d275efd7fb290550ae8559217f64d49a975df152eb6d5792abb51c`,
  recorded in §3 and in `logs/SNAP0_after_transfer.sha256`); the disposition
  action can be regenerated via `run_baseline --baseline E3 --disposition`
  (new `created_utc` → different hash; it is an administrative record with no
  measurements).
- **Lost, byte-identical recovery available:** the 24 transferred records —
  identical copies of the git-tracked archive `build/results-g7pair-20261022/`
  (41/41 verified intact), with every hash listed in `logs/SNAP0_after_transfer.sha256`
  and `DRYRUN_TRANSFER_MANIFEST.sha256`.
- **Survived:** this record, all logs, run log, test outputs, aggregate outputs,
  transfer manifests, and the full SHA-256 inventory of the 25 pre-existing
  store files.
- **Impact on the verdict:** none to the facts — G1–G6 PASS, G7 FAIL, G8 PASS
  were computed by the production evaluator over the store as it existed, with
  output preserved verbatim. The limitation is that the round-1 store can no
  longer be independently re-evaluated.
- **Process correction:** all future campaign artifacts must be kept outside
  `build/` (e.g., under `work/`) or committed to git immediately — the tracked
  feasibility archive survived the same event precisely because it is tracked.

§9's "All artifacts preserved" statement was true at write time and is hereby
qualified by this note. The FAIL verdict stands as round 1's documented outcome.

## 11. Remediation option (proposal — not authorized)

One documented remediation **round 2** per addendum §6 (pre-registered before execution): preserve this round-1 store as failed evidence (rename to `build/results-round1-g7fail-20261022/`, never edited), designate a fresh clean `build/results/`, re-transfer the 24 records, re-run the identical campaign commands once. **Uncertainty resolved:** whether the single anomalous E5 invocation (≈22% faster across B6/B7/B9) is transient host noise or systematic non-reproducibility on this machine. **Decision paths:** round-2 all-core pair agrees within 15% → G7 passes on round-2 evidence with the round-1 anomaly disclosed as a limitation (M0 acceptance then requires the signed record); round-2 shows comparable spread → the machine cannot satisfy G7 as ruled → U1 machine designation is revisited by the owner (tolerances must not change).
