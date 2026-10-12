#!/usr/bin/env python3
"""Append section 7a (answers 1-4) to highres_v8_analysis.txt."""
from pathlib import Path

out = Path("stark/reports/g7-campaign-affinityfix/highres_v8_analysis.txt")
L = """7. EXPLICIT ANSWERS (v8 step instructions, requirement 4)

  (1) Does B6 now pass the predeclared 2.0% collector-perturbation
      criterion?  **YES -- PASS.**
      Paired median +0.19%, paired mean +0.81%, pooled-median comparison
      +0.00% (A = 140.0 us, B = 140.0 us over 400+400 iterations) --
      all three aggregates are within +/-2.0%.  The v7 pooled -5.71% is
      NOT reproduced.  Honest qualification: 4/8 individual pairs exceed
      +/-2% (50% of pairs), range -6.99%..+5.67%, spread 12.67 pp.

  (2) If not, order/cold-start or genuine perturbation?  Not applicable
      (criterion passes), but the residual per-pair scatter is answered:
      it is NEITHER.  Signs are inconsistent across pairs (+5.67, +2.13,
      -6.99, +0.38, +5.62, +0.00, +0.00, -0.35); order subgroups are
      nearly identical (A->B mean +1.07%, B->A mean +0.54%) so no order
      bias; pooled is exactly 0.00% so no systematic collector effect
      (a real effect would be sign-stable with nonzero pooled).  The
      scatter tracks exec-to-exec frequency-state flips (exec medians
      cluster near ~133 vs ~143 us, +/-7.5%) -- i.e. the very variation
      the investigation measures.  v7's -5.71% was driven by the
      session's first-ever cold A exec (146 us) plus the post-idle A
      exec (130 us), which this position-matched design removes.

  (3) Does B9 now have comfortable coverage above the 10-sample floor?
      TYPICALLY YES, NOT UNIFORMLY: 7/8 execs carry 14-15 usable
      in-window samples (+4/+5 margin = 40-50% above the floor, at the
      duration ceiling span/500 = 14-15 slots); 1/8 exec fell to 7
      usable because of ONE 6.2 ms collector scheduling stall
      (max_sample_gap 6247 us; all 14 slots were otherwise available).
      Mechanism of v7's 10-13 result (now identified, all four
      candidates tested): (a) execution duration -- dominant: the
      ~6.9-7.2 ms window at 500 us admits at most 14-15 samples; (b)
      sample filtering -- contributed in v7 (3 and 2 R2 rejections)
      but ZERO rejections in v8; (c) out-of-window boundary loss 2-3
      samples; (d) PDH latency/failures -- NOT a cause: 0 failures in
      all 8 execs, max single PDH call 633 us; scheduling -- the cause
      of the single 7-sample exec (one 6.2 ms stall).  B9 is NOT
      intrinsically worse than B6: B6 spans are identical
      (6.7-7.3 ms) and v8 B6 execs carry 13-23 samples at the same
      ceiling.  The floor rule (>=10) was NOT lowered and cadence was
      NOT increased.

  (4) Does the v7 finding of genuine within-execution frequency
      variation survive?  **YES.**  6/16 B execs show in-exec spreads
      5.65-17.12%; 5/16 exceed the production 6.8974% gate value
      INSIDE a single ~7 ms exec (impossible for a between-exec or
      sampling artifact to mimic).  Between-exec medians are stable
      (pooled A = B = 140.0 us exactly; B9 exec medians 133-135 us),
      the counter is adequate (P1 distinct-change median 5.0 us;
      P2 step latency 0.026 ms), pins verified on both threads,
      0 PDH failures, 0 rejected samples.  Per-exec distribution
      differs from v7 (6 A / 3 B / 7 C vs 6 A / 2 B / 0 C): the new
      C-zone execs show MODERATE 2.67-4.19% in-exec variation that
      meets neither threshold -- recorded honestly, not reclassified.
"""
out.write_text(out.read_text(encoding="utf-8") + L + "\n", encoding="utf-8")
print("appended answers 1-4")
