#!/usr/bin/env python3
"""Append answers 5-8 + closing sections to highres_v8_analysis.txt."""
from pathlib import Path

out = Path("stark/reports/g7-campaign-affinityfix/highres_v8_analysis.txt")
L = """  (5) Does any remaining uncertainty affect the validity of the
      frequency measurement?  NO material effect.  Residuals and why
      they do not invalidate: (a) 1/16 B exec below the coverage floor
      (7 usable) -- classified C by rule and excluded from adequacy-
      based claims; the other 15/16 carry 13-23 usable samples; (b) B6
      per-pair timing scatter +/-7% sign-inconsistent -- affects only
      the A/B timing comparison, which pools to exactly 0.00%; (c) A
      execs have no frequency samples (structural: no collector exists
      during A by design) -- frequency claims rest on B execs as
      predeclared; (d) one first-B-exec transient (pair 0: span
      13199 us, 9 slow iterations) -- inside the timed region, counted
      in the aggregates, not excluded.  Counter adequacy, pin
      verification, and 0 PDH failures are unchanged from v7.

  (6) Which classification applies?  **A -- genuine within-execution
      frequency variation** (same as v7), under the existing rules
      unchanged.  B (measurement artifact) is not supported: only 3/16
      execs hold <=2.0% in-exec spread, and those occur only in
      already-at-frequency stretches, while 5/16 execs exceed 6.8974%
      inside one exec.  The collector-perturbation explanation for the
      timing spread fails its own 2.0% test (answer 1).  D is not
      permitted here: coverage (15/16), PDH adequacy, and pins make the
      data decidable.

  (7) Is another diagnostic required?  **NO** for the two predeclared
      v7 limitations: B6 materiality is resolved (PASS, pooled 0.00%,
      order-balanced) and B9's low-coverage mechanism is identified
      (duration ceiling + boundary loss + R2 rejections in v7; zero
      filtering loss and 14-15 typical in v8; one scheduler stall
      explains the single sub-floor exec).  Documented residual
      limitation: at the frozen benchmark timing (~7 ms exec windows)
      and the fixed, predeclared 500 us cadence, per-exec coverage is
      structurally capped at 14-15 samples, and a rare scheduler stall
      can drop a single exec below 10.  Raising that cap would require
      changing the cadence or the benchmark -- both explicitly out of
      scope.  This residual does not bear on the frequency finding.

  (8) Is G7 authorized?  **NO.**  This step ran no G7 campaign.  The
      5% G7 gate, thresholds, formulas, benchmark timing semantics,
      frozen 30 records, records_sha256.txt, evidence_manifest.json,
      production binaries, v7 evidence, and historical records are
      unchanged (all re-verified, section 0).  No G7CAM record was
      created or modified.

8. WHAT THIS EVIDENCE MEANS FOR G7 (interpretation only -- no gate change)
   - The diagnostic instrumentation used to question the frequency
     finding is now clean on both documented v7 limitations: the
     collector does not materially perturb execution (B6 pooled
     0.00% vs 2.0% allowed), and B9 coverage is at its duration
     ceiling with the shortfall mechanism fully attributed.
   - Therefore the v7 conclusion -- genuine within-execution CPU
     frequency variation, often exceeding the 5% exec-window spread
     gate inside a single exec -- stands on unconfounded evidence.
   - What that means FOR the G7 gate itself is a separate decision,
     explicitly deferred: nothing here modifies the 5% gate, and no
     G7 rerun is authorized by this step.

9. CHANGED FILES (this step)
   Source: tests/diag_highres_frequency.cpp (v8 P3 schedule only:
     8 alternating B6 pairs + 8 B9 B-side execs; B7 dropped from the
     schedule; control constants DIAG_VERSION/V8_B6_N_PAIRS/
     V8_B9_N_EXECS).  Build: only diag_highres_frequency.exe relinked
     (ninja exit 0); the 5 production binaries unchanged.
   New evidence:
     reports/g7-campaign-affinityfix/highres_frequency_v8.json
     reports/g7-campaign-affinityfix/power_scheme_session_highres_v8.json
     reports/g7-campaign-affinityfix/highres_v8_analysis.txt (this file)
   Not touched: build/g7-campaign (frozen 30),
     build/g7-campaign-affinityfix (30 G7CAM records), both manifests,
     records_sha256.txt, all thresholds/specs, all v7 artifacts.
"""
out.write_text(out.read_text(encoding="utf-8") + L + "\n", encoding="utf-8")
print("appended answers 5-8 + sections 8-9")
