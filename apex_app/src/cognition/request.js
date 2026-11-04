// Deterministic request understanding.
//
// This stage reads the user's own words and the reduced state it is given. It classifies what the
// request is about, resolves references it can see in stored records, and states what it cannot
// resolve. It never calls a model, never invents a referent, and never grants permission: an intent
// that sounds like an instruction is still only a description of the request.
import { clarificationFor, unsupportedOperationFor } from '../controller/decision.js';
import { isOpenStatus, goalProgress } from '../goals/model.js';
import { isOpenPlan } from '../plans/model.js';
import { Intent, INTENT_NOTE, MissingInfo } from './vocabulary.js';

const ID_TOKEN = /^[A-Za-z0-9-]{4,64}$/;
const MAX_ENTITIES = 6;
const MAX_REFS = 4;
const MAX_INSTRUCTIONS = 4;

const RULES = [
  {
    intent: Intent.NEXT_STEP,
    test: (t) => /\b(?:what(?:'s| is)?\s+next|next\s+step|what\s+should\s+i\s+do\s+(?:now|next)|what\s+now|what\s+remains|where\s+do\s+i\s+start)\b/i.test(t),
  },
  {
    intent: Intent.TASK_EXECUTION,
    test: (t) => /\b(?:run|execute|resume|retry|approve|continue)\b[^.!?]{0,60}\b(?:task|step)\b/i.test(t)
      || /\b(?:task|step)\b[^.!?]{0,40}\b(?:run|execute|resume|retry|approve)\b/i.test(t),
  },
  {
    intent: Intent.GOAL_CREATION,
    test: (t) => /\b(?:create|add|set|start|make|record|track)\s+(?:a\s+|an\s+|the\s+|my\s+)?goal\b/i.test(t)
      || /\bmy\s+goal\s+is\b/i.test(t)
      || /\bi\s+want\s+to\s+achieve\b/i.test(t),
  },
  {
    intent: Intent.GOAL_PROGRESS,
    test: (t) => /\b(?:goal\s+(?:progress|status)|progress\s+(?:on|towards?|of)|status\s+of\s+(?:the\s+|my\s+)?goal|where\s+am\s+i\s+(?:on|with))\b/i.test(t)
      || (/\bgoal\b/i.test(t) && /\b(?:progress|status|blocked|blocker|done|complete|completion|remaining)\b/i.test(t)),
  },
  {
    intent: Intent.PLAN_REVIEW,
    test: (t) => /\b(?:review|validate|check|is|why)\b[^.!?]{0,60}\bplan\b/i.test(t)
      || /\bplan\s+(?:valid|validity|safe|unsafe|approve|approval|blocked)\b/i.test(t),
  },
  {
    intent: Intent.PLANNING,
    test: (t) => /\b(?:make|create|draft|write|build|propose|need|give\s+me)\s+(?:a\s+|an\s+|the\s+)?plan\b/i.test(t)
      || /\bplan\s+(?:for|to)\b/i.test(t)
      || /\b(?:how\s+(?:should|do|can)\s+i|steps?\s+to)\b/i.test(t),
  },
  {
    intent: Intent.COMPARISON,
    test: (t) => /\bcompare\b|\bversus\b|\bvs\.?(?:\s|$)|\bdifference\s+between\b|\bdiffer\b/i.test(t),
  },
  {
    intent: Intent.FEEDBACK,
    test: (t) => /^(?:no[,;:]\s*)?(?:that(?:'s| is)|this is)\s+(?:wrong|incorrect|not right|not what i)/i.test(t)
      || /^(?:actually|correction)\b[,\s:]/i.test(t)
      || /^(?:i\s+(?:said|meant)|not quite|you(?:'re| are)\s+wrong)\b/i.test(t),
  },
  {
    intent: Intent.HISTORICAL,
    test: (t) => /\b(?:history|historical|previously|formerly|used\s+to|back\s+then|last\s+(?:year|month|week)|in\s+\d{4}|as\s+of|earlier|before|changed?|was)\b/i.test(t),
  },
  {
    intent: Intent.EXPLANATION,
    test: (t) => /^(?:why|how)\b/i.test(t) || /\bexplain\b|\bwhat\s+caused\b|\bwhat\s+does\b[^?]*\bmean\b/i.test(t),
  },
  {
    intent: Intent.STORED_INFORMATION,
    test: (t) => /\b(?:what\s+do\s+you\s+(?:remember|know)|do\s+you\s+(?:remember|know)|recall|memory|memories|what\s+did\s+i\s+(?:say|tell|record)|i\s+(?:told|said|recorded)|notes?)\b/i.test(t),
  },
];

function norm(text) {
  return String(text ?? '').normalize('NFKC').toLowerCase();
}

function tokens(text) {
  return norm(text).match(/[\p{L}\p{N}-]+/gu) ?? [];
}

function questionLike(text) {
  return /\?\s*$/.test(text) || /^(?:what|who|when|where|why|how|which|is|are|was|were|can|could|should|do|does|did|will|would|tell|show|list|find|explain|compare)\b/i.test(text);
}

function surfaceForms(entity) {
  return [entity.name, ...(entity.aliases ?? [])]
    .filter((value) => typeof value === 'string' && value.trim().length >= 3)
    .map((value) => ({ surface: norm(value).trim(), raw: value }));
}

// A stored name is matched as a whole token sequence, never as a substring of a longer word, and a
// surface that names two active entities is reported as ambiguous instead of being resolved by order.
function matchEntities(request, state) {
  if (!state || !(state.entities instanceof Map)) return { entities: [], ambiguities: [] };
  const text = ` ${norm(request).replace(/[^\p{L}\p{N}-]+/gu, ' ').replace(/\s+/g, ' ').trim()} `;
  const bySurface = new Map();
  const matched = new Map();
  for (const entity of state.entities.values()) {
    if (!entity || entity.status !== 'active') continue;
    for (const form of surfaceForms(entity)) {
      if (!text.includes(` ${form.surface} `)) continue;
      const list = bySurface.get(form.surface) ?? [];
      if (!list.some((entry) => entry.entity.id === entity.id)) list.push({ entity, raw: form.raw });
      bySurface.set(form.surface, list);
      matched.set(entity.id, { entity, matchedBy: form.surface === norm(entity.name).trim() ? 'name' : 'alias', raw: form.raw });
    }
    // An exact id or a unique id prefix in the request is an explicit identity reference.
    const idPattern = norm(entity.id);
    if (idPattern.length >= 4 && text.includes(` ${idPattern} `)) {
      matched.set(entity.id, { entity, matchedBy: 'id', raw: entity.id });
    }
  }
  const entities = [...matched.values()]
    .sort((a, b) => a.entity.id.localeCompare(b.entity.id))
    .slice(0, MAX_ENTITIES)
    .map(({ entity, matchedBy, raw }) => ({
      ref: raw,
      id: entity.id,
      name: entity.name,
      category: entity.category,
      matchedBy,
      ambiguous: false,
      candidates: [],
    }));
  const ambiguities = [];
  for (const [surface, list] of bySurface) {
    const ids = [...new Set(list.map((entry) => entry.entity.id))];
    if (ids.length < 2) continue;
    ambiguities.push({
      code: MissingInfo.AMBIGUOUS_REFERENCE,
      detail: `"${surface}" matches ${ids.length} active entities`,
      kind: 'entity',
      candidates: list.map((entry) => ({ id: entry.entity.id, name: entry.entity.name, category: entry.entity.category })),
    });
  }
  for (const item of entities) {
    const ambiguity = ambiguities.find((entry) => entry.candidates.some((candidate) => candidate.id === item.id));
    if (ambiguity) {
      item.ambiguous = true;
      item.candidates = ambiguity.candidates;
    }
  }
  return { entities, ambiguities };
}

function matchExecRefs(request, records, prefixLength = 4) {
  const text = ` ${norm(request).replace(/[^\p{L}\p{N}-]+/gu, ' ').replace(/\s+/g, ' ').trim()} `;
  const matches = [];
  for (const record of records ?? []) {
    if (!record || typeof record.id !== 'string') continue;
    const id = norm(record.id);
    if (id.length >= prefixLength && text.includes(` ${id} `)) {
      matches.push({ ref: record.id, id: record.id, matchedBy: 'id', ambiguous: false, candidates: [] });
    }
  }
  // A unique prefix is accepted only when it names exactly one record.
  for (const token of tokens(request)) {
    if (!ID_TOKEN.test(token) || token.length < prefixLength) continue;
    const hits = (records ?? []).filter((record) => typeof record?.id === 'string' && norm(record.id).startsWith(token));
    if (hits.length === 1) matches.push({ ref: token, id: hits[0].id, matchedBy: 'id-prefix', ambiguous: false, candidates: [] });
    if (hits.length > 1) {
      matches.push({
        ref: token,
        id: null,
        matchedBy: 'id-prefix',
        ambiguous: true,
        candidates: hits.map((record) => ({ id: record.id, name: record.request ?? record.outcome ?? record.goal ?? record.id })),
      });
    }
  }
  const seen = new Set();
  return matches.filter((entry) => {
    const key = `${entry.id ?? entry.ref}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, MAX_REFS);
}

function parseDateValue(text, now) {
  const value = text.trim().replace(/^the\s+/i, '');
  if (/^today$/i.test(value)) return now.toISOString();
  if (/^yesterday$/i.test(value)) return new Date(now.getTime() - 86400000).toISOString();
  const relative = /^last\s+(\d{1,3})\s+(day|week|month|year)s?$/i.exec(value);
  if (relative) {
    const n = Number(relative[1]);
    const unit = relative[2].toLowerCase();
    const ms = { day: 86400000, week: 7 * 86400000, month: 30 * 86400000, year: 365 * 86400000 }[unit];
    return new Date(now.getTime() - n * ms).toISOString();
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function extractTimeRange(request, now) {
  const text = String(request).trim();
  let match = /\bas\s+of\s+(.+?)(?:[?.!,;]|$)/i.exec(text);
  if (match) {
    const at = parseDateValue(match[1], now);
    if (at) return { kind: 'as-of', at, label: `as of ${match[1].trim()}`, parsed: true };
    return { kind: 'as-of', at: null, label: `as of ${match[1].trim()}`, parsed: false };
  }
  match = /\bbetween\s+(.+?)\s+and\s+(.+?)(?:[?.!,;]|$)/i.exec(text);
  if (match) {
    const from = parseDateValue(match[1], now);
    const to = parseDateValue(match[2], now);
    return { kind: 'between', from, to, label: `between ${match[1].trim()} and ${match[2].trim()}`, parsed: Boolean(from && to) };
  }
  match = /\b(?:since|after)\s+(.+?)(?:[?.!,;]|$)/i.exec(text);
  if (match) {
    const from = parseDateValue(match[1], now);
    return { kind: 'since', from, to: null, label: `since ${match[1].trim()}`, parsed: Boolean(from) };
  }
  match = /\b(?:before|until)\s+(.+?)(?:[?.!,;]|$)/i.exec(text);
  if (match) {
    const to = parseDateValue(match[1], now);
    return { kind: 'until', from: null, to, label: `until ${match[1].trim()}`, parsed: Boolean(to) };
  }
  return null;
}

function extractInstructions(request) {
  const clauses = String(request)
    .split(/(?:[.!?;\n]+|\s+but\s+)/)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0 && clause.length <= 220);
  return clauses
    .filter((clause) => /\b(?:do not|don't|never|only|must|should|without|cite|explain|keep|limit|use)\b/i.test(clause))
    .slice(0, MAX_INSTRUCTIONS)
    .map((clause) => ({ kind: 'constraint', text: clause.slice(0, 200) }));
}

function classify(text) {
  return RULES.filter((rule) => rule.test(text)).map((rule) => rule.intent);
}

function requiredFor(intent) {
  switch (intent) {
    case Intent.STORED_INFORMATION: return ['topic'];
    case Intent.WORLD_MODEL: return ['entity_or_topic'];
    case Intent.HISTORICAL: return ['time_range'];
    case Intent.COMPARISON: return ['two_referents'];
    case Intent.GOAL_PROGRESS: return ['goal_reference', 'criterion_state'];
    case Intent.PLANNING: return ['outcome', 'success_criteria'];
    case Intent.PLAN_REVIEW: return ['plan_reference', 'live_state'];
    case Intent.NEXT_STEP: return ['open_work'];
    case Intent.TASK_EXECUTION: return ['task_reference', 'authorization'];
    case Intent.GOAL_CREATION: return ['success_criteria'];
    case Intent.FEEDBACK: return ['corrected_claim'];
    default: return ['question'];
  }
}

export function understandRequest({
  request,
  now = new Date(),
  worldState = null,
  goals = [],
  plans = [],
  tasks = [],
  hasContext = false,
  requestId = null,
} = {}) {
  const text = String(request ?? '').trim();
  const lower = norm(text);
  const unsupported = unsupportedOperationFor(text);
  const clarification = clarificationFor(text, { hasContext, checkContinuation: true });
  const matched = classify(lower);
  const { entities, ambiguities: entityAmbiguities } = matchEntities(text, worldState);

  let intent = matched[0] ?? Intent.GENERAL_QUESTION;
  if (unsupported) intent = Intent.UNSUPPORTED;
  else if (clarification) intent = Intent.CLARIFICATION;
  else if (entities.length > 0 && questionLike(text) && !matched.includes(Intent.FEEDBACK)) {
    // A stored entity named in a question is a World Model question unless a more specific executive
    // or comparison intent already governs it.
    if (![Intent.COMPARISON, Intent.GOAL_PROGRESS, Intent.PLAN_REVIEW, Intent.PLANNING, Intent.NEXT_STEP, Intent.HISTORICAL, Intent.STORED_INFORMATION, Intent.EXPLANATION].includes(intent)) {
      intent = Intent.WORLD_MODEL;
    }
  }

  const openGoals = (goals ?? []).filter((goal) => isOpenStatus(goal?.status));
  const openPlans = (plans ?? []).filter((plan) => isOpenPlan(plan?.status));
  const openTasks = (tasks ?? []).filter((task) => ['running', 'paused', 'awaiting_approval', 'planned'].includes(task?.status));

  const goalRefs = matchExecRefs(text, goals);
  const planRefs = matchExecRefs(text, plans);
  const taskRefs = matchExecRefs(text, tasks);

  const missing = [];
  const ambiguities = [...entityAmbiguities];

  if (intent === Intent.GOAL_PROGRESS && goalRefs.length === 0 && openGoals.length === 1) {
    goalRefs.push({ ref: openGoals[0].id, id: openGoals[0].id, matchedBy: 'only-open', ambiguous: false, candidates: [] });
  }
  if (intent === Intent.GOAL_PROGRESS && goalRefs.length === 0 && openGoals.length > 1) {
    ambiguities.push({
      code: MissingInfo.AMBIGUOUS_REFERENCE,
      detail: `${openGoals.length} open goals are recorded; the request names none`,
      kind: 'goal',
      candidates: openGoals.slice(0, 6).map((goal) => ({ id: goal.id, name: goal.request })),
    });
  }
  if (intent === Intent.PLAN_REVIEW && planRefs.length === 0 && openPlans.length === 1) {
    planRefs.push({ ref: openPlans[0].id, id: openPlans[0].id, matchedBy: 'only-open', ambiguous: false, candidates: [] });
  }
  if (intent === Intent.PLAN_REVIEW && planRefs.length === 0 && openPlans.length > 1) {
    ambiguities.push({
      code: MissingInfo.AMBIGUOUS_REFERENCE,
      detail: `${openPlans.length} open plans are recorded; the request names none`,
      kind: 'plan',
      candidates: openPlans.slice(0, 6).map((plan) => ({ id: plan.id, name: plan.outcome })),
    });
  }
  if (intent === Intent.TASK_EXECUTION && taskRefs.length === 0 && openTasks.length === 1) {
    taskRefs.push({ ref: openTasks[0].id, id: openTasks[0].id, matchedBy: 'only-open', ambiguous: false, candidates: [] });
  }
  for (const item of [...goalRefs, ...planRefs, ...taskRefs]) {
    if (item.ambiguous) {
      ambiguities.push({
        code: MissingInfo.AMBIGUOUS_REFERENCE,
        detail: `"${item.ref}" matches ${item.candidates.length} records`,
        kind: 'executive',
        candidates: item.candidates,
      });
    }
  }

  const timeRange = extractTimeRange(text, now);
  if (intent === Intent.HISTORICAL && !timeRange) {
    missing.push({ code: MissingInfo.TIME_RANGE, detail: 'the question asks about an earlier state but names no time' });
  }
  if (intent === Intent.STORED_INFORMATION && /\b(?:remember|recall|memory|memories)\b/i.test(text)
    && !/\b(?:about|regarding|on|for|remember|recall)\s+\S+/i.test(text.replace(/^(?:what do you remember|recall|search memory)\s*/i, ''))) {
    missing.push({ code: MissingInfo.TOPIC, detail: 'the request asks for a memory search without a topic' });
  }
  if (intent === Intent.GOAL_CREATION && !/\b(?:so that|by|finish|complete|done when|criterion|criteria|measure|achieve|reduce|increase)\b/i.test(text)) {
    missing.push({ code: MissingInfo.GOAL_CRITERIA, detail: 'no success criterion was named' });
  }
  if (intent === Intent.PLANNING && /\brun\b|\bexecute\b/i.test(text)) {
    missing.push({ code: MissingInfo.ACTION_PARAMETER, detail: 'a plan was requested together with execution; execution needs its own authorization' });
  }
  if (intent === Intent.UNSUPPORTED) missing.push({ code: MissingInfo.INTENT, detail: unsupported });
  if (intent === Intent.CLARIFICATION) missing.push({ code: MissingInfo.INTENT, detail: clarification });

  for (const item of ambiguities) {
    if (!missing.some((entry) => entry.code === item.code)) missing.push({ code: item.code, detail: item.detail });
  }

  const instructions = extractInstructions(text);
  const executionRequested = intent === Intent.TASK_EXECUTION
    || (intent === Intent.NEXT_STEP && /\b(?:run|execute|start|do)\s+(?:it|that|them|this)\b/i.test(text));

  const clarificationQuestion = clarification
    ?? (ambiguities.length > 0
      ? ambiguityQuestion(ambiguities[0])
      : null);

  return {
    requestId: typeof requestId === 'string' ? requestId : null,
    intent,
    intents: [...new Set([intent, ...matched])],
    entities,
    goals: goalRefs,
    plans: planRefs,
    tasks: taskRefs,
    timeRange,
    historical: intent === Intent.HISTORICAL || Boolean(timeRange && (timeRange.kind === 'as-of' || timeRange.kind === 'between')),
    instructions,
    required: requiredFor(intent),
    missing,
    ambiguities,
    unsupported,
    clarification: clarificationQuestion,
    clarificationDetail: missing.length > 0 ? missing[0] : null,
    executionRequested,
    authorization: { granted: false, note: INTENT_NOTE },
    open: {
      goals: openGoals.length,
      plans: openPlans.length,
      tasks: openTasks.length,
      goalProgress: openGoals.slice(0, 3).map((goal) => ({ id: goal.id, status: goal.status, progress: goalProgress(goal) })),
    },
  };
}

function ambiguityQuestion(ambiguity) {
  if (ambiguity.kind === 'entity') {
    const names = ambiguity.candidates.slice(0, 4).map((candidate) => `${candidate.name} [${candidate.id.slice(0, 8)}]`).join(', ');
    return `Which entity do you mean? "${ambiguity.candidates[0]?.name ?? 'the name'}" matches ${ambiguity.candidates.length} active entities: ${names}.`;
  }
  if (ambiguity.kind === 'goal') {
    const names = ambiguity.candidates.slice(0, 4).map((candidate) => `[${candidate.id.slice(0, 8)}] ${candidate.name}`).join(', ');
    return `Which goal do you mean? ${names}.`;
  }
  if (ambiguity.kind === 'plan') {
    const names = ambiguity.candidates.slice(0, 4).map((candidate) => `[${candidate.id.slice(0, 8)}] ${candidate.name}`).join(', ');
    return `Which plan do you mean? ${names}.`;
  }
  return 'Which record do you mean? Please give its id or more of its name.';
}
