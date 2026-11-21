// Council actions: registered by the composition root alongside every other capability.
// The council is a read-oriented deliberation surface: it evaluates evidence and produces a
// synthesis, but never authorizes or executes anything.
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

function optionalText(value, name, max) {
  if (value === undefined || value === null || value === '') return null;
  return textField(value, name, max);
}

function intField(value, name, fallback, min, max) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ValidationError(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function evidenceField(value, limit) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ValidationError('evidence must be a list');
  if (value.length > limit) throw new ValidationError(`at most ${limit} evidence items may be cited`);
  const out = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new ValidationError('each evidence item must be an object');
    const evidenceId = textField(item.evidenceId, 'evidence.evidenceId', 120);
    const source = textField(item.source, 'evidence.source', 80);
    if (typeof item.claim !== 'string') throw new ValidationError('each evidence item needs a claim');
    if (item.claim.length > 500) throw new ValidationError('an evidence claim exceeds 500 characters');
    out.push({
      evidenceId,
      source,
      recordId: optionalText(item.recordId, 'evidence.recordId', 160),
      claim: item.claim,
      trust: optionalText(item.trust, 'evidence.trust', 40),
      relation: optionalText(item.relation, 'evidence.relation', 40),
      current: item.current !== false,
      validity: optionalText(item.validity, 'evidence.validity', 40),
      validFrom: optionalText(item.validFrom, 'evidence.validFrom', 40),
      validUntil: optionalText(item.validUntil, 'evidence.validUntil', 40),
      observedAt: optionalText(item.observedAt, 'evidence.observedAt', 40),
    });
  }
  return out;
}

function resourceContextField(value) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError('resourceContext must be an object');
  const allowed = ['cpuMillis', 'memoryBytes', 'storageBytes', 'networkBytes', 'gpuMemoryBytes', 'available', 'capacity'];
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new ValidationError(`unexpected resourceContext field "${singleLine(key, 40)}"`);
  }
  const out = {};
  for (const key of allowed) {
    if (value[key] === undefined) continue;
    if (key === 'available') {
      if (typeof value[key] !== 'boolean' && typeof value[key] !== 'number') throw new ValidationError('resourceContext.available must be a boolean or a number');
      out[key] = value[key];
    } else if (key === 'capacity') {
      if (!value[key] || typeof value[key] !== 'object' || Array.isArray(value[key])) throw new ValidationError('resourceContext.capacity must be an object');
      out[key] = value[key];
    } else {
      if (!Number.isSafeInteger(value[key]) || value[key] < 0) throw new ValidationError(`resourceContext.${key} must be a non-negative integer`);
      out[key] = value[key];
    }
  }
  return out;
}

function taskRecordField(value) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError('taskRecord must be an object');
  const allowed = ['taskId', 'id', 'status', 'deadline', 'dueAt', 'steps', 'dependents'];
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new ValidationError(`unexpected taskRecord field "${singleLine(key, 40)}"`);
  }
  const steps = Array.isArray(value.steps) ? value.steps.slice(0, 200).map((step) => {
    if (!step || typeof step !== 'object') throw new ValidationError('each task step must be an object');
    return {
      status: step.status === undefined ? null : String(step.status).slice(0, 40),
      verified: step.verified === true,
      outcome: step.outcome === undefined ? null : String(step.outcome).slice(0, 40),
      approval: step.approval === true,
    };
  }) : [];
  return {
    taskId: value.taskId ?? value.id ?? null,
    status: value.status ?? null,
    deadline: value.deadline ?? value.dueAt ?? null,
    steps,
    dependents: Array.isArray(value.dependents) ? value.dependents.slice(0, 64).map((d) => String(d).slice(0, 120)) : [],
  };
}

function candidateField(value) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError('candidate must be an object');
  const allowed = ['id', 'action', 'description'];
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new ValidationError(`unexpected candidate field "${singleLine(key, 40)}"`);
  }
  return {
    id: optionalText(value.id, 'candidate.id', 128),
    action: optionalText(value.action, 'candidate.action', 128),
    description: optionalText(value.description, 'candidate.description', 500),
  };
}

export function councilActions(councilService) {
  return [
    {
      name: 'council.deliberate',
      description: 'Run deterministic multi-perspective council evaluation over cited or gathered evidence. Read-oriented: produces a synthesis and disagreement record, never authorizes execution.',
      inputHint: '{"objective":"text","evidence":[{"evidenceId","source","claim"}],"candidate":{"action","description"},"useContext":false}',
      permission: 'read',
      // Deliberation appends one session to the council log, so it is a user-origin act even
      // though it evaluates rather than changes the world. A model-origin request may read a
      // session but may not make the council produce one.
      origins: [ORIGIN_USER],
      // A synthesis is a judgement about a moment, not a step with a world effect. Letting a plan
      // include one would record a decision as if it were an executed step, so it is not a plan
      // capability; the UI and the CLI call it directly through the ECP.
      plannable: false,
      validate(input) {
        const o = expectObject(input, [
          'objective', 'evidence', 'candidateId', 'candidate', 'limit', 'useContext',
          'resourceContext', 'taskRecord', 'signalledContradiction',
        ]);
        const objective = textField(o.objective, 'objective', 2000);
        const limit = intField(o.limit, 'limit', 40, 1, 40);
        const evidence = evidenceField(o.evidence, limit);
        const candidateId = optionalText(o.candidateId, 'candidateId', 128);
        const candidate = candidateField(o.candidate);
        if (candidateId && !candidate) {
          // A bare candidateId is resolved by the service through its configured context owner;
          // it is never treated as capability metadata on its own.
        }
        const useContext = o.useContext === true;
        return {
          objective,
          evidence,
          candidateId,
          candidate,
          limit,
          useContext,
          resourceContext: resourceContextField(o.resourceContext),
          taskRecord: taskRecordField(o.taskRecord),
          signalledContradiction: optionalText(o.signalledContradiction, 'signalledContradiction', 500),
        };
      },
      async execute(ctx, input) {
        const result = await ctx.council.deliberate(input);
        const synthesis = result.synthesis;
        const session = result.session;
        return {
          summary: `council deliberation complete; ${result.positions.length} perspectives, disagreement: ${result.disagreement.kind}${result.persisted ? '' : ' (not persisted)'}`,
          data: {
            sessionId: session.sessionId,
            objective: input.objective,
            evaluatedAt: session.evaluatedAt,
            evidenceProvenance: result.evidenceProvenance,
            persisted: result.persisted,
            persistenceError: result.persistenceError,
            synthesis: synthesis.synthesis,
            disagreement: result.disagreement,
            disagreementExplanation: synthesis.disagreementExplanation,
            positions: result.positions.map((p) => ({
              perspectiveId: p.perspectiveId,
              perspectiveName: p.perspectiveName,
              status: p.status,
              position: p.position ?? null,
              method: p.method,
              limitations: p.limitations,
              assumptions: p.assumptions,
              // T-37 Step 2: the Values & Constraints Core travels with its own rule-by-rule
              // evaluation. The other seven perspectives have no such field and it stays undefined
              // for them rather than being filled with an empty object.
              ...(p.evaluation === undefined ? {} : { evaluation: p.evaluation }),
              ...(p.values === undefined ? {} : { values: p.values }),
            })),
            authorizesExecution: false,
          },
          display: [
            `Council deliberation for: ${input.objective}`,
            `Evidence mode: ${result.evidenceProvenance.mode} (supplied ${result.evidenceProvenance.supplied}, gathered ${result.evidenceProvenance.gathered})`,
            `Disagreement: ${result.disagreement.kind} — ${result.disagreement.detail}`,
            `Recommended level: ${synthesis.synthesis.recommendedOption.level} (support: ${synthesis.synthesis.support}, confidence: ${synthesis.synthesis.confidence})`,
            synthesis.synthesis.recommendedOption.summary,
            '',
            'Perspectives:',
            ...result.positions.map((p) => {
              const pos = p.position ?? {};
              return `  [${p.perspectiveName}] ${p.status === 'insufficient_input' ? 'insufficient input' : pos.verdict} — ${pos.summary ?? pos.evidence?.map((e) => e.detail).join('; ') ?? 'no detail'}`;
            }),
            '',
            'Synthesis:',
            `  Recommended: ${synthesis.synthesis.recommendedOption.level}`,
            `  Supporting evidence: ${synthesis.synthesis.supportingEvidence.length}`,
            `  Conflicting evidence: ${synthesis.synthesis.conflictingEvidence.length}`,
            `  Risks: ${synthesis.synthesis.risks.length ? synthesis.synthesis.risks.join('; ') : 'none flagged'}`,
            `  Unknowns: ${synthesis.synthesis.unknowns.length ? synthesis.synthesis.unknowns.join('; ') : 'none'}`,
            `  Missing information: ${synthesis.synthesis.missingInformation.length ? synthesis.synthesis.missingInformation.join('; ') : 'none'}`,
            `  Required approvals: ${synthesis.synthesis.requiredApprovals.join('; ')}`,
            `  Reversibility: ${synthesis.synthesis.reversibility}`,
            result.persisted ? '' : `NOT PERSISTED: ${result.persistenceError ?? 'the council store is unavailable'}`,
            '',
            'This is deliberation data. Nothing is authorized or executed. All consequential actions still pass through the Executive Control Plane.',
          ].join('\n'),
        };
      },
      async verify(ctx, input, result) {
        // Recompute the same deliberation without writing a second session, and compare the
        // synthesis and disagreement the caller was shown. The session ID is content-addressed
        // and includes the evaluation time, so it will differ between runs with different clocks;
        // we compare the deterministic parts only.
        const fresh = await ctx.council.deliberate({ ...input, useContext: false });
        if (result.data.synthesis.recommendedOption.level !== fresh.synthesis.synthesis.recommendedOption.level) {
          return { ok: false, detail: 'recommended level differs on re-deliberation' };
        }
        if (result.data.disagreement.kind !== fresh.disagreement.kind) {
          return { ok: false, detail: 'disagreement kind differs on re-deliberation' };
        }
        // Positions and their verdicts should be identical for identical inputs.
        for (let i = 0; i < result.data.positions.length; i++) {
          const a = result.data.positions[i];
          const b = fresh.positions[i];
          if (a.position?.verdict !== b.position?.verdict) {
            return { ok: false, detail: `position ${i} verdict differs: ${a.position?.verdict} vs ${b.position?.verdict}` };
          }
        }
        return { ok: true, detail: 'deliberation is deterministic: the same input produces the same synthesis and disagreement' };
      },
    },
    {
      name: 'council.list',
      description: 'List recent council deliberation sessions. Read-only.',
      inputHint: '{"limit": optional 1-50}',
      permission: 'read',
      origins: [ORIGIN_USER, ORIGIN_MODEL],
      // Session inspection is a workspace read, never a plan step.
      plannable: false,
      validate(input) {
        const o = expectObject(input ?? {}, ['limit']);
        return { limit: intField(o.limit, 'limit', 20, 1, 50) };
      },
      async execute(ctx, { limit }) {
        const page = await ctx.council.list({ limit });
        const display = page.sessions.length === 0
          ? '  (no council sessions stored)'
          : page.sessions.map((s) => `  [${s.sessionId}] ${s.objective ? singleLine(s.objective, 120) : '(no objective)'} — ${s.status} — ${s.recommendation ?? 'no recommendation'} — ${s.at ? s.at.slice(0, 19) : ''}`).join('\n');
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
      description: 'Retrieve one council session by id, including its synthesis. Read-only.',
      inputHint: '{"sessionId":"council session id"}',
      permission: 'read',
      origins: [ORIGIN_USER, ORIGIN_MODEL],
      // Session inspection is a workspace read, never a plan step.
      plannable: false,
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
          summary: `council session ${s.sessionId}`,
          data: {
            sessionId: s.sessionId,
            objective: s.objective,
            evaluatedAt: s.evaluatedAt,
            at: s.evaluatedAt,
            status: s.status,
            synthesis: s.synthesis?.synthesis ?? null,
            disagreement: s.disagreement ?? null,
            positions: s.positions ?? [],
            evidenceSet: s.evidenceSet ?? null,
            contentDigest: s.contentDigest,
            previousDigest: s.previousDigest,
            authorizesExecution: false,
          },
          display: [
            `Council session ${s.sessionId}`,
            `Objective: ${s.objective ? singleLine(s.objective, 200) : '(none)'}`,
            `Evaluated: ${s.evaluatedAt ? s.evaluatedAt.slice(0, 19) : ''}`,
            `Status: ${s.status}`,
            `Recommendation: ${s.synthesis?.synthesis?.recommendedOption?.level ?? 'none'}`,
            `Support: ${s.synthesis?.synthesis?.support ?? 'unknown'}`,
            'Authorizes execution: no',
          ].join('\n'),
        };
      },
      async verify(ctx, { sessionId }, result) {
        const fresh = await ctx.council.session(sessionId);
        if (!fresh.found) return { ok: false, detail: 'session not found on re-read' };
        if (result.data.sessionId !== fresh.session.sessionId) return { ok: false, detail: 'session id differs from an independent read' };
        if (result.data.objective !== fresh.session.objective) return { ok: false, detail: 'objective differs from an independent read' };
        if (result.data.contentDigest !== fresh.session.contentDigest) return { ok: false, detail: 'content digest differs from an independent read' };
        return { ok: true, detail: 'session confirmed against the store' };
      },
    },
    {
      name: 'council.replay',
      description: 'Recompute a stored council session from its recorded input at its recorded evaluation time. Read-only; writes nothing.',
      inputHint: '{"sessionId":"council session id"}',
      permission: 'read',
      origins: [ORIGIN_USER, ORIGIN_MODEL],
      // Session inspection is a workspace read, never a plan step.
      plannable: false,
      validate(input) {
        const o = expectObject(input, ['sessionId']);
        const sessionId = o.sessionId === undefined ? null : textField(o.sessionId, 'sessionId', 128);
        if (!sessionId) throw new ValidationError('sessionId is required');
        return { sessionId };
      },
      async execute(ctx, { sessionId }) {
        const result = await ctx.council.replay(sessionId);
        if (!result.replayed) throw new ValidationError(result.reason ?? 'replay failed');
        return {
          summary: result.match ? 'council session replay matches the stored synthesis' : 'council session replay differs from the stored synthesis',
          data: result,
          display: [
            `Replay ${result.sessionId} at ${result.evaluatedAt}`,
            result.detail,
            ...(result.differences?.length ? [`Differences: ${result.differences.map((d) => `${d.perspectiveId} stored=${d.stored} replayed=${d.replayed}`).join('; ')}`] : []),
          ].join('\n'),
        };
      },
      async verify(_ctx, _input, result) {
        return result.data.match
          ? { ok: true, detail: result.data.detail }
          : { ok: false, detail: result.data.detail };
      },
    },
    {
      name: 'council.compare',
      description: 'Compare two council sessions, preserving every difference. Read-only.',
      inputHint: '{"a":"session id","b":"session id"}',
      permission: 'read',
      origins: [ORIGIN_USER, ORIGIN_MODEL],
      // Session inspection is a workspace read, never a plan step.
      plannable: false,
      validate(input) {
        const o = expectObject(input, ['a', 'b']);
        const a = textField(o.a, 'a', 128);
        const b = textField(o.b, 'b', 128);
        return { a, b };
      },
      async execute(ctx, { a, b }) {
        const result = await ctx.council.compare(a, b);
        if (!result.compared) throw new ValidationError(result.reason ?? 'comparison failed');
        return {
          summary: `${result.perspectiveDifferences.length} perspective difference(s) between the two sessions`,
          data: result,
          display: [
            `A: ${result.a.sessionId} (${result.recommendationA})`,
            `B: ${result.b.sessionId} (${result.recommendationB})`,
            result.sameInput ? 'The two sessions record the same input.' : 'The two sessions record different input.',
            ...result.perspectiveDifferences.map((d) => `  ${d.perspectiveId}: ${d.a} -> ${d.b}`),
            result.note,
          ].join('\n'),
        };
      },
      async verify(_ctx, _input, result) {
        return { ok: true, detail: result.data.note };
      },
    },
  ];
}

export function createCouncilService({ dataDir, now, idFactory, registry, reasoning = null, controlPlane = null }) {
  const store = new CouncilStore(`${dataDir}/council.jsonl`, { now, idFactory });
  // Gathered evidence comes from the existing ReasoningService, which is the bounded read owner
  // across memory, knowledge, world model, documents and situational observations. The council
  // neither reads those stores itself nor keeps a second copy of them.
  const evidenceProvider = reasoning && typeof reasoning.reason === 'function'
    ? async ({ objective, signal }) => {
      const session = await reasoning.reason({ request: objective, origin: 'runtime', persist: false, signal });
      return {
        items: Array.isArray(session?.evidence?.items) ? session.evidence.items : [],
        limitations: Array.isArray(session?.evidence?.limitations) ? session.evidence.limitations : [],
      };
    }
    : null;
  return new CouncilService({
    store,
    capabilityLookup: (name) => registry.get(name),
    // T-37 Step 2: a candidate may be named by the id of a registered capability. Resolving one is a
    // read of the registry - it creates nothing and authorizes nothing - and it is what lets the
    // constraint core evaluate a real declaration instead of reporting every rule unverifiable.
    // A name the registry does not hold resolves to null, which the core reports honestly.
    context: {
      candidate: (candidateId) => {
        if (typeof candidateId !== 'string' || candidateId.length === 0 || candidateId.length > 128) return null;
        const definition = registry.get(candidateId);
        if (!definition) return null;
        return {
          id: candidateId,
          action: candidateId,
          name: definition.name ?? candidateId,
          description: definition.description ?? `run ${candidateId}`,
        };
      },
    },
    // T-37 Step 2: the constraint core's lockdown rule reads the same latch the ECP enforces. It is a
    // read of the latch's state, not a handle to it: the Council cannot engage or release anything.
    latchLookup: controlPlane && typeof controlPlane.killSwitchStatus === 'function'
      ? () => {
        const status = controlPlane.killSwitchStatus();
        return { active: status?.active === true, policyUnavailable: status?.policyUnavailable === true };
      }
      : null,
    evidenceProvider,
    evidenceProviderName: evidenceProvider ? 'reasoning' : null,
    now,
    idFactory,
  });
}
