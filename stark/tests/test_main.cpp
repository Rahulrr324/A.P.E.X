#include "test_harness.h"

namespace test {

int assertions = 0;
int failures = 0;
const char* test_name = "<unknown>";

void set_test_name(const char* name) {
    test_name = name;
}

int report() {
    if (failures == 0) {
        std::printf("PASS: %s (%d assertions)\n", test_name, assertions);
        return 0;
    }
    std::printf("FAIL: %s (%d assertions, %d failures)\n", test_name, assertions, failures);
    return 1;
}

} // namespace test
