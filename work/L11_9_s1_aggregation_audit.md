# STARK-L11.9 — Audit B: S1 Aggregation and Power, Independently Verified

**All arithmetic reproducible:** `python3 work/L11_9_claim_audit.py`, section *AUDIT B*.
Transcript: `work/L11_9_audit_transcript.txt`.

---

## 1. The four rules, recovered from the artifacts (not from their names)

| ID | Definition as stated in L11.8 | Source |
|---|---|---|
| **D0** | "all 9 cells ≥ 108/120", i.e. every task × every seed reaches `Comp ≥ 0.90` | `L11_8_S1_AGGREGATION.md` §2 |
| **D3** | "every task passes on ≥ 2 of its 3 seeds", where *passes* = that **cell** clears 108/120 | §2 |
| **D4** | "every run's mean over tasks ≥ 0.90 (i.e. 324/360 per seed)" | §2 |
| **D5** | "one pooled estimate over all 9 cells ≥ 0.90 (972/1080)" | §2 |

The ambiguity that matters: **"0.90" is used in two different senses** across the documents
— as the *true per-cell accuracy* (the parameter of a Bernoulli model) and, in the
mission's cross-check, as the *probability that one run's cell passes*. Audit B separates
them explicitly.

---

## 2. The outcome model

- One cell = **120 Bernoulli trials** with a fixed checkpoint. The pass event is
  `X ≥ 108`, so `P(cell passes) = P(X ≥ 108 | Bin(120, p)) ≡ q(p)`.
- `q(0.85) = 0.074631`, **`q(0.90) = 0.576071`**, `q(0.95) = 0.992807`. **[D]**
- 9 cells = 3 tasks × 3 runs. The rules differ only in how they aggregate the 9 pass
  indicators.

---

## 3. The D3 reconciliation — requested explicitly, resolved

### 3.1 The two calculations

| Calculation | Formula | Value |
|---|---|---|
| Mission's cross-check | `3(0.90)²(0.10) + (0.90)³` | **0.972000** **[D]** |
| L11.8's reported value | `[3q²(1−q) + q³]³` with **q = q(0.90) = 0.576071** | **0.230601** **[D]** |

They use the *same* formula with *different* per-run pass probabilities, and they answer
different questions:

- **0.972** = P(a single task passes on ≥ 2 of 3 runs | each run passes with probability 0.90).
- **0.231** = P(**all three tasks** pass on ≥ 2 of 3 runs | each **cell** passes with
  probability `q(0.90) = 0.5761`, i.e. the model's true accuracy is 0.90).

**Neither is an arithmetic error. The discrepancy is definitional**, and it is resolved by
the following table, which is the deliverable the mission asked for.

### 3.2 The mapping that resolves it **[D]**

| per-run pass probability | per-task P(≥2 of 3) | complete contract (3 tasks) |
|---|---|---|
| 0.90 *(hypothetical)* | **0.972000** | **0.918330** |
| `q(0.95) = 0.992807` | 0.999846 | 0.999537 |
| `q(0.93) = 0.922545` | 0.982931 | 0.949661 |
| **`q(0.90) = 0.576071`** | **0.613226** | **0.230601** |

**A per-run pass probability of 0.90 corresponds to a true cell accuracy of 0.9269, not
0.90** **[D]**. That single sentence is the whole reconciliation: the mission's 0.972 is the
right number for an accuracy of ≈0.927; L11.8's 0.231 is the right number for an accuracy
of 0.90.

### 3.3 The three levels the mission requires to be kept apart **[D]**

| Level | at a true accuracy of 0.90 | at 0.95 |
|---|---|---|
| **marginal** — one cell clears 108/120 | **0.5761** | 0.9928 |
| **per-task** — one task clears on ≥ 2 of 3 runs | **0.6132** | 0.99985 |
| **complete contract** — all three tasks clear | **0.2306** | 0.99954 |

**Audit finding S1-1:** L11.8's prose is correct but its table header ("`P(pass)` at a true
per-cell `p`") is easy to misread as per-task or as complete-contract. **The ratified text
must label every power figure with its level.** Recommended labels:
`P(marginal)`, `P(per-task)`, `P(complete)`.

---

## 4. The four rules at a true 0.90 **[D]**

| rule | value |
|---|---|
| D0 all 9 cells | **0.006987** |
| D3 every task, 2 of 3 runs | **0.230601** |
| D4 run mean ≥ 0.90 | **0.161195** |
| D5 pooled 972/1080 | **0.525597** |

**Audit finding S1-2:** D3 dominates D4 on both axes — stronger claim, higher power. That
result of L11.8 reproduces exactly and is therefore **not** an artifact of rounding.

---

## 5. Dependence analysis

| scenario | D0 | D3 |
|---|---|---|
| cells independent | 0.006987 | **0.230601** |
| within-run comonotone (a run passes all its tasks or none) | 0.576071 | **0.191174** |
| spread across the two extremes | **0.569** | **0.039** |

**[D]** D3 is an order of magnitude more robust to the dependence assumption than D0, and
the direction is the counter-intuitive one: for a k-of-n rule with `k > n·q`, positive
dependence *lowers* the pass probability. **Audit finding S1-3:** this is the strongest
technical argument for D3 and it survives independent recomputation.

**Assumption flagged [U]:** both columns assume cells within a run are exchangeable given
the run. The true within-run correlation is unknown and unmeasured; no arm has run.

---

## 6. Catastrophic-run scenario **[D]**

Run accuracies `(0.95, 0.95, 0.20)`, cells independent within run:

| quantity | value |
|---|---|
| per-run pass probabilities | 0.992807 / 0.992807 / ~0 (below 1e-15) |
| per-task P(≥2 of 3 runs) | **0.985666** |
| complete contract (3 tasks) | **0.957613** |

**Audit finding S1-4:** D3 passes a model with one catastrophic run across all three tasks
in **95.8 %** of studies. This is the concession L11.8 states in words and it reproduces
exactly. It must appear in the ratified text next to the rule, not only in a design note.

---

## 7. Does each rule match the per-task scientific claim?

| rule | claim it operationalises | matches the L11.8 claim ("every task, ≥ 2 of 3 runs")? |
|---|---|---|
| D0 | every task on every run | **stronger** than the claim |
| D3 | every task on at least two runs | **exactly the claim** |
| D4 | the battery mean | **weaker** — a task may be compensated |
| D5 | one pooled proportion | **different claim entirely**; forbidden by the frozen spec |

---

## 8. Audit B verdict

| Question | Verdict |
|---|---|
| Is D3's 0.231 reproducible? | **yes**, from `q(0.90) = 0.5761` and a three-task conjunction |
| Is the mission's 0.972 wrong? | **no** — it answers a different question (per-run probability 0.90 ≈ true 0.9269) |
| Are marginal, per-task and complete-contract power conflated in L11.8? | **not in the arithmetic; yes in the labelling** — fixed by §3.3 |
| Is D3 dependence-robust? | **yes**, spread 0.039 vs 0.569 **[D]** |
| Is D3's weakness disclosed? | **yes** — 95.8 % pass with one catastrophic run |
| Is the rule matched to the claim? | **yes for D3**; the frozen D (all cells) does not match the L11.8 claim |
