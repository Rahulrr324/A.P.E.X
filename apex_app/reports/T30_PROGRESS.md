# T-30 Progress Report

**Report checkpoint:** Packages 0–1 complete, 2026-11-19 (UTC)

**Scope:** T-30 Packages 0–3 only before Packages 4–6; no later package is marked complete by this report.

## Repository checkpoint

- Starting commit: `fb09e73f2d875fe8697d731c9b9845dd054a0465`.
- Package 0 code commit: `45ae99a87645be444070741d6cdea1e31c45f352` (`T-30 P0: repair syntax, inventory, and storage integrity`).
- HEAD at the Package 0 code checkpoint: `45ae99a87645be444070741d6cdea1e31c45f352`.
- Active branch: `arena/c4691a2f-a-p-e-x`; `origin/main` was fetched and remained at the starting commit. No branch switch, push, PR, tag, or history rewrite was performed.
- `stark/` and the unrelated OnCall Memory project were not modified.
- Package 0 tests ran against the working tree that was committed unchanged as `45ae99a`.

## Package status

| Package | Status | Notes |
|---|---|---|
| 0 — Syntax, inventory, data-directory failures, storage, CI | **Complete and verified** | Full suite passes; see exact results below. |
| 1 — Ledgers, architecture, requirements, numbering, state precedence/ownership | **Complete and verified** | Added dated ledger/requirements/architecture annotations and the ten-state source/precedence contract. Focused UI/core-state tests pass (26/26), syntax (1/1), full suite (3,733 total, 3,731 passed, 0 failed, 2 skipped); P1 code commit is being recorded separately. |
| 2 — Authoritative state events and cross-process observation | Not started | Depends on Package 1's owner/precedence contract. |
| 3 — T-18 UI defects and lockdown integration | Not started | Depends on Packages 1–2 and must remain fail-closed. |
| 4–6 | Not started; intentionally deferred | Do not begin until Packages 0–3 are complete. |

## Package 0 work completed

- Repaired the nested template literals in `src/ui/assets.js` and literal `\n` escape sequences in `src/app.js`.
- Added `tests/source-syntax.test.js` and `npm run test:syntax`. It runs `node --check` on every JavaScript source file (**221 files**) and parses the extracted `UI_CLIENT` independently.
- Aligned the live capability inventory, README and capture classification: current counts are 139 default actions, 154 with a configured workspace root, 84 read actions and 70 write actions. Prior counts are identified as historical. Workshop reads are included in the read-only store snapshot, `workshop.compose` is covered by the model-origin write-denial sweep, and inventory tests exercise seeded Workshop data.
- Corrected fail-closed expectations for unusable data directories, exposed session diagnostics detail, and validated Workshop candidates before append.
- Fixed the reproduced concurrent JSONL append defects. Appends now use the cross-process writer-lock protocol unless the authoritative store lock already owns the same path; that ownership is propagated through `AsyncLocalStorage`, including `TaskStore`'s manual lock. Readers wait briefly and re-read an unterminated tail only while a writer lock is present. Fault-injection tests now target the data file rather than the lock's staging file.
- Changed Linux resident-memory sampling to read the live process's `/proc/<pid>/status` entry instead of spawning `ps` for every sample. The pilot failure assertion now includes the report output when a scenario exits nonzero.
- Updated CI to trigger on every push to `main`, install development dependencies with `npm ci --ignore-scripts`, run the source/UI syntax guard and the full suite, and allow 35 minutes for the observed suite runtime.

## Files changed in Package 0

- `.github/workflows/apex-app-tests.yml`
- `apex_app/README.md`
- `apex_app/package.json`
- `apex_app/pilot/harness.js`
- `apex_app/src/app.js`
- `apex_app/src/diagnostics.js`
- `apex_app/src/memory/jsonl-store.js`
- `apex_app/src/memory/writer-lock.js`
- `apex_app/src/tasks/store.js`
- `apex_app/src/ui/assets.js`
- `apex_app/src/workshop/store.js`
- `apex_app/tests/capability-inventory.test.js`
- `apex_app/tests/cli-workflow.test.js`
- `apex_app/tests/controller.test.js`
- `apex_app/tests/failure-semantics.test.js`
- `apex_app/tests/model-self-authorization.test.js`
- `apex_app/tests/source-syntax.test.js` (new)
- `apex_app/tests/storage-concurrency.test.js`
- `apex_app/tests/t16-pilot-reporting.test.js`

## Package 1 completed — dated reconciliation and Core-state contract

- Preserved and annotated the earlier T-19 Core table instead of deleting it. Added a current ten-state source/owner/precedence table and a state-ownership register in `apex_app/ARCHITECTURE_V2.md`. The fixed order is **Lockdown > Degraded > Awaiting Approval > Uncertain > Executing > Thinking > Idle**. Dormant, Listening and Speaking have no live source and are reserved/not reachable; persisted task uncertainty is a real source, so it is reachable. The UI setter fails safely to Degraded for reserved or unknown values.
- Added `src/ui/core-state.js` with state definitions, reachability, precedence, `resolveCoreState()` and explicit source/owner descriptions. The pure resolver is contract code for Package 3; the current UI does **not yet consume every source or apply the full precedence**. Package 3 remains responsible for that integration.
- Corrected the basic UI state key to `awaiting_approval`; the served client embeds the same state definitions and refuses reserved/unknown Core state assignments. This does not grant UI authority or alter ECP policy.
- Annotated stale T-16/T-17 claims in `docs/APEX_V2_REQUIREMENTS.md` about no ECP, no L0–L5 configuration, no kill switch, no Resource Fabric owner, and no briefing/Council/Workshop foundation. Each addendum distinguishes the local foundation from the complete v2 target and preserves the original statement as historical.
- Added dated reconciliation notes to `ARCHITECTURE.md`, `APEX_MISSION_PROGRESS.md`, `T19_PROGRESS.md` and `T24_IMPLEMENTATION_REPORT.md`. The earlier failed-fetch statement is retained as an observation from the older Windows checkout; `git fetch origin` succeeded in this Arena checkout.
- Numbering resolution: no milestone IDs were invented. T-19 is the separate `T19_PROGRESS.md` checkpoint; T-20–T-24 are summarized in `T24_IMPLEMENTATION_REPORT.md`; T-25, T-26/T-27 and T-28 appear in the later progress ledger/Master Project Document; T-29 remains **not accepted as a unified integration milestone**. This clone is shallow and does not contain the historical commit objects, so those earlier claims were not independently replayed or backdated as verified.

### Files changed in Package 1

- `APEX_MISSION_PROGRESS.md`
- `T19_PROGRESS.md`
- `T24_IMPLEMENTATION_REPORT.md`
- `apex_app/ARCHITECTURE.md`
- `apex_app/ARCHITECTURE_V2.md`
- `apex_app/docs/APEX_V2_REQUIREMENTS.md`
- `apex_app/src/ui/assets.js`
- `apex_app/src/ui/core-state.js` (new)
- `apex_app/tests/core-state-contract.test.js` (new)
- `apex_app/reports/T30_PROGRESS.md`

### T-19–T-29 evidence crosswalk

| Milestone | What the retained records say | T-30 treatment |
|---|---|---|
| T-19 | Separate checkpoint; it reports UI/Core/event work and refers to `e9d0880` and `301ba97`. | Kept as history; commit objects are absent from this shallow clone. T-30 does not claim those behaviors were independently verified. Package 2 still audits the current event implementation. |
| T-20–T-24 | `T24_IMPLEMENTATION_REPORT.md` summarizes Command Experience, planner/TaskGraph, briefing, evolution foundation and documentation. | Summary retained; its starting commit `5098705` is unavailable locally and historical tests are not retroactively rerun. |
| T-25 | Council and served UI foundation; historical report records 8 Council tests and 7 Playwright tests. | Current Node tests are in the passing full suite. Browser run here is blocked by missing Chromium; historical screenshots are not newly reviewed. |
| T-26/T-27 | Workshop design-composition/store/actions/UI foundation. | Current Node suite passes; P0 repaired the nested UI template syntax. The product remains a deterministic design/simulation tool, not 3D CAD or code execution. |
| T-28 | Local device-trust registry foundation. | Its tests are included in the passing full suite; transport, Presence Mesh, owner MFA and UI/ECP device operations remain unimplemented or unverified. |
| T-29 | Ledger says “not started”; current repository also contains separate cognitive/executive modules. | Still not accepted as a unified integration milestone; module presence and a green suite are not proof of the complete pipeline. |

## Verification evidence

| Command | Result |
|---|---|
| `npm run test:syntax` (P0 checkpoint) | **1 passed, 0 failed, 0 skipped**; checked 221 source files and separately parsed the served client. |
| `npm run test:syntax` (P1 checkpoint) | **1 passed, 0 failed, 0 skipped**; checked 222 source files and separately parsed the served client. |
| `node --test tests/cross-process-stress.test.js tests/storage-concurrency.test.js tests/t16-pilot-reporting.test.js` | **21 tests: 21 passed, 0 failed, 0 skipped**. |
| `node --test tests/core-state-contract.test.js tests/ui-server.test.js` | **26 tests: 26 passed, 0 failed, 0 skipped**; covers all ten state rows, precedence, reserved-state rejection and UI-server integration. |
| `npm test` (P0 checkpoint) | **3,729 tests: 3,727 passed, 0 failed, 0 cancelled, 2 skipped; 570 suites**. Runtime 1,245,229 ms (about 20m45s). Log: `/tmp/apex-p0-full-verified.log`. |
| `npm test` (P1 checkpoint) | **3,733 tests: 3,731 passed, 0 failed, 0 cancelled, 2 skipped; 571 suites**. Runtime 1,231,611 ms (about 20m32s). Log: `/tmp/apex-p1-full.log`. |
| `git diff --check` | Passed. |
| `npm run test:e2e` | Could not launch because the installed `node_modules/.bin/playwright` shim is not executable in this workspace (`Permission denied`). |
| `node node_modules/@playwright/test/cli.js test` | **7 tests discovered: 1 passed, 6 could not launch Chromium** because Playwright's `chrome-headless-shell` binary is absent. No system Chromium/Chrome/Firefox was present. This is an environment/browser-availability blocker, not six observed product assertion failures. Browser verification and screenshots remain **unverified**. |

The full Node suite and syntax tests are verified. Playwright was attempted through the package CLI; browser-based validation could not execute without a browser binary. No browser download was attempted. No `npm ci` was run locally; the existing development installation was used.

## Risks and blockers

- Browser behavior and screenshots are not verified in this environment because there is no installed browser executable. Keep this explicitly marked unverified unless browser execution becomes available.
- P0 resolves the observed concurrent-write and pilot-reporting failures; it does not establish broader cross-platform filesystem guarantees beyond the passing tests on this Linux/Node 22 environment.
- No inference, model download, model endpoint, voice/audio path, or remote inference process was used or added.

## Current blockers and limits

- Browser behavior and screenshots remain **unverified**: Playwright could not launch a browser because this environment has no installed Chromium/Chrome/Firefox binary. The P1 `UI_CLIENT` source parses and UI-server tests pass, but that is not browser verification.
- The full Core precedence resolver is tested as a pure contract, but the current UI does not yet derive every state from its owner or enforce the full source precedence. That is Package 3 work, not a Package 1 completion claim.
- T-19 historical commits are unavailable in the shallow local history; current T-19 event behavior remains to be inspected and tested in Package 2.

## Next action

Start Package 2: inspect what T-19 actually implemented in `src/ui/server.js` and the browser client; complete/verify bounded versioned owner events for task, plan, approval, lockdown, runtime and health; observe cross-process file/version changes server-side; preserve progress/chat events; test sequence gaps, duplicates, order/version errors, bounded subscribers/queues, reconnect reconciliation and a CLI-process change. Meet the 500 ms heartbeat, 1.5 s watchdog and Degraded-within-2 s acceptance with isolated tests. Do not begin Package 3 or Packages 4–6 until Package 2 is tested and committed.
