#pragma once

/**
 * STARK Phase 1 (M0): gate evaluation seam (spec §G/J)
 *
 * This header is the SINGLE production implementation of the M0 acceptance
 * gates G1..G7. It exists so that both the `aggregate` CLI and the automated
 * regression tests evaluate the EXACT same code path — the tests never
 * reimplement gate logic.
 *
 * Input: records that have already been parsed and passed
 *        ExperimentRecord::validate() (the aggregator performs that filtering;
 *        gate evaluation itself makes no schema-level judgments beyond the
 *        gate contracts).
 *
 * Output: one GateReport per gate, in a stable order (G1..G7).
 *
 * Gate semantics (rev 1.4 corrections):
 *   G2  requires BOTH E1 and E5 present AND PASSED, each with >= 10 samples,
 *       and requires them to be distinct records (duplicate-only evidence fails).
 *   G4  requires BOTH E1 and E5 present AND PASSED and validates the measured
 *       peak-memory block strictly. A missing/non-PASSED baseline FAILS G4
 *       (it is never silently skipped).
 *   G7  evaluates every same-configuration benchmark group. The overall result
 *       is initialized FAIL and can only be turned false — never back to true —
 *       so a later passing group can never erase an earlier failure.
 *
 * Gate semantics (rev 1.5 additions for v2.3):
 *   G3  no-CUDA branch requires, for E2/B4/B5, an explicit, provenance-bearing
 *       structured `skip_attestation` (reason code + capability state +
 *       execution availability + capability source + producer + probe result).
 *       A non-empty status_reason alone is NO LONGER sufficient: arbitrary or
 *       contradictory skips, missing provenance and malformed metadata FAIL
 *       closed. The CUDA-present branch is unchanged and strict (PASSED only).
 *
 * Gate semantics (rev 1.6 corrections for v2.4 — frozen-text alignment):
 *   G4  validates EVERY PASSED baseline record's peak-memory block against the
 *       frozen rule (V009 §G): the RAM peak must be measured; a VRAM peak must
 *       be measured (numeric + vram_measured=true) OR documented as a
 *       structured {value:null, non-empty reason} unavailability corroborated
 *       by the record's own embedded hardware.cuda_available == false (the G3
 *       provenance principle applied to VRAM). A peak value present while
 *       vram_measured=false is an ESTIMATED peak and FAILS (the frozen G4 fail
 *       condition); a measurement claim without a positive finite value FAILS;
 *       an uncorroborated or self-contradictory unavailability claim FAILS.
 *       Physical capability (gpu_present) is NOT a G4 criterion: the v2.1–v2.3
 *       rules "GPU-capable host requires measured VRAM" and "capability
 *       Unknown fails closed" were stricter interpretations layered on the
 *       frozen text and are removed. Capability is reported informationally
 *       only. The E1/E5 presence + PASSED requirement is unchanged; the peak
 *       check now covers every PASSED baseline record ("Every baseline
 *       record's peak RAM/VRAM ..."), not just the latest E1/E5.
 */

#include <string>
#include <vector>

#include "common/ExperimentRecord.h"

namespace stark_p1 {

struct GateReport {
    std::string gate;
    bool pass = false;
    std::string detail;
};

/// Evaluate gates G1..G7 over the supplied records. Deterministic.
/// Queries live machine state only through the documented CUDA probe in G3;
/// all other evidence comes from the records themselves.
std::vector<GateReport> evaluate_gates(const std::vector<ExperimentRecord>& records);

/// Same as evaluate_gates(), but with the G3 CUDA-availability probe supplied
/// explicitly. This is a TEST SEAM ONLY: production callers must use
/// evaluate_gates(), which passes the real
/// HardwareProfiler::cudaRuntimeAvailable() result. Injection lets regression
/// tests exercise BOTH G3 branches deterministically without faking a CUDA
/// runtime. Passing an override never turns a SKIPPED record into a PASS on the
/// CUDA-present branch.
std::vector<GateReport> evaluate_gates_with_cuda(const std::vector<ExperimentRecord>& records,
                                                 bool cuda_available);

/// True when every gate in the report passes.
bool all_gates_pass(const std::vector<GateReport>& gates);

} // namespace stark_p1
