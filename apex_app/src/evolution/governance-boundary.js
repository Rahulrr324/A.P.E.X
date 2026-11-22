// T-41 Step 3 (2026-11-22): the immutable governance boundary, as one canonical policy.
//
// APEX may propose changes to itself. It may not propose changes to the parts of itself that decide
// *what a change is allowed to be*. Those parts are named here, in one place, so the boundary is a
// definition the system reads rather than a paragraph a reader has to trust:
//
//   - `src/executive/` holds the ECP, which is the only authorization authority. A proposal that edits
//     it could authorize itself.
//   - `src/security/` holds the latch, the step-up checks and the secrets handling. A proposal that
//     edits it could release a lockdown.
//   - `src/governance/` holds the policy the ECP reads.
//   - the safety latch store and the autonomy matrix are the two things that decide how autonomous
//     APEX is; editing them is the same act as editing the governor.
//   - the audit ledgers are append-only evidence. A change that can rewrite its own audit trail has no
//     audit trail.
//   - `src/workshop/applier.js` is the write path. A proposal that edits the applier can apply anything
//     without passing a check, so it sits inside the boundary even though it is not governance code.
//
// Two rules make this policy usable rather than decorative:
//
//   1. **Canonical matching.** A path is matched after normalisation and case folding, so `SRC/Executive/`,
//      `./src/executive/../executive/control-plane.js` and `src/executive/control-plane.js` are one
//      refusal. A boundary that a `..` can step around is not a boundary.
//   2. **Refusal is total.** There is no override, no `force` flag and no "owner may proceed anyway"
//      path. The refusal is the feature; an escape hatch would make the rest of this file a claim
//      rather than an enforcement.
export const GOVERNANCE_BOUNDARY_SCHEMA = 'apex.evolution.governance-boundary/1';

// The boundary refusal code. It is spelled once so the action, the route, the ECP audit record, the
// Evolution Lab status and the browser cannot drift apart.
export const IMMUTABLE_BOUNDARY_CODE = 'IMMUTABLE_GOVERNANCE_BOUNDARY';

// Each entry: a canonical prefix or file, why it is inside the boundary, and the kind of thing it is.
// `prefix: true` means "this directory and everything under it". `prefix: false` means the exact file.
const BOUNDARIES = Object.freeze([
  Object.freeze({
    path: 'src/executive/', prefix: true, category: 'authorization',
    why: 'the ECP is the only authorization authority; a proposal that edits it could authorize itself',
  }),
  Object.freeze({
    path: 'src/security/', prefix: true, category: 'safety',
    why: 'the safety latch, step-up checks and secrets handling live here; editing them could release a lockdown',
  }),
  Object.freeze({
    path: 'src/governance/', prefix: true, category: 'policy',
    why: 'the policy the ECP reads to decide what an action may do',
  }),
  Object.freeze({
    path: 'src/autonomy/', prefix: true, category: 'autonomy',
    why: 'the autonomy matrix decides how much APEX may do without asking',
  }),
  Object.freeze({
    path: 'src/workshop/applier.js', prefix: false, category: 'write_path',
    why: 'the applier is the only path from a candidate to the workspace; editing it would bypass verification',
  }),
  // Safety latch files and audit ledgers are named by the names the running system uses, so a rename
  // would be caught as an ordinary refused path rather than slipping through as an unknown file.
  Object.freeze({
    path: 'data/safety-latch.json', prefix: false, category: 'safety_latch',
    why: 'the persisted kill-switch latch: editing it directly is the act the latch exists to prevent',
  }),
  Object.freeze({
    path: 'data/autonomy-matrix.json', prefix: false, category: 'autonomy',
    why: 'the persisted autonomy matrix',
  }),
]);

// Audit ledgers are matched by name anywhere in the tree, because the ledger directory is configurable
// and a ledger that moved is still a ledger.
const LEDGER_PATTERNS = Object.freeze([
  Object.freeze({ test: /(^|\/)(audit|audit-log|operations|ecp-audit|memory-timeline)(\.jsonl|-.*\.jsonl)$/i, category: 'audit_ledger', why: 'the ECP audit trail is append-only evidence; a change that can rewrite it removes it' }),
  Object.freeze({ test: /(^|\/)ledgers?\//i, category: 'audit_ledger', why: 'ledger directories hold append-only evidence' }),
]);

// Canonical form: forward slashes, no leading `./`, no empty or `.` segments, `..` resolved lexically,
// lower-cased. Lexical resolution is safe here because the path is a *proposal* and does not have to
// exist. A path that tries to leave the root keeps a leading `..` segment and is refused by matching.
export function canonicalRelativePath(raw) {
  if (typeof raw !== 'string') return null;
  const slashed = raw.trim().replace(/\\/g, '/');
  const segments = [];
  for (const segment of slashed.split('/')) {
    if (segment.length === 0 || segment === '.') continue;
    if (segment === '..') {
      if (segments.length > 0 && segments[segments.length - 1] !== '..') segments.pop();
      else segments.push('..');
      continue;
    }
    segments.push(segment);
  }
  return segments.join('/').toLowerCase();
}

// Is this proposal path inside the immutable boundary? Returns a refusal object or null.
//
// The return value is deliberately verbose: the UI has to be able to say *which* boundary was hit and
// why it exists, and a refusal that says only "forbidden" teaches the owner nothing.
export function classifyGovernancePath(relativePath) {
  const canonical = canonicalRelativePath(relativePath);
  if (canonical === null) {
    return {
      refused: true, code: IMMUTABLE_BOUNDARY_CODE, path: null, category: 'invalid',
      boundary: null, why: 'the proposed path is not text, so it cannot be shown to be outside the boundary',
    };
  }
  for (const boundary of BOUNDARIES) {
    const hit = boundary.prefix
      ? canonical === boundary.path.slice(0, -1) || canonical.startsWith(boundary.path)
      : canonical === boundary.path;
    if (hit) {
      return {
        refused: true, code: IMMUTABLE_BOUNDARY_CODE, path: canonical,
        category: boundary.category, boundary: boundary.path, why: boundary.why,
      };
    }
  }
  for (const ledger of LEDGER_PATTERNS) {
    if (ledger.test.test(canonical)) {
      return {
        refused: true, code: IMMUTABLE_BOUNDARY_CODE, path: canonical,
        category: ledger.category, boundary: 'audit ledgers', why: ledger.why,
      };
    }
  }
  return null;
}

// The policy itself, for the UI and for the boundary report. This is the list the product shows; it is
// generated from the same constants the refusal uses, so a screen cannot describe a boundary that is
// stricter or looser than the one enforced.
export function governanceBoundaryPolicy() {
  const entries = BOUNDARIES.map((boundary) => ({
    path: boundary.path,
    kind: boundary.prefix ? 'directory' : 'file',
    category: boundary.category,
    why: boundary.why,
  }));
  for (const ledger of LEDGER_PATTERNS) {
    entries.push({
      path: String(ledger.test).replace(/^\/|\/[a-z]*$/g, ''),
      kind: 'pattern',
      category: ledger.category,
      why: ledger.why,
    });
  }
  return Object.freeze({
    schema: GOVERNANCE_BOUNDARY_SCHEMA,
    code: IMMUTABLE_BOUNDARY_CODE,
    // A count the UI and the tests can both assert against without hard-coding a number that will
    // change the next time a directory is added to the boundary.
    entries: Object.freeze(entries),
    total: entries.length,
    overridable: false,
    note: 'There is no override. A proposal that targets any of these paths is refused before it reaches the sandbox.',
  });
}
