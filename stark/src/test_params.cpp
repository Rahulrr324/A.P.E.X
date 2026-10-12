#include "neural/NeuralCell.h"
#include <iostream>
#include <iomanip>

/**
 * Test neural cell with different parameter configurations.
 * Demonstrates how each parameter affects neuron dynamics.
 */

int main() {
    std::cout << "=== Neural Cell Parameter Tests ===\n\n";

    // Test 1: Fast leak (small tau_m) - less memory
    std::cout << "Test 1: Fast leak (tau_m=0.5)\n";
    NeuralCell cell1(0.5, 1.0, 10.0, 0.5, -0.5);
    cell1.update(2.0, 0.05);  // dt < tau_m
    std::cout << "  After 1 step I=2.0, V=" << cell1.getV()
              << ", theta=" << cell1.getTheta() << "\n\n";

    // Test 2: Slow leak (large tau_m) - more memory
    std::cout << "Test 2: Slow leak (tau_m=3.0)\n";
    NeuralCell cell2(3.0, 1.0, 10.0, 0.5, -0.5);
    cell2.update(2.0, 0.1);
    std::cout << "  After 1 step I=2.0, V=" << cell2.getV()
              << ", theta=" << cell2.getTheta() << "\n\n";

    // Test 3: Fast adaptation (small tau_a) - adaptation decays quickly
    std::cout << "Test 3: Fast adaptation (tau_a=1.0)\n";
    NeuralCell cell3(1.0, 1.0, 1.0, 0.5, -0.5);
    cell3.update(2.0, 0.05);
    std::cout << "  After 1 step I=2.0, V=" << cell3.getV()
              << ", theta=" << cell3.getTheta() << "\n\n";

    // Test 4: Slow adaptation (large tau_a) - adaptation persists longer
    std::cout << "Test 4: Slow adaptation (tau_a=20.0)\n";
    NeuralCell cell4(1.0, 1.0, 20.0, 0.5, -0.5);
    cell4.update(2.0, 0.1);
    std::cout << "  After 1 step I=2.0, V=" << cell4.getV()
              << ", theta=" << cell4.getTheta() << "\n\n";

    // Test 5: Low baseline threshold (small theta_0) - more excitable
    std::cout << "Test 5: Low baseline (theta_0=0.5)\n";
    NeuralCell cell5(1.0, 0.5, 10.0, 0.5, -0.5);
    cell5.update(2.0, 0.1);
    std::cout << "  After 1 step I=2.0, V=" << cell5.getV()
              << ", theta=" << cell5.getTheta() << "\n\n";

    // Test 6: High baseline threshold (large theta_0) - less excitable
    std::cout << "Test 6: High baseline (theta_0=2.0)\n";
    NeuralCell cell6(1.0, 2.0, 10.0, 0.5, -0.5);
    cell6.update(2.0, 0.1);
    std::cout << "  After 1 step I=2.0, V=" << cell6.getV()
              << ", theta=" << cell6.getTheta() << "\n\n";

    // Test 7: Strong adaptation (large b) - stronger post-spike refractoriness
    std::cout << "Test 7: Strong adaptation (b=1.0)\n";
    NeuralCell cell7(1.0, 1.0, 10.0, 1.0, -0.5);
    cell7.update(2.0, 0.1);
    std::cout << "  After 1 step I=2.0, V=" << cell7.getV()
              << ", theta=" << cell7.getTheta() << "\n\n";

    // Test 8: Weak adaptation (small b) - weaker post-spike refractoriness
    std::cout << "Test 8: Weak adaptation (b=0.1)\n";
    NeuralCell cell8(1.0, 1.0, 10.0, 0.1, -0.5);
    cell8.update(2.0, 0.1);
    std::cout << "  After 1 step I=2.0, V=" << cell8.getV()
              << ", theta=" << cell8.getTheta() << "\n\n";

    // Test 9: Negative reset potential (more hyperpolarizing)
    std::cout << "Test 9: Negative V_reset (-1.0)\n";
    NeuralCell cell9(1.0, 1.0, 10.0, 0.5, -1.0);
    cell9.update(2.0, 0.1);
    std::cout << "  After 1 step I=2.0, V=" << cell9.getV()
              << ", theta=" << cell9.getTheta() << "\n\n";

    // Test 10: Different reset potential (-0.1)
    std::cout << "Test 10: Mild V_reset (-0.1)\n";
    NeuralCell cell10(1.0, 1.0, 10.0, 0.5, -0.1);
    cell10.update(2.0, 0.1);
    std::cout << "  After 1 step I=2.0, V=" << cell10.getV()
              << ", theta=" << cell10.getTheta() << "\n\n";

    return 0;
}