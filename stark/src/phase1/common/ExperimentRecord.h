#pragma once

/**
 * STARK Phase 1 (M0): Experiment Record — "STARKP1 1" schema
 *
 * Machine-readable, append-only record format for every Phase-1 measurement
 * (profiler capture, benchmark run, baseline run). Per spec §F:
 *   - every record embeds the hardware snapshot (never a name-only reference)
 *   - unknown/unavailable values are null + reason, never zero-by-default
 *   - raw samples are always stored, not just statistics
 *   - a failed measurement is itself a measurement (records with failures are valid)
 *   - determinism triple requested/available/bit_identical on every record
 *   - skipped / not_attempted are explicit statuses with reasons
 *
 * JSON writer/reader are hand-rolled (no external deps, matches repo conventions),
 * with strict round-trip: serialize -> parse must preserve all fields bit-exactly.
 */

#include <cstdint>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <vector>

namespace stark_p1 {

// ---------------------------------------------------------------------------
// Generic JSON value tree (used for embedded snapshots and the record itself)
// ---------------------------------------------------------------------------
class JsonValue {
public:
    enum class Type { Null, Bool, Int, UInt, Double, String, Array, Object };

    JsonValue() : type_(Type::Null) {}
    static JsonValue null() { return JsonValue(); }
    static JsonValue boolean(bool b);
    static JsonValue integer(int64_t v);
    static JsonValue uinteger(uint64_t v);
    static JsonValue number(double v);
    static JsonValue str(const std::string& s);
    static JsonValue array();
    static JsonValue object();

    Type type() const { return type_; }
    bool isNull() const { return type_ == Type::Null; }
    bool isObject() const { return type_ == Type::Object; }
    bool isArray() const { return type_ == Type::Array; }

    // Accessors (checked; throw std::runtime_error on type mismatch)
    bool asBool() const;
    int64_t asInt() const;
    uint64_t asUInt() const;
    double asDouble() const;
    const std::string& asString() const;

    // Array
    void append(JsonValue v);
    const std::vector<JsonValue>& items() const;

    // Object
    void set(const std::string& key, JsonValue v);
    bool has(const std::string& key) const;
    const JsonValue& get(const std::string& key) const;   // throws if absent
    const std::map<std::string, JsonValue>& entries() const;

    // Serialization
    std::string dump(int indent = 0) const;

    /// Strict parse. Throws std::runtime_error on malformed input.
    static JsonValue parse(const std::string& text);

private:
    Type type_;
    bool bool_ = false;
    int64_t int_ = 0;
    uint64_t uint_ = 0;
    double num_ = 0.0;
    std::string str_;
    std::vector<JsonValue> arr_;
    std::map<std::string, JsonValue> obj_;

    void dumpTo(std::string& out, int indent, int depth) const;
    static const JsonValue kNullValue;
};

// Optional-with-reason helper: serialized as {"value": ..., "reason": "..."} when null,
// or as the bare value when present. Never silently zero.
template <typename T>
struct Reasoned {
    std::optional<T> value;
    std::string reason;   // required when value is nullopt

    Reasoned() = default;
    Reasoned(std::nullopt_t, std::string why) : value(std::nullopt), reason(std::move(why)) {}
    Reasoned(T v) : value(std::move(v)) {}

    bool present() const { return value.has_value(); }
    bool valid() const { return value.has_value() || !reason.empty(); }
};

// --- Reasoned<T> <-> JsonValue codecs (T restricted to the used types) ---
JsonValue to_json(const Reasoned<uint64_t>& r);
JsonValue to_json(const Reasoned<int64_t>& r);
JsonValue to_json(const Reasoned<double>& r);
JsonValue to_json(const Reasoned<std::string>& r);
Reasoned<uint64_t> reasoned_u64_from(const JsonValue& v, const std::string& what);
Reasoned<int64_t> reasoned_i64_from(const JsonValue& v, const std::string& what);
Reasoned<double> reasoned_double_from(const JsonValue& v, const std::string& what);
Reasoned<std::string> reasoned_str_from(const JsonValue& v, const std::string& what);

// ---------------------------------------------------------------------------
// Failure entry
// ---------------------------------------------------------------------------
struct FailureEntry {
    std::string component;
    std::string error;
    bool recovered = false;
    JsonValue to_json() const;
    static FailureEntry from_json(const JsonValue& v);
};

// ---------------------------------------------------------------------------
// Determinism triple (spec §E, rev 1.1)
// ---------------------------------------------------------------------------
struct DeterminismInfo {
    bool requested = false;
    bool available = false;         // whether the runtime/device can provide the mode
    std::optional<bool> bit_identical;  // observed; null when not evaluated

    JsonValue to_json() const;
    static DeterminismInfo from_json(const JsonValue& v);
};

// ---------------------------------------------------------------------------
// Statistics block (raw samples always included)
// ---------------------------------------------------------------------------
struct Statistics {
    std::vector<double> samples;    // raw, always stored
    double mean = 0.0;
    double median = 0.0;
    double p95 = 0.0;
    double p99 = 0.0;
    double min = 0.0;
    double max = 0.0;
    double stdev = 0.0;
    bool computed = false;          // false when samples empty (not fabricated)

    JsonValue to_json() const;
    static Statistics from_json(const JsonValue& v);
};

/// Compute statistics from samples (mean/median/p95/p99/min/max/stdev).
/// Percentiles use linear interpolation between order statistics.
Statistics compute_statistics(std::vector<double> samples);

// ---------------------------------------------------------------------------
// ExperimentRecord — the top-level document
// ---------------------------------------------------------------------------
enum class RunStatus { PASSED, FAILED, SKIPPED, NOT_ATTEMPTED };

const char* run_status_name(RunStatus s);
RunStatus run_status_from(const std::string& name);

struct ExperimentRecord {
    std::string record_id;          // unique, e.g. "P1-E1-run-<utc>-<counter>"
    std::string schema_version = "STARKP1 1";
    std::string created_utc;        // ISO-8601 UTC at creation
    std::string stark_phase = "P1";

    std::string kind;               // "profiler" | "benchmark" | "baseline"
    std::string experiment_id;      // e.g. "E1", "B3", "profile"
    RunStatus status = RunStatus::PASSED;
    std::string status_reason;      // required when SKIPPED / NOT_ATTEMPTED / FAILED

    JsonValue hardware;             // embedded static profile snapshot (never name-only)
    JsonValue software;             // {os, compiler, build_type, cuda_runtime, ...}
    JsonValue configuration;        // {benchmark_id, workload params, threads, batch, seq_len, ...}
    JsonValue precision;            // {compute precision, storage format, bytes_per_param table, quant metadata}
    JsonValue accounting;           // ParameterAccounting (when the record concerns a model); null otherwise
    JsonValue budget;               // BudgetEvaluation summary when evaluated; null otherwise

    DeterminismInfo determinism;

    std::optional<Statistics> statistics;   // null for pure-static records (profiler)
    JsonValue peak_memory;          // {ram_peak_bytes, vram_peak_bytes, measured_vs_estimated flags}; null fields w/ reasons

    std::vector<FailureEntry> failures;     // empty on success
    std::map<std::string, JsonValue> provenance;  // field -> source or "unavailable: why"

    // Provenance accessors (additive; operate on the provenance map only).
    bool has(const std::string& key) const;
    const JsonValue& get(const std::string& key) const;

    // Structured, machine-verifiable skip attestation (v2.3). Null for records
    // that are not environment skips. When present it must be an object:
    //   { schema, reason_code, capability_state, execution_availability,
    //     capability_source, producer, cuda_available }
    // Gate G3 requires this structured evidence (rather than free-text
    // status_reason alone) before accepting a no-CUDA skip. Records that predate
    // this field parse unchanged (the field is absent -> null) but FAIL CLOSED
    // at G3 because no attestation is present.
    JsonValue skip_attestation;

    // Optional GPU sub-measurements when applicable
    std::optional<double> measured_memory_bandwidth_gbps;  // only from timed runs (B3/B5); never device props
    std::optional<double> measured_gflops;                 // only from timed runs (B1/B2/B4)

    JsonValue to_json() const;

    /// Serialize to pretty JSON text.
    std::string serialize() const;

    /// Strict parse + validate. Throws std::runtime_error on malformed input or
    /// schema violation (wrong magic, missing required fields).
    static ExperimentRecord parse(const std::string& text);

    /// Structural validation (schema-level; not gate evaluation).
    /// Returns list of violations (empty = valid).
    std::vector<std::string> validate() const;
};

// ---------------------------------------------------------------------------
// Append-only record store
// ---------------------------------------------------------------------------
class RecordStore {
public:
    explicit RecordStore(std::string directory);
    ~RecordStore();

    /// Append a record as <dir>/<record_id>.json.
    /// Never replaces an existing id; rejects unsafe path-like ids.
    /// Requires a filesystem with hard-link support for atomic no-replace publication.
    /// Throws std::runtime_error on duplicate id, unsafe id or IO failure.
    /// Atomic visibility is provided; crash/power-loss fsync durability is not claimed.
    void append(const ExperimentRecord& record) const;

    /// Load and parse all *.json records in the directory (sorted by name).
    /// Throws std::runtime_error only if the directory cannot be read;
    /// malformed individual files are returned as parse-failure entries.
    struct Entry {
        std::string path;
        bool parse_ok = false;
        std::string error;          // when parse_ok == false
        ExperimentRecord record;    // when parse_ok == true
    };
    std::vector<Entry> loadAll() const;

    static std::string utc_timestamp_now();

private:
    std::string dir_;
};

} // namespace stark_p1
