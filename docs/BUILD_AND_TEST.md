# Build and test

The build root is `stark/`, not the repository root. Requirements: C++17 compiler,
CMake >= 3.15, CTest. GCC >=9 is recommended for standard filesystem support;
this session's native checks used GCC 12.2. No external C++ libraries or model
weights are required. Python >=3.10 is needed only for developer tooling.

```sh
cmake -S stark -B /tmp/apex-build -DCMAKE_BUILD_TYPE=Release
cmake --build /tmp/apex-build --config Release --parallel 2
(cd /tmp/apex-build && ctest -C Release --output-on-failure)
```

Use a native path on Windows. `--config`/`ctest -C` matter for multi-configuration
generators. GNU-only static runtime options are conditioned on both Windows and
GNU; the Windows SDK libraries remain Windows-only. Windows execution must still
be independently verified.

## Inventory

The reviewed source manifest has **58 executable targets**, including **29** genuine
automated suites on Windows, **28** elsewhere. These include three new Phase-1
suites: helper-record compatibility, append-only store safety and JSON codec.

Six Windows-only targets are guarded with explicit messages: affinity test, two
affinity investigation programs, two frequency diagnostics and power-scheme
control. `test_params` and the two investigation programs are not registered as
automated tests. CTest registrations are not themselves execution evidence.

The older readiness plan counted 22 unregistered executables but excluded three
non-suites: the actual existing suites added are 19. Current totals add the three
new suites above. No acceptance criterion or metric threshold was adjusted.

`STARK_BUILD_RESEARCH_DRIVERS` and `STARK_BUILD_DIAGNOSTICS` default OFF and exclude
those programs from the default build only. Their targets remain individually
addressable. Automated tests and record tooling stay in the default build.

`test_neuron` retains assertions even in Release. Other suites use explicit
failure counters/CHECK. Every registered test has a 180-second CTest timeout.

## Working directories and generated state

CMake/CTest retains the historical `stark/` working directory. Four persistence
suites now create `build/dev_bin` themselves; their assertions and saved paths
are unchanged. `Network::save` was not modified. CTest may create ignored scratch
files in the disposable checkout; do not run it against frozen evidence trees.

The explicit compiler engine instead creates a separate cwd per invocation and
copies only `fixtures/controlled-valid` for the gate suite. That dependency is
reported and preserved, not weakened to pass. Objects/binaries/reports live
outside the source and source integrity is checked before/after validation.

## Reproduction and limitations

`tools/validate.py` emits JSON results, complete command logs and SHA-256 file
manifest. It refuses a reused output directory. `stark/scripts/build_and_test_report.sh`
is an alternative Bash report wrapper for CMake. Neither downloads dependencies.

This environment has no CMake/CTest, so direct GCC checks do **not** establish a
clean CMake configure, generated target graph, Windows build or CTest pass.
The manual-only GitHub workflow is available for a separately authorized hosted
check, but was not dispatched and consumes no runner minutes merely by pushing.

Compatibility tests compare whole serialized B6/B7/B9 records against test-only
original helper bodies. They are not official baseline arms or acceptance runs;
the unmodified original CLI was ill-formed on GCC. Details of the allowed
normalization are in `test_phase1_helper_equivalence.cpp`.
