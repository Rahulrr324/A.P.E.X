// Test fixture for Batch AN work package E: a real APEX process that runs `plan continue` against a
// run another process left interrupted. Spawned concurrently by tests/continuation-cross-process-an.test.js
// to show what two processes attempting the same continuation actually do.
//
//   continue-child.mjs <dataDir> <planId> [startDelayMs]
//
// The fixture capabilities are the same probes tests/fixtures/continuation-child.mjs registers: each
// leaves one observable line in the side-effect file, so "did any step run twice" is answered by the
// bytes on disk rather than by the process's own claim. TEST FIXTURE: nothing here is evidence about
// a real capability, and no model is contacted (the gateway is the no-backend one).
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../../src/app.js';
import { NoBackend, ModelGateway } from '../../src/model/gateway.js';
import { CAPTURE_OFF } from '../../src/experience/capture.js';

const [dataDir, planId, delayArg = '0'] = process.argv.slice(2);
if (!dataDir || !planId) {
  process.stderr.write('usage: continue-child.mjs <dataDir> <planId> [startDelayMs]\n');
  process.exit(2);
}

function report(obj) {
  fs.writeSync(1, `RESULT ${JSON.stringify(obj)}\n`);
}

function probeAction(name, permission, mark) {
  const effectFile = path.join(dataDir, 'effects.txt');
  return {
    name,
    description: `fixture ${permission} that leaves one observable line behind`,
    inputHint: '{"tag":"text"}',
    permission,
    origins: permission === 'write' ? ['user'] : ['user', 'model'],
    validate: (input) => ({ tag: String(input?.tag ?? 'x').trim() }),
    async execute(_ctx, input) {
      fs.appendFileSync(effectFile, `${mark(input.tag)}\n`);
      return { summary: `${name} ${input.tag}`, data: { tag: input.tag, effect: mark(input.tag) } };
    },
    async verify(_ctx, input, result) {
      const want = mark(String(input?.tag ?? result?.data?.tag ?? ''));
      const lines = fs.existsSync(effectFile)
        ? fs.readFileSync(effectFile, 'utf8').split('\n').filter((l) => l.trim() !== '')
        : [];
      return lines.includes(want)
        ? { ok: true, detail: `the side-effect file holds ${want}` }
        : { ok: false, detail: `the side-effect file holds no ${want}` };
    },
  };
}

const delay = Number(delayArg);
if (Number.isFinite(delay) && delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));

const app = await createApp({
  dataDir,
  gateway: new ModelGateway({ backend: new NoBackend() }),
  experienceCapture: CAPTURE_OFF,
  extraActions: [
    probeAction('probe.note', 'write', (tag) => tag),
    probeAction('probe.peek', 'read', (tag) => `read:${tag}`),
  ],
});

let res;
try {
  res = await app.controller.planContinue(planId);
} catch (err) {
  report({ threw: String(err?.message ?? err) });
  process.exit(3);
}
report({
  status: res.status,
  ran: Array.isArray(res.ran) ? res.ran : null,
  display: String(res.display ?? res.output ?? '').slice(0, 1200),
});
process.exit(0);
