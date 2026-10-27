# STARK-L11.4 — Protocol and Preregistration Impact Assessment (R4, R5, schema errata)

**Subject:** the changes proposed in `work/L11_4_R4_COMPETING_DEFINITIONS.md`,
`work/L11_4_R5_METRIC_CONTRACT.md` and
`work/L11_4_SCHEMA_V0_2_CONSISTENCY_REVIEW.md`.
**Nothing here is applied.** The frozen protocol (`322078c8…`) and the
preregistration (`57a8139d…`) are byte-unchanged by this milestone.

---

## 1. Classification

Classes: **S** serialization-only · **I** instrumentation-only · **M**
metric-definition · **A** acceptance-criterion · **X** experimental-design.

| Proposal | Class | Reaches a preregistered *metric*? | Reaches a preregistered *criterion*? | Mechanism required |
|---|---|---|---|---|
| **R4** — report `Comp_task(A4)` **and** `Comp_rule(A4)`, named | **M** | yes — adds two named reported metrics for A4 | **no** (no criterion references A4) | versioned protocol amendment (text change ⇒ hash change) |
| **R4b** — pin tie-break to "lowest bank index" | **M** (documentary) | yes, in wording only | no | same amendment |
| **R4c** — add `Read_rule(A4)` or mark `Read(A4)` undefined | **M** | yes | no | same amendment |
| **R5** — `L11-C := MixAcc`, per cell, 0.50 unchanged | **A** | yes | **yes — L11-C** | versioned amendment **plus** owner ratification of a criterion clarification |
| **R5b** — restore "pooled ≥ 0.75" | **A** | yes | **yes** (new clause) | amendment + ratification; **not proposed for adoption here** |
| **D1–D3, D6–D8** — schema errata | **S/I** | no | no | schema revision v0.2 → v0.2.1 + re-recorded `schema_sha256` |
| **D4** — corrected P7 signature | **I** | no | no | schema/patch-spec erratum; part of C4 |
| **D5** — `Read(AMBIG11)` conditioning | **M** | yes | no | same amendment as R4 |

**Tally:** 0 experimental-design changes. 1 acceptance-criterion change (R5) plus 1
declined one (R5b). The rest are metric-definition, serialization or instrumentation.

---

## 2. Why a **versioned amendment** is required, not a schema revision

The L11.3 distinction is retained:

| Mechanism | Changes | Sufficient here? |
|---|---|---|
| Schema revision (v0.2 → v0.2.1) | how a trial is *recorded* | **no** — R4/R5 change how a *result is defined*, not how a row is written |
| Versioned protocol amendment (v0.1 → v0.2) | metric definitions and criterion text, re-hashed and re-recorded | **yes** |

The protocol is frozen *by hash*: `322078c8…` is recorded in the preregistration
**[V]** and this milestone re-verified that the file's hash still equals the
recorded value. Any textual change to protocol §6 — even one that moves no
criterion number — produces a different hash and therefore **cannot** be made to
the frozen file. The frozen file stays; a v0.2 amendment is added alongside it,
unregistered until the owner registers it.

**Consequence for the record:** after a v0.2 amendment is ratified, the
preregistration must record *both* hashes (`protocol_sha256` v0.1 retained,
`protocol_sha256_v0_2` added) and a new `schema_sha256`. The v0.1 record is never
overwritten.

---

## 3. Does R4 change the meaning of a preregistered metric?

**Strictly, yes — and only for a metric no criterion uses.**

| Aspect | Answer |
|---|---|
| Which metric? | `Comp` **as applied to `AMBIG11`** — a reported quantity |
| Does it change its meaning? | Yes: the frozen text defines `Comp = routing` and then, one sentence later, prescribes a rule bank for `AMBIG11`. The two cannot both be the definition. The amendment makes both explicit and **names them separately**, so neither meaning is lost |
| Does any criterion change? | **No.** L11-A, L11-B, L11-C, L11-D, L11-G all reference A2, A3 or A9; none references A4 **[V, `…generalization.md:143–147`; prereg `criteria_candidate`]** |
| Could a pass/fail flip? | **No**, structurally: A4 is not an input to any criterion |
| Is this "purely documentary"? | **Not quite** — the metric vocabulary changes (two names where the text had one). It is a metric-definition change with zero acceptance-criterion impact. Calling it "purely documentary" would overstate it |

---

## 4. Does R5 change the meaning of a preregistered criterion?

**Yes, and this is the material change in this milestone.**

| Aspect | Answer |
|---|---|
| Criterion | **L11-C** |
| Frozen text | "no cell `(seed, task)` in A2 or A3 below 0.50" — metric unnamed |
| Semantic change | the criterion now identifies `MixAcc` as its metric |
| Direction | **strengthening** on the only non-redundant cell: a run with `Comp(A3) = 1.00` and `Read(A3) = 0.00` passes under the routing reading and fails under the accuracy reading |
| Threshold | **unchanged** at 0.50 |
| Scope | unchanged: A2 and A3 |
| Aggregation | unchanged: per cell, no pooling |
| Could a previously-passing run now fail? | **Yes** — that is exactly what a clarification that resolves an ambiguity in the stricter direction does. It must therefore be ratified **before** data exist, which is the case: zero official trials exist **[V]** |
| Could a previously-failing run now pass? | Also possible (a cell with `Comp(A3)=0.30, Read=1.00, WrongBankAcc=1.00` → MixAcc 1.00). So the amendment is **not a monotone strengthening** across all inputs — it is a *different predicate*. This is stated so that no one describes it as "only stricter" |

**Because it is not monotone, R5 cannot be justified as "we made it stronger so it
is safe".** It is justified only by the evidence of intent
(`L11_4_R5_METRIC_CONTRACT.md` §2, §3) and by non-redundancy (§4). That is a
weaker form of justification, which is precisely why it needs the owner.

---

## 5. Preregistration impact

| Prereg field | Impact | Proposed handling |
|---|---|---|
| `registered_protocol.sha256` | v0.1 hash must remain valid for the v0.1 file | **retain unchanged** |
| (new) `registered_protocol_v0_2.sha256` | records the amendment | add **only on ratification** |
| `companion_documents.specification.sha256` | specification §2.1's dangling "§4" reference (R4 Finding 4) | either amend the specification or record the erratum; owner's choice |
| `companion_documents.trial_schema.sha256` | v0.1 schema is superseded in intent by v0.2 → v0.2.1 | record v0.2.1 hash; retain v0.1 |
| `criteria_candidate["L11-C"]` | the text changes if R5 is ratified | replace with the R5 contract text; retain the old string under `criteria_candidate_v0_1` |
| `criteria_candidate["L11-A"/"B"/"D"/"E"/"F"/"G"]` | **no change** | untouched |
| `declared_rule.applies_to` | unchanged; `AMBIG11 (tie-break clause)` already registered | untouched |
| `declared_rule.statement` | "ties broken by lowest **bank** index" — matches the R4b recommendation | untouched (the protocol is the outlier, not the prereg) |
| seeds, arms, thresholds, sample sizes, ordering, mixture ratios, null construction, tie-break | **no change proposed anywhere in this milestone** | untouched |

**[V]** No field of the preregistration is modified by this milestone.

---

## 6. What must be approved and re-frozen before an official run

In order; each blocks the next:

1. **R5** — ratify `L11-C := MixAcc` (or choose another option) → amendment §A of
   `work/L11_4_PROPOSED_AMENDMENT.md`.
2. **R4 / R4b / R4c** — ratify the two-name reporting for A4 and the tie-break
   wording → amendment §B.
3. **R5b** — decide the pooled clause explicitly (adopt with a written contract, or
   reject and record the rejection).
4. **R6 (carried from L11.3)** — record the adopted schema hash (now v0.2.1) in the
   preregistration.
5. **R1** — ratify thresholds. Still **NOT RATIFIED**; this milestone does not
   ratify it and no proposal here presumes it.
6. Re-freeze: commit the v0.2 protocol file, re-record every hash, and only then
   authorise implementation (R3/C1–C7).
7. Implementation and the C6 battery.

---

## 7. The status sentence this milestone is allowed to use

> The protocol remains **frozen at v0.1 and ambiguous**. Two blocking defects are
> characterized and a resolution is proposed for each; neither is ratified. **The
> protocol must not be described as frozen and unambiguous.**

Explicitly **not** permitted:
- "protocol ambiguity resolved" — the analysis is complete, the ratification is not.
- "L11-C strengthened" — it is *redefined*, and not monotonically.
- "R4 closed" — it is closed *analytically*, open *procedurally*.
- any statement that the frozen record was amended.

---

## 8. Safeguards honoured in this assessment

| Safeguard | How |
|---|---|
| Do not alter the protocol or preregistration | both byte-identical; hashes re-verified (§9) |
| Do not change thresholds, sample sizes, ordering, mixture ratios, null construction, tie-breaking rules silently | none changed; R4b is a wording pin with **zero** numeric effect and is flagged, not applied |
| Do not choose definitions because they pass | no L11 data exists; recommendation derived from construction arithmetic, declared intent and redundancy |
| Do not treat prior recommendation as ratification | R4/R5 are re-derived from primary evidence; L11.3's suggestion was revised where the evidence differed (R5: `MixAcc` alone, not the conjunction) |
| Do not mark R1 ratified | R1 remains **NOT RATIFIED** |

## 9. Frozen-hash verification (re-run in this milestone)

```
stark/design/l11_1_protocol.md                                   322078c8…   == prereg  ✅
stark/design/l11_trial_schema.md (v0.1)                          a8edd674…   == prereg  ✅
stark/design/l11_cross_signature_compositional_generalization.md  d9cd7dc4…   == prereg  ✅
work/L11_1_PREREGISTRATION.json                                  57a8139d…              ✅
```
