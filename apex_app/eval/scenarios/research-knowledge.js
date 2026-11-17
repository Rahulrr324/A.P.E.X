// Research and knowledge scenarios: the promises a person relies on when they store what they
// learned, ask for it back, and expect history to stay honest after a retraction, a conflict, or a
// re-ingested document.
//
// Every check reads a public result: the status a command reported, the text a user sees, or a
// record read back through the store. Documents are exercised through the CLI a user runs, because
// that is the only supported surface for content ingestion.
import { check } from '../framework.js';
import {
  outcomeIs, displayHas, dataOf, boundedDisplay, atLeast, readJsonl,
} from '../oracles.js';

function hitsOf(result) {
  return dataOf(result)?.hits ?? [];
}

export default [
  {
    id: 'rk-01',
    category: 'research-knowledge',
    title: 'Stored knowledge is found by search and summarized in a digest',
    intent: 'Record two related facts, find both by keyword, and confirm a topic digest reports them.',
    preconditions: ['an empty knowledge store', 'no model backend'],
    steps: [
      'add "vendor ships on Tuesdays" as knowledge',
      'add "vendor invoices monthly on the 1st" as knowledge',
      'search knowledge for "vendor"',
      'request a knowledge digest for "vendor"',
    ],
    async run(ctx) {
      const first = await ctx.act('knowledgeAdd', {
        subject: 'vendor', relationship: 'ships', object: 'on Tuesdays',
      }, 'knowledge: add shipping fact');
      const second = await ctx.act('knowledgeAdd', {
        subject: 'vendor', relationship: 'invoices', object: 'monthly on the 1st',
      }, 'knowledge: add invoicing fact');
      const found = await ctx.call('knowledgeSearch', ['vendor'], 'knowledge: search vendor');
      const digest = await ctx.act('knowledgeDigest', { query: 'vendor' }, 'knowledge: digest vendor');

      const hits = hitsOf(found);
      const objects = hits.map((hit) => hit.object);
      const digestData = dataOf(digest);
      const digestResults = digestData?.knowledge?.search?.results ?? [];

      return {
        expected: 'both stored claims are returned by search and included in the topic digest',
        actual: `${hits.length} search hit(s); digest claims ${digestData?.knowledge?.counts?.claims ?? 'n/a'}`,
        checks: {
          correctness: check(
            outcomeIs(first, 'success_verified').ok
              && outcomeIs(second, 'success_verified').ok
              && outcomeIs(found, 'success_verified').ok,
            'both writes and the search report verified success',
            `${first.status}/${second.status}/${found.status}`,
          ),
          completeness: check(
            objects.includes('on Tuesdays') && objects.includes('monthly on the 1st'),
            'search returns both stored claims',
            objects.join(' | ') || '(no hits)',
          ),
          continuity: check(
            digestResults.length === 2 && digestResults.every((record) => /vendor/i.test(record.subject)),
            'the digest reads the same two claims back from the store',
            `${digestResults.length} digest result(s)`,
          ),
          ux: check(
            boundedDisplay(digest, { min: 20 }).ok
              && displayHas(digest, /Tuesdays/).ok
              && displayHas(digest, /1st/).ok,
            'the digest is bounded and names both facts',
            digest.display,
          ),
        },
        metrics: {
          searchHits: hits.length,
          digestMatches: digestResults.length,
          storedClaims: digestData?.knowledge?.counts?.claims ?? null,
        },
      };
    },
  },

  {
    id: 'rk-02',
    category: 'research-knowledge',
    title: 'A retracted claim leaves current search but stays readable as history',
    intent: 'Retract a stored claim and confirm search stops returning it while the record and its retraction remain readable, including after a restart.',
    preconditions: ['one stored knowledge claim', 'a deterministic clock'],
    steps: [
      'add "the backup policy requires weekly snapshots"',
      'retract it with a reason',
      'search for "backup policy"',
      'list knowledge and read its history',
      'restart and search again',
    ],
    async run(ctx) {
      const added = await ctx.act('knowledgeAdd', {
        subject: 'backup policy', relationship: 'requires', object: 'weekly snapshots',
      }, 'knowledge: add backup claim');
      const id = dataOf(added)?.id ?? null;
      const retracted = await ctx.act('knowledgeRetract', {
        target: id, reason: 'replaced by the 2026 retention policy',
      }, 'knowledge: retract backup claim');
      const searchAfter = await ctx.call('knowledgeSearch', ['backup policy'], 'knowledge: search after retraction');
      const listed = await ctx.act('knowledgeList', {}, 'knowledge: list after retraction');
      const history = await ctx.call('knowledgeHistory', [id], 'knowledge: history');

      await ctx.restart();
      const searchRestarted = await ctx.call('knowledgeSearch', ['backup policy'], 'knowledge: search after restart');
      const listRestarted = await ctx.act('knowledgeList', {}, 'knowledge: list after restart');

      const afterHits = hitsOf(searchAfter);
      const restartedHits = hitsOf(searchRestarted);
      const retractedRow = (dataOf(listed)?.records ?? []).find((record) => record.id === id);
      const retractedRowAfterRestart = (dataOf(listRestarted)?.records ?? []).find((record) => record.id === id);

      return {
        expected: 'the retraction is verified, current search excludes the claim, and the original claim plus its retraction remain readable across a restart',
        actual: `after=${afterHits.length} restarted=${restartedHits.length} state=${retractedRow?.lifecycleState ?? 'missing'}`,
        checks: {
          correctness: check(
            outcomeIs(retracted, 'success_verified').ok,
            'the retraction reports verified success',
            retracted.status,
          ),
          completeness: check(
            afterHits.length === 0 && restartedHits.length === 0,
            'current search returns the retracted claim in neither session',
            `${afterHits.length} hit(s) after retraction, ${restartedHits.length} after restart`,
          ),
          continuity: check(
            retractedRow?.lifecycleState === 'retracted'
              && retractedRowAfterRestart?.lifecycleState === 'retracted'
              && retractedRow?.object === 'weekly snapshots',
            'the original claim and its retracted state survive the restart',
            `before=${retractedRow?.lifecycleState ?? 'missing'} after=${retractedRowAfterRestart?.lifecycleState ?? 'missing'}`,
          ),
          safety: check(
            (dataOf(listed)?.records ?? []).length === 1
              && displayHas(history, /retract/i).ok
              && displayHas(history, /2026 retention policy/).ok,
            'the claim is preserved with its user-supplied retraction reason rather than deleted',
            `records=${(dataOf(listed)?.records ?? []).length}`,
          ),
        },
        metrics: {
          hitsAfterRetraction: afterHits.length,
          hitsAfterRestart: restartedHits.length,
          storedClaims: readJsonl(ctx.dataDir, 'knowledge.jsonl').records.length,
        },
      };
    },
  },

  {
    id: 'rk-03',
    category: 'research-knowledge',
    title: 'Conflicting claims are both preserved and surfaced as unresolved',
    intent: 'Record two incompatible values for the same relationship and confirm neither is silently dropped and the conflict is reported.',
    preconditions: ['an empty knowledge store'],
    steps: [
      'add "the office is in Berlin"',
      'add "the office is in Munich"',
      'search for "office"',
      'request a digest',
    ],
    async run(ctx) {
      const berlin = await ctx.act('knowledgeAdd', {
        subject: 'the office', relationship: 'is in', object: 'Berlin',
      }, 'knowledge: add Berlin claim');
      const berlinId = dataOf(berlin)?.id ?? null;
      const munich = await ctx.act('knowledgeAdd', {
        subject: 'the office', relationship: 'is in', object: 'Munich',
      }, 'knowledge: add Munich claim');
      const munichData = dataOf(munich);
      const search = await ctx.call('knowledgeSearch', ['office'], 'knowledge: search office');
      const digest = await ctx.act('knowledgeDigest', { query: 'office' }, 'knowledge: digest office');

      const hits = hitsOf(search);
      const byObject = new Map(hits.map((hit) => [hit.object, hit]));
      const digestData = dataOf(digest);

      return {
        expected: 'the second incompatible claim is stored, the conflict names both claims, and nothing is discarded',
        actual: `${hits.length} hit(s); conflicts=${digestData?.knowledge?.counts?.conflicts?.groups ?? 'n/a'}`,
        checks: {
          correctness: check(
            outcomeIs(munich, 'success_verified').ok
              && munichData?.status === 'conflicting',
            'the incompatible claim is stored and reported conflicting',
            `${munich.status}/${munichData?.status ?? 'missing'}`,
          ),
          completeness: check(
            hits.length === 2 && byObject.has('Berlin') && byObject.has('Munich'),
            'search returns both claims',
            hits.map((hit) => hit.object).join(' | ') || '(no hits)',
          ),
          safety: check(
            (munichData?.conflictingIds ?? []).includes(berlinId)
              && (byObject.get('Munich')?.conflictsWith ?? []).includes(berlinId)
              && (byObject.get('Berlin')?.conflictsWith ?? []).includes(munichData?.id),
            'each claim names the other as an unresolved conflict instead of replacing it',
            `Munich conflicts=${JSON.stringify(munichData?.conflictingIds ?? [])}`,
          ),
          ux: check(
            displayHas(search, /Berlin/).ok && displayHas(search, /Munich/).ok,
            'the user sees both competing values',
            search.display,
          ),
        },
        metrics: {
          hits: hits.length,
          conflictGroups: digestData?.knowledge?.counts?.conflicts?.groups ?? null,
          storedClaims: digestData?.knowledge?.counts?.claims ?? null,
        },
      };
    },
  },

  {
    id: 'rk-04',
    category: 'research-knowledge',
    title: 'A re-ingested document is found at its current version after a restart',
    intent: 'Ingest a document through the CLI, edit it, re-ingest, and confirm search reports the current version even from a new process.',
    preconditions: [
      'one Markdown file in the authorized content root',
      'document content permission configured through the CLI',
    ],
    steps: [
      'write a document saying the review is on Friday',
      'configure, enable and ingest through the document CLI',
      'search the document index for "Friday"',
      'rewrite the document to say Monday and re-ingest',
      'search for "Monday", restart, and search again',
    ],
    async run(ctx) {
      const root = ctx.filesDir;
      ctx.writeFile('notes/plan.md', '# Release\n\nThe release review is on Friday.\n');

      const configured = await ctx.cli(['document', 'configure', '--root', root, '--extension', 'md']);
      const enabled = await ctx.cli(['document', 'enable']);
      const firstIngest = await ctx.cli(['document', 'ingest']);
      const firstSearch = await ctx.cli(['document', 'search', 'Friday']);
      const firstId = /(doc:[0-9a-f]{32}) v(\d+)/.exec(firstIngest.stdout)?.[1] ?? null;

      ctx.writeFile('notes/plan.md', '# Release\n\nThe release review is on Monday.\n');
      const secondIngest = await ctx.cli(['document', 'ingest', '--force']);
      const secondSearch = await ctx.cli(['document', 'search', 'Monday']);
      const versions = await ctx.cli(['document', 'versions', firstId ?? 'missing']);

      await ctx.restart();
      const afterRestart = await ctx.cli(['document', 'search', 'Monday']);
      const staleAfterRestart = await ctx.cli(['document', 'search', 'Friday']);

      const durationOf = (stdout) => {
        const match = /in (\d+) ms/.exec(stdout);
        return match ? Number(match[1]) : null;
      };
      const indexed = /(\d+) indexed/.exec(firstIngest.stdout);
      const currentVersion = /v(\d+)/.exec(secondSearch.stdout)?.[1] ?? null;

      return {
        expected: 'ingestion succeeds, search follows the edited content at version 2, and a restarted process reports the same current version',
        actual: `first=${firstSearch.stdout.trim().split('\n')[0]} second=${secondSearch.stdout.trim().split('\n')[0]} v=${currentVersion}`,
        checks: {
          correctness: check(
            configured.code === 0 && enabled.code === 0
              && firstIngest.code === 0 && secondIngest.code === 0
              && secondSearch.code === 0,
            'configure, enable and both ingests exit successfully',
            `configure=${configured.code} enable=${enabled.code} ingest=${firstIngest.code}/${secondIngest.code}`,
          ),
          completeness: check(
            indexed !== null && Number(indexed[1]) === 1
              && firstSearch.code === 0 && /Friday/.test(firstSearch.stdout)
              && secondSearch.code === 0 && /Monday/.test(secondSearch.stdout)
              && currentVersion === '2',
            'the first content is found, then the edited content is found at version 2',
            `indexed=${indexed?.[1] ?? 'n/a'} firstHasFriday=${/Friday/.test(firstSearch.stdout)} secondHasMonday=${/Monday/.test(secondSearch.stdout)} version=${currentVersion}`,
          ),
          continuity: check(
            afterRestart.code === 0
              && /Monday/.test(afterRestart.stdout)
              && /v2/.test(afterRestart.stdout)
              && /no match/.test(staleAfterRestart.stdout),
            'a new process still reports Monday at v2 and no longer matches Friday',
            `restart v-match=${/v2/.test(afterRestart.stdout)} staleFriday=${/no match/.test(staleAfterRestart.stdout)}`,
          ),
          ux: check(
            /versions?/i.test(versions.stdout) || /v1/.test(versions.stdout) || /v2/.test(versions.stdout),
            'the version history is readable from the CLI',
            versions.stdout,
          ),
        },
        metrics: {
          firstIngestMs: durationOf(firstIngest.stdout),
          secondIngestMs: durationOf(secondIngest.stdout),
          documentId: firstId,
          currentVersion,
        },
      };
    },
  },
];
