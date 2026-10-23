# Round-1 Store Preservation — 2026-10-23 (partial reconstruction, disclosed)

## What happened (already documented in ACCEPTANCE_RECORD.md §10, commit affecc4)

The Round-1 acceptance store `build/results/` (43 JSONs) was produced during
the Round-1 campaign on 2026-10-22 and verified complete at that time (SNAP0
25/25 OK after all appends). Between session turns the sandbox rebuilt the
checkout; untracked content under the directory name `build/` is excluded from
persisted snapshots. The store was lost before any preservation copy could be
made. This is an environment persistence loss, not an evidence-handling action.

## What is preserved here: `build/results-round1-g7fail-20261022/`

- **24 records — recovered bit-identical.** These are byte-identical copies of
  the git-tracked feasibility archive `build/results-g7pair-20261022/`, which
  are also byte-identical to the 24 records transferred into the Round-1 store.
  Verified against Round-1's own recorded hashes (`logs/round1_recovered_check.sha256`
  = SNAP0 minus the E3 line, path-adjusted): **24/24 OK**.

## What is lost and disclosed

- **18 all-core measurement records (9 per pass)** — irrecoverable; per-file
  hashes were never captured (SNAP0 predates them). Their measured aggregates
  survive verbatim in Round-1 `logs/run_log.txt` (printed medians) and
  `logs/aggregate_normal.txt` / `aggregate_strict.txt` (complete evaluator
  output including the G7 deviation table).
- **1 E3 disposition record** — original sha256
  `f868c7b5c7d275efd7fb290550ae8559217f64d49a975df152eb6d5792abb51c`
  (recorded in ACCEPTANCE_RECORD §3 and SNAP0 line 25). Administrative record,
  no measurements; Round 2 produces its own E3 disposition record.

## Auditability

- Round-1 verdict (FAIL G7) was computed by the production evaluator over the
  intact 43-record store before the loss; both aggregate outputs are committed
  (work/g7_acceptance_campaign_20261022/logs/).
- Every hash of the 25 pre-all-core records is committed (SNAP0).
- This directory is labeled a PARTIAL RECONSTRUCTION; it is never represented
  as the complete Round-1 store.
