# Remaining Specification-Compliance Gaps — 2026-10-23 (separate from campaign verdict)

Reported separately per owner instruction. None of these changed the C1
campaign outcome (G7 failures are environmental — see
`work/g7_c1_campaign_20261023/REPORT.md` §4). Each needs a spec-authority or
owner ruling; none is being self-resolved.

1. **D3 — B7 cold-cache mode unimplemented.** V009 §B L123 requires "warm
   and cold cache"; implementation measures warm only
   (`BenchmarkHarness.cpp` L310, `mode:"warm_cache"`). Options: authorize a
   cold-cache variant (new record/mode — methodology addition), or annotate
   the row as warm-only for Phase 1.

2. **Q6 — §B general floor vs table N (now satisfied in practice).** V009 L111
   ("≥10 timed iterations (configurable)") vs L122/L125 (N=200 / 200×). C1
   executes 200 and therefore conforms to both texts; the spec authority should
   still record whether the table's N is normative (which would characterize
   the Round-1/Round-2 E1/E5 records as under-sized workloads) or the
   configurable floor governs. This ruling affects the retroactive
   characterization of earlier rounds, not future campaigns.

3. **U8 literal path vs preservation.** U8 designated clean `build/results/`;
   this campaign used `build/results-c1-20261023/` because `build/results/`
   holds preserved Round-2 evidence and the owner required a "fresh, clearly
   identified acceptance store". If a future campaign passes, the owner should
   designate the final store path explicitly (options: designate the named
   store as-is, or authorize a hash-verified bit-identical relocation after
   Round-2 evidence is archived under a renamed path).

4. **B9 metadata/comment (resolved by C1, recorded for the file).** The
   `"repeats":"200"` metadata is now truthful (200 timed repeats); L282
   comment cleaned. No further action.

Statuses: M0 = FAIL (G7, environmental); M1 = LOCKED; addendum unsigned.
