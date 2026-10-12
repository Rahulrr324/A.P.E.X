# G7 controlled-variability hypothesis worklog

## Hypothesis
The G7 failures across B6/B7/B9 might be reduced by tighter intra-run control: larger
sample count per independent execution, longer warmup, and spacing between independent
runs to reduce thermal/throttling noise. The frozen V009 contract permits all of these
(measurement_count >= 10 configurable; warmup_count >= 3 configurable; thread_count=1;
deterministic seeds).

## Campaign run
- `n = 50` timed samples per independent execution (spec floor = 10)
- `warmup = 10` iterations per execution (spec floor = 3)
- `thread_count = 1` (single-thread, spec §B)
- `independent_runs = 5` per (experiment_id, benchmark_id) pair
- experiment_ids: E1 and E5 (required by G2/G4; same logical configuration)
- delay between independent runs: 30s

This produced **10 valid independent executions per benchmark** (5 E1 + 5 E5), all with
n=50 raw samples, all median-validated by the independent calculator.

## Result
All 10 executions per benchmark were valid, but the pairwise symmetric relative difference
**did not improve** with the larger per-execution sample count. Spread remained very large:

| benchmark | execs | max pairwise | min pairwise | CV%  | verdict |
|-----------|-------|--------------|--------------|------|---------|
| B6        | 10    | 64.84%       | 2.23%        | 28.67 | FAIL |
| B7        | 10    | 56.19%       | 0.55%        | 26.12 | FAIL |
| B9        | 10    | 67.04%       | 0.41%        | 32.46 | FAIL |

Notably, some pairs were within tolerance (B6 min 2.23%, B7 min 0.55%, B9 min 0.41%),
but the all-pairs rule is strict: a single failing pair fails the group.

## Observation
The per-execution median values cluster but with a wide spread. Under n=50 per execution,
the within-execution sampling noise is already small; the residual spread across executions
is not primarily from too-few samples per execution. This is consistent with systemic
run-to-run variability (thermal throttling, frequency scaling, OS scheduler, background
activity) that tighter within-execution sampling does not eliminate.

## Decision
Increasing n further (e.g. n=100 or n=200) is not likely to close a 60% spread that
already persists at n=50 with 10 warmup iterations and 5 independent runs. The gating
issue is not raw-sample count per execution; it is run-to-run reproducibility on this
hardware under the permitted controls.

A second larger-n campaign is not pursued here because:
- The controlled-variability hypothesis was tested with a substantially larger n than
  the historical attempts and did not resolve G7.
- Further increases would be tuning toward a pass, which the frozen contract does not
  authorize as a substitute for genuine reproducibility.
- The objective of this campaign is to determine whether G7 can pass under a compliant
  measurement, not to endlessly iterate until a favorable run appears.

## Conclusion
Under the frozen V009 contract and the controls permitted by it, the current hardware
did **not** produce a same-configuration baseline group that satisfies the ±15% all-pairs
requirement for B6, B7, or B9. G7 remains failed for the current baseline evidence.
