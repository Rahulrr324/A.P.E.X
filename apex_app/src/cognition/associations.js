// T-34 Step 2 (2026-11-19): candidate associative recall.
//
// A prior episode can say something about a new intent - "last time I audited this workspace, the
// join failed because the ledger was empty" is worth surfacing. It is worth surfacing as a *guess*,
// and that is the whole point of this module: a recall is a candidate association, never an
// observation, never a fact, and never a permission.
//
//   * The status is fixed by construction. Every recall carries
//     `epistemicStatus: 'candidate_association'` and `status: 'candidate'`; there is no code path
//     here that produces `observed`, and `authorizesExecution` is `false` on the envelope.
//   * The link is stated. `sourceRecordId` names the run (or episode) the association came from, so
//     a reader can go and read that record; the recall carries nothing the source does not.
//   * The evidence is stated. `similarity` is a real number computed from the two texts by one
//     deterministic function, `confidence` is capped below any observed confidence, and `basis`
//     names the shared terms that produced the match.
//   * Nothing is inferred from a model. Two token sets and a threshold decide it, so the same inputs
//     always produce the same recalls in the same order, and a test can assert exactly what is
//     expected instead of "something appeared".
//
// The recall never enters the ECP, never grants anything and never changes a decision. It is added
// to the Stage 1 context packet as its own list, counted as its own epistemic class, and rendered
// with its own badge.
import { createHash } from 'node:crypto';

export const ASSOCIATION_SCHEMA = 'apex.associations/1';
export const ASSOCIATION_STATUS = 'candidate_association';
// Words that carry no subject: they appear in almost every intent, so matching on them would
// associate everything with everything.
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'than', 'that', 'this', 'these', 'those', 'to', 'of', 'in', 'on', 'at',
  'for', 'with', 'from', 'by', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'it', 'its', 'my', 'me', 'i',
  'you', 'your', 'we', 'our', 'us', 'they', 'their', 'them', 'he', 'she', 'his', 'her', 'do', 'does', 'did', 'can',
  'could', 'should', 'would', 'will', 'shall', 'may', 'might', 'must', 'not', 'no', 'yes', 'please', 'again', 'about',
  'into', 'over', 'under', 'so', 'very', 'just', 'now', 'also', 'run', 'ran', 'make', 'made', 'get', 'got',
]);
const MIN_TOKEN_LENGTH = 3;
const MAX_TOKEN_LENGTH = 32;
// A recall below this relatedness is not a candidate at all: two shared stopwords are not a memory.
export const MIN_SIMILARITY = 0.25;
const MIN_SHARED_TOKENS = 2;
// An association is never as strong as an observation. The ceiling is deliberately low.
export const MAX_CANDIDATE_CONFIDENCE = 0.6;
const MAX_SUMMARY_CHARS = 240;

export function tokensOf(value) {
  if (typeof value !== 'string') return [];
  const seen = new Set();
  for (const raw of value.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < MIN_TOKEN_LENGTH || raw.length > MAX_TOKEN_LENGTH) continue;
    if (STOPWORDS.has(raw)) continue;
    seen.add(raw);
  }
  return [...seen];
}

// Sorensen-Dice over the token sets: a stable, symmetric number in [0, 1] that a test can compute by
// hand. Two identical texts score 1; two texts that share nothing score 0.
export function relatedness(a, b) {
  const left = tokensOf(a);
  const right = tokensOf(b);
  if (left.length === 0 || right.length === 0) return 0;
  const rightSet = new Set(right);
  const shared = left.filter((token) => rightSet.has(token));
  return (2 * shared.length) / (left.length + right.length);
}

function sharedTerms(a, b) {
  const rightSet = new Set(tokensOf(b));
  return tokensOf(a).filter((token) => rightSet.has(token)).sort();
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

function summaryOf(value) {
  const line = String(value ?? '').replace(/\s+/g, ' ').trim();
  return line.length <= MAX_SUMMARY_CHARS ? line : `${line.slice(0, MAX_SUMMARY_CHARS - 1)}…`;
}

// A stable id for one association, so the same pair always names the same recall and a second run
// does not invent a new identity for the same evidence.
export function associationId({ intent, sourceRecordId }) {
  const digest = createHash('sha256').update(`${String(intent)}\u0000${String(sourceRecordId)}`).digest('hex');
  return `assoc-${digest.slice(0, 16)}`;
}

// Compiles the candidate recalls for one intent from a list of prior episodes. An episode is any
// record with an id, a text to compare and an outcome; `sourceType` says what kind of record it is so
// the reader knows where to look. The list is filtered, scored, sorted (strongest first, then by id so
// the order is total) and capped.
export function candidateAssociations({ intent, episodes = [], limit = 3, sourceType = 'cognition_run' } = {}) {
  const bounded = Number.isInteger(limit) ? Math.min(Math.max(limit, 0), 10) : 3;
  const recalls = [];
  for (const episode of Array.isArray(episodes) ? episodes : []) {
    const sourceRecordId = typeof episode?.id === 'string' ? episode.id : null;
    if (!sourceRecordId) continue;
    const compared = typeof episode.text === 'string' ? episode.text : '';
    const similarity = round(relatedness(intent, compared));
    const shared = sharedTerms(intent, compared);
    if (similarity < MIN_SIMILARITY || shared.length < MIN_SHARED_TOKENS) continue;
    recalls.push({
      schema: ASSOCIATION_SCHEMA,
      kind: 'candidate_association',
      id: associationId({ intent, sourceRecordId }),
      // Never `observed`: this is the one field a reader uses to decide how far to trust the line.
      epistemicStatus: ASSOCIATION_STATUS,
      status: 'candidate',
      sourceType,
      sourceRecordId,
      sourceAt: episode.at ?? null,
      sourceOutcome: episode.outcome ?? null,
      // What the source said, shortened, so the recall cannot claim more than its evidence.
      summary: summaryOf(compared),
      similarity,
      confidence: round(Math.min(MAX_CANDIDATE_CONFIDENCE, similarity * MAX_CANDIDATE_CONFIDENCE)),
      basis: `shared terms: ${shared.join(', ')}`,
      verified: false,
      // Stated in the record itself, because a reader of one recall must not have to know the router.
      authorizesExecution: false,
      grantsPermission: false,
    });
  }
  recalls.sort((a, b) => b.similarity - a.similarity || a.id.localeCompare(b.id));
  return recalls.slice(0, bounded);
}

// The envelope the packet and the route carry: the recalls, the rule that produced them, and a
// standing statement that they authorize nothing.
export function associationEnvelope({ intent, recalls = [], episodesConsidered = 0 } = {}) {
  return {
    schema: ASSOCIATION_SCHEMA,
    at: null,
    epistemicStatus: ASSOCIATION_STATUS,
    rule: `candidate associations by Sorensen-Dice relatedness of intent and prior episode, threshold ${MIN_SIMILARITY}, at least ${MIN_SHARED_TOKENS} shared terms, confidence capped at ${MAX_CANDIDATE_CONFIDENCE}`,
    episodesConsidered,
    count: recalls.length,
    recalls,
    // A candidate association is a memory of something that happened, not a statement about now, and
    // it never stands in for a permission.
    authorizesExecution: false,
    grantsPermission: false,
    intent: summaryOf(intent),
  };
}
