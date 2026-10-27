cmake_minimum_required(VERSION 3.15)
project(STARK-006 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Include directories
include_directories(${CMAKE_SOURCE_DIR}/src)

# STARK-002 simulation
add_executable(stark_002
    src/main.cpp
    src/neural/NeuralCell.h
    src/neural/NeuralCell.cpp
    src/neural/Synapse.h
    src/neural/Synapse.cpp
)

# STARK-001 tests
add_executable(test_neuron
    src/test_neuron.cpp
    src/neural/NeuralCell.cpp
)
add_executable(test_params
    src/test_params.cpp
    src/neural/NeuralCell.cpp
)

# STARK-002 tests
add_executable(test_synapse
    src/test_synapse.cpp
    src/neural/Synapse.cpp
)
add_executable(test_integration
    src/test_integration.cpp
    src/neural/NeuralCell.cpp
    src/neural/Synapse.cpp
)
add_executable(network_demo
    src/network_demo.cpp
    src/neural/NeuralCell.cpp
    src/neural/Synapse.cpp
    src/neural/Network.cpp
)

# STARK-004 STDP tests and demo
add_executable(test_stdp
    tests/test_stdp.cpp
    src/neural/NeuralCell.cpp
    src/neural/Synapse.cpp
    src/neural/Network.cpp
)
add_executable(stdp_demo
    tests/examples/stdp_demo.cpp
    src/neural/NeuralCell.cpp
    src/neural/Synapse.cpp
    src/neural/Network.cpp
)

# STARK-005 Homeostasis tests
add_executable(test_homeostasis
    tests/test_homeostasis.cpp
    src/neural/NeuralCell.cpp
    src/neural/Synapse.cpp
    src/neural/Network.cpp
)
add_executable(homeostasis_demo
    tests/examples/homeostasis_demo.cpp
    src/neural/NeuralCell.cpp
    src/neural/Synapse.cpp
    src/neural/Network.cpp
)

target_compile_features(stark_002 PUBLIC cxx_std_17)
target_compile_features(test_neuron PUBLIC cxx_std_17)
target_compile_features(test_params PUBLIC cxx_std_17)
target_compile_features(test_synapse PUBLIC cxx_std_17)
target_compile_features(test_integration PUBLIC cxx_std_17)

# STARK-003 network test (pre-existing target in the archive; wired into the
# build through the older CMakeLists). Kept here so the Phase-1 build is
# self-contained.
add_executable(test_network
    src/test_network.cpp
    src/neural/NeuralCell.cpp
    src/neural/Synapse.cpp
    src/neural/Network.cpp
)
target_compile_features(test_network PUBLIC cxx_std_17)

target_compile_features(network_demo PUBLIC cxx_std_17)
target_compile_features(test_stdp PUBLIC cxx_std_17)
target_compile_features(stdp_demo PUBLIC cxx_std_17)
target_compile_features(test_homeostasis PUBLIC cxx_std_17)
target_compile_features(homeostasis_demo PUBLIC cxx_std_17)

# STARK-006 Three-factor modulator-gated plasticity tests and demo
add_executable(test_three_factor
    tests/test_three_factor.cpp
    src/neural/NeuralCell.cpp
    src/neural/Synapse.cpp
    src/neural/Network.cpp
)
target_compile_features(test_three_factor PUBLIC cxx_std_17)
add_executable(three_factor_demo
    tests/examples/three_factor_demo.cpp
    src/neural/NeuralCell.cpp
    src/neural/Synapse.cpp
    src/neural/Network.cpp
)
target_compile_features(three_factor_demo PUBLIC cxx_std_17)

# STARK-007 Serialization & Experiment Harness tests
add_executable(test_serialization
    tests/test_serialization.cpp
    src/neural/NeuralCell.cpp
    src/neural/Synapse.cpp
    src/neural/Network.cpp
    src/experiment/Recorder.cpp
    src/experiment/Experiment.cpp
)
target_compile_features(test_serialization PUBLIC cxx_std_17)
add_executable(serialization_demo
    tests/examples/serialization_demo.cpp
    src/neural/NeuralCell.cpp
    src/neural/Synapse.cpp
    src/neural/Network.cpp
    src/experiment/Recorder.cpp
    src/experiment/Experiment.cpp
)

# STARK-L1 reproducible reward-modulated learning loop (toy association task).
# Design + frozen success criteria: design/learning_loop_milestone.md
add_executable(learning_loop
    src/learning/learning_loop.cpp
    src/learning/ToyAssociationTask.cpp
    src/neural/NeuralCell.cpp
    src/neural/Synapse.cpp
    src/neural/Network.cpp
)
target_compile_features(learning_loop PUBLIC cxx_std_17)

add_executable(test_learning_loop
    tests/test_learning_loop.cpp
    src/learning/ToyAssociationTask.cpp
    src/neural/NeuralCell.cpp
    src/neural/Synapse.cpp
    src/neural/Network.cpp
)
target_compile_features(test_learning_loop PUBLIC cxx_std_17)

# STARK-L2 delayed-reward learning (temporal credit assignment across a
# decision->reward gap). Design + frozen protocol: design/delayed_reward_milestone.md
add_executable(delayed_reward_loop
    src/learning/delayed_reward_loop.cpp
    src/learning/ToyAssociationTask.cpp
    src/neural/NeuralCell.cpp
    src/neural/Synapse.cpp
    src/neural/Network.cpp
)
target_compile_features(delayed_reward_loop PUBLIC cxx_std_17)

add_executable(test_delayed_reward
    tests/test_delayed_reward.cpp
    src/learning/ToyAssociationTask.cpp
    src/neural/NeuralCell.cpp
    src/neural/Synapse.cpp
    src/neural/Network.cpp
)
target_compile_features(test_delayed_reward PUBLIC cxx_std_17)
target_compile_features(serialization_demo PUBLIC cxx_std_17)

# STARK-L3 sequential-context learning (early cue + distractor sequence +
# delayed reward; persistent-activity attractor). Frozen protocol:
# design/sequential_context_milestone.md
add_executable(sequential_context_loop
    src/learning/sequential_context_loop.cpp
    src/learning/ToyAssociationTask.cpp
    src/neural/NeuralCell.cpp
    src/neural/Synapse.cpp
    src/neural/Network.cpp
)
target_compile_features(sequential_context_loop PUBLIC cxx_std_17)

add_executable(test_sequential_context
    tests/test_sequential_context.cpp
    src/learning/ToyAssociationTask.cpp
    src/neural/NeuralCell.cpp
    src/neural/Synapse.cpp
    src/neural/Network.cpp
)
target_compile_features(test_sequential_context PUBLIC cxx_std_17)

# STARK-L4 multi-item associative memory (learned cue->response bindings,
# interference, save/reload). Frozen protocol:
# design/associative_memory_milestone.md
add_executable(associative_memory_loop
    src/learning/associative_memory_loop.cpp
    src/learning/AssociativeMemoryTask.cpp
    src/neural/NeuralCell.cpp
    src/neural/Synapse.cpp
    src/neural/Network.cpp
)
target_compile_features(associative_memory_loop PUBLIC cxx_std_17)

add_executable(test_associative_memory
    tests/test_associative_memory.cpp
    src/learning/AssociativeMemoryTask.cpp
    src/neural/NeuralCell.cpp
    src/neural/Synapse.cpp
    src/neural/Network.cpp
)
target_compile_features(test_associative_memory PUBLIC cxx_std_17)

# STARK-L5 eligibility-gated credit assignment (pre-synaptic eligibility
# gate; training with distractors). Frozen protocol:
# design/eligibility_gating_milestone.md
add_executable(eligibility_gating_loop
    src/learning/eligibility_gating_loop.cpp
    src/learning/AssociativeMemoryTask.cpp
    src/neural/NeuralCell.cpp
    src/neural/Synapse.cpp
    src/neural/Network.cpp
)
target_compile_features(eligibility_gating_loop PUBLIC cxx_std_17)

add_executable(test_eligibility_gating
    tests/test_eligibility_gating.cpp
    src/learning/AssociativeMemoryTask.cpp
    src/neural/NeuralCell.cpp
    src/neural/Synapse.cpp
    src/neural/Network.cpp
)
target_compile_features(test_eligibility_gating PUBLIC cxx_std_17)

# STARK-L6 learned relevance routing (self-organized attention; REINFORCE
# over routing state). Frozen protocol: design/learned_relevance_milestone.md
add_executable(learned_relevance_loop
    src/learning/learned_relevance_loop.cpp
    src/learning/RelevanceRouting.cpp
    src/neural/NeuralCell.cpp
    src/neural/Synapse.cpp
    src/neural/Network.cpp
)
target_compile_features(learned_relevance_loop PUBLIC cxx_std_17)

add_executable(test_learned_relevance
    tests/test_learned_relevance.cpp
    src/learning/RelevanceRouting.cpp
    src/neural/NeuralCell.cpp
    src/neural/Synapse.cpp
    src/neural/Network.cpp
)
target_compile_features(test_learned_relevance PUBLIC cxx_std_17)

# STARK-L7 N-way learned relevance (no hand-designed slot prior; scales to
# N=2,4,8 channels/contexts). Frozen protocol: design/n_way_learned_relevance_milestone.md
add_executable(n_way_learned_relevance_loop
    src/learning/n_way_learned_relevance_loop.cpp
    src/learning/RelevanceRouting.cpp
    src/neural/NeuralCell.cpp
    src/neural/Synapse.cpp
    src/neural/Network.cpp
)
target_compile_features(n_way_learned_relevance_loop PUBLIC cxx_std_17)

add_executable(test_n_way_learned_relevance
    tests/test_n_way_learned_relevance.cpp
    src/learning/RelevanceRouting.cpp
    src/neural/NeuralCell.cpp
    src/neural/Synapse.cpp
    src/neural/Network.cpp
)
target_compile_features(test_n_way_learned_relevance PUBLIC cxx_std_17)

# STARK-L8 N-way learning recovery (F1b p1count80 + F2a softmax_half fix).
# Frozen protocol: design/n_way_learning_recovery_milestone.md
add_executable(n_way_learned_relevance_loop_L8
    src/learning/n_way_learned_relevance_loop_L8.cpp
    src/learning/RelevanceRouting.cpp
    src/neural/NeuralCell.cpp
    src/neural/Synapse.cpp
    src/neural/Network.cpp
)
target_compile_features(n_way_learned_relevance_loop_L8 PUBLIC cxx_std_17)

# STARK-L9: Continual learning and catastrophic forgetting benchmark.
# Frozen protocol: design/continual_learning_milestone.md
add_executable(continual_learning_loop
    src/learning/continual_learning_loop.cpp
    src/learning/RelevanceRouting.cpp
    src/neural/NeuralCell.cpp
    src/neural/Synapse.cpp
    src/neural/Network.cpp
)
target_compile_features(continual_learning_loop PUBLIC cxx_std_17)

# STARK-L10: Context-conditioned memory and continual learning (CCM).
# Frozen protocol: design/context_conditioned_memory_milestone.md v1.6
add_executable(context_conditioned_memory_loop
    src/learning/context_conditioned_memory_loop.cpp
    src/learning/ContextConditionedMemory.cpp
    src/learning/RelevanceRouting.cpp
    src/neural/NeuralCell.cpp
    src/neural/Synapse.cpp
    src/neural/Network.cpp
)
target_compile_features(context_conditioned_memory_loop PUBLIC cxx_std_17)

add_executable(test_context_conditioned_memory
    tests/test_context_conditioned_memory.cpp
    src/learning/ContextConditionedMemory.cpp
    src/learning/RelevanceRouting.cpp
    src/neural/NeuralCell.cpp
    src/neural/Synapse.cpp
    src/neural/Network.cpp
)
target_compile_features(test_context_conditioned_memory PUBLIC cxx_std_17)

# STARK-L10 validation: independent structural audit of the CCM agent
# (bank isolation, shared-pathway enumeration, serialization of lifecycle state).
add_executable(test_l10_structural_audit
    tests/test_l10_structural_audit.cpp
    src/learning/ContextConditionedMemory.cpp
    src/learning/RelevanceRouting.cpp
    src/neural/NeuralCell.cpp
    src/neural/Synapse.cpp
    src/neural/Network.cpp
)
target_compile_features(test_l10_structural_audit PUBLIC cxx_std_17)

# STARK-L10 validation: independent experiment harness (reproduces the frozen
# protocol from the design document and runs exploratory variants). Not part of
# the frozen evaluation path.
add_executable(l10_validation_harness
    src/learning/l10_validation_harness.cpp
    src/learning/ContextConditionedMemory.cpp
    src/learning/RelevanceRouting.cpp
    src/neural/NeuralCell.cpp
    src/neural/Synapse.cpp
    src/neural/Network.cpp
)
target_compile_features(l10_validation_harness PUBLIC cxx_std_17)

# STARK-L10.1: focused regression test for the sealing toggle (write predicate,
# gate state, readability of a sealed bank, multi-candidate trials).
add_executable(test_l10_1_sealing
    tests/test_l10_1_sealing.cpp
    src/learning/ContextConditionedMemory.cpp
    src/learning/RelevanceRouting.cpp
    src/neural/NeuralCell.cpp
    src/neural/Synapse.cpp
    src/neural/Network.cpp
)
target_compile_features(test_l10_1_sealing PUBLIC cxx_std_17)

# STARK-L11.10: the cross-family (2:1 / 3:1) cue constructor.
# Additive only: a new source file, a new test target, no existing target is
# touched and the L10 harness keeps its own cue construction unchanged.
add_executable(test_l11_cue_constructor
    tests/test_l11_cue_constructor.cpp
    src/learning/L11CueConstruction.cpp
    src/learning/ContextConditionedMemory.cpp
    src/learning/RelevanceRouting.cpp
    src/neural/NeuralCell.cpp
    src/neural/Synapse.cpp
    src/neural/Network.cpp
)
target_compile_features(test_l11_cue_constructor PUBLIC cxx_std_17)

# ============================================================
# STARK Phase 1 (M0): measurement infrastructure
# New targets only; existing STARK-001..007 targets are unchanged.
# ============================================================

# ---------------------------------------------------------------------------
# Single production library.
#
# All Phase-1 implementation lives in exactly ONE static library and every
# executable (CLIs and tests) LINKS it instead of recompiling the sources.
# The previous layout compiled the same .cpp files into every executable
# independently (the archive was built but never linked), which duplicated
# code and, when a target also linked the archive, produced duplicate-symbol
# link errors. Linking the single archive with no duplicate compilation is the
# correct fix. No global linker flags are required: the g++ driver already
# links libstdc++, libgcc and libgcc_eh for C++ targets.
set(STARK_PHASE1_SOURCES
    src/phase1/common/ExperimentRecord.cpp
    src/phase1/common/HardwareProfiler.cpp
    src/phase1/common/HardwareAffinity.cpp
    src/phase1/bench/BudgetLedger.cpp
    src/phase1/bench/ParameterAccounting.cpp
    src/phase1/bench/BenchmarkHarness.cpp
    src/phase1/bench/TinyDenseModel.cpp
    src/phase1/gates.cpp
)

add_library(stark_phase1 STATIC ${STARK_PHASE1_SOURCES})
target_compile_features(stark_phase1 PUBLIC cxx_std_17)
target_include_directories(stark_phase1 PUBLIC
    ${CMAKE_SOURCE_DIR}/src/phase1
    ${CMAKE_SOURCE_DIR}/src
    ${CMAKE_CURRENT_SOURCE_DIR})

# Make Phase-1 binaries self-contained w.r.t. the GCC runtime.
#
# Evidence (v1.4 investigation): on this host the WinLibs UCRT toolchain's
# directory is at PATH position ~58, while Git-for-Windows' MSVCRT
# libstdc++-6.dll is at position 1. A dynamically linked WinLibs UCRT binary
# therefore loads the MSVCRT libstdc++-6.dll at runtime, producing an ABI
# mismatch that segfaults inside std::string/IO paths (observed: fault inside
# RecordStore::append -> libstdc++-6.dll from C:\Program Files\Git\mingw64).
# Prepending the WinLibs bin to PATH makes the same binary pass, proving the
# fault is DLL resolution, not code. Statically linking the GCC runtime removes
# the PATH dependency for every Phase-1 executable. This is a concrete,
# reproducible fix; it is unrelated to the previously removed speculative
# global -lgcc -lgcc_eh -lstdc++ flags.
if(WIN32 AND CMAKE_CXX_COMPILER_ID STREQUAL "GNU")
    target_link_options(stark_phase1 INTERFACE -static-libgcc -static-libstdc++)
endif()
if(STARK_ENABLE_CUDA)
    target_compile_definitions(stark_phase1 PUBLIC STARK_ENABLE_CUDA)
    target_include_directories(stark_phase1 PUBLIC ${CUDAToolkit_INCLUDE_DIRS})
    target_link_libraries(stark_phase1 PUBLIC ${CUDAToolkit_LIBRARY_DIR}/cudart.lib)
endif()
if(WIN32)
    target_link_libraries(stark_phase1 PUBLIC psapi)
endif()

# ---- Production CLIs (aggregate, profiler_cli, run_baseline) ----
add_executable(profiler_cli src/phase1/profiler_cli.cpp)
target_link_libraries(profiler_cli PRIVATE stark_phase1)
target_compile_features(profiler_cli PUBLIC cxx_std_17)

add_executable(run_baseline src/phase1/baselines/run_baseline.cpp)
target_link_libraries(run_baseline PRIVATE stark_phase1)
target_compile_features(run_baseline PUBLIC cxx_std_17)

add_executable(aggregate src/phase1/aggregate.cpp)
target_link_libraries(aggregate PRIVATE stark_phase1)
target_compile_features(aggregate PUBLIC cxx_std_17)

# Read-only developer inspection; never registered as an automated test.
add_executable(record_inspector src/phase1/record_inspector.cpp)
target_link_libraries(record_inspector PRIVATE stark_phase1)
target_compile_features(record_inspector PUBLIC cxx_std_17)

# ---- G7 Resolution Campaign ----
add_executable(g7_campaign src/phase1/campaign/G7Campaign.cpp)
target_link_libraries(g7_campaign PRIVATE stark_phase1)
target_compile_features(g7_campaign PUBLIC cxx_std_17)

# ---- Phase-1 automated tests (spec §K) ----
# Genuine automated tests that return nonzero on any failed assertion.
# test_main.cpp provides the counting CHECK framework (active under NDEBUG).
# Each test builds from the full Phase-1 source set (ExperimentRecord,
# HardwareProfiler, BudgetLedger, ParameterAccounting, BenchmarkHarness,
# TinyDenseModel) plus its own test source and test_main.cpp.
foreach(t profiler accounting budget records reproducibility gates helper_equivalence store_safety json_codec)
    add_executable(test_phase1_${t}
        tests/test_phase1_${t}.cpp
        tests/test_main.cpp)
    target_link_libraries(test_phase1_${t} PRIVATE stark_phase1)
    target_compile_features(test_phase1_${t} PUBLIC cxx_std_17)
endforeach()

find_package(Threads REQUIRED)
target_link_libraries(test_phase1_store_safety PRIVATE Threads::Threads)

# C5b: test_phase1_affinity exercises the Windows affinity API (DWORD_PTR,
# GetProcessAffinityMask) and cannot be compiled on any other platform. It used to be
# generated by the foreach() above, which made 'cmake --build' fail on POSIX. It is
# now declared only where it can build, and its CTest registration is guarded together
# with it (see the add_test block below).
if(WIN32)
    add_executable(test_phase1_affinity
        tests/test_phase1_affinity.cpp
        tests/test_main.cpp)
    target_link_libraries(test_phase1_affinity PRIVATE stark_phase1)
    target_compile_features(test_phase1_affinity PUBLIC cxx_std_17)
else()
    message(STATUS "STARK: skipping target test_phase1_affinity (Windows-only: DWORD_PTR)")
endif()

# ============================================================
# C5: Windows-only targets.
#
# The five targets below include <windows.h> and/or link the Windows-only
# libraries pdh / powrprof, so they cannot be configured or built on any other
# platform. They are guarded instead of being left to fail at compile time.
# Each skip prints a STATUS line so a target never disappears silently.
# ============================================================

# ---- Temporary Windows affinity root-cause diagnostic (investigation only) ----
if(WIN32)
    add_executable(test_windows_affinity_diag
        tests/test_windows_affinity_diag.cpp)
    target_link_libraries(test_windows_affinity_diag PRIVATE stark_phase1)
    target_compile_features(test_windows_affinity_diag PUBLIC cxx_std_17)
else()
    message(STATUS "STARK: skipping target test_windows_affinity_diag (Windows-only: <windows.h>)")
endif()

# ---- Production-path affinity evidence capture (investigation only) ----
# Exercises the actual HardwareAffinity production path post-fix. Not a CTest test.
if(WIN32)
    add_executable(test_production_affinity_evidence
        tests/test_production_affinity_evidence.cpp)
    target_link_libraries(test_production_affinity_evidence PRIVATE stark_phase1)
    target_compile_features(test_production_affinity_evidence PUBLIC cxx_std_17)
else()
    message(STATUS "STARK: skipping target test_production_affinity_evidence (Windows-only: <windows.h>)")
endif()

# ---- Frequency/power-state evidence diagnostic (investigation only) ----
# Records CPU frequency/power telemetry around unchanged production benchmark
# execs. Not a CTest test; writes no STARKP1 records.
if(WIN32)
    add_executable(diag_frequency_evidence
        tests/diag_frequency_evidence.cpp)
    target_link_libraries(diag_frequency_evidence PRIVATE stark_phase1 pdh powrprof)
    target_compile_features(diag_frequency_evidence PUBLIC cxx_std_17)
else()
    message(STATUS "STARK: skipping target diag_frequency_evidence (Windows-only: pdh/powrprof)")
endif()

# ---- Session-scoped power-scheme control (stability-gate validation) ----
# Documented PowerGetActiveScheme/PowerSetActiveScheme only. Applies the High
# performance scheme around a child command and ALWAYS restores the original.
# Not a CTest test; writes no STARKP1 records.
if(WIN32)
    add_executable(power_scheme_control
        tests/power_scheme_control.cpp)
    target_link_libraries(power_scheme_control PRIVATE powrprof)
    target_compile_features(power_scheme_control PUBLIC cxx_std_17)
else()
    message(STATUS "STARK: skipping target power_scheme_control (Windows-only: powrprof)")
endif()

# ---- High-resolution frequency diagnostic (investigation only) ----
# Per-iteration QPC brackets + tight-loop PDH collector thread around the
# UNCHANGED production benchmark path. Not a CTest test; writes no STARKP1
# records.
if(WIN32)
    add_executable(diag_highres_frequency
        tests/diag_highres_frequency.cpp)
    target_link_libraries(diag_highres_frequency PRIVATE stark_phase1 pdh)
    target_compile_features(diag_highres_frequency PUBLIC cxx_std_17)
else()
    message(STATUS "STARK: skipping target diag_highres_frequency (Windows-only: pdh)")
endif()

# ---- CTest integration (M0 audit evidence) ----
enable_testing()

# Genuine automated test: returns nonzero on any failed assertion (CONFIG,
# BUDGET, PROFILER, RECORDS, REPRODUCIBILITY). Diagnostic-only programs are
# not registered as CTest tests.
add_test(NAME test_phase1_profiler
         COMMAND test_phase1_profiler
         WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR})
add_test(NAME test_phase1_accounting
         COMMAND test_phase1_accounting
         WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR})
add_test(NAME test_phase1_budget
         COMMAND test_phase1_budget
         WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR})
add_test(NAME test_phase1_records
         COMMAND test_phase1_records
         WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR})
add_test(NAME test_phase1_reproducibility
         COMMAND test_phase1_reproducibility
         WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR})
add_test(NAME test_phase1_gates
         COMMAND test_phase1_gates
         WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR})
# Compatibility unit test: historical helper namespace vs retained harness, not
# an official baseline arm and not evidence that the M0 contract is accepted.
add_test(NAME test_phase1_helper_equivalence
         COMMAND test_phase1_helper_equivalence
         WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR})

add_test(NAME test_phase1_store_safety
         COMMAND test_phase1_store_safety
         WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR})

add_test(NAME test_phase1_json_codec
         COMMAND test_phase1_json_codec
         WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR})

# test_phase1_affinity is Windows-only (uses DWORD_PTR/GetProcessAffinityMask),
# so it is registered only where it can actually build and run.
if(WIN32)
    add_test(NAME test_phase1_affinity
             COMMAND test_phase1_affinity
             WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR})
else()
    message(STATUS "STARK: skipping CTest test_phase1_affinity (Windows-only)")
endif()


# ============================================================
# B7 isolated diagnostic (INVESTIGATION ONLY)
#
# Dedicated target for src/phase1/diagnostics/bm_b7_diagnostic.cpp: the
# first build/execution evidence for that diagnostic. It is deliberately
# minimal and isolated:
#   - it compiles ONLY the diagnostic plus its dependency closure
#     (TinyDenseModel -> ParameterAccounting -> ExperimentRecord), so no
#     unrelated Phase-1 translation unit is compiled and NO existing target
#     or production source is modified;
#   - it intentionally does NOT link stark_phase1 (which would pull in
#     gates/BenchmarkHarness/HardwareProfiler and their Windows libs);
#   - it registers no CTest test, writes no STARKP1 record, and creates no
#     G7CAM record. All of its filesystem activity is confined at run time to
#     build/bm_b7_diagnostic/ (enforced by the diagnostic's own isolation
#     guard).
# The static GCC-runtime link mirrors the rationale documented for
# stark_phase1 above (WinLibs UCRT binaries otherwise pick up the MSVCRT
# libstdc++-6.dll at position 1 of PATH).
# ============================================================
set(BM_B7_DIAGNOSTIC_SOURCES
    src/phase1/diagnostics/bm_b7_diagnostic.cpp
    src/phase1/bench/TinyDenseModel.cpp
    src/phase1/bench/ParameterAccounting.cpp
    src/phase1/common/ExperimentRecord.cpp
)
add_executable(bm_b7_diagnostic ${BM_B7_DIAGNOSTIC_SOURCES})
target_include_directories(bm_b7_diagnostic PRIVATE
    ${CMAKE_SOURCE_DIR}/src/phase1
    ${CMAKE_SOURCE_DIR}/src)
target_compile_features(bm_b7_diagnostic PRIVATE cxx_std_17)
if(WIN32 AND CMAKE_CXX_COMPILER_ID STREQUAL "GNU")
    target_link_options(bm_b7_diagnostic PRIVATE -static-libgcc -static-libstdc++)
endif()

# ============================================================
# C6: register the existing test executables with CTest.
#
# Targets below were checked manually; CTest execution remains unverified on
# this host (CMake/CTest are unavailable). Registration requires: (1) its exit code is meaningful (nonzero on
# a failed assertion), (2) it runs with WORKING_DIRECTORY = this directory,
# (3) it is deterministic (no wall-clock or unseeded RNG in the assertions), and
# (4) its runtime is bounded (all of them together take about two seconds on the
# reference host; timings must be rechecked on the deployment host).
#
# Deliberately NOT registered:
#   test_params                      - prints a parameter table, has no assertions
#                                      and cannot fail (design/technical_debt.md).
#   test_windows_affinity_diag       - Windows-only investigation program.
#   test_production_affinity_evidence- investigation program, not a CTest test.
# ============================================================
# test_neuron uses standard assert(), unlike the CHECK-based suites. Keep its
# assertions active in Release builds as well; do not alter any test assertion.
if(MSVC)
    target_compile_options(test_neuron PRIVATE /UNDEBUG)
else()
    target_compile_options(test_neuron PRIVATE -UNDEBUG)
endif()

foreach(t
    test_neuron
    test_synapse
    test_integration
    test_network
    test_stdp
    test_homeostasis
    test_three_factor
    test_serialization
    test_learning_loop
    test_delayed_reward
    test_sequential_context
    test_associative_memory
    test_eligibility_gating
    test_learned_relevance
    test_n_way_learned_relevance
    test_context_conditioned_memory
    test_l10_structural_audit
    test_l10_1_sealing
    test_l11_cue_constructor
)
    add_test(NAME ${t}
             COMMAND ${t}
             WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR})
endforeach()

# Development test hygiene only: bound execution time; no threshold/assertion changes.
get_property(STARK_REGISTERED_TESTS DIRECTORY PROPERTY TESTS)
set_tests_properties(${STARK_REGISTERED_TESTS} PROPERTIES TIMEOUT 180)

# Keep production record tools + automated tests in the default developer build.
# Research drivers/diagnostics remain addressable by their historical target names;
# opting out only excludes them from ALL, it never disables a test or deletes a target.
option(STARK_BUILD_RESEARCH_DRIVERS "Include research drivers/demos in the default build" OFF)
option(STARK_BUILD_DIAGNOSTICS "Include investigation-only diagnostics in the default build" OFF)
set(STARK_RESEARCH_DRIVERS
    stark_002 network_demo stdp_demo homeostasis_demo three_factor_demo serialization_demo
    learning_loop delayed_reward_loop sequential_context_loop associative_memory_loop
    eligibility_gating_loop learned_relevance_loop n_way_learned_relevance_loop
    n_way_learned_relevance_loop_L8 continual_learning_loop context_conditioned_memory_loop
    l10_validation_harness run_baseline g7_campaign)
set(STARK_DIAGNOSTICS
    test_params test_windows_affinity_diag test_production_affinity_evidence
    diag_frequency_evidence power_scheme_control diag_highres_frequency bm_b7_diagnostic)
if(NOT STARK_BUILD_RESEARCH_DRIVERS)
    foreach(target IN LISTS STARK_RESEARCH_DRIVERS)
        if(TARGET ${target})
            set_property(TARGET ${target} PROPERTY EXCLUDE_FROM_ALL TRUE)
            message(STATUS "STARK: ${target} excluded from default build (research driver; explicit target remains available)")
        endif()
    endforeach()
endif()
if(NOT STARK_BUILD_DIAGNOSTICS)
    foreach(target IN LISTS STARK_DIAGNOSTICS)
        if(TARGET ${target})
            set_property(TARGET ${target} PROPERTY EXCLUDE_FROM_ALL TRUE)
            message(STATUS "STARK: ${target} excluded from default build (diagnostic; explicit target remains available)")
        endif()
    endforeach()
endif()
