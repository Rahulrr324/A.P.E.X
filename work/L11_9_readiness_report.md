# STARK-L11.9 — Readiness Report

**Question:** how ready is the L11 package, and what does this audit actually establish?

**Answer in one line:** the package is **internally coherent apart from one contradiction, has
one proven redundancy removed, and is blocked by a missing measurement instrument, not only
by missing authorization** — and **nothing here authorizes anything**.

---

## 1. Directly verified facts

Read from files or Git, not inferred.

| fact | value |
|---|---|
| Audit base commit | `ad595ab1e54d3e58d5332b2c915d55b56fa09279` |
| L11.8 branch state at audit start | pushed, remote confirmed, working tree clean |
| L11.8 diff scope | **13 files, 0 outside `work/L11_8/`** |
| L11.8 audit script re-run | **byte-identical** to its recorded output |
| Frozen artifacts re-hashed | **11 / 11 unchanged** |
| Files changed by L11.9 | **10**, all new, all under `work/L11_9_*` |
| Frozen or historical files modified | **0** |
| Official arms run | **0** |
| Official trials run | **0** |

---

## 2. Independently reproduced claims

Recomputed from the definitions, not copied.

| claim | reproduced? |
|---|---|
| `q(0.90) = P(X ≥ 108 \| Bin(120, 0.90)) = 0.576071` | **yes** |
| D0 = 0.006987, **D3 = 0.230601**, D4 = 0.161195, D5 = 0.525597 | **yes, all four** |
| D3 comonotone = 0.191174; D0 comonotone = 0.576071 | **yes** |
| catastrophic-run model passes D3 with probability 0.957613 | **yes** |
| `NG ≥ 0.75 ⟺ MixAcc ≥ 0.75 + 0.25 Null` | **yes**, 0 disagreements on a 6000-point grid |
| `P(NG ≥ 0.75 \| MixAcc = 0.90) = 0.9164` | **yes, 0.916360** |
| `sd(NG) ≈ 0.0496` | **yes, 0.049634 exact** |
| "every task ≥ 0.90" at true 0.90 yields ≈0.23 | **yes** |

---

## 3. Assumption-dependent claims

True **given** assumptions that L11 does not test.

| claim | assumption it needs |
|---|---|
| all power figures | cells within a run are exchangeable; a *fixed* true null shape `(1, 1/6, 1/6)` |
| B's `P = 0.9164` | the checkpoint's true forced-bank accuracies are `(1, 1/6, 1/6)`; between-seed null variation is **not** modelled |
| D3's dependence robustness | positive dependence within a run is the worst case considered; no measurement exists |
| `MixAcc`'s meaning | `WrongBankAcc` is estimated on eligible cells only |
| per-task gate | the three tasks are the population of interest, not a sample |
| the "0.75" threshold | the L10-K1 precedent is an appropriate analogy |

---

## 4. Findings that changed the picture (all new in L11.9)

| # | finding | severity |
|---|---|---|
| **IMP-4** | **the harness cannot emit a 3- or 4-feature cross-family cue.** `CM_CROSS` produces 1:1 only; `CROSS21`/`CROSS31` appear **0 times** in `stark/src/`. **A2 and A3 are not measurable.** | **blocking** |
| **CA-1** | the claim states one aggregation rule; the contract applies two (A: 2-of-3, D: all-9). D's own contribution differs **79×**. | high |
| **S3-1** | `Comp ∧ Read ≥ 0.90 ⇒ MixAcc ≥ 0.81 > 0.50` — **L11-C is provably redundant** on A2. | medium (simplifies) |
| **S2-2** | the `NG ≥ 0.75` rule is **tie-sensitive**: exact rule gives 0.91636, naive float gives 0.91429. Implementation must use integer arithmetic. | medium |
| **DL-1** | L11.8's "17 decisions" matches **none** of its own enumerations (queue 19, register 22). | low (documented) |
| **DL-2** | C1–C7 are runtime conditions, not decisions; four are absent from the frozen text entirely. | low |
| **E-4** | "pooling hid the historical failure" is imprecise — pooling's danger is **loss of structure**, not a threshold artefact. | low |

---

## 5. Unresolved decisions

**26 canonical items; 17 are value judgments.** None is approved.

| category | count | blocking |
|---|---|---|
| scientific claim | 2 | yes |
| statistical contract | 5 | yes |
| metric semantics | 10 | yes |
| implementation / schema | 5 | yes (**do not ask the owner**) |
| protocol registration | 2 | after §4 |
| experimental authorization | 2 | last |

Plus **7 runtime conditions** (C1–C7) that are **not decidable items**.

---

## 6. Unavailable or unexecuted checks

| check | status | smallest safe next step |
|---|---|---|
| any L11 arm | **NOT EXECUTED** (0 / 0) | build IMP-4 first |
| C1–C7 | **NOT EXECUTED** (0 / 7) | after EXP-1 |
| `CROSS21` / `CROSS31` / `AMBIG11` cue construction | **absent from the codebase** | implement IMP-4 |
| between-seed null variation | **no data** | requires arms; cannot be simulated honestly |
| within-run cell correlation | **no data** | same |
| A10, A9, A11, A13, A14 | **not implemented** | after IMP-4 |
| population inference over tasks | **not possible by design** | no sampling frame exists |

---

## 7. Authorization state

| item | state |
|---|---|
| Protocol registered | **no** |
| Implementation authorized | **no** |
| Official evaluation authorized | **no** |
| Official arms / trials | **0 / 0** |
| This audit's grants | **none** |

**L11.9 completion is not authorization to implement or execute L11.**

---

## 8. Reproducibility

```
$ python3 work/L11_9_claim_audit.py     # run twice
exit code 0 / 0 — output byte-identical across runs
                         (sha256 of run 1 == sha256 of run 2, recorded in
                          work/L11_9_audit_transcript.txt)
32 checks, 32 PASS, 0 FAIL, 0 UNVERIFIED
```

Full transcript with both runs: `work/L11_9_audit_transcript.txt`.

---

## 9. Readiness verdict

| dimension | ready? |
|---|---|
| claim defined and modest | **yes** |
| acceptance predicates match the claim | **no** (CA-1) |
| power adequate at the target accuracy | **no** — 0.2306 complete at true 0.90; the study is powered for ≈0.93+ |
| metrics adequate | **partly** — B conditions on the null; C is redundant on A2 |
| measurement instrument exists | **no** (IMP-4) |
| criteria implemented | **no** (0 of 7) |
| protocol registered | **no** |
| authorization | **none** |

**The honest summary: L11 is a well-argued specification with one contradiction, one
proven redundancy, insufficient power at its own target, no implementation, and no
authorization. It is nowhere near runnable — and it has never been closer to being
*correctly* specified.**
