// T-25 browser validation. Playwright is a development-only dependency and is never part of
// the application runtime: `apex_app` declares no runtime dependencies.
//
// The suite starts its own `bin/apex-serve.js` on an ephemeral loopback port with an isolated
// temporary APEX data directory, so no real user data is read or written.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  // T-31 Step 1 (2026-11-19): the real-browser suite is the one the CI job runs, because it
  // resolves a real system browser and fails loudly on console errors, overflow, a missing
  // screenshot or a Core that does not degrade. `tests/e2e/apex-browser.spec.mjs` (T-25) is kept
  // in the tree as history but is not part of the default run: it asserts the pre-T-29 navigation
  // count and pre-T-31 markup, and the T-31 suite covers everything it covered and more.
  // T-32 Step 2 (2026-11-19): the HUD experience suite runs next to the T-31 one. Both drive the
  // shipped server and client with a real binary; neither is a simulation.
  // T-33 Step 4 (2026-11-19): the executive-loop walk joins them. It drives the whole five-character
  // loop in one session and writes its own JSON summary for the workflow annotation.
  // T-34 Step 4 (2026-11-19): the mission-DAG walk joins them. It drives a fan-out/fan-in mission
  // from its gates to a verified completion, switches tasks in the selector and writes its own
  // summary.
  // T-35 Step 4 (2026-11-19): the step-down / handoff / doctor walk joins them. It walks the ladder
  // 0 -> 5, measures the flash guard with the Web Animations API, claims a staged envelope and runs
  // the doctor, and writes its own summary.
  // T-36 Step 4 (2026-11-21): the cold-boot walk joins them. It is the only suite that starts from
  // an empty data directory, so the machine it reports was set up by the bootstrap during the walk.
  // T-37 Step 4 (2026-11-21): the neural/Council/router walk joins them. It is the only suite that
  // checks all eleven canonical screens by their declared ids in a live DOM.
  // T-40 Step 4 (2026-11-22): the changeset / disk-drift / command-help walk joins them. It is the
  // only suite that applies more than one file in a single governed act and then measures the disk
  // afterwards, and the only one that opens the command reference with a key.
  // T-43 Step 4 (2026-11-19): the workstation / git executive / telemetry walk joins them. It is the
  // only suite whose workspace is a real git repository, so the counts it asserts are checked against
  // the system git binary as well as against the product, and the only one that measures the host's
  // listening ports and finds its own server among them.
  testMatch: ['**/t31-real-browser.spec.mjs', '**/t32-hud-experience.spec.mjs', '**/t33-executive-loop.spec.mjs', '**/t34-mission-dag-and-briefing.spec.mjs', '**/t35-stepdown-handoff-doctor.spec.mjs', '**/t36-cold-boot-unseeded.spec.mjs', '**/t37-neural-council-router.spec.mjs', '**/t38-values-workspace-trace.spec.mjs', '**/t39-workshop-apply-rollback.spec.mjs', '**/t40-changeset-drift-command-help.spec.mjs', '**/t41-sandbox-test-and-evolution-bridge.spec.mjs', '**/t43-workstation-git-telemetry.spec.mjs'],
  testIgnore: ['**/apex-browser.spec.mjs'],
  // Generated traces/screenshots from a failing run must not be committed.
  outputDir: './test-results/playwright',
  reporter: [['list']],
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  timeout: 90_000,
  expect: { timeout: 15_000 },
});
