// Batch AM work package E: the step outcomes the plan records themselves hold.
//
// A comparison of candidate approaches can honestly say what past runs of the same capabilities left
// on record, and it can only say that from the records. This module reads them and nothing else: it
// opens no other store, computes no rate, and draws no conclusion. What it returns is the list of
// steps that ended failed or uncertain, each naming the capability it ran and the audit operation that
// says so, plus the two facts a reader needs to distrust the list - how many plan records were looked
// at, and whether the bound cut the list short.
//
// `read: false` is the answer when no plan store was available to the caller. It is not the same
// answer as an empty list, and the comparison ranks nothing on it: an unread record is not a clean one.
import { StepStatus } from '../tasks/model.js';

export const OUTCOME_BOUND = 12;

// One plan record's own failed or uncertain steps, in the shape the comparison reads. A step result
// with no recorded status is not an outcome and is not reported as one.
export function recordedStepOutcomes(plan) {
  const byId = new Map((plan?.steps ?? []).map((s) => [s.id, s]));
  return Object.entries(plan?.stepResults ?? {})
    .filter(([, r]) => r?.status === StepStatus.FAILED || r?.status === StepStatus.UNCERTAIN)
    .map(([stepId, r]) => ({
      planId: plan.id ?? null,
      stepId,
      capability: byId.get(stepId)?.action ?? null,
      status: r.status,
      operationId: r.operationId ?? '',
    }));
}

// Every recorded failed or uncertain step outcome for one goal, across the plan records that name it.
// Bounded, and the bound is reported, because a list that stopped short must not read as a complete
// history to whoever ranks candidates with it.
export async function outcomesForGoal(plansStore, { goalId = null, bound = OUTCOME_BOUND } = {}) {
  if (!plansStore || typeof plansStore.list !== 'function' || !goalId) {
    return { read: false, records: [], plans: 0, truncated: false, note: 'no plan store was handed to this read, so what past runs did is unknown here' };
  }
  const plans = (await plansStore.list()).filter((p) => p?.goalId === goalId);
  const records = plans.flatMap((p) => recordedStepOutcomes(p));
  return {
    read: true,
    records: records.slice(0, bound),
    plans: plans.length,
    truncated: records.length > bound,
  };
}

// The shape an audit line and a re-read both print: counts and ids, never prose, so two readers that
// disagree about the records disagree here.
export function outcomesAudit(outcomes) {
  if (!outcomes) return { read: false, records: 0, plans: 0, truncated: false, capabilities: [] };
  return {
    read: outcomes.read === true,
    records: (outcomes.records ?? []).length,
    plans: outcomes.plans ?? 0,
    truncated: outcomes.truncated === true,
    capabilities: [...new Set((outcomes.records ?? []).map((r) => r.capability).filter(Boolean))].sort(),
  };
}
