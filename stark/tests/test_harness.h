#pragma once

#include <cstdio>
#include <cstdlib>
#include <string>

namespace test {

// Global counters shared by every test binary.
extern int assertions;
extern int failures;

// Name of the currently running test (set by each main()).
extern const char* test_name;

/// Set the name of the test currently being run.
void set_test_name(const char* name);

/// Print a final summary and return a nonzero exit code on any failure.
int report();

} // namespace test

// --- CHECK macro: evaluates the condition, prints on failure, never disabled. ---
#define CHECK(cond)                                                    \
    do {                                                               \
        ++test::assertions;                                            \
        if (!(cond)) {                                                 \
            ++test::failures;                                          \
            std::fprintf(stderr, "[%s] CHECK FAILED: %s (line %d)\n",  \
                         test::test_name, #cond, __LINE__);            \
        }                                                              \
    } while (0)

// --- CHECK_MSG: same as CHECK but also prints a custom message on failure. ---
#define CHECK_MSG(cond, msg)                                           \
    do {                                                               \
        ++test::assertions;                                            \
        if (!(cond)) {                                                 \
            ++test::failures;                                          \
            std::fprintf(stderr, "[%s] CHECK FAILED: %s (line %d): %s\n", \
                         test::test_name, #cond, __LINE__, (msg));     \
        }                                                              \
    } while (0)
