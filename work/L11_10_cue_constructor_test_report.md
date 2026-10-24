# STARK-L11.10 — Unit-Test Report

Every result below was **executed**. Nothing is inferred from reading the code.

---

## 1. Environment

| item | value |
|---|---|
| compiler | `g++ (Debian 12.2.0-14+deb12u1) 12.2.0` |
| standard | `-std=c++17` |
| flags | `-O2 -Wall -Wextra` |
| `cmake` | **not installed** in this sandbox |
| `ninja` | **not installed** |
| host | Linux sandbox, not the author's machine |

**Consequence:** the CMake target added to `stark/CMakeLists.txt` **cannot be exercised
here** — building through CMake is **UNEXECUTED**. The equivalent direct compile below uses
the same source list the CMake target declares, so the code path is identical; only the
build-system invocation differs.

---

## 2. Build

```
$ g++ -std=c++17 -O2 -Wall -Wextra -I stark/src \
    stark/tests/test_l11_cue_constructor.cpp \
    stark/src/learning/L11CueConstruction.cpp \
    stark/src/learning/ContextConditionedMemory.cpp \
    stark/src/learning/RelevanceRouting.cpp \
    stark/src/neural/NeuralCell.cpp \
    stark/src/neural/Synapse.cpp \
    stark/src/neural/Network.cpp \
    -o /tmp/l11f/t
BUILD_EXIT=0
```

**Warnings attributable to the new files: none.** (`-Wall -Wextra` does emit pre-existing
warnings from `RelevanceRouting.cpp:288` and `NeuralCell.h:148`, both untouched by this
milestone and both present before it.)

---

## 3. Test run, twice

```
$ /tmp/l11f/t
STARK-L11.10 cross-family cue constructor tests
[section] S1 valid inputs: every frozen-table case in scope
[section] S2 multiplicity and ratio derive from feature counts only
[section] S3 canonical order and permutation invariance
[section] S4 determinism and absence of global state
[section] S5 invalid inputs are rejected deterministically
[section] S6 exhaustive enumeration of the cross-family cue space
[section] S7 the constructed stimulus is accepted by the router (hand-set weights, no training)
[section] S8 separation: no dependence on group count, task index, bank or answer
PASS: test_l11_cue_constructor (276 assertions)

EXIT=0
```

| run | exit code | assertions | failures | sha256 of output |
|---|---|---|---|---|
| 1 | 0 | 276 | 0 | `837d3ed24cc95b4dd13cace80969d29f66856a074dbf5b91a2031c3c793094d0` |
| 2 | 0 | 276 | 0 | identical to run 1 |

**Determinism: `diff` of the two runs reports no difference (byte-identical).**

---

## 4. What each section asserts

| section | assertions cover |
|---|---|
| **S1** | all 6 ordered group pairs × {1:1, 2:1, 3:1}; category, counts, `majority_group`, total length, and per-feature group membership |
| **S2** | same groups with 1, 2 and 3 features → different category; same counts with different groups → same category; mirrored `1,2` input → `CROSS21` with majority = B; non-adjacent groups; a 5-group (T = 5) feature space |
| **S3** | reversed input lists produce an identical cue; canonical order is `[group A ascending, group B ascending]`; multiset preserved; swapped group arguments preserve multiplicities, category and majority; all 6 ordered pairs give identical multiplicity metadata |
| **S4** | repeated construction identical; identical result after unrelated and **failing** intervening calls (no global state); enumeration repeatable and identical |
| **S5** | 15 distinct invalid specifications, each mapped to its expected error code, each verified to leave the output untouched; null output pointers; enumeration error paths leave the vector empty |
| **S6** | 24 / 16 / 16 cues per group pair; strict lexicographic order; every cue's invariants; 144 distinct `CROSS21` stimuli; the existing `CM_CROSS` 1:1 pattern is representable as `AMBIG11` |
| **S7** | all 336 cross-family cues for T = 3 reach `ccPreferredBank`; each resolves to the count-majority group under hand-set group-consistent weights; no constructed feature falls outside the router's input space; a **documented counter-example** where unequal magnitudes outvote the count |
| **S8** | the same spec in a 12- and a 24-feature space yields the same cue; emitted features are exactly the input union; `majority_group` is always one of the two declared groups |

---

## 5. Are the tests sensitive? (mutation check)

A test suite that passes can still be vacuous. Three deliberate defects were injected into
a **copy** of the module (the repository copy was never modified) and the suite re-run:

| mutation | effect | result |
|---|---|---|
| remove the duplicate-feature check | duplicates accepted | **FAIL — 2 failures** |
| drop the canonical sort | input order preserved | **FAIL — 3 failures** |
| always set `majority_group = group_a` | majority ignores counts | **FAIL — 10 failures** |

All three defects are detected. The suite is not vacuous.

---

## 6. Regression: existing tests

Built from the same unmodified sources and run directly:

| test | exit code | result |
|---|---|---|
| `test_context_conditioned_memory` | 0 | **PASS (330 assertions)** |
| `test_l10_structural_audit` | 0 | **PASS (357 assertions)** |
| `test_l10_1_sealing` | 0 | **PASS (276 assertions)** |

These are the three existing tests that link `ContextConditionedMemory` and
`RelevanceRouting` — the components the new module sits beside. All pass unchanged.

**Not run:** the full CMake test suite (no cmake), the L10 validation harness (it is an
executable driver, not a test, and running it would constitute an evaluation). Both are
marked **UNEXECUTED** rather than assumed.

---

## 7. Determinism of construction

Verified in three independent ways:

1. `sameCue(first, again)` after unrelated and failing calls — S4.
2. Two full runs of the binary are byte-identical — §3.
3. The module contains no RNG, no `static` state and no time/global dependence; the only
   include besides its own header is `<algorithm>`.

---

## 8. Coverage honesty

| question | answer |
|---|---|
| is every frozen cross-family case tested? | **yes** — 1:1, 2:1, 3:1 |
| is every invalid-input class tested? | **yes** — 15 specifications across 9 error codes |
| is the enumeration tested for completeness? | **yes** — by closed-form cardinality |
| is the router integration tested? | **yes, with hand-set weights** — not with a trained model, and no training occurred |
| is the *scientific* behaviour tested? | **no** — a unit test cannot test learning, and none was attempted |

**No experimental claim is made anywhere in this report.**
