# STARK-L10 — Run manifest and reproduction record

Everything in this directory is raw output. Nothing here was edited by hand
except this manifest and `build_report_metadata.py` (which only *adds* an
envelope to the raw results; it never alters a measured number).

## 1. Repository and Git state at the start of the milestone

| Item | Value |
|---|---|
| Repository | `Rahulrr324/A.P.E.X` (private), default branch `main` |
| Working branch | `arena/86da64f9-a-p-e-x` (Arena session branch) |
| Starting HEAD | `5f5a57717509623bd4c79460d50c05f7cbc605c3` (`STARK-L9: Continual learning and catastrophic forgetting`) |
| Working tree at start | clean, no untracked files |
| PR #2 | `OPEN`, unmerged, base `main` @ `563395f1ca7742ecb65bcef6134212f5bb66c3d8`, head `arena/c90f7329-a-p-e-x` @ `5f5a57717509623bd4c79460d50c05f7cbc605c3` |
| Note | this Arena session's branch (`arena/86da64f9-a-p-e-x`) is a clone of the PR #2 head commit; PR #2 was not merged, closed, or replaced |

Commands used to establish the starting state:

```
git status --porcelain=v1 -b
git log --oneline -30 --decorate
git remote -v
git fetch origin --prune
git ls-remote origin
gh repo view Rahulrr324/A.P.E.X --json name,nameWithOwner,defaultBranchRef,isPrivate,url
gh pr view 2 --repo Rahulrr324/A.P.E.X --json number,state,baseRefName,headRefName,headRefOid
```

## 2. Environment

| Item | Value |
|---|---|
| Compiler | `g++ (Debian 12.2.0-14+deb12u1) 12.2.0`, `-std=c++17 -O2` |
| Cores / RAM | 2 vCPU / 3 GB |
| cmake | **absent** in this sandbox; every target was built with the
  explicit source list from `stark/CMakeLists.txt` |
| OS | Linux (Debian 12). The M0/§K `test_phase1_affinity` target is
  Windows-only source (`DWORD_PTR`) and does not compile here — pre-existing,
  unmodified by L10. |

## 3. L9 baseline reproduction (before any L10 change)

```
cd stark && g++ -O2 -std=c++17 -Isrc -o continual_learning_loop \
  src/learning/continual_learning_loop.cpp src/learning/RelevanceRouting.cpp \
  src/neural/NeuralCell.cpp src/neural/Synapse.cpp src/neural/Network.cpp
./continual_learning_loop        # writes work/dev_continual_learning_report_STARK-L9-1.json
```

- Runtime 3.7 s.
- Output md5: **`a00b62b330bf231fdecf2b4991ec44fa`** — identical to the
  determinism md5 recorded in the L9 report.
- All six arms reproduce the published pooled numbers exactly, e.g.
  `SEQUENTIAL acq=[1.000000,0.666667,0.563889] mean_forget=0.467593
  final_avg=0.275926`, `REPLAY 0.366667 / 0.206481`,
  `CONSOLIDATION 0.285185 / 0.182407`, `FRESH-TRAINING 0.116667 / 0.052778`.
- Raw copy: `l9_reproduction/report_reproduced.json`, console transcript
  `l9_reproduction/console.txt`.

## 4. L8 reproduction

`n_way_learned_relevance_loop_L8` → `verdict: PASS` (14 s).
Raw: `l8_reproduction/console.txt`.
(The binary needs a `build/dev_bin/` directory to exist in its working
directory for its checkpoint fixtures.)

## 5. L10 evaluation

```
cd stark && g++ -O2 -std=c++17 -Isrc -o context_conditioned_memory_loop \
  src/learning/context_conditioned_memory_loop.cpp \
  src/learning/ContextConditionedMemory.cpp src/learning/RelevanceRouting.cpp \
  src/neural/NeuralCell.cpp src/neural/Synapse.cpp src/neural/Network.cpp
./context_conditioned_memory_loop        # 8 arms x 3 frozen seeds
```

- Two independent runs (`final_run/`, `determinism/report_rerun.json`),
  20.3 s / 20.0 s each, peak RSS 7.2 MB.
- Determinism: after removing wall-clock fields (`env.total_seconds`, per-seed
  `seconds`), the two result documents are identical
  (sha256 of the normalised document
  `5554710d03619ac9118ad660d7030cc47f32cfc23154765a7934cc65b8d34c0e`).
  The `per_seed.csv` files differ only in their `seconds` column.
- Self-test (save/load, checkpoint resume): all three checks `true`.
- Same binary, development seed only: `./context_conditioned_memory_loop --dev`
  (seed `987654321`, not an evaluation master).

## 6. Regression battery

Built and run from `stark/` (see `regression/results_stark_cwd.txt`, per-suite
stdout in `regression/*.out`):

| Suite | Exit | Result |
|---|---|---|
| test_neuron / test_params / test_synapse / test_integration / test_network | 0 | pass |
| test_stdp | 0 | All tests passed |
| test_homeostasis, test_three_factor, test_serialization | 0 | ALL TESTS PASSED |
| test_learning_loop, test_delayed_reward, test_sequential_context | 0 | ALL TESTS PASSED |
| test_associative_memory, test_eligibility_gating, test_learned_relevance, test_n_way_learned_relevance | 0 | ALL TESTS PASSED (see note) |
| test_context_conditioned_memory (new) | 0 | PASS (330 assertions) |
| test_phase1_profiler / accounting / budget / records / reproducibility | 0 | PASS (34/67/55/72/37 assertions) |
| test_phase1_gates | 0 | **PASS (437 assertions, 0 failures)** |
| test_phase1_affinity | — | does not compile on Linux (`DWORD_PTR`), pre-existing |

**Note on the four suites that abort in the table's second-to-last group:** they
abort with `Network::save: cannot open file: build/dev_bin/...` when the
working directory has no `build/dev_bin/` directory. After creating it, all
four pass (exit 0). This is a fixture-path requirement, not a test failure —
verified both ways; see `regression/results_isolated_cwd.txt` and
`regression/*.out`.

**Note on `test_phase1_gates`:** the inherited claim was "19 known failures".
Run from a directory without the expected fixture layout it reports exactly
19 `copy_file` failures (`regression/test_phase1_gates_from_tmp.txt`). Run
from `stark/` — the canonical layout — it passes with 0 failures
(`regression/test_phase1_gates_from_stark.txt`). The 19 "known failures" are
therefore a working-directory artifact, not a gate regression. The test source
was not modified.

## 7. Files added by this milestone

```
stark/design/context_conditioned_memory_milestone.md   (frozen protocol + revision log)
stark/src/learning/ContextConditionedMemory.h
stark/src/learning/ContextConditionedMemory.cpp
stark/src/learning/context_conditioned_memory_loop.cpp
stark/tests/test_context_conditioned_memory.cpp
stark/CMakeLists.txt                                    (two targets added)
work/dev_context_conditioned_memory_report_STARK-L10-1.md
work/dev_context_conditioned_memory_report_STARK-L10-1.json
work/l10_raw/**                                         (this evidence)
```

No existing source file was modified. `git diff --stat` against the starting
commit shows only additions.
