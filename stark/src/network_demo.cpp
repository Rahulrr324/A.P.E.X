#include "neural/Network.h"
#include <iostream>
#include <iomanip>
#include <vector>

/**
 * STARK-003 Network Demonstration
 * 
 * Demonstrates a small recurrent network with:
 * - 5 neurons
 * - Excitatory and inhibitory connections
 * - External drive to one neuron
 * - Spike propagation through the network
 * 
 * Prints a timestep trace showing network dynamics.
 */

int main() {
    std::cout << "=== STARK-003 Network Demonstration ===\n\n";
    
    // Create a small network: 5 neurons
    Network net;
    
    // Add neurons with slightly different parameters for heterogeneity
    size_t n0 = net.addNeuron(1.0, 1.0, 10.0, 0.5, -0.5);  // Input neuron
    size_t n1 = net.addNeuron(1.0, 1.0, 10.0, 0.5, -0.5);  // Excitatory
    size_t n2 = net.addNeuron(1.0, 1.0, 10.0, 0.5, -0.5);  // Excitatory
    size_t n3 = net.addNeuron(1.0, 1.2, 10.0, 0.5, -0.5);  // Inhibitory (higher threshold)
    size_t n4 = net.addNeuron(1.0, 1.0, 10.0, 0.5, -0.5);  // Output
    
    // Create connectivity:
    // n0 -> n1 (excitatory)
    // n0 -> n2 (excitatory)
    // n1 -> n3 (excitatory, drives inhibitor)
    // n2 -> n4 (excitatory)
    // n3 -> n1 (inhibitory, feedback)
    // n3 -> n2 (inhibitory, feedback)
    
    net.addSynapse(n0, n1, 1.5, 2.0, 0);   // E
    net.addSynapse(n0, n2, 1.5, 2.0, 0);   // E
    net.addSynapse(n1, n3, 1.0, 2.0, 0);   // E
    net.addSynapse(n2, n4, 1.5, 2.0, 0);   // E
    net.addSynapse(n3, n1, -1.0, 2.0, 0);  // I (feedback inhibition)
    net.addSynapse(n3, n2, -1.0, 2.0, 0);  // I (feedback inhibition)
    
    std::cout << "Network structure:\n";
    std::cout << "  Neurons: " << net.getNeuronCount() << "\n";
    std::cout << "  Synapses: " << net.getSynapseCount() << "\n";
    std::cout << "  Connectivity:\n";
    std::cout << "    n0 -> n1 (E, w=1.5)\n";
    std::cout << "    n0 -> n2 (E, w=1.5)\n";
    std::cout << "    n1 -> n3 (E, w=1.0)\n";
    std::cout << "    n2 -> n4 (E, w=1.5)\n";
    std::cout << "    n3 -> n1 (I, w=-1.0)\n";
    std::cout << "    n3 -> n2 (I, w=-1.0)\n";
    std::cout << "\n";
    
    const double dt = 0.1;
    const int timesteps = 100;
    
    std::cout << std::fixed << std::setprecision(3);
    std::cout << "  t  | n0.V   | n0.spk | n1.V   | n1.spk | n2.V   | n2.spk | n3.V   | n3.spk | n4.V   | n4.spk\n";
    std::cout << "-----|--------|--------|--------|--------|--------|--------|--------|--------|--------|-------\n";
    
    // Track spike counts
    std::vector<int> spike_counts(5, 0);
    
    for (int t = 0; t < timesteps; ++t) {
        // External drive to n0
        net.setExternalInput(n0, 2.5);
        
        // Step the network
        net.step(dt);
        
        // Get spikes
        const auto& spikes = net.getSpikesThisStep();
        for (size_t i = 0; i < 5; ++i) {
            if (spikes[i]) spike_counts[i]++;
        }
        
        // Print trace every 5 steps
        if (t % 5 == 0 || spikes[n0] || spikes[n1] || spikes[n2] || spikes[n3] || spikes[n4]) {
            std::cout << std::setw(4) << t << " | "
                      << std::setw(6) << net.getNeuron(n0).getV() << " | "
                      << std::setw(6) << (spikes[n0] ? "SPIKE" : "-") << " | "
                      << std::setw(6) << net.getNeuron(n1).getV() << " | "
                      << std::setw(6) << (spikes[n1] ? "SPIKE" : "-") << " | "
                      << std::setw(6) << net.getNeuron(n2).getV() << " | "
                      << std::setw(6) << (spikes[n2] ? "SPIKE" : "-") << " | "
                      << std::setw(6) << net.getNeuron(n3).getV() << " | "
                      << std::setw(6) << (spikes[n3] ? "SPIKE" : "-") << " | "
                      << std::setw(6) << net.getNeuron(n4).getV() << " | "
                      << std::setw(6) << (spikes[n4] ? "SPIKE" : "-") << "\n";
        }
    }
    
    std::cout << "\n=== Spike Summary ===\n";
    for (size_t i = 0; i < 5; ++i) {
        std::cout << "  Neuron " << i << ": " << spike_counts[i] << " spikes\n";
    }
    
    std::cout << "\n=== Network State at End ===\n";
    for (size_t i = 0; i < 5; ++i) {
        std::cout << "  Neuron " << i << ": V=" << std::setw(7) << net.getNeuron(i).getV()
                  << ", theta=" << std::setw(7) << net.getNeuron(i).getTheta() << "\n";
    }
    
    std::cout << "\n=== Demonstration Complete ===\n";
    
    return 0;
}