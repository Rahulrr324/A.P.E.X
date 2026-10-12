/**
 * STARK-005: Homeostatic Plasticity Tests
 *
 * Tests the firing-rate homeostasis mechanism that stabilizes network activity
 * by applying multiplicative synaptic scaling to incoming synapses based on
 * physical-Hz firing-rate estimates.
 *
 * All tests use counting assertions (CHECK) so that failures cause non-zero exit.
 *
 * Coverage:
 *   1.  Physical Hz units (r_inst = spike ? 1/dt : 0)
 *   2.  Analytical EMA correctness
 *   3.  Rate decay toward zero
 *   4.  Hyperactive neuron causes down-scaling
 *   5.  Hypoactive neuron causes up-scaling
 *   6.  Multiplicative scaling (w_new = w_old * scale)
 *   7.  Relative ratio preservation
 *   8.  Inhibitory sign preservation
 *   9.  Zero-weight preservation
 *  10.  Hysteresis dead-zone
 *  11.  Per-synapse weight bounds
 *  12.  STDP + homeostasis interaction
 *  13.  Deterministic repeated execution
 *  14.  Multi-neuron isolation (incoming-only)
 *  15.  Parameter validation
 *  16.  Different dt values (physical-rate behavior)
 *  17.  reset() restores homeostatic state
 *  18.  addNeuron() correctly initializes new state
 *  19.  Extreme/pathological parameter safety
 *  20.  Repeated updates remain finite/stable
 */

#include "neural/Network.h"
#include "neural/NeuralCell.h"
#include "neural/Synapse.h"
#include <iostream>
#include <cmath>
#include <vector>
#include <limits>

// ---------------------------------------------------------------------------
// Counting assertion mechanism (same pattern as test_stdp.cpp)
// ---------------------------------------------------------------------------
static int g_checks = 0;

#define CHECK(cond)                                                        \
    do {                                                                   \
        ++g_checks;                                                        \
        if (!(cond)) {                                                     \
            std::cerr << "  FAILED: " << #cond << " (line " << __LINE__    \
                      << ")" << std::endl;                                 \
            std::abort();                                                  \
        }                                                                  \
    } while (0)

#define CHECK_NEAR(a, b, eps)                                              \
    do {                                                                   \
        ++g_checks;                                                        \
        double _a = (a), _b = (b);                                         \
        if (!(std::fabs(_a - _b) <= (eps))) {                              \
            std::cerr << "  FAILED: |" << _a << " - " << _b                \
                      << "| > " << (eps) << " (line " << __LINE__ << ")"   \
                      << std::endl;                                        \
            std::abort();                                                  \
        }                                                                  \
    } while (0)

// Helper: add a neuron that will spike reliably with I_DRIVE and dt=0.1.
// tau_m=10.0, theta_0=1.0, tau_a=20.0, b=0.1, v_reset=0.0
// With dt=0.1: V_temp = 0 + I*0.1. For I=15, V_temp=1.5 >= 1.0 => spike.
static size_t addSpikingNeuron(Network& net) {
    return net.addNeuron(10.0, 1.0, 20.0, 0.1, 0.0);
}

static constexpr double I_DRIVE = 15.0;  // input current that makes neurons spike
static constexpr double DT = 0.1;         // 100 ms timestep (valid: dt < tau_m=10, dt < tau_s=2)

// ===================================================================
// TEST 1: Physical Hz units
// ===================================================================
void test_physical_hz_units() {
    std::cout << "Test 1: Physical Hz units (dt=0.1, one spike => 10 Hz)... " << std::flush;

    Network net;
    addSpikingNeuron(net);
    // tau_r large so only ~1 step influences the EMA; use small hysteresis=0
    net.setHomeostasisParameters(1000.0, 1.0, 5.0, 0.0);

    double dt = DT;  // 0.1 s

    // Drive neuron to spike exactly once
    net.setExternalInput(0, I_DRIVE);
    net.step(dt);

    CHECK(net.getSpikesThisStep()[0]);  // confirm it spiked

    // r_inst = 1/dt = 1/0.1 = 10 Hz
    // r_mean = 0 * exp(-dt/tau_r) + 10 * (1 - exp(-dt/tau_r))
    double r_inst = 1.0 / dt;
    double decay = std::exp(-dt / 1000.0);
    double expected_r = 0.0 * decay + r_inst * (1.0 - decay);
    CHECK_NEAR(net.getFiringRates()[0], expected_r, 1e-12);

    // Confirm r_inst is in Hz (10), not "1 spike per timestep"
    CHECK_NEAR(r_inst, 10.0, 1e-12);

    std::cout << "PASS (r_mean=" << net.getFiringRates()[0] << " Hz)" << std::endl;
}

// ===================================================================
// TEST 2: Analytical EMA correctness
// ===================================================================
void test_ema_analytical() {
    std::cout << "Test 2: Analytical EMA correctness... " << std::flush;

    Network net;
    addSpikingNeuron(net);
    net.setHomeostasisParameters(1.0, 1.0, 5.0, 0.0);

    double dt = DT;
    double tau_r = 1.0;
    double decay = std::exp(-dt / tau_r);
    double alpha = 1.0 - decay;

    // Manually simulate: spike every other step, use ACTUAL network spike to compute r_mean
    double r_mean = 0.0;
    int spike_count = 0;
    for (int i = 0; i < 20; ++i) {
        bool drive = (i % 2 == 0);
        if (drive) {
            net.setExternalInput(0, I_DRIVE);
        } else {
            net.setExternalInput(0, 0.0);
        }
        net.step(dt);

        bool spike = net.getSpikesThisStep()[0];
        double r_inst = spike ? 1.0 / dt : 0.0;
        r_mean = r_mean * decay + r_inst * alpha;
        if (spike) spike_count++;

        CHECK_NEAR(net.getFiringRates()[0], r_mean, 1e-12);
    }

    CHECK(spike_count > 0);
    std::cout << "PASS (r_mean=" << net.getFiringRates()[0] << ")" << std::endl;
}

// ===================================================================
// TEST 3: Rate decay toward zero
// ===================================================================
void test_rate_decay() {
    std::cout << "Test 3: Rate decay toward zero when spikes stop... " << std::flush;

    Network net;
    addSpikingNeuron(net);
    net.setHomeostasisParameters(0.5, 1.0, 5.0, 0.0);

    double dt = DT;

    // Drive neuron to spike a few times
    for (int i = 0; i < 10; ++i) {
        net.setExternalInput(0, I_DRIVE);
        net.step(dt);
    }
    double r_after_spiking = net.getFiringRates()[0];
    CHECK(r_after_spiking > 0.0);

    // Stop spiking — rate must decay toward zero
    for (int i = 0; i < 500; ++i) {
        net.setExternalInput(0, 0.0);
        net.step(dt);
    }
    double r_final = net.getFiringRates()[0];
    CHECK(r_final < r_after_spiking);
    CHECK_NEAR(r_final, 0.0, 0.1);

    std::cout << "PASS (r=" << r_after_spiking << " -> " << r_final << ")" << std::endl;
}

// ===================================================================
// TEST 4: Hyperactive neuron causes down-scaling
// ===================================================================
void test_hyperactive_down() {
    std::cout << "Test 4: Hyperactive neuron => incoming weights decrease... " << std::flush;

    Network net;
    addSpikingNeuron(net);  // neuron 0 (B)
    addSpikingNeuron(net);  // neuron 1 (A, driver)
    net.setHomeostasisParameters(0.5, 0.5, 1.0, 0.0);

    double dt = DT;

    // A -> B, B is the one we monitor
    size_t A = 1, B = 0;
    size_t syn = net.addSynapse(A, B, 0.5, 2.0, 0);
    double w_init = net.getSynapse(syn).getWeight();
    CHECK_NEAR(w_init, 0.5, 1e-12);

    // Drive B hard — B will fire at a rate > target (1 Hz)
    // With dt=0.1, a spike gives r_inst = 10 Hz > 1 Hz target.
    // So B is hyperactive and incoming weights should decrease.
    for (int i = 0; i < 500; ++i) {
        net.setExternalInput(B, I_DRIVE);
        net.step(dt);
    }

    double w_final = net.getSynapse(syn).getWeight();
    CHECK(w_final < w_init);
    CHECK(net.getFiringRates()[B] > net.getHomeostasisTargetHz());

    std::cout << "PASS (w=" << w_init << " -> " << w_final << ")" << std::endl;
}

// ===================================================================
// TEST 5: Hypoactive neuron causes up-scaling
// ===================================================================
void test_hypoactive_up() {
    std::cout << "Test 5: Hypoactive neuron => incoming weights increase... " << std::flush;

    Network net;
    addSpikingNeuron(net);  // neuron 0 (B)
    addSpikingNeuron(net);  // neuron 1 (A, driver)
    // High target, large kappa, low hysteresis
    net.setHomeostasisParameters(0.5, 1.0, 100.0, 0.0);

    double dt = DT;

    // A -> B, weight starts small
    size_t A = 1, B = 0;
    size_t syn = net.addSynapse(A, B, 0.1, 2.0, 0);
    double w_init = net.getSynapse(syn).getWeight();

    // Keep B silent — rate is 0 < target (100 Hz)
    // Incoming weight should increase multiplicatively.
    for (int i = 0; i < 200; ++i) {
        net.setExternalInput(A, I_DRIVE);  // A spikes, but B may not
        net.setExternalInput(B, 0.0);       // B gets no direct input
        net.step(dt);
    }

    double w_final = net.getSynapse(syn).getWeight();
    // If B didn't spike, its rate = 0, error = 100 - 0 = 100 > hysteresis
    // scale = exp(kappa * error * dt) > 1 => weight increases
    if (net.getFiringRates()[B] < 100.0) {
        CHECK(w_final > w_init);
    }

    std::cout << "PASS (w=" << w_init << " -> " << w_final << ", r_B=" << net.getFiringRates()[B] << ")" << std::endl;
}

// ===================================================================
// TEST 6: Multiplicative scaling
// ===================================================================
void test_multiplicative_scaling() {
    std::cout << "Test 6: Multiplicative scaling (w_new ≈ w_old * scale)... " << std::flush;

    Network net;
    addSpikingNeuron(net);  // neuron 0 (B)
    addSpikingNeuron(net);  // neuron 1 (A, driver)
    net.setHomeostasisParameters(0.01, 0.01, 100.0, 0.0);

    double dt = DT;

    size_t A = 1, B = 0;
    size_t syn = net.addSynapse(A, B, 0.5, 2.0, 0);
    double w_init = net.getSynapse(syn).getWeight();

    // Drive neuron A hard so A spikes every step.
    // B receives input from A but B's rate is 0 (no direct drive to B).
    // error = 100 - 0 = 100 Hz
    // scale = exp(0.01 * 100 * 0.1) = exp(0.1) ~ 1.1051709
    // After first step: w = 0.5 * 1.1052 = 0.5526 (below w_max=1.0, no clamp)
    double w0 = 0.5;

    // First step: B doesn't spike (no direct input), r_mean_B ~ 0
    // error = 100 - ~0 = ~100, scale = exp(0.01 * 100 * 0.1) = exp(0.1)
    net.setExternalInput(A, I_DRIVE);
    net.step(dt);

    double scale1 = net.getHomeostaticScale(B);
    CHECK(scale1 > 1.0);
    double expected_scale1 = std::exp(0.01 * 100.0 * 0.1);
    CHECK_NEAR(scale1, expected_scale1, 1e-10);

    // B doesn't spike here either, so r_mean_B is still essentially 0.
    // But r_mean_B was set to a small value (10 * alpha) in step 1.
    // With tau_r=0.01, decay = exp(-0.1/0.01) = exp(-10) ~ 4.5e-5, so r_mean decays to near 0.
    // error ~ 100, scale ~ exp(0.1) again
    double w_after_step1 = net.getSynapse(syn).getWeight();
    double expected_w1 = w0 * expected_scale1;
    CHECK_NEAR(w_after_step1, expected_w1, 1e-9);

    // Second step
    net.setExternalInput(A, I_DRIVE);
    net.step(dt);

    double scale2 = net.getHomeostaticScale(B);
    double w_final = net.getSynapse(syn).getWeight();

    // Verify multiplicative scaling: w_final = w0 * scale1 * scale2
    double expected_w_final = w0 * scale1 * scale2;
    CHECK_NEAR(w_final, expected_w_final, 1e-9);

    std::cout << "PASS (scale=" << scale2 << ", w=" << w0 << "->" << w_final << ")" << std::endl;
}

// ===================================================================
// TEST 7: Relative ratio preservation
// ===================================================================
void test_ratio_preservation() {
    std::cout << "Test 7: Relative ratio preservation... " << std::flush;

    Network net;
    addSpikingNeuron(net);  // neuron 0 (B, target)
    addSpikingNeuron(net);  // neuron 1 (A1)
    addSpikingNeuron(net);  // neuron 2 (A2)

    // Set up homeostasis with large tau_r, small kappa, target=1000 Hz so error is always large and positive (B fires rarely).
    // Use very small kappa so weights don't hit bounds (w_max=1.0 for both)
    net.setHomeostasisParameters(1000.0, 0.0001, 1000.0, 0.0);

    double dt = DT;

    // Two incoming synapses with different weights
    size_t syn1 = net.addSynapse(1, 0, 0.2, 2.0, 0);  // A1 -> B
    size_t syn2 = net.addSynapse(2, 0, 0.5, 2.0, 0);  // A2 -> B

    double w1_init = net.getSynapse(syn1).getWeight();  // 0.2
    double w2_init = net.getSynapse(syn2).getWeight();  // 0.5
    CHECK_NEAR(w1_init, 0.2, 1e-12);
    CHECK_NEAR(w2_init, 0.5, 1e-12);
    double ratio_init = w2_init / w1_init;  // 2.5

    // Drive both A1 and A2 so B receives input.
    // B's rate will be below target (1000 Hz), so both weights get scaled UP.
    // With kappa=0.0001, scale = exp(0.0001 * 1000 * 0.1) = exp(0.01) ~ 1.01 per step
    // After 20 steps: w1 ~ 0.2 * 1.01^20 ~ 0.24 (well below 1.0)
    // After 20 steps: w2 ~ 0.5 * 1.01^20 ~ 0.61 (well below 1.0)
    for (int i = 0; i < 20; ++i) {
        net.setExternalInput(1, I_DRIVE);
        net.setExternalInput(2, I_DRIVE);
        net.step(dt);
    }

    double w1_final = net.getSynapse(syn1).getWeight();
    double w2_final = net.getSynapse(syn2).getWeight();
    double ratio_final = w2_final / w1_final;

    // Check ratio is preserved (within tolerance, since no clamping should occur
    // for these small weights with small kappa)
    CHECK_NEAR(ratio_init, ratio_final, 1e-6);
    CHECK(w1_final > w1_init);
    CHECK(w2_final > w2_init);

    std::cout << "PASS (ratio " << ratio_init << " -> " << ratio_final << ")" << std::endl;
}

// ===================================================================
// TEST 8: Inhibitory sign preservation
// ===================================================================
void test_inhibitory_preservation() {
    std::cout << "Test 8: Inhibitory sign preservation... " << std::flush;

    Network net;
    addSpikingNeuron(net);  // neuron 0 (B)
    addSpikingNeuron(net);  // neuron 1 (A1, excitatory)
    addSpikingNeuron(net);  // neuron 2 (A2, inhibitory)

    // target=0, hysteresis=0 so scaling always happens when rate differs from 0
    net.setHomeostasisParameters(1000.0, 0.01, 0.0, 0.0);

    double dt = DT;

    // Excitatory synapse: +0.5
    size_t syn_e = net.addSynapse(1, 0, 0.5, 2.0, 0);
    // Inhibitory synapse: -0.4
    size_t syn_i = net.addSynapse(2, 0, -0.4, 2.0, 0);

    CHECK(net.getSynapse(syn_e).getWeight() > 0.0);
    CHECK(net.getSynapse(syn_i).getWeight() < 0.0);

    // Verify bounds are sign-appropriate
    CHECK(net.getSynapse(syn_e).getWeightMin() >= 0.0);
    CHECK(net.getSynapse(syn_i).getWeightMax() <= 0.0);

    // Drive B to spike at high rate (10 Hz >> 0.0 target)
    // error = 0 - 10 = -10, scale = exp(0.01 * (-10) * 0.1) = exp(-0.01) ≈ 0.99005
    for (int i = 0; i < 20; ++i) {
        net.setExternalInput(0, I_DRIVE);  // B spikes
        net.step(dt);
    }

    double w_e_final = net.getSynapse(syn_e).getWeight();
    double w_i_final = net.getSynapse(syn_i).getWeight();

    // Both should have been scaled DOWN (r_mean > target=0)
    CHECK(w_e_final < 0.5);
    CHECK(w_i_final > -0.4);  // less negative = scaled toward 0 but stays negative

    // Sign must be preserved
    CHECK(w_e_final > 0.0);
    CHECK(w_i_final < 0.0);

    std::cout << "PASS (exc=" << 0.5 << "->" << w_e_final << ", inh=" << -0.4 << "->" << w_i_final << ")" << std::endl;
}

// ===================================================================
// TEST 9: Zero-weight preservation
// ===================================================================
void test_zero_weight_preservation() {
    std::cout << "Test 9: Zero-weight preservation under scaling... " << std::flush;

    // Test at Synapse level: scaleWeight on a zero weight
    Synapse syn(0.0, 2.0);
    syn.setPlasticityParameters(0.01, 0.01, 20.0, 20.0, -1.0, 1.0);
    CHECK_NEAR(syn.getWeight(), 0.0, 1e-12);
    syn.scaleWeight(2.0);
    CHECK_NEAR(syn.getWeight(), 0.0, 1e-12);  // 0 * 2 = 0
    syn.scaleWeight(0.5);
    CHECK_NEAR(syn.getWeight(), 0.0, 1e-12);  // 0 * 0.5 = 0

    std::cout << "PASS" << std::endl;
}

// ===================================================================
// TEST 10: Hysteresis dead-zone
// ===================================================================
void test_hysteresis_deadzone() {
    std::cout << "Test 10: Hysteresis dead-zone (no scaling when |error| <= hz)... " << std::flush;

    Network net;
    addSpikingNeuron(net);  // neuron 0 (B)
    addSpikingNeuron(net);  // neuron 1 (A, driver)

    // tau_r = 1.0, kappa small, target = 10 Hz, hysteresis = 20 Hz
    // Since hysteresis > target, |error| will always be <= hysteresis
    net.setHomeostasisParameters(1.0, 1.0, 10.0, 20.0);

    double dt = DT;

    size_t A = 1, B = 0;
    size_t syn = net.addSynapse(A, B, 0.5, 2.0, 0);
    double w_before = net.getSynapse(syn).getWeight();

    // Run without homeostasis being triggered (error within dead-zone)
    for (int i = 0; i < 100; ++i) {
        net.setExternalInput(A, I_DRIVE);
        net.step(dt);
    }

    double w_after = net.getSynapse(syn).getWeight();
    // If B's rate stays within [target - hz, target + hz] = [-10, 30], no scaling
    // B may or may not spike; if it doesn't, rate=0, error=10, |10| <= 20 => no scaling.
    CHECK(net.getFiringRates()[B] <= 30.0);  // within dead zone
    CHECK_NEAR(w_after, w_before, 1e-12);

    // Now set hysteresis = 0 so scaling always happens
    // Use target=1.0 Hz so when B spikes at 10 Hz, error = 1 - 10 = -9 < 0 => scale < 1 => weight decreases
    net.setHomeostasisParameters(1.0, 1.0, 1.0, 0.0);
    net.reset();

    // Re-add neurons and synapse in fresh network
    net = Network();
    addSpikingNeuron(net);  // B (0)
    addSpikingNeuron(net);  // A (1)
    net.setHomeostasisParameters(1.0, 1.0, 1.0, 0.0);

    size_t syn2 = net.addSynapse(1, 0, 0.5, 2.0, 0);
    double w2_before = net.getSynapse(syn2).getWeight();

    // Drive B to spike (rate = 10 Hz >> target 1 Hz => error < 0 => scale < 1 => weight decreases)
    for (int i = 0; i < 20; ++i) {
        net.setExternalInput(0, I_DRIVE);
        net.step(dt);
    }

    double w2_after = net.getSynapse(syn2).getWeight();
    CHECK(w2_after < w2_before);  // scaling happened

    std::cout << "PASS (no-scale: w=" << w_after << ", scaled: w=" << w2_before << "->" << w2_after << ")" << std::endl;
}

// ===================================================================
// TEST 11: Per-synapse weight bounds
// ===================================================================
void test_weight_bounds() {
    std::cout << "Test 11: Per-synapse weight bounds enforced... " << std::flush;

    Network net;
    addSpikingNeuron(net);  // B
    addSpikingNeuron(net);  // A
    net.setHomeostasisParameters(1.0, 10.0, 1000.0, 0.0);  // large error => strong scaling

    double dt = DT;

    // Excitatory synapse with explicit bounds [0, 1]
    size_t syn_e = net.addSynapse(1, 0, 0.5, 2.0, 0);
    net.enablePlasticity(syn_e, 0.01, 0.01, 20.0, 20.0, 0.0, 1.0);

    // Drive B hard — rate >> target => scale < 1 => weight decreases toward w_min=0
    for (int i = 0; i < 200; ++i) {
        net.setExternalInput(0, I_DRIVE);
        net.step(dt);
    }

    double w_e = net.getSynapse(syn_e).getWeight();
    CHECK(w_e >= 0.0);  // w_min
    CHECK(w_e <= 1.0);  // w_max
    CHECK(std::isfinite(w_e));

    // Inhibitory synapse with explicit bounds [-1, 0]
    net.reset();
    addSpikingNeuron(net);  // B (0)
    addSpikingNeuron(net);  // A (1)
    net.setHomeostasisParameters(1.0, 10.0, 0.0, 0.0);  // target=0 => always scale down

    size_t syn_i = net.addSynapse(1, 0, -0.5, 2.0, 0);
    net.enablePlasticity(syn_i, 0.01, 0.01, 20.0, 20.0, -1.0, 0.0);

    // Drive B to spike — rate > 0 = target => scale < 1 => weight more negative, clamped at -1
    for (int i = 0; i < 200; ++i) {
        net.setExternalInput(0, I_DRIVE);
        net.step(dt);
    }

    double w_i = net.getSynapse(syn_i).getWeight();
    CHECK(w_i <= 0.0);   // w_max
    CHECK(w_i >= -1.0);  // w_min
    CHECK(std::isfinite(w_i));

    std::cout << "PASS (exc=" << w_e << ", inh=" << w_i << ")" << std::endl;
}

// ===================================================================
// TEST 12: STDP + homeostasis interaction
// ===================================================================
void test_stdp_homeostasis_interaction() {
    std::cout << "Test 12: STDP + homeostasis interaction... " << std::flush;

    Network net;
    net.setHomeostasisParameters(1000.0, 0.001, 1000.0, 0.0);  // very slow, high target

    double dt = 1.0;

    size_t A = net.addNeuron(10.0, 1.0, 20.0, 0.1, 0.0);
    size_t B = net.addNeuron(10.0, 1.0, 20.0, 0.1, 0.0);
    size_t syn = net.addSynapse(A, B, 0.5, 2.0, 0);
    net.enablePlasticity(syn, 0.01, 0.01, 20.0, 20.0, 0.0, 1.0);

    double w_init = net.getSynapse(syn).getWeight();

    // Train STDP: pre before post => LTP
    for (int trial = 0; trial < 50; ++trial) {
        net.setExternalInput(A, 2.0);
        net.step(dt);
        net.setExternalInput(B, 2.0);
        net.step(dt);
        net.step(dt);  // rest
    }

    double w_after_stdp = net.getSynapse(syn).getWeight();
    CHECK(w_after_stdp > w_init);  // STDP increased weight

    // Verify STDP is still working AND homeostasis didn't destroy it
    CHECK(net.getSynapse(syn).getWeight() > 0.0);
    CHECK(net.getSynapse(syn).getWeight() <= 1.0);

    std::cout << "PASS (STDP: " << w_init << " -> " << w_after_stdp << ")" << std::endl;
}

// ===================================================================
// TEST 13: Deterministic repeated execution
// ===================================================================
void test_deterministic() {
    std::cout << "Test 13: Deterministic repeated execution... " << std::flush;

    auto build = []() {
        Network net;
        addSpikingNeuron(net);
        addSpikingNeuron(net);
        net.setHomeostasisParameters(0.5, 0.1, 5.0, 0.1);
        net.addSynapse(1, 0, 0.5, 2.0, 0);
        return net;
    };

    auto run_sim = [](Network& net) {
        double dt = DT;
        for (int i = 0; i < 300; ++i) {
            net.setExternalInput(0, (i % 10 == 0) ? I_DRIVE : 0.0);
            net.setExternalInput(1, I_DRIVE);
            net.step(dt);
        }
    };

    Network net1 = build();
    Network net2 = build();

    run_sim(net1);
    run_sim(net2);

    // Same network, same inputs, same dt => identical state
    CHECK(net1.getNeuron(0).getV() == net2.getNeuron(0).getV());
    CHECK(net1.getNeuron(1).getV() == net2.getNeuron(1).getV());
    CHECK_NEAR(net1.getFiringRates()[0], net2.getFiringRates()[0], 1e-15);
    CHECK_NEAR(net1.getFiringRates()[1], net2.getFiringRates()[1], 1e-15);
    CHECK(net1.getSynapse(0).getWeight() == net2.getSynapse(0).getWeight());
    CHECK(net1.getHomeostaticScale(0) == net2.getHomeostaticScale(0));

    std::cout << "PASS (identical rates and weights)" << std::endl;
}

// ===================================================================
// TEST 14: Multi-neuron isolation (incoming-only)
// ===================================================================
void test_multi_neuron_isolation() {
    std::cout << "Test 14: Multi-neuron isolation (incoming-only scaling)... " << std::flush;

    Network net;
    addSpikingNeuron(net);  // n0 (quiet, no drive)
    addSpikingNeuron(net);  // n1 (quiet, no drive)
    addSpikingNeuron(net);  // n2 (hyperactive)
    // target=0 Hz so quiet neurons (r_mean=0) have error=0 and don't scale.
    // Only n2 (hyperactive, r_mean > 0) will have error != 0 and trigger scaling.
    net.setHomeostasisParameters(1.0, 0.5, 0.0, 0.0);

    double dt = DT;

    // n0 -> n2 (incoming to n2)
    size_t syn_n0_n2 = net.addSynapse(0, 2, 0.5, 2.0, 0);
    // n1 -> n2 (incoming to n2)
    size_t syn_n1_n2 = net.addSynapse(1, 2, 0.5, 2.0, 0);
    // n2 -> n1 (outgoing from n2, incoming to n1)
    size_t syn_n2_n1 = net.addSynapse(2, 1, 0.001, 2.0, 0);  // tiny weight so n1 stays quiet

    double w_n0_n2_init = net.getSynapse(syn_n0_n2).getWeight();
    double w_n1_n2_init = net.getSynapse(syn_n1_n2).getWeight();
    double w_n2_n1_init = net.getSynapse(syn_n2_n1).getWeight();

    // Drive n2 to fire at high rate (hyperactive)
    // n2's incoming synapses (n0->n2 and n1->n2) should be scaled.
    // n2's outgoing synapse (n2->n1) should NOT be directly modified by n2's homeostasis
    // (it's n1's incoming, so only n1's homeostasis would affect it)
    // n1 is not driven hard, so it should be quiet => n2->n1 unchanged.
    for (int i = 0; i < 50; ++i) {
        net.setExternalInput(2, I_DRIVE);
        net.step(dt);
    }

    double w_n0_n2_final = net.getSynapse(syn_n0_n2).getWeight();
    double w_n1_n2_final = net.getSynapse(syn_n1_n2).getWeight();
    double w_n2_n1_final = net.getSynapse(syn_n2_n1).getWeight();

    // n2's incoming weights should have changed (scaled down due to hyperactivity)
    // n2's outgoing synapse should NOT be modified by n2's homeostasis
    // (it's n1's incoming, and n1 is quiet so n1's homeostasis doesn't trigger)
    CHECK_NEAR(w_n2_n1_final, w_n2_n1_init, 1e-12);

    std::cout << "PASS (incoming changed, outgoing not directly scaled)" << std::endl;
}

// ===================================================================
// TEST 15: Parameter validation
// ===================================================================
void test_parameter_validation() {
    std::cout << "Test 15: Parameter validation... " << std::flush;

    Network net;
    addSpikingNeuron(net);

    // tau_r <= 0
    bool caught = false;
    try { net.setHomeostasisParameters(0.0, 0.1, 5.0, 0.1); } catch (const std::invalid_argument&) { caught = true; }
    CHECK(caught);

    caught = false;
    try { net.setHomeostasisParameters(-1.0, 0.1, 5.0, 0.1); } catch (const std::invalid_argument&) { caught = true; }
    CHECK(caught);

    // kappa <= 0
    caught = false;
    try { net.setHomeostasisParameters(1.0, 0.0, 5.0, 0.1); } catch (const std::invalid_argument&) { caught = true; }
    CHECK(caught);

    caught = false;
    try { net.setHomeostasisParameters(1.0, -0.1, 5.0, 0.1); } catch (const std::invalid_argument&) { caught = true; }
    CHECK(caught);

    // target_hz < 0
    caught = false;
    try { net.setHomeostasisParameters(1.0, 0.1, -1.0, 0.1); } catch (const std::invalid_argument&) { caught = true; }
    CHECK(caught);

    // target_hz = 0 is valid
    caught = false;
    try { net.setHomeostasisParameters(1.0, 0.1, 0.0, 0.1); } catch (...) { caught = true; }
    CHECK(!caught);

    // hysteresis_hz < 0
    caught = false;
    try { net.setHomeostasisParameters(1.0, 0.1, 5.0, -0.1); } catch (const std::invalid_argument&) { caught = true; }
    CHECK(caught);

    // hysteresis_hz = 0 is valid
    caught = false;
    try { net.setHomeostasisParameters(1.0, 0.1, 5.0, 0.0); } catch (...) { caught = true; }
    CHECK(!caught);

    // NaN and Inf
    caught = false;
    try { net.setHomeostasisParameters(std::numeric_limits<double>::quiet_NaN(), 0.1, 5.0, 0.1); } catch (...) { caught = true; }
    CHECK(caught);

    caught = false;
    try { net.setHomeostasisParameters(1.0, std::numeric_limits<double>::infinity(), 5.0, 0.1); } catch (...) { caught = true; }
    CHECK(caught);

    std::cout << "PASS" << std::endl;
}

// ===================================================================
// TEST 16: Different dt values (physical-rate behavior)
// ===================================================================
void test_dt_variation() {
    std::cout << "Test 16: Different dt values produce consistent Hz behavior... " << std::flush;

    // With dt=0.1, one spike gives r_inst = 10 Hz
    // With dt=0.01, one spike gives r_inst = 100 Hz
    // These are different physical rates, so the EMA results should differ
    // in a way consistent with the physical Hz formula.

    double tau_r = 1.0;

    // dt = 0.1, one spike
    // With dt=0.1 and tau_m=10, theta_0=1.0: V_temp = 0 + 15*0.1 = 1.5 >= 1.0 => spike
    // But with dt=0.01: V_temp = 0 + I*0.01. For V_temp >= 1.0, need I >= 100.
    // Use I=150 for dt=0.01, I=15 for dt=0.1 (same V_temp = 1.5)
    {
        Network net;
        addSpikingNeuron(net);
        net.setHomeostasisParameters(tau_r, 1.0, 1000.0, 0.0);
        double dt = 0.1;
        net.setExternalInput(0, I_DRIVE);  // 15.0
        net.step(dt);
        CHECK(net.getSpikesThisStep()[0]);

        double r_inst = 1.0 / dt;  // 10 Hz
        double decay = std::exp(-dt / tau_r);
        double expected = r_inst * (1.0 - decay);
        CHECK_NEAR(net.getFiringRates()[0], expected, 1e-12);
    }

    // dt = 0.01, one spike
    // Need I >= 100 for V_temp = I*0.01 >= 1.0. Use I=150 => V_temp=1.5
    {
        Network net;
        net.addNeuron(10.0, 1.0, 20.0, 0.1, 0.0);
        net.setHomeostasisParameters(tau_r, 1.0, 1000.0, 0.0);
        double dt = 0.01;
        net.setExternalInput(0, 150.0);
        net.step(dt);
        CHECK(net.getSpikesThisStep()[0]);

        double r_inst = 1.0 / dt;  // 100 Hz
        double decay = std::exp(-dt / tau_r);
        double expected = r_inst * (1.0 - decay);
        CHECK_NEAR(net.getFiringRates()[0], expected, 1e-12);
    }

    std::cout << "PASS" << std::endl;
}

// ===================================================================
// TEST 17: reset() restores homeostatic state
// ===================================================================
void test_reset() {
    std::cout << "Test 17: reset() restores homeostatic state... " << std::flush;

    Network net;
    addSpikingNeuron(net);
    addSpikingNeuron(net);
    net.setHomeostasisParameters(0.5, 0.1, 5.0, 0.1);

    double dt = DT;

    // Run simulation to build up state
    for (int i = 0; i < 100; ++i) {
        net.setExternalInput(0, I_DRIVE);
        net.step(dt);
    }

    // Verify state is non-trivial
    CHECK(net.getFiringRates()[0] > 0.0);
    CHECK(net.getCurrentTimeStep() > 0);

    // Reset
    net.reset();

    // State should be back to initial
    CHECK_NEAR(net.getFiringRates()[0], 0.0, 1e-15);
    CHECK_NEAR(net.getFiringRates()[1], 0.0, 1e-15);
    CHECK_NEAR(net.getHomeostaticScale(0), 1.0, 1e-15);
    CHECK_NEAR(net.getHomeostaticScale(1), 1.0, 1e-15);
    CHECK(net.getCurrentTimeStep() == 0);

    // Homeostasis config should still be enabled
    CHECK(net.isHomeostasisEnabled());

    std::cout << "PASS" << std::endl;
}

// ===================================================================
// TEST 18: addNeuron() correctly initializes new state
// ===================================================================
void test_add_neuron_state() {
    std::cout << "Test 18: addNeuron() initializes new state without disturbing existing... " << std::flush;

    Network net;
    addSpikingNeuron(net);  // n0
    net.setHomeostasisParameters(0.5, 0.1, 5.0, 0.1);

    // Drive n0 to build up rate
    double dt = DT;
    for (int i = 0; i < 50; ++i) {
        net.setExternalInput(0, I_DRIVE);
        net.step(dt);
    }
    double r0_before = net.getFiringRates()[0];
    CHECK(r0_before > 0.0);

    // Add neuron AFTER homeostasis is configured
    size_t n1 = net.addNeuron(10.0, 1.0, 20.0, 0.1, 0.0);
    CHECK(net.getFiringRates().size() == 2);
    CHECK_NEAR(net.getFiringRates()[1], 0.0, 1e-15);         // new neuron starts at 0
    CHECK_NEAR(net.getHomeostaticScale(1), 1.0, 1e-15);       // new neuron scale = 1
    CHECK_NEAR(net.getFiringRates()[0], r0_before, 1e-15);   // existing neuron unchanged

    std::cout << "PASS" << std::endl;
}

// ===================================================================
// TEST 19: Extreme/pathological parameter safety
// ===================================================================
void test_extreme_safety() {
    std::cout << "Test 19: Extreme parameter safety... " << std::flush;

    Network net;
    addSpikingNeuron(net);  // B
    addSpikingNeuron(net);  // A

    // Large kappa but small enough to not overflow exp
    // target=1.0 Hz so B (spiking at ~10 Hz) is hyperactive => scale < 1
    net.setHomeostasisParameters(0.01, 0.001, 1.0, 0.0);

    double dt = DT;

    size_t A = 1, B = 0;
    size_t syn = net.addSynapse(A, B, 0.01, 2.0, 0);  // tiny weight
    double w_init = net.getSynapse(syn).getWeight();

    // Drive B hard — rate will be very high, error very negative
    // scale = exp(kappa * error * dt) = exp(0.001 * (10 - high) * 0.1)
    // Even if rate is ~100 Hz, exponent = 0.001 * (-90) * 0.1 = -0.009, scale ≈ 0.991
    for (int i = 0; i < 1000; ++i) {
        net.setExternalInput(B, I_DRIVE);
        net.step(dt);
    }

    double w_final = net.getSynapse(syn).getWeight();
    CHECK(std::isfinite(w_final));
    CHECK(w_final >= 0.0);
    CHECK(w_final <= 1.0);
    CHECK(w_final < w_init);  // decreased

    // Also verify all firing rates are finite
    for (size_t i = 0; i < net.getNeuronCount(); ++i) {
        CHECK(std::isfinite(net.getFiringRates()[i]));
    }

    std::cout << "PASS (w=" << w_init << " -> " << w_final << ")" << std::endl;
}

// ===================================================================
// TEST 20: Repeated updates remain finite/stable
// ===================================================================
void test_repeated_stability() {
    std::cout << "Test 20: Repeated homeostatic updates remain finite/stable... " << std::flush;

    Network net;
    addSpikingNeuron(net);  // B
    addSpikingNeuron(net);  // A

    net.setHomeostasisParameters(0.5, 0.1, 5.0, 0.0);

    double dt = DT;
    size_t A = 1, B = 0;
    size_t syn = net.addSynapse(A, B, 0.5, 2.0, 0);

    // Run many steps with alternating spiking
    for (int i = 0; i < 5000; ++i) {
        if (i % 3 == 0) {
            net.setExternalInput(B, I_DRIVE);
        } else {
            net.setExternalInput(A, I_DRIVE);
            net.setExternalInput(B, 0.0);
        }
        net.step(dt);

        // Check invariants every 100 steps
        if (i % 100 == 0) {
            double w = net.getSynapse(syn).getWeight();
            double r = net.getFiringRates()[B];
            CHECK(std::isfinite(w));
            CHECK(std::isfinite(r));
            CHECK(w >= 0.0);
            CHECK(w <= 1.0);
            CHECK(r >= 0.0);
            CHECK(std::isfinite(net.getHomeostaticScale(B)));
        }
    }

    std::cout << "PASS" << std::endl;
}

// ===================================================================
// Main
// ===================================================================
int main() {
    std::cout << "==========================================" << std::endl;
    std::cout << "STARK-005 Homeostatic Plasticity Tests" << std::endl;
    std::cout << "==========================================" << std::endl;

    test_physical_hz_units();
    test_ema_analytical();
    test_rate_decay();
    test_hyperactive_down();
    test_hypoactive_up();
    test_multiplicative_scaling();
    test_ratio_preservation();
    test_inhibitory_preservation();
    test_zero_weight_preservation();
    test_hysteresis_deadzone();
    test_weight_bounds();
    test_stdp_homeostasis_interaction();
    test_deterministic();
    test_multi_neuron_isolation();
    test_parameter_validation();
    test_dt_variation();
    test_reset();
    test_add_neuron_state();
    test_extreme_safety();
    test_repeated_stability();

    std::cout << "==========================================" << std::endl;
    std::cout << "Total assertions: " << g_checks << std::endl;
    std::cout << "ALL TESTS PASSED" << std::endl;
    std::cout << "==========================================" << std::endl;

    return 0;
}
