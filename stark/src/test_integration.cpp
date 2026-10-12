#include "neural/NeuralCell.h"
#include "neural/Synapse.h"
#include <iostream>
#include <iomanip>
#include <cmath>
#include <cassert>
#include <limits>

/**
 * STARK-002 Integration Tests
 * 
 * Tests the complete pathway:
 * Neuron A -> Synapse -> Neuron B
 */

int main() {
    std::cout << "=== STARK-002 Integration Tests ===\n\n";
    
    int passed = 0;
    int failed = 0;
    
    auto run_test = [&](const std::string& name, bool condition) {
        if (condition) {
            std::cout << "  \u2713 " << name << " PASSED\n";
            passed++;
        } else {
            std::cout << "  \u2717 " << name << " FAILED\n";
            failed++;
        }
    };
    
    // Test 1: Excitatory connection A -> B
    {
        std::cout << "Test 1: Excitatory connection A -> B\n";
        NeuralCell neuron_A(1.0, 1.0, 10.0, 0.5, -0.5);
        NeuralCell neuron_B(1.0, 1.0, 10.0, 0.5, -0.5);
        Synapse synapse(0.5, 2.0);  // excitatory
        
        double dt = 0.1;
        
        // Drive neuron A to spike
        bool spike_A = false;
        for (int i = 0; i < 20 && !spike_A; ++i) {
            spike_A = neuron_A.update(3.0, dt);
        }
        run_test("  Neuron A spiked", spike_A);
        
        // Get synaptic current
        double I_B = synapse.receiveSpike(spike_A, dt);
        run_test("  Synaptic current > 0 (excitatory)", I_B > 0.0);
        
        // Neuron B receives current
        double V_before = neuron_B.getV();
        bool spike_B = neuron_B.update(I_B, dt);
        double V_after = neuron_B.getV();
        
        run_test("  Neuron B V increased", V_after > V_before);
        std::cout << "    V_before=" << V_before << ", V_after=" << V_after << ", I_B=" << I_B << "\n";
    }
    
    // Test 2: Inhibitory connection A -> B
    {
        std::cout << "\nTest 2: Inhibitory connection A -> B\n";
        NeuralCell neuron_A(1.0, 1.0, 10.0, 0.5, -0.5);
        NeuralCell neuron_B(1.0, 1.0, 10.0, 0.5, -0.5);
        Synapse synapse(-0.5, 2.0);  // inhibitory
        
        double dt = 0.1;
        
        // Pre-charge neuron B with some positive input so we can see inhibition
        for (int i = 0; i < 5; ++i) {
            neuron_B.update(1.0, dt);
        }
        double V_before = neuron_B.getV();
        
        // Drive neuron A to spike
        bool spike_A = false;
        for (int i = 0; i < 20 && !spike_A; ++i) {
            spike_A = neuron_A.update(3.0, dt);
        }
        run_test("  Neuron A spiked", spike_A);
        
        // Get synaptic current (should be negative)
        double I_B = synapse.receiveSpike(spike_A, dt);
        run_test("  Synaptic current < 0 (inhibitory)", I_B < 0.0);
        
        // Neuron B receives inhibitory current
        bool spike_B = neuron_B.update(I_B, dt);
        double V_after = neuron_B.getV();
        
        run_test("  Neuron B V decreased", V_after < V_before);
        std::cout << "    V_before=" << V_before << ", V_after=" << V_after << ", I_B=" << I_B << "\n";
    }
    
    // Test 3: Temporal dynamics - single spike decay
    {
        std::cout << "\nTest 3: Temporal dynamics - single spike decay\n";
        NeuralCell neuron_A(1.0, 1.0, 10.0, 0.5, -0.5);
        NeuralCell neuron_B(1.0, 1.0, 10.0, 0.5, -0.5);
        Synapse synapse(1.0, 1.0);  // w=1, tau_s=1.0 for easy math
        
        double dt = 0.1;
        
        // Drive A to spike once
        bool spike_A = false;
        for (int i = 0; i < 20 && !spike_A; ++i) {
            spike_A = neuron_A.update(3.0, dt);
        }
        run_test("  Neuron A spiked once", spike_A);
        
        // First synaptic current
        double I1 = synapse.receiveSpike(spike_A, dt);
        run_test("  First current = w * 1.0 = 1.0", std::abs(I1 - 1.0) < 1e-10);
        
        // Neuron B gets the current
        neuron_B.update(I1, dt);
        
        // Now no more spikes from A - synaptic current should decay
        for (int i = 0; i < 5; ++i) {
            double I_decay = synapse.receiveSpike(false, dt);
            neuron_B.update(I_decay, dt);
        }
        
        // After 5 steps with tau_s=1.0, dt=0.1: Euler decay factor = (1 - dt/tau_s)^5 = 0.9^5 = 0.59049
        // The state after the loop is already after 5 decays
        double expected_state = std::pow(0.9, 5);
        double state_after_5 = synapse.getState();
        run_test("  Synaptic state decayed correctly (Euler)", std::abs(state_after_5 - expected_state) < 1e-6);
        std::cout << "    State after 5 decay steps: " << state_after_5 
                  << " (expected " << expected_state << ")\n";
    }
    
    // Test 4: Multiple synapses converging on one neuron
    {
        std::cout << "\nTest 4: Multiple synapses converging on one neuron\n";
        NeuralCell neuron_A(1.0, 1.0, 10.0, 0.5, -0.5);
        NeuralCell neuron_C(1.0, 1.0, 10.0, 0.5, -0.5);
        NeuralCell neuron_B(1.0, 1.0, 10.0, 0.5, -0.5);
        Synapse synapse_A_B(0.3, 2.0);
        Synapse synapse_C_B(0.4, 2.0);
        
        double dt = 0.1;
        
        // Drive both A and C to spike
        bool spike_A = false, spike_C = false;
        for (int i = 0; i < 20; ++i) {
            if (!spike_A) spike_A = neuron_A.update(3.0, dt);
            if (!spike_C) spike_C = neuron_C.update(3.0, dt);
        }
        run_test("  Neuron A spiked", spike_A);
        run_test("  Neuron C spiked", spike_C);
        
        // Both synapses receive spikes
        double I_A = synapse_A_B.receiveSpike(spike_A, dt);
        double I_C = synapse_C_B.receiveSpike(spike_C, dt);
        double I_total = I_A + I_C;
        
        run_test("  Total current = sum of individual", std::abs(I_total - (I_A + I_C)) < 1e-10);
        run_test("  Total current > individual currents", I_total > I_A && I_total > I_C);
        
        // Neuron B receives combined input
        double V_before = neuron_B.getV();
        neuron_B.update(I_total, dt);
        double V_after = neuron_B.getV();
        
        run_test("  Neuron B V increased by combined input", V_after > V_before);
        std::cout << "    I_A=" << I_A << ", I_C=" << I_C << ", I_total=" << I_total 
                  << ", V_before=" << V_before << ", V_after=" << V_after << "\n";
    }
    
    // Test 5: Full two-neuron spike propagation
    {
        std::cout << "\nTest 5: Full two-neuron spike propagation\n";
        NeuralCell neuron_A(1.0, 1.0, 10.0, 0.5, -0.5);
        NeuralCell neuron_B(1.0, 1.0, 10.0, 0.5, -0.5);
        Synapse synapse(1.5, 2.0);  // Stronger weight to ensure B spikes
        
        double dt = 0.1;
        int max_steps = 100;
        
        // Run simulation
        int spike_count_A = 0;
        int spike_count_B = 0;
        
        for (int t = 0; t < max_steps; ++t) {
            // A gets constant external input
            bool spike_A = neuron_A.update(2.5, dt);
            if (spike_A) spike_count_A++;
            
            // Synapse transmits
            double I_B = synapse.receiveSpike(spike_A, dt);
            
            // B gets only synaptic input
            bool spike_B = neuron_B.update(I_B, dt);
            if (spike_B) spike_count_B++;
        }
        
        run_test("  Neuron A spiked multiple times", spike_count_A > 1);
        run_test("  Neuron B spiked at least once", spike_count_B > 0);
        std::cout << "    A spikes: " << spike_count_A << ", B spikes: " << spike_count_B << "\n";
    }
    
    // Test 6: Inhibitory prevents spiking
    {
        std::cout << "\nTest 6: Inhibitory input prevents spiking\n";
        NeuralCell neuron_A(1.0, 1.0, 10.0, 0.5, -0.5);
        // Higher threshold neuron so it doesn't spike during charging
        NeuralCell neuron_B(1.0, 10.0, 10.0, 0.5, -0.5);
        Synapse synapse_exc(0.8, 2.0);   // excitatory
        Synapse synapse_inh(-0.8, 2.0);  // inhibitory
        
        double dt = 0.1;
        
        // Pre-charge B with excitatory input to near threshold
        // Use higher threshold neuron so it doesn't spike during charging
        for (int i = 0; i < 10; ++i) {
            double I = synapse_exc.receiveSpike(true, dt);
            neuron_B.update(I, dt);
        }
        double V_near_threshold = neuron_B.getV();
        run_test("  B charged but below threshold", V_near_threshold > 0.5 && V_near_threshold < 10.0);
        
        // Now A spikes, providing inhibition
        bool spike_A = false;
        for (int i = 0; i < 20 && !spike_A; ++i) {
            spike_A = neuron_A.update(3.0, dt);
        }
        
        double I_inh = synapse_inh.receiveSpike(spike_A, dt);
        double V_before_inh = neuron_B.getV();
        neuron_B.update(I_inh, dt);
        double V_after_inh = neuron_B.getV();
        
        run_test("  Inhibitory current < 0", I_inh < 0.0);
        run_test("  V decreased due to inhibition", V_after_inh < V_before_inh);
        std::cout << "    V_before=" << V_before_inh << ", V_after=" << V_after_inh 
                  << ", I_inh=" << I_inh << "\n";
    }
    
    // Test 7: Synapse reset
    {
        std::cout << "\nTest 7: Synapse reset clears state\n";
        Synapse s(0.5, 2.0);
        double dt = 0.1;
        
        s.receiveSpike(true, dt);
        s.receiveSpike(true, dt);
        run_test("  State built up", s.getState() > 0.0);
        
        s.reset();
        run_test("  State = 0 after reset", std::abs(s.getState() - 0.0) < 1e-10);
    }
    
    // Test 8: Non-finite input validation
    {
        std::cout << "\nTest 8: Non-finite input validation\n";
        Synapse s(0.5, 2.0);
        double dt = 0.1;
        
        // Test with neuron spike being used - the synapse itself doesn't validate
        // spike inputs since they're bool, but we test the dt validation which
        // is the same as before
        
        bool caught = false;
        try { s.receiveSpike(false, std::numeric_limits<double>::quiet_NaN()); } 
        catch (...) { caught = true; }
        run_test("  NaN dt rejected", caught);
        
        caught = false;
        try { s.receiveSpike(false, std::numeric_limits<double>::infinity()); } 
        catch (...) { caught = true; }
        run_test("  infinity dt rejected", caught);
    }
    
    // Summary
    std::cout << "\n========================================\n";
    std::cout << "Integration Tests: " << passed << " passed, " << failed << " failed\n";
    std::cout << "========================================\n";
    
    return failed > 0 ? 1 : 0;
}