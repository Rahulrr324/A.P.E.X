# Bounded benchmarks

## Isolation, safety and how to run these

A benchmark is code that writes. What keeps it away from a real store, per script, measured in
`tests/data-dir-isolation.test.js` and the isolation checks in each harness:

- **Every script writes only under the OS temporary directory**, in a fresh `apex-bench-*` directory it
  creates for the run and removes afterwards. `--keep` is the only opt-out, and it says where it left
  the files.
- `run-model-benchmark.mjs` uses a fresh temporary directory **even when `APEX_DATA_DIR` is already
  set**, and gives each sample its own store: the operator's data directory is never what a benchmark
  appends to. Its children are handed `APEX_DATA_ISOLATED=1`.
- `run-world-state-benchmark.mjs` deletes `APEX_DATA_DIR` from the environment it passes to a child and
  sets `APEX_DATA_ISOLATED=1`, so a child that tried to reach a real directory fails at construction
  instead of writing to it.
- `run-prediction-benchmark.mjs` sets `APEX_DATA_ISOLATED=1` for the real child processes that race the
  prediction lock, and builds its in-process apps on `mkdtemp` directories.
- `run-experience-benchmark.mjs` passes an explicit `dataDir` from `fs.mkdtempSync()` to `createApp`,
  and its cleanup **refuses** to remove a directory that is not under the temp root and not prefixed
  `apex-bench-` - so a mistake in the harness cannot turn a benchmark run into a delete.
- `run-cognition-benchmark.mjs` builds every app on a `mkdtemp` directory prefixed `apex-bench-cog-`
  and uses the same refusing cleanup. It starts no child process and constructs no backend.
- `run-executive-bridge-benchmark.mjs` builds every app on a `mkdtemp` directory prefixed
  `apex-bench-akx-` with the same refusing cleanup, and gives **every sample its own fresh copy of its
  row fixture**, so no measurement can be taken on a store a previous measurement enlarged. It starts
  no child process and constructs no backend: every application is built with `NoBackend`.
- `run-planning-benchmark.mjs` builds every fixture on a `mkdtemp` directory prefixed
  `apex-bench-alx-` and uses the same refusing cleanup. It constructs no backend (`NoBackend` behind a
  `ModelGateway`) and touches no network. Its `recovery` phase is the one place it starts a child: the
  same `tests/fixtures/continuation-child.mjs` the AM tests stop, spawned with `APEX_DATA_DIR` pointed
  **at that fixture directory inside the temp root** and `APEX_DATA_ISOLATED=1`, so the interrupted run
  it leaves behind is a real process in a real temporary store rather than a described one. Its
  `control` phase empties the prediction and experience ledgers **inside the fixture directory it
  created for that run**, which is why it is the last phase and why it is destructive only to a
  temporary store.

- Nothing here reads `~/.apex`. A run that leaves a file behind outside the temp root is a defect worth
  reporting, not a cleanup task.

To check it yourself rather than trusting this text, hash your real store before and after
(`Get-FileHash -Algorithm SHA256 $env:USERPROFILE\.apex\local-alpha\*` on Windows,
`sha256sum ~/.apex/local-alpha/*` on POSIX) and compare. `apex status` also prints which data directory
a run is using, and prints a `Data:` notice when `APEX_DATA_DIR` is not set at all.

Two operating rules:

1. **One benchmark at a time, and never alongside `npm test`.** These are timing measurements on a
   shared machine; a concurrency-sensitive suite running next to a benchmark produces numbers that
   describe neither. The same applies to comparing runs: an in-run A/B comparison is evidence, a
   cross-run comparison is a dated observation about two moments.
2. **A prompt is sent, not just stored.** `run-model-benchmark.mjs` sends its prompt text to whatever
   endpoint it is pointed at. APEX's credential masking protects what is *persisted and printed*, not
   the request that leaves the process, so never put a real credential in a benchmark fixture or a
   prompt, and never point the script at an endpoint you did not choose to receive that text. The
   fixtures in these scripts are synthetic prose for exactly that reason.

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

1. `--experiences` is 1-10,000 (a comma-separated list makes a size matrix, default `20,100,400`) and
   `--repeats` is 1-25 (default 5). `--phase` selects one of `reads`, `writes`, `capture`, `context`,
   `compare`, `finalize`, `temporal`; without it all seven run in that order. A size above 2,000 is
   accepted only for `--phase temporal`: seeding the other phases goes through the request path, and
   10,000 events that way would take hours, so the script refuses rather than appearing hung. A run
   that selects only `temporal` does not seed the fixtures the other phases share, because the
   temporal phase builds its own, with default sizes `100,1,000,5,000,10,000`.
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
- **temporal**: the Batch AC/AD reads. Its fixture is separate from the others because a temporal query
  is a question about time: events are spread evenly across the 29 days ending an hour before the
  benchmark clock, one request in ten is rejected before execution, and one experience in nine
  carries corrective feedback, so every event is inside the default 30-day window and the last seven
  days are a genuine subset. Because a temporal query only reads, the fixture writes records
  directly in the exact shape the store validates, instead of driving 10,000 requests through the
  controller (measured: about 125 s of seeding per 1,000 events, so roughly 21 minutes at the
  largest size, for data the reads validate on every load anyway). Reported per size: `read` (the
  store load and integrity scan alone) and `derive` (the derived lifecycle over those records)
  as the two parts a temporal query cannot avoid, then `timeline` (the full query over a fresh
  store instance: read, derive, filter, detect patterns), `warm` (the same call again on the same
  instance, which is the only column allowed to reuse the parse cache), `7 days` (the same query on
  a narrow window), `compare` (the two-window query), and three engine-only columns measured on one
  already-derived list - `filter` (window filtering, ordering, grouping), `analysis` (that plus
  pattern detection), and `summary` (the bounded summary built from it). It prints the growth factor
  of each column between sizes, the window, outcome classes, capability-group count and detected
  pattern kinds, a closing statement naming the dominant cost and the evidence-based threshold for
  revisiting indexing or archival, and the prompt contribution: the characters and lines the bounded
  temporal summary adds to a time-related request, the base prompt size, and the cost of stating
  that the store could not be read.

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
  not a claim about a complete query. Measured over five repeats, `timeline` at 100 / 1,000 / 5,000 /
  10,000 events was about 5 / 35 / 310 / 686 ms, and the whole-file read plus validation was the
  largest share of it at every size (about half at 100 events and about four fifths at 5,000). The
  engine-only columns grew more
  slowly: detection (`analysis`) stayed under 85 ms at 10,000 events and the bounded `summary` was
  effectively free. That composition, not one absolute figure, is the finding: at these sizes the
  query is dominated by reading the store, not by pattern detection. The temporal fixture is
  synthetic evenly spaced timestamps, and it is read-only, so the write path is not measured here;
  equal-timestamp tie-breaking and undated-record exclusion are covered by the tests, not measured.
  Revisit indexing or archival only when a cold temporal query exceeds roughly one second, or when
  the store passes about 50,000 events, whichever comes first; a time-based archive is preferable to
  an index because the log is append-only and already ordered.
- No figure here involves a model. Nothing in this file shows that an approved adaptation improves
  an answer, only what it costs the context that carries it.

This script is not part of `npm test` and no test depends on it.

## Prediction ledger benchmark

`run-prediction-benchmark.mjs` measures the expectation ledger (`src/prediction/prediction-store.js`,
`src/prediction/prediction-engine.js`) and the bounded context section it contributes. It contacts no
model, starts no service, downloads nothing and needs no configuration: every application it times is
built with `NoBackend`, so the request path stops at `model_unavailable` and what is measured is APEX's
own work. It builds fresh temporary APEX data directories, fills them, and removes them unless
`--keep` is passed; the removal helper refuses to touch any path that is not one of its own benchmark
directories.

### Procedure

```bash
cd apex_app
node benchmarks/run-prediction-benchmark.mjs
node benchmarks/run-prediction-benchmark.mjs --repeats 7 --phase reads
```

1. `--repeats` is 1-25 (default 5) and `--phase` selects one of `reads`, `writes`, `contention`,
   `context`; without it all four run in that order. There is no size flag: the read matrix is fixed
   (10 / 50 / 100 / 200 predictions against a 1,000-event log, then 50 predictions against logs of
   100 and 5,000 events) so that two runs of this script are comparable. Hard caps are 2,000
   predictions and 10,000 events.
2. Both fixtures are seeded as records written directly in the stores' own validated shapes rather
   than through the write paths, because a prediction read only reads: seeding this way exercises the
   same readers a real log does and keeps seeding cost out of the measurement. Every ledger line the
   fixture produces is checked with the ledger's own validator as it is written, so a line no reader
   would accept cannot quietly become a fast number.
3. The clock is one fixed instant for the whole run and every fixture is spread over the same 29 days
   ending an hour before it, so a horizon boundary cannot move between seeding and measuring. The
   ledger fixture carries every lifecycle state a reader can report - half its horizons already past,
   one prediction in five citing events that predate it, one in nine replacing an earlier expectation,
   one in eleven withdrawn, and a fixed group holding a recorded verdict - because an aggregate read
   derives a state per record and a single-shape fixture would measure a ledger that does not exist.
4. Each write sample appends into its own fresh copy of the seeded fixture, so no cell can enlarge or
   slow the ledger a later cell reads.

### What it reports

- **reads**: eleven columns per row, with the two axes of the cost stated separately. `load` is the
  ledger's whole-file read, hash, parse and per-record validation; `project` is the ledger derivation
  over those records with no experience read at all; `status` and `health` are the two ledger-only
  reads that open no horizon; `horizon` is **one** re-opening of one prediction's horizon against the
  experience log - the unit an aggregate read multiplies; `show`, `list`, `history`, `summary` and
  `prompt` are the public store paths, each on a fresh instance, and `warm` is a second `list()` on
  one instance. When a row moves one axis and holds the other, the run prints the growth factor of
  `list` between the two rows rather than leaving the reader to subtract them.
- **writes**: one append in parts - the raw JSONL append with no read and no lock (printed to bound
  the store-level write, not offered as an operation APEX performs), the uncontended write-lock
  section, `recordPrediction` with and without citations, the same write through the authorized action
  layer with its audit record and independent re-read, an evaluation that judges an outcome, an
  evaluation whose horizon has nothing to judge and therefore writes nothing, and a withdrawal. A
  "records after" column makes each refusal visible as a total that did not move.
- **contention**: 1, 2 and 4 **real child processes** (`tests/fixtures/prediction-writer-child.mjs`)
  appending to one ledger released from a shared start, each timing its own attempt from inside
  itself. Per configuration: wall time, accepted attempts out of sent, ledger records, distinct record
  ids after the race, the median/min/max of the attempts, the refusals with their codes, corrupt lines,
  coordination residue, and the number of stored confidence values - which the run prints because it
  must be zero.
- **context**: the lines and characters the bounded expectation section adds, how many standing
  expectations it names against its binding maximum of 4, the base prompt length and the section's
  share of the context budget, the characters the one sentence costs when the ledger cannot be read,
  and a gate control that runs the **same** assembled request with and without the section so the
  printed difference is the gate rather than the difference between two request lengths. It also
  times the read behind that section (`promptView()`) at the largest and smallest ledger, which is
  where the run shows that the section's *size* is fixed while its *cost* is not.

### Interpretation limits

- This script measures the code as it stands. It has no pre-optimization mode, so the before/after
  table in [Batch AE: Measured](../README.md#batch-ae-prediction-ledger-hypothesis-lifecycle-and-outcome-evaluation-as-implemented)
  is two runs of this script on one machine, and the claim that the two paths return the *same*
  projection is carried by the AE-8 regression tests, not by a benchmark number.
- Medians over `repeats` samples in one process on one machine, with nothing else deliberately
  excluded. Differences of a few milliseconds are noise; read the growth factors and the composition
  of a read, not one figure.
- In the reads phase every aggregate column opens one horizon per standing prediction from one snapshot
  of the experience log, so the whole-file read, the per-record validation and the lifecycle
  derivation run once per operation while the window slice and pattern detection still grow per
  prediction. The residual per-expectation cost is the difference between the `list` and `horizon`
  columns on each row, and it is the reason the main README states a threshold for revisiting indexing.
- The fixture gives every prediction the same capability (`calc.evaluate`) and evenly spread
  timestamps, which is the worst case for the per-capability grouping and makes equal-timestamp
  tie-breaking likelier than in a real ledger. Tie-breaking and undated-record exclusion are covered by
  tests, not measured here.
- In the contention phase the wall column includes Node start-up for each child (several hundred
  milliseconds on this machine) while the attempt columns come from inside each writer and exclude it.
  The run prints both and never subtracts one from the other. A race figure describes this machine at
  this moment.
- The `evaluate` cell can print a per-sample note that the expectation it picked offered no verdict;
  that is the fixture and the judge disagreeing honestly, not a suppressed refusal.
- No model is contacted anywhere in this file, and nothing here shows that a recorded expectation
  improves an answer. It measures what the ledger costs to read, write, race and carry.

This script is not part of `npm test` and no test depends on it.

## World Model benchmark

`benchmarks/run-world-model-benchmark.mjs [--repeats R] [--phase reads|analysis|writes|contention|context] [--keep]`
measures the persistent World Model (`world-model.jsonl`, `src/world/`) with synthetic logs in a
fresh temporary data directory. It runs no inference, is built with `NoBackend`, contacts no
service, and is not part of `npm test`.

### Procedure

- Every fixture line is produced in the store's own validated record shape and checked with
  `validateWorldRecord` as it is written, so a line no reader would accept cannot become a fast
  number. Fixtures are deterministic: fixed ids, fixed instants, fixed order. The fixture is
  written as lines rather than through the write paths, so seeding cost stays out of the read
  phases while every read still validates and reduces the whole log.
- `reads` runs the nine read paths (`load`, `status`, `listEntities`, `showEntity`, `findEntities`,
  `factsFor`, `attributesFor`, `relationshipsFor`, `eventsFor`) at 100, 250, 500, 1,000, and 2,000
  entities. Each cell is one call on a fresh `WorldModelStore`, so it pays the load, validation,
  and reduction a real reader pays.
- `analysis` measures traversal (`related`), contradiction analysis, identity candidates, entity
  history, `changes`, prior-belief reconstruction (`stateAt`), and `buildWorldModelContext` on the
  already-reduced state. The context column is the section assembly only; it performs no store
  read.
- `writes` times one append in parts: the raw JSONL append with no read and no lock (printed to
  bound the store-level write, not offered as an operation APEX performs), uncontended lock
  acquisition, entity/fact/relationship/event/retraction writes, and the same writes through the
  authorized action layer with its audit record and independent re-read. The fixture has 1,000
  entities and 5,619 record lines; a "records after" total makes a refusal visible as a count that
  did not move.
- `contention` starts 1, 2, and 4 **real child processes**
  (`tests/fixtures/world-writer-child.mjs`) creating entities in one log from a shared start, each
  timing its own attempt. The run prints wall time, accepted attempts out of sent, records after,
  new entities, median/min/max, refusals, corrupt lines, lock residue, and asserts that the number
  of new `e-w*` entities equals the accepted attempts on every row.
- `context` prints the bounded section's lines and characters, the entries the local budget omitted,
  the number of disagreement groups named, the base prompt length and the section's share of the
  6,000-character budget, the overview form's contribution, the cost of the unavailable notice, and
  a forced-section control on an unrelated request. It also times `store.state()` on the fixture
  and `buildWorldModelContext` on the reduced state.

### What it reports

All medians below are from `--repeats 3` on one Windows 11 machine (Node v24.18.0, 12 logical
CPUs, warm page cache). Readings move with machine load; read the growth across rows, not one cell.

| Entities | Lines | Bytes | load | status | list | show | find | facts | attributes | relationships | events |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 100 | 562 | 249,430 | 14.4 | 15.0 | 12.8 | 15.4 | 12.1 | 12.8 | 13.7 | 14.2 | 13.4 |
| 250 | 1,406 | 624,309 | 33.0 | 31.0 | 30.5 | 32.1 | 27.4 | 32.3 | 31.6 | 31.8 | 32.4 |
| 500 | 2,810 | 1,247,992 | 56.1 | 64.6 | 59.5 | 69.2 | 58.1 | 62.3 | 61.3 | 71.3 | 65.6 |
| 1,000 | 5,619 | 2,495,785 | 212.7 | 241.0 | 203.5 | 242.4 | 210.9 | 236.1 | 227.0 | 228.7 | 240.2 |
| 2,000 | 11,239 | 4,993,059 | 436.6 | 481.2 | 420.7 | 502.1 | 428.4 | 468.6 | 477.2 | 462.5 | 496.7 |

| Entities | related | conflicts | identity | history | changes | state-at | context build |
|---|---|---|---|---|---|---|---|
| 100 | 23.5 | 23.7 | 30.9 | 26.7 | 32.2 | 29.1 | 6.0 |
| 250 | 51.9 | 53.4 | 66.7 | 54.7 | 69.5 | 63.7 | 7.6 |
| 500 | 100.3 | 102.1 | 129.9 | 112.4 | 143.3 | 127.9 | 20.9 |
| 1,000 | 228.3 | 243.3 | 255.1 | 229.5 | 313.9 | 279.3 | 27.4 |
| 2,000 | 440.3 | 451.6 | 504.9 | 427.9 | 577.6 | 532.7 | 65.3 |

Writes at 1,000 entities (median / min / max ms): append 18.1 / 13.5 / 30.2, lock 25.0 / 24.7 /
27.4, create entity 337.2 / 316.5 / 385.5, assert fact 342.2 / 333.8 / 355.3, assert relationship
356.9 / 346.7 / 392.0, record event 338.0 / 324.0 / 377.8, retract 341.1 / 340.1 / 349.2, create
entity through the action layer 563.2 / 555.2 / 613.9, assert fact through the action layer 600.5 /
591.6 / 604.2. A public write re-reads and revalidates the whole log inside the lock, so the
one-line append is not the cost; the integrity pass and the reduction are.

Contention: 1 writer completed 3/3 accepted attempts in 540.7 ms (median attempt 106.0, max 116.0);
2 writers completed 6/6 in 919.8 ms (median 103.0, max 485.0); 4 writers completed 12/12 in
1,817.7 ms (median 112.0, max 1,330.0). Every row left 0 refusals, 0 corrupt lines, 0 lock residue,
and exactly as many new entities as accepted attempts.

Context: a named entity produced 9 lines and 1,163 characters (13 entries omitted by the local
budget), an overview request 8 lines and 615 characters naming 33 disagreement groups, and an
unrelated request 0 lines. The named section adds 1,632 characters on the 6,000-character budget
(27.2%); the overview form adds 1,084 on its base, the unavailable notice 171. `store.state()` on
the 2,000-entity fixture took 223.6 ms median (220.4-232.9) and `buildWorldModelContext` on the
reduced state 24.5 ms.

### Interpretation limits

- Medians over three samples in one process on one machine, warm page cache, with nothing else
  deliberately excluded. Differences of a few milliseconds are noise, and absolute milliseconds
  move by up to about 2x with machine load. Read the growth across rows and the composition of an
  operation.
- The reads are called directly on `WorldModelStore`, not through `runAction`. They exercise the
  same store reads the actions call, but they do not include the action wrapper, its audit record,
  or its verifier; the action-layer write rows show that difference on the write side.
- The fixture's facts include deliberately overlapping single-valued values, so the contradiction
  analysis in the `analysis` phase has real work on every row. A clean log would be cheaper.
- The contention wall column includes Node start-up for each child (several hundred milliseconds),
  while the attempt columns come from inside each writer and exclude it. The run prints both and
  never subtracts one from the other.
- No derived index exists and none is measured. These figures are the cost of the current
  whole-log validation and reduction, which is why the main README's decision against adding an
  index cites them rather than a guess.
- No model is contacted anywhere in this file, and nothing here shows that a recorded fact is true
  or that an answer improves. It measures what the World Model costs to read, write, race, and
  carry into a prompt.

## Cognition benchmark

`run-cognition-benchmark.mjs` measures the deterministic cognition layer added by Batch AJ. It is
model-free: no backend is constructed, `analyzeRequest` only reads stores, and the validation
samples are literal strings.

```sh
node benchmarks/run-cognition-benchmark.mjs [--repeats R] [--phase stages|context|validation|all] [--keep]
```

The fixture seeds memory and knowledge records through their stores' own validated write paths at
20, 200 and 800 records each, plus one World Model entity with two disagreeing facts and one event,
so claim extraction and deliberation have real work. Nothing is written outside a fresh temporary
data directory.

### What it reports

Measured on Node v26.4.0, Windows x64, 12 logical CPU(s), `--repeats 5`:

| Measurement | 20 records | 200 records | 800 records |
|---|---|---|---|
| World state read + conflict derivation | 0.92 ms | 0.78 ms | 1.38 ms |
| Analysis total (standalone) | 9.12 ms | 37.06 ms | 325.15 ms |
| Request understanding | 0.27 ms | 0.26 ms | 0.16 ms |
| Retrieval and evidence normalization | 7.98 ms | 36.01 ms | 324.48 ms |
| Claim extraction | 0.20 ms | 0.15 ms | 0.17 ms |
| Deliberation | 0.22 ms | 0.15 ms | 0.11 ms |
| Grounding brief | 0.10 ms | 0.05 ms | 0.04 ms |

Context: at 800 memory and 800 knowledge records, 20 hits each reach the prompt. The brief carries
11 of 19 lines and 1,335 characters (8 omitted by its own bound); in an 8,000-character
measurement budget it adds 741 characters, and `buildPrompt()` takes 0.58 ms median over five
samples. At the default 6,000-character budget the brief is trimmed first; in this fixture the
remaining room went to records, so the brief's omission notice did not fit either. The records it
would have described were still present, and the operation record still carries the analysis.

Validation: an accepted structured response validates in 0.12 ms median, an invented evidence id
is rejected as `INVALID_STRUCTURE` in 0.08 ms, and malformed JSON is rejected as `MALFORMED_JSON`
in 0.02 ms.

### Interpretation limits

- Medians over five samples in one process on one machine, warm page cache. Differences of a few
  milliseconds are noise, and absolute milliseconds move with machine load.
- The `stages` phase is the standalone analysis, which reads memory and knowledge itself. The
  controller passes its already-retrieved records as seeds, so on the model path those two reads
  do not happen twice; the seeded path is exercised by `tests/cognition-scenarios.test.js`.
- The analysis is bounded at 36 evidence records (6 per source), so its own stages stay flat while
  the store grows. The retrieval growth shown is the memory and knowledge search inside it, which
  existed before this layer and is not changed by it.
- The fixture's two disagreeing World Model facts give the contradiction map real work on every
  row. A clean store would be cheaper.
- No model is contacted anywhere, and nothing here measures answer quality, reasoning quality, or
  human-like cognition. It measures what the deterministic stages cost to run.

## Executive bridge benchmark

`run-executive-bridge-benchmark.mjs` measures the Batch AK executive bridge: the request path
User request → understanding → proposal → validation → authorization → execution → verification →
audit → outcome. It is model-free in the strongest sense available: every application it builds uses
`NoBackend`, so a request that needed a model stops at `model_unavailable`, no network is contacted,
no service is started, and nothing is downloaded. What is timed is APEX's own work.

### Procedure

```bash
cd apex_app
node benchmarks/run-executive-bridge-benchmark.mjs --repeats 5 --rows 1,10,50,150 --phase all
node benchmarks/run-executive-bridge-benchmark.mjs --repeats 3 --phase run
```

1. `--repeats` is 1-25 (default 3). `--rows` is a comma-separated list of fixture sizes, each
   0-400 (default `1,10,50,150`); `--phase` selects one of `preview`, `authorization`, `run`,
   `status`, `recovery`, `finalize`, or `all`. `--keep` leaves the temporary directories in place and
   prints where. Nothing outside the OS temp folder is written.
2. The growth axis is **historical executive work, not plan length**: `MAX_PLAN_STEPS` is 8, so the
   largest plan this file can measure has 8 steps, and the rows vary how much executive history each
   request must read past. Each row holds that many goal/plan/task bundles; a bundle is produced by
   really running prepare → approve → start in a throwaway directory and collecting the exact lines
   that run wrote, so every fixture record is one a real request produced (~16 record lines per
   bundle, across `goals`, `plans`, `tasks`, `operations` and `memory`).
3. Seeding is reported apart from every measurement, because it costs whole-store reads: 150 bundles
   took 100.7 s. `--rows` accepts 400 but this file has only been run to 150, so 400 is unmeasured
   and the seeding time extrapolates to several minutes.
4. Every sample writes its own fresh copy of the row fixture into its own directory and builds a new
   application per phase, so no sample measures a store a previous sample enlarged. The phases inside
   one sample do share that sample's fixture, so a later phase reads the row fixture plus the few
   records the earlier phases wrote; the printed per-request record deltas bound that addition, and
   it is the same addition at every row, so it does not create the growth the rows show. The two
   write columns of `finalize` are excepted: each gets its own copy, because a store's first write
   builds the incremental state a second write reuses.

### What it reports

Alongside every millisecond figure the script prints **the records each call appended, per log**. A
latency number says how long a request took; those lines say what it did, which is the part a timing
figure cannot show and the part any optimization would have to change.

- **preview**: request-to-preview as a whole, then the bridge's own computation in parts on one plan
  (intent signal, plan synthesis, view build, approval binding hash - each with no store read), plus
  the live plan-validity read, and the bridge's own computation as a share of the request.
- **authorization**: `plan.approve` at the action layer, the approval *answer* (the same approval plus
  the read-back view that prints the binding), a clarification refusal, and a draft that cannot be
  started.
- **run**: multi-step orchestration through the existing `TaskRunner` - a 1-step plan and the
  maximum-size 8-step plan on the same bytes, per-step cost, and the **marginal** cost of a step
  (the difference between the two plans over the 7 steps the longer one has more of), each with its
  record delta.
- **status**: the status answer, the bare continuation record read behind it, the two reads the bridge
  performs before it defers an approval question to the task log, and what each appended - which is
  how a read-only request is told apart from an executing one.
- **recovery**: the read-only sweep, the same sweep after a failed run, and the reconcile that records
  that run's outcomes against the plan. The failed run comes from a labelled benchmark double that
  throws (`bench.fail`), so it is not evidence about a real action.
- **finalize**: one verified write at five depths - the bare store append, the authorized action step,
  then the whole request with capture off, with capture armed, and with capture off again. The three
  request columns are the same ordinary `remember that the AK benchmark request fact for row N holds`
  (`memory.add`) words handed to `handle()` on copies of the same bytes, so they measure the finalization
  contract a bridge step ends on rather than an `executive.*` operation; the armed figure is compared
  with two same-condition figures and the third prints the drift of the run itself rather than the capture.
- growth from the smallest row to the largest for every headline column, and process RSS and heap at
  the end of the run.

### Measured

All medians below are from `--repeats 5 --rows 1,10,50,150 --phase all` on one Windows 11 machine
(Node v26.4.0, x64, 12 logical CPUs, 24 GiB reported, warm page cache), in a run that excluded any
other benchmark or test. Fixture bytes: 11,126 / 111,271 / 556,751 / 1,671,012. Read the growth
across rows and the composition of an operation; a single figure here is an indication, not a
specification.

| ms (1 / 10 / 50 / 150 bundles) | 1 | 10 | 50 | 150 | 1→150 |
|---|---|---|---|---|---|
| request → preview | 115.69 | 117.21 | 155.16 | 248.78 | 2.15x |
| live plan validity read | 4.82 | 4.97 | 13.49 | 25.15 | 5.21x |
| bridge's own computation (pure sum) | 0.44 | 0.58 | 0.36 | 0.35 | flat |
| `plan.approve` (action layer) | 67.22 | 60.82 | 87.70 | 108.79 | 1.62x |
| approval answer (with read-back view) | 97.61 | 112.81 | 162.66 | 199.55 | 2.04x |
| clarification refusal | 43.69 | 37.99 | 46.96 | 40.61 | flat |
| 1-step plan run | 397.30 | 464.86 | 547.61 | 662.40 | 1.67x |
| 8-step plan run | 1200.69 | 1234.42 | 1434.40 | 1822.48 | 1.52x |
| per step (8-step) | 150.09 | 154.30 | 179.30 | 227.81 | 1.52x |
| marginal cost of a step | 114.77 | 109.94 | 126.68 | 165.73 | - |
| status answer | 32.23 | 32.95 | 49.53 | 71.07 | 2.20x |
| continuation record read | 12.40 | 15.32 | 25.48 | 45.86 | 3.70x |
| recovery sweep (read-only) | 16.38 | 16.46 | 23.86 | 43.24 | 2.64x |
| reconcile after a failed run | 35.71 | 36.31 | 64.46 | 96.77 | 2.71x |
| store append (one record) | 37.78 | 50.34 | 42.02 | 38.13 | 1.01x |
| authorized action step (one write) | 46.81 | 56.76 | 52.43 | 50.66 | 1.08x |
| request, capture off / armed / off again | 129.56 / 155.62 / 121.93 | 103.03 / 187.07 / 111.64 | 139.17 / 214.49 / 132.71 | 106.07 / 192.10 / 140.92 | - |

Capture overhead within one run, on the same bytes: `armed - off` was 26.06 / 84.04 / 75.32 / 86.03 ms,
while the same-condition control drifted -7.63 / +8.60 / -6.46 / +34.86 ms, and `armed - off(second)`
was 33.69 / 75.44 / 81.78 / 51.17 ms. The armed request appended exactly one extra record
(`experiences+1`); its other writes were identical to the unarmed one's.

What each path appends, identical across all rows and all five samples: a prepare writes
`plans+1 operations+1 conversation+2`; a status question writes `operations+1` and the bare record read
behind it writes **nothing**; a 1-step run writes `plans+3 tasks+5 operations+2 memory+1
conversation+1` and an 8-step run `plans+3 tasks+19 operations+9 memory+8 conversation+1`. The
status read at 150 bundles saw 156 plans and 152 tasks. Every run reported `8/8 completed, outcome
success_verified`; the recovery sweep after the labelled failing run reported
`execution_failed, steps ["completed","failed"]` and reconciled to `plan_stored`.

**Conclusion against indexes and caches.** 150x more executive history buys 1.5-2.2x on the request
paths, 3.7-5.2x on the two whole-store read columns, and 1.01-1.08x on a single write - while the
bridge's own computation stays at 0.35-0.58 ms, or 0.1-0.5% of a request, at every size. A fixed
per-operation cost dominates: the coordinated write and the whole-store validated read that Batch V
already measured and left alone, not bridge logic. **No derived index and no cache is justified by
these figures, and none was added.** The lines to re-measure if this path ever needs one are the live
plan validity read (5.21x, steepest), the status continuation record read (3.70x), the approval answer
(2.04x) and the per-step orchestration cost (227.81 ms/step at 150 bundles). Revisit the question only
when a request-to-preview at 150 bundles passes about one second, when the validity read passes about
100 ms at that row, or when a store passes roughly 10,000 executive records / 7 MiB - an order of
magnitude beyond the 2,400 records and 1.67 MiB ceiling measured here.

### Interpretation limits

- The worst measured case is an 8-step plan: 1.82 s median, 2.33 s across the min-max spread, on a
  1.67 MiB fixture. That is the whole plan, not a request; each step is one authorized, executed,
  verified and audited `memory.add`.
- Medians over five samples in one process on one machine. Differences of a few milliseconds,
  including negative ones in the capture-drift lines, are noise; the armed/off pair is the evidence
  and any figure from a different run is a dated observation.
- RSS 182.8 MiB and heap 24.6 MiB at the end of the run are the benchmark process's own footprint
  including the seeded fixture it held while writing 150 bundles. They are not a claim about the
  steady-state footprint of a request, and no per-request memory figure is measured here.
- The fixture is one `memory.add` step per bundle and one fixed clock, which is the shape the plan and
  task logs grow fastest in; a real install spreads its steps over more capabilities and its records
  over more varied text.
- This measures what the executive path costs to run. It is not evidence that a plan the bridge
  recorded was a good plan, that a verified step is correct in the world, or that any model would have
  chosen these steps: no model was contacted, no inference was run, and no inference was simulated.

This script is not part of `npm test` and no test depends on it.

## Planning benchmark (Batch AL)

`run-planning-benchmark.mjs` measures the nine adaptive-planning paths Batch AL added: goal
decomposition with provenance, candidate generation, candidate evaluation, plan validation, goal
progress derivation, outcome evaluation, replanning, continuation ranking, and the one recorded
assessment. Like the other scripts here it is model-free in the strongest available sense: every
application is built with `NoBackend` behind a `ModelGateway`, so no network is contacted, no service
is started, nothing is downloaded, and no inference is run or simulated. What is timed is APEX's own
work through the real controller, the real stores, the real action registry and the real verifier.

### Procedure

```bash
cd apex_app
node benchmarks/run-planning-benchmark.mjs                          # all three sizes, all phases
node benchmarks/run-planning-benchmark.mjs --sizes S --repeats 2    # a fast shape check
node benchmarks/run-planning-benchmark.mjs --sizes L --phase control
```

1. `--repeats` is 1-25 (default 3). `--sizes` selects any of `S,M,L,XL` (default `S,M,L`; `XL` is
   opt-in). `--phase` selects `columns`, `attribution`, `control`, `constraints`, `recovery`, `ranking`,
   or `all`; `--keep` leaves the fixture directories and prints where. Batch AM added `constraints` and
   `recovery`; Batch AN added `ranking` and `XL`.
2. A fixture is a subject goal with two required criteria plus one approved and run plan, then the
   backlog the reads must scan: `memory.add` and knowledge triples, goals and two-step plans created
   through the stores' own writes, plans really activated through the existing task runner, predictions
   recorded through the ledger, and one experience filed against each operation the seeding produced
   (the store allows one per operation, so the audit log is grown first by audited reads of the
   experience ledger). Nothing is written into a fixture by hand. Backlog plans reference their goal by
   the id the store returned; before Batch AN they were created with `undefined` and silently recorded
   no goal link, which left their activation and validity checks goal-free. `XL` adds 40 runs stopped
   after activation (plan active, task pending, no step begun) to the 40 that run to completion.
3. Seeding is reported apart from every measurement and is by far the slowest part of a run: 0.5 s,
   60 s and 226 s for S, M and L in the Batch AN run below, 356 s for XL, and the same L fixture seeded
   in 75 s in an earlier run on the same machine. Treat seeding figures as machine load, not as a
   measurement.
4. An audited read appends one operation record of its own, so the second and third sample of a column
   are taken on a log one or two records longer than the first. At these sizes that is well under one
   part in a thousand of `operations.jsonl`, and it is disclosed rather than hidden. The assessment
   column is taken once per fixture and last, because the store refuses a second assessment of the same
   plan version.
5. The `control` phase runs only at the largest selected size: it empties `predictions.jsonl` and
   `experiences.jsonl` in that fixture and re-takes the three reads. That is the comparison that tells
   the planning code's own growth apart from the disclosure it prints.

### What it reports

- **columns**: each of the nine paths, as medians with every sample, at each size. `candidate
  generation` and `candidate evaluation` are the pure functions called directly, so the answer prints
  the cost of the AL logic itself next to the cost of the audited reads that wrap it.
- **attribution**: the three reads the learning disclosure makes (`activeAdaptations`,
  `predictions.calibration`, `plans.list`), each alone, plus `goals.list`, `operations.inspect`, and the
  raw read-and-parse of the prediction and experience logs - so a claim about where time goes is a
  measurement and not an inference. It also counts store calls: a census taken across one candidate
  read and one outcome read shows `plans.list`, `activeAdaptations` and `calibration` twice per read,
  which is the action's own verification re-deriving what it printed, and `operations.findById` twice
  per outcome read for the operations its findings cite.
- **control**: the same goals, plans, tasks and audit log with the two ledgers the disclosure reads
  emptied.
- **constraints** (Batch AM): one fresh goal whose recorded constraint items are grown through the
  store's own `goal revise` - none, one full list of 8, then all six lists full at 48 - timed twice, as
  the `constraintLedger` call alone and as the audited `plan.candidates` read that carries its answer.
  Each rung prints how many items the ledger answered, how many of them gate work, and how many
  candidates the gate excluded, so the cost is stated beside what it bought. The texts name registered
  capabilities on purpose: a constraint can only bear on a step that exists.
- **recovery** (Batch AM): a **real child process** (`tests/fixtures/continuation-child.mjs`) approves a
  two-step plan, activates it and stops at the boundary where the task and its steps are recorded and
  nothing has run - inside the fixture directory this size built. A second process, holding the registry
  that run used, is then timed on the bytes the first left: `plan continuation` (the nine-state
  reading), the `work`/`next` ranking that now reads it, the conversational readiness question about
  that plan, `plan continue` taking the untouched steps up once, the refused second resume of the same
  run, and the reading and ranking of the now-settled run. Each line prints its samples; the resume is
  timed once and taken after the reads, because it is the one measurement in this file that changes the
  records it measures.
- **ranking** (Batch AN): one `work`/`next` report, with its store calls counted, then the stages it
  derives timed separately over the same pre-read records: the five whole-store reads, the audit log
  read and one record by id, the pre-AN per-plan goal replay, live validity through the store and
  through one shared snapshot, the constraint ledger per goal, the continuation reading, the readiness
  reading, the pure candidate ranking, rendering, and the report end to end. The two validity shapes are
  compared verdict by verdict in the same run. `XL` is the fixture this phase exists for: it holds 40
  interrupted runs, so the ranking has readings to derive.

### Measured

Medians from `node benchmarks/run-planning-benchmark.mjs` (default repeats 3, all phases) on Windows 11,
Node v26.4.0, x64, in a run with no other benchmark or test active. Fixture contents at L: 2,021 memory
records, 2,000 knowledge claims, 155 goal events, 235 plan events, 147 task lines, 401 operations, 800
predictions, 400 experiences - about 2.2 MB of JSONL.

| ms (median S / M / L) | S | M | L |
|---|---|---|---|
| goal decomposition (`assessStoredGoal`) | 6.3 | 18.1 | 18.7 |
| candidate generation (pure) | 3.0 | 4.2 | 0.5 |
| candidate evaluation (pure) | 1.0 | 0.3 | 0.2 |
| plan validation (`validateStoredPlan`) | 5.3 | 27.7 | 21.2 |
| goal progress over every goal | 1.5 | 9.4 | 8.8 |
| outcome read (`plan.outcome`) | 31.9 | 431.2 | 3,321.5 |
| replan read (`plan.replan`) | 24.0 | 445.2 | 3,149.3 |
| candidate read (`plan.candidates`) | 18.2 | 261.1 | 3,243.6 |
| continuation ranking (`work`/`next`) | 4.5 | 10.1 | 51.1 |
| recorded assessment (`plan.assess`) | 45.2 | 210.9 | 289.0 * |

\* at L the assessment is taken after the control emptied the two ledgers, so it belongs with the
control row below, not with the three reads above.

| attribution, ms (S / M / L) | S | M | L |
|---|---|---|---|
| the three learning reads together | 3.0 | 184.8 | 1,623.4 |
| `predictions.calibration` alone | 1.3 | 187.1 | 1,492.9 |
| `activeAdaptations` alone | 1.7 | 5.5 | 5.1 |
| `plans.list` alone | 1.6 | 9.7 | 11.0 |
| `goals.list` alone | 1.4 | 15.6 | 30.0 |
| both ledgers read and parsed | 0.3 | 8.6 | 15.2 |
| control: candidate / replan / outcome read with no predictions and no experiences | - | - | 118.8 / 138.8 / 271.5 |

The reading of these numbers is narrow and deliberate: the planning code does not get slower with the
history it reads - the generator and evaluator stay under a millisecond at L, and decomposition,
validation, progress and ranking stay between 18 and 52 ms - while each of the three audited planning
reads does, and the whole of that increase sits in the prediction ledger projection the learning
disclosure performs twice per read. Emptying those two ledgers returns the same fixture's reads to
0.1-0.3 s, and the calibration at 800 predictions against 400 experiences costs about the same as those
three reads, so it is the mechanism, not an incidental.

### Measured (Batch AM: the same paths after the read fix, plus the two new phases)

Two runs of this script on one Windows 11 machine (Node v26.4.0, x64, 12 logical CPUs), no other
benchmark or test active in either. **Before** = a copy of the tree taken from `HEAD`
(`5a3d4947753703e49a79a698191e05d24119f13a`, the Batch AL commit) extracted with `git archive` into a
temporary directory, so it is the shipped code before Batch AM, not a switched-off mode. **After** = this
working tree. Fixture contents at L were identical between the two runs: 2,021 memory, 2,000 knowledge,
155 goal events, 235 plan events, 147 task lines, 401 operations, 800 predictions, 400 experiences, about
2.2 MB.

The **Before L column is one sample** (`--repeats 1`). The three-sample run of the same command did
finish, but its scratch output path was reused by the second run before either was read, so only the
single-sample figures survive. That is a bookkeeping mistake in this session, not a property of the
measurement. The M column is three samples on both sides, and the AL-era figures committed above (L:
candidate 3,243.6 / replan 3,149.3 / outcome 3,321.5 ms, calibration 1,492.9 ms) agree with the Before L
column to within about 8-10%, so the size of the change rests on three independent measurements rather
than on one.

| ms (median) | Before S | After S | Before M | After M | Before L (1 sample) | After L |
|---|---|---|---|---|---|---|
| outcome read (`plan.outcome`) | 27.5 | 26.0 | 435.0 | 183.4 | 3,587.6 | 349.5 |
| replan read (`plan.replan`) | 19.4 | 25.3 | 300.6 | 112.3 | 3,424.3 | 299.6 |
| candidate read (`plan.candidates`) | 14.9 | 21.1 | 270.4 | 108.6 | 3,499.1 | 269.4 |
| the three learning reads | 1.3 | 1.3 | 115.5 | 26.4 | 1,528.3 | 76.9 |
| `predictions.calibration` | 0.5 | 0.4 | 119.1 | 26.0 | 1,518.2 | 61.7 |
| continuation ranking (`work`/`next`) | 3.4 | 3.6 | 21.7 | 16.7 | 49.7 | 41.6 |
| plan validation | 4.5 | 5.3 | 19.4 | 19.1 | 40.2 | 48.7 |
| goal progress over every goal | 1.0 | 0.9 | 5.4 | 7.1 | 24.9 | 26.9 |
| recorded assessment (`plan.assess`) | 30.1 | 34.1 | 109.5 | 109.8 | 166.1 | 173.6 |
| control at L: candidate / replan / outcome | - | - | - | - | 128.4 / 129.9 / 196.9 | 170.5 / 161.5 / 247.9 |

The ratios at L: the three audited planning reads are **10.3x / 11.4x / 13.0x** faster, the learning trio
**19.9x**, `predictions.calibration` alone **24.6x**. At M the same three reads are 2.4x / 2.7x / 2.5x and
the calibration 4.6x. What did not move is the part the fix was never about: decomposition, validation,
progress, ranking and the recorded assessment stay within noise of their Before figures at every size,
and the control - the same fixture with both ledgers emptied - costs about the same on both sides (0.13-
0.20 s Before, 0.16-0.25 s After), which is what says the After reads are now close to their own floor
rather than to a coincidence.

One census line did change, and it is the cost Batch AM added on purpose: a candidate read performs
`plans.list` twice at HEAD and four times after, an outcome read four times and six. The extra reads are
the constraint ledger and the guidance ledger, each of which re-reads the plan store so its answer comes
from records rather than from what the read already held. At L that is about 13-25 ms of `plans.list`
inside a read that got 3.2 s cheaper.

**Constraint evaluation** (`constraints`, After; the phase does not exist at HEAD). One goal, its recorded
items grown through `goal revise` to the store's own cap - `MAX_GOAL_ITEMS` is 8 per list and there are
six lists. The ledger is timed alone and inside the audited candidate read, which prints what the ledger
answered.

| rung | ledger S | ledger M | ledger L | audited read S / M / L | items answered / gating / excluded, at L |
|---|---|---|---|---|---|
| none recorded | 0.0 ms | 0.1 ms | 0.0 ms | 16.9 / 105.6 / 258.7 ms | 0 / 0 / 0 |
| 8 blockers | 0.4 ms | 0.7 ms | 0.3 ms | 18.7 / 106.0 / 255.3 ms | 8 / 0 / 0 |
| 48 items, all six lists full | 1.4 ms | 2.0 ms | 1.5 ms | 23.7 / 101.4 / 259.6 ms | 48 / 0 / 0 |

The ledgers cost is the size of the stores its citations are answered from, not the number of items it
answers: 48 recorded items cost 1.5 ms at L against 0.0 ms for none, and the audited read moves by less
than the noise between the rungs (258.7 / 255.3 / 259.6 ms). A goals own recorded constraints therefore
have a hard ceiling in this store - 48 items - and it is cheap. The `gating 0 / excluded 0` columns are
the fixture speaking honestly: these blockers bear on no step this goals candidates take, so they are
disclosed and gate nothing. Where a recorded blocker does name a step a candidate takes, the exclusion is
real, and that is pinned by tests (`plan-constraints.test.js`, `plan-scenarios-am.test.js` scenario 13),
not measured here; this phase measures cost and prints the answer counts so a cost cannot be read as an
effect.

**Recovery and resume** (`recovery`, After; the phase does not exist at HEAD). A real child process
approved a two-step plan, activated it and stopped at the boundary where the task and its steps are
recorded and nothing has run; a second process read those bytes.

| ms (median of 3) | S | M | L |
|---|---|---|---|
| continuation reading (`plan continuation`) | 14.8 | 44.5 | 97.2 |
| ranking over that reading (`work`/`next`) | 9.7 | 60.5 | 223.6 |
| readiness question about the interrupted plan | 28.2 | 155.5 | 258.8 |
| resume once (`plan continue`: 2 steps executed, verified, audited) | 144.2 † | 501.3 † | 692.0 † |
| the same resume refused, the run now closed | 20.2 | 58.6 | 111.9 |
| reading of the settled run | 21.3 | 65.4 | 115.5 |
| ranking after the resume | 3.3 | 14.6 | 48.4 |

† one sample: taking the run up changes the records, so it cannot be repeated on the same bytes.

Every size ended the same way: the resume returned `plan_stored` and left exactly two lines in the
side-effect file, and the second resume of the same run was refused. The ranking at L is the column
Batch AM made heavier - 223.6 ms against the `columns` phase 41.6 ms on a fixture holding no interrupted
run - because each active plan with a task of its own now gets a continuation reading before it can be
ranked, and the L fixture holds 147 task lines. It is a read, so that cost is paid by the user who asks
what is next and never by a background process; the refused second resume at 111.9 ms is the same reading
taken again on a run that is now settled.

### Measured (Batch AN: continuation ranking over four fixtures)

Two commands on one Windows 11 machine (Node v26.4.0, x64): `--sizes S,M,L` and `--sizes XL`, both
`--phase ranking --repeats 3`, with no other benchmark or test active. The `XL` fixture is a large
project with many active plans and tasks: 885 goal events, 645 plan events, 327 task lines, 401 audit
records, 800 predictions, 400 experiences, and 40 interrupted runs among 80 activated plans - about
3.6 MB of JSONL. S, M and L hold no interrupted run, so their ranking has no reading to derive; they
measure the whole-report cost on a project whose plans have all settled.

One `work`/`next` report at every size reads the goal log once (`goals.inspect` 1, `goals.get` 0), the
plan log once, the task log once, and - when an interrupted run exists - the audit log once and the task
lock once. No plan re-reads a store after the one goal snapshot.

| ms (median of 3) | S | M | L | XL |
|---|---|---|---|---|
| the five whole-store reads | 4.1 | 26.4 | 43.9 | 177.7 |
| audit log read and parsed | 0.7 | 4.1 | 8.4 | 7.4 |
| one audit record by id | 0.9 | 3.2 | 4.3 | 4.5 |
| ranking end to end (`work`/`next`) | 3.3 | 20.3 | 37.6 | 220.2 |

The XL stages, over the same records (medians of 3):

| stage | ms |
|---|---|
| goal replay, once per interrupted plan (the pre-AN read shape) | 5,451.8 |
| live validity through the store, once per ranked plan (with that replay inside) | 5,511.9 |
| live validity through one shared snapshot | 6.9 |
| constraint derivation, one ledger per distinct goal | 2.2 |
| continuation reading | 21.0 |
| readiness reading | 6.2 |
| candidate ranking (pure) | 6.5 |
| render | 0.0 |
| ranking end to end | 220.2 |

The two validity shapes agreed on every plan's verdict (`ok` and every problem line), so the faster
shape is not a weaker one. The replay is the mechanism: the goal log holds 885 events and `goals.get`
replays and reduces all of them, so one call costs about 136 ms here; Batch AM's ranking made that call
twice per interrupted plan - once for the reading's constraint ledger and once inside live validity -
which is why the same report cost about 5.1 s on a 300-goal probe before the fix. The report now pays
one whole-log read and one reduce, then answers every plan from that snapshot. An earlier isolated probe
of the same change (300 goals, 40 interrupted plans) measured 5,138.9 ms to 117.0 ms; it was taken in a
different run, so it is context, not a comparable column.

### Interpretation limits

- Absolute timings on this machine varied up to 2x between two runs of the identical fixture, including
  the 75 s/200 s seeding difference above. Only comparisons taken inside one run - the control against
  the reads, the attribution against the total - are treated as findings here.
- The fixture's predictions and experiences are uniform in capability and window, which is the shape
  that makes a horizon query scan the whole snapshot; a real ledger spread over capabilities is not
  measured here and would not necessarily cost the same per record.
- One subject plan and two-step historical plans are the shape Batch AL's own scenarios use; a goal with
  eight criteria, or a plan at the eight-step cap, is not what these columns measured.
- This measures what the planning paths cost to run. It is not evidence that a candidate APEX generated
  was a good plan, that a recorded verdict describes the world, or that any model would choose these
  steps: no model was contacted, no inference was run, and no inference was simulated.
- The `XL` interrupted runs are stopped by a throwing `tasks.run` at the same boundary the AM recovery
  child stops at: the records left behind are the plan active, the task pending and no step begun. That
  is the state a dead process leaves, but the process here is this script's own; the real-child claim is
  made by the `recovery` phase, not by `ranking`.
- The Batch AN fixture links backlog plans to the goal id the store returned. Earlier runs of `columns`
  and `attribution` were taken with that link missing, so their absolute figures are historical; the
  Batch AN tables above were taken after the correction. As always, only comparisons inside one run are
  treated as findings.

This script is not part of `npm test` and no test depends on it.

## Adaptation decision benchmark (Batch AP)

`run-adaptation-decision-benchmark.mjs` measures the one stage Batch AP added to `evaluateCandidates`:
the counterfactual decision block that runs the existing Pareto rule a second time over the same
candidate bytes with the `approved_adaptation_fit` dimension removed, so a reader is shown what the
comparison would have said without the approved record. It trains no model, constructs no backend
and builds no application: the comparison is a pure function over synthetic candidates and a
synthetic guidance ledger.

### Procedure

```bash
cd apex_app
node benchmarks/run-adaptation-decision-benchmark.mjs --repeats 15
node benchmarks/run-adaptation-decision-benchmark.mjs --repeats 9 --sizes S
node benchmarks/run-adaptation-decision-benchmark.mjs --before-ref <sha> --repeats 15
```

1. `--sizes` selects any of `S,M,L` (default all three). The growth axes are the candidate count and
   the guidance ledger: **4 / 10 / 20 candidates**, **1 / 6 / 12 approved records**, and
   **2 / 10 / 20 support ids per kind**. The support axis stops at the 20-id bound the decision
   itself applies, because a larger number would measure slicing.
2. The **before** module is the real pre-change code, not a switched-off mode: `git archive` extracts
   `apex_app/src` from `--before-ref` (default `a2c9a64`, the last commit before Batch AP) into a
   fresh temporary directory and imports its `evaluation.js`. Once Batch AP is committed, pass the
   parent commit's SHA. If the ref cannot be materialized the run stops rather than printing
   after-only numbers as a before/after.
3. Both modules are warmed 20 times, then measured **interleaved per sample** on the same fixture
   objects, `--repeats` times each; medians and minima are printed with every sample. The two
   results are compared field by field with `adaptationDecision` removed, so the run also checks
   that the disclosure stage changed nothing else.
4. Nothing is written outside the temp directory; `--keep` leaves it and prints where. The removal
   helper refuses any path that is not one of its own `apex-bench-ap01-` directories.

### What it reports

Per size: the fixture's record/candidate counts, the front with and without the dimension, the
decision outcome (`declined` / `changed` / `applied_not_changed`), the number of rules, evidence ids
and considered records, the before and after comparison medians with samples, the added cost and its
share of the pre-change median, the disclosure render time, and whether the two evaluations agree on
every other field.

### Measured

One run of `--repeats 15` on Windows 11, Node v24.18.0, x64, with no test or other benchmark active.
Fixture contents as above; every candidate passed every gate.

| ms (median) | S (4 candidates, 1 record) | M (10, 6) | L (20, 12) |
|---|---|---|---|
| comparison before (module at `a2c9a64`) | 0.144 | 0.261 | 0.849 |
| comparison after (AP-01) | 0.180 | 0.268 | 1.258 |
| added by the decision disclosure | 0.036 (25.1%) | 0.007 (2.7%) | 0.408 (48.1%) |
| disclosure render | 0.002 | 0.004 | 0.010 |

The fronts moved as the design intends: without the dimension 2 / 4 / 7 candidates were on the front
and none led; with it 1 / 2 / 3 led, all of them the reads-first approaches the record asks for. A
second run of the same command measured the added cost as −0.009 / +0.154 / +0.270 ms, so at four
candidates the added work is within noise and at twenty it is well under half a millisecond.

The finding is narrow: the counterfactual is a second O(n²) pass, but at the candidate counts a
comparison actually sees its absolute cost is under 1.3 ms, against an audited `plan.candidates` read
that spends hundreds of milliseconds in store reads at the same fixture sizes (Batch AM's planning
benchmark). **No cache and no index is justified, and none was added.**

### Interpretation limits

- Medians over 15 samples in one process on one machine. Differences below about 0.05 ms are noise;
  only the before/after pair inside one run is treated as a finding.
- The fixture candidates are synthetic and uniform (two step structures, varied step counts and
  estimated seconds), and the guidance ledger is built to apply rather than conflict. Conflict,
  ineligibility and reversal are covered by `tests/adaptation-decision.test.js`, not measured here.
- The comparison is pure, so this measures the decision stage alone. It does not include the store
  reads, the learning read, rendering the whole comparison, or the audit append that surround it.
- No inference is run or simulated; nothing here shows that an influenced ordering is better work.

This script is not part of `npm test` and no test depends on it.

## Cognitive runtime diagnostics benchmark (Batch AO, package G)

`run-cognitive-runtime-benchmark.mjs` measures the request lifecycle and the stage record it now
produces. It needs no model, no network, and no configured endpoint.

```sh
node benchmarks/run-cognitive-runtime-benchmark.mjs [--repeats R] [--phase answer|proposal|handoff|executive|diagnostics|all] [--keep]
```

`--repeats` is 1-25 and defaults to 9. Every phase writes only into a fresh directory under the OS
temp folder and removes it unless `--keep` is given; the script refuses to remove anything that is
not one of its own prefixed directories.

### Procedure

- `answer` asks one grounded question through the real controller at 0, 20, 200, 800, and 2,000
  seeded records. The reply is fixed text from an in-process backend object, so `model_call`,
  validation, retrieval, claim extraction, and finalization all run their real code.
- `proposal` sends deterministic replies that propose a permitted read, a duplicated proposal, a
  denied write, a malformed proposal, an already-cancelled request, and one transport retry. Only the
  retry row constructs an HTTP backend, and it does so with an injected `fetchImpl` that fails once
  and answers locally.
- `handoff` times `buildPlanActivationHandoff`, completion, the recorded-phase check, and live
  reference validation for 1-, 2-, 4-, and 8-step plans, plus reference validation against 0, 100,
  and 1,000 extra step-operation entries, and the two component hashes separately.
- `executive` runs plan add, approve, and activate (run) for a 1-step and an 8-step plan, then the
  continuation (`work`/`next`) report, reading each figure from the operation's own diagnostics.
- `diagnostics` times a request-shaped `SpanRecorder` workload in isolation, prints the record's key
  list and size over 50 replies, and observes `heapUsed` across 100 further requests.

Timings use `performance.now()`. A duration that was not produced is `null` and prints `n/a`, never
zero. p95 is printed only for at least 20 samples. Warm-up is explicit in the handoff phase (200
builds before measuring); the other phases report every repetition.

### Measured

The package report's before/after tables were produced with `--repeats 9 --phase all` on the same
machine and Node version, with no test or other benchmark running. The controlled baseline was HEAD
plus this package's instrumentation; the only source differences were `memory-store.js` conflict
pairing and `handoff.js` single-hash binding. Results and the reasoning that ties each figure to its
file are in the README section "Batch AO (package G): request diagnostics and the performance they
measured".

### Interpretation limits

- The model is a plain object with a fixed reply. No inference is run, no socket is opened, and no
  endpoint is named. These numbers describe APEX's own pipeline, not a model.
- Nine samples support a median and a min/max but not a p95, so none is printed for the main rows.
- Absolute timings varied up to about 2x between runs of an identical fixture on this machine; only
  comparisons taken inside one controlled run are treated as findings.
- The answer phase's request total is the record's own sum of measured work. Work that runs before
  the recorder's spans (notably the `memory.search` in `handle`) is visible in wall time but not in
  the stage columns; the conflict-pairing improvement therefore shows in wall and total, not in the
  retrieval stage.
- The fixture's records are uniform user facts, which is the shape that makes conflict pairing
  quadratic. A store whose records rarely share a subject does not pay that cost and would not show
  the same difference.
- Memory observation is a single `heapUsed` reading without forced collection; it is not a leak
  measurement.

This script is not part of `npm test` and no test depends on it.
