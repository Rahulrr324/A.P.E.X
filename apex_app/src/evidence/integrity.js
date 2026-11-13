// Batch AP-06: one closed vocabulary for the integrity of assembled evidence.
//
// Every consumer that reads several stores has, until now, described its own doubts in its own words:
// a digest that did not match, a plan id with no plan, a history that stopped at a limit. This module
// gives those doubts a fixed set of names so that a caller can decide what to do with an answer without
// parsing prose, and so that two reports describing the same condition cannot disagree about it.
//
// The vocabulary is closed and ordered. `valid` is the least severe state and each later entry outranks
// everything before it, so a bundle with several findings is reported by its worst one. The order is
// deliberate: a bounded read (`valid_bounded`) is still evidence, a missing record is a gap, a stale or
// conflicting record is a disagreement inside the gap, a broken reference is an absence that was cited,
// and damage, truncation, concurrent modification and an unverifiable store each mean the answer cannot
// be trusted even about itself.
//
// Nothing here repairs anything. A finding is a statement about what the records say now; rewriting,
// deleting or back-filling a record to make a finding disappear would destroy the evidence the finding
// is about. Every report this module produces carries `authorizes: false`, because integrity metadata is
// not an authority: a valid digest proves the bytes have not changed since they were read, never that
// they are true, and never that an action is permitted.
import { sha256Hex } from '../memory/memory-store.js';
import { stableStringify } from '../tasks/model.js';
import { DEFAULT_SNAPSHOT_ATTEMPTS, contributingStores, runConsistentEvidenceRead } from './snapshot.js';

export const INTEGRITY_SCHEMA = 'apex.evidence-integrity.v1';
export const EVIDENCE_READ_SCHEMA = 'apex.evidence-read.v1';

// Ordered by severity, least to most. `valid` is always the floor.
export const INTEGRITY_STATES = Object.freeze([
  'valid',
  'valid_bounded',
  'missing',
  'stale',
  'conflicting',
  'broken_reference',
  'damaged_store',
  'truncated_history',
  'concurrent_modification',
  'unverifiable',
]);

// The states in which an answer may be used by a consumer that discloses its bounds.
export const INTEGRITY_USABLE_STATES = Object.freeze(['valid', 'valid_bounded']);

export const MAX_INTEGRITY_FINDINGS = 50;

const SEVERITY = new Map(INTEGRITY_STATES.map((state, index) => [state, index]));
const singleLine = (value, max = 200) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

export function isIntegrityState(state) {
  return SEVERITY.has(state);
}

// The worst state in a list, by the order above. No states is `valid`, never an absence of judgement.
export function worstIntegrityState(states = []) {
  let worst = 'valid';
  for (const state of states) {
    if (!isIntegrityState(state)) {
      throw new TypeError(`unknown integrity state ${JSON.stringify(singleLine(state, 60))}`);
    }
    if (SEVERITY.get(state) > SEVERITY.get(worst)) worst = state;
  }
  return worst;
}

export function integrityUsable(report) {
  return Boolean(report) && INTEGRITY_USABLE_STATES.includes(report.state);
}

// One finding. An unknown state is a programming error, not a finding: a diagnostic with an invented
// name would silently escape every consumer that switches on the vocabulary.
export function integrityFinding(state, { check, subject = null, detail = null, ...evidence } = {}) {
  if (!isIntegrityState(state)) {
    throw new TypeError(`unknown integrity state ${JSON.stringify(singleLine(state, 60))}`);
  }
  return {
    state,
    check: singleLine(check ?? 'unspecified', 60),
    subject: subject === null ? null : singleLine(subject, 120),
    detail: detail === null ? null : singleLine(detail, 300),
    ...evidence,
  };
}

// Duplicate identities inside one store. The first occurrence in append order is the record that was
// actually written; every later one is reported against it and never used to satisfy a reference.
export function duplicateFindings({ store = 'store', records = [], idOf = (record) => record?.id } = {}) {
  const seen = new Map();
  const findings = [];
  for (const record of records) {
    const id = idOf(record);
    if (typeof id !== 'string' || id.length === 0) continue;
    const first = seen.get(id);
    if (!first) {
      seen.set(id, { occurrences: 1, finding: null });
      continue;
    }
    first.occurrences += 1;
    if (!first.finding) {
      first.finding = integrityFinding('conflicting', {
        check: 'duplicate_identity',
        subject: id,
        store,
        occurrences: first.occurrences,
        detail: `${store} holds more than one record with id ${id}; the earliest append is the one read`,
      });
      findings.push(first.finding);
    } else {
      first.finding.occurrences = first.occurrences;
    }
  }
  return findings;
}

// The statuses a resolved reference may carry, mapped onto the vocabulary. A reference that merely fell
// outside a bounded read is not broken: the record is not known to be absent, only unread, and calling
// that broken would turn a limit into a negative fact about the world.
const REFERENCE_STATES = Object.freeze({
  resolved: null,
  out_of_window: 'valid_bounded',
  unread: 'valid_bounded',
  missing: 'broken_reference',
  stale: 'stale',
  conflicting: 'conflicting',
  damaged: 'damaged_store',
  superseded: null,
  retired: null,
});

export function referenceFindings({ references = [] } = {}) {
  const findings = [];
  for (const ref of references) {
    if (!Object.prototype.hasOwnProperty.call(REFERENCE_STATES, ref?.status)) {
      throw new TypeError(`unknown reference status ${JSON.stringify(singleLine(ref?.status, 60))}`);
    }
    const state = REFERENCE_STATES[ref.status];
    if (state === null) continue;
    findings.push(integrityFinding(state, {
      check: ref.check ?? 'reference',
      subject: ref.to ?? null,
      from: ref.from ?? null,
      kind: ref.kind ?? null,
      detail: ref.detail ?? null,
    }));
  }
  return findings;
}

// A digest that does not match what it claims to describe. The comparison is of assembled bytes, so a
// mismatch means the record moved or the reader assembled something else - never that the record is
// false.
export function digestFindings({ pairs = [] } = {}) {
  const findings = [];
  for (const pair of pairs) {
    if (typeof pair?.expected !== 'string' || typeof pair?.actual !== 'string') continue;
    if (pair.expected === pair.actual) continue;
    findings.push(integrityFinding(pair.state ?? 'conflicting', {
      check: pair.check ?? 'digest_mismatch',
      subject: pair.subject ?? null,
      expected: pair.expected,
      actual: pair.actual,
      detail: pair.detail ?? 'the digest recorded for this evidence does not match the evidence as it reads now',
    }));
  }
  return findings;
}

// A snapshot verdict is an integrity finding in its own right: a consistent window adds nothing, a
// changed identity is `concurrent_modification`, and a store that could not be inspected is
// `unverifiable`.
export function snapshotFindings(snapshot) {
  if (!snapshot || typeof snapshot.state !== 'string' || snapshot.state === 'unverified') return [];
  if (snapshot.state === 'consistent') return [];
  if (snapshot.state === 'concurrent_modification') {
    return [integrityFinding('concurrent_modification', {
      check: 'snapshot',
      subject: (snapshot.changed ?? []).map((entry) => entry.name).join(', ') || null,
      detail: 'a contributing store changed while this read was in progress; the combined result describes no single instant',
    })];
  }
  if (snapshot.state === 'unverifiable') {
    return [integrityFinding('unverifiable', {
      check: 'snapshot',
      subject: (snapshot.unverifiable ?? []).join(', ') || null,
      detail: 'a contributing store could not be inspected, so consistency cannot be claimed either way',
    })];
  }
  return [];
}

function findingOrder(a, b) {
  return SEVERITY.get(b.state) - SEVERITY.get(a.state)
    || String(a.check).localeCompare(String(b.check))
    || String(a.subject ?? '').localeCompare(String(b.subject ?? ''));
}

// The report a consumer receives. `findings` is bounded for disclosure, but `counts` and `bounded`
// describe the untrimmed set, so a reader can tell a clean answer from a clipped one. A bounded read is
// `valid_bounded`, not `truncated_history`: nothing was lost, the caller asked for a window. The digest
// covers the state, the untrimmed counts and the disclosed findings: two runs over the same records
// produce the same digest, and a run whose findings were clipped does not pretend to have seen fewer.
// The snapshot state, not its identity digest, is part of the canonical form, because the window's
// modification time says when the read happened rather than what it found.
export function integrityReport({
  subject = null,
  findings = [],
  snapshot = null,
  truncated = false,
  truncatedSources = [],
  counts = {},
  generatedAt = null,
  note = null,
} = {}) {
  const combined = [...findings, ...snapshotFindings(snapshot)];
  const state = worstIntegrityState([
    ...combined.map((finding) => finding.state),
    ...(truncated ? ['valid_bounded'] : []),
  ]);
  const ordered = [...combined].sort(findingOrder);
  const disclosed = ordered.slice(0, MAX_INTEGRITY_FINDINGS);
  const byState = Object.fromEntries(INTEGRITY_STATES.map((name) => [name, 0]));
  for (const finding of combined) byState[finding.state] += 1;
  const bounded = {
    findings: ordered.length,
    disclosed: disclosed.length,
    byState,
    truncated: ordered.length > disclosed.length,
  };
  const canonical = {
    schema: INTEGRITY_SCHEMA,
    subject,
    state,
    bounded,
    counts,
    truncated,
    truncatedSources: [...truncatedSources].sort(),
    snapshotState: snapshot?.state ?? 'unverified',
    findings: disclosed.map((finding) => ({
      state: finding.state, check: finding.check, subject: finding.subject ?? null,
    })),
  };
  return {
    schema: INTEGRITY_SCHEMA,
    subject,
    state,
    usable: INTEGRITY_USABLE_STATES.includes(state),
    findings: disclosed,
    bounded,
    counts,
    truncated,
    truncatedSources: canonical.truncatedSources,
    snapshot: snapshot?.digest ?? null,
    snapshotState: canonical.snapshotState,
    digest: sha256Hex(stableStringify(canonical)),
    generatedAt,
    authorizes: false,
    note: note ?? 'integrity is a statement about these records as they read in this read; it does not establish that they are true or that any action is authorized',
  };
}

// The store health checks do not all spell the same things the same way: each store reports the
// counts that make sense for it, and `corrupt` is the sample list rather than the count everywhere
// but the audit log. Normalising here means a damaged store cannot be reported as valid because its
// health summary used a different field name.
function corruptCountOf(health) {
  if (!health) return null;
  if (Number.isInteger(health.corruptLines)) return health.corruptLines;
  if (Array.isArray(health.corrupt)) return health.corrupt.length;
  return null;
}

function recordCountOf(health) {
  if (!health) return null;
  if (Number.isInteger(health.records)) return health.records;
  // The knowledge store reports claims and lifecycle events separately; both are records in its log.
  if (Number.isInteger(health.claims)) {
    return health.claims + (Number.isInteger(health.lifecycleEvents) ? health.lifecycleEvents : 0);
  }
  return Number.isInteger(health.count) ? health.count : null;
}

function healthUnusable(health) {
  return Boolean(health) && (health.available === false || health.state === 'unavailable' || health.inspected === false);
}

// One read-scoped integrity report over every evidence store this build has configured. The store
// identities are inspected before and after the health reads; if any file moved, the report is a
// statement about the read (`concurrent_modification`) rather than about the data, and it is refused
// rather than assembled from instants that never coexisted. A store without a `health()` method is
// reported by its identity only - absence of a check is not evidence of damage.
export async function evidenceIntegrityReport({
  stores = {},
  now = () => new Date(),
  attempts = DEFAULT_SNAPSHOT_ATTEMPTS,
} = {}) {
  const generatedAt = now().toISOString();
  const contributing = contributingStores(stores);
  if (contributing.length === 0) {
    const integrity = integrityReport({ subject: 'evidence', snapshot: null, generatedAt });
    return {
      schema: EVIDENCE_READ_SCHEMA,
      available: false,
      state: 'missing',
      usable: false,
      reason: 'no evidence store is configured in this build, so there is no read to certify',
      generatedAt,
      stores: [],
      counts: { stores: 0, records: 0 },
      snapshot: null,
      integrity,
      digest: integrity.digest,
      authorizes: false,
      note: EVIDENCE_READ_NOTE,
    };
  }

  const run = await runConsistentEvidenceRead({
    stores: contributing,
    attempts,
    read: async (snapshot) => {
      const rows = [];
      const findings = [];
      for (const { name, store } of contributing) {
        const check = typeof store.health === 'function'
          ? await snapshot.read(`health:${name}`, async () => {
            try {
              return { ok: true, value: await store.health() };
            } catch (err) {
              return { ok: false, detail: err?.message ?? String(err) };
            }
          })
          : null;
        const health = check?.ok ? check.value : null;
        const corrupt = corruptCountOf(health);
        const truncated = health?.truncated === true || health?.historyTruncated === true;
        const unreadable = check ? check.ok !== true || healthUnusable(health) : false;
        if (unreadable) {
          findings.push(integrityFinding('unverifiable', {
            check: 'store_health',
            subject: name,
            detail: check?.detail ?? health?.detail ?? health?.reason ?? 'the store health check could not be completed',
          }));
        } else if (corrupt !== null && corrupt > 0) {
          findings.push(integrityFinding('damaged_store', {
            check: 'store_health',
            subject: name,
            detail: `${corrupt} unreadable record line(s) in ${name}`,
          }));
        }
        if (truncated) {
          findings.push(integrityFinding('truncated_history', {
            check: 'store_health',
            subject: name,
            detail: `the ${name} health check reports a bounded history`,
          }));
        }
        rows.push({
          name,
          checked: check ? 'health' : 'identity',
          state: health?.state ?? null,
          records: recordCountOf(health),
          corrupt,
          readable: check ? check.ok === true && !healthUnusable(health) : null,
        });
      }
      return { rows, findings };
    },
  });

  const verdict = run.snapshot;
  const consistency = {};
  for (const row of verdict.stores ?? []) consistency[row.name] = row.state;
  const rows = run.value.rows.map((row) => ({
    ...row,
    present: verdict.stores?.find((item) => item.name === row.name)?.exists === true,
    consistency: consistency[row.name] ?? 'unverified',
  }));
  const records = rows.reduce((sum, row) => sum + (row.records ?? 0), 0);
  const integrity = integrityReport({
    subject: 'evidence',
    findings: run.value.findings,
    snapshot: verdict,
    counts: { stores: rows.length, records },
    generatedAt,
  });
  const consistent = verdict.state === 'consistent';
  // A consistent window around a store whose health check could not be completed is not a certified
  // report: the window proves nothing moved, but it cannot say what is in the files it could not read.
  // Damage is different - it is a finding about records that were read, so the report remains available.
  const certifiable = consistent && integrity.state !== 'unverifiable';
  return {
    schema: EVIDENCE_READ_SCHEMA,
    available: certifiable,
    state: consistent ? integrity.state : verdict.state,
    usable: certifiable && integrity.usable,
    reason: certifiable
      ? null
      : verdict.state === 'unverifiable'
        ? 'a contributing store could not be inspected while this read was in progress, so consistency cannot be claimed either way'
        : consistent
          ? 'a store health check could not be completed, so the evidence report cannot be certified'
          : `a contributing store changed while this read was in progress${run.attempts > 1 ? ` (retried ${run.attempts - 1} time(s))` : ''}; the combined report describes no single instant`,
    generatedAt,
    attempts: run.attempts,
    stores: rows,
    counts: { stores: rows.length, records },
    snapshot: {
      schema: verdict.schema,
      state: verdict.state,
      consistent: verdict.consistent === true,
      complete: verdict.complete === true,
      stores: verdict.stores ?? [],
      reads: verdict.reads ?? 0,
      digest: verdict.digest ?? null,
      beginDigest: verdict.beginDigest ?? null,
      bounded: verdict.bounded === true,
    },
    integrity,
    digest: integrity.digest,
    authorizes: false,
    note: EVIDENCE_READ_NOTE,
  };
}

const EVIDENCE_READ_NOTE = 'this read certifies that no visible append moved a contributing file while it ran; it is not a transaction, holds no lock, and a matching digest proves the bytes did not change, never that the records are true';

export function renderEvidenceIntegrity(report, { indent = '' } = {}) {
  if (!report) return `${indent}No evidence-integrity report was produced.`;
  const lines = [
    `${indent}Evidence integrity: ${report.state}${report.available ? '' : ` - ${report.reason}`} (${report.counts.stores} store(s), ${report.counts.records} record(s))`,
  ];
  for (const row of report.stores) {
    lines.push(`${indent}  ${row.name}: ${row.present ? 'present' : 'absent'} | ${row.checked} | ${row.consistency}${row.corrupt ? ` | ${row.corrupt} corrupt line(s)` : ''}`);
  }
  if (report.integrity?.findings?.length > 0) {
    for (const finding of report.integrity.findings) {
      lines.push(`${indent}  ${finding.state} (${finding.check}${finding.subject ? `: ${finding.subject}` : ''}): ${finding.detail}`);
    }
  }
  lines.push(`${indent}  ${report.note}`);
  return lines.join('\n');
}
