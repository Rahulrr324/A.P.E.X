// Reasoning-quality scenarios for the T-13 workspace. They ask whether a session that reads the
// same stores gives an answer a person can check: are contradictions surfaced instead of settled,
// is missing information named instead of filled in, is a superseded record kept out of current
// support, and is the same question answered reproducibly after a correction?
//
// Every check reads the documented session result (classification, assessment counts, evidence
// items, decision fields). No scenario asserts a probability, and none treats a recommendation as
// permission. The verdicts are deterministic rule outcomes, not calibrated confidence.
import { check } from '../framework.js';
import { outcomeIs, dataOf, displayHas, boundedDisplay, readJsonl } from '../oracles.js';

const recordsIn = (dataDir, name) => readJsonl(dataDir, name).records;

// Trust classes whose current support settles a conclusion, mirroring the advertised rule. The
// metric is used only to report how much of the supporting set came from non-settling classes.
const SETTLING_TRUST = new Set([
  'user_statement', 'user_confirmed', 'user_objective', 'authorized_document',
  'world_model', 'operational_record', 'outcome',
]);

function supportQuality(items = []) {
  const supporting = items.filter((item) => item.relation === 'supporting');
  const unsettled = supporting.filter((item) => !SETTLING_TRUST.has(item.trust) || item.current === false);
  return {
    supporting: supporting.length,
    unsettled: unsettled.length,
    unsupportedRate: supporting.length > 0 ? unsettled.length / supporting.length : 0,
  };
}

function provenanceOrigins(items = []) {
  return new Set(items.map((item) => String(item.provenance?.origin ?? 'unknown')));
}

export default [
  {
    id: 'rq-01',
    category: 'reasoning-quality',
    blind: true,
    title: 'Two documents that disagree produce preserved alternatives, not a chosen winner',
    intent: 'Ingest two authorized documents with different owners for the same field and confirm the session reports a conflict, keeps both sides, offers no preferred hypothesis, and recommends clarification rather than answering.',
    preconditions: [
      'two JSON documents with different values for the same field',
      'document content permission configured through the CLI',
      'no model backend',
    ],
    steps: [
      'write and ingest two documents that both record an owner, with different owners',
      'start a reasoning session asking who the owner is',
      'read the classification, conflicts, hypotheses, decision and evidence',
    ],
    async run(ctx) {
      ctx.writeFile('corpus/a.json', JSON.stringify({ owner: 'Ada' }));
      ctx.writeFile('corpus/b.json', JSON.stringify({ owner: 'Grace' }));
      const configured = await ctx.cli(['document', 'configure', '--root', ctx.filesDir, '--extension', 'json']);
      const enabled = await ctx.cli(['document', 'enable']);
      const ingest = await ctx.cli(['document', 'ingest']);

      const command = await ctx.act('reasoningStart', { request: 'who is the owner?' }, 'reasoning: conflicting owner');
      const session = dataOf(command)?.session ?? {};
      const items = session.evidence?.items ?? [];
      const assessment = session.assessment ?? {};
      const conflicts = assessment.conflicts ?? [];
      const hypotheses = session.hypotheses ?? [];
      const selection = session.hypothesisSelection ?? {};
      const decision = session.decision ?? {};
      const conclusion = session.conclusion ?? {};
      const quality = supportQuality(items);

      return {
        expected: 'the session classifies the answer as conflicting, keeps both document values, prefers no hypothesis, and recommends clarification without executing anything',
        actual: `classification=${conclusion.classification} conflicts=${conflicts.length} hypotheses=${hypotheses.length} preferred=${selection.preferred} recommended=${decision.recommended}`,
        checks: {
          correctness: check(
            outcomeIs(command, 'success_verified').ok && conclusion.classification === 'conflicting',
            'the session completes and classifies the answer as conflicting',
            `${command.status}/${conclusion.classification}`,
          ),
          completeness: check(
            conflicts.length >= 1
              && conflicts.some((group) => group.kind === 'cross_document_conflict' && (group.members ?? []).length >= 2)
              && hypotheses.length >= 2
              && hypotheses.every((hypothesis) => hypothesis.status === 'unresolved'),
            'the conflict is named with both members and at least two unresolved hypotheses remain',
            `conflicts=${conflicts.map((g) => `${g.kind}:${(g.members ?? []).length}`).join(',') || 'none'} hypotheses=${hypotheses.length}`,
          ),
          safety: check(
            selection.preferred === null
              && decision.executable === false
              && decision.authorizes === false
              && session.authorization?.executes === false
              && items.some((item) => /Ada/.test(String(item.claim ?? '')))
              && items.some((item) => /Grace/.test(String(item.claim ?? '')))
              && configured.code === 0 && enabled.code === 0 && ingest.code === 0,
            'no source is chosen, nothing is executable, and both values survive in the evidence set',
            `preferred=${selection.preferred} executable=${decision.executable} ada=${items.some((i) => /Ada/.test(String(i.claim ?? '')))} grace=${items.some((i) => /Grace/.test(String(i.claim ?? '')))} `,
          ),
          ux: check(
            boundedDisplay(command, { min: 20 }).ok
              && displayHas(command, /conflict/i).ok
              && (decision.options ?? []).some((option) => option.kind === 'clarify' && option.recommended),
            'the answer says the records conflict and recommends asking the user',
            command.display,
          ),
        },
        metrics: {
          evidence: items.length,
          conflicts: conflicts.length,
          hypotheses: hypotheses.length,
          provenanceOrigins: provenanceOrigins(items).size,
          supporting: quality.supporting,
          unsupportedRate: quality.unsupportedRate,
          modelCalls: 0,
        },
      };
    },
  },

  {
    id: 'rq-02',
    category: 'reasoning-quality',
    blind: true,
    title: 'An unanswerable question is reported as unknown with the missing evidence named',
    intent: 'Ask about a project that has no records and confirm the session says the records do not establish an answer, names the missing evidence, and recommends gathering evidence.',
    preconditions: ['empty stores', 'no model backend'],
    steps: [
      'start a reasoning session asking about a project with no records',
      'read the classification, missing-evidence list and decision',
    ],
    async run(ctx) {
      const command = await ctx.act('reasoningStart', { request: 'What is the launch date for Project Nope?' }, 'reasoning: unknown');
      const session = dataOf(command)?.session ?? {};
      const conclusion = session.conclusion ?? {};
      const assessment = session.assessment ?? {};
      const decision = session.decision ?? {};
      const items = session.evidence?.items ?? [];
      const quality = supportQuality(items);

      return {
        expected: 'the session classifies the answer as unknown, names no_relevant_evidence, and recommends gathering evidence instead of answering',
        actual: `classification=${conclusion.classification} missing=${(assessment.missing ?? []).join(',') || 'none'} recommended=${decision.recommended}`,
        checks: {
          correctness: check(
            outcomeIs(command, 'success_verified').ok && conclusion.classification === 'unknown',
            'the session completes and reports the answer as unknown',
            `${command.status}/${conclusion.classification}`,
          ),
          completeness: check(
            (assessment.missing ?? []).includes('no_relevant_evidence')
              && /do not establish|missing/i.test(String(conclusion.statement ?? '')),
            'the missing evidence is named and the statement says no answer is established',
            conclusion.statement,
          ),
          safety: check(
            (assessment.currentSupport ?? 0) === 0
              && quality.supporting === 0
              && conclusion.authorizes === false
              && decision.executable === false,
            'no supporting record is claimed and nothing is authorized',
            `currentSupport=${assessment.currentSupport} supporting=${quality.supporting} authorizes=${conclusion.authorizes}`,
          ),
          ux: check(
            decision.recommended === 'gather'
              && boundedDisplay(command, { min: 20 }).ok
              && displayHas(command, /unknown/i).ok,
            'the recommendation is to gather evidence and the answer is bounded',
            command.display,
          ),
        },
        metrics: {
          evidence: items.length,
          supporting: quality.supporting,
          missingCodes: (assessment.missing ?? []).length,
          modelCalls: 0,
        },
      };
    },
  },

  {
    id: 'rq-03',
    category: 'reasoning-quality',
    blind: true,
    title: 'A superseded record is read as history and kept out of current support',
    intent: 'Store two competing knowledge claims where the second supersedes the first, then confirm the current answer follows the replacement while the original is reported as historical.',
    preconditions: ['two knowledge claims for the same subject and field, one superseding the other', 'no model backend'],
    steps: [
      'add "Atlas database is PostgreSQL"',
      'add "Atlas database is MySQL" superseding the first',
      'start a reasoning session asking which database Atlas uses',
    ],
    async run(ctx) {
      const first = await ctx.act('knowledgeAdd', {
        subject: 'Atlas', relationship: 'database', object: 'PostgreSQL',
      }, 'knowledge: add PostgreSQL');
      const firstId = dataOf(first)?.id ?? null;
      const second = await ctx.act('knowledgeAdd', {
        subject: 'Atlas', relationship: 'database', object: 'MySQL', supersedes: [firstId],
      }, 'knowledge: add MySQL superseding');
      const secondId = dataOf(second)?.id ?? null;

      const command = await ctx.act('reasoningStart', { request: 'What database does Atlas use?' }, 'reasoning: current database');
      const session = dataOf(command)?.session ?? {};
      const conclusion = session.conclusion ?? {};
      const assessment = session.assessment ?? {};
      const temporal = session.temporal ?? {};
      const items = session.evidence?.items ?? [];
      const current = items.find((item) => item.current === true && /MySQL/.test(String(item.claim ?? ''))) ?? null;
      const stale = items.find((item) => item.current === false && /PostgreSQL/.test(String(item.claim ?? ''))) ?? null;
      const quality = supportQuality(items);

      return {
        expected: 'the current answer follows the replacement, the original is marked historical and stale, and the session does not report a conflict or authorize anything',
        actual: `classification=${conclusion.classification} stale=${(assessment.stale ?? []).length} historical=${temporal.counts?.historical ?? 'n/a'} current=${current?.relation ?? 'missing'} staleClaim=${stale?.relation ?? 'missing'}`,
        checks: {
          correctness: check(
            outcomeIs(command, 'success_verified').ok
              && conclusion.classification !== 'conflicting'
              && current !== null,
            'the session completes with a current supporting MySQL record and no conflict',
            `${command.status}/${conclusion.classification}/${current?.relation ?? 'no-current'}`,
          ),
          completeness: check(
            (assessment.stale ?? []).length >= 1
              && (temporal.counts?.historical ?? 0) >= 1
              && stale !== null
              && stale.relation === 'historical'
              && new Set(items.map((item) => item.evidenceId)).size === items.length,
            'the superseded record is kept and reported as historical, and every evidence id is unique',
            `stale=${(assessment.stale ?? []).length} historical=${temporal.counts?.historical} staleRelation=${stale?.relation ?? 'missing'}`,
          ),
          safety: check(
            (assessment.currentSupport ?? 0) >= 1
              && conclusion.authorizes === false
              && (session.decision?.executable ?? true) === false
              && !(assessment.stale ?? []).includes(current?.evidenceId),
            'current support counts the replacement, not the superseded record, and nothing is authorized',
            `currentSupport=${assessment.currentSupport} staleIncludesCurrent=${(assessment.stale ?? []).includes(current?.evidenceId)}`,
          ),
          ux: check(
            boundedDisplay(command, { min: 20 }).ok
              && displayHas(command, /MySQL/).ok
              && provenanceOrigins([current, stale].filter(Boolean)).size >= 1,
            'the answer names the current value and every cited record keeps its provenance',
            command.display,
          ),
        },
        metrics: {
          evidence: items.length,
          staleRecords: (assessment.stale ?? []).length,
          historicalRecords: temporal.counts?.historical ?? null,
          currentSupport: assessment.currentSupport ?? null,
          secondId: secondId === firstId ? 0 : 1,
          modelCalls: 0,
        },
      };
    },
  },

  {
    id: 'rq-04',
    category: 'reasoning-quality',
    blind: true,
    title: 'The same question is reproducible, then a later correction changes the replay',
    intent: 'Ask the same question in two sessions and confirm the evidence digest matches, then correct the underlying memory and confirm replay reports changed evidence and an explicit invalidation survives a restart.',
    preconditions: ['one remembered fact', 'no model backend'],
    steps: [
      'remember that the Atlas database is PostgreSQL',
      'start two reasoning sessions with the same request and compare their evidence digests',
      'correct the memory to MySQL',
      'replay the first session, invalidate it, and read it after a restart',
    ],
    async run(ctx) {
      const stored = await ctx.say('remember that the Atlas database is PostgreSQL');
      const memoryId = dataOf(stored)?.id ?? null;

      const first = dataOf(await ctx.act('reasoningStart', { request: 'Which database does Atlas use?' }, 'reasoning: first'))?.session ?? {};
      const second = dataOf(await ctx.act('reasoningStart', { request: 'Which database does Atlas use?' }, 'reasoning: second'))?.session ?? {};
      const firstDigest = first.evidence?.digest ?? null;
      const secondDigest = second.evidence?.digest ?? null;

      const corrected = await ctx.act('correctMemory', {
        targetId: memoryId, content: 'the Atlas database is MySQL', resolve: true,
      }, 'memory: correct database');
      const replay = dataOf(await ctx.act('reasoningReplay', { session: first.sessionId }, 'reasoning: replay after correction')) ?? {};
      const invalidated = await ctx.act('reasoningInvalidate', {
        session: first.sessionId, reason: 'the user corrected the database record',
      }, 'reasoning: invalidate first');
      const replayAfter = dataOf(await ctx.act('reasoningReplay', { session: first.sessionId }, 'reasoning: replay after invalidation')) ?? {};

      await ctx.restart();
      const shownCommand = await ctx.act('reasoningShow', { session: first.sessionId }, 'reasoning: show after restart');
      const shown = dataOf(shownCommand)?.session ?? {};
      const listed = dataOf(await ctx.act('reasoningList', {}, 'reasoning: list after restart')) ?? {};

      const memoryRows = recordsIn(ctx.dataDir, 'memory.jsonl');
      const currentMemory = memoryRows.filter((record) => !memoryRows.some(
        (other) => (other.provenance?.replaces ?? []).includes(record.id),
      ));
      const sessions = recordsIn(ctx.dataDir, 'reasoning.jsonl');
      const afterIds = Array.isArray(replay.afterEvidenceIds) ? replay.afterEvidenceIds : [];

      return {
        expected: 'two identical questions produce the same evidence digest, a correction changes the replay evidence, an invalidation is append-only, and the invalidated session is still readable after a restart',
        actual: `digests=${firstDigest === secondDigest ? 'match' : 'differ'} replayUnchanged=${replay.evidenceUnchanged} afterInvalidation=${replayAfter.replayed} invalidated=${shown.invalidated} sessions=${listed.total}`,
        checks: {
          correctness: check(
            firstDigest !== null && firstDigest === secondDigest
              && first.conclusion?.classification === second.conclusion?.classification,
            'two runs of the same question agree on the evidence digest and classification',
            `${firstDigest === secondDigest ? 'same' : 'different'} digest; ${first.conclusion?.classification}/${second.conclusion?.classification}`,
          ),
          completeness: check(
            outcomeIs(invalidated, 'success_verified').ok
              && replay.replayed === true
              && replay.evidenceUnchanged === false
              && afterIds.some((id) => String(id).startsWith('ev:memory:'))
              && replayAfter.replayed === false
              && shown.invalidated === true,
            'the correction changes the replay, the invalidation succeeds, and a later replay is refused',
            `invalidated=${invalidated.status} replayed=${replay.replayed} changed=${replay.evidenceUnchanged === false} replayAfter=${replayAfter.replayed}`,
          ),
          continuity: check(
            (listed.total ?? 0) >= 2
              && sessions.filter((record) => record.sessionId === first.sessionId).length >= 1
              && currentMemory.length === 1 && memoryRows.length === 2,
            'both sessions and one current memory record survive the restart with no duplication',
            `sessions=${listed.total} memoryRows=${memoryRows.length} current=${currentMemory.length}`,
          ),
          safety: check(
            shown.authorization?.executes === false
              && shown.conclusion?.authorizes === false
              && corrected.status === 'success_verified',
            'the invalidated session still grants nothing and the correction was verified',
            `executes=${shown.authorization?.executes} authorizes=${shown.conclusion?.authorizes}`,
          ),
          ux: check(
            boundedDisplay(shownCommand, { min: 20 }).ok
              && displayHas(shownCommand, /invalidated/i).ok,
            'the after-restart read is bounded and says the session is invalidated',
            shownCommand.display,
          ),
        },
        metrics: {
          evidenceDigestStable: firstDigest !== null && firstDigest === secondDigest ? 1 : 0,
          afterEvidenceIds: afterIds.length,
          sessions: listed.total ?? null,
          modelCalls: 0,
        },
      };
    },
  },
];
