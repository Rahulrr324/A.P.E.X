#include "neural/NeuralCell.h"
#include "neural/Synapse.h"
#include <iostream>
#include <iomanip>
#include <vector>

/**
 * STARK-002 Two-Neuron Simulation
 * 
 * Demonstrates:
 *   Neuron A (driven by external input)
 *        ↓ spike
 *   Synapse A→B (excitatory, w=0.5)
 *        ↓ current
 *   Neuron B (receives only synaptic input)
 * 
 * Prints timestep trace:
 *   t | A.V | A.theta | A.spike | synapse.x | B.V | B.theta | B.spike
 */

int main() {
    // Neuron A: receives external input
    NeuralCell neuron_A(1.0, 1.0, 10.0, 0.5, -0.5);
    
    // Neuron B: receives only synaptic input from A
    NeuralCell neuron_B(1.0, 1.0, 10.0, 0.5, -0.5);
    
    // Synapse A → B: excitatory (w > 0)
    Synapse synapse_A_B(0.5, 2.0);  // weight=0.5, tau_s=2.0
    
    const double dt = 0.1;
    const int timesteps = 60;
    
    std::cout << "=== STARK-002 Two-Neuron Simulation ===\n\n";
    std::cout << "Neuron A: tau_m=1.0, theta_0=1.0, tau_a=10.0, b=0.5, v_reset=-0.5\n";
    std::cout << "Neuron B: tau_m=1.0, theta_0=1.0, tau_a=10.0, b=0.5, v_reset=-0.5\n";
    std::cout << "Synapse A->B: w=0.5 (excitatory), tau_s=2.0\n";
    std::cout << "Time step dt=" << dt << "\n\n";
    
    std::cout << std::fixed << std::setprecision(4);
    std::cout << "     t |    A.V | A.theta | A.spk |  syn.x |    B.V | B.theta | B.spk\n";
    std::cout << "-------|--------|---------|-------|--------|--------|---------|-------\n";
    
    // Initial state (t=0)
    std::cout << std::setw(5) << 0 
              << " | " << std::setw(6) << neuron_A.getV()
              << " | " << std::setw(7) << neuron_A.getTheta()
              << " | " << std::setw(5) << (neuron_A.getSpike() ? 1 : 0)
              << " | " << std::setw(6) << synapse_A_B.getState()
              << " | " << std::setw(6) << neuron_B.getV()
              << " | " << std::setw(7) << neuron_B.getTheta()
              << " | " << std::setw(5) << (neuron_B.getSpike() ? 1 : 0)
              << "\n";
    
    // External input to Neuron A (gradually increasing to induce spiking)
    for (int t = 1; t <= timesteps; ++t) {
        // External input to A: constant strong input
        double I_A = 2.5;
        
        // Step 1: Update Neuron A
        bool spike_A = neuron_A.update(I_A, dt);
        
        // Step 2: Synapse receives A's spike, produces current for B
        double I_B = synapse_A_B.receiveSpike(spike_A, dt);
        
        // Step 3: Update Neuron B with synaptic current only (no external input)
        bool spike_B = neuron_B.update(I_B, dt);
        
        // Print trace
        std::cout << std::setw(5) << t 
                  << " | " << std::setw(6) << neuron_A.getV()
                  << " | " << std::setw(7) << neuron_A.getTheta()
                  << " | " << std::setw(5) << (spike_A ? 1 : 0)
                  << " | " << std::setw(6) << synapse_A_B.getState()
                  << " | " << std::setw(6) << neuron_B.getV()
                  << " | " << std::setw(7) << neuron_B.getTheta()
                  << " | " << std::setw(5) << (spike_B ? 1 : 0)
                  << "\n";
    }
    
    std::cout << "\n=== Simulation Complete ===\n";
    
    return 0;
}