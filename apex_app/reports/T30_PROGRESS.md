# T-30 Progress Report

**Report checkpoint:** Packages 0–6 complete to their bounded scope, 2026-11-19 (UTC).
Browser/visual evidence is unavailable in this environment and is marked UNVERIFIED throughout.

> **Step-series checkpoint (2026-11-19, later the same day).** Four further steps were requested and
> completed on this branch: **S1** `/api/state` latency, **S2** the T-29 unified cognitive pipeline,
> **S3** the zero-dependency thin desktop shell, and **S4** full verification. They are recorded in
> the "Step series S1–S4" section at the end of this report; the Package 0–6 sections above are kept
> as written and are not restated. **S1 was corrected after its first commit:** the fast path it
> shipped keyed on filesystem metadata that this machine's filesystem does not change on a
> same-length rewrite, so it could serve stale records. The full suite caught it, the mechanism was
> replaced with digest-verified retention, and the correction is written up in the S1 subsection.

**Scope:** T-30 Packages 0–6.

> **Superseded statement (2026-11-19, same day).** The previous checkpoint read "Packages 0–4
> only. Packages 5–6 were intentionally not started." The owner then requested the P0 client
> fix, real-browser re-verification, Package 5 and Package 6 on the same branch. That earlier
> scope line is kept here as history and is no longer the current scope.

## Repository checkpoint

- Starting commit: `fb09e73f2d875fe8697d731c9b9845dd054a0465`.
- Package 0 code commit: `45ae99a87645be444070741d6cdea1e31c45f352` (`T-30 P0: repair syntax, inventory, and storage integrity`).
- Package 1 code commit: `875e3bc46703179ab50bcd22aa71c96939574f03` (`T-30 P1: define Core state ownership and precedence`).
- Package 2 code commit: `ba08127` (`T-30 P2: version owner events and reconcile streams`).
- Package 3 code commit: `fa9f8f9` (`T-30 P3: integrate live Core state and safety controls`); full verification is recorded below.
- Package 4 code commits: `d3b0936` (`T-30 P4: implement owner-backed workspaces with truthful states`), `3c753c2` (`T-30 P4: finish workspace empty-state and document-count truthfulness`) and `1ce7bf4` (`T-30 P4: show Resource Fabric diagnostics in the system workspace`); the P4 full suite ran on `1ce7bf4` and this report is committed afterwards as `d8b1880` plus this correction. Verification is recorded below.
- HEAD at the Package 0 code checkpoint: `45ae99a87645be444070741d6cdea1e31c45f352`; later checkpoints are recorded below.
- Active branch: `arena/c4691a2f-a-p-e-x`; `origin/main` was fetched and remained at the starting commit. At the Package 0 checkpoint no branch switch, push, PR, tag or history rewrite had been performed; the later checkpoints pushed this branch and opened PR #5 (`T-30: complete Packages 0–4 for APEX`, base `main`).
- `stark/` and the unrelated OnCall Memory project were not modified.
- Package 0 tests ran against the working tree that was committed unchanged as `45ae99a`.

## Package status

| Package | Status | Notes |
|---|---|---|
| 0 — Syntax, inventory, data-directory failures, storage, CI | **Complete and verified** | Full suite passed at the P0 checkpoint; see exact results below. |
| 1 — Ledgers, architecture, requirements, numbering, state precedence/ownership | **Complete and verified** | Added dated ledger/requirements/architecture annotations and the ten-state source/precedence contract. Focused UI/core-state tests passed (26/26), syntax passed, and the P1 checkpoint full suite passed (3,733 total, 3,731 passed, 0 failed, 2 skipped); commit `875e3bc46703179ab50bcd22aa71c96939574f03`. |
| 2 — Authoritative state events and cross-process observation | **Complete and verified** | Bounded versioned owner snapshots, cross-process refresh, replay/reconciliation, heartbeat/watchdog handling and preservation of transient events. Package-focused tests pass (36/36); syntax passes across 223 source files. Full Core-state integration was not claimed at the P2 checkpoint; its later P3 completion is recorded below. |
| 3 — T-18 UI defects and lockdown integration | **Complete and verified** | All seven authoritative owner snapshots feed the live Core projection with full precedence and fail-closed validation; truthful boot/Quick boot, request-thinking, state visuals, and ECP safety UI are covered. Safety routes require local UI auth/CSRF, enforce the action's 240-character reason limit and release confirmation, return audit evidence, and do not resume paused runtime work. Focused tests 44/44; full suite passes (3,751 total, 3,749 passed, 0 failed, 2 skipped); syntax and diff checks pass. Browser execution remains unverified. |
| 4 — Truthful owner-backed workspaces | **Complete and verified** | Mission Control, Approval Centre, Sentinel, Memory Timeline, Conversation and the recorded Briefing are projections of the owning stores, including goals, plans, tasks, approvals, situational events, memory, knowledge and world-model history. Each workspace reports loading, empty, error, partial and unavailable states; provenance and lifecycle history are preserved, and writes stay on the existing controller paths. Focused tests 83/83 and 101/101; syntax passes; the P4 checkpoint full suite passed (see below). Browser execution remains unverified. |
| 5 — Experience system and desktop readiness | **Complete to its bounded scope; browser rendering unverified** | Design tokens from master §4.1 as shipped values, five owner-selectable presentation modes plus a latch-derived Lockdown presentation, reduced-motion and high-contrast support, `:focus-visible`, keyboard view traversal, five responsive breakpoints, and removal of the last dead element reference (`#situation`). Desktop shell ADR written (`reports/T30_P5_DESKTOP_SHELL_ADR.md`). Focused tests 10/10. Layout, pixels, overflow and perceived motion remain UNVERIFIED: no browser can be installed here (see `T30_P0_BROWSER_VERIFICATION.md` §4). |
| 6 — Whole-system validation and evidence | **Complete to its bounded scope; browser evidence unavailable** | `node --check` on 225 source files; full suite **3,781 tests, 3,779 passed, 0 failed, 0 cancelled, 2 skipped, 582 suites** (22m47s); real timings measured for state read, event delivery, degraded detection and reconnect reconciliation. Playwright could not launch a browser (6 of 7 tests cannot start; no binary), so screenshots at 1600×900, 1280×720 and 390×844 are **not produced**. Recorded below and in `T30_P0_BROWSER_VERIFICATION.md`. |

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
- At the Package 1 checkpoint, added `src/ui/core-state.js` with state definitions, reachability, precedence, `resolveCoreState()` and explicit source/owner descriptions. The pure resolver was contract code at that checkpoint; the UI did **not yet consume every source or apply the full precedence**. Package 3's later live integration is recorded below.
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

## Package 2 completed — bounded authoritative owner events and reconciliation

- Added `src/ui/event-contract.js` with `apex.state-event/1` and `apex.event-heartbeat/1`, strict stream/sequence/owner-version validation, a bounded replay history, the subscriber frame-queue guard and an injectable 1.5 s watchdog helper.
- The UI server now emits bounded owner snapshots for tasks, plans, approvals, ECP lockdown, runtime, health and conversation. Owner versions increase only when that owner's projection changes; every state event has a process-specific stream ID and contiguous sequence. The client rejects gaps, duplicates, out-of-order versions, malformed envelopes and stream mismatches, then requests explicit reconciliation when needed.
- A directory watcher plus a 250 ms metadata-poll fallback observes data changes made by other CLI processes. Reconnects replay retained events from `Last-Event-ID`; changed stream IDs or unavailable history produce a full owner reconciliation. History is capped at 128 state events, streams at eight subscribers, each event frame at 256 KiB and the response queue at 1 MiB.
- Preserved the separate progress/chat/Council/Workshop events. Heartbeats are emitted every 500 ms with the server head sequence; the browser watchdog expires at 1.5 s and marks transport state Degraded. At the Package 2 checkpoint this was not the full Core-state precedence integration; Package 3's later completion is recorded below.

### Files changed in Package 2

- `apex_app/src/ui/event-contract.js` (new)
- `apex_app/src/ui/server.js`
- `apex_app/src/ui/assets.js`
- `apex_app/tests/ui-event-contract.test.js` (new)
- `apex_app/tests/ui-owner-events.test.js` (new)
- `apex_app/tests/ui-server.test.js`
- `apex_app/reports/T30_PROGRESS.md`

## Package 3 completed — live Core projection, T-18 UI, and ECP safety controls

- Connected all seven Package 2 owner snapshots (`tasks`, `plans`, `approval`, `lockdown`, `runtime`, `health`, `conversation`) to `resolveCoreStateFromOwners()` and the served client. Both initial reconciliation snapshots and contiguous owner updates feed the same reducer; chat Thinking is derived only from a real outstanding `/api/chat` request.
- The live order is **Lockdown > Degraded > Awaiting Approval > Uncertain > Executing > Thinking > Idle**. Missing/malformed task counts, approval arrays, ECP flags, runtime lifecycle/pause state, health projection/counters, conversation counts, stale reads, or event liveness fail closed to Degraded. A positively observed active latch still wins. Health attention that is solely the same recorded approval or uncertain outcome is represented by that more-specific Core state; unrelated health blockers remain Degraded. Paused tasks or runtime scheduling are not presented as healthy Idle. Dormant, Listening and Speaking remain reserved.
- T-18 UI corrections: the page boots in Degraded until authoritative reconciliation; boot diagnostics read actual state, health, ECP latch and event reconciliation rather than displaying a fictitious loopback check; both Quick boot controls skip the overlay; Core status has reachable-state visuals, an uncertainty treatment, Idle breathing, steady Degraded, contracted red Lockdown, reduced-motion handling and a screen-reader status; chat requests present Thinking only while pending.
- Added the System safety panel and kept mutations on the existing Controller/ECP action path. The local UI token, POST marker and same-origin guard protect the controls. Lockdown/release reasons obey the underlying action's 240-character limit; release additionally requires a non-empty reason and explicit checkbox/`confirm: true`. Responses surface audit operation IDs and `recorded`; malformed/failed audit attempts are not presented as confirmed. Latch state is marked stale during a mutation and refreshed before release is re-enabled. ECP remains the authority, and releasing the latch does **not** resume a paused runtime or task.
- Owner/event/served-client, malformed-source, real startup Idle, real external CLI draft Awaiting Approval, and real uncertain-task projection are covered by the focused tests. Safety integration covers missing/wrong authentication, CSRF marker, reason length, release confirmation, audit fields/origin/reason and no-auto-resume.
- Local UI-token authentication is not owner identity/MFA/step-up. Playwright/browser interaction and screenshots remain unverified because Chromium is unavailable; full v2 cinematic visuals are not claimed.

### Package 3 files changed

- `apex_app/src/ui/assets.js`
- `apex_app/src/ui/core-state.js`
- `apex_app/src/ui/event-contract.js`
- `apex_app/src/ui/server.js`
- `apex_app/tests/ui-core-projection.test.js` (new)
- `apex_app/tests/ui-owner-events.test.js`
- `apex_app/tests/ui-server.test.js`
- `apex_app/ARCHITECTURE.md`
- `apex_app/ARCHITECTURE_V2.md`
- `apex_app/docs/APEX_V2_REQUIREMENTS.md`
- `apex_app/reports/T30_PROGRESS.md`

## Package 4 completed — truthful owner-backed workspaces

- Added owner-backed projections and routes: `GET /api/mission-control` (GoalStore, PlanStore, TaskStore), `GET /api/approvals` (TaskStore, PlanStore and situational approval requests), `GET /api/timeline?limit=N` (MemoryStore, KnowledgeStore, WorldModelStore), an expanded `GET /api/situation`, and an expanded `GET /api/briefing`. Each answers with a per-source `available` flag, an error string when a source could not be read, and a `status` of `available`, `partial` or `unavailable`.
- Added bounded chronological projections `KnowledgeStore.timeline()` and `WorldModelStore.timeline()` (1–100 rows). The combined timeline merges memory records with knowledge claims/retractions/resolutions and world-model changes in recorded-time order and reports `partial` when any owner is unreadable or memory reports corrupt records.
- Goal projections now carry origin, criteria with basis/requirement, blockers, unknowns, contradictions, completion records, entity/world references and bounded status/revision history. Plan projections carry origin, risk, approval binding, activation task, preconditions, checkpoints with recorded progress, linked outcomes and bounded lifecycle history. Task and approval projections carry the recorded origin/planner and the task's goal/plan references.
- Situation decisions bind to a recorded assessment and never execute an action. The page exposes only `ignore`, `record`, `investigate`, `notify` and `recommend` through `POST /api/situation/decide`, which calls `controller.situationDecide`. Approved execution remains a separate CLI `situation execute` step.
- Writes stay on the existing user-origin controller methods: task approve (`POST /api/tasks/:id/approve`), plan approve, plan cancel (`POST /api/plans/:id/cancel`, reason 1–500 characters, unknown fields refused) and the situational decision above. Approving a record changes intent only; no page control starts a task, runs a plan, resumes a paused runtime or executes a situational response.
- The served client's `refresh()` cycle now reads these endpoints instead of the older list routes, and every workspace has its own status element with `data-state` styling for `available`/`empty`/`partial`/`error`/`unavailable`/`loading`. Unavailable owners are named, an unavailable count is `null` rather than zero, and the briefing says so in its own note.
- System diagnostics now shows the health areas, runtime status, external sources and Resource Fabric readings. CPU and memory come from the fabric; GPU and network are shown as unavailable with the provider's own reason, so an absent provider is never displayed as a zero reading. The existing ECP safety controls and their audit evidence are unchanged.
- No decorative controls and no fabricated records were added. Controls appear only where an owner recorded a pending request or a cancellable plan, and the cancellation form states that cancelling a plan does not stop a task created from it.
- README records the workspace/route table and replaces the stale claim that the page has no situational write path with a dated addendum.

### Package 4 files changed

- `apex_app/src/ui/server.js`
- `apex_app/src/ui/assets.js`
- `apex_app/src/knowledge/knowledge-store.js`
- `apex_app/src/world/store.js`
- `apex_app/src/briefing/index.js`
- `apex_app/tests/ui-server.test.js`
- `apex_app/README.md`
- `apex_app/reports/T30_PROGRESS.md`

### T-19–T-29 evidence crosswalk

| Milestone | What the retained records say | T-30 treatment |
|---|---|---|
| T-19 | Separate checkpoint; it reports UI/Core/event work and refers to `e9d0880` and `301ba97`. | Kept as history; commit objects are absent from this shallow clone. Package 2 independently verified the current bounded event implementation and does not retroactively verify those historical commits. |
| T-20–T-24 | `T24_IMPLEMENTATION_REPORT.md` summarizes Command Experience, planner/TaskGraph, briefing, evolution foundation and documentation. | Summary retained; its starting commit `5098705` is unavailable locally and historical tests are not retroactively rerun. |
| T-25 | Council and served UI foundation; historical report records 8 Council tests and 7 Playwright tests. | Node tests are included in the P0/P1/P3 full-suite runs; Package 2 preserves served events. Browser run here is blocked by missing Chromium; historical screenshots are not newly reviewed. |
| T-26/T-27 | Workshop design-composition/store/actions/UI foundation. | Current Node suite passes; P0 repaired the nested UI template syntax. The product remains a deterministic design/simulation tool, not 3D CAD or code execution. |
| T-28 | Local device-trust registry foundation. | Its tests are included in the passing full suite; transport, Presence Mesh, owner MFA and UI/ECP device operations remain unimplemented or unverified. |
| T-29 | Ledger says “not started”; current repository also contains separate cognitive/executive modules. | Still not accepted as a unified integration milestone; module presence and a green suite are not proof of the complete pipeline. |

## Verification evidence

| Command | Result |
|---|---|
| `node --test tests/briefing.test.js tests/memory-knowledge-history.test.js tests/world-model-core.test.js tests/t09-situational-awareness.test.js tests/ui-server.test.js` (P4 focused run) | **101 tests: 101 passed, 0 failed, 0 skipped**; covers the owner timelines, briefing owners, situational state and the new workspace routes. |
| `node --test tests/ui-server.test.js tests/ui-core-projection.test.js tests/ui-owner-events.test.js tests/core-state-contract.test.js tests/briefing.test.js tests/t12-documents.test.js` (P4 focused runs) | **83 tests: 83 passed, 0 failed, 0 skipped**; includes the served-client checks, the document-index route change and the Resource Fabric diagnostics. |
| `npm run test:syntax` (P4 final run) | **1 passed, 0 failed, 0 skipped**; every JavaScript source file and the served client parsed. |
| `npm test` (P4 final full suite) | **3,760 tests: 3,758 passed, 0 failed, 0 cancelled, 2 skipped; 577 suites**. Runtime 1,307,566 ms (about 21m48s). Log: `/tmp/apex-t30-p4-final.log`. Code checkpoint `1ce7bf4`; this report is committed separately afterwards. |
| `npm run test:syntax` (P0 checkpoint) | **1 passed, 0 failed, 0 skipped**; checked 221 source files and separately parsed the served client. |
| `npm run test:syntax` (P1 checkpoint) | **1 passed, 0 failed, 0 skipped**; checked 222 source files and separately parsed the served client. |
| `node --test tests/cross-process-stress.test.js tests/storage-concurrency.test.js tests/t16-pilot-reporting.test.js` | **21 tests: 21 passed, 0 failed, 0 skipped**. |
| `node --test tests/core-state-contract.test.js tests/ui-server.test.js` (P1 checkpoint) | **26 tests: 26 passed, 0 failed, 0 skipped**; covers all ten state rows, precedence, reserved-state rejection and UI-server integration. |
| `node --test tests/core-state-contract.test.js tests/ui-event-contract.test.js tests/ui-owner-events.test.js tests/ui-server.test.js` (P2 checkpoint) | **36 tests: 36 passed, 0 failed, 0 skipped**; adds event-envelope/version/gap checks, bounded replay/queue guards, cross-process CLI plan/runtime changes, stale-stream reconciliation, fail-closed health/lockdown owner events, subscriber limit and preserved progress/chat events. |
| `npm run test:syntax` (P2 checkpoint) | **1 passed, 0 failed, 0 skipped**; checked all 223 JavaScript source files and parsed the served client independently. |
| `node --test tests/core-state-contract.test.js tests/ui-core-projection.test.js tests/ui-event-contract.test.js tests/ui-owner-events.test.js tests/ui-server.test.js` (P3 final focused run) | **44 tests: 44 passed, 0 failed, 0 skipped**; includes real startup Idle, external CLI draft Awaiting Approval, real uncertain-task projection, malformed sources, precedence, UI safety gating, ECP auth/audit and no-auto-resume. |
| `npm run test:syntax` (P3 final run) | **1 passed, 0 failed, 0 skipped**; all 223 JavaScript source files and the served client parsed. |
| `npm test` (P3 final full suite) | **3,751 tests: 3,749 passed, 0 failed, 0 cancelled, 2 skipped; 576 suites**. Runtime 1,302,751 ms (about 21m43s). Log: `/tmp/apex-t30-p3-final.log`. |
| `npm test` (P0 checkpoint) | **3,729 tests: 3,727 passed, 0 failed, 0 cancelled, 2 skipped; 570 suites**. Runtime 1,245,229 ms (about 20m45s). Log: `/tmp/apex-p0-full-verified.log`. |
| `npm test` (P1 checkpoint) | **3,733 tests: 3,731 passed, 0 failed, 0 cancelled, 2 skipped; 571 suites**. Runtime 1,231,611 ms (about 20m32s). Log: `/tmp/apex-p1-full.log`. |
| Full `npm test` immediately after Package 2 | Not run at the P2 checkpoint; the later P3 final full suite covers the combined P0–P3 working tree. |
| `git diff --check` (P3 final review) | Passed. |
| `npm run test:e2e` | Could not launch because the installed `node_modules/.bin/playwright` shim is not executable in this workspace (`Permission denied`). |
| `node node_modules/@playwright/test/cli.js test` | **7 tests discovered: 1 passed, 6 could not launch Chromium** because Playwright's `chrome-headless-shell` binary is absent. No system Chromium/Chrome/Firefox was present. This is an environment/browser-availability blocker, not six observed product assertion failures. Browser verification and screenshots remain **unverified**. |

The P4 final `npm test` passed across the combined P0–P4 application code, served-client and documentation changes on code checkpoint `1ce7bf4`. Like the P3 run, it says nothing about browser behaviour; the Playwright blocker below still applies.

The P3 final `npm test` passed across the combined P0–P3 application code and architecture/requirements changes. The progress report was then updated with that result; the exact full-suite total and log are shown above. This does not retroactively convert the P2 checkpoint's focused-only run into a P2-only full-suite claim. Playwright was attempted through the package CLI; browser-based validation could not execute without a browser binary. No browser download was attempted. No `npm ci` was run locally; the existing development installation was used.

## Package 5 work completed (experience system and desktop readiness)

- **Tokens.** `UI_CSS` now carries the master-document values as the canonical tokens
  (`--bg-void #05080f`, `--bg-deep #0a1220`, `--glass rgba(12,28,48,0.55)`, `--arc-cyan #00e5ff`,
  `--armor-gold #ffb000`, `--armor-red #e10600`, `--ok-green #2bff88`, `--text #dcebff`,
  `--text-dim #7fa3c7`, `--radius 2px`) with aliases (`--cyan`, `--gold`, `--muted`, `--panel`,
  …) so no pre-existing rule changed meaning silently. Tabular numerals are applied to the body
  and to every numeric readout. `--armor-red-text #ff6b5a` exists because `#e10600` measures
  below 4.5:1 on the void background; the raw red stays a fill/border colour.
- **Modes.** Classic is the default skin; Tactical, Overwatch, Synthesis and Quiet are
  token-only overlays (palette emphasis, one motion-duration change each) selected from a real
  `<select>`; Lockdown is **derived from the ECP latch** through the Core projection and disables
  the selector while active. No mode rule hides a record surface, and no mode reaches an API,
  a store or the ECP — asserted by test.
- **Accessibility.** `:focus-visible` outline on every interactive element, `aria-current="page"`
  on the active nav item, `aria-pressed` on the motion/contrast toggles, a skip link, a labelled
  mode selector, `prefers-reduced-motion` and a manual reduced-motion switch, `prefers-contrast:
  more` plus a high-contrast toggle, and measured contrast ≥ 4.5:1 for seven text/surface token
  pairs (the test computes the ratio from the shipped hex values).
- **Responsiveness.** Breakpoints at 1600, 1280, 1100, 720 and 480 px, `min-width: 0` and
  `overflow-wrap` on panels/rails/stages, and horizontal scrolling confined to `<pre>` blocks.
  The layout itself is unverified without a browser.
- **Dead controls.** A new audit found `getElementById('situation')` registered but absent from
  the served page and never read; it was removed. The audit now fails the suite if any
  `getElementById` target is missing, if a nav item has no view section (or vice versa), or if a
  voice/microphone/push-to-talk control appears.
- **Desktop shell ADR.** `reports/T30_P5_DESKTOP_SHELL_ADR.md` evaluates loopback browser +
  thin shell, Tauri and Electron across IPC security, lifecycle, authentication, window
  management, startup/shutdown, local data access, packaging/updates, crash recovery, resource
  usage and security boundaries. Recommendation: thin shell now, Tauri if a native shell becomes
  necessary, Electron rejected. No shell code was written.

### Package 5 files changed

- `apex_app/src/ui/assets.js` (tokens, modes, focus/contrast/motion rules, responsive breakpoints,
  mode and preference controls, keyboard traversal, latch-derived Lockdown presentation)
- `apex_app/tests/ui-experience-system.test.js` (new, 10 tests)
- `apex_app/reports/T30_P5_DESKTOP_SHELL_ADR.md` (new)
- `apex_app/reports/T30_PROGRESS.md` (this report)

### Package 5 verification

| Check | Result |
|---|---|
| `node --check` on every file under `apex_app/src` | **225 files, 0 failures** |
| `node --test tests/ui-experience-system.test.js` | **10 tests, 10 passed, 0 failed** |
| `node --test` on the nine UI/syntax suites | **71 tests, 71 passed, 0 failed** (18 suites, 13.7 s) |
| Real-browser verification of modes, focus, overflow, screenshots | **UNVERIFIED** — no browser can be installed (see `T30_P0_BROWSER_VERIFICATION.md` §4) |

## P0 client fix and Step 2 verification (recorded here for completeness)

- **Defect.** The served client embedded Node functions with `.toString()`; the first event threw
  `ReferenceError: STREAM_ID_RE is not defined` and the Core stayed on Degraded against a healthy
  server. Reproduced against `d7ad87e` with the new test (4 of 5 cases fail with that exact error).
- **Fix (commit `3cb33ea`).** One self-contained factory (`src/ui/client-contract.js`) is called by
  Node and rendered verbatim into the browser; `core-state-tables.js` holds the vocabulary as
  data; `core-state.js` and `event-contract.js` keep their public exports.
- **Guards.** `ui-client-contract-source` (bare-vm execution and Node/browser equivalence),
  `ui-client-runtime` (shipped script, fake stream, 1500 ms watchdog measured), and
  `ui-live-stream` (real server, real SSE, real cross-process write, real restart).
- **Step 2 (commit `0798d4b`).** `reports/T30_P0_BROWSER_VERIFICATION.md` records every failed
  route to a Chromium binary (blocked CDN, missing shared libraries, no apt access, unreachable
  release assets). No screenshot was produced and none is claimed.

## Package 6 work (whole-system validation)

See the evidence table and the measured timings below. Screenshots at 1600×900, 1280×720 and
390×844 are **not available** in this environment; nothing in `reports/` was generated by this
session, and the historical `t25_*.png` captures were not re-verified.

## Package 6 evidence (whole-system validation)

Command context: Linux, Node 22.22.3, `apex_app/`, working tree at commit
`T-30 P6` (this commit's parent `763456d` plus the two test-text updates in this commit).

| Check | Exact result |
|---|---|
| `node --check` on every file under `apex_app/src` | **225 files, 0 failures** |
| `npm run test:syntax` | **1 passed, 0 failed** |
| `node --test` (full suite) | **3,781 tests, 3,779 passed, 0 failed, 0 cancelled, 2 skipped, 582 suites**; 1,366,890 ms (22m47s); log `/tmp/apex-t30-p6-final.log` with `EXIT=0` |
| `node node_modules/@playwright/test/cli.js test` | **7 discovered: 1 passed, 6 failed to launch** — `browserType.launch: Executable doesn't exist at /home/user/.cache/ms-playwright/chromium_headless_shell-1255/chrome-headless-shell-linux64/chrome-headless-shell`. These are environment failures, not product assertions. |
| `npx playwright install chromium` | Failed: `ECONNRESET` to `cdn.playwright.dev:443` (see `T30_P0_BROWSER_VERIFICATION.md` §4 for the five other attempted routes) |
| `git diff --check` | Clean |

### Measured timings (real, from `tests/ui-live-stream.test.js`; not a browser)

The harness runs the shipped `UI_CLIENT` in a `vm` against a real `createUiServer` on loopback,
with a real `text/event-stream`, real timers and a real cross-process `plan add`.

| Measurement | Value | Notes |
|---|---|---|
| First `/api/state` read | **167–204 ms** | cold start of the app in the harness; includes store reads |
| First reconcile frame after page load | **225–281 ms** | server sends the reconciliation immediately on connect |
| Heartbeats received | **2 in 1.2 s** | server cadence 500 ms |
| Degraded detection when the server stops | **20 ms** | the transport errors immediately, which also marks the stream degraded |
| Degraded detection when heartbeats stop but the socket stays open | **1,500 ms** measured on a virtual clock | the watchdog value; acceptance limit 2,000 ms (`tests/ui-client-runtime.test.js`) |
| Reconnect-to-reconciled after a restart on the same port | **338 ms** | includes the client's 300 ms reconnect backoff |
| Cross-process write visible as Awaiting Approval | under 2 s | a real `plan add` in a separate process |

These are harness numbers on this machine. They are **not** browser paint timings, first-contentful
paint, or layout measurements.

### Screenshots

**None produced.** `apex_app/reports/` contains no image from this session. The `t25_*.png` files are
historical Windows captures and were not re-verified. The three required viewports (1600×900,
1280×720, 390×844), the workspace, approval, lockdown and degraded views therefore have **no visual
evidence**, and the responsive claims in Package 5 are supported only by static CSS assertions.

## Risks and blockers

- Browser behavior and screenshots are not verified in this environment because there is no installed browser executable. Keep this explicitly marked unverified unless browser execution becomes available.
  - *Updated 2026-11-19 (Package 6):* the blocker is now characterised precisely rather than as "no
    installed browser". Playwright's browser download fails with `ECONNRESET` at
    `cdn.playwright.dev:443`; no system browser or Electron is installed; ten Chromium shared
    libraries (`libnss3`, `libnspr4`, `libgbm`, `libatk-1.0`, `libxkbcommon`, `libasound`, `libcups`,
    `libdrm`, `libpango`, `libcairo`) are absent; `apt` cannot be used (no permission, no mirror); and
    a portable Chromium release asset is unreachable (`curl` 35). See
    `reports/T30_P0_BROWSER_VERIFICATION.md` §4.
- P0 resolves the observed concurrent-write and pilot-reporting failures; it does not establish broader cross-platform filesystem guarantees beyond the passing tests on this Linux/Node 22 environment.
- No inference, model download, model endpoint, voice/audio path, or remote inference process was used or added.

## Current blockers and limits

- Browser rendering, end-to-end clicks and screenshots remain **unverified**: the Playwright shim is non-executable and Chromium/Chrome/Firefox binaries are absent. The served client parses and Node UI/server tests pass, but neither establishes browser behavior.
- The UI token is process-local authentication, not owner identity, MFA or step-up authentication. The ECP remains the authorization authority.
- The full v2 visual/cinematic target and Listening/Speaking/audio remain unimplemented, and Packages 5–6 are outside the completed T-30 scope. No completion claim is made for them.
- T-19 historical commit objects remain unavailable in this shallow local history; current T-30 tests do not retroactively verify historical evidence.
- P0's passing storage tests do not establish broader cross-platform filesystem guarantees beyond this Linux/Node 22 environment. No inference, model download, endpoint, voice/audio path, or remote inference process was used or added.

## Step series S1–S4 (2026-11-19, after the Packages 0–6 checkpoint)

Four steps were requested in a fixed order, each verified and committed before the next. Every
number below was measured in this environment; nothing visual was observed.

### S1 — `/api/state` latency (commit `d1c9155`; mechanism corrected by the S4 repair)

**Defect.** The Package 6 pilot measured 167–204 ms for `/api/state` against a Part 4 bound of
≤150 ms. Profiling showed the cost was not one pathological read: the page-load burst issues
fifteen owner routes, and each one that read a store re-read, hashed and re-parsed the whole file
even when nothing had changed. Paired measurement on this machine before any change: a cold
`/api/state` racing fourteen other owner routes took **155.2 ms**, and the full fan-out
**174.3 ms**.

**Change, final form.** `src/memory/jsonl-store.js` retains, per instance, the records it last
derived together with the SHA-256 of the exact bytes they were derived from. `load()` reads the
file, hashes it, and serves the retained records only when digest **and** byte length both match.
Anything else — a different digest, a different length, an unterminated tail, a missing or
unreadable file, more than `readCacheMaxRecords` records, or more bytes than the store's
`parseCacheBytes` cap — falls through to the unchanged parse path. The bytes are therefore always
read; what retention saves is the parse, the validation and the freeze, plus the per-route
repetition inside one burst, because concurrent reads of one file share a single in-flight read.
A read certifies its digest to a caller (the knowledge lifecycle index) only when this store kept
the derivation, so an uncertified read still authorizes nothing.

**Correction, same day: the first version keyed on file identity and was wrong.** `d1c9155` keyed
the fast path on `fs.stat({ bigint: true })` — `dev/ino/size/mtimeNs/ctimeNs` — on the assumption
that a rewrite in place moves `mtimeNs`/`ctimeNs`. On this machine's scratch filesystem
(ext2/ext3) it does not: a 28-byte file rewritten with 28 different bytes reported **identical**
`ino`, `size`, `mtimeNs = 1795158626995990272n` and `ctimeNs` afterwards. The first full-suite run
found it — `tests/request-scoped-reads.test.js` returned `aaaa` where `bbbb` had been written — and
it was then reproduced directly against the filesystem, so it was a cache-correctness bug, not a
flaky test. The identity key was removed rather than patched: no store in APEX now reuses records
on the strength of metadata this filesystem does not promise. Hashing a file that was just read
costs a fraction of parsing and validating it, and the bound below is kept without the unsafe key.
An earlier draft of this section claimed the identity path was safe *because* an in-place rewrite
moves `mtimeNs`/`ctimeNs`; that claim was false here and is withdrawn.

**Measured — paired A/B, same harness, same machine, back-to-back.** The pre-S1 file
(`d1c9155^`) and the current file were swapped in turn; seven full runs each; seeded with 300
memory records / 150 tasks / 60 plans / 30 goals, page = `/api/state` plus the fourteen other owner
routes.

| Measurement | Before (`d1c9155^`) | After (content-verified) |
|---|---|---|
| cold `/api/state`, single read | 40.3 ms (36.9–59.1) | 40.6 ms (37.3–59.9) |
| cold page fan-out, 15 routes | **182.2 ms** (139.6–203.6) | **125.4 ms** (102.5–241.3) |
| warm `/api/state` p50 | 12.7 ms | 12.6 ms |
| warm page fan-out p50 | 70.2 ms (62.5–85.2) | 53.5 ms (50.8–66.3) |

Contended run (200 tasks / 100 memory; `/api/state` racing fourteen routes; five rounds; state and
page in ms):

| Round | Before: state / page | After: state / page |
|---|---|---|
| 0 (cold) | **155.2 / 174.3** | **87.9 / 98.5** |
| 1–4 (warm) | 37.5–87.7 / 46.3–101.2 | 31.5–50.4 / 39.9–56.9 |

Read these numbers for what they are. `/api/state`'s own cost is dominated by the causal projection,
not by store parsing, so its single-read cold and warm figures barely move; the gain is in the
burst, where the repeated whole-file parses used to sit. This box has two vCPUs and single cold
samples are noisy: the mid-suite sample reached 241 ms while a 24-minute test run was finishing,
and the medians with min–max are reported instead of one sample. The acceptance bound is asserted
on `/api/state` itself — ≤150 ms cold, ≤100 ms warm, single read and under a concurrent burst,
plus a cross-process write visible on the very next read — and `tests/ui-state-latency.test.js`
measures those directly.

**Test.** `tests/ui-state-latency.test.js` (5 tests, 5/5): a cold read ≤150 ms, every warm read
≤100 ms with retained reads actually served (`readCacheStats.hits > 0`), a page-load burst that
does not push `/api/state` past 150 ms, an external `plan add` visible on the very next read with a
proved retained-read miss, a lockdown latch flipped by another process visible at once, and a
damaged `kill-switch.json` reported `policyUnavailable: true` and never `active: false`. The
regression that caught the identity bug is
`tests/request-scoped-reads.test.js` ("a same-length rewrite is parsed again, not answered from the
snapshot"); `tests/knowledge-lifecycle-reuse.test.js`, `tests/retrieval-snapshot.test.js`,
`tests/incremental-write-state.test.js`, `tests/store-write-concurrency.test.js` and
`tests/storage-integrity.test.js` pin the rest of the store's reuse contract.

### S2 — T-29 unified cognitive pipeline (commit `49651dd`)

`src/cognition/pipeline.js` runs one owner intent through five recorded stages and stores the run
in `cognition-runs.jsonl` (append-only, same store rules as every other ledger).

1. **Context** — a `CognitiveContextPacket` of owner goals, memory records, knowledge claims and
   world-model facts. Every claim carries an epistemic tag (`observed | inferred | assumed |
   predicted`) decided by fixed rules over the record's own provenance and confidence, and every
   cited item names its record id.
2. **Salience** — read-only `urgency`, `confidence`, `uncertainty`, `goal_progress`,
   `resource_pressure` (Resource Fabric), `risk_sensitivity`, `novelty`, each with a stated basis.
   `goal_progress` is `null` rather than invented when no goal reports criteria. Sentinel
   advisories are carried as advisories; they cannot authorize anything.
3. **Council** — the deterministic Council's perspectives, mapped to `thesis`, `counter_risk` and
   `evidence_check` and cited against the packet, with the recommendation and the explicit
   `authorizesExecution: false`. Skipped, with the reason, when uncertainty and risk are low.
4. **Task graph** — one step per concrete action, carrying the registry's permission and risk.
5. **Execution** — through the controller, registry and ECP only.

**The gate.** A write, an L2+ action, a high/critical-risk action, an irreversible effect or a
security-relevant capability stops the run before anything executes: the task is recorded, taken to
its authorization gate, and left `paused` with the step in `awaiting_approval`. Only
`controller.approveTask(taskId, { stepId })` records the owner's approval; `runTask(id, 'resume')`
then executes it. `verified: true` is derived from the task step's `success_verified` outcome on
every read, never from the pipeline's own claim.

**Fail-closed.** An active latch or an unreadable latch halts the run with
`KILL_SWITCH_ACTIVE` / `POLICY_UNAVAILABLE` before a task exists; an ECP denial of the concrete
action halts with the ECP's reason. The capability itself (`cognition.run`) is owner-only, write,
unplannable, and denied to a model origin, so under lockdown the ECP refuses it and the requesting
operation records the denial.

**Surface.** `POST /api/cognition/run`, `GET /api/cognition/runs`, `GET /api/cognition/runs/:id`,
`POST /api/cognition/runs/:id/approve`, a `cognition` SSE event, and a Command Deck workspace that
renders the five stages from the run record with an approval control only when the run says a step
is waiting.

**Two representation defects found while wiring it, and fixed.**

- `src/health.js` counted a paused task awaiting approval **twice** (once as `approval`, once as an
  unexplained `paused-task`), which made the Core report Degraded for a gated run.
- `src/ui/client-contract.js` treated *any* paused task as degradation, so `Awaiting Approval` was
  unreachable for a paused task even when a step was waiting. A paused task with nothing waiting
  still degrades the Core; a pending approval now outranks the bare paused-task warning.

**Tests.** `tests/cognition-pipeline.test.js` 15/15 (packet, salience bounds and basis, Council
perspectives, read end-to-end verified, write gated → approve → resume → verified, lockdown halt
with an audit record, unreadable latch, unregistered capability, registry classification, storage
and corruption handling, the health double-count). `tests/ui-cognition.test.js` 8/8 (all four
routes, refusal and 404 cases, the SSE transition, and the shipped `UI_CLIENT` rendering five
stages, offering the approval control, and re-reading on the event — in a vm, not a browser).

### S3 — zero-dependency thin desktop shell (commit `ab630fa`)

Option (A) of `reports/T30_P5_DESKTOP_SHELL_ADR.md`, implemented as `src/ui/desktop-shell.js`.

- Starts the existing loopback UI server on `127.0.0.1` and a free or configured port
  (`--port`, `APEX_DESKTOP_PORT`, `APEX_UI_PORT`, else kernel-assigned), then **verifies
  `/api/state`** answers with the process token before it launches anything.
- Resolves a Chromium-family executable: an explicit setting first (`APEX_DESKTOP_BROWSER_BIN`, or
  `--browser` naming one binary for this run), then discovery in the order `msedge`, then
  Chrome/Chromium per platform. It launches it with `--app=<loopback url>`,
  `--user-data-dir=<dataDir>/desktop-profile` (mode 0700), `--no-first-run` and
  `--no-default-browser-check`. Arguments are passed as a vector; nothing is interpolated into a
  shell.
- `--dry-run` and `--print-launch-spec` return the exact command without spawning; the spawner is
  injectable, so every behaviour is tested on a machine with no browser.
- With no browser installed it prints an honest diagnostic, starts nothing, and leaves the working
  URL on screen. It never pretends a window exists.
- Stops the server and terminates the child on exit, `SIGINT` and `SIGTERM`.
- Entry points: `node src/cli.js desktop`, `node bin/apex.js desktop`, `npm run desktop`.

**Correction, found by CI (2026-11-19).** The first version tried `APEX_DESKTOP_BROWSER_BIN` *last*,
so on a machine with a browser installed the setting was silently ignored: the hosted runner has
`/usr/bin/microsoft-edge`, and `--print-launch-spec` reported Edge where the configured binary had
been named. The configured browser is now tried first and discovery answers only when nothing was
configured; `--browser` still replaces the list entirely. `tests/desktop-shell.test.js` gained a
regression that resolves a configured binary against an installed `microsoft-edge` and expects the
configured one. This is also why the first CI runs of S1–S3 were red while the same tree was green
here: this box has no browser at all, so the ordering defect was invisible.

**Tests.** `tests/desktop-shell.test.js` 14/14: explicit-then-discovered candidate order (and the
installed-browser regression above), resolution with the tried list, PATH lookup, launch-spec
construction, port parsing, a real loopback server with a verified ready state and an isolated
profile, dry-run spawning nothing, real spawn argument vectors, the no-binary fallback with a
still-serving URL, idempotent stop, and three CLI runs (`--dry-run`, `--print-launch-spec` JSON,
no-browser fallback).

**Not verified.** No window was opened, and nothing was run on Windows or macOS. The platform
matrices are unit-tested, not executed.

### S4 — full verification

| Check | Result |
|---|---|
| `node --check` over every `apex_app/src/**/*.js` | **228 files, 0 failures** |
| `npm test` (full suite) | **3,823 tests: 3,821 pass, 0 fail, 2 skipped** — two consecutive runs, 1,441.6 s and 1,458.5 s |
| `/api/state`, cold (single read) | 8–14 ms on the live harness's small store; 37–60 ms on the seeded 300/150/60/30 workspace |
| `/api/state`, warm p50 | 8–13 ms small store; 12.6 ms seeded workspace |
| First reconcile frame after page load | 266–384 ms |
| Degraded detection after the server stops | 20 ms |
| Reconnect → reconciled | 331–356 ms (includes the client's 300 ms backoff) |
| Five-stage trace rendered after the `cognition` event | 103–159 ms |
| Core transitions observed through the served client | `idle → awaiting_approval → idle` around one gated run |
| Hosted CI (`.github/workflows/apex-app-tests.yml`, Node 22, ubuntu-latest) | **green** on commit `7a059a3`: same full suite, same syntax guard |

The live harness (`tests/ui-live-stream.test.js`) drives the shipped `UI_CLIENT` inside a vm against
a real `createUiServer`: it records the state reads, the first reconcile frame, the heartbeat
cadence, the T-29 SSE transition, the gated run's approval, the five-stage render and the degraded
and reconnect behaviour. It is **not a browser**: no pixels, layout or motion were observed.

The reconcile, degraded, reconnect and trace rows are the numbers `tests/ui-live-stream.test.js`
prints in its own diagnostics (`--test-reporter=tap`, four consecutive runs on this two-vCPU box;
the range is the spread across those runs). The `/api/state` rows are the live harness's small empty
store (8–14 ms) beside the seeded 300/150/60/30 benchmark workspace used in S1 (37–60 ms cold,
12.6 ms warm p50, seven runs). None of these is a paint, layout or first-contentful-paint
measurement.

The hosted CI job is the independent check on the same tree: `npm ci --ignore-scripts`, the syntax
guard, then `npm test`, green on `7a059a3`. It is also what found the desktop-shell ordering defect
recorded in S3 — the runner has a browser installed and this sandbox does not.

The full-suite row is two consecutive runs that closed this step series, both taken **after** the
S1 mechanism was replaced: 3,823 tests, 3,821 passing, 0 failing, 2 skipped, in 1,441.6 s and
1,458.5 s of wall clock (the second on the committed tree). Two earlier runs are history rather
than results — 3,805/3,823 with 16 failures before the T-29 health, client-projection and inventory
repairs, and 3,820/3,823 with one failure (the same-length rewrite above) before the S1 correction.

**Deliberately not claimed.** Intelligence, executive completeness, in-browser rendering, the three
viewports, screenshots, Windows and macOS behaviour, and any voice path. Passing tests here are
evidence about this code on this machine, not proof of the system's competence.

> **Superseded counts (2026-11-19).** The registry figure in the Package 6 row of the table above
> (and the AF-19 inventory counts) predate T-29: with `cognition.run` registered the verified
> registry is **140 actions by default and 155 with a filesystem root — 85 reads, 71 writes, 56
> plannable**. The earlier 139/154 figures are history, not inventory.


## Next action

The step series S1–S4 is complete: `/api/state` meets its bound on a seeded workspace, T-29 runs
end-to-end behind an explicit owner approval, and the desktop shell launches or honestly reports
that it cannot. What remains is still the evidence this environment cannot produce — a real
Chromium run at the three viewports with zero console errors, plus screenshots — and the owner's
decision on the desktop platform. Until then every visual, layout, overflow, motion and focus
claim stays **UNVERIFIED**.

Packages 0–6 are complete to their bounded scope. The P0 client defect is fixed and guarded, the
experience system is applied, and the desktop-shell decision is recorded. What remains is not a
package: it is the evidence that this environment cannot produce — a real Chromium run at the three
viewports with zero console errors, plus screenshots. Until that exists, every visual, layout,
overflow, motion and focus claim stays **UNVERIFIED**, and passing tests must not be read as proof of
intelligence, of a complete executive system, or of the Tony-Stark experience target.
