#!/usr/bin/env bash
# Usage: build_and_test_report.sh [build-dir] [new-report-file]
# No campaigns/drivers are executed. No dependency installation is attempted.
set -u
set -o pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)" || exit 1
BUILD_DIR="${1:-$REPO_ROOT/build}"
mkdir -p -- "$BUILD_DIR" || exit 1
BUILD_DIR="$(cd -- "$BUILD_DIR" && pwd)"
SHA="$(git -C "$REPO_ROOT" rev-parse HEAD)"
REPORT="${2:-$BUILD_DIR/build_report_${SHA:0:12}_$(date -u +%Y%m%dT%H%M%SZ).txt}"
mkdir -p -- "$(dirname -- "$REPORT")" || exit 1
# Never overwrite an earlier report, including one from the same second.
(set -C; : > "$REPORT") 2>/dev/null || { echo "Refusing existing report: $REPORT" >&2; exit 1; }
log() { printf '%s\n' "$*" | tee -a "$REPORT"; }
run() {
    local label="$1"; shift
    log "=== $label"
    printf '$ ' >> "$REPORT"; printf '%q ' "$@" >> "$REPORT"; printf '\n' >> "$REPORT"
    "$@" >> "$REPORT" 2>&1
    local rc=$?
    log "exit_code=$rc ($label)"
    return "$rc"
}
log "STARK/APEX build/test report"
log "commit=$SHA"
log "dirty_entries=$(git -C "$REPO_ROOT" status --porcelain -uall | wc -l)"
log "host=$(uname -srm)"
log "build_dir=$BUILD_DIR"
missing=0
for tool in cmake ctest c++; do
    if command -v "$tool" >/dev/null 2>&1; then
        run "$tool version" "$tool" --version || missing=1
    else
        log "BLOCKED: $tool unavailable; command lookup exit=1"
        missing=1
    fi
done
if [ "$missing" -ne 0 ]; then
    log "Configure/build/CTest NOT RUN: prerequisite unavailable."
    exit 127
fi
run configure cmake -S "$REPO_ROOT/stark" -B "$BUILD_DIR" -DCMAKE_BUILD_TYPE=Release || exit $?
run build cmake --build "$BUILD_DIR" --parallel || exit $?
# CTest --test-dir is newer than the project's declared CMake 3.15 minimum.
cd -- "$BUILD_DIR" || exit 1
run "registered tests (not execution)" ctest -N || exit $?
if ! grep -Eq '^[[:space:]]*Total Tests:[[:space:]]+[1-9][0-9]*[[:space:]]*$' "$REPORT"; then
    log "No registered tests found; refusing an empty successful test run."
    exit 1
fi
run "tests actually executed" ctest --output-on-failure || exit $?
log "Build and CTest completed with exit=0. This is not acceptance."
