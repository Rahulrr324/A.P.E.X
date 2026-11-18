// Controlled evolution foundation (T-23).
// Proposal -> review -> baseline -> experiment -> measurement -> decision -> approval -> promotion -> monitoring -> rollback.
// No silent promotion, no policy changes, no model training/inference, no production mutation.

export const EVOLUTION_SCHEMA = 'apex.evolution.v1';

export const STATES = Object.freeze({
  PROPOSAL: 'proposal',
  REVIEW: 'review',
  BASELINE: 'baseline',
  EXPERIMENT: 'experiment',
  MEASUREMENT: 'measurement',
  DECISION: 'decision',
  APPROVAL: 'approval',
  PROMOTION: 'promotion',
  MONITORING: 'monitoring',
  ROLLBACK: 'rollback',
});

const TRANSITIONS = {
  proposal: 'review',
  review: 'baseline',
  baseline: 'experiment',
  experiment: 'measurement',
  measurement: 'decision',
  decision: 'approval',
  approval: 'promotion',
  promotion: 'monitoring',
  monitoring: 'rollback',
};

export function createProposal({ id, title, evidence = [], baseline = null } = {}) {
  if (!title || typeof title !== 'string') throw new Error('title is required');
  return { schema: EVOLUTION_SCHEMA, id: id || `prop-${Date.now()}`, title, evidence, baseline, state: STATES.PROPOSAL, history: [{ state: STATES.PROPOSAL, at: new Date().toISOString() }], promoted: false, rolledBack: false };
}

export function advance(proposal) {
  const next = TRANSITIONS[proposal.state];
  if (!next) throw new Error(`no transition from ${proposal.state}`);
  // Approval gate: promotion requires explicit approval flag
  if (proposal.state === 'approval' && proposal.approved !== true) {
    throw new Error('promotion requires explicit approval');
  }
  const updated = { ...proposal, state: next, history: [...proposal.history, { state: next, at: new Date().toISOString() }] };
  if (next === 'promotion') updated.promoted = true;
  return updated;
}

export function approve(proposal) {
  if (proposal.state !== STATES.APPROVAL) throw new Error('approve only in approval state');
  return { ...proposal, approved: true };
}

export function rollback(proposal, { reason } = {}) {
  if (!reason || typeof reason !== 'string') throw new Error('rollback requires a reason');
  return { ...proposal, state: STATES.ROLLBACK, rolledBack: true, rollbackReason: reason, history: [...proposal.history, { state: STATES.ROLLBACK, at: new Date().toISOString(), reason }] };
}

export function isIsolated(experimentDir, productionDir) {
  // Ensure experiment dir is not production dir and is inside temp
  if (!experimentDir || !productionDir) return false;
  return String(experimentDir) !== String(productionDir) && String(experimentDir).toLowerCase().includes('tmp');
}
