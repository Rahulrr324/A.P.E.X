#!/usr/bin/env python3
"""Apply the v8 doc-comment rewrite for diag_highres_frequency.cpp.

Only the first doc-comment block is replaced (up to and including the v7
addendum line and the closing `*/`). Everything after that block is preserved
verbatim by byte offset.
"""
from __future__ import annotations

import re
from pathlib import Path

PATH = Path("stark/tests/diag_highres_frequency.cpp")

NEW_HEADER = (
    "/**\n"
    " * Diagnostic: high-resolution CPU performance telemetry for the G7\n"
    " * reproducibility investigation. (Investigation only — not a G7 campaign.)\n"
    " *\n"
    " * Purpose: determine whether the residual 6.8974% exec-window\n"
    " * % Processor Performance spread under High Performance is\n"
    " *   A. genuine within-execution frequency variation, or\n"
    " *   B. a PDH sampling-window resolution artifact, or\n"
    " *   C. mixed/indeterminate.\n"
    " *\n"
    " * Rules honored:\n"
    " *   - Production benchmark semantics UNCHANGED: the same\n"
    " *     stark_p1::run_benchmark() path with campaign-equivalent configs\n"
    " *     (warmup=10, samples=50, thread=1, batch=1, seq=0, FP32).\n"
    " *   - Writes NO STARKP1 records; touches NO record store.\n"
    " *   - Per-iteration brackets are taken by THIS process around its own\n"
    " *     op() calls with QPC (same timer class as the production harness);\n"
    " *     the production harness median for the same exec is reported for\n"
    " *     parity but the per-iteration brackets are diagnostic-only.\n"
    " *   - Collector: one dedicated background thread, own PDH query\n"
    " *     (PDH queries are not thread-safe), tight loop, QPC timestamps on\n"
    " *     every sample.\n"
    " *   - ASCII-safe console output only.\n"
    " * Version history (predeclarations live alongside the report tree):\n"
    " *   v5 (2026-10-07): measurement-architecture fix — process affinity is no\n"
    " *     longer narrowed to CPU0; worker is explicitly pinned to CPU0, the\n"
    " *     collector to a separate logical CPU, both verified by readback +\n"
    " *     observed-CPU samples. Adds an A/B perturbation check.\n"
    " *   v6 (2026-10-07): physical-core separation — the collector target is\n"
    " *     chosen by the v6 rule (lowest LP that does not share a physical core\n"
    " *     with CPU0) and self-validated from GetLogicalProcessorInformationEx.\n"
    " *   v7 (2026-10-07): race-free gating + paced sampling (500 us) — fixes the\n"
    " *     pre-exec coverage race and the ~50 kHz rate perturbation; records\n"
    " *     per-exec collector diagnostics so any coverage shortfall is observable.\n"
    " *   v8 (2026-10-08): two tightly-controlled diagnostics only. (1) B6:\n"
    " *     position-matched A/B perturbation at the validated 500 us cadence,\n"
    " *     order alternated across N_PAIR adjacent pairs, repeated under the same\n"
    " *     thermal/power/background conditions; the predeclared 2.0% materiality\n"
    " *     criterion is not interpreted away. (2) B9: repeated identical B-side\n"
    " *     executions at the 500 us cadence, each recording the full exec-level\n"
    " *     evidence, with a mechanism probe for the prior 10-13 sample floor.\n"
    " * v8 does not change any G7 threshold, formula, benchmark timing semantics,\n"
    " * production binary, frozen 30 records, or the v7 finding.\n"
    " */\n"
)


def main() -> None:
    text = PATH.read_text(encoding="utf-8")

    m = re.search(
        r"highres_v7_predeclaration_addendum\.txt\.[\r\n] \*/[\r\n]", text
    )
    assert m, "v7 doc-comment tail not found"

    cs = text.find("/**")
    assert cs != -1, "doc comment start not found"

    old_block = text[cs:m.end()]
    assert len(old_block) == 4126, f"unexpected old block length: {len(old_block)}"
    assert len(NEW_HEADER) == 2637, f"unexpected new header length: {len(NEW_HEADER)}"

    new_text = NEW_HEADER + text[m.end():]
    PATH.write_text(new_text, encoding="utf-8")
    print("APPLIED.")


if __name__ == "__main__":
    main()
