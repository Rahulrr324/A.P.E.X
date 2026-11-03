// TEST FIXTURE for the concurrent plan decision scenario. Spawned in pairs by
// tests/executive-reliability.test.js so approval and revision really run in separate processes.
//
//   node exec-pair-child.mjs <dataDir> approve <planId>
//   node exec-pair-child.mjs <dataDir> revise <planId>
import { createApp } from '../../src/app.js';
import { CAPTURE_OFF } from '../../src/experience/capture.js';

const [dataDir, action, planId] = process.argv.slice(2);
if (!dataDir || !action || !planId) {
  process.stderr.write('usage: exec-pair-child.mjs <dataDir> <approve|revise> <planId>\n');
  process.exit(2);
}

const app = createApp({ dataDir, experienceCapture: CAPTURE_OFF });

const res = action === 'approve'
  ? await app.controller.planApprove({ target: planId })
  : await app.controller.planRevise({
    target: planId,
    outcome: 'the revised list is returned',
    steps: [{
      id: 's1',
      description: 'list the stored memory again',
      action: 'memory.list',
      input: { limit: 3 },
      dependsOn: [],
      expectedResult: 'a bounded list is returned',
      verification: 'the list read succeeds',
      criterion: 'c1',
      risk: 'low',
    }],
    reason: 'concurrent revision',
  });

process.stdout.write(`${JSON.stringify({ status: res.status })}\n`);
process.exit(res.status === 'success_verified' || String(res.status).startsWith('plan_') ? 0 : 1);
