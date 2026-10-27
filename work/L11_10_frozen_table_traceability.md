# STARK-L11.10 — Frozen-Table Traceability

Every construction the module supports, mapped to its authoritative row. **No new
condition was created and the frozen task was not redefined.**

**Authoritative sources**

| Ref | File | Content used |
|---|---|---|
| **[T]** | `stark/design/l11_cross_signature_compositional_generalization.md` §3 | the ten-cue category table |
| **[A]** | same file, §5 | the arm table (`A2`, `A3`, `A4`, `A9`) |
| **[R]** | same file, §2.1 | the declared rule R-majority + tie-break |
| **[P]** | `stark/design/l11_1_protocol.md` §4, §7 | rule statement and criteria |
| **[C]** | `stark/src/learning/l10_validation_harness.cpp:97–100, 295` | group size 4, `signature = {4t…4t+3}`, `n_feat = 4T` |
| **[S]** | `stark/design/l11_trial_schema_v0_2.md` | `cue_category` per-trial field |

---

## 1. Supported cases

| # | source row | category | multiplicity | ratio | total features | arms | test |
|---|---|---|---|---|---|---|---|
| 1 | **[T]** `AMBIG11` — "1 from A + 1 from B" | `AMBIG11` | 1 + 1 | 1:1 | **2** | `A4`, and the existing `CM_CROSS` | S1, S6 |
| 2 | **[T]** `CROSS21` — "2 features from group A + 1 from group B" | `CROSS21` | 2 + 1 | 2:1 | **3** | `A2`, `A9`, `A10` | S1, S6, S7 |
| 3 | **[T]** `CROSS31` — "3 from A + 1 from B" | `CROSS31` | 3 + 1 | 3:1 | **4** | `A3` | S1, S6, S7 |

`CROSS21` and `CROSS31` are the cases IMP-4 identified as unconstructable. `AMBIG11` is
included because the existing `CM_CROSS` produces exactly its feature pattern (1 + 1) and
the module must be able to represent the case the harness already emits, or the 2-feature
path would be quietly redefined.

**Deliberately out of scope** (and why): `TRAIN` and `HOLDOUT` are within-group pairs built
from the task's own cue table (`[C]`: `train_cues`, `holdout_cues`); `PARTIAL` and `OFF` are
0- and 1-feature reductions; `SHUFFLED` and `MISLEAD` are borrowings of another group's
pair. None is a *cross-family multiplicity* construction, and each already has a
constructor in the harness. Re-implementing them here would duplicate working code and
change existing behaviour.

---

## 2. Per-case detail

### Case 1 — `CROSS21` (2:1)

| field | value |
|---|---|
| **source row** | **[T]** row `CROSS21`; **[A]** arm `A2` (primary), `A9` (order-permuted), `A10` (frozen router) |
| **input feature identities** | `group_a × 4 + i` for two distinct `i`; `group_b × 4 + j` for one `j` |
| **family membership** | 2 features in group A, 1 in group B; `group_a ≠ group_b` |
| **multiplicity** | `count_a = 2`, `count_b = 1` (or mirrored input `1,2` → derived majority = B) |
| **ratio** | 2:1, computed from the counts |
| **output representation** | `features = [a₀, a₁, b₀]`, ascending within each block |
| **expected task-bank** | bank allocated to the **majority group's task**, i.e. the bank of `majority_group` **under the frozen one-bank-per-task allocation** |
| **expected rule-bank** | same, by **[R]** R-majority; no tie exists, so the tie-break is not engaged |
| **default evaluation arm** | 120 trials/cell, `n_chan = 2`, learning disabled, `CC_LEARNED` |
| **invariant** | I1 (length = 3), I2, I3, I4, I7 (24 cues per group pair) |

### Case 2 — `CROSS31` (3:1)

| field | value |
|---|---|
| **source row** | **[T]** row `CROSS31`; **[A]** arm `A3` |
| **input feature identities** | `group_a × 4 + i` for three distinct `i`; `group_b × 4 + j` for one `j` |
| **family membership** | 3 in group A, 1 in group B |
| **multiplicity** | `count_a = 3`, `count_b = 1` |
| **ratio** | 3:1 |
| **output representation** | `features = [a₀, a₁, a₂, b₀]` |
| **expected task-bank / rule-bank** | the bank of `majority_group`, as above; the majority is larger, so a magnitude-based router would need a 4:1 weight ratio to be outvoted |
| **invariant** | I1 (length = 4), I7 (16 cues per group pair) |

### Case 3 — `AMBIG11` (1:1)

| field | value |
|---|---|
| **source row** | **[T]** row `AMBIG11`; **[A]** arm `A4` |
| **input feature identities** | one from each of two distinct groups |
| **multiplicity** | `count_a = count_b = 1` |
| **ratio** | 1:1 |
| **output representation** | `features = [a₀, b₀]`; `majority_group = -1` |
| **expected rule-bank** | **none** — **[R]** declares a tie, broken by the **lowest bank index**. The constructor records the absence of a majority (`-1`) rather than inventing one. |
| **note** | the existing `CM_CROSS` (`harness:233`) emits exactly this pattern, so this case is what L10 actually measured when it reported cross-cue accuracy |
| **invariant** | I1 (length = 2), I7 (16 cues per group pair) |

---

## 3. Feature-identity space

| property | value | source |
|---|---|---|
| features per group | **4** | **[C]** `signature = {b+0, b+1, b+2, b+3}` |
| groups for T = 3 | **3** (indices 0, 1, 2) | **[C]** `n_feat = 4*T` |
| total features | **12**, indices 0–11 | **[C]** `cfg.n_feat = 4 * T` |
| group of feature `f` | `f / 4` | `L11CueConstruction::signatureGroupOfFeature` |
| features within a group | **not interchangeable** — `+0` and `+1` appear in 3 of 4 training pairs, `+2` in 2, `+3` in 2 | **[C]** `train_cues` |

The last row is why the module does not choose features: any fixed choice would bias the
stimulus toward the most-practised features of the group.

---

## 4. What the constructor emits, and what it deliberately does not

| quantity | emitted? | reason |
|---|---|---|
| feature identities | **yes** | the stimulus |
| group membership, multiplicities, ratio, category | **yes** | descriptive metadata required by the schema (`cue_category`, **[S]**) |
| `majority_group` | **yes** — `-1` when there is no majority | descriptive; it is a *group* label, not a bank or an answer |
| expected task-bank | **no** | evaluation metadata; emitting it would invite a reader to short-circuit routing |
| expected rule-bank | **no** | same |
| queried identity / expected answer | **no** | belongs to the trial mapping, not to the stimulus |
| task index | **no** | not a parameter and not a field |

---

## 5. Cardinalities (used as test oracles)

| case | cues per ordered group pair | ordered pairs for T = 3 | total |
|---|---|---|---|
| `AMBIG11` | C(4,1)·C(4,1) = **16** | 6 | 96 |
| `CROSS21` | C(4,2)·C(4,1) = **24** | 6 | **144** |
| `CROSS31` | C(4,3)·C(4,1) = **16** | 6 | 96 |

The test suite asserts 24 / 16 / 16 per pair, and 144 distinct `CROSS21` stimuli across all
pairs.

---

## 6. Gaps and ambiguities carried forward (not resolved here)

| # | ambiguity | effect on the constructor | who must decide |
|---|---|---|---|
| A1 | which features of a group may be used | none — caller supplies them | the driver / owner (`F2`, L11.6) |
| A2 | which partner group is sampled, and with what distribution | none — caller supplies it | the driver / owner (`F2`) |
| A3 | whether `A9`'s permuted allocation makes bank index ≠ group index | the module already refuses to equate them; a **driver that compares `majority_group` to a bank index would silently break `A9`** | the driver author |
| A4 | whether `CROSS21` and `CROSS31` use the same partner for a given task | none — caller supplies it | the driver / owner |
| A5 | the cue's presentation order inside the engine | canonical order imposed here | none — ordering is not scientifically specified |

**A3 is the one to watch.** Under the frozen allocation, group index and bank index
coincide, so a driver could pass its tests while equating them; under `A9` the allocation is
permuted and the same code would fail. Recorded in the leakage audit §5.
