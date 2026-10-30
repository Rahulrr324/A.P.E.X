// Implementation 053: what a follow-up points at, and which recorded task that is.
//
// This module reads the *language* of a request only to find out what the user is
// pointing at and what they want to know. It never decides that a task exists and never
// decides that anything succeeded - that is the task log and the operation audit, read by
// the controller (CognitiveController#explainTaskRequest). No model is consulted here: a
// follow-up that cannot be resolved from the records is asked about, not answered from
// what a model remembers of the task.
//
// The lists below are question *classes*, not phrasings. A request becomes a task
// question only when it has a class AND something that points at a task, so an ordinary
// sentence that merely mentions the word "task" stays an ordinary request.

// Task ids are UUIDs. A whole id is recognised anywhere in the request, with or without
// the word "task" beside it. A short id - what `task list` prints, and what APEX itself
// quotes back - is only recognised after a cue, so a number that happens to be written in
// hexadecimal characters is not read as an id.
const UUID = /\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b/gi;
const CUED_ID = /\b(?:tasks?|task\s+ids?|ids?)\s+#?\s*([0-9a-f][0-9a-f-]{3,35})\b|(?:^|[\s(,:])#([0-9a-f][0-9a-f-]{3,35})\b/gi;

// A command addressed to APEX is a request to change something, not a question about what
// a record already says. Those belong to the action and approval paths, where authorization
// applies; answering one here would imply that the change had been made.
const STATE_CHANGING_COMMAND = /^(?:please\s+|now\s+|also\s+|and\s+|then\s+)?(?:do|make|create|plan|build|add|start|set|mark|change|update|delete|remove|run|resume|cancel|retry|approve|execute|ignore|forget|continue|proceed|carry\s+on|go\s+ahead|pick\s+up)\b/i;
// "do it again" is an instruction; "do I need to approve it?" is a question. A verb followed
// by a person as its subject is the second one, so the command rule above does not apply.
// Object pronouns are deliberately absent: "do it" is how an instruction starts.
const INTERROGATIVE_SUBJECT = /^(?:do|does|did)\s+(?:i|we|you|they)\b/i;

// An explicit request for the most recently discussed task. Recency is what the user named,
// so choosing it is not a silent choice between candidates.
const RECENT_SELECTOR = /\b(?:the|this|that|our)?\s*(?:last|latest|newest|most\s+recent|current)\s+tasks?\b/i;

// A reference to a task or to its steps.
const TASK_WORD = /\b(?:tasks?|steps?)\b/i;
const PRONOUN = /\b(?:it|its|they|them|this|that|these|those)\b/i;
// An indefinite is a subject of its own: "explain something long" asks about *something*,
// not about a record.
const VAGUE_REFERENT = /\b(?:some|any|no|every)(?:thing|one|body|where)\b/i;
// A task being asked for is not a task being referred back to. "explain the task of sorting
// my downloads" states a goal, so it must not be answered as a question about a record -
// and a definite article does not turn a goal into a reference.
const GOAL_OF_TASK = /\btasks?\s+(?:of|that|to|for)\s/i;
const GOAL_REQUESTED = /\b(?:a|an|another|new|one|two|three|several|some|any|the following)\s+tasks?\b|\b(?:create|plan|make|build|add|start|want|need)\s+(?:a|an|us|me|you)?\s*(?:new\s+)?tasks?\b/i;
// Nouns that name the question being asked ("does it need my approval?", "what is the
// state?") rather than a thing a pronoun could stand for.
const ABSTRACT_NOUNS = 'approv\\w*|permiss\\w*|authoriz\\w*|sign[- ]?off|go[- ]?ahead|help|aid|notice|word|news|update|progress|status|state|end|start|beginning|top|bottom|point|time|way|issue|matter|result|outcome';
// A follow-up with no task word and no id can only be about the task if nothing else in it
// could be what it refers to. "how did it go with the report?" asks about the report;
// "did it finish?" and "what is still pending?" name no other thing.
const OTHER_NOUN_PHRASE = new RegExp(
  `\\b(?:the|a|an|my|your|his|her|its|their|our|some|any|each|every)\\s+(?!(?:tasks?|steps?|ones?|first|second|third|fourth|next|previous|last|latest|newest|most|current|remaining|pending|same|above|earlier|before|${ABSTRACT_NOUNS})\\b)[\\w-]+`,
  'i',
);
// A bare follow-up stays a single thought: past this length, or with a proper noun in it,
// the request is describing something else, and that is its referent. A capital at the very
// start of the request is sentence punctuation, not a name, so it is not tested.
const MAX_FOLLOWUP_WORDS = 8;
const PROPER_NOUN = /\b[A-Z][a-z]{2,}/;

// Question classes, in the order they are decided. The most specific come first, so "can
// you explain why it stopped?" is an interruption question rather than a request for the
// whole status view, and "did it finish, or is something still pending?" is answered as the
// pending question it ends on.
const OUTCOME_INTENTS = [
  ['approval', /\b(?:approv\w*|authoriz\w*|permiss\w*|sign[- ]?off|waiting for me|need me|do i need|can i go ahead)\b/i],
  ['recovery', /\b(?:resum\w*|retr\w*|recover\w*|continue|carry on|pick(?:ing)? (?:it|that|the task) up|restart|start over|back on track|do it again|(?:runs?|ran|running|rerun)\w*\b[^?!.]*\bagain\b)/i],
  ['why_stopped', /\bwhy\b[^?!.]*\b(?:stop\w*|fail\w*|failure|pause\w*|cancel\w*|abort\w*|halt\w*|error\w*|crash\w*|break\w*|stuck|never ran|did not run)\b/i],
  ['steps_succeeded', /\b(?:which|what)\b[^?!.]*\b(?:steps?|ones?)\b[^?!.]*\b(?:succeed\w*|complete\w*|verif\w*|passed|ran|worked|finished)\b/i],
  ['pending', /\b(?:pending|left|remaining|yet to (?:run|do)|to go|unstarted|still to (?:do|run|be done)|not (?:yet )?(?:been )?(?:run|done|finished|completed|started))\b/i],
  ['finished', /\b(?:finish(?:ed|es)?|complet\w*|done|over|succe\w*|success\w*|worked|went through|verif\w*|verified)\b/i],
  ['status', /\b(?:status|state|progress|update|explain|what happened|how did|tell me about|where is it)\b/i],
];

const MAX_CANDIDATE_CHARS = 500;

// The task ids a request names, in the order they appear, lowercased: ids are stored in
// lowercase, and the same id typed in capitals is the same id.
export function explicitTaskIds(text) {
  const found = [];
  const add = (raw) => {
    const id = String(raw ?? '').toLowerCase().replace(/^#/, '');
    if (id.length > 0 && !found.includes(id)) found.push(id);
  };
  const source = String(text ?? '');
  for (const match of source.matchAll(UUID)) add(match[0]);
  for (const match of source.matchAll(CUED_ID)) add(match[1] ?? match[2]);
  return found;
}

// Which question class a request is, or null when it asks about no recorded outcome at all.
export function intentOf(text) {
  for (const [name, pattern] of OUTCOME_INTENTS) {
    if (pattern.test(text)) return name;
  }
  return null;
}

// The language-only half of the decision: does this request point at a task, and what does
// it want to know? A candidate is not yet an answer - the controller has to find the task it
// refers to in the records, and it may still ask instead of answering.
export function taskQuestionCandidate(text) {
  const raw = String(text ?? '').trim();
  if (raw.length === 0 || raw.length > MAX_CANDIDATE_CHARS) return null;
  if (!INTERROGATIVE_SUBJECT.test(raw) && STATE_CHANGING_COMMAND.test(raw)) return null;
  const intent = intentOf(raw);
  if (!intent) return null;

  const ids = explicitTaskIds(raw);
  const recency = RECENT_SELECTOR.test(raw);
  // The request names ids: the task log decides whether they mean anything.
  if (ids.length > 0) return { ids, intent, recency };
  // A goal is not a reference to a record.
  if (GOAL_OF_TASK.test(raw) || GOAL_REQUESTED.test(raw)) return null;
  if (TASK_WORD.test(raw) || recency) return { ids: [], intent, recency };
  // Nothing names a task. A bare follow-up ("did it finish?", "what is still pending?",
  // "does it need my approval?") still asks about a recorded outcome, so it counts when it
  // is short, holds no proper noun, and points at nothing else the pronoun could stand for.
  // The whole-record 'status' view needs a direct anchor: a pronoun, or nothing but the
  // question itself ("any progress?"). An indefinite ("explain something long") is the
  // subject of that kind of request, so it is not a follow-up about a record.
  const words = raw.split(/\s+/).length;
  if (words > MAX_FOLLOWUP_WORDS) return null;
  if (VAGUE_REFERENT.test(raw) && intent === 'status') return null;
  // The whole-record view always needs something to point at. A request that names no
  // pronoun, no task word, and no id - "what happened?" - is asking for a recap of the
  // conversation, which is the model's job and not an answer from the task log.
  if (intent === 'status' && !PRONOUN.test(raw)) return null;
  if (PROPER_NOUN.test(raw.slice(1))) return null;
  if (OTHER_NOUN_PHRASE.test(raw)) return null;
  return { ids: [], intent, recency };
}

// The task ids this conversation holds, most recently mentioned first, taken from the turns
// that carry a task id (a task result, or an answer about a task). A turn naming no id is
// not evidence that a task was discussed.
export function discussedTaskIds(turns) {
  const ids = [];
  for (const turn of turns ?? []) {
    if (typeof turn?.taskId === 'string' && turn.taskId.length > 0 && !ids.includes(turn.taskId)) ids.unshift(turn.taskId);
  }
  return ids;
}

// Which task the candidate refers to, once the session's recorded task ids are known.
// An id the user named is used as given - the controller resolves it against the task log,
// which is also what rejects an id that names nothing and what refuses to pick between two.
// Anything else needs exactly one discussed task, or an explicit request for the most recent
// one. Two discussed tasks with no such request is a real ambiguity, so it is asked about.
export function selectTaskReferent({ ids = [], recency = false, discussed = [] } = {}) {
  if (ids.length >= 2) return { kind: 'ambiguous-id', ids };
  if (ids.length === 1) return { kind: 'named-id', id: ids[0] };
  if (recency && discussed.length > 0) return { kind: 'recent', id: discussed[0] };
  if (discussed.length === 1) return { kind: 'discussed', id: discussed[0] };
  if (discussed.length > 1) return { kind: 'ambiguous', ids: discussed };
  return { kind: 'none', ids: [] };
}
