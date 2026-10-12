// STARK-004 STDP tests.
//
// These tests verify the pair-based trace STDP rule implemented in
// Synapse and orchestrated by Network. They use a counting assertion
// macro (CHECK) so that every test can genuinely fail and the total
// number of assertions is reported.

#include "neural/Network.h"
#include "neural/NeuralCell.h"
#include "neural/Synapse.h"
#include <cassert>
#include <cstdlib>
#include <iostream>
#include <vector>
#include <cmath>

// ---------------------------------------------------------------------------
// Counting assertion mechanism
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
// Synapse-level unit tests
// ---------------------------------------------------------------------------

void test_synapse_plasticity_initialization() {
    std::cout << "Test: Synapse Plasticity Initialization... " << std::flush;

    Synapse synapse(0.5, 2.0);

    // Before plasticity is enabled, traces are zero.
    CHECK(synapse.getPreTrace() == 0.0);
    CHECK(synapse.getPostTrace() == 0.0);
    CHECK(synapse.getWeight() == 0.5);

    // Enable plasticity; weight should remain unchanged and clamped in range.
    synapse.setPlasticityParameters(0.01, 0.01, 20.0, 20.0, 0.0, 1.0);
    CHECK(synapse.getWeight() == 0.5);
    CHECK(synapse.getPreTrace() == 0.0);
    CHECK(synapse.getPostTrace() == 0.0);

    std::cout << "PASS" << std::endl;
}

void test_synapse_trace_decay() {
    std::cout << "Test: Synapse Trace Decay (exact exponential)... " << std::flush;

    Synapse synapse(0.5, 2.0);
    synapse.setPlasticityParameters(0.01, 0.01, 20.0, 20.0, 0.0, 1.0);

    // A pre spike increments the pre trace to exactly 1.
    synapse.receiveSpike(true, 1.0);
    CHECK(synapse.getPreTrace() == 1.0);

    // Decay for one step: x_pre *= exp(-1/20).
    double expected = std::exp(-1.0 / 20.0);
    synapse.decayTraces(1.0);
    CHECK_NEAR(synapse.getPreTrace(), expected, 1e-12);
    CHECK(synapse.getPreTrace() > 0.0);
    CHECK(synapse.getPreTrace() < 1.0);

    std::cout << "PASS" << std::endl;
}

void test_synapse_ltp_unit() {
    std::cout << "Test: Synapse LTP unit (post spike uses pre trace)... " << std::flush;

    Synapse synapse(0.5, 2.0);
    synapse.setPlasticityParameters(0.01, 0.01, 20.0, 20.0, 0.0, 1.0);

    // Pre spike raises x_pre to 1.
    synapse.receiveSpike(true, 1.0);
    CHECK(synapse.getPreTrace() == 1.0);

    // LTP: dw = +A_plus * x_pre = +0.01 * 1 = +0.01.
    double w0 = synapse.getWeight();
    synapse.applyLTP();
    CHECK_NEAR(synapse.getWeight(), w0 + 0.01, 1e-12);
    CHECK(synapse.getWeight() > w0);

    std::cout << "PASS" << std::endl;
}

void test_synapse_ltd_unit() {
    std::cout << "Test: Synapse LTD unit (pre spike uses post trace)... " << std::flush;

    Synapse synapse(0.5, 2.0);
    synapse.setPlasticityParameters(0.01, 0.01, 20.0, 20.0, 0.0, 1.0);

    // Post spike raises x_post to 1.
    synapse.updatePostTrace();
    CHECK(synapse.getPostTrace() == 1.0);

    // LTD: dw = -A_minus * x_post = -0.01 * 1 = -0.01.
    double w0 = synapse.getWeight();
    synapse.applyLTD();
    CHECK_NEAR(synapse.getWeight(), w0 - 0.01, 1e-12);
    CHECK(synapse.getWeight() < w0);

    std::cout << "PASS" << std::endl;
}

void test_synapse_weight_bounds() {
    std::cout << "Test: Synapse Weight Bounds... " << std::flush;

    // LTP drives weight up to w_max.
    Synapse syn(0.5, 2.0);
    syn.setPlasticityParameters(0.1, 0.1, 20.0, 20.0, 0.0, 1.0);
    for (int i = 0; i < 50; ++i) {
        syn.receiveSpike(true, 1.0);  // keep x_pre high
        syn.applyLTP();
    }
    CHECK(syn.getWeight() == 1.0);  // clamped at w_max

    // LTD drives weight down to w_min.
    Synapse syn2(0.5, 2.0);
    syn2.setPlasticityParameters(0.1, 0.1, 20.0, 20.0, 0.0, 1.0);
    for (int i = 0; i < 50; ++i) {
        syn2.updatePostTrace();       // keep x_post high
        syn2.applyLTD();
    }
    CHECK(syn2.getWeight() == 0.0);  // clamped at w_min

    std::cout << "PASS" << std::endl;
}

// ---------------------------------------------------------------------------
// Network-level STDP tests (exercise Network::step, not applyLTP/applyLTD)
// ---------------------------------------------------------------------------

// Helper: build a 2-neuron A->B network with one plastic synapse.
struct PairNet {
    Network net;
    size_t A, B, syn;
    PairNet(double w0) {
        A = net.addNeuron(10.0, 1.0, 20.0, 0.1, 0.0);
        B = net.addNeuron(10.0, 1.0, 20.0, 0.1, 0.0);
        syn = net.addSynapse(A, B, w0, 2.0, 0);
        net.enablePlasticity(syn, 0.01, 0.01, 20.0, 20.0, 0.0, 1.0);
    }
};

void test_network_stdp_potentiation() {
    std::cout << "Test: Network STDP Potentiation (pre before post)... " << std::flush;

    PairNet p(0.5);
    double w0 = p.net.getSynapse(p.syn).getWeight();
    CHECK(w0 == 0.5);

    // Step 1: drive A to spike (pre).
    p.net.setExternalInput(p.A, 2.0);
    p.net.step(1.0);
    CHECK(p.net.getSpikesThisStep()[p.A]);
    CHECK(!p.net.getSpikesThisStep()[p.B]);

    // Step 2: drive B to spike (post). A does not spike this step.
    p.net.setExternalInput(p.B, 2.0);
    p.net.step(1.0);
    CHECK(p.net.getSpikesThisStep()[p.B]);
    CHECK(!p.net.getSpikesThisStep()[p.A]);

    // pre->post => LTP => weight must increase.
    double w1 = p.net.getSynapse(p.syn).getWeight();
    CHECK(w1 > w0);
    // Expected: dw = +A_plus * x_pre, x_pre decayed one step from 1.
    double expected = w0 + 0.01 * std::exp(-1.0 / 20.0);
    CHECK_NEAR(w1, expected, 1e-9);

    std::cout << "PASS (w " << w0 << " -> " << w1 << ")" << std::endl;
}

void test_network_stdp_depression() {
    std::cout << "Test: Network STDP Depression (post before pre)... " << std::flush;

    PairNet p(0.5);
    double w0 = p.net.getSynapse(p.syn).getWeight();
    CHECK(w0 == 0.5);

    // Step 1: drive B to spike (post).
    p.net.setExternalInput(p.B, 2.0);
    p.net.step(1.0);
    CHECK(p.net.getSpikesThisStep()[p.B]);
    CHECK(!p.net.getSpikesThisStep()[p.A]);

    // Step 2: drive A to spike (pre). B does not spike this step.
    p.net.setExternalInput(p.A, 2.0);
    p.net.step(1.0);
    CHECK(p.net.getSpikesThisStep()[p.A]);
    CHECK(!p.net.getSpikesThisStep()[p.B]);

    // post->pre => LTD => weight must decrease.
    double w1 = p.net.getSynapse(p.syn).getWeight();
    CHECK(w1 < w0);
    // Expected: dw = -A_minus * x_post, x_post decayed one step from 1.
    double expected = w0 - 0.01 * std::exp(-1.0 / 20.0);
    CHECK_NEAR(w1, expected, 1e-9);

    std::cout << "PASS (w " << w0 << " -> " << w1 << ")" << std::endl;
}

void test_same_timestep_spikes() {
    std::cout << "Test: Same-timestep pre+post spikes... " << std::flush;

    // Symmetric rates: A_plus == A_minus. Both traces reach exactly 1 in the
    // same step, so dw_total = +A_plus*1 - A_minus*1 = 0 (weight unchanged).
    PairNet p(0.5);
    double w0 = p.net.getSynapse(p.syn).getWeight();

    // Drive BOTH A and B to spike in the same timestep.
    p.net.setExternalInput(p.A, 2.0);
    p.net.setExternalInput(p.B, 2.0);
    p.net.step(1.0);
    CHECK(p.net.getSpikesThisStep()[p.A]);
    CHECK(p.net.getSpikesThisStep()[p.B]);

    // Both traces should now be exactly 1.
    CHECK(p.net.getSynapse(p.syn).getPreTrace() == 1.0);
    CHECK(p.net.getSynapse(p.syn).getPostTrace() == 1.0);

    // Net change = +0.01*1 - 0.01*1 = 0.
    double w1 = p.net.getSynapse(p.syn).getWeight();
    CHECK_NEAR(w1, w0, 1e-9);

    std::cout << "PASS (w " << w0 << " -> " << w1 << ", symmetric cancellation)" << std::endl;
}

void test_same_timestep_asymmetric() {
    std::cout << "Test: Same-timestep spikes, asymmetric rates... " << std::flush;

    // A_plus = 0.02, A_minus = 0.01. Both traces = 1.
    // dw_total = +0.02*1 - 0.01*1 = +0.01.
    Network net;
    size_t A = net.addNeuron(10.0, 1.0, 20.0, 0.1, 0.0);
    size_t B = net.addNeuron(10.0, 1.0, 20.0, 0.1, 0.0);
    size_t syn = net.addSynapse(A, B, 0.5, 2.0, 0);
    net.enablePlasticity(syn, 0.02, 0.01, 20.0, 20.0, 0.0, 1.0);

    net.setExternalInput(A, 2.0);
    net.setExternalInput(B, 2.0);
    net.step(1.0);
    CHECK(net.getSpikesThisStep()[A]);
    CHECK(net.getSpikesThisStep()[B]);

    double w1 = net.getSynapse(syn).getWeight();
    CHECK_NEAR(w1, 0.5 + 0.01, 1e-9);

    std::cout << "PASS (w 0.5 -> " << w1 << ")" << std::endl;
}

void test_trace_invariants() {
    std::cout << "Test: Trace and weight invariants under repeated learning... " << std::flush;

    PairNet p(0.5);
    const Synapse& s = p.net.getSynapse(p.syn);

    // Repeatedly drive A then B, checking invariants every step.
    for (int trial = 0; trial < 20; ++trial) {
        p.net.setExternalInput(p.A, 2.0);
        p.net.step(1.0);
        CHECK(s.getPreTrace() >= 0.0);
        CHECK(s.getPostTrace() >= 0.0);
        CHECK(s.getWeight() >= 0.0);
        CHECK(s.getWeight() <= 1.0);
        CHECK(std::isfinite(s.getWeight()));

        p.net.setExternalInput(p.B, 2.0);
        p.net.step(1.0);
        CHECK(s.getPreTrace() >= 0.0);
        CHECK(s.getPostTrace() >= 0.0);
        CHECK(s.getWeight() >= 0.0);
        CHECK(s.getWeight() <= 1.0);
        CHECK(std::isfinite(s.getWeight()));
    }

    std::cout << "PASS" << std::endl;
}

void test_trace_decay_to_zero() {
    std::cout << "Test: Traces decay toward zero when spikes stop... " << std::flush;

    PairNet p(0.5);
    const Synapse& s = p.net.getSynapse(p.syn);

    // Create trace activity: A spikes.
    p.net.setExternalInput(p.A, 2.0);
    p.net.step(1.0);
    CHECK(s.getPreTrace() > 0.0);

    // Now run many steps with no input; traces must decay toward zero.
    for (int i = 0; i < 300; ++i) {
        p.net.step(1.0);
    }
    CHECK(s.getPreTrace() >= 0.0);
    CHECK(s.getPreTrace() < 1e-6);
    CHECK(s.getPostTrace() >= 0.0);
    CHECK(s.getPostTrace() < 1e-6);

    std::cout << "PASS (x_pre=" << s.getPreTrace() << ")" << std::endl;
}

void test_dt_constraint_corrected() {
    std::cout << "Test: dt constraint (Euler tau_s only, not tau_pre/tau_post)... " << std::flush;

    // tau_s = 2.0, plasticity traces with SMALL tau (0.5). dt = 1.0.
    // dt=1.0 > tau_pre=0.5, but trace decay is exact exponential, so this
    // must be ACCEPTED. Only the Euler constraint dt < tau_s applies.
    Synapse syn(0.5, 2.0);
    syn.setPlasticityParameters(0.01, 0.01, 0.5, 0.5, 0.0, 1.0);

    CHECK(syn.validateDt(1.0) == true);   // 1.0 < tau_s=2.0, valid
    CHECK(syn.validateDt(1.9) == true);   // still < tau_s
    CHECK(syn.validateDt(2.0) == false);  // == tau_s, Euler boundary
    CHECK(syn.validateDt(2.5) == false);  // > tau_s, invalid
    CHECK(syn.validateDt(0.0) == false);  // zero invalid

    // receiveSpike must not throw for dt=1.0 even though dt > tau_pre.
    bool threw = false;
    try {
        syn.receiveSpike(true, 1.0);
    } catch (...) {
        threw = true;
    }
    CHECK(threw == false);

    std::cout << "PASS" << std::endl;
}

void test_network_deterministic_learning() {
    std::cout << "Test: Network deterministic repeated training... " << std::flush;

    // Two identical networks trained identically must end with equal weights.
    auto train = [](Network& net, size_t A, size_t B) {
        for (int i = 0; i < 5; ++i) {
            net.setExternalInput(A, 2.0);
            net.step(1.0);
            net.setExternalInput(B, 2.0);
            net.step(1.0);
        }
    };

    Network n1, n2;
    size_t a1 = n1.addNeuron(10.0, 1.0, 20.0, 0.1, 0.0);
    size_t b1 = n1.addNeuron(10.0, 1.0, 20.0, 0.1, 0.0);
    size_t s1 = n1.addSynapse(a1, b1, 0.5, 2.0, 0);
    n1.enablePlasticity(s1, 0.01, 0.01, 20.0, 20.0, 0.0, 1.0);

    size_t a2 = n2.addNeuron(10.0, 1.0, 20.0, 0.1, 0.0);
    size_t b2 = n2.addNeuron(10.0, 1.0, 20.0, 0.1, 0.0);
    size_t s2 = n2.addSynapse(a2, b2, 0.5, 2.0, 0);
    n2.enablePlasticity(s2, 0.01, 0.01, 20.0, 20.0, 0.0, 1.0);

    train(n1, a1, b1);
    train(n2, a2, b2);

    CHECK(n1.getSynapse(s1).getWeight() == n2.getSynapse(s2).getWeight());
    CHECK(n1.getSynapse(s1).getWeight() > 0.5);  // learning occurred

    std::cout << "PASS (w=" << n1.getSynapse(s1).getWeight() << ")" << std::endl;
}

void test_learning_experiment_response_strength() {
    std::cout << "Test: Learning experiment (response strengthens)... " << std::flush;

    // Measure the synaptic weight before and after a training block and
    // confirm the post-synaptic response drive (w * x) increases.
    PairNet p(0.3);
    double w_before = p.net.getSynapse(p.syn).getWeight();

    // Training block: repeated pre->post pairing. Use strong input (3.0) so
    // both neurons keep spiking despite spike-frequency adaptation.
    for (int trial = 0; trial < 30; ++trial) {
        p.net.setExternalInput(p.A, 3.0);
        p.net.step(1.0);
        p.net.setExternalInput(p.B, 3.0);
        p.net.step(1.0);
    }

    double w_after = p.net.getSynapse(p.syn).getWeight();
    CHECK(w_after > w_before);
    CHECK(w_after <= 1.0);

    std::cout << "PASS (w " << w_before << " -> " << w_after << ")" << std::endl;
}

int main() {
    std::cout << "STARK-004 STDP Tests" << std::endl;
    std::cout << "====================" << std::endl;

    test_synapse_plasticity_initialization();
    test_synapse_trace_decay();
    test_synapse_ltp_unit();
    test_synapse_ltd_unit();
    test_synapse_weight_bounds();
    test_network_stdp_potentiation();
    test_network_stdp_depression();
    test_same_timestep_spikes();
    test_same_timestep_asymmetric();
    test_trace_invariants();
    test_trace_decay_to_zero();
    test_dt_constraint_corrected();
    test_network_deterministic_learning();
    test_learning_experiment_response_strength();

    std::cout << "====================" << std::endl;
    std::cout << "Total assertions: " << g_checks << std::endl;
    std::cout << "All tests passed!" << std::endl;
    return 0;
}
