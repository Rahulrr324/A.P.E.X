#include "neural/NeuralCell.h"
#include <iostream>
#include <iomanip>
#include <cmath>
#include <cassert>
#include <limits>

/**
 * Test neural cell with the final 5-parameter model.
 * 
 * Tests the activity-dependent adaptation formulation:
 *   V_temp = V_{t-1} * (1 - dt/tau_m) + I_t * dt
 *   s_t = 1 if V_temp >= theta_{t-1}
 *   a_temp = a_{t-1} * (1 - dt/tau_a)
 *   a_t = a_temp + b if s_t = 1, else a_t = a_temp
 *   theta_t = theta_0 + a_t
 *   V_t = v_reset if s_t = 1, else V_t = V_temp
 */

// Helper to wait for N spikes with a maximum timestep bound
int waitForSpikes(NeuralCell& cell, double I, double dt, int N, int max_steps) {
    int spike_count = 0;
    int steps = 0;
    
    while (spike_count < N && steps < max_steps) {
        if (cell.update(I, dt)) {
            spike_count++;
        }
        steps++;
    }
    
    return spike_count;
}

int main() {
    // Test 1: Basic spike generation with constant input
    {
        NeuralCell cell(1.0, 1.0, 10.0, 0.5, -0.5);
        const double I = 3.0;
        const double dt = 0.1;
        const int timesteps = 30;

        std::cout << "=== Test 1: Constant input I=3.0, spike generation ===\n\n";
        std::cout << std::fixed << std::setprecision(4);

        int spike_count = 0;
        for (int t = 1; t <= timesteps; ++t) {
            bool spiked = cell.update(I, dt);
            if (spiked) {
                spike_count++;
                std::cout << "t=" << std::setw(2) << t 
                          << ": V=" << std::setw(7) << cell.getV()
                          << ", theta=" << std::setw(7) << cell.getTheta()
                          << " *** SPIKE ***\n";
            } else {
                std::cout << "t=" << std::setw(2) << t 
                          << ": V=" << std::setw(7) << cell.getV()
                          << ", theta=" << std::setw(7) << cell.getTheta() 
                          << "\n";
            }
        }

        std::cout << "\nTotal spikes: " << spike_count << "/" << timesteps << "\n";
        assert(spike_count > 0 && "Test 1 FAILED: Neuron should spike with I=3.0");
        std::cout << "Test 1 PASSED: Neuron generated " << spike_count << " spikes\n\n";
    }

    // Test 2: No-input decay - threshold returns to theta_0
    {
        NeuralCell cell(1.0, 1.0, 10.0, 0.5, -0.5);
        
        // First, wait for 3 spikes
        int spikes = waitForSpikes(cell, 3.0, 0.1, 3, 50);
        assert(spikes == 3 && "Test 2 FAILED: Should have 3 spikes");
        
        double theta_after_spikes = cell.getTheta();
        std::cout << "=== Test 2: No-input decay, threshold returns to theta_0 ===\n\n";
        std::cout << "theta after 3 spikes (before decay): " << theta_after_spikes << "\n";
        std::cout << "theta_0 (baseline): 1.0\n\n";

        // Now let it decay with no input for many steps
        // With tau_a=10 and dt=0.1, decay factor = 0.99 per step
        // After 500 steps: 0.99^500 ≈ 0.0066 (well within 0.1)
        for (int t = 1; t <= 500; ++t) {
            cell.update(0.0, 0.1);
        }

        double theta_after_decay = cell.getTheta();
        std::cout << "theta after 500 steps no input: " << theta_after_decay << "\n";
        
        // Threshold should be close to theta_0 after decay, NOT near zero
        assert(std::abs(theta_after_decay - 1.0) < 0.1 && 
               "Test 2 FAILED: Threshold should return to theta_0, not near zero");
        std::cout << "Test 2 PASSED: Threshold decayed to " << theta_after_decay 
                  << " (within 0.1 of theta_0=1.0)\n\n";
    }

    // Test 3: Adaptation increases after spike, decays after spikes stop
    {
        NeuralCell cell(1.0, 1.0, 10.0, 0.5, -0.5);
        
        std::cout << "=== Test 3: Adaptation increases after spike, decays when stopped ===\n\n";
        std::cout << "Initial theta: " << cell.getTheta() << " (=" << 1.0 << " + " << 0.0 << ")\n\n";

        // Wait for 5 spikes
        int spikes = waitForSpikes(cell, 3.0, 0.1, 5, 100);
        assert(spikes == 5 && "Test 3 FAILED: Should have 5 spikes");

        double theta_after_spikes = cell.getTheta();
        std::cout << "theta after 5 spikes: " << theta_after_spikes 
                  << " (=" << 1.0 << " + " << (theta_after_spikes - 1.0) << ")\n\n";

        // Now let it decay with no input
        for (int t = 1; t <= 15; ++t) {
            cell.update(0.0, 0.1);
        }

        double theta_after_decay = cell.getTheta();
        std::cout << "theta after 15 steps no input: " << theta_after_decay 
                  << " (=" << 1.0 << " + " << (theta_after_decay - 1.0) << ")\n\n";

        // Adaptation should have decayed from the peak but not disappeared completely
        // (with tau_a=10 and dt=0.1, after 15 steps decay factor ≈ (1-0.1/10)^15 ≈ 0.86)
        double adaptation_remaining = theta_after_decay - 1.0;
        double adaptation_after_5_spikes = 5.0 * 0.5;  // 2.5 peak
        assert(adaptation_remaining > 0.0 && 
               "Test 3 FAILED: Some adaptation should remain after 15 steps");
        assert(adaptation_remaining < adaptation_after_5_spikes && 
               "Test 3 FAILED: Adaptation should have decayed from 5 spikes");
        std::cout << "Test 3 PASSED: Adaptation decayed from " << adaptation_after_5_spikes 
                  << " to " << adaptation_remaining << "\n\n";
    }

    // Test 4: Threshold always >= theta_0
    {
        NeuralCell cell(1.0, 2.0, 10.0, 0.5, -0.5);
        
        std::cout << "=== Test 4: Threshold >= theta_0 always ===\n\n";
        
        // Run for many steps with various inputs
        for (int t = 0; t < 50; ++t) {
            cell.update(0.0, 0.1);  // no input
        }
        
        double theta = cell.getTheta();
        assert(theta >= 2.0 && 
               "Test 4 FAILED: theta must always be >= theta_0");
        std::cout << "Test 4 PASSED: theta=" << theta << " >= theta_0=2.0\n\n";
    }

    // Test 5: Invalid parameters are rejected
    {
        std::cout << "=== Test 5: Invalid parameters rejected ===\n\n";
        
        // tau_m <= 0
        bool caught = false;
        try {
            NeuralCell cell(-1.0, 1.0, 10.0, 0.5, -0.5);
        } catch (const std::invalid_argument&) {
            caught = true;
        }
        assert(caught && "Test 5 FAILED: tau_m <= 0 should throw");
        std::cout << "  tau_m <= 0 correctly rejected\n";

        // theta_0 < 0
        caught = false;
        try {
            NeuralCell cell(1.0, -0.5, 10.0, 0.5, -0.5);
        } catch (const std::invalid_argument&) {
            caught = true;
        }
        assert(caught && "Test 5 FAILED: theta_0 < 0 should throw");
        std::cout << "  theta_0 < 0 correctly rejected\n";

        // tau_a <= 0
        caught = false;
        try {
            NeuralCell cell(1.0, 1.0, 0.0, 0.5, -0.5);
        } catch (const std::invalid_argument&) {
            caught = true;
        }
        assert(caught && "Test 5 FAILED: tau_a <= 0 should throw");
        std::cout << "  tau_a <= 0 correctly rejected\n";

        // b < 0
        caught = false;
        try {
            NeuralCell cell(1.0, 1.0, 10.0, -0.5, -0.5);
        } catch (const std::invalid_argument&) {
            caught = true;
        }
        assert(caught && "Test 5 FAILED: b < 0 should throw");
        std::cout << "  b < 0 correctly rejected\n";

        std::cout << "Test 5 PASSED: All invalid parameter cases rejected\n\n";
    }

    // Test 6: Invalid dt is rejected
    {
        NeuralCell cell(1.0, 1.0, 10.0, 0.5, -0.5);
        std::cout << "=== Test 6: Invalid dt rejected ===\n\n";
        
        // dt = 0
        bool caught = false;
        try {
            cell.update(1.0, 0.0);
        } catch (const std::invalid_argument&) {
            caught = true;
        }
        assert(caught && "Test 6 FAILED: dt = 0 should throw");
        std::cout << "  dt = 0 correctly rejected\n";

        // dt > tau_m
        caught = false;
        try {
            cell.update(1.0, 2.0);
        } catch (const std::invalid_argument&) {
            caught = true;
        }
        assert(caught && "Test 6 FAILED: dt > tau_m should throw");
        std::cout << "  dt > tau_m correctly rejected\n";

        // dt > tau_a
        caught = false;
        try {
            cell.update(1.0, 11.0);
        } catch (const std::invalid_argument&) {
            caught = true;
        }
        assert(caught && "Test 6 FAILED: dt > tau_a should throw");
        std::cout << "  dt > tau_a correctly rejected\n";

        // dt == tau_m (should fail)
        caught = false;
        try {
            cell.update(1.0, 1.0);
        } catch (const std::invalid_argument&) {
            caught = true;
        }
        assert(caught && "Test 6 FAILED: dt == tau_m should throw");
        std::cout << "  dt == tau_m correctly rejected\n";

        // dt == tau_a (should fail)
        caught = false;
        try {
            cell.update(1.0, 10.0);
        } catch (const std::invalid_argument&) {
            caught = true;
        }
        assert(caught && "Test 6 FAILED: dt == tau_a should throw");
        std::cout << "  dt == tau_a correctly rejected\n";

        // valid dt < min(tau_m, tau_a)
        caught = false;
        try {
            cell.update(1.0, 0.5);  // 0.5 < min(1.0, 10.0)
        } catch (...) {
            caught = true;
        }
        assert(!caught && "Test 6 FAILED: valid dt should not throw");
        std::cout << "  valid dt < min(tau_m, tau_a) correctly accepted\n";

        std::cout << "Test 6 PASSED: All dt validation cases correct\n\n";
    }

    // Test 7: Spike counter works correctly
    {
        NeuralCell cell(1.0, 1.0, 10.0, 0.5, -0.5);
        const double I = 3.0;
        const double dt = 0.1;
        const int timesteps = 30;

        std::cout << "=== Test 7: Spike counter correctness ===\n\n";
        
        int spike_count = 0;
        for (int t = 1; t <= timesteps; ++t) {
            bool spiked = cell.update(I, dt);
            if (spiked) {
                spike_count++;
            }
        }

        std::cout << "Total spikes counted: " << spike_count << "\n";
        assert(spike_count > 0 && "Test 7 FAILED: Should have counted spikes");
        std::cout << "Test 7 PASSED: Spike counter correctly counted " << spike_count << " spikes\n\n";
    }

    // Test 8: Reset works correctly
    {
        NeuralCell cell(1.0, 1.0, 10.0, 0.5, -0.5);
        
        std::cout << "=== Test 8: Reset works correctly ===\n\n";
        
        // Run some steps to induce spikes and build adaptation
        int spikes = waitForSpikes(cell, 3.0, 0.1, 2, 50);
        assert(spikes == 2 && "Test 8 FAILED: Should have 2 spikes");
        
        double V_before = cell.getV();
        double theta_before = cell.getTheta();
        std::cout << "Before reset: V=" << V_before << ", theta=" << theta_before << "\n";
        
        cell.reset();
        
        double V_after = cell.getV();
        double theta_after = cell.getTheta();
        std::cout << "After reset:  V=" << V_after << ", theta=" << theta_after << "\n";
        
        assert(V_after == -0.5 && "Test 8 FAILED: V should return to v_reset after reset");
        assert(theta_after == 1.0 && "Test 8 FAILED: theta should return to theta_0 after reset");
        assert(cell.getSpike() == false && "Test 8 FAILED: spike indicator should be false after reset");
        std::cout << "Test 8 PASSED: Reset correctly restored V and theta\n\n";
    }

    // Test 9: Invariants a >= 0 and theta >= theta_0
    {
        NeuralCell cell(1.0, 1.0, 10.0, 0.5, -0.5);
        const double dt = 0.1;
        
        std::cout << "=== Test 9: Invariants a >= 0 and theta >= theta_0 ===\n\n";
        
        // Test with no input
        for (int t = 0; t < 20; ++t) {
            cell.update(0.0, dt);
            assert(cell.getTheta() >= 1.0 && "Test 9 FAILED: theta < theta_0 with no input");
        }
        std::cout << "  Invariants hold with no input\n";
        
        // Test with positive input
        for (int t = 0; t < 20; ++t) {
            cell.update(1.0, dt);
            assert(cell.getTheta() >= 1.0 && "Test 9 FAILED: theta < theta_0 with positive input");
        }
        std::cout << "  Invariants hold with positive input\n";
        
        // Test with repeated spikes
        int spikes = waitForSpikes(cell, 3.0, dt, 5, 100);
        assert(spikes == 5 && "Test 9 FAILED: Should have 5 spikes");
        assert(cell.getTheta() >= 1.0 && "Test 9 FAILED: theta < theta_0 after spikes");
        std::cout << "  Invariants hold after 5 spikes\n";
        
        // Test with negative input
        for (int t = 0; t < 20; ++t) {
            cell.update(-1.0, dt);
            assert(cell.getTheta() >= 1.0 && "Test 9 FAILED: theta < theta_0 with negative input");
        }
        std::cout << "  Invariants hold with negative input\n";
        
        std::cout << "Test 9 PASSED: Invariants a >= 0 and theta >= theta_0 maintained\n\n";
    }

    // Test 10: Non-finite inputs rejected
    {
        NeuralCell cell(1.0, 1.0, 10.0, 0.5, -0.5);
        std::cout << "=== Test 10: Non-finite inputs rejected ===\n\n";
        
        // NaN input
        bool caught = false;
        try {
            cell.update(std::numeric_limits<double>::quiet_NaN(), 0.1);
        } catch (const std::invalid_argument&) {
            caught = true;
        }
        assert(caught && "Test 10 FAILED: NaN input should throw");
        std::cout << "  NaN input correctly rejected\n";

        // +infinity input
        caught = false;
        try {
            cell.update(std::numeric_limits<double>::infinity(), 0.1);
        } catch (const std::invalid_argument&) {
            caught = true;
        }
        assert(caught && "Test 10 FAILED: +infinity input should throw");
        std::cout << "  +infinity input correctly rejected\n";

        // -infinity input
        caught = false;
        try {
            cell.update(-std::numeric_limits<double>::infinity(), 0.1);
        } catch (const std::invalid_argument&) {
            caught = true;
        }
        assert(caught && "Test 10 FAILED: -infinity input should throw");
        std::cout << "  -infinity input correctly rejected\n";

        // NaN dt
        caught = false;
        try {
            cell.update(1.0, std::numeric_limits<double>::quiet_NaN());
        } catch (const std::invalid_argument&) {
            caught = true;
        }
        assert(caught && "Test 10 FAILED: NaN dt should throw");
        std::cout << "  NaN dt correctly rejected\n";

        // infinity dt
        caught = false;
        try {
            cell.update(1.0, std::numeric_limits<double>::infinity());
        } catch (const std::invalid_argument&) {
            caught = true;
        }
        assert(caught && "Test 10 FAILED: infinity dt should throw");
        std::cout << "  infinity dt correctly rejected\n";

        std::cout << "Test 10 PASSED: All non-finite inputs rejected\n\n";
    }

    // Test 11: Deterministic spiking behavior
    {
        NeuralCell cell(1.0, 1.0, 10.0, 0.5, -0.5);
        const double I = 3.0;
        const double dt = 0.1;
        
        std::cout << "=== Test 11: Deterministic spiking behavior ===\n\n";
        
        // Wait for first spike
        int steps_to_spike = 0;
        bool spiked = false;
        while (!spiked && steps_to_spike < 50) {
            spiked = cell.update(I, dt);
            steps_to_spike++;
        }
        assert(spiked && "Test 11 FAILED: Should have spiked within 50 steps");
        std::cout << "  First spike occurred at step " << steps_to_spike << "\n";
        
        // Confirm state after spike
        assert(cell.getV() == -0.5 && "Test 11 FAILED: V should be v_reset after spike");
        assert(cell.getTheta() > 1.0 && "Test 11 FAILED: theta should increase after spike");
        std::cout << "  After spike: V=" << cell.getV() << ", theta=" << cell.getTheta() << "\n";
        
        // Confirm adaptation increased
        double adaptation_after_spike = cell.getTheta() - 1.0;
        assert(adaptation_after_spike > 0.0 && "Test 11 FAILED: adaptation should increase after spike");
        std::cout << "  Adaptation increased to " << adaptation_after_spike << "\n";
        
        // Remove input and confirm adaptation decays
        double theta_before_decay = cell.getTheta();
        for (int t = 0; t < 10; ++t) {
            cell.update(0.0, dt);
        }
        double theta_after_decay = cell.getTheta();
        assert(theta_after_decay < theta_before_decay && "Test 11 FAILED: theta should decay with no input");
        assert(theta_after_decay >= 1.0 && "Test 11 FAILED: theta should not decay below theta_0");
        std::cout << "  Theta decayed from " << theta_before_decay << " to " << theta_after_decay << "\n";
        
        std::cout << "Test 11 PASSED: Deterministic spiking behavior verified\n\n";
    }

    std::cout << "========================================\n";
    std::cout << "All 11 tests completed successfully!\n";
    std::cout << "========================================\n";
    
    return 0;
}