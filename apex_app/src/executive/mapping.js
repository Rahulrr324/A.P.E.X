// Request-to-capability mapping: the deterministic half of the executive bridge.
//
// Three questions are answered here, from the user's own words and the live registry, and never
// from a model: what kind of executive request this is, which registered capability could carry
// each part of it, and what a plan built from those parts would look like. A part that no
// registered action matches is kept as an explicit unknown and shown to the user; it is never
// filled in with an invented capability name, and a plan is never approved by being described.
//
// Nothing in this module authorizes, stores, or runs anything. It reuses the existing router
// (`route`), the existing goal splitter and step checker (`planFromText`, `splitGoal`,
// `checkSteps`, `describeStep`), and the existing plan content bounds, so there is exactly one
// definition of what a valid step is.
import { route } from '../controller/router.js';
import { singleLine, truncate } from '../util.js';
import { containsSecret } from '../security/secrets.js';
import { splitGoal, checkSteps, describeStep } from '../tasks/planner.js';
import { MAX_STEPS } from '../tasks/model.js';
import {
  MAX_ASSERTIONS, MAX_EXPECTED_CHARS, MAX_PLAN_OUTCOME_CHARS, MAX_PRECONDITIONS,
  MAX_PRECONDITION_CHARS,
} from '../plans/model.js';
import { RequestMode, SideEffect, Reversibility, StatusQuestion } from './vocabulary.js';

// An id-shaped reference. Plan and task ids are UUIDs, so a short reference is hex-shaped; that
// also keeps an ordinary word after "plan" ("start plan for the garden") from being read as one.
const PLAN_REF_RE = /\bplans?\s*#?\s*([0-9a-f][0-9a-f-]{3,63})\b/i;
const GOAL_REF_RE = /\bgoals?\s*#?\s*([0-9a-f][0-9a-f-]{3,63})\b/i;
const UUID_RE = /\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b/i;

// Preparation requests are marked by the user's own words. A statement that merely describes work
// is not turned into a stored plan: recording a plan is a write, and it happens only when the user
// asked for a plan.
const PREPARE_MARKER = /\b(?:(?:make|build|create|draft|write|give me|prepare|plan)\s+(?:me\s+)?(?:a|an|the|us|this)?\s*(?:new\s+|draft\s+|execution\s+)?plans?\b|(?:lay|outline|plan|draft)\s+(?:out\s+)?(?:this|it|that|the\s+following|these)\b|^(?:plan|prepare|draft|outline|lay\s+out|step[\s-]*by[\s-]*step)\b|as\s+(?:a|an)\s+(?:execution\s+)?plan\b|in\s+(?:\d+|two|three|four|five|six|seven|eight)\s+steps?\b|next\s+steps?\s*:|plan\s+(?:of|for|to)\s+(?:action\s+)?steps?\b)/i;
const PREPARE_LEAD = /^\W*(?:please\s+|now\s+|also\s+|and\s+)?(?:can\s+you\s+|could\s+you\s+|will\s+you\s+)?(?:(?:i\s+'m|i\s+am)\s+asking\s+you\s+to\s+)?(?:(?:plan|prepare|draft|outline|lay\s+out|make\s+(?:a|the)\s+plan(?:\s+for)?)\b[\s:,-]*(?:out\s+|up\s+|a\s+|an\s+|the\s+|my\s+|this\s+|that\s+|to\s+|for\s+)*)/i;
const FILLER_LEAD = /^(?:and\s+|then\s+|to\s+|for\s+|that\s+|it\s+|the\s+|a\s+|an\s+|my\s+|our\s+|please\s+)+/i;

const APPROVE_MARKER = /^\W*(?:please\s+|now\s+)?(?:approve|accept|authori[sz]e|sign\s+off\s+on|give\s+(?:the\s+)?go[-\s]?ahead\s+for)\b/i;
const EXECUTE_MARKER = /^\W*(?:please\s+|now\s+)?(?:start|run|execute|carry\s+out|activate|begin\s+(?:work(?:ing)?)?\s+on|proceed\s+with|go\s+ahead\s+with)\b/i;

// A request for a different approach to a plan already recorded. It is tested before the preparation
// markers, because "replan plan x" contains the words "plan plan", which a preparation test would
// otherwise read as a request to draft a new plan from the user's own text. A revision of a recorded
// plan is a different act, and which plan is being revised has to be answered from the record.
const REPLAN_MARKER = /^\W*(?:please\s+|now\s+|also\s+)?(?:(?:can|could|would)\s+you\s+)?(?:re-?plan\b(?:\s+(?:the|this|that|plan)\b)?|(?:revise|replace|redraft|amend)\s+(?:an?\s+|the\s+|this\s+|that\s+)?(?:alternative|different|revised|new|fresh)?\s*plans?\b|(?:draw\s+up|produce|generate|offer|make|draft)\s+(?:an?\s+|the\s+|this\s+)?(?:alternative|different|revised|new|fresh)\s+(?:plan|approach)\b|(?:make|draft|plan)\s+an\s+alternative\b)/i;

// Executive status: what APEX's own records say about open work. Task-level questions are already
// answered from the task log by the router, so these are the portfolio-level ones - the plan, goal,
// approval, and continuation dimension the task log cannot answer.
const STATUS_PATTERNS = [
  [StatusQuestion.APPROVAL, /\b(?:what|which|anything)\b[^?!.]*\b(?:needs?|waiting|requir\w*|pending|owes?)\b[^?!.]*\b(?:my|our|your)?\s*(?:approv\w*|authoriz\w*|decision|sign[-\s]?off|go[-\s]?ahead)\b/i,
    /\b(?:do|does)\s+(?:i|we)\s+need\s+to\s+(?:approve|authori[sz]e)\b/i,
    /\bwhat\s+(?:am|are)\s+(?:i|we)\s+waiting\s+to\s+(?:approve|authori[sz]e)\b/i],
  [StatusQuestion.BLOCKED, /\b(?:what|which|is|are|anything)\b[^?!.]*\b(?:block\w*|stuck|halt\w*)\b/i],
  [StatusQuestion.UNCERTAIN, /\b(?:what|which|is|are|anything)\b[^?!.]*\buncertain\w*\b/i],
  [StatusQuestion.FAILED, /\b(?:what|which|anything)\b[^?!.]*\b(?:fail\w*|went wrong|error\w*)\b/i],
  [StatusQuestion.COMPLETED, /\b(?:what|which)\b[^?!.]*\b(?:have\s+you|did\s+APEX|already|so\s+far)\b[^?!.]*\b(?:completed?|finished?|done|verified|achieved?)\b/i,
    /\b(?:how\s+much|how\s+many)\b[^?!.]*\b(?:done|completed|finished)\b/i,
    /\bwhat\s+(?:did|have|has)\s+you\s+do\b[^?!.]*\b(?:so\s+far|already|yet|up\s+to\s+now|until\s+now)\b/i,
    /\bwhat\s+have\s+you\s+(?:done|achieved|accomplished|finished|completed)\b/i,
    /\bwhat(?:'s| is)\s+(?:been\s+)?(?:done|completed|finished|achieved)\b/i],
  [StatusQuestion.CANCEL, /\b(?:can|could|should|do)\s+(?:we|i|you)\b[^?!.]*\bcancel\w*\b/i],
  [StatusQuestion.CONTINUE, /\b(?:can|could|should|are)\s+(?:we|i|you|it)\b[^?!.]*\b(?:continue|resume|carry\s+on|keep\s+going|pick\s+(?:it|this)\s+up|start\s+again)\b/i,
    /\b(?:is|are)\s+(?:there\s+)?(?:anything|work|plans?)\s+(?:left\s+)?(?:to\s+)?\b(?:continue|resume|proceed)\b/i],
  [StatusQuestion.ACTIVITY, /\bwhat\s+(?:are|is)\s+you\s+(?:doing|up\s+to|working\s+on)\b/i,
    /\bwhat\s+is\s+APEX\s+(?:doing|working\s+on)\b/i],
  [StatusQuestion.NEXT, /\bwhat(?:'s| is)?\s+(?:the\s+)?(?:next|following)\s+(?:step|thing|move|action|task|plan)\b/i,
    // "what next", "what's next" and "what is next" are the same question, and the apostrophe form is
    // how most people type it. Left unmatched it fell through to a model, which cannot read the
    // records that answer it.
    /^\s*(?:what(?:'s|s| is)?\s+next|next\s+steps?)\s*[?.!]*$/i],
    // Deliberately unmatched: "what should I do next?" asks for advice, not for a reading of the
    // records. The cognitive path answers it - it reads the same goal and plan records, gives them to
    // the configured model, and marks any recommendation as not executed. A status view has no basis
    // to say what the user should do, so it does not claim the question.
  [StatusQuestion.PROGRESS, /\b(?:status|progress)\s+(?:report|update|of|on)\b/i,
    /\b(?:report|summarise|summarize)\b[^?!.]*\b(?:progress|status|work|plans?)\b/i,
    /\bhow'?s\s+(?:the\s+)?(?:plan|work|progress)\b/i,
    /\b(?:any|what)\s+progress\b/i,
    // "how close am I to finishing" is the same reading of the recorded step outcomes the progress
    // question is, asked in the words a user reaches for when they are part-way through.
    /\bhow\s+close\b[^?!.]*\b(?:am\s+i|are\s+we|is\s+(?:it|APEX|the\s+plan))\b/i,
    /\b(?:current|overall)\s+(?:status|progress)\b/i],
  // Whether a plan can be taken up now. "ready" and "what is stopping it" are the two halves of the
  // same question, and both are answered by the live check rather than by a guess.
  [StatusQuestion.READINESS, /\b(?:is|are|can|could)\b[^?!.]*\b(?:ready|prepared|startable|runnable)\b/i,
    /\bhow\s+ready\b/i,
    // The noun form names this reading exactly, so it is matched wherever it appears and about
    // whichever record the request carries.
    /\breadiness\b/i,
    /\bwhat\s+(?:is\s+|would\s+)?(?:still\s+)?(?:holding\s+up|holding\s+(?:it|that|this|the\s+plan)\s+up|stopping|in\s+the\s+way)\b/i,
    /\bcan\s+(?:we|i|you|APEX)\b[^?!.]*\b(?:start|run|execute|proceed\s+with)\b[^?!.]*\bplan\b/i,
    /\bwhat\s+(?:do\s+I|do\s+we|would\s+you)\s+do\s+(?:now|next)\s+(?:with|on)\s+(?:the\s+)?plan\b/i],
  // What other approaches exist. The question is about the candidate set a goal supports, which no
  // single record holds: it is produced by reading the goal and the live registry together.
  [StatusQuestion.OPTIONS, /\b(?:what|which|how\s+many)\b[^?!.]*\b(?:options?|alternatives?|choices?|candidate\s+plans?|other\s+plans?)\b[^?!.]*\b(?:do\s+(?:i|we)\s+have|are\s+there|do\s+you\s+(?:have|offer|know)|exist)\b/i,
    // The short form, allowed to carry which record it is about: "what are my options for goal x" is
    // the same question as "what are my options", and a request about something APEX does not hold is
    // turned away by the noun guard rather than by this pattern stopping at the noun. Only the
    // punctuation that closes the question may sit at the end.
    /^\s*what(?:'s|s| are| is)?\s+(?:the\s+|my\s+|our\s+)?(?:other\s+)?(?:options|alternatives|choices)\b[^?!.]*[?.!]*\s*$/i,
    /\b(?:which|what)\s+(?:plan|approach|option|candidate)\b[^?!.]*\b(?:should|is\s+(?:better|best|safer)|do\s+(?:i|we)|would\s+you)\b/i,
    /\b(?:what|which)\s+other\s+(?:plans?|approaches?|options?|candidates?)\b/i,
    /\b(?:compare|evaluate)\b[^?!.]*\b(?:plans?|approaches|options?|candidates?)\b/i,
    /\b(?:is|are)\s+there\s+(?:any\s+)?(?:other\s+)?(?:plans?|approaches|options?|candidates?)\b/i],
  // What the execution established, as distinct from what it recorded: the question is answered by the
  // outcome reading, which re-reads the audit log and the criteria rather than the plan's own text.
  [StatusQuestion.OUTCOME, /\bwhat\s+(?:was|is)\s+the\s+outcome\b/i,
    /\b(?:did|has|have)\b[^?!.]*\bplan\b[^?!.]*\b(?:work|worked|succeed|succeeded|achieve|accomplish|done)\b/i,
    /\bhow\s+did\b[^?!.]*\bplan\b[^?!.]*\b(?:go|turn\s+out|end|finish)\b/i,
    /\bdid\s+it\s+work\b/i,
    /\bwhat\s+(?:evidence|proof)\b[^?!.]*\b(?:support|back|for|show)\b/i,
    /\b(?:is|was|has)\b[^?!.]*\b(?:the\s+)?(?:goal|plan)\b[^?!.]*\b(?:achieved|met|reached|satisfied|completed)\b/i],
];

function firstMatch(patterns, text) {
  for (const pattern of patterns) if (pattern.test(text)) return true;
  return false;
}

// A status question is about APEX's own open work. A request whose definite or possessive phrases
// name something APEX does not hold - "the story", "my essay", "the print job" - is about that
// thing, and the ordinary answer path keeps it. A phrase is read as the words after its determiner
// up to the next preposition, verb or determiner, so "the next step" counts as an executive phrase
// because the noun it is about, "step", is inside it.
const DETERMINERS = new Set(['the', 'a', 'an', 'this', 'that', 'these', 'those', 'my', 'your', 'our', 'his', 'her', 'their']);
// Words that end a noun phrase. Everything after one belongs to another clause or another phrase.
const PHRASE_BREAK = new Set(['of', 'for', 'to', 'in', 'on', 'at', 'by', 'with', 'about', 'as', 'into',
  'onto', 'from', 'and', 'or', 'but', 'so', 'that', 'which', 'who', 'whom', 'whose', 'is', 'are', 'was',
  'were', 'be', 'been', 'being', 'am', 'do', 'does', 'did', 'have', 'has', 'had', 'will', 'would', 'can',
  'could', 'shall', 'should', 'may', 'might', 'must', 'if', 'when', 'while', 'because', 'than', 'then',
  'how', 'what', 'why', 'not', 'no', 'yes']);
// The planning nouns are in this vocabulary because the candidate set is one of APEX's own records: a
// question about which approaches exist is answered by reading a goal and the live registry, not by
// advice, so "my options" is about APEX's work in the same way "my plans" is.
const EXECUTIVE_WORD = /^(?:plan|goal|step|task|work|approv|authoriz|decision|progress|status|uncertaint|block|fail|error|outcome|run|resume|contin|cancel|queue|backlog|item|record|evidence|option|alternativ|choic|candidate|approach|readi|nothing|anything|left|pending|open|unfinished|done|finished|completed|verified)[\w'-]*$/i;

// The preposition that introduces what a phrase is about. "the status of Atlas" names the reading
// ("status") and then the subject ("Atlas"), so an executive word appearing as the reading is not
// evidence that the question is about APEX's work: the subject after the preposition is.
const OBJECT_PREP = new Set(['of', 'on', 'for', 'in', 'at', 'about']);

// Whether the object of a phrase names something this vocabulary has no word for. A phrase with no
// object at all ("the overall status") is about APEX's own records; an object whose words are all
// outside that vocabulary ("of parcel locker") is about the thing it names.
function objectIsForeign(words, from) {
  let i = from;
  while (i < words.length && DETERMINERS.has(words[i])) i += 1;
  const tail = [];
  while (i < words.length && !PHRASE_BREAK.has(words[i]) && !DETERMINERS.has(words[i])) {
    if (OBJECT_PREP.has(words[i])) break;
    if (EXECUTIVE_WORD.test(words[i])) return false;
    tail.push(words[i]);
    i += 1;
  }
  return tail.length > 0;
}

function pointsAtSomethingElse(text) {
  const words = String(text).toLowerCase().match(/[\w'-]+/g) ?? [];
  for (let i = 0; i < words.length; i += 1) {
    if (!DETERMINERS.has(words[i])) continue;
    let executive = false;
    let objectAt = -1;
    for (let j = i + 1; j < words.length; j += 1) {
      const word = words[j];
      // The object is read even after an executive word, because "the status of Atlas" has both: the
      // reading APEX would give and the thing it would be about.
      if (OBJECT_PREP.has(word)) { objectAt = j + 1; break; }
      if (PHRASE_BREAK.has(word) || DETERMINERS.has(word)) break;
      if (EXECUTIVE_WORD.test(word)) executive = true;
    }
    if (!executive) return true;
    if (objectAt >= 0 && objectIsForeign(words, objectAt)) return true;
  }
  return false;
}

// The plan reference a request names, or null. A full UUID is accepted anywhere; a short reference
// must follow the word "plan", because a bare hex-shaped token is too easy to misread.
//
// The word before a UUID says which record it names. Goal ids and plan ids are the same shape, so a
// UUID written after "goal" is a goal and reading it as a plan would act on the wrong record.
function namesGoal(text, uuidIndex) {
  const before = String(text).slice(0, uuidIndex).trim().toLowerCase();
  return /(?:^|\s)goals?$/.test(before);
}

export function planRefOf(text) {
  const source = String(text ?? '');
  const named = PLAN_REF_RE.exec(source);
  if (named) return named[1];
  const uuid = UUID_RE.exec(source);
  if (!uuid) return null;
  return namesGoal(source, uuid.index) ? null : uuid[0].toLowerCase();
}

// The goal reference a request names, or null. Unlike a plan reference, a bare UUID never counts as
// one: goals are named by their id only when the words say so, because the ordinary way to refer to a
// goal is to describe it, and a description is not an id.
export function goalRefOf(text) {
  const source = String(text ?? '');
  const named = GOAL_REF_RE.exec(source);
  if (named) return named[1];
  const uuid = UUID_RE.exec(source);
  if (!uuid) return null;
  return namesGoal(source, uuid.index) ? uuid[0].toLowerCase() : null;
}

// Which executive status question, if any, this request asks. A request that points at something
// other than APEX's own work is not one, whatever verb it uses: the noun guard is what keeps
// "what's next on the menu?" off this path.
export function statusQuestionOf(text) {
  const raw = String(text ?? '').trim();
  if (raw.length === 0 || raw.length > 500) return null;
  if (pointsAtSomethingElse(raw)) return null;
  for (const [question, ...patterns] of STATUS_PATTERNS) {
    if (firstMatch(patterns, raw)) return question;
  }
  return null;
}

// The cheap first pass. It decides only whether the deeper mapping is worth doing, so an ordinary
// informational request costs one regex set and keeps the path it had before this layer existed.
export function executiveSignal(text, { plansAvailable = true } = {}) {
  const raw = String(text ?? '').trim();
  if (raw.length === 0 || raw.length > 500 || !plansAvailable) return null;
  if (containsSecret(raw)) return null;
  const question = statusQuestionOf(raw);
  // A status question carries the references it names, because "what was the outcome of plan x" and
  // "what are my options" are answered about different records. Carrying them here means the answer
  // is read about the record the user named rather than about whichever one the store lists first.
  if (question) {
    return { mode: RequestMode.STATUS, question, request: raw, ref: planRefOf(raw), goalRef: goalRefOf(raw) };
  }

  if (APPROVE_MARKER.test(raw)) {
    const ref = planRefOf(raw);
    if (ref) return { mode: RequestMode.APPROVE, ref, request: raw };
    // An approval that mentions a plan but names no reference is asked about: approving the wrong
    // record because it was the last one discussed is the failure this bridge must not have.
    if (/\bplans?\b/i.test(raw)) return { mode: RequestMode.CLARIFY, reason: 'approval-needs-a-plan', request: raw };
    return null;
  }

  if (EXECUTE_MARKER.test(raw)) {
    const ref = planRefOf(raw);
    // "start the garden project" is not an executive command APEX can honour, and refusing it here
    // would be worse than letting the ordinary path answer it. Only a named plan is an execution
    // request.
    if (!ref) return null;
    return { mode: RequestMode.EXECUTE, ref, request: raw };
  }

  if (REPLAN_MARKER.test(raw)) {
    // Which record is being revised has to be answered from the request, because a revision recorded
    // against the wrong plan would replace work the user never spoke about. A plan reference names
    // the plan being answered; a goal reference alone asks for a different approach to that goal,
    // which is generated from the goal's recorded criteria.
    const ref = planRefOf(raw);
    if (ref) return { mode: RequestMode.REPLAN, ref, goalRef: goalRefOf(raw), request: raw };
    const goalRef = goalRefOf(raw);
    if (goalRef) return { mode: RequestMode.REPLAN, ref: null, goalRef, request: raw };
    if (/\b(?:plans?|goals?|approach\w*|alternativ\w*)\b/i.test(raw)) {
      return { mode: RequestMode.CLARIFY, reason: 'replan-needs-a-plan', request: raw };
    }
    return null;
  }

  if (PREPARE_MARKER.test(raw)) {
    const goalRef = goalRefOf(raw);
    const workText = residualWorkText(raw);
    // A preparation with no work left in it after the marker words are removed is only a request APEX
    // can answer when it names a recorded goal: the goal's own criteria are then the work, and the
    // candidate set is generated from them. With no goal named there is nothing to plan against, and
    // the ordinary path keeps the request.
    if (workText.length === 0 && !goalRef) return null;
    return { mode: RequestMode.PREPARE, workText, goalRef, request: raw };
  }
  return null;
}

// The part of a preparation request that could be a step. The marker words the user used to ask
// for a plan are not part of the work, and a "context: steps" form carries the steps after the
// colon.
//
// A recorded goal named by its id says which intention the plan serves; it is not part of the work a
// step carries. The bridge hands it to the plan store as `goalId`, so leaving it in the work text
// would ask the router to match a sentence whose only content is an id.
const GOAL_PHRASE_RE = /\b(?:for\s+|under\s+|against\s+|on\s+|to\s+|with\s+)?goals?\s*#?\s*[0-9a-f][0-9a-f-]{3,63}\b/gi;

export function residualWorkText(text) {
  let rest = String(text ?? '').replace(PREPARE_LEAD, '').trim();
  rest = rest.replace(GOAL_PHRASE_RE, ' ').replace(/\s{2,}/g, ' ').trim();
  if (rest.length === 0) return '';
  const colon = rest.indexOf(':');
  if (colon >= 0 && rest.slice(colon + 1).trim().length > 0 && colon < 80) rest = rest.slice(colon + 1).trim();
  rest = rest.replace(FILLER_LEAD, '').trim();
  // "prepare a plan to remember X": the verb the user used is stripped above, but the noun they
  // asked for is left behind, and "plan to remember X" is not a request the router can match. The
  // plan being requested is not part of the work it describes, so it is removed here too, including
  // when nothing follows it ("prepare a plan for goal <id>" names its work in the goal, not in a
  // clause). A word boundary, not a space, is what leaves "planning the rollout" untouched.
  rest = rest.replace(/^plans?\b\s*(?:to\s+|for\s+|that\s+|of\s+action\s+)?/i, '').trim();
  if (/^(?:out|up|to|a|an|the|my|this|that|for)\b/i.test(rest)) {
    rest = rest.replace(/^(?:out|up|to|a|an|the|my|this|that|for)\s+/i, '').trim();
  }
  return rest;
}

// Each part of the work text, resolved against the registry: the parts a registered capability
// could carry, and the parts that cannot be completed now. A part that the router does not match is
// an unknown, stated as the user wrote it; the bridge never substitutes a plausible action name.
//
// A segment the router cannot match is tried once more as a coordination of two requests ("list the
// notes and add a note that the build passed"), and is split only when every resulting part routes
// to a registered action on its own. A segment the router already matches is never split, because
// "remember the date and the release" is one memory, not two.
const JOINED_BY = /\s+(?:and\s+then|and|plus|also|then)\s+/i;

// The part, or null with a stated reason. `registry` must hold the action and accept its input.
function resolvePart(text, registry) {
  const routed = route(text);
  if (routed.kind !== 'action') return null;
  const def = registry.get(routed.action);
  if (!def) return { missing: `the action ${singleLine(routed.action, 40)} is not available in this configuration` };
  try {
    return { def, routed, input: def.validate(routed.input) };
  } catch (err) {
    return { missing: `the action ${def.name} refused this input: ${singleLine(err?.message ?? 'invalid input', 120)}` };
  }
}

function asStep(text, resolved) {
  const { def, routed, input } = resolved;
  return {
    text,
    action: routed.action,
    capability: routed.capability ?? routed.action,
    input,
    permission: def.permission,
    sideEffect: def.permission === 'write' ? SideEffect.APPEND : SideEffect.NONE,
    reversibility: def.permission === 'write' ? Reversibility.APPEND : Reversibility.READ,
    description: singleLine(describeStep(text, routed.action, input), MAX_EXPECTED_CHARS),
  };
}

// Split into parts only if all of them resolve. Up to MAX_STEPS parts, so an unbounded list of
// coordinations cannot become an oversized plan.
function splitIfAllResolve(text, registry) {
  const parts = text.split(JOINED_BY).map((p) => p.trim()).filter((p) => p.length > 0);
  if (parts.length < 2 || parts.length > MAX_STEPS) return null;
  const resolved = parts.map((part) => resolvePart(part, registry));
  if (resolved.some((r) => r === null || r?.missing)) return null;
  return parts.map((part, i) => asStep(part, resolved[i]));
}

export function mapWorkText(workText, registry) {
  const segments = splitGoal(workText);
  const mapped = [];
  const unmapped = [];
  for (const segment of segments) {
    const direct = resolvePart(segment, registry);
    if (direct && !direct.missing) {
      mapped.push(asStep(segment, direct));
      continue;
    }
    if (direct?.missing) {
      unmapped.push({ text: segment, reason: direct.missing });
      continue;
    }
    const split = splitIfAllResolve(segment, registry);
    if (split) {
      mapped.push(...split);
      continue;
    }
    unmapped.push({ text: segment, reason: 'no registered action matches this part of the request' });
  }
  return { segments, mapped, unmapped };
}

// What a step's expected result and verification are, said as the registry defines them: a write
// appends a record its own verifier re-reads, and a read returns a result and changes nothing.
// These are descriptions of the check that will run, not promises that it will pass.
export function stepExpectation(def) {
  if (def.permission === 'write') {
    return {
      expectedResult: `${def.name} appends one persistent record to the store it owns, and that record can be read back by id`,
      verification: `${def.name} verify(): the action's own independent re-read of the record it wrote`,
      risk: 'medium',
      sideEffect: SideEffect.APPEND,
    };
  }
  return {
    expectedResult: `${def.name} returns its result; no APEX store changes`,
    verification: `${def.name} verify(): the action's own independent re-check of the returned result`,
    risk: 'low',
    sideEffect: SideEffect.NONE,
  };
}

function preconditionFor(mapped, goalId) {
  const list = [];
  if (goalId) {
    list.push(`the goal ${truncate(String(goalId), 24)} is recorded and is not completed, failed, cancelled, or superseded`);
  }
  if (mapped.some((m) => m.action.startsWith('filesystem.'))) {
    list.push('an authorised filesystem root is configured, or these steps are unavailable');
  }
  if (mapped.some((m) => m.permission === 'write')) {
    list.push('the stores these steps write can be written: a corrupt or locked store makes a step fail rather than guess');
  }
  if (mapped.some((m) => m.action === 'memory.add' && m.input?.sensitivity === 'private')) {
    list.push('a private memory write cannot be part of a plan; that step must be remembered on its own');
  }
  return list.slice(0, MAX_PRECONDITIONS).map((p) => singleLine(p, MAX_PRECONDITION_CHARS));
}

function assertionsFor({ requestText, unmapped, mappedCount }) {
  const assertions = [];
  if (requestText) {
    assertions.push({ kind: 'user_fact', text: singleLine(`the user asked for: ${requestText}`, MAX_EXPECTED_CHARS) });
  }
  for (const part of unmapped.slice(0, MAX_ASSERTIONS - 2)) {
    assertions.push({
      kind: 'unknown',
      text: singleLine(`cannot be completed by any registered capability: "${part.text}" (${part.reason})`, MAX_EXPECTED_CHARS),
    });
  }
  if (mappedCount > 1) {
    assertions.push({
      kind: 'inference',
      text: 'steps are ordered as written and run one at a time: the task runner has no parallel path, so independence is not assumed',
    });
  }
  return assertions.slice(0, MAX_ASSERTIONS);
}

// Build the plan content a preparation request resolves to. `checkSteps` is run over the mapped
// parts, so the authorization, dependency, and input rules that guard every plan are the ones
// applied here - this module adds no policy of its own.
export function synthesizePlan({ request, workText, registry, goalId = null, now = null }) {
  const { segments, mapped, unmapped } = mapWorkText(workText, registry);
  const problems = [];
  if (mapped.length === 0) {
    return {
      ok: false,
      reason: 'nothing-mapped',
      problems: ['no part of this request matches a registered action, so no step could be recorded'],
      segments, mapped, unmapped, content: null,
    };
  }
  const checked = checkSteps(mapped.map((m, i) => ({
    id: `s${i + 1}`,
    description: m.description,
    action: m.action,
    input: m.input,
    dependsOn: i === 0 ? [] : [`s${i}`],
  })), registry, 'user');
  if (checked.problems.length > 0) {
    return { ok: false, reason: 'policy-refused', problems: checked.problems, segments, mapped, unmapped, content: null };
  }
  const steps = checked.steps.map((s, i) => {
    const def = registry.get(s.action);
    const expectation = stepExpectation(def);
    return {
      id: s.id,
      description: s.description,
      action: s.action,
      input: s.input,
      dependsOn: [...s.dependsOn],
      expectedResult: singleLine(expectation.expectedResult, MAX_EXPECTED_CHARS),
      verification: singleLine(expectation.verification, MAX_EXPECTED_CHARS),
      risk: expectation.risk,
      estimate: { seconds: null },
    };
  });
  const outcome = singleLine(request, MAX_PLAN_OUTCOME_CHARS) || singleLine(workText, MAX_PLAN_OUTCOME_CHARS);
  const content = {
    goalId,
    outcome,
    steps,
    preconditions: preconditionFor(mapped, goalId),
    assertions: assertionsFor({ requestText: singleLine(workText, MAX_EXPECTED_CHARS), unmapped, mappedCount: steps.length }),
    estimatedSeconds: null,
    reason: `prepared from the user's own request${now ? ` at ${new Date(now).toISOString()}` : ''}`,
  };
  return {
    ok: true,
    reason: null,
    problems: [],
    segments,
    mapped: steps.map((s, i) => ({ ...mapped[i], id: s.id })),
    unmapped,
    content,
  };
}

// Per-step authorization as the registry decides it right now, for the origin that would run it.
// The preview prints these, so the user sees the same answer the runner will reach later.
export function authorizationReview(steps, registry) {
  return steps.map((s) => {
    const def = registry.get(s.action);
    const user = registry.authorize(s.action, 'user');
    const model = registry.authorize(s.action, 'model');
    return {
      id: s.id,
      action: s.action,
      permission: def?.permission ?? 'unknown',
      plannable: def ? def.plannable !== false : false,
      userDecision: user.decision,
      userReason: user.reason,
      modelDecision: model.decision,
      modelReason: model.reason,
      hasVerifier: typeof def?.verify === 'function',
      sideEffect: def?.permission === 'write' ? SideEffect.APPEND : SideEffect.NONE,
      reversibility: def?.permission === 'write' ? Reversibility.APPEND : Reversibility.READ,
    };
  });
}
