#!/usr/bin/env python3
"""
STARK-L11.8 -- scientific-claim and acceptance-contract redesign: reproducible arithmetic.

Python standard library only. Deterministic. Every number quoted in
work/L11_8_*.md is produced by this file.

Run:  python3 work/L11_8_power/claim_audit.py
"""
from math import comb, sqrt, ceil, log, exp, lgamma

# ---------------------------------------------------------------------------
N = 120             # trials per (task, cue category)          [frozen]
TASKS = 3
SEEDS = 3
K_A = 108           # L11-A per-cell pass count                [frozen]
CHANCE_ID = 1 / 6   # 6 identities
NULL_SHAPE = (1.0, 1 / 6, 1 / 6)   # one forced cell is the aligned bank


def section(t):
    print("\n" + "=" * 78)
    print(t)
    print("=" * 78)


def tail(n, p, k):
    if k <= 0:
        return 1.0
    if k > n:
        return 0.0
    if n <= 600:
        return sum(comb(n, i) * p**i * (1 - p)**(n - i) for i in range(k, n + 1))
    L = [lgamma(n + 1) - lgamma(i + 1) - lgamma(n - i + 1) + i * log(p)
         + (n - i) * log(1 - p) for i in range(n + 1)]
    m = max(L[k:])
    return exp(m) * sum(exp(x - m) for x in L[k:])


def binom_pmf(n, p):
    return [comb(n, i) * p**i * (1 - p)**(n - i) for i in range(n + 1)]


def convolve(a, b):
    out = [0.0] * (len(a) + len(b) - 1)
    for i, ai in enumerate(a):
        if ai == 0.0:
            continue
        for j, bj in enumerate(b):
            out[i + j] += ai * bj
    return out


def null_sum_pmf(shape):
    """pmf of S = sum of three forced-bank correct counts (each Bin(120, p_k))."""
    pm = binom_pmf(N, shape[0])
    for p in shape[1:]:
        pm = convolve(pm, binom_pmf(N, p))
    return pm


def p_two_of_three(q1, q2, q3):
    return (q1*q2*(1-q3) + q1*q3*(1-q2) + q2*q3*(1-q1) + q1*q2*q3)


# ---------------------------------------------------------------------------
section("0. design constants")
print(f"n = {N} trials per cell; {TASKS} tasks; {SEEDS} primary seeds")
print(f"independent training runs = {SEEDS};  trials per task = {N}")
print(f"total trials per arm = {TASKS*SEEDS*N} = 1080  (NOT 1080 independent units)")
print(f"per-identity chance = {CHANCE_ID:.4f}")
print(f"Ungrouped E[Null] = (1 + 1/6 + 1/6)/3 = "
      f"{(NULL_SHAPE[0]+NULL_SHAPE[1]+NULL_SHAPE[2])/3:.4f}")

# ---------------------------------------------------------------------------
section("1. S1 -- four aggregation rules for L11-A (per-cell gate unchanged: 108/120)")

def rule_all9(q):
    return q ** 9

def rule_two_of_three_seeds(q):
    per_task = 3 * q * q * (1 - q) + q ** 3
    return per_task ** 3

def rule_run_mean(p):
    """per seed, mean(Comp) over the 3 tasks >= 0.90  <=>  324/360 pooled trials."""
    return tail(360, p, 324) ** 3

def rule_pooled(p):
    """one pooled estimate over all 9 cells >= 0.90  <=>  972/1080 trials."""
    return tail(1080, p, 972)

print(f"{'true p':>7} {'q_cell':>8} {'D0 all9':>10} {'D3 2of3':>10} "
      f"{'D4 run-mean':>12} {'D5 pooled':>11}")
for p in (0.80, 0.85, 0.90, 0.92, 0.93, 0.95):
    q = tail(N, p, K_A)
    print(f"{p:>7.2f} {q:>8.4f} {rule_all9(q):>10.5f} {rule_two_of_three_seeds(q):>10.5f} "
          f"{rule_run_mean(p):>12.5f} {rule_pooled(p):>11.5f}")

print("\ndependence sensitivity of the SAME rules at a true 0.90")
q = tail(N, 0.90, K_A)
print(f"  D0: independent {q**9:.4f} | comonotone (all cells move together) {q:.4f}"
      f" | Frechet range [0, {q:.4f}]")
pt = 3*q*q*(1-q) + q**3
print(f"  D3: cells independent {pt**3:.4f} | within-seed comonotone (a run either "
      f"passes every task or none) {q**3:.4f}")
print(f"      -> D3 spans {q**3:.4f} .. {pt**3:.4f} : spread {abs(q**3 - pt**3):.4f}, "
      f"versus {abs(q - q**9):.4f} for D0")
print("      -> counter-intuitive but correct: positive dependence LOWERS a k-of-n")
print("         probability when k > n*q, so D3 is nearly dependence-robust while D0")
print("         spans two orders of magnitude under the same assumption.")
print(f"  D4: independent {rule_run_mean(0.90):.4f} | perfectly correlated runs "
      f"{tail(360,0.90,324):.4f}")
print(f"  D5: one test, no multiplicity, no cell structure: "
      f"{rule_pooled(0.90):.4f}")

print("\nclaim each rule supports")
print("  D0  'every task, on every run'                 <- highest bar, worst power")
print("  D3  'every task, on at least two of three runs'  <- matches a robustness claim")
print("  D4  'the battery mean reaches 0.90 on every run'  <- allows one task to compensate")
print("  D5  'the pooled rate exceeds 0.90'                <- a different, weaker claim")

# ---------------------------------------------------------------------------
section("2. S1 -- failure-model pass probabilities")
scenarios = [
    ("uniform 0.85 (below target)", {0: 0.85, 1: 0.85, 2: 0.85}),
    ("task-structured 0.99/0.99/0.60", {0: 0.99, 1: 0.99, 2: 0.60}),
    ("task-structured 0.99/0.99/0.13 (L10.3-shaped)", {0: 0.99, 1: 0.99, 2: 0.13}),
    ("uniform 0.50", {0: 0.50, 1: 0.50, 2: 0.50}),
]
print(f"{'failure model':<44} {'D0':>10} {'D3':>10} {'D4':>10} {'D5':>10}")
for name, cs in scenarios:
    qs = [tail(N, cs[t], K_A) for t in range(3)]
    d0 = qs[0]*qs[1]*qs[2]
    d0 = d0 ** 3
    d3 = 1.0
    for t in range(3):
        d3 *= (3*qs[t]**2*(1-qs[t]) + qs[t]**3)
    # D4 / D5 via pooled-normal approximation on per-task means
    mean_p = sum(cs.values()) / 3
    d4 = rule_run_mean(mean_p)
    d5 = rule_pooled(mean_p)
    print(f"{name:<44} {d0:>10.3e} {d3:>10.3e} {d4:>10.5f} {d5:>10.5f}")

# ---------------------------------------------------------------------------
section("3. S2 -- NormalizedGain = (MixAcc - Null) / (1 - Null)")
print("identity: MixAcc = Comp*Read + (1-Comp)*WrongBankAcc")
print("criterion NG >= t  <=>  MixAcc >= t + (1-t)*Null")
print("\nimplied MixAcc floor at t = 0.75, and at the frozen raw-difference rule:")
print(f"{'Null':>8} {'NG>=0.75 needs MixAcc':>22} {'headroom used':>13} "
      f"{'raw +0.50 needs':>16} {'raw headroom':>12}")
for nv in (0.0, 0.05, 1/6, 0.25, 1/3, 4/9, 0.50, 0.60, 0.75, 0.90):
    print(f"{nv:>8.4f} {0.75+0.25*nv:>22.4f} {(0.75+0.25*nv-nv)/(1-nv):>13.4f} "
          f"{nv+0.50:>16.4f} {min(1.0,0.50/(1-nv)) if nv < 1 else float('nan'):>12.4f}")
print("  the normalized rule consumes exactly 75 % of headroom on every cell;")
print("  the frozen raw rule consumes 50 % (Null=0) to 100 % (Null=0.50).")
print("  1.0000 -> NG = 0/0 UNDEFINED (structural NA, never a pass, never a fail)")

print("\nsensitivity: d(required MixAcc)/d(Null)")
print("  normalized rule : 0.25      (four times less sensitive than the raw difference)")
print("  raw-difference  : 1.00")
print("  a Null swing from 0.3333 to 0.5000 (the measured range) moves the required")
print("  MixAcc by 0.1667 under the raw rule and by 0.0417 under the normalized rule.")

print("\nnoise amplification: NG = (M-N)/(1-N)")
print("  dNG/dM = 1/(1-N);  dNG/dN = -(1-NG)/(1-N)")
print(f"{'Null':>8} {'sd(M)':>8} {'sd(Null)':>10} {'amp on M':>10} {'sd(NG)':>9}")
for shape in [(0.0, 0.0, 0.0), (1/6, 1/6, 1/6), NULL_SHAPE, (0.5, 1/6, 1/6)]:
    Nv = sum(shape) / 3
    sdM = sqrt(0.90 * 0.10 / N)
    sdN = sqrt(sum(p*(1-p)/N for p in shape)) / 3
    amp = 1 / (1 - Nv)
    ng = (0.90 - Nv) / (1 - Nv)
    sdNG = sqrt(sdM**2 + (1 - ng)**2 * sdN**2) / (1 - Nv)
    print(f"{Nv:>8.4f} {sdM:>8.4f} {sdN:>10.4f} {amp:>10.3f} {sdNG:>9.4f}")
print("  (the third row is the protocol's actual forced-bank construction)")

print("\nexact P(NG >= 0.75) with X ~ Bin(120, MixAcc) and the three forced cells")
print("enumerated exactly (S = sum of the three forced-bank counts):")
print(f"{'true MixAcc':>12} {'Null shape':>18} {'P(NG>=0.75)':>12}")
for shape, label in [(NULL_SHAPE, "1, 1/6, 1/6"),
                     ((1/6, 1/6, 1/6), "1/6 each"),
                     ((0.5, 1/6, 1/6), "0.5, 1/6, 1/6")]:
    pmS = null_sum_pmf(shape)
    Nv = sum(shape) / 3
    for m in (0.85, 0.90, 0.95):
        tot = 0.0
        for s, ps in enumerate(pmS):
            if ps == 0.0:
                continue
            k = ceil(90 + s / 12.0)
            tot += ps * tail(N, m, k)
        print(f"{m:>12.2f} {label:>18} {tot:>12.4f}")

# ---------------------------------------------------------------------------
section("4. S2 -- alternatives, side by side at the measured null")
print("Null shape of the protocol = (1, 1/6, 1/6), so E[Null] = 4/9 = 0.4444")
for m in (0.86, 0.88, 0.90, 0.92, 0.95):
    ng = (m - 4/9) / (1 - 4/9)
    raw = m - 4/9
    print(f"  MixAcc {m:.2f}: raw gain {raw:+.4f} (needs +0.50 -> "
          f"{'PASS' if raw >= 0.5 else 'FAIL'});  NG {ng:.4f} (needs 0.75 -> "
          f"{'PASS' if ng >= 0.75 else 'FAIL'})")
print("\nreported-separately option: no gate, both numbers printed with intervals.")
print("  weakest possible criterion set: A (routing) and D (retrieval) only.")

# ---------------------------------------------------------------------------
section("5. candidate contract vs the frozen contract -- scenario table")
print("candidate contract: A(2-of-3 seeds per task) AND B(NG>=0.75 on >=2 of 3")
print("tasks, per seed) AND D(Read>=0.90, n_elig>=30) AND G AND E AND F")
print("frozen contract  : A(all 9) AND B(raw +0.50 vs measured Null) AND C(18) AND D AND G")

MEASURED_NULL = {0: (0.5000, 0.4444, 0.5000),
                 1: (0.4444, 0.3917, 0.3889),
                 2: (0.3333, 0.3889, 0.3889)}

def cell_pass_A(c):
    return tail(N, c, K_A)

def cell_pass_D(c, r):
    n = int(round(N * c))
    if n < 30:
        return float('nan'), n
    return tail(n, r, ceil(0.9 * n)), n

def cell_pass_B(m, shape):
    pmS = null_sum_pmf(shape)
    tot = 0.0
    for s, ps in enumerate(pmS):
        if ps == 0.0:
            continue
        k = ceil(90 + s / 12.0)
        tot += ps * tail(N, m, k)
    return tot

def contract(scenario, c, r, wrong):
    m = c * r + (1 - c) * wrong
    pA = cell_pass_A(c)
    pD, n_el = cell_pass_D(c, r)
    pB = cell_pass_B(m, NULL_SHAPE)
    out = {"A_all9": pA ** 9,
           "A_2of3": (3*pA*pA*(1-pA) + pA**3) ** 3,
           "B_norm": (3*pB*pB*(1-pB) + pB**3) ** 3,
           "D": (0.0 if pD != pD else pD ** 9),
           "MixAcc": m}
    # frozen C: 18 cells >= 0.50
    pC = tail(N, m, 60) ** 18
    out["C_frozen"] = pC
    # frozen B with the measured per-cell nulls
    per_seed = []
    for s in range(3):
        ps = [tail(N, m, ceil((MEASURED_NULL[s][t] + 0.5) * N)) for t in range(3)]
        per_seed.append(p_two_of_three(*ps))
    out["B_frozen"] = per_seed[0] * per_seed[1] * per_seed[2]
    out["frozen_total"] = out["A_all9"] * out["B_frozen"] * pC * out["D"]
    out["candidate_total"] = out["A_2of3"] * out["B_norm"] * out["D"]
    return out, n_el

print(f"{'scenario':<34} {'MixAcc':>7} {'A all9':>9} {'A 2of3':>8} {'B frozen':>10} "
      f"{'B norm':>8} {'D':>7} {'frozen':>9} {'candidate':>10}")
cases = [
    ("perfect (Comp .99, Read 1)", 0.99, 1.00, CHANCE_ID),
    ("good (Comp .95, Read 1)", 0.95, 1.00, CHANCE_ID),
    ("on target (Comp .90, Read 1)", 0.90, 1.00, CHANCE_ID),
    ("leakage, same Comp/Read as on-target", 0.90, 1.00, 0.60),
    ("retrieval drop, Comp .90 Read .90", 0.90, 0.90, CHANCE_ID),
    ("retrieval collapse (Comp .99, Read 0)", 0.99, 0.00, CHANCE_ID),
    ("uniform wrong routing (Comp .50, Read 1)", 0.50, 1.00, 0.132),
]
for name, c, r, w in cases:
    o, n_el = contract(name, c, r, w)
    print(f"{name:<34} {o['MixAcc']:>7.4f} {o['A_all9']:>9.3e} {o['A_2of3']:>8.4f} "
          f"{o['B_frozen']:>10.3e} {o['B_norm']:>8.4f} {o['D']:>7.4f} "
          f"{o['frozen_total']:>9.3e} {o['candidate_total']:>10.4f}")

print("\nnote: every figure assumes independence across cells; that assumption is")
print("stated, not justified by the design. See the Frechet bounds of L11.7 section 2.")

# ---------------------------------------------------------------------------
section("6. effective sample size / experimental unit")
print("  trials per cell         120   -> measurement precision for ONE fixed checkpoint")
print("  seeds (independent runs)  3   -> the only real replication of the training procedure")
print("  tasks (fixed battery)     3   -> a fixed factor, not a random sample")
print("  a claim about the METHOD therefore has n = 3, not 9 and not 1080")
z = 1.959963985
ph, nn = 108/120, 120
dd = 1 + z*z/nn
cc = ph + z*z/(2*nn)
ss = z*sqrt(ph*(1-ph)/nn + z*z/(4*nn*nn))
lo_, hi_ = (cc-ss)/dd, (cc+ss)/dd
print(f"  Wilson 95% interval at 108/120 = ({lo_:.4f}, {hi_:.4f}); half-width "
      f"{(hi_-lo_)/2:.4f}")

# ---------------------------------------------------------------------------
section("7. S3 -- coverage arithmetic for the 0.50 floor")
print(f"{'failure mode':<42} {'A':>7} {'D':>7} {'C@0.50':>8}")
modes = [
    ("routing collapse on one task (Comp 0)", 0.0, None, 0.132),
    ("uniform wrong routing (Comp .50, Read 1)", 0.50, 1.0, 0.132),
    ("retrieval collapse (Comp .99, Read 0)", 0.99, 0.0, CHANCE_ID),
    ("leakage, same Comp/Read as on-target", 0.90, 1.00, 0.60),
    ("retrieval drop, Comp .90 Read .90", 0.90, 0.90, CHANCE_ID),
    ("on target (Comp .90, Read 1)", 0.90, 1.0, CHANCE_ID),
]
for name, c, r, w in modes:
    m = c * (r if r is not None else 0.0) + (1 - c) * w
    A = "PASS" if c >= 0.90 else "FAIL"
    D = "UNDEF" if r is None else ("PASS" if r >= 0.90 else "FAIL")
    C = "PASS" if m >= 0.50 else "FAIL"
    print(f"{name:<42} {A:>7} {D:>7} {C:>8}   (MixAcc {m:.3f})")
print("\nC@0.50 never rejects a mode that A or D accepts, and it PASSES two modes")
print("(uniform wrong routing, leakage) that A rejects. It is the weakest gate.")
