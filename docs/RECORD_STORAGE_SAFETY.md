# Experimental record storage safety

This is the Phase-1 experimental `RecordStore`, **not personal conversational or
long-term memory**. Its schema and acceptance evaluators are unchanged.

## Corrected defects

- `append()` previously removed `<record_id>.json` before rename, replacing an
  existing record despite the append-only API. It now rejects unsafe path-like
  IDs, reserves a staging directory atomically, writes/closes the payload, and
  publishes with a no-replace hard link. Duplicate IDs cannot replace evidence.
- Staging reservations are unique across writers. Thread/process tests require
  exactly one successful writer for the same ID and complete parseable output.
- `profiler_cli` used the timestamp's **length**, always 24, as its record suffix.
  Two restarts reused IDs. It now uses actual high-resolution time, process ID and
  a per-process counter. Collisions still fail closed at the store.
- The strict JSON codec previously accepted malformed numbers and raw controls,
  misdecoded surrogate pairs and reported every error at offset zero. Grammar,
  Unicode and numeric boundary tests now enforce the existing strict-codec intent.
  Duplicate keys are rejected rather than interpreted ambiguously.

## Limits

- Atomic visibility/no replacement requires hard-link support. Unsupported
  filesystems fail explicitly; there is no unsafe rename/overwrite fallback.
- No file or directory fsync is performed, so **power-loss durability is not
  claimed**. Successful close/publication is not an independent backup.
- A process crash can leave a `.append-*` staging directory. It is not a record
  and `loadAll()` ignores it. Do not automatically delete unknown staging data.
- Storage directories are trusted, operator-selected local directories, not a
  malicious multi-user namespace. TOCTOU protection against hostile owners of
  the directory is not claimed.
- `loadAll()` still returns error entries for malformed files, but its legacy
  missing/unreadable-directory behaviour is empty results. The inspector checks
  directory existence first. Do not reuse this as a personal-memory recovery
  service without a separately reviewed IO/recovery contract.
- The inspector's budgets preflight an operator-controlled directory. Concurrent
  hostile directory mutation can invalidate that preflight; it is not a sandbox.
- Historical files, manifests, record schemas and acceptance outcomes were not
  rewritten or recertified by these changes.
