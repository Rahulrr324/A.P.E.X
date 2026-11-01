# Bounded benchmarks

## Model-endpoint benchmark (live, opt-in)

`run-model-benchmark.mjs` measures the ordinary APEX path (controller, gateway, audit,
conversation write) against one configured endpoint. It sends no request unless
`APEX_BENCH_LIVE=1` is set; otherwise it prints the plan. APEX does not install,
download, start, or recommend a model server: running this script is a decision to send
requests to an endpoint **you** have configured, so it is off by default.

### Procedure

1. Point the settings at an endpoint that already exists and already serves the model you
   name. The harness never starts a server, downloads a model, or changes a default.
2. Use a fresh temporary APEX data directory. The harness creates one under the OS temp
   folder, gives every sample its own store, and removes it unless `--keep` is passed.
3. Fix the prompt and settings before running. The harness supports four non-sensitive
   prompts (`factual`, `summary`, `arithmetic`, `concise`) and at most four requests per
   run: sample 1 is the cold-planned request, samples 2-4 are warm-planned.
4. Record a readiness check separately; it lists models and runs no inference.

```bash
cd apex_app
APEX_BENCH_LIVE=1 APEX_MODEL_PROVIDER=ollama APEX_MODEL_URL=http://127.0.0.1:11434 \
APEX_MODEL_NAME=<model-that-endpoint-serves> APEX_MODEL_TIMEOUT_MS=300000 APEX_MODEL_MAX_TOKENS=1200 \
APEX_MODEL_RETRIES=0 node benchmarks/run-model-benchmark.mjs --requests 4 --out /tmp/bench.json
```

The values above are the settings one dated run used; the URLs are examples of an
operator-configured endpoint, not a recommendation to run one.

## What it reports

- readiness/listing time (no inference);
- wall time per request through the application path;
- generated tokens and throughput only when the backend reports both;
- result classification: success, truncated, empty response, timeout, provider error;
- verification status, proposal count, and executed-step count.

Time to first token is reported as unavailable: the gateway uses non-streaming
transport and receives the whole answer at once.

## Interpretation limits

- Cold/warm is defined by request order, not by a measured model load.
- A few samples describe one machine at one time. They are observations, not a
  statistically reliable benchmark, and they do not transfer to other hardware.
- Model text is never verified by APEX; `verification_unavailable` is the correct
  outcome for a model answer.

This script is not part of `npm test` and no test depends on a model endpoint existing.

## World-state projection benchmark

`run-world-state-benchmark.mjs` measures the read path of the epistemic world-state
projection (`src/world/world-state.js`) against synthetic fixtures. It contacts no model,
starts no service, downloads nothing, and needs no configuration: it builds a fresh
temporary APEX data directory, fills it, and then times APEX's own reads.

### Procedure

```bash
cd apex_app
node benchmarks/run-world-state-benchmark.mjs --memory 2000 --claims 2000 --repeats 7
```

1. The fixture sizes are capped on purpose: `--memory` is 1-40000, `--claims` is 1-2000,
   `--repeats` is 1-25. Claims stay small because each one is appended through the store,
   which re-reads the whole store first; the seeding line reports that cost.
2. Memory records are written directly as valid JSONL lines so that seeding does not
   dominate the run; claims are appended through `KnowledgeStore.add`, because that is
   the only path that produces a well-formed claim. Seeding time is therefore reported
   separately from read time.
3. `--keep` leaves the temporary directory in place for inspection; otherwise it is
   removed. Nothing outside the OS temp folder is written.

### What it reports

- four reads of the same unchanged stores, so the cost of each part of the optimization is
  visible separately rather than asserted: the first read in a process that has derived
  nothing, the same read again once the derived snapshot exists, the same read with the
  snapshot switched off (one authoritative read per store), and the pre-optimization read
  pattern (two whole-store loads per store, no snapshot). The last two are compared to each
  other and to the warm read, and the projection the old pattern returns is compared
  record-for-record with the one the current code returns;
- one store read on its own, cached against uncached, because the snapshot's benefit is
  per store and a merged read's benefit is per projection;
- store-wide health scan time, render time, and up to seven full `execute` + independent
  `verify` passes through the action layer, reported separately and counted, so an
  optimization cannot quietly delete the verifying read to look fast;
- the write phases twice, once with the snapshot enabled and once with it disabled, and the
  median difference per operation: `add()` on memory, `add()` on knowledge, and the read
  after a memory append. A derived performance aid that slows the authoritative path shows
  up here as a positive number;
- the derived snapshot's own state at the end of the run (enabled, cap, cached bytes,
  cached records, cumulative hits and misses). It is a performance aid and the run says so
  in its label; nothing reads it to decide whether data exists;
- what the projection actually derived: represented beliefs out of stored records, beliefs
  shown, memory conflict groups, largest group, whether the projection is complete and
  whether it asks for attention;
- process RSS and heap before and after, and the byte length of every store file before and
  after the unchanged-store reads, reported as "writes during N reads: none (every store
  file is byte-identical)" only when each one is unchanged;
- the conditions of the run: Node version, platform and architecture, logical CPU count,
  reported total memory, fixture sizes and their write cost, and a closing statement of
  what the run cannot prove.

### Write-path mode (`--writes`)

```bash
cd apex_app
node benchmarks/run-world-state-benchmark.mjs --writes --repeats 7
```

Read mode times the projection; `--writes` times the store's own write path, because Batch V
changed that and a read benchmark cannot see it. The sizes are a fixed matrix (memory
200 / 2,000 / 20,000 / 40,000 records, knowledge 200 / 2,000 claims) so that two runs are
comparable, and each measurement is a median over `--repeats` samples, every sample taken on a
fresh copy of the same fixture so the store under measurement always holds the same bytes.

- **The parts of one append**, per size: reading the file, reading and hashing it, reading and
  parsing it without integrity checks, the whole-store validated read a write used to perform,
  the write read a freshly constructed instance performs now, the incremental validated read a
  warm instance performs, the append on its own, the whole write on a fresh instance ("cold
  write") and the next write on an instance that has already written once ("warm write"). Two
  derived lines come from those columns: the integrity work a validated read does beyond
  parsing, and the retention cost of a cold write read (what building the incremental state
  costs on the first write of an instance, measured against the read that replaced it).
- **The operations that read derived state** on the same fixtures: a conflicting memory `add()`,
  a `correct()` replacement, ranked `search()`, a bounded `list()`, a `health()` scan and a
  `projectionRead()`; for knowledge a conflicting claim, a supersession, a retraction and a
  resolution. Each constructs its own store instance, so each is a cold-instance number.
  `search()` scores every record against every query term, so it is timed at 2,000 records only
  and the omission is printed rather than hidden.
- **Cumulative append workloads**: a seeded store, then 100 or 1,000 ordinary writes through one
  held store instance, which is what a continuous session does. Each workload runs twice on one
  seed: "incremental" with the derived state enabled, "revalidate" with `parseCacheBytes: 0` so
  every write read parses and validates the whole store again - what a write cost before Batch V.
  Same fixture bytes, same machine, same page-cache state, so the ratio is a measurement and not
  a comparison with a recorded number. Per-append medians over the first, middle and last ten
  writes show the remaining growth, and the reuse provenance is printed beside the totals.
- **Store-layer work inside one call**: one public write timed as a whole, with its write read and
  its append timed inside that same call, so the difference is one number from one sample rather
  than three medians subtracted across distributions. That difference is the conflict scan, the
  lifecycle rebuild, the record construction and the integrity checks - everything an incremental
  conflict or lifecycle index could still remove, which is why it is V-06's evidence.
- **The refusal a damaged store forces**: a write onto a store whose last line is unterminated,
  timed, with the exact reported reason and whether the refused write left any bytes behind.
- **Composition and footprint**: the cold/warm/reuse decomposition for the largest fixture per
  store, and RSS and heap at the end of the run.

### Coordination mode (`--lock`)

```bash
cd apex_app
node benchmarks/run-world-state-benchmark.mjs --lock --repeats 7
```

`--writes` and `--lock` measure different paths and refuse to run in one invocation, so neither shares
a process with the other. `--lock` times the coordination Batch W added, on a fixed matrix (memory and
knowledge at 200 and 2,000 records, with 1, 2 and 4 concurrent writers), in five phases:

- **Uncontended section, and a whole write under it**: one warm store instance per sample, timing
  `store.writeLock.run(async () => {})` against the store's own public write on that same instance,
  and printing the section as a share of that write plus whether the claim left any residue. The empty
  section is coordination alone: on this platform it is about six NTFS metadata operations - the
  directory preparation, the staged body, the publishing link, the staged unlink, the ownership read at
  release and the claim unlink. The design cannot give any of them up without weakening a guarantee:
  the claim must never exist without its bytes, and it must never be removed by a process that cannot
  prove it wrote them.
- **Contended writes from real processes**: 1, 2 or 4 separate child processes on a fresh copy of the
  fixture, released from one start barrier, each making the same number of append attempts and
  reporting each attempt's own duration from inside itself. Per configuration the run prints wall time,
  accepted attempts out of sent, records appended, distinct record ids in the store afterwards, the
  median/min/max of the attempts, throughput, the refusals the writers printed, their exit codes,
  corrupt lines and coordination residue. `--writes` cannot produce this table from one process: the
  claim file *is* the mechanism, so an in-process promise race would measure the event loop instead of
  the lock.
- **Lock hold and lock wait**: a holder process that keeps the section for a declared time - doing no
  store work in it - while a contender process tries to write. Short budgets (250 ms, 1,000 ms, and the
  configured default with `--full`) are timed against holders that outlast them, and each refusal
  reports its measured wait against its budget, the exact reason string, whether the store's bytes
  changed, whether the claim was still held when the contender gave up, and what residue remained after
  the holder exited. Longer holds report the contender's wait and how many records are on disk
  afterwards.
- **The refusal a damaged store forces under coordination**: a write onto a store whose last line is
  unterminated, timed, with its error code, whether the authoritative read really ran while the claim
  was held, whether the store stayed byte-identical, and whether the claim was released on the refusal
  path.
- **Incremental state after another process wrote underneath**: one held instance writes once, two real
  processes write while it is idle, and the instance then writes again. The run reports what that last
  write's own read saw and whether the claim was held during it, the derived-state counters before and
  after, whether the retained records equal a fresh replay of the file, and the residue.

### Interpretation limits

- Fixtures are uniform synthetic text in a one-clause-subject shape, which is the worst
  case for the memory conflict scan; a real store with varied records reads faster.
- A cold read and the read that follows a write still parse and validate the whole store, so
  read cost is **not** independent of total store size. Only a repeat read of bytes that
  have not changed is cheaper, and it is cheaper by skipping parsing, not I/O.
- Claim seeding in read mode is quadratic in the number of claims and is reported as a write cost, not
  a read cost. It is a property of the store's deliberate whole-store conflict check, not of
  the projection, and no read-side optimization changes it. It also runs against a store constructed
  with `parseCacheBytes: 0`, which switches off the incremental write state as well as the read
  snapshot, so this figure is deliberately the pre-Batch-V cost: `--writes` measures the same kind of
  workload with the state enabled and disabled in one run.
- Figures recorded in the main README before Batch U were measured with the two-loads-per-store
  pattern and may include unrelated system load. Every run now re-creates that pattern in
  the same process against the same fixture, so prefer the in-run comparison.
- One repeat counts one process. Timing noise from the operating system is not separated
  out, so treat the median as an indication, not a specification. Differences of a few
  milliseconds, including negative ones in the write-overhead lines, are noise.
- `--writes` runs with no concurrent writer and no model, in a temporary local directory. The
  fixtures are far larger than a personal APEX install, so absolute medians move with system
  load while the composition does not; read the ratios and the in-call decomposition, not a
  single millisecond figure.
- Every write measurement still reads and hashes the whole store, so a write is not constant
  time and no number here should be read as claiming that. What the incremental state removes
  is the parse-and-validate pass, and the run reports the pass it removes next to the pass that
  remains.
- A freshly constructed instance pays the whole-store derivation the incremental state exists to
  avoid, so the "cold write" column can be slower than the pre-Batch-V write it replaced: that
  is the retention cost line, and it is the honest price of the reuse. A one-command-per-process
  CLI pays the cold number; a session that writes repeatedly pays the warm one.
- `--lock` measures races, and a race cannot be timed without starting processes. Every wall figure
  includes Node start-up for each child (several hundred milliseconds on this machine), while the
  attempt columns come from inside each writer and exclude it; the run prints both and never
  subtracts one from the other.
- The hold lines use second-scale holds on purpose. A contender's own start-up is a few hundred
  milliseconds, so a 200 ms hold would end before the contender began and the measured wait would be
  zero - which would be a false statement about the lock, not a small one.
- A wait budget is a floor, not a promise: the last poll can overshoot it by one retry interval, and a
  release is noticed only at polling granularity, so a contender can finish up to 250 ms before a
  declared hold ends. Both directions are printed as they are measured.
- Attributed waits (the difference from the 1-writer median) can come out negative. NTFS metadata
  operations are the bulk of a coordinated write at these sizes and their cost moves with whatever
  else the machine is doing, so a negative line is noise, not a saving from contention.
- One race per configuration per run, on one machine, with no model and no network. The contended
  figures describe this machine at this moment; compare the 1-, 2- and 4-writer medians within a run
  and never across runs.
- The same caution applies to a wait measured while anything else is running. In a full-suite run on
  this 12-CPU machine, ten writer children plus 57 other test files competed for the same disk, and one
  ordinary coordinated write waited 10,553 ms against the 10,000 ms budget and was refused with `LOCKED`
  while its nine peers were all still writing normally. That is the protocol behaving as designed - a
  refusal, nothing written, no data lost - but it says the default budget is not a throughput guarantee,
  and a writer's measured wait on a loaded machine can exceed every figure in this file.
- The pre-Batch-W comparison is a separate `--writes` run against a copy of the tree taken from
  `HEAD` before coordination. It is a separate run because the store has no lock-free mode to switch
  to, and a benchmark-only bypass would not be the code that ships.

## Experience, feedback and adaptation benchmark

`run-experience-benchmark.mjs` measures the experience store (`src/experience/experience-store.js`)
and the context its approved rules add. It contacts no model, starts no service and downloads
nothing: every application it times is built with `NoBackend`, so the request path stops at
`model_unavailable` and what is measured is APEX's own work. It needs no configuration; it builds a
fresh temporary APEX data directory per fixture, fills it through the real paths, and removes it
unless `--keep` is passed.

### Procedure

```bash
cd apex_app
node benchmarks/run-experience-benchmark.mjs --experiences 400 --repeats 7
node benchmarks/run-experience-benchmark.mjs --experiences 20 --repeats 3 --phase reads
```

1. `--experiences` is 1-2000 (a comma-separated list makes a size matrix, default `20,100,400`) and
   `--repeats` is 1-25 (default 5). `--phase` selects one of `reads`, `writes`, `capture`, `context`,
   `compare`, `finalize`, `temporal`; without it all seven run in that order. A run that selects only
   `temporal` does not seed the fixtures the other phases share, because the temporal phase builds its
   own.
2. A fixture is `N` audited events, each produced the way the application produces one (a verified
   request through the controller), then one recorded experience and one corrective feedback record
   per event, one derivation, and three approvals. Seeding time is reported separately from every
   measurement.
3. Only the first 16 feedback records of a fixture carry guidance text, because one adaptation may
   cite at most 20 evidence records and a larger group is skipped rather than truncated. Restating
   one preference across a 400-experience store would therefore leave the store with no rules in it
   and nothing to measure; the rest of the feedback still records the user's assessment.
4. Every write sample runs against a fresh copy of its fixture, so each repeat measures the same
   bytes. Nothing outside the OS temp folder is written.

### What it reports

- **reads**: one read split into its parts at each size - cold (a process that has read nothing) and
  warm, the load alone, the derived-lifecycle recomputation alone, a bounded `list()`, an
  `activeAdaptations()` retrieval, a repeat `deriveAdaptations()` scan over a store that already
  carries those candidates, `health()`, and one `evidenceCheck()`. The recomputation is measured on
  every read deliberately: it is why a corrected experience cannot leave a stale rule in effect.
- **writes**: one append in parts - the audited event an experience must name, the store append
  inside the write lock, the end-to-end controller call (audit record plus independent re-check), a
  feedback record, an approval of a genuinely undecided candidate, a retirement, and the evidence
  re-check.
- **capture**: what one setting adds, measured as a difference inside the same run. Condition A runs
  an eligible verified request with `APEX_EXPERIENCE_CAPTURE` unset (the default) and condition B runs
  the same request against a fresh copy of the same fixture with it armed, so `B - A` is the capture
  itself. Alongside it: the store append the capture performs on its own, a second claim for one
  operation id refused inside the write lock (duplicate detection), two writers on one store started
  together (lock contention), the same request against a store with one corrupt line, and the same
  request against a store that cannot be opened at all - both of which must still succeed as the
  operation. The two conditions that must not be slowed are reported too: an ineligible request
  (`calc 2+2`) with the setting armed against it unset, and the first capture into an empty store on a
  fresh directory.
- **context**: the prompt characters each approved rule adds and for the default window, the cost of
  the note that rules were cut, the cost of stating that the store could not be read, the longest
  single rule line, the retrieval window and its hard maximum, and what one request actually pays:
  `calc 2+2` and a free-form ask are timed against both a populated store and an empty one, with the
  number of `activeAdaptations()` calls counted per request by an observing wrapper that returns
  exactly what the store returned.
- **compare**: the same raw append through the shared JSONL layer, the same store-level write, the
  same whole-file read and the same read-plus-derived-state call on the memory and knowledge stores
  at matched record counts, so the difference between these stores is measured rather than asserted.
  The raw-append probe re-appends the last line of each store's own file, read back verbatim into a
  throwaway copy, so no store is measured appending a shape the benchmark invented.
- **finalize**: the Batch AB completion contract in parts, all on one real verified `memory.add`
  record produced once through the controller and copied into a fresh fixture per sample. `audit
  only` is the raw append; `finalize off` is the same append through `finalizeOperation()` with no
  capture, so the gap between them bounds the helper's own cost (measured: none beyond noise);
  `finalize armed` adds the experience append and its independent read-back; `duplicate` is a second
  finalization of the same record object, which must be refused before it can append; `damaged audit`
  and `unreadable` run the armed path against an audit log that holds one corrupt line, or cannot be
  opened at all. Damaged and unreadable **experience** stores are measured in the capture phase.
- **temporal**: the Batch AC reads. Its fixture is separate from the others because a temporal query
  is a question about time: events are spread evenly across the 29 days ending an hour before the
  benchmark clock, one request in ten is rejected before execution, and one experience in nine
  carries corrective feedback, so every event is inside the default 30-day window and the last seven
  days are a genuine subset. Reported per size: `timeline` (the full query: read, derive, filter,
  detect patterns), `warm` (the same call again), `7 days` (the same query on a narrow window),
  `compare` (the two-window query), and three engine-only columns measured on one already-derived
  list - `filter` (window filtering, ordering, grouping), `analysis` (that plus pattern detection),
  and `summary` (the bounded summary built from it). It also prints the window, outcome classes,
  capability-group count and detected pattern kinds for each size, and the prompt contribution: the
  characters and lines the bounded temporal summary adds to a time-related request, the base prompt
  size, and the cost of stating that the store could not be read.

### Interpretation limits

- Fixtures are uniform synthetic text with one audited capability (`memory.add`), which is the worst
  case for derivation grouping and for the support bound; a real store spreads its evidence more.
- A read parses, hashes and validates the whole file and then recomputes the lifecycle, so read cost
  is **not** independent of total store size, and neither is write cost: each write reads the whole
  store before appending. The growth across the size matrix is the finding, not an artifact.
- The context figures are measured against the largest fixture, but they do not depend on store
  size: the adaptation section is bounded by the retrieval window (default 3, hard maximum 10), so
  the prompt characters are a function of rule text and window, while the retrieval *time* is what
  grows with the store.
- `repeats` samples in one process on one machine. Treat a median as an indication; differences of a
  few milliseconds - including a populated store that measures faster than an empty one - are noise.
- The capture phase is read as `B - A` within one run and never against another run's absolute
  figures: the machine, the background load and the fixture size all move the medians, while the
  armed-versus-unarmed pair runs on copies of the same bytes seconds apart. The finalize phase obeys
  the same rule: `finalize off` versus `audit only` is the contract's own overhead, and both run in
  the same process on copies of the same fixture.
- In the temporal phase the `timeline`, `warm`, `7 days` and `compare` columns include a whole-store
  read and derived-lifecycle recomputation, so they grow with the store as the other read phases do.
  The `filter`, `analysis` and `summary` columns are engine-only: they run on one list that has
  already been read and derived, outside the store, so they are additive within that same sample and
  not a claim about a complete query. The temporal fixture is synthetic evenly spaced timestamps;
  equal-timestamp tie-breaking and undated-record exclusion are covered by the tests, not measured.
- No figure here involves a model. Nothing in this file shows that an approved adaptation improves
  an answer, only what it costs the context that carries it.

This script is not part of `npm test` and no test depends on it.
