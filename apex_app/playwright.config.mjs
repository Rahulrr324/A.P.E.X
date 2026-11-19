// T-25 browser validation. Playwright is a development-only dependency and is never part of
// the application runtime: `apex_app` declares no runtime dependencies.
//
// The suite starts its own `bin/apex-serve.js` on an ephemeral loopback port with an isolated
// temporary APEX data directory, so no real user data is read or written.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.mjs',
  // Generated traces/screenshots from a failing run must not be committed.
  outputDir: './test-results/playwright',
  reporter: [['list']],
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  timeout: 90_000,
  expect: { timeout: 15_000 },
});
