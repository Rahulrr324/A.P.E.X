#!/usr/bin/env python3
"""
STARK-L11.7 -- statistical validity audit: reproducible arithmetic.

Python standard library only. No RNG: every number is exact binomial arithmetic,
a fixed quadrature grid, or a closed-form bound. Every figure quoted in
work/L11_7_*.md is produced here.

Run:  python3 work/L11_7_power/stat_audit.py
"""
from math import comb, sqrt, log, exp, lgamma, erf, pi

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def tail(n, p, k):
    """P(X >= k), X ~ Binomial(n, p), exact sum in floating point."""
    if k <= 0:
        return 1.0
    if k > n:
        return 0.0
    if n <= 600:
        return sum(comb(n, i) * p**i * (1 - p)**(n - i) for i in range(k, n + 1))
    L = log_pmf_table(n, p)
    m = max(L[k:])
    return exp(m) * sum(exp(x - m) for x in L[k:])


def log_pmf_table(n, p):
    lp, lq = log(p), log(1 - p)
    return [lgamma(n + 1) - lgamma(i + 1) - lgamma(n - i + 1) + i * lp + (n - i) * lq
            for i in range(n + 1)]


def k_for_alpha(n, p0, alpha):
    """smallest k with P(X >= k | p0) <= alpha."""
    L = log_pmf_table(n, p0)
    m = max(L)
    acc, k = 0.0, n
    while k > 0:
        acc += exp(L[k])
        if acc > alpha:
            break
        k -= 1
    return min(n, k + 1)


def wilson(k, n, z=1.959963985):
    if n == 0:
        return (float('nan'), float('nan'))
    ph = k / n
    d = 1 + z * z / n
    c = ph + z * z / (2 * n)
    s = z * sqrt(ph * (1 - ph) / n + z * z / (4 * n * n))
    return ((c - s) / d, (c + s) / d)


def Phi(x):
    return 0.5 * (1 + erf(x / sqrt(2)))


def inv_norm(q):
    """Acklam rational approximation; |error| < 1.2e-9."""
    a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
         1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00]
    b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
         6.680131188771972e+01, -1.328068155288572e+01]
    c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
         -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00]
    d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
         3.754408661907416e+00]
    pl = 0.02425
    if q < pl:
        t = sqrt(-2 * log(q))
        return (((((c[0]*t+c[1])*t+c[2])*t+c[3])*t+c[4])*t+c[5]) / ((((d[0]*t+d[1])*t+d[2])*t+d[3])*t+1)
    if q > 1 - pl:
        t = sqrt(-2 * log(1 - q))
        return -(((((c[0]*t+c[1])*t+c[2])*t+c[3])*t+c[4])*t+c[5]) / ((((d[0]*t+d[1])*t+d[2])*t+d[3])*t+1)
    t = (q - 0.5) ** 2
    return (((((a[0]*t+a[1])*t+a[2])*t+a[3])*t+a[4])*t+a[5])*(q-0.5) / (((((b[0]*t+b[1])*t+b[2])*t+b[3])*t+b[4])*t+1)


def section(t):
    print("\n" + "=" * 78)
    print(t)
    print("=" * 78)


# ---------------------------------------------------------------------------
# 0. constants read from the frozen artifacts
# ---------------------------------------------------------------------------
N = 120            # trials per (task, cue category)  -- protocol section 3
N_TASKS = 3
N_SEEDS = 3        # primary seeds 123456789, 218213831, 171473193
K_A = 108          # L11-A pass threshold

section("0. design constants (frozen)")
print(f"trials per cell n = {N}; tasks = {N_TASKS}; primary seeds = {N_SEEDS}")
print(f"L11-A cells = {N_TASKS*N_SEEDS}; pass threshold = {K_A}/{N} = {K_A/N:.6f}")
print(f"answer space = 6 identities -> per-identity chance = 1/6 = {1/6:.4f}")

# ---------------------------------------------------------------------------
# 1. L11-A per-cell power
# ---------------------------------------------------------------------------
section("1. L11-A per-cell power   P(X >= 108 | n=120, p)")
print(f"{'p':>7} {'P(pass)':>10} {'P(fail)':>10}")
tab = {}
for p in (0.80, 0.85, 0.875, 0.88, 0.90, 0.91, 0.92, 0.93, 0.95, 0.97, 0.99):
    q = tail(N, p, K_A)
    tab[p] = q
    print(f"{p:>7.3f} {q:>10.4f} {1-q:>10.4f}")
lo, hi = wilson(K_A, N)
print(f"Wilson 95% interval at an observed 108/120: ({lo:.4f}, {hi:.4f}); "
      f"half-width {(hi-lo)/2:.4f}")
print("reproduces L11.1's published triple: "
      f"P(pass|0.95)={tab[0.95]:.4f}  P(pass|0.90)={tab[0.90]:.4f}  "
      f"P(pass|0.85)={tab[0.85]:.4f}")

q90, q95, q85 = tab[0.90], tab[0.95], tab[0.85]

# ---------------------------------------------------------------------------
# 2. joint power over 9 cells
# ---------------------------------------------------------------------------
section("2. L11-A joint power over 9 cells")

def gauss_copula_joint(q, rho, g=241):
    """joint probability that 9 events, each marginal probability q, all occur
    under an equicorrelated Gaussian copula with correlation rho."""
    if rho <= 0:
        return q ** 9
    if rho >= 0.999999:
        return q
    z = inv_norm(q)
    sr, s1 = sqrt(rho), sqrt(1 - rho)
    tot = wsum = 0.0
    for i in range(g):
        u = -6 + 12 * i / (g - 1)
        w = exp(-u * u / 2)
        p = Phi((z - sr * u) / s1)
        tot += w * p ** 9
        wsum += w
    return tot / wsum

print(f"{'true p':>7} {'per-cell':>9} {'indep':>11} {'rho=.3':>11} {'rho=.6':>11} "
      f"{'rho=.9':>11} {'Frechet lo':>11} {'comonotone':>11}")
for p in (0.85, 0.90, 0.92, 0.93, 0.95):
    q = tab[p]
    print(f"{p:>7.2f} {q:>9.4f} {q**9:>11.3e} {gauss_copula_joint(q,0.3):>11.4f} "
          f"{gauss_copula_joint(q,0.6):>11.4f} {gauss_copula_joint(q,0.9):>11.4f} "
          f"{max(0.0,9*q-8):>11.4f} {q:>11.4f}")
print("\nFrechet: for an intersection of 9 events each of probability q,")
print("  max(0, 9q-8) <= P(all) <= q.  Independence is one point inside;")
print("  it is not a bound and it is not implied by anything in the protocol.")

print("\nper-cell power required for a stated joint (independent) power:")
for target in (0.50, 0.80, 0.90, 0.95):
    need = target ** (1 / 9)
    lo_, hi_ = 0.5, 0.999999
    for _ in range(80):
        mid = (lo_ + hi_) / 2
        if tail(N, mid, K_A) >= need:
            hi_ = mid
        else:
            lo_ = mid
    print(f"  joint {target:.2f} -> per-cell q >= {need:.4f} -> true p >= {hi_:.4f} "
          f"= {N*hi_:.1f}/120")

# ---------------------------------------------------------------------------
# 3. the four required cases
# ---------------------------------------------------------------------------
section("3. the four required L11-A cases")
q88 = tab[0.88]
print("case 1 -- all nine cells exactly at the target (p = 0.90 each)")
print(f"  per-cell {q90:.4f}; independence {q90**9:.5f}; "
      f"Frechet [{max(0.0,9*q90-8):.4f}, {q90:.4f}]; comonotone {q90:.4f}")
print("\ncase 2 -- six cells at 0.95, three at 0.88")
print(f"  q(0.88)={q88:.4f} q(0.95)={q95:.4f}; independence {q95**6*q88**3:.3e}; "
      f"comonotone (bounded by worst cell) {min(q88,q95):.4f}")
print("\ncase 3 -- correlated: equicorrelated Gaussian copula, marginals all 0.90")
for rho in (0.0, 0.3, 0.6, 0.9, 1.0):
    print(f"  rho={rho:.1f} -> {gauss_copula_joint(q90, rho):.4f}")
print("\ncase 4 -- genuine performance above the target")
for p in (0.95, 0.97, 0.99):
    print(f"  p={p:.2f}: per-cell {tab[p]:.4f}, joint(indep) {tab[p]**9:.4f}")

# ---------------------------------------------------------------------------
# 4. L11-B
# ---------------------------------------------------------------------------
section("4. L11-B -- MixAcc(A2,t) - Null(t) >= 0.50")
NULL = {123456789: (0.5000, 0.4444, 0.5000),
        218213831: (0.4444, 0.3917, 0.3889),
        171473193: (0.3333, 0.3889, 0.3889)}
print("Null(t) is a MEASURED quantity: mean accuracy over OFF trials with each")
print("bank forced in turn, three forced cells averaged.  Its expectation is")
print("(1 + 1/6 + 1/6)/3 = 4/9 = 0.4444, NOT 1/6, because the aligned forced")
print("cell scores 1.0000.  Measured values (L10.4, same three primary seeds):")
print(f"{'seed':>10} {'t0':>7} {'t1':>7} {'t2':>7} | {'required MixAcc':>28} | {'required k/120':>16}")
for s, v in NULL.items():
    req = [x + 0.5 for x in v]
    ks = [int(-(-r * N // 1)) for r in req]
    print(f"{s:>10} " + " ".join(f"{x:>7.4f}" for x in v) + " | " +
          "/".join(f"{r:>8.4f}" for r in req) + " | " + "/".join(f"{k:>4d}" for k in ks))

print("\nimplied Comp requirement if Read = 1.0 and WrongBankAcc = 0.132 (L10.3):")
print("  MixAcc = Comp*(Read - Wrong) + Wrong  =>  Comp = (MixAcc - 0.132)/0.868")
for r in (1.0000, 0.9444, 0.8917, 0.8889, 0.8333):
    print(f"  MixAcc >= {r:.4f} -> Comp >= {(r-0.132)/0.868:.4f}"
          + ("   <-- requires 120/120" if r >= 1.0 else ""))

print("\nper-seed P('>= 2 of 3 tasks') at a uniform true MixAcc:")
print(f"{'true':>6} " + " ".join(f"{s:>12}" for s in NULL) + "   joint(3 seeds)")
for p in (0.90, 0.93, 0.95, 0.97, 0.99):
    per = []
    for s, v in NULL.items():
        ps = [tail(N, p, int(-(-(x + 0.5) * N // 1))) for x in v]
        per.append(ps[0]*ps[1]*(1-ps[2]) + ps[0]*ps[2]*(1-ps[1])
                   + ps[1]*ps[2]*(1-ps[0]) + ps[0]*ps[1]*ps[2])
    print(f"{p:>6.2f} " + " ".join(f"{x:>12.5f}" for x in per)
          + f"   {per[0]*per[1]*per[2]:.3e}")

print("\nsame rule if the null were a 4-way chance level 0.25 (it is not):")
for p in (0.80, 0.85, 0.90, 0.93):
    ps = tail(N, p, 90)
    p2 = 3 * ps * ps * (1 - ps) + ps ** 3
    print(f"  trueMixAcc={p:.2f}: per-cell {ps:.4f}, per-seed(2of3) {p2:.4f}, "
          f"joint {p2**3:.4f}")

# ---------------------------------------------------------------------------
# 5. L11-C
# ---------------------------------------------------------------------------
section("5. L11-C -- MixAcc >= 0.50")
CH_ALIGNED = 4 / 9
CH_ID = 1 / 6

def mixacc(comp, read, wrong):
    return comp * read + (1 - comp) * wrong

print(f"{'scenario':<46} {'Comp':>6} {'Read':>6} {'Wrong':>6} {'MixAcc':>7} {'@0.50':>6}")
rows = [("perfect routing + perfect retrieval", 1.0, 1.0, CH_ID),
        ("perfect routing + retrieval fails", 1.0, 0.0, CH_ID),
        ("routing fails + conditional retrieval 1.0", 0.0, 1.0, CH_ID),
        ("chance routing + chance retrieval", 1/3, CH_ID, CH_ID),
        ("routing 0.50 uniform + Read 1.0 (L10.3-shaped)", 0.50, 1.0, 0.132),
        ("L10.3 pooled routing 0.5019 + Read 1.0", 0.5019, 1.0, 0.132),
        ("L10.3 task 0: routing 0.0 + Read undefined", 0.0, 0.0, 0.132)]
for name, c, r, w in rows:
    m = mixacc(c, r, w)
    print(f"{name:<46} {c:>6.4f} {r:>6.4f} {w:>6.4f} {m:>7.4f} "
          f"{'PASS' if m >= 0.5 else 'FAIL':>6}")

print("\nheadroom above the measured context-ignoring null 4/9 = 0.4444:")
print(f"  the 0.50 floor sits {0.50-CH_ALIGNED:.4f} above it and requires "
      f"{(0.50-CH_ALIGNED)/(1-CH_ALIGNED)*100:.1f}% of the remaining headroom")
print(f"  L11-A's 0.90 requires {(0.90-CH_ALIGNED)/(1-CH_ALIGNED)*100:.1f}% of it")

print("\n'every cell >= 0.50' joint power at a uniform true MixAcc:")
for p in (0.45, 0.50, 0.55, 0.60):
    per = tail(N, p, 60)
    print(f"  true {p:.2f}: per-cell {per:.4f}  joint-18 {per**18:.3e}  joint-9 {per**9:.3e}")

# ---------------------------------------------------------------------------
# 6. L11-D
# ---------------------------------------------------------------------------
section("6. L11-D -- Read >= 0.90, denominator = routing==1")
print(f"{'Comp':>6} {'n_elig':>7} {'k':>5} {'P(pass|0.90)':>13} {'P(pass|0.95)':>13}")
for comp in (0.05, 0.10, 0.25, 0.50, 0.75, 0.90, 0.95):
    n = int(round(N * comp))
    k = int(-(-0.90 * n // 1))
    print(f"{comp:>6.2f} {n:>7} {k:>5} {tail(n,0.90,k):>13.3f} {tail(n,0.95,k):>13.3f}")
print("  Comp = 0     0     --   UNDEFINED (zero rows; the metric does not exist)")
print("\nP(fail | true Read = 0.90) rises as n_elig falls; at n_elig = 6 the "
      "criterion is decided by one or two trials.")

# ---------------------------------------------------------------------------
# 7. L11-G
# ---------------------------------------------------------------------------
section("7. L11-G -- Comp(A2) - Comp(A9) >= -0.10")
print("A2 and A9 are matched pairs: identical evaluation seed and identical")
print("streams; only training order differs.  The 360 evaluation cues are the")
print("same objects, so the two proportions are PAIRED and the correct test is")
print("McNemar.  var(d) = (psi - delta^2)/n, psi = P(discordant).")
print(f"{'p':>6} {'psi':>6} {'sd paired':>10} {'P(fail|delta=0)':>16} {'sd unpaired':>12} {'P(fail|delta=0)':>16}")
for p in (0.90, 0.95):
    for psi in (0.02, 0.05, 0.10, 0.20):
        sd_p = sqrt(psi / N)
        sd_u = sqrt(2 * p * (1 - p) / N)
        print(f"{p:>6.2f} {psi:>6.2f} {sd_p:>10.4f} {Phi(-0.10/sd_p):>16.2e} "
              f"{sd_u:>12.4f} {Phi(-0.10/sd_u):>16.2e}")
print("\nthe criterion is one-sided with a 0.10 slack: at delta = 0 it fails with")
print("probability < 1e-4 for plausible discordance, i.e. it is nearly non-binding;")
print("at delta = -0.10 exactly it passes with probability 0.5.")
print("three seeds, no multiplicity control: family error <= 3 x the per-seed rate.")

# ---------------------------------------------------------------------------
# 8. candidate designs
# ---------------------------------------------------------------------------
section("8. candidate L11-A designs (per-cell gate 108/120 unchanged)")
print(f"{'design':<52} {'p=.90':>8} {'p=.93':>8} {'p=.95':>8}")
def stats(p):
    q = tail(N, p, K_A)
    all9 = q ** 9
    k7 = sum(comb(9, i) * q**i * (1-q)**(9-i) for i in range(7, 10))
    k8 = sum(comb(9, i) * q**i * (1-q)**(9-i) for i in range(8, 10))
    two_of_three = (3*q*q*(1-q) + q**3) ** 3
    return all9, k7, k8, two_of_three
A = {p: stats(p) for p in (0.90, 0.93, 0.95)}
names = ["D0 all 9 cells (status quo, independence)",
         "D1 >= 7 of 9 cells",
         "D2 >= 8 of 9 cells",
         "D3 every task passes on >= 2 of 3 seeds"]
for i, nm in enumerate(names):
    print(f"{nm:<52} " + " ".join(f"{A[p][i]:>8.5f}" for p in (0.90, 0.93, 0.95)))
print("\nD0 under comonotone dependence instead of independence:")
print(f"  p=0.90 -> {q90:.4f}; p=0.93 -> {tab[0.93]:.4f}; p=0.95 -> {q95:.4f}")

section("8b. pre-specified global statistic: 1080 pooled trials")
print("claim tested: 'the pooled composition rate exceeds 0.90' (a DIFFERENT")
print("claim from 'every task exceeds 0.90').")
for alpha in (0.05, 0.01):
    k = k_for_alpha(1080, 0.90, alpha)
    print(f"  H0: p<=0.90 at alpha={alpha:.2f}: need >= {k}/1080 = {k/1080:.4f}; "
          f"power at 0.92 = {tail(1080,0.92,k):.4f}, at 0.95 = {tail(1080,0.95,k):.4f}")
print("  no-alpha version (threshold at 0.90, >= 972):")
for p in (0.90, 0.91, 0.92, 0.95):
    print(f"    P(pass|{p:.2f}) = {tail(1080,p,972):.4f}")

section("8c. familywise control of a 9-cell conjunction")
kf = k_for_alpha(N, 0.90, 0.05 / 9)
print(f"  Bonferroni per-cell threshold (alpha = 0.05/9): >= {kf}/120 = {kf/120:.4f}")
for p in (0.90, 0.95, 0.97, 0.99):
    print(f"    P(cell passes | {p:.2f}) = {tail(N,p,kf):.4f}; joint9 = "
          f"{tail(N,p,kf)**9:.3e}")

section("8d. non-inferiority reading of the frozen 108/120 gate")
lo_, hi_ = 0.70, 0.90
for _ in range(80):
    mid = (lo_ + hi_) / 2
    if tail(N, mid, K_A) >= 0.05:
        hi_ = mid
    else:
        lo_ = mid
print(f"  the largest p0 with P(X>=108|p0) <= 0.05 is {hi_:.4f}")
print(f"  so 108/120 is a one-sided 5% test of H0: p <= {hi_:.4f}")
print(f"  its power at a true 0.90 is {tail(N,0.90,K_A):.4f}")

section("9. whole-contract conjunction")
print("cell predicates: L11-A 9, L11-B 3 seeds x (2 of 3), L11-C 18, L11-D 9, "
      "L11-G 3")
print("no alpha is stated anywhere; the criteria are fixed-cutoff screening")
print("gates, not tests of a null, so no familywise error rate is defined.")
qA = tail(N, 0.95, K_A)
qC = tail(N, 0.95, 60)
print(f"model at Comp=Read=0.95 uniformly: A {qA**9:.4f}, C {qC**18:.4f}, "
      f"B ~ 2.6e-3 (section 4)")
print("complete pass ~ 2.6e-3 x 0.94 x 0.83 = 2.0e-3 at best")
print(f"model at 0.99 uniformly: A {tail(N,0.99,K_A)**9:.4f}, C {tail(N,0.99,60)**18:.4f}, "
      f"B 5.09e-1")
