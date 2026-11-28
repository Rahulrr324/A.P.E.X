// The registered capability that runs the T-29 pipeline. Registering it (rather than calling the
// pipeline from a route) is what puts the orchestration under the same registry, ECP, operation
// audit and verifier as every other capability. The action itself is an owner-only write: it may
// create a governed task, and every concrete step inside that task is authorized separately and
// pauses for explicit owner approval when it is a write or an L2+ action.
import { ValidationError } from '../errors.js';
import { compileMission, MissionError } from '../cognition/missions.js';

function intentField(value) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 500) {
    throw new ValidationError('intent must be 1-500 characters');
  }
  return value.trim();
}

function traceText(run) {
  const stage = (name, label, detail) => `${label}: ${detail}`;
  const lines = [];
  const packet = run.stages.context;
  lines.push(stage('context', '1 Context', `${packet.memory.count} memory · ${packet.knowledge.count} knowledge · ${packet.world.count} world facts (${packet.epistemic.observed} observed / ${packet.epistemic.inferred} inferred / ${packet.epistemic.assumed} assumed / ${packet.epistemic.predicted} predicted)`
    // T-32 Step 3: a run that read the machine says so, with the moment it was read.
    + (packet.host && packet.host.available
      ? ` · host: ${packet.host.observations.length} live observation(s), last at ${packet.host.lastObservationAt ?? 'not recorded'}`
      : ' · host: no perception reading')));
  const salience = run.stages.salience;
  lines.push(stage('salience', '2 Salience', `urgency ${salience.urgency} · confidence ${salience.confidence} · uncertainty ${salience.uncertainty} · risk ${salience.risk_sensitivity} · novelty ${salience.novelty}`));
  const council = run.stages.council;
  lines.push(stage('council', '3 Council', council.status === 'ran'
    ? `${council.perspectives?.thesis?.verdict ?? 'no thesis'} / ${council.perspectives?.counter_risk?.verdict ?? 'no counter-risk'} / ${council.perspectives?.evidence_check?.verdict ?? 'no evidence check'} — deliberation data, not a permission`
    : `${council.status}: ${council.reason ?? 'not run'}`));
  const graph = run.stages.task_graph;
  // T-34 Step 1: a compiled mission says which template it came from and what shape it has, so a
  // reader can tell three nodes in a chain from a fan-out with a join.
  lines.push(stage('task_graph', '4 Task graph', `${graph.summary}${graph.mission ? ` · mission ${graph.mission}` : ''}${graph.shape ? ` · fan-out ${graph.shape.fanOut}, join ${(graph.shape.joins ?? []).join(', ') || 'none'}` : ''}`));
  const execution = run.stages.execution;
  lines.push(stage('execution', '5 Execution', `${run.status}${run.verification?.verified ? ' · verified' : ` · ${run.verification?.outcome ?? 'not verified'}`}${run.halted ? ` · halted: ${run.halted.reason}` : ''}`));
  return lines.join('\n');
}

export function cognitionActions(pipeline) {
  if (!pipeline || typeof pipeline.run !== 'function' || typeof pipeline.get !== 'function') {
    throw new TypeError('cognitionActions requires the cognitive pipeline');
  }
  return [
    {
      name: 'cognition.run',
      description: 'Run the unified cognitive pipeline for one owner intent: context packet, salience and Sentinel advisories, Council synthesis, task graph, and governed execution through the ECP. A write or L2+ step pauses as awaiting_approval and executes only after an explicit owner approval. A named mission (mission: "audit_and_stage") is compiled from a fixed template into a multi-node task with a fan-out and a join, and every write node in it is gated the same way. User origin only.',
      inputHint: '{"intent":"what the owner is asking","action":"optional registered capability","input":{},"mission":"optional mission template","artifactId":"required by a mission that names one"}',
      permission: 'write',
      origins: ['user'],
      plannable: false,
      validate(input) {
        if (!input || typeof input !== 'object' || Array.isArray(input)) {
          throw new ValidationError('cognition.run expects an object');
        }
        const allowed = new Set(['intent', 'action', 'input', 'councilRequested', 'mission', 'artifactId']);
        for (const key of Object.keys(input)) {
          if (!allowed.has(key)) throw new ValidationError(`unexpected cognition.run input: ${key}`);
        }
        const intent = intentField(input.intent);
        let action = null;
        if (input.action !== undefined && input.action !== null) {
          if (typeof input.action !== 'string' || input.action.length === 0 || input.action.length > 80) {
            throw new ValidationError('action must be a registered capability name');
          }
          action = input.action;
        }
        let payload = null;
        if (input.input !== undefined && input.input !== null) {
          if (typeof input.input !== 'object' || Array.isArray(input.input)) {
            throw new ValidationError('input must be an object');
          }
          payload = input.input;
        }
        let mission = null;
        if (input.mission !== undefined && input.mission !== null) {
          if (typeof input.mission !== 'string' || input.mission.length === 0 || input.mission.length > 60) {
            throw new ValidationError('mission must name a mission template');
          }
          mission = input.mission;
          // The compiler is the validator: a mission name it does not hold, or one whose required
          // artifact is missing, is a rejected input rather than an execution that failed. The compile
          // is pure and cheap, so validating by compiling states the same rule in one place.
          try {
            compileMission({ mission, artifactId: input.artifactId ?? null });
          } catch (err) {
            if (err instanceof MissionError) throw new ValidationError(err.message, err.code);
            throw err;
          }
          if (action !== null) throw new ValidationError('a mission compiles its own steps, so action cannot also be named');
          if (payload !== null) throw new ValidationError('a mission compiles its own inputs, so input cannot also be named');
        }
        let artifactId = null;
        if (input.artifactId !== undefined && input.artifactId !== null) {
          if (typeof input.artifactId !== 'string' || input.artifactId.trim().length === 0 || input.artifactId.length > 64) {
            throw new ValidationError('artifactId must be a workshop artifact id');
          }
          artifactId = input.artifactId.trim();
          if (mission === null) throw new ValidationError('artifactId is only an input to a mission');
        }
        return { intent, action, input: payload, councilRequested: input.councilRequested === true, mission, artifactId };
      },
      async execute(_ctx, { intent, action, input, councilRequested, mission, artifactId }) {
        const run = await pipeline.run({ intent, action, input, councilRequested, requestedBy: 'owner', mission, artifactId });
        return {
          summary: `cognitive run ${run.runId}: ${run.status}`,
          data: {
            runId: run.runId,
            status: run.status,
            taskId: run.taskId,
            halted: run.halted,
            verification: run.verification,
            approval: run.approval,
            mission: run.mission ?? null,
            // T-37 Step 1: Track 2's contribution, as a sibling of `stages` rather than a stage of it.
            // `null` rather than omitted, so a reader can tell a build without Track 2 from a run that
            // simply did not record one.
            neural: run.neural ?? null,
            stages: run.stages,
          },
          display: traceText(run),
        };
      },
      async verify(_ctx, { intent }, result) {
        const run = await pipeline.get(result?.data?.runId);
        if (!run) return { ok: false, detail: 'the run record is not readable; nothing is claimed' };
        if (run.status === 'halted') {
          return { ok: false, detail: `the run halted fail-closed (${run.halted?.reason ?? 'unknown'}); no step executed` };
        }
        if (run.status === 'awaiting_approval') {
          // T-34 Step 1: a paused mission is a partial run, and saying "nothing has executed yet"
          // about one would be false. The detail names what ran, what waits for the owner and what the
          // records leave blocked behind it.
          const steps = run.task?.steps ?? [];
          const waiting = steps.filter((step) => step.status === 'awaiting_approval').map((step) => step.id);
          const ran = steps.filter((step) => step.status === 'completed').map((step) => step.id);
          const blocked = (run.blocked ?? []).filter((node) => node.blockedBy.length > 0)
            .map((node) => `${node.id} by ${node.blockedBy.join(', ')}`);
          return {
            ok: false,
            detail: `the run is paused awaiting explicit owner approval of ${waiting.join(', ') || 'a step'}; `
              + `${ran.length > 0 ? `${ran.join(', ')} ran and verified` : 'nothing has executed yet'}`
              + `${blocked.length > 0 ? `; blocked: ${blocked.join('; ')}` : ''}`,
          };
        }
        if (run.status === 'completed' && run.verification?.verified === true) {
          return { ok: true, detail: `${run.taskId} completed and every step verified: ${run.verification.detail}` };
        }
        return {
          ok: false,
          detail: `run ${run.runId} is ${run.status}; verification is ${run.verification?.outcome ?? 'unknown'} (${run.verification?.detail ?? 'no detail'}) for intent "${intent.slice(0, 80)}"`,
        };
      },
    },
  ];
}
