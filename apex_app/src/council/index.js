// Council: deterministic multi-perspective decision architecture (T-26).
//
// The Council consumes evidence that other owners already produced. It does not create a
// second evidence store, a second memory, a planner, or an authorization path. Evidence
// references point back at the authoritative record (`source` + `recordId`) so a reader can
// verify a claim instead of trusting this module.
//
// Every perspective is a separate deterministic function with its own verdict vocabulary,
// declared inputs and declared limitations. They are not the same rule with different labels:
//   objective alignment  - token/scope overlap with the stated objective
//   evidence quality     - trust class, currentness, relation and source diversity
//   safety and policy    - registry permission/origin/risk/reversibility declaration
//   resource feasibility - declared demand vs declared capacity (never measured by guessing)
//   operational reliability - task/step state, failures, uncertainty and verification
//   temporal consequences - validity windows and staleness against the evaluation time
//   long-term implications - side-effect class, reversibility and dependents
//
// No model inference is performed. A Council synthesis never authorizes execution: all
// consequential actions still pass through the Executive Control Plane.
import { createHash } from 'node:crypto';

export const COUNCIL_SCHEMA = 'apex.council.v1';
export const COUNCIL_SCHEMA_VERSION = 1;

export const MAX_OBJECTIVE_CHARS = 2000;
export const MAX_EVIDENCE_ITEMS = 40;
export const MAX_CLAIM_CHARS = 500;
export const MAX_CANDIDATE_ID_CHARS = 128;

export const EVIDENCE_RELATIONS = Object.freeze([
  'supporting', 'contradicting', 'contextual', 'historical', 'insufficient',
]);

// Trust classes, strongest first. `derived` and `candidate` never settle a question alone.
export const TRUST_CLASSES = Object.freeze([
  'user_confirmed', 'operational_record', 'outcome', 'user_statement', 'authorized_document', 'document',
  'external_observation', 'world_model', 'derived', 'candidate', 'unknown',
]);

export const SUPPORT_LEVELS = Object.freeze(['supported', 'tentative', 'unsupported']);

const TRUST_RANK = new Map(TRUST_CLASSES.map((t, i) => [t, TRUST_CLASSES.length - i]));
const SETTLING_TRUST = new Set([
  'user_confirmed', 'operational_record', 'outcome', 'user_statement',
  'authorized_document', 'document', 'external_observation', 'world_model',
]);

// ---------------------------------------------------------------------------
// Small deterministic helpers
// ---------------------------------------------------------------------------

export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

export function digestOf(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function cleanText(value, max = MAX_CLAIM_CHARS) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function isoOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function tokenize(text) {
  const raw = String(text).toLowerCase().match(/[a-z0-9][a-z0-9._-]{2,}/g) ?? [];
  const stop = new Set([
    'the', 'and', 'for', 'with', 'that', 'this', 'from', 'what', 'when', 'where', 'which', 'who',
    'why', 'how', 'does', 'did', 'are', 'was', 'were', 'has', 'have', 'had', 'into', 'about', 'our',
    'you', 'your', 'can', 'could', 'should', 'would', 'there', 'their', 'then', 'than', 'not', 'but',
    'use', 'using', 'project', 'current', 'currently', 'please', 'tell', 'give', 'any', 'all',
  ]);
  return [...new Set(raw.filter((t) => !stop.has(t) && t.length >= 3))].slice(0, 40);
}

// ---------------------------------------------------------------------------
// Decision objective
// ---------------------------------------------------------------------------

export function parseObjective(text) {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return { valid: false, error: 'objective is required' };
  }
  const clipped = text.trim().slice(0, MAX_OBJECTIVE_CHARS);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(clipped)) {
    return { valid: false, error: 'objective contains control characters' };
  }
  return { valid: true, objective: clipped };
}

// ---------------------------------------------------------------------------
// Evidence set consumed by the council
// ---------------------------------------------------------------------------

export function normalizeEvidenceItem(raw, { now = () => new Date() } = {}) {
  const at = now();
  const evidenceId = cleanText(raw?.evidenceId, 120);
  if (evidenceId.length === 0) return null;
  const relation = EVIDENCE_RELATIONS.includes(raw?.relation) ? raw.relation : 'contextual';
  const trust = TRUST_CLASSES.includes(raw?.trust) ? raw.trust : 'unknown';
  const current = raw?.current !== false;
  return {
    evidenceId,
    source: cleanText(raw?.source, 80) || 'unspecified',
    recordId: raw?.recordId === undefined || raw?.recordId === null ? null : cleanText(raw.recordId, 160),
    claim: cleanText(raw?.claim, MAX_CLAIM_CHARS),
    trust,
    relation,
    current,
    validity: raw?.validity ?? null,
    observedAt: isoOrNull(raw?.observedAt ?? raw?.createdAt),
    validFrom: isoOrNull(raw?.validFrom),
    validUntil: isoOrNull(raw?.validUntil),
    provenance: raw?.provenance === undefined || raw?.provenance === null ? null : cleanText(raw.provenance, 200),
    evaluatedAt: at.toISOString(),
  };
}

export function buildEvidenceSet({ evidence = [], now = () => new Date() } = {}) {
  const raw = Array.isArray(evidence) ? evidence.slice(0, MAX_EVIDENCE_ITEMS) : [];
  const items = [];
  const duplicates = [];
  const seen = new Set();
  for (const entry of raw) {
    const item = normalizeEvidenceItem(entry, { now });
    if (!item) continue;
    if (seen.has(item.evidenceId)) {
      duplicates.push(item.evidenceId);
      continue;
    }
    seen.add(item.evidenceId);
    items.push(item);
  }
  const byId = new Map(items.map((item) => [item.evidenceId, item]));
  const byRelation = new Map(EVIDENCE_RELATIONS.map((relation) => [relation, []]));
  const bySource = new Map();
  for (const item of items) {
    byRelation.get(item.relation).push(item);
    const list = bySource.get(item.source) ?? [];
    list.push(item);
    bySource.set(item.source, list);
  }
  const current = items.filter((item) => item.current);
  const contradicting = byRelation.get('contradicting');
  const supporting = byRelation.get('supporting');
  return {
    items,
    byId,
    byRelation,
    bySource,
    current,
    contradicting,
    supporting,
    contextual: [...byRelation.get('contextual'), ...byRelation.get('historical')],
    historical: byRelation.get('historical'),
    insufficient: byRelation.get('insufficient'),
    duplicates,
    count: items.length,
    currentCount: current.length,
    nowIso: now().toISOString(),
  };
}

// Bounded, citable summary kept in a session. The full claim text stays in its owner store.
export function evidenceReferences(evidenceSet) {
  return evidenceSet.items.map((item) => ({
    evidenceId: item.evidenceId,
    source: item.source,
    recordId: item.recordId,
    claim: item.claim,
    trust: item.trust,
    relation: item.relation,
    current: item.current,
    validity: item.validity,
    validFrom: item.validFrom,
    validUntil: item.validUntil,
    observedAt: item.observedAt,
  }));
}

// ---------------------------------------------------------------------------
// Perspective declarations: contract, inputs, method, assumptions, limitations.
// ---------------------------------------------------------------------------

export const PERSPECTIVES = Object.freeze([
  {
    id: 'objective_alignment',
    name: 'Objective alignment',
    description: 'How directly the candidate serves the stated objective.',
    requiredInputs: ['objective', 'candidate'],
    method: 'Tokenise the objective and compare it with the candidate action/description; report overlap and scope match. Does not judge feasibility or safety.',
    assumptions: ['The objective text is owner intent, not an inference.'],
    limitations: ['Overlap is lexical and structural, not a measure of value or of the owner\'s actual priority.'],
  },
  {
    id: 'evidence_quality',
    name: 'Evidence quality',
    description: 'Strength, currentness and consistency of the evidence behind the candidate or the objective.',
    requiredInputs: ['evidence', 'candidate'],
    method: 'Group cited evidence by relation and trust class, count current/historical/contradicting items and distinct sources. Relevance is lexical; a cited record is the evidence, not surrounding prose.',
    assumptions: ['Each cited record exists in the source store it names.'],
    limitations: ['Evidence quality is not the quality of the conclusion, and lexical relevance can miss paraphrase.'],
  },
  {
    id: 'safety_policy',
    name: 'Safety and policy',
    description: 'Whether the candidate stays inside the declared capability policy.',
    requiredInputs: ['candidate', 'capability'],
    method: 'Read the registry declaration: permission class, allowed origins, risk, delegability and reversibility. Unknown declarations are reported as unknown, never assumed safe.',
    assumptions: ['The action registry declaration is the policy source.'],
    limitations: ['A declaration does not prove real-world safety, and this evaluator cannot inspect external side effects.'],
  },
  {
    id: 'resource_feasibility',
    name: 'Resource feasibility',
    description: 'Whether declared resource demand fits declared capacity.',
    requiredInputs: ['candidate', 'capability', 'resourceContext'],
    method: 'Compare declared demand with a supplied capacity figure when one exists. With no capacity figure it reports declared-only; it never invents a measurement.',
    assumptions: ['Declared demand is representative of the step.'],
    limitations: ['Declared demand is not measured consumption, and missing capacity is unknown rather than infinite.'],
  },
  {
    id: 'operational_reliability',
    name: 'Operational reliability',
    description: 'How the candidate has behaved under execution, interruption and verification.',
    requiredInputs: ['candidate', 'taskRecord'],
    method: 'Inspect recorded task/step statuses, failures, uncertain steps, pending approvals and verification results. Absence of a record is not evidence of success.',
    assumptions: ['Recorded states are accurate at the time they were written.'],
    limitations: ['A recorded status is not a prediction that the next attempt will succeed.'],
  },
  {
    id: 'temporal_consequences',
    name: 'Temporal consequences',
    description: 'Validity windows, staleness, ordering and deadline effects.',
    requiredInputs: ['objective', 'evidence', 'candidate'],
    method: 'Compare validFrom/validUntil/observedAt with the evaluation time and read any recorded deadline. Old evidence stays labelled stale; it is not silently dropped.',
    assumptions: ['Timestamps are trustworthy.'],
    limitations: ['Time data is only as good as its source record, and a future window is not a guarantee.'],
  },
  {
    id: 'long_term_implications',
    name: 'Long-term implications',
    description: 'Structural effects on future work: side effects, reversibility and dependents.',
    requiredInputs: ['candidate', 'capability', 'taskRecord'],
    method: 'Read the declared side-effect class and reversibility, then add the recorded dependent count. It cannot forecast consequences beyond the declaration.',
    assumptions: ['Declared side effects are accurate.'],
    limitations: ['Declared effects are not a forecast, and dependents may be incomplete.'],
  },
]);

// ---------------------------------------------------------------------------
// Evaluator results
// ---------------------------------------------------------------------------

export function evaluatePerspective(perspective, input = {}) {
  const provided = new Set(Object.keys(input).filter((key) => input[key] !== undefined));
  const missing = perspective.requiredInputs.filter((key) => !provided.has(key));
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
      notes: [`missing input: ${missing.join(', ')}`],
    };
  }
  const result = evaluateOne(perspective, input);
  return {
    perspectiveId: perspective.id,
    perspectiveName: perspective.name,
    status: result.status ?? 'position',
    position: result.position ?? null,
    assumptions: perspective.assumptions.slice(),
    limitations: perspective.limitations.slice(),
    method: perspective.method,
    notes: result.notes ?? [],
  };
}

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

function candidateText(candidate) {
  if (!candidate) return '';
  if (typeof candidate === 'string') return candidate;
  return [candidate.id, candidate.action, candidate.description, candidate.step, candidate.title]
    .filter((value) => typeof value === 'string').join(' ');
}

function evalObjectiveAlignment({ objective, candidate }) {
  const objectiveText = typeof objective === 'string' ? objective : String(objective?.text ?? '');
  const objTokens = tokenize(objectiveText);
  const candText = candidateText(candidate).toLowerCase();
  if (objTokens.length === 0) {
    return {
      status: 'position',
      position: {
        verdict: 'undetermined', summary: 'The objective has no comparable terms.',
        evidence: [], assumptions: ['objective text is the reference intent'],
        uncertainty: 'no objective terms to compare',
      },
    };
  }
  if (!candidate) {
    // No candidate: the objective itself is the only subject. This is deliberately not "aligned".
    return {
      status: 'position',
      position: {
        verdict: 'no_candidate', summary: 'No candidate was supplied, so alignment cannot be attributed.',
        evidence: [{ kind: 'objective_terms', detail: `${objTokens.length} comparable objective terms` }],
        assumptions: ['objective text is the reference intent'],
        uncertainty: 'candidate is missing',
      },
    };
  }
  const overlap = objTokens.filter((token) => candText.includes(token));
  const exactPhrase = candText.length > 0 && (objectiveText.toLowerCase().includes(candText) || candText.includes(objectiveText.toLowerCase()));
  const score = overlap.length / objTokens.length;
  const verdict = (score >= 0.6 || exactPhrase) ? 'strong_alignment'
    : score >= 0.3 ? 'partial_alignment' : 'weak_alignment';
  return {
    status: 'position',
    position: {
      verdict,
      summary: `${overlap.length} of ${objTokens.length} objective terms appear in the candidate${exactPhrase ? '; full phrase match' : ''}.`,
      evidence: [
        { kind: 'overlap', detail: `${overlap.length}/${objTokens.length} objective tokens appear in the candidate` },
        { kind: 'overlap_terms', detail: overlap.slice(0, 12).join(', ') || 'none' },
        { kind: 'phrase', detail: exactPhrase ? 'an objective phrase appears in the candidate' : 'no full phrase match' },
      ],
      assumptions: ['objective text is the reference intent'],
      uncertainty: score < 0.3 ? 'alignment rests on very little shared vocabulary' : null,
    },
  };
}

function isRelevant(item, tokens, candText) {
  const hay = [item.claim, item.source, item.recordId].filter(Boolean).join(' ').toLowerCase();
  if (tokens.length === 0) return false;
  return tokens.some((token) => hay.includes(token))
    || (candText.length > 0 && (hay.includes(candText) || candText.includes(hay)));
}

function evalEvidenceQuality({ evidence, candidate, objective }) {
  const set = buildEvidenceSet({ evidence });
  const objectiveText = typeof objective === 'string' ? objective : String(objective?.text ?? '');
  const tokens = tokenize(objectiveText);
  const candText = candidateText(candidate).toLowerCase();
  const relevant = set.items.filter((item) => isRelevant(item, tokens, candText));
  const usable = relevant.length > 0 ? relevant : [];
  const currentRelevant = usable.filter((item) => item.current);
  const contradictingRelevant = usable.filter((item) => item.relation === 'contradicting');
  const supportingRelevant = usable.filter((item) => item.relation === 'supporting');
  const historical = usable.filter((item) => item.relation === 'historical' || !item.current);
  const sources = new Set(usable.map((item) => item.source));
  const trusts = new Map();
  for (const item of usable) trusts.set(item.trust, (trusts.get(item.trust) ?? 0) + 1);
  const settling = usable.filter((item) => item.current && SETTLING_TRUST.has(item.trust));
  let verdict;
  if (usable.length === 0) verdict = 'no_relevant_evidence';
  else if (contradictingRelevant.length > 0 && supportingRelevant.length === 0) verdict = 'contradicted';
  else if (currentRelevant.length === 0) verdict = 'no_current_evidence';
  else if (settling.length === 0) verdict = 'weak_trust';
  else if (contradictingRelevant.length > 0) verdict = 'mixed';
  else verdict = 'adequate';
  return {
    status: 'position',
    position: {
      verdict,
      summary: usable.length === 0
        ? 'No cited evidence matched the objective or candidate.'
        : `${usable.length} relevant item(s) from ${sources.size} source(s); ${currentRelevant.length} current, ${contradictingRelevant.length} contradicting.`,
      evidence: [
        { kind: 'relevant_count', detail: `${usable.length} relevant evidence items` },
        { kind: 'current_count', detail: `${currentRelevant.length} current` },
        { kind: 'contradicting_count', detail: `${contradictingRelevant.length} contradicting` },
        { kind: 'historical_count', detail: `${historical.length} historical or non-current` },
        { kind: 'source_diversity', detail: `${sources.size} distinct source(s): ${[...sources].join(', ') || 'none'}` },
        { kind: 'trust_distribution', detail: [...trusts.entries()].map(([k, v]) => `${k}: ${v}`).join('; ') || 'none' },
      ],
      supportingEvidence: supportingRelevant.map((item) => item.evidenceId).slice(0, 20),
      conflictingEvidence: contradictingRelevant.map((item) => item.evidenceId).slice(0, 20),
      assumptions: ['relevance is lexical and a cited record is the evidence'],
      uncertainty: usable.length === 0 ? 'no relevant evidence retrieved' : null,
    },
  };
}

function evalSafetyPolicy({ capability }) {
  const def = capability ?? null;
  if (!def) {
    return {
      status: 'position',
      position: {
        verdict: 'unknown_capability',
        summary: 'No registered capability declaration was supplied, so policy cannot be checked.',
        evidence: [{ kind: 'declaration', detail: 'no capability declaration provided' }],
        assumptions: [], uncertainty: 'capability declaration unknown',
      },
    };
  }
  const permission = def.permission ?? 'unknown';
  const origins = Array.isArray(def.origins) ? def.origins : [];
  const risk = def.risk ?? 'unknown';
  const delegable = def.delegable === true;
  const issues = [];
  if (permission === 'write' && !origins.includes('user')) issues.push('write action is not offered to the user origin');
  if (risk === 'high') issues.push('high risk classification');
  if (permission === 'write' && !delegable) issues.push('write action is not delegable');
  if (permission === 'write' && def.reversibility === 'irreversible') issues.push('irreversible write');
  if (!['read', 'write'].includes(permission)) issues.push('permission class is not declared');
  if (origins.includes('model') && permission === 'write') issues.push('a write action is offered to the model origin');
  let verdict;
  if (risk === 'high' || issues.some((issue) => issue.startsWith('irreversible'))) verdict = 'risk_flag';
  else if (issues.length === 0) verdict = 'within_policy';
  else verdict = 'policy_note';
  return {
    status: 'position',
    position: {
      verdict,
      summary: issues.length === 0
        ? `Declared ${permission} capability for ${origins.join('/') || 'no'} origin with ${risk} risk.`
        : `Policy notes: ${issues.join('; ')}.`,
      evidence: [
        { kind: 'permission', detail: permission },
        { kind: 'origins', detail: origins.join(',') || 'none declared' },
        { kind: 'risk', detail: risk },
        { kind: 'delegable', detail: String(delegable) },
        { kind: 'reversibility', detail: def.reversibility ?? 'unknown' },
        ...issues.map((issue) => ({ kind: 'issue', detail: issue })),
      ],
      assumptions: ['registry declaration is current'],
      uncertainty: def.permission === undefined ? 'declaration incomplete' : null,
    },
  };
}

function evalResourceFeasibility({ capability, resourceContext }) {
  const demand = capability?.resourceDemand ?? null;
  const scope = capability?.resourceScope ?? null;
  const ctx = resourceContext ?? null;
  const fields = ['cpuMillis', 'memoryBytes', 'storageBytes', 'networkBytes', 'gpuMemoryBytes'];
  const notes = [];
  if (!demand) notes.push('no declared resource demand');
  if (scope) notes.push(`declared scope: ${scope}`);
  if (!ctx) {
    return {
      status: 'position',
      position: {
        verdict: demand ? 'declared_only' : 'undetermined',
        summary: demand ? 'Demand is declared, but no capacity figure was supplied.' : 'Neither demand nor capacity was supplied.',
        evidence: [
          { kind: 'demand', detail: demand ? JSON.stringify(demand) : 'none declared' },
          { kind: 'scope', detail: scope ?? 'none declared' },
          { kind: 'context', detail: 'none provided' },
        ],
        assumptions: ['declared demand is representative'],
        uncertainty: demand ? 'capacity is unmeasured' : 'no demand information',
      },
    };
  }
  if (ctx.available === false) {
    return {
      status: 'position',
      position: {
        verdict: 'unknown_capacity',
        summary: 'Resource capacity is reported unavailable; this is unknown, not zero.',
        evidence: [{ kind: 'context', detail: 'resource fabric reports unavailable' }],
        assumptions: [], uncertainty: 'capacity unmeasured',
      },
    };
  }
  const over = [];
  const present = [];
  for (const field of fields) {
    const need = demand?.[field];
    const have = ctx[field] ?? ctx.capacity?.[field] ?? ctx.available?.[field];
    if (Number.isFinite(need) && Number.isFinite(have)) {
      present.push(`${field}: need ${need}, available ${have}`);
      if (need > have) over.push(field);
    }
  }
  let verdict;
  if (!demand) verdict = 'undetermined';
  else if (over.length > 0) verdict = 'over_budget';
  else if (present.length > 0) verdict = 'within_declared_budget';
  else verdict = 'declared_only';
  return {
    status: 'position',
    position: {
      verdict,
      summary: verdict === 'over_budget'
        ? `Declared demand exceeds the supplied capacity for: ${over.join(', ')}.`
        : verdict === 'within_declared_budget'
          ? 'Declared demand fits the supplied capacity figures.'
          : 'Demand is declared; no comparable capacity figure was supplied.',
      evidence: [
        { kind: 'demand', detail: demand ? JSON.stringify(demand) : 'none declared' },
        { kind: 'scope', detail: scope ?? 'none declared' },
        { kind: 'capacity', detail: present.length ? present.join('; ') : 'no comparable capacity figure' },
      ],
      assumptions: ['declared demand is representative'],
      uncertainty: verdict === 'declared_only' && demand ? 'capacity is unmeasured' : null,
    },
  };
}

function evalOperationalReliability({ taskRecord }) {
  const task = taskRecord ?? null;
  const steps = Array.isArray(task?.steps) ? task.steps : [];
  const running = steps.filter((s) => s && (s.status === 'running' || s.status === 'pending'));
  const completed = steps.filter((s) => s && s.status === 'completed');
  const failed = steps.filter((s) => s && s.status === 'failed');
  const uncertain = steps.filter((s) => s && s.status === 'uncertain');
  const awaiting = steps.filter((s) => s && (s.status === 'awaiting_approval' || s.approval));
  const verified = steps.filter((s) => s && (s.verified === true || s.outcome === 'success_verified'));
  let verdict;
  if (!task) verdict = 'no_record';
  else if (failed.length > 0) verdict = 'has_failures';
  else if (uncertain.length > 0) verdict = 'has_uncertainty';
  else if (awaiting.length > 0) verdict = 'awaiting_confirmation';
  else if (running.length > 0) verdict = 'in_flight';
  else if (completed.length > 0 && verified.length === 0) verdict = 'completed_unverified';
  else if (verified.length > 0) verdict = 'verified_steps';
  else verdict = 'no_execution_record';
  return {
    status: 'position',
    position: {
      verdict,
      summary: !task ? 'No execution record was supplied.' : `${steps.length} recorded step(s): ${completed.length} completed, ${failed.length} failed, ${uncertain.length} uncertain, ${verified.length} verified.`,
      evidence: [
        { kind: 'step_count', detail: `${steps.length} steps` },
        { kind: 'completed', detail: `${completed.length} completed` },
        { kind: 'verified', detail: `${verified.length} verified` },
        { kind: 'failed', detail: `${failed.length} failed` },
        { kind: 'uncertain', detail: `${uncertain.length} uncertain` },
        { kind: 'awaiting', detail: `${awaiting.length} awaiting` },
        { kind: 'running', detail: `${running.length} running` },
      ],
      assumptions: ['recorded states are accurate'],
      uncertainty: uncertain.length > 0 ? 'uncertain side effects present' : (completed.length > 0 && verified.length === 0 ? 'completed steps are not verified' : null),
    },
  };
}

function evalTemporalConsequences({ evidence, taskRecord, evaluatedAt }) {
  const at = isoOrNull(evaluatedAt) ?? new Date().toISOString();
  const set = buildEvidenceSet({ evidence, now: () => new Date(at) });
  const expired = [];
  const future = [];
  const stale = [];
  const staleThreshold = Date.parse(at) - 30 * 24 * 60 * 60 * 1000;
  for (const item of set.items) {
    if (item.validity === 'expired' || (item.validUntil && item.validUntil < at)) expired.push(item.evidenceId);
    else if (item.validity === 'not_yet_valid' || (item.validFrom && item.validFrom > at)) future.push(item.evidenceId);
    if (item.observedAt && Date.parse(item.observedAt) < staleThreshold) stale.push(item.evidenceId);
  }
  const deadline = isoOrNull(taskRecord?.deadline ?? taskRecord?.dueAt);
  let verdict;
  if (expired.length > 0) verdict = 'expired_evidence_present';
  else if (future.length > 0) verdict = 'future_weighted';
  else if (stale.length > 0) verdict = 'stale_evidence';
  else if (deadline) verdict = 'deadline_present';
  else if (set.items.some((item) => item.validFrom || item.validUntil || item.observedAt)) verdict = 'temporal_context_present';
  else verdict = 'no_temporal_signal';
  return {
    status: 'position',
    position: {
      verdict,
      summary: expired.length > 0
        ? `${expired.length} evidence item(s) are expired at the evaluation time.`
        : future.length > 0 ? `${future.length} item(s) are not yet valid.`
          : stale.length > 0 ? `${stale.length} item(s) are older than 30 days.`
            : deadline ? `A recorded deadline applies: ${deadline}.` : 'No temporal signal was found.',
      evidence: [
        { kind: 'time_sensitive_count', detail: `${set.items.filter((item) => item.validFrom || item.validUntil || item.observedAt).length} time-bearing items` },
        { kind: 'expired', detail: expired.slice(0, 10).join(', ') || 'none' },
        { kind: 'future', detail: future.slice(0, 10).join(', ') || 'none' },
        { kind: 'stale', detail: stale.slice(0, 10).join(', ') || 'none' },
        { kind: 'deadline', detail: deadline ?? 'none recorded' },
      ],
      assumptions: ['timestamps are trustworthy'],
      uncertainty: set.items.length === 0 ? 'no evidence to place in time' : null,
    },
  };
}

function evalLongTermImplications({ capability, taskRecord }) {
  const sideEffect = capability?.sideEffect ?? 'unknown';
  const reversibility = capability?.reversibility ?? 'unknown';
  const dependents = Array.isArray(taskRecord?.dependents) ? taskRecord.dependents.length : 0;
  let verdict;
  if (sideEffect === 'none') verdict = 'read_only';
  else if (sideEffect === 'unknown') verdict = 'unknown_effect';
  else if (reversibility === 'irreversible') verdict = 'irreversible_effect';
  else if (reversibility === 'correctable') verdict = dependents > 0 ? 'dependency_weight' : 'correctable_effect';
  else verdict = 'partially_reversible';
  return {
    status: 'position',
    position: {
      verdict,
      summary: `Declared side effect: ${sideEffect}; reversibility: ${reversibility}; ${dependents} dependent step(s).`,
      evidence: [
        { kind: 'sideEffect', detail: sideEffect },
        { kind: 'reversibility', detail: reversibility },
        { kind: 'dependents', detail: String(dependents) },
      ],
      assumptions: ['declared effects are accurate'],
      uncertainty: sideEffect === 'unknown' || reversibility === 'unknown' ? 'effect class unknown' : null,
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

const INCONCLUSIVE_VERDICTS = new Set([
  'undetermined', 'declared_only', 'no_temporal_signal', 'unknown_capability', 'no_record',
  'no_execution_record', 'no_candidate', 'unknown_effect',
]);

export function classifyDisagreement(positions = []) {
  const withPosition = positions.filter((p) => p?.status === 'position' && p.position);
  if (withPosition.length === 0) return { kind: DISAGREEMENT_KIND.NO_POSITIONS, detail: 'no evaluator produced a position' };
  const byId = new Map(withPosition.map((p) => [p.perspectiveId, p.position.verdict]));
  const unique = new Set(byId.values());
  const safety = byId.get('safety_policy');
  const alignment = byId.get('objective_alignment');
  const evidence = byId.get('evidence_quality');
  const resource = byId.get('resource_feasibility');
  const unreliable = byId.get('operational_reliability');
  const irreversible = byId.get('long_term_implications');

  if ((safety === 'risk_flag' || unreliable === 'has_failures' || irreversible === 'irreversible_effect')
    && (alignment === 'strong_alignment' || alignment === 'partial_alignment')) {
    return { kind: DISAGREEMENT_KIND.RISK_DISAGREEMENT, detail: 'the objective case is offset by a safety, reliability or irreversibility flag' };
  }
  if (resource === 'over_budget' && (alignment === 'strong_alignment' || alignment === 'partial_alignment')) {
    return { kind: DISAGREEMENT_KIND.RESOURCE_DISAGREEMENT, detail: 'the candidate is aligned but declared demand exceeds supplied capacity' };
  }
  if (evidence === 'contradicted' || evidence === 'mixed') {
    return { kind: DISAGREEMENT_KIND.CONTRADICTION, detail: 'cited evidence contains a conflict the council cannot resolve' };
  }
  if (unique.size === 1) {
    const verdict = [...unique][0];
    if (verdict === 'no_relevant_evidence' || verdict === 'no_current_evidence') {
      return { kind: DISAGREEMENT_KIND.INSUFFICIENT_EVIDENCE, detail: `all evaluators report ${verdict}` };
    }
    if (INCONCLUSIVE_VERDICTS.has(verdict)) {
      return { kind: DISAGREEMENT_KIND.INSUFFICIENT_EVIDENCE, detail: 'positions exist but are inconclusive' };
    }
    return { kind: DISAGREEMENT_KIND.AGREEMENT, detail: `all evaluators report ${verdict}` };
  }
  const inconclusive = [...unique].every((verdict) => INCONCLUSIVE_VERDICTS.has(verdict));
  if (inconclusive) return { kind: DISAGREEMENT_KIND.INSUFFICIENT_EVIDENCE, detail: 'every position is inconclusive' };
  return {
    kind: DISAGREEMENT_KIND.PARTIAL_AGREEMENT,
    detail: `evaluators diverge across ${unique.size} distinct verdicts (${[...unique].join(', ')})`,
  };
}

// ---------------------------------------------------------------------------
// Synthesis
// ---------------------------------------------------------------------------

export function synthesize({ objective, positions, disagreement, evidence, candidate, evaluatedAt = null }) {
  const evidenceSet = evidence && evidence.items
    ? evidence
    : buildEvidenceSet({ evidence: Array.isArray(evidence) ? evidence : [] });
  const positionsOut = positions.map((p) => ({
    perspectiveId: p.perspectiveId,
    perspectiveName: p.perspectiveName,
    status: p.status,
    position: p.position ?? null,
    assumptions: p.assumptions ?? [],
    limitations: p.limitations ?? [],
    method: p.method ?? '',
    notes: p.notes ?? [],
  }));
  const recommendation = buildRecommendation({ positions, disagreement, evidence: evidenceSet, candidate });
  const alternatives = buildAlternatives({ positions, disagreement, evidence: evidenceSet, candidate });
  const supporting = evidenceSet.items.filter((item) => item.current && item.relation === 'supporting');
  const conflicting = evidenceSet.items.filter((item) => item.relation === 'contradicting');
  return {
    schema: COUNCIL_SCHEMA,
    evaluatedAt: evaluatedAt ?? evidenceSet.nowIso,
    objective: typeof objective === 'string' ? objective : (objective?.text ?? null),
    decisionObjective: objective ? { text: typeof objective === 'string' ? objective : objective.text, parsed: objective?.valid !== false } : null,
    evidence: {
      count: evidenceSet.count,
      currentCount: evidenceSet.currentCount,
      contradictingCount: conflicting.length,
      sources: [...evidenceSet.bySource.keys()],
      duplicateIds: evidenceSet.duplicates,
      references: evidenceReferences(evidenceSet),
    },
    disagreement: { kind: disagreement.kind, detail: disagreement.detail },
    disagreementExplanation: explainDisagreement(positions),
    positions: positionsOut,
    synthesis: {
      recommendedOption: recommendation,
      support: recommendation.support,
      confidence: recommendation.confidence,
      alternatives,
      supportingEvidence: supporting.map((item) => ({ evidenceId: item.evidenceId, source: item.source, claim: item.claim })),
      conflictingEvidence: conflicting.map((item) => ({ evidenceId: item.evidenceId, source: item.source, claim: item.claim })),
      evidenceSummary: summarizeEvidence(evidenceSet),
      risks: extractRisks(positions),
      assumptions: extractAssumptions(positions),
      unknowns: extractUnknowns(positions),
      missingInformation: extractMissing(positions, evidenceSet),
      requiredApprovals: requiredApprovalsFor(positions, candidate),
      reversibility: extractReversibility(positions, candidate),
      expectedVerification: expectedVerification(positions),
      rejectedAlternatives: reasonsForRejection(positions, alternatives),
      explanation: recommendation.summary,
    },
    authorizesExecution: false,
    note: 'Council output is deliberation data. It does not authorize, execute, or modify any store. All consequential actions still pass through the Executive Control Plane.',
  };
}

function buildRecommendation({ positions, disagreement, evidence, candidate }) {
  const verdictOf = (id) => positions.find((p) => p.perspectiveId === id)?.position?.verdict ?? 'unknown';
  const alignment = verdictOf('objective_alignment');
  const evidenceQ = verdictOf('evidence_quality');
  const safety = verdictOf('safety_policy');
  const resource = verdictOf('resource_feasibility');
  const reliability = verdictOf('operational_reliability');
  const irreversible = verdictOf('long_term_implications');
  const highRisk = safety === 'risk_flag' || safety === 'unknown_capability'
    || reliability === 'has_failures' || irreversible === 'irreversible_effect';
  const insufficient = disagreement.kind === DISAGREEMENT_KIND.INSUFFICIENT_EVIDENCE
    || disagreement.kind === DISAGREEMENT_KIND.NO_POSITIONS;

  let level;
  if (insufficient) level = 'defer';
  else if (highRisk) level = 'review_required';
  else if (resource === 'over_budget') level = 'conditional';
  else if (alignment === 'strong_alignment' && evidenceQ === 'adequate' && safety === 'within_policy') level = 'supported';
  else if (alignment === 'partial_alignment' || evidenceQ === 'mixed') level = 'conditional';
  else level = 'weak';

  const support = level === 'supported' ? 'supported'
    : level === 'conditional' ? 'tentative' : level === 'defer' ? 'tentative' : 'unsupported';
  const confidence = level === 'supported' ? 'medium'
    : level === 'conditional' ? 'low'
      : level === 'defer' ? 'none' : 'low';
  return {
    level,
    support,
    confidence,
    confidenceBasis: 'deterministic evaluation of declared evidence and capability metadata; not a statistical confidence',
    summary: summarizeRecommendation(level, disagreement),
    requiresAuthorization: true,
    detail: { objectiveAlignment: alignment, evidenceQuality: evidenceQ, safetyPolicy: safety, resourceFeasibility: resource, operationalReliability: reliability, longTermImplications: irreversible },
    actionNote: 'no action is taken. Present this synthesis for review; any execution requires explicit authorization through the Executive Control Plane.',
  };
}

function buildAlternatives({ positions, disagreement }) {
  const verdictOf = (id) => positions.find((p) => p.perspectiveId === id)?.position?.verdict ?? 'unknown';
  return [
    {
      option: 'proceed_with_review',
      available: verdictOf('safety_policy') !== 'risk_flag',
      when: 'alignment is partial or strong and evidence is adequate',
      from: 'objective_alignment + evidence_quality',
    },
    {
      option: 'do_not_proceed',
      available: true,
      when: 'a safety, reliability or irreversibility flag is present',
      from: 'safety_policy + operational_reliability + long_term_implications',
    },
    {
      option: 'gather_more_evidence',
      available: verdictOf('evidence_quality') !== 'adequate',
      when: 'evidence quality is weak, absent or contradictory',
      from: 'evidence_quality',
    },
    {
      option: 'defer_decision',
      available: disagreement.kind === DISAGREEMENT_KIND.INSUFFICIENT_EVIDENCE || disagreement.kind === DISAGREEMENT_KIND.NO_POSITIONS,
      when: 'input is insufficient or every position is inconclusive',
      from: 'disagreement classification',
    },
  ];
}

function summarizeEvidence(evidence) {
  return {
    total: evidence.count ?? 0,
    current: evidence.currentCount ?? 0,
    contradicting: evidence.contradicting?.length ?? 0,
    historical: evidence.historical?.length ?? 0,
    insufficient: evidence.insufficient?.length ?? 0,
    duplicateIds: evidence.duplicates ?? [],
    bySource: [...(evidence.bySource ?? new Map()).entries()].map(([source, items]) => ({ source, count: items.length })),
  };
}

function explainDisagreement(positions) {
  const lines = [];
  for (const p of positions) {
    if (p.status !== 'position' || !p.position) {
      lines.push(`${p.perspectiveName}: no position (${(p.missing ?? []).join(', ') || 'insufficient input'})`);
      continue;
    }
    lines.push(`${p.perspectiveName}: ${p.position.verdict}${p.position.summary ? ` — ${p.position.summary}` : ''}`);
  }
  return lines;
}

function extractRisks(positions) {
  const risks = new Set();
  for (const p of positions) {
    const verdict = p.position?.verdict;
    if (verdict === 'risk_flag') risks.add(`${p.perspectiveName}: risk flag`);
    if (verdict === 'has_failures') risks.add(`${p.perspectiveName}: prior failures`);
    if (verdict === 'has_uncertainty') risks.add(`${p.perspectiveName}: uncertain effects`);
    if (verdict === 'over_budget') risks.add(`${p.perspectiveName}: declared demand over budget`);
    if (verdict === 'irreversible_effect') risks.add(`${p.perspectiveName}: irreversible effect`);
    if (verdict === 'expired_evidence_present') risks.add(`${p.perspectiveName}: expired evidence is being cited`);
    if (verdict === 'contradicted' || verdict === 'mixed') risks.add(`${p.perspectiveName}: conflicting evidence`);
  }
  return [...risks];
}

function extractAssumptions(positions) {
  const out = new Map();
  for (const p of positions) for (const a of p.assumptions ?? []) out.set(a, true);
  return [...out.keys()];
}

function extractUnknowns(positions) {
  const out = new Map();
  for (const p of positions) {
    if (p.position?.uncertainty) out.set(p.position.uncertainty, true);
    for (const note of p.notes ?? []) if (note.startsWith('unknown')) out.set(note, true);
  }
  return [...out.keys()];
}

function extractMissing(positions, evidence) {
  const missing = [];
  for (const p of positions) {
    if (p.status === 'insufficient_input') missing.push(`${p.perspectiveName}: ${(p.missing ?? []).join(', ')}`);
  }
  if (evidence.count === 0) missing.push('no evidence was cited');
  if ((evidence.duplicates ?? []).length > 0) missing.push(`duplicate evidence ids were dropped: ${evidence.duplicates.join(', ')}`);
  return missing;
}

function requiredApprovalsFor(positions) {
  const verdictOf = (id) => positions.find((p) => p.perspectiveId === id)?.position?.verdict;
  const safety = verdictOf('safety_policy');
  if (safety === 'risk_flag' || verdictOf('operational_reliability') === 'has_failures') return ['explicit_user_review_before_any_execution'];
  if (safety === 'policy_note' || safety === 'unknown_capability') return ['user_review'];
  return ['user_authorization_for_execution'];
}

function extractReversibility(positions, candidate) {
  const node = positions.find((p) => p.perspectiveId === 'long_term_implications')?.position;
  const effect = node?.evidence?.find((e) => e.kind === 'reversibility')?.detail;
  if (!effect || effect === 'unknown') return 'unknown; the capability declaration did not state reversibility';
  if (effect === 'irreversible') return 'irreversible; review is required and later records cannot undo it';
  if (effect === 'correctable') return 'correctable by a later record; not erasable';
  return `declared as ${effect}`;
}

function expectedVerification(positions) {
  const reliability = positions.find((p) => p.perspectiveId === 'operational_reliability')?.position?.verdict;
  const out = [
    'independent verifier re-reads the relevant store after execution',
    'recorded outcome must be success_verified, not merely claimed',
    'any uncertain step must be resolved before it is treated as done',
  ];
  if (reliability === 'completed_unverified') out.push('completed steps exist without verification; verify them before building on them');
  return out;
}

function reasonsForRejection(positions, alternatives) {
  const verdictOf = (id) => positions.find((p) => p.perspectiveId === id)?.position?.verdict;
  const out = [];
  if (verdictOf('safety_policy') === 'risk_flag') out.push({ alternative: 'proceed_with_review', reason: 'risk flag from the safety perspective' });
  if (verdictOf('operational_reliability') === 'has_failures') out.push({ alternative: 'proceed_with_review', reason: 'prior failed steps' });
  if (verdictOf('safety_policy') === 'unknown_capability') out.push({ alternative: 'proceed_with_review', reason: 'capability declaration unknown' });
  if (verdictOf('long_term_implications') === 'irreversible_effect') out.push({ alternative: 'proceed_with_review', reason: 'irreversible effect' });
  for (const alternative of alternatives) {
    if (alternative.available === false && !out.some((item) => item.alternative === alternative.option)) {
      out.push({ alternative: alternative.option, reason: 'not available from the current positions' });
    }
  }
  return out;
}

function summarizeRecommendation(level, disagreement) {
  switch (level) {
    case 'supported': return 'Council finds the option aligned with the objective, supported by adequate current evidence, and within declared policy. Execution still requires explicit authorization.';
    case 'conditional': return 'Council finds partial support. The option may fit the objective, but at least one perspective is conditional; review before execution.';
    case 'weak': return 'Council does not find enough support across the perspectives to recommend starting. Review the objective, the evidence, or both.';
    case 'review_required': return 'Council flags risk, irreversibility or reliability concerns. Do not proceed without explicit review and authorization.';
    case 'defer': return 'Council does not have enough input or conclusive positions to recommend. Clarify the objective or supply missing evidence before deciding.';
    default: return 'Council could not reach a recommending position.';
  }
}

// ---------------------------------------------------------------------------
// Session construction and persistence helpers
// ---------------------------------------------------------------------------

export function councilSessionId(inputDigest) {
  return `council-${String(inputDigest).slice(0, 16)}`;
}

export function createCouncilSession({ objective, inputDigest, now = () => new Date() } = {}) {
  return {
    schema: COUNCIL_SCHEMA,
    schemaVersion: COUNCIL_SCHEMA_VERSION,
    kind: 'session',
    sessionId: councilSessionId(inputDigest),
    inputDigest,
    objective: typeof objective === 'string' ? objective : objective?.text ?? null,
    evaluatedAt: now().toISOString(),
    status: 'prepared',
    authorizesExecution: false,
  };
}

export async function appendCouncilSession(store, session) {
  if (!store || typeof store.append !== 'function') return { saved: false, reason: 'no session store' };
  const outcome = await store.append(session);
  return { saved: outcome?.appended !== false, ...outcome };
}
