STARK-L10.1  P-FROZEN: reproduction of the frozen L10 protocol (track P-FROZEN)

Build: g++ 12.2.0 -O2 -std=c++17 from the working tree of branch validation/l10-1-control-repair
Command: ./ccm   (8 arms x 3 frozen seeds, 3 tasks, 3 banks, frozen protocol v1.0)
run1 normalized sha256 = fe76eb2a7a626be5714fa3c48a3943f56b2b4284a5fd911065586c6e2628787d
run2 normalized sha256 = fe76eb2a7a626be5714fa3c48a3943f56b2b4284a5fd911065586c6e2628787d
previous milestone (independent_validation_20261024/post_fix) = fe76eb2a7a626be5714fa3c48a3943f56b2b4284a5fd911065586c6e2628787d
deterministic across runs : True
matches previous milestone : True
(normalization removes env.* and per-seed seconds, i.e. wall-clock fields only)

Criteria block, unchanged and verbatim:
  L10-A:       PASS  |  CCM mean forgetting <= 0.10 and final avg >= 0.85
  L10-B:       PASS  |  CCM acquisition >= 0.85 on every task
  L10-C:       PASS  |  CCM routing accuracy >= 0.90 on every task
  L10-D:       PASS  |  CCM held-out cue combination >= 0.80 per task
  L10-E:       FAIL  |  shuffled-cue <= 0.40 and context-off <= 0.40
  L10-F:       FAIL  |  NO-SEAL mean forgetting > CCM mean forgetting
  L10-G:       PASS  |  K2-STRESS worse than CCM (forgetting or final avg)
  L10-H:       PASS  |  persistence + determinism + checkpoint resume exact
  L10-I: SEE-REPORT  |  no new regressions vs L9 baseline (see markdown report)
  L10-J: SEE-REPORT  |  limitations reported honestly; no threshold nudged

L10-E result: FAIL (context-off 0.425926 > 0.40) -- threshold NOT changed
L10-F result: FAIL (NO-SEAL == CCM)          -- criterion NOT changed
