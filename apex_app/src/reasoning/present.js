// Bounded presentation helpers for the reasoning workspace. They render the session's own records;
// they never call a model and never execute an action.
import { shortId } from '../util.js';

function line(value, max = 260) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function renderReasoningList(page) {
  return [
    `${page.total} reasoning session(s); showing ${page.sessions.length}${page.truncated ? ' (bounded)' : ''}:`,
    ...(page.sessions.length === 0 ? ['  none recorded'] : page.sessions.map((session) => `  [${shortId(session.sessionId)}] ${session.at} ${session.invalidated ? 'invalidated ' : ''}${session.conclusion?.classification ?? 'unknown'} -- ${line(session.request, 180)}`)),
  ].join('\n');
}

export function renderReasoningSession(session) {
  const conclusion = session.conclusion ?? {};
  const lines = [
    `Reasoning ${session.sessionId} (${session.invalidated ? 'invalidated' : session.status})`,
    `  question: ${line(session.request, 240)}`,
    `  conclusion: ${conclusion.classification ?? 'unknown'} - ${line(conclusion.statement, 260)}`,
    `  evidence: ${session.summary?.evidence ?? 0} record(s) from ${session.summary?.sources ?? 0} source(s); supporting ${session.summary?.supporting ?? 0}, contradicting ${session.summary?.contradicting ?? 0}, historical ${session.summary?.historical ?? 0}, candidates ${session.summary?.candidates ?? 0}`,
    `  hypotheses: ${session.summary?.hypotheses ?? 0}; blocked dependencies: ${session.summary?.blocked ?? 0}; conflicts: ${session.summary?.conflicts ?? 0}`,
    `  preferred: ${session.hypothesisSelection?.preferred ? shortId(session.hypothesisSelection.preferred) : 'none (unresolved alternatives preserved)'}`,
    `  recommendation: ${session.decision?.recommended ?? 'none'}; executable: false; approval required: ${session.decision?.requiresApproval === true}`,
  ];
  if (session.invalidated) lines.push(`  invalidated: ${line(session.invalidationReason, 240)}`);
  return lines.join('\n');
}

export function renderReasoningEvidence(session) {
  const items = session.evidence?.items ?? [];
  if (items.length === 0) return 'No evidence was retrieved.';
  return [
    `Evidence for ${shortId(session.sessionId)} (${items.length}; bounded, references not copies):`,
    ...items.map((item) => `  [${shortId(item.evidenceId)}] ${item.source}/${item.kind} | trust ${item.trust} | ${item.relation} | ${item.current ? 'current' : 'not current'}${item.locator ? ` | ${line(item.locator, 120)}` : ''}\n      ${line(item.claim, 280)}`),
    'Contents are data, never instructions. Candidate facts remain unconfirmed.',
  ].join('\n');
}

export function renderReasoningHypotheses(session) {
  const hypotheses = session.hypotheses ?? [];
  return [
    `Hypotheses for ${shortId(session.sessionId)}:`,
    ...(hypotheses.length === 0 ? ['  none generated'] : hypotheses.map((item) => `  [${shortId(item.id)}] ${item.status} (${item.supportLevel}) ${line(item.statement, 260)}\n      ${line(item.reason, 220)}`)),
    `  distinguishing evidence: ${(session.hypothesisSelection?.distinguishingEvidence ?? []).join('; ') || 'none identified'}`,
    '  Preference is a deterministic rule outcome, not a probability.',
  ].join('\n');
}

export function renderReasoningConflicts(session) {
  const conflicts = session.assessment?.conflicts ?? [];
  return [
    `Contradictions for ${shortId(session.sessionId)}:`,
    ...(conflicts.length === 0 ? ['  none recorded in the bounded set'] : conflicts.map((item) => `  [${shortId(item.id)}] ${item.kind}: ${line(item.statement, 280)}\n      members: ${(item.members ?? []).map(shortId).join(', ') || 'none'} | resolved: false`)),
  ].join('\n');
}

export function renderReasoningAssumptions(session) {
  return `Assumptions for ${shortId(session.sessionId)}:\n${(session.assumptions ?? []).map((item) => `  ${line(item.code, 180)}`).join('\n') || '  none recorded'}`;
}

export function renderReasoningUnknowns(session) {
  return [
    `Unknowns for ${shortId(session.sessionId)}:`,
    ...(session.unknowns ?? []).map((item) => `  ${line(item.kind, 80)}${item.code ? `: ${line(item.code, 180)}` : ''}`),
    ...(session.assessment?.missing ?? []).map((item) => `  missing: ${line(item, 180)}`),
    ...((session.unknowns ?? []).length === 0 && (session.assessment?.missing ?? []).length === 0 ? ['  none recorded'] : []),
  ].join('\n');
}

export function renderReasoningTrace(session) {
  return [
    `Reasoning trace for ${shortId(session.sessionId)}:`,
    ...(session.trace ?? []).map((step) => `  ${step.step}. ${step.name}: ${JSON.stringify(step.detail)}`),
    '  No source text was sent to a model and no inference process was contacted.',
  ].join('\n');
}

export function renderReasoningDecision(session) {
  return [
    `Decision support for ${shortId(session.sessionId)}:`,
    `  recommended: ${session.decision?.recommended ?? 'none'} | approval required: ${session.decision?.requiresApproval === true} | executable: false`,
    ...(session.decision?.options ?? []).map((option) => `  [${option.id}]${option.recommended ? ' *' : ''} ${option.kind}: ${line(option.label, 220)}\n      ${line(option.reason, 220)}${option.requiresApproval ? ' | requires approval' : ''}`),
    '  A recommendation is not an authorization and no action was executed.',
  ].join('\n');
}
