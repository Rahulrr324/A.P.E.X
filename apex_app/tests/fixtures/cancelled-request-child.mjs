// Test fixture for Batch AO Package C: a real APEX process terminated while a model request is in
// flight. Spawned by tests/cognition-lifecycle.test.js and by nothing else.
//
//   node cancelled-request-child.mjs <data dir>
//
// The backend is a fixed-output stub that never answers; it prints MODEL-STARTED once the ordinary
// controller path has reached the model. The parent terminates the process there. Nothing is written
// to the audit log by this fixture itself: an operation record is produced only at finalization.
//
// TEST FIXTURE: this is not a model and its output is not evidence about inference.
import { createApp } from '../../src/app.js';
import { ModelGateway } from '../../src/model/gateway.js';

const [dataDir] = process.argv.slice(2);
if (!dataDir) {
  process.stderr.write('usage: cancelled-request-child.mjs <dataDir>\n');
  process.exit(2);
}

const gateway = new ModelGateway({
  backend: {
    name: 'hang-reply',
    provider: 'hang-reply',
    configured: true,
    describe: () => ({ configured: true, provider: 'hang-reply', endpoint: 'hang-reply', model: 'hang-reply' }),
    health: async () => ({ available: true, detail: 'stub reply' }),
    async complete() {
      process.stdout.write('MODEL-STARTED\n');
      // A ref'd timer keeps the process alive while the promise never settles, so the parent can
      // terminate it at the model boundary.
      setInterval(() => {}, 500);
      await new Promise(() => {});
    },
  },
});

const app = createApp({ dataDir, gateway });
await app.controller.handle('tell me something about the sky', { origin: 'user' });
