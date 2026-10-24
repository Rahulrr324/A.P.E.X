#!/usr/bin/env python3
"""
STARK-L11.9 -- independent, deterministic audit of the proposed L11 acceptance contract.

Standard library only. No randomness, no clock, no environment dependence.
Every printed line is a pure function of the constants and formulas below, so two
consecutive runs must produce byte-identical output.

Run:  python3 work/L11_9_claim_audit.py
Exit: 0 if every executed check passes, 1 if any FAILs (UNVERIFIED does not fail the run,
      it is reported separately and counted).
"""
import sys
from math import comb, sqrt, ceil, log, exp, lgamma

FAILS = []
CHECKS = []


def check(tag, ok, detail=""):
    CHECKS.append((tag, ok, detail))
    if ok is False:
        FAILS.append(tag)
    print(f"[{'PASS' if ok else 'FAIL' if ok is False else 'UNVERIFIED'}] {tag}"
          + (f"  {detail}" if detail else ""))


def section(t):
    print("\n" + "=" * 78)
    print(t)
    print("=" * 78)


# ---------------------------------------------------------------------------
# frozen constants (from the artifacts, quoted in the audit documents)
# ---------------------------------------------------------------------------
N = 120            # trials per cell
TASKS = 3
SEEDS = 3
K_A = 108          # per-cell pass count for Comp >= 0.90
CHANCE_ID = 1 / 6
NULL_SHAPE = (1.0, 1 / 6, 1 / 6)     # protocol: OFF + each bank forced in turn
MEASURED_NULL = {0: (0.5000, 0.4444, 0.5000),
                 1: (0.4444, 0.3917, 0.3889),
                 2: (0.3333, 0.3889, 0.3889)}   # L10.4, same primary seeds

FROZEN = {
    "stark/design/l11_1_protocol.md":
        "322078c8345b5c72c4954a6de529329065d8875f2a103626039e92f09a810c32",
    "stark/design/l11_cross_signature_compositional_generalization.md":
        "d9cd7dc4024e407317a083001aff40bd287cad0f301f777cdfc5082afc3ae542",
    "stark/design/l11_trial_schema.md":
        "a8edd674bc9efd651e1c3a25dee1f5317dae442aaf236ae01f1b8240f8d87917",
    "stark/design/l11_trial_schema_v0_2.md":
        "1ce1525b83f9c02a3f1d996ec2736b0d10fcc0beefe7c1b1362f886279d96ad8",
    "work/L11_1_PREREGISTRATION.json":
        "57a8139d6797b305dd7e2d4791b00f981ff84329d2e7329a55413fbf4ea6ce3b",
    "work/L11_2_R3_AUTHORIZATION_AUDIT.md":
        "5045c1576cd207e42cc58638163b3a1c74f73fcea1fbfadeef978e290fcf1015",
    "stark/src/learning/l10_validation_harness.cpp":
        "697b5f8a23eed90324ae600fd868628dc257cd8ca0b0a3b5f509a1f42df1ffc7",
    "stark/tests/test_phase1_affinity.cpp":
        "9dab81ee7c0b825f96b3a4dc8d33859c8cb84814ec1efa9a65bc6a7250a76561",
    "work/L11_5_AMENDMENT_DRAFT.md":
        "883312d9da9efba144257455ead9d26dcaa340baceed2c1f3ad74e89fed881bf",
    "work/L11_6_CANDIDATE_AMENDMENT.md":
        "07a0cd4c5187327560e10b5b798d96d77b5b7077370f8c82ff938ec543d77511",
    "work/L11_7_power/stat_audit.py":
        "74d128b740a25ef8f48a43fcdabf94e1a57c986d7c539a51804078f02b29cbdf",
}


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
        if ai:
            for j, bj in enumerate(b):
                if bj:
                    out[i + j] += ai * bj
    return out


def two_of_three(q1, q2, q3):
    return (q1*q2*(1-q3) + q1*q3*(1-q2) + q2*q3*(1-q1) + q1*q2*q3)


# ===========================================================================
section("AUDIT 0 -- frozen artifact integrity (recorded hashes vs disk)")
import hashlib
for path, expect in sorted(FROZEN.items()):
    try:
        got = hashlib.sha256(open(path, "rb").read()).hexdigest()
    except OSError as e:
        check(f"0.frozen:{path}", None, f"cannot read: {e}")
        continue
    check(f"0.frozen:{path}", got == expect,
          "" if got == expect else f"expected {expect[:16]} got {got[:16]}")

# ===========================================================================
section("AUDIT A -- does the candidate contract's aggregation match its claim?")
print("claim (L11.8): 'in every task, on at least two of the three runs', covering")
print("both the routing clause and the retrieval clause.")
print("candidate contract (L11.8): A aggregated 2-of-3; D aggregated over ALL 9 cells.")
print("=> the two clauses are aggregated differently. Quantified below.\n")

def pd_cell(c, r):
    n = int(round(N * c))
    if n < 30:
        return None, n
    return tail(n, r, ceil(0.9 * n)), n

print(f"{'scenario':<28} {'pD cell':>8} {'D all-9':>10} {'D 2of3':>10} "
      f"{'A 2of3':>9} {'B':>9} {'total D9':>10} {'total D23':>10}")
for name, c, r in (("on target (0.90, 1.00)", 0.90, 1.00),
                   ("good (0.95, 1.00)", 0.95, 1.00),
                   ("retrieval drop (0.90, 0.90)", 0.90, 0.90)):
    pd_, n_el = pd_cell(c, r)
    d9 = pd_ ** 9
    d23 = (3 * pd_**2 * (1 - pd_) + pd_**3) ** 3
    pA = tail(N, c, K_A)
    a23 = (3 * pA**2 * (1 - pA) + pA**3) ** 3
    m = c * r + (1 - c) * CHANCE_ID
    pmS_ = binom_pmf(N, NULL_SHAPE[0])
    for sh in NULL_SHAPE[1:]:
        pmS_ = convolve(pmS_, binom_pmf(N, sh))
    pmXm = binom_pmf(N, m)
    pb = 0.0
    for sidx in range(len(pmS_)):
        if pmS_[sidx] == 0.0 or sidx == 360:
            continue
        for x in range(N + 1):
            if pmXm[x] and 12 * x >= 1080 + sidx:
                pb += pmS_[sidx] * pmXm[x]
    pb_task = 3 * pb * pb * (1 - pb) + pb ** 3
    pb3 = pb_task ** 3
    print(f"{name:<28} {pd_:>8.4f} {d9:>10.4f} {d23:>10.4f} "
          f"{a23:>9.4f} {pb3:>9.4f} {a23*d9*pb3:>10.4f} {a23*d23*pb3:>10.4f}")
print("\n  (columns 'total D9' and 'total D23' apply B's 2-of-3 rule and A's 2-of-3")
print("   rule in both cases; they differ only in D's aggregation.)")
check("A.1  the claim states one aggregation rule but the contract applies two",
      True, "A is 2-of-3, D is all-9; quantified above; flagged for the owner")
check("A.2  D's own aggregation changes by ~79x on the retrieval-drop scenario",
      True, "D all-9 0.0013 vs D 2-of-3 0.1027; B dominates that row's total")

# ===========================================================================
section("AUDIT B -- S1 aggregation: probabilities and the D3 reconciliation")
q90 = tail(N, 0.90, K_A)
q95 = tail(N, 0.95, K_A)
q85 = tail(N, 0.85, K_A)
print(f"per-cell gate: pass iff X >= {K_A} of {N}")
print(f"  q(p=0.85) = {q85:.6f}")
print(f"  q(p=0.90) = {q90:.6f}   <- marginal (one cell)")
print(f"  q(p=0.95) = {q95:.6f}")

# the mission's check: 0.90 used as the PER-RUN pass probability
per_task_090 = 3 * 0.90**2 * 0.10 + 0.90**3
check("B.1  P(>=2 of 3) with per-run pass prob = 0.90 equals 0.972",
      abs(per_task_090 - 0.972) < 5e-13, f"{per_task_090:.6f}")
print(f"      complete contract under that reading = {per_task_090**3:.6f}")

# L11.8's actual reading: 0.90 is the TRUE ACCURACY, the per-run event is the cell gate
per_task_gate = 3 * q90**2 * (1 - q90) + q90**3
complete_gate = per_task_gate ** 3
print(f"\n  per-task  P(>=2 of 3) with per-run prob = q(p=0.90) = {q90:.6f}"
      f" is {per_task_gate:.6f}")
print(f"  complete  (3 tasks)                            = {complete_gate:.6f}"
      f"  -> L11.8 reported 0.231")
check("B.2  L11.8's D3 value 0.2306 is reproduced from q(p=0.90), not from 0.90",
      abs(complete_gate - 0.2306) < 5e-5, f"{complete_gate:.6f}")

# which true accuracy would make the per-run pass probability equal to 0.90?
lo, hi = 0.90, 0.999
for _ in range(200):
    mid = (lo + hi) / 2
    if tail(N, mid, K_A) >= 0.90:
        hi = mid
    else:
        lo = mid
print(f"  a per-run pass probability of 0.90 corresponds to a true accuracy of "
      f"{hi:.4f}, not 0.90")
print("  => the 0.972 and the 0.231 answer different questions; neither is an error.")

print("\n  q  ->  per-task  ->  complete   (the mapping that resolves the ambiguity)")
for label, qq in (("per-run prob 0.90 (hypothetical)", 0.90),
                  (f"q(p=0.95) = {q95:.4f}", q95),
                  (f"q(p=0.93) = {tail(N,0.93,K_A):.4f}", tail(N, 0.93, K_A)),
                  (f"q(p=0.90) = {q90:.4f}", q90)):
    pt = 3 * qq*qq*(1-qq) + qq**3
    print(f"  {label:<34} {pt:>10.6f} {pt**3:>12.6f}")

# the four rules
d0 = q90 ** 9
d4 = tail(360, 0.90, 324) ** 3
d5 = tail(1080, 0.90, 972)
print(f"\n  at a true per-cell accuracy of 0.90:")
print(f"    D0 all 9 cells            {d0:.6f}")
print(f"    D3 every task, 2 of 3     {complete_gate:.6f}")
print(f"    D4 run mean >= 0.90       {d4:.6f}")
print(f"    D5 pooled 972/1080        {d5:.6f}")
check("B.3  D0 = 0.006987", abs(d0 - 0.006987) < 5e-6, f"{d0:.6f}")
check("B.4  D4 = 0.16119 (L11.8 printed value)", abs(d4 - 0.161190) < 5e-5, f"{d4:.6f}")
check("B.5  D5 = 0.52560 (L11.8 printed value)", abs(d5 - 0.525600) < 5e-5, f"{d5:.6f}")

# dependence
comonotone_d3 = q90 ** 3
print(f"\n  D3 dependence bounds at p=0.90:")
print(f"    independent cells        {complete_gate:.6f}")
print(f"    within-seed comonotone   {comonotone_d3:.6f}")
print(f"    D0 independent           {d0:.6f}")
print(f"    D0 comonotone            {q90:.6f}")
check("B.6  D3 comonotone = q^3 = 0.1912 (L11.8 printed value)",
      abs(comonotone_d3 - 0.1912) < 5e-4, f"{comonotone_d3:.6f}")

# catastrophic-run scenario: two strong runs, one catastrophic
ps = (0.95, 0.95, 0.20)
qs = [tail(N, p, K_A) for p in ps]
pt = two_of_three(*qs)
print(f"\n  catastrophic-run scenario: run accuracies {ps}")
print(f"    per-run gate probabilities {[round(x,6) for x in qs]}")
print(f"    per-task P(>=2 of 3 runs)  {pt:.6f}")
print(f"    complete (3 tasks)         {pt**3:.6f}")
print("    => D3 passes a model with one catastrophic run, on 3 tasks in ~"
      f"{pt**3*100:.1f}% of studies; this is the cost stated in L11.8.")

# ===========================================================================
section("AUDIT C -- S2 normalized gain: algebra, edge cases, probabilities")
print("NG = (MixAcc - Null) / (1 - Null);  rule: NG >= 0.75")
worst = 0.0
for i in range(0, 1000):
    Nv = i / 1000.0 * 0.99
    for m in (0.80, 0.86, 0.875, 0.90, 0.95, 1.0):
        ng = (m - Nv) / (1 - Nv)
        rhs = 0.75 + 0.25 * Nv
        worst = max(worst, abs((1 if ng >= 0.75 else 0) - (1 if m >= rhs else 0)))
check("C.1  NG>=0.75  <=>  MixAcc >= 0.75+0.25*Null   (grid, Null in [0,0.99))",
      worst == 0.0, f"max disagreement {worst}")

print(f"\n{'Null':>8} {'required MixAcc':>16} {'status':>34}")
for nv, st in ((0.0, "evaluable"), (1e-6, "evaluable"), (1/6, "evaluable"),
               (0.5, "evaluable"), (0.90, "evaluable but headroom 10%"),
               (0.99, "evaluable but headroom 1%"), (1.0, "UNDEFINED (0/0)")):
    print(f"{nv:>8.4f} {0.75+0.25*nv:>16.4f} {st:>34}")
print("  Null > 1 (impossible for a proportion): invalid measurement -> INVALID")
print("  Null missing one forced cell           : INCOMPUTABLE, never a pass")
print("  Null non-finite (NaN/inf)             : INVALID, never a pass")
check("C.2  Null=1 -> undefined, Null>1 -> invalid, missing -> incomputable",
      True, "classified by explicit rule (see s2 document)")

# exact distribution of NG at MixAcc = 0.90 with the protocol's forced-bank shape
pmS = binom_pmf(N, NULL_SHAPE[0])
for sh in NULL_SHAPE[1:]:
    pmS = convolve(pmS, binom_pmf(N, sh))
pmX = binom_pmf(N, 0.90)
# EXACT rule:  NG >= 0.75  <=>  x/120 - s/360 >= 0.75*(1 - s/360)
#              <=>  12*x >= 1080 + s        (integer comparison, no rounding)
pass_prob = 0.0
mean = 0.0
var = 0.0
tot = 0.0
undef_mass = 0.0
boundary_mass = 0.0
n_boundary = 0
for s in range(len(pmS)):
    if pmS[s] == 0.0:
        continue
    if s == 360:                      # Null = 1 -> structurally undefined
        undef_mass += pmS[s]
        continue
    nv = s / 360.0
    for x in range(len(pmX)):
        if pmX[x] == 0.0:
            continue
        w = pmS[s] * pmX[x]
        ng = (x / 120.0 - nv) / (1.0 - nv)
        exact_pass = (12 * x >= 1080 + s)
        if exact_pass and abs(ng - 0.75) < 1e-12:
            boundary_mass += w
            n_boundary += 1
        tot += w
        mean += w * ng
        var += w * ng * ng
        if exact_pass:
            pass_prob += w
mean /= tot
sd = sqrt(var / tot - mean * mean)
print(f"\nexact P(NG >= 0.75 | true MixAcc = 0.90), integrating over the measured null's")
print(f"sampling noise: {pass_prob:.6f}   (L11.8 reported 0.9164)")
print(f"probability mass at Null = 1 (undefined, excluded): {undef_mass:.3e}")
check("C.3  exact pass probability at MixAcc=0.90 reproduces 0.9164",
      abs(pass_prob - 0.9164) < 5e-4, f"{pass_prob:.6f}")
print(f"exact mean(NG) = {mean:.6f}, exact sd(NG) = {sd:.6f} "
      f"(L11.8 delta-method estimate 0.0496)")
check("C.4  exact sd(NG) agrees with the reported 0.0496 within 10 %",
      abs(sd - 0.0496) <= 0.00496, f"{sd:.6f}")
print(f"\nexact-boundary states (MixAcc == 0.75 + 0.25*Null exactly): {n_boundary} "
      f"states, probability mass {boundary_mass:.4f}")
fl = 0.0
for s in range(len(pmS)):
    if pmS[s] == 0.0 or s == 360:
        continue
    nv = s / 360.0
    for x in range(len(pmX)):
        if pmX[x] and (x / 120.0 - nv) / (1.0 - nv) >= 0.75:
            fl += pmS[s] * pmX[x]
fl /= tot
print(f"same quantity evaluated in FLOAT: {fl:.6f}  (difference "
      f"{pass_prob - fl:+.6f})")
check("C.6  the rule is boundary-sensitive and must be specified in exact arithmetic",
      abs(pass_prob - fl) > 1e-4,
      "float evaluation silently drops the exact-tie states, which must PASS")
print("note: this integration accounts for MEASUREMENT noise in Null, not for")
print("      between-seed variation of the true null, which remains ASSUMED fixed.")
check("C.5  the reported probability is conditional on a fixed true null shape",
      True, "sampling noise in Null integrated; model-to-model null variation not")

# ===========================================================================
section("AUDIT D -- S3 failure coverage, recomputed")
def mixacc(c, r, w):
    return c * r + (1 - c) * w

rows = [
    ("routing collapse on one task", 0.00, 0.00, 0.132),
    ("uniform wrong routing", 0.50, 1.00, 0.132),
    ("retrieval collapse", 0.99, 0.00, CHANCE_ID),
    ("leakage at same Comp/Read", 0.90, 1.00, 0.60),
    ("on target", 0.90, 1.00, CHANCE_ID),
]
print(f"{'scenario':<34} {'Comp':>6} {'Read':>6} {'MixAcc':>8} {'A':>6} {'D':>6} {'C':>6}")
bad = 0
for name, c, r, w in rows:
    m = mixacc(c, r, w)
    A = "PASS" if c >= 0.90 else "FAIL"
    D = "UNDEF" if c == 0.0 else ("PASS" if r >= 0.90 else "FAIL")
    C = "PASS" if m >= 0.50 else "FAIL"
    if A == "PASS" and D == "PASS" and C == "FAIL":
        bad += 1
    print(f"{name:<34} {c:>6.2f} {r:>6.2f} {m:>8.4f} {A:>6} {D:>6} {C:>6}")
check("D.1  no scenario where A and D accept but C rejects", bad == 0,
      "consistent with the analytic implication A and D => MixAcc >= 0.81")

print("\nanalytic implication: Comp >= 0.90 and Read >= 0.90 with Wrong >= 0 implies")
print(f"  MixAcc >= 0.90*0.90 + 0.10*Wrong_min = {0.9*0.9:.2f} > 0.50, so C@0.50 can")
print("  never reject a cell that A and D both accept.")
worst_hi = max(0.9 * 0.9 + 0.1 * w for w in (0.0, CHANCE_ID, 0.132))
check("D.2  A and D imply MixAcc >= 0.81 (grid over Wrong)", worst_hi >= 0.81)

leak_lo = mixacc(0.90, 1.00, CHANCE_ID)
leak_hi = mixacc(0.90, 1.00, 0.60)
print(f"\nleakage: at Comp=0.90, Read=1.00, Wrong 1/6 -> 0.60 raises MixAcc "
      f"{leak_lo:.4f} -> {leak_hi:.4f}")
check("D.3  MixAcc is strictly increasing in WrongBankAcc at fixed Comp,Read",
      leak_hi > leak_lo)

# ===========================================================================
section("AUDIT F -- decision-ledger counts")
CLM = ["S4", "U3"]
STC = ["S1", "S2/AC-3", "AC-7", "CA-1", "R5b"]
MET = ["S3/AC-4", "AC-5", "AC-6", "R4", "R4b", "R4c", "F1", "F2", "U1", "U2"]
IMP = ["F4", "R2", "U4", "IMP-4", "IMP-5"]
REG = ["R1", "R6"]
EXP = ["EXP-1", "EXP-2"]
DEDUPED = {"R5": "S3/AC-4", "AC-1": "U3", "AC-8": "U1/U2", "AC-9": None}
CONDITIONS = ["C1", "C2", "C3", "C4", "C5", "C6", "C7"]

total = len(CLM) + len(STC) + len(MET) + len(IMP) + len(REG) + len(EXP)
print(f"1 scientific claim        {len(CLM):>3}  {CLM}")
print(f"2 statistical contract    {len(STC):>3}  {STC}")
print(f"3 metric semantics        {len(MET):>3}  {MET}")
print(f"4 implementation / schema {len(IMP):>3}  {IMP}")
print(f"5 protocol registration   {len(REG):>3}  {REG}")
print(f"6 experimental auth.      {len(EXP):>3}  {EXP}")
print(f"  deduplicated (kept as rows, not counted): {sorted(DEDUPED)}")
print(f"  CANONICAL distinct decisions (L11.9) = {total}")
print(f"  of which: scientific/value judgments = {len(CLM)+len(STC)+len(MET)}")
print(f"            engineering, answer determined by evidence = {len(IMP)}")
print(f"            authorization steps = {len(REG)+len(EXP)}")
print(f"  implementation/runtime CONDITIONS (not decisions) = {len(CONDITIONS)}")

l118_queue = 19
l118_register = 22
print(f"\nreconciliation of L11.8's stated count:")
print(f"  L11.8 queue enumeration                  = {l118_queue}")
print(f"  L11.8 register IDs (queue + AC-5/6/7)    = {l118_register}")
print(f"  minus one dedup (R5 -> S3/AC-4)          = {l118_register - 1}")
print(f"  plus five discovered in L11.9            = +5 "
      f"(CA-1, IMP-4, IMP-5, EXP-1, EXP-2)")
print(f"  canonical                                = {l118_register - 1 + 5}")
check("F.1  canonical total equals audited L11.8 set plus the five new items",
      total == l118_register - 1 + 5, f"{total} vs {l118_register + 4}")
check("F.2  L11.8's stated 17 matches none of its enumerated counts",
      17 not in (l118_queue, l118_register), "internal inconsistency, documented not repaired")
print("  note: the audited value-judgment count (17) coincidentally equals L11.8's")
print("        stated 17, but the SETS DIFFER (L11.8 counted implementation items")
print("        and omitted AC-5/6/7). The equality is a coincidence, not a repair.")

# ===========================================================================
section("AUDIT -- authorization-state consistency in the L11.8 artifacts")
import glob
files = sorted(glob.glob("work/L11_8_*.md"))
print(f"L11.8 markdown artifacts found: {len(files)}")
forbidden = ["l11 pass", "contract passed", "official evaluation passed",
             "all criteria hold", "result: pass", "verdict: pass"]
hits = []
for f in files:
    t = open(f, encoding="utf-8").read().lower()
    for ph in forbidden:
        if ph in t:
            hits.append((f, ph))
print(f"affirmative executed-verdict phrases found: {len(hits)}")
check("G.1  no L11.8 artifact asserts an executed official PASS/FAIL verdict",
      len(hits) == 0, str(hits) if hits else "")

must = {
    "work/L11_8_COMPLETION_REPORT.md": ["authorised? | **no**", "0 / 0",
                                        "not registered"],
    "work/L11_8_READINESS_REPORT.md": ["authorised? | **no**", "0 / 0"],
    "work/L11_8_CANDIDATE_AMENDMENT.md": ["not registered", "not authorized"],
}
ok = True
for f, needles in must.items():
    t = open(f, encoding="utf-8").read().lower()
    for nd in needles:
        if nd not in t:
            ok = False
            print(f"  missing {nd!r} in {f}")
check("G.2  the completion, readiness and amendment artifacts state the locked status",
      ok, f"{len(must)} files checked")

# ===========================================================================
section("SUMMARY")
npass = sum(1 for _, ok, _ in CHECKS if ok is True)
nfail = sum(1 for _, ok, _ in CHECKS if ok is False)
nunv = sum(1 for _, ok, _ in CHECKS if ok is None)
print(f"checks executed : {len(CHECKS)}")
print(f"  PASS          : {npass}")
print(f"  FAIL          : {nfail}")
print(f"  UNVERIFIED    : {nunv}")
print(f"official arms run : 0")
print(f"official trials run : 0")
print(f"frozen artifacts modified by this milestone : 0")
print("RUN-STABLE" if nfail == 0 else "RUN-HAS-FAILURES")
sys.exit(1 if nfail else 0)
