# STARK-007 Serialization Format Comparison

> STATUS: DECIDED. The repository already shipped a working `STARK006 2` text-token format.
> This document documents why that choice was retained rather than replaced.

---

## Candidate formats evaluated

| # | Format | Pros | Cons | Verdict |
|---|--------|------|------|---------|
| A | Plain-text token stream (chosen) | Human-readable, easy to diff, version-agnostic parsing, no deps, debuggable, `max_digits10` precision preserves doubles exactly | Larger file size than binary | **CHOSEN** |
| B | Binary (raw doubles) | Compact, fast I/O | Not human-inspectable, endianness/portability issues, harder versioning, no simple diff | Rejected |
| C | JSON | Human-readable, widely supported | Requires a parser (even a minimal one adds code weight), floating-point formatting non-deterministic across libraries (`to_string` vs `printf`), key-order sensitivity | Rejected |
| D | YAML | Human-readable | Heavier parser requirement, unnecessary feature set for this project | Rejected |
| E | Pickle / serializer lib | Automatic field serialization | Introduces dependency, security risk (untrusted input), Python-only or platform-specific | Rejected |
| F | HDF5 | Scales to large data | Heavy dependency, over-engineered for a small deterministic simulator | Rejected |
| G | Protocol Buffers | Schema-versioned, compact | Code generation, dependencies, overkill for current scale | Rejected |

---

## Why the existing `STARK006 2` text-token format was kept

1. **Minimal dependencies.** The project deliberately avoids third-party libraries for MinGW/GCC compatibility reasons. A hand-written tokenizer using `std::istringstream` and `std::strtod` is sufficient.

2. **Exact double round-trip.** Using `std::setprecision(max_digits10)` with `defaultfloat` guarantees that every IEEE 754 double round-trips through text without loss on the same build/platform.

3. **Human inspectability.** A checkpoint file is a plain text file. Bugs can be spotted visually without a viewer tool. This is valuable for a research simulator.

4. **Simple versioning.** The header `STARK006 2` encodes both magic and schema version. Adding a new field is a token append; rejecting unknown versions is a single branch.

5. **No formatting ambiguity.** Unlike JSON's `to_json(double)` which varies by library, `std::ostringstream << std::setprecision(max_digits10) << val` has a single unambiguous representation.

---

## Format specification (retained)

```
STARK006 2          ← magic + schema version
N <N> <E> <t> <h>  ← neurons, synapses, timestep, homeostasis-enabled flag
H <tau_r> <kappa> <target> <hysteresis>
R <r_0> <r_1> ... <r_{N-1}>
S <s_0> <s_1> ... <s_{N-1}>
SP <sp_0> <sp_1> ... <sp_{N-1}>
E <ext_0> <ext_1> ... <ext_{N-1}>
NC <i> <tau_m> <theta_0> <tau_a> <b> <v_reset> <V> <a> <spiked>   (×N)
SC <k> <pre> <post> <delay> <tau_s> <w> <x> <x_pre> <x_post>
    <w_min> <w_max> <A_plus> <A_minus> <tau_pre> <tau_post> <plast>
    <e> <E_plus> <E_minus> <tau_e> <eta_3f> <tf_enabled> <mode>   (×E, v2)
M <modulator>       (v2 only)
DQ <N>
Q <count> [<syn_id> <deliver>]...       (×N)
```

All doubles use `max_digits10` precision. All integers are base-10. Whitespace is insignificant (token-delimited). Line breaks are logical grouping only.

---

## Compatibility policy

- `STARK006 1` → supported (legacy, three-factor fields absent)
- `STARK006 2` → supported (current)
- `STARK006 3+` → rejected with `std::invalid_argument`
- `STARK005` or any other magic → rejected
- Trailing tokens → tolerated if all required tokens are consumed first

---

*Decision finalized in STARK-007 design review. The format identity remains `STARK006` per project convention; schema version `2` reflects the addition of three-factor state.*
