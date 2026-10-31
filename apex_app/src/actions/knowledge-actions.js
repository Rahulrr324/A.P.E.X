// Knowledge actions: registered by the composition root alongside builtin memory actions.
// Follows the same action definition pattern: validate, execute, verify.
// Write actions (knowledge.add) are user-origin only; the registry enforces this.
// Read actions (knowledge.search, knowledge.list) may be offered to the model.
import { ValidationError } from '../errors.js';
import { CONTROL_CHARS, shortId, singleLine } from '../util.js';
import { containsSecret } from '../security/secrets.js';
import { MAX_SUPERSEDES } from '../knowledge/knowledge-store.js';
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

function expectObject(input, allowedKeys) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('input must be an object');
  }
  for (const key of Object.keys(input)) {
    if (!allowedKeys.includes(key)) throw new ValidationError(`unexpected input field "${singleLine(key, 40)}"`);
  }
  return input;
}

function renderStatus(status, conflictsWith, supersededBy) {
  if (supersededBy && supersededBy.length > 0) return 'superseded';
  if (status === 'conflicting' || (conflictsWith && conflictsWith.length > 0)) {
    return `conflicting (conflicts with: ${(conflictsWith ?? []).map(shortId).join(', ')})`;
  }
  return status ?? 'supported';
}

function renderRecord(r) {
  const status = renderStatus(r.status, r.conflictsWith, r.supersededBy);
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
