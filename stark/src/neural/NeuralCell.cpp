#include "NeuralCell.h"
#include <cmath>
#include <stdexcept>
#include <limits>

NeuralCell::NeuralCell(
    double tau_m,
    double theta_0,
    double tau_a,
    double b,
    double v_reset
) :
    V_(v_reset),
    theta_(theta_0),
    tau_m_(tau_m),
    theta_0_(theta_0),
    tau_a_(tau_a),
    b_(b),
    v_reset_(v_reset),
    a_(0.0),
    spiked_(false)
{
    validateParameters();
}

void NeuralCell::validateParameters() const {
    // tau_m must be positive
    if (tau_m_ <= 0.0) {
        throw std::invalid_argument(
            "NeuralCell: tau_m must be > 0. Got tau_m=" + std::to_string(tau_m_)
        );
    }

    // theta_0 must be non-negative
    if (theta_0_ < 0.0) {
        throw std::invalid_argument(
            "NeuralCell: theta_0 must be >= 0. Got theta_0=" + std::to_string(theta_0_)
        );
    }

    // tau_a must be positive (adaptation time constant)
    if (tau_a_ <= 0.0) {
        throw std::invalid_argument(
            "NeuralCell: tau_a must be > 0. Got tau_a=" + std::to_string(tau_a_)
        );
    }

    // b must be non-negative (adaptation increment)
    if (b_ < 0.0) {
        throw std::invalid_argument(
            "NeuralCell: b must be >= 0. Got b=" + std::to_string(b_)
        );
    }

    // Check for finite values
    if (!std::isfinite(tau_m_) || !std::isfinite(theta_0_) ||
        !std::isfinite(tau_a_) || !std::isfinite(b_) ||
        !std::isfinite(v_reset_)) {
        throw std::invalid_argument(
            "NeuralCell: all parameters must be finite values."
        );
    }
}

void NeuralCell::reset() {
    V_ = v_reset_;
    theta_ = theta_0_;
    a_ = 0.0;
    spiked_ = false;
}

bool NeuralCell::update(double I, double dt) {
    // Validate input and time step
    if (!std::isfinite(I)) {
        throw std::invalid_argument(
            "NeuralCell: input I must be finite. Got I=" + std::to_string(I)
        );
    }
    if (!std::isfinite(dt)) {
        throw std::invalid_argument(
            "NeuralCell: dt must be finite. Got dt=" + std::to_string(dt)
        );
    }
    
    // Validate time step for numerical stability
    if (!validateDt(dt)) {
        throw std::invalid_argument(
            "NeuralCell: dt must be > 0 and < min(tau_m, tau_a). "
            "Got dt=" + std::to_string(dt) +
            ", tau_m=" + std::to_string(tau_m_) +
            ", tau_a=" + std::to_string(tau_a_)
        );
    }

    // Step 1: Leak membrane and add input
    // V_temp = V_{t-1} * (1 - dt/tau_m) + I * dt
    double leak_factor = 1.0 - (dt / tau_m_);
    double V_temp = V_ * leak_factor + I * dt;

    // Step 2: Determine spike using threshold from previous step
    // s_t = 1 if V_temp >= theta_{t-1}, else 0
    bool current_spike = (V_temp >= theta_);

    // Step 3: Adapt threshold based on neural activity (current spike)
    // a_temp = a_{t-1} * (1 - dt/tau_a)
    // if spike occurred: a_t = a_temp + b
    // else:               a_t = a_temp
    double adaptation_leak_factor = 1.0 - (dt / tau_a_);
    double a_temp = a_ * adaptation_leak_factor;
    
    if (current_spike) {
        a_ = a_temp + b_;
    } else {
        a_ = a_temp;
    }
    
    // Step 4: Update threshold
    // theta_t = theta_0 + a_t
    // Since a_t >= 0, we have theta_t >= theta_0
    theta_ = theta_0_ + a_;

    // Step 5: Update membrane state
    if (current_spike) {
        spiked_ = true;
        V_ = v_reset_;
    } else {
        spiked_ = false;
        V_ = V_temp;
    }

    return spiked_;
}

double NeuralCell::getV() const {
    return V_;
}

double NeuralCell::getTheta() const {
    return theta_;
}

bool NeuralCell::getSpike() const {
    return spiked_;
}

double NeuralCell::getA() const {
    return a_;
}

double NeuralCell::getVReset() const {
    return v_reset_;
}

double NeuralCell::getTauM() const {
    return tau_m_;
}

double NeuralCell::getTheta0() const {
    return theta_0_;
}

double NeuralCell::getTauA() const {
    return tau_a_;
}

double NeuralCell::getB() const {
    return b_;
}

void NeuralCell::setActiveState(double V, double a, bool spiked) {
    // Restore the full active state (STARK-006 serialization/checkpointing).
    // theta is recomputed as theta_0 + a to preserve the model invariant
    // theta == theta_0 + a. Parameters are unchanged.
    if (!std::isfinite(V) || !std::isfinite(a)) {
        throw std::invalid_argument(
            "NeuralCell: active state V and a must be finite values."
        );
    }
    if (a < 0.0) {
        throw std::invalid_argument(
            "NeuralCell: adaptation state a must be >= 0. Got a=" + std::to_string(a)
        );
    }
    V_ = V;
    a_ = a;
    spiked_ = spiked;
    theta_ = theta_0_ + a_;
}

void NeuralCell::setParameters(double tau_m, double theta_0, double tau_a, double b, double v_reset) {
    // Validate all parameters before setting
    tau_m_ = tau_m;
    theta_0_ = theta_0;
    tau_a_ = tau_a;
    b_ = b;
    v_reset_ = v_reset;
    
    validateParameters();
    
    // Reset state to initial values
    V_ = v_reset;
    theta_ = theta_0;
    a_ = 0.0;
    spiked_ = false;
}

bool NeuralCell::validateDt(double dt) const {
    // For explicit Euler integration of both membrane and adaptation,
    // we require dt < tau_m AND dt < tau_a to ensure both leak factors
    // (1 - dt/tau_m) and (1 - dt/tau_a) remain positive.
    // This prevents unbounded growth of V and ensures a >= 0.
    if (dt <= 0.0) return false;
    if (tau_m_ <= 0.0) return false;
    if (tau_a_ <= 0.0) return false;
    return (dt < tau_m_) && (dt < tau_a_);
}