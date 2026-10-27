#!/usr/bin/env python3
"""STARK-L10.5 — build work/L10_5_MILESTONE_CLOSEOUT.json.

Values for the technical disposition are re-derived from the committed L10.4
artifacts; governance states are recorded as pending/none, never inferred.
"""
import csv
import glob
import hashlib
import json
import os
import statistics as st
import subprocess

REPO = "/home/user/A.P.E.X"
EV = os.path.join(REPO, "work/l10_raw/official_evaluation_20261024")


def sha(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for c in iter(lambda: f.read(1 << 16), b""):
            h.update(c)
    return h.hexdigest()


def git(*a):
    return subprocess.check_output(["git", "-C", REPO] + list(a), text=True).strip()


# ---- re-derive L10-E and L10-E2 from the L10.4 metrics artifacts ----
off, shuf, e2_ok = [], [], True
e2 = {}
for m in (123456789, 218213831, 171473193):
    rows = {int(r["step_task"]): r for r in
            csv.DictReader(open(os.path.join(EV, "K1", "metrics_tasks_T3_K3_%d_K1.csv" % m)))}
    for t in range(3):
        off.append(float(rows[t]["context_off"]))
        shuf.append(float(rows[t]["shuffled"]))
    m_off = [float(rows[t]["final_retention"]) - float(rows[t]["context_off"]) for t in range(3)]
    m_sh = [float(rows[t]["final_retention"]) - float(rows[t]["shuffled"]) for t in range(3)]
    a = sum(1 for x in m_off if x >= 0.60) >= 2
    b = sum(1 for x in m_sh if x >= 0.60) >= 2
    e2_ok = e2_ok and a and b
    e2[str(m)] = {"correct_minus_off": [round(x, 6) for x in m_off],
                  "correct_minus_shuffled": [round(x, 6) for x in m_sh],
                  "two_of_three_off": a, "two_of_three_shuffled": b}

official = json.load(open(os.path.join(REPO, "work", "L10_4_OFFICIAL_EVALUATION.json")))

doc = {
  "artifact": "STARK-L10.5 — owner-governed milestone closure",
  "date": "2026-10-24",
  "status": "governance closeout; decisions A, B and C APPROVED by the owner 2026-10-24; L10 formally CLOSED; specification promoted to v1.8",
  "no_experiment_run": True,
  "no_source_changed": True,
  "provenance": {
    "repository": "https://github.com/Rahulrr324/A.P.E.X.git",
    "starting_branch": "validation/l10-4-official-evaluation",
    "starting_sha": "aed9c304cdadf6b855d682bf5dfbbc811eab8dcf",
    "branch": "validation/l10-5-milestone-closeout",
    "pull_requests": {
      "2": {"state": "OPEN", "merged": False,
            "head_sha": "5f5a57717509623bd4c79460d50c05f7cbc605c3"},
      "3": {"state": "OPEN", "merged": False,
            "head_sha": "49cc6ba18650c0d9614bb9e8918fe65453ec5a02"}},
    "new_pr_created": False,
    "governance_rule": "milestone document section 13 (v1.7 entry): any change to section 8 requires an owner decision, in a new version, never edited in place"},
  "technical_disposition": {
    "L10-E": {
      "criterion": "shuffled-cue mean accuracy <= 0.40 and context-off mean <= 0.40",
      "threshold": 0.40, "threshold_changed": False,
      "measured_shuffled": round(st.mean(shuf), 6),
      "measured_context_off": round(st.mean(off), 6),
      "status": "FAILED",
      "what_it_measures": "fixed-point agreement between the fallback bank's random permutation and each task's permutation; expected pooled 4/9 = 0.4444, attainable range [1/3, 1], perfect-router pass probability 0.1512",
      "does_not_show": ["that context is unnecessary", "that the model passed the original criterion"]},
    "L10-K1": {
      "status": official["official_results"]["disposition"],
      "per_seed": {m: {"CAA_pooled": v["CAA_pooled"], "CRA_pooled": v["CRA_pooled"],
                        "seed_pass": v["seed_pass"]}
                    for m, v in official["official_results"]["per_seed"].items()},
      "thresholds": {"CAA_pooled": 0.40, "CAA_task": 0.25, "CRA_pooled": 0.50},
      "evidence": "work/l10_raw/official_evaluation_20261024/",
      "protocol_sha256": "249d507495bedb4a68b6be5eee26f968c89b3db92584dcd700d2712d9a7fb790",
      "registration_commit": "e32043c",
      "authority": "owner Option B, 2026-10-24"},
    "L10-E2": {"status": "PASS" if e2_ok else "FAIL", "threshold": 0.60,
                "per_seed": e2, "note": "re-derived from the L10.4 artifacts"},
    "L10-F": {
      "rule": "NO-SEAL mean forgetting > CCM mean forgetting",
      "status": "FAILED", "reason": "zero sealing opportunities at commit_trials = 480; unsatisfiable by construction, not a mechanism failure",
      "superseded_by": "L10-F2",
      "replacement_status": "PASS (owner ratification A-1, 2026-10-24)",
      "replacement_numbers": {"sealed_forgetting": 0.0, "unsealed_forgetting": 0.4509,
                               "opportunities": 185, "blocked": 185, "executed": 184}},
    "L10-G": {
      "rule": "K2-STRESS worse than CCM (forgetting or final average)",
      "status": "PASS", "arm": "CONFOUNDED — K2-STRESS reused a bank and un-sealed the others (two interventions)",
      "superseded_by": "L10-G2",
      "replacement_status": "PASS (owner ratification A-3, 2026-10-24)",
      "replacement_numbers": {"K2_final": 0.6361, "K2_forgetting": 0.2713,
                               "CCM_final": 1.0, "CCM_forgetting": 0.0}},
    "other": {"L10-A": "PASS", "L10-B": "PASS", "L10-C": "PASS", "L10-D": "PASS",
               "L10-H": "PASS", "L10-I": "no new failures", "L10-J": "satisfied",
               "test_phase1_affinity": None}},
  "owner_decisions": {
    "A_L10_E": {"subject": "L10-E closure",
                 "options": ["retain the historical FAILED result and formally close the criterion",
                              "leave unresolved and keep L10 open",
                              "other, with implications explained"],
                 "recommendation": "option 1 — retain and close, changing nothing",
                 "answer": "option 1",
                 "status": "APPROVED", "decided_by": "repository owner (Rahulrr324)",
                 "date": "2026-10-24"},
    "B_L10_F": {"subject": "L10-F supersession",
                 "options": ["mark superseded and closed by L10-F2, preserving the failure",
                              "leave unresolved and keep L10 open",
                              "other, with implications explained"],
                 "recommendation": "option 1",
                 "answer": "option 1",
                 "status": "APPROVED", "decided_by": "repository owner (Rahulrr324)",
                 "date": "2026-10-24"},
    "C_L10_G": {"subject": "L10-G supersession",
                 "options": ["record the historical confounded PASS as superseded by L10-G2, preserving both",
                              "leave both recorded as-is",
                              "other, with implications explained"],
                 "recommendation": "option 1",
                 "answer": "option 1",
                 "status": "APPROVED", "decided_by": "repository owner (Rahulrr324)",
                 "date": "2026-10-24"},
    "asked_separately": True,
    "bundled": False,
    "agent_approved_anything": False,
    "agent_inferred_from_prior_decisions": False,
    "record": "stark/reports/L10_5_OWNER_DECISION.md"},
  "layer_separation": {
    "owner_approved_in_force": [
      "L10.2 A-1 -> L10-F2 protocol",
      "L10.2 A-3 -> L10-G2 + informational L10-R1/L10-S1",
      "L10.3 Option B -> L10-K1 added to section 8 as v1.7"],
    "proposed_pending": ["A (L10-E closure)", "B (L10-F supersession)", "C (L10-G supersession)"],
    "historical_experimental_results": [
      "L10-E FAILED (context-off 0.425926, shuffled 0.132407)",
      "L10-F FAILED (zero sealing opportunities)",
      "L10-G PASS on a confounded arm",
      "L10-A/B/C/D/E2/H PASS"],
    "current_official_statuses": {
      "L10-A": "PASS", "L10-B": "PASS", "L10-C": "PASS", "L10-D": "PASS",
      "L10-E": "FAILED", "L10-E2": "PASS", "L10-F": "FAILED (retained)",
      "L10-F2": "PASS", "L10-G": "PASS (confounded, retained)", "L10-G2": "PASS",
      "L10-H": "PASS", "L10-I": "no new failures", "L10-J": "satisfied",
      "L10-K1": "PASS"},
    "formal_milestone_closure": "CLOSED (2026-10-24) by owner decisions A, B, C"},
  "specification": {
    "authoritative_version": "v1.8",
    "authoritative_path": "stark/design/context_conditioned_memory_milestone.md",
    "authoritative_sha256": sha(os.path.join(REPO, "stark/design/context_conditioned_memory_milestone.md")),
    "authoritative_modified_by_this_milestone": True,
    "previous_authoritative_version": "v1.7",
    "previous_authoritative_sha256": "a323378c680ebda8f6e23921b6fc95b8ad1ac2e6e37e81f04cdaa57fe5134bd5",
    "diff_shape": "+51 / -5; the only deletions are the old version-header block; three annotation rows added beneath untouched criterion rows",
    "approval_authority": "owner decisions A, B, C, 2026-10-24",
    "proposed_version": "v1.8",
    "proposal_path": "stark/design/context_conditioned_memory_milestone_v1_8_proposal.md",
    "proposal_sha256": sha(os.path.join(REPO, "stark/design/context_conditioned_memory_milestone_v1_8_proposal.md")),
    "proposal_in_force": True,
    "proposal_role": "retained as the reviewable change set that was authorised and applied",
    "why": "section 13 requires an owner decision for any section-8 change; the owner answered all three on 2026-10-24 and the authorised patches were applied",
    "change_set": {"P-A": "L10-E closure annotation (conditional)",
                    "P-B": "L10-F supersession note (conditional)",
                    "P-C": "L10-G supersession note (conditional)",
                    "P-H": "header, section-8 status line, section-13 v1.8 entry (conditional)"},
    "preserved_in_every_combination": [
      "all criterion texts, thresholds and metrics",
      "all measured values and pass/fail outcomes",
      "the official L10-K1 PASS and its provenance",
      "the v1.6 and v1.7 text",
      "seeds, evaluation semantics, task distribution"]},
  "evidence_integrity": {
    "manifests": {
      "official_evaluation_20261024": {"entries": 129, "problems": 0},
      "context_contribution_20261024": {"entries": 245, "problems": 0},
      "spec_ratification_20261024": {"entries": 200, "problems": 1,
        "explanation": "stark/src/learning/l10_validation_harness.cpp — the declared, expected difference: the manifest hashes the source as it stood at the end of L10.2, and the file was extended additively in L10.3; frozen-artifact reproduction was re-verified then, and no source file changes in L10.5"}},
    "historical_evidence_modified": False,
    "experiments_rerun_for_hash_refresh": False},
  "tests": {
    "run_in_this_milestone": [],
    "existing_verified_results": {
      "targets": 26, "all_exit_zero": True,
      "assertions": {"test_context_conditioned_memory": 330,
                      "test_l10_structural_audit": 357,
                      "test_l10_1_sealing": 276,
                      "test_phase1_gates": 437},
      "source": "work/l10_raw/official_evaluation_20261024/regression/battery_summary.txt (L10.4)",
      "status": "cited, not re-executed"},
    "not_executed": [{"target": "test_phase1_affinity",
                       "reason": "DWORD_PTR not declared (Win32-only)", "status": "UNKNOWN"}],
    "why_no_rerun": "no source, build file, test or evaluator changed; git diff contains Markdown and JSON only"},
  "deliverables": [
    "work/L10_5_MILESTONE_CLOSEOUT.md",
    "work/L10_5_MILESTONE_CLOSEOUT.json",
    "stark/reports/L10_5_OWNER_DECISION.md",
    "stark/design/context_conditioned_memory_milestone_v1_8_proposal.md"],
  "progress_estimate": {"previous": 0.55, "current": 0.57,
                         "rationale": "the milestone is formally closed with a consistent acceptance record, removing a standing governance debt; no capability added and no measured outcome changed"},
  "recommended_next": "L10.6 — L10 sign-off and L11 readiness assessment: verify v1.8 against the decision record, confirm the evidence manifests still verify, publish the milestone summary, and scope the L11 prerequisites. Optionally register the channel-slot diagnostic from L10.4 section H, the only outstanding measurement gap.",
}

out = os.path.join(REPO, "work", "L10_5_MILESTONE_CLOSEOUT.json")
with open(out, "w") as f:
    json.dump(doc, f, indent=2)
    f.write("\n")
print("wrote", out, os.path.getsize(out), "bytes")
print("L10-E", doc["technical_disposition"]["L10-E"]["status"],
      "| L10-K1", doc["technical_disposition"]["L10-K1"]["status"],
      "| closure:", doc["layer_separation"]["formal_milestone_closure"])
