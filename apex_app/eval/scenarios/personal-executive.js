// Personal-executive scenarios: the everyday promises a person relies on when they ask APEX to
// remember, correct, keep private, and ask rather than guess.
//
// Every check reads a public outcome: the status a command reported, the text a user sees, or a
// record read back through the store. No check asserts an internal helper name, an exact sentence,
// or a private implementation detail, and no scenario contacts a model.
import { check } from '../framework.js';
import {
  outcomeIs, outcomeIn, displayHas, displayLacks, dataOf, boundedDisplay, atLeast,
} from '../oracles.js';
import { readJsonl } from '../oracles.js';

function checks(entries) {
  return entries;
}

export default [
  {
    id: 'pe-01',
    category: 'personal-executive',
    title: 'A remembered fact survives a restart and can be recalled',
    intent: 'Store a small user fact through ordinary conversation, then recall it after the process is rebuilt.',
    preconditions: [
      'an empty isolated data directory',
      'the deterministic evaluation clock',
      'no model backend is configured',
    ],
    steps: [
      'say "remember that the vendor ships on Tuesdays"',
      'restart the application over the same data',
      'say "what do you remember about the vendor"',
    ],
    async run(ctx) {
      const stored = await ctx.say('remember that the vendor ships on Tuesdays');
      const storedData = dataOf(stored);
      await ctx.restart();
      const recalled = await ctx.say('what do you remember about the vendor');
      const hits = dataOf(recalled)?.hits ?? [];
      const persisted = readJsonl(ctx.dataDir, 'memory.jsonl');

      return {
        expected: 'the fact is stored, survives a restart, and is returned with its content',
        actual: `${hits.length} hit(s) after restart; stored status ${stored.status}`,
        checks: checks({
          correctness: outcomeIs(stored, 'success_verified'),
          completeness: check(
            persisted.records.length === 1
              && persisted.records[0].content === 'the vendor ships on Tuesdays'
              && hits.length === 1 && hits[0].id === persisted.records[0].id,
            'the stored record holds the fact and the recall returns that record',
            hits.map((h) => h.id).join(' | ') || '(no hits)',
          ),
          continuity: check(
            persisted.records.length === 1 && hits.length === 1,
            'one record on disk and one recalled hit after restart',
            `${persisted.records.length} record(s) on disk, ${hits.length} hit(s) from the new instance`,
          ),
          ux: check(
            boundedDisplay(recalled, { min: 10 }).ok && displayHas(recalled, /Tuesdays/).ok,
            'a bounded answer names the fact',
            recalled.display,
          ),
        }),
        metrics: { storedRecords: persisted.records.length, recalledHits: hits.length },
      };
    },
  },

  {
    id: 'pe-02',
    category: 'personal-executive',
    title: 'A correction replaces a fact without erasing the original',
    intent: 'Correct a stored fact and confirm the replacement is current while the original remains readable as history.',
    preconditions: ['one stored memory fact', 'a deterministic clock'],
    steps: [
      'say "remember that the access code is alpha-7"',
      'correct that record to "the access code is beta-9"',
      'recall the access code',
      'restart and recall again',
    ],
    async run(ctx) {
      const first = await ctx.say('remember that the access code is alpha-7');
      const originalId = dataOf(first)?.id ?? null;
      const corrected = ctx.app.controller.correctMemory
        ? await ctx.run('correct memory', () => ctx.app.controller.correctMemory({
          targetId: originalId,
          content: 'the access code is beta-9',
          resolve: true,
        }))
        : null;
      const beforeRestart = await ctx.say('what do you remember about the access code');
      await ctx.restart();
      const afterRestart = await ctx.say('what do you remember about the access code');
      const hits = dataOf(afterRestart)?.hits ?? [];
      const current = hits.find((h) => (h.replaces ?? []).includes(originalId));
      const historical = hits.find((h) => h.id === originalId);

      return {
        expected: 'the correction is current, the original is retained as superseded, and both survive a restart',
        actual: `current=${current?.status ?? 'missing'} historical=${historical?.status ?? 'missing'} hits=${hits.length}`,
        checks: checks({
          correctness: check(
            corrected && outcomeIs(corrected, 'success_verified').ok && current !== undefined,
            'the correction is verified and the replacement is recalled',
            corrected?.status ?? '(no correction call)',
          ),
          completeness: check(
            historical !== undefined && historical.status === 'superseded' && (current?.replaces ?? []).includes(originalId),
            'the original is retained as superseded and the correction names it',
            `historical=${historical?.status ?? 'missing'} replaces=${JSON.stringify(current?.replaces ?? [])}`,
          ),
          continuity: check(
            (dataOf(beforeRestart)?.hits ?? []).length === hits.length && hits.length === 2,
            'the same two records are recalled before and after a restart',
            `before=${(dataOf(beforeRestart)?.hits ?? []).length} after=${hits.length}`,
          ),
          safety: check(
            (readJsonl(ctx.dataDir, 'memory.jsonl').records ?? []).length === 2,
            'nothing is erased: the original and the correction are both stored',
            `${readJsonl(ctx.dataDir, 'memory.jsonl').records.length} stored record(s)`,
          ),
          ux: check(
            displayHas(afterRestart, /beta-9/).ok,
            'the answer shows the current value',
            afterRestart.display,
          ),
        }),
        metrics: { hits: hits.length },
      };
    },
  },

  {
    id: 'pe-03',
    category: 'personal-executive',
    title: 'A private memory is kept out of model turns and reported as private',
    intent: 'Store a private fact, then verify it is available to the user, absent from a model-bound answer, and counted as private.',
    preconditions: ['an empty memory store', 'no model backend'],
    steps: [
      'say "remember privately that the safe combination is 44-19-30"',
      'say "list my memories"',
      'say a request that would need a model answer',
      'read memory health',
    ],
    async run(ctx) {
      const stored = await ctx.say('remember privately that the safe combination is 44-19-30');
      const listed = await ctx.say('list my memories');
      const modelBound = await ctx.say('write me a short poem about the office');
      const health = await ctx.app.controller.memoryHealth();
      const privateCount = health.health?.privateRecords ?? null;

      return {
        expected: 'the private fact is visible to the user, never sent to a model, and counted as private',
        actual: `store=${stored.status} list=${listed.status} model=${modelBound.status} private=${privateCount}`,
        checks: checks({
          correctness: check(
            outcomeIn(modelBound, ['model_unavailable', 'clarification_required']).ok,
            'a model-bound request reports unavailability rather than inventing an answer',
            modelBound.status,
          ),
          completeness: check(
            displayHas(listed, /44-19-30/).ok,
            'the user can read the private fact back',
            listed.display,
          ),
          safety: check(
            !String(modelBound.display ?? '').includes('44-19-30')
              && !String(modelBound.output ?? '').includes('44-19-30')
              && privateCount === 1,
            'the private value does not appear in the model-bound answer and health counts it as private',
            `privateCount=${privateCount}`,
          ),
          ux: check(
            displayHas(stored, /private|never sent/i).ok && boundedDisplay(health, { min: 20 }).ok,
            'the store notice and health report say what private means',
            stored.display,
          ),
        }),
        metrics: { privateRecords: privateCount },
      };
    },
  },

  {
    id: 'pe-04',
    category: 'personal-executive',
    title: 'An ambiguous request is questioned instead of guessed',
    intent: 'Ask something with no subject and confirm APEX asks for the missing information without running or inventing anything.',
    preconditions: ['no prior conversation turns'],
    steps: ['say "recall"', 'read the reported status and display'],
    async run(ctx) {
      const answer = await ctx.say('recall');
      const operationsBefore = readJsonl(ctx.dataDir, 'operations.jsonl').records.length;
      const memoryRows = readJsonl(ctx.dataDir, 'memory.jsonl').records.length;

      return {
        expected: 'APEX asks what to search for and writes nothing',
        actual: `${answer.status}: ${String(answer.display ?? '').slice(0, 160)}`,
        checks: checks({
          correctness: outcomeIs(answer, 'clarification_required'),
          safety: check(
            memoryRows === 0,
            'no memory record is written for a request that was only clarified',
            `${memoryRows} memory record(s)`,
          ),
          ux: check(
            displayHas(answer, /\?/).ok && boundedDisplay(answer, { min: 10, max: 600 }).ok,
            'the answer is a bounded question the user can answer',
            answer.display,
          ),
        }),
        metrics: { operationsBefore, memoryRows },
      };
    },
  },
];
