// Workshop actions: the user composes a design sheet, and either origin can read, inspect, or
// simulate a stored one. A composition is a write; inspection and simulation are reads that
// recompute from the stored record and write nothing.
//
// A workshop report is arithmetic over declared numbers. It is never an authorization, never a
// claim that code ran, and never a substitute for the ECP's decision to run an action.
import { ExecutionError, ValidationError } from '../errors.js';
import {
  canonicalJson, normalizeComposition, WorkshopError,
} from '../workshop/index.js';
import { textInput } from './inputs.js';
import { ORIGIN_MODEL, ORIGIN_USER } from './origins.js';

function show(summary, data, display) {
  return { summary, data, display: display ?? summary };
}

function artifactRef(value) {
  return textInput(value, 'artifact id', { max: 64 });
}

// The pure module speaks WorkshopError; an action reports a rejected input the way the rest of
// the registry does.
function normalizeForAction(input) {
  try {
    return normalizeComposition(input);
  } catch (err) {
    if (err instanceof WorkshopError) throw new ValidationError(err.message);
    throw err;
  }
}

function requireArtifact(found, artifactId) {
  if (!found.found) throw new ExecutionError('WORKSHOP_NOT_FOUND', found.detail ?? `no workshop artifact for ${artifactId}`);
  return found.artifact;
}

function sameReport(a, b) {
  return canonicalJson(a) === canonicalJson(b);
}

export function workshopActions(workshop) {
  return [
    {
      name: 'workshop.compose',
      description: 'Compose an immutable design sheet: components with declared supply, demand and cost, plus connections between them and an optional budget. The sheet is stored, never executed. User origin only.',
      inputHint: '{"title": "text", "domain": "generic|code|circuit|cad|data|plan", "components": [{"id": "api", "label": "API", "kind": "service", "supply": 10, "demand": 0, "cost": 2}], "connections": [{"from": "api", "to": "db"}], "budget": {"total": 20}, "note": "text"}',
      permission: 'write',
      origins: [ORIGIN_USER],
      plannable: false,
      validate(input) {
        return normalizeForAction(input);
      },
      async execute(ctx, input) {
        if (!ctx?.workshop) throw new ExecutionError('WORKSHOP_UNAVAILABLE', 'the workshop is not available in this configuration');
        const composed = await ctx.workshop.compose(input);
        const artifact = composed.artifact;
        const simulation = await ctx.workshop.simulate(artifact.artifactId);
        return show(
          `composed workshop artifact ${artifact.artifactId} (${artifact.components.length} component(s), ${artifact.connections.length} connection(s))`,
          {
            artifactId: artifact.artifactId,
            identityDigest: artifact.identityDigest,
            title: artifact.title,
            domain: artifact.domain,
            components: artifact.components.length,
            connections: artifact.connections.length,
            budget: artifact.budget === null ? null : artifact.budget.total,
            appended: composed.appended,
            duplicate: composed.duplicate,
            simulationStatus: simulation.found ? simulation.report.status : null,
            authorizesExecution: false,
            executedCode: false,
          },
          `Workshop artifact ${artifact.artifactId} stored: "${artifact.title}" (${artifact.domain}), ${artifact.components.length} component(s), ${artifact.connections.length} connection(s).\n`
            + `${composed.duplicate ? 'The same sheet was already stored, so no second record was written.' : 'The sheet was appended to the workshop log.'}\n`
            + `A simulation is arithmetic over the declared numbers. Nothing was executed and nothing was authorized.`,
        );
      },
      async verify(ctx, _input, result) {
        try {
          const found = await ctx.workshop.get(result.data.artifactId);
          if (!found.found) return { ok: false, detail: 'the composed artifact cannot be read back' };
          const artifact = found.artifact;
          if (artifact.identityDigest !== result.data.identityDigest) {
            return { ok: false, detail: 'the stored artifact digest differs from the reported digest' };
          }
          if (artifact.components.length !== result.data.components) {
            return { ok: false, detail: 'the stored component count differs from the reported count' };
          }
          if (artifact.connections.length !== result.data.connections) {
            return { ok: false, detail: 'the stored connection count differs from the reported count' };
          }
          const simulation = await ctx.workshop.simulate(artifact.artifactId);
          if (!simulation.found) return { ok: false, detail: 'the stored artifact cannot be simulated' };
          if (simulation.report.status !== result.data.simulationStatus) {
            return { ok: false, detail: 'a fresh simulation of the stored artifact disagrees with the reported status' };
          }
          return { ok: true, detail: `artifact ${artifact.artifactId} confirmed by an independent read and simulation` };
        } catch (err) {
          return { ok: false, detail: `the artifact could not be re-read: ${err?.message ?? err}` };
        }
      },
    },
    {
      name: 'workshop.list',
      description: 'List stored workshop artifacts, newest first. Reads the workshop log and writes nothing.',
      inputHint: '{"limit": optional 1-200}',
      permission: 'read',
      origins: [ORIGIN_USER, ORIGIN_MODEL],
      plannable: false,
      validate(input) {
        if (input === null || typeof input !== 'object' || Array.isArray(input)) {
          throw new ValidationError('input must be an object');
        }
        for (const key of Object.keys(input)) {
          if (key !== 'limit') throw new ValidationError(`unexpected input field "${key}"`);
        }
        const limit = input.limit === undefined ? 20 : input.limit;
        if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
          throw new ValidationError('limit must be an integer from 1 to 200');
        }
        return { limit };
      },
      async execute(ctx, { limit }) {
        if (!ctx?.workshop) throw new ExecutionError('WORKSHOP_UNAVAILABLE', 'the workshop is not available in this configuration');
        const page = await ctx.workshop.list({ limit });
        const lines = page.artifacts.map((artifact) => `  ${artifact.artifactId}  ${artifact.title}  (${artifact.domain}, ${artifact.components} component(s))`);
        return show(
          `listed ${page.artifacts.length} workshop artifact(s)`,
          page,
          page.artifacts.length === 0 ? 'No workshop artifacts are stored.' : `Workshop artifacts (${page.artifacts.length} of ${page.total}):\n${lines.join('\n')}`,
        );
      },
      async verify(ctx, input, result) {
        try {
          const fresh = await ctx.workshop.list({ limit: input.limit });
          if (fresh.artifacts.length !== result.data.artifacts.length) {
            return { ok: false, detail: `the log now lists ${fresh.artifacts.length} artifact(s), not ${result.data.artifacts.length}` };
          }
          for (let i = 0; i < fresh.artifacts.length; i += 1) {
            if (fresh.artifacts[i].artifactId !== result.data.artifacts[i].artifactId) {
              return { ok: false, detail: `artifact ${i} is ${fresh.artifacts[i].artifactId} on disk, not ${result.data.artifacts[i].artifactId}` };
            }
          }
          return { ok: true, detail: `${fresh.artifacts.length} artifact(s) confirmed by an independent listing` };
        } catch (err) {
          return { ok: false, detail: `the workshop log could not be re-listed: ${err?.message ?? err}` };
        }
      },
    },
    {
      name: 'workshop.get',
      description: 'Show one stored workshop artifact in full, by id or unambiguous prefix.',
      inputHint: '{"artifactId": "ws-..."}',
      permission: 'read',
      origins: [ORIGIN_USER, ORIGIN_MODEL],
      plannable: false,
      validate(input) {
        if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new ValidationError('input must be an object');
        for (const key of Object.keys(input)) {
          if (key !== 'artifactId') throw new ValidationError(`unexpected input field "${key}"`);
        }
        return { artifactId: artifactRef(input.artifactId) };
      },
      async execute(ctx, input) {
        if (!ctx?.workshop) throw new ExecutionError('WORKSHOP_UNAVAILABLE', 'the workshop is not available in this configuration');
        const found = await ctx.workshop.get(input.artifactId);
        const artifact = requireArtifact(found, input.artifactId);
        return show(
          `showed workshop artifact ${artifact.artifactId}`,
          { artifact },
          `${artifact.artifactId}  ${artifact.title}  (${artifact.domain})\n`
            + `${artifact.components.length} component(s), ${artifact.connections.length} connection(s), budget ${artifact.budget === null ? 'not declared' : artifact.budget.total}.\n`
            + `This is a stored design sheet. Nothing was executed and nothing was authorized.`,
        );
      },
      async verify(ctx, input, result) {
        try {
          const fresh = await ctx.workshop.get(result.data.artifact.artifactId);
          if (!fresh.found) return { ok: false, detail: 'the artifact can no longer be read' };
          if (fresh.artifact.identityDigest !== result.data.artifact.identityDigest) {
            return { ok: false, detail: 'the stored artifact digest changed since it was shown' };
          }
          return { ok: true, detail: `artifact ${fresh.artifact.artifactId} confirmed by an independent read` };
        } catch (err) {
          return { ok: false, detail: `the artifact could not be re-read: ${err?.message ?? err}` };
        }
      },
    },
    {
      name: 'workshop.inspect',
      description: 'Inspect a stored workshop artifact: components grouped by kind, isolated parts, feedback loops, and declared budget. Reads only.',
      inputHint: '{"artifactId": "ws-..."}',
      permission: 'read',
      origins: [ORIGIN_USER, ORIGIN_MODEL],
      plannable: false,
      validate(input) {
        if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new ValidationError('input must be an object');
        for (const key of Object.keys(input)) {
          if (key !== 'artifactId') throw new ValidationError(`unexpected input field "${key}"`);
        }
        return { artifactId: artifactRef(input.artifactId) };
      },
      async execute(ctx, input) {
        if (!ctx?.workshop) throw new ExecutionError('WORKSHOP_UNAVAILABLE', 'the workshop is not available in this configuration');
        const found = await ctx.workshop.inspect(input.artifactId);
        if (!found.found) throw new ExecutionError('WORKSHOP_NOT_FOUND', found.detail ?? `no workshop artifact for ${input.artifactId}`);
        const report = found.report;
        const kinds = report.kinds.map((kind) => `${kind} ${report.byKind[kind]}`).join(', ');
        return show(
          `inspected workshop artifact ${report.artifactId}: ${report.counts.components} component(s) in ${report.counts.kinds} kind(s)`,
          report,
          `${report.artifactId}  ${report.title}  (${report.domain})\n`
            + `components: ${report.counts.components} (${kinds || 'none'})\n`
            + `connections: ${report.counts.connections}; isolated: ${report.counts.isolated}; feedback loops: ${report.counts.cycles}\n`
            + `budget: ${report.budget === null ? 'not declared' : report.budget.total}`,
        );
      },
      async verify(ctx, input, result) {
        try {
          const fresh = await ctx.workshop.inspect(result.data.artifactId);
          if (!fresh.found) return { ok: false, detail: 'the artifact can no longer be inspected' };
          if (!sameReport(fresh.report, result.data)) {
            return { ok: false, detail: 'a fresh inspection of the stored artifact disagrees with the reported one' };
          }
          return { ok: true, detail: `inspection of ${fresh.report.artifactId} confirmed by an independent re-derivation` };
        } catch (err) {
          return { ok: false, detail: `the artifact could not be re-inspected: ${err?.message ?? err}` };
        }
      },
    },
    {
      name: 'workshop.simulate',
      description: 'Simulate a stored workshop artifact: split each declared supply evenly across its outgoing connections and report what each component receives against what it demands, plus budget use. Arithmetic only; nothing is executed.',
      inputHint: '{"artifactId": "ws-..."}',
      permission: 'read',
      origins: [ORIGIN_USER, ORIGIN_MODEL],
      plannable: false,
      validate(input) {
        if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new ValidationError('input must be an object');
        for (const key of Object.keys(input)) {
          if (key !== 'artifactId') throw new ValidationError(`unexpected input field "${key}"`);
        }
        return { artifactId: artifactRef(input.artifactId) };
      },
      async execute(ctx, input) {
        if (!ctx?.workshop) throw new ExecutionError('WORKSHOP_UNAVAILABLE', 'the workshop is not available in this configuration');
        const found = await ctx.workshop.simulate(input.artifactId);
        if (!found.found) throw new ExecutionError('WORKSHOP_NOT_FOUND', found.detail ?? `no workshop artifact for ${input.artifactId}`);
        const report = found.report;
        const lines = report.components.map((component) => `  ${component.id}: receives ${component.inbound}, demands ${component.demand}${component.satisfied ? '' : '  [SHORT]'}`);
        return show(
          `simulated workshop artifact ${report.artifactId}: ${report.status}${report.warnings.length ? ` (${report.warnings.length} warning(s))` : ''}`,
          report,
          `${report.artifactId}: ${report.status}\n${lines.join('\n')}\n`
            + `${report.budget === null ? 'budget: not declared' : `budget: ${report.budget.spent} of ${report.budget.total}${report.budget.overBudget ? '  [OVER]' : ''}`}\n`
            + `${report.warnings.length ? `warnings: ${report.warningsText}` : 'no warnings'}\n`
            + 'This is arithmetic over the declared numbers. Nothing was executed and nothing was authorized.',
        );
      },
      async verify(ctx, input, result) {
        try {
          const fresh = await ctx.workshop.simulate(result.data.artifactId);
          if (!fresh.found) return { ok: false, detail: 'the artifact can no longer be simulated' };
          if (!sameReport(fresh.report, result.data)) {
            return { ok: false, detail: 'a fresh simulation of the stored artifact disagrees with the reported one' };
          }
          return { ok: true, detail: `simulation of ${fresh.report.artifactId} reproduced exactly by an independent run` };
        } catch (err) {
          return { ok: false, detail: `the artifact could not be re-simulated: ${err?.message ?? err}` };
        }
      },
    },
  ];
}
