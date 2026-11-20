#!/usr/bin/env node
// Starts the local APEX web interface. Run from the apex_app directory:
//   node bin/apex-serve.js
//
// It serves one loopback address with a per-process access token, prints the URL that
// contains the token, and stops cleanly on Ctrl+C. It opens no outbound connection and
// configures no model: with no model endpoint set, the same deterministic answers the CLI
// gives are what the page shows.
import { createAppFromEnv } from '../src/app.js';
import { createUiServer } from '../src/ui/server.js';

const DEFAULT_PORT = 8787;
// The interface is loopback-only by default. APEX_UI_HOST exists only so a sandboxed preview
// environment can proxy the page in from outside the process's own network namespace; every request
// is still gated by the per-process token, and the printed line says which address is bound.
const LOOPBACK = '127.0.0.1';
const ALLOWED_HOSTS = new Set([LOOPBACK, '0.0.0.0']);

function hostFromEnv(value) {
  if (value === undefined || value === '') return LOOPBACK;
  if (!ALLOWED_HOSTS.has(value)) {
    throw new Error(`APEX_UI_HOST must be ${[...ALLOWED_HOSTS].join(' or ')}, not "${value}"`);
  }
  return value;
}

function portFromEnv(value) {
  if (value === undefined || value === '') return DEFAULT_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`APEX_UI_PORT must be a whole number from 0 to 65535, not "${value}"`);
  }
  return port;
}

async function main() {
  const port = portFromEnv(process.env.APEX_UI_PORT);
  const host = hostFromEnv(process.env.APEX_UI_HOST);
  const { config, ...app } = createAppFromEnv(process.env);
  const ui = createUiServer({ app, host, port, allowNonLoopback: host !== LOOPBACK });

  const stopping = [];
  const stop = async (signal) => {
    if (stopping.length > 0) return;
    stopping.push(signal);
    await ui.stop();
    process.stdout.write(`\nAPEX interface stopped (${signal}). Data directory: ${config.dataDir}\n`);
    process.exitCode = 0;
  };
  process.on('SIGINT', () => { stop('SIGINT').catch((err) => { process.stderr.write(`fatal: ${err.message}\n`); process.exitCode = 1; }); });
  process.on('SIGTERM', () => { stop('SIGTERM').catch((err) => { process.stderr.write(`fatal: ${err.message}\n`); process.exitCode = 1; }); });

  let started;
  try {
    started = await ui.start();
  } catch (err) {
    throw new Error(err?.code === 'EADDRINUSE'
      ? `port ${port} is already in use; set APEX_UI_PORT to another port or 0 to pick a free one`
      : `cannot start the interface: ${err?.message ?? err}`);
  }

  const model = typeof app.gateway?.describe === 'function' ? app.gateway.describe() : null;
  process.stdout.write([
    host === LOOPBACK ? 'APEX local interface (loopback only).' : `APEX interface bound to ${host} (preview proxy mode; the token still gates every request).`,
    `Open: ${started.url}`,
    `Data directory: ${config.dataDir}`,
    `Model: ${model?.configured ? 'configured; the page sends requests exactly as the CLI does' : 'none configured; answers come from the deterministic path'}`,
    'The URL contains this process\'s access token. Every request needs it.',
    'Press Ctrl+C to stop.',
    '',
  ].join('\n'));
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err?.message ?? err}\n`);
  process.exitCode = 1;
});
