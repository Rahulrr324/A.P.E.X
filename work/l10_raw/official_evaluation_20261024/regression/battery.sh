#!/bin/bash
# STARK canonical regression battery — run from stark/ (the documented working
# directory). Identical target list to the L10.1 / L10.2 / L10.3 batteries.
# Preserved as a file in the evidence directory so the suite is reproducible.
set -u
cd "$(dirname "$0")/../../../../stark" || exit 2   # -> stark/ (evidence sits under <repo>/work/l10_raw/...)
pwd
B=${BATTERY_OUT:-/home/user/l104/build/battery}
mkdir -p "$B" build/dev_bin 2>/dev/null
CORE="src/learning/ContextConditionedMemory.cpp src/learning/RelevanceRouting.cpp src/neural/NeuralCell.cpp src/neural/Synapse.cpp src/neural/Network.cpp"
P1="src/phase1/common/ExperimentRecord.cpp src/phase1/common/HardwareProfiler.cpp src/phase1/common/HardwareAffinity.cpp src/phase1/bench/BudgetLedger.cpp src/phase1/bench/ParameterAccounting.cpp src/phase1/bench/BenchmarkHarness.cpp src/phase1/bench/TinyDenseModel.cpp src/phase1/gates.cpp"
LR="src/neural/NeuralCell.cpp src/neural/Synapse.cpp src/neural/Network.cpp"
COREONLY="src/neural/NeuralCell.cpp src/neural/Synapse.cpp src/neural/Network.cpp"
run(){ # name src extra
  name=$1; src=$2; extra=${3:-}
  g++ -O2 -std=c++17 -Isrc -Isrc/phase1 -I. -o "$B/$name" "$src" $extra 2> "$B/$name.build.log"
  if [ $? -ne 0 ]; then echo "BUILD_FAIL $name"; echo "BUILD_FAIL $name" > "$B/$name.log"; return; fi
  out=$("$B/$name" 2>&1); rc=$?
  echo "EXIT $rc  $name  $(echo "$out" | tail -1)"
  echo "$out" > "$B/$name.log"
}
run test_neuron src/test_neuron.cpp "$COREONLY"
run test_params src/test_params.cpp "$COREONLY"
run test_synapse src/test_synapse.cpp "src/neural/Synapse.cpp"
run test_integration src/test_integration.cpp "$COREONLY"
run test_network src/test_network.cpp "$COREONLY"
run test_stdp tests/test_stdp.cpp "$COREONLY"
run test_homeostasis tests/test_homeostasis.cpp "$COREONLY"
run test_three_factor tests/test_three_factor.cpp "$COREONLY"
run test_serialization tests/test_serialization.cpp "$COREONLY"
run test_learning_loop tests/test_learning_loop.cpp "src/learning/ToyAssociationTask.cpp $LR"
run test_delayed_reward tests/test_delayed_reward.cpp "src/learning/ToyAssociationTask.cpp $LR"
run test_sequential_context tests/test_sequential_context.cpp "src/learning/ToyAssociationTask.cpp $LR"
run test_associative_memory tests/test_associative_memory.cpp "src/learning/AssociativeMemoryTask.cpp $LR"
run test_eligibility_gating tests/test_eligibility_gating.cpp "src/learning/AssociativeMemoryTask.cpp $LR"
run test_learned_relevance tests/test_learned_relevance.cpp "src/learning/RelevanceRouting.cpp $LR"
run test_n_way_learned_relevance tests/test_n_way_learned_relevance.cpp "src/learning/RelevanceRouting.cpp $LR"
run test_context_conditioned_memory tests/test_context_conditioned_memory.cpp "$CORE"
run test_l10_structural_audit tests/test_l10_structural_audit.cpp "$CORE"
run test_l10_1_sealing tests/test_l10_1_sealing.cpp "$CORE"
run n_way_learned_relevance_loop_L8 src/learning/n_way_learned_relevance_loop_L8.cpp "src/learning/RelevanceRouting.cpp $LR"
for t in profiler accounting budget records reproducibility gates; do
  run test_phase1_$t tests/test_phase1_$t.cpp "tests/test_main.cpp $P1 -include sys/statvfs.h -include string.h"
done

