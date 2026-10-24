# STARK-L11.10 — Cross-Family Cue Constructor: Design

**Milestone nature:** a narrowly scoped engineering milestone. It provides the *stimulus*.
It does not build the experiment, and it authorizes nothing.

**New files**

| File | Lines | Role |
|---|---|---|
| `stark/src/learning/L11CueConstruction.h` | 128 | interface, types, error codes, scope contract |
| `stark/src/learning/L11CueConstruction.cpp` | 220 | validation, canonicalisation, enumeration |
| `stark/tests/test_l11_cue_constructor.cpp` | 486 | 276 assertions across 8 sections |
| `stark/CMakeLists.txt` | +14 | one additive test target; **no existing target touched** |

No existing source file was modified. No model component was touched.

---

## 1. Why this exists

L11.9's IMP-4 finding: the L11 harness constructs cross-family cues with

```cpp
// l10_validation_harness.cpp:233
cue = {b + (pick_pair(rng_shuf) % 4), b2 + (pick_pair(rng_shuf) % 4)};
```

— **one feature from the task's own group and one from another group: a 1:1 cue.** The
frozen cue table requires `CROSS21` (2 from A + 1 from B) and `CROSS31` (3 from A + 1 from
B). `AMBIG11`, `CROSS21` and `CROSS31` appear **zero times** in `stark/src/`. The primary
arm's stimulus could not be produced.

That is what this milestone fixes.

---

## 2. What the frozen artifacts actually fix, and what they leave open

| Question | Answered by the frozen record? | Consequence for the design |
|---|---|---|
| how many features per signature group | **yes** — 4 (`l10_validation_harness.cpp:97–100`, `signature = {b+0…b+3}`; `cfg.n_feat = 4*T` at `:295`) | groups are fixed; 12 features for T = 3 |
| the composition ratios | **yes** — 2:1, 3:1, 1:1 (spec §3 cue table) | exactly three supported multiplicities |
| which group is the majority | **yes** — the group contributing more features | derived, never passed as a label |
| **which particular features** of a group | **no** | **caller-supplied**; see §3 |
| **which other group** is paired | **no** | **caller-supplied**; see §3 |
| the order of features within a cue | **no** | canonicalised; see §4 |

The two "no" rows are the reason this module is a *validator and canonicaliser*, not a
sampler.

---

## 3. The design decision that matters: no sampling policy

A constructor that picked the features itself would have to choose among 4 features per
group. Those features are **not interchangeable**: in the training table
(`:98`), feature `+0` appears in three of the four pairs, `+1` in three, `+2` in two and
`+3` in two. A constructor that always took "the first *k* features" would systematically
prefer the most-practised features — a scientifically consequential bias, invented by an
engineer, in the exact variable the milestone is trying to control.

Likewise, always pairing with "the lowest-indexed other group" would confound partner
identity with group index.

**Therefore:**

- `buildCrossFamilyCue` takes the feature lists and both group indices **as inputs** and
  validates them;
- `enumerateCrossFamilyCues` returns **all** valid cues for a spec, in a deterministic
  order, so that a driver can sample from the true space with its own seeded RNG;
- the module contains **no RNG**, no static state, and no default choices.

Sampling is the driver's job, and the driver does not yet exist.

---

## 4. Representation and canonical order

```cpp
struct CrossFamilyCue {
    CrossFamilyCategory category;   // AMBIG11 | CROSS21 | CROSS31
    int n_feat;                     // 12 for T = 3
    int group_a, group_b;           // signature groups as supplied
    int count_a, count_b;           // multiplicities as supplied
    int majority_count, minority_count;
    int majority_group;             // -1 when count_a == count_b
    std::vector<int> features;      // canonical: group A ascending, then group B ascending
};
```

- **Feature identities and multiplicities are preserved exactly** — the emitted vector is
  a permutation of the inputs, never a re-derivation.
- **Canonical order** is fixed so that two descriptions of the same multiset produce a
  bit-identical vector. This matters because `bankScores()` accumulates
  `Σ_{f ∈ cue} w[f][k]` in cue order (`ContextConditionedMemory.cpp:193–203`); a different
  order is a different floating-point summation order.
- `majority_group` is `-1` for `1:1`, where no majority exists. There is deliberately **no
  fallback that invents one**.

---

## 5. What the module does not contain, by construction

The translation unit includes only its own header and `<algorithm>`. It has **no**
dependency on `CCAgent`, `CCBankMode`, `LRMapping`, `Network`, or the harness. It follows
that it cannot route, score, retrieve, reward, or learn — those functions are not reachable
from it.

It also has no field and no parameter named `task`, `bank`, `answer`, `queried`, `expected`
or `label`. The stimulus is described; the expected response is not.

---

## 6. Validation rules

| Rule | Error code |
|---|---|
| `n_feat` must be a positive multiple of 4 | `InvalidFeatureSpace` |
| at least two signature groups | `TooFewSignatureGroups` |
| both groups in `[0, n_feat/4)` | `GroupOutOfRange` |
| groups distinct | `GroupsNotDistinct` |
| `(count_a, count_b)` ∈ {{1,1}, {2,1}, {3,1}} | `UnsupportedMultiplicity` |
| feature lists non-empty | `FeatureCountMismatch` |
| features in `[0, n_feat)` | `FeatureOutOfRange` |
| no duplicate feature | `DuplicateFeature` |
| each feature in its declared group | `FeatureGroupMismatch` |

**On any error the output argument is left untouched** — a rejected spec cannot leave a
half-built stimulus behind. Errors carry stable messages via `cueBuildErrorMessage`.

`{1,2}` is **accepted** and normalised to a `CROSS21` whose majority is group B: the frozen
row fixes the multiset, not the argument order. `{2,2}`, `{3,2}`, `{4,1}` and `{1,0}` are
rejected.

---

## 7. Relationship to the existing harness

The harness is **unchanged**. `CM_CROSS` still constructs 1:1 cues, `eval_cue` still
defaults to `CM_TRAIN`, and no L10 result can shift.

Wiring this module into an evaluation driver is a **separate, unauthorized change**: it
would add new arms (`A2`, `A3`, `A4`), new stream seeds, and a new aggregation path. Under
the milestone's preservation rules that work is out of scope, and it is listed as the first
item of `L11_10_readiness_report.md` §4.

---

## 8. Invariants, stated for the test suite

1. **I1** — a cue's length equals `count_a + count_b` and equals the frozen-table value
   (3 for 2:1, 4 for 3:1, 2 for 1:1).
2. **I2** — multiplicities come from the lists, never from a group index, task index or
   category name.
3. **I3** — every emitted feature lies in `[0, n_feat)` (a silent out-of-range feature would
   be skipped by `bankScores`, so this must be enforced at construction).
4. **I4** — the emitted feature multiset equals the input multiset.
5. **I5** — construction is a pure function: same input ⇒ same output, regardless of call
   order, unrelated intervening calls, or the number of signature groups in the environment.
6. **I6** — rejected input leaves the output untouched.
7. **I7** — enumeration is complete and duplicate-free (24 / 16 / 16 per group pair).
8. **I8** — the stimulus is accepted by the real router and resolves by count under
   group-consistent equal-magnitude weights.

All eight are tested. See `L11_10_cue_constructor_test_report.md`.
