// T-37 Step 4 (2026-11-21): the fixture the neural/Council/router browser walk drives.
//
// Unlike the T-36 fixture this one starts warm, because the walk is not testing setup - it is testing
// what the deck does once Track 2 and the Council are already there. The seed it does add is the one
// thing a walk cannot produce for itself: a substrate that has already stepped, so the eight regions
// have real spike counts and the bridge has a real crossing to report.
//
// Everything else the walk verifies is produced during the walk, by the shipped server and the
// shipped client, against this machine. Nothing here contacts a model or reads a real APEX data
// directory.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../../src/app.js';
import { createUiServer } from '../../src/ui/server.js';
import { ModelGateway, NoBackend } from '../../src/model/gateway.js';

export const T37_TOKEN = 'T37-neural-council-router-token-0123456789';
export const T37_SCHEMA = 'apex.t37.neural-council-router/1';
export const T37_SEED = 't37-real-browser-seed';

// The eight regions, in the order the substrate declares them. The walk checks this list against what
// the deck renders, so a region that stopped being exposed fails the suite rather than silently
// disappearing from a table.
export const T37_REGIONS = ['sensory', 'associative', 'temporal', 'predictive', 'attention', 'working', 'plasticity', 'integration'];

// The eleven canonical screens, in the brief's order.
export const T37_SCREENS = [
  'boot', 'command-deck', 'mission-view', 'briefing', 'workshop', 'memory-timeline',
  'council', 'presence-mesh', 'sentinel', 'policy-autonomy', 'lockdown',
];

export async function startT37Ui({ token = T37_TOKEN, port = 0, seed = T37_SEED } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'apex-t37-e2e-'));
  const dataDir = path.join(root, 'data');
  await fsp.mkdir(dataDir, { recursive: true });

  const app = createApp({
    dataDir,
    gateway: new ModelGateway({ backend: new NoBackend() }),
    neuralSeed: seed,
  });
  const ui = createUiServer({ app, token, host: '127.0.0.1', port });
  let started;
  try {
    started = await ui.start();
  } catch (error) {
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  const base = `http://127.0.0.1:${started.port}`;
  const headers = { authorization: `Bearer ${token}`, 'x-apex-ui': '1' };

  const get = async (pathname) => {
    const response = await fetch(`${base}${pathname}`, { headers });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const post = async (pathname, body) => {
    const response = await fetch(`${base}${pathname}`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };

  // Step the substrate before the browser opens, through the governed capability rather than by
  // reaching into the service. Forty steps is what the assay drive needs to charge the membrane and
  // fire every region.
  const step = await post('/api/neural/step', { steps: 40 });
  if (step.status !== 200 || step.body?.stepVerified !== true) {
    await ui.stop();
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
    throw new Error(`the fixture could not step the substrate: ${step.status} ${JSON.stringify(step.body).slice(0, 200)}`);
  }

  return {
    app,
    ui,
    root,
    dataDir,
    base,
    token,
    headers,
    get,
    post,
    seededStep: step.body,
    async stop() {
      await ui.stop();
      await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
    },
  };
}

// The CDP session's console and error collectors, shared by every phase of the walk so the final
// assertion counts everything the page did rather than only the last screen's noise.
export function attachConsoleCollectors(page) {
  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(String(error?.message ?? error)));
  page.on('requestfailed', (request) => {
    const url = request.url();
    // A favicon that the fixture does not ship is not a console error the deck caused.
    if (url.endsWith('/favicon.ico')) return;
    failedRequests.push(`${request.method()} ${url}: ${request.failure()?.errorText ?? 'failed'}`);
  });
  return { consoleErrors, pageErrors, failedRequests };
}

// Every element that declares a screen, with what it declared. Read from the live DOM so the audit is
// of what the browser parsed, not of what the source file said.
export async function readScreenDeclarations(page) {
  return page.evaluate(() => Array.from(document.querySelectorAll('[data-screen-id]')).map((node) => ({
    id: node.getAttribute('data-screen-id'),
    message: node.getAttribute('data-screen-message'),
    tag: node.tagName.toLowerCase(),
    view: node.getAttribute('data-view'),
    isView: node.classList.contains('view'),
    visible: !!(node.offsetWidth || node.offsetHeight || node.getClientRects().length),
  })));
}

// The horizontal-overflow measurement every suite in this repository uses.
export async function measureOverflow(page) {
  return page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
}
