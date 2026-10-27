# STARK-L11.8 — Readiness Report

**Question:** what stands between the current repository and an executable, authorised L11
evaluation?

**Answer, in one line:** a ratified claim and contract (17 decisions), a schema repair, six
implementation conditions, and one runtime-test condition. **Nothing about the science is
blocked by missing knowledge; everything is blocked by missing authorisation.**

---

## 1. Gate table

| # | Gate | Type | Status | Owner action needed |
|---|---|---|---|---|
| 1 | **S4** — per-task or pooled claim | claim | **OPEN** | decision |
| 2 | **S1** — aggregation rule | claim | **OPEN** | decision |
| 3 | **U3** — claim wording accepted | claim | **OPEN** | decision |
| 4 | **S2** — L11-B statistic | metric | **OPEN** | decision |
| 5 | **S3** — L11-C scope | metric | **OPEN** | decision |
| 6 | **U1** — A10 contrast as criterion? | metric | **OPEN** (no δ exists) | decision + a measurement |
| 7 | **U2** — A3 ordering as criterion? | metric | **OPEN** (no value exists) | decision + a measurement |
| 8 | **R4, R4b, R4c** | metric | **OPEN** | decision |
| 9 | **R5** | metric | subsumed by S3 | decision |
| 10 | **R5b** | claim | **DEFERRED** | decision |
| 11 | **F1** | design | **OPEN** | decision |
| 12 | **F2** | design | **OPEN** | decision |
| 13 | **F4** — stream-seed table | doc/impl | **OPEN** | decision (correct to code) |
| 14 | **U4** — schema grouping key for `Null(t)` | schema | **OPEN** | design + decision |
| 15 | **R2** — non-building inherited test | impl | **OPEN** | fix |
| 16 | **R1** — ratification | registration | **OPEN** | decision |
| 17 | **R6** — hash recording | registration | **OPEN** | decision |
| 18 | **C1** separate writer | impl | **BLOCKED** | implement |
| 19 | **C2** capture in `evalTask` | impl | **BLOCKED** | implement |
| 20 | **C3** update mass / advantage | impl | **BLOCKED** | implement |
| 21 | **C4** schema v0.2.1 (D1–D8 + U4) | spec+impl | **SPEC-LEVEL ONLY, with an erratum** | implement |
| 22 | **C5** one-file change, no new RNG | impl | **BLOCKED** | implement |
| 23 | **C6** 13 non-interference checks | runtime | **BLOCKED** | execute |
| 24 | **C7** serialization discipline | impl | **BLOCKED** | implement |

**C1–C7: 0 of 7 satisfied.**

---

## 2. The two gaps that no arithmetic can close

| Gap | Why it matters | What would close it |
|---|---|---|
| **No criterion uses A10** — nothing in the contract distinguishes a *learned* router from the default tie-break **[V]** | the programme is titled "learning"; a contract with no learning contrast cannot support a learning claim | run A10 once; measure `Comp(A10)`; then a δ becomes defensible |
| **No criterion uses A3** — the additive model's ordering prediction (`3:1 ≥ 2:1`) is untested **[V]** | without it, a high `Comp` on 2:1 could come from any mechanism | run A3; report the ordering |

Both are **measurements that do not exist**, not analyses that have not been done. Neither
can be proposed with a threshold in this milestone; both are **[U]** by construction.

---

## 3. What is ready

| Component | Ready? |
|---|---|
| The metric algebra (`Comp`, `Read`, `MixAcc`, `Null`, `NG`) | **yes** — every identity verified **[D]** |
| The power arithmetic | **yes** — reproducible, stdlib only, byte-identical transcript |
| The schema fields needed for A, B, C, D, G | **yes**, except the `Null` grouping key (U4) **[V]** |
| The instrumentation conditions C1–C7 | **no** — 0/7 |
| The arms | **no** — A2/A3/A4/A6/A7/A10 have never been implemented or run **[X]** |
| The claim | **no** — S4 open |
| The contract | **no** — S1–S3 open |

---

## 4. What must be ratified, in order

```
S4  (claim)      ─┐
S1, S2, S3       ─┤→ AC-1 … AC-8 become a contract
U3, U4           ─┤
R4, R4b, R4c     ─┤
F1, F2, F4, R2   ─┘
        ↓
     R1 ratification  →  new artifacts committed, hashes computed, R6 recorded
        ↓
     C1–C4 implementation (schema v0.2.1)   →  C5, C7
        ↓
     C6 (13 non-interference checks, executed)
        ↓
     arms implemented   →   official run authorised (separate authorisation)
```

**No step may be skipped, and no step is authorised today.**

---

## 5. Honest assessment of the programme's state

- **The statistical audit changed the picture in one important way.** In L11.6 the
  conclusion was "the contract is underpowered". L11.7–L11.8 make it sharper: **the
  contract as written would reject a near-perfect model 40 % of the time**, and its B
  clause demands 120/120 on two of nine cells. That is not a demanding standard; it is a
  miscalibrated one.
- **The redesign restores a defensible design** — the candidate contract passes a 0.95
  model 99.95 % of the time and still rejects every failure model at ≈0.
- **But the redesign does not make L11 a test of learning.** Without A10 and A3 the
  contract cannot separate a learned additive router from a default tie-break. That is the
  single largest scientific weakness remaining, and it is stated as **U1/U2**, not papered
  over.
- **No capability has been demonstrated.** Zero arms, zero trials. APEX progress is
  unchanged.

---

## 6. Status

| Question | Answer |
|---|---|
| Scientific claim defined? | **proposed, not ratified** |
| Candidate contract internally coherent? | **yes, within its stated assumptions** — every row names its gate, its unit, its power and its missing-data policy |
| Protocol authorised? | **no** |
| Implementation authorised? | **no** |
| Official evaluation authorised? | **no** |
| Arms run / trials run | **0 / 0** |
| Frozen artifacts unchanged? | **yes** — 11/11 byte-identical |
| APEX progress | **≈ 57 %, unchanged** |
