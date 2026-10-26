/** Codec conformance tests, not a change to any acceptance gate/metric. */
#include <cmath>
#include <cstdint>
#include <limits>
#include <stdexcept>
#include <string>
#include <vector>
#include "test_harness.h"
#include "common/ExperimentRecord.h"
using namespace stark_p1;
namespace {
bool rejects(const std::string& s) {
    try { (void)JsonValue::parse(s); return false; } catch (const std::exception&) { return true; }
}
}
int main() {
    test::set_test_name("test_phase1_json_codec");
    for (const auto& text : {"null", "true", "false", "0", "-0", "1", "-1", "1.0",
                            "1e0", "-1.25e+2", "1E-2", "[]", "{}", "[1,true,null]",
                            "{\"a\":{\"b\":[1,2]}}"}) {
        CHECK(!rejects(text));
        const auto parsed = JsonValue::parse(text);
        CHECK(JsonValue::parse(parsed.dump()).dump() == parsed.dump());
    }
    for (const auto& text : {"+1", "01", "-01", "1.", ".1", "1e", "1E+", "1e-",
                            "1..2", "1.2.3", "1e2e3", "1+2", "1-2", "--1", "-+1",
                            "NaN", "nan", "Infinity", "-Infinity", "1e9999", "",
                            "{", "[", "{\"x\":}", "{\"x\":1,}", "[1,]", "true false",
                            "{\"x\":1,\"x\":2}", "{\"x\":null,\"x\":null}",
                            "\"\\q\"", "\"\\uXYZW\"", "\"\\u123\"",
                            "\"\\uD800\"", "\"\\uDC00\"", "\"\\uD800\\u0041\""}) {
        CHECK_MSG(rejects(text), text);
    }
    CHECK(JsonValue::parse("18446744073709551615").asUInt() == std::numeric_limits<uint64_t>::max());
    CHECK(JsonValue::parse("-9223372036854775808").asInt() == std::numeric_limits<int64_t>::min());
    CHECK(rejects("18446744073709551616"));
    CHECK(rejects("-9223372036854775809"));
    CHECK(JsonValue::parse("\"\\uD83D\\uDE00\"").asString() == "\xF0\x9F\x98\x80");
    CHECK(JsonValue::parse("\"\\u0BA4\\u0BAE\\u0BBF\\u0BB4\\u0BCD\"").asString() == u8"தமிழ்");
    CHECK(JsonValue::parse(JsonValue::str(u8"தமிழ் 😀").dump()).asString() == u8"தமிழ் 😀");
    CHECK(JsonValue::parse("\"\\u0000\"").asString() == std::string(1, '\0'));
    for (unsigned c = 0; c < 32; ++c) {
        CHECK(rejects(std::string("\"") + static_cast<char>(c) + "\""));
        const std::string control(1, static_cast<char>(c));
        CHECK(JsonValue::parse(JsonValue::str(control).dump()).asString() == control);
    }
    for (const std::string& invalid : {std::string("\x80"), std::string("\xC0\xAF"),
            std::string("\xED\xA0\x80"), std::string("\xF4\x90\x80\x80"),
            std::string("\xF5\x80\x80\x80"), std::string("\xE2\x82"), std::string("\xC2x")}) {
        CHECK(rejects("\"" + invalid + "\""));
    }
    // Quoted delimiters/escapes must not be confused with structural delimiters.
    const std::string escapes = "\"\\\"\\\\\\/\\b\\f\\n\\r\\t\"";
    CHECK(JsonValue::parse(escapes).asString() == std::string("\"\\/\b\f\n\r\t"));
    try {
        (void)JsonValue::parse("{\"x\": }");
        CHECK(false);
    } catch (const std::exception& e) {
        CHECK(std::string(e.what()).find("offset 6:") != std::string::npos);
    }
    CHECK(rejects(std::string(140, '[') + "0" + std::string(140, ']')));
    for (double value : {std::numeric_limits<double>::infinity(),
                         -std::numeric_limits<double>::infinity(),
                         std::numeric_limits<double>::quiet_NaN()}) {
        bool threw = false;
        try { (void)JsonValue::number(value); } catch (const std::exception&) { threw = true; }
        CHECK(threw);
    }
    return test::report();
}
