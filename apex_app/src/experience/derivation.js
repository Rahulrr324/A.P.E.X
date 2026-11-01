// Deterministic adaptation derivation. Pure: no I/O, no clock, no model. It reads the
// shaped records the store hands it and says which candidate adaptations the stored
// evidence supports.
//
// A candidate is a behaviour change APEX can see that the user asked for, not a
// conclusion APEX drew. The rule text is always one of the user's own guidance strings,
// copied verbatim; derivation only groups and counts. Nothing here approves anything:
// a candidate is evidence that a rule was asked for more than once, and it stays
// inactive until the user records a decision (see the store and ../actions).
//
// The rule it implements is deliberately narrow and statable in one sentence:
//   two or more distinct recorded experiences, each answered by current user feedback
//   that assesses it correctively and states the same guidance, in the same capability
//   scope, yield one candidate adaptation for that scope carrying that guidance.
export const DERIVATION_METHOD = 'repeated_user_correction';
export const MIN_SUPPORT_FEEDBACK = 2;

// A corrective assessment says the result was not what the user wanted. `partially_correct`
// is not included: it agrees with part of the result, so the guidance it carries cannot be
// read as "always do this instead". Silence is not an assessment at all.
export const CORRECTIVE_ASSESSMENTS = Object.freeze([
  'incorrect',
  'not_useful',
  'user_correction',
  'outcome_failed',
]);

export function normalizeRuleText(text) {
  return String(text).trim().replace(/\s+/g, ' ').toLowerCase();
}

function currentFeedbackIds(feedback, supersededIds) {
  const current = new Set();
  for (const entry of feedback) {
    if (supersededIds.has(entry.id)) continue;
    current.add(entry.id);
  }
  return current;
}

// Groups the supporting evidence and reports it in a stable order: store order for the
// first member of each group, then by group key. The same records always produce the same
// candidates in the same order, which is what lets the tests and the audit describe one
// derivation rather than a race.
export function deriveCandidateSpecs({
  experiences,
  feedback,
  supersededFeedbackIds = [],
  existingAdaptations = [],
  minSupport = MIN_SUPPORT_FEEDBACK,
} = {}) {
  const byExperience = new Map((experiences ?? []).map((record) => [record.id, record]));
  const superseded = new Set(supersededFeedbackIds);
  const current = currentFeedbackIds(feedback ?? [], superseded);
  const taken = new Set((existingAdaptations ?? [])
    .filter((adaptation) => !adaptation.retired)
    .map((adaptation) => `${adaptation.capability}\u0000${normalizeRuleText(adaptation.rule)}`));

  const groups = new Map();
  for (const entry of feedback ?? []) {
    if (!current.has(entry.id)) continue;
    if (!CORRECTIVE_ASSESSMENTS.includes(entry.assessment)) continue;
    if (typeof entry.guidance !== 'string' || entry.guidance.trim().length === 0) continue;
    const experience = byExperience.get(entry.experienceId);
    if (!experience) continue;
    const key = `${experience.capability}\u0000${normalizeRuleText(entry.guidance)}`;
    const group = groups.get(key) ?? {
      capability: experience.capability,
      groups: new Map(),
    };
    // One experience supports a candidate once, with its earliest qualifying feedback, so
    // repeated feedback on the same experience cannot manufacture the required number of
    // independent observations.
    if (!group.groups.has(experience.id)) {
      group.groups.set(experience.id, { experienceId: experience.id, feedbackId: entry.id, guidance: entry.guidance.trim() });
    }
    groups.set(key, group);
  }

  const created = [];
  const skipped = [];
  for (const [key, group] of groups) {
    const members = [...group.groups.values()];
    const [capability, normalizedRule] = key.split('\u0000');
    if (taken.has(key)) {
      skipped.push({ capability, reason: 'an adaptation for this scope and rule is already recorded', supportingExperienceIds: members.map((m) => m.experienceId) });
      continue;
    }
    if (members.length < minSupport) {
      skipped.push({ capability, reason: `${members.length} supporting experience(s); ${minSupport} are required`, supportingExperienceIds: members.map((m) => m.experienceId) });
      continue;
    }
    // The verbatim rule text is the earliest member's own words: a later feedback record
    // cannot silently rewrite what the user first asked for.
    created.push({
      capability,
      normalizedRule,
      rule: members[0].guidance,
      support: {
        experienceIds: members.map((m) => m.experienceId),
        feedbackIds: members.map((m) => m.feedbackId),
      },
    });
    taken.add(key);
  }
  return { created, skipped, minSupport };
}
