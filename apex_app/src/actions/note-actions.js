// Note actions: a structured note is written, corrected, and read by the user.
//
// Every action here is user-origin only and unplannable. A note is the user's own composition, and
// a model may neither write one nor have one offered to a plan; the same rule keeps a note from
// becoming a side effect of an approved plan step.
import { ExecutionError, ValidationError } from '../errors.js';
import { buildKnowledgeDigest, renderDigest } from '../knowledge/digest.js';
import { truncate } from '../util.js';
import { textInput } from './inputs.js';
import { ORIGIN_USER } from './origins.js';

function noteRef(value) {
  const ref = textInput(value, 'note reference', { max: 64 });
  return ref;
}

function sourcesInput(value) {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new ValidationError('sources must be a list');
  return value;
}

function tagsInput(value) {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new ValidationError('tags must be a list');
  return value;
}

function optionalText(value, name, max) {
  return value === undefined || value === null ? undefined : textInput(value, name, { max });
}

function show(summary, data, display) {
  return { summary, data, display: display ?? summary };
}

// The records a digest was built from, cited the way a note cites evidence: a kind and the
// record's exact id. A search result is preferred when the digest ran with a topic.
function digestSources(digest) {
  const sources = [];
  const add = (kind, ref, label) => {
    if (typeof ref !== 'string' || ref.length === 0) return;
    if (sources.some((s) => s.kind === kind && s.ref === ref)) return;
    sources.push({ kind, ref, label });
  };
  for (const record of digest.knowledge.search?.results ?? digest.knowledge.records ?? []) {
    add('knowledge', record.id, truncate(`${record.subject} ${record.relationship} ${record.object}`, 120));
  }
  for (const record of digest.memory.search?.results ?? digest.memory.records ?? []) {
    add('memory', record.id, truncate(record.content, 120));
  }
  return sources.slice(0, 20);
}

export function noteActions(notes) {
  return [
    {
      name: 'note.add',
      description: 'Store a structured personal note with its cited sources and optional private marking. User origin only.',
      inputHint: '{"title": "text", "body": "text", "tags": ["tag"], "sources": [{"kind": "knowledge|memory|file|...", "ref": "id or path"}], "sensitivity": "normal|private"}',
      permission: 'write',
      origins: [ORIGIN_USER],
      plannable: false,
      validate(input) {
        if (input === null || typeof input !== 'object' || Array.isArray(input)) {
          throw new ValidationError('input must be an object');
        }
        const allowed = ['title', 'body', 'tags', 'sources', 'sensitivity'];
        for (const key of Object.keys(input)) {
          if (!allowed.includes(key)) throw new ValidationError(`unexpected input field "${key}"`);
        }
        return {
          title: textInput(input.title, 'title', { max: 160 }),
          body: input.body === undefined ? '' : textInput(input.body, 'body', { max: 20000, multiline: true, required: false }),
          tags: tagsInput(input.tags) ?? [],
          sources: sourcesInput(input.sources) ?? [],
          sensitivity: input.sensitivity === undefined ? 'normal' : input.sensitivity,
        };
      },
      async execute(_ctx, input) {
        const { record, revision } = await notes.add({
          ...input,
          provenance: { operationId: _ctx?.operationId ?? null },
          origin: 'user',
        });
        const shown = sourcesCount(record);
        return show(
          `stored note ${record.id} revision ${revision}${record.sensitivity === 'private' ? ' (private)' : ''}`,
          {
            id: record.id,
            shortId: record.id.slice(0, 8),
            revision,
            title: record.title,
            sensitivity: record.sensitivity,
            tags: record.tags,
            sources: shown,
            bodySha256: record.bodySha256,
          },
          `Note ${record.id.slice(0, 8)} (revision ${revision}) stored: "${record.title}"${record.sensitivity === 'private' ? ' [private]' : ''}, ${shown} source(s), ${record.tags.length} tag(s).`,
        );
      },
      async verify(_ctx, _input, result) {
        try {
          const current = await notes.show(result.data.id, { includePrivate: true });
          if (current.id !== result.data.id) return { ok: false, detail: 'the stored note is no longer the current revision' };
          if (current.revision !== result.data.revision) return { ok: false, detail: `revision is ${current.revision}, not ${result.data.revision}` };
          if (current.bodySha256 !== result.data.bodySha256) return { ok: false, detail: 'the stored body hash differs from the reported hash' };
          if (current.sources.length !== result.data.sources) return { ok: false, detail: 'the stored source count differs from the reported count' };
          return { ok: true, detail: `note ${result.data.shortId} revision ${current.revision} confirmed by an independent read` };
        } catch (err) {
          return { ok: false, detail: `note could not be re-read: ${err?.message ?? err}` };
        }
      },
    },
    {
      name: 'note.update',
      description: 'Revise a note by appending a new revision that names the exact current revision it replaces. User origin only.',
      inputHint: '{"target": "current note id", "title": optional, "body": optional, "tags": optional, "sources": optional, "sensitivity": optional}',
      permission: 'write',
      origins: [ORIGIN_USER],
      plannable: false,
      validate(input) {
        if (input === null || typeof input !== 'object' || Array.isArray(input)) {
          throw new ValidationError('input must be an object');
        }
        const allowed = ['target', 'title', 'body', 'tags', 'sources', 'sensitivity'];
        for (const key of Object.keys(input)) {
          if (!allowed.includes(key)) throw new ValidationError(`unexpected input field "${key}"`);
        }
        if (input.title === undefined && input.body === undefined && input.tags === undefined
          && input.sources === undefined && input.sensitivity === undefined) {
          throw new ValidationError('a revision must change at least one field');
        }
        return {
          target: noteRef(input.target),
          title: optionalText(input.title, 'title', 160),
          body: input.body === undefined ? undefined : textInput(input.body, 'body', { max: 20000, multiline: true, required: false }),
          tags: tagsInput(input.tags),
          sources: sourcesInput(input.sources),
          sensitivity: input.sensitivity,
        };
      },
      async execute(_ctx, input) {
        const { record, revision, previous } = await notes.update({
          ...input,
          provenance: { operationId: _ctx?.operationId ?? null },
          origin: 'user',
        });
        return show(
          `revised note ${previous.id} to ${record.id} (revision ${revision})`,
          {
            id: record.id,
            shortId: record.id.slice(0, 8),
            previousId: previous.id,
            revision,
            title: record.title,
            sensitivity: record.sensitivity,
            tags: record.tags,
            sources: sourcesCount(record),
            bodySha256: record.bodySha256,
          },
          `Note ${record.id.slice(0, 8)} is now revision ${revision} of ${previous.id.slice(0, 8)}: "${record.title}"${record.sensitivity === 'private' ? ' [private]' : ''}.`,
        );
      },
      async verify(_ctx, input, result) {
        try {
          const current = await notes.show(result.data.id, { includePrivate: true });
          if (current.id !== result.data.id) return { ok: false, detail: 'the written revision is no longer the current revision' };
          if (current.revision !== result.data.revision) return { ok: false, detail: `revision is ${current.revision}, not ${result.data.revision}` };
          if (!current.supersedes.includes(result.data.previousId)) {
            return { ok: false, detail: 'the written revision does not name the reported predecessor' };
          }
          const before = await notes.show(input.target, { includePrivate: true });
          if (before.id !== result.data.id) return { ok: false, detail: 'the predecessor no longer resolves to the new revision' };
          return { ok: true, detail: `revision ${current.revision} confirmed, superseding ${current.supersedes[0]?.slice(0, 8)}` };
        } catch (err) {
          return { ok: false, detail: `revision could not be re-read: ${err?.message ?? err}` };
        }
      },
    },
    {
      name: 'note.from_digest',
      description: 'Read the cross-source digest and store that reading as a note, citing every record it was built from. Private memory is excluded. User origin only.',
      inputHint: '{"query": optional text, "limit": optional 1-10, "title": optional text, "tags": optional, "sensitivity": optional "normal|private"}',
      permission: 'write',
      origins: [ORIGIN_USER],
      plannable: false,
      validate(input) {
        if (input === null || typeof input !== 'object' || Array.isArray(input)) {
          throw new ValidationError('input must be an object');
        }
        for (const key of Object.keys(input)) {
          if (!['query', 'limit', 'title', 'tags', 'sensitivity'].includes(key)) {
            throw new ValidationError(`unexpected input field "${key}"`);
          }
        }
        const limit = input.limit === undefined ? 5 : input.limit;
        if (!Number.isInteger(limit) || limit < 1 || limit > 10) {
          throw new ValidationError('limit must be an integer from 1 to 10');
        }
        const sensitivity = input.sensitivity === undefined ? 'normal' : input.sensitivity;
        if (sensitivity !== 'normal' && sensitivity !== 'private') {
          throw new ValidationError('sensitivity must be normal or private');
        }
        return {
          query: input.query === undefined || input.query === null ? null : textInput(input.query, 'query', { max: 500 }),
          limit,
          title: input.title === undefined ? undefined : textInput(input.title, 'title', { max: 160 }),
          tags: tagsInput(input.tags) ?? [],
          sensitivity,
        };
      },
      async execute(ctx, input) {
        let digest;
        try {
          digest = await buildKnowledgeDigest({
            memory: ctx.memory,
            knowledge: ctx.knowledge,
            query: input.query,
            limit: input.limit,
            includePrivate: false,
          });
        } catch (err) {
          throw new ExecutionError('DIGEST_UNAVAILABLE', `the digest could not be read, so no note was stored: ${err?.message ?? err}`);
        }
        const sources = digestSources(digest);
        const title = input.title ?? (digest.topic === null ? 'Knowledge digest' : `Digest: ${truncate(digest.topic, 140)}`);
        const { record, revision } = await notes.add({
          title,
          body: renderDigest(digest),
          tags: input.tags,
          sources,
          sensitivity: input.sensitivity,
          provenance: { operationId: ctx?.operationId ?? null },
          origin: 'user',
        });
        const counts = `knowledge ${digest.knowledge.counts.claims ?? 0} claim(s), memory ${digest.memory.counts.records ?? 0} record(s)`;
        return show(
          `stored note ${record.id} revision ${revision} from the digest (${counts}, ${sources.length} source(s))`,
          {
            id: record.id,
            shortId: record.id.slice(0, 8),
            revision,
            title: record.title,
            sensitivity: record.sensitivity,
            bodySha256: record.bodySha256,
            digestTopic: digest.topic,
            sources: sources.length,
            privateMemoryExcluded: true,
          },
          `Note ${record.id.slice(0, 8)} (revision ${revision}) stored from the digest: "${record.title}".\n`
            + `It cites ${sources.length} record(s) and reports ${counts}. Private memory was excluded; the note holds the digest as it was read, not a new claim about the world.`,
        );
      },
      async verify(ctx, input, result) {
        try {
          const current = await notes.show(result.data.id, { includePrivate: true });
          if (current.revision !== result.data.revision) {
            return { ok: false, detail: `the stored note is at revision ${current.revision}, not ${result.data.revision}` };
          }
          if (current.bodySha256 !== result.data.bodySha256) {
            return { ok: false, detail: 'the stored note body hash differs from the reported hash' };
          }
          if (current.sources.length !== result.data.sources) {
            return { ok: false, detail: 'the stored source count differs from the reported count' };
          }
          for (const source of current.sources) {
            if (source.kind === 'knowledge') {
              const history = await ctx.knowledge.history(source.ref);
              if (!history?.record || history.record.id !== source.ref) {
                return { ok: false, detail: `cited knowledge record ${source.ref.slice(0, 8)} cannot be resolved` };
              }
            } else if (source.kind === 'memory') {
              const record = await ctx.memory.get(source.ref);
              if (!record || record.id !== source.ref) {
                return { ok: false, detail: `cited memory record ${source.ref.slice(0, 8)} cannot be resolved` };
              }
            }
          }
          return { ok: true, detail: `note ${result.data.shortId} revision ${current.revision} confirmed, and every cited source resolves` };
        } catch (err) {
          return { ok: false, detail: `the digest note could not be re-checked: ${err?.message ?? err}` };
        }
      },
    },
    {
      name: 'note.list',
      description: 'List the current revision of each note. Private note bodies are withheld unless includePrivate is set.',
      inputHint: '{"limit": optional 1-200, "includePrivate": optional boolean}',
      permission: 'read',
      origins: [ORIGIN_USER],
      plannable: false,
      validate(input) {
        if (input === null || typeof input !== 'object' || Array.isArray(input)) {
          throw new ValidationError('input must be an object');
        }
        const allowed = ['limit', 'includePrivate'];
        for (const key of Object.keys(input)) {
          if (!allowed.includes(key)) throw new ValidationError(`unexpected input field "${key}"`);
        }
        const limit = input.limit === undefined ? 20 : input.limit;
        if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new ValidationError('limit must be an integer from 1 to 200');
        if (input.includePrivate !== undefined && typeof input.includePrivate !== 'boolean') {
          throw new ValidationError('includePrivate must be true or false');
        }
        return { limit, includePrivate: input.includePrivate === true };
      },
      async execute(_ctx, { limit, includePrivate }) {
        const rows = await notes.list({ limit, includePrivate });
        const shown = rows.map((r) => `  ${r.shortId}  r${r.revision}  ${r.title}${r.sensitivity === 'private' ? ' [private]' : ''}`);
        return show(
          `listed ${rows.length} note(s)${includePrivate ? '' : ' (private bodies withheld)'}`,
          { notes: rows, includePrivate },
          rows.length === 0 ? 'No notes are stored.' : `Notes (${rows.length}):\n${shown.join('\n')}`,
        );
      },
      async verify(_ctx, input, result) {
        try {
          const fresh = await notes.list({ limit: input.limit, includePrivate: input.includePrivate });
          const reported = result.data.notes;
          if (fresh.length !== reported.length) return { ok: false, detail: `the store now lists ${fresh.length} note(s), not ${reported.length}` };
          for (let i = 0; i < fresh.length; i += 1) {
            if (fresh[i].id !== reported[i].id) return { ok: false, detail: `note ${i} is ${fresh[i].shortId} on disk, not ${reported[i].shortId}` };
          }
          return { ok: true, detail: `${fresh.length} note(s) confirmed by an independent listing` };
        } catch (err) {
          return { ok: false, detail: `notes could not be re-listed: ${err?.message ?? err}` };
        }
      },
    },
    {
      name: 'note.show',
      description: 'Show one note at its current revision, with its sources and history. A private body requires includePrivate.',
      inputHint: '{"target": "note id or prefix", "includePrivate": optional boolean}',
      permission: 'read',
      origins: [ORIGIN_USER],
      plannable: false,
      validate(input) {
        if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new ValidationError('input must be an object');
        for (const key of Object.keys(input)) {
          if (!['target', 'includePrivate'].includes(key)) throw new ValidationError(`unexpected input field "${key}"`);
        }
        if (input.includePrivate !== undefined && typeof input.includePrivate !== 'boolean') {
          throw new ValidationError('includePrivate must be true or false');
        }
        return { target: noteRef(input.target), includePrivate: input.includePrivate === true };
      },
      async execute(_ctx, input) {
        const note = await notes.show(input.target, { includePrivate: input.includePrivate });
        const lines = [
          `${note.shortId}  revision ${note.revision}  ${note.createdAt}${note.sensitivity === 'private' ? '  [private]' : ''}`,
          `title: ${note.title}`,
          note.bodyHidden ? 'body: withheld (private; ask for it explicitly)' : `body:\n${note.body}`,
          note.tags.length > 0 ? `tags: ${note.tags.join(', ')}` : 'tags: none',
          note.sources.length > 0
            ? `sources:\n${note.sources.map((s) => `  ${s.kind}: ${s.ref}${s.label ? ` (${s.label})` : ''}`).join('\n')}`
            : 'sources: none',
        ];
        // The body is rendered for the caller but never placed in the result data, because the
        // result is what the audit record keeps. The note log is the one copy of the user's text.
        return show(
          `showed note ${note.shortId} (revision ${note.revision})`,
          { note: { ...note, body: null, bodyHidden: note.sensitivity === 'private' || note.bodyHidden === true } },
          lines.join('\n'),
        );
      },
      async verify(_ctx, input, result) {
        try {
          const fresh = await notes.show(input.target, { includePrivate: input.includePrivate });
          if (fresh.id !== result.data.note.id) return { ok: false, detail: 'the note now resolves to a different revision' };
          if (fresh.bodySha256 !== result.data.note.bodySha256) return { ok: false, detail: 'the note body hash changed since it was shown' };
          return { ok: true, detail: `note ${fresh.shortId} confirmed at revision ${fresh.revision}` };
        } catch (err) {
          return { ok: false, detail: `note could not be re-read: ${err?.message ?? err}` };
        }
      },
    },
    {
      name: 'note.search',
      description: 'Search note titles, tags and bodies. Private notes are excluded unless includePrivate is set.',
      inputHint: '{"query": "words", "limit": optional 1-50, "includePrivate": optional boolean}',
      permission: 'read',
      origins: [ORIGIN_USER],
      plannable: false,
      validate(input) {
        if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new ValidationError('input must be an object');
        for (const key of Object.keys(input)) {
          if (!['query', 'limit', 'includePrivate'].includes(key)) throw new ValidationError(`unexpected input field "${key}"`);
        }
        const limit = input.limit === undefined ? 5 : input.limit;
        if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new ValidationError('limit must be an integer from 1 to 50');
        if (input.includePrivate !== undefined && typeof input.includePrivate !== 'boolean') {
          throw new ValidationError('includePrivate must be true or false');
        }
        return { query: textInput(input.query, 'query', { max: 300 }), limit, includePrivate: input.includePrivate === true };
      },
      async execute(_ctx, input) {
        const found = await notes.search(input.query, { limit: input.limit, includePrivate: input.includePrivate });
        const lines = found.results.map((r) => `  ${r.shortId}  ${r.title}${r.sensitivity === 'private' ? ' [private]' : ''}  (score ${r.score})`);
        const withheld = found.excludedPrivate > 0 ? `\n  (${found.excludedPrivate} private note(s) matched and were withheld)` : '';
        return show(
          `found ${found.results.length} note(s) for "${input.query}"${found.excludedPrivate > 0 ? `, ${found.excludedPrivate} private withheld` : ''}`,
          { results: found.results, excludedPrivate: found.excludedPrivate, matched: found.matched },
          found.results.length === 0
            ? `No notes match "${input.query}".${withheld}`
            : `Notes matching "${input.query}" (${found.matched} matched, ${found.results.length} shown):\n${lines.join('\n')}${withheld}`,
        );
      },
      async verify(_ctx, input, result) {
        try {
          const fresh = await notes.search(input.query, { limit: input.limit, includePrivate: input.includePrivate });
          const reported = result.data.results;
          if (fresh.results.length !== reported.length) return { ok: false, detail: `the store now returns ${fresh.results.length} result(s), not ${reported.length}` };
          for (let i = 0; i < fresh.results.length; i += 1) {
            if (fresh.results[i].id !== reported[i].id) return { ok: false, detail: `result ${i} is ${fresh.results[i].shortId} on disk, not ${reported[i].shortId}` };
          }
          return { ok: true, detail: `${fresh.results.length} search result(s) confirmed by an independent read` };
        } catch (err) {
          return { ok: false, detail: `search could not be re-run: ${err?.message ?? err}` };
        }
      },
    },
    {
      name: 'note.history',
      description: 'Show every stored revision of one note, oldest first, and whether its revision chain is intact.',
      inputHint: '{"target": "note id or prefix"}',
      permission: 'read',
      origins: [ORIGIN_USER],
      plannable: false,
      validate(input) {
        if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new ValidationError('input must be an object');
        for (const key of Object.keys(input)) {
          if (key !== 'target') throw new ValidationError(`unexpected input field "${key}"`);
        }
        return { target: noteRef(input.target) };
      },
      async execute(_ctx, input) {
        const history = await notes.history(input.target);
        const lines = history.versions.map((v) => `  r${v.revision}  ${v.shortId}  ${v.createdAt}  ${v.title}`);
        return show(
          `note ${history.id.slice(0, 8)} has ${history.versions.length} stored revision(s)${history.conflict ? ' and a competing revision' : ''}`,
          { history },
          `Revisions of ${history.id.slice(0, 8)} (oldest first${history.truncated ? ', truncated' : ''}):\n${lines.join('\n')}`
            + `${history.conflict ? '\n  WARNING: more than one revision names this one; the current text is ambiguous.' : ''}`,
        );
      },
      async verify(_ctx, input, result) {
        try {
          const fresh = await notes.history(input.target);
          if (fresh.versions.length !== result.data.history.versions.length) {
            return { ok: false, detail: `the chain now holds ${fresh.versions.length} revision(s), not ${result.data.history.versions.length}` };
          }
          if (fresh.current !== result.data.history.current) return { ok: false, detail: 'the current revision changed while the history was read' };
          return { ok: true, detail: `${fresh.versions.length} revision(s) confirmed by an independent read` };
        } catch (err) {
          return { ok: false, detail: `history could not be re-read: ${err?.message ?? err}` };
        }
      },
    },
  ];
}

function sourcesCount(record) {
  return record.sources.length;
}
