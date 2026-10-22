# A.P.E.X — Acceptance-Scope Addendum (DRAFT for approval)

**Document status: RECORD OF DECISIONS — DOCUMENT UNSIGNED.**
Decisions for U1–U10 and E3 were provided by the project owner through the
authorized Q&A channel on **2026-10-22** and are recorded in §5. The rulings
originate from that channel, not from this document. **This document itself is
NOT a signed artifact** — the approval record in §5 is intentionally left
unsigned; signing it on PR #2 formalizes this record. Prior recommended
defaults in §4 are retained below as the proposals that were ruled on.

| | |
|---|---|
| Prepared | 2026-10-22 (Asia/Calcutta) |
| Prepared from | read-only acceptance-scope report (session of 2026-10-22) and the merged G7 feasibility evidence |
| Repository / base | `Rahulrr324/A.P.E.X` @ `main`; merged PR #1 (merge commit `563395f1ca7742ecb65bcef6134212f5bb66c3d8`, attested by GitHub API; not re-verifiable in the post-merge sandbox — see Limitations) |
| Evidence commits | `6d98b2e` (pair payload) → `e41247e` (evidence package) → `c32071e` (SHA-record) |
| Evidence package | `work/g7_feasibility_pair_20261022/` — `REPORT.md`, `SCOPE_REVIEW.md`, `MANIFEST.md` / `MANIFEST.sha256` (41/41 hashes OK), `REPRODUCE.md`, `PREREGISTRATION.md`, logs, `build_shim/`; store `build/results-g7pair-20261022/` (24 `STARKP1 1` records, 300 raw samples) |
| Scope of this addendum | Acceptance-scope decisions only. It changes **no** code, specification text, threshold, validator, historical record, gate status, or M0/M1 status. |

**How to use:** read §2 (three highlighted issues), then §4 (U1–U10), then
complete §5 (decision table: authorized ruling, approver, date, rationale).
§6 shows the execution plan that follows from whatever is approved.

**Legend.** **[FROZEN]** = existing, binding requirement quoted or cited from
frozen sources. **[PROPOSED]** = Arena's interpretation/recommendation; open
until approved. Frozen sources:
`stark/design/V009_phase1_M0_specification.md` (V009),
`stark/reports/M0_FINAL_ACCEPTANCE.md` (ACC), production code under
`stark/src/phase1/` (implementation behavior only — code is not authority for
what the spec requires, only for what the evaluator computes).

---

## 1. Verified basis (facts, not interpretations)

- V009 §G acceptance gates are exactly G1–G8 (V009 L322–329). G7 (L328):
  "Full re-run of the same suite with same config: every benchmark median within
  ±15% of the recorded median (memory bandwidth ±20%). … Tolerance is defined
  here once — later phases may not loosen it silently."
- Production evaluator `stark/src/phase1/gates.cpp` emits **G1–G7 only**
  (labels L477–773). `aggregate.cpp` header (L3–11) says "evaluates gates
  G1-G7". Exit 0 ⇔ all emitted gates pass (`aggregate.cpp` L88, L97–105).
  `G7_MEDIAN_TOLERANCE_PCT = 0.001` (gates.cpp L25) is the internal
  stored-vs-recomputed-median check only — NOT the G7 tolerance.
- G7 feasibility pair (single pre-registered campaign, Linux Xeon container,
  single-thread variant): aggregator **G1–G7 all PASS, exit 0** (plain and
  `--strict`); worst all-pairs median deviation **11.62%** (B9) vs 15%; B3
  bandwidth 16.942→16.654 GB/s = **−1.70%** vs 20%. This is feasibility
  evidence only; it is **not** M0 acceptance evidence under any completed
  ruling.
- ACC §7 (L175–186): decision rule; current state **`M0 = FAIL`, `M1 = LOCKED`**
  ("the single gating condition is G7 PASS on the current-machine acceptance
  evidence — see Q8"). ACC Q8 (L38–45) defines the concrete campaign
  condition (≥2 independent runs per same-config group; n≥10; ≥3 warmups;
  pinned/recorded affinity; zero tolerance changes; PROFILE + attested no-CUDA
  skips; aggregator G1–G8 PASS).
- Access limitation: post-merge, remote git access is blocked in this sandbox;
  merge commit `563395f1…` is attested by the GitHub API response recorded
  during the merge, not re-verified locally. All local evidence files and 41
  manifest hashes verify OK.

## 2. Three highlighted issues (read these first)

### H1 — The historical nine records (G7-C) can sink the acceptance campaign
The nine immutable historical records (`archive_recovery/original_historical_records/`,
copies under `aggregator_input/`, `original_build_results/`) fail G7 by
16.13–48.04% and are classified **G7-C: permanently failing** (ACC L31–37,
L128–131). ACC §3: "the historical nine are in scope **if they are in the
acceptance store** — and they fail permanently." Therefore:
- **If they are included in the evaluated acceptance store, G7 FAILS and M0
  cannot flip** — unless the owner issues an explicit scope redefinition (the
  tolerance itself may NOT be loosened: V009 L328).
- **They must not be silently excluded, deleted, overwritten, or "lost"** to
  make the evaluator pass. They remain preserved append-only evidence (V009
  §F L315) regardless of any ruling. The recommended U4 ruling (below) is an
  *explicit composition decision by the owner*, not a silent exclusion.
- Technical hazard if stores are merged: fixed record-ids collide
  (`P1-PROFILE-24-0`, `P1-TELEMETRY-24-1` exist in more than one store) and
  `RecordStore::append` removes+renames (`ExperimentRecord.cpp` L683–701) —
  naive file-copy assembly can overwrite records or collapse G7 groups
  (G7 dedups by `record_id`, gates.cpp L831–839).

### H2 — E3 contradiction inside the frozen specification
The frozen text contradicts itself and must be resolved by the specification
authority — it cannot be silently decided either way:
- V009 §E L284: "E3 INT8 inference … **CPU path always**"; L286: E5 =
  "E1–E3 forced to CPU-only build/run … **always**".
- V009 §8 L479–480: "**Do not implement E2/E3/E4** or any GPU benchmark unless
  CUDA is present; **record them as skipped/not_attempted otherwise**."
  (§I L363–364 also groups E3 with the optional-CUDA step.)
- Current evidence state: the feasibility package contains **no E3 record of
  any kind** (E2 and E4 carry disposition records; E3 does not). Under either
  reading, §8 L479–480 requires a disposition record ("record them as
  skipped/not_attempted otherwise"). Under the §E reading, the CPU INT8 path
  must also execute — note an executed E3 record carries `benchmark_id:"B6"`
  with the same configuration and **joins the B6 G7 group** (medians must then
  agree within ±15%).

### H3 — G8 has no production reporting/evaluation path
- Frozen G8 (V009 L329): ``build/results/`` contains a record "for every
  executed benchmark/baseline and every profiler capture, parseable by the
  same reader used in tests"; §K L406 maps G8 to `test_phase1_records.cpp`;
  §8 L483–484 exit criteria require "`aggregate.cpp` reports **G1–G8** pass".
- Production reality: `gates.cpp` emits G1–G7; **no G8 gate exists**; the
  aggregate can only evidence parseability (loadAll/validate/`--strict`). The
  §8 clause "aggregate reports G1–G8" is unmet **by the production code
  itself**.
- Consequence: G8 cannot be certified PASS today by the production evaluator
  alone. The evidence definition (manual inventory + `test_phase1_records`
  passing) is available; the *reporting path* is missing and needs either an
  accepted manual procedure or an authorized future code addition.

---

## 3. Scope of authority (what this document may and may not do)

**[FROZEN] May not change:** gate text or tolerances (V009 L328), validators,
historical evidence (§F L315), record schema semantics, test definitions,
M0/M1 status. **[PROPOSED]** items below are decisions *requested*; approving
them records a ruling, it does not edit frozen text. Where a ruling would
conflict with frozen text (e.g., loosening a tolerance), the frozen text wins
unless the specification authority issues a formal revision through its own
process.

---

## 4. The ten questions (U1–U10)

### U1 — Acceptance machine
- **[FROZEN] References:** V009 L111–113 (machine named only for workload
  sizing: "i5-12450H / RTX 2050"); G2 L323 ("second independent run **on the
  same machine**"); §8 L483–484 ("on this machine"); ACC Q5 L28–31 ("the
  frozen acceptance scope is **the current machine's** verification run");
  ACC Q8 L38–45 ("current-machine"). No frozen text designates a host, OS, or
  CPU for acceptance.
- **[PROPOSED] Recommended ruling:** accept **one machine declared in writing
  before the acceptance campaign**, with embedded `StaticHardwareProfile` and
  recorded environment, as the acceptance machine. The historical Windows/MSVC
  box is not required by any text.
- **If accepted:** the Linux Xeon container that produced the feasibility pair
  may be designated (single-thread G7 evidence reusable); or any one declared
  machine. One declaration closes the question for the whole campaign.
- **If rejected / unresolved:** acceptance evidence must come from a
  prescribed machine (the pair must be fully regenerated there), or every
  result remains scope-challengeable — M0 cannot flip defensibly.
- **Authority:** project owner (M0 acceptance authority). **M0 consequence:**
  gates the validity of all measurement evidence.

### U2 — Run configuration (single-thread and all-core)
- **[FROZEN] References:** V009 L111: "CPU thread count pinned
  (**single-thread AND all-core variants**)". Valid-run mechanics: §B
  (fixed workloads/seeds, ≥3 warmups, ≥10 timed iterations, mean/median/p95 +
  raw samples); `BenchmarkHarness.cpp` L27–33 (warmup≥3, meas≥10 enforced).
- **[PROPOSED] Recommended ruling:** **both variants are required** for
  acceptance (the AND is explicit). A valid run = same fixed workload/seed,
  ≥3 warmups, ≥10 timed samples, complete `STARKP1 1` record per §F, identical
  configuration block across the pair.
- **If accepted:** the acceptance campaign adds the all-core variant (two
  invocations per same-config group). The completed single-thread pair is
  reusable for its half if U1 accepts its machine.
- **If rejected / unresolved:** single-thread-only would contradict the only
  sentence defining thread scope (challengeable acceptance), or the campaign
  scope stays undefined (cannot execute defensibly).
- **Authority:** project owner. **M0 consequence:** defines campaign suite
  scope; missing variant = incomplete suite under §B.

### U3 — Affinity metadata (`configuration.affinity`)
- **[FROZEN] References:** V009 L302 (record schema lists `affinity` in
  `configuration`); ACC Q8 L40–41 ("pinned/**recorded** affinity"); §A
  no-fabrication rule. Implementation: `make_benchmark_record`
  (`BenchmarkHarness.cpp` L251–262) omits `affinity`; `ExperimentRecord::validate()`
  (L604–630) does not require it; **no gate reads it**;
  `apply_campaign_affinity` is called only by `G7Campaign.cpp` (L169/218/271);
  the pair was pinned externally (`taskset -c 0`, recorded in `logs/runs.log`).
- **[PROPOSED] Recommended ruling:** **conditionally acceptable.** Not fatal
  under the frozen gate mechanics (nothing enforces it). For acceptance runs,
  require either (a) in-record affinity provenance, or (b) the authority
  explicitly accepts documented external pinning + run-log attestation as
  "recorded". Rule (b) may be applied retroactively to the completed pair.
- **If accepted (a):** one authorized production change is needed before the
  acceptance campaign (the `run_baseline` path cannot emit affinity today),
  then the pair is re-run (records are append-only — cannot be retrofitted).
  **If accepted (b):** no regeneration; the ruling documents the gap.
- **If rejected / unresolved:** (a-path without the change) acceptance runs
  fail the methodology clause; unresolved = permanent scope challenge on every
  record.
- **Authority:** project owner. **M0 consequence:** methodology-compliance of
  acceptance records (not a G1–G8 gate item).

### U4 — Acceptance-store composition and the historical nine (see H1)
- **[FROZEN] References:** ACC §3 L128–131 ("G7 applies to same-configuration
  'recorded' medians **in the evaluated store**; … the historical nine are in
  scope **if they are in the acceptance store** — and they fail permanently
  (G7-C)"; new baseline "is a supplement, never a replacement"); ACC §7
  L183–186 (gating = "G7 PASS on the **current-machine** acceptance evidence");
  G8 L329 (store-oriented); ACC G8 audit Q6 (G8 evaluates "the current
  verification run's store").
- **[PROPOSED] Recommended ruling:** the acceptance store = the **declared
  acceptance machine's verification store only**. The historical nine remain
  preserved append-only (never deleted, overwritten, or altered), are evaluated
  as their own store where they remain G7-C FAIL, and are **not co-evaluated**
  with the new evidence. This is an explicit composition ruling recorded here —
  **not** a silent exclusion. If the owner instead rules the historical nine
  must be co-evaluated, then M0 = FAIL permanently unless the owner issues a
  formal G7 scope revision (tolerance loosening is forbidden: V009 L328).
- **If accepted:** the pair's G7 result stands; the campaign closes the other
  gaps only. Records must never be merged by naive copy (id-collision hazard,
  H1).
- **If rejected / unresolved:** with the nine in-store, G7 fails by
  construction and M0 cannot flip; unresolved leaves the single most decisive
  campaign question open — **do not run anything until this is ruled**.
- **Authority:** project owner, with specification-authority input on G7-C
  treatment. **M0 consequence:** determines pass/fail of the G7 gate itself.

### U5 — G8: acceptance requirements, authoritative evaluator (see H3)
- **[FROZEN] References:** G8 L329; §K L406 (`test_phase1_records.cpp` —
  round-trip bit-exactness, schema enforcement, append-only rejection); §8
  L483–484 (tests + §M audit + "`aggregate.cpp` reports G1–G8 pass"); ACC
  L55–100 (G8 audit: PASS = every represented execution present as parseable,
  schema-valid `STARKP1 1` by the same reader + append-only integrity; FAIL
  conditions as listed there).
- **[PROPOSED] Recommended ruling:** G8 PASS evidence = (1) reader-validity
  over the designated store (`aggregate` plain + `--strict`, 0 invalid),
  (2) `test_phase1_records` passing output (plus the full §K suite + §M audit
  per §8), (3) a signed executed-output inventory. Accept a **manual G8
  checklist** for this acceptance round, and schedule the missing production
  G8 reporting (§8 expects aggregate to report G1–G8) as future authorized
  work — a code addition, not a threshold change.
- **If accepted:** G8 becomes certifiable without a code change this round.
- **If rejected / unresolved:** if the owner requires production-reported G8
  (literal §8 reading), an authorized evaluator addition must precede the
  campaign; unresolved = G8 stays UNDETERMINED and **M0 cannot flip**.
- **Authority:** specification authority (meaning of G8 + status of the §8
  aggregate clause) with project owner accepting the procedure.
  **M0 consequence:** G8 is one of the eight gates; it currently cannot be
  marked PASS by the evaluator alone.

### U6 — Independence of runs
- **[FROZEN] References:** G2 L323 ("second independent run on the same
  machine"); ACC Q8 L39 ("≥2 independent runs per same-config group"); gates.cpp
  L831–839 (mechanical definition: distinct `record_id` executions; "two
  records sharing a record_id are the same execution and do not constitute an
  independent repeat"). No frozen text defines session/day/build independence.
- **[PROPOSED] Recommended ruling:** distinct process invocations of the same
  build in the declared environment satisfy "independent"; **separate sessions
  preferred but not required**. (Stricter alternative: require ≥2 sessions.)
- **If accepted:** the completed pair (2 invocations, one session) satisfies the
  clause.
- **If rejected (sessions required) / unresolved:** +1 execution round
  (second-session pair) or every result stays challengeable on independence
  grounds.
- **Authority:** project owner. **M0 consequence:** counts of qualifying
  records per G7 group.

### U7 — B3/B5 tolerance semantics
- **[FROZEN] References:** G7 L328 ("within ±15% of the recorded median
  (memory bandwidth ±20%)"); B-suite L118–122 (B3 →
  `measured_memory_bandwidth_gbps`; B5 → PCIe transfer bandwidth); frozen
  implementation `gates.cpp` L863–864 (`allowed = bandwidth ? 20.0 : 15.0` for
  `bench ∈ {B3,B5}`) with `symmetric_rel_diff_pct` (L33–43) on **time
  medians**, all-pairs. Divergences (facts): spec wording implies
  recorded-referenced `|new−rec|/rec` while the evaluator uses symmetric
  `|a−b|/max`; the ±20% names "memory bandwidth" (a derived quantity) while
  the evaluator gates the timed median; B5 receives 20% though only "memory
  bandwidth" is named. The paired-sample statistic exists only in the B7
  diagnostic — it is **not** a production gate and its 2%/10%/2% thresholds are
  **not** acceptance thresholds.
- **[PROPOSED] Recommended ruling:** the **production evaluator's calculation
  is the operative acceptance criterion** (frozen; "tolerance is defined here
  once"). The specification authority **annotates** the three divergences
  (annotation only — thresholds and formulas unchanged); the acceptance report
  additionally presents the recorded-referenced deviation as a secondary
  column for transparency.
- **If accepted:** the criterion is unambiguous; the pair passes under both
  forms (worst 11.62%).
- **If rejected / unresolved:** boundary cases can be argued either way in
  future campaigns; unresolved = evaluator/spec mismatch remains a standing
  challenge vector.
- **Authority:** specification authority (annotation). **M0 consequence:**
  defines the pass/fail arithmetic of the blocking gate.

### U8 — Evidence location and composition
- **[FROZEN] References:** G8 L329 literal ``build/results/``; §8 L477 ("Write
  every output as `STARKP1 1` JSON into `build/results/`"); §J L382 (CLI
  default `--out build/results/`). Current package lives at
  `build/results-g7pair-20261022/` (pre-registered: the default store holds
  colliding fixed-id records and B7 truncates its input blob inside the store
  dir — running there would have overwritten historical artifacts).
- **[PROPOSED] Recommended ruling:** the literal path binds **for the final
  acceptance store**: the acceptance campaign writes to a designated, clean
  `build/results/`. The committed package remains valid archived evidence
  (manifest + hashes) independent of path. If the designated store must
  contain records whose ids already exist elsewhere, those records are
  re-produced (never copied over one another).
- **If accepted:** one path designation for the campaign; archive package
  unchanged.
- **If rejected / unresolved:** if the owner rules the clause
  directory-agnostic (the evaluator takes `--out`), the package suffices as-is;
  unresolved = G8 location condition unevidenced.
- **Authority:** project owner (specification authority if the literal reading
  is disputed). **M0 consequence:** G8 placement condition.

### U9 — M0/M1 relationship and flip criteria
- **[FROZEN] References:** ACC §7 L175–186 (decision rule: every mandatory
  requirement satisfied → ACCEPTED; ≥1 definitively unsatisfied → FAIL;
  indeterminate → BLOCKED; `M0 = FAIL`, `M1 = LOCKED`; "the single gating
  condition is G7 PASS on the current-machine acceptance evidence — see Q8");
  ACC Q8 L38–45 (concrete campaign condition); V009 §L.6 L432–433 (acceptance
  tests = G1–G8 + §K files); §8 L483–484 (tests + §M + aggregate G1–G8).
  **Gap:** M0/M1 milestone *scopes* are not defined in the design corpus
  (V009's "M1" at L495 is an unrelated §M audit row); the milestone contract
  lives in ACC + project process.
- **[PROPOSED] Recommended ruling:** **M0 FAIL→PASS iff** U1–U8 are ruled **and**
  the acceptance campaign under those rulings yields aggregator G1–G8 PASS over
  the designated store (G8 per U5's evidence definition) **and** the five §K
  tests + §M audit checks pass, all recorded in one signed acceptance record.
  **M1 unlocks automatically at M0 ACCEPTED**, and the owner states M1's
  deliverable scope at the same time (unblocking into an undefined scope is not
  a meaningful unlock).
- **If accepted:** the finish line is written down; no further interpretation
  is needed at evaluation time.
- **If rejected / unresolved:** each future acceptance can be re-litigated from
  scratch; M1 has no defined content to unlock into.
- **Authority:** project owner (with specification authority for the §L/§8
  readings). **M0 consequence:** defines the exact flip condition for M0 and
  M1.

### U10 — M1 deliverable scope
- **[FROZEN] References:** ACC §7 L183–186 ("M1 = LOCKED (cannot unlock until
  M0 is accepted …)"); no frozen document defines M1's deliverables.
- **[PROPOSED] Recommended ruling:** the owner defines M1's scope in the same
  approval record (one paragraph is sufficient), e.g., the phase-2
  architecture-selection boundary work consuming
  `ArchitectureCandidateEvaluation` (V009 §H) — or whatever the owner
  intends. Definition only; no work starts before unlock.
- **If accepted:** M1 unlock becomes meaningful.
- **If rejected / unresolved:** M1 can be "unlocked" into nothing definable;
  process ambiguity persists.
- **Authority:** project owner. **M0 consequence:** none directly (post-M0);
  **M1 consequence:** gating.

> **M0-impact summary:** U4 is decisive by itself (can force permanent FAIL);
> U1, U2, U5, U8 are required for a defensible PASS; U3, U6, U7, U9 remove
> standing challenge vectors; U10 is post-M0.

---

## 5. Decision and approval table (to be completed by the approver)

Instructions: for each row, mark the authorized ruling (Accept / Reject /
Modify — describe), enter approver name, date, and rationale. Unmarked rows =
unresolved; per §4, unresolved rows block a defensible M0 flip where noted.

| ID | Question (short) | Authorized ruling (Accept / Reject / Modify) | Approver | Date | Rationale |
|---|---|---|---|---|---|
| U1 | Acceptance machine = one pre-declared machine | **Accept** — declare the Linux Xeon container (current sandbox host; PROFILE `P1-PROFILE-24-0`) as the single acceptance machine | Project owner (authorized Q&A channel) | 2026-10-22 | One declared machine closes the scope; the feasibility evidence produced there is reusable |
| U2 | Both thread variants required; valid-run definition | **Accept** — both variants required (single-thread AND all-core) | Project owner (authorized Q&A channel) | 2026-10-22 | Matches V009 L111 "single-thread AND all-core variants"; valid run per §B/§F mechanics |
| U3 | Affinity: conditional (in-record OR accepted external+log) | **Accept option (b)** — external CPU pinning + run-log attestation counts as "recorded" | Project owner (authorized Q&A channel) | 2026-10-22 | No gate enforces the schema field; avoids an unauthorized production change and pair re-run; gap documented |
| U4 | Store = declared machine's verification store; nine preserved, not co-evaluated (or alternative) | **Accept** — current-machine acceptance store only; historical nine preserved append-only, evaluated separately as G7-C FAIL; never co-evaluated, never silently excluded | Project owner (authorized Q&A channel) | 2026-10-22 | Co-evaluation fails G7 permanently (ACC §3 L128–131); explicit composition decision; preservation obligation intact |
| U5 | G8 evidence = reader-validity + test_phase1_records + inventory; manual checklist now | **Accept** — manual G8 checklist + `test_phase1_records` this round; production G8 reporting deferred to future authorized work | Project owner (authorized Q&A channel) | 2026-10-22 | Certifiable without a code change now; §8 L483–484 aggregate G1–G8 clause noted as a known gap |
| U6 | Independence = distinct invocations (sessions preferred) | **Accept** — distinct process invocations constitute independent runs; sessions preferred, not required | Project owner (authorized Q&A channel) | 2026-10-22 | Matches the mechanical definition (gates.cpp L831–839); the completed pair qualifies |
| U7 | Operative arithmetic = production evaluator; annotate divergences | **Accept** — frozen production-evaluator arithmetic operative; annotate the three divergences; report secondary recorded-referenced column | Project owner (authorized Q&A channel) | 2026-10-22 | Tolerance frozen (V009 L328); annotation resolves the mismatch without change |
| U8 | Acceptance store at designated `build/results/`; archive package stands | **Accept** — designated clean `build/results/` is the final acceptance store; committed package remains archived evidence | Project owner (authorized Q&A channel) | 2026-10-22 | Literal G8 (L329) / §8 (L477) text |
| U9 | M0 flip criteria + M1 auto-unlock definition | **Accept** — M0 FAIL→PASS iff all rulings recorded + aggregator G1–G8 PASS over the designated store + §K/§M pass + one signed acceptance record; M1 unlocks at M0 ACCEPTED | Project owner (authorized Q&A channel) | 2026-10-22 | Writes the finish line down; aligns with ACC §7 |
| U10 | M1 deliverable scope statement | **Accept** — M1 = Phase-2 architecture-selection boundary work (consumers of `ArchitectureCandidateEvaluation`, V009 §H); no architecture choice inside M1 | Project owner (authorized Q&A channel) | 2026-10-22 | Gives M1 defined content at unlock |
| E3 (H2) | E3 contradiction: execute vs disposition | **Accept disposition-only** — do NOT execute E3; produce a `not_attempted` disposition record (§8 L479–480) | Project owner (authorized Q&A channel) | 2026-10-22 | Resolves the §E L284 / §8 L479 contradiction conservatively; no new G7-group member; matches "record them as skipped/not_attempted otherwise" |

**Record of decision source (added 2026-10-22):** the rulings in the table
above were provided by the project owner through the authorized Q&A channel on
2026-10-22 (ten scope decisions U1–U10 plus the E3 disposition ruling). This
document is prepared as the written record of those rulings. The decisions do
**not** originate from this document, and filling this document does not
constitute a signature.

**Approval record (formalization of THIS document — intentionally unsigned):**
- This addendum record is accepted as the written form of the rulings above:
  ☐ yes / ☐ no / ☐ with modifications (attach).
- Approver (project owner / specification authority): ______________________
- Date: ______________
- Signature / reference to written approval (issue, doc id): __________________

**Formal signature status: NOT SIGNED.** The lines above are intentionally
blank. Until the project owner signs (or an equivalent written approval is
attached to PR #2), cite the authorized Q&A record of 2026-10-22 as the ruling
source and this document as its prepared record. No gate status, M0 status, or
M1 status changes by virtue of this document existing.

## 6. Minimum execution plan (conditional on approved decisions)

**Before any execution (mandatory):** completed §5 decision table. Nothing runs
while U4 (store composition) is unresolved.

**Reuse as-is (no re-measurement)** if U1 accepts the container machine, U4
accepts the current-machine store, U3(b), U6 distinct-invocation:
`P1-PROFILE-24-0` + `P1-TELEMETRY-24-1`, E2/B4/B5 skip attestations, E4
disposition, and the **single-thread G7 pair** (both passes; G1–G7 PASS,
worst 11.62%). Evidence archive `work/g7_feasibility_pair_20261022/` stands.

**Minimum new execution (estimated 2–3 rounds, minutes each):**
1. All-core variant pair (U2): two invocations × {E1, E5, B1, B2, B3}, same
   protocol, all-core thread configuration. *(Confirmed requirement under the
   recommended U2.)*
2. E3: disposition record **always** (H2); E3 execution pair **only if** U3→H2
   ruling says "CPU path always" (its record joins the B6 group — pre-registered
   risk noted).
3. Test/audit round (**no benchmarks**): five §K tests (esp.
   `test_phase1_records`, `test_phase1_reproducibility`) + §M audit checks;
   `aggregate` plain + `--strict` over the designated store; signed G8
   checklist + executed-output inventory.

**Contingent rounds (+1 each, named triggers only):** second-session pair if
U6 requires sessions; full regeneration on a prescribed machine if U1
requires it; affinity-authoritative re-pass if U3(a) is chosen (after one
authorized production change); re-pass for any pre-registered group failure
(stopping rule: report, one documented repeat maximum).

**Estimated total: 2–3 rounds** under recommended rulings (floor 2; 3 if E3
executes); **up to 5** with machine change + second session + contingency.
Rounds beyond the first three are estimates, not confirmed requirements.

**Evaluated by:** production `aggregate` (G1–G7), §K suite + §M checks, G8
evidence definition (U5). **No threshold, validator, gate, or spec change** is
part of this plan.

## 7. M0/M1 gate conditions (reminder, unchanged by this draft)

- **M0 FAIL → PASS:** signed §5 rulings → campaign executed under them →
  aggregator G1–G8 PASS over the designated store → §K + §M pass → one signed
  acceptance record (ACC §7 L175–181 decision rule).
- **M1 LOCKED → unlocked:** automatically at M0 ACCEPTED (ACC L183–186), plus
  U10 scope statement.
- **Current status (unchanged): `M0 = FAIL`, `M1 = LOCKED`.** The G7
  feasibility pair is evidence that G7 is reachable — it is not acceptance
  evidence until the above completes.

---

*End of record. Prepared read-only: no code, specification, threshold,
validator, historical record, gate status, or M0/M1 status was changed in
producing this document. Decisions recorded 2026-10-22 (authorized Q&A
channel, project owner). Document NOT signed — see §5.*
