# Bounded benchmarks

## Local-model benchmark

`run-model-benchmark.mjs` measures the ordinary APEX path (controller, gateway, audit,
conversation write) against one configured loopback model. It sends no request unless
`APEX_BENCH_LIVE=1` is set; otherwise it prints the plan.

### Procedure

1. Reuse an installed model and a server you start for the run. The harness never starts
   a server, downloads a model, or changes a default.
2. Use a fresh temporary APEX data directory. The harness creates one under the OS temp
   folder, gives every sample its own store, and removes it unless `--keep` is passed.
3. Fix the prompt and settings before running. The harness supports four non-sensitive
   prompts (`factual`, `summary`, `arithmetic`, `concise`) and at most four requests per
   run: sample 1 is the cold-planned request, samples 2-4 are warm-planned.
4. Record a readiness check separately; it lists models and runs no inference.

```bash
cd apex_app
APEX_BENCH_LIVE=1 APEX_MODEL_PROVIDER=ollama APEX_MODEL_URL=http://127.0.0.1:11434 \
APEX_MODEL_NAME=<installed-model> APEX_MODEL_TIMEOUT_MS=300000 APEX_MODEL_MAX_TOKENS=1200 \
APEX_MODEL_RETRIES=0 node benchmarks/run-model-benchmark.mjs --requests 4 --out /tmp/bench.json
```

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

This script is not part of `npm test` and no test depends on a model being installed.

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

1. The fixture sizes are capped on purpose: `--memory` is 1-20000, `--claims` is
   1-2000, `--repeats` is 1-25. Larger fixtures were measured once, found to be slow for
   reasons the script already reports, and are not offered as defaults.
2. Memory records are written directly as valid JSONL lines so that seeding does not
   dominate the run; claims are appended through `KnowledgeStore.add`, because that is
   the only path that produces a well-formed claim. Seeding time is therefore reported
   separately from read time.
3. `--keep` leaves the temporary directory in place for inspection; otherwise it is
   removed. Nothing outside the OS temp folder is written.

### What it reports

- store-wide health scan time, projection build time (first run plus min, median and max
  over the repeats), render time, and up to three full `execute` + independent `verify`
  passes through the action layer;
- the numbers the projection actually derived: represented beliefs out of stored records,
  beliefs shown, memory conflict groups, largest group, whether the projection is
  complete and whether it asks for attention, and the rendered display length;
- process RSS and heap before and after, so a leak or an unexpected spike is visible;
- byte length and SHA-256 of every file at the top of the data directory before and after
  the reads, reported as "writes during N reads: none (every store file is
  byte-identical)" only when each one is unchanged;
- the conditions of the run: Node version, platform and architecture, logical CPU count,
  reported total memory, and the fixture sizes with their write cost.

### Interpretation limits

- Fixtures are uniform synthetic text in a one-clause-subject shape, which is the worst
  case for the memory conflict scan; a real store with varied records reads faster.
- Cost is described at the three sizes measured in the main README
  ([Benchmarks](../README.md#benchmarks)) and grows with total records, because each read
  loads and integrity-scans both stores before taking its fixed 100-record window. These
  are single-machine observations at stated fixture sizes, not a scaling guarantee, and no
  concurrent writer is present.
- One repeat counts one process. Timing noise from the operating system is not separated
  out, so treat the median as an indication, not a specification.

This script is not part of `npm test` and no test depends on it.
