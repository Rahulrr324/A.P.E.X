#include "common/ExperimentRecord.h"

#include <algorithm>
#include <atomic>
#include <cerrno>
#include <cstdlib>
#include <filesystem>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <ctime>
#include <fstream>
#include <iomanip>
#include <sstream>
#include <stdexcept>

#ifdef _WIN32
#define NOMINMAX
#include <direct.h>
#include <sys/stat.h>
#include <windows.h>
#else
#include <dirent.h>
#include <sys/stat.h>
#include <sys/types.h>
#endif

namespace stark_p1 {

const JsonValue JsonValue::kNullValue = JsonValue();

// ---------------------------------------------------------------------------
// JsonValue construction
// ---------------------------------------------------------------------------
JsonValue JsonValue::boolean(bool b) { JsonValue v; v.type_ = Type::Bool; v.bool_ = b; return v; }
JsonValue JsonValue::integer(int64_t i) { JsonValue v; v.type_ = Type::Int; v.int_ = i; return v; }
JsonValue JsonValue::uinteger(uint64_t u) { JsonValue v; v.type_ = Type::UInt; v.uint_ = u; return v; }
JsonValue JsonValue::number(double d) {
    if (!std::isfinite(d)) throw std::runtime_error("JsonValue::number: non-finite double not representable in JSON");
    JsonValue v; v.type_ = Type::Double; v.num_ = d; return v;
}
JsonValue JsonValue::str(const std::string& s) { JsonValue v; v.type_ = Type::String; v.str_ = s; return v; }
JsonValue JsonValue::array() { JsonValue v; v.type_ = Type::Array; return v; }
JsonValue JsonValue::object() { JsonValue v; v.type_ = Type::Object; return v; }

bool JsonValue::asBool() const {
    if (type_ != Type::Bool) throw std::runtime_error("json: expected bool");
    return bool_;
}
int64_t JsonValue::asInt() const {
    if (type_ == Type::Int) return int_;
    if (type_ == Type::UInt) {
        if (uint_ > static_cast<uint64_t>(std::numeric_limits<int64_t>::max()))
            throw std::runtime_error("json: uint value overflows int64");
        return static_cast<int64_t>(uint_);
    }
    throw std::runtime_error("json: expected int");
}
uint64_t JsonValue::asUInt() const {
    if (type_ == Type::UInt) return uint_;
    if (type_ == Type::Int) {
        if (int_ < 0) throw std::runtime_error("json: negative value where unsigned expected");
        return static_cast<uint64_t>(int_);
    }
    throw std::runtime_error("json: expected uint");
}
double JsonValue::asDouble() const {
    if (type_ == Type::Double) return num_;
    if (type_ == Type::Int) return static_cast<double>(int_);
    if (type_ == Type::UInt) return static_cast<double>(uint_);
    throw std::runtime_error("json: expected number");
}
const std::string& JsonValue::asString() const {
    if (type_ != Type::String) throw std::runtime_error("json: expected string");
    return str_;
}

void JsonValue::append(JsonValue v) {
    if (type_ != Type::Array) throw std::runtime_error("json: append on non-array");
    arr_.push_back(std::move(v));
}
const std::vector<JsonValue>& JsonValue::items() const {
    if (type_ != Type::Array) throw std::runtime_error("json: items() on non-array");
    return arr_;
}

void JsonValue::set(const std::string& key, JsonValue v) {
    if (type_ != Type::Object) throw std::runtime_error("json: set() on non-object");
    obj_[key] = std::move(v);
}
bool JsonValue::has(const std::string& key) const {
    return type_ == Type::Object && obj_.find(key) != obj_.end();
}
const JsonValue& JsonValue::get(const std::string& key) const {
    if (type_ != Type::Object) throw std::runtime_error("json: get() on non-object");
    auto it = obj_.find(key);
    if (it == obj_.end()) throw std::runtime_error("json: missing key '" + key + "'");
    return it->second;
}
const std::map<std::string, JsonValue>& JsonValue::entries() const {
    if (type_ != Type::Object) throw std::runtime_error("json: entries() on non-object");
    return obj_;
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------
static void escape_string(const std::string& s, std::string& out) {
    out += '"';
    for (char c : s) {
        switch (c) {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            case '\b': out += "\\b"; break;
            case '\f': out += "\\f"; break;
            default:
                if (static_cast<unsigned char>(c) < 0x20) {
                    char buf[8];
                    std::snprintf(buf, sizeof(buf), "\\u%04x", c);
                    out += buf;
                } else {
                    out += c;
                }
        }
    }
    out += '"';
}

static void dump_double(double d, std::string& out) {
    // Round-trip exact: max_digits10 guarantees double -> text -> double identity.
    char buf[64];
    std::snprintf(buf, sizeof(buf), "%.17g", d);
    // Ensure it parses as a double (has . e E or inf handled earlier)
    std::string s(buf);
    if (s.find('.') == std::string::npos && s.find('e') == std::string::npos &&
        s.find('E') == std::string::npos && s.find("inf") == std::string::npos &&
        s.find("nan") == std::string::npos) {
        s += ".0";
    }
    out += s;
}

void JsonValue::dumpTo(std::string& out, int indent, int depth) const {
    auto pad = [&](int d) {
        if (indent <= 0) return;
        out += '\n';
        out.append(static_cast<size_t>(indent) * static_cast<size_t>(d), ' ');
    };
    switch (type_) {
        case Type::Null: out += "null"; break;
        case Type::Bool: out += bool_ ? "true" : "false"; break;
        case Type::Int: out += std::to_string(int_); break;
        case Type::UInt: out += std::to_string(uint_); break;
        case Type::Double: dump_double(num_, out); break;
        case Type::String: escape_string(str_, out); break;
        case Type::Array: {
            out += '[';
            for (size_t i = 0; i < arr_.size(); ++i) {
                if (i) out += ',';
                pad(depth + 1);
                arr_[i].dumpTo(out, indent, depth + 1);
            }
            if (!arr_.empty()) pad(depth);
            out += ']';
            break;
        }
        case Type::Object: {
            out += '{';
            bool first = true;
            for (const auto& [k, v] : obj_) {
                if (!first) out += ',';
                first = false;
                pad(depth + 1);
                escape_string(k, out);
                out += indent > 0 ? ": " : ":";
                v.dumpTo(out, indent, depth + 1);
            }
            if (!first) pad(depth);
            out += '}';
            break;
        }
    }
}

std::string JsonValue::dump(int indent) const {
    std::string out;
    dumpTo(out, indent, 0);
    return out;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------
namespace {
struct Parser {
    const char* begin;
    const char* p;
    const char* end;

    void skipWs() {
        while (p < end && (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r')) ++p;
    }
    [[noreturn]] void fail(const std::string& msg) {
        throw std::runtime_error("json parse error at offset " +
                                 std::to_string(static_cast<size_t>(p - begin)) + ": " + msg);
    }
    char peek() {
        if (p >= end) fail("unexpected end of input");
        return *p;
    }
    void expect(char c) {
        if (p >= end || *p != c) {
            std::string got = p < end ? std::string(1, *p) : "<eof>";
            fail(std::string("expected '") + c + "', got '" + got + "'");
        }
        ++p;
    }

    JsonValue parseValue(int depth) {
        if (depth > 128) fail("nesting too deep");
        skipWs();
        char c = peek();
        switch (c) {
            case '{': return parseObject(depth);
            case '[': return parseArray(depth);
            case '"': return JsonValue::str(parseString());
            case 't': expectWord("true"); return JsonValue::boolean(true);
            case 'f': expectWord("false"); return JsonValue::boolean(false);
            case 'n': expectWord("null"); return JsonValue::null();
            default: return parseNumber();
        }
    }
    void expectWord(const char* w) {
        for (const char* q = w; *q; ++q) {
            if (p >= end || *p != *q) fail(std::string("expected '") + w + "'");
            ++p;
        }
    }
    JsonValue parseObject(int depth) {
        JsonValue obj = JsonValue::object();
        expect('{');
        skipWs();
        if (peek() == '}') { ++p; return obj; }
        while (true) {
            skipWs();
            std::string key = parseString();
            skipWs();
            expect(':');
            // Duplicate keys make security/configuration interpretation ambiguous.
            if (obj.has(key)) fail("duplicate object key");
            obj.set(key, parseValue(depth + 1));
            skipWs();
            char c = peek();
            if (c == ',') { ++p; continue; }
            if (c == '}') { ++p; break; }
            fail("expected ',' or '}' in object");
        }
        return obj;
    }
    JsonValue parseArray(int depth) {
        JsonValue arr = JsonValue::array();
        expect('[');
        skipWs();
        if (peek() == ']') { ++p; return arr; }
        while (true) {
            arr.append(parseValue(depth + 1));
            skipWs();
            char c = peek();
            if (c == ',') { ++p; continue; }
            if (c == ']') { ++p; break; }
            fail("expected ',' or ']' in array");
        }
        return arr;
    }
    unsigned hex4() {
        if (end - p < 4) fail("bad \\u escape");
        unsigned code = 0;
        for (int i = 0; i < 4; ++i) {
            const char h = *p++;
            code <<= 4;
            if (h >= '0' && h <= '9') code |= static_cast<unsigned>(h - '0');
            else if (h >= 'a' && h <= 'f') code |= static_cast<unsigned>(h - 'a' + 10);
            else if (h >= 'A' && h <= 'F') code |= static_cast<unsigned>(h - 'A' + 10);
            else fail("bad hex digit in \\u escape");
        }
        return code;
    }
    static void appendUtf8(std::string& out, unsigned code) {
        if (code < 0x80) out += static_cast<char>(code);
        else if (code < 0x800) {
            out += static_cast<char>(0xC0 | (code >> 6));
            out += static_cast<char>(0x80 | (code & 0x3F));
        } else if (code < 0x10000) {
            out += static_cast<char>(0xE0 | (code >> 12));
            out += static_cast<char>(0x80 | ((code >> 6) & 0x3F));
            out += static_cast<char>(0x80 | (code & 0x3F));
        } else {
            out += static_cast<char>(0xF0 | (code >> 18));
            out += static_cast<char>(0x80 | ((code >> 12) & 0x3F));
            out += static_cast<char>(0x80 | ((code >> 6) & 0x3F));
            out += static_cast<char>(0x80 | (code & 0x3F));
        }
    }
    std::string parseString() {
        expect('"');
        std::string out;
        while (true) {
            if (p >= end) fail("unterminated string");
            const unsigned char c = static_cast<unsigned char>(*p++);
            if (c == '"') break;
            if (c == '\\') {
                if (p >= end) fail("unterminated escape");
                const char e = *p++;
                switch (e) {
                    case '"': out += '"'; break;
                    case '\\': out += '\\'; break;
                    case '/': out += '/'; break;
                    case 'n': out += '\n'; break;
                    case 'r': out += '\r'; break;
                    case 't': out += '\t'; break;
                    case 'b': out += '\b'; break;
                    case 'f': out += '\f'; break;
                    case 'u': {
                        unsigned code = hex4();
                        if (code >= 0xD800 && code <= 0xDBFF) {
                            if (end - p < 2 || p[0] != '\\' || p[1] != 'u') fail("unpaired high surrogate");
                            p += 2;
                            const unsigned low = hex4();
                            if (low < 0xDC00 || low > 0xDFFF) fail("invalid low surrogate");
                            code = 0x10000 + ((code - 0xD800) << 10) + (low - 0xDC00);
                        } else if (code >= 0xDC00 && code <= 0xDFFF) fail("unpaired low surrogate");
                        appendUtf8(out, code);
                        break;
                    }
                    default: fail("unknown escape");
                }
            } else if (c < 0x20) {
                fail("unescaped control character");
            } else if (c < 0x80) {
                out += static_cast<char>(c);
            } else {
                // Raw UTF-8 must represent a Unicode scalar, without overlong forms.
                const char* start = p - 1;
                unsigned code = 0, minimum = 0;
                int trailing = 0;
                if (c >= 0xC2 && c <= 0xDF) { code = c & 0x1F; minimum = 0x80; trailing = 1; }
                else if (c >= 0xE0 && c <= 0xEF) { code = c & 0x0F; minimum = 0x800; trailing = 2; }
                else if (c >= 0xF0 && c <= 0xF4) { code = c & 0x07; minimum = 0x10000; trailing = 3; }
                else fail("invalid UTF-8 leading byte");
                for (int i = 0; i < trailing; ++i) {
                    if (p >= end || (static_cast<unsigned char>(*p) & 0xC0) != 0x80) fail("invalid UTF-8 continuation");
                    code = (code << 6) | (static_cast<unsigned char>(*p++) & 0x3F);
                }
                if (code < minimum || code > 0x10FFFF || (code >= 0xD800 && code <= 0xDFFF)) fail("invalid Unicode scalar");
                out.append(start, static_cast<size_t>(p - start));
            }
        }
        return out;
    }
    JsonValue parseNumber() {
        skipWs();
        const char* start = p;
        if (p < end && *p == '-') ++p;
        // JSON numbers have a grammar; stod() alone accepts prefixes of malformed
        // strings such as 1..2, 1e, +1 and 01. Never silently discard a suffix.
        if (p >= end) fail("missing number");
        if (*p == '0') ++p;
        else if (*p >= '1' && *p <= '9') {
            do { ++p; } while (p < end && *p >= '0' && *p <= '9');
        } else fail("invalid number");
        bool isInt = true;
        if (p < end && *p == '.') {
            isInt = false; ++p;
            if (p >= end || *p < '0' || *p > '9') fail("fraction requires digits");
            do { ++p; } while (p < end && *p >= '0' && *p <= '9');
        }
        if (p < end && (*p == 'e' || *p == 'E')) {
            isInt = false; ++p;
            if (p < end && (*p == '+' || *p == '-')) ++p;
            if (p >= end || *p < '0' || *p > '9') fail("exponent requires digits");
            do { ++p; } while (p < end && *p >= '0' && *p <= '9');
        }
        const std::string text(start, p);
        try {
            size_t consumed = 0;
            if (isInt) {
                if (text[0] == '-') {
                    auto value = std::stoll(text, &consumed);
                    if (consumed != text.size()) fail("invalid integer suffix");
                    return JsonValue::integer(static_cast<int64_t>(value));
                }
                auto value = std::stoull(text, &consumed);
                if (consumed != text.size()) fail("invalid integer suffix");
                return JsonValue::uinteger(static_cast<uint64_t>(value));
            }
            // stod commonly throws ERANGE for representable subnormals. Preserve
            // finite nonzero subnormal values, but reject overflow or underflow to
            // zero rather than silently fabricating a zero measurement.
            char* conversion_end = nullptr;
            errno = 0;
            const double value = std::strtod(text.c_str(), &conversion_end);
            if (conversion_end != text.c_str() + text.size()) fail("invalid double suffix");
            if (!std::isfinite(value) || (errno == ERANGE && value == 0.0)) fail("double outside representable range");
            return JsonValue::number(value);
        } catch (const std::exception&) { fail("number out of representable range"); }
    }
};
} // namespace

JsonValue JsonValue::parse(const std::string& text) {
    Parser parser{text.data(), text.data(), text.data() + text.size()};
    JsonValue v = parser.parseValue(0);
    parser.skipWs();
    if (parser.p != parser.end) parser.fail("trailing characters after JSON value");
    return v;
}

// ---------------------------------------------------------------------------
// Reasoned<T> codecs
// ---------------------------------------------------------------------------
static JsonValue reasoned_to_json_impl(bool present, bool is_unsigned, int64_t i, uint64_t u,
                                       double d, bool is_double, const std::string& s, bool is_string,
                                       const std::string& reason) {
    if (present) {
        if (is_string) return JsonValue::str(s);
        if (is_double) return JsonValue::number(d);
        if (is_unsigned) return JsonValue::uinteger(u);
        return JsonValue::integer(i);
    }
    JsonValue obj = JsonValue::object();
    obj.set("value", JsonValue::null());
    obj.set("reason", JsonValue::str(reason));
    return obj;
}

JsonValue to_json(const Reasoned<uint64_t>& r) {
    return reasoned_to_json_impl(r.value.has_value(), true, 0, r.value.value_or(0), 0.0, false, "", false, r.reason);
}
JsonValue to_json(const Reasoned<int64_t>& r) {
    return reasoned_to_json_impl(r.value.has_value(), false, r.value.value_or(0), 0, 0.0, false, "", false, r.reason);
}
JsonValue to_json(const Reasoned<double>& r) {
    return reasoned_to_json_impl(r.value.has_value(), false, 0, 0, r.value.value_or(0.0), true, "", false, r.reason);
}
JsonValue to_json(const Reasoned<std::string>& r) {
    return reasoned_to_json_impl(r.value.has_value(), false, 0, 0, 0.0, false, r.value.value_or(""), true, r.reason);
}

static Reasoned<uint64_t> reasoned_u64_impl(const JsonValue& v, const std::string& what) {
    if (v.isNull()) return Reasoned<uint64_t>(std::nullopt, "missing: " + what);
    if (v.isObject() && v.has("reason")) return Reasoned<uint64_t>(std::nullopt, v.get("reason").asString());
    return Reasoned<uint64_t>(v.asUInt());
}
static Reasoned<int64_t> reasoned_i64_impl(const JsonValue& v, const std::string& what) {
    if (v.isNull()) return Reasoned<int64_t>(std::nullopt, "missing: " + what);
    if (v.isObject() && v.has("reason")) return Reasoned<int64_t>(std::nullopt, v.get("reason").asString());
    return Reasoned<int64_t>(v.asInt());
}
static Reasoned<double> reasoned_double_impl(const JsonValue& v, const std::string& what) {
    if (v.isNull()) return Reasoned<double>(std::nullopt, "missing: " + what);
    if (v.isObject() && v.has("reason")) return Reasoned<double>(std::nullopt, v.get("reason").asString());
    return Reasoned<double>(v.asDouble());
}
static Reasoned<std::string> reasoned_str_impl(const JsonValue& v, const std::string& what) {
    if (v.isNull()) return Reasoned<std::string>(std::nullopt, "missing: " + what);
    if (v.isObject() && v.has("reason")) return Reasoned<std::string>(std::nullopt, v.get("reason").asString());
    return Reasoned<std::string>(v.asString());
}

Reasoned<uint64_t> reasoned_u64_from(const JsonValue& v, const std::string& what) { return reasoned_u64_impl(v, what); }
Reasoned<int64_t> reasoned_i64_from(const JsonValue& v, const std::string& what) { return reasoned_i64_impl(v, what); }
Reasoned<double> reasoned_double_from(const JsonValue& v, const std::string& what) { return reasoned_double_impl(v, what); }
Reasoned<std::string> reasoned_str_from(const JsonValue& v, const std::string& what) { return reasoned_str_impl(v, what); }

// ---------------------------------------------------------------------------
// FailureEntry / DeterminismInfo / Statistics
// ---------------------------------------------------------------------------
JsonValue FailureEntry::to_json() const {
    JsonValue o = JsonValue::object();
    o.set("component", JsonValue::str(component));
    o.set("error", JsonValue::str(error));
    o.set("recovered", JsonValue::boolean(recovered));
    return o;
}
FailureEntry FailureEntry::from_json(const JsonValue& v) {
    FailureEntry f;
    f.component = v.get("component").asString();
    f.error = v.get("error").asString();
    f.recovered = v.get("recovered").asBool();
    return f;
}

JsonValue DeterminismInfo::to_json() const {
    JsonValue o = JsonValue::object();
    o.set("deterministic_mode_requested", JsonValue::boolean(requested));
    o.set("deterministic_mode_available", JsonValue::boolean(available));
    o.set("outputs_bit_identical", bit_identical.has_value() ? JsonValue::boolean(*bit_identical) : JsonValue::null());
    return o;
}
DeterminismInfo DeterminismInfo::from_json(const JsonValue& v) {
    DeterminismInfo d;
    d.requested = v.get("deterministic_mode_requested").asBool();
    d.available = v.get("deterministic_mode_available").asBool();
    const JsonValue& b = v.get("outputs_bit_identical");
    if (!b.isNull()) d.bit_identical = b.asBool();
    return d;
}

Statistics compute_statistics(std::vector<double> samples) {
    Statistics s;
    s.samples = std::move(samples);
    if (s.samples.empty()) { s.computed = false; return s; }
    std::vector<double> sorted = s.samples;
    std::sort(sorted.begin(), sorted.end());
    auto n = sorted.size();
    auto at = [&](double q) -> double {
        if (n == 1) return sorted[0];
        double pos = q * static_cast<double>(n - 1);
        size_t lo = static_cast<size_t>(pos);
        size_t hi = std::min(lo + 1, n - 1);
        double frac = pos - static_cast<double>(lo);
        return sorted[lo] + frac * (sorted[hi] - sorted[lo]);
    };
    double sum = 0.0;
    for (double x : sorted) sum += x;
    s.mean = sum / static_cast<double>(n);
    s.median = at(0.5);
    s.p95 = at(0.95);
    s.p99 = at(0.99);
    s.min = sorted.front();
    s.max = sorted.back();
    double ss = 0.0;
    for (double x : sorted) ss += (x - s.mean) * (x - s.mean);
    s.stdev = n > 1 ? std::sqrt(ss / static_cast<double>(n - 1)) : 0.0;
    s.computed = true;
    return s;
}

JsonValue Statistics::to_json() const {
    JsonValue o = JsonValue::object();
    JsonValue arr = JsonValue::array();
    for (double x : samples) arr.append(JsonValue::number(x));
    o.set("samples", std::move(arr));
    o.set("mean", JsonValue::number(mean));
    o.set("median", JsonValue::number(median));
    o.set("p95", JsonValue::number(p95));
    o.set("p99", JsonValue::number(p99));
    o.set("min", JsonValue::number(min));
    o.set("max", JsonValue::number(max));
    o.set("stdev", JsonValue::number(stdev));
    o.set("computed", JsonValue::boolean(computed));
    return o;
}
Statistics Statistics::from_json(const JsonValue& v) {
    Statistics s;
    for (const auto& x : v.get("samples").items()) s.samples.push_back(x.asDouble());
    s.mean = v.get("mean").asDouble();
    s.median = v.get("median").asDouble();
    s.p95 = v.get("p95").asDouble();
    s.p99 = v.get("p99").asDouble();
    s.min = v.get("min").asDouble();
    s.max = v.get("max").asDouble();
    s.stdev = v.get("stdev").asDouble();
    s.computed = v.get("computed").asBool();
    return s;
}

// ---------------------------------------------------------------------------
// ExperimentRecord
// ---------------------------------------------------------------------------
const char* run_status_name(RunStatus s) {
    switch (s) {
        case RunStatus::PASSED: return "PASSED";
        case RunStatus::FAILED: return "FAILED";
        case RunStatus::SKIPPED: return "SKIPPED";
        case RunStatus::NOT_ATTEMPTED: return "NOT_ATTEMPTED";
    }
    return "UNKNOWN";
}
RunStatus run_status_from(const std::string& name) {
    if (name == "PASSED") return RunStatus::PASSED;
    if (name == "FAILED") return RunStatus::FAILED;
    if (name == "SKIPPED") return RunStatus::SKIPPED;
    if (name == "NOT_ATTEMPTED") return RunStatus::NOT_ATTEMPTED;
    throw std::runtime_error("unknown run status: " + name);
}

JsonValue ExperimentRecord::to_json() const {
    JsonValue o = JsonValue::object();
    o.set("schema_version", JsonValue::str(schema_version));
    o.set("record_id", JsonValue::str(record_id));
    o.set("created_utc", JsonValue::str(created_utc));
    o.set("stark_phase", JsonValue::str(stark_phase));
    o.set("kind", JsonValue::str(kind));
    o.set("experiment_id", JsonValue::str(experiment_id));
    o.set("status", JsonValue::str(run_status_name(status)));
    o.set("status_reason", status_reason.empty() ? JsonValue::null() : JsonValue::str(status_reason));
    o.set("hardware", hardware);
    o.set("software", software);
    o.set("configuration", configuration);
    o.set("precision", precision);
    o.set("accounting", accounting);
    o.set("budget", budget);
    o.set("determinism", determinism.to_json());
    o.set("statistics", statistics.has_value() ? statistics->to_json() : JsonValue::null());
    o.set("peak_memory", peak_memory);
    JsonValue fails = JsonValue::array();
    for (const auto& f : failures) fails.append(f.to_json());
    o.set("failures", std::move(fails));
    JsonValue prov = JsonValue::object();
    for (const auto& [k, v] : provenance) prov.set(k, v);
    o.set("provenance", std::move(prov));
    o.set("skip_attestation", skip_attestation);
    o.set("measured_memory_bandwidth_gbps",
          measured_memory_bandwidth_gbps.has_value() ? JsonValue::number(*measured_memory_bandwidth_gbps) : JsonValue::null());
    o.set("measured_gflops",
          measured_gflops.has_value() ? JsonValue::number(*measured_gflops) : JsonValue::null());
    return o;
}

std::string ExperimentRecord::serialize() const { return to_json().dump(2); }

ExperimentRecord ExperimentRecord::parse(const std::string& text) {
    JsonValue v = JsonValue::parse(text);
    ExperimentRecord r;
    r.schema_version = v.get("schema_version").asString();
    if (r.schema_version != "STARKP1 1")
        throw std::runtime_error("schema mismatch: expected 'STARKP1 1', got '" + r.schema_version + "'");
    r.record_id = v.get("record_id").asString();
    r.created_utc = v.get("created_utc").asString();
    r.stark_phase = v.get("stark_phase").asString();
    r.kind = v.get("kind").asString();
    r.experiment_id = v.get("experiment_id").asString();
    r.status = run_status_from(v.get("status").asString());
    const JsonValue& sr = v.get("status_reason");
    if (!sr.isNull()) r.status_reason = sr.asString();
    r.hardware = v.get("hardware");
    r.software = v.get("software");
    r.configuration = v.get("configuration");
    r.precision = v.get("precision");
    r.accounting = v.get("accounting");
    r.budget = v.get("budget");
    r.determinism = DeterminismInfo::from_json(v.get("determinism"));
    const JsonValue& st = v.get("statistics");
    if (!st.isNull()) r.statistics = Statistics::from_json(st);
    r.peak_memory = v.get("peak_memory");
    for (const auto& f : v.get("failures").items()) r.failures.push_back(FailureEntry::from_json(f));
    const JsonValue& prov = v.get("provenance");
    if (prov.isObject())
        for (const auto& [k, val] : prov.entries()) r.provenance[k] = val;
    // v2.3: optional structured skip attestation. Absent in pre-v2.3 records
    // (still valid -- the field is simply nullopt/null).
    if (v.has("skip_attestation")) r.skip_attestation = v.get("skip_attestation");
    const JsonValue& mbw = v.get("measured_memory_bandwidth_gbps");
    if (!mbw.isNull()) r.measured_memory_bandwidth_gbps = mbw.asDouble();
    const JsonValue& mgf = v.get("measured_gflops");
    if (!mgf.isNull()) r.measured_gflops = mgf.asDouble();
    return r;
}

std::vector<std::string> ExperimentRecord::validate() const {
    std::vector<std::string> errs;
    if (schema_version != "STARKP1 1") errs.push_back("schema_version must be 'STARKP1 1'");
    if (record_id.empty()) errs.push_back("record_id empty");
    if (created_utc.empty()) errs.push_back("created_utc empty");
    if (stark_phase != "P1") errs.push_back("stark_phase must be 'P1'");
    if (kind != "profiler" && kind != "benchmark" && kind != "baseline" && kind != "telemetry")
        errs.push_back("kind must be one of: profiler, benchmark, baseline, telemetry");
    if (experiment_id.empty()) errs.push_back("experiment_id empty");
    if (hardware.isNull()) errs.push_back("hardware snapshot missing (records must embed hardware)");
    if (software.isNull()) errs.push_back("software block missing");
    if (status == RunStatus::SKIPPED || status == RunStatus::NOT_ATTEMPTED || status == RunStatus::FAILED) {
        if (status_reason.empty())
            errs.push_back("status_reason required for status " + std::string(run_status_name(status)));
    }
    if (!statistics.has_value() && (kind == "benchmark" || kind == "baseline") && status == RunStatus::PASSED)
        errs.push_back("passed benchmark/baseline record requires statistics");
    if (statistics.has_value() && statistics->computed && statistics->samples.empty())
        errs.push_back("statistics computed but samples empty");
    // A PASSED benchmark/baseline record must carry COMPUTED statistics: an
    // uncomputed statistics block is not valid measurement evidence. This is the
    // smallest schema correction; serialization format is unchanged.
    if ((kind == "benchmark" || kind == "baseline") && status == RunStatus::PASSED &&
        statistics.has_value() && !statistics->computed)
        errs.push_back("passed benchmark/baseline record requires computed statistics");
    // v2.3: skip_attestation, when present, must be an object or null. A
    // malformed attestation is a malformed record (fail closed).
    if (!skip_attestation.isNull() && !skip_attestation.isObject())
        errs.push_back("skip_attestation must be an object or null");
    return errs;
}

// ---------------------------------------------------------------------------
// RecordStore
// ---------------------------------------------------------------------------
RecordStore::RecordStore(std::string directory) : dir_(std::move(directory)) {}
RecordStore::~RecordStore() = default;

bool ExperimentRecord::has(const std::string& key) const {
    return provenance.count(key) > 0;
}

const JsonValue& ExperimentRecord::get(const std::string& key) const {
    auto it = provenance.find(key);
    if (it == provenance.end())
        throw std::runtime_error("experiment record provenance: missing key '" + key + "'");
    return it->second;
}

static void ensure_directory(const std::string& dir) {
#ifdef _WIN32
    int rc = _mkdir(dir.c_str());
    if (rc != 0 && errno != EEXIST) {
        // Try recursive creation
        std::string partial;
        for (size_t i = 0; i <= dir.size(); ++i) {
            if (i == dir.size() || dir[i] == '/' || dir[i] == '\\') {
                if (!partial.empty()) _mkdir(partial.c_str());
            }
            partial += dir[i < dir.size() ? i : 0];
            if (i < dir.size() && (dir[i] == '/' || dir[i] == '\\')) { /* already appended */ }
        }
        rc = _mkdir(dir.c_str());
        if (rc != 0 && errno != EEXIST) throw std::runtime_error("cannot create directory: " + dir);
    }
#else
    // mkdir -p
    std::string partial;
    for (size_t i = 0; i < dir.size(); ++i) {
        partial += dir[i];
        if (dir[i] == '/') { mkdir(partial.c_str(), 0755); }
    }
    mkdir(dir.c_str(), 0755);
    struct stat st{};
    if (stat(dir.c_str(), &st) != 0 || !S_ISDIR(st.st_mode))
        throw std::runtime_error("cannot create directory: " + dir);
#endif
}

void RecordStore::append(const ExperimentRecord& record) const {
    // A record id is a basename, never a path. Do this before creating anything.
    const auto& id = record.record_id;
    if (id.empty() || id == "." || id == ".." || id.size() > 200 ||
        !std::all_of(id.begin(), id.end(), [](unsigned char c) {
            return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
                   (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.';
        })) throw std::runtime_error("record_id must be a safe basename (1..200 ASCII characters)");
    const std::string content = record.serialize();
    ensure_directory(dir_);
    const std::filesystem::path directory(dir_);
    const auto destination = directory / (id + ".json");

    // Atomically reserve a private staging directory. Different writers (including
    // different processes) cannot truncate each other's temporary payloads.
    static std::atomic<unsigned long long> counter{0};
    std::filesystem::path staging;
    for (unsigned attempt = 0; attempt < 128; ++attempt) {
        const auto tick = std::chrono::steady_clock::now().time_since_epoch().count();
        const auto candidate = directory / (".append-" + std::to_string(tick) + "-" +
                                             std::to_string(counter.fetch_add(1)));
        std::error_code error;
        if (std::filesystem::create_directory(candidate, error)) { staging = candidate; break; }
        if (error) throw std::runtime_error("cannot reserve record staging directory: " + error.message());
    }
    if (staging.empty()) throw std::runtime_error("could not reserve unique record staging directory");
    struct Cleanup {
        std::filesystem::path directory;
        ~Cleanup() { std::error_code ignored; std::filesystem::remove_all(directory, ignored); }
    } cleanup{staging};
    const auto temporary = staging / "payload";
    {
        std::ofstream out(temporary, std::ios::binary | std::ios::trunc);
        if (!out) throw std::runtime_error("cannot open record staging file");
        out << content;
        out.close();
        if (!out) throw std::runtime_error("record staging write/close failed");
    }
    // Hard-link publication is atomic and fails if destination exists. In
    // particular, NEVER remove an existing record to make rename succeed.
    // Filesystems without hard-link support fail closed. This is atomic visibility,
    // not a promise of power-loss durability (no file/directory fsync is claimed).
    std::error_code error;
    std::filesystem::create_hard_link(temporary, destination, error);
    if (error) throw std::runtime_error("record not published (duplicate id or unsupported storage): " + error.message());
}

std::vector<RecordStore::Entry> RecordStore::loadAll() const {
    std::vector<Entry> entries;
#ifdef _WIN32
    WIN32_FIND_DATAA fd{};
    HANDLE h = FindFirstFileA((dir_ + "\\*.json").c_str(), &fd);
    if (h == INVALID_HANDLE_VALUE) return entries;
    do {
        if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) continue;
        Entry e;
        e.path = dir_ + "/" + fd.cFileName;
        std::ifstream in(e.path, std::ios::binary);
        if (!in) { e.parse_ok = false; e.error = "cannot open"; entries.push_back(std::move(e)); continue; }
        std::stringstream ss; ss << in.rdbuf();
        try {
            e.record = ExperimentRecord::parse(ss.str());
            e.parse_ok = true;
        } catch (const std::exception& ex) {
            e.parse_ok = false;
            e.error = ex.what();
        }
        entries.push_back(std::move(e));
    } while (FindNextFileA(h, &fd));
    FindClose(h);
#else
    DIR* d = opendir(dir_.c_str());
    if (!d) return entries;
    struct dirent* de;
    while ((de = readdir(d)) != nullptr) {
        std::string name = de->d_name;
        if (name.size() < 6 || name.substr(name.size() - 5) != ".json") continue;
        Entry e;
        e.path = dir_ + "/" + name;
        std::ifstream in(e.path, std::ios::binary);
        if (!in) { e.parse_ok = false; e.error = "cannot open"; entries.push_back(std::move(e)); continue; }
        std::stringstream ss; ss << in.rdbuf();
        try {
            e.record = ExperimentRecord::parse(ss.str());
            e.parse_ok = true;
        } catch (const std::exception& ex) {
            e.parse_ok = false;
            e.error = ex.what();
        }
        entries.push_back(std::move(e));
    }
    closedir(d);
#endif
    std::sort(entries.begin(), entries.end(), [](const Entry& a, const Entry& b) { return a.path < b.path; });
    return entries;
}

std::string RecordStore::utc_timestamp_now() {
    using clock = std::chrono::system_clock;
    auto now = clock::now();
    std::time_t t = clock::to_time_t(now);
    auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(now.time_since_epoch()).count() % 1000;
    std::tm tm{};
#ifdef _WIN32
    gmtime_s(&tm, &t);
#else
    gmtime_r(&t, &tm);
#endif
    char buf[64];
    std::snprintf(buf, sizeof(buf), "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ",
                  tm.tm_year + 1900, tm.tm_mon + 1, tm.tm_mday,
                  tm.tm_hour, tm.tm_min, tm.tm_sec, static_cast<int>(ms));
    return buf;
}

} // namespace stark_p1
