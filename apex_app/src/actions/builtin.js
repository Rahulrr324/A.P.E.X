// Built-in actions. Every action declares: input schema (validate), permission
// and origins (authorization), an execute body, and a verify procedure that
// checks the postcondition against the store or an independent computation.
// `verify` returns { ok, detail }, or null when no independent check is possible.
import { ExecutionError, ValidationError } from '../errors.js';
import { sha256Hex, validateContent } from '../memory/memory-store.js';
import { CONTROL_CHARS, round3, shortId, singleLine, truncate } from '../util.js';
import { evaluateExpression, evaluateRpn, validateExpression } from './calc.js';
import { APP_NAME, APP_STAGE, APP_VERSION } from '../identity.js';
import { ORIGIN_MODEL, ORIGIN_USER } from './origins.js';
import { contractProblems, renderProviderContract } from '../model/contract.js';
import { neuralBoundaryProblems, renderNeuralBoundary } from '../neural/diagnostics.js';

const OPERATION_ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const BACKEND_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const MEMORY_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function expectObject(input, allowedKeys) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('input must be an object');
  }
  for (const key of Object.keys(input)) {
    if (!allowedKeys.includes(key)) throw new ValidationError(`unexpected input field "${singleLine(key, 40)}"`);
  }
  return input;
}

function textField(value, name, min, max) {
  if (typeof value !== 'string') throw new ValidationError(`${name} must be text`);
  const t = value.trim();
  if (t.length < min) throw new ValidationError(`${name} is empty`);
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

function renderRecords(hits) {
  if (hits.length === 0) return '  (no matching memory records)';
  return hits.map((h) => {
    const status = h.status ?? h.updateMode;
    const replacements = h.replaces?.length ? `; corrects ${h.replaces.join(', ')}` : '';
    const replacedBy = h.replacedBy?.length ? `; superseded by ${h.replacedBy.join(', ')}` : '';
    const state = status ? ` [${status}${replacements}${replacedBy}]` : '';
    return `  [${h.id}] ${h.kind} from ${h.source}: ${h.content}${state}`;
  }).join('\n');
}

function hitsFromRecords(records) {
  return records.map((r) => ({
    id: r.id,
    kind: r.kind,
    source: r.source,
    createdAt: r.createdAt,
    content: r.content,
    updateMode: r.status ?? r.provenance?.updateMode,
    replaces: r.provenance?.replaces ?? [],
    replacedBy: r.replacedBy ?? [],
  }));
}

export function builtinActions() {
  return [
    {
      name: 'app.status',
      description: 'Report APEX application and memory status. No side effects.',
      inputHint: '{}',
      permission: 'read',
      origins: [ORIGIN_USER, ORIGIN_MODEL],
      validate(input) {
        expectObject(input ?? {}, []);
        return {};
      },
      async execute(ctx) {
        const s = await ctx.getStatus();
        return {
          summary: `${APP_NAME} ${APP_STAGE} ${APP_VERSION}; ${s.memoryRecords} memory record(s)`,
          data: s,
          display: `${APP_NAME} ${APP_STAGE} ${APP_VERSION}\n  memory records: ${s.memoryRecords} (corrupt lines skipped: ${s.corruptMemoryLines})\n  operation records: ${s.operationRecords}\n  model backend: ${s.model.configured ? s.model.endpoint : 'none configured'}`,
        };
      },
      async verify(ctx, _input, result) {
        const fresh = await ctx.memory.status();
        if (result.data.app !== APP_NAME) return { ok: false, detail: 'application identity mismatch' };
        if (result.data.memoryRecords !== fresh.records) {
          return { ok: false, detail: `reported ${result.data.memoryRecords} memory records; store holds ${fresh.records}` };
        }
        return { ok: true, detail: 'identity and memory count agree with an independent store read' };
      },
    },

    {
      // What APEX can actually do is the live registry, not a hand-written list. A read of it
      // is how a request ("what can you do about memory?") is answered without a model, and it
      // is the same list a plan is checked against, so the answer cannot offer an action the
      // planner would refuse. It is deliberately not plannable: listing capabilities is not a
      // step toward a goal, and offering it to a model plan would add a step that does nothing.
      name: 'app.capabilities',
      description: 'List the registered actions APEX can perform, optionally filtered by keyword. Reads the live registry; changes nothing.',
      inputHint: '{"query": optional text}',
      plannable: false,
      permission: 'read',
      origins: [ORIGIN_USER, ORIGIN_MODEL],
      validate(input) {
        const o = expectObject(input ?? {}, ['query']);
        return { query: o.query === undefined || o.query === null ? null : textField(o.query, 'query', 1, 200) };
      },
      async execute(ctx, { query }) {
        const defs = ctx.registry.list().sort((a, b) => a.name.localeCompare(b.name));
        const terms = query === null ? [] : query.toLowerCase().split(/\s+/).filter(Boolean);
        // Every term must appear in the name, description, or input hint. Matching is a plain
        // substring over data the registry already holds - no scoring, so the same query always
        // returns the same set.
        const matched = defs.filter((d) => {
          if (terms.length === 0) return true;
          const haystack = `${d.name} ${d.description} ${d.inputHint ?? ''}`.toLowerCase();
          return terms.every((t) => haystack.includes(t));
        });
        const actions = matched.map((d) => ({
          name: d.name,
          permission: d.permission,
          origins: [...d.origins],
          plannable: d.plannable !== false,
          description: truncate(d.description, 160),
          inputHint: d.plannable === false ? null : (d.inputHint ?? null),
        }));
        const reads = actions.filter((a) => a.permission === 'read').length;
        const writes = actions.length - reads;
        const families = [];
        for (const a of actions) {
          const family = a.name.split('.')[0];
          const existing = families.find((f) => f.family === family);
          if (existing) existing.count += 1;
          else families.push({ family, count: 1 });
        }
        const plannable = actions.filter((a) => a.plannable).length;
        const data = { query, total: defs.length, matched: actions.length, reads, writes, plannable, families, actions };

        const headline = query === null
          ? `${APP_NAME} has ${defs.length} registered action(s): ${reads} read, ${writes} write; ${plannable} can appear as a plan step.`
          : `${matched.length} of ${defs.length} registered action(s) match "${query}": ${reads} read, ${writes} write; ${plannable} can appear as a plan step.`;
        const lines = [
          headline,
          'Only these registered actions can run. A step runs only if the registry authorizes its action for the request origin, and a write action is never run on a model\'s own authority.',
        ];
        if (actions.length === 0) {
          lines.push('', `No registered action matches "${query}". Try a broader word such as "memory", "knowledge", "world", "plan", or "prediction".`);
        }
        let current = null;
        for (const a of actions) {
          const family = a.name.split('.')[0];
          if (family !== current) {
            current = family;
            lines.push('', `${family} (${families.find((f) => f.family === family).count})`);
          }
          const origins = a.origins.length === 1 ? a.origins[0] : a.origins.join(' + ');
          const tag = `${a.permission}; ${origins}${a.plannable ? '; plan step' : ''}`;
          lines.push(`  ${a.name} [${tag}] ${a.description}`);
          // The input shape is most useful when the list is narrow enough to act on; printing
          // it for every action would bury the names.
          if (query !== null && a.inputHint) lines.push(`      input: ${a.inputHint}`);
        }
        // A long registry must not truncate the answer into a partial one: an action that is
        // registered but missing from "what can you do" is a capability the user cannot discover.
        // The full form carries descriptions while it fits; past the bound the same list is printed
        // compactly, one action per line, so every name survives and the omission is stated.
        const full = lines.join('\n');
        const compact = [
          headline,
          'Descriptions are omitted because the full list exceeds the display bound. Every registered action is still named.',
          '',
          ...actions.map((a) => `  ${a.name} [${a.permission}; ${a.origins.join(' + ')}${a.plannable ? '; plan step' : ''}]`),
        ].join('\n');
        return {
          summary: `${actions.length} registered action(s) listed${query === null ? '' : ` for "${query}"`}`,
          data,
          display: truncate(full.length <= 12000 ? full : compact, 20000),
        };
      },
      async verify(ctx, _input, result) {
        // The answer is a claim about the live registry, so it is checked against a fresh read
        // of that registry rather than against the list the execute body built.
        const names = ctx.registry.names();
        if (result.data.total !== names.length) {
          return { ok: false, detail: `reported ${result.data.total} actions; the registry holds ${names.length}` };
        }
        const unknown = result.data.actions.map((a) => a.name).filter((n) => !names.includes(n));
        if (unknown.length > 0) return { ok: false, detail: `listed actions the registry does not hold: ${unknown.join(', ')}` };
        if (result.data.actions.length !== result.data.matched) {
          return { ok: false, detail: `listed ${result.data.actions.length} actions but reported ${result.data.matched} matches` };
        }
        if (result.data.matched > result.data.total) return { ok: false, detail: 'more matches than registered actions' };
        return { ok: true, detail: 'every listed action is registered and the total matches a fresh registry read' };
      },
    },

    {
      // A declaration, not a probe. The contract says what the configured backend and APEX's own
      // transport declare, and marks every entry unverified. It contacts nothing, so it is safe to
      // read at any time and cannot turn a reachable socket into a claim about generation quality.
      // Like app.capabilities it is deliberately not plannable: inspecting the model boundary is
      // not a step toward a goal.
      name: 'model.contracts',
      description: 'Report the declared model provider capabilities, protocol contracts, runtime limits and trust boundary. Contacts no endpoint.',
      inputHint: '{}',
      plannable: false,
      permission: 'read',
      origins: [ORIGIN_USER, ORIGIN_MODEL],
      validate(input) {
        expectObject(input ?? {}, []);
        return {};
      },
      async execute(ctx) {
        const contract = ctx.modelContract;
        const problems = contractProblems(contract);
        if (problems.length > 0) {
          throw new ExecutionError(`the model contract is unavailable: ${problems[0]}`);
        }
        return {
          summary: contract.configured
            ? `model provider ${contract.provider} declared (${contract.backend}); no endpoint was contacted`
            : 'no model backend is configured; no provider capability is claimed',
          data: contract,
          display: renderProviderContract(contract),
        };
      },
      async verify(ctx, _input, result) {
        const problems = contractProblems(result.data);
        if (problems.length > 0) return { ok: false, detail: problems[0] };
        // The identity fields are checked against a fresh status read, which asks the gateway for
        // its description again. That is an independent check of the declaration's source; it is
        // still not a probe, and the contract's own `probed: false` is part of the result.
        const fresh = await ctx.getStatus();
        const model = fresh?.model ?? {};
        if ((result.data.configured === true) !== (model.configured === true)) {
          return { ok: false, detail: 'the reported configuration state disagrees with a fresh status read' };
        }
        if (result.data.provider !== (model.provider ?? null)) {
          return { ok: false, detail: 'the reported provider disagrees with a fresh status read' };
        }
        if (result.data.endpoint !== (model.endpoint ?? null)) {
          return { ok: false, detail: 'the reported endpoint disagrees with a fresh status read' };
        }
        if (result.data.verified !== false || result.data.probed !== false) {
          return { ok: false, detail: 'a declared contract must be marked unprobed and unverified' };
        }
        return { ok: true, detail: 'the declaration agrees with a fresh status read; no endpoint was contacted' };
      },
    },

    {
      // The neural boundary is declared for the same reason as the model contract: a reader must
      // be able to see the versions, limits, isolation, and trust rules without contacting a runtime
      // and without mistaking the deterministic simulated transport for an integrated model. The
      // action is unplannable: inspecting a boundary is not a step toward a goal.
      name: 'neural.contract',
      description: 'Report the declared neural runtime boundary: contract versions, limits, isolation, simulated-transport availability and trust. Connects to no runtime and runs no inference.',
      inputHint: '{}',
      plannable: false,
      permission: 'read',
      origins: [ORIGIN_USER, ORIGIN_MODEL],
      validate(input) {
        expectObject(input ?? {}, []);
        return {};
      },
      async execute(ctx) {
        const declaration = ctx.neuralContract;
        const problems = neuralBoundaryProblems(declaration);
        if (problems.length > 0) {
          throw new ExecutionError(`the neural boundary declaration is unavailable: ${problems[0]}`);
        }
        return {
          summary: declaration.configured
            ? `neural transport ${declaration.transport.name} declared; no inference was run`
            : 'no neural runtime is configured; the contract and a deterministic simulated transport are declared',
          data: declaration,
          display: renderNeuralBoundary(declaration),
        };
      },
      async verify(ctx, _input, result) {
        const problems = neuralBoundaryProblems(result.data);
        if (problems.length > 0) return { ok: false, detail: problems[0] };
        const fresh = ctx.neuralContract;
        for (const field of ['configured', 'requestSchema', 'responseSchema']) {
          if (result.data[field] !== fresh[field]) {
            return { ok: false, detail: `the reported ${field} disagrees with a fresh declaration` };
          }
        }
        if ((result.data.transport?.name ?? null) !== (fresh.transport?.name ?? null)
          || (result.data.transport?.simulated ?? false) !== (fresh.transport?.simulated ?? false)) {
          return { ok: false, detail: 'the reported transport disagrees with a fresh declaration' };
        }
        if (JSON.stringify(result.data.limits) !== JSON.stringify(fresh.limits)) {
          return { ok: false, detail: 'the reported limits disagree with a fresh declaration' };
        }
        if (result.data.verified !== false || result.data.probed !== false || result.data.inferenceTested !== false) {
          return { ok: false, detail: 'a boundary declaration must stay unprobed, unverified, and untested' };
        }
        return { ok: true, detail: 'the declaration is internally consistent and agrees with a fresh read; nothing was contacted' };
      },
    },

    {
      name: 'memory.search',
      description: 'Search personal memory by keyword. Read-only.',
      inputHint: '{"query": "text", "limit": optional 1-50}',
      permission: 'read',
      origins: [ORIGIN_USER, ORIGIN_MODEL],
      validate(input) {
        const o = expectObject(input, ['query', 'limit']);
        return {
          query: textField(o.query, 'query', 1, 500),
          limit: intField(o.limit, 'limit', 5, 1, 50),
        };
      },
      async execute(ctx, { query, limit }) {
        // Private memories are visible to the user only, never to a model-origin request.
        const found = await ctx.memory.search(query, { limit, includePrivate: ctx.origin !== ORIGIN_MODEL });
        const data = {
          query,
          hits: found.map((h) => ({
            ...hitsFromRecords([h.record])[0],
            score: round3(h.score),
            status: h.status,
            replaces: h.replaces,
            replacedBy: h.replacedBy,
          })),
        };
        return {
          summary: `${data.hits.length} matching memory record(s)`,
          data,
          display: `Memory matches for "${query}":\n${renderRecords(data.hits)}`,
        };
      },
      async verify(ctx, { query, limit }, result) {
        const fresh = await ctx.memory.search(query, { limit, includePrivate: ctx.origin !== ORIGIN_MODEL });
        const claimed = result.data.hits.map((h) => h.id);
        const actual = fresh.map((h) => h.record.id);
        if (claimed.length !== actual.length || claimed.some((id, i) => id !== actual[i])) {
          return { ok: false, detail: 'returned hits differ from an independent store search' };
        }
        for (const h of result.data.hits) {
          const rec = await ctx.memory.get(h.id);
          if (!rec || rec.content !== h.content) return { ok: false, detail: `record ${shortId(h.id)} is missing or its content differs` };
        }
        return { ok: true, detail: `${claimed.length} hit(s) confirmed against the store` };
      },
    },

    {
      name: 'memory.list',
      description: 'List the most recent personal memory records. Read-only.',
      inputHint: '{"limit": optional 1-100}',
      permission: 'read',
      origins: [ORIGIN_USER, ORIGIN_MODEL],
      validate(input) {
        const o = expectObject(input ?? {}, ['limit']);
        return { limit: intField(o.limit, 'limit', 20, 1, 100) };
      },
      async execute(ctx, { limit }) {
        const hits = hitsFromRecords(await ctx.memory.list({ limit, includePrivate: ctx.origin !== ORIGIN_MODEL }));
        return {
          summary: `${hits.length} memory record(s) listed`,
          data: { limit, hits },
          display: `Most recent memory records:\n${renderRecords(hits)}`,
        };
      },
      async verify(ctx, { limit }, result) {
        const fresh = await ctx.memory.list({ limit, includePrivate: ctx.origin !== ORIGIN_MODEL });
        const expected = fresh.length;
        if (result.data.hits.length !== expected || result.data.hits.some((h, i) => h.id !== fresh[i].id)) {
          return { ok: false, detail: `listed ${result.data.hits.length}; an independent read gives ${expected}` };
        }
        for (let i = 1; i < result.data.hits.length; i += 1) {
          if (result.data.hits[i - 1].createdAt < result.data.hits[i].createdAt) {
            return { ok: false, detail: 'records are not newest-first' };
          }
        }
        for (const h of result.data.hits) {
          const rec = await ctx.memory.get(h.id);
          if (!rec || rec.content !== h.content) return { ok: false, detail: `record ${shortId(h.id)} is missing or its content differs` };
        }
        return { ok: true, detail: `${expected} record(s) confirmed against the store` };
      },
    },

    // Filesystem actions live in src/filesystem/actions.js and are registered by the composition
    // root only when APEX_FILESYSTEM_ROOT is configured; there is no default authorized root.
    {
      name: 'memory.add',
      description: 'Store a user-provided fact in memory. Write: user origin only.',
      inputHint: '{"content": "text to remember", "sensitivity": "normal or private"}',
      permission: 'write',
      origins: [ORIGIN_USER],
      validate(input) {
        const o = expectObject(input, ['content', 'sensitivity']);
        const sensitivity = o.sensitivity === undefined ? 'normal' : o.sensitivity;
        if (sensitivity !== 'normal' && sensitivity !== 'private') throw new ValidationError('sensitivity must be normal or private');
        return { content: validateContent(o.content), sensitivity };
      },
      async execute(ctx, { content, sensitivity }) {
        const rec = await ctx.memory.add({
          content,
          kind: 'user_fact',
          source: 'user',
          sensitivity,
          provenance: { origin: 'user_request', operationId: ctx.operationId },
        });
        const label = sensitivity === 'private' ? 'private user fact' : 'user fact';
        return {
          summary: `stored ${label} ${shortId(rec.id)}`,
          data: { id: rec.id, kind: rec.kind, source: rec.source, sensitivity: rec.sensitivity, content: rec.content },
          display: `Stored (${label}) ${shortId(rec.id)}${sensitivity === 'private' ? ' - never sent to a model' : ''}`,
        };
      },
      async verify(ctx, { content, sensitivity }, result) {
        const rec = await ctx.memory.get(result.data.id);
        if (!rec) return { ok: false, detail: 'record not found in store after write' };
        if (rec.contentSha256 !== sha256Hex(content)) return { ok: false, detail: 'stored content hash differs from the requested content' };
        if (rec.kind !== 'user_fact' || rec.source !== 'user') return { ok: false, detail: 'stored provenance differs from the request' };
        if ((rec.sensitivity ?? 'normal') !== sensitivity) return { ok: false, detail: 'stored sensitivity differs from the request' };
        return { ok: true, detail: 'record present; content hash, provenance, and sensitivity match' };
      },
    },

    {
      name: 'memory.correct',
      description: 'Append a user-confirmed correction to one explicitly identified memory claim. User origin only.',
      inputHint: '{"targetId":"full memory record ID", "content":"replacement claim", "resolve":true}',
      plannable: false,
      permission: 'write',
      origins: [ORIGIN_USER],
      validate(input) {
        const o = expectObject(input, ['targetId', 'content', 'resolve']);
        if (typeof o.targetId !== 'string' || !MEMORY_ID_RE.test(o.targetId)) {
          throw new ValidationError('targetId must be a full memory record ID');
        }
        if (o.resolve !== true) throw new ValidationError('explicit --resolve confirmation is required');
        return { targetId: o.targetId, content: validateContent(o.content), resolve: true };
      },
      async execute(ctx, { targetId, content }) {
        const rec = await ctx.memory.correct({ targetId, content, origin: ctx.origin });
        return {
          summary: `stored user-confirmed correction ${shortId(rec.id)} for ${shortId(targetId)}`,
          data: { id: rec.id, targetId, contentSha256: rec.contentSha256, sensitivity: rec.sensitivity },
          display: `Stored correction ${rec.id}; it explicitly corrects ${targetId}. Earlier evidence remains stored.`,
        };
      },
      async verify(ctx, { targetId, content }, result) {
        const rec = await ctx.memory.get(result.data.id);
        const target = await ctx.memory.get(targetId);
        if (!rec || !target) return { ok: false, detail: 'correction or original claim is missing from memory' };
        if (rec.contentSha256 !== sha256Hex(content)) return { ok: false, detail: 'stored correction hash differs from the requested replacement' };
        if (rec.source !== 'user' || rec.kind !== 'user_fact') return { ok: false, detail: 'correction is not stored as a user fact' };
        if ((rec.sensitivity ?? 'normal') !== (target.sensitivity ?? 'normal')) {
          return { ok: false, detail: 'correction sensitivity differs from the original claim' };
        }
        if (rec.provenance.origin !== 'user_memory_correction' || rec.provenance.updateMode !== 'user_confirmed') {
          return { ok: false, detail: 'correction provenance is not user-confirmed' };
        }
        if (rec.provenance.replaces?.length !== 1 || rec.provenance.replaces[0] !== targetId) {
          return { ok: false, detail: 'replacement link does not match the selected claim' };
        }
        return { ok: true, detail: 'correction and exact historical replacement link confirmed in memory' };
      },
    },

    {
      name: 'memory.save_conclusion',
      description: 'Store a model answer as a model_conclusion after explicit user approval. Write: user origin only.',
      plannable: false,
      permission: 'write',
      origins: [ORIGIN_USER],
      validate(input) {
        const o = expectObject(input, ['content', 'operationId', 'backend']);
        const operationId = o.operationId === undefined ? null : textField(o.operationId, 'operationId', 1, 64);
        if (operationId !== null && !OPERATION_ID_RE.test(operationId)) throw new ValidationError('operationId has an invalid format');
        const backend = o.backend === undefined ? null : textField(o.backend, 'backend', 1, 64);
        if (backend !== null && !BACKEND_RE.test(backend)) throw new ValidationError('backend has an invalid format');
        return { content: validateContent(o.content), operationId, backend };
      },
      async execute(ctx, { content, operationId, backend }) {
        const rec = await ctx.memory.add({
          content,
          kind: 'model_conclusion',
          source: 'model',
          provenance: { origin: 'model_output_approved_by_user', operationId: operationId ?? undefined, backend: backend ?? undefined },
        });
        return {
          summary: `stored model conclusion ${shortId(rec.id)}`,
          data: { id: rec.id, kind: rec.kind, source: rec.source, content: rec.content, operationId, backend },
          display: `Stored (model conclusion, user-approved) ${shortId(rec.id)}`,
        };
      },
      async verify(ctx, { content, operationId }, result) {
        const rec = await ctx.memory.get(result.data.id);
        if (!rec) return { ok: false, detail: 'record not found in store after write' };
        if (rec.contentSha256 !== sha256Hex(content)) return { ok: false, detail: 'stored content hash differs from the approved content' };
        if (rec.kind !== 'model_conclusion' || rec.source !== 'model') return { ok: false, detail: 'stored provenance is not model_conclusion' };
        if (operationId && rec.provenance.operationId !== operationId) return { ok: false, detail: 'operation link missing from provenance' };
        return { ok: true, detail: 'record present; content hash and model provenance match' };
      },
    },

    {
      name: 'calc.evaluate',
      description: 'Evaluate a plain arithmetic expression (+ - * / and parentheses). Deterministic.',
      inputHint: '{"expression": "e.g. (2+3)*4"}',
      permission: 'read',
      origins: [ORIGIN_USER, ORIGIN_MODEL],
      validate(input) {
        const o = expectObject(input, ['expression']);
        return { expression: validateExpression(o.expression) };
      },
      async execute(_ctx, { expression }) {
        const value = evaluateExpression(expression);
        return {
          summary: `${expression} = ${value}`,
          data: { expression, value },
          display: `${expression} = ${value}`,
        };
      },
      async verify(_ctx, { expression }, result) {
        // Independent method (shunting-yard) recomputes the value from the same input.
        const independent = evaluateRpn(expression);
        const claimed = result.data.value;
        const tolerance = 1e-9 * Math.max(1, Math.abs(claimed));
        if (!Number.isFinite(claimed) || Math.abs(claimed - independent) > tolerance) {
          return { ok: false, detail: `executor gave ${claimed}; independent evaluation gives ${independent}` };
        }
        return { ok: true, detail: `independent evaluation agrees: ${independent}` };
      },
    },
  ];
}
