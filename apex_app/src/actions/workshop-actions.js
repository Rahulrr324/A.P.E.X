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
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { join } from 'node:path';
import { MAX_EXCERPT_LINES, MAX_INSPECT_ENTRIES } from '../workshop/sandbox.js';

function show(summary, data, display) {
  return { summary, data, display: display ?? summary };
}

function artifactRef(value) {
  return textInput(value, 'artifact id', { max: 64 });
}

// T-33 Step 3: a reason is the owner's own words for a promotion. It is optional for a
// verification (the check is the evidence) and required for a promotion (the decision is the act).
function reasonField(value, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new ValidationError('a reason is required');
    return null;
  }
  if (typeof value !== 'string') throw new ValidationError('reason must be text');
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    if (required) throw new ValidationError('a reason is required');
    return null;
  }
  if (trimmed.length > 240) throw new ValidationError('reason must be at most 240 characters');
  return trimmed;
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
    {
      name: 'workshop.verify',
      description: 'Run the deterministic sandbox verification over a stored workshop artifact: structure, resolved connections, isolation, feedback loops, supply against demand and the declared budget. Records the result in the workshop verification ledger. Nothing is executed; a failed verification is recorded as a failure, not as an absent record.',
      inputHint: '{"artifactId": "ws-...", "reason": optional text}',
      permission: 'write',
      origins: [ORIGIN_USER],
      plannable: false,
      validate(input) {
        if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new ValidationError('input must be an object');
        for (const key of Object.keys(input)) {
          if (key !== 'artifactId' && key !== 'reason') throw new ValidationError(`unexpected input field "${key}"`);
        }
        return { artifactId: artifactRef(input.artifactId), reason: reasonField(input.reason) };
      },
      async execute(ctx, input) {
        if (!ctx?.workshop) throw new ExecutionError('WORKSHOP_UNAVAILABLE', 'the workshop is not available in this configuration');
        const result = await ctx.workshop.verify(input.artifactId);
        if (!result.found) throw new ExecutionError('WORKSHOP_NOT_FOUND', result.detail ?? `no workshop artifact for ${input.artifactId}`);
        const verification = result.verification;
        const failed = verification.checks.filter((check) => check.passed !== true);
        return show(
          `verified workshop artifact ${verification.artifactId}: ${verification.verified ? 'all checks passed' : `${failed.length} check(s) failed`}`,
          {
            artifactId: verification.artifactId,
            identityDigest: verification.identityDigest,
            verificationId: verification.id,
            verified: verification.verified,
            passed: verification.passed,
            failed: verification.failed,
            checks: verification.checks,
            metrics: verification.metrics,
            at: verification.at,
            authorizesExecution: false,
            executedCode: false,
          },
          `${verification.artifactId}  ${verification.verified ? 'VERIFIED' : 'NOT VERIFIED'}\n`
            + verification.checks.map((check) => `  ${check.passed ? 'pass' : 'FAIL'}  ${check.id} — ${check.detail}`).join('\n')
            + '\nThe checks are arithmetic and structure over the stored sheet. Nothing was executed and nothing was authorized.',
        );
      },
      async verify(ctx, _input, result) {
        try {
          const state = await ctx.workshop.verificationState(result.data.artifactId);
          if (!state.verification) return { ok: false, detail: 'the verification cannot be read back from the ledger' };
          if (state.verification.id !== result.data.verificationId) {
            return { ok: false, detail: 'the ledger holds a different verification than the one reported' };
          }
          if (state.verification.verified !== result.data.verified) {
            return { ok: false, detail: 'the ledger disagrees with the reported outcome' };
          }
          return { ok: true, detail: `verification ${state.verification.id} confirmed by an independent read of the ledger` };
        } catch (err) {
          return { ok: false, detail: `the verification ledger could not be re-read: ${err?.message ?? err}` };
        }
      },
    },
    {
      name: 'workshop.promote',
      description: 'Promote a stored workshop artifact after its newest recorded sandbox verification passed. Refuses when no verification exists, when the newest one failed, or when it was recorded against different content. Records the promotion with the owner\'s reason and writes one memory-timeline entry. It applies nothing and executes nothing.',
      inputHint: '{"artifactId": "ws-...", "reason": "why this design is accepted"}',
      permission: 'write',
      origins: [ORIGIN_USER],
      plannable: false,
      validate(input) {
        if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new ValidationError('input must be an object');
        for (const key of Object.keys(input)) {
          if (key !== 'artifactId' && key !== 'reason') throw new ValidationError(`unexpected input field "${key}"`);
        }
        return { artifactId: artifactRef(input.artifactId), reason: reasonField(input.reason, { required: true }) };
      },
      async execute(ctx, input) {
        if (!ctx?.workshop) throw new ExecutionError('WORKSHOP_UNAVAILABLE', 'the workshop is not available in this configuration');
        const result = await ctx.workshop.promote(input.artifactId, { reason: input.reason });
        if (!result.found) throw new ExecutionError('WORKSHOP_NOT_FOUND', result.detail ?? `no workshop artifact for ${input.artifactId}`);
        if (result.promoted !== true) {
          // A refusal is an outcome, not a crash: the reason code says which gate held.
          throw new ExecutionError(
            result.reasonCode ?? 'PROMOTION_REFUSED',
            result.detail ?? 'the promotion was refused',
          );
        }
        const promotion = result.promotion;
        // The timeline entry is the visible consequence of accepting the design. It is a record about
        // the design, never a belief that the design is true.
        let memoryId = null;
        try {
          const record = await ctx.memory.add({
            content: `workshop artifact ${promotion.artifactId} promoted after sandbox verification ${promotion.verificationId}`,
            // The memory store accepts two kinds; a promotion is the owner's own act, so it is
            // recorded as the owner's fact about it rather than as a model conclusion.
            kind: 'user_fact',
            source: 'user',
            provenance: { context: `workshop.promote ${promotion.artifactId}` },
          });
          memoryId = record?.id ?? null;
        } catch {
          // A memory write that fails does not undo the promotion; the promotion record is the
          // authority and the summary says the timeline entry is missing.
        }
        return show(
          `promoted workshop artifact ${promotion.artifactId} on verification ${promotion.verificationId}${memoryId ? '' : ' (the memory timeline entry could not be written)'}`,
          {
            artifactId: promotion.artifactId,
            promotionId: promotion.id,
            verificationId: promotion.verificationId,
            verified: true,
            reason: promotion.reason,
            memoryId,
            at: promotion.at,
            appliesNothing: true,
            authorizesExecution: false,
            executedCode: false,
          },
          `${promotion.artifactId} promoted.\n`
            + `Verification ${promotion.verificationId} passed; the promotion is recorded with your reason.\n`
            + `${memoryId ? 'One memory-timeline entry was written.' : 'The memory-timeline entry could not be written.'} Nothing was applied or executed.`,
        );
      },
      async verify(ctx, input, result) {
        try {
          const state = await ctx.workshop.verificationState(result.data.artifactId);
          if (!state.promotion) return { ok: false, detail: 'the promotion is not in the ledger' };
          if (state.promotion.id !== result.data.promotionId) {
            return { ok: false, detail: 'the ledger holds a different promotion than the one reported' };
          }
          if (state.promotion.verificationId !== result.data.verificationId) {
            return { ok: false, detail: 'the promotion cites a different verification than the one reported' };
          }
          if (state.verified !== true) return { ok: false, detail: 'the verification behind the promotion does not read as passed' };
          return { ok: true, detail: `promotion ${state.promotion.id} confirmed against verification ${state.promotion.verificationId}` };
        } catch (err) {
          return { ok: false, detail: `the promotion could not be re-read: ${err?.message ?? err}` };
        }
      },
    },
    ...fileBackedActions(),
  ];
}

// T-38 Step 2 (2026-11-21): the file-backed Workshop. These four capabilities read the configured
// workspace tree and stage candidates in an isolated sandbox under the APEX data directory. Two rules
// run through all of them:
//
//   - the live workspace tree is opened for reading and never for writing, so `workshop.stage_file`
//     writes only under `<dataDir>/workshop-sandbox/<candidateId>/`;
//   - `verified` is a measurement, not a claim. `workshop.verify_file` runs the real parser against the
//     staged bytes and records its exit code and stderr, and a syntax error makes `verified` false.
function fileBackedActions() {
  const requireSandbox = (ctx) => {
    if (!ctx?.workshopSandbox) {
      throw new ExecutionError('WORKSHOP_SANDBOX_UNAVAILABLE', 'the workshop sandbox is not available in this configuration');
    }
    return ctx.workshopSandbox;
  };

  return [
    {
      name: 'workspace.inspect',
      description: 'List the files and directories of the configured target workspace, with byte size, line count and SHA-256 content digest for each text file. Skips .git, node_modules and build trees, and reports a binary file as binary rather than reading it. Every path is resolved with realpath and refused if it escapes the root. Read-only: nothing is written and nothing is executed.',
      inputHint: '{"maxEntries": 1-400}',
      permission: 'read',
      origins: [ORIGIN_USER, ORIGIN_MODEL],
      plannable: false,
      validate(input) {
        if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new ValidationError('input must be an object');
        for (const key of Object.keys(input)) {
          if (key !== 'maxEntries') throw new ValidationError(`unexpected input field "${key}"`);
        }
        if (input.maxEntries === undefined) return { maxEntries: MAX_INSPECT_ENTRIES };
        if (!Number.isInteger(input.maxEntries) || input.maxEntries < 1 || input.maxEntries > MAX_INSPECT_ENTRIES) {
          throw new ValidationError(`maxEntries must be an integer from 1 to ${MAX_INSPECT_ENTRIES}`);
        }
        return { maxEntries: input.maxEntries };
      },
      async execute(ctx, input) {
        const sandbox = requireSandbox(ctx);
        const listing = sandbox.inspector.list({ maxEntries: input.maxEntries });
        const files = listing.entries.filter((entry) => entry.kind === 'file');
        return show(
          `inspected the workspace: ${files.length} text file(s), ${listing.entries.filter((e) => e.kind === 'directory').length} director(ies)`,
          {
            root: listing.root,
            entries: listing.entries,
            total: listing.total,
            truncated: listing.truncated,
            authorizesExecution: false,
          },
          `Workspace ${listing.root}\n`
            + listing.entries.slice(0, 40).map((entry) => `  ${entry.kind === 'directory' ? 'dir ' : entry.kind === 'binary' ? 'bin ' : 'file'}  ${entry.path}`).join('\n')
            + (listing.truncated ? '\n(the listing was capped)' : ''),
        );
      },
      async verify(ctx, _input, result) {
        try {
          const again = requireSandbox(ctx).inspector.list({ maxEntries: result.data.total || MAX_INSPECT_ENTRIES });
          if (again.entries.length !== result.data.entries.length) {
            return { ok: false, detail: 'a second read of the tree found a different number of entries' };
          }
          return { ok: true, detail: `the tree was read back: ${again.entries.length} entries` };
        } catch (err) {
          return { ok: false, detail: `the workspace could not be re-read: ${err?.message ?? err}` };
        }
      },
    },
    {
      name: 'workspace.read_file',
      description: 'Read a bounded, line-numbered excerpt of one text file inside the configured workspace, with its SHA-256 digest. The path is canonicalized with realpath and refused if it escapes the root, is absolute, or contains a traversal component. Read-only.',
      inputHint: '{"path": "relative/path.js", "startLine": 1, "lines": 1-200}',
      permission: 'read',
      origins: [ORIGIN_USER, ORIGIN_MODEL],
      plannable: false,
      validate(input) {
        if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new ValidationError('input must be an object');
        for (const key of Object.keys(input)) {
          if (!['path', 'startLine', 'lines'].includes(key)) throw new ValidationError(`unexpected input field "${key}"`);
        }
        const filePath = textInput(input.path, 'path', { max: 512 });
        const startLine = input.startLine === undefined ? 1 : input.startLine;
        const lines = input.lines === undefined ? 80 : input.lines;
        if (!Number.isInteger(startLine) || startLine < 1) throw new ValidationError('startLine must be a positive integer');
        if (!Number.isInteger(lines) || lines < 1 || lines > MAX_EXCERPT_LINES) {
          throw new ValidationError(`lines must be an integer from 1 to ${MAX_EXCERPT_LINES}`);
        }
        return { path: filePath, startLine, lines };
      },
      async execute(ctx, input) {
        const sandbox = requireSandbox(ctx);
        const excerpt = sandbox.inspector.read(input.path, { startLine: input.startLine, lines: input.lines });
        return show(
          `read ${excerpt.path}: lines ${excerpt.startLine}-${excerpt.startLine + excerpt.lines - 1} of ${excerpt.totalLines}`,
          excerpt,
          excerpt.excerpt,
        );
      },
      async verify(ctx, input, result) {
        try {
          const again = requireSandbox(ctx).inspector.read(input.path, { startLine: input.startLine, lines: input.lines });
          if (again.digest !== result.data.digest) {
            return { ok: false, detail: 'the file changed between the read and the re-read' };
          }
          return { ok: true, detail: `digest ${again.digest.slice(0, 16)} confirmed by a second read` };
        } catch (err) {
          return { ok: false, detail: `the file could not be re-read: ${err?.message ?? err}` };
        }
      },
    },
    {
      name: 'workshop.stage_file',
      description: 'Stage a proposed new or modified file into an isolated sandbox under the APEX data directory, recording its SHA-256 digest, a line diff against the current workspace file when one exists, and the rationale. The live workspace tree is never written to. A staged file is not verified; verifying it is a separate, measured step.',
      inputHint: '{"relativePath": "src/thing.js", "proposedContent": "text", "rationale": "why"}',
      permission: 'write',
      origins: [ORIGIN_USER],
      plannable: false,
      validate(input) {
        if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new ValidationError('input must be an object');
        for (const key of Object.keys(input)) {
          if (!['relativePath', 'proposedContent', 'rationale'].includes(key)) throw new ValidationError(`unexpected input field "${key}"`);
        }
        const relativePath = textInput(input.relativePath, 'relativePath', { max: 512 });
        if (typeof input.proposedContent !== 'string') throw new ValidationError('proposedContent must be text');
        const rationale = input.rationale === undefined || input.rationale === null ? null : textInput(input.rationale, 'rationale', { max: 2000 });
        return { relativePath, proposedContent: input.proposedContent, rationale };
      },
      async execute(ctx, input) {
        const sandbox = requireSandbox(ctx);
        const record = sandbox.stage(input);
        return show(
          `staged ${record.relativePath} as ${record.candidateId}: ${record.bytes} byte(s), ${record.lines} line(s), digest ${record.digest.slice(0, 16)}`,
          {
            candidateId: record.candidateId,
            relativePath: record.relativePath,
            bytes: record.bytes,
            lines: record.lines,
            digest: record.digest,
            base: record.base,
            diff: record.diff,
            verified: false,
            sandboxDir: record.sandboxDir,
            mutatesLiveWorkspace: false,
            authorizesExecution: false,
          },
          `Staged ${record.relativePath} in the sandbox.\n`
            + `  ${record.bytes} byte(s), ${record.lines} line(s), sha256 ${record.digest}\n`
            + `  base: ${record.base.exists ? record.base.path + ' (sha256 ' + String(record.base.digest).slice(0, 16) + ')' : 'no such file in the workspace'}\n`
            + `  diff: +${record.diff.addedLines} -${record.diff.removedLines}\n`
            + 'Nothing was verified and the live workspace was not written.',
        );
      },
      async verify(ctx, _input, result) {
        try {
          const record = requireSandbox(ctx).load(result.data.candidateId);
          if (!record) return { ok: false, detail: 'the staged candidate cannot be read back' };
          if (record.digest !== result.data.digest) return { ok: false, detail: 'the staged record holds a different digest' };
          return { ok: true, detail: `candidate ${record.candidateId} confirmed in the sandbox` };
        } catch (err) {
          return { ok: false, detail: `the candidate could not be re-read: ${err?.message ?? err}` };
        }
      },
    },
    {
      name: 'workshop.verify_file',
      description: 'Verify a staged file by running the real parser against the staged bytes in the sandbox: node --check for .js/.mjs/.cjs, strict JSON.parse for .json. Records the exact exit code and stderr, the staged and base SHA-256 digests, and the diff. verified is true only when every check passed; a syntax error makes it false and keeps the parser message.',
      inputHint: '{"candidateId": "wsc-..."}',
      permission: 'write',
      origins: [ORIGIN_USER],
      plannable: false,
      validate(input) {
        if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new ValidationError('input must be an object');
        for (const key of Object.keys(input)) {
          if (key !== 'candidateId') throw new ValidationError(`unexpected input field "${key}"`);
        }
        const candidateId = textInput(input.candidateId, 'candidateId', { max: 64 });
        if (!/^wsc-[0-9a-f]{12}$/.test(candidateId)) throw new ValidationError('candidateId must look like wsc-<12 hex characters>');
        return { candidateId };
      },
      async execute(ctx, input) {
        const sandbox = requireSandbox(ctx);
        const result = sandbox.verify(input.candidateId);
        if (!result.found) throw new ExecutionError('WORKSHOP_NOT_FOUND', result.detail ?? `no staged candidate ${input.candidateId}`);
        const verification = result.verification;
        const failed = verification.checks.filter((check) => check.passed !== true);
        return show(
          `verified staged file ${verification.relativePath}: ${verification.verified ? 'all checks passed' : `${failed.length} check(s) failed`}`,
          verification,
          `${verification.relativePath}  ${verification.verified ? 'VERIFIED' : 'NOT VERIFIED'}\n`
            + verification.checks.map((check) => `  ${check.passed ? 'pass' : 'FAIL'}  ${check.id} — ${check.detail}`).join('\n')
            + (verification.parser.ran ? `\n\n${verification.parser.kind} exited ${verification.parser.exitCode} as ${verification.parser.moduleKind}` : '')
            + (verification.parser.stderr ? `\n${verification.parser.stderr}` : '')
            + '\nThe file was parsed in the sandbox. The live workspace was not written and nothing was authorized.',
        );
      },
      async verify(ctx, input, result) {
        try {
          const recorded = requireSandbox(ctx).latestVerification(input.candidateId);
          if (!recorded) return { ok: false, detail: 'the verification cannot be read back from the sandbox' };
          if (recorded.id !== result.data.id) return { ok: false, detail: 'the sandbox holds a different verification than the one reported' };
          if (recorded.verified !== result.data.verified) return { ok: false, detail: 'the sandbox disagrees with the reported outcome' };
          return { ok: true, detail: `verification ${recorded.id} confirmed by an independent read of the sandbox` };
        } catch (err) {
          return { ok: false, detail: `the verification could not be re-read: ${err?.message ?? err}` };
        }
      },
    },
    {
      name: 'workshop.promote_file',
      description: 'Promote a staged file after its newest sandbox verification passed. Refuses when no verification exists, when the newest one failed, or when the sandbox digest has changed since that verification. Records the promotion with the owner\'s reason. It applies nothing: the live workspace is not written and the candidate is not copied anywhere.',
      inputHint: '{"candidateId": "wsc-...", "reason": "why this candidate is accepted"}',
      permission: 'write',
      origins: [ORIGIN_USER],
      plannable: false,
      validate(input) {
        if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new ValidationError('input must be an object');
        for (const key of Object.keys(input)) {
          if (!['candidateId', 'reason'].includes(key)) throw new ValidationError(`unexpected input field "${key}"`);
        }
        const candidateId = textInput(input.candidateId, 'candidateId', { max: 64 });
        if (!/^wsc-[0-9a-f]{12}$/.test(candidateId)) throw new ValidationError('candidateId must look like wsc-<12 hex characters>');
        return { candidateId, reason: reasonField(input.reason, { required: true }) };
      },
      async execute(ctx, input) {
        const sandbox = requireSandbox(ctx);
        const record = sandbox.load(input.candidateId);
        if (!record) throw new ExecutionError('WORKSHOP_NOT_FOUND', `no staged candidate ${input.candidateId}`);
        const verification = sandbox.latestVerification(input.candidateId);
        if (!verification) {
          throw new ExecutionError('PROMOTION_REFUSED', 'the candidate has not been verified in the sandbox');
        }
        if (verification.verified !== true) {
          throw new ExecutionError('PROMOTION_REFUSED', `the newest verification failed: ${verification.failed.join(', ') || 'unknown check'}`);
        }
        if (verification.stagedDigest !== record.digest) {
          throw new ExecutionError('PROMOTION_REFUSED', 'the sandbox holds different bytes than the verification recorded');
        }
        const promotion = {
          schema: 'apex.workshop.file-promotion/1',
          kind: 'file_promotion',
          id: `wsp-${createHash('sha256').update(`${input.candidateId}:${verification.id}:${sandbox.now().toISOString()}`).digest('hex').slice(0, 12)}`,
          candidateId: input.candidateId,
          relativePath: record.relativePath,
          verificationId: verification.id,
          digest: record.digest,
          reason: input.reason,
          at: sandbox.now().toISOString(),
          appliesNothing: true,
          mutatesLiveWorkspace: false,
          authorizesExecution: false,
        };
        fs.writeFileSync(join(record.sandboxDir, 'promotion.json'), `${JSON.stringify(promotion, null, 2)}\n`, 'utf8');
        return show(
          `promoted staged file ${record.relativePath} on verification ${verification.id}`,
          {
            candidateId: promotion.candidateId,
            relativePath: promotion.relativePath,
            promotionId: promotion.id,
            verificationId: promotion.verificationId,
            digest: promotion.digest,
            verified: true,
            reason: promotion.reason,
            appliesNothing: true,
            mutatesLiveWorkspace: false,
            authorizesExecution: false,
          },
          `${record.relativePath} promoted on verification ${verification.id}.\n`
            + 'The promotion is a record. The live workspace was not written and nothing was applied.',
        );
      },
      async verify(ctx, input, result) {
        try {
          const verification = requireSandbox(ctx).latestVerification(input.candidateId);
          if (!verification) return { ok: false, detail: 'the verification behind the promotion cannot be read back' };
          if (verification.id !== result.data.verificationId) return { ok: false, detail: 'the sandbox cites a different verification' };
          if (verification.verified !== true) return { ok: false, detail: 'the verification behind the promotion does not read as passed' };
          return { ok: true, detail: `promotion confirmed against verification ${verification.id}` };
        } catch (err) {
          return { ok: false, detail: `the promotion could not be re-read: ${err?.message ?? err}` };
        }
      },
    },
  ];
}
