// Structured objective understanding.
//
// This module turns one request into the parts it actually contains, the constraints the user
// stated, the unknowns that remain, the order the user implied, and - when a capability catalogue is
// supplied - which registered action could carry each part. It is deterministic and reads only the
// user's words plus the registry descriptors it is given. It never calls a model, never invents a
// constraint the user did not state, and never presents a lexical similarity as a mapping: a part is
// either routed by the real router or listed as a candidate with the reason it was suggested.
//
// Nothing here authorizes. Every result carries `authorization.granted === false`, and a mapped part
// is still authorized again by the action registry when (and if) it is ever run.
import { route } from '../controller/router.js';
import { singleLine, truncate } from '../util.js';

export const OBJECTIVE_SCHEMA = 'apex.objective.v1';

export const OBJECTIVE_NOTE = 'objective decomposition describes what the request contains and grants no authorization; every mapped part is still authorized by the action registry';

export const PartKind = Object.freeze({
  QUESTION: 'question',
  REQUEST: 'request',
  CONSTRAINT: 'constraint',
  STATEMENT: 'statement',
});

export const CapabilityStatus = Object.freeze({
  ROUTED: 'routed',
  MODEL: 'model',
  CANDIDATE: 'candidate',
  UNMATCHED: 'unmatched',
  UNAVAILABLE: 'unavailable',
  NOT_APPLICABLE: 'not_applicable',
  NOT_EVALUATED: 'not_evaluated',
});

export const ConstraintKind = Object.freeze({
  AUTHORIZATION: 'authorization',
  PROHIBITION: 'prohibition',
  PRIVACY: 'privacy',
  QUANTITY: 'quantity',
  TIME: 'time',
  FORMAT: 'format',
  SCOPE: 'scope',
  REQUIREMENT: 'requirement',
  PREFERENCE: 'preference',
});

export const UnknownCode = Object.freeze({
  UNRESOLVED_REFERENCE: 'unresolved_reference',
  MISSING_TARGET: 'missing_target',
  VAGUE_QUANTITY: 'vague_quantity',
  VAGUE_TIME: 'vague_time',
  UNREGISTERED_CAPABILITY: 'unregistered_capability',
  NO_MATCHING_CAPABILITY: 'no_matching_capability',
});

const MAX_PARTS = 8;
const MAX_PART_CHARS = 240;
const MAX_CONSTRAINTS = 6;
const MAX_UNKNOWNS = 8;
const MAX_CANDIDATES = 3;
const MAX_TEXT_CHARS = 2000;
const MAX_CLAUSE_CHARS = 220;
const CANDIDATE_THRESHOLD = 0.3;

// Verbs that begin a request to do something. The list decides how a clause is shaped, not whether it
// is allowed: an unrecognized verb leaves the part a statement, and the registry still decides what
// can run.
const IMPERATIVE_VERBS = new Set([
  'add', 'analyze', 'analyse', 'approve', 'ask', 'build', 'calculate', 'cancel', 'check', 'compare',
  'compile', 'compute', 'convert', 'copy', 'count', 'create', 'delete', 'describe', 'dig', 'display',
  'draft', 'explain', 'extract', 'fetch', 'find', 'forget', 'generate', 'give', 'import', 'ingest',
  'judge', 'list', 'load', 'look', 'make', 'move', 'open', 'outline', 'plan', 'prepare', 'print',
  'pull', 'rate', 'read', 'recall', 'record', 'remember', 'remove', 'rename', 'replan', 'report',
  'restore', 'resume', 'review', 'run', 'save', 'schedule', 'search', 'set', 'show', 'start', 'stop',
  'do',
  'summarise', 'summarize', 'tell', 'track', 'undo', 'update', 'validate', 'verify', 'write',
]);

// A verb that needs a target. "summarize" on its own is a request with a hole, which is stated as
// missing rather than guessed.
const TARGETED_VERBS = new Set([
  'add', 'create', 'delete', 'extract', 'find', 'import', 'load', 'move', 'open', 'read', 'remove',
  'rename', 'search', 'show', 'summarise', 'summarize', 'update', 'write',
]);

const QUESTION_WORDS = new Set([
  'what', 'who', 'when', 'where', 'why', 'how', 'which', 'is', 'are', 'was', 'were', 'can', 'could',
  'should', 'would', 'will', 'do', 'does', 'did', 'have', 'has', 'am',
]);

const PRONOUN_SUBJECTS = new Set([
  'it', 'that', 'this', 'them', 'those', 'these', 'they', 'he', 'she',
]);

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'about', 'your', 'you', 'our', 'their',
  'them', 'they', 'have', 'has', 'had', 'will', 'would', 'could', 'should', 'can', 'may', 'might',
  'must', 'not', 'but', 'all', 'any', 'some', 'one', 'two', 'three', 'then', 'than', 'when', 'what',
  'where', 'which', 'who', 'why', 'how', 'its', 'it', 'is', 'are', 'was', 'were', 'be', 'been',
  'being', 'to', 'of', 'in', 'on', 'at', 'by', 'as', 'or', 'if', 'do', 'does', 'did', 'please',
  'me', 'my', 'we', 'us', 'i', 'a', 'an',
]);

const CONSTRAINT_RULES = [
  [ConstraintKind.AUTHORIZATION, /\b(?:ask|check\s+with|confirm\s+with|wait\s+for)\s+(?:me|my)\b|\bwait(?:ing)?\s+for\s+(?:my\s+)?(?:approval|confirmation)\b|\b(?:do\s+not|don't|never)\s+(?:execute|run|start|act)\b|\bpropose\s+only\b|\bwithout\s+(?:running|executing)\b|\brequire\s+(?:my\s+)?approval\b/i],
  [ConstraintKind.PROHIBITION, /\b(?:do\s+not|don't|never|must\s+not|mustn't|avoid)\b/i],
  [ConstraintKind.PRIVACY, /\b(?:private|privately|confidential|secret|sensitive|local[-\s]?only|offline|do\s+not\s+share|don't\s+share|do\s+not\s+send|don't\s+send)\b/i],
  [ConstraintKind.QUANTITY, /\b(?:at\s+most|no\s+more\s+than|up\s+to|exactly|only)\s+\d+\b|\b\d+\s+(?:or\s+fewer|or\s+less|max)\b|\bmax(?:imum)?\s+\d+\b/i],
  [ConstraintKind.TIME, /\b(?:by|before|until|within|no\s+later\s+than)\s+(?:the\s+)?(?:end\s+of\s+)?(?:today|tomorrow|tonight|this\s+(?:week|month|quarter|year)|next\s+(?:week|month)|[A-Z][a-z]+\s+\d{1,2}|\d{4}-\d{2}-\d{2})\b|\b(?:today|tomorrow|tonight|this\s+week|next\s+week|end\s+of\s+(?:the\s+)?(?:week|month))\b/i],
  [ConstraintKind.FORMAT, /\b(?:as\s+(?:a\s+)?(?:list|table|json|csv|bullets?|summary)|in\s+(?:one|a\s+single)\s+(?:line|paragraph|sentence)|concise|brief|short|detailed)\b/i],
  [ConstraintKind.SCOPE, /\b(?:only|just|limited\s+to|restricted\s+to|inside|within|under)\b/i],
  [ConstraintKind.REQUIREMENT, /\b(?:must|should|need\s+to|needs\s+to|has\s+to|have\s+to|required)\b/i],
  [ConstraintKind.PREFERENCE, /\b(?:prefer|ideally|if\s+possible|if\s+you\s+can|rather)\b/i],
];

// A leading marker that makes a clause a constraint rather than a request to run something. "just"
// is deliberately absent: "just summarize the plan" is a request, while "just the open plans" is a
// scope condition, and the ordering inside the clause is what tells them apart.
const CONSTRAINT_LEAD = /^\W*(?:please\s+)?(?:do\s+not|don't|never|must\s+not|mustn't|avoid|only|without|at\s+most|no\s+more\s+than|up\s+to|keep\s+it|make\s+sure|be\s+sure|wait\s+for|ask\s+me)\b/i;

const SEQUENCE_LEAD = /^\W*(?:then|next|after(?:wards| that)?|finally|subsequently|lastly|once\s+[^,]{1,80},)\s+/i;
const ORDINAL_LEAD = /^\W*(?:first|second|third|fourth|fifth)(?:ly)?\s*[,:]?\s+/i;
const COORDINATION = /^\s*(?:and(?:\s+then)?|then|plus|also)\s+/i;

function norm(text) {
  return String(text ?? '').normalize('NFKC');
}

function words(text) {
  return norm(text).toLowerCase().match(/[\p{L}\p{N}-]+/gu) ?? [];
}

function firstWord(text) {
  return words(text)[0] ?? '';
}

function trimClause(text) {
  return String(text ?? '').trim().replace(/^[-*•\s]+|[,;:\s]+$/g, '');
}

// A sentence is split only at explicit boundaries. A period splits only when the next word is
// capitalized, so "e.g. this" and a decimal stay in one clause, and a comma is never a boundary:
// "review the plan, which is old" is one request and "check the notes, then report" is handled by
// the sequence rule below rather than by splitting the noun phrase.
function sentences(text) {
  return String(text)
    .replace(/\r\n?/g, '\n')
    .split(/(?<=[!?;])\s+|(?<=\.)\s+(?=[A-Z0-9"'(])|\n+/)
    .map(trimClause)
    .filter((value) => value.length > 0);
}

const NUMBERED_ITEM = /^\s*(?:\(\d{1,2}\)|\d{1,2}[.)])\s+/;

// A numbered list is read as a list before sentence splitting, because "1. read the file" ends with
// a period that would otherwise be read as a sentence boundary. A bullet list is already one clause
// per line.
function listItems(text) {
  const source = String(text).replace(/\r\n?/g, '\n');
  if (NUMBERED_ITEM.test(source)) {
    return source
      .split(/\s+(?=(?:\(\d{1,2}\)|\d{1,2}[.)])\s+)/)
      .map((item) => trimClause(item.replace(NUMBERED_ITEM, '')))
      .filter((item) => item.length > 0);
  }
  if (/^\s*[-*•]\s+/m.test(source)) {
    return source
      .split('\n')
      .map((line) => trimClause(line.replace(/^\s*[-*•]\s+/, '')))
      .filter((line) => line.length > 0);
  }
  return null;
}

function isQuestion(text) {
  const t = text.trim();
  if (/\?\s*$/.test(t)) return true;
  const word = firstWord(t);
  // "do it" is a command; "do I need to..." is a question. The subject, not the auxiliary, is what
  // tells them apart.
  if (word === 'do' || word === 'does' || word === 'did') {
    return /^(?:do|does|did)\s+(?:i|we|you|they)\b/i.test(t);
  }
  return QUESTION_WORDS.has(word);
}

function isRequestShaped(text) {
  const t = text.trim();
  if (isQuestion(t)) return true;
  const lead = t.replace(COORDINATION, '').trim();
  return IMPERATIVE_VERBS.has(firstWord(lead)) || /^please\b/i.test(lead);
}

function stripLead(text) {
  return text.replace(SEQUENCE_LEAD, '').replace(ORDINAL_LEAD, '').trim();
}

// What the router is asked about. A part may begin with "and", "then", or an ordinal because that
// is how the user sequenced it; those words are order markers, not part of the operation.
function routingText(text) {
  return stripLead(String(text).replace(COORDINATION, ''))
    .replace(COORDINATION, '')
    .replace(/[.!?]+\s*$/, '')
    .trim();
}

function classifyKind(text) {
  if (CONSTRAINT_LEAD.test(text)) return PartKind.CONSTRAINT;
  if (isQuestion(text)) return PartKind.QUESTION;
  const lead = stripLead(text);
  return IMPERATIVE_VERBS.has(firstWord(lead)) ? PartKind.REQUEST : PartKind.STATEMENT;
}

// Coordination is split only when both sides stand on their own as requests or questions. The test
// is deliberately symmetric: "remember the date and the release" stays one part, because "the
// release" is not a request, while "search the notes and list the deadlines" is two.
function splitCoordination(text) {
  const positions = [];
  const pattern = /\s+(?:and\s+then|and|plus|also|then)\s+/gi;
  let match;
  while ((match = pattern.exec(text)) !== null) positions.push(match.index);
  if (positions.length === 0) return [text];
  const pieces = [];
  let start = 0;
  for (const index of positions) {
    pieces.push(trimClause(text.slice(start, index)));
    start = index + matchLengthAt(text, index);
  }
  pieces.push(trimClause(text.slice(start)));
  const kept = pieces.filter((piece) => piece.length > 0);
  if (kept.length < 2) return [text];
  if (!kept.every(isRequestShaped)) return [text];
  return kept.slice(0, 4);
}

function matchLengthAt(text, index) {
  const rest = text.slice(index);
  const match = /^\s+(?:and\s+then|and|plus|also|then)\s+/i.exec(rest);
  return match ? match[0].length : 1;
}

function splitParts(text) {
  const items = listItems(text);
  if (items && items.length > 1) return items.map((piece) => ({ text: piece, splitBy: 'list' }));
  const parts = [];
  for (const sentence of sentences(text)) {
    if (sentence.length > MAX_CLAUSE_CHARS) {
      // A long clause is kept whole: splitting it on commas would invent structure. It is recorded
      // as bounded rather than silently rewritten.
      parts.push({ text: sentence, splitBy: 'whole' });
      continue;
    }
    const coordinated = splitCoordination(sentence);
    if (coordinated.length > 1) {
      for (const piece of coordinated) parts.push({ text: piece, splitBy: 'coordination' });
      continue;
    }
    parts.push({ text: sentence, splitBy: 'sentence' });
  }
  return parts;
}

function constraintKinds(text) {
  const kinds = [];
  for (const [kind, pattern] of CONSTRAINT_RULES) {
    if (pattern.test(text) && !kinds.includes(kind)) kinds.push(kind);
  }
  return kinds;
}

function looksLikeVagueQuantity(text) {
  return /\b(?:some|a\s+few|several|many|a\s+lot|lots\s+of|a\s+bunch\s+of)\b/i.test(text);
}

function looksLikeVagueTime(text) {
  if (CONSTRAINT_RULES.find(([kind]) => kind === ConstraintKind.TIME)[1].test(text)) return false;
  return /\b(?:soon|later|sometime|eventually|asap|as\s+soon\s+as\s+possible)\b/i.test(text);
}

function hasTarget(text) {
  const tokens = words(stripLead(text));
  if (tokens.length === 0) return false;
  const rest = tokens.slice(1);
  if (rest.length === 0) return false;
  const meaningful = rest.filter((token) => !STOPWORDS.has(token) && token.length > 1);
  return meaningful.length > 0;
}

function dependencyOf(text, index) {
  if (index === 0) return null;
  if (SEQUENCE_LEAD.test(text) || ORDINAL_LEAD.test(text)) return { prerequisite: index - 1, kind: 'sequence' };
  return null;
}

// Registry descriptors, reduced to the fields a catalogue needs. The action definitions themselves
// are never copied into the objective: they carry executable functions.
function catalogue(capabilities) {
  if (!Array.isArray(capabilities)) return null;
  return capabilities
    .filter((def) => def && typeof def.name === 'string')
    .map((def) => ({
      name: def.name,
      description: typeof def.description === 'string' ? def.description : '',
      inputHint: typeof def.inputHint === 'string' ? def.inputHint : '',
      permission: def.permission === 'write' ? 'write' : 'read',
    }));
}

function meaningfulTokens(text) {
  return [...new Set(words(text).filter((token) => token.length >= 3 && !STOPWORDS.has(token)))];
}

function overlap(queryTokens, text) {
  const target = new Set(meaningfulTokens(text));
  return queryTokens.filter((token) => target.has(token));
}

// A lexical candidate is a suggestion, not a mapping. It is offered only when the shared terms are
// specific enough that a reader could check the suggestion against the action's own description.
function candidateFor(partText, defs) {
  const queryTokens = meaningfulTokens(stripLead(partText));
  if (queryTokens.length === 0) return [];
  const scored = [];
  for (const def of defs) {
    const nameHits = overlap(queryTokens, def.name.replace(/[._-]+/g, ' '));
    const descHits = overlap(queryTokens, def.description);
    const hintHits = overlap(queryTokens, def.inputHint);
    if (nameHits.length === 0 && descHits.length < 2) continue;
    const score = (3 * nameHits.length + descHits.length + hintHits.length) / (3 * queryTokens.length);
    if (score < CANDIDATE_THRESHOLD) continue;
    scored.push({
      name: def.name,
      permission: def.permission,
      score: Math.round(score * 100) / 100,
      basis: nameHits.length > 0 ? 'shared terms with the action name' : 'shared terms with the action description',
    });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, MAX_CANDIDATES);
}

function capabilityFor(text, kind, defs) {
  if (kind === PartKind.CONSTRAINT || kind === PartKind.STATEMENT) {
    return { status: CapabilityStatus.NOT_APPLICABLE, action: null, capability: null, candidates: [], reason: 'this part states a condition or context, not an operation' };
  }
  const routed = route(routingText(text));
  if (routed.kind === 'action') {
    if (defs === null) {
      return { status: CapabilityStatus.ROUTED, action: routed.action, capability: routed.capability ?? routed.action, candidates: [], registered: null, reason: null };
    }
    const registered = defs.some((def) => def.name === routed.action);
    if (!registered) {
      return {
        status: CapabilityStatus.UNAVAILABLE,
        action: routed.action,
        capability: routed.capability ?? routed.action,
        candidates: [],
        registered: false,
        reason: `the action ${routed.action} is not available in this configuration`,
      };
    }
    return { status: CapabilityStatus.ROUTED, action: routed.action, capability: routed.capability ?? routed.action, candidates: [], registered: true, reason: null };
  }
  if (routed.kind !== 'model') {
    // A task question is answered from the task log, not by a model or an action. It is a supported
    // read of APEX's own records, so it is not reported as a missing capability.
    return { status: CapabilityStatus.ROUTED, action: null, capability: routed.capability ?? routed.kind, candidates: [], registered: null, reason: null };
  }
  if (defs === null) {
    return { status: CapabilityStatus.NOT_EVALUATED, action: null, capability: null, candidates: [], registered: null, reason: 'no capability catalogue was supplied' };
  }
  const candidates = candidateFor(text, defs);
  if (candidates.length > 0) {
    return { status: CapabilityStatus.CANDIDATE, action: null, capability: null, candidates, registered: false, reason: 'a registered action shares terms with this part; this is a suggestion, not a mapping' };
  }
  if (kind === PartKind.QUESTION) {
    // A question that matches no action is answered by the model path, which is a registered
    // capability of the application as a whole. It is not a missing action.
    return { status: CapabilityStatus.MODEL, action: null, capability: 'model.answer', candidates: [], registered: null, reason: null };
  }
  return { status: CapabilityStatus.UNMATCHED, action: null, capability: null, candidates: [], registered: false, reason: 'no registered action matches this part' };
}

// The whole decomposition. `capabilities` is an optional array of registry definitions; when it is
// absent the objective still decomposes the request but says capability mapping was not evaluated,
// rather than claiming every part is unmatched.
export function decomposeObjective(text, { capabilities = null, hasContext = false } = {}) {
  const raw = String(text ?? '');
  const shown = singleLine(raw, MAX_TEXT_CHARS);
  const defs = catalogue(capabilities);
  const pieces = raw.trim().length === 0 ? [] : splitParts(raw);
  const dropped = Math.max(0, pieces.length - MAX_PARTS);
  const kept = pieces.slice(0, MAX_PARTS);

  const parts = kept.map((piece, index) => {
    const plain = singleLine(piece.text, MAX_PART_CHARS);
    const kind = classifyKind(piece.text);
    const dependency = dependencyOf(piece.text, index);
    return {
      id: `p${index + 1}`,
      index,
      kind,
      text: plain,
      splitBy: piece.splitBy,
      question: kind === PartKind.QUESTION,
      dependency,
      capability: capabilityFor(piece.text, kind, defs),
    };
  });

  const requestIndices = parts.filter((part) => part.kind === PartKind.REQUEST || part.kind === PartKind.QUESTION).map((part) => part.index);
  const constraints = [];
  for (const part of parts) {
    const kinds = constraintKinds(part.text);
    for (const kind of kinds) {
      if (constraints.length >= MAX_CONSTRAINTS) break;
      constraints.push({
        kind,
        part: part.index,
        // A standalone condition governs the objective; a condition inside a request governs that
        // request. Neither is applied to work it did not accompany.
        appliesTo: part.kind === PartKind.CONSTRAINT ? requestIndices.filter((index) => index !== part.index) : [part.index],
        text: truncate(part.text, 160),
      });
    }
  }

  const unknowns = [];
  const addUnknown = (code, part, detail) => {
    if (unknowns.length >= MAX_UNKNOWNS) return;
    if (unknowns.some((entry) => entry.code === code && entry.part === part)) return;
    unknowns.push({ code, part, detail });
  };
  for (const part of parts) {
    if (part.kind !== PartKind.REQUEST && part.kind !== PartKind.QUESTION) continue;
    const lead = routingText(part.text);
    const leadWord = firstWord(lead);
    if (PRONOUN_SUBJECTS.has(leadWord) && !hasContext) {
      addUnknown(UnknownCode.UNRESOLVED_REFERENCE, part.index, 'the part points at something with a pronoun, and no earlier turn names it');
    }
    // "do it", "continue that", "run them" points at earlier work as surely as a pronoun subject
    // does; without a turn to resolve it against, the part has no referent.
    if (!hasContext && /^(?:do|try|use|run|start|continue|resume|retry|approve|pick\s+up)\s+(?:it|that|this|them|those|these)\b/i.test(lead)) {
      addUnknown(UnknownCode.UNRESOLVED_REFERENCE, part.index, 'the part refers to earlier work by pronoun, and no earlier turn names it');
    }
    if (part.kind === PartKind.REQUEST && TARGETED_VERBS.has(leadWord) && !hasTarget(lead)) {
      addUnknown(UnknownCode.MISSING_TARGET, part.index, `"${leadWord}" was asked for without naming what it applies to`);
    }
    if (looksLikeVagueQuantity(part.text)) {
      addUnknown(UnknownCode.VAGUE_QUANTITY, part.index, 'the amount is stated loosely, so a bounded read cannot be chosen from it');
    }
    if (looksLikeVagueTime(part.text)) {
      addUnknown(UnknownCode.VAGUE_TIME, part.index, 'the time is stated loosely and no date or interval is named');
    }
    if (part.capability.status === CapabilityStatus.UNAVAILABLE) {
      addUnknown(UnknownCode.UNREGISTERED_CAPABILITY, part.index, part.capability.reason);
    } else if (part.capability.status === CapabilityStatus.UNMATCHED) {
      addUnknown(UnknownCode.NO_MATCHING_CAPABILITY, part.index, part.capability.reason);
    }
  }

  const dependencies = parts
    .filter((part) => part.dependency !== null)
    .map((part) => ({ prerequisite: part.dependency.prerequisite, dependent: part.index, kind: part.dependency.kind }));

  const statuses = parts.map((part) => part.capability.status);
  const capabilitiesSummary = {
    evaluated: defs !== null,
    catalogue: defs?.length ?? null,
    parts: parts.length,
    routed: statuses.filter((status) => status === CapabilityStatus.ROUTED).length,
    model: statuses.filter((status) => status === CapabilityStatus.MODEL).length,
    candidates: statuses.filter((status) => status === CapabilityStatus.CANDIDATE).length,
    unmatched: statuses.filter((status) => status === CapabilityStatus.UNMATCHED).length,
    unavailable: statuses.filter((status) => status === CapabilityStatus.UNAVAILABLE).length,
    notApplicable: statuses.filter((status) => status === CapabilityStatus.NOT_APPLICABLE).length,
    notEvaluated: statuses.filter((status) => status === CapabilityStatus.NOT_EVALUATED).length,
  };

  const missingCapabilities = parts
    .filter((part) => part.capability.status === CapabilityStatus.UNMATCHED || part.capability.status === CapabilityStatus.UNAVAILABLE)
    .map((part) => ({ part: part.index, text: truncate(part.text, 160), reason: part.capability.reason }));

  return {
    schema: OBJECTIVE_SCHEMA,
    text: shown,
    parts,
    constraints,
    unknowns,
    dependencies,
    capabilities: capabilitiesSummary,
    missingCapabilities,
    bounded: {
      truncated: dropped > 0 || pieces.some((piece) => piece.text.length > MAX_PART_CHARS),
      parts: MAX_PARTS,
      droppedParts: dropped,
      constraints: MAX_CONSTRAINTS,
      unknowns: MAX_UNKNOWNS,
    },
    authorization: { granted: false, note: OBJECTIVE_NOTE },
  };
}

// The user-facing rendering. Every line is derived from the decomposition above; nothing is added
// to make a part look better supported than it is.
export function renderObjective(objective) {
  if (!objective || !Array.isArray(objective.parts) || objective.parts.length === 0) {
    return 'No parts could be separated from the request.';
  }
  const lines = [`${objective.parts.length} part${objective.parts.length === 1 ? '' : 's'} in the request:`];
  for (const part of objective.parts) {
    const label = part.kind === PartKind.CONSTRAINT ? 'condition' : part.kind;
    let status;
    if (part.capability.status === CapabilityStatus.ROUTED) {
      status = part.capability.action ? `routed to ${part.capability.action}` : `answered by ${part.capability.capability}`;
    } else if (part.capability.status === CapabilityStatus.MODEL) {
      status = 'answered by the model path';
    } else if (part.capability.status === CapabilityStatus.CANDIDATE) {
      status = `possible: ${part.capability.candidates.map((candidate) => `${candidate.name} (${candidate.score})`).join(', ')} - not mapped`;
    } else if (part.capability.status === CapabilityStatus.UNAVAILABLE) {
      status = `unavailable: ${part.capability.reason}`;
    } else if (part.capability.status === CapabilityStatus.UNMATCHED) {
      status = 'no registered action matches';
    } else if (part.capability.status === CapabilityStatus.NOT_EVALUATED) {
      status = 'capability mapping was not evaluated';
    } else {
      status = 'no operation';
    }
    const order = part.dependency ? ` (after part ${part.dependency.prerequisite + 1})` : '';
    lines.push(`${part.index + 1}. [${label}] ${truncate(part.text, 120)}${order} - ${status}`);
  }
  if (objective.constraints.length > 0) {
    lines.push(`Conditions: ${objective.constraints.map((item) => `${item.kind} (part ${item.part + 1})`).join(', ')}.`);
  }
  if (objective.unknowns.length > 0) {
    lines.push(`Unresolved: ${objective.unknowns.map((item) => item.code).join(', ')}.`);
  }
  return lines.join('\n');
}

// The content-free record. Counts and fixed labels only: no part text and no constraint text, so a
// trace can describe the decomposition without copying the request.
export function objectiveAudit(objective) {
  if (!objective || objective.schema !== OBJECTIVE_SCHEMA) return null;
  const count = (predicate) => objective.parts.filter(predicate).length;
  return {
    schema: objective.schema,
    parts: objective.parts.length,
    requests: count((part) => part.kind === PartKind.REQUEST),
    questions: count((part) => part.kind === PartKind.QUESTION),
    conditions: count((part) => part.kind === PartKind.CONSTRAINT),
    statements: count((part) => part.kind === PartKind.STATEMENT),
    constraints: objective.constraints.length,
    constraintKinds: [...new Set(objective.constraints.map((item) => item.kind))].slice(0, 8),
    unknowns: objective.unknowns.length,
    unknownCodes: [...new Set(objective.unknowns.map((item) => item.code))].slice(0, 8),
    dependencies: objective.dependencies.length,
    capabilities: { ...objective.capabilities },
    missingCapabilities: objective.missingCapabilities.length,
    truncated: objective.bounded.truncated,
    authorizes: false,
  };
}
