# STARK-L11.2 — Prepared Change (NOT APPLIED)

**Status: PROPOSED / NOT APPLIED.** Authorization R3 is unresolved
(`work/L11_2_INSTRUMENTATION_IMPLEMENTATION.md` §2). This document describes the
change precisely enough to implement in one pass once authorized. **No repository
file has been modified.**

**File touched: `stark/src/learning/l10_validation_harness.cpp` only.**
`ContextConditionedMemory.cpp/.h`, `RelevanceRouting.cpp/.h`, `Network.*`,
`CMakeLists.txt` and every test file are **not** touched. The feasibility probe
(`work/L11_2_EVIDENCE/feasibility_probe.cpp`) shows every required datum is
reachable from the existing public API, so no engine change is needed.

---

## 1. Why harness-only is sufficient

| Datum | Source | Proof |
|---|---|---|
| selected bank / slot / queried / choice / plastic_write / reward | `CCResult` | field declarations in `ContextConditionedMemory.h`; probe prints them |
| router scores & margin | `ccRouterWeights()` → `Σ_{f∈cue} W[f][k]` | probe prints `score=[...]` |
| update mass per bank/pathway | `ccBankWeights()` before/after | probe prints `update_mass` |
| router L1 | `ccRouterWeights()` before/after | probe prints `router_l1=1.333333` |
| state identity | `ccSerialize()` | probe prints a state fingerprint; the run wrapper hashes it |
| bank lifecycle | `ag.bank_state`, `ccActiveBank()` | public members; probe prints them |
| intended slot | `map.phi[s.ctx]` (driver state) | probe prints `intended_slot=1` |
| intended bank | R-majority over the cue (driver state) | pure function of the cue; no engine knowledge |

---

## 2. The change

### P1 — `StreamSpec` additions (line ~145)

```cpp
bool emit_l11 = false;          // default OFF: legacy behaviour is unchanged
std::string run_id;             // operator-supplied, required when emit_l11
std::string protocol_sha;       // 64-hex, validated at argument parsing
std::string dump_state_path;    // optional: ccSerialize() dump for external hashing
```

### P2 — trial record type (`StreamResult`, line ~117)

```cpp
struct TrialRow11 {
    // identity
    std::string cue_id;  int cue_cat = -1;  int cue_modified = 0;  int held_out = 0;
    std::vector<int> cue;
    // routing
    int intended_bank = -1;  int selected_bank = -1;  int routing_correct = -1; // -1 => null
    double score_margin = 0.0;  int have_margin = 0;
    // retrieval
    int intended_slot = -1;  int selected_slot = -1;  int have_slot = 0;
    int presented[2] = {-1, -1};  int queried = -1;  int choice = -1;  int correct = -1;
    int scoring_window = 0;
    // memory / learning
    int active_bank = -1;  std::string bank_state;  int plastic_write = 0;
    int have_mass = 0;  double mass_intended = 0.0, mass_other = 0.0;
    double reward = 0.0;  int have_adv = 0;  double advantage = 0.0;
    int have_router_l1 = 0;  double router_l1 = 0.0;
};
```
`have_*` flags exist so that "not measured" is written as an **empty field**, never
as `0`. This is the schema's explicit-absence rule, enforced by type rather than by
discipline.

### P3 — capture in `evalTask` (inside the per-trial loop, after `runCCTrial`)

Evaluation runs with learning disabled, so the learning fields are explicitly
absent (`have_adv = have_router_l1 = have_mass = 0`), and the router weights are
constant across the call — the margin is computed once per call from
`ccRouterWeights(ag)` and stored per row.

### P4 — capture in the training loop (`runStream`, after `runCCTrial`)

```cpp
// only when spec.emit_l11
auto wb0 = ccBankWeights(ag);   auto wr0 = ccRouterWeights(ag);
const double baseline_before = ag.reward_baseline[0];   // BEFORE the call
CCResult r = runCCTrial(...);
auto wb1 = ccBankWeights(ag);   auto wr1 = ccRouterWeights(ag);
// mass_intended = Σ |ΔW| over (bank, queried); mass_other = Σ |ΔW| over the bank elsewhere
// router_l1     = Σ |ΔW| over [feat][bank]
// advantage     = reward − baseline_before, only if the router actually updated
//                 (learning_enabled && router_learning && mode==CC_LEARNED && forced_bank<0)
```
The `w0/w1` copies the L10.1 telemetry already makes can be reused for the subset of
trials it covers; the additional copies are two 108- and 36-double arrays per trial,
which neither allocates RNG nor touches weights.

**The baseline snapshot is mandatory**: `runCCTrial` updates
`reward_baseline` internally, so reading it after the call yields the *next* trial's
baseline, not the advantage that was applied.

### P5 — separate writer

```cpp
void writeTrial11Csv(const std::string& path, unsigned master, const StreamResult& r);
// -> <out>/trials11_<tag>.csv, 35 columns in schema order, '\n' endings,
//    ';'-joined cue, empty field for every absent value.
```
`writeTrialCsv` is **not modified**, and `trials_<tag>.csv` is written exactly as
before. Non-interference therefore reduces to a byte comparison of an untouched
file.

### P6 — CLI (argument loop in `main`, line ~705)

```cpp
--emit-l11 0|1        (default 0)
--run-id <string>     required when --emit-l11 1
--protocol-sha <hex64>  required when --emit-l11 1; aborts if not 64 lowercase hex
--dump-state <path>   optional
```
Aborting on a malformed or missing protocol hash prevents the failure mode this
project already suffered once (`e32043c` quoting a stale hash).

### P7 — the declared rule (new, driver-side)

```cpp
// R-majority over disjoint signature groups of width 4: bank owning the group that
// contributes the most cue features; ties -> lowest bank index.
int intendedBankByRule(const std::vector<int>& cue, int n_tasks, int group_width = 4);
```
It receives only the cue, so it cannot leak task identity to the mechanism. Its
predictions are unit-testable without any model (test T11).

### P8 — state dump for external hashing

`--dump-state` writes `ccSerialize(ag)` at run start and after each task step. The
runner (Python) computes SHA-256. No crypto is added to C++.

---

## 3. Expected effect on behaviour

| Property | Expectation | How it is checked |
|---|---|---|
| default-off output | byte-identical to `6a43974` | 18-file comparison already established as the stable baseline (§5.1 of the report) |
| RNG consumption | unchanged: no new draws anywhere | trial counts and `sel_slot` per trial must match on/off |
| weights, routing, reward, eligibility | unchanged | per-trial comparison of the 17 legacy columns |
| final state | unchanged | `ccSerialize` dump identical on/off |
| legacy `trials_*.csv` | untouched | file hash identical |

If any of these fail, the implementation is wrong — **the criterion must not be
weakened**.

---

## 4. Out of scope for this change

- The six new cue categories/arms (`CROSS21`, `CROSS31`, `AMBIG11`, `MISLEAD`,
  `ORDERPERM`). Instrumentation alone produces correct records for arms that do not
  yet exist. The arms are a **separate** authorized change, and no official run may
  happen before they exist.
- Any threshold, metric definition, seed list or aggregation rule.
- Any engine/mechanism change.
