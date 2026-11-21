// T-38 Step 1 (2026-11-21): capability safety metadata.
//
// The Values & Constraints Core's `irreversible-needs-the-owner` rule reads a capability's declared
// reversibility. Until this milestone nothing in the registry declared it, so the rule answered
// `unverifiable` for every candidate - which is the correct verdict for a missing fact, and useless
// as a check. This module supplies the fact.
//
// Two things live here, and the separation matters:
//
//   1. The vocabulary, as frozen constants. `reversibility` and `blastRadius` are a closed set, so a
//      declaration cannot invent a fourth kind of "mostly reversible"; `validateDefinition` refuses
//      anything outside these lists, which is what makes the metadata inspectable rather than
//      decorative.
//
//   2. One declarative overlay, keyed by capability name. It is written as data rather than spread
//      across thirty action files because a reader must be able to see the whole safety surface of
//      APEX at once, and because a single table is the only form in which "does every write declare
//      its reversibility?" is a question a test can ask.
//
// The overlay is applied by the registry itself at registration time (see applySafetyMetadata), so
// `registry.get(name)` returns a definition whose `reversibility` and `blastRadius` came from here.
// A module that sets them on its own definition wins: this is a defaulting layer, not an override.

export const REVERSIBILITY_KINDS = Object.freeze(['read_only', 'reversible', 'compensatable', 'irreversible']);
export const BLAST_RADIUS_KINDS = Object.freeze(['none', 'session', 'local_store', 'workspace_sandbox', 'system_latch']);

// What each kind means, stated once so a rule or a UI can show the owner the claim rather than the
// word. These are the definitions the Values Core cites.
export const REVERSIBILITY_MEANING = Object.freeze({
  // Reads nothing that can be undone because nothing changed.
  read_only: 'reads state and writes no record; there is nothing to undo',
  // Undoing is a supported operation: the record can be corrected, the file restored, the step retried
  // from the same input.
  reversible: 'the effect can be undone by an operation this system already has',
  // The effect cannot be undone, but it can be offset by a further recorded action.
  compensatable: 'the effect cannot be undone, but a further action can compensate for it',
  // No operation restores the previous state. A wrong one is permanent.
  irreversible: 'no operation restores the previous state',
});

export const BLAST_RADIUS_MEANING = Object.freeze({
  none: 'no persisted state changes',
  session: 'the change is bounded to this conversation or run',
  local_store: 'the change is bounded to one append-only store under the APEX data directory',
  workspace_sandbox: 'the change is bounded to the staged sandbox, never the live workspace tree',
  system_latch: 'the change takes effect across the whole system until it is released',
});

// The declarations. Every capability that persists anything appears here with both fields.
//
// The readings are not guesses: they follow what each action's own `execute` does. A read that only
// appends to an audit log is `local_store` because the log is a durable record even though no domain
// state changed; a write whose effect the system can correct is `reversible`; a latch that stays
// engaged until a human releases it is `system_latch` and `reversible`, because release is a
// supported operation - it is the release's own preconditions, not its reversibility, that make it
// owner-only.
const DECLARATIONS = Object.freeze({
  // ---------------------------------------------------------------- reads over owned stores ---
  'app.status': ['read_only', 'none'],
  'app.capabilities': ['read_only', 'none'],
  'system.bootstrap_status': ['read_only', 'none'],
  'calc.evaluate': ['read_only', 'none'],

  // ------------------------------------------------------------------------- memory ---
  'memory.search': ['read_only', 'none'],
  'memory.list': ['read_only', 'none'],
  // A stored fact can be corrected, and the correction is itself a record, so the wrong state is not
  // destroyed - it is superseded. That is reversible in the sense this vocabulary means.
  'memory.add': ['reversible', 'local_store'],
  'memory.correct': ['reversible', 'local_store'],
  'memory.save_conclusion': ['reversible', 'local_store'],

  // ---------------------------------------------------------------------- knowledge ---
  'knowledge.search': ['read_only', 'none'],
  'knowledge.list': ['read_only', 'none'],
  'knowledge.add': ['reversible', 'local_store'],
  'knowledge.retract': ['reversible', 'local_store'],

  // -------------------------------------------------------------------------- notes ---
  'note.list': ['read_only', 'none'],
  'note.show': ['read_only', 'none'],
  'note.search': ['read_only', 'none'],
  'note.history': ['read_only', 'none'],
  'note.add': ['reversible', 'local_store'],
  'note.from_digest': ['reversible', 'local_store'],

  // ----------------------------------------------------------------- tasks and plans ---
  'task.feedback': ['reversible', 'local_store'],

  // ------------------------------------------------------------- the filesystem sandbox ---
  // The filesystem capabilities are the only ones whose blast radius is the workspace tree, and the
  // only ones where an effect can be genuinely unrecoverable: a delete goes to a quarantine this
  // system can restore from, but a replace overwrites bytes the previous content cannot be recovered
  // from, which is why it is compensatable rather than reversible.
  // (Their names are checked against the live registry by `every declaration names a registered
  // capability` in tests/t38-values-metadata.test.js: a name that is spelled wrong here would read
  // as coverage and provide none.)

  // ------------------------------------------------------------------------ workshop ---
  // A design sheet is a record like any other. A verification is an append to its own ledger. A
  // promotion writes a record and a timeline entry, and applies nothing.
  'workshop.compose': ['reversible', 'local_store'],
  'workshop.list': ['read_only', 'none'],
  'workshop.get': ['read_only', 'none'],
  'workshop.inspect': ['read_only', 'none'],
  'workshop.simulate': ['read_only', 'none'],
  'workshop.verify': ['reversible', 'local_store'],
  'workshop.promote': ['reversible', 'local_store'],

  // -------------------------------------------------------------------- cognition ---
  'cognition.run': ['reversible', 'local_store'],

  // ---------------------------------------------------------------------- council ---
  // A deliberation appends one session record. It decides nothing, so its radius is the store, not
  // the system.
  'council.deliberate': ['reversible', 'local_store'],
  'council.compare': ['read_only', 'none'],
  'council.get': ['read_only', 'none'],
  'council.list': ['read_only', 'none'],
  'council.replay': ['read_only', 'none'],

  // ------------------------------------------------------------------ perception ---
  'perception.sense_host': ['reversible', 'local_store'],
  'perception.state': ['read_only', 'none'],

  // ------------------------------------------------------------------- briefing ---
  'briefing.acknowledge': ['reversible', 'local_store'],

  // ---------------------------------------------------------------------- neural ---
  // Stepping the substrate advances a stateful simulation and appends to a ledger. It is reversible
  // in this vocabulary's sense because the substrate is a pure function of seed and step count: the
  // same substrate can be rebuilt to any earlier step exactly.
  'neural.step': ['reversible', 'local_store'],
  'neural.contract': ['read_only', 'none'],
  'neural.read': ['read_only', 'none'],
  'neural.bridge_reset': ['reversible', 'local_store'],

  // -------------------------------------------------------------------- presence ---
  // A handoff stages a payload the owner must claim. Staging is not delivery, so the radius is the
  // store until a claim happens, and the claim is bounded to the session that made it.

  // ------------------------------------------- the remaining stores, audited in the same pass ---
  // Every entry below is a write that appends or supersedes a record in one store. None of them
  // destroys a record: `retract`, `supersede`, `retire` and `invalidate` all keep what was there and
  // add the reason beside it, which is why they read as reversible rather than irreversible.
  'knowledge.resolve': ['reversible', 'local_store'],
  'note.update': ['reversible', 'local_store'],
  'experience.record': ['reversible', 'local_store'],
  'feedback.record': ['reversible', 'local_store'],
  'adaptation.derive': ['reversible', 'local_store'],
  'adaptation.decide': ['reversible', 'local_store'],
  'adaptation.guide': ['reversible', 'local_store'],
  'adaptation.retire': ['reversible', 'local_store'],
  'adaptation.review.open': ['reversible', 'local_store'],
  'adaptation.review.decide': ['reversible', 'local_store'],
  'learning.observe': ['reversible', 'local_store'],
  'learning.propose': ['reversible', 'local_store'],
  'learning.measure': ['reversible', 'local_store'],
  'learning.rollback': ['reversible', 'local_store'],
  'situation.ingest': ['reversible', 'local_store'],
  'situation.evaluate': ['reversible', 'local_store'],
  'situation.decide': ['reversible', 'local_store'],
  'situation.response': ['reversible', 'local_store'],
  'prediction.record': ['reversible', 'local_store'],
  'prediction.evaluate': ['reversible', 'local_store'],
  'prediction.invalidate': ['reversible', 'local_store'],
  'goal.add': ['reversible', 'local_store'],
  'goal.revise': ['reversible', 'local_store'],
  'goal.confirm': ['reversible', 'local_store'],
  'goal.update': ['reversible', 'local_store'],
  'goal.evidence': ['reversible', 'local_store'],
  'goal.complete': ['reversible', 'local_store'],
  'goal.link': ['reversible', 'local_store'],
  'plan.add': ['reversible', 'local_store'],
  'plan.revise': ['reversible', 'local_store'],
  'plan.approve': ['reversible', 'local_store'],
  'plan.cancel': ['reversible', 'local_store'],
  'plan.pause': ['reversible', 'local_store'],
  'plan.resume': ['reversible', 'local_store'],
  'plan.supersede': ['reversible', 'local_store'],
  'plan.assess': ['reversible', 'local_store'],
  'proposal.accept': ['reversible', 'local_store'],
  'proposal.reject': ['reversible', 'local_store'],
  'proposal.invalidate': ['reversible', 'local_store'],
  // An export writes a new archive and changes nothing the system reads. Reading an archive back is
  // the one operation in this build that *replaces* data files, and it writes its own pre-restore
  // archive first - so the previous state is still recoverable from disk, but only by an operator,
  // which is what separates compensatable from reversible.
  'backup.export': ['reversible', 'local_store'],
  'backup.restore': ['compensatable', 'local_store'],
  'world.entity.add': ['reversible', 'local_store'],
  'world.entity.alias': ['reversible', 'local_store'],
  'world.entity.retire': ['reversible', 'local_store'],
  'world.entity.merge': ['reversible', 'local_store'],
  'world.entity.unmerge': ['reversible', 'local_store'],
  'world.fact.add': ['reversible', 'local_store'],
  'world.relationship.add': ['reversible', 'local_store'],
  'world.event.add': ['reversible', 'local_store'],
  'world.statement.retract': ['reversible', 'local_store'],
  'world.statement.supersede': ['reversible', 'local_store'],
  'world.identity.decide': ['reversible', 'local_store'],
  'evolution.propose': ['reversible', 'local_store'],
  'evolution.verify': ['reversible', 'local_store'],
  'evolution.promote': ['reversible', 'local_store'],
  'evolution.decide': ['reversible', 'local_store'],
  'perception.dismiss_alert': ['reversible', 'local_store'],
  'perception.revoke_suppression': ['reversible', 'local_store'],
  // The handoff family is registered with dots in its action name, so its declarations are spelled
  // the same way here. A declaration for a name nobody registered is dead weight that reads as
  // coverage, which is why a test checks every entry against the live registry below.
  'presence.handoff.stage': ['reversible', 'local_store'],
  'presence.handoff.claim': ['reversible', 'session'],
  'presence.handoff.revoke': ['reversible', 'local_store'],
  // Bootstrap runs the read-only doctor checks, takes a real host reading and enrols the workstation.
  // It writes one marker and one device record; both are recoverable by re-running it.
  'system.bootstrap': ['reversible', 'local_store'],

  // ------------------------------------------------- the file-backed workshop (T-38 Step 2) ---
  // The two reads see the workspace tree but change nothing. The three writes change only the sandbox
  // under the APEX data directory, which is why they are `workspace_sandbox` and not `local_store`:
  // the sandbox is a scratch space whose contents are proposed changes, not records.
  'workspace.inspect': ['read_only', 'none'],
  'workspace.read_file': ['read_only', 'none'],
  'workshop.stage_file': ['reversible', 'workspace_sandbox'],
  'workshop.verify_file': ['reversible', 'workspace_sandbox'],
  'workshop.promote_file': ['reversible', 'workspace_sandbox'],

  // ----------------------------------------------------------------------- safety ---
  // The latch is system-wide and stays engaged until released. It is *reversible* - release is a
  // supported, required operation - but its blast radius is the whole system, which is why the
  // constraints core treats a latched system differently from an idle one.
  'safety.lockdown': ['reversible', 'system_latch'],
  'safety.release': ['reversible', 'system_latch'],
});

// A read that appends nothing and changes nothing. Used to check a capability that is registered but
// not listed above: instead of inventing a declaration, the registry leaves the fields absent and the
// constraints core reports `unverifiable` - the honest answer for a fact nobody recorded.
export function safetyMetadataFor(name, definition = {}) {
  const entry = DECLARATIONS[name];
  if (entry) return { reversibility: entry[0], blastRadius: entry[1], metadataSource: 'declared' };
  // A read capability that nobody declared is still a read: `permission: 'read'` is a fact, so the
  // blast radius is known even when the reversibility of the read is not interesting.
  if (definition.permission === 'read') {
    return { reversibility: 'read_only', blastRadius: 'none', metadataSource: 'derived_from_permission' };
  }
  return { reversibility: null, blastRadius: null, metadataSource: 'undeclared' };
}

// Applied by ActionRegistry.register(). Returns the fields to add, never removing what a definition
// already states about itself.
export function applySafetyMetadata(def) {
  const derived = safetyMetadataFor(def.name, def);
  return {
    reversibility: def.reversibility ?? derived.reversibility,
    blastRadius: def.blastRadius ?? derived.blastRadius,
    metadataSource: def.reversibility !== undefined && def.blastRadius !== undefined
      ? 'declared'
      : derived.metadataSource,
  };
}

// The full table, for the inventory report and the tests that check every write is covered.
export function safetyDeclarations() {
  return Object.entries(DECLARATIONS).map(([name, [reversibility, blastRadius]]) => ({
    name, reversibility, blastRadius,
  }));
}

// The pairs that make no sense together: a read that changes a store, or a mutation that touches
// nothing. A declaration that pairs them is a typo, and a typo in this table is a rule that reads
// the wrong fact.
export function contradictoryDeclaration(reversibility, blastRadius) {
  if (reversibility === 'read_only' && blastRadius !== 'none') {
    return `read_only cannot have blast radius ${blastRadius}`;
  }
  if (reversibility !== 'read_only' && blastRadius === 'none') {
    return `${reversibility} cannot have blast radius none`;
  }
  return null;
}
