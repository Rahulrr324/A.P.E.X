# STARK-L11.5 — Final Readiness Matrix

**Question this document answers:** what stands between this repository and an
authorized official L11 evaluation?

**Answer:** 8 owner decisions, 1 schema errata pass, 1 hash re-record, 1 patch, 1
run-time battery, and 1 arm-implementation package. **None of them can be supplied by
a document.**

Tags: **[V]** verified · **[A]** artifact · **[C]** computed · **[I]** inferred ·
**[P]** proposed.

---

## 1. Gate matrix

| # | Gate | Type | Owner action? | Status | Blocks |
|---|---|---|---|---|---|
| **G1** | **R5** — L11-C metric + threshold | owner decision | **yes** | **OPEN** | **every official run** |
| **G2** | **R4** — `Comp` / `AMBIG11` reporting | owner decision | **yes** | OPEN | protocol unambiguity |
| **G3** | **R4b** — tie-break wording | owner decision | **yes** | OPEN (zero numeric effect today) | nothing today |
| **G4** | **R4c** — `Read_rule(A4)` | owner decision | **yes** | OPEN | completeness of A4 reporting |
| **G5** | **R5b** — pooled clause | owner decision | **yes** | OPEN (declined for now) | nothing today |
| **G6** | **F1 / F2** — `MISLEAD`≠`SHUFFLED`; `o` distribution | owner decision | **yes** | OPEN | A4/A6/A7 implementation |
| **G7** | **R1** — ratify criteria + thresholds | owner decision | **yes** | **OPEN — NOT RATIFIED** | any official run |
| **G8** | v0.2.1 schema errata D1–D8 | documentation + owner | **yes** | OPEN | any correct implementation |
| **G9** | **R6** — re-record protocol v0.2 + schema v0.2.1 hashes | documentation + owner | **yes** | OPEN | preregistration completeness |
| **G10** | **R2** — affinity port | authorized work | no (approved in principle) | OPEN, **unapplied** | L11-F gate |
| **G11** | **R3** — harness patch under C1–C7 | authorized work | no (conditional) | OPEN, **unapplied** | instrumentation |
| **G12** | C6 battery: checks 1–8, 7′, 9–14 | run | no | **NEVER RUN** | non-interference claim |
| **G13** | protocol §11 R-majority unit test | run | no | **NEVER RUN** | composition correctness |
| **G14** | ARM IMPLEMENTATION: `CROSS21`, `CROSS31`, `AMBIG11`, `MISLEAD`, arm selector | **class X — not authorized** | **yes, a new authorization** | NOT STARTED | any L11 measurement |
| **G15** | preflight review | owner | **yes** | not started | official run |

**15 gates. 0 closed.**

---

## 2. Dependency order

```
G1 (R5) ─┐
G2 (R4) ─┼─→ G8 (schema errata) ─→ G9 (hashes) ─→ G11 (patch) ─→ G12 (battery)
G3, G4 ──┤
G5, G6 ──┘
G7 (R1) ─────────────────────────────────────────────────────────→ G15 (preflight)
G10 (affinity) ────────────────────────────────────────────────────↗
                                                                    
G14 (arms) ────────────────────────────────────────────────────────↗   [needs its own authorization]
```

Note the two independent branches: **instrumentation** (G8–G12) can proceed before the
arms, as C6 requires ("before any arm is implemented"). **The arms** (G14) are a
separate experimental-design authorization that has never been requested.

---

## 3. What each gate would certify, and what it would not

| Gate | Certifies | Does **not** certify |
|---|---|---|
| G1 (R5) | the reported metric has a defined meaning agreed before data | that the metric is any good |
| G2 (R4) | A4 reports two named quantities instead of one ambiguous one | that A4 means anything about composition |
| G3 (R4b) | one tie-break rule exists | that the tie-break is scientifically right |
| G5 (R5b) | the pooled clause is decided either way | that pooling is sound |
| G7 (R1) | thresholds are fixed before evidence | that the thresholds are achievable |
| G8 (errata) | the schema describes states the engine can produce | that any writer implements it |
| G10 (affinity) | the test builds on this platform | that affinity control works |
| G11 (patch) | instrumentation exists and is opt-in | that it is inert |
| G12 (battery) | observationally inert **under the tested conditions** | inertness outside them |
| G13 (§11 test) | the driver's rule matches the declared rule | that the model follows it |
| G14 (arms) | the cues exist and are selectable | that they are the right cues (§F1/F2 unresolved) |

---

## 4. Status of the three artifacts that must remain untouched

| Artifact | Hash | State |
|---|---|---|
| protocol v0.1 | `322078c8345b5c72c4954a6de529329065d8875f2a103626039e92f09a810c32` | **byte-identical to its registered hash [V]** |
| schema v0.1 | `a8edd674bc9efd651e1c3a25dee1f5317dae442aaf236ae01f1b8240f8d87917` | **byte-identical [V]** |
| preregistration | `57a8139d6797b305dd7e2d4791b00f981ff84329d2e7329a55413fbf4ea6ce3b` | **byte-identical [V]** |
| specification | `d9cd7dc4024e407317a083001aff40bd287cad0f301f777cdfc5082afc3ae542` | **byte-identical [V]** |

---

## 5. Official-status ledger

| Item | Status |
|---|---|
| Official L11 evaluation | **NOT RUN** |
| Official L11 arms | **0** |
| Official L11 trials | **0** |
| L11 arms implemented | **0 of 11 selectable** |
| Instrumentation implemented | **no** |
| C1–C7 satisfied | **0 of 7** |
| Tests executed in this milestone | **0** |
| Tests claimed passed | **0** |
| APEX progress | **≈ 57 %** |

---

## 6. The shortest honest path

1. Owner answers **G1, G2, G3, G4, G5, G6** (six sentences).
2. Documentation: schema v0.2.1 errata; commit the protocol v0.2 draft; record hashes
   (**G8, G9**).
3. Owner ratifies **G7** (thresholds) — separately.
4. Apply **G10** (affinity) — independent, already approved in principle.
5. Apply **G11** (the C1–C7 patch); pass **G12** (13 checks) and **G13**.
6. Owner authorizes **G14** (arms) and it is implemented — a **class X** change.
7. **G15** preflight, then the official run.

Steps 1–3 are owner work. Step 4 is cheap. Steps 5–6 are the implementation
milestones. Step 7 is the only place an official number can appear — and it has not
been reached.
