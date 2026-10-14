#!/usr/bin/env bash
# Phase 19 step 1 - record state BEFORE any planning artifact is written.
# Read-only: hashes and git queries only. Nothing is written outside this file's
# own stdout redirect.
set -u
cd "E:/My Local AI" || exit 9

echo "PHASE 19 STARTING STATE"
echo "recorded_local: $(date -Iseconds)"
echo

echo "=== GIT ==="
echo "branch: $(git rev-parse --abbrev-ref HEAD 2>&1)"
echo "HEAD  : $(git rev-parse HEAD 2>&1)  ($(git log -1 --pretty=%s 2>&1))"
echo "recent commits:"
git log --oneline -6 2>&1 | sed 's/^/  /'
echo
echo "git status --porcelain (whole repo):"
git status --porcelain 2>&1 | sed 's/^/  /'
echo

echo "=== PRESERVED EVIDENCE: sha256 (actual) vs expected ==="
check() { # path expected
  local p="$1" e="${2:-}"
  if [ ! -f "$p" ]; then printf '  MISSING   %s\n' "$p"; return; fi
  local a; a=$(sha256sum "$p" | cut -d' ' -f1)
  if [ -z "$e" ]; then
    printf '  %s  %s  (no expectation recorded)\n' "$a" "$p"
  elif [ "$a" = "$e" ]; then
    printf '  %s  MATCH     %s\n' "$a" "$p"
  else
    printf '  %s  MISMATCH  %s\n     expected %s\n' "$a" "$p" "$e"
  fi
}

echo "-- B7 paired-sample deliverable (must never change)"
check "work/b7_diag_20261011_paired_capture/run2/paired_samples.csv" \
      "818bf1a541b8115f2393a3da2b912eb3757b7f187199d5e9b60beca4e167998f"
echo
echo "-- historical frozen campaign CSV"
HIST=$(find stark -name '*.csv' -not -path '*/node_modules/*' 2>/dev/null | sort)
echo "  csv files under stark/: ${HIST:-<none>}"
for f in $HIST; do check "$f" ""; done
echo
echo "-- executable that produced the deliverable (version-locked for Phase 19)"
check "stark/build-b7diag-vs2019b/Release/bm_b7_diagnostic.exe" \
      "86ee9f3ee2c1daac8f2815be4516e2ea03fd19273166978cbf09e6d69ca09d88"
echo "-- older WinLibs/MinGW diagnostic build (NOT used in Phase 19)"
check "stark/build-b7diag-20261011/bm_b7_diagnostic.exe" \
      "a2e9e0ada6df0f10a91681e96349349166a081dcca0570312c6d175ad0691bd6"
echo
echo "-- diagnostic source and build basis"
check "stark/src/phase1/diagnostics/bm_b7_diagnostic.cpp" \
      "aeb31eb2250d05e66a805597624db62f7d66090c7e9b5140b38f9c6f5955ca2b"
check "stark/src/phase1/bench/BenchmarkHarness.cpp" \
      "1b37e95f0cc47568839727bc0ef8836397f705255b47fe85ebe4b988867b4414"
check "stark/src/phase1/bench/TinyDenseModel.cpp" \
      "d458e4c9cd8c14bdf340452aa46200c4c0e357989e7cdb536b6bee77eb99f099"
check "stark/src/phase1/bench/TinyDenseModel.h" \
      "05f83b7d0d40dff9ef72bb9407c3c51222193d888a8ff85cb57e71f7acd9479c"
check "stark/CMakeLists.txt" \
      "575fe264921512f41d30267c1c659e3662bbcfd92e71623720f9d047b7dddcc8"
echo
echo "-- predecessor report"
check "work/b7_diag_20261011_paired_capture/phase18_report_timing_order_and_tail.md" ""
echo
echo "=== RUN COUNTS ==="
echo "  files matching */paired_samples.csv (whole repo):"
find . -name 'paired_samples.csv' 2>/dev/null | sed 's/^/    /'
echo "  phase19_runs present? $([ -d work/b7_diag_20261011_paired_capture/phase19_runs ] && echo YES || echo NO)"
