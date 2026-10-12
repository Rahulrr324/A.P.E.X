#include "neural/Network.h"
#include "neural/NeuralCell.h"
#include "neural/Synapse.h"
#include <iostream>
#include <iomanip>
#include <vector>

void printNetworkState(const Network& network, size_t timestep) {
    std::cout << "Timestep: " << timestep << std::endl;
    
    // Print neuron states
    for (size_t i = 0; i < network.getNeuronCount(); ++i) {
        const NeuralCell& neuron = network.getNeuron(i);
        std::cout << "  Neuron " << i << ": V=" << std::fixed << std::setprecision(3) << neuron.getV()
                  << ", theta=" << neuron.getTheta()
                  << ", spike=" << (network.getSpikesThisStep()[i] ? "1" : "0") << std::endl;
    }
    
    // Print synapse states
    for (size_t i = 0; i < network.getSynapseCount(); ++i) {
        const Synapse& synapse = network.getSynapse(i);
        std::cout << "  Synapse " << i << ": w=" << std::fixed << std::setprecision(3) << synapse.getWeight()
                  << ", x=" << synapse.getState()
                  << ", x_pre=" << synapse.getPreTrace()
                  << ", x_post=" << synapse.getPostTrace() << std::endl;
    }
    
    std::cout << std::endl;
}

int main() {
    std::cout << "STARK-004 STDP Learning Demonstration" << std::endl;
    std::cout << "=====================================" << std::endl;
    std::cout << "This demo shows STDP learning in a 3-neuron network:" << std::endl;
    std::cout << "- Neuron 0 (Input) connects to Neuron 2 (Output)" << std::endl;
    std::cout << "- Neuron 1 (Intermediate) connects to Neuron 2 (Output)" << std::endl;
    std::cout << "- Both synapses are plastic and will learn via STDP." << std::endl;
    std::cout << std::endl;
    
    // Create network
    Network network;
    
    // Add neurons
    size_t input_neuron = network.addNeuron(10.0, 1.0, 20.0, 0.1, 0.0);
    size_t intermediate_neuron = network.addNeuron(10.0, 1.0, 20.0, 0.1, 0.0);
    size_t output_neuron = network.addNeuron(10.0, 1.0, 20.0, 0.1, 0.0);
    
    // Add synapses
    size_t synapse_input_to_output = network.addSynapse(input_neuron, output_neuron, 0.5, 2.0, 0);
    size_t synapse_intermediate_to_output = network.addSynapse(intermediate_neuron, output_neuron, 0.5, 2.0, 0);
    
    // Enable plasticity
    network.enablePlasticity(synapse_input_to_output, 0.01, 0.01, 20.0, 20.0, 0.0, 1.0);
    network.enablePlasticity(synapse_intermediate_to_output, 0.01, 0.01, 20.0, 20.0, 0.0, 1.0);
    
    // Training phase: repeated pattern
    std::cout << "Training Phase: Repeated Pattern (Input → Intermediate → Output)" << std::endl;
    std::cout << "-------------------------------------------------------------" << std::endl;
    
    for (int trial = 0; trial < 20; ++trial) {
        std::cout << "Trial " << trial + 1 << ":" << std::endl;
        
        // Reset network
        network.reset();
        
        // Step 1: Activate input neuron
        network.setExternalInput(input_neuron, 2.0);
        network.step(1.0);
        printNetworkState(network, 0);
        
        // Step 2: Activate intermediate neuron
        network.setExternalInput(intermediate_neuron, 2.0);
        network.step(1.0);
        printNetworkState(network, 1);
        
        // Step 3: Activate output neuron
        network.setExternalInput(output_neuron, 2.0);
        network.step(1.0);
        printNetworkState(network, 2);
    }
    
    // Test phase: only activate input and intermediate neurons
    std::cout << "Test Phase: Only Input and Intermediate Neurons Activated" << std::endl;
    std::cout << "-----------------------------------------------------" << std::endl;
    
    network.reset();
    
    // Step 1: Activate input neuron
    network.setExternalInput(input_neuron, 2.0);
    network.step(1.0);
    printNetworkState(network, 0);
    
    // Step 2: Activate intermediate neuron
    network.setExternalInput(intermediate_neuron, 2.0);
    network.step(1.0);
    printNetworkState(network, 1);
    
    // Check if output neuron spikes (it should if learning was successful)
    bool output_spiked = network.getSpikesThisStep()[output_neuron];
    std::cout << "Output neuron " << (output_spiked ? "spiked" : "did not spike")
              << " in response to learned pattern." << std::endl;
    
    // Print final weights
    std::cout << std::endl;
    std::cout << "Final Synaptic Weights:" << std::endl;
    std::cout << "  Input → Output: " << std::fixed << std::setprecision(3)
              << network.getSynapse(synapse_input_to_output).getWeight() << std::endl;
    std::cout << "  Intermediate → Output: " << std::fixed << std::setprecision(3)
              << network.getSynapse(synapse_intermediate_to_output).getWeight() << std::endl;
    
    return 0;
}