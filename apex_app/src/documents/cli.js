// CLI surface for T-12. Configuration is inert, enable is the explicit content-permission grant,
// and only ingest reads file contents. Search and evidence are read-only.
import { ValidationError } from '../errors.js';

function integer(flags, name, min, max) {
  if (flags[name] === undefined) return null;
  const value = Number(flags[name]);
  if (!Number.isInteger(value) || value < min || value > max) throw new ValidationError(`--${name} must be a whole number from ${min} to ${max}`, 'USAGE');
  return value;
}

function firstLine(value, max = 160) { return String(value ?? '').replace(/\s+/g, ' ').slice(0, max); }

function renderDocument(row) {
  return `  ${row.documentId} v${row.version} ${row.status} ${row.path} (${row.format}, ${row.bytes} bytes)${row.deleted ? ' [deleted]' : ''}`;
}

export async function runDocumentCommand({ app, args, out, err, parseFlags, rejectUnexpected }) {
  const service = app.documents;
  if (!service) { err('document content understanding is not available in this configuration'); return 1; }
  const [sub, ...rest] = args;
  if (sub === 'sources' || sub === 'status') {
    const { rest: extra } = parseFlags(rest, []);
    rejectUnexpected(extra, `document ${sub}`);
    const status = await service.status();
    out([
      `Document content ${status.config.enabled ? 'enabled' : 'disabled'}${status.config.paused ? '; paused' : ''}; permission ${status.permission}.`,
      `Indexed ${status.indexed} document(s), ${status.failed} failed, ${status.deleted} deleted, ${status.corrupt} corrupt record(s).`,
      `Roots: ${status.config.roots.length ? status.config.roots.join(', ') : 'none'}; formats: ${status.config.extensions.join(', ')}.`,
      `Limits: ${status.config.maxFiles} file(s), ${status.config.maxBytes} bytes each.`,
    ].join('\n'));
    return 0;
  }
  if (sub === 'diagnose') {
    const { rest: extra } = parseFlags(rest, []);
    rejectUnexpected(extra, 'document diagnose');
    const report = await service.diagnose();
    out([`Document diagnosis: ${report.healthy ? 'healthy' : 'problems found'}`, ...report.checks.map((check) => `  [${check.ok ? 'ok' : 'FAIL'}] ${check.name}: ${detail(check.detail)}`), 'No inference process is contacted; extraction is local and deterministic.'].join('\n'));
    return report.healthy ? 0 : 1;
  }
  if (sub === 'configure') {
    const { flags, rest: ids } = parseFlags(rest, ['root', 'extension', 'exclude', 'entity', 'max-files', 'max-bytes', 'interval'], ['root', 'extension', 'exclude']);
    if (ids.length > 0) { err('usage: document configure [--root <dir>]... [--extension <ext>]... [--entity <id>] [--max-files N] [--max-bytes N] [--interval <ms>]'); return 2; }
    const patch = {};
    if (flags.root !== undefined) patch.roots = flags.root;
    if (flags.extension !== undefined) patch.extensions = flags.extension;
    if (flags.exclude !== undefined) patch.exclude = flags.exclude;
    if (flags.entity !== undefined) patch.entityId = flags.entity;
    const maxFiles = integer(flags, 'max-files', 1, 500);
    if (maxFiles !== null) patch.maxFiles = maxFiles;
    const maxBytes = integer(flags, 'max-bytes', 1, 4 * 1024 * 1024);
    if (maxBytes !== null) patch.maxBytes = maxBytes;
    const interval = integer(flags, 'interval', 1000, 86400000);
    if (interval !== null) patch.intervalMs = interval;
    if (Object.keys(patch).length === 0) { err('document configure needs at least one option'); return 2; }
    const result = await service.configure(patch);
    out(`Document source configured; content permission is ${result.config.enabled ? 'granted' : 'not granted'}.`);
    return 0;
  }
  if (sub === 'enable' || sub === 'disable' || sub === 'pause' || sub === 'resume') {
    const { rest: extra } = parseFlags(rest, []);
    rejectUnexpected(extra, `document ${sub}`);
    const result = sub === 'enable' ? await service.enable() : sub === 'disable' ? await service.disable() : sub === 'pause' ? await service.pause() : await service.resume();
    out(sub === 'enable' ? `Content ingestion is enabled; permission ${result.permission} was granted. Files are still read only during an explicit ingest or runtime tick.`
      : sub === 'disable' ? 'Content ingestion is disabled; no file contents will be read and existing index history is preserved.'
        : sub === 'pause' ? 'Content ingestion is paused.' : 'Content ingestion is resumed.');
    return 0;
  }
  if (sub === 'ingest') {
    const { flags, rest: extra } = parseFlags(rest, ['force']);
    rejectUnexpected(extra, 'document ingest [--force]');
    const report = await service.ingest({ force: flags.force === true });
    if (report.status === 'skipped') { err(`document ingestion skipped: ${report.reason}`); return 1; }
    out([
      `Document ingest: ${report.indexed} indexed, ${report.changed} changed, ${report.duplicates} duplicate, ${report.failed} failed, ${report.deleted} deleted of ${report.observed} observed in ${report.durationMs} ms${report.truncated ? ' (bounded; more files remain)' : ''}.`,
      ...(report.limited > 0 ? [`  ${report.limited} current file(s) were not indexed because the index is at its document limit.`] : []),
      ...report.documents.slice(0, 20).map((row) => `  ${row.documentId} v${row.version} ${row.status} ${row.path} (${row.candidateIds} candidate fact(s))`),
      ...(report.documents.length > 20 ? [`  ... and ${report.documents.length - 20} more document(s).`] : []),
      ...report.warnings.slice(0, 10).map((line) => `  note: ${line}`),
      ...(report.warnings.length > 10 ? [`  ... and ${report.warnings.length - 10} more note(s).`] : []),
    ].join('\n'));
    return 0;
  }
  if (sub === 'list') {
    const { flags, rest: extra } = parseFlags(rest, ['limit', 'all']);
    rejectUnexpected(extra, 'document list [--limit N] [--all]');
    const limit = integer(flags, 'limit', 1, 100) ?? 20;
    const rows = await service.list({ limit, includeDeleted: flags.all === true });
    out([`${rows.length} document(s):`, ...rows.map(renderDocument), rows.length === 0 ? '  (none indexed)' : null].filter(Boolean).join('\n'));
    return 0;
  }
  if (sub === 'show') {
    const { rest: ids } = parseFlags(rest, []);
    if (ids.length !== 1) { err('usage: document show <document-id>'); return 2; }
    const doc = await service.document(ids[0]);
    if (!doc) { err('document not found'); return 1; }
    out([
      `${doc.documentId} ${doc.deleted ? '[deleted]' : `v${doc.version} ${doc.status}`}`,
      `  path: ${doc.path} (${doc.format}); root ${doc.root}`,
      `  content sha256: ${doc.contentHash}`,
      `  bytes: ${doc.bytes}; observed ${doc.observedAt}; ingested ${doc.ingestedAt}`,
      ...(doc.status === 'failed' && doc.error ? [`  error: ${firstLine(doc.error, 300)}`] : []),
      `  extractor: ${doc.extractor?.id} v${doc.extractor?.version}`,
      `  sections: ${doc.sections.length}; warnings: ${doc.warnings.length}; limitations: ${doc.limitations.length}`,
      ...doc.limitations.slice(0, 5).map((line) => `  limitation: ${firstLine(line, 200)}`),
      `  extract: document evidence ${doc.documentId} --section 0`,
    ].join('\n'));
    return 0;
  }
  if (sub === 'search' || sub === 'ask') {
    const { flags, rest: words } = parseFlags(rest, ['limit', 'document', 'version', 'section']);
    if (words.length === 0) { err(`usage: document ${sub} <query>`); return 2; }
    const query = words.join(' ');
    const limit = integer(flags, 'limit', 1, 20) ?? 5;
    if (sub === 'ask') {
      const answer = await service.ask(query, { limit });
      out([
        `Question: ${answer.question}`,
        `Explicit source statements: ${answer.explicit.length ? '' : '(none found)'}`,
        ...answer.explicit.map((line) => `  ${line}`),
        `Deterministically extracted: ${answer.extracted.length ? '' : '(none found)'}`,
        ...answer.extracted.map((line) => `  ${line}`),
        'Rule-based inference:',
        ...(answer.inferred.length ? answer.inferred.map((line) => `  ${line}`) : ['  (none)']),
        'Not determinable from the available material:',
        ...(answer.unknown.length ? answer.unknown.map((line) => `  ${line}`) : ['  (nothing marked unknown)']),
      ].join('\n'));
      return 0;
    }
    const results = await service.search(query, { limit, documentId: flags.document ?? null, version: integer(flags, 'version', 1, 60), section: integer(flags, 'section', 0, 199) });
    out([`${results.length} document match(es) for \"${query}\":`, ...results.flatMap((result) => [
      `  ${result.documentId} v${result.version} ${result.path} [${result.reasons.join(', ')}]`,
      `    ${result.section?.label ?? 'document'}: ${firstLine(result.excerpt.text, 300)}`,
    ]), results.length === 0 ? '  (no match; this is not proof that the information is absent)' : null].filter(Boolean).join('\n'));
    return 0;
  }
  if (sub === 'versions' || sub === 'compare') {
    const { flags, rest: ids } = parseFlags(rest, ['from', 'to']);
    if (ids.length !== 1) { err(`usage: document ${sub} <document-id> [--from N] [--to N]`); return 2; }
    if (sub === 'compare') {
      const result = await service.compare(ids[0], { from: integer(flags, 'from', 1, 60), to: integer(flags, 'to', 1, 60) });
      if (!result) { err('document not found'); return 1; }
      if (result.error) { err(result.error); return 1; }
      out([
        `Comparison of ${result.path}: v${result.from.version} -> v${result.to.version}; changed=${result.changed}`,
        `  added lines: ${result.diff.added.length}; removed lines: ${result.diff.removed.length}; unchanged: ${result.diff.unchanged}`,
        ...result.diff.added.slice(0, 10).map((line) => `  + ${firstLine(line, 200)}`),
        ...result.diff.removed.slice(0, 10).map((line) => `  - ${firstLine(line, 200)}`),
      ].join('\n'));
      return 0;
    }
    const versions = await service.versions(ids[0]);
    if (!versions) { err('document not found'); return 1; }
    out([`${versions.length} version(s):`, ...versions.map((version) => `  v${version.version} ${version.status} ${version.contentHash.slice(0, 16)}… ${version.createdAt}`)].join('\n'));
    return 0;
  }
  if (sub === 'evidence') {
    const { flags, rest: ids } = parseFlags(rest, ['version', 'section']);
    if (ids.length !== 1) { err('usage: document evidence <document-id> [--version N] [--section N]'); return 2; }
    const result = await service.evidence(ids[0], { version: integer(flags, 'version', 1, 60), section: integer(flags, 'section', 0, 199) });
    if (!result) { err('document or version not found'); return 1; }
    out([
      `${result.document.documentId} v${result.document.version} ${result.document.path} (${result.document.format})${result.document.current ? ' [current]' : ' [historical or unavailable]'}`,
      `  content sha256 ${result.document.contentHash}; extractor ${result.extractor?.id} v${result.extractor?.version}`,
      `  section: ${result.section?.label ?? 'document'}; range ${result.section?.start ?? 0}-${result.section?.end ?? result.excerpt.length}`,
      result.excerpt,
      ...result.limitations.map((line) => `  limitation: ${firstLine(line, 200)}`),
    ].join('\n'));
    return 0;
  }
  if (sub === 'facts') {
    const { rest: ids } = parseFlags(rest, []);
    if (ids.length !== 1) { err('usage: document facts <document-id>'); return 2; }
    const facts = await service.candidateFacts(ids[0]);
    out([`${facts.length} document-derived candidate(s):`, ...facts.map((fact) => `  ${fact.id} ${fact.subject} --[${fact.relationship}]--> ${fact.object} [candidate; source ${fact.sourceState}; status ${fact.status}]`), facts.length === 0 ? '  (none; a candidate is not user-confirmed knowledge)' : null].filter(Boolean).join('\n'));
    return 0;
  }
  if (sub === 'promote') {
    const { flags, rest: ids } = parseFlags(rest, ['reason']);
    if (ids.length !== 1) { err('usage: document promote <candidate-id> [--reason <text>]'); return 2; }
    const result = await app.knowledge.promoteSourceCandidate({ target: ids[0], origin: 'user', provenance: { operationId: 'document-promote', context: flags.reason ?? null } });
    out(`Promoted candidate ${ids[0]} to user-confirmed knowledge ${result.record.id}; the candidate and its document provenance remain in history.`);
    return 0;
  }
  if (sub === 'invalidate') {
    const { flags, rest: ids } = parseFlags(rest, ['reason']);
    if (ids.length !== 1 || !flags.reason) { err('usage: document invalidate <document-id> --reason <text>'); return 2; }
    const result = await service.invalidate(ids[0], { reason: flags.reason });
    out(`Invalidated ${result.documentId}; history is preserved and a later ingest can index it again.`);
    return 0;
  }
  if (sub === 'reprocess') {
    const { rest: ids } = parseFlags(rest, []);
    if (ids.length !== 1) { err('usage: document reprocess <document-id>'); return 2; }
    const result = await service.reprocess(ids[0]);
    if (result.status === 'skipped') { err(`document reprocessing skipped: ${result.reason}`); return 1; }
    out(`Reprocessed ${ids[0]}: ${result.indexed} indexed, ${result.failed} failed.`);
    return 0;
  }
  err('usage: document sources|status|diagnose|configure|enable|disable|pause|resume|ingest|list|show|search|ask|versions|compare|evidence|facts|promote|invalidate|reprocess');
  return 2;
}

function detail(value) { return firstLine(value, 400); }
