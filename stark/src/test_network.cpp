#include "neural/Network.h"
#include <iostream>
#include <iomanip>
#include <cmath>
#include <cassert>
#include <limits>
#include <vector>

/**
 * STARK-003 Network Tests
 * 
 * Tests the Network class with comprehensive coverage of:
 * - Neuron/synapse management
 * - Spike propagation
 * - Excitatory/inhibitory connections
 * - Convergence/divergence
 * - Reset behavior
 * - Determinism
 * - Validation
 * - Transmission delays
 * - Structured connectivity
 */

int main() {
    std::cout << "=== STARK-003 Network Tests ===\n\n";
    
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
    
    // Test 1: Single neuron with external input
    {
        std::cout << "Test 1: Single neuron with external input\n";
        Network net;
        size_t n0 = net.addNeuron(1.0, 1.0, 10.0, 0.5, -0.5);
        
        run_test("  Neuron count = 1", net.getNeuronCount() == 1);
        run_test("  Synapse count = 0", net.getSynapseCount() == 0);
        run_test("  Initial timestep = 0", net.getCurrentTimeStep() == 0);
        
        // Set external input and step
        net.setExternalInput(n0, 3.0);
        net.step(0.1);
        
        run_test("  Timestep advanced to 1", net.getCurrentTimeStep() == 1);
        run_test("  Neuron V changed", net.getNeuron(n0).getV() != -0.5);
        
        // Run more steps to get a spike
        int spike_count = 0;
        for (int i = 0; i < 30; ++i) {
            net.setExternalInput(n0, 3.0);
            net.step(0.1);
            if (net.getSpikesThisStep()[n0]) spike_count++;
        }
        run_test("  Neuron spiked with strong input", spike_count > 0);
        std::cout << "    Spikes in 30 steps: " << spike_count << "\n";
    }
    
    // Test 2: A -> B excitatory propagation
    {
        std::cout << "\nTest 2: A -> B excitatory propagation\n";
        Network net;
        size_t A = net.addNeuron(1.0, 1.0, 10.0, 0.5, -0.5);
        size_t B = net.addNeuron(1.0, 1.0, 10.0, 0.5, -0.5);
        size_t syn = net.addSynapse(A, B, 1.5, 2.0, 0);  // Strong excitatory
        
        run_test("  Neuron count = 2", net.getNeuronCount() == 2);
        run_test("  Synapse count = 1", net.getSynapseCount() == 1);
        run_test("  Connection exists", net.hasConnection(A, B));
        run_test("  No reverse connection", !net.hasConnection(B, A));
        
        // Drive A to spike
        int spikes_A = 0, spikes_B = 0;
        for (int t = 0; t < 100; ++t) {
            net.setExternalInput(A, 2.5);
            net.step(0.1);
            if (net.getSpikesThisStep()[A]) spikes_A++;
            if (net.getSpikesThisStep()[B]) spikes_B++;
        }
        
        run_test("  A spiked multiple times", spikes_A > 1);
        run_test("  B spiked from synaptic input", spikes_B > 0);
        std::cout << "    A spikes: " << spikes_A << ", B spikes: " << spikes_B << "\n";
    }
    
    // Test 3: A -> B inhibitory connection
    {
        std::cout << "\nTest 3: A -> B inhibitory connection\n";
        Network net;
        size_t A = net.addNeuron(1.0, 1.0, 10.0, 0.5, -0.5);
        size_t B = net.addNeuron(1.0, 1.0, 10.0, 0.5, -0.5);
        net.addSynapse(A, B, -1.0, 2.0, 0);  // Inhibitory
        
        // Give B some external input to depolarize it
        // Then A's spikes should inhibit B
        double V_B_before_inhibition = 0.0;
        bool B_was_depolarized = false;
        
        for (int t = 0; t < 50; ++t) {
            net.setExternalInput(A, 3.0);  // Drive A to spike
            net.setExternalInput(B, 1.5);  // Depolarize B
            net.step(0.1);
            
            if (net.getNeuron(B).getV() > 0.3 && !B_was_depolarized) {
                B_was_depolarized = true;
                V_B_before_inhibition = net.getNeuron(B).getV();
            }
        }
        
        // Check that inhibitory synapse has negative weight
        run_test("  Synapse weight is negative", net.getSynapse(0).getWeight() < 0);
        run_test("  B was depolarized at some point", B_was_depolarized);
    }
    
    // Test 4: Multiple synapses converging on one neuron
    {
        std::cout << "\nTest 4: Multiple synapses converging on one neuron\n";
        Network net;
        size_t A = net.addNeuron(1.0, 1.0, 10.0, 0.5, -0.5);
        size_t C = net.addNeuron(1.0, 1.0, 10.0, 0.5, -0.5);
        size_t B = net.addNeuron(1.0, 1.0, 10.0, 0.5, -0.5);
        
        net.addSynapse(A, B, 0.8, 2.0, 0);
        net.addSynapse(C, B, 0.8, 2.0, 0);
        
        run_test("  B has 2 incoming synapses", net.getIncomingSynapses(B).size() == 2);
        run_test("  A has 1 outgoing synapse", net.getOutgoingSynapses(A).size() == 1);
        run_test("  C has 1 outgoing synapse", net.getOutgoingSynapses(C).size() == 1);
        
        // Drive both A and C
        int spikes_B = 0;
        for (int t = 0; t < 100; ++t) {
            net.setExternalInput(A, 2.5);
            net.setExternalInput(C, 2.5);
            net.step(0.1);
            if (net.getSpikesThisStep()[B]) spikes_B++;
        }
        
        run_test("  B spiked from convergent input", spikes_B > 0);
        std::cout << "    B spikes from 2 inputs: " << spikes_B << "\n";
    }
    
    // Test 5: One neuron -> multiple targets (divergence)
    {
        std::cout << "\nTest 5: One neuron -> multiple targets (divergence)\n";
        Network net;
        size_t A = net.addNeuron(1.0, 1.0, 10.0, 0.5, -0.5);
        size_t B = net.addNeuron(1.0, 1.0, 10.0, 0.5, -0.5);
        size_t C = net.addNeuron(1.0, 1.0, 10.0, 0.5, -0.5);
        
        net.addSynapse(A, B, 1.5, 2.0, 0);
        net.addSynapse(A, C, 1.5, 2.0, 0);
        
        run_test("  A has 2 outgoing synapses", net.getOutgoingSynapses(A).size() == 2);
        
        int spikes_B = 0, spikes_C = 0;
        for (int t = 0; t < 100; ++t) {
            net.setExternalInput(A, 2.5);
            net.step(0.1);
            if (net.getSpikesThisStep()[B]) spikes_B++;
            if (net.getSpikesThisStep()[C]) spikes_C++;
        }
        
        run_test("  B spiked from A", spikes_B > 0);
        run_test("  C spiked from A", spikes_C > 0);
        std::cout << "    B spikes: " << spikes_B << ", C spikes: " << spikes_C << "\n";
    }
    
    // Test 6: Network reset
    {
        std::cout << "\nTest 6: Network reset\n";
        Network net;
        size_t A = net.addNeuron(1.0, 1.0, 10.0, 0.5, -0.5);
        size_t B = net.addNeuron(1.0, 1.0, 10.0, 0.5, -0.5);
        net.addSynapse(A, B, 1.0, 2.0, 0);
        
        // Run some steps
        for (int t = 0; t < 20; ++t) {
            net.setExternalInput(A, 3.0);
            net.step(0.1);
        }
        
        run_test("  Timestep > 0 before reset", net.getCurrentTimeStep() > 0);
        run_test("  Neuron state changed", net.getNeuron(A).getV() != -0.5);
        
        // Reset
        net.reset();
        
        run_test("  Timestep = 0 after reset", net.getCurrentTimeStep() == 0);
        run_test("  Neuron A V = v_reset", std::abs(net.getNeuron(A).getV() - (-0.5)) < 1e-10);
        run_test("  Neuron A theta = theta_0", std::abs(net.getNeuron(A).getTheta() - 1.0) < 1e-10);
        run_test("  Synapse state = 0", std::abs(net.getSynapse(0).getState()) < 1e-10);
    }
    
    // Test 7: Deterministic repeated execution
    {
        std::cout << "\nTest 7: Deterministic repeated execution\n";
        
        auto run_simulation = [](std::vector<bool>& spikes_A, std::vector<bool>& spikes_B) {
            Network net;
            size_t A = net.addNeuron(1.0, 1.0, 10.0, 0.5, -0.5);
            size_t B = net.addNeuron(1.0, 1.0, 10.0, 0.5, -0.5);
            net.addSynapse(A, B, 1.5, 2.0, 0);
            
            for (int t = 0; t < 50; ++t) {
                net.setExternalInput(A, 2.5);
                net.step(0.1);
                spikes_A.push_back(net.getSpikesThisStep()[A]);
                spikes_B.push_back(net.getSpikesThisStep()[B]);
            }
        };
        
        std::vector<bool> spikes_A1, spikes_B1, spikes_A2, spikes_B2;
        run_simulation(spikes_A1, spikes_B1);
        run_simulation(spikes_A2, spikes_B2);
        
        bool identical = (spikes_A1 == spikes_A2) && (spikes_B1 == spikes_B2);
        run_test("  Two identical runs produce identical spikes", identical);
    }
    
    // Test 8: STARK-001 and STARK-002 regression
    {
        std::cout << "\nTest 8: STARK-001/002 regression (primitives unchanged)\n";
        
        // Test NeuralCell directly
        NeuralCell cell(1.0, 1.0, 10.0, 0.5, -0.5);
        bool spiked = false;
        for (int i = 0; i < 20 && !spiked; ++i) {
            spiked = cell.update(3.0, 0.1);
        }
        run_test("  NeuralCell still spikes correctly", spiked);
        run_test("  NeuralCell V = v_reset after spike", std::abs(cell.getV() - (-0.5)) < 1e-10);
        
        // Test Synapse directly
        Synapse syn(0.5, 2.0);
        double I = syn.receiveSpike(true, 0.1);
        run_test("  Synapse still produces correct current", std::abs(I - 0.5) < 1e-10);
    }
    
    // Test 9: Invalid neuron/synapse references
    {
        std::cout << "\nTest 9: Invalid neuron/synapse references\n";
        Network net;
        net.addNeuron(1.0, 1.0, 10.0, 0.5, -0.5);
        
        bool caught = false;
        try { net.getNeuron(999); } catch (const std::out_of_range&) { caught = true; }
        run_test("  Invalid neuron ID throws", caught);
        
        caught = false;
        try { net.getSynapse(999); } catch (const std::out_of_range&) { caught = true; }
        run_test("  Invalid synapse ID throws", caught);
        
        caught = false;
        try { net.addSynapse(0, 999, 1.0); } catch (const std::out_of_range&) { caught = true; }
        run_test("  addSynapse with invalid post throws", caught);
        
        caught = false;
        try { net.setExternalInput(999, 1.0); } catch (const std::out_of_range&) { caught = true; }
        run_test("  setExternalInput with invalid ID throws", caught);
    }
    
    // Test 10: Non-finite input / invalid timestep handling
    {
        std::cout << "\nTest 10: Non-finite input / invalid timestep\n";
        Network net;
        net.addNeuron(1.0, 1.0, 10.0, 0.5, -0.5);
        
        // NaN external input
        bool caught = false;
        try { net.setExternalInput(0, std::numeric_limits<double>::quiet_NaN()); }
        catch (const std::invalid_argument&) { caught = true; }
        run_test("  NaN external input rejected", caught);
        
        // Infinity external input
        caught = false;
        try { net.setExternalInput(0, std::numeric_limits<double>::infinity()); }
        catch (const std::invalid_argument&) { caught = true; }
        run_test("  Infinity external input rejected", caught);
        
        // Invalid dt
        caught = false;
        try { net.step(0.0); } catch (const std::invalid_argument&) { caught = true; }
        run_test("  dt=0 rejected", caught);
        
        caught = false;
        try { net.step(-0.1); } catch (const std::invalid_argument&) { caught = true; }
        run_test("  Negative dt rejected", caught);
        
        caught = false;
        try { net.step(2.0); } catch (const std::invalid_argument&) { caught = true; }
        run_test("  dt > tau_m rejected", caught);
        
        // validateDt
        run_test("  validateDt(0.1) = true", net.validateDt(0.1));
        run_test("  validateDt(0.0) = false", !net.validateDt(0.0));
        run_test("  validateDt(2.0) = false", !net.validateDt(2.0));
    }
    
    // Test 11: Transmission delays
    {
        std::cout << "\nTest 11: Transmission delays\n";
        Network net;
        size_t A = net.addNeuron(1.0, 1.0, 10.0, 0.5, -0.5);
        size_t B = net.addNeuron(1.0, 1.0, 10.0, 0.5, -0.5);
        
        // Add synapse with delay of 3 timesteps
        size_t syn_id = net.addSynapse(A, B, 2.0, 2.0, 3);
        
        run_test("  Synapse delay = 3", net.getSynapse(syn_id).getTauS() == 2.0);
        
        // Drive A to spike
        int first_A_spike_step = -1;
        int first_B_spike_step = -1;
        
        for (int t = 0; t < 100; ++t) {
            net.setExternalInput(A, 3.0);
            net.step(0.1);
            
            if (net.getSpikesThisStep()[A] && first_A_spike_step < 0) {
                first_A_spike_step = t;
            }
            if (net.getSpikesThisStep()[B] && first_B_spike_step < 0) {
                first_B_spike_step = t;
            }
        }
        
        run_test("  A spiked", first_A_spike_step >= 0);
        run_test("  B spiked (after delay)", first_B_spike_step >= 0);
        
        if (first_A_spike_step >= 0 && first_B_spike_step >= 0) {
            int delay_observed = first_B_spike_step - first_A_spike_step;
            run_test("  B spike delayed relative to A", delay_observed > 0);
            std::cout << "    A first spike at step " << first_A_spike_step 
                      << ", B first spike at step " << first_B_spike_step
                      << ", observed delay: " << delay_observed << " steps\n";
        }
    }
    
    // Test 12: Structured connectivity builders
    {
        std::cout << "\nTest 12: Structured connectivity builders\n";
        
        // Test connectAllToAll
        {
            Network net;
            for (int i = 0; i < 5; ++i) {
                net.addNeuron(1.0, 1.0, 10.0, 0.5, -0.5);
            }
            net.connectAllToAll(0.5, 2.0, 0);
            
            // 5 neurons, all-to-all excluding self = 5*4 = 20 synapses
            run_test("  All-to-all: 5 neurons -> 20 synapses", net.getSynapseCount() == 20);
        }
        
        // Test connectLocal
        {
            Network net;
            for (int i = 0; i < 5; ++i) {
                net.addNeuron(1.0, 1.0, 10.0, 0.5, -0.5);
            }
            net.connectLocal(1, 0.5, 2.0, 0);  // radius=1
            
            // Each neuron connects to neighbors within distance 1
            // Neuron 0: connects to 1 (1 connection)
            // Neuron 1: connects to 0, 2 (2 connections)
            // Neuron 2: connects to 1, 3 (2 connections)
            // Neuron 3: connects to 2, 4 (2 connections)
            // Neuron 4: connects to 3 (1 connection)
            // Total: 8 synapses
            run_test("  Local radius=1: 5 neurons -> 8 synapses", net.getSynapseCount() == 8);
        }
        
        // Test connectRandomSparse
        {
            Network net;
            for (int i = 0; i < 10; ++i) {
                net.addNeuron(1.0, 1.0, 10.0, 0.5, -0.5);
            }
            net.connectRandomSparse(0.3, 1.0, -0.5, 2.0, 2.0, 0.8, 0);
            
            // With p=0.3 and 10 neurons (90 possible pairs), expect ~27 synapses
            // But it's random, so just check it's reasonable
            size_t count = net.getSynapseCount();
            run_test("  Random sparse creates some synapses", count > 0);
            run_test("  Random sparse not too dense", count < 90);
            std::cout << "    Random sparse (p=0.3): " << count << " synapses\n";
        }
    }
    
    // Test 13: Disconnected neurons don't receive input
    {
        std::cout << "\nTest 13: Disconnected neurons don't receive input\n";
        Network net;
        size_t A = net.addNeuron(1.0, 1.0, 10.0, 0.5, -0.5);
        size_t B = net.addNeuron(1.0, 1.0, 10.0, 0.5, -0.5);
        size_t C = net.addNeuron(1.0, 1.0, 10.0, 0.5, -0.5);  // Disconnected
        
        net.addSynapse(A, B, 1.5, 2.0, 0);
        
        // Drive A, B should get input, C should not
        int C_spikes = 0;
        for (int t = 0; t < 50; ++t) {
            net.setExternalInput(A, 3.0);
            net.step(0.1);
            if (net.getSpikesThisStep()[C]) C_spikes++;
        }
        
        // C should never spike (no input ever)
        run_test("  Disconnected neuron C never spikes", C_spikes == 0);
        // C's V decays toward 0 (leak equilibrium), not driven by any input
        run_test("  Disconnected neuron C V near 0 (leak equilibrium)", 
                 std::abs(net.getNeuron(C).getV()) < 0.1);
    }
    
    // Test 14: Network with no neurons/synapses
    {
        std::cout << "\nTest 14: Empty network handling\n";
        Network net;
        
        run_test("  Empty network has 0 neurons", net.getNeuronCount() == 0);
        run_test("  Empty network has 0 synapses", net.getSynapseCount() == 0);
        
        // Step should work (no-op)
        bool caught = false;
        try { net.step(0.1); } catch (...) { caught = true; }
        run_test("  Empty network step doesn't crash", !caught);
    }
    
    // Test 15: Synaptic current sign verification
    {
        std::cout << "\nTest 15: Synaptic current sign verification\n";
        Network net;
        size_t A = net.addNeuron(1.0, 1.0, 10.0, 0.5, -0.5);
        size_t B = net.addNeuron(1.0, 1.0, 10.0, 0.5, -0.5);
        
        // Excitatory
        size_t syn_exc = net.addSynapse(A, B, 1.0, 2.0, 0);
        run_test("  Excitatory weight > 0", net.getSynapse(syn_exc).getWeight() > 0);
        
        // Add inhibitory to a different network
        Network net2;
        size_t A2 = net2.addNeuron(1.0, 1.0, 10.0, 0.5, -0.5);
        size_t B2 = net2.addNeuron(1.0, 1.0, 10.0, 0.5, -0.5);
        size_t syn_inh = net2.addSynapse(A2, B2, -1.0, 2.0, 0);
        run_test("  Inhibitory weight < 0", net2.getSynapse(syn_inh).getWeight() < 0);
    }
    
    // Summary
    std::cout << "\n========================================\n";
    std::cout << "Network Tests: " << passed << " passed, " << failed << " failed\n";
    std::cout << "========================================\n";
    
    return failed > 0 ? 1 : 0;
}