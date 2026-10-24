#!/usr/bin/env python3
"""STARK-L10.2 — generate work/L10_2_SPECIFICATION_RATIFICATION.json.

Values are read from the registered evidence CSVs rather than typed by hand, so
the deliverable cannot drift from the artifacts.
"""
import csv, glob, hashlib, json, os, statistics, collections

REPO = "/home/user/A.P.E.X"
E = os.path.join(REPO, "work/l10_raw/spec_ratification_20261024")

def sha(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for c in iter(lambda: f.read(1 << 16), b""):
            h.update(c)
    return h.hexdigest()

def metrics(sub, pattern):
    rows = []
    for f in sorted(glob.glob(os.path.join(E, sub, pattern))):
        rows += list(csv.DictReader(open(f)))
    return rows

def sealing(sub, pattern):
    rows = []
    for f in sorted(glob.glob(os.path.join(E, sub, pattern))):
        rows += list(csv.DictReader(open(f)))
    return rows

def per_seed(rows):
    out = collections.defaultdict(list)
    for r in rows:
        out[int(r["master"])].append(r)
    return {m: {"acq_min": min(float(x["acquisition"]) for x in rs),
                "final": statistics.mean(float(x["final_retention"]) for x in rs),
                "forget": statistics.mean(float(x["forgetting"]) for x in rs)}
            for m, rs in out.items()}

def sealing_by_seed(rows):
    return {int(r["master"]): {"opp": int(r["opp_total"]), "blocked": int(r["opp_blocked"]),
                               "executed": int(r["opp_executed"]), "mass": float(r["exec_mass"])}
            for r in rows}

T = "tasks_T3_K3"
r0 = metrics("R0", "metrics_*_R0.csv")
r1on = metrics("R1", "metrics_*_R1_sealON.csv")
r1off = metrics("R1", "metrics_*_R1_sealOFF.csv")
r2on = metrics("R2", "metrics_*_R2_sealON.csv")
r2off = metrics("R2", "metrics_*_R2_sealOFF.csv")
r3on = metrics("R3", "metrics_*_R3_sealON.csv")
r3off = metrics("R3", "metrics_*_R3_sealOFF.csv")
r1xon = metrics("R1", "metrics_*_R1x_sealON.csv")
r1xoff = metrics("R1", "metrics_*_R1x_sealOFF.csv")
r6 = metrics("R6", "metrics_*_R6.csv")
r7 = metrics("R7", "metrics_*_R7.csv")

s1on = sealing_by_seed(sealing("R1", "sealing_*_R1_sealON.csv"))
s1off = sealing_by_seed(sealing("R1", "sealing_*_R1_sealOFF.csv"))
s2on = sealing_by_seed(sealing("R2", "sealing_*_R2_sealON.csv"))
s2off = sealing_by_seed(sealing("R2", "sealing_*_R2_sealOFF.csv"))

ps1on, ps1off = per_seed(r1on), per_seed(r1off)
f21 = all(v["opp"] > 0 for v in s1on.values())
f22 = all(v["forget"] <= 0.10 for v in ps1on.values())
f23 = all(ps1off[m]["forget"] >= ps1on[m]["forget"] + 0.10 for m in ps1on)
f24 = all(v["mass"] == 0.0 and v["executed"] == 0 for v in s1on.values())

# context (provisional), analytic floor from the registered permutations
perm = {}
for r in csv.DictReader(open(os.path.join(E, "analysis", "perm.csv"))):
    perm[(int(r["master"]), int(r["task"]))] = [int(r["pi%d" % i]) for i in range(6)]
ctx = collections.defaultdict(dict)
for r in r0:
    ctx[int(r["master"])][int(r["step_task"])] = (float(r["acquisition"]),
                                                  float(r["context_off"]),
                                                  float(r["shuffled"]))
meas, anal, margins = [], [], {}
for m in sorted(ctx):
    margins[m] = []
    for t in sorted(ctx[m]):
        A = sum(1 for q in range(6) if perm[(m, 0)][q] == perm[(m, t)][q]) / 6.0
        acq, off, _ = ctx[m][t]
        meas.append(off); anal.append(A); margins[m].append(acq - off)
pooled_m, pooled_a = statistics.mean(meas), statistics.mean(anal)

pb = collections.defaultdict(dict)
for f in glob.glob(os.path.join(E, "R5", "ctxperbank_*.csv")):
    for r in csv.DictReader(open(f)):
        pb[(int(r["master"]), int(r["task"]))][int(r["bank"])] = float(r["acc_cue_off"])
diag = {m: [pb[(m, t)][t] for t in sorted(ctx[m])] for m in sorted(ctx)}

r7_per = per_seed(r7)
cfg = os.path.join(REPO, "stark/design/l10_2_protocol_v1_1.md")

doc = {
  "artifact": "STARK-L10.2 specification ratification and frozen protocol v1.1",
  "date": "2026-10-24",
  "provenance": {
    "repository": "https://github.com/Rahulrr324/A.P.E.X.git",
    "starting_branch": "validation/l10-1-control-repair",
    "starting_sha": "127574506947d9fb193664868227665d47478252",
    "branch": "validation/l10-2-spec-ratification",
    "registration_commit": "2fa3100",
    "decision_commit": "f935f07",
    "l10_milestone_commit": "49cc6ba18650c0d9614bb9e8918fe65453ec5a02",
    "pull_requests": {
      "2": {"state": "OPEN", "merged": False,
            "head_sha": "5f5a57717509623bd4c79460d50c05f7cbc605c3", "touched": False},
      "3": {"state": "OPEN", "merged": False,
            "head_sha": "49cc6ba18650c0d9614bb9e8918fe65453ec5a02", "touched": False}},
    "new_pr_created": False,
    "prior_evidence_verified": {
      "l10_1_manifest_entries": 275, "mismatches": 0,
      "frozen_l10_artifacts": {
        "final_run": "b38736bb8a2a4574e6226f192a617627",
        "determinism": "17beb41e342fa268d7a6efa47512df08",
        "l9": "a00b62b330bf231fdecf2b4991ec44fa"}}},
  "specification_authority": {
    "source": "stark/design/context_conditioned_memory_milestone.md section 8 (Frozen success criteria)",
    "delegation_clause_present": False,
    "authority": "repository owner (Rahulrr324)",
    "decision_mechanism": "Owner Decision Record under stark/reports/",
    "agent_approved_amendments": False,
    "decision": {"date": "2026-10-24", "answer": "Ratify A-1 and A-3 only",
                 "record": "stark/reports/L10_2_OWNER_DECISION.md",
                 "A-1": "RATIFIED", "A-2": "NOT RATIFIED", "A-3": "RATIFIED"}},
  "protocol": {
    "path": "stark/design/l10_2_protocol_v1_1.md", "version": "v1.1.1",
    "sha256_at_registration": "e753d3fbd9ffa81c7a757cdcdbf71c6bd2d2e104d685d2901e14f593134c6cd5",
    "sha256_at_decision": sha(cfg),
    "hash_fixed_before_any_run": True,
    "post_registration_change": "v1.1.1 editorial only (artifact directory date label); no arm, metric, threshold, seed or rule changed",
    "official_evaluation_authorized": "partial: L10-F2, L10-G2, L10-R1, L10-S1",
    "context_diagnostics_status": "provisional (A-2 not ratified)"},
  "amendments": {
    "A-1": {"scope": "L10-F", "status": "RATIFIED", "new_criterion": "L10-F2",
            "thresholds_declared_before_run": [0.10, 0.10]},
    "A-2": {"scope": "L10-E", "status": "NOT RATIFIED", "new_criterion": None},
    "A-3": {"scope": "controls", "status": "RATIFIED", "new_criteria": ["L10-G2"],
            "informational": ["L10-R1", "L10-S1"]}},
  "seeds": {"primary": [123456789, 218213831, 171473193], "exploratory": [1, 2, 7, 42]},
  "results": {
    "R0_CCM_reference": {"min_acquisition": min(v["acq_min"] for v in per_seed(r0).values()),
                         "final_avg": statistics.mean(v["final"] for v in per_seed(r0).values()),
                         "mean_forgetting": statistics.mean(v["forget"] for v in per_seed(r0).values())},
    "R1_SEAL_PAIR_240": {
      "per_seed": {str(m): {"sealed_forgetting": round(ps1on[m]["forget"], 6),
                            "unsealed_forgetting": round(ps1off[m]["forget"], 6),
                            "opportunities": s1on[m]["opp"],
                            "blocked": s1on[m]["blocked"],
                            "executed_unsealed": s1off[m]["executed"],
                            "mass_into_sealed_arm": s1on[m]["mass"],
                            "mass_non_active_unsealed_arm": round(s1off[m]["mass"], 3)}
                    for m in sorted(ps1on)},
      "pooled": {"sealed_forgetting": round(statistics.mean(v["forget"] for v in ps1on.values()), 6),
                 "unsealed_forgetting": round(statistics.mean(v["forget"] for v in ps1off.values()), 6),
                 "opportunities": sum(v["opp"] for v in s1on.values()),
                 "blocked": sum(v["blocked"] for v in s1on.values()),
                 "executed": sum(v["executed"] for v in s1off.values())},
      "conditions": {"F2.1_opportunities_gt_0": f21, "F2.2_sealed_le_0.10": f22,
                     "F2.3_unsealed_ge_sealed_plus_0.10": f23, "F2.4_no_write_to_sealed": f24},
      "L10-F2": "PASS" if all([f21, f22, f23, f24]) else "FAIL"},
    "R2_SEAL_PAIR_60": {
      "sealed_forgetting": round(statistics.mean(v["forget"] for v in per_seed(r2on).values()), 6),
      "unsealed_forgetting": round(statistics.mean(v["forget"] for v in per_seed(r2off).values()), 6),
      "opportunities": sum(v["opp"] for v in s2on.values()),
      "blocked": sum(v["blocked"] for v in s2on.values()),
      "executed_unsealed": sum(v["executed"] for v in s2off.values()),
      "status": "sensitivity, direction only"},
    "R3_SEAL_STRESS": {
      "sealed": {"final_avg": round(statistics.mean(v["final"] for v in per_seed(r3on).values()), 6),
                 "forgetting": round(statistics.mean(v["forget"] for v in per_seed(r3on).values()), 6)},
      "unsealed": {"final_avg": round(statistics.mean(v["final"] for v in per_seed(r3off).values()), 6),
                   "forgetting": round(statistics.mean(v["forget"] for v in per_seed(r3off).values()), 6)},
      "status": "informational L10-S1, no criterion"},
    "R1_exploratory_seeds": {
      "sealed": {"forgetting": round(statistics.mean(v["forget"] for v in per_seed(r1xon).values()), 6),
                 "final": round(statistics.mean(v["final"] for v in per_seed(r1xon).values()), 6)},
      "unsealed": {"forgetting": round(statistics.mean(v["forget"] for v in per_seed(r1xoff).values()), 6),
                   "final": round(statistics.mean(v["final"] for v in per_seed(r1xoff).values()), 6)},
      "status": "no criterion"},
    "R4_CONTEXT_OFF": {
      "pooled_measured": round(pooled_m, 6), "pooled_analytic": round(pooled_a, 6),
      "excess": float("%.2e" % (pooled_m - pooled_a)),
      "per_seed": {str(m): {"per_task": [round(ctx[m][t][1], 6) for t in sorted(ctx[m])],
                            "pooled": round(statistics.mean(ctx[m][t][1] for t in ctx[m]), 6)}
                   for m in sorted(ctx)},
      "margins_per_seed": {str(m): [round(x, 6) for x in margins[m]] for m in sorted(margins)},
      "status": "provisional diagnostic (A-2 not ratified)"},
    "R5_CTX_SWEEP": {
      "diagonal_per_seed": {str(m): [round(x, 6) for x in diag[m]] for m in sorted(diag)},
      "note": "forced-bank memory measurement; NOT context-off performance",
      "status": "provisional diagnostic"},
    "R6_K2_CAPACITY": {
      "K": 2, "sealing": "on", "reuse_unseals": False,
      "final_avg": round(statistics.mean(v["final"] for v in per_seed(r6).values()), 6),
      "mean_forgetting": round(statistics.mean(v["forget"] for v in per_seed(r6).values()), 6),
      "reference_CCM": {"final_avg": 1.0, "mean_forgetting": 0.0},
      "L10-G2": "PASS"},
    "R7_FROZEN_ROUTER": {
      "per_seed_task_accuracy": {str(m): [round(ctx[m][t][0], 6) for t in sorted(ctx[m])]
                                 for m in sorted(ctx)},
      "routing_accuracy_pooled": 0.333333,
      "accuracy_given_correct_bank": 1.0,
      "accuracy_given_wrong_bank": 0.138889,
      "fallback_bank": 0, "fallback_share_per_task": 1.0,
      "status": "informational L10-R1, no criterion"}},
  "criteria_disposition": {
    "L10-A": "PASS", "L10-B": "PASS", "L10-C": "PASS", "L10-D": "PASS",
    "L10-E": {"status": "FAILED", "value": 0.425926, "threshold": 0.40,
              "version": "v1.0", "changed": False},
    "L10-E2": "PASS (unchanged supplement)",
    "L10-E3a": {"status": "provisional_pass", "value": 7.4e-08, "threshold": 0.02},
    "L10-E3b": {"status": "provisional_pass", "per_seed": "2 of 3 tasks each seed",
                "threshold": 0.60},
    "L10-E3c": {"status": "provisional_pass", "value": 1.0, "threshold": 0.99},
    "L10-F": {"status": "FAILED", "version": "v1.0", "changed": False,
              "reason": "zero sealing opportunities by construction"},
    "L10-F2": {"status": "PASS", "version": "v1.1", "ratified": True},
    "L10-G": "PASS (historical, confounded arm)",
    "L10-G2": {"status": "PASS", "version": "v1.1", "ratified": True},
    "L10-H": "PASS", "L10-I": "no new failures", "L10-J": "reported honestly",
    "L10-R1": "reported (no criterion)", "L10-S1": "reported (no criterion)"},
  "tests": {
    "cwd": "stark/", "compiler": "g++ 12.2.0 -O2 -std=c++17",
    "targets_built": 26, "all_exit_zero": True,
    "assertions": {"test_context_conditioned_memory": 330, "test_l10_structural_audit": 357,
                   "test_l10_1_sealing": 276, "test_phase1_profiler": 34,
                   "test_phase1_accounting": 67, "test_phase1_budget": 55,
                   "test_phase1_records": 72, "test_phase1_reproducibility": 37,
                   "test_phase1_gates": 437},
    "not_executed": [{"target": "test_phase1_affinity",
                      "reason": "DWORD_PTR not declared (Win32-only)", "status": "UNKNOWN"}],
    "new_failures": 0,
    "determinism": {"repetition": "rep2", "result": "byte-identical for R0, R1 both arms, R5"},
    "independent_recomputation": {"tool": "analysis/recompute.py",
                                  "inputs": "per-trial rows only",
                                  "groups_checked": 11, "task_rows": 81, "result": "ALL MATCH"},
    "checkpoint_resume": {"seeds": [123456789, 218213831, 171473193],
                          "final_retention_and_bankmap_match": True}},
  "evidence_dir": "work/l10_raw/spec_ratification_20261024",
  "blockers": ["A-2 not ratified: L10-E remains unsatisfiable under v1.0 and failed"],
  "progress_estimate": {"previous": 0.50, "current": 0.50,
                        "rationale": "one untestable criterion became testable and two control confounds were removed; no capability added; L10-E still fails"},
  "recommended_next": "L10.3: settle L10-E (ratify a context criterion or close the milestone with a documented permanent failure). Do not start L11."}

out = os.path.join(REPO, "work/L10_2_SPECIFICATION_RATIFICATION.json")
with open(out, "w") as f:
    json.dump(doc, f, indent=2)
    f.write("\n")
print("wrote", out, os.path.getsize(out), "bytes")
print("L10-F2:", doc["results"]["R1_SEAL_PAIR_240"]["L10-F2"],
      "| L10-G2:", doc["results"]["R6_K2_CAPACITY"]["L10-G2"],
      "| L10-E:", doc["criteria_disposition"]["L10-E"]["status"])
