#!/usr/bin/env bash
# M0 v1.8 — run the REAL production aggregator over every required input in
# BOTH build configurations and record exact output + exit codes.
# Writes: reports/v18-aggregator/matrix.txt  (and per-run logs)
set -u
cd "$(dirname "$0")/.." || exit 1
ROOT="$(pwd)"
OUTDIR="reports/v18-aggregator"
mkdir -p "$OUTDIR"
MATRIX="$OUTDIR/matrix.txt"
: > "$MATRIX"

INPUTS=(
  "build/historical-regen"
  "build/results"
  "fixtures/v14-valid"
  "fixtures/controlled-valid"
  "fixtures/controlled-invalid-g2"
  "fixtures/controlled-invalid-g4"
  "fixtures/controlled-invalid-g7"
  "fixtures/controlled-g7-endpoint-outlier"
  "fixtures/controlled-invalid-raw-sample"
  "fixtures/controlled-incorrect-stored-median"
  "fixtures/probe-malformed-profile"
  "fixtures/probe-malformed-accounting"
)

run_one() {
  local cfg="$1" bin="$2" mode="$3" dir="$4"
  local tag
  tag="$(basename "$dir").${cfg}.${mode}"
  local log="$OUTDIR/${tag}.log"
  local rc
  if [ "$mode" = "strict" ]; then
    "$bin" --out "$dir" --strict > "$log" 2>&1
  else
    "$bin" --out "$dir" > "$log" 2>&1
  fi
  rc=$?
  local failed passed records invalid
  failed=$(grep -c '^\s*\[FAIL\]' "$log")
  passed=$(grep -c '^\s*\[PASS\]' "$log")
  records=$(sed -n 's/^records found: //p' "$log")
  invalid=$(sed -n 's/^INVALID RECORDS (\([0-9]*\)).*/\1/p' "$log")
  printf '%-9s %-9s %-40s exit=%-3s pass=%s fail=%s records=%s invalid=%s\n' \
    "$cfg" "$mode" "$dir" "$rc" "$passed" "$failed" "${records:-?}" "${invalid:-0}" \
    >> "$MATRIX"
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$cfg" "$mode" "$dir" "$rc" "$passed" "$failed" "${records:-?}" "${invalid:-0}" \
    > "$OUTDIR/${tag}.tsv"
}

for cfg in debug release; do
  bin="./build-v18-${cfg}/aggregate.exe"
  [ -x "$bin" ] || { echo "MISSING BINARY: $bin" >> "$MATRIX"; continue; }
  for dir in "${INPUTS[@]}"; do
    [ -d "$dir" ] || { printf '%-9s %-9s %-40s MISSING\n' "$cfg" "-" "$dir" >> "$MATRIX"; continue; }
    run_one "$cfg" "$bin" normal "$dir"
    run_one "$cfg" "$bin" strict  "$dir"
  done
  echo "" >> "$MATRIX"
done

echo "=== aggregator matrix (debug + release, normal + strict) ==="
cat "$MATRIX"
