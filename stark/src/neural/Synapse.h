#pragma once

/**
 * STARK-004: Synapse with Spike-Timing-Dependent Plasticity (STDP)
 * STARK-006: Three-factor modulator-gated plasticity (eligibility trace)
 *
 * Mathematical model:
 *
 * State: x_t (synaptic efficacy/state), x_pre (pre-synaptic trace), x_post (post-synaptic trace)
 *        e (STARK-006 eligibility trace)
 *
 * Update per timestep:
 *   x_t = x_{t-1} * (1 - dt/tau_s) + s_pre
 *   x_pre = x_pre * exp(-dt/tau_pre) + s_pre
 *   x_post = x_post * exp(-dt/tau_post)
 *   e = e * exp(-dt/tau_e)                      [STARK-006, THREEFACTOR mode only]
 *
 * Output current to post-synaptic neuron:
 *   I_post = w * x_t
 *
 * STDP weight update (pair-based trace model, STARK-004):
 *   When a PRE-synaptic spike occurs:
 *       x_pre += 1
 *       Δw_LTD = -A_- * x_post      (depression, uses post trace)
 *   When a POST-synaptic spike occurs:
 *       x_post += 1
 *       Δw_LTP = +A_+ * x_pre       (potentiation, uses pre trace)
 *   w = clamp(w + Δw, w_min, w_max)
 *
 * Three-factor eligibility credit (STARK-006):
 *   When a POST-synaptic spike occurs:  e += E_plus  * x_pre
 *   When a PRE-synaptic spike occurs:   e += -E_minus * x_post
 *   dw = eta_3f * m(t) * e
 *   w = clamp(w + dw, w_min, w_max)
 *
 * Therefore:
 *   pre → post  (pre fires, then post fires)  => LTP (w increases)
 *   post → pre  (post fires, then pre fires)  => LTD (w decreases)
 *
 * Where:
 *   - s_pre ∈ {0, 1} is the pre-synaptic spike
 *   - w ∈ R is the synaptic weight (positive = excitatory, negative = inhibitory)
 *   - tau_s > 0 is the synaptic time constant
 *   - tau_pre > 0 is the pre-synaptic trace time constant
 *   - tau_post > 0 is the post-synaptic trace time constant
 *   - A_+ >= 0 is the LTP learning rate
 *   - A_- >= 0 is the LTD learning rate
 *   - dt is the simulation time step. The ONLY timestep constraint is the
 *     Euler constraint 0 < dt < tau_s (for the synaptic state x_t). The
 *     plasticity traces use exact exponential decay and are stable for any
 *     dt > 0, so no upper bound on dt is imposed by tau_pre / tau_post.
 *
 * Invariants:
 *   - x_t >= 0 for all t (since x_0 = 0, leak factor > 0, s_pre >= 0)
 *   - x_pre >= 0, x_post >= 0 (exact exponential decay preserves sign)
 *   - w_min <= w <= w_max
 *   - I_post sign is determined by w
 *
 * Plasticity modes (mutually exclusive per synapse):
 *   - STDP: two-factor, immediate weight update (STARK-004 behavior)
 *   - THREEFACTOR: three-factor, deferred weight update via eligibility trace (STARK-006)
 *   - NONE: no plasticity
 */

#include <cmath>
#include <stdexcept>
#include <limits>
#include <algorithm>

/// Learning mode for a synapse (STARK-006)
enum class PlasticityMode {
    NONE,         ///< No plasticity (STARK-002 default for inactive synapses)
    STDP,         ///< Two-factor STDP (STARK-004 behavior)
    THREEFACTOR   ///< Three-factor modulator-gated with eligibility (STARK-006)
};

class Synapse {
public:
    /**
     * Construct a synapse with specified weight and time constant.
     *
     * @param weight Synaptic weight w (can be positive or negative).
     *               w > 0: excitatory (depolarizing)
     *               w < 0: inhibitory (hyperpolarizing)
     *               w = 0: no effect
     * @param tau_s Synaptic time constant (tau_s > 0). Determines how fast
     *              the synaptic state decays. Larger tau_s = slower decay =
     *              longer temporal integration window. Default: 2.0
     *
     * Default weight bounds are chosen from the sign of the initial weight so
     * that homeostatic scaling (STARK-005) never flips polarity:
     *   weight > 0  ->  bounds [0, +max]
     *   weight < 0  ->  bounds [-max, 0]
     *   weight = 0  ->  bounds [-max, +max]
     * where max = max(1, |weight|). These defaults are overridden by
     * setPlasticityParameters() when STDP is enabled.
     */
    Synapse(double weight, double tau_s = 2.0);

    /// Default destructor
    ~Synapse() = default;

    /**
     * Reset the synapse to its initial state.
     *
     * Sets synaptic state x = 0, and resets pre- and post-synaptic traces.
     * Also resets the STARK-006 eligibility trace e to 0.
     * Does not change parameters.
     */
    void reset();

    /**
     * Receive a pre-synaptic spike and compute post-synaptic current.
     *
     * Performs the synaptic state update:
     *   x_temp = x * (1 - dt/tau_s)
     *   x = x_temp + s_pre  (where s_pre = 1 if pre_spike, else 0)
     *   I_post = w * x
     *
     * Also increments the pre-synaptic trace on a spike:
     *   x_pre += 1  (when pre_spike is true)
     * Note: trace decay is handled separately by decayTraces().
     *
     * @param pre_spike true if pre-synaptic neuron spiked this timestep
     * @param dt Time step size. Must satisfy 0 < dt < tau_s (Euler constraint)
     * @return Post-synaptic current I_post = w * x_t
     * @throws std::invalid_argument if dt is invalid
     */
    double receiveSpike(bool pre_spike, double dt);

    /// Get the current synaptic state x_t
    double getState() const;

    /// Get the synaptic weight w
    double getWeight() const;

    /// Get the minimum weight bound (STARK-005 diagnostics)
    double getWeightMin() const;

    /// Get the maximum weight bound (STARK-005 diagnostics)
    double getWeightMax() const;

    /// Set the synaptic weight
    void setWeight(double weight);

    /// Get the synaptic time constant tau_s
    double getTauS() const;

    /// Get the pre-synaptic trace x_pre
    double getPreTrace() const;

    /// Get the post-synaptic trace x_post
    double getPostTrace() const;

    /// Get the LTP learning rate A_plus (STARK-006 serialization)
    double getAPlus() const;

    /// Get the LTD learning rate A_minus (STARK-006 serialization)
    double getAMinus() const;

    /// Get the pre-synaptic trace time constant tau_pre (STARK-006 serialization)
    double getTauPre() const;

    /// Get the post-synaptic trace time constant tau_post (STARK-006 serialization)
    double getTauPost() const;

    /// Get whether plasticity (STDP) is enabled (STARK-006 serialization)
    bool getPlasticityEnabled() const;

    /**
     * Transactionally restore the FULL synapse state (STARK-006 serialization).
     *
     * Validates ALL supplied values BEFORE committing, so a failed call leaves
     * the synapse unchanged. If plasticity is enabled (true), the plasticity
     * parameters and bounds are validated; otherwise the plasticity fields are
     * recorded but marked not-enabled. The weight is clamped into [w_min,w_max].
     *
     * @throws std::invalid_argument if any value is invalid
     */
    void setFullState(double x, double w, double x_pre, double x_post,
                      double A_plus, double A_minus,
                      double tau_pre, double tau_post,
                      double w_min, double w_max, bool plasticity_enabled);

    /**
     * Transactionally restore the FULL synapse state including three-factor state (STARK-006).
     *
     * Validates ALL supplied values BEFORE committing, so a failed call leaves
     * the synapse unchanged.
     *
     * @throws std::invalid_argument if any value is invalid
     */
    void setFullState(double x, double w, double x_pre, double x_post,
                      double A_plus, double A_minus,
                      double tau_pre, double tau_post,
                      double w_min, double w_max, bool plasticity_enabled,
                      double e, double e_plus, double e_minus,
                      double tau_e, double eta_3f, bool three_factor_enabled,
                      PlasticityMode mode);

    /**
     * Set plasticity parameters for STDP.
     *
     * @param A_plus LTP learning rate (A_+ > 0)
     * @param A_minus LTD learning rate (A_- > 0)
     * @param tau_pre Pre-synaptic trace time constant (tau_pre > 0)
     * @param tau_post Post-synaptic trace time constant (tau_post > 0)
     * @param w_min Minimum weight bound (w_min <= w)
     * @param w_max Maximum weight bound (w_max >= w)
     * @throws std::invalid_argument if parameters are invalid
     */
    void setPlasticityParameters(double A_plus, double A_minus, double tau_pre, double tau_post, double w_min, double w_max);

    /**
     * Update the post-synaptic trace on a post-synaptic spike.
     *
     * Performs:
     *   x_post += 1
     *
     * This should be called when the post-synaptic neuron spikes.
     */
    void updatePostTrace();

    /**
     * Apply LTP (Long-Term Potentiation) when post-synaptic neuron spikes.
     *
     * Δw = A_+ * x_pre
     *
     * This strengthens the synapse based on recent pre-synaptic activity.
     * The weight is clamped to [w_min, w_max].
     */
    void applyLTP();

    /**
     * Apply LTD (Long-Term Depression) when pre-synaptic neuron spikes.
     *
     * Δw = -A_- * x_post
     *
     * This weakens the synapse based on recent post-synaptic activity.
     * The weight is clamped to [w_min, w_max].
     */
    void applyLTD();

    /**
     * Decay pre- and post-synaptic traces using EXACT exponential decay.
     *
     * Performs:
     *   x_pre = x_pre * exp(-dt/tau_pre)
     *   x_post = x_post * exp(-dt/tau_post)
     *
     * Because this is exact exponential decay (not Euler), it is stable and
     * preserves non-negativity for any dt > 0. No upper bound on dt is
     * required by the trace equations.
     *
     * @param dt Time step size. Must be > 0.
     */
    void decayTraces(double dt);

    /**
     * Validate that time step dt is numerically valid for this synapse.
     *
     * The ONLY constraint is the Euler constraint from the synaptic state:
     *   0 < dt < tau_s
     * The plasticity traces use exact exponential decay and impose no upper
     * bound on dt (only dt > 0, which is already required by tau_s).
     *
     * Exposed as public for Network-level validation (STARK-003).
     */
    bool validateDt(double dt) const;

    /**
     * Scale the synaptic weight multiplicatively (STARK-005 homeostasis).
     *
     * This is the preferred method for homeostatic plasticity as it preserves
     * relative weight ratios and sign. The weight is multiplied by the given
     * factor (which must be > 0 and finite) and then clamped to [w_min, w_max].
     *
     * @param factor Multiplicative scaling factor (must be > 0 and finite)
     * @throws std::invalid_argument if factor is not finite or <= 0
     */
    void scaleWeight(double factor);

    // ============================================================
    // STARK-006: Three-factor modulator-gated plasticity
    // ============================================================

    /**
     * Get the current three-factor learning mode of this synapse.
     */
    PlasticityMode getPlasticityMode() const { return mode_; }

    /**
     * Enable three-factor modulator-gated plasticity (STARK-006).
     *
     * Switches this synapse into THREEFACTOR mode. In this mode the synapse
     * maintains an eligibility trace and receives modulator-gated weight updates
     * via applyThreeFactor(). The immediate STDP weight update (applyLTP/applyLTD)
     * is suppressed for this synapse.
     *
     * Weight bounds must be explicitly provided and must contain the current weight.
     *
     * @param E_plus Eligibility potentiation amplitude (>= 0)
     * @param E_minus Eligibility depression amplitude (>= 0)
     * @param tau_e Eligibility time constant (seconds, > 0)
     * @param eta_3f Three-factor learning rate (dimensionless, > 0)
     * @param w_min Minimum weight bound (w_min <= current weight)
     * @param w_max Maximum weight bound (w_max >= current weight)
     * @throws std::invalid_argument if parameters are invalid
     */
    void enableThreeFactor(double E_plus, double E_minus, double tau_e,
                          double eta_3f, double w_min, double w_max);

    /**
     * Decay the eligibility trace using exact exponential decay.
     *
     *   e <- e * exp(-dt / tau_e)
     *
     * Stable for any dt > 0 (exact exponential).
     *
     * @param dt Time step size. Must be > 0.
     */
    void decayEligibility(double dt);

    /**
     * Accumulate signed eligibility credit from pre/post spike pairing.
     *
     *   if post spiked:  e += E_plus  * x_pre
     *   if pre  spiked:  e -= E_minus * x_post
     *
     * Uses the post-increment trace values (same values STARK-004 STDP uses).
     * Order: post contribution first, then pre contribution (deterministic).
     *
     * @param pre_spiked Whether the pre-synaptic neuron spiked this timestep
     * @param post_spiked Whether the post-synaptic neuron spiked this timestep
     */
    void accumulateEligibility(bool pre_spiked, bool post_spiked);

    /**
     * Apply the modulator-gated three-factor weight update.
     *
     *   dw = eta_3f * m * e
     *   w  <- clamp(w + dw, w_min, w_max)
     *
     * Only operates on THREEFACTOR-mode synapses.
     * Non-finite modulator (NaN/Inf) is rejected.
     *
     * @param m The modulatory signal (dimensionless, finite)
     * @throws std::invalid_argument if m is not finite, or synapse not in THREEFACTOR mode
     */
    void applyThreeFactor(double m);

    /**
     * Get the current eligibility trace value (STARK-006 diagnostics).
     */
    double getEligibility() const { return e_; }

    /**
     * Get the eligibility time constant tau_e (STARK-006).
     */
    double getTauE() const { return tau_e_; }

    /**
     * Get the three-factor learning rate eta_3f (STARK-006).
     */
    double getEta3f() const { return eta_3f_; }

    /**
     * Get the eligibility potentiation amplitude E_plus (STARK-006).
     */
    double getEPlus() const { return E_plus_; }

    /**
     * Get the eligibility depression amplitude E_minus (STARK-006).
     */
    double getEMinus() const { return E_minus_; }

    /**
     * Get whether three-factor mode is enabled (STARK-006).
     */
    bool getThreeFactorEnabled() const { return three_factor_enabled_; }

    /**
     * Transactionally restore the full three-factor state of this synapse (STARK-006 serialization).
     *
     * Validates ALL supplied values BEFORE committing, so a failed call leaves
     * the synapse unchanged.
     *
     * @throws std::invalid_argument if any value is invalid
     */
    void setThreeFactorState(double e, double e_plus, double e_minus,
                         double tau_e, double eta_3f, bool enabled,
                         PlasticityMode mode);

private:
    // Synaptic state
    double x_;           ///< Synaptic state x_t >= 0
    double tau_s_;       ///< Synaptic time constant > 0
    double w_;           ///< Synaptic weight (can be negative)

    // Plasticity state
    double x_pre_;       ///< Pre-synaptic trace >= 0
    double x_post_;      ///< Post-synaptic trace >= 0
    double A_plus_;      ///< LTP learning rate > 0
    double A_minus_;     ///< LTD learning rate > 0
    double tau_pre_;     ///< Pre-synaptic trace time constant > 0
    double tau_post_;    ///< Post-synaptic trace time constant > 0
    double w_min_;       ///< Minimum weight bound
    double w_max_;       ///< Maximum weight bound
    bool plasticity_enabled_; ///< Whether plasticity is enabled

    // Three-factor learning (STARK-006)
    PlasticityMode mode_; ///< Current plasticity mode (STARK-006)

    // Three-factor parameters (STARK-006)
    double e_;            ///< Eligibility trace (signed)
    double tau_e_;        ///< Eligibility time constant (seconds, > 0)
    double E_plus_;       ///< Eligibility potentiation credit (dimensionless, >= 0)
    double E_minus_;      ///< Eligibility depression credit (dimensionless, >= 0)
    double eta_3f_;       ///< Three-factor learning rate (dimensionless, > 0)
    bool three_factor_enabled_; ///< Whether three-factor mode is configured

    /// Validate all parameters are in valid ranges
    void validateParameters() const;

    /// Validate plasticity parameters
    void validatePlasticityParameters() const;

    /// Validate three-factor parameters
    void validateThreeFactorParameters() const;

    /// Clamp weight to [w_min, w_max]
    void clampWeight();

    /// Derive sign-appropriate default bounds from current weight value
    void applyDefaultBoundsFromWeight(double weight);
};
