// T-16 pilot reporting: measurements must be numbers the run actually took.
//
// The pilot printed "[object Promise] interface process memory" because the security scenario
// recorded the unawaited operating-system read. It then printed "0 bytes" after the fix, because
// the process had already been stopped and PowerShell's blank reply coerces to 0. Both made a
// measurement that was never taken look like a published figure. This drives the real runner and
// the real operating-system read.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { processMemoryBytes } from '../pilot/harness.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function runPilot(...args) {
  const run = spawnSync(process.execPath, [path.join(ROOT, 'pilot', 'run.js'), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 300000,
    windowsHide: true,
  });
  return { code: run.status, stdout: run.stdout ?? '', stderr: run.stderr ?? '' };
}

describe('pilot measurements', () => {
  test('the security scenario publishes a real resident-byte reading', () => {
    const { code, stdout, stderr } = runPilot('--id', 'sec-01');
    assert.equal(code, 0, stderr || stdout.slice(-12000));
    assert.doesNotMatch(stdout, /\[object Promise\]/);
    assert.doesNotMatch(stdout, /\bn\/a\b/);
    const line = stdout.split('\n').find((row) => row.includes('interface process memory')) ?? '';
    assert.ok(line, 'the measurement line is present');
    assert.match(line, /sec-01-local-ui-boundaries\s+\d+\s+bytes\s+interface process memory/);
    const bytes = Number(line.match(/\s(\d+)\s+bytes\s+interface process memory/)[1]);
    assert.ok(bytes > 1024 * 1024, `a live interface uses more than 1 MiB, saw ${bytes}`);
  });

  test('the operating-system read distinguishes a live process from an unavailable one', async () => {
    const own = await processMemoryBytes(process.pid);
    assert.equal(typeof own, 'number', 'the current process has a readable working set');
    assert.ok(own > 1024 * 1024);
    const absent = await processMemoryBytes(0x7ffffff0);
    assert.equal(absent, null, 'a process the operating system cannot report is null, never 0');
  });
});
