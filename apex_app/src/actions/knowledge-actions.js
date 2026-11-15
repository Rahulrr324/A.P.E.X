// Knowledge actions: registered by the composition root alongside builtin memory actions.
// Follows the same action definition pattern: validate, execute, verify.
// Write actions (knowledge.add) are user-origin only; the registry enforces this.
// Read actions (knowledge.search, knowledge.list) may be offered to the model.
import { ValidationError } from '../errors.js';
import { CONTROL_CHARS, shortId, singleLine } from '../util.js';
import { containsSecret } from '../security/secrets.js';
import { MAX_RETRACTION_REASON_CHARS, MAX_SUPERSEDES } from '../knowledge/knowledge-store.js';
import { buildKnowledgeDigest, renderDigest, DIGEST_DEFAULT_LIMIT, DIGEST_MAX_LIMIT } from '../knowledge/digest.js';
import { ORIGIN_MODEL, ORIGIN_USER } from './origins.js';

const MAX_FIELD_CHARS = 500;
const MAX_EVIDENCE_CHARS = 1000;
// Maximum knowledge records injected into a model prompt. This bounds context size.
export const KNOWLEDGE_PROMPT_LIMIT = 3;

function textField(value, name, max = MAX_FIELD_CHARS) {
  if (typeof value !== 'string') throw new ValidationError(`${name} must be text`);
  const t = value.trim();
  if (t.length === 0) throw new ValidationError(`${name} is empty`);
  if (t.length > max) throw new ValidationError(`${name} exceeds ${max} characters`);
  if (CONTROL_CHARS.test(t)) throw new ValidationError(`${name} contains control characters`);
  if (containsSecret(t)) {
    throw new ValidationError(
      `${name} looks like a password, key, or token; it was not stored`,
      'SECRET_REFUSED',
    );
  }
  return t;
}

function optionalTextField(value, name, max = MAX_FIELD_CHARS) {
  if (value === undefined || value === null) return null;
  return textField(value, name, max);
}

// A record reference is not a field of the claim, so it has its own limits and its
// own refusal. The value is never quoted back in the error: that text can be audited.
function recordRef(value, name) {
  if (typeof value !== 'string') throw new ValidationError(`${name} must be text`);
  const ref = value.trim();
  if (ref.length === 0) throw new ValidationError(`${name} is empty`);
  if (ref.length > 64) throw new ValidationError(`${name} is longer than 64 characters`);
  if (CONTROL_CHARS.test(ref)) throw new ValidationError(`${name} contains control characters`);
  if (containsSecret(ref)) {
    throw new ValidationError(`${name} looks like a password, key, or token; it was not used`, 'SECRET_REFUSED');
  }
  return ref;
}

function optionalReason(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new ValidationError('reason must be text');
  const text = value.trim();
  if (text.length === 0) return null;
  if (text.length > MAX_RETRACTION_REASON_CHARS) {
    throw new ValidationError(`reason exceeds ${MAX_RETRACTION_REASON_CHARS} characters`);
  }
  if (CONTROL_CHARS.test(text)) throw new ValidationError('reason contains control characters');
  if (containsSecret(text)) {
    throw new ValidationError('reason looks like a password, key, or token; it was not stored', 'SECRET_REFUSED');
  }
  return text;
}

function expectObject(input, allowedKeys) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('input must be an object');
  }
  for (const key of Object.keys(input)) {
    if (!allowedKeys.includes(key)) throw new ValidationError(`unexpected input field "${singleLine(key, 40)}"`);
  }
  return input;
}

function renderStatus(r) {
  if (r.lifecycleState === 'ambiguous') {
    return `ambiguous (${r.lifecycleNote ?? 'lifecycle evidence disagrees'}); not active`;
  }
  if (r.lifecycleState === 'retracted') return 'retracted';
  if (r.supersededBy && r.supersededBy.length > 0) return 'superseded';
  if (r.status === 'conflicting' || (r.conflictsWith && r.conflictsWith.length > 0)) {
    const base = `conflicting (conflicts with: ${(r.conflictsWith ?? []).map(shortId).join(', ')})`;
    // A recorded decision changes what is chosen, not whether the claims agree. Say both,
    // so a list reader does not mistake a decision for a resolution of the facts.
    return r.conflictState === 'resolved' && r.resolution
      ? `${base}; user decision chose ${shortId(r.resolution.chosenId)} (a recorded decision, not verified truth)`
      : base;
  }
  return r.status ?? 'supported';
}

function renderRecord(r) {
  const status = renderStatus(r);
  const prov = r.provenance?.origin ?? 'unknown';
  const evi = r.evidence ? `\n      evidence: ${r.evidence}` : '';
  return `  [${shortId(r.id)}] ${r.subject} --[${r.relationship}]--> ${r.object}${evi}\n      status: ${status} | provenance: ${prov} | recorded: ${String(r.createdAt).slice(0, 10)}`;
}

export function knowledgeActions(knowledge) {
  return [
    {
      name: 'knowledge.add',
      description: 'Store an explicit knowledge relationship (subject, relationship, object). Optionally supersede conflicting live records. Write: user origin only.',
      inputHint: '{"subject":"text","relationship":"text","object":"text","evidence":"optional text","supersedes":["optional record ids"]}',
      permission: 'write',
      origins: [ORIGIN_USER],
      // A model-proposed write would be approved without showing the triple, then run
      // as the user. That would relabel model-authored text as a user-confirmed fact.
      plannable: false,
      validate(input) {
        const o = expectObject(input, ['subject', 'relationship', 'object', 'evidence', 'supersedes']);
        let supersedes = [];
        if (o.supersedes !== undefined) {
          if (!Array.isArray(o.supersedes)) throw new ValidationError('supersedes must be a list of record ids');
          if (o.supersedes.length > MAX_SUPERSEDES) {
            throw new ValidationError(`supersedes may name at most ${MAX_SUPERSEDES} records`);
          }
          supersedes = o.supersedes.map((value) => {
            if (typeof value !== 'string') throw new ValidationError('each supersedes entry must be text');
            const ref = value.trim();
            if (ref.length === 0) throw new ValidationError('a supersedes entry is empty');
            if (ref.length > 64) throw new ValidationError('a supersedes entry is longer than 64 characters');
            if (CONTROL_CHARS.test(ref)) throw new ValidationError('a supersedes entry contains control characters');
            return ref;
          });
        }
        return {
          subject: textField(o.subject, 'subject'),
          relationship: textField(o.relationship, 'relationship'),
          object: textField(o.object, 'object'),
          evidence: optionalTextField(o.evidence, 'evidence', MAX_EVIDENCE_CHARS),
          supersedes,
        };
      },
      async execute(ctx, { subject, relationship, object, evidence, supersedes }) {
        const { record, conflictingIds, supersededIds } = await knowledge.add({
          subject,
          relationship,
          object,
          evidence,
          provenance: { operationId: ctx.operationId },
          origin: ctx.origin,
          supersedes,
        });
        const conflictNote = conflictingIds.length > 0
          ? ` (conflicts with ${conflictingIds.length} existing record(s): ${conflictingIds.map(shortId).join(', ')})`
          : '';
        const supersedeNote = supersededIds.length > 0
          ? ` (supersedes ${supersededIds.map(shortId).join(', ')})`
          : '';
        return {
          summary: `stored knowledge record ${shortId(record.id)}${conflictNote}${supersedeNote}`,
          data: {
            id: record.id,
            subject: record.subject,
            relationship: record.relationship,
            object: record.object,
            evidence: record.evidence,
            status: record.status,
            conflictingIds,
            supersededIds,
          },
          display: `Stored knowledge record ${shortId(record.id)}: ${record.subject} --[${record.relationship}]--> ${record.object}${conflictNote}${supersedeNote}`,
        };
      },
      async verify(ctx, { subject, relationship, object }, result) {
        const rec = await knowledge.get(result.data.id);
        if (!rec) return { ok: false, detail: 'record not found in store after write' };
        if (rec.subject !== subject) return { ok: false, detail: 'stored subject differs from request' };
        if (rec.relationship !== relationship) return { ok: false, detail: 'stored relationship differs from request' };
        if (rec.object !== object) return { ok: false, detail: 'stored object differs from request' };
        if (rec.provenance?.updateMode !== 'user_confirmed') {
          return { ok: false, detail: 'stored provenance is not user_confirmed' };
        }

        const supersededIds = result.data.supersededIds ?? [];
        const stored = [...(rec.supersededBy ?? [])].sort();
        const expected = [...supersededIds].sort();
        if (stored.length !== expected.length || stored.some((id, i) => id !== expected[i])) {
          return { ok: false, detail: 'stored supersession list differs from the write result' };
        }
        for (const targetId of supersededIds) {
          const [target] = await knowledge.findByPrefix(targetId);
          if (!target) return { ok: false, detail: `superseded record ${shortId(targetId)} is no longer in the store` };
          if (target.status !== 'superseded') {
            return { ok: false, detail: `record ${shortId(targetId)} is not reported superseded` };
          }
          if (!(target.supersededBy ?? []).includes(rec.id)) {
            return { ok: false, detail: `record ${shortId(targetId)} does not name the new record as its replacement` };
          }
        }
        const [fresh] = await knowledge.findByPrefix(rec.id);
        if (!fresh) return { ok: false, detail: 'record cannot be read back after write' };
        if (fresh.status !== result.data.status) {
          return { ok: false, detail: 'stored conflict status differs from the write result' };
        }
        const remaining = [...(fresh.conflictsWith ?? [])].sort();
        const claimed = [...(result.data.conflictingIds ?? [])].sort();
        if (remaining.length !== claimed.length || remaining.some((id, i) => id !== claimed[i])) {
          return { ok: false, detail: 'remaining conflicts differ from an independent read' };
        }
        return {
          ok: true,
          detail: supersededIds.length > 0
            ? `record present; provenance confirmed; ${supersededIds.length} prior claim(s) superseded`
            : 'record present; subject, relationship, object, and provenance confirmed',
        };
      },
    },

    {
      name: 'knowledge.retract',
      description: 'Mark an existing knowledge claim as no longer active without deleting its history or supplying a replacement. Write: user origin only.',
      inputHint: '{"target":"record id","reason":"optional text"}',
      permission: 'write',
      origins: [ORIGIN_USER],
      // Retraction changes what APEX treats as active knowledge, so a model proposal
      // can never authorize it. The registry also forbids write actions for the model.
      plannable: false,
      validate(input) {
        const o = expectObject(input, ['target', 'reason']);
        return {
          target: recordRef(o.target, 'target'),
          reason: optionalReason(o.reason),
        };
      },
      async execute(ctx, { target, reason }) {
        const { event, record } = await knowledge.retract({
          target,
          reason,
          provenance: { operationId: ctx.operationId },
          origin: ctx.origin,
        });
        const reasonNote = event.reason ? ' with a recorded reason' : '';
        return {
          summary: `retracted knowledge record ${shortId(record.id)}${reasonNote}; the original claim is preserved`,
          data: {
            targetId: record.id,
            retractionId: event.id,
            reason: event.reason ?? null,
            retractedAt: event.createdAt,
            claim: {
              subject: record.subject,
              relationship: record.relationship,
              object: record.object,
              evidence: record.evidence ?? null,
              createdAt: record.createdAt,
            },
          },
          display: `Retracted knowledge record ${shortId(record.id)}: ${record.subject} --[${record.relationship}]--> ${record.object}. The original claim, evidence, and provenance remain stored.`,
        };
      },
      async verify(ctx, { target }, result) {
        const [rec] = await knowledge.findByPrefix(result.data.targetId);
        if (!rec) return { ok: false, detail: 'retracted record not found in store after write' };
        if (rec.active) return { ok: false, detail: 'record is still reported active' };
        if (rec.status !== 'retracted') return { ok: false, detail: 'record is not reported retracted' };
        const retraction = rec.retraction;
        if (!retraction || retraction.id !== result.data.retractionId) {
          return { ok: false, detail: 'stored retraction event differs from the write result' };
        }
        if ((retraction.reason ?? null) !== (result.data.reason ?? null)) {
          return { ok: false, detail: 'stored retraction reason differs from the write result' };
        }
        if (retraction.origin !== 'user_supplied' && retraction.origin !== 'user_approved') {
          return { ok: false, detail: 'retraction provenance is not user origin' };
        }
        if (retraction.updateMode !== 'user_confirmed') {
          return { ok: false, detail: 'retraction provenance is not user confirmed' };
        }
        // Retraction is append-only: the claim that was retired must still be exactly
        // the claim that was named in the write result.
        const claim = result.data.claim ?? {};
        if (rec.subject !== claim.subject || rec.relationship !== claim.relationship || rec.object !== claim.object) {
          return { ok: false, detail: 'the original claim was altered by the retraction' };
        }
        if ((rec.evidence ?? null) !== (claim.evidence ?? null)) {
          return { ok: false, detail: 'the original evidence was altered by the retraction' };
        }
        if (rec.createdAt !== claim.createdAt) {
          return { ok: false, detail: 'the original timestamp was altered by the retraction' };
        }
        return { ok: true, detail: 'retraction event confirmed; original claim and evidence preserved' };
      },
    },

    {
      name: 'knowledge.resolve',
      description: 'Record an explicit user decision choosing one claim from a live conflict group. Other claims are preserved; the choice is not verified truth. Write: user origin only.',
      inputHint: '{"target":"record id in the conflict group","choose":"claim id to select","reason":"optional text"}',
      permission: 'write',
      origins: [ORIGIN_USER],
      // A resolution is a user decision about what to treat as chosen. A model proposal
      // could otherwise author the decision and have it recorded as user-originated.
      plannable: false,
      validate(input) {
        const o = expectObject(input, ['target', 'choose', 'reason']);
        return {
          target: recordRef(o.target, 'target'),
          choose: recordRef(o.choose, 'choose'),
          reason: optionalReason(o.reason),
        };
      },
      async execute(ctx, { target, choose, reason }) {
        const { event, chosen, targetIds, claims } = await knowledge.resolve({
          target,
          choose,
          reason,
          provenance: { operationId: ctx.operationId },
          origin: ctx.origin,
        });
        const alternatives = targetIds.length - 1;
        return {
          summary: `recorded resolution ${shortId(event.id)} choosing ${shortId(chosen.id)} among ${targetIds.length} claim(s); ${alternatives} alternative(s) preserved`,
          data: {
            resolutionId: event.id,
            targetId: chosen.id,
            chosenId: chosen.id,
            targetIds,
            reason: event.reason ?? null,
            resolvedAt: event.createdAt,
            provenance: {
              origin: event.provenance.origin,
              updateMode: event.provenance.updateMode,
            },
            chosenClaim: {
              id: chosen.id,
              subject: chosen.subject,
              relationship: chosen.relationship,
              object: chosen.object,
              evidence: chosen.evidence ?? null,
              createdAt: chosen.createdAt,
            },
            claims: claims.map((claim) => ({
              id: claim.id,
              subject: claim.subject,
              relationship: claim.relationship,
              object: claim.object,
              evidence: claim.evidence ?? null,
              createdAt: claim.createdAt,
            })),
          },
          display: [
            `Recorded user resolution ${shortId(event.id)} for ${targetIds.length} conflicting claim(s):`,
            `  chosen: [${shortId(chosen.id)}] ${chosen.subject} --[${chosen.relationship}]--> ${chosen.object}`,
            `  alternatives preserved: ${alternatives}`,
            'This records a user decision. It does not prove the chosen claim is true, and the other claims remain stored.',
          ].join('\n'),
        };
      },
      async verify(_ctx, _input, result) {
        const event = await knowledge.getEvent(result.data.resolutionId);
        if (!event || event.kind !== 'resolution') {
          return { ok: false, detail: 'resolution event not found in store after write' };
        }
        if (event.chosenId !== result.data.chosenId) {
          return { ok: false, detail: 'stored chosen claim differs from the write result' };
        }
        const stored = [...event.targetIds].sort();
        const claimed = [...result.data.targetIds].sort();
        if (stored.length !== claimed.length || stored.some((id, i) => id !== claimed[i])) {
          return { ok: false, detail: 'stored target claims differ from the write result' };
        }
        if ((event.reason ?? null) !== (result.data.reason ?? null)) {
          return { ok: false, detail: 'stored resolution reason differs from the write result' };
        }
        if (event.provenance?.updateMode !== 'user_confirmed'
          || (event.provenance?.origin !== 'user_supplied' && event.provenance?.origin !== 'user_approved')) {
          return { ok: false, detail: 'resolution provenance is not user confirmed' };
        }
        // Append-only: every claim named by the decision must still be exactly the claim
        // that was read when the decision was recorded.
        for (const snapshot of result.data.claims) {
          const fresh = await knowledge.get(snapshot.id);
          if (!fresh) return { ok: false, detail: `claim ${shortId(snapshot.id)} was removed by the resolution` };
          if (fresh.subject !== snapshot.subject
            || fresh.relationship !== snapshot.relationship
            || fresh.object !== snapshot.object
            || (fresh.evidence ?? null) !== (snapshot.evidence ?? null)
            || fresh.createdAt !== snapshot.createdAt) {
            return { ok: false, detail: `claim ${shortId(snapshot.id)} was altered by the resolution` };
          }
        }
        const view = await knowledge.history(result.data.chosenId);
        if (!view || !(view.resolutions ?? []).some((entry) => entry.id === event.id)) {
          return { ok: false, detail: 'resolution is not discoverable in the chosen claim history' };
        }
        return {
          ok: true,
          detail: `resolution event confirmed; ${result.data.claims.length} claim(s) preserved; the choice is a recorded decision, not verified fact`,
        };
      },
    },

    {
      name: 'knowledge.list',
      description: 'List recent knowledge records with provenance and conflict status. Read-only.',
      inputHint: '{"limit": optional 1-50}',
      permission: 'read',
      origins: [ORIGIN_USER, ORIGIN_MODEL],
      validate(input) {
        const o = expectObject(input ?? {}, ['limit']);
        const limit = o.limit === undefined ? 20 : o.limit;
        if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
          throw new ValidationError('limit must be an integer from 1 to 50');
        }
        return { limit };
      },
      async execute(_ctx, { limit }) {
        const records = await knowledge.list({ limit });
        const display = records.length === 0
          ? '  (no knowledge records stored)'
          : records.map(renderRecord).join('\n');
        return {
          summary: `${records.length} knowledge record(s) listed`,
          data: { limit, records },
          display: `Knowledge records (newest first):\n${display}`,
        };
      },
      async verify(_ctx, { limit }, result) {
        const fresh = await knowledge.list({ limit });
        if (result.data.records.length !== fresh.length) {
          return { ok: false, detail: `listed ${result.data.records.length}; an independent read gives ${fresh.length}` };
        }
        if (result.data.records.some((r, i) => r.id !== fresh[i].id)) {
          return { ok: false, detail: 'record ids differ from an independent store read' };
        }
        return { ok: true, detail: `${fresh.length} record(s) confirmed against the store` };
      },
    },

    {
      name: 'knowledge.digest',
      description: 'Cross-source digest of what memory and knowledge hold, optionally for a topic, with conflicts, supersession, retraction, and corrections shown. Read-only; the two sources stay separate.',
      inputHint: '{"query": optional text, "limit": optional 1-10}',
      permission: 'read',
      origins: [ORIGIN_USER, ORIGIN_MODEL],
      validate(input) {
        const o = expectObject(input ?? {}, ['query', 'limit']);
        const limit = o.limit === undefined ? DIGEST_DEFAULT_LIMIT : o.limit;
        if (!Number.isInteger(limit) || limit < 1 || limit > DIGEST_MAX_LIMIT) {
          throw new ValidationError(`limit must be an integer from 1 to ${DIGEST_MAX_LIMIT}`);
        }
        return { query: optionalTextField(o.query, 'query', 500), limit };
      },
      async execute(ctx, { query, limit }) {
        // Private memory never reaches a model-origin caller, the same rule memory.search applies.
        const includePrivate = ctx.origin !== ORIGIN_MODEL;
        const data = await buildKnowledgeDigest({
          memory: ctx.memory, knowledge: ctx.knowledge, query, limit, includePrivate,
        });
        const topic = data.topic === null ? '' : ` for "${data.topic}"`;
        return {
          summary: `digest${topic}: ${data.knowledge.counts.claims} knowledge claim(s), ${data.memory.counts.records} memory record(s)`,
          data,
          display: renderDigest(data),
        };
      },
      async verify(ctx, { query, limit }, result) {
        const includePrivate = ctx.origin !== ORIGIN_MODEL;
        const fresh = await buildKnowledgeDigest({
          memory: ctx.memory, knowledge: ctx.knowledge, query, limit, includePrivate,
        });
        const ids = (records) => (records ?? []).map((record) => record.id).join(',');
        const checks = [
          ['knowledge claim count', result.data.knowledge.counts.claims, fresh.knowledge.counts.claims],
          ['knowledge state', result.data.knowledge.state, fresh.knowledge.state],
          ['knowledge conflict groups', result.data.knowledge.counts.conflicts?.groups, fresh.knowledge.counts.conflicts?.groups],
          ['knowledge corrupt lines', result.data.knowledge.counts.corruptLines, fresh.knowledge.counts.corruptLines],
          ['knowledge records', ids(result.data.knowledge.records), ids(fresh.knowledge.records)],
          ['memory record count', result.data.memory.counts.records, fresh.memory.counts.records],
          ['memory state', result.data.memory.state, fresh.memory.state],
          ['memory corrections', result.data.memory.counts.corrections, fresh.memory.counts.corrections],
          ['memory corrupt lines', result.data.memory.counts.corruptLines, fresh.memory.counts.corruptLines],
          ['memory records', ids(result.data.memory.records), ids(fresh.memory.records)],
        ];
        if (query !== null) {
          checks.push(
            ['knowledge matches', ids(result.data.knowledge.search?.results), ids(fresh.knowledge.search?.results)],
            ['knowledge matched count', result.data.knowledge.search?.matched, fresh.knowledge.search?.matched],
            ['memory matches', ids(result.data.memory.search?.results), ids(fresh.memory.search?.results)],
            ['memory matched count', result.data.memory.search?.matched, fresh.memory.search?.matched],
          );
        }
        const changed = checks.find(([, claimed, reread]) => claimed !== reread);
        if (changed) {
          return { ok: false, detail: `${changed[0]} differs from an independent re-read of the stores` };
        }
        return {
          ok: true,
          detail: `${fresh.knowledge.counts.claims} claim(s) and ${fresh.memory.counts.records} memory record(s) confirmed against the stores`,
        };
      },
    },

    {
      name: 'knowledge.search',
      description: 'Search knowledge by keyword across subject, relationship, object, and evidence. Read-only.',
      inputHint: '{"query": "text", "limit": optional 1-10}',
      permission: 'read',
      origins: [ORIGIN_USER, ORIGIN_MODEL],
      validate(input) {
        const o = expectObject(input, ['query', 'limit']);
        const limit = o.limit === undefined ? 5 : o.limit;
        if (!Number.isInteger(limit) || limit < 1 || limit > 10) {
          throw new ValidationError('limit must be an integer from 1 to 10');
        }
        return {
          query: textField(o.query, 'query', 500),
          limit,
        };
      },
      async execute(_ctx, { query, limit }) {
        const hits = await knowledge.search(query, { limit });
        const display = hits.length === 0
          ? '  (no matching knowledge records)'
          : hits.map((h) => renderRecord(h.record)).join('\n');
        return {
          summary: `${hits.length} matching knowledge record(s)`,
          data: { query, hits: hits.map((h) => ({ ...h.record, score: h.score })) },
          display: `Knowledge search for "${query}":\n${display}`,
        };
      },
      async verify(_ctx, { query, limit }, result) {
        const fresh = await knowledge.search(query, { limit });
        const claimed = result.data.hits.map((h) => h.id);
        const actual = fresh.map((h) => h.record.id);
        if (claimed.length !== actual.length || claimed.some((id, i) => id !== actual[i])) {
          return { ok: false, detail: 'returned hits differ from an independent store search' };
        }
        return { ok: true, detail: `${claimed.length} hit(s) confirmed against the store` };
      },
    },
  ];
}
