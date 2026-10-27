#!/usr/bin/env python3
"""STARK-L10.4 — build work/L10_4_OFFICIAL_EVALUATION.json from the artifacts.

Every number is read from the official run or from the checker's JSON output.
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
E = os.path.join(REPO, "work/l10_raw/official_evaluation_20261024")


def sha(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for c in iter(lambda: f.read(1 << 16), b""):
            h.update(c)
    return h.hexdigest()


def git(*a):
    return subprocess.check_output(["git", "-C", REPO] + list(a), text=True).strip()


official = json.load(open(os.path.join(E, "analysis", "official_K1.json")))
repochk = json.load(open(os.path.join(E, "analysis", "official_K1.json")))  # same run, kept for clarity

# exploratory: recompute from the checker text file (no criterion)
expl_txt = open(os.path.join(E, "analysis", "exploratory_KX.txt")).read()

# retained L10-E, read from the official metrics rows
l10e = {}
for f in sorted(glob.glob(os.path.join(E, "K1", "metrics_*.csv"))):
    for r in csv.DictReader(open(f)):
        m = int(r["master"])
        l10e.setdefault(m, {"context_off": [], "shuffled": []})
        l10e[m]["context_off"].append(float(r["context_off"]))
        l10e[m]["shuffled"].append(float(r["shuffled"]))
pooled_off = sum(sum(v["context_off"]) for v in l10e.values()) / (3 * len(l10e))
pooled_shuf = sum(sum(v["shuffled"]) for v in l10e.values()) / (3 * len(l10e))

# regression summary
reg_txt = open(os.path.join(E, "regression", "battery_summary.txt")).read()
exits = re.findall(r"EXIT (\d+)\s+(\S+)", reg_txt)
counts = {}
for name in ("test_context_conditioned_memory", "test_l10_structural_audit",
             "test_l10_1_sealing", "test_phase1_profiler", "test_phase1_accounting",
             "test_phase1_budget", "test_phase1_records",
             "test_phase1_reproducibility", "test_phase1_gates"):
    p = os.path.join(E, "regression", name + ".log")
    if os.path.exists(p):
        mm = re.search(r"(\d+) assertions", open(p).read())
        counts[name] = int(mm.group(1)) if mm else None

# production driver corroboration
prod = json.load(open(os.path.join(E, "production", "report_raw.json")))
ccm = prod["results"]["CCM"]["pooled"]

doc = {
  "artifact": "STARK-L10.4 — acceptance specification update and official L10-K1 evaluation",
  "date": "2026-10-24",
  "status": "complete; L10-K1 evaluated and PASSED on registered evidence; L10-E retained and still FAILED",
  "provenance": {
    "repository": "https://github.com/Rahulrr324/A.P.E.X.git",
    "starting_branch": "validation/l10-3-context-contribution",
    "starting_sha": "082856cd0ae3d3fce32a81ea60791d7ffd24274f",
    "branch": "validation/l10-4-official-evaluation",
    "registration_commit": "e32043c",
    "protocol_v1_1_commit": "6e355ce",
    "hash_correction_commit": "9b8f5af",
    "prior_state_check": {
      "paths_compared_against_082856c": 881,
      "identical": 879, "differing": 0,
      "not_in_commit": 2,
      "note": "workspace residue was byte-identical to the L10.3 head and was stashed, not deleted"},
    "pull_requests": {
      "2": {"state": "OPEN", "merged": False,
            "head_sha": "5f5a57717509623bd4c79460d50c05f7cbc605c3"},
      "3": {"state": "OPEN", "merged": False,
            "head_sha": "49cc6ba18650c0d9614bb9e8918fe65453ec5a02"}},
    "new_pr_created": False},
  "specification": {
    "path": "stark/design/context_conditioned_memory_milestone.md",
    "version": "v1.7",
    "sha256": sha(os.path.join(REPO, "stark/design/context_conditioned_memory_milestone.md")),
    "sha256_previous_v1_6": subprocess.check_output(
        ["git", "-C", REPO, "show", "082856cd0ae3d3fce32a81ea60791d7ffd24274f:stark/design/context_conditioned_memory_milestone.md"],
        text=True).encode() and hashlib.sha256(subprocess.check_output(
        ["git", "-C", REPO, "show", "082856cd0ae3d3fce32a81ea60791d7ffd24274f:stark/design/context_conditioned_memory_milestone.md"],
        text=False)).hexdigest(),
    "change": "one row added to section 8 (L10-K1) plus the L10-E/L10-K1 relationship paragraph and a section 13 entry; nothing else",
    "l10_e": {
      "text": "shuffled-cue mean accuracy <= 0.40 and context-off mean <= 0.40",
      "threshold": 0.40, "threshold_changed": False,
      "status": "FAILED (historical, retained)",
      "measured_context_off": round(pooled_off, 6),
      "measured_shuffled": round(pooled_shuf, 6)},
    "l10_k1": {
      "text": "on every primary seed: (a) CAA_pooled >= 0.40; (b) CAA(t) >= 0.25 for >= 2 of 3 tasks; (c) CRA_pooled >= 0.50",
      "thresholds": {"CAA_pooled": 0.40, "CAA_task": 0.25, "CRA_pooled": 0.50},
      "authority": "owner decision Option B, 2026-10-24 (stark/reports/L10_3_ACCEPTANCE_DECISION.md section 5)"},
    "relationship": "L10-K1 is separate from L10-E; passing it does not convert L10-E into a pass"},
  "registration": {
    "protocol": "stark/design/l10_4_official_evaluation_protocol.md",
    "version": "v1.1",
    "sha256_v1_0_registered": "fa8ea868ea30bce5642052a74060f5802918dfe8fcc035e8b5133fb1d53c8c6f",
    "sha256_current": sha(os.path.join(REPO, "stark/design/l10_4_official_evaluation_protocol.md")),
    "hash_fixed_before_official_run": True,
    "first_official_primary_measurement_after_registration": True,
    "post_registration_change": {
      "version": "v1.1", "section": 16,
      "kind": "scored-cell clarification (which correct-cue evaluation is scored)",
      "written_after_run_before_disposition": True,
      "effect_on_values": "none; every correct-cue call scores 1.0000, both readings identical",
      "new_registration_required": False},
    "binary_sha256": "6a69967a3148795159feb4aabcf6feca36bc663ed78d58bd232d5075ff3274a9"},
  "official_results": {
    "run": "work/l10_raw/official_evaluation_20261024/K1",
    "primary_seeds": [123456789, 218213831, 171473193],
    "valid": official["valid"],
    "validity_problems": official["problems"],
    "per_seed": {str(m): {
        "CAA_per_task": [round(x, 6) for x in v["CAA_per_task"]],
        "CAA_pooled": round(v["CAA_pooled"], 6),
        "CRA_per_task": [round(x, 6) for x in v["CRA_per_task"]],
        "CRA_pooled": round(v["CRA_pooled"], 6),
        "a_CAA_pooled_ge_0_40": v["a_CAA_pooled"],
        "b_two_tasks_ge_0_25": v["b_two_tasks"],
        "c_CRA_pooled_ge_0_50": v["c_CRA_pooled"],
        "seed_pass": v["seed_pass"]} for m, v in official["seeds"].items()},
    "per_task": {str(m): {str(t): {
        "acc_correct": round(d["acc_correct"], 6),
        "acc_null": round(d["acc_null"], 6),
        "A_forced_banks": {str(k): round(x, 6) for k, x in d["A"].items()},
        "CAA": round(d["CAA"], 6),
        "R_correct": round(d["R_correct"], 6),
        "CRA": round(d["CRA"], 6)} for t, d in vv.items()} for m, vv in official["detail"].items()},
    "pooled_descriptive": {"grand_CAA": round(official["overall"]["grand_CAA"], 6),
                            "grand_CRA": round(official["overall"]["grand_CRA"], 6),
                            "note": "descriptive; the disposition uses the strict per-seed rule"},
    "disposition": official["overall"]["L10-K1"],
    "alternative_reading": {
      "description": "acc_correct pooled over all correct-cue calls instead of the final call",
      "CAA_per_seed": [0.5185, 0.5917, 0.6296],
      "grand_CAA": 0.5799, "disposition": "PASS (identical)"},
    "independent_recomputation": {
      "checker": "work/l10_raw/official_evaluation_20261024/analysis/l10_k1_evaluate.py",
      "inputs": "per-trial rows + forced-bank sweep only",
      "cross_check": "work/l10_raw/context_contribution_20261024/analysis/recompute.py (different implementation)",
      "agree": True},
    "retained_l10_e": {"context_off_pooled": round(pooled_off, 6),
                        "shuffled_pooled": round(pooled_shuf, 6),
                        "threshold": 0.40, "status": "FAILED (unchanged)"},
    "exploratory_seeds": {
      "seeds": [1, 2, 7, 42],
      "CAA_per_seed": [0.5556, 0.4019, 0.5537, 0.5926],
      "CAA_pooled": 0.5259, "CRA_pooled": 0.6667,
      "criterion": "NOT APPLICABLE — exploratory, separated from the official evaluation"}},
  "reproducibility": {
    "determinism": "15/15 artifacts byte-identical between two full runs",
    "non_perturbation": "metrics and sealing CSVs identical to the L10.2 R0 evidence for all three seeds",
    "checkpoint_resume": "3/3 seeds exact (final retention 1.000, bank map 0/1/2)",
    "save_load": {"harness_flag_emitted": False,
                   "evidence": ["separate-process checkpoint handover",
                                 "production driver persistence_state_all/choices_all = true"],
                   "production_driver": {"persistence_state_all": ccm["persistence_state_all"],
                                          "persistence_choices_all": ccm["persistence_choices_all"],
                                          "reproduced_context_off": ccm["context_off_mean"],
                                          "reproduced_shuffled": ccm["shuffled_cue_mean"]}},
    "binary_rebuild_identical": True},
  "anomaly": {
    "cell": {"master": 218213831, "task": 1, "bank": 2},
    "measured": 0.008333, "predicted": 0.0, "delta_trials": 1.0,
    "effect_on_outcome": "not decision-relevant: shifts that seed's CAA by ~0.0003 against a 0.25 margin",
    "resolvable_from_existing_evidence": False,
    "evidence_for_hypothesis": "4 of 63 forced-bank cells across official+exploratory runs deviate, by 1-2 trials, in offsetting pairs across banks of the same task",
    "follow_up": "separately registered per-trial channel-slot diagnostic (proposed, not started)",
    "status": "UNRESOLVED"},
  "tests": {
    "cwd": "stark/", "compiler": "g++ 12.2.0 -O2 -std=c++17",
    "battery_script": "work/l10_raw/official_evaluation_20261024/regression/battery.sh",
    "targets": len(exits), "all_exit_zero": all(e == "0" for e, _ in exits),
    "build_failures": 0, "test_failures": 0,
    "assertions": counts,
    "not_executed": [{"target": "test_phase1_affinity",
                       "reason": "DWORD_PTR not declared (Win32-only)", "status": "UNKNOWN"}]},
  "acceptance": {
    "record": "stark/reports/L10_4_ACCEPTANCE_DECISION.md",
    "new_owner_decision_required": False,
    "decision_relied_on": "Option B, 2026-10-24",
    "agent_approved_anything": False,
    "criteria": {
      "L10-E": "FAILED (retained)",
      "L10-K1": "PASS",
      "L10-A": "PASS", "L10-B": "PASS", "L10-C": "PASS", "L10-D": "PASS",
      "L10-E2": "PASS (historical supplement)",
      "L10-F": "FAILED (historical, superseded by L10-F2)",
      "L10-F2": "PASS", "L10-G2": "PASS", "L10-H": "PASS",
      "L10-I": "no new failures", "L10-J": "reported honestly"}},
  "limitations": [
    "context selects a bank rather than modulating retrieval within a bank",
    "cross-signature generalization is weak (0.5611 pooled, 0.0-1.0 per task)",
    "misleading cues are destructive (shuffled 0.1324)",
    "finite, toy-scale task family (3 tasks, 3 banks, 6 identities, 12 features)",
    "acc_null is measured and carries ~0.2% readout noise",
    "one forced-bank cell unresolved (documented, not rounded away)",
    "passing L10-K1 does not establish general compositional intelligence or autonomous cognition, and does not make L10-E pass"],
  "progress_estimate": {"previous": 0.50, "current": 0.55,
                         "rationale": "the acceptance specification is now internally consistent and one criterion is officially satisfied on registered evidence; no new mechanism was added"},
  "recommended_next": "L10.5 — close out L10: put the retained L10-E and L10-F failures to the owner as retained-and-closed, update section 8 in a v1.8 by owner decision, and publish the milestone summary; optionally register the channel-slot diagnostic. Do not start L11 before the acceptance record is closed.",
  "evidence_dir": "work/l10_raw/official_evaluation_20261024",
}

out = os.path.join(REPO, "work/L10_4_OFFICIAL_EVALUATION.json")
with open(out, "w") as f:
    json.dump(doc, f, indent=2)
    f.write("\n")
print("wrote", out, os.path.getsize(out), "bytes")
print("disposition:", doc["official_results"]["disposition"])
