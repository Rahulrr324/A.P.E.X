// Council: deterministic multi-perspective decision architecture (T-26).
// Consumers existing evidence; never creates duplicate stores or metadata.
// Distinct deterministic evaluators with separate methods; disagreement preserved.
// No model inference; no fabricated agents; recommendations never authorize execution.
import { createHash } from 'node:crypto';

export const COUNCIL_SCHEMA = 'apex.council.v1';

// ---------------------------------------------------------------------------
// Decision objective
// ---------------------------------------------------------------------------

export function parseObjective(text) {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return { valid: false, error: 'objective is required' };
  }
  const clipped = text.trim().slice(0, 2000);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(clipped)) {
    return { valid: false, error: 'objective contains control characters' };
  }
  return { valid: true, objective: clipped };
}

// ---------------------------------------------------------------------------
// Evidence set consumed by the council
// ---------------------------------------------------------------------------

export function buildEvidenceSet({ evidence = [], now = () => new Date() }) {
  const items = Array.isArray(evidence) ? evidence : [];
  const byId = new Map(items.map((item) => [item.evidenceId, item]));
  const current = items.filter((item) => item.current !== false);
  const contradicting = items.filter((item) => item.relation === 'contradicting');
  const supporting = items.filter((item) => item.relation === 'supporting');
  const contextual = items.filter((item) => item.relation === 'contextual' || item.relation === 'historical');
  const bySource = new Map();
  for (const item of items) {
    const list = bySource.get(item.source) ?? [];
    list.push(item);
    bySource.set(item.source, list);
  }
  return {
    items,
    byId,
    current,
    contradicting,
    supporting,
    contextual,
    bySource,
    count: items.length,
    currentCount: current.length,
    nowIso: now().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Perspective: a named evaluator with declared inputs, method, assumptions,
// limitations, and a structured position.
// ---------------------------------------------------------------------------

export const PERSPECTIVES = Object.freeze([
  {
    id: 'objective_alignment',
    name: 'Objective alignment',
    description: 'How directly the candidate serves the stated objective.',
    requiredInputs: ['objective', 'candidate'],
    method: 'Compare the candidate step against the objective text for topical overlap, scope match and explicit success criteria. Does not judge feasibility or safety.',
    assumptions: ['The objective text is the owner intent, not an inference.'],
    limitations: ['Overlap is lexical and structural, not a measure of value.'],
  },
  {
    id: 'evidence_quality',
    name: 'Evidence quality',
    description: 'Strength and consistency of evidence behind the candidate or the objective.',
    requiredInputs: ['evidence', 'candidate'],
    method: 'Inspect trust class, currentness, relation, and contradiction links of relevant evidence items.',
    assumptions: ['A cited record is the evidence, not the surrounding prose.'],
    limitations: ['Quality of evidence is not quality of the conclusion.'],
  },
  {
    id: 'safety_policy',
    name: 'Safety and policy',
    description: 'Whether the candidate stays inside declared safety and policy boundaries.',
    requiredInputs: ['candidate', 'capability'],
    method: 'Check permission class, origin requirements, risk classification and whether the step is delegable or write-scoped.',
    assumptions: ['The action registry declaration is the policy source.'],
    limitations: ['Policy presence does not prove real-world safety.'],
  },
  {
    id: 'resource_feasibility',
    name: 'Resource feasibility',
    description: 'Whether the candidate is plausible given declared resource demand and scope.',
    requiredInputs: ['candidate', 'capability', 'resourceContext'],
    method: 'Inspect declared resource demand, resource scope, and any available resource context.',
    assumptions: ['Declared demand is representative of the step.'],
    limitations: ['Declared demand is not measured consumption.'],
  },
  {
    id: 'operational_reliability',
    name: 'Operational reliability',
    description: 'How the candidate behaves under interruption, uncertainty and verification.',
    requiredInputs: ['candidate', 'taskRecord'],
    method: 'Inspect task/step status, verification state, continuation readiness and uncertainty markers.',
    assumptions: ['Recorded states are accurate.'],
    limitations: ['A recorded status is not a prediction of success.'],
  },
  {
    id: 'temporal_consequences',
    name: 'Temporal consequences',
    description: 'Ordering, deadlines, validity windows and sequencing effects.',
    requiredInputs: ['objective', 'evidence', 'candidate'],
    method: 'Inspect valid-from/until, observed/recorded times, deadlines, and temporal evidence state.',
    assumptions: ['Timestamps are trustworthy.'],
    limitations: ['Time data is only as good as its source record.'],
  },
  {
    id: 'long_term_implications',
    name: 'Long-term implications',
    description: 'Structural effects on future work: dependencies, irreversibility, scope growth.',
    requiredInputs: ['candidate', 'capability', 'taskRecord'],
    method: 'Inspect side-effect class, reversibility, dependency footprint and whether the step appends vs. reads.',
    assumptions: ['Declared side effects are accurate.'],
    limitations: ['Declared effects are not a forecast of consequences.'],
  },
]);

// ---------------------------------------------------------------------------
// Evaluator results
// ---------------------------------------------------------------------------

export function evaluatePerspective(perspective, input) {
  const required = new Set(perspective.requiredInputs);
  const provided = new Set(Object.keys(input));
  const missing = [...required].filter((k) => !provided.has(k));
  if (missing.length > 0) {
    return {
      perspectiveId: perspective.id,
      perspectiveName: perspective.name,
      status: 'insufficient_input',
      missing,
      position: null,
      assumptions: perspective.assumptions.slice(),
      limitations: perspective.limitations.slice(),
      method: perspective.method,
    };
  }
  const result = evaluateOne(perspective, input);
  return {
    perspectiveId: perspective.id,
    perspectiveName: perspective.name,
    status: result.status,
    position: result.position,
    assumptions: perspective.assumptions.slice(),
    limitations: perspective.limitations.slice(),
    method: perspective.method,
    notes: result.notes ?? [],
  };
}

// ---------------------------------------------------------------------------
// Distinct deterministic evaluators
// ---------------------------------------------------------------------------

function evaluateOne(perspective, input) {
  switch (perspective.id) {
    case 'objective_alignment': return evalObjectiveAlignment(input);
    case 'evidence_quality': return evalEvidenceQuality(input);
    case 'safety_policy': return evalSafetyPolicy(input);
    case 'resource_feasibility': return evalResourceFeasibility(input);
    case 'operational_reliability': return evalOperationalReliability(input);
    case 'temporal_consequences': return evalTemporalConsequences(input);
    case 'long_term_implications': return evalLongTermImplications(input);
    default: return { status: 'unknown_perspective', position: null, notes: ['unknown perspective'] };
  }
}

function evalObjectiveAlignment({ objective, candidate }) {
  const text = (objective?.text ?? objective ?? '').toString().toLowerCase();
  const candText = [(candidate?.description ?? candidate?.action ?? candidate ?? '').toString()].flat().join(' ').toLowerCase();
  const tokens = tokenize(text);
  const overlap = tokens.filter((t) => candText.includes(t));
  const exactPhrase = text.includes(candText) || candText.includes(text);
  const score = tokens.length === 0 ? 0 : overlap.length / tokens.length;
  let verdict;
  if (tokens.length === 0) verdict = 'undetermined';
  else if (score >= 0.6 || exactPhrase) verdict = 'strong_alignment';
  else if (score >= 0.3) verdict = 'partial_alignment';
  else verdict = 'weak_alignment';
  return {
    status: 'position',
    position: {
      verdict,
      evidence: [
        { kind: 'overlap', detail: `${overlap.length}/${tokens.length} objective tokens appear in the candidate` },
        { kind: 'phrase', detail: exactPhrase ? 'an objective phrase appears in the candidate' : 'no full phrase match' },
      ],
      assumptions: ['objective text is the reference intent'],
      uncertainty: tokens.length === 0 ? 'no objective terms to compare' : null,
    },
  };
}

function evalEvidenceQuality({ evidence, candidate }) {
  const set = buildEvidenceSet({ evidence });
  const relevant = set.items.filter((item) => {
    const hay = [item.claim, item.source, item.kind, item.recordId].join(' ').toLowerCase();
    const cand = [(candidate?.description ?? candidate?.action ?? '').toString()].flat().join(' ').toLowerCase();
    return hay.includes(cand) || cand.includes(hay);
  });
  const currentRelevant = relevant.filter((item) => item.current !== false);
  const contradictingRelevant = relevant.filter((item) => item.relation === 'contradicting');
  const supportingRelevant = relevant.filter((item) => item.relation === 'supporting');
  const trustCounts = new Map();
  for (const item of relevant) {
    trustCounts.set(item.trust, (trustCounts.get(item.trust) ?? 0) + 1);
  }
  let verdict;
  if (relevant.length === 0) verdict = 'no_relevant_evidence';
  else if (contradictingRelevant.length > 0 && supportingRelevant.length === 0) verdict = 'contradicted';
  else if (currentRelevant.length === 0) verdict = 'no_current_evidence';
  else if (!trustCounts.has('user_statement') && !trustCounts.has('user_confirmed') && !trustCounts.has('operational_record') && !trustCounts.has('outcome')) verdict = 'weak_trust';
  else if (contradictingRelevant.length > 0) verdict = 'mixed';
  else verdict = 'adequate';
  return {
    status: 'position',
    position: {
      verdict,
      evidence: [
        { kind: 'relevant_count', detail: `${relevant.length} relevant evidence items` },
        { kind: 'current_count', detail: `${currentRelevant.length} current` },
        { kind: 'contradicting_count', detail: `${contradictingRelevant.length} contradicting` },
        { kind: 'trust_distribution', detail: [...trustCounts.entries()].map(([k, v]) => `${k}: ${v}`).join('; ') || 'none' },
      ],
      assumptions: ['relevance is lexical'],
      uncertainty: relevant.length === 0 ? 'no relevant evidence retrieved' : null,
    },
  };
}

function evalSafetyPolicy({ candidate, capability }) {
  const def = capability ?? null;
  if (!def) {
    return { status: 'position', position: { verdict: 'unknown_capability', evidence: [{ kind: 'declaration', detail: 'no capability declaration provided' }] } };
  }
  const permission = def.permission ?? 'unknown';
  const origins = Array.isArray(def.origins) ? def.origins : [];
  const risk = def.risk ?? 'unknown';
  const delegable = def.delegable === true;
  const issues = [];
  if (permission === 'write' && !origins.includes('user')) issues.push('write action origin policy unclear');
  if (risk === 'high') issues.push('high risk classification');
  if (!delegable && permission === 'write') issues.push('write action is not delegable');
  let verdict;
  if (issues.length === 0) verdict = 'within_policy';
  else if (risk === 'high') verdict = 'risk_flag';
  else verdict = 'policy_note';
  return {
    status: 'position',
    position: {
      verdict,
      evidence: [
        { kind: 'permission', detail: permission },
        { kind: 'origins', detail: origins.join(',') },
        { kind: 'risk', detail: risk },
        { kind: 'delegable', detail: String(delegable) },
        ...issues.map((i) => ({ kind: 'issue', detail: i })),
      ],
      assumptions: ['registry declaration is current'],
      uncertainty: def.permission === undefined ? 'declaration incomplete' : null,
    },
  };
}

function evalResourceFeasibility({ candidate, capability, resourceContext }) {
  const def = capability ?? null;
  const demand = (def && def.resourceDemand) ? def.resourceDemand : null;
  const scope = (def && def.resourceScope) ? def.resourceScope : null;
  const ctx = resourceContext ?? null;
  const notes = [];
  if (!demand) notes.push('no declared resource demand');
  if (scope) notes.push(`declared scope: ${scope}`);
  if (ctx && typeof ctx === 'object') {
    for (const key of ['cpuMillis', 'memoryBytes', 'storageBytes']) {
      if (ctx[key] != null) notes.push(`context ${key}: ${ctx[key]}`);
    }
  }
  let verdict = 'declared_only';
  if (!demand) verdict = 'undetermined';
  return {
    status: 'position',
    position: {
      verdict,
      evidence: [
        { kind: 'demand', detail: demand ? JSON.stringify(demand) : 'none declared' },
        { kind: 'scope', detail: scope ?? 'none declared' },
        { kind: 'context', detail: ctx ? 'available' : 'none provided' },
      ],
      assumptions: ['declared demand is representative'],
      uncertainty: !demand ? 'no demand information' : null,
    },
  };
}

function evalOperationalReliability({ candidate, taskRecord }) {
  const task = taskRecord ?? null;
  const steps = Array.isArray(task?.steps) ? task.steps : [];
  const running = steps.filter((s) => s && (s.status === 'running' || s.status === 'pending'));
  const completed = steps.filter((s) => s && s.status === 'completed');
  const failed = steps.filter((s) => s && s.status === 'failed');
  const uncertain = steps.filter((s) => s && s.status === 'uncertain');
  const awaiting = steps.filter((s) => s && (s.status === 'awaiting_approval' || s.approval));
  let verdict;
  if (!task) verdict = 'no_record';
  else if (failed.length > 0) verdict = 'has_failures';
  else if (uncertain.length > 0) verdict = 'has_uncertainty';
  else if (awaiting.length > 0) verdict = 'awaiting_confirmation';
  else if (running.length > 0) verdict = 'in_flight';
  else if (completed.length > 0) verdict = 'completed_steps';
  else verdict = 'no_execution_record';
  return {
    status: 'position',
    position: {
      verdict,
      evidence: [
        { kind: 'step_count', detail: `${steps.length} steps` },
        { kind: 'completed', detail: `${completed.length} completed` },
        { kind: 'failed', detail: `${failed.length} failed` },
        { kind: 'uncertain', detail: `${uncertain.length} uncertain` },
        { kind: 'awaiting', detail: `${awaiting.length} awaiting` },
        { kind: 'running', detail: `${running.length} running` },
      ],
      assumptions: ['recorded states are accurate'],
      uncertainty: uncertain.length > 0 ? 'uncertain side effects present' : null,
    },
  };
}

function evalTemporalConsequences({ objective, evidence, candidate }) {
  const set = buildEvidenceSet({ evidence });
  const now = set.nowIso;
  const timeSensitive = set.items.filter((item) => item.validFrom || item.validUntil || item.observedAt);
  const futureItems = set.items.filter((item) => item.validity === 'not_yet_valid' || (item.validUntil && item.validUntil > now));
  const expiredItems = set.items.filter((item) => item.validity === 'expired' || (item.validFrom && item.validFrom > now));
  let verdict = 'no_temporal_signal';
  if (futureItems.length > 0 && expiredItems.length === 0) verdict = 'future_weighted';
  else if (expiredItems.length > 0) verdict = 'expired_evidence_present';
  else if (timeSensitive.length > 0) verdict = 'temporal_context_present';
  return {
    status: 'position',
    position: {
      verdict,
      evidence: [
        { kind: 'time_sensitive_count', detail: `${timeSensitive.length} time-bearing items` },
        { kind: 'future_count', detail: `${futureItems.length} not-yet-valid/future` },
        { kind: 'expired_count', detail: `${expiredItems.length} expired/past` },
      ],
      assumptions: ['timestamps are trustworthy'],
      uncertainty: timeSensitive.length === 0 ? 'no temporal evidence' : null,
    },
  };
}

function evalLongTermImplications({ candidate, capability, taskRecord }) {
  const def = capability ?? null;
  const sideEffect = def?.sideEffect ?? 'unknown';
  const reversibility = def?.reversibility ?? 'unknown';
  const task = taskRecord ?? null;
  const dependents = Array.isArray(task?.dependents) ? task.dependents.length : 0;
  let verdict = 'neutral';
  const notes = [];
  if (sideEffect === 'append' && reversibility === 'correctable') notes.push('append-only, correctable');
  if (sideEffect === 'none') notes.push('read-only, no persistent effect');
  if (dependents > 0) notes.push(`${dependents} dependent steps`);
  if (sideEffect !== 'none' && reversibility !== 'correctable') notes.push('non-correctable effect');
  if (notes.length === 0) verdict = 'undetermined';
  return {
    status: 'position',
    position: {
      verdict,
      evidence: [
        { kind: 'sideEffect', detail: sideEffect },
        { kind: 'reversibility', detail: reversibility },
        { kind: 'dependents', detail: String(dependents) },
      ],
      assumptions: ['declared effects are accurate'],
      uncertainty: sideEffect === 'unknown' ? 'effect class unknown' : null,
    },
  };
}

// ---------------------------------------------------------------------------
// Disagreement classification
// ---------------------------------------------------------------------------

export const DISAGREEMENT_KIND = Object.freeze({
  AGREEMENT: 'agreement',
  PARTIAL_AGREEMENT: 'partial_agreement',
  CONTRADICTION: 'contradiction',
  INSUFFICIENT_EVIDENCE: 'insufficient_evidence',
  INCOMPATIBLE_OBJECTIVES: 'incompatible_objectives',
  RISK_DISAGREEMENT: 'risk_disagreement',
  RESOURCE_DISAGREEMENT: 'resource_disagreement',
  NO_POSITIONS: 'no_positions',
});

export function classifyDisagreement(positions) {
  const withPosition = positions.filter((p) => p.status === 'position' && p.position);
  if (withPosition.length === 0) return { kind: DISAGREEMENT_KIND.NO_POSITIONS, detail: 'no evaluator produced a position' };
  const verdicts = withPosition.map((p) => p.position.verdict);
  const unique = new Set(verdicts);
  if (unique.size === 1) {
    const v = verdicts[0];
    if (v === 'no_relevant_evidence' || v === 'no_current_evidence' || v === 'no_relevant_evidence') {
      return { kind: DISAGREEMENT_KIND.INSUFFICIENT_EVIDENCE, detail: `all evaluators report ${v}` };
    }
    if (v === 'undetermined' || v === 'declared_only' || v === 'no_temporal_signal') {
      return { kind: DISAGREEMENT_KIND.INSUFFICIENT_EVIDENCE, detail: 'positions exist but are inconclusive' };
    }
    return { kind: DISAGREEMENT_KIND.AGREEMENT, detail: `all evaluators report ${v}` };
  }
  const hasRisk = [...unique].some((v) => v === 'risk_flag' || v === 'has_failures');
  const hasFeasibility = [...unique].some((v) => v === 'undetermined' || v === 'no_relevant_evidence');
  if (hasRisk && hasFeasibility) return { kind: DISAGREEMENT_KIND.RISK_DISAGREEMENT, detail: 'risk and feasibility positions diverge' };
  if ([...unique].some((v) => v === 'contradicted' || v === 'mixed')) return { kind: DISAGREEMENT_KIND.CONTRADICTION, detail: 'evidence or conclusions contradict' };
  return { kind: DISAGREEMENT_KIND.PARTIAL_AGREEMENT, detail: `evaluators diverge across ${unique.size} distinct verdicts` };
}

// ---------------------------------------------------------------------------
// Synthesis
// ---------------------------------------------------------------------------

export function synthesize({ objective, positions, disagreement, evidence, candidate }) {
  const positionsOut = positions.map((p) => ({
    perspectiveId: p.perspectiveId,
    perspectiveName: p.perspectiveName,
    status: p.status,
    position: p.position ?? null,
    assumptions: p.assumptions,
    limitations: p.limitations,
    method: p.method,
    notes: p.notes ?? [],
  }));
  const recommendation = buildRecommendation({ positions, disagreement, evidence, candidate });
  const alternatives = buildAlternatives({ positions, disagreement, evidence, candidate });
  return {
    schema: COUNCIL_SCHEMA,
    objective: objective?.text ?? objective ?? null,
    decisionObjective: objective ? { text: objective.text, parsed: objective.valid } : null,
    evidence: {
      count: evidence.count,
      currentCount: evidence.currentCount,
      contradictingCount: evidence.contradicting.length,
      sources: [...evidence.bySource.keys()],
    },
    disagreement: {
      kind: disagreement.kind,
      detail: disagreement.detail,
    },
    positions: positionsOut,
    synthesis: {
      recommendedOption: recommendation,
      alternatives: alternatives,
      evidenceSummary: summarizeEvidence(evidence),
      risks: extractRisks(positions),
      assumptions: extractAssumptions(positions),
      unknowns: extractUnknowns(positions),
      requiredApprovals: requiredApprovalsFor(positions, candidate),
      reversibility: extractReversibility(positions, candidate),
      expectedVerification: expectedVerification(positions),
      rejectedAlternatives: reasonsForRejection(positions, alternatives),
    },
    authorizesExecution: false,
    note: 'Council output is deliberation data. It does not authorize, execute, or modify any store. All consequential actions still pass through the Executive Control Plane.',
  };
}

function buildRecommendation({ positions, disagreement, evidence, candidate }) {
  const alignment = positions.find((p) => p.perspectiveId === 'objective_alignment');
  const evidenceQ = positions.find((p) => p.perspectiveId === 'evidence_quality');
  const safety = positions.find((p) => p.perspectiveId === 'safety_policy');
  const reliability = positions.find((p) => p.perspectiveId === 'operational_reliability');
  const riskPositions = [safety, reliability].filter(Boolean);
  const highRisk = riskPositions.some((p) => p?.position?.verdict === 'risk_flag' || p?.position?.verdict === 'has_failures');
  const insufficient = disagreement.kind === DISAGREEMENT_KIND.INSUFFICIENT_EVIDENCE;
  let level;
  if (insufficient) level = 'defer';
  else if (highRisk) level = 'review_required';
  else if (alignment?.position?.verdict === 'strong_alignment' && evidenceQ?.position?.verdict === 'adequate' && safety?.position?.verdict === 'within_policy') level = 'supported';
  else if (alignment?.position?.verdict === 'partial_alignment') level = 'conditional';
  else level = 'weak';
  return {
    level,
    summary: summarizeRecommendation(level, disagreement),
    requiresAuthorization: true,
    detail: {
      objectiveAlignment: alignment?.position?.verdict ?? 'unknown',
      evidenceQuality: evidenceQ?.position?.verdict ?? 'unknown',
      safetyPolicy: safety?.position?.verdict ?? 'unknown',
      operationalReliability: reliability?.position?.verdict ?? 'unknown',
    },
    actionNote: 'no action is taken. Present this synthesis for review; any execution requires explicit authorization through the Executive Control Plane.',
  };
}

function buildAlternatives({ positions, disagreement, evidence, candidate }) {
  return [
    {
      option: 'proceed_with_review',
      when: 'alignment is partial and evidence is adequate',
      from: 'objective_alignment + evidence_quality',
    },
    {
      option: 'do_not_proceed',
      when: 'safety or reliability flags are present',
      from: 'safety_policy + operational_reliability',
    },
    {
      option: 'gather_more_evidence',
      when: 'evidence quality is weak or contradictory',
      from: 'evidence_quality',
    },
    {
      option: 'defer_decision',
      when: 'insufficient input or inconclusive positions',
      from: 'disagreement classification',
    },
  ];
}

function summarizeEvidence(evidence) {
  return {
    total: evidence.count,
    current: evidence.currentCount,
    contradicting: evidence.contradictingCount,
    bySource: [...evidence.bySource.entries()].map(([source, items]) => ({ source, count: items.length })),
  };
}

function extractRisks(positions) {
  const risks = new Set();
  for (const p of positions) {
    if (p.position?.verdict === 'risk_flag') risks.add(`${p.perspectiveName}: risk flag`);
    if (p.position?.verdict === 'has_failures') risks.add(`${p.perspectiveName}: prior failures`);
    if (p.position?.verdict === 'has_uncertainty') risks.add(`${p.perspectiveName}: uncertain effects`);
  }
  return [...risks];
}

function extractAssumptions(positions) {
  const out = new Map();
  for (const p of positions) {
    for (const a of p.assumptions) out.set(a, true);
  }
  return [...out.keys()];
}

function extractUnknowns(positions) {
  const out = new Map();
  for (const p of positions) {
    if (p.position?.uncertainty) out.set(p.position.uncertainty, true);
    for (const n of (p.notes ?? [])) { if (n.startsWith('unknown')) out.set(n, true); }
  }
  return [...out.keys()];
}

function requiredApprovalsFor(positions, candidate) {
  const safety = positions.find((p) => p.perspectiveId === 'safety_policy');
  const verdict = safety?.position?.verdict;
  if (verdict === 'risk_flag' || verdict === 'has_failures') return ['explicit_user_review_before_any_execution'];
  if (verdict === 'policy_note') return ['user_review'];
  return ['user_authorization_for_execution'];
}

function extractReversibility(positions, candidate) {
  const lt = positions.find((p) => p.perspectiveId === 'long_term_implications');
  return lt?.position?.verdict === 'neutral' ? 'likely correctable by later record; not erasable' : 'depends on declared side effects';
}

function expectedVerification(positions) {
  return [
    'independent verifier re-reads the relevant store after execution',
    'recorded outcome must be success_verified, not merely claimed',
    'any uncertain step must be resolved before treated as done',
  ];
}

function reasonsForRejection(positions, alternatives) {
  const safety = positions.find((p) => p.perspectiveId === 'safety_policy');
  const reliability = positions.find((p) => p.perspectiveId === 'operational_reliability');
  const out = [];
  if (safety?.position?.verdict === 'risk_flag') out.push({ alternative: 'proceed_with_review', reason: 'risk flag from safety perspective' });
  if (reliability?.position?.verdict === 'has_failures') out.push({ alternative: 'proceed_with_review', reason: 'prior failed steps' });
  if (safety?.position?.verdict === 'unknown_capability') out.push({ alternative: 'proceed_with_review', reason: 'capability declaration unknown' });
  return out;
}

function summarizeRecommendation(level, disagreement) {
  switch (level) {
    case 'supported': return 'Council finds the option aligned with the objective, supported by adequate current evidence, and within declared policy. Execution still requires explicit authorization.';
    case 'conditional': return 'Council finds partial alignment. The option may fit the objective but is not clearly supported across all perspectives; review before execution.';
    case 'weak': return 'Council does not find strong support across enough perspectives to recommend starting. Review objective, evidence, or both.';
    case 'review_required': return 'Council flags risk or reliability concerns. Do not proceed without explicit review and authorization.';
    case 'defer': return 'Council does not have enough input or conclusive positions to recommend. Clarify the objective or supply missing evidence before deciding.';
    default: return 'Council could not reach a recommending position.';
  }
}

// ---------------------------------------------------------------------------
// Session persistence (append-only, metadata only)
// ---------------------------------------------------------------------------

export function createCouncilSession({ objective, decisionId, now = () => new Date() }) {
  return {
    schema: COUNCIL_SCHEMA,
    kind: 'session',
    sessionId: decisionId ?? `council-${createHash('sha256').update(String(now()) + String(Math.random())).digest('hex').slice(0, 12)}`,
    objective: objective.text,
    at: now().toISOString(),
    status: 'prepared',
    authorizesExecution: false,
  };
}

export async function appendCouncilSession(store, session) {
  if (!store || typeof store.append !== 'function') return { saved: false, reason: 'no session store' };
  await store.append(session);
  return { saved: true };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function tokenize(text) {
  const raw = String(text).toLowerCase().match(/[a-z0-9][a-z0-9._-]{2,}/g) ?? [];
  const stop = new Set(['the','and','for','with','that','this','from','what','when','where','which','who','why','how','does','did','are','was','were','has','have','had','into','about','our','you','your','can','could','should','would','there','their','then','than','not','but','use','using','project','current','currently','please','tell','give','any','all']);
  return raw.filter((t) => !stop.has(t) && t.length >= 3).slice(0, 40);
}
