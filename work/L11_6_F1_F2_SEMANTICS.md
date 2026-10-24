# STARK-L11.6 — F1 and F2: Experimental Semantics Candidates

**Status: BOTH UNRESOLVED.** F1 may have no defensible answer in the current design
and is reported as such. F2 is offered strictly as a candidate for owner review.
Nothing here is adopted. Tags: **[V]** verified · **[C]** computed · **[I]** inferred ·
**[P]** proposed · **[?]** unknown.

---

## 1. Why these are in an owner package

Both were discovered in L11.5 while inventorying the arms. Neither is a stylistic
gap: F1 determines whether the design has 11 arms or 10, and F2 determines the expected
value of every cross-family metric. Both are **experimental-design** questions
(class **X**), not documentation questions, so this milestone may characterize them but
may not settle them.

---

## 2. F1 — what distinguishes `MISLEAD` from `SHUFFLED`?

### 2.1 The frozen constructions

| Category | Protocol §4 **[V]** | Specification §3 **[V]** |
|---|---|---|
| `MISLEAD` | "2 features from `g(o)` only (the *wrong* group)" | "all features from a *wrong* group" — causal question: "does the rule hold when following it yields the wrong answer?" |
| `SHUFFLED` | "`TRAIN` pair of another task" | "cue taken from another task, registered procedure" — causal question: "contradictory context" |

### 2.2 The finding

**[I, from [V]]: the two constructions are the same.** A `TRAIN` pair of another task
`o` is by definition two features drawn from `g(o)` — which is verbatim the `MISLEAD`
construction. The implementation confirms there is only one mode: `CM_SHUFFLED` draws
`tasks[ot].train_cues[pick_pair]` (`harness:215–222`), i.e. a training pair of a
uniformly drawn other task.

A `TRAIN` pair is itself 2 features from a single group (`VTask::train_cues` are pairs
within `4t..4t+3`, `harness:98`), so **"pair of another task" and "2 features from the
wrong group" denote the same set of cue vectors** — modulo the *distribution over that
set*, which is exactly the `o`-selection and index-draw question (F2).

### 2.3 The seven-field comparison the mission requires

| Field | `MISLEAD` (as written) | `SHUFFLED` (as written) | Distinguishable today? |
|---|---|---|---|
| **Cue construction** | 2 features from `g(o)` | `TRAIN` pair of another task = 2 features from `g(o)` | **NO — identical** |
| **Intended bank** (the bank the *driver* asserts for scoring) | not stated anywhere | not stated anywhere | **NO — neither is defined** |
| **Rule-designated bank** `B_rule` | `bank(g(o))` — the wrong bank | `bank(g(o))` — the wrong bank | **NO — identical** |
| **Permitted transformations** | none specified | none specified | **NO** |
| **Expected behaviour** | "following the rule yields the wrong answer" | "contradictory context" | **NO — both are "follow a cue that points away from the task"** |
| **Control interpretation** | rule-following **under contradiction** (does the *mechanism* follow the rule even when it hurts?) | context **contradiction** (does a mismatched cue corrupt routing?) | **partially** — the *questions* differ in wording, but no measurable quantity separates them |

### 2.4 Candidate resolutions (presented, not chosen)

| Option | Description | Cost | Assessment |
|---|---|---|---|
| **(a) Merge** | delete A6; keep A7 `SHUFFLED` | design has 10 arms; one question unasked | honest; requires an explicit experimental-design decision and would change the frozen arm list |
| **(b) Differentiate by `o`-selection** | `MISLEAD` = the **nearest-index** other group (deterministic, so the contradiction is controlled); `SHUFFLED` = a **uniformly drawn** other task (as coded) | two well-defined arms; one extra stream consumer | **my recommendation if a distinction is wanted** — it makes the empirical difference real and states it |
| **(c) Differentiate by scoring** | both use the same cue, but `MISLEAD` is scored for `rule_compliant` only and `SHUFFLED` for `accuracy`/`MAPCHECK` only | no construction change; the arms differ purely in what is reported | weakest — two names for one observation |
| **(d) Leave as written** | both defined, both identical | none | indefensible: the arms table assigns them different causal questions, which the design cannot separate |

**Recommendation [P]: (b)**, with (a) as the fallback if the owner judges the
distinction unsupported by the design.

### 2.5 What I will not claim

**I do not assert that a defensible distinction exists in the current design.** The
frozen text assigns two different causal questions to two identical constructions, and
no measurable quantity currently separates them. That is an **unresolved design
decision**, not a documentation gap, and inventing a distinction would be exactly the
substitution this package exists to prevent.

### 2.6 Consequences if unresolved

- A6 and A7 cannot be implemented without pre-deciding by accident the thing the owner
  should decide.
- No acceptance criterion references A6 or A7 **[V]**, so nothing is blocked today
  except those two arms.

---

## 3. F2 — the `o` sampling distribution

### 3.1 The variable

For a cross-family cue evaluated on task `t`, `o` is the **other task** contributing
features. Protocol §4 says only "first draw selects `o`" with `o ≠ t` **[V]**
`:60–66`. No distribution appears in protocol, specification, schema, or preregistration
**[V]**.

### 3.2 Candidate specification (for review, **not adopted**)

| Element | Candidate **[P]** |
|---|---|
| **Sampled variable** | `o ∈ {0,1,2} \ {t}` — the other task supplying the minority features |
| **Support** | the two tasks other than the evaluated one |
| **Distribution** | **uniform**: `P(o) = 1/2` for each of the two |
| **Sampling procedure** | one draw per trial, from an `std::uniform_int_distribution<int>(0, n_other-1)` indexing the sorted list of other tasks — the procedure the existing `CM_CROSS` already uses (`harness:227–231`) |
| **Seed handling** | the arm's cross-family stream. Protocol §5 assigns `master + 9600` for this, but the code uses `master + 9400 + t` (**F4**) and the two disagree; the constant must be settled before this can be specified |
| **Shared across arms?** | **yes** — one draw rule for `CROSS21`, `CROSS31`, `AMBIG11`, `MISLEAD`; each arm uses its own stream *prefix* so the draws are independent across arms |
| **Effect on balance** | with uniformity each task sees both possible `o` values with equal probability, so no task is systematically paired with a "nearer" or "farther" group |
| **Effect on comparability** | uniform is the only option symmetric in the task index, so it is the only one under which a per-task metric is comparable in expectation across tasks |

### 3.3 Why uniformity is a candidate and not a conclusion

- It is **already the implemented behaviour** for the one existing cross-family mode
  **[V]** — so adopting it changes nothing and requires no re-derivation.
- But the protocol's silence means adoption is a **new specification**, and it interacts
  with F1(b): if `MISLEAD` is to be deterministic-nearest, `MISLEAD` must **not** use
  this uniform draw.
- It changes no threshold and no acceptance criterion, but it *does* change the
  distribution of the statistics the criteria are computed on.

### 3.4 Quantitative consequence (computed)

Under uniformity, the `Comp_task` / `Comp_rule` divergence on A4 is **50 % overall**, in
the task pattern 0 % / 50 % / 100 % **[C]**. Under a non-uniform `o` the per-trial
metrics are unchanged but those expected frequencies shift — which is why the choice
must be registered rather than left to whoever implements first.

---

## 4. What is being asked of the owner

| ID | One sentence |
|---|---|
| **F1** | Are `MISLEAD` and `SHUFFLED` distinguished by their `o`-selection (option b), merged (option a), or something else? |
| **F2** | Is `o` drawn uniformly over the other two tasks from the cross-family stream (candidate), and is one draw rule shared by all cross-family arms? |

Neither answer is implied by anything in this document.
