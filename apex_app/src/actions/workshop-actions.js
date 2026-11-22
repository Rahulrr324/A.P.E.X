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
import { WorkshopApplier, MIN_CHANGESET_FILES, MAX_CHANGESET_FILES } from '../workshop/applier.js';

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
  // The applier shares the sandbox's inspector, so the containment an apply obeys is the same one the
  // inspection obeys. It is constructed per call rather than cached, because a cached instance would
  // keep writing to whatever directory the first request happened to configure.
  const requireApplier = (ctx) => {
    if (ctx?.workshopApplier) return ctx.workshopApplier;
    const sandbox = requireSandbox(ctx);
    if (!sandbox?.dataDir) {
      throw new ExecutionError('WORKSHOP_SANDBOX_UNAVAILABLE', 'the workshop sandbox has no data directory, so changes cannot be recorded');
    }
    return new WorkshopApplier({ dataDir: sandbox.dataDir, sandbox, now: () => sandbox.now?.() ?? new Date() });
  };

  return [
    {
      name: 'workshop.check_applied',
      description: 'Re-measure every applied workspace change against the file on disk right now, and classify each one: intact (still the bytes the apply wrote, so a rollback is safe), modified_externally (edited outside APEX since the apply, with both digests reported, so an automatic rollback would refuse rather than discard the edit), reverted_externally (already put back by hand, so there is nothing to roll back), or deleted_externally. Read-only: it opens each file for reading inside the configured root and writes nothing, repairs nothing, and authorizes nothing.',
      inputHint: '{}',
      permission: 'read',
      origins: [ORIGIN_USER, ORIGIN_MODEL],
      plannable: false,
      validate(input) {
        if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new ValidationError('input must be an object');
        for (const key of Object.keys(input)) throw new ValidationError(`unexpected input field "${key}"`);
        return {};
      },
      async execute(ctx) {
        const applier = requireApplier(ctx);
        const live = applier.liveStatus();
        return show(
          live.available
            ? `checked ${live.open} applied change(s): ${live.counts.intact} intact, ${live.counts.modified_externally} modified, ${live.counts.reverted_externally} reverted, ${live.counts.deleted_externally} deleted`
            : 'no workspace root is configured, so no applied change can be measured against a disk',
          {
            ...live,
            // The counts are summed here rather than left to a reader, because a screen that adds up
            // four numbers for itself can add them up wrongly.
            summary: {
              open: live.open,
              intact: live.counts.intact,
              modifiedExternally: live.counts.modified_externally,
              revertedExternally: live.counts.reverted_externally,
              deletedExternally: live.counts.deleted_externally,
            },
            checkedAt: live.at,
          },
          live.available
            ? [
              `Measured ${live.open} applied change(s) against the disk at ${live.at}.`,
              ...live.states.slice(0, 20).map((entry) => `  ${entry.state.padEnd(19)} ${entry.relativePath}`),
              live.allIntact ? 'Every open change still holds what was applied.' : 'At least one open change does not, so a batch rollback would refuse.',
            ].join('\n')
            : 'No workspace root is configured; there is nothing to measure.',
        );
      },
      async verify(ctx, _input, result) {
        try {
          // An independent second read. Two reads of the same disk that disagree would mean the disk
          // changed between them, and saying so is more useful than reporting the first answer twice.
          const again = requireApplier(ctx).liveStatus();
          if (again.open !== result.data.open) {
            return { ok: false, detail: `the second read found ${again.open} open change(s) where the first found ${result.data.open}` };
          }
          return { ok: true, detail: `re-read ${again.open} applied change(s) from disk; both reads agree` };
        } catch (err) {
          return { ok: false, detail: `the disk status could not be re-read: ${err?.message ?? err}` };
        }
      },
    },
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
      inputHint: '{"relativePath": "src/thing.js", "proposedContent": "text", "rationale": "why", "testContent": "optional node:test source"}',
      permission: 'write',
      origins: [ORIGIN_USER],
      plannable: false,
      validate(input) {
        if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new ValidationError('input must be an object');
        for (const key of Object.keys(input)) {
          if (!['relativePath', 'proposedContent', 'rationale', 'testContent'].includes(key)) throw new ValidationError(`unexpected input field "${key}"`);
        }
        const relativePath = textInput(input.relativePath, 'relativePath', { max: 512 });
        if (typeof input.proposedContent !== 'string') throw new ValidationError('proposedContent must be text');
        const rationale = input.rationale === undefined || input.rationale === null ? null : textInput(input.rationale, 'rationale', { max: 2000 });
        // T-41 Step 2: an optional companion test. It is bounded here as well as in the sandbox so a
        // request that is too large is refused before it reaches the staging write.
        let testContent = null;
        if (input.testContent !== undefined && input.testContent !== null) {
          if (typeof input.testContent !== 'string') throw new ValidationError('testContent must be text');
          if (Buffer.byteLength(input.testContent, 'utf8') > 256 * 1024) throw new ValidationError('testContent exceeds 262144 bytes');
          if (input.testContent.trim().length === 0) throw new ValidationError('testContent must not be empty');
          testContent = input.testContent;
        }
        return { relativePath, proposedContent: input.proposedContent, rationale, testContent };
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
            // T-41: staging with a companion test is not verification. The flag says a test travelled
            // with the candidate; `verified` stays false until `workshop.verify_file` runs it.
            hasSandboxTest: typeof record.testPath === 'string',
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
      description: 'Verify a staged file by running the real parser against the staged bytes in the sandbox: node --check for .js/.mjs/.cjs, strict JSON.parse for .json. When the candidate carried a companion test, the real test runner executes it inside the sandbox with a fixed argument vector and a 5000 ms timeout, and its exit code, pass/fail counts and output excerpt are recorded as sandboxTestResult. A failed assertion, a non-zero exit, or a change to the live workspace measured across the run makes verified false. Records the staged and base SHA-256 digests and the diff. verified is true only when every check passed.',
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
            + (verification.sandboxTestResult
              ? `\n\nnode --test exited ${verification.sandboxTestResult.exitCode} in ${verification.sandboxTestResult.durationMs} ms: `
                + `${verification.sandboxTestResult.passedCount} passed, ${verification.sandboxTestResult.failedCount} failed`
                + (verification.sandboxTestResult.timedOut ? ' (timed out)' : '')
                + `\n${verification.sandboxTestResult.outputExcerpt}`
              : '\n\nNo companion test was staged, so behaviour was not exercised; only parsing was measured.')
            + '\nThe file was parsed and its test, when one was staged, ran in the sandbox. '
            + 'The live workspace was not written and nothing was authorized.',
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

    {
      name: 'workshop.apply_file',
      description: 'Apply a staged, verified candidate to the live workspace: the first and only action in APEX that writes into the owner\'s real workspace tree. Refuses unless the newest sandbox verification passed and its digest still matches the staged bytes; refuses a path that resolves outside the configured root; refuses when the file on disk no longer hashes to the base the candidate was staged against, reporting both digests. Saves the previous bytes under a content-addressed backup before writing, writes atomically through a sibling temporary file, and re-reads the file from disk to prove the result before reporting success.',
      inputHint: '{"candidateId": "wsc-...", "reason": "why this file may be written", "stepUp": "the configured step-up secret, only when step-up is configured"}',
      permission: 'write',
      origins: [ORIGIN_USER],
      plannable: false,
      validate(input) {
        if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new ValidationError('input must be an object');
        for (const key of Object.keys(input)) {
          if (!['candidateId', 'reason', 'stepUp'].includes(key)) throw new ValidationError(`unexpected input field "${key}"`);
        }
        const candidateId = textInput(input.candidateId, 'candidateId', { max: 64 });
        if (!/^wsc-[0-9a-f]{12}$/.test(candidateId)) throw new ValidationError('candidateId must look like wsc-<12 hex characters>');
        const stepUp = input.stepUp === undefined || input.stepUp === null ? null : input.stepUp;
        if (stepUp !== null && (typeof stepUp !== 'string' || stepUp.length === 0 || stepUp.length > 200)) {
          throw new ValidationError('stepUp must be the configured step-up secret');
        }
        return { candidateId, reason: reasonField(input.reason, { required: true }), stepUp };
      },
      async execute(ctx, input) {
        // Writing into the owner's tree takes the step-up when one is configured, exactly as approving
        // an evolution promotion does. Lockdown and model-origin refusals happened in the ECP already.
        const controlPlane = ctx.registry?.controlPlane;
        if (controlPlane && typeof controlPlane.verifyStepUp === 'function') {
          const gate = controlPlane.verifyStepUp(input.stepUp, { capability: 'workshop.apply_file' });
          if (!gate.ok) {
            throw new ValidationError(gate.reason === 'STEP_UP_REQUIRED'
              ? 'step-up is required to write a file into the workspace and no proof was given'
              : 'the step-up proof did not match; nothing was written');
          }
        }
        const applier = requireApplier(ctx);
        const applied = applier.apply({ candidateId: input.candidateId });
        return show(
          `applied ${applied.relativePath} to the workspace as ${applied.applyId}`,
          {
            ...applied,
            verificationId: applied.verificationId ?? null,
            reason: input.reason,
            // The three claims a caller must be able to assert: it happened, it was proved, and it
            // amended a real file rather than a copy.
            appliedToWorkspace: true,
            verifiedOnDisk: applied.diskSha256 === applied.appliedSha256,
            mutatesLiveWorkspace: true,
            authorizesExecution: false,
          },
          [
            `${applied.relativePath} applied to the workspace.`,
            `Disk SHA-256 ${applied.appliedSha256}, read back from the file and compared with the candidate.`,
            applied.beforeSha256
              ? `The bytes it replaced (${applied.beforeSha256}) are saved as backup ${applied.backupId}, so this can be rolled back.`
              : 'The file did not exist before, so a rollback removes it.',
            'The change is recorded in the Workshop ledger and can be rolled back.',
          ].join('\n'),
        );
      },
      async verify(ctx, input, result) {
        try {
          const applier = requireApplier(ctx);
          const record = applier.applyRecord(result.data.applyId);
          if (!record) return { ok: false, detail: 'the apply cannot be read back from the ledger' };
          if (record.appliedSha256 !== result.data.appliedSha256) return { ok: false, detail: 'the ledger holds a different digest than the one reported' };
          const resolved = applier.inspector.resolve(record.relativePath);
          if (!resolved.ok) return { ok: false, detail: `the written path can no longer be resolved: ${resolved.detail}` };
          const disk = createHash('sha256').update(fs.readFileSync(resolved.realPath)).digest('hex');
          if (disk !== record.appliedSha256) return { ok: false, detail: 'the file on disk no longer matches the digest the apply recorded' };
          const backupFile = join(record.backupDir, `before-${record.beforeSha256 ?? 'none'}.bin`);
          if (record.existedBefore === true && !fs.existsSync(backupFile)) {
            return { ok: false, detail: 'the rollback snapshot cannot be found' };
          }
          return { ok: true, detail: `the ledger, the file on disk and the backup agree on ${record.appliedSha256}` };
        } catch (err) {
          return { ok: false, detail: `the apply could not be re-read: ${err?.message ?? err}` };
        }
      },
    },
    {
      name: 'workshop.apply_changeset',
      description: 'Apply 2 to 8 verified candidates to the live workspace as ONE all-or-nothing change. Pre-flights every file before writing anything - ledger capacity, duplicate target paths, a passing verification per candidate whose digest still matches the staged bytes, realpath containment, and the base digest on disk - and refuses the entire changeset with CHANGESET_PREFLIGHT_REFUSED naming the offending candidate if any single file fails. Then snapshots every file, writes them all atomically, and reads each one back from disk; if any write or read-back fails, every file already written is restored before the failure is reported. Records one changeset in the ledger and the causal trace.',
      inputHint: '{"candidateIds": ["wsc-...", "wsc-..."], "title": "what this change is", "rationale": "why it may be written", "stepUp": "the configured step-up secret, only when step-up is configured"}',
      permission: 'write',
      origins: [ORIGIN_USER],
      plannable: false,
      validate(input) {
        if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new ValidationError('input must be an object');
        for (const key of Object.keys(input)) {
          if (!['candidateIds', 'title', 'rationale', 'stepUp'].includes(key)) throw new ValidationError(`unexpected input field "${key}"`);
        }
        if (!Array.isArray(input.candidateIds)) throw new ValidationError('candidateIds must be an array');
        if (input.candidateIds.length < MIN_CHANGESET_FILES) {
          throw new ValidationError(`a changeset needs at least ${MIN_CHANGESET_FILES} candidates`);
        }
        if (input.candidateIds.length > MAX_CHANGESET_FILES) {
          throw new ValidationError(`a changeset holds at most ${MAX_CHANGESET_FILES} candidates`);
        }
        const candidateIds = input.candidateIds.map((value, index) => {
          const id = textInput(value, `candidateIds[${index}]`, { max: 64 });
          if (!/^wsc-[0-9a-f]{12}$/.test(id)) throw new ValidationError(`candidateIds[${index}] must look like wsc-<12 hex characters>`);
          return id;
        });
        const title = textInput(input.title, 'title', { max: 160 });
        const stepUp = input.stepUp === undefined || input.stepUp === null ? null : input.stepUp;
        if (stepUp !== null && (typeof stepUp !== 'string' || stepUp.length === 0 || stepUp.length > 200)) {
          throw new ValidationError('stepUp must be the configured step-up secret');
        }
        return { candidateIds, title, rationale: reasonField(input.rationale, { required: true }), stepUp };
      },
      async execute(ctx, input) {
        const controlPlane = ctx.registry?.controlPlane;
        if (controlPlane && typeof controlPlane.verifyStepUp === 'function') {
          const gate = controlPlane.verifyStepUp(input.stepUp, { capability: 'workshop.apply_changeset' });
          if (!gate.ok) {
            throw new ValidationError(gate.reason === 'STEP_UP_REQUIRED'
              ? 'step-up is required to write a changeset into the workspace and no proof was given'
              : 'the step-up proof did not match; nothing was written');
          }
        }
        const changeset = requireApplier(ctx).applyChangeset({
          candidateIds: input.candidateIds,
          title: input.title,
          rationale: input.rationale,
        });
        return show(
          `applied a ${changeset.fileCount}-file changeset ${changeset.changesetId} to the workspace`,
          { ...changeset, rationale: input.rationale },
          [
            `${changeset.fileCount} files applied atomically as ${changeset.changesetId}.`,
            ...changeset.files.map((file) => `  ${file.relativePath}  ${String(file.appliedSha256).slice(0, 12)}`),
            'Every file was read back from disk and compared with its candidate; a change that fails that check is undone whole.',
            `The bytes these replaced are saved under ${changeset.changesetId}, so the whole changeset can be rolled back.`,
          ].join('\n'),
        );
      },
      async verify(ctx, _input, result) {
        try {
          const applier = requireApplier(ctx);
          const record = applier.changesetRecord(result.data.changesetId);
          if (!record) return { ok: false, detail: 'the changeset cannot be read back from the ledger' };
          if (record.files.length !== result.data.fileCount) return { ok: false, detail: 'the ledger holds a different number of files than were reported' };
          // Every file is re-read from disk, not from the record.
          for (const file of record.files) {
            let target;
            try {
              target = applier.inspector.resolve(file.relativePath);
            } catch (err) {
              return { ok: false, detail: `${file.relativePath} cannot be resolved: ${err?.message ?? err}` };
            }
            if (!target.ok) return { ok: false, detail: `${file.relativePath} is no longer inside the root` };
            const disk = createHash('sha256').update(fs.readFileSync(target.realPath)).digest('hex');
            if (disk !== file.appliedSha256) return { ok: false, detail: `${file.relativePath} no longer matches the digest the changeset recorded` };
          }
          return { ok: true, detail: `re-read all ${record.files.length} files from disk; each matches its applied digest` };
        } catch (err) {
          return { ok: false, detail: `the changeset could not be re-read: ${err?.message ?? err}` };
        }
      },
    },
    {
      name: 'workshop.rollback_changeset',
      description: 'Roll back a whole applied changeset, or none of it. Pre-flights every file first and refuses with CHANGESET_ROLLBACK_DRIFT if any one of them was edited outside APEX after the apply, restoring nothing in that case. When every file still holds what the changeset wrote, restores all of them to their exact pre-apply bytes atomically and verifies each one on disk before reporting success. Records the batch rollback in the ledger and the causal trace.',
      inputHint: '{"changesetId": "wcs-...", "reason": "why this is being undone", "stepUp": "the configured step-up secret, only when step-up is configured"}',
      permission: 'write',
      origins: [ORIGIN_USER],
      plannable: false,
      validate(input) {
        if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new ValidationError('input must be an object');
        for (const key of Object.keys(input)) {
          if (!['changesetId', 'reason', 'stepUp'].includes(key)) throw new ValidationError(`unexpected input field "${key}"`);
        }
        const changesetId = textInput(input.changesetId, 'changesetId', { max: 64 });
        if (!/^wcs-[0-9a-f]{12}$/.test(changesetId)) throw new ValidationError('changesetId must look like wcs-<12 hex characters>');
        const stepUp = input.stepUp === undefined || input.stepUp === null ? null : input.stepUp;
        if (stepUp !== null && (typeof stepUp !== 'string' || stepUp.length === 0 || stepUp.length > 200)) {
          throw new ValidationError('stepUp must be the configured step-up secret');
        }
        return { changesetId, reason: reasonField(input.reason, { required: true }), stepUp };
      },
      async execute(ctx, input) {
        const controlPlane = ctx.registry?.controlPlane;
        if (controlPlane && typeof controlPlane.verifyStepUp === 'function') {
          const gate = controlPlane.verifyStepUp(input.stepUp, { capability: 'workshop.rollback_changeset' });
          if (!gate.ok) {
            throw new ValidationError(gate.reason === 'STEP_UP_REQUIRED'
              ? 'step-up is required to roll back a changeset and no proof was given'
              : 'the step-up proof did not match; no file was restored');
          }
        }
        const rolledBack = requireApplier(ctx).rollbackChangeset({ changesetId: input.changesetId, reason: input.reason });
        return show(
          `rolled back the ${rolledBack.fileCount}-file changeset ${rolledBack.changesetId}`,
          { ...rolledBack, reason: input.reason },
          [
            `${rolledBack.fileCount} files restored atomically, every one verified against its pre-apply digest.`,
            ...rolledBack.files.map((file) => `  ${file.relativePath}  ${file.existedBefore ? `restored ${String(file.restoredSha256).slice(0, 12)}` : 'created by the changeset, removed'}`),
            'The rollback is recorded in the Workshop ledger and in the causal trace.',
          ].join('\n'),
        );
      },
      async verify(ctx, _input, result) {
        try {
          const applier = requireApplier(ctx);
          const rollback = applier.records().find((entry) => entry.kind === 'changeset_rollback' && entry.changesetId === result.data.changesetId);
          if (!rollback) return { ok: false, detail: 'the changeset rollback cannot be read back from the ledger' };
          for (const file of rollback.files) {
            const resolved = applier.inspector.resolve(file.relativePath);
            if (file.existedBefore === false) {
              if (resolved.ok) return { ok: false, detail: `${file.relativePath} was created by the changeset and should now be absent` };
              continue;
            }
            if (!resolved.ok) return { ok: false, detail: `${file.relativePath} cannot be resolved after the rollback` };
            const disk = createHash('sha256').update(fs.readFileSync(resolved.realPath)).digest('hex');
            if (disk !== file.restoredSha256) return { ok: false, detail: `${file.relativePath} no longer holds the pre-apply bytes` };
          }
          return { ok: true, detail: `re-read all ${rollback.files.length} files; each holds the bytes it had before the changeset` };
        } catch (err) {
          return { ok: false, detail: `the changeset rollback could not be re-read: ${err?.message ?? err}` };
        }
      },
    },
    {
      name: 'workshop.rollback_file',
      description: 'Roll back an applied change: restore the exact bytes the apply replaced, or remove a file the apply created. The bytes come from the apply\'s own ledger record and its content-addressed backup, never from the request. Refuses when the file on disk no longer hashes to what the apply wrote, because a rollback would then destroy an edit made after it. Restores atomically and re-reads the file to prove the pre-apply digest before reporting success.',
      inputHint: '{"applyId": "wsa-...", "reason": "why this is being undone", "stepUp": "the configured step-up secret, only when step-up is configured"}',
      permission: 'write',
      origins: [ORIGIN_USER],
      plannable: false,
      validate(input) {
        if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new ValidationError('input must be an object');
        for (const key of Object.keys(input)) {
          if (!['applyId', 'reason', 'stepUp'].includes(key)) throw new ValidationError(`unexpected input field "${key}"`);
        }
        const applyId = textInput(input.applyId, 'applyId', { max: 64 });
        if (!/^wsa-[0-9a-f]{12}$/.test(applyId)) throw new ValidationError('applyId must look like wsa-<12 hex characters>');
        const stepUp = input.stepUp === undefined || input.stepUp === null ? null : input.stepUp;
        if (stepUp !== null && (typeof stepUp !== 'string' || stepUp.length === 0 || stepUp.length > 200)) {
          throw new ValidationError('stepUp must be the configured step-up secret');
        }
        return { applyId, reason: reasonField(input.reason, { required: true }), stepUp };
      },
      async execute(ctx, input) {
        const controlPlane = ctx.registry?.controlPlane;
        if (controlPlane && typeof controlPlane.verifyStepUp === 'function') {
          const gate = controlPlane.verifyStepUp(input.stepUp, { capability: 'workshop.rollback_file' });
          if (!gate.ok) {
            throw new ValidationError(gate.reason === 'STEP_UP_REQUIRED'
              ? 'step-up is required to roll back a workspace change and no proof was given'
              : 'the step-up proof did not match; the file is unchanged');
          }
        }
        const rolledBack = requireApplier(ctx).rollback({ applyId: input.applyId, reason: input.reason });
        return show(
          rolledBack.removedFile
            ? `removed ${rolledBack.relativePath}, which ${rolledBack.applyId} created`
            : `restored ${rolledBack.relativePath} to the bytes ${rolledBack.applyId} replaced`,
          { ...rolledBack, reason: input.reason, mutatesLiveWorkspace: true, authorizesExecution: false },
          [
            rolledBack.removedFile
              ? `${rolledBack.relativePath} was created by the apply and has been removed.`
              : `${rolledBack.relativePath} restored to SHA-256 ${rolledBack.restoredSha256}, read back from the file.`,
            rolledBack.removedFile
              ? 'Its absence was confirmed after removal.'
              : `That is the digest the apply recorded before it wrote; the restore is byte-identical.`,
            'The rollback is recorded in the Workshop ledger and in the causal trace.',
          ].join('\n'),
        );
      },
      async verify(ctx, input, result) {
        try {
          const applier = requireApplier(ctx);
          const records = applier.records();
          const rollback = records.find((entry) => entry.kind === 'rollback' && entry.applyId === result.data.applyId);
          if (!rollback) return { ok: false, detail: 'the rollback cannot be read back from the ledger' };
          const resolved = applier.inspector.resolve(rollback.relativePath);
          if (rollback.existedBefore === false) {
            const exists = resolved.ok;
            return exists
              ? { ok: false, detail: 'the file the rollback removed is present again' }
              : { ok: true, detail: 'the ledger records the removal and the file is absent' };
          }
          if (!resolved.ok) return { ok: false, detail: `the restored path cannot be resolved: ${resolved.detail}` };
          const disk = createHash('sha256').update(fs.readFileSync(resolved.realPath)).digest('hex');
          if (disk !== rollback.restoredSha256) return { ok: false, detail: 'the restored file no longer matches the pre-apply digest' };
          return { ok: true, detail: `the restored file hashes to ${rollback.restoredSha256}, the digest recorded before the apply` };
        } catch (err) {
          return { ok: false, detail: `the rollback could not be re-read: ${err?.message ?? err}` };
        }
      },
    },
  ];
}
