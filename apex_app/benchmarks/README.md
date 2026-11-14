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

- `run-longitudinal-benchmark.mjs` builds every fixture on a `mkdtemp` directory prefixed
  `apex-bench-longitudinal-` and uses the same refusing cleanup. It constructs no backend (`NoBackend`
  behind a `ModelGateway`) and touches no network. Every measured condition runs against its own copy of
  the seeded store (`fs.cpSync`), so no measurement is taken on a store a previous measurement enlarged;
  its partial (analysis / store read / derivation) timings and its complete request timings are printed
  separately and never added together.

- `run-effectiveness-benchmark.mjs` builds every fixture on a `mkdtemp` directory prefixed
  `apex-bench-effectiveness-` with the same refusing cleanup, constructs `NoBackend` (never contacted)
  and touches no network. Each measured condition uses its own seeded directory, and the complete
  request, the partial store/audit reads, and the concurrency runs are printed separately and never
  added together.

- `run-governance-benchmark.mjs` builds every fixture on a `mkdtemp` directory prefixed
  `apex-bench-governance-`, asserts each directory with `assertIsolatedDataDir`, and uses the same
  refusing cleanup. It accepts `APEX_DATA_ISOLATED` unset or `1` and refuses any other value, runs
  each review stage on a fresh copy of the seeded store, constructs `NoBackend` (never contacted) and
  touches no network. Complete stage, partial reads and concurrency runs are printed separately and
  never added together.

- `run-evidence-benchmark.mjs` builds every fixture on a `mkdtemp` directory prefixed
  `apex-bench-evidence-`, asserts each directory with `assertIsolatedDataDir`, and uses the same
  refusing cleanup. It accepts `APEX_DATA_ISOLATED` unset or `1` and refuses any other value,
  constructs `NoBackend` (never contacted) and touches no network. Every measured condition runs on
  identical copied bytes; the retrieval partial is printed separately from the complete actions and
  the two are never added together.

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

## Prediction-informed adaptation benchmark (Batch AP-02)

`run-prediction-adaptation-benchmark.mjs` measures whether the decision path Batch AP-01 built costs
more when part of the approved ledger is prediction-derived. It runs the same pure path
`plan.candidates` and `plan.replan` run — read the approved adaptation ledger, then compare the
candidate bytes — under two conditions over **identical candidates** and the **same total number of
approved records**; only the provenance of some records differs:

- **AP-01 condition:** every record was derived from user feedback and shaped by a guidance record.
- **prediction condition:** `P` of those records were derived from one evaluated prediction each
  (a typed proposal restating the recorded outcome in the same four guidance fields), with a
  separated `support.predictionIds`/`evaluationIds` list and a `predictionEvidence` read.

It trains no model, constructs no backend and builds no application; no cache, index, or validation
skip was added, so the figures describe the existing code rather than a benchmark-only path.

### Procedure

```bash
cd apex_app
node benchmarks/run-prediction-adaptation-benchmark.mjs --repeats 15
node benchmarks/run-prediction-adaptation-benchmark.mjs --repeats 9 --sizes S
```

1. `--sizes` selects any of `S,M,L` (default all three). The axes are the candidate count, the
   number of approved records, and how many of them are prediction-derived:
   **S** 4 candidates / 1 record / 1 prediction / 2 support ids; **M** 10 / 6 / 2 / 10;
   **L** 20 / 12 / 4 / 20.
2. Each condition is rendered 20 times before sampling. Samples are then taken **interleaved per
   sample** (A, B, A, B, …), `--repeats` times each (default 9, capped at 25), and medians, minima
   and every sample are printed.
3. The run also checks that both conditions produced **identical candidate bytes, digests, gates,
   included/excluded sets, binding (`boundTo`) and ranked dimensions**. If they differ, the run
   exits non-zero instead of printing a timing comparison of different work.
4. A second section measures the pure eligibility rule (`predictionEligibility` and `proposalFor`)
   over projections of evaluated predictions at 25 / 100 / 400 records. It reads no ledger and
   caches nothing; it is included to show the per-record rule the store applies, not a decision-path
   cost.

### Measured

One run of `--repeats 15` on Windows 11, Node v26.4.0, x64, with no test or other benchmark active.

| ms (median) | S (4 candidates, 1 record) | M (10, 6) | L (20, 12) |
|---|---|---|---|
| combined ledger read + comparison, AP-01 | 0.201 | 0.262 | 0.687 |
| combined ledger read + comparison, prediction | 0.166 | 0.261 | 0.678 |
| difference (prediction − AP-01) | −0.035 (−17.5%) | −0.001 (−0.5%) | −0.009 (−1.3%) |

For the largest fixture the two components were: ledger read 0.216 (AP-01) vs 0.232 (prediction),
and comparison 0.524 vs 0.448 ms. The disclosure render took 0.004 / 0.004 / 0.009 ms at S / M / L.
Both ledgers applied: the decision's `sources.predictionEvidence` was `none` under AP-01 at every
size, and `prediction_derived` at S and `both` at M and L under the prediction condition; the
prediction records/evaluations applied were 1/1, 2/2 and 4/4.

Eligibility scan over evaluated projections, one process, no ledger read:

| projections | total ms | µs/record | eligible / proposal produced |
|---|---|---|---|
| 25 | 0.112 | 4.476 | 25 / 25 |
| 100 | 0.263 | 2.626 | 100 / 100 |
| 400 | 1.061 | 2.654 | 400 / 400 |

The finding is narrow: within one run the prediction-informed ledger is not measurably slower than
the feedback-only ledger at these sizes, and every difference is smaller than the run-to-run spread.
The eligibility rule is linear in the number of projections at roughly 2.6–4.5 µs per record, with
the higher first figure consistent with a cold first pass.

### Interpretation limits

- Medians over 15 interleaved samples in one process on one machine. Differences below about
  0.05 ms are noise and are reported as measured, not as an improvement; only the in-run pair is a
  finding. Across runs the same numbers move by more than the effect being compared.
- The measured path is pure (ledger read + comparison). **It does not include the AP-02-specific
  store read**: `experience-store.js` re-reads the prediction ledger through `predictions.details`
  for every active prediction-derived row on every adaptation read, so stale evidence cannot remain
  active. Since AP-03 that is one batched ledger read per check rather than one `detail` read per
  cited prediction; that currentness check, its cost, and the experience/audit stores around the
  decision remain excluded here, and are covered by the AP-03 benchmark's complete-request
  measurement and by the test suites for behavior.
- The fixtures are synthetic and uniform, and their prediction-derived rows rest on one current
  prediction/evaluation each. Conflict, ineligibility, staleness, withdrawal and reversal are
  covered by `tests/prediction-adaptation-learning.test.js`, not measured here.
- No inference is run or simulated; nothing here shows that an influenced ordering is better work,
  or that a prediction is accurate. Batch AP-02 claims neither.

This script is not part of `npm test` and no test depends on it.

## Longitudinal outcome benchmark (Batch AP-03)

`run-longitudinal-benchmark.mjs` measures the bounded, read-only longitudinal analysis Batch AP-03
added and the **complete** decision request it can inform. It runs entirely on synthetic histories:
no model, no backend, no network. It has two sections, and their numbers are never added together.

- **Pure analysis.** `analyzeLongitudinal` over increasing synthetic histories (default 20 / 100 /
  500 / 1,000 recorded predictions, one group per 25 records capped at 20 groups), repeating each
  sample and reporting the median, the per-record cost, group/eligible/excluded counts, the pattern
  mix, whether per-group truncation was disclosed, and the report size.
- **Real production path.** A temporary APEX application seeded through the ordinary controller
  actions (evaluations for `memory.add` plus one single-evaluation `memory.list` scope), then three
  things printed separately and labelled *partial*: the store longitudinal read, the authorized
  action, and the derivation that may append a candidate. The **complete** `plan.candidates` request
  is measured separately on byte-identical copies of the store under three conditions: no rule
  approved, the AP-02 single-citation rule approved, and the AP-03 longitudinal rule approved. The
  currentness read that re-judges every citation runs inside every complete request, with nothing
  cached, so it is part of each total rather than a discount.

### Procedure

```bash
cd apex_app
node benchmarks/run-longitudinal-benchmark.mjs
node benchmarks/run-longitudinal-benchmark.mjs --sizes 20,100,500,1000 --real 8,14,19,25 --repeats 7
```

`--repeats` is capped at 15. The real-path default sizes include 25, one above the
`MAX_PREDICTION_CANDIDATES` derivation bound, so the refusal a partial read forces is measured
rather than hidden. Every condition runs on its own `fs.cpSync` copy of the seeded store, so no
measurement is taken on a store a previous measurement enlarged; only the OS temporary directory is
written, and `--keep` leaves it in place.

### What it reports

- pure-analysis median and minimum, µs per recorded prediction, group counts, eligible and excluded
  counts, the pattern mix, whether per-group truncation was disclosed, and report bytes;
- the seeded pattern, eligible/excluded counts and calibration status (available or the exact
  `below 20` reason) for the real store;
- the **partial** store read, authorized action, one derivation, and repeat derivation, labelled as
  partial and not the request cost;
- the **complete** request under no rule / AP-02 rule / AP-03 rule, the median difference of each
  against the no-rule request, the applied/changed flags, the citation count, the decision-block
  bytes, and whether candidate bytes, gates and binding are identical across all three;
- a final consistency check: if the candidate bytes moved, the dimension is wrong, the longitudinal
  rule did not apply and change the comparison, the rule is not labelled `longitudinal_pattern`, the
  citation count is not `min(size, 20)`, or the AP-02-shaped rule does not cite exactly one
  prediction, the run exits non-zero.

### Measured

One run of `--repeats 7` on Windows 11, Node v26.4.0, x64, with no test or other benchmark active.
These are observations of one machine at one time, not targets.

Pure analysis (one group per 25 records, capped at 20 groups):

| recorded predictions | median ms | min ms | µs/record | groups | eligible | excluded | per-group truncation |
|---|---|---|---|---|---|---|---|
| 20 | 0.208 | 0.163 | 10.39 | 1 | 15 | 5 | no |
| 100 | 0.397 | 0.244 | 3.97 | 4 | 71 | 29 | no |
| 500 | 2.738 | 1.847 | 5.48 | 20 | 359 | 141 | no |
| 1,000 | 2.732 | 1.743 | 2.73 | 20 | 719 | 281 | yes |

At 500 and 1,000 records the 20-group cap holds group work constant, so the cost tracks the bounded
number of groups rather than the raw record count; at 1,000 the run says the per-group view was
truncated. The pattern mix at both sizes was `repeated_success:5 repeated_failure:5 mixed_outcomes:10`.

Complete production path, one evaluated capability, identical stores, noise included:

| evaluations | no rule (ms) | AP-02 (ms) | AP-03 (ms) | AP-02 − no rule | AP-03 − no rule |
|---|---|---|---|---|---|
| 8 | 27.662 | 28.207 | 28.894 | +0.545 | +1.232 |
| 14 | 67.984 | 87.111 | 73.791 | +19.128 | +5.807 |
| 19 | 72.465 | 74.717 | 79.607 | +2.251 | +7.142 |

The AP-03 rule applied and changed the comparison at each size, cited `min(size, 20)` predictions
(8 / 14 / 19), and left the candidate bytes, gates and binding byte-identical to the no-rule and
AP-02 conditions. Partial timings at 19 evaluations were: store longitudinal read 11.6 ms, authorized
action 33.4 ms, one derivation 90.5 ms, repeat derivation 43.2 ms - each a piece, none the request.
At 25 evaluations the derivation's read was bounded and it refused a pattern from a partial sequence
(`no longitudinal candidate: ...`), which is a disclosed boundary rather than a benchmark failure.

### Interpretation limits

- Medians over 7 samples in one process on one machine. Differences of a few milliseconds move
  between runs; the in-run comparison against the no-rule condition on the identical store is the
  finding, not the absolute figure. The AP-02 column at 14 evaluations is visibly larger than at 19,
  which is run-to-run noise, not a property of the rule.
- The AP-03 delta includes the complete request: controller work, audit append, independent re-read,
  the guidance read, and the currentness check (one batched ledger read per request, nothing cached).
  The partial lines are printed separately and must not be summed into a request cost.
- Fixtures are uniform synthetic success/failure histories, not a real user's record; they show how
  the bounded analysis scales and that the full path still applies one disclosed influence, not that
  a repeated pattern predicts anything.
- The 1,000-record pure case and the 25-record real case exercise the upper bounds; a production
  store larger than the derivation bound would report truncation and derive no longitudinal
  candidate, by design.

This script is not part of `npm test` and no test depends on it.

## Adaptation effectiveness benchmark (Batch AP-04)

`run-effectiveness-benchmark.mjs` measures the bounded, read-only effectiveness read Batch AP-04
added and the **complete verified request** it is served by. It runs entirely on synthetic fixtures
written through the ordinary controller actions: no model, no backend, no network. It has three
sections, and their numbers are never added together.

- **Linked uses.** One approved rule and, for each use, the full real path — an executive `prepare`
  that records the decision and the plan in one operation, a separate user approval, activation and
  verified execution, goal evidence for each criterion, and the plan's own assessment. Sizes 4 / 12 /
  24 use records; the 24 case exercises the 20-kept-use bound and discloses truncation.
- **Stored adaptations.** 1 / 8 / 20 / 21 stored adaptation records against the same history. The 21
  case exercises the 20-record window: the oldest record is outside it and its uses are honestly
  reported as not read.
- **Concurrent activity.** Two reads issued beside two writes, and four reads beside each other, then
  one serial read on the same store. Nothing is averaged away: a read that refuses to confirm a
  concurrent change is printed with its reason.

The **complete** request is the authorized `adaptation.effectiveness` action: the analysis, the
independent verification that re-runs the whole analysis and compares its digest, the audit append,
and the controller return. The experience-store read, the plan-store read, the audit read and the
pure analysis are printed separately and labelled *partial*; they are not the request cost. No cache
or index is added: every sample of a repeated read pays the same cost.

### Procedure

```bash
cd apex_app
node benchmarks/run-effectiveness-benchmark.mjs
node benchmarks/run-effectiveness-benchmark.mjs --sizes 4,12,24 --adaptations 1,8,20,21 --repeats 7
```

`--repeats` is capped at 15; two warm-up calls are made before each measured series. Every fixture is
built in its own temporary data directory under the OS temp root, and `--keep` leaves it in place.
The script is not part of `npm test`.

### What it reports

- the fixture's JSONL record and byte counts per store; the seeded use's outcome kind and the
  adaptation's classification state;
- **partial** medians for the adaptation-detail read, the plan-store read, the audit read, and the
  pure analysis;
- the **complete** request median, minimum and every sample, plus the read counts it discloses
  (adaptations, plans, audit records, disclosure sites), whether the displayed sample list was
  truncated, the report bytes, and the first and last sample so the growing audit log is visible;
- the number of adaptation rows against the 20-record window, the total uses and evaluated uses, and
  whether a named target fell outside the window;
- concurrent wall times, the number of reads that verified or refused, and the exact refusal reason;
- a final consistency check: a request that does not verify, a report that is not the expected
  schema, wrong use counts, wrong truncation disclosure, a digest that is not deterministic between
  two direct analyses of the same store, or a write that does not verify makes the run exit non-zero.
  A read that honestly refuses because a concurrent write changed the evidence is reported, not
  counted as a failure — the refusal is the designed behavior.

### Measured

One run of `--repeats 7` on Windows 11, Node v26.4.0, x64, with no test or other benchmark active.
These are observations of one machine at one time, not targets.

Complete request, one approved rule, one plan and assessment per use:

| linked uses | median ms | min ms | partial: plan read / audit read / pure analysis (ms) | audit records read | report bytes |
|---|---|---|---|---|---|
| 4 | 52.327 | 48.804 | 1.465 / 3.088 / 27.491 | 61 | 13,395 |
| 12 | 146.657 | 138.360 | 2.844 / 6.412 / 71.400 | 149 | 25,283 |
| 24 | 318.400 | 301.425 | 4.941 / 11.770 / 167.604 | 281 | 25,283 |

Each use adds a plan, a task, conversation and audit records, so both the plan and audit reads grow
with the history; the complete request grew 52 → 147 → 318 ms and the pure analysis 27 → 71 → 168 ms,
about 13 / 12 / 13 ms of complete request per use. The report size stops growing once the displayed
samples are bounded (10 shown, 20 kept). The 24-use case discloses sample truncation and counts 20
kept uses, not an inflated total.

Complete request against stored adaptations on the same 24-use history:

| stored adaptations | median ms | rows reported | uses counted | report bytes |
|---|---|---|---|---|
| 1 | 316.417 | 1 | 20 | 25,249 |
| 8 | 320.387 | 8 | 20 | 40,855 |
| 20 | 337.901 | 20 | 20 | 66,285 |
| 21 | 65.126 | 20 | 0 | 44,543 |

At 21 stored records the named target is outside the newest-20 window, so its uses are not read and
the report says so; the drop from 338 to 65 ms is the lineage of those 20 uses not being walked, not
a faster read of the same work.

Concurrent activity, one 8-use history:

| condition | wall ms | outcome |
|---|---|---|
| two reads + two writes in parallel | 129.499 | both writes verified; both reads `verification_failed` because a write landed between their two reads |
| four reads in parallel | 188.615 | 4 of 4 verified |
| one read, serial | 97.504 | verified |

The read/write refusals are the designed fail-closed answer: the report's digest covers the
audit-record count, so a concurrent append is a real change and the read refuses to confirm it. The
four-read wall time is roughly twice one serial read in this process; no throughput is claimed.

### Interpretation limits

- Medians over 7 samples in one process on one machine. Absolute figures include controller work,
  audit append, the independent re-read and machine noise; the partial lines are pieces, not the
  request.
- Fixtures are synthetic success histories with one approved rule; they show how the bounded read
  scales and that the full path continues to describe an association, not that any rule improves
  outcomes.
- The digest covers the audit-record count, so a direct analysis of one store state cannot be
  compared with a request made after another record was appended. The benchmark compares two direct
  analyses of the same state for determinism, and relies on the action's own verification for the
  across-append re-read.
- A read beside a write can verify-fail by design: the second read sees the new record and refuses to
  confirm the first. The concurrency section reports that instead of hiding it.

## Adaptation governance benchmark (Batch AP-05)

`run-governance-benchmark.mjs` measures the complete production review path Batch AP-05 added: the
read-only list, then open, inspect, reconcile and decide (`keep_active`), each served by the authorized
action, its independent verification re-running the whole analysis, the audit append, and the
controller return. It runs entirely on synthetic fixtures written through the ordinary controller
actions: no model, no backend, no network. It has three sections, and their numbers are never added
together.

- **Linked uses.** One approved rule and, for each use, the full real path (executive `prepare`, a
  separate user approval, activation, verified execution, goal evidence per criterion, and the plan's
  own assessment). Sizes 4 / 12 / 24 use records. Each stage is sampled on a fresh copy of the seeded
  directory so the open, inspect, reconcile and decide actions can each perform their real write
  without the earlier stages' records changing the fixture mid-series.
- **Stored adaptations.** 1 / 8 / 20 / 21 stored adaptation records against the same 24-use history.
  The 21 case exercises the 20-row window: the target's row is not reported and its uses are
  honestly reported as not read.
- **Concurrent activity.** Two reads issued beside two writes, four reads beside each other, and one
  serial read on the same store. A read that refuses to confirm a concurrent change is printed with
  its reason rather than averaged away.

The **complete** stage is the authorized action plus its verification, audit append and controller
return. The governance builder, the single-adaptation detail read and the review preparation are
printed separately and labelled *partial*; they are not the request cost. No cache or index is added:
every sample pays the same cost.

### Procedure

```bash
cd apex_app
APEX_DATA_ISOLATED=1 node benchmarks/run-governance-benchmark.mjs
APEX_DATA_ISOLATED=1 node benchmarks/run-governance-benchmark.mjs --sizes 4,12,24 --adaptations 1,8,20,21 --repeats 5
```

`--repeats` defaults to 5 and is capped at 10. Every data directory is asserted to be under the OS
temp root with the `apex-bench-governance-` prefix, and cleanup refuses any other path; `--keep`
leaves the directories in place. The script is not part of `npm test`. Run it alone: concurrent tests
would change every wall-clock figure.

### What it reports

- the fixture's JSONL record and byte counts per store, the seeded use's outcome kind, and the
  adaptation's classification state;
- **partial** medians for the governance builder, the single-adaptation detail read, and the review
  preparation, plus the prepared evidence and detail sizes in bytes;
- **complete** medians, minima and every sample for list, open, inspect, reconcile and decide, plus
  the evidence digest equality each stage checks;
- the number of adaptation rows against the 20-row window and whether a named target fell outside it;
- concurrent wall times, whether every read and write verified, and the exact refusal reason when a
  read declines to confirm a concurrent change;
- a final consistency check: a stage that does not verify, a report that is not the expected schema,
  `authorizes` not `false`, a wrong row count or window disclosure, an evidence digest that differs
  from the live one, or a `keep_active` decision that records a retirement makes the run exit non-zero.

### Measured

One run of `--repeats 5` on Windows 11, Node v26.4.0, x64, with no test or other benchmark active.
These are observations of one machine at one time, not targets.

Complete stage medians, one approved rule, one plan and assessment per use:

| linked uses | list ms | open ms | inspect ms | reconcile ms | decide keep_active ms | partial: builder / detail / prepare ms |
|---|---|---|---|---|---|---|
| 4 | 166.276 | 151.712 | 338.739 | 240.928 | 163.890 | 27.628 / 33.947 / 32.698 |
| 12 | 474.227 | 445.081 | 667.049 | 632.501 | 345.750 | 240.475 / 296.247 / 279.935 |
| 24 | 995.981 | 640.061 | 1,231.229 | 1,160.686 | 608.471 | 476.930 / 585.049 / 536.281 |

The prepared evidence bundle was 7,536 bytes at 4 uses and 16,539 bytes at 12 and 24: it is capped at
20 evidence references, so it stops growing once the bound is reached. The audit log grows by one
record per stage, so every later sample is served from a slightly larger store. The spread between
samples within one figure is large (for example 97–180 ms for the 4-use list), which is why only
in-run comparisons are treated as findings.

Complete list request against stored adaptations on the same 24-use history:

| stored adaptations | median ms | rows reported | target read |
|---|---|---|---|
| 1 | 967.757 | 1 | yes (`no_review_required`) |
| 8 | 997.409 | 8 | yes |
| 20 | 1,049.925 | 20 | yes |
| 21 | 82.096 | 20 | no — outside the newest-20 window |

At 21 stored records the named target is outside the window and is not reported; the drop from about
1,050 to 82 ms is the lineage of its 24 uses not being walked, not a faster read of the same work.

Concurrent activity, one 8-use history:

| condition | wall ms | outcome |
|---|---|---|
| two reads + two writes in parallel | 401.122 | both writes verified; both reads verified; 0 refusals |
| four reads in parallel | 470.019 | 4 of 4 verified |
| one read, serial | 331.192 | verified |

Unlike the AP-04 read, these reads did not observe the concurrent writes between their two reads in
this run, so none refused. That is a property of the timing, not a guarantee: the report digest covers
the audit-record count, so a write that lands between the two reads is still a real change and is
reported as a failed verification. The four-read wall time is one and a half times one serial read in
this process; no throughput is claimed.

### Interpretation limits

- Medians over 5 samples in one process on one machine, on synthetic success histories with one
  approved rule. Absolute figures include controller work, audit append, the independent re-read and
  machine noise; the partial lines are pieces, not the request.
- Each stage performs its own analysis and verification, so these are the costs of five different
  production requests, not of one request repeated. They are not additive.
- The fixtures show how the bounded review path scales and that it continues to describe evidence;
  they are not evidence that any rule improves outcomes, that a review is needed, or that a
  recommendation is correct.
- At 21 stored adaptations the target is not listed; the lower figure is less work on a smaller
  visible scope, not an optimization.
- A read beside a write can verify-fail by design. The concurrency section reports what it observed,
  and a refusal is the designed fail-closed answer rather than a benchmark failure.

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

## Evidence fabric benchmark (Batch AP-06)

`run-evidence-benchmark.mjs` measures what a cross-store read window costs and what the complete
cross-store reads cost at increasing store size. It starts no child process and constructs no backend.

```sh
APEX_DATA_ISOLATED=1 node benchmarks/run-evidence-benchmark.mjs [--records 100,1000,4000] [--repeats R] [--keep]
```

`--repeats` is 1-10 and defaults to 5. `APEX_DATA_ISOLATED` must be unset or `1`; any other value is
refused. Every directory is a fresh `apex-bench-evidence-` entry under the OS temp root, asserted with
`assertIsolatedDataDir`, and cleanup refuses any path that is not its own.

### Procedure

- The base fixture is built through the ordinary controller actions: two user corrections derive and
  approve one rule, one goal is prepared into a plan, approved, activated and executed, each criterion
  is evidenced, and the plan is assessed. Synthetic memory records are then appended directly as valid
  JSONL at 100 / 1,000 / 4,000 records, each fixture copied so no measurement is taken on a store a
  previous measurement enlarged.
- For each size the script times, separately: the window open and verify alone (partial), the
  integrity report alone (partial), the complete `evidence.integrity` request (two windows, verify,
  audit), cognitive retrieval called directly (partial - a free-form request cannot reach retrieval
  under `NoBackend`, which answers `model_unavailable` before the model call), the complete
  `adaptation.effectiveness` request and the complete `adaptation.reviews` request.
- The cost of the window itself is measured by alternating the same effectiveness analysis with and
  without a window on identical bytes, three times each, so the comparison is in-run rather than
  across runs.
- A second section stores 20 then 21 adaptations and reads the complete effectiveness request, which
  checks that the clipped window is disclosed rather than silently applied.
- A third section issues an integrity read, a write, an effectiveness read and another write in
  parallel, then four integrity reads in parallel beside one serial read. It reports every refusal
  reason. Any complete read that does not verify, any report with `authorizes` not `false`, any state
  that is not `consistent`, or a missing truncation disclosure makes the run exit non-zero.

### Measured

One run of `--records 100,1000,4000 --repeats 5` on Windows 11, Node v26.4.0, x64, with no test or
other benchmark active. Medians with the min-max spread in brackets; the nine stores held 146 /
1,046 / 4,046 records.

| Complete request | 100 records | 1,000 records | 4,000 records |
|---|---|---|---|
| `evidence.integrity` | 20.874 [16.839–22.310] | 23.557 [21.974–24.750] | 33.475 [32.574–41.450] |
| `adaptation.effectiveness` | 31.488 [31.122–32.470] | 39.410 [37.968–44.840] | 57.463 [56.148–69.020] |
| `adaptation.reviews` | 34.899 [34.026–36.330] | 40.961 [40.781–44.450] | 56.906 [56.672–59.340] |
| cognitive retrieval (partial) | 12.999 [9.945–36.870] | 21.281 [20.359–22.230] | 58.103 [56.139–63.600] |

Partial pieces, for attribution only - none is a request: window open and verify alone took 1.071 /
0.719 / 0.778 ms, and the integrity report alone took 9.990 / 11.361 / 14.775 ms.

The window itself, on identical bytes:

| memory records | effectiveness without a window | with the window | delta |
|---|---|---|---|
| 100 | 15.107 | 15.008 | -0.098 |
| 1,000 | 15.780 | 16.413 | +0.633 |
| 4,000 | 25.215 | 26.168 | +0.953 |

The delta is within the sample noise at 100 records and stays around a millisecond at 4,000: the
window is one `stat` pair per store, so its cost is per store rather than per record. The growth in
the complete requests is in parsing and lineage, not in certification.

Adaptation window, complete effectiveness request:

| stored adaptations | median ms | rows reported | integrity | truncated |
|---|---|---|---|---|
| 20 | 33.211 | 20 | `valid` | false |
| 21 | 32.706 | 20 | `valid_bounded` | true (`adaptations`) |

Concurrent activity:

| condition | wall ms | outcome |
|---|---|---|
| integrity + write + effectiveness + write | 122.670 | both writes verified; both reads refused (`verification_failed`) with their reasons |
| four integrity reads in parallel | 66.256 | 4 of 4 verified |
| one integrity read, serial | 29.115 | verified |

### Interpretation limits

- Medians over five samples in one process on one machine, on a synthetic history with one approved
  rule. Absolute figures include controller work, audit appends, the independent second read and
  machine noise. The partial lines are pieces, not requests.
- `NoBackend` answers `model_unavailable` before retrieval, so the complete grounded request cannot be
  measured without inference. Retrieval is therefore measured as a direct partial, and no figure here
  is a model latency.
- The retrieval partial reached 15 evidence records at every size with zero dropped and zero
  unavailable sources, so the growth shown is store parsing and retrieval across the same bounded
  result, not a larger answer.
- The window delta is a difference of medians on the same fixture; at 100 records it is smaller than
  the sample spread, so it is reported as noise rather than a saving.
- The 21-adaptation read is not faster or slower evidence: it reports one bounded window over 20 rows
  and names the clipped source. The row count is the same by design.
- A read beside a write can verify-fail by design. The refusal is the fail-closed answer, not a
  benchmark failure; four reads issued beside each other verified because each action's audit line
  lands after its own second window.
- The fixture stores synthetic prose; nothing here is evidence that a rule improves outcomes or that
  any report is true.

This script is not part of `npm test` and no test depends on it.

## Evidence consistency benchmark (Batch AP-07)

`run-consistency-benchmark.mjs` measures the AP-07 consistency work on the paths it changed: content
certification of a window, the integrity report, cognitive retrieval, world-state certification, the
longitudinal read, the complete read actions, per-operation snapshot reuse, and cold versus warm
reads. Each integrated consumer is measured beside the read shape it had before AP-07, on the same
bytes in the same run.

```sh
APEX_DATA_ISOLATED=1 node benchmarks/run-consistency-benchmark.mjs [--records 100,1000,4000] [--repeats R] [--keep]
```

`--repeats` is 1-10 and defaults to 5; partial module calls use three samples. `APEX_DATA_ISOLATED`
must be unset or `1`. Every directory is a fresh `apex-bench-consistency-` entry under the OS temp
root, asserted with `assertIsolatedDataDir`, and cleanup refuses any path that is not its own.

### Procedure

- The base fixture is built through the ordinary controller actions: two user corrections derive and
  approve one rule; one goal is prepared into a plan, approved, activated and executed; each criterion
  is evidenced; the plan is assessed. Synthetic memory records are then appended directly as valid
  JSONL at 100 / 1,000 / 4,000 records, each fixture copied so no measurement is taken on a store a
  previous measurement enlarged. The nine stores hold 135 / 1,035 / 4,035 records.
- For each size the script times, separately: a content window and a metadata-only window over all
  nine stores; the integrity report alone; the complete `evidence.integrity` request (its own two
  windows, verify, audit); cognitive retrieval; world-state construction; goal assessment without a
  window; and the complete `plan.candidates`, `prediction.longitudinal`, `plan.outcome`,
  `adaptation.effectiveness` and `adaptation.reviews` requests.
- Cognitive retrieval is measured in **three arms** on the same stores and query: the AP-06 shape
  (`retrieveEvidence` performs its own per-source reads), a control that performs the same two
  searches up front and hands them in as seeds with no window, and the AP-07 shape that performs the
  same reads through one content-certified window and passes its verdict. The control separates the
  cost of the seeded read plan from the cost of certification; without it, run-to-run variation in
  the memory search looks like window cost.
- The longitudinal analysis is measured separately over in-memory projections at 20 / 200 / 1,000
  records with and without a window verdict (the fixture's own ledger records no evaluated
  expectations, so the complete read's ledger-backed analysis is empty and is disclosed as such).
- One section reads the same label twice inside one window against two windows that each read it
  once; one section measures the first read in a freshly assembled application (cold) against later
  reads (warm) on a second fresh application, and times application assembly once, separately.
- Any complete read that does not verify, any report with `authorizes` not `false`, any window that
  is not `consistent`, any control arm that is not `unverified`, or a missing truncation disclosure
  makes the run exit non-zero.

### Measured

One run of `--records 100,1000,4000 --repeats 5` on Windows 11, Node v26.4.0, x64, with no test or
other benchmark active. Medians with the min-max spread in brackets. Wall-clock figures vary between
runs on this machine; see the interpretation limits.

Partial pieces, for attribution only - none is a request:

| Partial | 100 records | 1,000 records | 4,000 records |
|---|---|---|---|
| window open + verify, content (9 stores) | 1.853 [1.807-2.852] | 2.478 [2.433-2.552] | 15.422 [14.904-17.376] |
| window open + verify, metadata only | 0.886 [0.797-2.164] | 0.830 [0.825-0.834] | 4.374 [3.189-4.529] |
| certification cost of the bytes | +0.967 | +1.648 | +11.049 |
| integrity report (window + health) | 7.721 [7.272-8.050] | 10.834 [10.404-14.454] | 50.265 [45.875-68.837] |
| goal assessment (no window) | 5.705 [5.458-6.708] | 13.860 [13.583-20.107] | 6.573 [5.349-8.544] |

Cognitive retrieval, three arms on the same stores:

| Arm | 100 records | 1,000 records | 4,000 records |
|---|---|---|---|
| stores read directly (AP-06 shape) | 10.201 [9.519-10.501] | 17.152 [16.604-33.144] | 109.210 [96.946-119.620] |
| the same reads seeded, no window (control) | 9.710 [9.168-10.849] | 17.523 [17.391-45.838] | 104.090 [87.990-106.034] |
| through one certified window (AP-07 shape) | 11.481 [10.534-11.912] | 20.278 [15.765-57.730] | 119.478 [111.412-144.116] |
| seeded read plan (control over AP-06) | -0.491 | +0.371 | -5.119 |
| window + verdict (AP-07 over control) | +1.771 | +2.755 | +15.388 |
| window + verdict, total (AP-07 over AP-06) | +1.280 | +3.126 | +10.268 |

The window over the control tracks the standalone content-window cost (+1.8 / +2.8 / +15.4 ms against
+1.0 / +1.6 / +11.0 ms of pure certification): the added cost is hashing the contributing bytes at the
two inspections, not the read plan. At every size retrieval returned 15 evidence records with 2
dropped by a bound.

World-state construction and the analytic read:

| Path | 100 records | 1,000 records | 4,000 records |
|---|---|---|---|
| world-state build, unwindowed | 3.645 [3.632-3.801] | 14.486 [14.443-17.004] | 23.150 [22.088-27.256] |
| world-state build + window + certify | 6.505 [6.457-6.758] | 24.205 [23.163-28.528] | 39.125 [35.926-40.644] |
| window + certification on the projection | +2.860 | +9.719 | +15.975 |
| longitudinal analysis, no window | 0.190 (20 projections) | 1.032 (200) | 3.256 (1,000) |
| longitudinal analysis, window verdict | 0.166 | 1.077 | 3.894 |
| longitudinal delta | -0.024 | +0.045 | +0.638 |

The world-state projection is cut at `WORLD_RECORD_LIMIT` (20 of 100 beliefs shown) at every size, so
its read is `truncated` and certification never promotes its completeness.

Complete read actions, each opening and verifying its own window and appending its own audit line:

| Complete request | 100 records | 1,000 records | 4,000 records |
|---|---|---|---|
| `evidence.integrity` | 21.703 [20.627-22.630] | 25.945 [24.649-28.048] | 133.148 [113.486-171.666] |
| `plan.candidates` | 22.697 [22.260-23.964] | 64.149 [57.563-67.784] | 70.137 [67.041-101.085] |
| `prediction.longitudinal` | 10.038 [9.626-11.507] | 26.776 [24.888-45.100] | 30.007 [28.634-30.730] |
| `plan.outcome` | 33.731 [31.648-36.267] | 128.042 [117.025-151.305] | 154.588 [125.839-171.446] |
| `adaptation.effectiveness` | 35.736 [33.358-36.292] | 150.116 [89.828-216.613] | 158.947 [141.912-197.830] |
| `adaptation.reviews` | 33.593 [31.622-35.222] | 150.788 [108.781-237.191] | 122.495 [115.356-153.671] |

Per-operation reuse and cold/warm:

| Measure | Result |
|---|---|
| one window, the same label read twice | 13.918 [13.726-16.259] |
| two windows, each reading the label once | 46.500 [43.605-48.238] |
| `evidence.integrity`, fresh application (cold) | 36.865 |
| `evidence.integrity`, later reads (warm median) | 43.072 [25.789-77.747] |
| `plan.outcome`, fresh application (cold) | 45.295 |
| `plan.outcome`, later reads (warm median) | 45.694 [35.876-52.864] |
| `prediction.longitudinal`, fresh application (cold) | 9.653 |
| `prediction.longitudinal`, later reads (warm median) | 11.307 [10.732-11.980] |
| application assembly, one fresh app | 2.165 |

### Interpretation limits

- Medians over one run in one process on one machine. The complete reads show a wide within-run
  spread at 1,000 and 4,000 records (for example `adaptation.effectiveness` 89.8-216.6 ms at 1,000),
  and repeated runs of the same fixture moved the complete `evidence.integrity` median between 48 and
  133 ms at 4,000 records. Those figures are descriptive observations, not targets; only the in-run
  paired and three-arm comparisons are treated as findings.
- The direct retrieval median at 1,000 records ranged 17-42 ms across three runs of this section on
  the same fixture. That is why the control arm exists: at 1,000 records it moved by -5 to +0.4 ms
  against the AP-06 shape, while the window over it moved by +2.8 to +9.3 ms. An earlier two-arm run
  that did not have the control showed +22 ms and was read as noise in the search, not as window
  cost.
- `NoBackend` answers `model_unavailable` before the model call, so the complete grounded request
  cannot be measured without inference. Retrieval is measured as a direct partial on the same stores
  and query; no figure here is a model latency.
- "Cold" is the first read of a store in a freshly assembled application in this process, with the
  OS file cache already warm. On this machine the cold read was not slower than the warm median for
  any of the three measured reads; the warm spread is larger than the difference, so no cold penalty
  is claimed.
- The longitudinal sweep uses in-memory synthetic projections; the fixture's own ledger holds no
  evaluated expectations, so the complete longitudinal request analyses an empty ledger and says so.
- The world-state projection is truncated by its own record limit at every size, so its completeness
  is false and certification is measured as overhead, not as a move to complete.
- The fixture stores synthetic prose. Nothing here shows that a rule improves outcomes, that a
  projection is true, or that any report authorizes an action.

This script is not part of `npm test` and no test depends on it.

## Grounded response integrity benchmark (Batch AP-08)

`run-response-integrity-benchmark.mjs` measures the AP-08 request-to-response path: the complete
deterministic request through the real controller, the trust assessment and fourteen-stage contract
in isolation, and repeated identical requests. The model is a deterministic in-process fixture that
returns one fixed `COGNITION` line citing a seeded record; nothing is inferred, downloaded, or sent.

```sh
APEX_DATA_ISOLATED=1 node benchmarks/run-response-integrity-benchmark.mjs [--repeats R] [--phase request|assessment|record|all] [--keep]
```

`--repeats` is 1-25 and defaults to 9. Every directory is a fresh `apex-bench-ap08-` entry under the
OS temp root and cleanup refuses any path that is not its own. No backend or socket is constructed;
the gateway wraps the fixture object, so the real classification, validation, trust and audit code
runs against a controlled reply. `APEX_DATA_ISOLATED` is not consulted by the script itself, but it
is set by convention so the fixture cannot fall back to a real data directory.

### Procedure

- The `request` phase seeds small / medium / large memory and knowledge histories (20 / 200 / 1,000
  records). The filler history is never re-seeded, so a larger row measures retrieval over a larger
  store rather than a different question. One exact target record is added last and cited by the
  fixture reply. Two warm-up requests are run per size and not measured; the recorded samples are
  the wall time of `controller.handle`.
- Before measuring, the warm-up reply must reach `factually_supported`; otherwise the script throws
  instead of measuring a different path.
- The `assessment` phase calls `assessResponseIntegrity` and `buildResponseContract` directly on
  synthetic analyses holding 6 / 24 / 36 evidence records (the retrieval budget), for a plain reply
  and for a structured grounded reply. 200 measured iterations follow 20 warm-ups per row. The two
  functions are timed together and separately; neither figure includes a store read or a model call.
- The `record` phase repeats the identical request and compares the stored integrity audit and the
  contract skeleton (stage orders, ids, statuses, checks, authority statement; the operation request
  id and the growing retrieval counts are excluded, because each request appends a conversation turn
  that later requests retrieve as evidence). It also reports the stored audit size.

### Measured

One run of `--repeats 9` on Windows, Node v26.4.0, x64, with no test or other benchmark active,
taken on the final tree. Medians with min-max spread in parentheses; p95 is not printed below 20
samples.

Complete request, one grounded reply through the controller:

| Memory+knowledge records | Wall per request | Retrieved evidence | Status | Trust | Contract reached |
|---|---|---|---|---|---|
| 20 | 34.277 ms (30.838-38.243) | 10 | `verification_unavailable` | `factually_supported` | 14, `ok: true` |
| 200 | 155.318 ms (130.618-269.474) | 10 | `verification_unavailable` | `factually_supported` | 14, `ok: true` |
| 1,000 | 336.757 ms (317.894-380.249) | 10 | `verification_unavailable` | `factually_supported` | 14, `ok: true` |

`verification_unavailable` is the outcome of a grounded answer with no action to verify, not a
failure: the fixture proposes nothing. Retrieval stays at 10 evidence records at every size because
the per-source and total retrieval bounds apply, so the growth is the stores' search and parse cost,
not a larger evidence set.

Assessment and contract in isolation, microseconds per iteration:

| Evidence | Reply | Assess + contract | Assess | Contract | Min | Max |
|---|---|---|---|---|---|---|
| 6 | plain | 27.20 | 6.80 | 20.15 | 22.80 | 1,922.60 |
| 6 | structured | 40.35 | 19.90 | 20.10 | 36.30 | 3,186.50 |
| 24 | plain | 23.10 | 6.30 | 16.55 | 20.40 | 2,177.10 |
| 24 | structured | 31.50 | 14.50 | 16.50 | 25.20 | 2,326.60 |
| 36 | plain | 17.90 | 3.30 | 14.60 | 16.30 | 2,169.80 |
| 36 | structured | 22.65 | 10.20 | 12.10 | 17.90 | 4,376.40 |

The medians are tens of microseconds against requests measured in tens to hundreds of milliseconds.
The maxima are one-iteration outliers from JIT and garbage collection; garbage collection is not
forced, so they are observations, not a tail measurement.

Repeated identical requests:

| Measure | Result |
|---|---|
| distinct integrity audits over 9 requests | 1 |
| distinct contract skeletons (request id and counts excluded) | 1 |
| retrieved records, first to last request | 8 -> 10 (conversation turns accumulate) |
| stored integrity + contract skeleton size | 2,270 bytes |

### Interpretation limits

- The fixture reply is fixed synthetic prose. These figures measure APEX's handling of a controlled
  reply; they say nothing about the quality, truthfulness, or latency of a real model.
- One run on one machine. Wall-clock figures vary between runs; only in-run comparisons are treated
  as findings, and the assessment rows have enough noise that only their medians are meaningful. A
  repeat run on the same tree moved the 200-record request median by about 17% and changed only the
  outlier maxima in the assessment rows; the ordering across sizes and the millisecond/microsecond
  separation did not change.
- The complete request includes the controller, retrieval, claim extraction, prompt construction,
  the fixture model call, validation, assessment, contract, audit append and conversation write.
  It is not a model latency and it is not comparable to the live model-endpoint benchmark.
- The 20 / 200 / 1,000 histories are memory and knowledge prose. No world-model, plan, prediction or
  experience history is seeded, so those stores are read but hold no records.
- Repeated requests are not byte-identical in context: each appends a conversation turn that later
  requests retrieve. The determinism claim covers the assessment and the contract's decisions, not
  the accumulated evidence count.

This script is not part of `npm test` and no test depends on it.

## Semantic validation benchmark (Batch AP-09)

`run-semantic-validation-benchmark.mjs` measures the AP-09 semantic check: the complete deterministic
request at 20 / 200 / 1,000 / 4,000 records, the attribution, semantic, response-consistency,
integrity and contract functions in isolation, claim-count scaling, and eleven adversarial rows
through the real controller. The model is a deterministic in-process fixture returning one fixed
`COGNITION` line that cites the seeded target record; nothing is inferred, downloaded, or sent.

```sh
node benchmarks/run-semantic-validation-benchmark.mjs [--repeats R] [--phase request|components|adversarial|all] [--sizes 20,200,1000,4000] [--adversarial-size 200] [--keep]
```

`--repeats` is 1-15 and defaults to 7. Every directory is a fresh `apex-bench-ap09-` entry under the
OS temp root, and cleanup refuses any path that is not its own. No backend or socket is constructed:
the gateway wraps the fixture object, so retrieval, structured-reply validation, attribution,
semantic assessment, response consistency, the trust ladder, the response contract and the handoff
all run through their real code paths.

### Procedure

- The `request` phase seeds a memory and knowledge history of the requested size, adds one target
  record last, and runs the same grounded question through `controller.handle`. Filler history is
  never re-seeded, so a larger row measures retrieval and assessment over a larger store, not a
  different request. Warm-ups are run but not measured.
- The history fixture names the same three words the request asks about (`lighthouse`, `project`,
  `status`). This is deliberate: knowledge search scores are IDF-weighted, and at 4,000 records a
  filler record sharing only a generic word falls below the fixed 0.2 prompt-relevance floor, which
  would drop every knowledge record from the prompt and make the evidence column non-comparable
  between rows. Naming the asked words keeps the target above the floor at every size. The floor
  itself is unchanged.
- The `components` phase calls `assessClaimAttribution`, `assessClaimSemantics`,
  `assessResponseConsistency`, `assessResponseIntegrity` and `buildResponseContract` directly on
  synthetic analyses with 6 / 24 / 36 evidence records (the retrieval budget), for a claim that
  restates its record and a claim that reverses it. 200 measured calls per function per row follow 20
  warm-ups. Each function is timed on its own; the integrity figure re-runs attribution and semantic
  assessment internally, so the columns are not additive and none includes a store read or a model
  call. The claim-scaling section holds evidence at 36 records and grows one response from 1 to 12
  claims (the structural bound).
- The `adversarial` phase runs ten contradiction fixtures plus a supported control, each through the
  complete controller at `--adversarial-size` records (default 200). It checks the trust state, the
  summary semantic finding, the stated limitations, whether a notice is present, and that no class
  reaches `factually_supported` or `verified`.

### Measured

One run of `--repeats 9` on Windows, Node v26.4.0, x64, 12 logical CPUs, 24 GiB, with no test or
other benchmark active, taken on the final tree. Medians with min-max spread in parentheses; p95 is
not printed below 20 samples.

Complete request, one grounded reply through the controller:

| Memory+knowledge records | Wall per request | Retrieved evidence | Status | Trust | Semantic finding | Contract reached |
|---|---|---|---|---|---|---|
| 20 | 40.534 ms (38.475-51.796) | 10 | `verification_unavailable` | `factually_supported` | `semantically_consistent` | 14, `ok: true` |
| 200 | 59.911 ms (54.739-63.597) | 10 | `verification_unavailable` | `factually_supported` | `semantically_consistent` | 14, `ok: true` |
| 1,000 | 171.308 ms (145.844-175.234) | 10 | `verification_unavailable` | `factually_supported` | `semantically_consistent` | 14, `ok: true` |
| 4,000 | 747.173 ms (726.916-782.416) | 10 | `verification_unavailable` | `factually_supported` | `semantically_consistent` | 14, `ok: true` |

Retrieval stays at ten evidence records at every size because the per-source and total retrieval
bounds apply, so the growth is the stores' search and parse cost. `verification_unavailable` is the
outcome of a grounded answer with no action to verify, not a failure: the fixture proposes nothing.

Components in isolation, microseconds per call (median, 200 measured calls after 20 warm-ups):

| Evidence | Reply | Attribution | Semantic | Consistency | Integrity | Contract |
|---|---|---|---|---|---|---|
| 6 | consistent | 8.00 | 98.60 | 37.25 | 149.70 | 26.05 |
| 6 | adversarial | 7.40 | 83.05 | 33.60 | 127.35 | 23.20 |
| 24 | consistent | 5.60 | 84.45 | 32.20 | 127.35 | 21.30 |
| 24 | adversarial | 5.20 | 69.80 | 30.90 | 108.35 | 15.70 |
| 36 | consistent | 5.00 | 73.65 | 29.30 | 108.00 | 16.20 |
| 36 | adversarial | 5.60 | 73.80 | 31.95 | 112.90 | 14.90 |

The adversarial reply is summarised as `polarity_conflict` in the integrity column; the consistent
reply is `semantically_consistent`. The integrity figure re-runs attribution and semantic
assessment internally, so the columns are not additive.

Claim-count scaling at 36 evidence records:

| Claims | Integrity median | Response finding | Assessed | Contradictions |
|---|---|---|---|---|
| 1 | 104.00 us | `semantically_consistent` | 1 | 0 |
| 4 | 435.80 us | `polarity_conflict` | 4 | 4 |
| 8 | 846.00 us | `polarity_conflict` | 8 | 6 |
| 12 | 1,224.45 us | `polarity_conflict` | 12 | 6 |

Every side is a constant bound (12 claims, 6 compared pairs); the growth is the per-claim
comparison, not an unbounded scan.

Adversarial rows through the complete controller at 200 records:

| Class | Wall median | Trust | Semantic finding | Limitation | Notice |
|---|---|---|---|---|---|
| control: exact restatement | 47.072 ms | `factually_supported` | `semantically_consistent` | n/a | no |
| polarity reversal | 49.407 ms | `accepted_for_presentation` | `polarity_conflict` | `semantic_polarity_conflict` | yes |
| changed quantity | 49.408 ms | `accepted_for_presentation` | `numerical_conflict` | `semantic_numerical_conflict` | yes |
| bound stated as an exact value | 51.262 ms | `accepted_for_presentation` | `numerical_conflict` | `semantic_numerical_conflict` | yes |
| changed date | 47.969 ms | `accepted_for_presentation` | `temporal_conflict` | `semantic_temporal_conflict` | yes |
| swapped entity | 49.191 ms | `accepted_for_presentation` | `entity_conflict` | `semantic_entity_conflict` | yes |
| reversed relationship | 47.939 ms | `accepted_for_presentation` | `relationship_conflict` | `semantic_relationship_conflict` | yes |
| widened quantifier | 47.820 ms | `accepted_for_presentation` | `qualifier_conflict` | `semantic_qualifier_conflict` | yes |
| added cause | 47.204 ms | `accepted_for_presentation` | `unsupported_transformation` | `semantic_unsupported_transformation` | yes |
| unestablished meaning | 47.201 ms | `accepted_for_presentation` | `ambiguous` | `semantic_ambiguous` | yes |
| omitted quantity | 47.707 ms | `accepted_for_presentation` | `partially_consistent` | `semantic_partial` | yes |

Every contradiction class stayed at presentation with a stated limitation; the supported control
reached factual support. No class reached `verified`, which no path can.

### Interpretation limits

- The fixture text is fixed synthetic prose and each attack class is worded to be decidable by a
  finite rule. These figures measure APEX's handling of controlled replies; they say nothing about
  the quality, truthfulness, or latency of a real model, and nothing about whether the rules would
  detect a naturally worded claim.
- One run on one machine. Wall-clock figures vary between runs and the component rows have enough
  noise that only their medians are meaningful. On the identical code tree, an earlier full run
  produced 34.578 / 137.155 / 322.083 / 1,498.995 ms per request and semantic medians of 121-163 us,
  while this final run produced 40.534 / 59.911 / 171.308 / 747.173 ms and 74-99 us. Both are
  observations, not a latency specification, and only in-run comparisons are treated as findings.
- The complete request includes the controller, retrieval, claim extraction, prompt construction,
  the fixture model call, validation, semantic assessment, contract, audit append and conversation
  write. It is not a model latency and is not comparable to a live model-endpoint benchmark.
- A size row adds one target record plus filler history; the filler is never re-seeded. The 4,000
  row therefore measures a much larger store read, which dominates the request cost.
- The semantic check reads at most six records per claim, twelve claims and six pairs per response.
  A record outside the retrieval, or a claim beyond those bounds, is not checked and is reported as
  such.

This script is not part of `npm test` and no test depends on it.

## Retrieval quality benchmark (Batch AP-10)

```sh
node benchmarks/run-retrieval-quality-benchmark.mjs
node benchmarks/run-retrieval-quality-benchmark.mjs --sizes 20,200,1000,4000,10000 --repeats 9
node benchmarks/run-retrieval-quality-benchmark.mjs --phase scoring
```

Network-free. The model is a deterministic in-process fixture object implementing the same small
backend interface the HTTP backends implement; it returns fixed synthetic text. No inference is run,
no socket is opened, no endpoint is named, and no model quality is claimed. Fixtures are written
through the stores' own validated write paths into a fresh temporary directory prefixed
`apex-bench-ap10-`, which is removed at the end unless `--keep` is passed.

### What it measures

| Phase | Subject | Sizes |
| --- | --- | --- |
| `normalize` | `queryTokens` alone, per query class: token count, dropped count, wall time | size-independent |
| `scoring` | the absent-term weight before (uncapped AP-09 IDF) and after (capped AP-10), and the resulting score against the fixed 0.2 floor | every requested size |
| `retrieval` | `memory.search` and `knowledge.search` separately, five query classes, returned counts, top and tail score | every requested size |
| `context` | `buildPrompt` over the retrieved hits: assembly time, surviving line counts, dedup and omission disclosures; plus size-independent contradiction-preservation and deduplication checks | every requested size |
| `request` | one grounded question through the complete controller path: wall time, trust state, retrieval read state, claim-attribution counts, the retrieval report state with per-source returned/contributed counts, and the citation-completeness counts | every requested size |

Five query classes are reported **separately and never averaged**: `common` (every term in every
record), `rare-token` (one term absent from the whole store — the class that exposed the AP-09 defect),
`long` (380 unrelated words plus three relevant ones), `adversarial` (a negation), and `no-result`
(no term present). Each store ends with **exactly** the number of records its row states: the two
target records are part of that count, fillers are added only up to it, and the row is refused if the
persisted counts disagree. A size smaller than the current corpus rebuilds a fresh isolated directory
instead of measuring the larger one. Two target records are added once per corpus.

The `scoring` phase is a before/after comparison of the **weighting policy on identical document
frequencies**, computed from the same formula the stores use. It is not a comparison of two builds of
the application, and it is printed apart from the latency phases so the two are never conflated.

### Measurement rules

- Timings are monotonic (`performance.now`). Two warm-up calls per row are run but not measured.
- Median, min and max are printed with the sample count. p95 is printed only at 20 or more samples.
- A duration that was not produced is `null`, never zero, and prints as `n/a`.
- Default repeats 7, maximum 15. Default sizes 20, 200, 1000, 4000; 10000 is available via `--sizes`
  and is slower because seeding is a validated append per record.
- Never run this benchmark concurrently with another benchmark or with the test suite: the rows are
  wall-clock timings and contention invalidates them.

### Measured results (Batch AP-10 run — request and context rows SUPERSEDED)

One run of `--sizes 20,200,1000,4000,10000 --repeats 7 --phase all`, on the final AP-10 tree, with no
other benchmark and no test suite running. Node v26.4.0 on win32 x64, 12 logical CPUs, 24 GiB reported
memory. Every row below is from that single run; nothing is averaged across runs and no figure is
carried over from an earlier batch.

> **Superseded by Batch AP-11.** That run shared one corpus across phases and `growTo()` only ever
> grew it. The `retrieval` phase ran first and grew the corpus 20 → 10000, so its rows are valid. The
> `context` and `request` phases then asked for 20, 200, 1000, 4000 and 10000 in turn and **every one
> of those rows measured the 10000-record corpus the retrieval phase had left behind**. Their size
> labels are wrong, and the conclusion drawn from them — that request latency is flat across corpus
> sizes and dominated by a size-independent cost — is **invalid**. The corrected benchmark rebuilds an
> isolated corpus per row and verifies the persisted record count before measuring; see
> [Batch AP-11](#runtime-performance-benchmark-batch-ap-11) below for the corrected request and context
> measurements. The historical rows are preserved here, marked invalid, not deleted.

The corpus was grown monotonically within the retrieval phase, so a larger row there is the same
corpus plus fillers rather than a different fixture. Two target records were added once, on top of the
stated filler count, so the retrieval rows describe `size + 2` memory and `size + 1` knowledge records
rather than exactly `size`. Fillers share the common query terms; the `rare-token` class asks for one
term that occurs in no record; `long` is 380 unrelated words plus three relevant ones; `adversarial`
is a negation; `no-result` shares no term with the store.

**Normalization is size-independent and never truncated these queries.** Token counts: `common` 3,
`rare-token` 3, `long` 383, `adversarial` 4, `no-result` 3; `dropped` 0 in every class, so
`MAX_QUERY_TOKENS = 4096` was not reached. `not completed` normalizes to `[task, not, complet]` and
`completed` to `[task, complet]` — the negation survives. `ap-10`, `2026-06-01` and `v1.2` are kept
whole alongside their split parts.

**The absent-term defect and its fix, on identical document frequencies.** Query terms: `lighthouse`
and `status` in every record, `project` in none. Fixed floor 0.2; `MAX_UNSEEN_TERM_WEIGHT = 4`.

| records | before weight | after weight | before score | after score | before floor | after floor |
| --- | --- | --- | --- | --- | --- | --- |
| 20 | 3.7377 | 3.7377 | 0.3486 | 0.3486 | kept | kept |
| 200 | 5.9965 | 4.0000 | 0.2501 | 0.3333 | kept | kept |
| 1000 | 7.6019 | 4.0000 | 0.2083 | 0.3333 | kept | kept |
| 4000 | 8.9874 | 4.0000 | 0.1820 | 0.3333 | **excluded** | kept |
| 10000 | 9.9036 | 4.0000 | 0.1680 | 0.3333 | **excluded** | kept |

At 20 records the uncapped weight is still below the cap, so before and after are byte-identical — the
fix changes nothing where the defect did not reach. From 200 records up the cap binds and the score
stops moving. This is one fixture, not a claim of general retrieval quality.

**Normalization wall time** (size-independent, median over 7 samples): `common` 10.40 µs
(4.80–15.80), `rare-token` 3.40 µs (3.40–4.60), `long` 170.10 µs (159.50–218.70), `adversarial`
3.30 µs (3.20–42.20), `no-result` 3.00 µs (2.10–12.00). The `long` class costs about 16× the `common`
class because it normalizes 383 tokens; it is never subtracted from a request time.

**Per-source retrieval, median wall time in milliseconds.** The source limit is 5 per search, so a
class returning 5 may be truncated and the count alone does not say so.

| class | source | 20 | 200 | 1000 | 4000 | 10000 |
| --- | --- | --- | --- | --- | --- | --- |
| common | memory | 1.767 | 11.812 | 14.263 | 65.180 | 236.067 |
| common | knowledge | 1.119 | 7.399 | 13.951 | 47.236 | 255.476 |
| rare-token | memory | 1.148 | 9.269 | 14.783 | 60.792 | 227.029 |
| rare-token | knowledge | 0.909 | 8.278 | 11.694 | 89.898 | 199.164 |
| long | memory | 2.747 | 17.914 | 30.466 | 228.637 | 683.810 |
| long | knowledge | 1.976 | 10.636 | 19.683 | 159.992 | 772.439 |
| adversarial | memory | 1.163 | 8.477 | 14.241 | 99.405 | 234.629 |
| adversarial | knowledge | 0.891 | 8.530 | 8.980 | 72.095 | 195.546 |
| no-result | memory | 0.730 | 4.949 | 6.047 | 42.390 | 97.256 |
| no-result | knowledge | 0.601 | 5.090 | 6.127 | 52.407 | 116.595 |

Returned counts are identical at every size: `common` 5/5, `rare-token` 5/5, `long` 1 memory and 0
knowledge, `adversarial` 5/5, `no-result` 0/0 (memory/knowledge). Retrieval is a full scan, so the
median grows with the corpus; the `long` class is the most expensive because every one of its 383
tokens is weighted against every record. The growth is **not monotonic at every size in this run** —
the 1000-record row is faster than the trend, and at 4000 records `rare-token` knowledge (89.898 ms)
is slower than memory (60.792 ms) while at 10000 the order reverses. These are single-run medians on a
shared machine, not a fitted scaling law, and no per-size ordering is claimed.

Scores, kept apart from latency: `common` tops and tails at 1.0000 in both stores at every size.
`rare-token` tops at 1.0000; its memory tail falls 0.1618 → 0.0927 → 0.0714 → 0.0596 → 0.0537 and its
knowledge tail 0.4406 → 0.2904 → 0.2353 → 0.2023 → 0.1851, so at 10000 the fifth knowledge record is
below the 0.2 floor while the target still ranks first. `adversarial` tops at 0.6262–0.6879 (memory)
and 0.5510–0.5849 (knowledge). `long` is the known weakness stated below: memory retrieves the exact
match and ranks it first at 0.0055 (20 records) and 0.0078 (200 and above), which is below the floor,
so it is excluded from the prompt and reported as `below_relevance_threshold`; knowledge returns
nothing at all.

**Context assembly — SUPERSEDED, every row measured 10000 records** (`buildPrompt` over the retrieved
hits): median 0.132 ms at the row labelled 20, then 0.064 / 0.061 / 0.083 / 0.048 ms at the rows labelled
200 / 1000 / 4000 / 10000. Those labels are not the corpora measured; the spread between them is
single-run noise on one 10000-record corpus, not a size effect. The prompt is 983 characters with
memory 1/1 and knowledge 5/5 lines surviving, 0 duplicates collapsed and 0 records omitted — the budget
was not reached, so there was nothing to disclose. Two size-independent checks ran beside it and are
unaffected by the corpus defect: with both sides of a disagreement retrieved the contested marker is
present, and after a budget that keeps only one side the marker is *still* present and the omission is
disclosed; three retrieved triples of which two are identical collapse to 2 lines with 1 collapse
disclosed and the disagreeing triple surviving.

**The complete request path — SUPERSEDED, every row measured 10000 records.** One grounded question,
median wall time over 7 samples:

| row label | median | range | trust | read state | actual corpus |
| --- | --- | --- | --- | --- | --- |
| 20 | 2222.288 ms | 2110.479–2464.019 ms | factually_supported | bounded_usable | **10000, invalid** |
| 200 | 2211.550 ms | 2098.968–2317.982 ms | factually_supported | bounded_usable | **10000, invalid** |
| 1000 | 2192.306 ms | 2150.544–2233.452 ms | factually_supported | bounded_usable | **10000, invalid** |
| 4000 | 2181.647 ms | 2080.679–2220.243 ms | factually_supported | bounded_usable | **10000, invalid** |
| 10000 | 2197.148 ms | 2070.635–2230.813 ms | factually_supported | bounded_usable | 10000, valid |

Only the last row describes the corpus its label states. The five medians are five measurements of the
same 10000-record store, which is why they agree; they are **not** evidence that latency is independent
of corpus size.

The classification and completeness findings are unaffected by the size defect, because they were all
observed on the same corpus: 1 factual claim, 1 directly supported, 0 partial attribution, 0
unattributed. The retrieval report was `source_limit_reached` with `complete false` and window
`consistent`: memory returned 5 of more matches and contributed 1, knowledge returned 3 and contributed
1, conversation contributed 4 and temporal 1, and the remaining sources are named as not searched rather
than omitted. The citation assessment found 1 claim, 0 citations outside the snapshot, **1 relevant
retrieved record left uncited**, 0 one-sided conflicts, bounded true. The uncited record is disclosed,
not force-cited, and the claim's support was not upgraded because of it.

`factually_supported` is APEX's own bounded lexical classification of a fixed synthetic reply, not a
verification of truth.

### What it does not establish

- Retrieval here is bounded lexical token overlap weighted by inverse document frequency. It is **not
  semantic understanding**, not entailment and not natural-language inference. A synonym absent from
  the record text, a paraphrase, an implication or a coreference is not resolved.
- One fixture is not evidence of general retrieval quality. The five classes are reported apart, and
  no single overall quality number is computed from them.
- The `long` class measures a known weakness rather than a success: the score denominator sums every
  query term, so a long request dilutes its own exact match below the prompt floor. The record is
  still retrieved and still citable; it does not enter the prompt. That exclusion is reported as
  `below_relevance_threshold`, never as "no match".
- The request phase measures APEX's own classification of a fixed synthetic reply. It says nothing
  about a real model's answer quality, and `factually_supported` is a bounded lexical verdict, not a
  verification of truth.

This script is not part of `npm test`. Since Batch AP-11 one test imports its corpus builder —
`tests/benchmark-corpus-size.test.js` proves that the size a row reports is the size the request
measured — but no test runs a measurement, and importing the module never starts one.

## Runtime performance benchmark (Batch AP-11)

```sh
node benchmarks/run-runtime-performance-benchmark.mjs
node benchmarks/run-runtime-performance-benchmark.mjs --phase scaling --sizes 20,200,1000,4000,10000 --repeats 5
node benchmarks/run-runtime-performance-benchmark.mjs --phase shapes --shape-size 200
node benchmarks/run-runtime-performance-benchmark.mjs --phase limits
```

Network-free, deterministic in-process model fixture, real controller, real persisted stores. It reuses
the corrected corpus builder from the retrieval-quality benchmark, so a row labelled `size` holds
exactly `size` records in each store and the count is verified against the persisted files before the
row is measured. Temporary directories are prefixed `apex-bench-ap10-` and removed unless `--keep`.

### What it measures

| Phase | Subject |
| --- | --- |
| `scaling` | one grounded question at each size, **cold** (a fresh application per sample, so no parse snapshot and no derived lifecycle entry exists) and **warm** (one application, repeated requests, first discarded as warm-up). Median/min/max wall time, the per-stage trace, store read counts, lifecycle-index construction and reuse counts, parse-snapshot hits and misses, and process memory. |
| `shapes` | ten request shapes, each on its own isolated corpus: simple factual, memory-only, knowledge-only, multi-source, conflicting, long query, empty store, large knowledge store, goal/plan, executive preview. Reported apart, never averaged. |
| `limits` | the bounded-read disclosure ladder: the same question over corpora holding 1, 3, 5, 6, 10, 20 and 40 matching records, reporting returned/matched/eligible/contributed, the exclusion counts, the retrieval state and whether completeness was established. |

### Measured results (corrected harness)

Environment: Node v26.4.0, win32 x64, 12 logical CPUs, 24 GiB reported memory, Windows 10.0.26300.
Every row is a real controller request against a temporary store whose persisted count is verified
before measurement (the printed line names both counts). Repeats 5. The fillers share one subject and
relationship, so they form a single conflict group and conflict annotation must name every partner —
the worst case for that cost, stated rather than hidden.

**Scaling, sequential runs.** The same script on two trees: the pre-AP-11 tree extracted with
`git archive`, and the working tree. These are complete-run medians, not paired samples. Cold rows should
be unaffected by the change, so their spread (for example 492.0 ms before and 581.0 ms after at 1,000)
estimates the run-to-run drift that also affects the warm rows.

| records per store | before cold | before warm | after cold | after warm |
| --- | --- | --- | --- | --- |
| 20 | 45.0 (38.9–181.0) | 35.6 (33.5–37.8) | 127.0 (124.7–264.6) | 37.5 (33.3–39.3) |
| 200 | 211.2 (182.4–321.2) | 174.6 (164.8–224.9) | 181.2 (179.6–256.6) | 148.8 (144.3–158.0) |
| 1,000 | 492.0 (406.0–506.0) | 385.5 (366.1–467.4) | 581.0 (464.0–688.1) | 488.0 (422.5–937.4) |
| 4,000 | 1,389.3 (891.1–1,434.6) | 1,320.0 (1,250.5–1,344.0) | 1,441.3 (1,313.1–1,544.4) | 1,218.9 (1,193.2–1,249.6) |
| 10,000 | 3,764.9 (3,675.6–3,942.3) | 3,513.6 (3,475.3–3,981.8) | 3,897.6 (3,764.8–4,098.5) | 3,527.8 (3,461.5–3,632.3) |

All values are milliseconds: median, min–max over 5 samples. The 10,000 after-row was measured in a
separate run of the same script (`--sizes 10000`) after the combined run stopped during its corpus
build; its corpus was rebuilt and verified independently, and the pre-existing 10,000 row was kept.

**Scaling, paired.** Both trees on one seeded corpus, alternating requests (six per tree), so machine
drift cannot be read as a code effect. Absolute values are higher than the table above because two
applications share one process and one conversation log that grows with every request; only the
within-pair comparison is meaningful.

| records per store | before | after | delta | answer surface |
| --- | --- | --- | --- | --- |
| 1,000 | 676.7 | 672.8 | −0.6% | identical |
| 4,000 | 2,640.5 | 2,441.0 | −7.6% | identical |

"Identical answer surface" means status, trust, retrieval state, completeness, claim counts and
per-source returned/contributed counts were equal. The reuse itself is counted, not inferred: over two
requests the working tree reports `builds 1, hits 3, misses 1; health builds 1, hits 1` at every size,
while the pre-AP-11 tree has no such counters (`n/a`). Store read counts are size-independent: per two
requests, six `log.load` calls each for memory, knowledge and experience, two searches and two
projection reads per store, and two `getMany` reads per store. The number of reads does not grow with
the corpus; the cost of each does.

**Where the request time goes.** The ten measured diagnostic stages sum to about 11.8 ms of the
benchmark's 488.0 ms warm request at 1,000 records (2.4%) and about 5.5 ms of 3,527.8 ms at 10,000
(0.2%): the stage trace covers only part of the path. A separate instrumented probe — timed wrappers on
a distinct application, whose per-call values are inflated by the wrappers and by GC, so it ranks costs
rather than summing to the request — attributes the rest, in order, to `knowledge.projectionRead`
(whole-log load, store-wide health, window annotation), `memory.search` and `knowledge.search`
(tokenizing every record), the six whole-store `log.load` calls (each returns isolated copies of every
record), and `getMany` plus the small executive reads. That residual is the measured lower bound this
batch does not move: the sub-second target at 10,000 would require an inverted or persistent index over
record content, which §5 forbids without measured justification and which would be a storage-behaviour
change rather than a read-path tightening.

**Targets.** Small store (<300 ms): met warm (37.5 ms). 1,000 (<500 ms): met warm under this
benchmark's single-application conditions (488.0 ms), not cold (581.0 ms), and the paired run puts the
steady state near 670 ms when two applications share the process. 10,000 (<1 s): not met (3.53 s warm).
Targets are objectives, reported as measured rather than as guarantees.

**Memory.** At 10,000 records the after-run reports rss 146.2 → 264.2 MiB and heapUsed 34.3 → 107.3 MiB
across the cold samples and the counted reads. The retained derived state is one entry per store
instance, replaced on any content change; it holds indexes, not record copies.

**Query shapes.** Ten shapes, each on its own isolated corpus, warm, five samples. One run; shapes are
reported apart and nothing is averaged across them. Fixture build time is excluded from the request
measurement (it ranged from 0.1 ms to 17.2 s and is harness setup, not runtime cost).

| shape | corpus memory/knowledge | warm median (min–max) | verdict |
| --- | --- | --- | --- |
| simple factual | 2 / 1 | 37.1 (35.6–40.0) | `factually_supported`, `bounded_results` |
| memory-only | 1 / 0 | 33.5 (28.4–36.3) | `factually_supported`, `bounded_results` |
| knowledge-only | 0 / 1 | 28.7 (28.2–32.8) | `accepted_for_presentation`, `bounded_results` |
| multi-source | 1 / 1 | 31.9 (30.4–32.2) | `factually_supported`, `bounded_results` |
| conflicting | 1 / 2 | 31.7 (28.6–32.6) | `factually_supported`, `bounded_results` |
| long query (3,816 chars) | 199 / 198 | 202.3 (182.4–211.8) | `received`, `bounded_results`; memory 1 returned/0 contributed |
| empty store | 0 / 0 | 99.1 (82.9–154.0) | `accepted_for_presentation`, `bounded_results` |
| large knowledge store | 1 / 199 | 151.7 (141.8–199.8) | `factually_supported`, `source_limit_reached`; knowledge 3/3, 196 limit-excluded |
| goal/plan | 2 / 1 | 113.8 (92.0–150.2) | `plan_rejected` (the fixture reply carries no plan proposal; nothing stored) |
| executive preview | 2 / 1 | 28.0 (26.6–30.9) | `success_verified` |

Three results deserve the caveats rather than a reading. The **long query** normalizes 383 tokens and
is the only shape above 100 ms; its one retrieved memory record scored below the relevance floor, so it
was returned but contributed nothing. The **goal/plan** shape measures the plan request through
validation and rejection: the in-process fixture returns prose, never a `plan_create` proposal, so the
real runtime correctly refused it and stored nothing — this is not a measurement of the accepted-plan
path. The **empty store** median (99.1 ms) is higher than every small populated shape (28–37 ms) in the
same run and its range is the widest; with five samples on a shared machine, that is unexplained
run-to-run variability, not a claim that an empty store is slower. No shape is averaged into another
and no overall latency or quality number is computed from them.

**Source-limit disclosure ladder.** The same question over a 200-record corpus per store holding
1, 3, 5, 6, 10, 20 or 40 matching records. Fillers share no content word with the question, so
`matched` counts exactly the sewn records and every exclusion is attributable to a named bound.
Warm, five samples. Nothing in this ladder widens a bound; it reports what each existing bound
excludes.

| matching | memory ret/mat/eli/con | memory limit-excluded | knowledge ret/mat/eli/con | knowledge limit-excluded | prompt knowledge lines | overall state | warm median (min–max) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1/1/1/1 | 0 | 1/1/1/1 | 0 | 1 | `bounded_results` | 167.9 (154.7–448.2) |
| 3 | 3/3/3/3 | 0 | 3/3/3/3 | 0 | 3 | `bounded_results` | 158.8 (156.1–206.9) |
| 5 | 5/5/5/5 | 0 | 3/5/3/3 | 2 | 3 | `source_limit_reached` | 163.4 (142.0–187.9) |
| 6 | 5/6/5/5 | 1 | 3/6/3/3 | 3 | 3 | `source_limit_reached` | 154.6 (140.1–165.2) |
| 10 | 5/10/5/5 | 5 | 3/10/3/3 | 7 | 3 | `source_limit_reached` | 169.5 (128.0–276.4) |
| 20 | 5/20/5/5 | 15 | 3/20/3/3 | 17 | 3 | `source_limit_reached` | 150.5 (145.2–267.3) |
| 40 | 5/40/5/5 | 35 | 3/40/3/3 | 37 | 3 | `source_limit_reached` | 146.0 (139.4–181.0) |

`ret/mat/eli/con` are returned, matched, eligible and contributed. The binding windows are smaller
than the evidence layer's own six-record per-source bound, because the answer path pre-reads both
stores and seeds the evidence read from what it already chose: memory evidence inherits the
five-record memory search window, and knowledge evidence inherits the three-record prompt knowledge
window (`KNOWLEDGE_PROMPT_LIMIT`, the same window whose lines the prompt carries). So the prompt
never shows more than three knowledge lines, and the report's knowledge exclusions count records
the three-record window cut — not records a six-record bound would have kept.

The state change point is exact. At 1 matching record both sources report `complete_with_results`
and completeness true. At 3, memory still does (3 < 5) but knowledge reports `bounded_results`:
a window that returned exactly its limit cannot establish that nothing else matched. From 5
onward both sources report `source_limit_reached` with completeness false, and the
limit-excluded counts grow one-for-one with the matching records. The overall state stays
`bounded_results` at 1 and 3 only because other sources (world, experience, feedback, adaptation,
goal, plan, task) are also read under bounds; from 5 the knowledge and memory exclusions raise it
to `source_limit_reached`. Warm time does not grow with the number of matches (146–170 ms across
all rows); the 448 ms maximum in the first row is one outlier in the first measured row, not a
size effect. What grows is the disclosed exclusion count, which is the point.

### Measurement rules

- Timings are monotonic (`performance.now`). Default repeats 5, maximum 15.
- **Latency is measured on an uninstrumented application.** Read and construction counts are collected
  afterwards on a separate instrumented application, so no counting wrapper sits inside a timed request.
- **Cold means cold application state, not cold disk.** The operating system's file cache is warm, so a
  cold row measures construction and first-read cost, not device latency.
- A duration or count that was not produced is `null` and prints `n/a`, never zero. The pre-AP-11 tree
  has no derived-state reuse and therefore reports no construction counters; those cells are `n/a`.
- Before/after comparisons run the same script, the same corpora and the same repeats on two trees: the
  committed pre-AP-11 tree extracted with `git archive`, and the working tree. Nothing is averaged
  across runs and no figure is carried over from an earlier batch.
- Never run this benchmark concurrently with another benchmark or with the test suite.

### What it does not establish

- A fixture reply is not a model answer. `factually_supported` is APEX's own bounded lexical
  classification of fixed synthetic text, not a verification of truth.
- One corpus composition is not a scaling law. The fillers share one subject and relationship, so they
  form a single growing conflict group: that is a **worst case** for conflict annotation, and a store
  whose claims are spread over many subjects behaves differently. Both are reported where measured.
- The ten shapes are reported apart. No overall latency or quality number is computed from them.
