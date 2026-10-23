# C1 Campaign Pre-Registration — 2026-10-23 (written before measurements)

Authorization: owner message 2026-10-23 ("I authorize C1 as scoped in
`work/C1_DECISION_NOTE_20261023.md`: change the E1/E5-family measurement_count
from 10 to 200 in make_cfg, including the specified L282 comment cleanup; run
the §K regression tests; and execute one fresh-store acceptance campaign with
both variants per U2, E3 disposition-only, frozen gates and thresholds, normal
and strict evaluation, §M checks, and the accepted manual G8 checklist. …").

Applied change (verified): run_baseline.cpp make_cfg measurement_count
10→200 + L282 comment cleanup (git diff: 2 insertions, 2 deletions). §K
regression 5/5 PASS (265 assertions) before campaign.

Fixed scope: U1 Linux Xeon container · U2 BOTH variants (single-thread
`--threads 1` `taskset -c 0`; all-core `--threads 2` `taskset -c 0,1`) · U3
external pinning + run-log · E3 disposition-only · frozen gates/thresholds
(±15%/±20%) · normal+strict aggregate · §M · manual G8 (U5) · U9 flip
definition unchanged (signature required after PASS).

Store: fresh `build/results-c1-20261023/` (Round-2 `build/results/` preserved
untouched as tracked evidence; the U8 literal-path nuance is reported as a
remaining compliance gap, separate from the campaign verdict).

Expected records: 43 = 2 PROFILE/TELEMETRY + 3 SKIPPED (E2/B4/B5) + 2
NOT_ATTEMPTED (E3/E4) + 36 measured (both variants × 2 passes ×
{E1,E5,B1,B2,B3}). E1/E5-family records carry measurement_count=200;
B1/B2/B3 carry their protected overrides (warmup 10 / measurement 30).

Order: env set ONCE (profiler_cli, E2, E4) → E3 --disposition → snapshot →
single-thread PASS 1, PASS 2 → all-core PASS 1, PASS 2 → aggregate normal +
strict → §M → manual G8 → campaign report. No repeats, no outlier handling,
no threshold or evaluator changes.

Predictions (from investigation F1–F4): with 200-sample medians, sub-second
host plateaus no longer define a record's median; G7 is expected to PASS on
this fresh store if host states remain sub-second — not guaranteed.
