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
  testMatch: ['**/t31-real-browser.spec.mjs', '**/t32-hud-experience.spec.mjs'],
  testIgnore: ['**/apex-browser.spec.mjs'],
  // Generated traces/screenshots from a failing run must not be committed.
  outputDir: './test-results/playwright',
  reporter: [['list']],
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  timeout: 90_000,
  expect: { timeout: 15_000 },
});
