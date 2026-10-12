#pragma once

/**
 * STARK-001: Leaky Integrator with Adaptive Threshold Neuron
 * 
 * Mathematical model with activity-dependent adaptation:
 * 
 * Step 1: Leak membrane and add input
 *   V_temp = V_{t-1} * (1 - dt/tau_m) + I_t * dt
 * 
 * Step 2: Determine spike using threshold from previous step
 *   s_t = 1 if V_temp >= theta_{t-1}
 *         0 otherwise
 * 
 * Step 3: Adapt threshold based on neural activity
 *   a_temp = a_{t-1} * (1 - dt/tau_a)
 *   if s_t = 1: a_t = a_temp + b
 *   else:        a_t = a_temp
 * 
 * Step 4: Update threshold
 *   theta_t = theta_0 + a_t
 * 
 * Step 5: Update membrane state
 *   if s_t = 1: V_t = v_reset
 *   else:        V_t = V_temp
 * 
 * Invariants:
 *   a_t >= 0
 *   theta_t >= theta_0
 */

class NeuralCell {
public:
    /**
     * Construct a neural cell with specified parameters.
     * 
     * @param tau_m Membrane time constant (tau_m > 0). Determines how fast V leaks.
     *              Larger tau_m = slower leak = longer memory. Default: 1.0
     * @param theta_0 Baseline threshold (theta_0 >= 0). Theta is always >= theta_0.
     *                 The adaptive component a_t >= 0 pushes theta above this baseline.
     *                 Default: 1.0
     * @param tau_a Adaptation time constant (tau_a > 0). Determines how fast the
     *              adaptation state a_t decays when no spikes occur. Larger tau_a =
     *              slower decay = adaptation persists longer. Default: 10.0
     * @param b Adaptation increment (b >= 0). How much the adaptation state a_t
     *          increases when the neuron fires. Larger b = stronger adaptation = 
     *          stronger post-spike refractoriness. Default: 0.5
     * @param v_reset Reset potential after spike (typically negative). Neuron must
     *                re-depolarize before spiking again. Default: -0.5
     */
    NeuralCell(
        double tau_m = 1.0,
        double theta_0 = 1.0,
        double tau_a = 10.0,
        double b = 0.5,
        double v_reset = -0.5
    );

    /// Default destructor
    ~NeuralCell() = default;

    /**
     * Reset the neural cell to its initial state.
     * 
     * Returns V, a, and theta to their initial values.
     * Does not change parameters.
     */
    void reset();

    /**
     * Update the neural cell with a new input.
     * 
     * Performs the 5-step update:
     *   1. Leak membrane and add input:
 *          V_temp = V * (1 - dt/tau_m) + I * dt
     *   2. Determine spike using previous threshold:
 *          s_t = 1 if V_temp >= theta, else 0
     *   3. Adapt threshold based on neural activity:
 *          a_temp = a * (1 - dt/tau_a)
 *          a = a_temp + b if s_t = 1, else a = a_temp
     *   4. Update threshold:
 *          theta = theta_0 + a
     *   5. Update membrane state:
 *          V = v_reset if s_t = 1, else V = V_temp
     * 
     * @param I Input current I_t at this time step (must be finite)
     * @param dt Time step size dt. Must satisfy 0 < dt < min(tau_m, tau_a)
     * @return true if the neuron spiked (fired) this step, false otherwise
     * @throws std::invalid_argument if parameters are invalid, dt is invalid,
     *         or I/dt are not finite
     */
    bool update(double I, double dt);

    /// Get the current membrane potential V_t
    double getV() const;

    /// Get the current adaptive threshold theta_t
    double getTheta() const;

    /// Get the spike indicator s_t from the last update
    bool getSpike() const;

    /// Get the current adaptation state a_t (STARK-006 observability/serialization)
    double getA() const;

    /// Get the reset potential v_reset
    double getVReset() const;

    /// Get the membrane time constant tau_m
    double getTauM() const;

    /// Get the baseline threshold theta_0
    double getTheta0() const;

    /// Get the adaptation time constant tau_a
    double getTauA() const;

    /// Get the adaptation increment b
    double getB() const;

    /**
     * Restore the full active state (STARK-006 serialization).
     * Sets V, a and the spike indicator. theta is recomputed as theta_0 + a to
     * preserve the model invariant theta == theta_0 + a. Does not change parameters.
     * @throws std::invalid_argument if V or a are not finite
     */
    void setActiveState(double V, double a, bool spiked);

    /// Set all parameters at once
    void setParameters(double tau_m, double theta_0, double tau_a, double b, double v_reset);

    /**
     * Validate that time step dt is numerically stable for this neuron.
     * Requires 0 < dt < min(tau_m, tau_a).
     * Exposed as public for Network-level validation (STARK-003).
     */
    bool validateDt(double dt) const;

private:
    double V_;          ///< Membrane potential V_t
    double theta_;      ///< Adaptive threshold theta_t = theta_0 + a_t
    double tau_m_;      ///< Membrane time constant
    double theta_0_;    ///< Baseline threshold (theta >= theta_0 always)
    double tau_a_;      ///< Adaptation time constant
    double b_;          ///< Adaptation increment per spike
    double v_reset_;    ///< Reset potential after spike
    bool spiked_;       ///< Spike indicator s_t from last update
    double a_;          ///< Adaptation state a_t >= 0

    /// Validate all parameters are in valid ranges
    void validateParameters() const;
};