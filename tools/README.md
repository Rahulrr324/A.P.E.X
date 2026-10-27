# Developer validation (not APEX Intelligence / not acceptance)

Python 3.10+, standard library only. Default engine requires CMake/CTest. The
explicit `compiler` engine requires a GCC-compatible driver and never substitutes
for a missing CMake pass.

```sh
python3 tools/check_target_manifest.py
python3 -m unittest discover -s tools/tests -v
python3 tools/validate.py --output /tmp/apex-cmake-001 --repeat 2
python3 tools/validate.py --engine compiler --output /tmp/apex-gcc-001 --include-programs --repeat 3
python3 tools/validate.py --engine compiler --build-type Debug --output /tmp/apex-debug-001
python3 tools/validate.py --engine compiler --sanitize undefined --output /tmp/apex-ubsan-001
python3 tools/validate.py --engine compiler --sanitize address --output /tmp/apex-asan-001
APEX_NATIVE_BIN=/tmp/apex-gcc-001/bin python3 -m unittest discover -s tools/tests -v
```

Every output directory must be **new and outside the source**. Existing files
are never cleaned or overwritten. Use `--source` to point to an isolated clean
clone. The tool does not make clones, switch branches, fetch, commit or push.
`--target NAME` restricts work; diagnostics/drivers are only compiled, never run.
`--include-programs` builds research/diagnostic targets as well; compiler checks
use the reviewed manifest, while CMake gets the corresponding ON options.

## What is recorded

- Tool command arguments, cwd, actual exits, elapsed times and full stdout/stderr.
- Build and execution as separate results; platform SKIP and failed-build NOT_RUN.
- Missing dependencies as BLOCKED, timeouts as TIMEOUT, zero selected CTests as failure.
- SHA-256 input snapshots, with a failing integrity result if source changes mid-run.
- `report.json` and `FILES.sha256` for the generated logs/report.

Every test invocation has its own cwd; gate fixtures are copied into that cwd.
Shared sources compile once per distinct flag set, without reusing old objects.
No unknown command string is passed through a shell. This is trusted developer
source, **not a sandbox for untrusted C++ tests**.

`check_target_manifest.py` checks only the simple source-list/foreach/library
subset used by this repository. It rejects unsupported source expressions; it is
not a CMake interpreter and does not validate generator/platform/link-option
semantics. CMake remains authoritative.

The native Python integration/property tests SKIP unless `APEX_NATIVE_BIN` points
to built binaries. With that variable set, a missing binary is a failure, not a
skip. Windows multi-configuration CMake builds usually need `.../cmake/Release`;
compiler-engine binaries are under `.../bin`.

Reports may expose local build paths and record filenames. Keep logs local until
reviewed for privacy. No credentials, process environment or conversation content
are intentionally captured. The manual GitHub workflow does not run on push and
requires an owner's explicit dispatch/runner-cost decision.
