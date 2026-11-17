// T-15 operational regression. The CLI help names options with values. An option that is missing
// from the parser's value list is not rejected as unknown: it becomes a switch and its value
// becomes a stray positional, so the command still refuses but with a generic usage line that
// hides the real cause. These tests drive the documented commands end to end through the real
// entry point, so a future option added without its value is caught here rather than by a user.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTempDataDir, cleanup, runCli, cleanEnv } from './helpers.js';

function fixture(t) {
  const dir = makeTempDataDir();
  t.after(() => cleanup(dir));
  return { dir, env: cleanEnv({ APEX_DATA_DIR: dir, HOME: dir, USERPROFILE: dir }) };
}

test('the documented situation ingest and decide commands accept their documented flags', async (t) => {
  const { env } = fixture(t);

  const ingest = await runCli([
    'situation', 'ingest',
    '--source', 'user', '--source-id', 'ux-1',
    '--type', 'observation', '--category', 'observation',
    '--payload', '{"summary":"the printer lease was renewed by the office manager"}',
    '--confidence', '0.8',
    '--observed-at', '2026-01-05T09:00:00.000Z', '--valid-until', '2099-01-01T00:00:00.000Z',
    '--operation-id', 'op-1', '--reporter', 'night desk',
  ], env);
  assert.equal(ingest.code, 0, ingest.stdout + ingest.stderr);
  const id = ingest.stdout.match(/Recorded event ([0-9a-f]+)/)?.[1];
  assert.ok(id, `the event id must be reported: ${ingest.stdout}`);

  const decide = await runCli(['situation', 'decide', id, '--response', 'record', '--reason', 'lease renewal noted'], env);
  assert.equal(decide.code, 0, decide.stdout + decide.stderr);
  assert.match(decide.stdout, /Decision .* for event/);

  const filtered = await runCli(['situation', 'decisions', '--event', id, '--limit', '5'], env);
  assert.equal(filtered.code, 0, filtered.stdout + filtered.stderr);
  assert.match(filtered.stdout, /1 decision\(s\) recorded/);

  // The fix must not swallow unexpected arguments: a stray positional is still a usage error.
  const stray = await runCli([
    'situation', 'ingest', '--source', 'user', '--source-id', 'ux-2',
    '--type', 'observation', '--category', 'observation', 'stray',
  ], env);
  assert.equal(stray.code, 2, stray.stdout + stray.stderr);
  // The reason is printed before the long usage line, so the 400-character bound cannot hide it.
  assert.match(stray.stderr, /^usage error: unexpected argument "stray"/);
  assert.match(stray.stderr, /usage: situation ingest/);
});

test('learning, adaptation and goal options carry their values to the action', async (t) => {
  const { env } = fixture(t);

  const patterns = await runCli(['learning', 'patterns', '--min-observations', '2'], env);
  assert.equal(patterns.code, 0, patterns.stdout + patterns.stderr);

  // A numeric option is parsed as a whole number, so a word is refused before anything runs.
  const word = await runCli(['learning', 'patterns', '--min-observations', 'two'], env);
  assert.equal(word.code, 2, word.stdout + word.stderr);
  assert.match(word.stderr, /--min-observations needs a whole number/);

  // Each of these now reaches its action and fails on the named record, which is the domain
  // answer. Before the repair every one of them stopped at a usage line instead.
  const cases = [
    [['learning', 'propose', '--min-observations', '2'], 0, /No candidate adaptation was proposed/],
    [['learning', 'rollback', 'missing', '--measurement', 'm-1', '--reason', 'test'], 1, /rollback target not found/],
    [['adaptation', 'effectiveness', '--adaptation', 'missing'], 1, /no adaptation matches/],
    [['adaptation', 'guide', 'missing', '--order', 'reads_first', '--avoid', 'a,b', '--prefer', 'c', '--max-steps', '2'], 1, /avoid and prefer must name registered capabilities/],
    [['goal', 'revise', 'missing', '--criterion', 'c1', '--reason', 'test', '--request', 'reworded'], 1, /no goal matches/],
  ];
  for (const [argv, code, expected] of cases) {
    const res = await runCli(argv, env);
    assert.equal(res.code, code, `${argv.join(' ')}: ${res.stdout}${res.stderr}`);
    assert.match(res.stdout + res.stderr, expected);
    assert.doesNotMatch(res.stderr, /^usage error:/m, `${argv.join(' ')} must not stop at the parser`);
  }
});
