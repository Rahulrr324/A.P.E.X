#include "neural/Synapse.h"
#include <iostream>
#include <iomanip>
#include <cmath>
#include <cassert>
#include <limits>

/**
 * Test the Synapse class with the Euler-discretized first-order model.
 * 
 * Model (explicit Euler discretization of dx/dt = -x/tau_s + s_pre):
 *   x_t = x_{t-1} * (1 - dt/tau_s) + s_pre
 *   I_post = w * x_t
 * 
 * Note: (1 - dt/tau_s)^n is the discrete Euler decay factor,
 * not the exact continuous exponential exp(-n*dt/tau_s).
 */

int main() {
    std::cout << "=== STARK-002 Synapse Tests ===\n\n";
    
    int passed = 0;
    int failed = 0;
    
    auto run_test = [&](const std::string& name, bool condition) {
        if (condition) {
            std::cout << "  ✓ " << name << " PASSED\n";
            passed++;
        } else {
            std::cout << "  ✗ " << name << " FAILED\n";
            failed++;
        }
    };
    
    // Test 1: Synapse initialization
    {
        std::cout << "Test 1: Synapse initialization\n";
        Synapse s(0.5, 2.0);
        run_test("  Initial state x=0", std::abs(s.getState() - 0.0) < 1e-10);
        run_test("  Weight=0.5", std::abs(s.getWeight() - 0.5) < 1e-10);
        run_test("  tau_s=2.0", std::abs(s.getTauS() - 2.0) < 1e-10);
    }
    
    // Test 2: Positive weight (excitatory)
    {
        std::cout << "\nTest 2: Positive weight (excitatory)\n";
        Synapse s(0.5, 2.0);
        double I = s.receiveSpike(true, 0.1);  // pre-spike
        run_test("  I > 0 after spike", I > 0.0);
        run_test("  I = w * x = 0.5 * 1.0 = 0.5", std::abs(I - 0.5) < 1e-10);
    }
    
    // Test 3: Negative weight (inhibitory)
    {
        std::cout << "\nTest 3: Negative weight (inhibitory)\n";
        Synapse s(-0.5, 2.0);
        double I = s.receiveSpike(true, 0.1);
        run_test("  I < 0 after spike", I < 0.0);
        run_test("  I = w * x = -0.5 * 1.0 = -0.5", std::abs(I + 0.5) < 1e-10);
    }
    
    // Test 4: Zero weight (no effect)
    {
        std::cout << "\nTest 4: Zero weight\n";
        Synapse s(0.0, 2.0);
        double I = s.receiveSpike(true, 0.1);
        run_test("  I = 0", std::abs(I - 0.0) < 1e-10);
    }
    
    // Test 5: Spike transmission (state update)
    {
        std::cout << "\nTest 5: Spike transmission and state update\n";
        Synapse s(1.0, 2.0);  // w=1 for easy verification
        double dt = 0.1;
        
        // Before any spike
        run_test("  Initial x=0", std::abs(s.getState() - 0.0) < 1e-10);
        
        // Receive spike
        double I1 = s.receiveSpike(true, dt);
        run_test("  After spike: x=1.0", std::abs(s.getState() - 1.0) < 1e-10);
        run_test("  I = 1.0 * 1.0 = 1.0", std::abs(I1 - 1.0) < 1e-10);
        
        // No spike next step - state should decay
        double I2 = s.receiveSpike(false, dt);
        double expected_x = 1.0 * (1.0 - dt/2.0);  // 1.0 * 0.95 = 0.95
        run_test("  After no spike: x decayed", std::abs(s.getState() - expected_x) < 1e-10);
        run_test("  I decayed", std::abs(I2 - expected_x) < 1e-10);
    }
    
    // Test 6: No-spike behavior (Euler discretization decay)
    {
        std::cout << "\nTest 6: No-spike behavior (Euler discretization decay)\n";
        Synapse s(1.0, 2.0);
        double dt = 0.1;
        
        // Build up state with a spike
        s.receiveSpike(true, dt);
        double x0 = s.getState();  // Should be 1.0
        
        // Decay for 10 steps with no spikes
        for (int i = 0; i < 10; ++i) {
            s.receiveSpike(false, dt);
        }
        
        double x10 = s.getState();
        double expected = x0 * std::pow(1.0 - dt/2.0, 10);  // (1 - dt/tau_s)^10 = 0.95^10
        run_test("  State decayed via Euler discretization", std::abs(x10 - expected) < 1e-10);
        run_test("  State > 0", x10 > 0.0);
        run_test("  State < initial", x10 < x0);
    }
    
    // Test 7: Temporal response - single spike decay
    {
        std::cout << "\nTest 7: Temporal response to single spike\n";
        Synapse s(1.0, 1.0);  // tau_s=1.0 for easy math
        double dt = 0.1;
        
        // Spike at t=1
        s.receiveSpike(true, dt);
        double peak = s.getState();  // 1.0
        run_test("  Peak state = 1.0", std::abs(peak - 1.0) < 1e-10);
        
        // Decay for 5 steps
        for (int i = 0; i < 5; ++i) {
            s.receiveSpike(false, dt);
        }
        
        // With tau_s=1.0, dt=0.1: Euler decay factor = (1 - dt/tau_s) = 0.9 per step
        // After 5 steps: 0.9^5 = 0.59049 (discrete Euler, not exact continuous exp(-0.5))
        double expected = std::pow(0.9, 5);
        run_test("  State after 5 steps = (1 - dt/tau_s)^5 = 0.9^5", std::abs(s.getState() - expected) < 1e-6);
    }
    
    // Test 8: Multiple synaptic contributions (simulated by multiple spikes)
    {
        std::cout << "\nTest 8: Multiple spikes accumulate\n";
        Synapse s(1.0, 10.0);  // Slow decay so spikes sum
        double dt = 0.1;
        
        // Spike at t=1
        s.receiveSpike(true, dt);
        double x1 = s.getState();
        
        // Spike at t=2 (before much decay)
        s.receiveSpike(true, dt);
        double x2 = s.getState();
        
        // x2 should be: x1*(1-dt/tau_s) + 1.0
        double expected_x2 = x1 * (1.0 - dt/10.0) + 1.0;
        run_test("  Second spike adds to decayed first", std::abs(x2 - expected_x2) < 1e-10);
        run_test("  State > 1.0 (summed)", x2 > 1.0);
    }
    
    // Test 9: Numerical stability - dt validation
    {
        std::cout << "\nTest 9: dt validation\n";
        Synapse s(0.5, 2.0);
        
        // Valid dt
        bool caught = false;
        try { s.receiveSpike(false, 0.5); } catch (...) { caught = true; }
        run_test("  dt=0.5 < tau_s=2.0 accepted", !caught);
        
        // dt = 0
        caught = false;
        try { s.receiveSpike(false, 0.0); } catch (...) { caught = true; }
        run_test("  dt=0 rejected", caught);
        
        // dt > tau_s
        caught = false;
        try { s.receiveSpike(false, 3.0); } catch (...) { caught = true; }
        run_test("  dt=3.0 > tau_s=2.0 rejected", caught);
        
        // dt == tau_s
        caught = false;
        try { s.receiveSpike(false, 2.0); } catch (...) { caught = true; }
        run_test("  dt=2.0 == tau_s rejected", caught);
        
        // NaN dt
        caught = false;
        try { s.receiveSpike(false, std::numeric_limits<double>::quiet_NaN()); } catch (...) { caught = true; }
        run_test("  NaN dt rejected", caught);
        
        // infinity dt
        caught = false;
        try { s.receiveSpike(false, std::numeric_limits<double>::infinity()); } catch (...) { caught = true; }
        run_test("  infinity dt rejected", caught);
    }
    
    // Test 10: Reset behavior
    {
        std::cout << "\nTest 10: Reset behavior\n";
        Synapse s(0.5, 2.0);
        double dt = 0.1;
        
        // Build up state
        s.receiveSpike(true, dt);
        s.receiveSpike(true, dt);
        run_test("  State > 0 before reset", s.getState() > 0.0);
        
        s.reset();
        run_test("  State = 0 after reset", std::abs(s.getState() - 0.0) < 1e-10);
        run_test("  Weight unchanged", std::abs(s.getWeight() - 0.5) < 1e-10);
    }
    
    // Test 11: Parameter validation
    {
        std::cout << "\nTest 11: Parameter validation\n";
        
        // tau_s <= 0
        bool caught = false;
        try { Synapse s(0.5, 0.0); } catch (...) { caught = true; }
        run_test("  tau_s=0 rejected", caught);
        
        caught = false;
        try { Synapse s(0.5, -1.0); } catch (...) { caught = true; }
        run_test("  tau_s=-1.0 rejected", caught);
        
        // Non-finite weight
        caught = false;
        try { Synapse s(std::numeric_limits<double>::infinity(), 2.0); } catch (...) { caught = true; }
        run_test("  infinite weight rejected", caught);
        
        caught = false;
        try { Synapse s(std::numeric_limits<double>::quiet_NaN(), 2.0); } catch (...) { caught = true; }
        run_test("  NaN weight rejected", caught);
        
        // Valid parameters
        caught = false;
        try { Synapse s(-1.0, 5.0); } catch (...) { caught = true; }
        run_test("  Negative weight accepted", !caught);
        
        caught = false;
        try { Synapse s(0.0, 1.0); } catch (...) { caught = true; }
        run_test("  Zero weight accepted", !caught);
    }
    
    // Test 12: setWeight for plasticity
    {
        std::cout << "\nTest 12: setWeight (for future plasticity)\n";
        Synapse s(0.5, 2.0);
        run_test("  Initial weight=0.5", std::abs(s.getWeight() - 0.5) < 1e-10);
        
        s.setWeight(-0.3);
        run_test("  Weight changed to -0.3", std::abs(s.getWeight() + 0.3) < 1e-10);
        
        // Test it affects output
        double I = s.receiveSpike(true, 0.1);
        run_test("  New weight affects output", std::abs(I + 0.3) < 1e-10);
    }
    
    // Summary
    std::cout << "\n========================================\n";
    std::cout << "Synapse Tests: " << passed << " passed, " << failed << " failed\n";
    std::cout << "========================================\n";
    
    return failed > 0 ? 1 : 0;
}