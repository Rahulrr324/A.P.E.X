// Deterministic identity candidates for the World Model.
//
// A candidate is a suggestion for a human decision. Nothing here merges, retires, or rewrites a
// record: the only output is an ordered list with a stated reason for each entry. The `score`
// orders candidates for reading; it is not a probability, it is never shown as confidence, and it
// is never a merge basis. A merge requires either a recorded user confirmation or a shared trusted
// external identifier, both of which are explicit records.
import {
  canonicalId,
  identityKey,
  latestIdentityDecision,
  normalizeExternal,
  normalizeName,
} from './model.js';
import { categoryLabel } from './vocabulary.js';

export const MAX_CANDIDATES = 20;
// Words that identify a kind of thing rather than a thing. They are removed before similarity is
// computed so "Acme Inc" and "Acme Ltd" are compared on "acme", and so two companies called
// "The Studio" are not considered similar on the strength of a generic word alone.
const GENERIC_TOKENS = new Set([
  'the', 'a', 'an', 'and', 'of', 'inc', 'incorporated', 'llc', 'ltd', 'limited', 'co', 'company',
  'corp', 'corporation', 'gmbh', 'plc', 'project', 'team', 'group', 'org', 'organization',
  'software', 'app', 'application',
]);

export function nameTokens(value) {
  return [...new Set(String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 1 && !GENERIC_TOKENS.has(token)))].sort();
}

function jaccard(left, right) {
  if (left.length === 0 || right.length === 0) return 0;
  const a = new Set(left);
  const b = new Set(right);
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / (a.size + b.size - shared);
}

function levenshtein(left, right, cap = 8) {
  if (left === right) return 0;
  if (Math.abs(left.length - right.length) > cap) return cap + 1;
  const previous = new Array(right.length + 1);
  const current = new Array(right.length + 1);
  for (let j = 0; j <= right.length; j += 1) previous[j] = j;
  for (let i = 1; i <= left.length; i += 1) {
    current[0] = i;
    let best = current[0];
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      if (current[j] < best) best = current[j];
    }
    if (best > cap) return cap + 1;
    for (let j = 0; j <= right.length; j += 1) previous[j] = current[j];
  }
  return previous[right.length];
}

function similarity(left, right) {
  const a = nameTokens(left);
  const b = nameTokens(right);
  if (a.length === 0 || b.length === 0) return 0;
  const tokenScore = jaccard(a, b);
  const joinedA = a.join(' ');
  const joinedB = b.join(' ');
  const distance = levenshtein(joinedA, joinedB);
  const editScore = 1 - distance / Math.max(joinedA.length, joinedB.length);
  if (tokenScore >= 0.5) return Math.max(tokenScore, editScore);
  // A single-token difference inside a multi-token name ("john smith" / "jon smith") is reported
  // only when the rest of the name matches exactly and the differing token is a near miss.
  if (a.length === b.length && a.length >= 2) {
    let differing = 0;
    let near = 0;
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] === b[i]) continue;
      differing += 1;
      const tokenDistance = levenshtein(a[i], b[i], 2);
      if (tokenDistance <= 2 && Math.min(a[i].length, b[i].length) >= 4) near += 1;
    }
    if (differing === near && differing > 0) return 0.6;
  }
  return 0;
}

function decisionFor(state, leftId, rightId) {
  return latestIdentityDecision(state, leftId, rightId);
}

function sharedExternal(left, right) {
  const reasons = [];
  for (const a of left.externalIds ?? []) {
    for (const b of right.externalIds ?? []) {
      if (a.scheme !== b.scheme) continue;
      if (normalizeExternal(a.value) !== normalizeExternal(b.value)) continue;
      const label = `${a.scheme}:${a.value}`;
      if (!reasons.includes(label)) reasons.push(label);
    }
  }
  return reasons;
}

function crossNames(left, right) {
  const leftNames = new Set([left.name, ...(left.aliases ?? [])].map(normalizeName));
  const rightNames = new Set([right.name, ...(right.aliases ?? [])].map(normalizeName));
  const shared = [];
  for (const name of leftNames) if (rightNames.has(name) && name) shared.push(name);
  return shared.sort();
}

function scoreCandidate(state, entity, other) {
  const reasons = [];
  let kind = null;
  let score = 0;
  let basis = 'deterministic';

  const external = sharedExternal(entity, other);
  if (external.length > 0) {
    kind = 'external_id';
    score = 1;
    for (const label of external) reasons.push(`both entities carry the trusted external identifier ${label}`);
  }

  const decision = decisionFor(state, entity.id, other.id);
  if (decision?.decision === 'confirmed') {
    if (!kind) kind = 'user_confirmed';
    score = Math.max(score, 0.98);
    reasons.push(`you confirmed on ${decision.at} that these entities are the same`);
  }

  const names = crossNames(entity, other);
  if (names.length > 0) {
    if (!kind) kind = 'shared_name';
    const nameOnly = Math.max(score, 0.9);
    score = nameOnly;
    for (const name of names.slice(0, 4)) reasons.push(`the normalized name or alias "${name}" matches exactly`);
  }

  if (kind === null) {
    const left = nameTokens(entity.name).join(' ');
    const right = nameTokens(other.name).join(' ');
    const ratio = similarity(entity.name, other.name);
    const aliasRatio = Math.max(
      ...[entity.name, ...(entity.aliases ?? [])].map((a) => Math.max(
        ...[other.name, ...(other.aliases ?? [])].map((b) => similarity(a, b)),
      )),
    );
    const best = Math.max(ratio, aliasRatio);
    if (best >= 0.75 && Math.min(left.length, right.length) >= 4) {
      kind = 'similar_name';
      basis = 'similarity';
      score = Math.min(0.7, 0.3 + best / 2);
      reasons.push(`the names are similar (${left || entity.name} / ${right || other.name}); similarity is a prompt to check, not identity`);
    }
  }

  return { kind, score, reasons, basis };
}

// Candidates for one entity, with every exclusion listed. A rejection recorded by the user keeps
// the pair out of the candidate list but stays visible in `rejected`, so the decision is not lost.
export function identityCandidates(state, entityId, { limit = MAX_CANDIDATES, includeRejected = false } = {}) {
  const resolvedId = canonicalId(state, entityId);
  if (resolvedId === null) return { entity: null, candidates: [], rejected: [], problem: 'the entity merge chain does not resolve' };
  const entity = state.entities.get(resolvedId);
  if (!entity) return { entity: null, candidates: [], rejected: [], problem: `entity ${entityId} does not exist` };
  const candidates = [];
  const rejected = [];
  for (const other of state.entities.values()) {
    if (other.id === entity.id || other.status !== 'active') continue;
    const scored = scoreCandidate(state, entity, other);
    if (!scored.kind) continue;
    const decision = decisionFor(state, entity.id, other.id);
    const row = {
      id: other.id,
      name: other.name,
      category: other.category,
      categoryLabel: categoryLabel(other.category),
      aliases: [...other.aliases],
      kind: scored.kind,
      score: Number(scored.score.toFixed(3)),
      basis: scored.basis,
      reasons: scored.reasons,
      decision: decision?.decision ?? null,
      decisionAt: decision?.at ?? null,
    };
    if (decision?.decision === 'rejected') rejected.push(row);
    else candidates.push(row);
  }
  candidates.sort((a, b) => b.score - a.score || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  rejected.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || (a.id < b.id ? -1 : 1));
  const bounded = Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_CANDIDATES) : MAX_CANDIDATES;
  return {
    entity: { id: entity.id, name: entity.name },
    candidates: candidates.slice(0, bounded),
    total: candidates.length,
    truncated: candidates.length > bounded,
    rejected: includeRejected ? rejected : [],
    rejectedTotal: rejected.length,
    problem: null,
    note: 'score orders candidates for reading; it is not a probability, it is not confidence, and it is never a merge basis. A merge needs a recorded confirmation or a shared trusted external identifier.',
  };
}

// Explains a specific pair, for an explicit merge request.
export function pairAssessment(state, leftId, rightId) {
  const left = state.entities.get(canonicalId(state, leftId) ?? leftId);
  const right = state.entities.get(canonicalId(state, rightId) ?? rightId);
  if (!left) return { allowed: false, problem: `entity ${leftId} does not exist`, basis: null, reasons: [] };
  if (!right) return { allowed: false, problem: `entity ${rightId} does not exist`, basis: null, reasons: [] };
  if (left.id === right.id) return { allowed: false, problem: 'the references resolve to the same entity', basis: null, reasons: [] };
  const external = sharedExternal(left, right);
  const decision = decisionFor(state, left.id, right.id);
  const names = crossNames(left, right);
  const reasons = [];
  if (external.length > 0) reasons.push(...external.map((label) => `shared trusted external identifier ${label}`));
  if (decision) reasons.push(`your recorded identity decision on ${decision.at} was "${decision.decision}"`);
  if (names.length > 0) reasons.push(...names.map((name) => `shared normalized name or alias "${name}"`));
  if (decision?.decision === 'rejected') {
    return {
      allowed: false,
      reason: 'you recorded that these entities are different; confirm identity again before merging',
      basis: null,
      reasons,
      left: { id: left.id, name: left.name },
      right: { id: right.id, name: right.name },
    };
  }
  if (decision?.decision === 'confirmed') {
    return {
      allowed: true,
      basis: 'user_confirmation',
      reasons,
      left: { id: left.id, name: left.name },
      right: { id: right.id, name: right.name },
      note: 'the merge is a separate user-origin record; confirming identity did not merge anything',
    };
  }
  if (external.length > 0) {
    return {
      allowed: true,
      basis: 'external_id',
      reasons,
      left: { id: left.id, name: left.name },
      right: { id: right.id, name: right.name },
      note: 'a shared trusted external identifier is deterministic evidence; the merge is still an explicit user-origin record',
    };
  }
  return {
    allowed: false,
    reason: names.length > 0
      ? 'a shared name is not identity; confirm the identity or record a shared trusted external identifier first'
      : 'no confirmation and no shared trusted external identifier is recorded for this pair',
    basis: null,
    reasons,
    left: { id: left.id, name: left.name },
    right: { id: right.id, name: right.name },
  };
}

export { identityKey };
