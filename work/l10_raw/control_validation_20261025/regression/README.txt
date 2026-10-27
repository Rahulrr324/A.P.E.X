STARK-L10.1  canonical regression battery
==========================================
Working directory: stark/   (documented layout; fixtures build/dev_bin/ created in place)
Build: g++ 12.2.0 -O2 -std=c++17 -Isrc -Isrc/phase1 -I.
Date: 2026-10-25

26 built targets, all exit code 0:

  test_neuron, test_params, test_synapse, test_integration, test_network,
  test_stdp, test_homeostasis, test_three_factor, test_serialization,
  test_learning_loop, test_delayed_reward, test_sequential_context,
  test_associative_memory, test_eligibility_gating, test_learned_relevance,
  test_n_way_learned_relevance,
  test_context_conditioned_memory    PASS (330 assertions)
  test_l10_structural_audit          PASS (357 assertions)
  test_l10_1_sealing                 PASS (276 assertions)   [NEW in L10.1]
  n_way_learned_relevance_loop_L8    verdict: PASS
  test_phase1_profiler               PASS (34 assertions)
  test_phase1_accounting             PASS (67 assertions)
  test_phase1_budget                 PASS (55 assertions)
  test_phase1_records                PASS (72 assertions)
  test_phase1_reproducibility        PASS (37 assertions)
  test_phase1_gates                  PASS (437 assertions, 0 failures)

NOT EXECUTED (reported as unknown, NOT as passing):
  test_phase1_affinity -- does not compile on Linux:
    tests/test_phase1_affinity.cpp:138: error: 'DWORD_PTR' has not been declared (Win32-only API)
    This is pre-existing and unrelated to L10.1; no source was modified.

Also not built here: Windows-only diagnostics (test_windows_affinity_diag,
test_production_affinity_evidence, diag_*), demos, and the G7/M0 campaign
binaries, which this milestone did not exercise.

Per-suite stdout is in this directory as <target>.log.
