# C3 Acceptance-Machine Readiness Note — 2026-10-23

Purpose: define the shortest evidence-based route to a legitimate G7 result —
run the frozen acceptance protocol once, on a **designated dedicated machine**
(C3), instead of spending further campaigns on the shared container.

**Authorization status (up front):** C3 machine designation and any new
campaign are **NOT authorized**. Nothing in this note designates a machine,
changes any gate/threshold/evaluator, runs a campaign, or signs anything. The
exact approval text the owner needs to supply is in §9. M0 = FAIL, M1 = LOCKED,
addendum UNSIGNED. The exact physical cause of the shared-host instability is
**not proven** (class established: sustained throughput interference; source
H1 co-tenant vs host-internal remains open).

---

## 1. Verified state (2026-10-23, before this note)

| Item | Verified fact |
|---|---|
| PR #2 / branch | `arena/c90f7329-a-p-e-x`, PR #2 OPEN, head `79e58787d7782f7171204767c3cc6e30fe780bf1` == `git ls-remote` tip == local HEAD (recovered after sandbox re-clone; tree clean) |
| C1 store | `build/results-c1-20261023/` — 43 JSON records + weights blob, all tracked in git; `STORE_MANIFEST.sha256` **43/43 OK** (independently re-verified) |
| Round-2 store | `build/results/` — 43 JSON records tracked in git; manifest **43/43 OK**; G7 re-reproduces exactly: B7 tc=2 pairs 16.35 / 25.50 / 21.83% FAIL (worst 25.50% vs 15%) |
| C1 report accuracy | Independently recomputed from raw records (all-pairs symmetric deviation): B7 ST 4.02% / AC 2.85% **PASS** (was 16.4–25.5% at n=10) — C1 fixed its targets; B9 ST 0.69% / AC 5.42% PASS; B6 ST 0.67% PASS. Remaining failures confirmed: **B2 ST 38.10%** (52.9 vs 85.5 ms), **B3 ST 24.28%** (allowed 20), **B1 AC 17.23%** (3185 vs 2636 ms), **B6 AC 17.97%** (E5-P2 358.12 µs) |
| Verdict unchanged | G1–G6 PASS, G7 FAIL over the C1 store → M0 = FAIL; M1 = LOCKED; §K 5/5 (265 assertions); §M M1–M10 PASS; manual G8 PASS with U8 note |
| M0 acceptance criteria | U9: M0 FAIL→PASS iff rulings recorded + aggregator G1–G8 PASS over the designated store + five §K tests + §M audit pass, **all in one owner-signed acceptance record**. M1 unlocks only at M0 ACCEPTED |
| Environment facts (this host) | 2 logical CPUs, 4,034,452 kB MemTotal (= PROFILE 4,131,278,848 bytes byte-exact); three campaigns (Round-1, Round-2, C1) failed G7 on sustained state swings up to ±38% — above frozen ±15/±20% as a matter of course on this host |

Conclusion carried forward: the measurement path is fixed (C1, B7/B9); the
remaining variable is the host environment. Another campaign on this shared
host is not justified (luck-dependent pair results).

## 2. Minimum machine requirements (C3 designation)

Hard minimums (a machine that fails any of these cannot run the frozen
protocol at all):

- **CPU:** x86-64; ≥ 2 logical cores (single-thread + all-core variants);
  CPU-affinity pinning available (`taskset` on Linux; `start /affinity` or
  PowerShell pin on Windows).
- **Memory:** ≥ 4 GB RAM total (largest single benchmark working set is B3's
  ≥ 512 MB sweep; suite cap is ≤ 1.5 GB host RAM per benchmark).
- **OS:** Linux ≥ 5.x **or** Windows 10/11 with native MSVC (the tree builds
  as-is under MSVC; POSIX g++ needs the portability copy in §6.1).
- **Storage:** repo volume with ≥ 1 GB free; writable `build/` (each store is
  ~1.5 MB plus the 1.05 MB B7 blob).
- **Permissions:** write access to the repo; read access to cpufreq sysfs
  (Linux, for freeze records) or ability to query/set the Windows power plan;
  ability to set `performance` governor / High Performance plan (admin/root if
  policy requires).
- **Offline:** zero network access during the campaign (V009 ground rule 3).
- **Dedicated during the campaign:** no co-tenant workloads (the C1 evidence
  shows multi-second bandwidth-state shifts on a shared host exceed the frozen
  tolerances); laptop on AC power.

Operational preferences (environment-variance controls — NOT contract terms):

- **Homogeneous cores preferred.** Hybrid P/E topologies (e.g., i5-12450H)
  add a placement variable to the all-core variant; if a hybrid CPU is
  designated, record the topology in the freeze records and treat any G7
  deviation as environment-analyzed first (never a threshold change).
- **Build fixed as CPU-only** (`STARK_ENABLE_CUDA=OFF`), same as all prior
  approved evidence. G3 then takes its allowed skip branch
  ("Either branch passes", V009 L325) even if the machine has a GPU; GPU
  presence is still recorded in the profile. Evidencing the CUDA branch
  (E2/B4/B5 measured records, §L7-parameterized ladder) is a **separate scope
  decision** not covered by the §9 approval.
- GPU/CUDA is not required for the campaign.

## 3. Designation procedure and environment freeze

**Designation (owner action):** the owner names exactly one machine in writing
(hostname/asset + CPU model + OS), superseding the U1 designation (the Linux
Xeon container) for acceptance evidence only. All other U1–U10 rulings and the
E3 disposition-only ruling remain in force.

**Freeze (before any measurement):** record once into
`work/g7_c3_campaign_<date>/logs/` and keep with the evidence:

- `lscpu` (or `wmic cpu`), `uname -a` (or `ver`), `free -b` (or
  `Get-CimInstance Win32_OperatingSystem`), `nproc`
- power state: governor per CPU +
  `energy_performance_preference`/`no_turbo` (Linux) or active power-plan GUID
  (Windows) — recorded at freeze **and** again after the last invocation
- `boot_id` / uptime and loadavg at the start and end of each pass block
  (ST-P1, ST-P2, AC-P1, AC-P2)
- MemTotal byte-match: `/proc/meminfo` MemTotal × 1024 == PROFILE
  `ram_total_bytes` (as verified byte-exact on the container)
- toolchain (g++/MSVC version), build type, commit hash of the tree

Environment rules for the campaign window: governor = `performance`
(Windows: High Performance); turbo left as-is but recorded; no OS/toolchain
updates; no other interactive workloads; one continuous session if possible
(U6: distinct invocations are sufficient; sessions preferred).

## 4. Evidence separation — historical stores vs the new acceptance store

Historical evidence (preserved exactly as committed at `79e58787`, never
modified, never co-evaluated, never written to again):

- Round-1: `work/g7_acceptance_campaign_20261022/` + archive
- Round-2: `build/results/` + `work/g7_acceptance_campaign_round2_20261023/`
- C1: `build/results-c1-20261023/` + `work/g7_c1_campaign_20261023/`

**Store hygiene on the acceptance machine** (this is the U8 procedure; approved
via §9 item 3):

1. Fresh clone; checkout the approved commit; `git status` clean. Note that the
   checkout **populates `build/results/` with the historical Round-2 store**
   (tracked in git) — it is NOT clean as-is.
2. Hash-verify the checked-out `build/results/` against
   `work/g7_acceptance_campaign_round2_20261023/STORE_MANIFEST.sha256`
   (expect 43/43 OK), then move the directory **intact** to
   `build/historical_round2_store_20261023/` and re-verify the hashes after
   the move. Never delete; git history remains a second copy.
3. Create a fresh empty `build/results/` — the designated acceptance store
   (satisfies U8/G8 literal path). Alternative if the owner prefers it: name a
   dedicated store (e.g. `build/results-c3-<date>/`) in the approval text and
   accept the U8 literal-path nuance (as in the C1 round).
4. Never copy any historical record into the new store. `RecordStore::append`
   **overwrites same-id records**, and the fixed-id records
   (P1-PROFILE-24-0, P1-TELEMETRY-24-1, P1-E2-skip, P1-B4-skip, P1-B5-skip,
   P1-E4-notattempted, P1-E3-notattempted) must exist exactly once in the new
   store, produced fresh.
5. Sanity counts (also catch accidental inclusions): 7 records after the
   env-set block, 43 after the campaign; pre-run `ls build/results/` must be
   empty.

## 5. Operational stability preflight — DIAGNOSTIC ONLY

> **Label: operational go/no-go diagnostic. Not an acceptance requirement, not
> a gate, not a threshold. It cannot fail or pass acceptance; it only decides
> whether the environment is ready to spend the campaign run.** No number here
> enters G1–G8 or any frozen tolerance.

Run before the campaign (and once after, as a drift check), into a throwaway
store `build/preflight-probe/` marked DIAGNOSTIC-PREFLIGHT — never acceptance
evidence:

1. **Idle screen:** loadavg (1/5 min) < 0.5 × nproc; no other CPU-bound
   processes; governor/power-plan as frozen; AC power (laptops).
2. **Bandwidth micro-probe:** 6 × `run_baseline --baseline B3 --out
   build/preflight-probe --threads <N>` spread over ≥ 3 minutes (distinct
   probe ids — rebuild the probe store between rounds rather than reusing ids).
   Compute the all-pairs max deviation of the run medians:
   - worst pair ≤ 10% → **GO** (half the frozen B3 ±20% band, margin retained)
   - 10–20% → cool down 10 minutes, one re-probe; then GO if ≤ 10%
   - \> 20% after the re-probe, or any probe CV > 8% within a run → **NO-GO**;
     report to the owner instead of running. (The C1 failing windows had CV
     ≈ 8% with fully shifted distributions.)

The probe reuses the production binary but its store and numbers are
diagnostic noise checks only. Thresholds above are go/no-go screens chosen for
margin against the frozen ±15/±20%; they are deliberately **not** new
acceptance criteria and may be adjusted operationally without any ruling.

## 6. Exact campaign procedure (frozen protocol; reuse of approved commands)

Single acceptance campaign, identical contract to the approved rounds: both
variants (U2), external affinity + run-log attestation (U3(b)), E3
disposition-only (**never execute E3**), frozen gates and thresholds (±15% /
±20% B3/B5 — unchanged), normal + strict aggregate, §K five tests, §M audit,
manual G8 checklist (U5), one unsigned acceptance-record draft for the owner.

### 6.1 Build (CPU-only)

Per `work/g7_feasibility_pair_20261022/REPRODUCE.md` §1 (cmake not required):

- Library sources = `STARK_PHASE1_SOURCES` (`stark/CMakeLists.txt` L145–155);
  POSIX flags `-std=c++17 -O2 -DNDEBUG -include cstring -include
  sys/statvfs.h`; binaries: `profiler_cli`, `run_baseline`, `aggregate`, plus
  the five §K tests (`stark/tests/test_phase1_{profiler,accounting,budget,
  records,reproducibility}.cpp`).
- **POSIX portability copy:** the2026-10-22 shim
  `work/g7_feasibility_pair_20261022/build_shim/run_baseline_portable.cpp` is
  **stale** (predates the E3 disposition change and C1). Regenerate from the
  CURRENT `stark/src/phase1/baselines/run_baseline.cpp` at the campaign commit:
  apply the 7 mechanical `rb_` renames exactly as documented in
  `build_shim/PORTABILITY_DIFF.txt` (3 helper definitions + 4 call sites). On
  MSVC none of this is needed.
- Verify `run_baseline` contains `measurement_count = 200` (C1) and the
  `--disposition` flag before running.

### 6.2 Run (exact command sequence; `STORE=build/results`, `N=$(nproc)`)

```
# 0. Preflight §5 GO, then write PREREGISTRATION.md (predictions + uncertainty)
#    under work/g7_c3_campaign_<date>/ BEFORE any measurement.

# 1. Environment/attestation set — run exactly ONCE (7 records)
taskset -c 0 bin/profiler_cli --out $STORE
taskset -c 0 bin/run_baseline --baseline E2 --out $STORE
taskset -c 0 bin/run_baseline --baseline E4 --out $STORE
taskset -c 0 bin/run_baseline --baseline E3 --out $STORE --disposition

# 2. Single-thread PASS 1 and PASS 2 — IDENTICAL commands, this order
taskset -c 0 bin/run_baseline --baseline E1 --out $STORE --threads 1
taskset -c 0 bin/run_baseline --baseline E5 --out $STORE --threads 1
taskset -c 0 bin/run_baseline --baseline B1 --out $STORE --threads 1
taskset -c 0 bin/run_baseline --baseline B2 --out $STORE --threads 1
taskset -c 0 bin/run_baseline --baseline B3 --out $STORE --threads 1
# (repeat the five for PASS 2)

# 3. All-core PASS 1 and PASS 2 — IDENTICAL commands, this order
taskset -c 0,1,...,N-1 bin/run_baseline --baseline E1 --out $STORE --threads $N
taskset -c 0,1,...,N-1 bin/run_baseline --baseline E5 --out $STORE --threads $N
taskset -c 0,1,...,N-1 bin/run_baseline --baseline B1 --out $STORE --threads $N
taskset -c 0,1,...,N-1 bin/run_baseline --baseline B2 --out $STORE --threads $N
taskset -c 0,1,...,N-1 bin/run_baseline --baseline B3 --out $STORE --threads $N
# (repeat the five for PASS 2)
```

Windows equivalents use the same binaries/flags with native pinning. Every
invocation is logged with timestamp, exact command, affinity, exit code
(run-log attestation, U3(b)) — mirror `work/g7_c1_campaign_20261023/logs/
run_log.txt`. No count/config/protocol adjustments of any kind.

### 6.3 Verify (in order)

1. `bin/aggregate --out $STORE` and `bin/aggregate --out $STORE --strict` —
   record both outputs and exit codes (success = G1–G8 all PASS, exit 0).
2. §K five tests — all PASS (C1 baseline: 34/67/55/72/37 = 265 assertions).
3. §M audit M1–M10 against this campaign's evidence (standing properties).
4. Manual G8 checklist (U5): every executed benchmark/capture has a record;
   all parseable by the production reader; schema-valid; append-only integrity
   (record count never decreases; fixed ids written once); records at the
   designated store path.
5. `sha256sum -c` over the new store manifest; env snapshots complete.
6. Campaign report + **unsigned** acceptance-record draft for the owner.

## 7. Expected outputs, failure handling, preservation

**Expected outputs** (descriptive, not a prediction of success): 43 records
(2 PROFILE/TELEMETRY + 3 SKIPPED + 2 NOT_ATTEMPTED + 36 measured); aggregate
outputs (normal + strict); §K results; §M audit; G8 checklist; manifests;
env/freeze records; run log; preregistration; campaign report; unsigned
acceptance-record draft. The G7 outcome is **not** guaranteed by any prior
result.

**Failure handling:** if any gate fails — preserve everything (append-only;
manifests; no overwrites/deletes), analyze the raw samples against the
preregistered predictions **before** choosing any next step (owner
instruction), never clip outliers or selectively rerun, never change
thresholds/evaluator/protocol, and never describe a predicted PASS as
guaranteed. If G7 fails after the preflight was GO, the residual hypotheses
narrow to within-campaign environment drift or a host-internal source; C2
telemetry is used only if it would materially distinguish the remaining
hypotheses. If G7 and all gates PASS: verify §K/§M/G8, prepare the acceptance
record for the **owner's** signature (never fabricated); M0 flips only at
signature; M1 stays LOCKED until M0 ACCEPTED.

**Preservation:** the campaign evidence is committed and pushed to
`arena/c90f7329-a-p-e-x` under the §9 authorization (same evidence-publish
class as the prior rounds). Historical stores and reports remain untouched
exactly as listed in §4. PR #2 is never merged by this work.

## 8. Specification gaps — tracking (none closed here)

Canonical list: `work/C1_REMAINING_COMPLIANCE_GAPS_20261023.md`. Status
per issue; "blocks M0" is assessed against the U9 flip criteria only:

| Gap | Blocks formal M0 acceptance? | Authority | Minimum evidence / approval |
|---|---|---|---|
| **D3** — V009 §B L123 requires B7 "warm and cold cache"; implementation measures warm only (`mode:"warm_cache"`) | **No** mechanically — no gate tests the B7 mode, G7 re-runs the executed suite, and G8 records it truthfully. **Yes** for any claim of literal §B conformance | Project owner / spec authority | One written ruling recorded in the acceptance record: either (a) Phase-1 B7 = warm-cache only (annotate the row), or (b) cold-cache as a separate future mode/campaign (methodology addition — NOT part of the C3 campaign). Recommendation: (a) for Phase 1. Not resolved by this note |
| **Q6** — §B L111 "≥10 configurable" vs table N=200 (L122/L125) | **No** — the C1 code executes N=200 and conforms to both readings; future campaigns unaffected | Spec authority (reading), owner ratifies | One written sentence recording which text governs. Affects only retroactive characterization of Round-1/Round-2 E1/E5 records (under-sized workload vs conforming). Not resolved by this note |
| **U8** — literal `build/results/` vs preserved stores | **Yes**, unaddressed — a fresh checkout's `build/results/` is not clean (contains tracked Round-2 evidence), so G8's placement condition needs the §4 procedure or an explicit path designation | Project owner (spec authority if the literal reading is disputed) | Approval §9 item 3 (archive-relocation + clean `build/results/`), or an explicit named-store designation accepting the literal-path nuance. Not resolved by this note |

B9 metadata/comment: resolved by the authorized C1 change (recorded for the
file). No other gap is being self-resolved.

## 9. Requested owner authorization (exact text)

The C1 authorization does **not** cover machine designation or a new campaign.
The owner's approval, to be posted as a message (and referenced in the
acceptance record), is the following, with the machine identity filled in:

> **C3 authorization (owner, <date>):**
>
> 1. **Machine designation.** I designate the machine identified as
>    [hostname/asset: ____; CPU: ____; OS: ____] — which meets the minimum
>    requirements of `work/C3_READINESS_NOTE_20261023.md` §2 — as the single
>    M0 acceptance machine, superseding the U1 machine designation (the Linux
>    Xeon container) for acceptance evidence. All other U1–U10 rulings and the
>    E3 disposition-only ruling remain in force (U2 both variants; U3(b)
>    external affinity + run-log; U4 store composition; U5 manual G8; U6
>    distinct invocations; U7 production-evaluator arithmetic; U9 flip
>    criteria; U10 M1 scope). The campaign build is CPU-only
>    (`STARK_ENABLE_CUDA=OFF`), G3 evaluated on its allowed skip branch.
> 2. **Campaign.** I authorize exactly one fresh acceptance campaign on that
>    machine under the frozen protocol of
>    `work/C3_READINESS_NOTE_20261023.md` §6 (same code at the approved commit;
>    both variants; E3 disposition-only; frozen gates and thresholds; normal +
>    strict evaluation; five §K tests; §M audit; manual G8 checklist). Campaign
>    evidence (store, manifests, logs, report, unsigned acceptance-record
>    draft) is committed and pushed to `arena/c90f7329-a-p-e-x` and preserved
>    append-only. If any gate fails: analyze the raw evidence before any repeat;
>    no threshold, evaluator, or protocol changes.
> 3. **Current-machine evidence.** The approved current-machine evidence is the
>    full committed record on `arena/c90f7329-a-p-e-x` at `79e58787`: Round-1
>    `work/g7_acceptance_campaign_20261022/`, Round-2 `build/results/` +
>    `work/g7_acceptance_campaign_round2_20261023/`, C1
>    `build/results-c1-20261023/` + `work/g7_c1_campaign_20261023/`. It stays
>    committed and untouched — never deleted, overwritten, or co-evaluated with
>    the new store. On the acceptance machine, the checked-out historical
>    `build/results/` is hash-verified against the Round-2 STORE_MANIFEST and
>    moved intact to `build/historical_round2_store_20261023/` before the
>    campaign, which then writes to clean `build/results/` (U8 literal
>    designation). [Owner alternative: strike the last sentence and designate a
>    named store path here instead.]

No further approvals are requested: U2–U7, U9, U10, and the E3 ruling are
already valid; no threshold/evaluator/spec change is sought; §8 gap rulings
(D3/Q6) can be supplied at signature time and are not campaign prerequisites.

## 10. Single next action

**The owner supplies the §9 authorization** (filling in the machine identity).
That single act unblocks: environment freeze + preflight (§5, diagnostics) →
one frozen campaign (§6) → evaluation and records (§7). Until then: no machine
is designated, no campaign runs, M0 stays FAIL, M1 stays LOCKED. (C2 telemetry
remains an alternative first step if the owner prefers host-attribution before
moving machines; it is not required by this route.)
