/**
 * STARK-005: Homeostatic Plasticity Demonstration
 *
 * Demonstrates MULTIPLICATIVE SYNAPTIC SCALING driven by a postsynaptic
 * physical-Hz firing-rate estimate.
 *
 * Topology:
 *   A (driver, excitatory) -> B (target)
 *   C (driver, inhibitory) -> B
 *
 * B is driven ONLY through its incoming synapses A->B and C->B. A and C are
 * externally driven "driver" neurons that spike each step. When B is
 * hyperactive (firing rate >> target), homeostasis multiplicatively down-scales
 * B's INCOMING weights, which weakens B's drive and pulls B's rate back toward
 * target. This is the feedback loop that the earlier demo was missing (it drove
 * B directly via external current, so scaling its incoming weights could never
 * change B's activity).
 *
 * The demo prints, over time:
 *   - B's measured firing-rate EMA (Hz)
 *   - B's firing-rate error vs target (Hz)
 *   - homeostatic scale factor
 *   - incoming excitatory (A->B) and inhibitory (C->B) weights
 *   - the excitatory/inhibitory weight-ratio (A/|C|)
 *
 * Verifies the invariants:
 *   - excitatory weight stays > 0, inhibitory weight stays < 0
 *   - weights stay within their configured sign-derived bounds
 *   - both incoming weights are scaled by the SAME positive factor
 *     (ratio preserved until an independent bound forces clamping)
 *   - homeostasis actually acts on B's activity (weights move AND B is driven
 *     through those weights)
 */

#include "neural/Network.h"
#include "neural/NeuralCell.h"
#include "neural/Synapse.h"
#include <iostream>
#include <iomanip>
#include <cmath>
#include <algorithm>

int main() {
    std::cout << "=== STARK-005 Homeostasis Demonstration ===\n\n";

    std::cout << "Setup:\n"
              << "  A (driver, excitatory) -> B\n"
              << "  C (driver, inhibitory) -> B\n"
              << "  A,C are driven externally and spike each step.\n"
              << "  B receives current ONLY through incoming synapses A->B, C->B.\n"
              << "  B starts hyperactive; homeostasis multiplicatively down-scales\n"
              << "  B's incoming weights, weakening B's drive toward target.\n\n";

    Network net;

    static constexpr double dt = 0.1;          // seconds
    static constexpr double I_DRIVE = 12.0;     // driver spikes each step (V=I*dt=1.2 >= theta)

    // Driver neurons A and C: no adaptation (b=0) so they spike every step.
    size_t A = net.addNeuron(10.0, 1.0, 100.0, 0.0, 0.0);
    size_t C = net.addNeuron(10.0, 1.0, 100.0, 0.0, 0.0);
    // Target neuron B: driven HARD through its incoming synapses so it is
    // clearly hyperactive (firing every step => ~10 Hz >> 5 Hz target).
    // b=0 (no adaptation) keeps B firing every step while its synaptic drive
    // remains above threshold, so that homeostatic down-scaling of the
    // incoming weights visibly reduces B's drive.
    size_t B = net.addNeuron(10.0, 1.0, 100.0, 0.0, 0.0);

    // Homeostatic parameters.
    // - tau_r = 0.2 s  (firing-rate EMA time constant)
    // - kappa = 0.02   (dimensionless multiplicative scaling rate)
    // - target = 5 Hz
    // - hysteresis = 0.5 Hz  (dead-zone)
    const double tau_r = 0.2;
    const double kappa = 0.02;
    const double target = 5.0;
    const double hysteresis = 0.5;
    net.setHomeostasisParameters(tau_r, kappa, target, hysteresis);

    // A -> B excitatory weight 0.8 (default bounds [0, 1.0])
    size_t syn_a = net.addSynapse(A, B, 0.8, 2.0, 0);
    // C -> B inhibitory weight -0.2 (default bounds [-1.0, 0])
    size_t syn_c = net.addSynapse(C, B, -0.2, 2.0, 0);

    std::cout << std::fixed << std::setprecision(4);
    std::cout << "Initial state:\n";
    std::cout << "  Neuron A -> B: w = " << net.getSynapse(syn_a).getWeight() << "\n";
    std::cout << "  Neuron C -> B: w = " << net.getSynapse(syn_c).getWeight() << "\n";
    std::cout << "  Bound A->B: [" << net.getSynapse(syn_a).getWeightMin()
              << ", " << net.getSynapse(syn_a).getWeightMax() << "]\n";
    std::cout << "  Bound C->B: [" << net.getSynapse(syn_c).getWeightMin()
              << ", " << net.getSynapse(syn_c).getWeightMax() << "]\n";
    std::cout << "  Target rate: " << net.getHomeostasisTargetHz() << " Hz\n";
    std::cout << "  Hysteresis:  " << net.getHomeostasisHysteresisHz() << " Hz\n";
    std::cout << "  kappa:       " << net.getHomeostasisKappa() << " (dimensionless)\n";
    std::cout << "  tau_r:       " << net.getHomeostasisTauR() << " s\n\n";

    double w_a_init = net.getSynapse(syn_a).getWeight();
    double w_c_init = net.getSynapse(syn_c).getWeight();
    double ratio_init = w_a_init / std::abs(w_c_init);

    std::cout << std::setw(8) << "t(s)" << " | "
              << std::setw(9) << "r_B(Hz)" << " | "
              << std::setw(9) << "err(Hz)" << " | "
              << std::setw(7) << "scale" << " | "
              << std::setw(9) << "w_AB" << " | "
              << std::setw(9) << "w_CB" << " | "
              << std::setw(9) << "ratio\n";
    std::cout << "---------|-----------|-----------|---------|-----------|-----------|---------\n";

    const size_t total_steps = 2000;
    const size_t print_every = 100;

    double peak_rate = 0.0;
    bool any_downscale = false;
    bool b_spiked = false;

    for (size_t step = 0; step < total_steps; ++step) {
        // Drive the driver neurons A and C only; B gets NO direct external input.
        net.setExternalInput(A, I_DRIVE);
        net.setExternalInput(C, I_DRIVE);
        net.step(dt);

        double r_b = net.getFiringRates()[B];
        peak_rate = std::max(peak_rate, r_b);
        if (net.getSpikesThisStep()[B]) b_spiked = true;

        double w_a = net.getSynapse(syn_a).getWeight();
        if (w_a < w_a_init - 1e-12) any_downscale = true;

        if ((step + 1) % print_every == 0) {
            const double t = (step + 1) * dt;
            double r = net.getFiringRates()[B];
            double err = target - r;
            double scale = net.getHomeostaticScale(B);
            double wa = net.getSynapse(syn_a).getWeight();
            double wc = net.getSynapse(syn_c).getWeight();
            double ratio = wa / std::abs(wc);
            std::cout << std::setw(8) << t << " | "
                      << std::setw(9) << r << " | "
                      << std::setw(9) << err << " | "
                      << std::setw(7) << scale << " | "
                      << std::setw(9) << wa << " | "
                      << std::setw(9) << wc << " | "
                      << std::setw(9) << ratio << "\n";
        }
    }

    double w_a_final = net.getSynapse(syn_a).getWeight();
    double w_c_final = net.getSynapse(syn_c).getWeight();
    double r_b_final = net.getFiringRates()[B];
    double scale_final = net.getHomeostaticScale(B);

    std::cout << "\nResults:\n";
    std::cout << "  Initial weights: A->B = " << w_a_init
              << ", C->B = " << w_c_init
              << ", ratio(A/|C|) = " << ratio_init << "\n";
    std::cout << "  Final weights:   A->B = " << w_a_final
              << ", C->B = " << w_c_final
              << ", ratio(A/|C|) = " << (w_a_final / std::abs(w_c_final)) << "\n";
    std::cout << "  Peak B rate:     " << peak_rate << " Hz\n";
    std::cout << "  Final B rate:    " << r_b_final << " Hz (target = " << target << " Hz)\n";
    std::cout << "  Final scale:     " << scale_final << "\n";
    std::cout << "  B spiked at some point: " << (b_spiked ? "yes" : "no") << "\n";
    std::cout << "  Any down-scale of A->B:  " << (any_downscale ? "yes" : "no") << "\n";

    // ============================================================
    // Invariant checks (should always hold regardless of dynamics)
    // ============================================================
    bool exc_sign = w_a_final > 0.0;
    bool inh_sign = w_c_final < 0.0;
    bool bounds_ab = (w_a_final >= net.getSynapse(syn_a).getWeightMin()) &&
                     (w_a_final <= net.getSynapse(syn_a).getWeightMax());
    bool bounds_cb = (w_c_final >= net.getSynapse(syn_c).getWeightMin()) &&
                     (w_c_final <= net.getSynapse(syn_c).getWeightMax());
    bool ratio_ok = std::abs(w_a_final / std::abs(w_c_final) - ratio_init) < 0.05;

    // Homeostasis must have acted through incoming synapses: weights moved AND B
    // was actually driven through them (spiked). We require down-scaling occurred
    // because B is driven hyperactive.
    bool feedback_active = any_downscale && b_spiked;

    std::cout << "\n  [CHECK] Excitatory weight stays positive: "
              << (exc_sign ? "PASS" : "FAIL") << "\n";
    std::cout << "  [CHECK] Inhibitory weight stays negative: "
              << (inh_sign ? "PASS" : "FAIL") << "\n";
    std::cout << "  [CHECK] A->B within bounds:                "
              << (bounds_ab ? "PASS" : "FAIL") << "\n";
    std::cout << "  [CHECK] C->B within bounds:                "
              << (bounds_cb ? "PASS" : "FAIL") << "\n";
    std::cout << "  [CHECK] Ratio preserved (within 0.05):     "
              << (ratio_ok ? "PASS" : "FAIL") << "\n";
    std::cout << "  [CHECK] Homeostasis acted via incoming synapses "
                 "(down-scale + B spiked): "
              << (feedback_active ? "PASS" : "FAIL") << "\n";

    if (b_spiked && peak_rate >= target) {
        std::cout << "  [NOTE] B began hyperactive (" << peak_rate
                  << " Hz >= target " << target << " Hz); final rate "
                  << r_b_final << " Hz." << "\n";
    } else if (b_spiked) {
        std::cout << "  [NOTE] B spiked but peak rate (" << peak_rate
                  << " Hz) did not clearly exceed target.\n";
    } else {
        std::cout << "  [NOTE] B never spiked; check driver/drive tuning.\n";
    }

    std::cout << "\n=== Demonstration Complete ===\n";

    // Non-zero exit if any invariant check failed.
    int failures = 0;
    if (!exc_sign) failures++;
    if (!inh_sign) failures++;
    if (!bounds_ab) failures++;
    if (!bounds_cb) failures++;
    if (!ratio_ok) failures++;
    if (!feedback_active) failures++;
    if (failures > 0) {
        std::cout << "[DEMO] " << failures << " invariant(s) FAILED\n";
        return 1;
    }

    return 0;
}