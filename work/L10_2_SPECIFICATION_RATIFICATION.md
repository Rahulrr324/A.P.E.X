# STARK-L10.2 — Specification Ratification and Frozen Protocol v1.1

**Milestone status:** protocol v1.1 registered and partially ratified by the
repository owner; the registered evaluation ran and is **official** for the two
ratified amendments (**A-1, A-3**) and **provisional** for the one that was not
ratified (**A-2**).

**Headline:**

| Criterion | Governing version | Result |
|---|---|---|
| L10-E (context) | v1.0 — **unchanged** | **FAILED** — 0.425926 > 0.40 |
| L10-F (sealing) | v1.0 | **FAILED** (historical, immutable) |
| **L10-F2** (sealing, ratified A-1) | v1.1 | **PASS** on all three masters |
| **L10-G2** (capacity, ratified A-3) | v1.1 | **PASS** |
| L10-R1 / L10-S1 (informational, A-3) | v1.1 | reported, no criterion |
| L10-E3a/b/c (context, **not ratified**) | v1.1 | provisional diagnostics only — do not alter L10-E |

Nothing in this milestone redefines L10-E. The owner ratified sealing and control
separation and declined the context amendment; the record reflects exactly that.

---

## A. Provenance

Verified against the live repo and GitHub before any change.

| Item | Value |
|---|---|
| Repository | `Rahulrr324/A.P.E.X` (private, default `main` @ `563395f1…`) |
| Starting branch | `validation/l10-1-control-repair` |
| Starting SHA | `127574506947d9fb193664868227665d47478252` |
| L10.2 branch | `validation/l10-2-spec-ratification` (created from `1275745`) |
| Registration commit | `2fa3100` — protocol v1.1 hash fixed **before any run** |
| Decision commit | `f935f07` — owner decision + v1.1.1 editorial correction |
| L10 milestone commit | `49cc6ba18650c0d9614bb9e8918fe65453ec5a02` |
| PR #2 | **OPEN, unmerged** — `arena/c90f7329-a-p-e-x` @ `5f5a577…`, base `main`, 202 files |
| PR #3 | **OPEN, unmerged** — `arena/86da64f9-a-p-e-x` @ `49cc6ba…`, base `arena/c90f7329-a-p-e-x`, 48 files |
| New PR | **none created** |

Original evidence re-verified before starting:

- L10.1 manifest: **275/275** sha256 entries verified, 0 problems.
- Frozen L10 artifacts unchanged: `b38736bb…`, `17beb41e…`, `a00b62b3…`.
- `git diff 123ef65` for the L10.1 branch touched no frozen artifact.

> **Branch note.** The two previous milestones of this session were also done on
> dedicated `validation/*` branches, because PR #3's head must stay stable. The
> same convention is used here: `arena/86da64f9-a-p-e-x` (PR #3) remains at
> `49cc6ba`, byte-for-byte untouched.

## B. Specification authority

**Where the criteria live.** `stark/design/context_conditioned_memory_milestone.md`
§8, headed *"Frozen success criteria"*:

> `L10-E | shuffled-cue mean accuracy ≤ 0.40 and context-off mean ≤ 0.40`
> `L10-F | NO-SEAL mean forgetting > CCM mean forgetting`

**Who may change them.** That document contains **no delegation clause** — a text
search for grant-of-authority language across `stark/design/` returns only
unrelated non-goals. Nothing authorises an agent, a tool or a report to amend a
criterion. The established governance convention in this repository is the
**Owner Decision Record** under `stark/reports/` (precedent:
`G7_OPTION1_OWNER_DECISION.md`, 2026-10-08, "Type: Governance / specification
decision artifact"). Authority therefore rests with the repository owner.

**Decision obtained.** The three amendments were put to the owner in this session
as a single question; the answer was **"Ratify A-1 and A-3 only"**. Recorded in
`stark/reports/L10_2_OWNER_DECISION.md`, dated **2026-10-24**, referencing
protocol **v1.1 (as editorially corrected by v1.1.1)**.

| Amendment | Scope | Status | Effect |
|---|---|---|---|
| **A-1** | L10-F sealing ablation | **RATIFIED** | L10-F2 becomes an official criterion |
| **A-2** | L10-E context criterion | **NOT RATIFIED** | L10-E unchanged; remains FAILED |
| **A-3** | control separation | **RATIFIED** | L10-G2 official; L10-R1 / L10-S1 informational |

**The agent did not approve anything.** The decision text, date and scope in the
record are the owner's selection quoted verbatim; the record explicitly states
it does not extend that decision beyond the three amendments.

### Outstanding owner decision

**A-2 remains open.** Until it is decided, L10-E cannot pass under any
implementation, because its bound (0.40) lies below the floor imposed by the
frozen task permutations (0.425926). The provisional diagnostics in §D.2 show
why, but they change nothing.

## C. Protocol

| Field | Value |
|---|---|
| Document | `stark/design/l10_2_protocol_v1_1.md` |
| Version | **v1.1.1** (v1.1 + one editorial path correction) |
| sha256 at registration (`2fa3100`) | `e753d3fbd9ffa81c7a757cdcdbf71c6bd2d2e104d685d2901e14f593134c6cd5` |
| sha256 after decision (`f935f07`) | `a514703c39d368ad50e8c5e6c48b2dc710d04b2df59ecf7f93b84cb7d179870c` |
| Hash fixed before any run | **yes** — registration commit precedes every artifact in the evidence directory |
| Post-registration change | v1.1.1, **editorial only**: the registered artifact directory label carried a wrong date (`20261026` → `20261024`). No arm, metric, threshold, seed or decision rule touched; logged in the protocol's version log and in the decision record |
| Official evaluation authorised | **partially** — official for L10-F2/L10-G2/L10-R1/L10-S1; provisional for all context diagnostics |

**What the protocol fixes (unchanged by the editorial correction):**

- 9 arms R0–R8 with explicit hypotheses (§3), including the matched seal pair
  (`commit_trials = 240`), a sensitivity pair (`60`), a separated mis-routing
  stress, the per-bank sweep, the de-confounded capacity arm, the frozen-router
  arm and the L9 parity arm.
- Seeds: primary `123456789, 218213831, 171473193`; exploratory `1, 2, 7, 42`
  (no criterion). All seed derivations exactly as protocol v1.0.
- Trial counts, matched-pair rule, divergence rule, metric formulas, `A(t)`,
  `excess`, `M(t)`, and the exact definition of context-off (all cue inputs 0.0,
  masked argmax, no exploration).
- Decision rules and thresholds, all declared before the run: sealed forgetting
  ≤ 0.10 (L10-A's own band), unsealed ≥ sealed + 0.10, opportunities > 0,
  |ΔW| into sealed banks = 0; E3a 0.02, E3b 0.60, E3c 0.99; L10-G2 unchanged
  decision rule.
- Failure conditions that make a run INVALID rather than FAIL.

## D. Results (protocol v1.1, registered run)

### D.1 Sealing — official (A-1)

**R1 `SEAL-PAIR-240`** — matched arms, `commit_trials = 240`, everything else
frozen; the only difference is `cfg.seal_superseded`.

| seed | sealed forget | unsealed forget | opportunities (sealed) | blocked | executed (unsealed) | \|ΔW\| into sealed banks (sealed arm) | \|ΔW\| non-active (unsealed arm) |
|---|---|---|---|---|---|---|---|
| 123456789 | **0.0000** | 0.3361 | 51 | 51 | 50 | **0.000** | 7.790 |
| 218213831 | **0.0000** | 0.5278 | 67 | 67 | 67 | **0.000** | 11.131 |
| 171473193 | **0.0000** | 0.4889 | 67 | 67 | 67 | **0.000** | 11.437 |
| **pooled** | **0.0000** | **0.4509** | 185 | 185 | 184 | 0.000 | 30.358 |

| Condition | Result |
|---|---|
| F2.1 opportunities > 0 on every seed | **PASS** (51 / 67 / 67) |
| F2.2 sealed mean forgetting ≤ 0.10 on every seed | **PASS** (0.0000) |
| F2.3 unsealed ≥ sealed + 0.10 on every seed | **PASS** (0.336 / 0.528 / 0.489) |
| F2.4 no write reached a sealed bank | **PASS** (0 writes, \|ΔW\| = 0) |
| **L10-F2** | **PASS** |

Acquisition is unaffected (min 1.0000 in both arms): sealing does not cost the
active bank its learning, it only blocks writes into superseded banks.

**R2 `SEAL-PAIR-60` (sensitivity, direction only):** sealed 0.0000 vs unsealed
0.5333; 345 blocked vs 342 executed. Same direction, larger effect, as declared.

**R3 `SEAL-STRESS` (informational L10-S1, 20 % declared cue corruption):**
sealed final 0.5194 / forgetting 0.4806 vs unsealed final 0.4361 / forgetting
0.5639. Sealing still helps but the gap is small, because a mis-routed **active**
bank is corrupted by the same mechanism and sealing cannot prevent that. This is
reported separately and is **not** part of L10-F2.

**R1 exploratory seeds 1/2/7/42 (no criterion):** sealed 0.0000, unsealed 0.4458.

### D.2 Context — provisional only (A-2 not ratified)

**R4** reproduces the frozen context-off measurement exactly: pooled **0.425926**,
per-task 1.0000 / 0.1667 / 0.3333 for every seed, matching the analytic floor
`A(t) = |{q : π₀(q)=π_t(q)}|/6` to **7.4e-08**. **L10-E remains FAILED**
(0.425926 > 0.40); the threshold was not touched.

Provisional diagnostics (pre-registered in v1.1, not ratified, therefore
informational):

| Diagnostic | Requirement | Result |
|---|---|---|
| E3a no hidden context channel | \|measured − analytic\| ≤ 0.02 | **holds** (7.4e-08) |
| E3b context load-bearing | margin ≥ 0.60 on ≥ 2 of 3 tasks | **holds** (2/3 on every seed) |
| E3c memory intact | per-bank diagonal ≥ 0.99 | **holds** (1.000, 1.000, 1.000 on every seed) |

**R5 per-bank forced cue-off sweep** (memory, *not* context-off performance):

| seed | bank 0 / bank 1 / bank 2 rows (task 0,1,2) | diagonal |
|---|---|---|
| 123456789 | 1.000 0.167 0.333 / 0.167 1.000 0.167 / 0.333 0.167 1.000 | 1.000 |
| 218213831 | 1.000 0.167 0.167 / 0.167 1.000 0.008 / 0.167 0.000 1.000 | 1.000 |
| 171473193 | 1.000 0.000 0.000 / 0.000 1.000 0.167 / 0.000 0.167 1.000 | 1.000 |

Each bank still holds its own mapping perfectly with the cue withheld; the frozen
number is the bank-0 column.

### D.3 Capacity — official (A-3)

**R6 `K2-CAPACITY`** — K = 2, 3 tasks, sealing fixed ON, `--reuse-seal 0` so a
reused bank does **not** silently unseal the others (the L10.1 confound removed):

| arm | final average | mean forgetting |
|---|---|---|
| CCM (R0, K=3) | 1.0000 | 0.0000 |
| K2-CAPACITY (K=2) | **0.6361** | **0.2713** |

L10-G2's decision rule is unchanged from L10-G ("K2 worse than CCM on forgetting
or final average"): **PASS**. The arm now varies only capacity.

### D.4 FROZEN-ROUTER and CONTEXT-OFF, reported separately (A-3)

**R7 `FROZEN-ROUTER`** decomposition, per seed and task:

| seed | task | routing acc | selected bank(s) | acc \| correct bank | acc \| wrong bank | task acc |
|---|---|---|---|---|---|---|
| 123456789 | 0 / 1 / 2 | 1.000 / 0.000 / 0.000 | bank 0 (120/120) each | 1.000 / — / — | — / 0.167 / 0.333 | 1.000 / 0.167 / 0.333 |
| 218213831 | 0 / 1 / 2 | 1.000 / 0.000 / 0.000 | bank 0 (120/120) each | 1.000 / — / — | — / 0.167 / 0.167 | 1.000 / 0.167 / 0.167 |
| 171473193 | 0 / 1 / 2 | 1.000 / 0.000 / 0.000 | bank 0 (120/120) each | 1.000 / — / — | — / 0.000 / 0.000 | 1.000 / 0.000 / 0.000 |

Pooled routing accuracy **0.3333** (a learned router: 1.0000); accuracy given the
correct bank **1.0000**; given the wrong bank **0.1389**. The arm shows that the
*memory* is intact and the *router* carries the capability — and that its task
accuracy necessarily coincides with CONTEXT-OFF's, which is why the two are now
reported side by side instead of being treated as one number.

### D.5 Historical criteria, unchanged

| Criterion | Result | Note |
|---|---|---|
| L10-A, B, C, D | PASS | R0 reproduces CCM exactly (min acq 1.0000, final 1.0000, forgetting 0.0000) |
| **L10-E** | **FAILED** | 0.425926 > 0.40 — v1.0, unchanged |
| **L10-F** | **FAILED** | NO-SEAL ≡ CCM in the v1.0 protocol (0 opportunities) — immutable |
| L10-G | PASS | historical, confounded arm; superseded in practice by L10-G2 |
| L10-H, L10-I, L10-J | PASS / no new failures / reported honestly | see §E |

## E. Tests, determinism, checkpoint

**Regression battery, cwd `stark/`, g++ 12.2.0 `-O2 -std=c++17`** — 26 targets
built, **all exit 0**:

| Suite | Result |
|---|---|
| `test_neuron`, `test_params`, `test_synapse`, `test_integration`, `test_network`, `test_stdp`, `test_homeostasis`, `test_three_factor`, `test_serialization` | pass |
| `test_learning_loop`, `test_delayed_reward`, `test_sequential_context`, `test_associative_memory`, `test_eligibility_gating`, `test_learned_relevance`, `test_n_way_learned_relevance` | pass |
| `test_context_conditioned_memory` | **PASS (330 assertions)** |
| `test_l10_structural_audit` | **PASS (357 assertions)** |
| `test_l10_1_sealing` | **PASS (276 assertions)** |
| `n_way_learned_relevance_loop_L8` | `verdict: PASS` |
| `test_phase1_{profiler, accounting, budget, records, reproducibility, gates}` | PASS (34 / 67 / 55 / 72 / 37 / **437**, 0 failures) |
| `test_phase1_affinity` | **NOT EXECUTED** — `DWORD_PTR` not declared (Win32-only). Reported as unknown, **not** as passing |

**Determinism.** The registered repetition (`rep2/`) reproduces every
criterion-bearing artifact **byte-identically**: R0 metrics, both R1 arms'
metrics and sealing telemetry, and all three R5 per-bank sweeps.

**Independent recomputation.** `analysis/recompute.py` rebuilds acquisition, final
retention, forgetting, routing accuracy, conditional accuracy and the context-off
fallback distribution from the **per-trial rows only** and compares them with the
driver's metrics CSV: **ALL MATCH** for R0, R1 both arms, R2 both arms, R3 both
arms, R6 and R7 (11 arm/seed groups, 81 task-rows).

**Checkpoint resume.** Two-process handover (stage 0 trains tasks 0–1 and writes
state, stage 1 resumes in a fresh process) matches the uninterrupted run's final
retention and bank map on all three seeds.

## F. Disposition

**Established**

1. The L10.1 diagnosis is confirmed on fresh, registered evidence: sealing has
   **zero** opportunities under the v1.0 protocol and a large, reproducible
   effect (0.000 vs 0.451 pooled) once `commit_trials` is halved.
2. **L10-F2 PASSES** on all four conditions, on all three masters, with matched
   arms and independent recomputation. This is the first time sealing has been
   demonstrated as load-bearing under any registered protocol.
3. **L10-G2 PASSES** with the sealing confound removed — the capacity effect is
   genuine and does not depend on the unseal-on-reuse quirk.
4. FROZEN-ROUTER and CONTEXT-OFF are now separately interpretable: the router
   carries the capability (routing 1.000 → 0.333 while memory stays at 1.000).
5. Determinism, checkpoint resume, and the full regression suite hold.

**Still failed / blocked**

- **L10-E is FAILED and stays failed.** The owner did not ratify A-2, so the
  0.40 bound governs; 0.425926 is above it. The provisional diagnostics show the
  bound is below the task distribution's floor — that is now a matter for the
  owner, not for this milestone.
- **L10-F (v1.0) is FAILED** in the historical record. L10-F2 passing does not
  rewrite it: the original criterion is unsatisfiable, and the record keeps both
  statements side by side.
- L10-F2's evidence is a **3-task toy domain with a shortened commitment window**;
  the magnitude is a property of this task structure, not a forecast for a
  personal assistant with thousands of contexts.

**Scientific limitations**

- A-1 and A-2 are **post-hoc** amendments relative to the L10 failures. That is
  disclosed in the protocol, and it is why A-2 was submitted to the owner rather
  than applied.
- The corrected sealing protocol changes *when* the router may act unforced; it
  does not test sealing against a realistic drift or noise model.
- All numbers remain at 6 identities / 2 channels / 3–8 contexts.

**A.P.E.X. completion estimate: ≈50 %, unchanged.**
L10.2 turns one untestable criterion into a tested one and removes two control
confounds. It adds no capability: the system still does a 3-context toy task, one
official criterion (L10-E) still fails, and nothing beyond L10's original scope
was demonstrated. Confidence up, capability flat.

**Recommended next milestone: L10.3 — settle L10-E.**
Not L11. Either the owner ratifies a context criterion (the A-2 text is ready and
its diagnostics already pass), or L10-E is recorded as permanently failed and the
milestone closes with that failure documented. Starting L11 with an open,
provably unsatisfiable criterion would carry a known-broken acceptance record
into the next phase.

## G. Deliverables

| Path | Contents |
|---|---|
| `work/L10_2_SPECIFICATION_RATIFICATION.md` | this report |
| `work/L10_2_SPECIFICATION_RATIFICATION.json` | machine-readable results, approval record, criterion dispositions |
| `stark/design/l10_2_protocol_v1_1.md` | registered protocol v1.1.1 |
| `stark/reports/L10_2_OWNER_DECISION.md` | owner decision record, 2026-10-24 |
| `work/l10_raw/spec_ratification_20261024/` | 194 hashed artifacts: `protocol/`, `R0`–`R8`, `determinism/`, `analysis/` (incl. `recompute.py`), `regression/`, `restart/`, `MANIFEST.md` |

### Reproduction

```bash
cd stark
CORE="src/learning/ContextConditionedMemory.cpp src/learning/RelevanceRouting.cpp \
      src/neural/NeuralCell.cpp src/neural/Synapse.cpp src/neural/Network.cpp"
g++ -O2 -std=c++17 -Isrc -o harness src/learning/l10_validation_harness.cpp $CORE
S=123456789,218213831,171473193
./harness --mode tasks --out DIR --seeds $S --seal 1 --tag _R0
./harness --mode tasks --out DIR --seeds $S --seal 1 --commit 240 --tag _R1_sealON
./harness --mode tasks --out DIR --seeds $S --seal 0 --commit 240 --tag _R1_sealOFF
./harness --mode tasks --out DIR --seeds $S --seal 1 --commit 60  --tag _R2_sealON
./harness --mode tasks --out DIR --seeds $S --seal 0 --commit 60  --tag _R2_sealOFF
./harness --mode tasks --out DIR --seeds $S --seal 1 --commit 240 --misroute 0.20 --tag _R3_sealON
./harness --mode tasks --out DIR --seeds $S --seal 0 --commit 240 --misroute 0.20 --tag _R3_sealOFF
./harness --mode tasks --out DIR --seeds $S --seal 1 --ctxperbank --tag _R5
./harness --mode tasks --out DIR --seeds $S --tasks 3 --banks 2 --seal 1 --reuse-seal 0 --tag _R6
./harness --mode tasks --out DIR --seeds $S --bank-mode frozen --tag _R7
./harness --mode perm  --seeds $S --tasks 3
python3 work/l10_raw/spec_ratification_20261024/analysis/recompute.py DIR tasks_T3_K3 $S _R1_sealON
```
