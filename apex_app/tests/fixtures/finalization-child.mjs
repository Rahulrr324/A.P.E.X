// TEST FIXTURE for Batch AB: a real process that runs one ordinary verified write through the
// controller and then stops at a chosen boundary of the finalization order. It does not simulate a
// kill inside a syscall; it leaves the durable bytes such a kill leaves, then exits with status 9,
// so the next process has to decide from those bytes alone what is known.
//
//   finalization-child.mjs <boundary> <dataDir> <note>
//
// The boundaries, in the order finalizeOperation runs them:
//   before-audit                          the side effect happened, the audit append never started
//   during-audit                          half an audit line is on disk, with no newline
//   after-audit-before-capture            the audit record is complete, no experience was attempted
//   during-experience-append              half an experience line is on disk, with no newline
//   after-experience-append-before-check  the experience record is complete, its read-back never ran
//   after-verification-before-disclosure  the read-back ran, the caller never returned a result
//   control                               the whole operation completes (a baseline, not an interruption)
//
// A `RESULT` line is written before exiting, when the process gets that far. The interrupted
// boundaries exit before a result is ever assembled, which is what the parent asserts.
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../../src/app.js';
import { CAPTURE_VERIFIED_SUCCESS } from '../../src/experience/capture.js';

const [boundary, dataDir, note] = process.argv.slice(2);
const OPS = path.join(dataDir, 'operations.jsonl');
const EXP = path.join(dataDir, 'experiences.jsonl');

function report(obj) {
  // Synchronous, because the process exits immediately afterwards; a buffered write could be lost.
  fs.writeSync(1, `RESULT ${JSON.stringify(obj)}\n`);
}

function stop(at) {
  report({ boundary, stoppedAt: at });
  process.exit(9);
}

const app = createApp({ dataDir, experienceCapture: CAPTURE_VERIFIED_SUCCESS });

switch (boundary) {
  case 'before-audit':
    app.operations.append = async () => stop('before-audit-append');
    break;
  case 'during-audit':
    app.operations.append = async (record) => {
      const line = JSON.stringify(record);
      fs.appendFileSync(OPS, line.slice(0, Math.max(1, Math.floor(line.length / 2))));
      stop('during-audit-append');
    };
    break;
  case 'after-audit-before-capture':
    app.experience.recordExperience = async () => stop('before-experience-append');
    break;
  case 'during-experience-append':
    app.experience.recordExperience = async ({ operationId }) => {
      fs.appendFileSync(EXP, `{"schema":1,"kind":"experience","operationId":"${operationId}"`);
      stop('during-experience-append');
    };
    break;
  case 'after-experience-append-before-check': {
    const record = app.experience.recordExperience.bind(app.experience);
    app.experience.recordExperience = async (args) => {
      await record(args);
      stop('before-experience-check');
    };
    break;
  }
  case 'after-verification-before-disclosure': {
    const check = app.experience.evidenceCheck.bind(app.experience);
    app.experience.evidenceCheck = async (target) => {
      await check(target);
      stop('before-disclosure');
    };
    break;
  }
  case 'control':
    break;
  default:
    report({ boundary, error: 'unknown boundary' });
    process.exit(2);
}

const res = await app.controller.handle(`remember that ${note}`, { origin: 'user' });
report({
  boundary,
  status: res.status,
  recorded: res.recorded,
  operationId: res.operation.id,
  captured: /Experience: captured automatically/.test(res.display ?? ''),
});
process.exit(0);
