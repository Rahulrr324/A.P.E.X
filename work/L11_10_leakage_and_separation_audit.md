# STARK-L11.10 — Leakage and Separation Audit

**Scope:** does the cue constructor build only a stimulus, and can the expected answer reach
the routing or scoring path? Every claim below is from reading the source at commit
`9169794`, with line numbers.

**Important framing:** the constructor is **not yet wired into any driver**, so there is no
live data flow to test. What follows is (a) what the constructor emits, (b) what the
existing evaluation path does with a cue, and (c) the junctions where a future driver could
introduce a leak.

---

## 1. What the constructor emits

| field | present | could it leak the answer? |
|---|---|---|
| `category` | yes | no — a function of the counts |
| `n_feat`, `group_a`, `group_b` | yes | no — design parameters |
| `count_a`, `count_b`, `majority_count`, `minority_count` | yes | no — derived from the lists |
| `majority_group` | yes (`-1` for 1:1) | no — a *group* label; see §5 |
| `features` | yes | no — the stimulus itself |

**Absent by construction:** task index, bank index, queried identity, expected answer,
evaluation label, arm id, seed. The translation unit includes only its own header and
`<algorithm>`; it cannot reach `CCAgent`, `CCBankMode` or the network, so it cannot route,
score, retrieve or learn.

---

## 2. Does routing receive the actual cue?

**Yes, and only the cue.** In the evaluated configuration (`learning_enabled = false`,
`router_learning = false`, `CC_LEARNED`, no forced bank):

```cpp
// ContextConditionedMemory.cpp:342
bank = ccPreferredBank(agent, sched.cue);
```

and `ccPreferredBank` → `bankScores(agent, cue)`:

```cpp
// ContextConditionedMemory.cpp:193-203
for (int f : cue) {
    if (f < 0 || f >= agent.cfg.n_feat) continue;
    for (int k = 0; k < K; ++k)
        sc[k] += weight(agent.router[f][k]);
}
```

The cue is the only input. `task_bank` is used **only** under `CC_ORACLE`
(`ContextConditionedMemory.cpp:312`, commented "DIAGNOSTIC UPPER BOUND ONLY"), a mode no L11
arm enables.

**Consequence:** a 3- or 4-feature cue flows through the routing path with no code change —
which is what the S7 section of the test suite verifies against the real `ccPreferredBank`.

---

## 3. Is the task index reachable from routing?

| path | finding |
|---|---|
| `runCCTrial(..., task_bank, ...)` | `task_bank` reaches only the `CC_ORACLE` branch |
| `makeLRTrials(cfg, map, 0, 20, seed)` | **takes no task index** (`RelevanceRouting.cpp:39–42`); it takes the task's *mapping* |
| context slot `s.ctx` | drawn uniformly per trial from `n_ctx` (`RelevanceRouting.cpp:87`), and `phi` is **shared across tasks** (`l10_validation_harness.cpp:300–301`) |
| channel attention `route[ctx]` | selects a channel *within* the chosen bank; it does not select the bank |
| `candidateMask` | restricts to allocated banks; no task information |

**No path from task index to the bank decision was found in the evaluated configuration.**

This is a static reading, not a runtime experiment. It is recorded as such: the strongest
statement supported is *"the routing decision is a function of the cue alone"*.

---

## 4. Is the expected answer manufactured from the cue?

No. The expected answer is computed in the harness from the task's own mapping:

```cpp
// l10_validation_harness.cpp (evalTask)
const bool ok = (r.choice == tasks[task].map.perm[r.queried]);
```

`map.perm` is evaluation metadata, orthogonal to the cue. The cue and the mapping are
supplied separately to `runCCTrial`, and the mapping is used for the *trial schedule* and
for *scoring*, never for bank selection.

**Junction to watch:** `evalTask` takes both `tasks[task]` and the cue. A driver that
derived the cue *from* `map` (e.g. by looking up which group the answer belongs to) would
manufacture the stimulus from the label. **This module makes that harder by requiring the
features explicitly**: the cue is an input, never computed from a task.

---

## 5. The one real hazard the constructor introduces: `majority_group` ≠ bank index

Under the frozen allocation each task owns one bank and bank index equals task index, so
`majority_group` and the expected bank coincide — **today**. Under `A9` the task→bank
allocation is permuted, and they no longer coincide.

| consumer behaviour | correct? |
|---|---|
| `expected_bank = bank_allocated_to(task)` | **correct** under every allocation |
| `expected_bank = cue.majority_group` | **correct only under the standard order; silently wrong under A9** |

**Mitigation taken:** the field is named `majority_group` (a group), not `bank`, and the
header documents that it is a signature-group label. **Residual risk:** a driver author can
still conflate them. This is recorded as the top item in the readiness report's driver
checklist, and it is precisely the kind of error `A9` exists to expose.

---

## 6. Diagnostic rows and denominators

| mode | contributes to a metric? | evidence |
|---|---|---|
| `CM_PARTIAL` | **no** — return value discarded | `l10_validation_harness.cpp:566` |
| `CM_OFF_UNIFORM` | **no** — return value discarded | `:569` |
| `CM_OFF` | **yes**, to `res.off` only | `:546` |
| `CM_SHUFFLED` | **yes**, to `res.shuffled` only | `:549` |
| `CM_CROSS` | **yes**, to `res.cross` only | `:574` |

Each metric is a separate vector; none pools across modes. A constructor-built cue would
enter through a new mode and must follow the same pattern.

---

## 7. Pre-existing issues found and **not** repaired

### 7.1 The metric is re-derived inside `evalTask` and never reconciled with the emitted rows

`evalTask` increments `correct` as it goes and returns `correct / n`, while pushing rows
separately. Rows are emitted only when `dump_rows` is true. **There is no check that the
rows reproduce the returned rate.** A defect in one and not the other would be invisible.

### 7.2 Five evaluation modes share one identity schedule

`CM_OFF`, `CM_SHUFFLED`, `CM_PARTIAL`, `CM_OFF_UNIFORM` and `CM_CROSS` are all called with
`seed = master + 5001 + t` (`:546, :549, :566, :569, :574`), so `makeLRTrials` produces the
**same 20-identity sequence, the same presentations and the same noise** in each mode.

This is deliberate and useful for paired comparisons, but it means:

- the modes are **not independent samples**, so any pipeline that pools their rows
  (`GROUP BY task` without filtering `eval_kind`) will **double-count the same identities**
  across modes;
- an unpaired variance calculation over pooled rows is invalid.

### 7.3 Out-of-range features are silently skipped

`bankScores` (and the cue-drive loop at `:367–371`) skip features outside `[0, n_feat)`.
A constructor bug producing feature 12 would therefore **vanish** rather than fail. The
constructor validates the range and the test suite asserts invariant I3, but the engine
itself remains silent — recorded, not changed.

**All three are pre-existing and out of scope.** None is repaired here; §7.1 and §7.2 must
be handled by whoever writes the L11 driver.

---

## 8. Separation verdict

| question | verdict |
|---|---|
| does the constructor create only the stimulus + authorised descriptive metadata? | **yes** |
| do routing and retrieval receive the constructed cue rather than a task shortcut? | **yes** — `ccPreferredBank(cue)` is the only selector |
| do expected labels stay evaluation metadata? | **yes** — `map.perm` is never an input to routing |
| are diagnostic rows excluded from metric denominators? | **yes** — separate vectors, discarded returns |
| is any hidden re-derivation or duplicate-row issue introduced by this milestone? | **no** — but three pre-existing ones are documented in §7 |
| is there a leak I could not rule out? | **yes, one** — §5, a driver conflating `majority_group` with a bank index under `A9` |
