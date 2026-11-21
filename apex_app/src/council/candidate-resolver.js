// T-38 Step 1 (2026-11-21): deterministic intent-to-capability resolution.
//
// The Values & Constraints Core evaluates a *candidate*: a concrete capability with a registry
// declaration, whose permission, origins, plannability, reversibility and blast radius the rules can
// read. A Council deliberation usually begins with a sentence, not a capability id - "verify release
// readiness for the neural bridge" - and before this module the core had nothing to evaluate, so every
// rule answered `unverifiable` for the uninteresting reason that no candidate existed.
//
// This module answers the narrow question the core needs: *which registered capabilities would this
// sentence actually invoke?* It answers it deterministically, from two sources that already exist:
//
//   1. The controller's own router (`src/controller/router.js`). That is the component that will run
//      the sentence, so its reading is the authoritative one. If it resolves to a capability, that
//      capability is the candidate - not a guess about what the sentence is "about".
//
//   2. An exact lexical match over registered capability names and their declared domains, so a
//      sentence that names a capability ("run the neural step", "verify the workshop") resolves even
//      when the router leaves it on the model path. Only whole words count, and only names that are
//      registered.
//
// The honesty rule is the point of the whole module: when neither source produces a capability, the
// answer is `no_mapped_capability` and the core reports `unverifiable` for that exact stated reason.
// A resolver that guessed here would convert "I do not know what this would do" into a satisfied
// rule, which is the failure this milestone exists to remove - not to relocate.
import { route } from '../controller/router.js';
import { truncate } from '../util.js';

export const RESOLVER_SCHEMA = 'apex.council.candidate-resolution/1';
export const RESOLUTION_KINDS = Object.freeze(['router_action', 'registry_name', 'capability_id', 'none']);

// Words that carry no capability meaning, so a sentence containing "the" cannot match a capability
// whose description happens to contain it. Kept short on purpose: the matcher is exact, not fuzzy.
const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'than', 'that', 'this', 'these', 'those',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am', 'do', 'does', 'did', 'doing', 'done',
  'to', 'of', 'in', 'on', 'at', 'by', 'for', 'with', 'from', 'into', 'onto', 'over', 'under',
  'i', 'we', 'you', 'it', 'they', 'me', 'us', 'my', 'our', 'your', 'its', 'their',
  'should', 'would', 'could', 'can', 'will', 'shall', 'may', 'might', 'must',
  'please', 'now', 'just', 'also', 'about', 'as', 'so', 'up', 'out', 'all', 'any', 'some',
  'how', 'what', 'when', 'where', 'which', 'who', 'why', 'before', 'after', 'again',
]);

// The verb a sentence uses, mapped to the permission class it implies. A sentence that says "verify"
// is proposing a check; one that says "delete" is proposing a destructive write. Used only to prefer
// one reading over another when a sentence names two capabilities - never to invent one.
const VERB_INTENT = Object.freeze({
  read: ['show', 'list', 'read', 'get', 'view', 'display', 'search', 'find', 'look', 'inspect', 'check',
    'status', 'report', 'verify', 'review', 'audit'],
  write: ['run', 'do', 'start', 'create', 'add', 'write', 'record', 'store', 'remember', 'save', 'apply',
    'promote', 'stage', 'claim', 'revoke', 'release', 'lock', 'lockdown', 'delete', 'remove',
    'move', 'rename', 'update', 'revise', 'approve', 'reject', 'cancel', 'retire', 'merge', 'correct'],
});

function words(text) {
  return String(text)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0 && !STOPWORDS.has(word));
}

// The capability name broken into its own words: `presence.handoff.stage` -> ['presence','handoff','stage'].
function nameWords(name) {
  return String(name).toLowerCase().split(/[._]+/).filter((word) => word.length > 0 && !STOPWORDS.has(word));
}

// Exact, whole-word containment in order: every word of the capability name appears in the sentence.
// Not a fuzzy score - a capability either is named or is not.
function namesCapability(textWords, name) {
  const parts = nameWords(name);
  if (parts.length === 0) return false;
  const present = new Set(textWords);
  return parts.every((part) => present.has(part));
}

function impliedPermission(textWords) {
  const set = new Set(textWords);
  if (VERB_INTENT.write.some((verb) => set.has(verb))) return 'write';
  if (VERB_INTENT.read.some((verb) => set.has(verb))) return 'read';
  return null;
}

// Deterministic: the same text against the same registry always produces the same list in the same
// order. Ties are broken by name, never by iteration order of a Map.
function resolveByRegistryName(text, { registry }) {
  const textWords = words(text);
  if (textWords.length === 0) return [];
  const want = impliedPermission(textWords);
  const matches = [];
  for (const definition of registry.list()) {
    if (!namesCapability(textWords, definition.name)) continue;
    // How much of the name the sentence actually reproduced, so `workshop.verify` beats a bare
    // `workshop` when the sentence says "verify the workshop".
    const parts = nameWords(definition.name);
    matches.push({
      definition,
      specificity: parts.length,
      verbAligns: want === null ? false : definition.permission === want,
    });
  }
  matches.sort((a, b) => {
    if (a.verbAligns !== b.verbAligns) return a.verbAligns ? -1 : 1;
    if (a.specificity !== b.specificity) return b.specificity - a.specificity;
    return a.definition.name.localeCompare(b.definition.name);
  });
  return matches.slice(0, 4).map((match) => match.definition);
}

// The public entry point. `lookup` is the registry's own getter; passing it in keeps this module pure
// and testable without constructing an app.
export function resolveCandidateCapabilities(text, { registry } = {}) {
  const objective = typeof text === 'string' ? text.trim() : '';
  const base = {
    schema: RESOLVER_SCHEMA,
    objective: truncate(objective, 2000),
    deterministic: true,
    usedInference: false,
  };
  if (objective.length === 0) {
    return {
      ...base, kind: 'none', reason: 'empty_objective', capabilities: [], candidate: null,
    };
  }

  // A sentence that *is* a capability id resolves without asking the router. This is the case the
  // Council was already handling; it stays first so nothing that worked before changes behaviour.
  if (registry && typeof registry.get === 'function') {
    const direct = registry.get(objective);
    if (direct) {
      return {
        ...base,
        kind: 'capability_id',
        reason: 'the objective is the exact name of a registered capability',
        capabilities: [describe(direct)],
        candidate: candidateFrom(direct),
      };
    }
  }

  const routed = route(objective);
  const routedAction = routed && routed.kind === 'action' && typeof routed.action === 'string' ? routed.action : null;
  if (routedAction && registry && typeof registry.get === 'function') {
    const definition = registry.get(routedAction);
    if (definition) {
      return {
        ...base,
        kind: 'router_action',
        reason: `the controller's own router resolves this sentence to ${routedAction}`,
        routerKind: routed.kind,
        capabilities: [describe(definition)],
        // The router's reading is the authoritative one: it is the component that would run it.
        candidate: candidateFrom(definition, { action: routed.input ? routedAction : routedAction }),
      };
    }
  }

  const named = registry && typeof registry.list === 'function' ? resolveByRegistryName(objective, { registry }) : [];
  if (named.length > 0) {
    return {
      ...base,
      kind: 'registry_name',
      reason: named.length === 1
        ? `the objective names one registered capability: ${named[0].name}`
        : `the objective names ${named.length} registered capabilities`,
      capabilities: named.map(describe),
      // The most specific match is the candidate the core evaluates. The rest travel as context so a
      // reader can see that the sentence was about more than one thing.
      candidate: candidateFrom(named[0]),
    };
  }

  // Nothing matched. This is not a failure to fix: it is the honest answer, and the constraints core
  // reports `unverifiable` with this reason rather than assuming the benign case.
  return {
    ...base,
    kind: 'none',
    reason: 'no_mapped_capability',
    detail: 'the objective names no registered capability and the router does not resolve it to one, '
      + 'so what it would do cannot be read from the registry',
    routerKind: routed?.kind ?? null,
    capabilities: [],
    candidate: null,
  };
}

// The shape the seven Council perspectives and the constraints core already read. `action` and `id`
// are what they look for; the safety fields are added so a reader of a session record can see what the
// verdict was based on without a second lookup.
function candidateFrom(definition, extra = {}) {
  return {
    id: definition.name,
    action: extra.action ?? definition.name,
    capability: definition.name,
    permission: definition.permission,
    origins: Array.isArray(definition.origins) ? [...definition.origins] : [],
    plannable: definition.plannable !== false,
    reversibility: definition.reversibility ?? null,
    blastRadius: definition.blastRadius ?? null,
    metadataSource: definition.metadataSource ?? 'undeclared',
  };
}

function describe(definition) {
  return {
    name: definition.name,
    permission: definition.permission,
    reversibility: definition.reversibility ?? null,
    blastRadius: definition.blastRadius ?? null,
    plannable: definition.plannable !== false,
    metadataSource: definition.metadataSource ?? 'undeclared',
  };
}
