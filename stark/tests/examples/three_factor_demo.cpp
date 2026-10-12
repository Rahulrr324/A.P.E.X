/**
 * STARK-006: Three-Factor Modulator-Gated Plasticity Demonstration
 *
 * Demonstrates the defining signature of three-factor learning:
 *   m(t) = 0  =>  NO weight change, even when pre/post pairings accumulate eligibility
 *   m(t) > 0  =>  weight changes proportional to eligibility
 *   m(t) < 0  =>  learning direction reverses
 *
 * Topology:
 *   A (driver) -> B (target), synapse in THREEFACTOR mode
 *
 * Prints over time:
 *   - timestep
 *   - pre/post spikes
 *   - eligibility trace e
 *   - modulator m
 *   - weight w
 *
 * Phases:
 *   Phase 1: pairings with m=0 -> eligibility accumulates, weight UNCHANGED
 *   Phase 2: same pairings with m>0 -> weight INCREASES (potentiation)
 *   Phase 3: m<0 -> weight DECREASES (direction reversed)
 */

#include "neural/Network.h"
#include "neural/NeuralCell.h"
#include "neural/Synapse.h"
#include <iostream>
#include <iomanip>
#include <cmath>

int main() {
    std::cout << "=== STARK-006 Three-Factor Learning Demonstration ===\n\n";

    std::cout << "Setup:\n"
              << "  A (driver) -> B (target), THREEFACTOR mode\n"
              << "  A and B both spike on direct external input (I=3.0, dt=1.0)\n"
              << "  Eligibility accumulates from pre/post spike timing\n"
              << "  Modulator m(t) gates whether eligibility converts to weight change\n\n";

    Network net;

    static constexpr double dt = 1.0;
    static constexpr double I_DRIVE = 3.0;

    size_t A = net.addNeuron(10.0, 1.0, 20.0, 0.1, 0.0);
    size_t B = net.addNeuron(10.0, 1.0, 20.0, 0.1, 0.0);
    size_t syn = net.addSynapse(A, B, 0.5, 2.0, 0);

    // Three-factor parameters
    double E_plus = 0.01;
    double E_minus = 0.01;
    double tau_e = 50.0;
    double eta_3f = 1.0;
    double w_min = 0.0;
    double w_max = 1.0;

    net.enableThreeFactor(syn, E_plus, E_minus, tau_e, eta_3f, w_min, w_max);

    double w_init = net.getSynapse(syn).getWeight();

    std::cout << std::fixed << std::setprecision(6);
    std::cout << "Parameters:\n"
              << "  E_plus=" << E_plus << ", E_minus=" << E_minus << "\n"
              << "  tau_e=" << tau_e << ", eta_3f=" << eta_3f << "\n"
              << "  w_bounds=[" << w_min << ", " << w_max << "]\n"
              << "  w_init=" << w_init << "\n\n";

    std::cout << std::setw(6) << "step" << " | "
              << std::setw(5) << "phase" << " | "
              << std::setw(5) << "spk_A" << " | "
              << std::setw(5) << "spk_B" << " | "
              << std::setw(10) << "e_tr" << " | "
              << std::setw(8) << "m" << " | "
              << std::setw(8) << "dw" << " | "
              << std::setw(10) << "w\n";
    std::cout << "------|-------|-----|-----|----------|--------|--------|----------\n";

    double w_prev = w_init;

    // --- Phase 1: pairings with m=0 (m=0 is the default after reset/clear) ---
    std::cout << "\n--- Phase 1: Pairings with m=0 (eligibility accumulates, w unchanged) ---\n";
    for (int step = 0; step < 10; ++step) {
        net.setExternalInput(A, I_DRIVE);
        net.step(dt);  // A spikes (pre), no modulator needed (default 0)
        net.setExternalInput(B, I_DRIVE);
        net.step(dt);  // B spikes (post), eligibility accumulates, m=0 => dw=0

        double e = net.getEligibility(syn);
        double w = net.getSynapse(syn).getWeight();
        double dw = w - w_prev;
        w_prev = w;

        if (step % 2 == 0 || step == 9) {
            std::cout << std::setw(6) << net.getCurrentTimeStep() << " | "
                      << std::setw(5) << "P1" << " | "
                      << std::setw(5) << "1" << " | "
                      << std::setw(5) << "1" << " | "
                      << std::setw(10) << e << " | "
                      << std::setw(8) << net.getModulatorySignal() << " | "
                      << std::setw(8) << dw << " | "
                      << std::setw(10) << w << "\n";
        }
    }

    double w_after_p1 = net.getSynapse(syn).getWeight();
    double e_after_p1 = net.getEligibility(syn);
    std::cout << "\nPhase 1 result: w = " << w_after_p1
              << " (init=" << w_init << ", unchanged=" << (std::fabs(w_after_p1 - w_init) < 1e-12 ? "YES" : "NO") << ")\n";
    std::cout << "  Eligibility accumulated: e = " << e_after_p1 << "\n";

    // --- Phase 2: pairings with m>0 (weight changes) ---
    std::cout << "\n--- Phase 2: Same pairings with m=+1 (weight changes) ---\n";
    for (int step = 0; step < 10; ++step) {
        net.setExternalInput(A, I_DRIVE);
        net.step(dt);
        net.setExternalInput(B, I_DRIVE);
        net.setModulatorySignal(1.0);
        net.step(dt);

        double e = net.getEligibility(syn);
        double w = net.getSynapse(syn).getWeight();
        double dw = w - w_prev;
        w_prev = w;

        if (step % 2 == 0 || step == 9) {
            std::cout << std::setw(6) << net.getCurrentTimeStep() << " | "
                      << std::setw(5) << "P2" << " | "
                      << std::setw(5) << "1" << " | "
                      << std::setw(5) << "1" << " | "
                      << std::setw(10) << e << " | "
                      << std::setw(8) << "+1" << " | "
                      << std::setw(8) << dw << " | "
                      << std::setw(10) << w << "\n";
        }
    }

    double w_after_p2 = net.getSynapse(syn).getWeight();
    std::cout << "\nPhase 2 result: w = " << w_after_p2
              << " (increased=" << (w_after_p2 > w_after_p1 ? "YES" : "NO") << ")\n";

    // --- Phase 3: pairings with m<0 (direction reversed) ---
    std::cout << "\n--- Phase 3: Same pairings with m=-1 (direction reversed) ---\n";
    for (int step = 0; step < 10; ++step) {
        net.setExternalInput(A, I_DRIVE);
        net.step(dt);
        net.setExternalInput(B, I_DRIVE);
        net.setModulatorySignal(-1.0);
        net.step(dt);

        double e = net.getEligibility(syn);
        double w = net.getSynapse(syn).getWeight();
        double dw = w - w_prev;
        w_prev = w;

        if (step % 2 == 0 || step == 9) {
            std::cout << std::setw(6) << net.getCurrentTimeStep() << " | "
                      << std::setw(5) << "P3" << " | "
                      << std::setw(5) << "1" << " | "
                      << std::setw(5) << "1" << " | "
                      << std::setw(10) << e << " | "
                      << std::setw(8) << "-1" << " | "
                      << std::setw(8) << dw << " | "
                      << std::setw(10) << w << "\n";
        }
    }

    double w_after_p3 = net.getSynapse(syn).getWeight();
    std::cout << "\nPhase 3 result: w = " << w_after_p3
              << " (decreased from P2=" << (w_after_p3 < w_after_p2 ? "YES" : "NO") << ")\n";

    // --- Summary ---
    std::cout << "\n=== Summary ===\n";
    std::cout << "Initial weight:            " << w_init << "\n";
    std::cout << "After Phase 1 (m=0):       " << w_after_p1 << " (unchanged)\n";
    std::cout << "After Phase 2 (m=+1):      " << w_after_p2 << " (potentiated)\n";
    std::cout << "After Phase 3 (m=-1):      " << w_after_p3 << " (depressed)\n";
    std::cout << "Eligibility at end:        " << net.getEligibility(syn) << "\n";

    bool sig1 = std::fabs(w_after_p1 - w_init) < 1e-9;
    bool sig2 = w_after_p2 > w_after_p1;
    bool sig3 = w_after_p3 < w_after_p2;
    bool bounds = (w_after_p1 >= 0.0 && w_after_p1 <= 1.0 &&
                   w_after_p2 >= 0.0 && w_after_p2 <= 1.0 &&
                   w_after_p3 >= 0.0 && w_after_p3 <= 1.0);

    std::cout << "\nSignature checks:\n";
    std::cout << "  [m=0 blocks learning]:         " << (sig1 ? "PASS" : "FAIL") << "\n";
    std::cout << "  [m>0 causes potentiation]:     " << (sig2 ? "PASS" : "FAIL") << "\n";
    std::cout << "  [m<0 reverses direction]:      " << (sig3 ? "PASS" : "FAIL") << "\n";
    std::cout << "  [weights within bounds]:        " << (bounds ? "PASS" : "FAIL") << "\n";

    int failures = 0;
    if (!sig1) failures++;
    if (!sig2) failures++;
    if (!sig3) failures++;
    if (!bounds) failures++;

    if (failures > 0) {
        std::cout << "\n[DEMO] " << failures << " signature check(s) FAILED\n";
        return 1;
    }

    std::cout << "\n=== Demonstration Complete ===\n";
    return 0;
}
