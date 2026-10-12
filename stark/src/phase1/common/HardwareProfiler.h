#pragma once

/**
 * STARK Phase 1 (M0): HardwareProfiler (spec §A, rev 1.1)
 *
 * STRICT separation:
 *   - StaticHardwareProfile: facts that change only on hardware/driver/OS change.
 *   - RuntimeTelemetry: point-in-time samples (total/available RAM, free VRAM,
 *     timestamp, platform_source). NO memory-compression heuristic (rev 1.1).
 *
 * Rules:
 *   - Do NOT fabricate. Unavailable => std::nullopt + provenance reason.
 *   - Device-property-derived bandwidth is THEORETICAL, never "measured".
 *   - No machine-specific limits (no RAM caps); generic validity only.
 *   - CUDA fields populated only when built with CUDA and a device is present.
 *   - PHYSICAL GPU PRESENCE is captured by `gpu_present`, obtained from an OS device
 *     inventory that is INDEPENDENT of whether this binary was built with CUDA.
 *     `cuda_available == false` means "this build cannot query CUDA", NOT "the
 *     machine has no GPU"; the two must never be conflated (rev 1.2).
 */

#include <map>
#include <optional>
#include <string>
#include <vector>

#include "common/ExperimentRecord.h"

namespace stark_p1 {

struct StaticHardwareProfile {
    // CPU
    std::string cpu_model;                                // cpuid brand string; empty => see provenance
    std::optional<uint32_t> physical_cores;
    std::optional<uint32_t> logical_cores;
    std::optional<std::string> cpu_instruction_set_notes; // from cpuid feature bits only

    // RAM (installed capacity)
    std::optional<uint64_t> ram_total_bytes;

    // GPU / CUDA
    bool cuda_available = false;
    std::optional<std::string> gpu_model;
    std::optional<uint64_t> vram_total_bytes;
    std::optional<int> gpu_compute_capability_major;
    std::optional<int> gpu_compute_capability_minor;
    std::optional<double> theoretical_memory_bandwidth_gbps; // device props; NEVER measured
    std::optional<std::string> cuda_version;                 // "runtime X.Y / driver Z" when available
    std::optional<std::string> pytorch_cuda_available_note;  // reserved (always null in C++ Phase 1)

    // Physical GPU presence, determined INDEPENDENTLY of the CUDA build flag.
    //   true    : the OS reports at least one real display adapter / GPU device
    //   false   : the OS reports display adapters but none is a real GPU
    //             (e.g. only Microsoft Basic Display / remote adapters)
    //   nullopt : device inventory unavailable (see provenance["gpu_present"])
    // This is deliberately separate from `cuda_available` (a build/runtime query).
    std::optional<bool> gpu_present;

    // Storage
    struct Volume {
        std::string path;
        std::optional<uint64_t> total_bytes;
        std::optional<uint64_t> free_bytes;
    };
    std::vector<Volume> storage_volumes;

    // Platform
    std::string os_name;
    std::string os_version;
    std::string toolchain;    // compiler id/version
    std::string build_type;   // Debug/Release/unknown

    // Provenance: field name -> "source: ..." or "unavailable: why". Required for every null.
    std::map<std::string, std::string> provenance;

    std::string collected_utc;

    JsonValue to_json() const;
    static StaticHardwareProfile from_json(const JsonValue& v);

    /// Generic validity (rev 1.1: NO machine-specific caps).
    std::vector<std::string> validate() const;
};

struct RuntimeTelemetry {
    std::optional<uint64_t> ram_total_bytes;
    std::optional<uint64_t> ram_available_bytes;
    std::optional<uint64_t> vram_free_bytes;
    std::string sampled_at_utc;
    std::string platform_source;   // e.g. "GlobalMemoryStatusEx" / "cudaMemGetInfo"

    std::map<std::string, std::string> provenance;

    JsonValue to_json() const;
    static RuntimeTelemetry from_json(const JsonValue& v);
};

/// A single display adapter as reported by the OS device inventory.
///   name       -> DISPLAY_DEVICE.DeviceString (friendly adapter string)
///   device_id  -> DISPLAY_DEVICE.DeviceID (stable PNP identity; may be empty)
struct DisplayAdapterInfo {
    std::string name;
    std::string device_id;
};

/// Result of classifying a raw display-adapter inventory into physical GPU
/// presence. See HardwareProfiler::classifyDisplayAdapters().
struct GpuPresenceResult {
    // true    -> at least one PHYSICAL GPU adapter (PCI device / known GPU vendor)
    // false   -> adapters present, but ALL are recognized virtual/basic/remote
    // nullopt -> cannot classify reliably (empty inventory, or ambiguous
    //            adapters): Unknown. Callers MUST NOT treat Unknown as CPU-only.
    std::optional<bool> present;
    std::string reason;                       // provenance / human-readable detail
    size_t raw_count = 0;                     // adapters enumerated (pre-dedupe)
    size_t unique_count = 0;                  // adapters after dedupe by identity
    std::vector<std::string> physical;        // classified physical adapters
    std::vector<std::string> virtual_adapters;// classified virtual/basic/remote
    std::vector<std::string> ambiguous;       // unclassifiable adapters
};

class HardwareProfiler {
public:
    /// Idempotent; safe to call repeatedly.
    static StaticHardwareProfile collectStatic();

    /// Point-in-time sample.
    static RuntimeTelemetry sampleDynamic();

    /// "STARKP1 1"
    static std::string schemaVersion();

    /// CUDA Runtime API query result at build/run time (false when built without CUDA).
    static bool cudaRuntimeAvailable();

    /// Classify a raw display-adapter inventory into physical GPU presence.
    /// Pure and deterministic (no OS calls): adapters are deduplicated by stable
    /// identity, known virtual/remote/basic adapters and software-enumerated
    /// devices are excluded, and anything that cannot be classified reliably
    /// yields Unknown (nullopt) rather than a false CPU-only verdict. This is
    /// the single classification implementation; collectPhysicalGpuPresence()
    /// only gathers the raw inventory and defers to it.
    static GpuPresenceResult classifyDisplayAdapters(const std::vector<DisplayAdapterInfo>& adapters);

private:
    static void collectCpuId(StaticHardwareProfile& p);
    static void collectRam(StaticHardwareProfile& p);
    static void collectGpu(StaticHardwareProfile& p);
    static void collectStorage(StaticHardwareProfile& p);
    static void collectPlatform(StaticHardwareProfile& p);
};

} // namespace stark_p1
