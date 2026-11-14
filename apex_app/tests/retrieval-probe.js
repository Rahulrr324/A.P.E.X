// Batch AP-10: shared harness for the retrieval snapshot, adversarial and acceptance suites.
//
// Every observation comes from the real controller, the real memory/knowledge stores, the real
// conversation log and the real operation log. The model is an in-process fixed-output stub and
// experience capture is off, so nothing here contacts a model, launches inference or downloads
// anything. The harness only reads and shapes what APEX itself produced; it never computes an
// expected answer, so a passing assertion is evidence of APEX's behaviour and not of the harness.
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { ModelGateway } from '../src/model/gateway.js';
import { CAPTURE_OFF } from '../src/experience/capture.js';
import { Outcome } from '../src/outcomes.js';
import { makeTempDataDir, cleanup } from './helpers.js';

export const CLOCK = '2026-06-01T00:00:00.000Z';
export const now = () => new Date(CLOCK);

const dirs = [];
export function tempDir() { const d = makeTempDataDir(); dirs.push(d); return d; }
export function cleanupAll() { while (dirs.length) cleanup(dirs.pop()); }

export function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
}

// A damaged store must still be countable: a case that appends a malformed line needs to prove the
// line was preserved, not have the harness throw while reading it. `damaged` counts what the strict
// reader could not parse.
export function readStoreLines(file) {
  if (!fs.existsSync(file)) return { records: [], lines: 0, damaged: 0 };
  const raw = fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '');
  const records = [];
  let damaged = 0;
  for (const line of raw) {
    try {
      records.push(JSON.parse(line));
    } catch {
      damaged += 1;
    }
  }
  return { records, lines: raw.length, damaged };
}

// A fixed-output backend. `reply` is called once per model request, so a fixture can time a store
// write against the model phase and still return the same text every run.
export function stubBackend(reply, hooks = {}) {
  return {
    name: 'ap10-probe',
    provider: 'ap10-probe',
    configured: true,
    describe: () => ({ configured: true, provider: 'ap10-probe', endpoint: 'synthetic', model: 'synthetic' }),
    health: async () => ({ available: true, detail: 'synthetic fixture' }),
    complete: async () => {
      if (hooks.before) await hooks.before();
      return {
        ok: true, backend: 'ap10-probe', provider: 'ap10-probe', model: 'synthetic',
        text: reply(), finishReason: 'stop', truncated: false, latencyMs: 0,
      };
    },
  };
}

export function cognitionBlock(answer, claims, extra = {}) {
  return `${answer}\nCOGNITION ${JSON.stringify({ schema: 1, decision: 'answer', answer, claims, ...extra })}`;
}

export const evidenceId = (source, id) => `ev:${source}:${id}`;

// One request through the real path, plus the eight observation dimensions AP-10 §10 asks each
// adversarial case to assert. `rank` re-runs the same query against the stores afterwards so a case
// can assert an ordering; it is a second read, so a case that appends during the request must not
// confuse the two.
export async function probe({
  memory = [], knowledge = [], query, reply = null, claims = null, answer = 'the lighthouse status is green',
  kind = 'supported', prepare = null, during = null, contextChars = null, retrievalLimit = null,
  rank = false, rankLimit = 50, app: existing = null, extraCognition = {},
} = {}) {
  const dir = existing ? null : tempDir();
  const state = { ids: [], kids: [], app: null };
  const text = () => {
    if (reply) return reply(state);
    const cited = claims ?? [{
      text: answer,
      evidence: state.ids.length ? [evidenceId('memory', state.ids[0])] : [],
      kind,
    }];
    return cognitionBlock(answer, cited, extraCognition);
  };
  const app = existing ?? createApp({
    dataDir: dir,
    gateway: new ModelGateway({ backend: stubBackend(text, { before: during ? () => during(state.app, state) : null }) }),
    experienceCapture: CAPTURE_OFF,
    now,
  });
  state.app = app;
  if (contextChars !== null) app.controller.maxContextChars = contextChars;
  if (retrievalLimit !== null) app.controller.retrievalLimit = retrievalLimit;
  for (const content of memory) {
    const record = typeof content === 'string' ? { content, kind: 'user_fact', source: 'user' } : content;
    state.ids.push((await app.memory.add(record)).id);
  }
  for (const triple of knowledge) state.kids.push((await app.knowledge.add(triple)).record.id);
  if (prepare) await prepare(app, state, dir ?? app.memory.filePath.replace(/memory\.jsonl$/, ''));

  const res = await app.controller.handle(query, { origin: 'user' });
  const op = res.operation;
  const dataDir = dir ?? path.dirname(app.memory.filePath);
  const audit = readJsonl(path.join(dataDir, 'operations.jsonl')).find((entry) => entry.id === op.id) ?? null;
  const integrity = op.cognition?.responseIntegrity ?? null;
  const report = op.prompt?.retrievalReport ?? null;
  const read = op.cognition?.read ?? null;
  const modelSteps = (op.steps ?? []).filter((step) => step.origin === 'model');

  let ranking = null;
  if (rank) {
    const mh = await app.memory.search(query, { limit: rankLimit });
    const kh = app.knowledge ? await app.knowledge.search(query, { limit: rankLimit }) : [];
    ranking = {
      memory: mh.map((hit) => hit.record.id),
      memoryScores: mh.map((hit) => hit.score),
      memoryConflicts: mh.map((hit) => hit.conflict ?? []),
      memoryStatus: mh.map((hit) => hit.status),
      knowledge: kh.map((hit) => hit.record.id),
      knowledgeScores: kh.map((hit) => hit.score),
    };
  }

  return {
    app, dir: dataDir, res, op, audit, state,
    ids: state.ids,
    kids: state.kids,
    report,
    preReport: op.cognition?.retrievalReport ?? null,
    read,
    integrity,
    ranking,
    // 1. which records reached the prompt
    records: { memory: op.prompt?.memoryIds ?? [], knowledge: op.prompt?.knowledgeIds ?? [] },
    // 3/4. the retrieval state and the completeness claim, kept apart
    retrievalState: report?.state ?? null,
    sourceState: (source) => report?.sources?.find((entry) => entry.source === source)?.state ?? null,
    sourceEntry: (source) => report?.sources?.find((entry) => entry.source === source) ?? null,
    completeness: {
      report: report?.complete ?? null,
      read: read?.complete ?? null,
      window: read?.window ?? null,
      readState: read?.state ?? null,
    },
    // 5. citation behaviour: the trust state, the claim counts and the fixed disclosure codes
    citation: {
      trust: integrity?.trust ?? null,
      claims: integrity?.claims ?? null,
      codes: (integrity?.limitations ?? []).filter((code) => code.startsWith('citation_')),
    },
    // 6. the limitation the answer carries, in the audit and beside the answer
    limitation: {
      codes: integrity?.limitations ?? [],
      degradation: integrity?.degradation ?? null,
      // Disclosures are bracketed, but not all of them start with "APEX": the stored-conflict notice
      // begins "[Stored context …". Matching only the APEX prefix would silently miss it.
      notices: (res.output ?? '').match(/\[[^\]\n]+\]/g) ?? [],
      output: res.output ?? '',
    },
    // 7. what was persisted: the audit record, the model turn, and the stores left as they were
    persistence: {
      auditFound: audit !== null,
      auditReport: audit?.prompt?.retrievalReport ?? null,
      auditAuthorizes: audit?.cognition?.responseIntegrity?.authorizes ?? null,
      modelTurns: readJsonl(path.join(dataDir, 'conversation.jsonl')).filter((turn) => turn.origin === 'model'),
      noticeTurns: readJsonl(path.join(dataDir, 'conversation.jsonl')).filter((turn) => turn.origin === 'notice'),
      memoryRecords: readStoreLines(path.join(dataDir, 'memory.jsonl')).lines,
      memoryDamaged: readStoreLines(path.join(dataDir, 'memory.jsonl')).damaged,
      knowledgeRecords: readStoreLines(path.join(dataDir, 'knowledge.jsonl')).lines,
    },
    // 8. whether any executive action was permitted. A retrieval report, a citation assessment and a
    // response assessment all say authorizes:false; execution still goes through the registry.
    executive: {
      decision: res.decision ?? null,
      status: res.status,
      modelSteps: modelSteps.map((step) => ({ action: step.action ?? null, outcome: step.outcome, summary: step.summary })),
      executed: modelSteps.filter((step) => step.outcome === Outcome.SUCCESS_VERIFIED).length,
      authorizes: {
        report: report?.authorizes ?? null,
        integrity: integrity?.authorizes ?? null,
        contract: op.cognition?.responseContract?.authorizes ?? null,
      },
    },
  };
}

export const NOISE = (count) => Array.from({ length: count }, (_, i) => `phras${String(i).padStart(4, '0')}`).join(' ');