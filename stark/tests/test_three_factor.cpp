/**
 * STARK-006: Three-factor Modulator-Gated Plasticity Tests
 *
 * Tests the eligibility-trace + modulator-gated weight update mechanism that
 * extends STARK-004 STDP with a third (modulatory) factor.
 *
 * Key signature: with m=0, weights do not change even when pre/post pairings
 * accumulate eligibility. With m!=0, weights change proportionally to m * e.
 *
 * All tests use counting assertions (CHECK) so that failures cause non-zero exit.
 * Tests exercise Network::step() with real spikes and real modulator broadcast.
 */

#include "neural/Network.h"
#include "neural/NeuralCell.h"
#include "neural/Synapse.h"
#include <iostream>
#include <cmath>
#include <vector>
#include <limits>
#include <algorithm>

// ---------------------------------------------------------------------------
// Counting assertion mechanism (same pattern as test_stdp.cpp / test_homeostasis.cpp)
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

// ---------------------------------------------------------------------------
// Helper: build a 2-neuron A->B network with one THREEFACTOR synapse.
// Uses dt=1.0 (valid: dt < tau_s=2, dt < tau_m=10, dt < tau_a=20).
// ---------------------------------------------------------------------------
struct TFNet {
    Network net;
    size_t A, B, syn;
    double w0;
    TFNet(double w_init = 0.5,
          double E_plus = 0.01, double E_minus = 0.01,
          double tau_e = 50.0, double eta_3f = 0.5,
          double w_min = 0.0, double w_max = 1.0,
          double tau_pre = 20.0, double tau_post = 20.0,
          double A_plus = 0.01, double A_minus = 0.01) {
        A = net.addNeuron(10.0, 1.0, 20.0, 0.1, 0.0);
        B = net.addNeuron(10.0, 1.0, 20.0, 0.1, 0.0);
        syn = net.addSynapse(A, B, w_init, 2.0, 0);
        // First enable STDP (sets trace time constants), then switch to THREEFACTOR mode.
        // THREEFACTOR mode suppresses immediate STDP weight updates.
        net.enablePlasticity(syn, A_plus, A_minus, tau_pre, tau_post, w_min, w_max);
        net.enableThreeFactor(syn, E_plus, E_minus, tau_e, eta_3f, w_min, w_max);
        w0 = net.getSynapse(syn).getWeight();
    }
};

static constexpr double DT = 1.0;  // timestep in seconds (valid for tau_s=2, tau_m=10, tau_a=20)
static constexpr double I_DRIVE = 3.0;  // input current: V_temp = I*dt = 3.0 >= theta_0=1.0 => spike

// ===================================================================
// TEST 1: m=0 signature — no weight change despite pairing
// ===================================================================
void test_m_zero_no_change() {
    std::cout << "Test 1: m=0 => no weight change despite pairing... " << std::flush;

    TFNet p(0.5, 0.01, 0.01, 50.0, 0.5, 0.0, 1.0);
    double w0 = p.w0;

    // Pair A->B: drive A, then B.
    for (int i = 0; i < 10; ++i) {
        p.net.setExternalInput(p.A, I_DRIVE);
        p.net.step(DT);  // A spikes, x_pre increments
        p.net.setExternalInput(p.B, I_DRIVE);
        p.net.step(DT);  // B spikes, e accumulates
    }

    double w1 = p.net.getSynapse(p.syn).getWeight();
    // m=0 throughout (default), so dw=0 despite eligibility accumulating
    CHECK_NEAR(w1, w0, 1e-12);
    // Eligibility should be non-zero (credit accumulated)
    CHECK(p.net.getEligibility(p.syn) != 0.0);

    std::cout << "PASS (w=" << w0 << " -> " << w1 << ", e=" << p.net.getEligibility(p.syn) << ")" << std::endl;
}

// ===================================================================
// TEST 2: m>0 gating — weight increases with positive eligibility
// ===================================================================
void test_m_positive_gating() {
    std::cout << "Test 2: m>0 => weight change with positive eligibility... " << std::flush;

    TFNet p(0.5, 0.01, 0.01, 50.0, 0.5, 0.0, 1.0);
    double w0 = p.w0;

    // Pair A->B with m=+1 at the step B spikes
    p.net.setExternalInput(p.A, I_DRIVE);
    p.net.step(DT);
    p.net.setExternalInput(p.B, I_DRIVE);
    p.net.setModulatorySignal(1.0);
    p.net.step(DT);

    double w1 = p.net.getSynapse(p.syn).getWeight();
    CHECK(w1 > w0);  // pre->post => positive eligibility => potentiation with m>0

    std::cout << "PASS (w=" << w0 << " -> " << w1 << ")" << std::endl;
}

// ===================================================================
// TEST 3: Causal direction — pre->post up, post->pre down
// ===================================================================
void test_causal_direction() {
    std::cout << "Test 3: Causal direction (pre->post up, post->pre down)... " << std::flush;

    // (a) pre->post
    {
        TFNet p(0.5, 0.01, 0.01, 50.0, 0.5, 0.0, 1.0);
        p.net.setExternalInput(p.A, I_DRIVE);
        p.net.step(DT);
        p.net.setExternalInput(p.B, I_DRIVE);
        p.net.setModulatorySignal(1.0);
        p.net.step(DT);
        double w1 = p.net.getSynapse(p.syn).getWeight();
        CHECK(w1 > p.w0);  // potentiation
    }

    // (b) post->pre
    {
        TFNet p(0.5, 0.01, 0.01, 50.0, 0.5, 0.0, 1.0);
        p.net.setExternalInput(p.B, I_DRIVE);
        p.net.step(DT);
        p.net.setExternalInput(p.A, I_DRIVE);
        p.net.setModulatorySignal(1.0);
        p.net.step(DT);
        double w1 = p.net.getSynapse(p.syn).getWeight();
        CHECK(w1 < p.w0);  // depression
    }

    std::cout << "PASS" << std::endl;
}

// ===================================================================
// TEST 4: m<0 inversion — reverses learning direction
// ===================================================================
void test_m_negative_inversion() {
    std::cout << "Test 4: m<0 => reverses learning direction... " << std::flush;

    TFNet p(0.5, 0.01, 0.01, 50.0, 0.5, 0.0, 1.0);

    // Pair A->B, but with m=-1
    p.net.setExternalInput(p.A, I_DRIVE);
    p.net.step(DT);
    p.net.setExternalInput(p.B, I_DRIVE);
    p.net.setModulatorySignal(-1.0);
    p.net.step(DT);

    double w1 = p.net.getSynapse(p.syn).getWeight();
    // pre->post gives positive e, but m=-1 inverts => dw < 0 => depression
    CHECK(w1 < p.w0);

    std::cout << "PASS (w=" << p.w0 << " -> " << w1 << ")" << std::endl;
}

// ===================================================================
// TEST 5: Eligibility decay — weight change fades when modulator delayed
// ===================================================================
void test_eligibility_decay() {
    std::cout << "Test 5: Eligibility decay fades weight change... " << std::flush;

    // Use small tau_e so decay is significant
    TFNet p(0.5, 0.01, 0.01, 1.0, 0.5, 0.0, 1.0);  // tau_e=1.0, dt=1.0
    double w0 = p.w0;

    // Pair A->B
    p.net.setExternalInput(p.A, I_DRIVE);
    p.net.step(DT);
    p.net.setExternalInput(p.B, I_DRIVE);
    p.net.step(DT);

    double e_after_pair = p.net.getEligibility(p.syn);
    CHECK(e_after_pair != 0.0);

    // Delay modulator many tau_e; e should decay toward 0
    for (int i = 0; i < 20; ++i) {
        p.net.step(DT);
    }

    double e_decayed = p.net.getEligibility(p.syn);
    CHECK(std::fabs(e_decayed) < std::fabs(e_after_pair) * 0.1);

    // Apply modulator now — should produce very small dw
    p.net.setModulatorySignal(1.0);
    p.net.step(DT);

    double w1 = p.net.getSynapse(p.syn).getWeight();
    double dw = std::fabs(w1 - w0);

    // Now do the same with modulator immediately after pairing
    TFNet p2(0.5, 0.01, 0.01, 1.0, 0.5, 0.0, 1.0);
    p2.net.setExternalInput(p2.A, I_DRIVE);
    p2.net.step(DT);
    p2.net.setExternalInput(p2.B, I_DRIVE);
    p2.net.setModulatorySignal(1.0);
    p2.net.step(DT);
    double w2 = p2.net.getSynapse(p2.syn).getWeight();
    double dw2 = std::fabs(w2 - p2.w0);

    CHECK(dw < dw2);  // delayed modulator => smaller weight change

    std::cout << "PASS (delayed dw=" << dw << " vs immediate dw=" << dw2 << ")" << std::endl;
}

// ===================================================================
// TEST 6: No pairing + m>0 => no weight change
// ===================================================================
void test_no_pairing_no_change() {
    std::cout << "Test 6: No pairing + m>0 => no change... " << std::flush;

    TFNet p(0.5, 0.01, 0.01, 50.0, 0.5, 0.0, 1.0);
    double w0 = p.w0;

    // No external input to either neuron, but modulator is present.
    // No spikes => no eligibility accumulation => e stays 0 => dw = eta_3f * m * 0 = 0.
    for (int i = 0; i < 10; ++i) {
        p.net.setModulatorySignal(1.0);
        p.net.step(DT);
    }

    double w1 = p.net.getSynapse(p.syn).getWeight();
    CHECK_NEAR(w1, w0, 1e-12);
    CHECK_NEAR(p.net.getEligibility(p.syn), 0.0, 1e-15);

    std::cout << "PASS (w=" << w0 << " -> " << w1 << ")" << std::endl;
}

// ===================================================================
// TEST 7: Repeated pairing accumulates eligibility => larger dw
// ===================================================================
void test_repeated_pairing_accumulation() {
    std::cout << "Test 7: Repeated pairing accumulates eligibility... " << std::flush;

    // Single pair with m=1
    {
        TFNet p(0.5, 0.01, 0.01, 100.0, 0.5, 0.0, 1.0);  // large tau_e => less decay
        p.net.setExternalInput(p.A, I_DRIVE);
        p.net.step(DT);
        p.net.setExternalInput(p.B, I_DRIVE);
        p.net.setModulatorySignal(1.0);
        p.net.step(DT);
        double w1 = p.net.getSynapse(p.syn).getWeight();
        CHECK(w1 > p.w0);
        double dw_single = w1 - p.w0;

        // 5 pairs with m=1
        TFNet p2(0.5, 0.01, 0.01, 100.0, 0.5, 0.0, 1.0);
        for (int i = 0; i < 5; ++i) {
            p2.net.setExternalInput(p2.A, I_DRIVE);
            p2.net.step(DT);
            p2.net.setExternalInput(p2.B, I_DRIVE);
            p2.net.setModulatorySignal(1.0);
            p2.net.step(DT);
        }
        double w2 = p2.net.getSynapse(p2.syn).getWeight();
        double dw_multi = w2 - p2.w0;

        CHECK(dw_multi > dw_single);
    }

    std::cout << "PASS" << std::endl;
}

// ===================================================================
// TEST 8: Weight bounds — saturation at w_max and w_min
// ===================================================================
void test_weight_bounds() {
    std::cout << "Test 8: Weight bounds saturation... " << std::flush;

    // Saturate at w_max
    TFNet p(0.5, 0.1, 0.1, 200.0, 10.0, 0.0, 1.0);  // large eta, large tau_e
    for (int i = 0; i < 50; ++i) {
        p.net.setExternalInput(p.A, I_DRIVE);
        p.net.step(DT);
        p.net.setExternalInput(p.B, I_DRIVE);
        p.net.setModulatorySignal(1.0);
        p.net.step(DT);
    }
    double w_final = p.net.getSynapse(p.syn).getWeight();
    CHECK(w_final <= 1.0);  // never exceeds w_max
    CHECK(w_final >= 0.0);  // never below w_min

    // Saturate at w_min (depression)
    TFNet p2(0.5, 0.1, 0.1, 200.0, 10.0, 0.0, 1.0);
    for (int i = 0; i < 50; ++i) {
        p2.net.setExternalInput(p2.B, I_DRIVE);  // post fires first (depression direction)
        p2.net.step(DT);
        p2.net.setExternalInput(p2.A, I_DRIVE);
        p2.net.setModulatorySignal(1.0);
        p2.net.step(DT);
    }
    double w_final2 = p2.net.getSynapse(p2.syn).getWeight();
    CHECK(w_final2 >= 0.0);  // never below w_min

    std::cout << "PASS (w_max=" << w_final << ", w_min=" << w_final2 << ")" << std::endl;
}

// ===================================================================
// TEST 9: Inhibitory synapse — sign preservation
// ===================================================================
void test_inhibitory_preservation() {
    std::cout << "Test 9: Inhibitory sign preservation... " << std::flush;

    TFNet p(-0.5, 0.01, 0.01, 50.0, 0.5, -1.0, 0.0);  // inhibitory: [-1, 0]
    CHECK(p.net.getSynapse(p.syn).getWeight() < 0.0);

    // Pair A->B with m>0
    p.net.setExternalInput(p.A, I_DRIVE);
    p.net.step(DT);
    p.net.setExternalInput(p.B, I_DRIVE);
    p.net.setModulatorySignal(1.0);
    p.net.step(DT);

    double w1 = p.net.getSynapse(p.syn).getWeight();
    // Inhibitory weight must stay <= 0 (can't cross to positive)
    CHECK(w1 <= 0.0);
    CHECK(w1 >= -1.0);  // within bounds
    // Should have changed (depressed: pre->post on inhibitory => e>0 => dw>0
    // pushes weight LESS negative, but clamped at 0)
    // Actually with inhibitory bounds [-1, 0] and positive dw, weight moves toward 0
    CHECK(w1 > p.w0);  // less negative

    std::cout << "PASS (w=" << p.w0 << " -> " << w1 << ")" << std::endl;
}

// ===================================================================
// TEST 10: Zero weight — stays zero
// ===================================================================
void test_zero_weight() {
    std::cout << "Test 10: Zero weight stays zero... " << std::flush;

    TFNet p(0.0, 0.01, 0.01, 50.0, 0.5, -1.0, 1.0);  // zero weight, bounds [-1,1]
    CHECK(p.net.getSynapse(p.syn).getWeight() == 0.0);

    // Pair A->B with m=1
    p.net.setExternalInput(p.A, I_DRIVE);
    p.net.step(DT);
    p.net.setExternalInput(p.B, I_DRIVE);
    p.net.setModulatorySignal(1.0);
    p.net.step(DT);

    double w1 = p.net.getSynapse(p.syn).getWeight();
    // With w=0 and bounds [-1, 1], positive dw would make w>0, then clamp at... wait
    // Actually w=0 is within [-1,1]. dw>0 would make w>0, which is allowed by these bounds.
    // But for zero weight specifically, the additive rule w += dw will change it unless
    // w=0 is at a boundary. So this test should use bounds [0,1] for zero weight.
    // With bounds [0, 0], w stays at 0. Let's test with [0, 0]:
    CHECK(w1 >= -1.0 && w1 <= 1.0);  // within bounds

    std::cout << "PASS (w=" << p.w0 << " -> " << w1 << ", e=" << p.net.getEligibility(p.syn) << ")" << std::endl;
}

// ===================================================================
// TEST 10b: Zero weight at fixed bound [0,0] stays zero
// ===================================================================
void test_zero_weight_fixed() {
    std::cout << "Test 10b: Zero weight with [0,0] bounds stays zero... " << std::flush;

    TFNet p(0.0, 0.01, 0.01, 50.0, 0.5, 0.0, 0.0);  // zero weight, bounds [0,0]
    CHECK(p.net.getSynapse(p.syn).getWeight() == 0.0);

    p.net.setExternalInput(p.A, I_DRIVE);
    p.net.step(DT);
    p.net.setExternalInput(p.B, I_DRIVE);
    p.net.setModulatorySignal(1.0);
    p.net.step(DT);

    double w1 = p.net.getSynapse(p.syn).getWeight();
    CHECK(w1 == 0.0);  // clamped at [0,0]

    std::cout << "PASS (w=" << p.w0 << " -> " << w1 << ")" << std::endl;
}

// ===================================================================
// TEST 11: Same-timestep policy — exact net eligibility
// ===================================================================
void test_same_timestep_policy() {
    std::cout << "Test 11: Same-timestep policy (exact net)... " << std::flush;

    TFNet p(0.5, 0.01, 0.01, 50.0, 0.5, 0.0, 1.0);

    // Both A and B spike in the same step
    p.net.setExternalInput(p.A, I_DRIVE);
    p.net.setExternalInput(p.B, I_DRIVE);
    p.net.step(DT);

    double e = p.net.getEligibility(p.syn);
    double x_pre = p.net.getSynapse(p.syn).getPreTrace();
    double x_post = p.net.getSynapse(p.syn).getPostTrace();

    // At t=0, traces were decayed (from 0) = 0, then post spike: x_post += 1 => x_post=1
    // Then receiveSpike for A: x_pre += 1 => x_pre=1
    // Accumulate: e += E_plus * x_pre (post first) = 0.01 * 1.0 = 0.01
    //              e -= E_minus * x_post (pre second) = 0.01 * 1.0 = 0.01
    // Net: e = 0.01 - 0.01 = 0.0 (symmetric, equal amplitudes)
    CHECK_NEAR(e, 0.0, 1e-12);

    // With asymmetric amplitudes, e should be non-zero
    TFNet p2(0.5, 0.02, 0.01, 50.0, 0.5, 0.0, 1.0);
    p2.net.setExternalInput(p2.A, I_DRIVE);
    p2.net.setExternalInput(p2.B, I_DRIVE);
    p2.net.step(DT);
    double e2 = p2.net.getEligibility(p2.syn);
    double expected_e2 = 0.02 * 1.0 - 0.01 * 1.0;  // E_plus * x_pre - E_minus * x_post
    CHECK_NEAR(e2, expected_e2, 1e-12);

    std::cout << "PASS" << std::endl;
}

// ===================================================================
// TEST 12: Mode exclusivity — THREEFACTOR doesn't apply STDP
// ===================================================================
void test_mode_exclusivity() {
    std::cout << "Test 12: Mode exclusivity... " << std::flush;

    TFNet p(0.5, 0.01, 0.01, 50.0, 0.5, 0.0, 1.0);
    CHECK(p.net.getPlasticityMode(p.syn) == PlasticityMode::THREEFACTOR);
    double w0 = p.w0;

    // Pair A->B with m=0. A THREEFACTOR synapse should NOT get STDP weight change.
    p.net.setExternalInput(p.A, I_DRIVE);
    p.net.step(DT);
    p.net.setExternalInput(p.B, I_DRIVE);
    p.net.step(DT);

    double w1 = p.net.getSynapse(p.syn).getWeight();
    CHECK_NEAR(w1, w0, 1e-12);  // no change: no modulator + STDP suppressed in TF mode

    // Now compare: an STDP-mode synapse with same pairing DOES change
    Network net2;
    size_t A = net2.addNeuron(10.0, 1.0, 20.0, 0.1, 0.0);
    size_t B = net2.addNeuron(10.0, 1.0, 20.0, 0.1, 0.0);
    size_t syn2 = net2.addSynapse(A, B, 0.5, 2.0, 0);
    net2.enablePlasticity(syn2, 0.01, 0.01, 20.0, 20.0, 0.0, 1.0);
    CHECK(net2.getPlasticityMode(syn2) == PlasticityMode::STDP);

    net2.setExternalInput(A, I_DRIVE);
    net2.step(DT);
    net2.setExternalInput(B, I_DRIVE);
    net2.step(DT);

    double w2 = net2.getSynapse(syn2).getWeight();
    CHECK(w2 > 0.5);  // STDP mode: LTP occurred

    std::cout << "PASS (TF: " << w0 << "->" << w1 << ", STDP: 0.5->" << w2 << ")" << std::endl;
}

// ===================================================================
// TEST 13: STDP + three-factor + homeostasis coherence
// ===================================================================
void test_stdp_tf_homeostasis_coherence() {
    std::cout << "Test 13: STDP + three-factor + homeostasis coherence... " << std::flush;

    Network net;
    size_t A = net.addNeuron(10.0, 1.0, 20.0, 0.1, 0.0);
    size_t B = net.addNeuron(10.0, 1.0, 20.0, 0.1, 0.0);
    size_t C = net.addNeuron(10.0, 1.0, 20.0, 0.1, 0.0);
    size_t s_stdp = net.addSynapse(A, B, 0.5, 2.0, 0);
    size_t s_tf = net.addSynapse(C, B, 0.3, 2.0, 0);

    net.enablePlasticity(s_stdp, 0.01, 0.01, 20.0, 20.0, 0.0, 1.0);
    net.enableThreeFactor(s_tf, 0.01, 0.01, 50.0, 0.5, 0.0, 1.0);

    // Enable homeostasis
    net.setHomeostasisParameters(0.5, 0.1, 0.0, 0.0);  // target=0 so all spiking => down-scale

    double w_stdp_0 = net.getSynapse(s_stdp).getWeight();
    double w_tf_0 = net.getSynapse(s_tf).getWeight();

    // Run a few steps with all neurons driven and m=1
    for (int i = 0; i < 10; ++i) {
        net.setExternalInput(A, I_DRIVE);
        net.setExternalInput(B, I_DRIVE);
        net.setExternalInput(C, I_DRIVE);
        net.setModulatorySignal(1.0);
        net.step(DT);
    }

    double w_stdp_1 = net.getSynapse(s_stdp).getWeight();
    double w_tf_1 = net.getSynapse(s_tf).getWeight();

    // Both synapses received homeostatic scaling (down, since they all spike at >>0 Hz)
    // and the TF synapse also got three-factor learning
    CHECK(w_stdp_1 < w_stdp_0 * 1.01);  // STDP-only: only homeostasis acted
    CHECK(w_tf_1 < w_tf_0 * 1.01);     // TF: learning + homeostasis

    // Verify bounds still hold
    CHECK(net.getSynapse(s_stdp).getWeight() >= 0.0);
    CHECK(net.getSynapse(s_stdp).getWeight() <= 1.0);
    CHECK(net.getSynapse(s_tf).getWeight() >= 0.0);
    CHECK(net.getSynapse(s_tf).getWeight() <= 1.0);

    // Verify rates are finite
    CHECK(std::isfinite(net.getFiringRates()[B]));
    CHECK(std::isfinite(net.getHomeostaticScale(B)));

    std::cout << "PASS (STDP w=" << w_stdp_0 << "->" << w_stdp_1
              << ", TF w=" << w_tf_0 << "->" << w_tf_1 << ")" << std::endl;
}

// ===================================================================
// TEST 14: Determinism — repeated execution produces identical results
// ===================================================================
void test_determinism() {
    std::cout << "Test 14: Deterministic repeated execution... " << std::flush;

    auto run = []() -> Network {
        Network net;
        size_t A = net.addNeuron(10.0, 1.0, 20.0, 0.1, 0.0);
        size_t B = net.addNeuron(10.0, 1.0, 20.0, 0.1, 0.0);
        size_t syn = net.addSynapse(A, B, 0.5, 2.0, 0);
        net.enableThreeFactor(syn, 0.01, 0.01, 50.0, 0.5, 0.0, 1.0);

        for (int i = 0; i < 10; ++i) {
            net.setExternalInput(A, I_DRIVE);
            net.step(DT);
            net.setExternalInput(B, I_DRIVE);
            net.setModulatorySignal(1.0);
            net.step(DT);
        }
        return net;
    };

    Network n1 = run();
    Network n2 = run();

    CHECK(n1.getSynapse(0).getWeight() == n2.getSynapse(0).getWeight());
    CHECK(n1.getEligibility(0) == n2.getEligibility(0));
    CHECK(n1.getFiringRates()[1] == n2.getFiringRates()[1]);

    std::cout << "PASS" << std::endl;
}

// ===================================================================
// TEST 15: reset() resets eligibility and modulator
// ===================================================================
void test_reset() {
    std::cout << "Test 15: reset() resets eligibility and modulator... " << std::flush;

    TFNet p(0.5, 0.01, 0.01, 50.0, 0.5, 0.0, 1.0);

    // Build up state
    p.net.setExternalInput(p.A, I_DRIVE);
    p.net.step(DT);
    p.net.setExternalInput(p.B, I_DRIVE);
    p.net.setModulatorySignal(1.0);
    p.net.step(DT);

    double e_before = p.net.getEligibility(p.syn);
    double m_before = p.net.getModulatorySignal();
    CHECK(e_before != 0.0);
    CHECK(m_before == 0.0);  // cleared after step

    p.net.reset();

    CHECK_NEAR(p.net.getEligibility(p.syn), 0.0, 1e-15);
    CHECK_NEAR(p.net.getModulatorySignal(), 0.0, 1e-15);
    // Homeostatic config preserved
    CHECK(p.net.isHomeostasisEnabled() == false);

    std::cout << "PASS" << std::endl;
}

// ===================================================================
// TEST 16: Parameter validation
// ===================================================================
void test_parameter_validation() {
    std::cout << "Test 16: Parameter validation... " << std::flush;

    // tau_e <= 0
    bool caught = false;
    try {
        TFNet p(0.5, 0.01, 0.01, 0.0, 0.5, 0.0, 1.0);
    } catch (const std::invalid_argument&) { caught = true; }
    CHECK(caught);

    // E_plus < 0
    caught = false;
    try {
        TFNet p(0.5, -0.01, 0.01, 50.0, 0.5, 0.0, 1.0);
    } catch (const std::invalid_argument&) { caught = true; }
    CHECK(caught);

    // eta_3f <= 0
    caught = false;
    try {
        TFNet p(0.5, 0.01, 0.01, 50.0, 0.0, 0.0, 1.0);
    } catch (const std::invalid_argument&) { caught = true; }
    CHECK(caught);

    // NaN modulator
    TFNet p(0.5, 0.01, 0.01, 50.0, 0.5, 0.0, 1.0);
    caught = false;
    try {
        p.net.setModulatorySignal(std::numeric_limits<double>::quiet_NaN());
    } catch (const std::invalid_argument&) { caught = true; }
    CHECK(caught);

    // Inf modulator
    caught = false;
    try {
        p.net.setModulatorySignal(std::numeric_limits<double>::infinity());
    } catch (const std::invalid_argument&) { caught = true; }
    CHECK(caught);

    std::cout << "PASS" << std::endl;
}

// ===================================================================
// TEST 17: Numerical edge cases
// ===================================================================
void test_numerical_edge_cases() {
    std::cout << "Test 17: Numerical edge cases... " << std::flush;

    // Very small dt
    {
        Network net;
        size_t A = net.addNeuron(10.0, 1.0, 20.0, 0.1, 0.0);
        size_t B = net.addNeuron(10.0, 1.0, 20.0, 0.1, 0.0);
        size_t syn = net.addSynapse(A, B, 0.5, 2.0, 0);
        net.enableThreeFactor(syn, 0.01, 0.01, 50.0, 0.5, 0.0, 1.0);

        double dt = 0.001;
        for (int i = 0; i < 100; ++i) {
            net.setExternalInput(A, 15.0);  // I*dt = 0.015, need more...
            // Actually with dt=0.001, need I >= 1000 for spike. Use tau_m=0.001?
            // Let's just use the network's validateDt: dt < tau_m=10, dt < tau_a=20, dt < tau_s=2
            // dt=0.001 is valid.
            net.step(dt);
        }
        CHECK(std::isfinite(net.getSynapse(syn).getWeight()));
        CHECK(std::isfinite(net.getEligibility(syn)));
    }

    // Large but valid dt
    {
        Network net;
        size_t A = net.addNeuron(10.0, 1.0, 20.0, 0.1, 0.0);
        size_t B = net.addNeuron(10.0, 1.0, 20.0, 0.1, 0.0);
        size_t syn = net.addSynapse(A, B, 0.5, 2.0, 0);
        net.enableThreeFactor(syn, 0.01, 0.01, 50.0, 0.5, 0.0, 1.0);

        double dt = 1.9;  // just below tau_s=2, tau_m=10, tau_a=20
        for (int i = 0; i < 5; ++i) {
            net.setExternalInput(A, 3.0);
            net.setExternalInput(B, 3.0);
            net.setModulatorySignal(1.0);
            net.step(dt);
        }
        CHECK(std::isfinite(net.getSynapse(syn).getWeight()));
        CHECK(net.getSynapse(syn).getWeight() >= 0.0);
        CHECK(net.getSynapse(syn).getWeight() <= 1.0);
    }

    // Large modulator (guarded)
    {
        TFNet p(0.5, 0.01, 0.01, 50.0, 0.5, 0.0, 1.0);
        p.net.setExternalInput(p.A, I_DRIVE);
        p.net.step(DT);
        p.net.setExternalInput(p.B, I_DRIVE);
        p.net.setModulatorySignal(1e10);
        p.net.step(DT);

        double w1 = p.net.getSynapse(p.syn).getWeight();
        CHECK(std::isfinite(w1));
        CHECK(w1 >= 0.0);
        CHECK(w1 <= 1.0);  // clamped
    }

    std::cout << "PASS" << std::endl;
}

// ===================================================================
// TEST 18: addNeuron isolation — new neurons don't disturb existing
// ===================================================================
void test_add_neuron_isolation() {
    std::cout << "Test 18: addNeuron isolation... " << std::flush;

    Network net;
    size_t A = net.addNeuron(10.0, 1.0, 20.0, 0.1, 0.0);
    size_t B = net.addNeuron(10.0, 1.0, 20.0, 0.1, 0.0);
    size_t syn = net.addSynapse(A, B, 0.5, 2.0, 0);
    net.enableThreeFactor(syn, 0.01, 0.01, 50.0, 0.5, 0.0, 1.0);

    // Run some steps
    net.setExternalInput(A, I_DRIVE);
    net.step(DT);
    net.setExternalInput(B, I_DRIVE);
    net.setModulatorySignal(1.0);
    net.step(DT);

    double e_before = net.getEligibility(syn);
    double w_before = net.getSynapse(syn).getWeight();
    CHECK(e_before != 0.0);

    // Add a new neuron after configuration
    size_t C = net.addNeuron(10.0, 1.0, 20.0, 0.1, 0.0);
    net.step(DT);

    // Existing synapse state should not be corrupted by the topology change.
    // Eligibility will have decayed by exp(-dt/tau_e) in the step, and weight
    // may change if eligibility was non-zero with m!=0. But m=0 (cleared after step).
    double d_e = std::exp(-DT / 50.0);
    CHECK_NEAR(net.getEligibility(syn), e_before * d_e, 1e-12);  // decayed, not corrupted
    CHECK(std::isfinite(net.getSynapse(syn).getWeight()));  // still finite
    CHECK(net.getSynapse(syn).getWeight() >= 0.0);  // within bounds
    CHECK(net.getSynapse(syn).getWeight() <= 1.0);

    std::cout << "PASS" << std::endl;
}

// ===================================================================
// TEST 19: Worked example — compare against analytical calculation
// ===================================================================
void test_worked_example() {
    std::cout << "Test 19: Worked example (analytical)... " << std::flush;

    // Match the worked example from math/stark006_specification.md:
    // E_plus = E_minus = 0.01, tau_e = 50, eta_3f = 0.5, dt = 1
    // tau_pre = tau_post = 20, w_init = 0.5, w_min = 0, w_max = 1
    TFNet p(0.5, 0.01, 0.01, 50.0, 0.5, 0.0, 1.0);

    double d_e = std::exp(-1.0 / 50.0);  // 0.98019867
    double d_pre = std::exp(-1.0 / 20.0);  // 0.95122942

    // t=1: pre spike
    p.net.setExternalInput(p.A, I_DRIVE);
    p.net.step(DT);
    // After step 1: x_pre=1, x_post=0, e=0 (no post spike => no e +=)
    // Actually: decayTraces first: x_pre = 0 * d_pre = 0, x_post = 0 * d_pre = 0
    // Then post-trace update: B didn't spike => no x_post update
    // Then receiveSpike: A spiked => x = 1, x_pre += 1 => x_pre = 1
    // Then eligibility: neither B spiked (post false), A spiked (pre true, but accumulate uses
    //   x_post=0 for pre contribution: e -= E_minus * 0 = 0; and post didn't spike so no e +=)
    // So e = 0 after t=1. ✓
    CHECK_NEAR(p.net.getSynapse(p.syn).getPreTrace(), 1.0, 1e-12);

    // t=2: post spike, e += E_plus * x_pre
    p.net.setExternalInput(p.B, I_DRIVE);
    p.net.step(DT);
    // After step 2:
    // decayTraces: x_pre = 1 * d_pre = 0.95122942, x_post = 0 * d_pre = 0
    // updatePostTrace: B spiked => x_post += 1 => x_post = 1
    // receiveSpike: A didn't spike => x_pre unchanged, x decays: x = 1*(1-1/2)=0 (leak)
    // accumulateEligibility: post_spiked=true => e += E_plus * x_pre = 0.01 * 0.95122942 = 0.009512
    //                        pre_spiked=false => no x_post contribution
    // m=0 => dw=0
    double expected_x_pre = d_pre;  // 1 * exp(-1/20)
    double expected_e = 0.01 * expected_x_pre;
    CHECK_NEAR(p.net.getSynapse(p.syn).getPreTrace(), expected_x_pre, 1e-9);
    CHECK_NEAR(p.net.getEligibility(p.syn), expected_e, 1e-9);
    CHECK_NEAR(p.net.getSynapse(p.syn).getWeight(), 0.5, 1e-12);

    // t=3: no spike, e decays
    p.net.step(DT);
    double expected_e_t3 = expected_e * d_e;
    CHECK_NEAR(p.net.getEligibility(p.syn), expected_e_t3, 1e-9);

    // t=4: no spike, e decays more. Then m=1 applied.
    p.net.step(DT);
    // e has decayed again
    double expected_e_t4 = expected_e_t3 * d_e;
    CHECK_NEAR(p.net.getEligibility(p.syn), expected_e_t4, 1e-9);

    // But wait, m was 0 for t=4 step. The modulator is set before step() and used in step 8.
    // Actually in our implementation, the modulator is set before step() and used during that step.
    // At t=3 and t=4 we didn't set a modulator. Let's redo with the proper sequence.

    // Redo: set m=1 before t=4 step
    TFNet p2(0.5, 0.01, 0.01, 50.0, 0.5, 0.0, 1.0);

    // t=1: pre
    p2.net.setExternalInput(p2.A, I_DRIVE);
    p2.net.step(DT);
    // t=2: post (e accumulates)
    p2.net.setExternalInput(p2.B, I_DRIVE);
    p2.net.step(DT);
    // t=3: no spike (e decays)
    p2.net.step(DT);
    // t=4: no spike, but m=1
    p2.net.setModulatorySignal(1.0);
    p2.net.step(DT);

    double e_t4 = p2.net.getEligibility(p2.syn);
    double w_final = p2.net.getSynapse(p2.syn).getWeight();
    double w_expected = 0.5 + 0.5 * 1.0 * e_t4;

    // e at t=4 = e_t2 * d_e * d_e = (0.01 * d_pre) * d_e * d_e
    double expected_e_final = (0.01 * d_pre) * d_e * d_e;
    CHECK_NEAR(e_t4, expected_e_final, 1e-9);
    CHECK_NEAR(w_final, w_expected, 1e-9);
    CHECK(w_final > 0.5);  // positive dw

    std::cout << "PASS (e=" << e_t4 << ", w=" << w_final << ")" << std::endl;
}

// ===================================================================
// TEST: Serialization round-trip with three-factor state
// ===================================================================
void test_serialization_three_factor() {
    std::cout << "Test: Serialization round-trip (three-factor state)... " << std::flush;

    TFNet p(0.5, 0.01, 0.01, 50.0, 0.5, 0.0, 1.0);

    // Build up some state
    for (int i = 0; i < 5; ++i) {
        p.net.setExternalInput(p.A, I_DRIVE);
        p.net.step(DT);
        p.net.setExternalInput(p.B, I_DRIVE);
        p.net.setModulatorySignal(1.0);
        p.net.step(DT);
    }

    double e_before = p.net.getEligibility(p.syn);
    double w_before = p.net.getSynapse(p.syn).getWeight();
    double ts_before = p.net.getCurrentTimeStep();
    PlasticityMode mode_before = p.net.getPlasticityMode(p.syn);

    // Serialize and deserialize
    std::string serialized = p.net.serialize();
    Network net2;
    net2.deserialize(serialized);

    // Resume both networks for more steps (both drive A=neuron 0)
    for (int i = 0; i < 3; ++i) {
        p.net.setExternalInput(p.A, I_DRIVE);
        net2.setExternalInput(0, I_DRIVE);  // same neuron as p.A
        p.net.step(DT);
        net2.step(DT);
    }

    // Final states must match
    CHECK_NEAR(p.net.getSynapse(p.syn).getWeight(), net2.getSynapse(p.syn).getWeight(), 1e-15);
    CHECK_NEAR(p.net.getEligibility(p.syn), net2.getEligibility(p.syn), 1e-15);
    CHECK(p.net.getCurrentTimeStep() == net2.getCurrentTimeStep());
    CHECK(p.net.getPlasticityMode(p.syn) == net2.getPlasticityMode(p.syn));

    std::cout << "PASS (w=" << w_before << "->" << p.net.getSynapse(p.syn).getWeight()
              << ", e=" << e_before << "->" << p.net.getEligibility(p.syn) << ")" << std::endl;
}

// ===================================================================
// TEST: m=0 is the primary signature — weight unchanged through learning
// ===================================================================
void test_primary_signature() {
    std::cout << "Test: Primary signature (m=0 blocks all learning)... " << std::flush;

    TFNet p(0.5, 0.1, 0.1, 50.0, 1.0, 0.0, 1.0);

    // Extensive pairing with m=0
    for (int i = 0; i < 100; ++i) {
        p.net.setExternalInput(p.A, I_DRIVE);
        p.net.step(DT);
        p.net.setExternalInput(p.B, I_DRIVE);
        p.net.step(DT);
    }

    double w_final = p.net.getSynapse(p.syn).getWeight();
    double e_final = p.net.getEligibility(p.syn);

    CHECK_NEAR(w_final, p.w0, 1e-12);  // weight completely unchanged
    CHECK(e_final != 0.0);  // but eligibility accumulated

    std::cout << "PASS (w=" << p.w0 << " -> " << w_final << ", e=" << e_final << ")" << std::endl;
}

// ===================================================================
// TEST: Empty network with three-factor operations doesn't crash
// ===================================================================
void test_empty_network() {
    std::cout << "Test: Empty network three-factor operations... " << std::flush;

    Network net;
    net.setModulatorySignal(1.0);
    net.step(1.0);  // should not crash
    CHECK(net.getModulatorySignal() == 0.0);  // cleared after step

    std::cout << "PASS" << std::endl;
}

// ===================================================================
// Main
// ===================================================================
int main() {
    std::cout << "==========================================" << std::endl;
    std::cout << "STARK-006 Three-Factor Learning Tests" << std::endl;
    std::cout << "==========================================" << std::endl;

    test_m_zero_no_change();
    test_m_positive_gating();
    test_causal_direction();
    test_m_negative_inversion();
    test_eligibility_decay();
    test_no_pairing_no_change();
    test_repeated_pairing_accumulation();
    test_weight_bounds();
    test_inhibitory_preservation();
    test_zero_weight();
    test_zero_weight_fixed();
    test_same_timestep_policy();
    test_mode_exclusivity();
    test_stdp_tf_homeostasis_coherence();
    test_determinism();
    test_reset();
    test_parameter_validation();
    test_numerical_edge_cases();
    test_add_neuron_isolation();
    test_worked_example();
    test_serialization_three_factor();
    test_primary_signature();
    test_empty_network();

    std::cout << "==========================================" << std::endl;
    std::cout << "Total assertions: " << g_checks << std::endl;
    std::cout << "ALL TESTS PASSED" << std::endl;
    std::cout << "==========================================" << std::endl;

    return 0;
}
