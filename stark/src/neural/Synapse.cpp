#include "Synapse.h"
#include <cmath>
#include <stdexcept>
#include <limits>
#include <algorithm>
#include <cerrno>
#include <cstring>

Synapse::Synapse(double weight, double tau_s) :
    x_(0.0),
    tau_s_(tau_s),
    w_(weight),
    x_pre_(0.0),
    x_post_(0.0),
    A_plus_(0.0),
    A_minus_(0.0),
    tau_pre_(1.0),
    tau_post_(1.0),
    w_min_(0.0),
    w_max_(1.0),
    plasticity_enabled_(false),
    mode_(PlasticityMode::NONE),
    e_(0.0),
    tau_e_(1.0),
    E_plus_(0.0),
    E_minus_(0.0),
    eta_3f_(0.0),
    three_factor_enabled_(false)
{
    // STARK-005: Set sign-appropriate default weight bounds so that
    // homeostatic scaling (which always clamps) never destroys inhibitory
    // synapses. Excitatory weights are bounded in [0, +max], inhibitory in
    // [-max, 0], and a zero weight is allowed to move in either direction.
    // These defaults are overridden by setPlasticityParameters() when STDP is
    // enabled, so STARK-002/003/004 semantics are unchanged.
    applyDefaultBoundsFromWeight(weight);

    validateParameters();
}

void Synapse::applyDefaultBoundsFromWeight(double weight) {
    double bound_mag = std::max(1.0, std::abs(weight));
    if (weight > 0.0) {
        w_min_ = 0.0;
        w_max_ = bound_mag;
    } else if (weight < 0.0) {
        w_min_ = -bound_mag;
        w_max_ = 0.0;
    } else {
        // Zero weight: permit either polarity by default.
        w_min_ = -bound_mag;
        w_max_ = bound_mag;
    }
}

void Synapse::validateParameters() const {
    if (tau_s_ <= 0.0) {
        throw std::invalid_argument(
            "Synapse: tau_s must be > 0. Got tau_s=" + std::to_string(tau_s_)
        );
    }

    if (!std::isfinite(w_)) {
        throw std::invalid_argument(
            "Synapse: weight must be finite. Got weight=" + std::to_string(w_)
        );
    }

    if (!std::isfinite(tau_s_)) {
        throw std::invalid_argument(
            "Synapse: tau_s must be finite. Got tau_s=" + std::to_string(tau_s_)
        );
    }
}

void Synapse::validatePlasticityParameters() const {
    if (plasticity_enabled_) {
        if (A_plus_ < 0.0) {
            throw std::invalid_argument(
                "Synapse: A_plus must be >= 0. Got A_plus=" + std::to_string(A_plus_)
            );
        }
        if (A_minus_ < 0.0) {
            throw std::invalid_argument(
                "Synapse: A_minus must be >= 0. Got A_minus=" + std::to_string(A_minus_)
            );
        }

        if (tau_pre_ <= 0.0) {
            throw std::invalid_argument(
                "Synapse: tau_pre must be > 0. Got tau_pre=" + std::to_string(tau_pre_)
            );
        }
        if (tau_post_ <= 0.0) {
            throw std::invalid_argument(
                "Synapse: tau_post must be > 0. Got tau_post=" + std::to_string(tau_post_)
            );
        }

        if (!std::isfinite(tau_pre_)) {
            throw std::invalid_argument(
                "Synapse: tau_pre must be finite. Got tau_pre=" + std::to_string(tau_pre_)
            );
        }
        if (!std::isfinite(tau_post_)) {
            throw std::invalid_argument(
                "Synapse: tau_post must be finite. Got tau_post=" + std::to_string(tau_post_)
            );
        }

        if (w_min_ > w_max_) {
            throw std::invalid_argument(
                "Synapse: w_min must be <= w_max. Got w_min=" + std::to_string(w_min_) +
                ", w_max=" + std::to_string(w_max_)
            );
        }
        if (!std::isfinite(w_min_)) {
            throw std::invalid_argument(
                "Synapse: w_min must be finite. Got w_min=" + std::to_string(w_min_)
            );
        }
        if (!std::isfinite(w_max_)) {
            throw std::invalid_argument(
                "Synapse: w_max must be finite. Got w_max=" + std::to_string(w_max_)
            );
        }
    }
}

void Synapse::validateThreeFactorParameters() const {
    if (three_factor_enabled_) {
        if (E_plus_ < 0.0) {
            throw std::invalid_argument(
                "Synapse: E_plus must be >= 0. Got E_plus=" + std::to_string(E_plus_)
            );
        }
        if (E_minus_ < 0.0) {
            throw std::invalid_argument(
                "Synapse: E_minus must be >= 0. Got E_minus=" + std::to_string(E_minus_)
            );
        }
        if (tau_e_ <= 0.0) {
            throw std::invalid_argument(
                "Synapse: tau_e must be > 0. Got tau_e=" + std::to_string(tau_e_)
            );
        }
        if (eta_3f_ <= 0.0) {
            throw std::invalid_argument(
                "Synapse: eta_3f must be > 0. Got eta_3f=" + std::to_string(eta_3f_)
            );
        }
        if (!std::isfinite(E_plus_) || !std::isfinite(E_minus_) ||
            !std::isfinite(tau_e_) || !std::isfinite(eta_3f_) || !std::isfinite(e_)) {
            throw std::invalid_argument(
                "Synapse: three-factor parameters must be finite"
            );
        }
    }
}

void Synapse::reset() {
    x_ = 0.0;
    x_pre_ = 0.0;
    x_post_ = 0.0;
    e_ = 0.0;
}

double Synapse::receiveSpike(bool pre_spike, double dt) {
    if (!std::isfinite(dt)) {
        throw std::invalid_argument(
            "Synapse: dt must be finite. Got dt=" + std::to_string(dt)
        );
    }

    if (!validateDt(dt)) {
        throw std::invalid_argument(
            "Synapse: dt must be finite and satisfy 0 < dt < tau_s "
            "(Euler constraint for synaptic state). "
            "Got dt=" + std::to_string(dt) +
            ", tau_s=" + std::to_string(tau_s_)
        );
    }

    double leak_factor = 1.0 - (dt / tau_s_);
    double x_temp = x_ * leak_factor;

    if (pre_spike) {
        x_ = x_temp + 1.0;
        x_pre_ += 1.0;
    } else {
        x_ = x_temp;
    }

    return w_ * x_;
}

double Synapse::getState() const {
    return x_;
}

double Synapse::getWeight() const {
    return w_;
}

double Synapse::getWeightMin() const {
    return w_min_;
}

double Synapse::getWeightMax() const {
    return w_max_;
}

void Synapse::setWeight(double weight) {
    if (!std::isfinite(weight)) {
        throw std::invalid_argument(
            "Synapse: weight must be finite. Got weight=" + std::to_string(weight)
        );
    }
    w_ = weight;
    // Update bounds to remain sign-appropriate for the new weight so that
    // future homeostatic scaling preserves polarity.
    applyDefaultBoundsFromWeight(weight);
    // Then clamp into the new bounds.
    if (w_ < w_min_) w_ = w_min_;
    if (w_ > w_max_) w_ = w_max_;
}

double Synapse::getTauS() const {
    return tau_s_;
}

double Synapse::getPreTrace() const {
    return x_pre_;
}

double Synapse::getPostTrace() const {
    return x_post_;
}

double Synapse::getAPlus() const {
    return A_plus_;
}

double Synapse::getAMinus() const {
    return A_minus_;
}

double Synapse::getTauPre() const {
    return tau_pre_;
}

double Synapse::getTauPost() const {
    return tau_post_;
}

bool Synapse::getPlasticityEnabled() const {
    return plasticity_enabled_;
}

void Synapse::setFullState(double x, double w, double x_pre, double x_post,
                           double A_plus, double A_minus,
                           double tau_pre, double tau_post,
                           double w_min, double w_max, bool plasticity_enabled) {
    // Delegate to the extended version with default three-factor fields.
    // This preserves the original 11-parameter API for backward compatibility
    // while routing through the validated atomic restore.
    setFullState(x, w, x_pre, x_post,
                 A_plus, A_minus, tau_pre, tau_post,
                 w_min, w_max, plasticity_enabled,
                 0.0, 0.0, 0.0, 1.0, 0.0, false,
                 plasticity_enabled ? PlasticityMode::STDP : PlasticityMode::NONE);
}

void Synapse::setFullState(double x, double w, double x_pre, double x_post,
                           double A_plus, double A_minus,
                           double tau_pre, double tau_post,
                           double w_min, double w_max, bool plasticity_enabled,
                           double e, double e_plus, double e_minus,
                           double tau_e, double eta_3f, bool three_factor_enabled,
                           PlasticityMode mode) {
    // Transactional restore: validate ALL inputs BEFORE committing so a failed
    // call leaves the synapse unchanged (STARK-006 serialization requirement).
    if (!std::isfinite(x) || !std::isfinite(x_pre) || !std::isfinite(x_post)) {
        throw std::invalid_argument(
            "Synapse::setFullState: x, x_pre, x_post must be finite"
        );
    }
    if (x < 0.0 || x_pre < 0.0 || x_post < 0.0) {
        throw std::invalid_argument(
            "Synapse::setFullState: x, x_pre, x_post must be >= 0"
        );
    }
    if (!std::isfinite(w)) {
        throw std::invalid_argument(
            "Synapse::setFullState: weight must be finite"
        );
    }
    if (!std::isfinite(w_min) || !std::isfinite(w_max)) {
        throw std::invalid_argument(
            "Synapse::setFullState: w_min and w_max must be finite"
        );
    }
    if (w_min > w_max) {
        throw std::invalid_argument(
            "Synapse::setFullState: w_min must be <= w_max"
        );
    }

    if (plasticity_enabled) {
        if (A_plus < 0.0 || A_minus < 0.0) {
            throw std::invalid_argument(
                "Synapse::setFullState: A_plus and A_minus must be >= 0 when plasticity enabled"
            );
        }
        if (!std::isfinite(A_plus) || !std::isfinite(A_minus)) {
            throw std::invalid_argument(
                "Synapse::setFullState: A_plus and A_minus must be finite when plasticity enabled"
            );
        }
        if (tau_pre <= 0.0 || tau_post <= 0.0) {
            throw std::invalid_argument(
                "Synapse::setFullState: tau_pre and tau_post must be > 0 when plasticity enabled"
            );
        }
        if (!std::isfinite(tau_pre) || !std::isfinite(tau_post)) {
            throw std::invalid_argument(
                "Synapse::setFullState: tau_pre and tau_post must be finite when plasticity enabled"
            );
        }
    }

    // Validate three-factor state
    if (!std::isfinite(e)) {
        throw std::invalid_argument("Synapse::setFullState: eligibility must be finite");
    }
    if (three_factor_enabled) {
        if (e_plus < 0.0 || e_minus < 0.0) {
            throw std::invalid_argument(
                "Synapse::setFullState: E_plus and E_minus must be >= 0 when three-factor enabled"
            );
        }
        if (!std::isfinite(e_plus) || !std::isfinite(e_minus)) {
            throw std::invalid_argument(
                "Synapse::setFullState: E_plus and E_minus must be finite when three-factor enabled"
            );
        }
        if (tau_e <= 0.0) {
            throw std::invalid_argument(
                "Synapse::setFullState: tau_e must be > 0 when three-factor enabled"
            );
        }
        if (!std::isfinite(tau_e)) {
            throw std::invalid_argument(
                "Synapse::setFullState: tau_e must be finite when three-factor enabled"
            );
        }
        if (eta_3f <= 0.0) {
            throw std::invalid_argument(
                "Synapse::setFullState: eta_3f must be > 0 when three-factor enabled"
            );
        }
        if (!std::isfinite(eta_3f)) {
            throw std::invalid_argument(
                "Synapse::setFullState: eta_3f must be finite when three-factor enabled"
            );
        }
    }

    // All validation passed: commit atomically.
    x_ = x;
    w_ = w;
    x_pre_ = x_pre;
    x_post_ = x_post;
    A_plus_ = A_plus;
    A_minus_ = A_minus;
    tau_pre_ = tau_pre;
    tau_post_ = tau_post;
    w_min_ = w_min;
    w_max_ = w_max;
    plasticity_enabled_ = plasticity_enabled;

    // Three-factor state
    e_ = e;
    E_plus_ = e_plus;
    E_minus_ = e_minus;
    tau_e_ = tau_e;
    eta_3f_ = eta_3f;
    three_factor_enabled_ = three_factor_enabled;
    mode_ = mode;

    // Clamp the weight into the restored bounds.
    if (w_ < w_min_) w_ = w_min_;
    if (w_ > w_max_) w_ = w_max_;
}

void Synapse::setPlasticityParameters(double A_plus, double A_minus, double tau_pre, double tau_post, double w_min, double w_max) {
    A_plus_ = A_plus;
    A_minus_ = A_minus;
    tau_pre_ = tau_pre;
    tau_post_ = tau_post;
    w_min_ = w_min;
    w_max_ = w_max;

    plasticity_enabled_ = true;
    mode_ = PlasticityMode::STDP;

    validatePlasticityParameters();
    clampWeight();
}

void Synapse::updatePostTrace() {
    if (plasticity_enabled_) {
        x_post_ += 1.0;
    }
}

void Synapse::applyLTP() {
    if (!plasticity_enabled_) return;
    // In THREEFACTOR mode, the immediate STDP weight update is suppressed.
    // Credit is accumulated into the eligibility trace instead (applyThreeFactor).
    if (mode_ == PlasticityMode::THREEFACTOR) return;

    double delta_w = A_plus_ * x_pre_;
    w_ += delta_w;
    clampWeight();
}

void Synapse::applyLTD() {
    if (!plasticity_enabled_) return;
    // In THREEFACTOR mode, the immediate STDP weight update is suppressed.
    if (mode_ == PlasticityMode::THREEFACTOR) return;

    double delta_w = -A_minus_ * x_post_;
    w_ += delta_w;
    clampWeight();
}

void Synapse::decayTraces(double dt) {
    if (!plasticity_enabled_) return;

    x_pre_ *= std::exp(-dt / tau_pre_);
    x_post_ *= std::exp(-dt / tau_post_);
}

void Synapse::clampWeight() {
    // Always clamp to bounds, even when plasticity is disabled.
    // This is required so that setWeight() and scaleWeight() always
    // respect the sign-appropriate bounds set at construction.
    if (w_ < w_min_) w_ = w_min_;
    if (w_ > w_max_) w_ = w_max_;
}

bool Synapse::validateDt(double dt) const {
    if (dt <= 0.0) return false;
    if (!std::isfinite(dt)) return false;
    if (tau_s_ <= 0.0) return false;
    if (dt >= tau_s_) return false;

    return true;
}

void Synapse::scaleWeight(double factor) {
    // Multiplicative homeostatic weight scaling (STARK-005)
    // Multiply weight by factor and clamp to [w_min, w_max].
    // This preserves sign and relative weight ratios (unless clamping occurs).
    if (!std::isfinite(factor)) {
        throw std::invalid_argument(
            "Synapse: scale factor must be finite. Got factor=" + std::to_string(factor)
        );
    }
    if (factor <= 0.0) {
        throw std::invalid_argument(
            "Synapse: scale factor must be > 0. Got factor=" + std::to_string(factor)
        );
    }

    w_ *= factor;

    // Clamp to bounds - this always applies (even when plasticity is disabled)
    // because homeostatic scaling must respect bounds.
    if (w_ < w_min_) w_ = w_min_;
    if (w_ > w_max_) w_ = w_max_;
}

// ============================================================
// STARK-006: Three-factor modulator-gated plasticity
// ============================================================

void Synapse::enableThreeFactor(double E_plus, double E_minus, double tau_e,
                                double eta_3f, double w_min, double w_max) {
    // Transactional: validate everything before committing.
    if (E_plus < 0.0) {
        throw std::invalid_argument(
            "Synapse::enableThreeFactor: E_plus must be >= 0. Got E_plus=" + std::to_string(E_plus)
        );
    }
    if (E_minus < 0.0) {
        throw std::invalid_argument(
            "Synapse::enableThreeFactor: E_minus must be >= 0. Got E_minus=" + std::to_string(E_minus)
        );
    }
    if (tau_e <= 0.0) {
        throw std::invalid_argument(
            "Synapse::enableThreeFactor: tau_e must be > 0. Got tau_e=" + std::to_string(tau_e)
        );
    }
    if (eta_3f <= 0.0) {
        throw std::invalid_argument(
            "Synapse::enableThreeFactor: eta_3f must be > 0. Got eta_3f=" + std::to_string(eta_3f)
        );
    }
    if (!std::isfinite(E_plus) || !std::isfinite(E_minus) ||
        !std::isfinite(tau_e) || !std::isfinite(eta_3f)) {
        throw std::invalid_argument(
            "Synapse::enableThreeFactor: parameters must be finite"
        );
    }
    if (!std::isfinite(w_min) || !std::isfinite(w_max)) {
        throw std::invalid_argument(
            "Synapse::enableThreeFactor: w_min and w_max must be finite"
        );
    }
    if (w_min > w_max) {
        throw std::invalid_argument(
            "Synapse::enableThreeFactor: w_min must be <= w_max"
        );
    }
    if (w_ < w_min || w_ > w_max) {
        throw std::invalid_argument(
            "Synapse::enableThreeFactor: current weight must be within [w_min, w_max]"
        );
    }

    // All validation passed: commit atomically.
    E_plus_ = E_plus;
    E_minus_ = E_minus;
    tau_e_ = tau_e;
    eta_3f_ = eta_3f;
    w_min_ = w_min;
    w_max_ = w_max;
    e_ = 0.0;
    plasticity_enabled_ = true;
    three_factor_enabled_ = true;
    mode_ = PlasticityMode::THREEFACTOR;

    clampWeight();
}

void Synapse::decayEligibility(double dt) {
    if (!three_factor_enabled_) return;
    if (!std::isfinite(dt) || dt <= 0.0) {
        throw std::invalid_argument(
            "Synapse::decayEligibility: dt must be > 0 and finite. Got dt=" + std::to_string(dt)
        );
    }
    e_ *= std::exp(-dt / tau_e_);
}

void Synapse::accumulateEligibility(bool pre_spiked, bool post_spiked) {
    if (!three_factor_enabled_) return;

    // Order matches STARK-004 same-timestep convention:
    // post contribution first, then pre contribution (deterministic).
    if (post_spiked) {
        e_ += E_plus_ * x_pre_;
    }
    if (pre_spiked) {
        e_ -= E_minus_ * x_post_;
    }
}

void Synapse::applyThreeFactor(double m) {
    if (mode_ != PlasticityMode::THREEFACTOR) return;
    if (!std::isfinite(m)) {
        throw std::invalid_argument(
            "Synapse::applyThreeFactor: modulator must be finite. Got m=" + std::to_string(m)
        );
    }

    double dw = eta_3f_ * m * e_;

    // Defensive finiteness guard on dw (mirrors STARK-005 exp() guard style).
    if (!std::isfinite(dw)) {
        return;  // Do not corrupt weight; skip this update.
    }

    w_ += dw;
    clampWeight();
}

void Synapse::setThreeFactorState(double e, double e_plus, double e_minus,
                                 double tau_e, double eta_3f, bool enabled,
                                 PlasticityMode mode) {
    // Transactional restore: validate all three-factor values before committing.
    if (!std::isfinite(e)) {
        throw std::invalid_argument(
            "Synapse::setThreeFactorState: eligibility must be finite"
        );
    }
    if (enabled) {
        if (e_plus < 0.0 || e_minus < 0.0) {
            throw std::invalid_argument(
                "Synapse::setThreeFactorState: E_plus and E_minus must be >= 0"
            );
        }
        if (!std::isfinite(e_plus) || !std::isfinite(e_minus)) {
            throw std::invalid_argument(
                "Synapse::setThreeFactorState: E_plus and E_minus must be finite"
            );
        }
        if (tau_e <= 0.0) {
            throw std::invalid_argument(
                "Synapse::setThreeFactorState: tau_e must be > 0"
            );
        }
        if (!std::isfinite(tau_e)) {
            throw std::invalid_argument(
                "Synapse::setThreeFactorState: tau_e must be finite"
            );
        }
        if (eta_3f <= 0.0) {
            throw std::invalid_argument(
                "Synapse::setThreeFactorState: eta_3f must be > 0"
            );
        }
        if (!std::isfinite(eta_3f)) {
            throw std::invalid_argument(
                "Synapse::setThreeFactorState: eta_3f must be finite"
            );
        }
    }

    // All validation passed: commit atomically.
    e_ = e;
    E_plus_ = e_plus;
    E_minus_ = e_minus;
    tau_e_ = tau_e;
    eta_3f_ = eta_3f;
    three_factor_enabled_ = enabled;
    mode_ = mode;
}
