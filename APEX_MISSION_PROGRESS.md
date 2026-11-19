# APEX Mission Progress (T-25 through T-29)

## Final state

- Branch: `main` (single shared branch; no agent branches)
- HEAD: `01c3eae` — T-25 Council, served UI, browser evidence
- `origin/main`: `78d88ee` — **T-25 is committed locally but NOT pushed.** The push was
  rejected: the credential helper is signed in as `rahulsamarth121`, which has no write
  access to `Rahulrr324/A.P.E.X`. Re-authenticate as an account with write access and run
  `git push origin main`; the local commit is a fast-forward from `78d88ee`.
- Worktree: clean apart from generated `apex_app/test-results/` output, which is ignored.
- Inference: none. No model runtime, no Ollama/LM Studio/llama.cpp, no remote endpoint,
  no model download. Every behaviour below is deterministic code or a simulated provider.
- Voice: out of scope for T-25 through T-29; still documented as future work.

## Milestone commits

- T-25: `01c3eae` — Council core, actions, controller path, UI, Playwright suite,
  capability inventory, README counts.
- T-26: not started.
- T-27: not started.
- T-28: not started.
- T-29: not started.

## Status

- **T-25 Council: implemented locally and verified.** Seven fixed perspectives over an
  evidence set built only from reasoning evidence; synthesis carries recommendation level,
  support, confidence, alternatives, risks, assumptions, unknowns, missing information,
  required approvals, reversibility and expected verification. Every record has
  `authorizesExecution: false`; the assertion is a test. Deliberation runs through
  `runAction` / the ECP / `operations.jsonl`, so a Council record is a judgement, never a
  permission. `council.deliberate`, `council.list`, `council.get`, `council.replay` and
  `council.compare` are reads, unplannable, and covered by the capability inventory.
- **T-25 UI:** `/api/council` and `/api/council/deliberate` routes, a Council view and a
  `renderCouncil` that reads the stored synthesis shape. The undefined `APP_NAME` import
  that made `/api/state` return 500 is fixed; the workspace now loads.
- **T-25 repository repair:** `npm test` is now bare `node --test` (Node 26 rejects
  `node --test tests/`); the old explicit list is `test:unit:legacy`. The old list had
  silently omitted six suites. Playwright is `test:e2e` and remains development-only;
  `apex_app` declares no runtime dependencies. Two stray `fix-council.mjs` / `fix2.mjs`
  scratch files were removed.
- **T-26 through T-29:** not started. Scope remains Workshop, device trust/presence mesh,
  and unified cognitive integration. None of them may authorize execution; the ECP stays
  the sole authorization authority and the kill switch stays outside the model path.

## Tests

Measured on this machine (Node v26.4.0, Windows), isolated temporary data directories:

- `node --test tests/council.test.js tests/capability-inventory.test.js
  tests/finalization-contract.test.js tests/ui-server.test.js` — **52 pass, 0 fail**
  (13 suites).
- `node --test tests/plan-scenarios-am.test.js` — **31 pass, 0 fail** (3 suites).
- `node --test tests/composition-guard.test.js tests/finalization-path-audit.test.js
  tests/capability-truthfulness.test.js tests/audit-consistency.test.js
  tests/acceptance-batch-f.test.js tests/data-dir-isolation.test.js` — **80 pass, 0 fail**
  (17 suites).
- `npm run test:e2e` (Playwright 1.65.1, Chromium) — **7 pass, 0 fail**. The committed
  PNGs in `apex_app/reports/` are captures from this run, not fabricated images.
- Not run in this milestone: the full `npm test` sweep (deliberately, to keep the
  milestone loop targeted). The full suite is the next step before T-26 starts.

## Remaining limitations

- T-26..T-29 are unimplemented: no Workshop, no presence mesh, no device trust store, no
  unified cognitive integration.
- Council deliberation is deterministic and hypothetical; it is not a trained or learned
  judgement, and its evidence comes only from records the runtime already holds.
- Browser evidence covers the served UI at 1280x720 and 390x844 on Chromium only; no other
  engine, no real mobile device.
- No remote model inference, by policy. Model-backed behaviour remains simulated.
- The T-25 commit is local until push credentials are corrected.
