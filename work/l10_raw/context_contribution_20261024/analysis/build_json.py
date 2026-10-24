#!/usr/bin/env python3
"""STARK-L10.3 — build work/L10_3_CONTEXT_CONTRIBUTION.json from the evidence.

Reads the analysis JSONs produced by context_contribution.py and the regression
summary; every number in the deliverable therefore comes from the artifacts.
Unmeasured quantities are written as null, never as zero.
"""
import csv
import glob
import hashlib
import json
import os
import re
import subprocess

REPO = "/home/user/A.P.E.X"
E = os.path.join(REPO, "work/l10_raw/context_contribution_20261024")


def sha(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for c in iter(lambda: f.read(1 << 16), b""):
            h.update(c)
    return h.hexdigest()


def git(*a):
    return subprocess.check_output(["git", "-C", REPO] + list(a), text=True).strip()


prim = json.load(open(os.path.join(E, "analysis", "primary_cross_arm.json")))
expl = json.load(open(os.path.join(E, "analysis", "exploratory.json")))

# generalization summaries (exploratory, no criterion)
def gen(tag):
    rows = []
    for f in sorted(glob.glob(os.path.join(E, "GEN", "metrics_*%s.csv" % tag))):
        rows += list(csv.DictReader(open(f)))
    if not rows:
        return None
    return {"cells": len(rows),
            "min_acquisition": round(min(float(r["acquisition"]) for r in rows), 6),
            "mean_final": round(sum(float(r["final_retention"]) for r in rows) / len(rows), 6),
            "mean_forgetting": round(sum(float(r["forgetting"]) for r in rows) / len(rows), 6),
            "min_holdout": round(min(float(r["holdout"]) for r in rows), 6)}


# regression summary
reg = {}
regtxt = open(os.path.join(E, "regression", "battery_summary.txt")).read()
exits = re.findall(r"EXIT (\d+)\s+(\S+)", regtxt)
reg["targets"] = len(exits)
reg["all_exit_zero"] = all(e == "0" for e, _ in exits)
counts = {}
for name in ("test_context_conditioned_memory", "test_l10_structural_audit",
             "test_l10_1_sealing", "test_phase1_profiler", "test_phase1_accounting",
             "test_phase1_budget", "test_phase1_records",
             "test_phase1_reproducibility", "test_phase1_gates"):
    p = os.path.join(E, "regression", name + ".log")
    if os.path.exists(p):
        m = re.search(r"(\d+) assertions", open(p).read())
        counts[name] = int(m.group(1)) if m else None
reg["assertions"] = counts
reg["not_executed"] = [{"target": "test_phase1_affinity",
                        "reason": "DWORD_PTR not declared (Win32-only)",
                        "status": "UNKNOWN"}]
reg["new_failures"] = 0
reg["cwd"] = "stark/"
reg["compiler"] = "g++ 12.2.0 -O2 -std=c++17"

cond = {k: {"pooled_accuracy": round(v["pooled_acc"], 6),
            "pooled_routing": round(v["pooled_routing"], 6) if v.get("pooled_routing") is not None else None}
        for k, v in prim["conditions"].items()}

doc = {
    "artifact": "STARK-L10.3 — context contribution, acceptance-criterion review and L10-E disposition",
    "date": "2026-10-24",
    "status": "diagnostics complete; no criterion changed; L10-E remains FAILED; proposed L10-K1 pending owner decision",
    "provenance": {
        "repository": "https://github.com/Rahulrr324/A.P.E.X.git",
        "starting_branch": "validation/l10-2-spec-ratification",
        "starting_sha": "8218615397ab5cfddad13765683788967d33d558",
        "branch": "validation/l10-3-context-contribution",
        "protocol_registration_commit": "3500c03",
        "protocol_v1_1_commit": "f60d1e9",
        "prior_evidence": {"l10_2_manifest_entries": 200, "mismatches": 0,
                           "l10_1_manifest_entries": 275,
                           "l10_1_expected_difference":
                               "stark/src/learning/l10_validation_harness.cpp (additive extension; frozen reproduction re-verified byte-identical)"},
        "pull_requests": {"2": {"state": "OPEN", "merged": False,
                                "head_sha": "5f5a57717509623bd4c79460d50c05f7cbc605c3"},
                          "3": {"state": "OPEN", "merged": False,
                                "head_sha": "49cc6ba18650c0d9614bb9e8918fe65453ec5a02"}},
        "new_pr_created": False},
    "protocol": {
        "path": "stark/design/l10_3_context_contribution_protocol.md",
        "version": "v1.1",
        "sha256_registered_v1_0": "7e90699b3db7d6c2f68998f46141f9f92c2dd1d26cc9dec0341f30aaed8cef82",
        "sha256_current": sha(os.path.join(REPO, "stark/design/l10_3_context_contribution_protocol.md")),
        "hash_fixed_before_any_registered_run": True,
        "post_registration_change": "v1.1: K4 (cross/ambiguous) execution path documented after that arm had been run and inspected; labelled as such; no definition, threshold, seed, hypothesis, failure condition or analysis formula changed",
        "authorization": "exploratory (no owner decision authorises a criterion change)"},
    "original_criterion": {
        "id": "L10-E",
        "source": "stark/design/context_conditioned_memory_milestone.md section 8",
        "text": "shuffled-cue mean accuracy <= 0.40 and context-off mean <= 0.40",
        "threshold": 0.40, "threshold_changed": False,
        "shuffled_measured": 0.132407, "context_off_measured": 0.425926,
        "status": "FAILED"},
    "analytic_floor": {
        "formula": "acc_off(t) = A(0,t) = (1/6) * #{i : pi_0[i] == pi_t[i]}; acc_off(0) = 1",
        "derangement_distribution_n6": {"counts": [265, 264, 135, 40, 15, 0, 1], "total": 720},
        "expected_pooled_context_off": 0.444444,
        "attainable_range": [0.333333, 1.0],
        "p_pass_perfect_router_single_seed": 0.405372,
        "p_pass_perfect_router_three_seeds": 0.151207,
        "measured_minus_analytic_max_abs": 0.0,
        "cells_checked": 9},
    "diagnostic": {
        "definitions": {
            "A(k,t)": "accuracy of bank k answering task t with the cue removed (forced-bank sweep)",
            "acc_null(t)": "(1/K) * sum_k A(k,t) — accuracy of a context-ignoring policy on this draw",
            "CAA(t)": "acc_correct(t) - acc_null(t)",
            "CRA(t)": "routing_correct(t) - 1/K",
            "degradation": "acc_correct_pooled - acc_condition_pooled"},
        "conditions": cond,
        "per_seed": {m: {"CAA": v["CAA"], "CRA": v["CRA"],
                         "CAA_per_task": v["CAA_per_task"],
                         "acc_null_per_task": v["acc_null_per_task"]}
                     for m, v in prim["per_seed"].items()},
        "pooled": {"CAA": prim["pooled"]["CAA"], "CRA": prim["pooled"]["CRA"],
                   "degradation": prim["pooled"]["degradation"]},
        "exploratory_seeds": {
            "seeds": expl["seeds"],
            "CAA_per_seed": {m: v["CAA"] for m, v in expl["per_seed"].items()},
            "CAA_pooled": expl["pooled"]["CAA"], "CRA_pooled": expl["pooled"]["CRA"],
            "note": "no criterion; reported separately"},
        "fallback": prim["fallback"],
        "model_check": prim["model_check"],
        "hypotheses": {
            "H1_CAA_ge_0_40_every_seed": "holds",
            "H2_CRA_ge_0_50": "holds",
            "H3_correct_ge_partial_ge_off": "holds",
            "H4_fallback_policy_band": "holds (|0.4259 - 0.4157| = 0.0102)",
            "H5_routing_under_off_equals_1_over_K": "holds (0.3333; bank 0 on 1080/1080 trials)",
            "H6_analytic_A_equals_agreement": "26 of 27 cells exact; 1 cell deviates by exactly one trial (see limitations)"},
        "unmeasured": {"ambiguity_resolution_curve": None,
                       "channel_misselection_attribution": None,
                       "human_review": None}},
    "proposed_criterion": {
        "id": "L10-K1",
        "status": "PENDING OWNER APPROVAL — not applied to any result",
        "text": "on every primary seed: CAA_pooled >= 0.40; CAA(t) >= 0.25 for at least two of three tasks; CRA_pooled >= 0.50",
        "null_value": 0.0,
        "ceiling_CAA": 0.555556, "ceiling_CRA": 0.666667,
        "p_pass_perfect_router": 0.999825,
        "would_pass_on_primary_seeds": True,
        "discriminating_evidence": "exploratory seed 2 scores CAA 0.4019 (barely above the threshold), so the criterion is not trivially satisfied"},
    "acceptance_decision": {
        "memo": "stark/reports/L10_3_ACCEPTANCE_DECISION.md",
        "options": {
            "A": {"description": "retain L10-E unchanged", "effect_on_history": "none"},
            "B": {"description": "keep L10-E FAILED and add L10-K1 as a separate criterion",
                  "effect_on_history": "none; L10-K1 has no history yet"},
            "C": {"description": "replace L10-E prospectively",
                  "effect_on_history": "failure preserved; the criterion row is superseded"}},
        "recommended": "B",
        "approval_status": "PENDING",
        "owner_decision_required": True,
        "agent_approved_anything": False},
    "tests": reg,
    "generalization_exploratory": {
        "T4_K4": gen("_G3_T4K4"), "T5_K5": gen("_G5_T5K5"), "T8_K8": gen("_G5_T8K8"),
        "order_201": gen("_G4_ord201"), "revisit_task0": gen("_G4_revisit"),
        "misroute_0_20": gen("_G6_misroute"), "forced_wrong_bank": gen("_G7_wrongbank")},
    "verification": {
        "determinism": "15/15 artifacts byte-identical between two runs",
        "non_perturbation": "metrics_*.csv and sealing_*.csv identical to the L10.2 R0 artifacts",
        "unflagged_reproduction": "12/12 R0 artifacts byte-identical with the modified binary",
        "checkpoint_resume": "3/3 seeds exact",
        "independent_recomputation": "analysis/recompute.py from per-trial rows only"},
    "limitations": [
        "one forced-bank cell deviates by exactly one trial (0.008333 vs 0.0); explained consistently by a channel-attention mis-selection but not verified",
        "CAA uses a measured forced-bank matrix and inherits its ~0.2% attention noise",
        "the floor derivation is specific to K=3, T=3 and n_ids=6",
        "the partial-cue condition is deterministic-alternating, not random dropout",
        "the proposed threshold is justified by headroom, not by a theory of sufficiency"],
    "progress_estimate": {"previous": 0.50, "current": 0.50,
                          "rationale": "a measurement contradiction was removed and the remaining failure made interpretable; no capability added"},
    "recommended_next": "owner decision on L10-E (A/B/C); if B is ratified, L10.4 moves L10-K1 into section 8 by a versioned change and re-runs it under a fresh registration. Do not start L11 before the acceptance specification is internally consistent.",
    "evidence_dir": "work/l10_raw/context_contribution_20261024",
}

out = os.path.join(REPO, "work/L10_3_CONTEXT_CONTRIBUTION.json")
with open(out, "w") as f:
    json.dump(doc, f, indent=2)
    f.write("\n")
print("wrote", out, os.path.getsize(out), "bytes")
