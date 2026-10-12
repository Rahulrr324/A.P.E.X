# STARK-004 Learning Mechanism Comparison

This document compares potential learning mechanisms for STARK's neural substrate. The comparison focuses on computational principles, compatibility with STARK's existing architecture, and suitability for future expansion.

## Comparison Table

| Mechanism               | Mathematical Complexity | Local Information | Biological Plausibility | Computational Cost | Stability | Temporal Patterns | Label-Free Learning | Compatibility with STARK | Future Reward Signals | CPU Suitability | GPU Suitability |
|------------------------|------------------------|-------------------|-------------------------|--------------------|-----------|-------------------|---------------------|--------------------------|-----------------------|---------------|---------------|
| Pair-based STDP        | Low                    | Yes               | High                    | Low                | Medium    | Yes               | Yes                 | High                     | Medium                | High          | High          |
| Rate-based Hebbian     | Low                    | Yes               | Medium                  | Low                | Low       | No                | Yes                 | Medium                   | Low                   | High          | High          |
| Oja's Rule             | Medium                 | Yes               | Medium                  | Medium             | High      | No                | Yes                 | Medium                   | Low                   | High          | High          |
| Reward-modulated STDP  | High                   | No                | High                    | High               | Medium    | Yes               | No                  | Medium                   | High                  | Medium        | Medium        |
| Three-factor Learning  | High                   | Partial           | High                    | High               | Medium    | Yes               | No                  | Medium                   | High                  | Medium        | Medium        |
| Homeostatic Plasticity | Medium                 | Yes               | High                    | Medium             | High      | No                | Yes                 | High                     | Low                   | High          | High          |
| BCM-style Plasticity   | Medium                 | Yes               | High                    | Medium             | High      | Yes               | Yes                 | High                     | Medium                | High          | High          |

## Detailed Analysis

### A. Pair-based STDP

**Mathematical Model (trace-based, as implemented in STARK-004):**
- Pre-synaptic trace: $x_{pre}(t) = \sum_{t_{pre}} \exp(-(t - t_{pre})/\tau_{pre})$
- Post-synaptic trace: $x_{post}(t) = \sum_{t_{post}} \exp(-(t - t_{post})/\tau_{post})$
- Weight update:
  - On a POST-synaptic spike: $\Delta w = +A_+ \cdot x_{pre}$ (LTP)
  - On a PRE-synaptic spike: $\Delta w = -A_- \cdot x_{post}$ (LTD)
- Net effect: pre→post pairing potentiates (w rises); post→pre pairing depresses (w falls).

**Advantages:**
- Simple to implement
- Temporally sensitive
- Local information only
- Compatible with spike-based architecture
- Low computational cost
- Suitable for CPU and GPU

**Disadvantages:**
- Susceptible to runaway weights
- Requires careful parameter tuning
- Limited to spike timing correlations

**Suitability for STARK:**
High. STDP aligns well with STARK's spike-based architecture and is computationally efficient.

---

### B. Rate-based Hebbian Learning

**Mathematical Model:**
- $\Delta w = \eta \cdot r_{pre} \cdot r_{post}$
- Where $r_{pre}$ and $r_{post}$ are firing rates

**Advantages:**
- Simple
- Local information
- Biologically inspired

**Disadvantages:**
- Not temporally sensitive
- Prone to runaway weights
- Requires rate estimation
- Less compatible with spike-based architecture

**Suitability for STARK:**
Medium. Not ideal for STARK's spike-based architecture.

---

### C. Oja's Rule

**Mathematical Model:**
- $\Delta w = \eta \cdot r_{post} \cdot (r_{pre} - r_{post} \cdot w)$

**Advantages:**
- Stable weight normalization
- Local information
- Prevents runaway weights

**Disadvantages:**
- Not temporally sensitive
- Requires rate estimation
- Less biologically plausible than STDP

**Suitability for STARK:**
Medium. Better suited for rate-based architectures.

---

### D. Reward-modulated STDP

**Mathematical Model:**
- $\Delta w = R \cdot \text{STDP}(\Delta t)$
- Where $R$ is a global reward signal

**Advantages:**
- Can learn complex tasks
- Temporally sensitive
- Biologically plausible

**Disadvantages:**
- Requires global reward signal
- High computational cost
- Not purely local

**Suitability for STARK:**
Medium. Requires a reward system, which is not yet implemented in STARK.

---

### E. Three-factor Learning / Eligibility Traces

**Mathematical Model:**
- Eligibility trace: $e(t) = \text{STDP}(\Delta t) + \gamma \cdot e(t-1)$
- Weight update: $\Delta w = R \cdot e(t)$

**Advantages:**
- Combines temporal sensitivity with reward modulation
- Biologically plausible

**Disadvantages:**
- Complex
- Requires global reward signal
- High computational cost

**Suitability for STARK:**
Medium. Requires a reward system.

---

### F. Homeostatic Plasticity

**Mathematical Model:**
- Adjusts neuronal excitability or synaptic weights to maintain target activity levels
- Example: $\Delta w = \eta \cdot (r_{target} - r_{post})$

**Advantages:**
- Stabilizes network activity
- Biologically plausible
- Local information

**Disadvantages:**
- Not a primary learning mechanism
- Slow timescale

**Suitability for STARK:**
High as a complementary mechanism, but not sufficient alone.

---

### G. BCM-style Plasticity

**Mathematical Model:**
- $\Delta w = \eta \cdot r_{pre} \cdot r_{post} \cdot (r_{post} - \theta_M)$
- Where $\theta_M$ is a sliding threshold

**Advantages:**
- Stable
- Temporally sensitive
- Biologically plausible
- Local information

**Disadvantages:**
- Requires rate estimation
- More complex than STDP

**Suitability for STARK:**
High. Compatible with spike-based architectures if adapted for spikes.

---

## Recommendation for STARK-004

**Primary Mechanism:** Pair-based STDP
- **Rationale:** STDP is the most compatible with STARK's spike-based architecture. It is computationally efficient, temporally sensitive, and biologically inspired. It also provides a foundation for future extensions like reward modulation.

**Complementary Mechanism:** Homeostatic Plasticity
- **Rationale:** Homeostatic plasticity can be added to stabilize network activity and prevent runaway weights. This should be implemented as a secondary mechanism to complement STDP.

**Avoid:**
- Rate-based Hebbian learning and Oja's rule, as they are not well-suited for spike-based architectures.
- Reward-modulated STDP and three-factor learning, as they require a reward system not yet implemented in STARK.
- BCM-style plasticity, as it is more complex and less directly compatible with spikes.