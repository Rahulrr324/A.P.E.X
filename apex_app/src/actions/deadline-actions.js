// Deadline actions: import recorded dates from a local file, and list what was recorded.
//
// The import reads a bounded file inside an authorized workspace root. It never infers a due
// date, never schedules anything, and never edits the source. Every stored record names the file,
// its SHA-256, and the line it came from, and the verifier re-reads that file to confirm the
// records match it. A model origin is not accepted for either action: a deadline is the owner's
// recorded date, not a model suggestion.
import path from 'node:path';
import { ExecutionError, ValidationError } from '../errors.js';
import { CONTROL_CHARS, singleLine, shortId } from '../util.js';
import { containsSecret } from '../security/secrets.js';
import { workspaceField } from '../filesystem/roots.js';
import {
  decodeText, expectObject, pathField, readBuf, relativeTo, resolveForAction, sha256,
} from '../filesystem/workspace.js';
import {
  deadlineIdentity, daysUntil, MAX_DEADLINES, MAX_TITLE_CHARS, normalizeDueAt,
} from '../deadlines/store.js';
import { ORIGIN_USER } from './origins.js';

export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
export const DEADLINE_LIST_DEFAULT_LIMIT = 50;
export const DEADLINE_LIST_MAX_LIMIT = 200;
export const DEADLINE_LIST_DEFAULT_HORIZON_DAYS = 30;
export const DEADLINE_LIST_MAX_HORIZON_DAYS = 3650;

const JSONL_EXTENSIONS = new Set(['.jsonl', '.ndjson']);
const DELIMITED_EXTENSIONS = new Map([['.csv', ','], ['.tsv', '\t']]);
const MAX_REPORTED_PROBLEMS = 5;

function cleanTitle(raw, line, problems) {
  try {
    if (typeof raw !== 'string') throw new ValidationError('title must be text');
    const title = raw.replace(/\r\n/g, '\n').trim();
    if (title.length === 0) throw new ValidationError('title is empty');
    if (title.length > MAX_TITLE_CHARS) throw new ValidationError(`title exceeds ${MAX_TITLE_CHARS} characters`);
    if (CONTROL_CHARS.test(title)) throw new ValidationError('title contains control characters');
    if (containsSecret(title)) {
      throw new ValidationError('title looks like a password, key, or token; the file was not imported', 'SECRET_REFUSED');
    }
    return title;
  } catch (err) {
    problems.push(`line ${line}: ${err.message}`);
    return null;
  }
}

function cleanDueAt(raw, line, problems) {
  try {
    return normalizeDueAt(raw);
  } catch (err) {
    problems.push(`line ${line}: ${err.message}`);
    return null;
  }
}

function parseJsonl(text, problems) {
  const entries = [];
  const lines = text.split(/\r\n|\n|\r/);
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    if (raw.trim() === '') continue;
    const at = index + 1;
    let value;
    try {
      value = JSON.parse(raw);
    } catch {
      problems.push(`line ${at}: not valid JSON`);
      continue;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      problems.push(`line ${at}: must be an object with "title" and "dueAt"`);
      continue;
    }
    const unexpected = Object.keys(value).filter((key) => key !== 'title' && key !== 'dueAt');
    if (unexpected.length > 0) {
      problems.push(`line ${at}: unexpected field "${singleLine(unexpected[0], 40)}"`);
      continue;
    }
    const title = cleanTitle(value.title, at, problems);
    const dueAt = cleanDueAt(value.dueAt, at, problems);
    if (title !== null && dueAt !== null) entries.push({ title, dueAt, line: at });
  }
  return entries;
}

// A small RFC 4180 reader: quoted fields may contain the delimiter, newlines, and doubled quotes.
// Each row keeps the line it started on, so a refusal can point at the source line.
function parseDelimitedRows(text, delimiter) {
  const rows = [];
  let fields = [];
  let field = '';
  let inQuotes = false;
  let line = 1;
  let rowLine = 1;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        if (ch === '\n') line += 1;
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      fields.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      fields.push(field);
      field = '';
      rows.push({ fields, line: rowLine });
      fields = [];
      line += 1;
      rowLine = line;
    } else {
      field += ch;
    }
  }
  if (inQuotes) throw new ExecutionError('INVALID_DEADLINE_FILE', 'the file has an unterminated quoted field');
  if (field.length > 0 || fields.length > 0) {
    fields.push(field);
    rows.push({ fields, line: rowLine });
  }
  return rows;
}

function parseDelimited(text, delimiter, problems) {
  const rows = parseDelimitedRows(text, delimiter);
  if (rows.length === 0) {
    problems.push('the file is empty');
    return [];
  }
  const header = rows[0].fields.map((value) => value.trim().toLowerCase());
  const titleIndex = header.indexOf('title');
  const dueIndex = header.indexOf('dueat');
  if (titleIndex < 0 || dueIndex < 0) {
    throw new ExecutionError(
      'INVALID_DEADLINE_FILE',
      'the first row must be a header naming a "title" column and a "dueAt" column',
    );
  }
  const entries = [];
  for (const row of rows.slice(1)) {
    if (row.fields.every((value) => value.trim() === '')) continue;
    if (row.fields.length !== header.length) {
      problems.push(`line ${row.line}: has ${row.fields.length} field(s); the header has ${header.length}`);
      continue;
    }
    const title = cleanTitle(row.fields[titleIndex], row.line, problems);
    const dueAt = cleanDueAt(row.fields[dueIndex], row.line, problems);
    if (title !== null && dueAt !== null) entries.push({ title, dueAt, line: row.line });
  }
  return entries;
}

// The format is decided by the file name, never by guessing at the content: a text file with
// commas in every line is not silently treated as a schedule.
export function parseDeadlineFile(inputPath, text) {
  const extension = path.extname(inputPath).toLowerCase();
  const problems = [];
  let format;
  let entries;
  if (JSONL_EXTENSIONS.has(extension)) {
    format = 'jsonl';
    entries = parseJsonl(text, problems);
  } else if (DELIMITED_EXTENSIONS.has(extension)) {
    format = extension === '.tsv' ? 'tsv' : 'csv';
    entries = parseDelimited(text, DELIMITED_EXTENSIONS.get(extension), problems);
  } else {
    throw new ExecutionError(
      'UNSUPPORTED_DEADLINE_FILE',
      'deadline import reads .jsonl, .ndjson, .csv, or .tsv files; the file name has no supported extension',
    );
  }
  return { format, entries, problems };
}

function daysPhrase(days) {
  if (days === null) return 'date unreadable';
  if (days < 0) return `overdue by ${Math.abs(days)} day(s)`;
  if (days === 0) return 'due today';
  return `in ${days} day(s)`;
}

function withinHorizon(items, horizonDays) {
  return items.filter((item) => item.daysUntil !== null && item.daysUntil <= horizonDays);
}

function importAction(deadlines, roots, { maxBytes = MAX_IMPORT_BYTES } = {}) {
  return {
    name: 'deadline.import',
    description: 'Import recorded deadlines from a bounded JSONL, NDJSON, CSV, or TSV file inside an authorized workspace root. Each entry needs a title and a strict ISO date; no date is inferred. Write: user origin only.',
    inputHint: `{"path": "relative/deadlines.csv", "workspace": optional root name, "maxBytes": optional 1-${maxBytes}}`,
    permission: 'write',
    origins: [ORIGIN_USER],
    // The file's dates are the effect the user asked for. It is never offered as a plan step.
    plannable: false,
    validate(input) {
      const o = expectObject(input, ['path', 'workspace', 'maxBytes']);
      const p = pathField(o.path);
      let limit = maxBytes;
      if (o.maxBytes !== undefined) {
        if (!Number.isInteger(o.maxBytes) || o.maxBytes < 1 || o.maxBytes > maxBytes) {
          throw new ValidationError(`maxBytes must be an integer from 1 to ${maxBytes}`);
        }
        limit = o.maxBytes;
      }
      return { path: p, workspace: workspaceField(o.workspace, roots), maxBytes: limit };
    },
    async execute(ctx, { path: inputPath, workspace, maxBytes: limit }) {
      const root = roots.pick(workspace);
      const file = resolveForAction(root, inputPath);
      const buf = readBuf(file, limit);
      const digest = sha256(buf);
      const text = decodeText(buf);
      const parsed = parseDeadlineFile(inputPath, text);
      if (parsed.problems.length > 0) {
        const shown = parsed.problems.slice(0, MAX_REPORTED_PROBLEMS).join('; ');
        const more = parsed.problems.length > MAX_REPORTED_PROBLEMS
          ? `; and ${parsed.problems.length - MAX_REPORTED_PROBLEMS} more`
          : '';
        throw new ExecutionError(
          'INVALID_DEADLINE_FILE',
          `nothing was imported: ${parsed.problems.length} problem(s): ${shown}${more}`,
        );
      }
      if (parsed.entries.length === 0) {
        throw new ExecutionError('INVALID_DEADLINE_FILE', 'the file contains no deadline entries; nothing was imported');
      }
      if (parsed.entries.length > MAX_DEADLINES) {
        throw new ExecutionError(
          'TOO_MANY_ENTRIES',
          `the file contains ${parsed.entries.length} entries; at most ${MAX_DEADLINES} may be imported at once`,
        );
      }
      const relativePath = relativeTo(root, file);
      const outcome = await deadlines.import(parsed.entries, {
        path: relativePath,
        sha256: digest,
        provenance: { operationId: ctx?.operationId ?? null },
        origin: 'user',
      });
      const added = outcome.added.map((record) => ({
        id: record.id,
        shortId: shortId(record.id),
        dueAt: record.dueAt,
        line: record.source.line,
      }));
      const lines = [
        `Imported ${added.length} new deadline(s) from "${relativePath}" (${parsed.format}, ${buf.length} bytes, sha256 ${digest.slice(0, 16)}…):`,
        ...added.map((entry, index) => `  [${entry.shortId}] ${entry.dueAt}  ${outcome.added[index].title}  (line ${entry.line})`),
      ];
      if (outcome.duplicates > 0) {
        lines.push(`  ${outcome.duplicates} entr(ies) were already recorded and were not added again.`);
      }
      lines.push('  (recorded dates from the file; nothing was scheduled, and no due date was inferred)');
      return {
        summary: `imported ${added.length} new deadline(s) from "${relativePath}" (${outcome.duplicates} already recorded)`,
        data: {
          path: relativePath,
          workspace,
          format: parsed.format,
          size: buf.length,
          sha256: digest,
          total: outcome.total,
          added: added.length,
          duplicates: outcome.duplicates,
          entries: added,
        },
        display: lines.join('\n'),
      };
    },
    async verify(ctx, input, result) {
      try {
        const root = roots.pick(input.workspace);
        const file = resolveForAction(root, input.path);
        const fresh = readBuf(file, input.maxBytes);
        if (sha256(fresh) !== result.data.sha256) {
          return { ok: false, detail: 'the source file changed since it was imported' };
        }
        const parsed = parseDeadlineFile(input.path, decodeText(fresh));
        if (parsed.problems.length > 0) {
          return { ok: false, detail: 'the source file no longer parses the way the import reported' };
        }
        if (parsed.entries.length !== result.data.total) {
          return { ok: false, detail: `the source now holds ${parsed.entries.length} entries, not ${result.data.total}` };
        }
        if (result.data.added + result.data.duplicates !== result.data.total) {
          return { ok: false, detail: 'the added and duplicate counts do not add up to the entries read' };
        }
        const stored = await deadlines.list();
        const byId = new Map(stored.map((record) => [record.id, record]));
        const byIdentity = new Map(stored.map((record) => [deadlineIdentity(record.title, record.dueAt), record]));
        for (const entry of parsed.entries) {
          const record = byIdentity.get(deadlineIdentity(entry.title, entry.dueAt));
          if (!record) return { ok: false, detail: `the deadline on line ${entry.line} is not recorded after the import` };
        }
        for (const entry of result.data.entries) {
          const record = byId.get(entry.id);
          if (!record) return { ok: false, detail: `reported deadline ${shortId(entry.id)} cannot be found in the store` };
          if (record.dueAt !== entry.dueAt) return { ok: false, detail: `deadline ${shortId(entry.id)} has a different due date in the store` };
          if (record.source.sha256 !== result.data.sha256) return { ok: false, detail: `deadline ${shortId(entry.id)} does not carry this file's digest` };
          if (record.source.line !== entry.line) return { ok: false, detail: `deadline ${shortId(entry.id)} does not carry the reported source line` };
        }
        return {
          ok: true,
          detail: `${result.data.added} added and ${result.data.duplicates} duplicate deadline(s) confirmed; the source file was re-read and re-parsed`,
        };
      } catch (err) {
        return { ok: false, detail: `the import could not be re-checked: ${err?.message ?? err}` };
      }
    },
  };
}

function listAction(deadlines, { defaultLimit = DEADLINE_LIST_DEFAULT_LIMIT, maxLimit = DEADLINE_LIST_MAX_LIMIT } = {}) {
  return {
    name: 'deadline.list',
    description: 'List recorded deadlines due within a bounded horizon, earliest first, with the source file and line each date came from. Read-only; it schedules nothing.',
    inputHint: `{"limit": optional 1-${maxLimit}, "horizonDays": optional 0-${DEADLINE_LIST_MAX_HORIZON_DAYS}}`,
    permission: 'read',
    origins: [ORIGIN_USER],
    validate(input) {
      const raw = input ?? {};
      if (typeof raw !== 'object' || Array.isArray(raw)) throw new ValidationError('input must be an object');
      for (const key of Object.keys(raw)) {
        if (!['limit', 'horizonDays'].includes(key)) throw new ValidationError(`unexpected field "${singleKey(key)}"`);
      }
      let limit = defaultLimit;
      if (raw.limit !== undefined) {
        if (!Number.isInteger(raw.limit) || raw.limit < 1 || raw.limit > maxLimit) {
          throw new ValidationError(`limit must be an integer from 1 to ${maxLimit}`);
        }
        limit = raw.limit;
      }
      let horizonDays = DEADLINE_LIST_DEFAULT_HORIZON_DAYS;
      if (raw.horizonDays !== undefined) {
        if (!Number.isInteger(raw.horizonDays) || raw.horizonDays < 0 || raw.horizonDays > DEADLINE_LIST_MAX_HORIZON_DAYS) {
          throw new ValidationError(`horizonDays must be an integer from 0 to ${DEADLINE_LIST_MAX_HORIZON_DAYS}`);
        }
        horizonDays = raw.horizonDays;
      }
      return { limit, horizonDays };
    },
    async execute(ctx, { limit, horizonDays }) {
      const now = ctx.now();
      const all = await deadlines.list({ now });
      const within = withinHorizon(all, horizonDays);
      const shown = within.slice(0, limit);
      const overdue = within.filter((item) => item.daysUntil < 0).length;
      const lines = shown.map((item) => `  [${item.shortId}] ${item.dueAt}  ${daysPhrase(item.daysUntil)}  ${item.title}  (from ${item.source.path}:${item.source.line})`);
      return {
        summary: `deadline list: ${shown.length} recorded deadline(s) within ${horizonDays} day(s)${overdue > 0 ? `, ${overdue} overdue` : ''}`,
        data: {
          horizonDays,
          limit,
          total: all.length,
          within: within.length,
          shown: shown.length,
          overdue,
          items: shown,
        },
        display: shown.length === 0
          ? `No recorded deadlines within ${horizonDays} day(s).${all.length > 0 ? ` The ledger holds ${all.length} later deadline(s).` : ' No deadlines have been imported.'}`
          : `Recorded deadlines within ${horizonDays} day(s) (${shown.length} of ${within.length}, ${overdue} overdue):\n${lines.join('\n')}\n  (recorded dates only; APEX schedules nothing)`,
      };
    },
    async verify(ctx, input, result) {
      try {
        const now = ctx.now();
        const all = await deadlines.list({ now });
        const within = withinHorizon(all, input.horizonDays);
        const expected = within.slice(0, input.limit);
        const claimed = result.data.items;
        if (claimed.length !== expected.length) {
          return { ok: false, detail: `the ledger now lists ${expected.length} deadline(s), not ${claimed.length}` };
        }
        for (let i = 0; i < expected.length; i += 1) {
          if (expected[i].id !== claimed[i].id) {
            return { ok: false, detail: `deadline ${i} is ${expected[i].shortId} in the ledger, not ${claimed[i].shortId}` };
          }
          if (expected[i].daysUntil !== claimed[i].daysUntil) {
            return { ok: false, detail: `deadline ${expected[i].shortId} has a different day count in the ledger` };
          }
        }
        if (result.data.overdue !== within.filter((item) => item.daysUntil < 0).length) {
          return { ok: false, detail: 'the overdue count differs from an independent read' };
        }
        return { ok: true, detail: `${expected.length} recorded deadline(s) confirmed by an independent read` };
      } catch (err) {
        return { ok: false, detail: `deadlines could not be re-read: ${err?.message ?? err}` };
      }
    },
  };
}

function singleKey(key) {
  return singleLine(key, 40);
}

export function deadlineActions({ deadlines, roots = null }) {
  return [
    ...(roots ? [importAction(deadlines, roots)] : []),
    listAction(deadlines),
  ];
}
