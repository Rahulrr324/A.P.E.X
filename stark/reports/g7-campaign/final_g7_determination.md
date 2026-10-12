# Final G7 determination (frozen 30-record campaign)

## G7 classification

ENVIRONMENT REPRODUCIBILITY LIMITATION

## Conclusion

The frozen 30-record G7 campaign did not satisfy the G7 ±15% all-pairs requirement:
- B6 max pairwise 64.84%
- B7 max pairwise 56.19%
- B9 max pairwise 67.04%

Production aggregator and independent raw-sample calculator agree.

## What the evidence shows

- The spread is cross-benchmark and cross-operation.
- The same campaign runs are fast or slow across B6, B7, and B9 simultaneously.
- The timed operations are short (sub-millisecond for B6/B9).
- The campaign recorded thread_count=1 but did not implement or verify OS affinity pinning.
- The traced benchmark implementation has no demonstrated arithmetic, warmup, or timer defect.

## What the evidence does not show

- The exact mechanism is not directly measured: no actual affinity, frequency, thermal, priority, background-load, or timer-overhead evidence was captured.

## Justification for no further blind campaign

A blind rerun of the same design is not justified. A further campaign is justified only if it first addresses the concrete control/instrumentation gap (proven affinity, better timing/isolation where the frozen spec permits) under a frozen design.

## Status

M0 remains FAIL.
M1 remains LOCKED.
