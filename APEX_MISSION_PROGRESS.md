# APEX Mission Progress (T-25 through T-29)

## Repository state verified from GitHub

- Canonical branch: `main`.
- Latest reviewed baseline: `7bb79848177c7cc0ed905d34bf4fea3cdf31470d` (commit message `a`).
- T-25 Council and repository-repair work is present on GitHub; the prior push blocker is no longer current.
- The latest baseline adds a Workshop service, append-only store, action definitions, controller integration and view markup.
- Review found the Workshop UI was incomplete: it referenced API endpoints that did not exist, and the compose form had no submit handler.
- Follow-up commits add the missing GET/list, POST/compose and POST/simulate API routes through the existing controller/ECP, plus the UI form handler and finite non-negative budget validation.
- Workshop persistence now refuses appends when the JSONL parser reports corrupt lines or the digest chain is broken. Reads fail closed on corrupt records or a broken chain. Status explicitly reports corruption as a damaged chain.
- Stored identity digests are recomputed from the canonical composition during record validation, so content altered without a matching identity digest is rejected.
- Added `tests/workshop-store-integrity.test.js` covering append/read, restart recovery, tampering, malformed JSON, identity-digest mismatch, idempotent duplicate composition and conflicting duplicate protection. Added `tests/workshop-actions.test.js` covering user-only composition authorization, model-origin read permissions, validation, independent verification and read-only simulation. Extended `tests/ui-server.test.js` with real HTTP integration coverage for authenticated compose/list/simulate, ECP-backed controller writes, read-only simulation, malformed/unknown inputs, missing artifacts, CSRF and JSON content-type boundaries.
- Commits: `fa4aaed` integrity enforcement; `f653714` integrity tests; `73fcc36` budget validation; `acc1327` action authorization/verification tests; `1e05586` idempotency and duplicate-protection tests.
- These edits were made through GitHub's file API. No local Node process, browser or full test runner was available here; the new tests and UI changes are not claimed as executed or tested.
- Inference remains prohibited. No model runtime, local inference server, remote endpoint or model download is used. Voice remains out of scope.

## T-25 — Council and release foundation

**Status: substantially implemented; reported local validation exists, independent rerun not performed here.**

The repository contains Council service/store/actions, controller/ECP path, API and UI, capability inventory updates and a Playwright suite. The T-25 report records 8 Council tests, targeted regression suites and 7 Playwright tests passing on the contributor's Windows environment. The full `npm test` suite was not run in that report.

## T-26/T-27 — Workshop foundation

**Status: backend and basic compose/list/simulate UI path implemented; validation outstanding.**

The Workshop provides:
- Validated, bounded design compositions.
- Content-addressed artifact identity.
- Append-only JSONL persistence and digest-chain reporting.
- Deterministic inspection and arithmetic simulation.
- User-only `workshop.compose` and read-only `workshop.list/get/inspect/simulate` actions.
- Controller methods that route writes through ECP.
- A Workshop view with composition and simulation controls.
- Newly added server routes and submit handler to connect the view to the controller.

The Workshop remains a deterministic design-sheet tool, not a code runner, CAD engine, circuit solver or capability publisher. It does not authorize execution.

## T-28 — Device trust and Presence Mesh

**Status: local device-trust foundation implemented; ECP action integration and runtime validation remain outstanding.**

Implemented on canonical `main`:
- `security/device-trust.js` provides explicit user-origin enrollment and revocation, a one-time random device secret, and a persisted SHA-256 credential hash (the raw secret is not written to disk).
- Signed HMAC-SHA256 envelopes bind device id, monotonic sequence, timestamp and payload. Authentication rejects unknown/revoked devices, invalid credentials/signatures, stale timestamps, replay and out-of-order messages.
- Enrollment, revocation and accepted message sequence events are persisted in an append-only local JSONL log with a SHA-256 hash chain. Startup rebuilds device and replay state from the log and fails closed on malformed or tampered records.
- The service is constructed by the application composition root and its bounded status is included in app status.
- The service explicitly reports that transport and remote presence are not implemented and that device authentication grants no capability authorization. ECP remains the sole authorization authority.
- Added `tests/device-trust.test.js` for user-only enrollment, secret-at-rest handling, restart recovery, signature tampering, replay protection, unknown/revoked devices, stale timestamps and hash-chain tampering.

Commits: `754b891` device-trust module; `c98a108` initial tests; `d574140`, `9c4749e`, `f84f7d9`, `458afcd` security corrections; `a0c9256` restart replay test; `7cf597d` list result fix; `5fe4d32` app composition integration.

**Important limitations:** These tests have been added but not executed in this session. The registry currently has no cross-process writer lock; it is not yet safe to treat as a multi-process or remote-device production service. Device operations are not yet exposed through user-authorized ECP actions/API/UI. No cryptographic claim beyond the implemented local HMAC/hash-chain mechanism is made. No transport, synchronization, presence mesh, owner MFA or hardware-backed key storage is implemented.

## T-29 — Unified cognitive integration

Not started. Existing subsystems remain separately implemented; a complete unified executive pipeline and sustained validation are not claimed.

## Required next verification

1. Run `npm test` from `apex_app/` and record exact totals; specifically run `node --test tests/workshop-store-integrity.test.js tests/workshop-actions.test.js tests/device-trust.test.js`.
2. Execute `node --test tests/workshop-store-integrity.test.js tests/workshop-actions.test.js tests/ui-server.test.js` and fix any failures. The HTTP integration tests are committed but have not been run in this environment.
3. Run the full `npm test` suite, then Playwright against isolated temporary data and exercise Workshop compose/list/simulate on desktop and mobile.
4. Verify malformed JSON, oversized input, missing artifacts, corrupt stores and unavailable storage fail safely.
5. Add a cross-process-safe append/locking strategy for the device registry, then expose enrollment, revocation and read-only status through existing ECP actions and the authenticated local UI. Keep raw enrollment secrets out of audit output and show them only once.\n6. Continue T-26/T-27 integration only after tests pass; then complete T-28 and T-29.

## Global constraints

- One shared canonical `main` branch.
- No destructive Git operations, force pushes, credential changes or unverified push claims.
- All tests use isolated temporary APEX data directories and self-seeded fixtures.
- `apex_app` must retain zero runtime dependencies; Playwright remains development-only.
- ECP remains the sole authorization authority; the kill switch remains outside the model path.
- Deterministic code and synthetic fixtures only. No inference, voice or fake AI capabilities.
- Distinguish code review from executed tests and browser verification.

## T-30 dated checkout and evidence annotation (2026-11-19)

The repository-state block above is a historical report for its earlier checkout. In this Arena session the starting commit and fetched `origin/main` were both `fb09e73f2d875fe8697d731c9b9845dd054a0465`, on active branch `arena/c4691a2f-a-p-e-x`; this environment successfully fetched `origin`. The T-19/T-24 commit references are not available as Git objects in this shallow clone and are not independently re-certified here. See `apex_app/docs/APEX_V2_REQUIREMENTS.md` and `apex_app/reports/T30_PROGRESS.md` for the dated T-19–T-29 crosswalk and Package 0 evidence.

Package 0 is verified on the committed T-30 code checkpoint `45ae99a87645be444070741d6cdea1e31c45f352`: `npm test` reported 3,729 tests, 3,727 passed, 0 failed, 0 cancelled and 2 skipped; the source/UI syntax guard checked every source file; targeted concurrent-storage/cross-process/pilot tests passed 21/21. This supersedes the earlier “not executed here” statements for the tests included in that run, without changing the historical claim that they had not been executed when the earlier report was written. The current Package 0 test details, Playwright browser-availability blocker and changed-file list are in the T-30 progress report.

T-29 remains **not accepted as a unified integration milestone**. Cognitive, executive and evidence modules exist in the current code, but the mission-level integrated pipeline and its own acceptance evidence are not established by their existence or by the full test suite. T-28 device-trust code is present and its tests were included in the full suite; transport, Presence Mesh, owner MFA and ECP-authorized device operations remain absent or unverified.

Package 1 is complete on the current T-30 working tree: dated annotations reconcile the requirements/architecture with the local code; the ten-state source/owner/precedence contract, reserved-state guard and precedence tests pass. `node --test tests/core-state-contract.test.js tests/ui-server.test.js` passed 26/26; the full suite reported 3,733 tests: 3,731 passed, 0 failed, 0 cancelled and 2 skipped. See `apex_app/reports/T30_PROGRESS.md` for exact commands, counts, crosswalk and browser limitations. Packages 2–3 and 4–6 are not yet complete; do not infer their completion from this annotation.
