// Council actions: registered by the composition root alongside other actions.
// The council is a read-oriented deliberation surface: it evaluates evidence and
// produces a synthesis, but never authorizes or executes anything.
import { ValidationError } from '../errors.js';
import { CONTROL_CHARS, singleLine } from '../util.js';
import { ORIGIN_USER, ORIGIN_MODEL } from './origins.js';
import { CouncilService } from '../council/service.js';
import { CouncilStore } from '../council/store.js';

function expectObject(input, allowedKeys) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('input must be an object');
  }
  for (const key of Object.keys(input)) {
    if (!allowedKeys.includes(key)) throw new ValidationError(`unexpected input field "${singleLine(key, 40)}"`);
  }
  return input;
}

function textField(value, name, max = 2000) {
  if (typeof value !== 'string') throw new ValidationError(`${name} must be text`);
  const t = value.trim();
  if (t.length === 0) throw new ValidationError(`${name} is empty`);
  if (t.length > max) throw new ValidationError(`${name} exceeds ${max} characters`);
  if (CONTROL_CHARS.test(t)) throw new ValidationError(`${name} contains control characters`);
  return t;
}

function intField(value, name, fallback, min, max) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ValidationError(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

export function councilActions(councilService) {
  return [
    {
      name: 'council.deliberate',
      description: 'Run deterministic multi-perspective council evaluation over real evidence. Read-oriented: produces a synthesis and disagreement record, never authorizes execution.',
      inputHint: '{"objective":"text","evidence":[["evidenceId","source","claim"]], "candidateId": "optional step or plan id", "limit": optional 1-40}',
      permission: 'read',
      origins: [ORIGIN_USER, ORIGIN_MODEL],
      validate(input) {
        const o = expectObject(input, ['objective', 'evidence', 'candidateId', 'limit']);
        const objective = textField(o.objective, 'objective', 2000);
        const limit = intField(o.limit, 'limit', 40, 1, 40);
        const evidence = Array.isArray(o.evidence) ? o.evidence.slice(0, limit) : [];
        for (const item of evidence) {
          if (!item || typeof item !== 'object') throw new ValidationError('each evidence item must be an object');
          if (typeof item.evidenceId !== 'string' || item.evidenceId.length === 0) {
            throw new ValidationError('each evidence item needs an evidenceId');
          }
          if (typeof item.source !== 'string' || item.source.length === 0) {
            throw new ValidationError('each evidence item needs a source');
          }
          if (typeof item.claim !== 'string') throw new ValidationError('each evidence item needs a claim');
        }
        const candidateId = o.candidateId === undefined || o.candidateId === null ? null : textField(o.candidateId, 'candidateId', 64);
        return { objective, evidence, candidateId, limit };
      },
      async execute(ctx, { objective, evidence, candidateId }) {
        const session = await ctx.council.deliberate({ objective, evidence, candidateId });
        const synthesis = session.synthesis;
        const positions = session.positions;
        return {
          summary: `council deliberation complete; ${positions.length} perspectives, disagreement: ${session.disagreement.kind}`,
          data: {
            sessionId: session.sessionId,
            objective,
            synthesis: synthesis.synthesis,
            disagreement: session.disagreement,
            positions: positions.map((p) => ({
              perspectiveId: p.perspectiveId,
              perspectiveName: p.perspectiveName,
              status: p.status,
              position: p.position ?? null,
            })),
            authorizesExecution: false,
          },
          display: [
            `Council deliberation for: ${objective}`,
            `Disagreement: ${session.disagreement.kind} — ${session.disagreement.detail}`,
            `Recommended level: ${synthesis.synthesis.recommendedOption.level}`,
            synthesis.synthesis.recommendedOption.summary,
            '',
            'Perspectives:',
            ...positions.map((p) => {
              const pos = p.position ?? {};
              return `  [${p.perspectiveName}] ${p.status === 'insufficient_input' ? 'insufficient input' : pos.verdict} — ${pos.evidence?.map((e) => e.detail).join('; ') || 'no detail'}`;
            }),
            '',
            'Synthesis:',
            `  Recommended: ${synthesis.synthesis.recommendedOption.level}`,
            `  Risks: ${synthesis.synthesis.risks.length ? synthesis.synthesis.risks.join('; ') : 'none flagged'}`,
            `  Unknowns: ${synthesis.synthesis.unknowns.length ? synthesis.synthesis.unknowns.join('; ') : 'none'}`,
            `  Required approvals: ${synthesis.synthesis.requiredApprovals.join('; ')}`,
            `  Reversibility: ${synthesis.synthesis.reversibility}`,
            '',
            'This is deliberation data. Nothing is authorized or executed. All consequential actions still pass through the Executive Control Plane.',
          ].join('\n'),
        };
      },
      async verify(ctx, { objective, evidence, candidateId }, result) {
        // Re-run deliberation and compare synthesized level and disagreement kind.
        const fresh = await ctx.council.deliberate({ objective, evidence, candidateId });
        if (result.data.synthesis.recommendedOption.level !== fresh.synthesis.synthesis.recommendedOption.level) {
          return { ok: false, detail: `recommended level differs on re-deliberation` };
        }
        if (result.data.disagreement.kind !== fresh.disagreement.kind) {
          return { ok: false, detail: `disagreement kind differs on re-deliberation` };
        }
        if (result.data.sessionId !== fresh.session.sessionId) {
          return { ok: false, detail: 'session id differs from a fresh deliberation' };
        }
        return { ok: true, detail: 'deliberation is deterministic: same input produces the same synthesis and disagreement' };
      },
    },
    {
      name: 'council.list',
      description: 'List recent council deliberation sessions. Read-only.',
      inputHint: '{"limit": optional 1-50}',
      permission: 'read',
      origins: [ORIGIN_USER, ORIGIN_MODEL],
      validate(input) {
        const o = expectObject(input ?? {}, ['limit']);
        return { limit: intField(o.limit, 'limit', 20, 1, 50) };
      },
      async execute(ctx, { limit }) {
        const page = await ctx.council.list({ limit });
        const display = page.sessions.length === 0
          ? '  (no council sessions stored)'
          : page.sessions.map((s) => `  [${s.sessionId}] ${s.objective ? singleLine(s.objective, 120) : '(no objective)'} — ${s.status} — ${s.at ? s.at.slice(0, 19) : ''}`).join('\n');
        return {
          summary: `${page.sessions.length} council session(s) listed`,
          data: page,
          display: `Council sessions (newest first):\n${display}`,
        };
      },
      async verify(ctx, { limit }, result) {
        const fresh = await ctx.council.list({ limit });
        if (result.data.sessions.length !== fresh.sessions.length) {
          return { ok: false, detail: `listed ${result.data.sessions.length}; an independent read gives ${fresh.sessions.length}` };
        }
        if (result.data.sessions.some((s, i) => s.sessionId !== fresh.sessions[i].sessionId)) {
          return { ok: false, detail: 'session ids differ from an independent read' };
        }
        return { ok: true, detail: `${fresh.sessions.length} session(s) confirmed against the store` };
      },
    },
    {
      name: 'council.get',
      description: 'Retrieve one council session by id. Read-only.',
      inputHint: '{"sessionId":"council session id"}',
      permission: 'read',
      origins: [ORIGIN_USER, ORIGIN_MODEL],
      validate(input) {
        const o = expectObject(input, ['sessionId']);
        const sessionId = o.sessionId === undefined ? null : textField(o.sessionId, 'sessionId', 128);
        if (!sessionId) throw new ValidationError('sessionId is required');
        return { sessionId };
      },
      async execute(ctx, { sessionId }) {
        const found = await ctx.council.session(sessionId);
        if (!found.found) throw new ValidationError(found.detail);
        const s = found.session;
        return {
          summary: `council session ${sessionId}`,
          data: {
            sessionId: s.sessionId,
            objective: s.objective,
            at: s.at,
            status: s.status,
            authorizesExecution: false,
          },
          display: [
            `Council session ${s.sessionId}`,
            `Objective: ${s.objective ? singleLine(s.objective, 200) : '(none)'}`,
            `At: ${s.at ? s.at.slice(0, 19) : ''}`,
            `Status: ${s.status}`,
            'Authorizes execution: no',
          ].join('\n'),
        };
      },
      async verify(ctx, { sessionId }, result) {
        const fresh = await ctx.council.session(sessionId);
        if (!fresh.found) return { ok: false, detail: 'session not found on re-read' };
        if (result.data.sessionId !== fresh.session.sessionId) {
          return { ok: false, detail: 'session id differs from an independent read' };
        }
        if (result.data.objective !== fresh.session.objective) {
          return { ok: false, detail: 'objective differs from an independent read' };
        }
        return { ok: true, detail: 'session confirmed against the store' };
      },
    },
  ];
}

export function createCouncilService({ dataDir, now, idFactory, registry }) {
  const store = new CouncilStore(`${dataDir}/council.jsonl`, { now, idFactory });
  return new CouncilService({ store, capabilityLookup: (name) => registry.get(name), now, idFactory });
}
