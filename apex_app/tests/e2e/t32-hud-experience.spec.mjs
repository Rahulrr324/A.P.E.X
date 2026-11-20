// T-32 Step 2 (2026-11-19): the HUD experience, verified in a real browser.
//
// T-31 proved a real Chromium-family binary runs the shipped page. This suite proves the T-32
// claims about that page are true in a computed-style sense rather than in the source:
//
//   * the void is #05080f, the glass planes blur, the panel radius is 2px and every telemetry
//     counter is tabular-nums;
//   * the five depth planes have strictly increasing computed z-index, z0 < z1 < z2 < z3 < z4;
//   * the reticle carries all five data-ring layers, is square, and changes its computed stroke,
//     weight and dash between Idle, Awaiting Approval, Degraded and Lockdown - reached by real
//     state transitions (a pending approval, a stopped stream, the lockdown route, a fresh server);
//   * a live contrast audit of every visible text run against its effective background finds zero
//     runs below 4.5:1;
//   * sequential Tab advances deterministically, is not trapped, keeps the command input ahead of
//     the workspace tabs, and every stop shows a visible focus indicator; Ctrl+K and / focus the
//     dispatch with an acknowledgement inside the 150 ms budget and Escape dismisses it;
//   * the owner's Reduced Motion toggle zeroes continuous animation and transition durations, and
//     so does the operating-system preference;
//   * a PNG per presentation state per viewport (Classic, Tactical, Overwatch, Synthesis, Quiet,
//     Lockdown at 1600x900, 1280x720 and 390x844) is written for the CI artifact.
//
// The suite skips, loudly, when the host has no browser. A skip is not a pass.
import { test, expect } from '@playwright/test';
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBrowser, noBrowserDiagnostic, BROWSER_BINARY_SCHEMA } from '../../src/ui/browser-binary.js';
import { startSeededUi, restartUi, T31_VIEWPORTS } from './t31-fixtures.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const reportDir = path.join(here, '..', '..', 'reports', 'screenshots');
const shotDir = path.join(reportDir, 't32');
const summaryPath = path.join(reportDir, 't32-hud-run.json');
const T32_SCHEMA = 'apex.t32.hud-run/1';
const MODES = ['classic', 'tactical', 'overwatch', 'synthesis', 'quiet'];
const STATES = [...MODES, 'lockdown'];

function playwrightChromiumPath() {
  try {
    return chromium.executablePath();
  } catch {
    return null;
  }
}

const resolution = resolveBrowser({
  platform: process.platform,
  env: process.env,
  playwrightPath: playwrightChromiumPath(),
});

const run = {
  schema: T32_SCHEMA,
  browserBinary: BROWSER_BINARY_SCHEMA,
  resolved: {
    executable: resolution.executable,
    source: resolution.source,
    candidate: resolution.browser?.label ?? null,
  },
  browserVersion: null,
  platform: process.platform,
  node: process.version,
  headless: true,
  viewports: [],
  planes: null,
  design: null,
  reticle: null,
  contrast: [],
  keyboard: null,
  motion: null,
  screenshots: [],
  failures: [],
  startedAt: new Date().toISOString(),
  finishedAt: null,
};

function pngSize(file) {
  const buffer = fs.readFileSync(file);
  const signature = buffer.subarray(0, 8).toString('hex');
  if (signature !== '89504e470d0a1a0a') return { bytes: buffer.length, width: null, height: null, png: false };
  return { bytes: buffer.length, width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), png: true };
}

function writeSummary() {
  run.finishedAt = new Date().toISOString();
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(summaryPath, `${JSON.stringify(run, null, 2)}\n`);
  // One short line first: the long summary can be truncated by the annotation API, and a failure
  // that is cut off is a failure that was not reported.
  console.log(`T32_FAILURES ${JSON.stringify({
    failures: run.failures,
    screenshots: run.screenshots.length,
    contrastChecked: (run.contrast ?? []).reduce((sum, entry) => sum + (entry.checked ?? 0), 0),
    viewports: run.viewports,
  })}`);
  console.log(`T32_HUD_SUMMARY ${JSON.stringify(run)}`);
}

// The page-side audit. It is deliberately conservative in the direction that can only produce a
// false failure, never a false pass: the background used for a text run is the *lightest* colour
// under it (including every stop of every gradient in its ancestry), and alpha from ancestors is
// folded into the text colour before the ratio is taken.
const CONTRAST_AUDIT = () => {
  const parse = (value) => {
    const match = /rgba?\(([^)]+)\)/.exec(String(value || ''));
    if (!match) return null;
    const parts = match[1].split(/[,/\s]+/).filter(Boolean).map(Number);
    if (parts.length < 3 || parts.slice(0, 3).some((n) => !Number.isFinite(n))) return null;
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 && Number.isFinite(parts[3]) ? parts[3] : 1 };
  };
  const channel = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const luminance = (c) => 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
  const over = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  });
  const stops = (image) => {
    const out = [];
    const re = /rgba?\([^)]+\)/g;
    let match;
    while ((match = re.exec(String(image || ''))) !== null) {
      const colour = parse(match[0]);
      if (colour) out.push(colour);
    }
    return out;
  };
  const label = (el) => {
    const id = el.id ? `#${el.id}` : '';
    const cls = typeof el.className === 'string' && el.className.trim()
      ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}`
      : '';
    return `${el.tagName.toLowerCase()}${id}${cls}`;
  };

  const roots = [...document.querySelectorAll('body *')];
  const checked = [];
  const violations = [];
  for (const el of roots) {
    if (el.closest('svg')) continue;
    const ownText = [...el.childNodes]
      .filter((node) => node.nodeType === 3)
      .map((node) => node.textContent.trim())
      .join(' ')
      .trim();
    if (ownText.length < 2) continue;
    if (el.closest('.visually-hidden, [aria-hidden="true"], [disabled], :disabled, .skip-link')) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    if (cs.clip === 'rect(0px, 0px, 0px, 0px)') continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;

    const chain = [];
    for (let node = el; node; node = node.parentElement) chain.unshift(node);
    let bg = { r: 5, g: 8, b: 15, a: 1 };
    let opacity = 1;
    const candidates = [];
    for (const node of chain) {
      const style = getComputedStyle(node);
      const nodeOpacity = Number(style.opacity);
      if (Number.isFinite(nodeOpacity)) opacity *= nodeOpacity;
      const colour = parse(style.backgroundColor);
      if (colour && colour.a > 0) bg = over(colour, bg);
      const image = style.backgroundImage;
      if (image && image !== 'none') {
        for (const stop of stops(image)) {
          if (stop.a > 0) candidates.push(over(stop, bg));
        }
      }
    }
    candidates.push(bg);
    // The lightest background is the worst case for the light-on-dark palette this deck uses.
    const worst = candidates.reduce((a, b) => (luminance(b) > luminance(a) ? b : a));
    const colour = parse(cs.color);
    if (!colour) continue;
    const text = over({ ...colour, a: colour.a * opacity }, worst);
    const ratio = (Math.max(luminance(text), luminance(worst)) + 0.05)
      / (Math.min(luminance(text), luminance(worst)) + 0.05);
    const record = {
      selector: label(el),
      sample: ownText.slice(0, 40),
      ratio: Math.round(ratio * 100) / 100,
      color: cs.color,
      background: `rgb(${Math.round(worst.r)}, ${Math.round(worst.g)}, ${Math.round(worst.b)})`,
      fontSize: cs.fontSize,
    };
    checked.push(record.selector);
    if (ratio < 4.5) violations.push(record);
  }
  return { checked: checked.length, violations };
};

const DESIGN_SNAPSHOT = () => {
  const planeOf = (el) => el?.getAttribute('data-depth-plane') ?? null;
  const planes = new Map();
  for (const el of document.querySelectorAll('[data-depth-plane]')) {
    const plane = planeOf(el);
    const z = Number.parseInt(getComputedStyle(el).zIndex, 10);
    if (!planes.has(plane)) planes.set(plane, []);
    planes.get(plane).push(Number.isFinite(z) ? z : null);
  }
  const planeTable = {};
  for (const [plane, values] of planes.entries()) {
    planeTable[plane] = { count: values.length, zIndexes: [...new Set(values)].sort((a, b) => a - b) };
  }
  const panel = document.querySelector('[data-depth-plane="z3"] .panel');
  const glass = panel ? getComputedStyle(panel) : null;
  const z4 = document.querySelector('#banner[data-depth-plane="z4"]');
  const z4Style = z4 ? getComputedStyle(z4) : null;
  const reticle = document.getElementById('core-reticle');
  const rect = reticle ? reticle.getBoundingClientRect() : null;
  const root = getComputedStyle(document.documentElement);
  const token = (name) => root.getPropertyValue(name).trim();
  const counters = ['#clock', '#gauge-cpu', '#gauge-mem', '#gauge-storage'];
  return {
    bodyBackground: getComputedStyle(document.body).backgroundColor,
    voidToken: token('--bg-void'),
    planes: planeTable,
    glass: glass ? {
      backgroundColor: glass.backgroundColor,
      backdropFilter: glass.backdropFilter,
      borderRadius: glass.borderRadius,
    } : null,
    critical: z4Style ? { backdropFilter: z4Style.backdropFilter, borderRadius: z4Style.borderRadius } : null,
    tabular: counters.map((selector) => ({
      selector,
      fontVariantNumeric: document.querySelector(selector)
        ? getComputedStyle(document.querySelector(selector)).fontVariantNumeric
        : null,
    })),
    reticle: reticle ? {
      rings: [...reticle.querySelectorAll('[data-ring]')].map((node) => node.getAttribute('data-ring')),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      borderRadius: getComputedStyle(reticle).borderRadius,
    } : null,
    motionTokens: {
      ack: token('--motion-ack'),
      panel: token('--motion-panel'),
      posture: token('--motion-posture'),
      reticle: token('--motion-reticle'),
    },
  };
};

const RETICLE_POSTURE = () => {
  const reticle = document.getElementById('core-reticle');
  if (!reticle) return null;
  const azimuthRing = reticle.querySelector('[data-ring="azimuth"] .core-ring');
  const azimuthTick = reticle.querySelector('[data-ring="azimuth"] .reticle-tick');
  const progress = reticle.querySelector('[data-ring="progress"] .reticle-progress');
  const telemetryArc = reticle.querySelector('[data-ring="telemetry"] .reticle-arc');
  const read = (node) => (node ? getComputedStyle(node) : null);
  const azimuth = read(azimuthRing);
  const tick = read(azimuthTick);
  const arc = read(telemetryArc);
  const step = read(progress);
  const wrap = read(reticle.querySelector('.reticle-azimuth'));
  return {
    state: document.body.dataset.coreState,
    caption: (document.getElementById('core-state')?.textContent ?? '').trim(),
    stroke: azimuth?.stroke ?? null,
    weight: azimuth?.strokeWidth ?? null,
    weightPx: (() => {
      const match = /-?[0-9]*\.?[0-9]+/.exec(String(azimuth?.strokeWidth ?? ''));
      return match === null ? null : Number.parseFloat(match[0]);
    })(),
    dash: tick?.strokeDasharray ?? null,
    telemetryDash: arc?.strokeDasharray ?? null,
    progressOffset: step?.strokeDashoffset ?? null,
    animationName: wrap?.animationName ?? null,
    animationDuration: wrap?.animationDuration ?? null,
  };
};

const ACTIVE_ELEMENT = () => {
  const el = document.activeElement;
  if (!el || el === document.body) return { key: '#body', focusVisible: false };
  const cs = getComputedStyle(el);
  const outlineVisible = cs.outlineStyle !== 'none' && Number.parseFloat(cs.outlineWidth) > 0;
  const shadowVisible = cs.boxShadow && cs.boxShadow !== 'none';
  const inTopbar = Boolean(el.closest('.topbar'));
  // The skip link is the first stop by design: it is how a keyboard owner jumps the chrome.
  const isSkipLink = el.classList.contains('skip-link');
  const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/)[0] ?? '' : '';
  // Two controls can share a tag and a class; the nav's fifteen items do. The view they select is
  // what tells them apart, so the key carries it and the trap assertion stops counting them as one.
  const view = el.dataset && el.dataset.view ? `[${el.dataset.view}]` : '';
  return {
    key: `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${cls ? `.${cls}` : ''}${view}`,
    inTopbar,
    isSkipLink,
    isNavItem: el.classList.contains('nav-item'),
    focusVisible: Boolean(outlineVisible || shadowVisible),
    outlineStyle: cs.outlineStyle,
    outlineWidth: cs.outlineWidth,
    boxShadow: cs.boxShadow,
  };
};

let handle = null;
let idleHandle = null;
let browser = null;

async function openDeck(page, viewport) {
  if (viewport) await page.setViewportSize({ width: viewport.width, height: viewport.height });
  await page.goto(`${handle.base}/?token=${encodeURIComponent(handle.token)}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForSelector('#main-content', { timeout: 20_000 });
  await page.waitForFunction(() => {
    const boot = document.getElementById('boot');
    return !boot || boot.classList.contains('hidden') || boot.hidden === true;
  }, null, { timeout: 30_000 });
}

async function setState(page, state) {
  await page.waitForFunction((want) => document.body.dataset.coreState === want, state, { timeout: 30_000 });
}

async function lockDown(page, reason) {
  const locked = await page.evaluate(async (text) => {
    const response = await fetch('/api/safety/lockdown', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-apex-ui': '1' },
      body: JSON.stringify({ reason: text }),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  }, reason);
  expect(locked.status, JSON.stringify(locked.body)).toBe(200);
  await setState(page, 'lockdown');
}

async function releaseLockdown(page, reason) {
  const released = await page.evaluate(async (text) => {
    const response = await fetch('/api/safety/release', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-apex-ui': '1' },
      body: JSON.stringify({ reason: text, confirm: true }),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  }, reason);
  expect(released.status, JSON.stringify(released.body)).toBe(200);
  await page.waitForFunction(() => document.body.dataset.coreState !== 'lockdown', null, { timeout: 20_000 });
}

test.describe('T-32 HUD experience', () => {
  test.skip(resolution.executable === null, noBrowserDiagnostic(resolution));

  test.beforeAll(async () => {
    // No binary: nothing to launch, and the skip below carries the diagnostic.
    if (resolution.executable === null) return;
    fs.mkdirSync(shotDir, { recursive: true });
    handle = await startSeededUi();
    // A second, unseeded server: no pending approval and nothing paused, which is what the Core
    // needs in order to be genuinely Idle. The posture is read from that live page, not by writing
    // a data attribute into this one.
    idleHandle = await startSeededUi({ token: 'T32-idle-deck-token-0123456789', seedData: false });
    browser = await chromium.launch({ executablePath: resolution.executable, headless: true });
    run.browserVersion = browser.version();
    run.checks = { seeded: handle.seed };
  });

  // A failure's own words travel in the summary: the workflow annotation is the only channel this
  // environment can read back, and a title alone does not say what the browser disagreed with.
  test.afterEach(async ({}, testInfo) => {
    if (testInfo.status !== testInfo.expectedStatus) {
      const message = (testInfo.errors ?? []).map((error) => error.message ?? String(error)).join(' | ');
      run.failures.push({ title: testInfo.title, status: testInfo.status, message: message.slice(0, 900) });
    }
  });

  test.afterAll(async () => {
    if (browser) await browser.close().catch(() => {});
    if (idleHandle) await idleHandle.stop().catch(() => {});
    if (handle) await handle.stop().catch(() => {});
    writeSummary();
  });

  test('void, glass, depth planes and tabular numerals are computed at three viewports', async () => {
    const results = [];
    for (const viewport of T31_VIEWPORTS) {
      const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
      const page = await context.newPage();
      try {
        await openDeck(page);
        const snapshot = await page.evaluate(DESIGN_SNAPSHOT);
        results.push({ viewport, snapshot });
        expect(snapshot.voidToken.toLowerCase(), `--bg-void at ${viewport.name}`).toBe('#05080f');
        // Chromium reports the computed background-color as an rgb() triple.
        expect(snapshot.bodyBackground.replace(/\s+/g, ' '), `body background at ${viewport.name}`)
          .toBe('rgb(5, 8, 15)');
        expect(snapshot.glass, 'the z3 glass plane exists').not.toBeNull();
        expect(snapshot.glass.backdropFilter, `z3 backdrop-filter at ${viewport.name}`).toContain('blur(');
        expect(snapshot.glass.borderRadius, `z3 panel radius at ${viewport.name}`).toBe('2px');
        expect(snapshot.glass.backgroundColor.replace(/\s+/g, ' '), `z3 glass colour at ${viewport.name}`)
          .toBe('rgba(12, 28, 48, 0.55)');
        expect(snapshot.critical?.backdropFilter ?? '', 'the z4 plane blurs').toContain('blur(');
        for (const counter of snapshot.tabular) {
          expect(counter.fontVariantNumeric, `${counter.selector} is tabular at ${viewport.name}`)
            .toContain('tabular-nums');
        }
        for (const plane of ['z0', 'z1', 'z2', 'z3', 'z4']) {
          expect(snapshot.planes[plane], `plane ${plane} exists at ${viewport.name}`).toBeTruthy();
        }
        const zOf = (plane) => Math.max(...snapshot.planes[plane].zIndexes);
        expect(zOf('z0'), 'z0 < z1').toBeLessThan(zOf('z1'));
        expect(zOf('z1'), 'z1 < z2').toBeLessThan(zOf('z2'));
        expect(zOf('z2'), 'z2 < z3').toBeLessThan(zOf('z3'));
        expect(zOf('z3'), 'z3 < z4').toBeLessThan(zOf('z4'));
        expect(snapshot.reticle, 'the reticle is present').not.toBeNull();
        expect(snapshot.reticle.rings.sort()).toEqual(['azimuth', 'brackets', 'nucleus', 'progress', 'telemetry']);
        expect(snapshot.reticle.width, `the reticle is square at ${viewport.name}`)
          .toBe(snapshot.reticle.height);
        expect(snapshot.reticle.width).toBeGreaterThan(0);
        expect(['0px', '50%'], `reticle radius at ${viewport.name}`).toContain(snapshot.reticle.borderRadius);
        expect(snapshot.motionTokens).toEqual({
          ack: '120ms', panel: '260ms', posture: '700ms', reticle: '380ms',
        });
      } finally {
        await context.close();
      }
    }
    run.design = results.map(({ viewport, snapshot }) => ({ viewport: viewport.name, ...snapshot }));
    run.planes = Object.fromEntries(results.map(({ viewport, snapshot }) => [viewport.name, snapshot.planes]));
  });

  test('the reticle posture differs between Idle, Awaiting Approval, Degraded and Lockdown', async () => {
    const captured = {};
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();
    try {
      await openDeck(page);
      await setState(page, 'awaiting_approval');
      captured.awaiting_approval = await page.evaluate(RETICLE_POSTURE);

      // Degraded is a real stream failure, not a class name: the server stops and the client's
      // watchdog has to notice on its own.
      await handle.stopServer();
      await setState(page, 'degraded');
      captured.degraded = await page.evaluate(RETICLE_POSTURE);
      handle = await restartUi(handle);
      await setState(page, 'awaiting_approval');

      await lockDown(page, 'T-32 Step 2: reticle posture check');
      captured.lockdown = await page.evaluate(RETICLE_POSTURE);
      expect(captured.lockdown.stroke, 'lockdown reticle is the alarm colour').toContain('225, 6, 0');
      expect(captured.lockdown.animationName, 'lockdown stops the continuous layers').toBe('none');
      await releaseLockdown(page, 'T-32 Step 2: reticle posture check complete');
      await setState(page, 'awaiting_approval');
    } finally {
      await context.close();
    }

    // Idle: the second, unseeded server. The page renders Idle because nothing is pending there.
    const idleContext = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const idlePage = await idleContext.newPage();
    try {
      const previous = handle;
      handle = idleHandle;
      try {
        await openDeck(idlePage);
        await setState(idlePage, 'idle');
        captured.idle = await idlePage.evaluate(RETICLE_POSTURE);
      } finally {
        handle = previous;
      }
    } finally {
      await idleContext.close();
    }

    expect(captured.idle.caption).toMatch(/idle/i);
    expect(captured.awaiting_approval.caption).toMatch(/awaiting/i);
    expect(captured.idle.stroke, 'idle is the cyan posture').toContain('0, 229, 255');
    expect(captured.awaiting_approval.stroke, 'awaiting approval is the gold posture').toContain('255, 176, 0');

    const signature = (posture) => [posture.stroke, posture.weight, posture.dash, posture.telemetryDash].join('|');
    const signatures = Object.entries(captured).map(([state, posture]) => [state, signature(posture)]);
    expect(new Set(signatures.map(([, sig]) => sig)).size, `distinct postures: ${JSON.stringify(signatures)}`)
      .toBe(signatures.length);
    const weights = Object.values(captured).map((posture) => posture.weightPx);
    expect(weights.every((weight) => Number.isFinite(weight) && weight > 0),
      `stroke weights were not numbers: ${JSON.stringify(weights)} in ${JSON.stringify(captured)}`).toBe(true);
    expect(new Set(weights).size, `the posture weights are distinct: ${weights.join(', ')}`).toBeGreaterThan(1);
    run.reticle = captured;
  });

  test('the live contrast audit finds zero text runs below 4.5:1', async () => {
    const audits = [];
    for (const viewport of T31_VIEWPORTS) {
      const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
      const page = await context.newPage();
      try {
        await openDeck(page);
        // Every workspace in turn, so the audit covers the surfaces a reviewer has to read.
        const views = await page.evaluate(() => [...document.querySelectorAll('nav .nav-item')].map((node) => node.dataset.view));
        for (const view of [...views, 'deck']) {
          // `body` carries data-view too, so the selector has to name the navigation item.
          await page.locator(`nav .nav-item[data-view="${view}"]`).first().click();
          await expect(page.locator('body')).toHaveAttribute('data-view', view);
          const audit = await page.evaluate(CONTRAST_AUDIT);
          audits.push({ viewport: viewport.name, view, ...audit });
          expect(audit.checked, `the audit actually ran on ${view} at ${viewport.name}`).toBeGreaterThan(10);
          expect(audit.violations, `contrast violations on ${view} at ${viewport.name}: ${JSON.stringify(audit.violations.slice(0, 5))}`)
            .toEqual([]);
        }
        // The alarm palette is audited too, once per viewport: lockdown changes the text tokens, so
        // a pass in Classic says nothing about it.
        await page.locator('nav .nav-item[data-view="deck"]').first().click();
        await lockDown(page, 'T-32 Step 2: contrast audit under lockdown');
        const alarmAudit = await page.evaluate(CONTRAST_AUDIT);
        audits.push({ viewport: viewport.name, view: 'deck+lockdown', ...alarmAudit });
        expect(alarmAudit.checked, `the lockdown audit ran at ${viewport.name}`).toBeGreaterThan(5);
        expect(alarmAudit.violations, `lockdown contrast violations at ${viewport.name}: ${JSON.stringify(alarmAudit.violations.slice(0, 5))}`)
          .toEqual([]);
        await releaseLockdown(page, 'T-32 Step 2: contrast audit complete');
      } finally {
        await context.close();
      }
    }
    run.contrast = audits.map((audit) => ({
      viewport: audit.viewport, view: audit.view, checked: audit.checked, violations: audit.violations.length,
    }));
  });

  test('Tab is deterministic and untrapped, the command input precedes the tabs, Ctrl+K acks, Escape dismisses', async () => {
    test.setTimeout(180_000);
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();
    const sweepOnce = async () => {
      await openDeck(page);
      const stops = [];
      for (let index = 0; index < 14; index += 1) {
        await page.keyboard.press('Tab');
        stops.push(await page.evaluate(ACTIVE_ELEMENT));
      }
      return stops;
    };
    try {
      const first = await sweepOnce();
      const second = await sweepOnce();
      expect(second.map((stop) => stop.key), 'the sweep is deterministic').toEqual(first.map((stop) => stop.key));

      const keys = first.map((stop) => stop.key);
      expect(new Set(keys).size, `Tab is trapped or repeats a stop: ${keys.join(' > ')}`).toBe(keys.length);
      const inputAt = keys.findIndex((key) => key.startsWith('textarea#chat-text'));
      const firstNavAt = first.findIndex((stop) => stop.isNavItem);
      expect(inputAt, `the command input is in the sweep: ${keys.join(' > ')}`).toBeGreaterThanOrEqual(0);
      expect(firstNavAt, `the workspace tabs are in the sweep: ${keys.join(' > ')}`).toBeGreaterThan(inputAt);
      expect(first.slice(0, inputAt).every((stop) => stop.inTopbar || stop.isSkipLink || stop.key === '#body'),
        `every stop before the input is the skip link or in the top bar: ${keys.join(' > ')}`).toBe(true);
      const invisible = first.filter((stop) => stop.key !== '#body' && !stop.focusVisible);
      expect(invisible, `stops without a visible focus indicator: ${JSON.stringify(invisible)}`).toEqual([]);

      // Ctrl+K from inside a field still reaches the dispatch, and the reticle answers inside 150 ms.
      await page.evaluate(() => {
        window.__t32ack = { at: null };
        const reticle = document.getElementById('core-reticle');
        new MutationObserver(() => {
          if (reticle.dataset.ackState === 'active' && window.__t32ack.at === null) {
            window.__t32ack.at = performance.now();
          }
        }).observe(reticle, { attributes: true, attributeFilter: ['data-ack-state'] });
      });
      await page.locator('body').press('Control+k');
      await expect(page.locator('#chat-text')).toBeFocused();
      const ack = await page.evaluate(() => ({
        at: window.__t32ack.at,
        state: document.getElementById('core-reticle').dataset.ackState,
        count: document.getElementById('core-reticle').dataset.ackCount,
      }));
      expect(ack.at, 'the reticle acknowledged the chord').not.toBeNull();
      expect(ack.count).toBe('1');
      // The chord's own acknowledgement budget is measured in the next test, inside the page, where
      // the number is the handler's latency rather than a cross-process round trip.
      await page.waitForTimeout(400);
      expect(await page.evaluate(() => document.getElementById('core-reticle').dataset.ackState)).not.toBe('active');

      await page.keyboard.press('Escape');
      const afterEscape = await page.evaluate(ACTIVE_ELEMENT);
      expect(afterEscape.key, 'Escape dismisses the dispatch').not.toMatch(/chat-text/);

      // The slash key opens the dispatch from the page body, and does not type a slash into it.
      await page.locator('body').press('/');
      await expect(page.locator('#chat-text')).toBeFocused();
      expect(await page.locator('#chat-text').inputValue()).toBe('');

      run.keyboard = {
        stops: keys,
        ackState: ack.state,
        ackCount: ack.count,
        ackObserverAt: ack.at,
        inputBeforeTabs: firstNavAt > inputAt,
        focusIndicators: first.map((stop) => ({ key: stop.key, focusVisible: stop.focusVisible })),
        escapeTo: afterEscape.key,
      };
    } finally {
      await context.close();
    }
  });

  test('a <150 ms acknowledgement is measured from the key press, not from a later frame', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();
    try {
      await openDeck(page);
      const measured = await page.evaluate(async () => {
        const reticle = document.getElementById('core-reticle');
        const start = performance.now();
        // Dispatch the chord from inside the page so the measurement is the handler's own latency
        // plus the acknowledgement write, with no cross-process hop in the number.
        document.body.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'k', ctrlKey: true, bubbles: true, cancelable: true,
        }));
        const active = document.activeElement?.id ?? null;
        const elapsed = performance.now() - start;
        return { elapsed, ackState: reticle.dataset.ackState, ackCount: reticle.dataset.ackCount, active };
      });
      expect(measured.ackState, 'the reticle is acknowledged synchronously').toBe('active');
      expect(measured.active, 'the dispatch took focus').toBe('chat-text');
      expect(measured.elapsed, `acknowledgement took ${measured.elapsed} ms`).toBeLessThan(150);
      run.keyboard = { ...(run.keyboard ?? {}), inPageAckMs: Math.round(measured.elapsed * 100) / 100 };
    } finally {
      await context.close();
    }
  });

  test('reduced motion, by toggle and by system preference, zeroes animation and transition', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();
    try {
      await openDeck(page);
      const read = () => page.evaluate(() => {
        const azimuth = document.querySelector('#core-reticle .reticle-azimuth');
        const panel = document.querySelector('[data-depth-plane="z3"] .panel');
        return {
          motion: document.body.dataset.motion,
          pressed: document.getElementById('motion-toggle')?.getAttribute('aria-pressed') ?? null,
          azimuthAnimation: getComputedStyle(azimuth).animationName,
          azimuthDuration: getComputedStyle(azimuth).animationDuration,
          panelTransition: getComputedStyle(panel).transitionDuration,
        };
      });
      const full = await read();
      expect(full.motion).toBe('full');
      expect(full.azimuthAnimation).toBe('spin');
      await page.locator('#motion-toggle').click();
      await expect(page.locator('body')).toHaveAttribute('data-motion', 'reduced');
      const reduced = await read();
      expect(reduced.pressed).toBe('true');
      expect(reduced.azimuthAnimation, 'the toggle stops continuous animation').toBe('none');
      expect(reduced.panelTransition.split(',').every((value) => value.trim() === '0s'),
        `transition durations under the toggle: ${reduced.panelTransition}`).toBe(true);
      await page.locator('#motion-toggle').click();
      await expect(page.locator('body')).toHaveAttribute('data-motion', 'full');
      expect((await read()).azimuthAnimation).toBe('spin');
      run.motion = { toggle: { full, reduced } };
    } finally {
      await context.close();
    }

    const systemContext = await browser.newContext({ viewport: { width: 1280, height: 720 }, reducedMotion: 'reduce' });
    const systemPage = await systemContext.newPage();
    try {
      await openDeck(systemPage);
      const system = await systemPage.evaluate(() => {
        const azimuth = document.querySelector('#core-reticle .reticle-azimuth');
        const panel = document.querySelector('[data-depth-plane="z3"] .panel');
        return {
          mediaMatches: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
          azimuthAnimation: getComputedStyle(azimuth).animationName,
          panelTransition: getComputedStyle(panel).transitionDuration,
          hudGridOpacity: getComputedStyle(document.getElementById('hud-grid')).opacity,
        };
      });
      expect(system.mediaMatches, 'the emulated preference is live').toBe(true);
      expect(system.azimuthAnimation, 'the system preference stops continuous animation').toBe('none');
      expect(system.panelTransition.split(',').every((value) => value.trim() === '0s'),
        `transition durations under the system preference: ${system.panelTransition}`).toBe(true);
      run.motion = { ...(run.motion ?? {}), system };
    } finally {
      await systemContext.close();
    }
  });

  test('every presentation state is captured at every viewport, for the artifact', async () => {
    test.setTimeout(240_000);
    for (const viewport of T31_VIEWPORTS) {
      const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
      const page = await context.newPage();
      try {
        console.log(`T32_PHASE screenshots:start ${viewport.width}x${viewport.height}`);
        await openDeck(page);
        await setState(page, 'awaiting_approval');
        for (const mode of MODES) {
          await page.selectOption('#mode-select', mode);
          await expect(page.locator('body')).toHaveAttribute('data-mode', mode);
          // One frame of settle so the screenshot is the mode, not the transition into it.
          await page.waitForTimeout(120);
          const file = path.join(shotDir, `t32_${mode}_${viewport.width}x${viewport.height}.png`);
          await page.screenshot({ path: file, fullPage: false });
          const size = pngSize(file);
          expect(size.png, `${mode} screenshot is a real PNG: ${JSON.stringify(size)}`).toBe(true);
          expect(size.width).toBe(viewport.width);
          expect(size.height).toBe(viewport.height);
          run.screenshots.push({
            state: mode,
            viewport: `${viewport.width}x${viewport.height}`,
            file: path.relative(path.join(here, '..', '..'), file),
            ...size,
          });
        }
        await lockDown(page, 'T-32 Step 2: lockdown screenshot');
        await expect(page.locator('body')).toHaveAttribute('data-mode', 'lockdown');
        await page.waitForTimeout(120);
        const file = path.join(shotDir, `t32_lockdown_${viewport.width}x${viewport.height}.png`);
        await page.screenshot({ path: file, fullPage: false });
        const size = pngSize(file);
        expect(size.png, `lockdown screenshot is a real PNG: ${JSON.stringify(size)}`).toBe(true);
        run.screenshots.push({
          state: 'lockdown',
          viewport: `${viewport.width}x${viewport.height}`,
          file: path.relative(path.join(here, '..', '..'), file),
          ...size,
        });
        await releaseLockdown(page, 'T-32 Step 2: lockdown screenshot complete');
        console.log(`T32_PHASE screenshots:done ${viewport.width}x${viewport.height} shots=${run.screenshots.length}`);
      } finally {
        await context.close();
      }
    }
    const states = new Set(run.screenshots.map((shot) => shot.state));
    for (const state of STATES) expect(states.has(state), `a ${state} capture exists`).toBe(true);
    expect(run.screenshots.length).toBe(STATES.length * T31_VIEWPORTS.length);
    run.viewports = T31_VIEWPORTS.map((viewport) => `${viewport.width}x${viewport.height}`);
  });
});
