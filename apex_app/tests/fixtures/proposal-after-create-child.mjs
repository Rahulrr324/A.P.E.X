// TEST FIXTURE for Batch AO Package H: a real APEX process that records one model-origin proposal
// and is then terminated by its parent. Spawned by tests/cross-process-ao09.test.js and nothing else.
//
//   proposal-after-create-child.mjs <dataDir>
//
// The proposal is written through the real proposal store. After that call returned, the fixture
// acquires the store's real write claim and blocks inside it, so termination leaves both a durable
// `proposal_created` event with no decision and a genuine claim file the next writer must take
// over. This is what a process killed inside a later store write leaves; the claim is created by
// the real WriterLock protocol, not fabricated.
//
// READY is printed with the id only from inside the held claim, so the parent's kill happens at
// the boundary the test names. The fixture never decides the proposal itself.
//
// TEST FIXTURE: `advice` is a synthetic proposal, not a model call. No backend is contacted.
import fs from 'node:fs';
import { createApp } from '../../src/app.js';
import { NoBackend, ModelGateway } from '../../src/model/gateway.js';
import { CAPTURE_OFF } from '../../src/experience/capture.js';

const [dataDir] = process.argv.slice(2);
if (!dataDir) {
  process.stderr.write('usage: proposal-after-create-child.mjs <dataDir>\n');
  process.exit(2);
}

const app = createApp({
  dataDir,
  now: () => new Date('2026-06-01T00:00:00.000Z'),
  gateway: new ModelGateway({ backend: new NoBackend() }),
  experienceCapture: CAPTURE_OFF,
});

const created = await app.proposals.createProposal({
  kind: 'advice',
  title: 'a suggestion recorded before the process was lost',
  rationale: 'the model suggests a next step; the user decides',
  changes: { summary: 'review the recorded suggestion before acting on it' },
  validation: { ok: true, problems: [] },
});

// Synchronous, because the parent kills this process on the marker; a buffered write could be lost.
// The claim is held while READY is printed, so the kill lands inside a real writer claim.
await app.proposals.lock.run(async () => {
  fs.writeSync(1, `READY ${created.proposal.id}\n`);
  // A ref'd timer keeps the loop alive while the claim is held, so the parent can terminate this
  // process inside the critical section.
  setInterval(() => {}, 500);
  await new Promise(() => {});
});
