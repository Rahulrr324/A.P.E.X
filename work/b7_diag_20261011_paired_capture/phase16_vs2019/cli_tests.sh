#!/usr/bin/env bash
# CLI argument-contract tests for the freshly built bm_b7_diagnostic.exe.
# Every case here is designed to be REJECTED before any run/storage work happens,
# OR to abort at the isolation check (which happens before storage creation).
# No case is allowed to execute a real diagnostic run.
#
# Run from project root:  E:\My Local AI
set -uo pipefail

EXE="stark/build-b7diag-vs2019b/Release/bm_b7_diagnostic.exe"
OUT="work/b7_diag_20261011_paired_capture/phase16_vs2019/cli"
mkdir -p "$OUT"

# Disable MSYS path-conversion so argv strings arrive verbatim in the child.
export MSYS2_ARG_CONV_EXCL='*'

run_case() {
  local id="$1"; shift
  local desc="$1"; shift
  "$EXE" "$@" > "$OUT/$id.out" 2> "$OUT/$id.err"
  local rc=$?
  printf '%s\n' "$rc" > "$OUT/$id.rc"
  printf '=== CASE %s ===\n' "$id"
  printf 'desc    : %s\n' "$desc"
  printf 'argv    : %s\n' "$*"
  printf 'exit    : %s\n' "$rc"
  printf 'stderr  : %s\n' "$(head -1 "$OUT/$id.err")"
  printf 'stdout-1: %s\n' "$(head -1 "$OUT/$id.out")"
  printf '\n'
}

# ---- snapshot of artifact-bearing areas BEFORE the invalid-argument tests ----
snap() {
  find build/bm_b7_diagnostic work/b7_diag_20261011_paired_capture/run2 -type f 2>/dev/null \
    | sort | while read -r f; do sha256sum "$f"; done
}
snap > "$OUT/snapshot_before.txt"

echo "########## A. --host-capture-dir contract ##########"
run_case A1 "--host-capture-dir with no value"                --host-capture-dir
run_case A2 "--host-capture-dir followed by another option"   --host-capture-dir --other
run_case A3 "--host-capture-dir empty value"                  --host-capture-dir ""
run_case A4 "duplicate --host-capture-dir"                    --host-capture-dir ok1 --host-capture-dir ok2
run_case A5 "absolute (drive letter)"                         --host-capture-dir "C:hostcaps"
run_case A6 "absolute (leading slash)"                        --host-capture-dir "/hostcaps"
run_case A7 "parent traversal"                                --host-capture-dir "../hostcaps"
run_case A8 "embedded traversal"                              --host-capture-dir "a/../b"
run_case A9 "forbidden marker: reports"                       --host-capture-dir "reports/x"
run_case A10 "forbidden marker: records"                      --host-capture-dir "records/x"
run_case A11 "forbidden marker: g7-campaign"                  --host-capture-dir "g7-campaign/x"
run_case A12 "forbidden marker: .jsonl"                       --host-capture-dir "x.jsonl"
run_case A13 "forbidden marker: evidence_manifest"            --host-capture-dir "evidence_manifest"

echo "########## B. other parser contract ##########"
run_case B1 "unknown long option"                             --bogus
run_case B2 "two positional directory arguments"              dir_one dir_two
run_case B3 "option value that looks like an option"          --host-capture-dir --host-capture-dir

echo "########## C. backward-compatible forms (must PARSE, abort at isolation check) ##########"
run_case C1 "single positional (invalid dir => isolation abort)"  not_the_diagnostic_dir
run_case C2 "single positional + valid host dir (isolation abort)" not_the_diagnostic_dir --host-capture-dir work/b7_diag_20261011_paired_capture/run2

snap > "$OUT/snapshot_after.txt"

echo "########## D. artifact snapshot diff (before vs after invalid-arg tests) ##########"
if diff -u "$OUT/snapshot_before.txt" "$OUT/snapshot_after.txt" > "$OUT/snapshot_diff.txt"; then
  echo "IDENTICAL: no artifact was created or modified by any invalid-argument invocation."
else
  echo "DIFFERENCES DETECTED:"; cat "$OUT/snapshot_diff.txt"
fi
echo
echo "########## E. exit-code summary ##########"
for f in "$OUT"/*.rc; do printf '%-6s %s\n' "$(basename "$f" .rc)" "$(cat "$f")"; done
