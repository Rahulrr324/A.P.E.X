// The user's assessment of a task's outcome, tied to the run the records hold.
//
// Execution success and intended outcome are different facts. A verified run says every step
// executed and was independently confirmed; only the user can say whether the result was the one
// they wanted. This action keeps them apart: it refuses unless the task is completed and an audited
// `task.run` operation shows a verified completion, it records the experience of that run if none
// exists, and it records the user's own feedback against it. A successful command is never treated
// as proof of the intended outcome, and nothing here derives or applies a behaviour change: a
// candidate still needs `adaptation.derive` and the user's explicit approval.
import { ValidationError } from '../errors.js';
import { ORIGIN_USER } from './origins.js';
import { shortId, truncate } from '../util.js';
import { Outcome } from '../outcomes.js';
import { StepStatus, TaskStatus } from '../tasks/model.js';
import {
  ASSESSMENTS,
  CAPTURE_EXPLICIT,
  MAX_REASON_CHARS,
  MAX_RULE_CHARS,
  MAX_SUPERSEDES,
} from '../experience/experience-store.js';

function textField(value, name, max, { required = true } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new ValidationError(`${name} is required`);
    return null;
  }
  if (typeof value !== 'string') throw new ValidationError(`${name} must be text`);
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    if (required) throw new ValidationError(`${name} must not be empty`);
    return null;
  }
  if (trimmed.length > max) throw new ValidationError(`${name} must be at most ${max} characters`);
  return trimmed;
}

function refList(value, name) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ValidationError(`${name} must be an array of record ids`);
  if (value.length > MAX_SUPERSEDES) throw new ValidationError(`${name} must hold at most ${MAX_SUPERSEDES} ids`);
  return value.map((entry) => textField(entry, `${name} entry`, 200));
}

// The run this feedback can rest on: the newest recorded run that ended verified with the task
// completed. Later runs that were refused before executing are not used as evidence and do not
// hide the run that established the completion; a later run that executed and failed could not
// leave the task completed, so it is not a case this selection can silently skip.
function verifiedRun(runs, taskId) {
  const run = runs.find((entry) => entry.status === Outcome.SUCCESS_VERIFIED && entry.taskStatus === TaskStatus.COMPLETED);
  if (run) return run;
  const latest = runs[0];
  if (!latest) {
    throw new ValidationError(`task ${shortId(taskId)} is completed, but no audited run record names it; an outcome can only be assessed against a run the records hold`);
  }
  throw new ValidationError(
    `task ${shortId(taskId)} has no run recorded as a verified completion (the most recent is ${latest.status}${latest.taskStatus ? `, leaving the task ${latest.taskStatus}` : ''}); feedback on an outcome needs a run whose every step was verified`,
  );
}

export function taskFeedbackActions() {
  return [
    {
      name: 'task.feedback',
      description: 'Record your own assessment of a completed task\'s outcome, tied to the audited run that verified it. The run\'s evidence and your judgement stay separate records; nothing changes behaviour without a derived candidate and your approval. Write: user origin only.',
      inputHint: '{"taskId":"task id or prefix","assessment":"correct|incorrect|partially_correct|useful|not_useful|user_correction|outcome_succeeded|outcome_failed","guidance":"optional text","reason":"optional text","supersedes":["optional feedback ids this corrects"]}',
      permission: 'write',
      origins: [ORIGIN_USER],
      // A model must never write the user's assessment; the whole path from feedback to a
      // candidate rule depends on that record being the user's own.
      plannable: false,
      validate(input) {
        const o = input ?? {};
        if (typeof o !== 'object' || Array.isArray(o)) throw new ValidationError('input must be an object');
        for (const key of Object.keys(o)) {
          if (!['taskId', 'assessment', 'guidance', 'reason', 'supersedes'].includes(key)) {
            throw new ValidationError(`unexpected field "${key}"`);
          }
        }
        if (typeof o.assessment !== 'string' || !ASSESSMENTS.includes(o.assessment)) {
          throw new ValidationError(`assessment must be one of: ${ASSESSMENTS.join(', ')}`);
        }
        return {
          taskId: textField(o.taskId, 'taskId', 200),
          assessment: o.assessment,
          guidance: textField(o.guidance, 'guidance', MAX_RULE_CHARS, { required: false }),
          reason: textField(o.reason, 'reason', MAX_REASON_CHARS, { required: false }),
          supersedes: refList(o.supersedes, 'supersedes'),
        };
      },
      async execute(ctx, { taskId, assessment, guidance, reason, supersedes }) {
        if (!ctx.taskStore) throw new ValidationError('task feedback needs a task store, and none is configured');
        if (!ctx.experience) throw new ValidationError('task feedback needs the experience store, and none is configured');
        if (!ctx.operations || typeof ctx.operations.findTaskRuns !== 'function') {
          throw new ValidationError('task feedback needs the audit log, and none is configured');
        }

        const task = await ctx.taskStore.resolve(taskId);
        if (task.status !== TaskStatus.COMPLETED) {
          throw new ValidationError(
            `task ${shortId(task.id)} is ${task.status}, not completed; feedback on an outcome needs a task whose run the records show as completed`,
          );
        }
        const unfinished = task.steps.filter((step) => step.status !== StepStatus.COMPLETED);
        if (unfinished.length > 0) {
          throw new ValidationError(
            `task ${shortId(task.id)} is completed, but step ${unfinished[0].id} is recorded ${unfinished[0].status}; an outcome cannot be assessed while a step is not completed`,
          );
        }
        // A step with no operation record, or one whose record is missing, has no independent
        // account of what happened. The task log's own status is not enough on its own.
        const gaps = await ctx.operations.missingTaskStepRecords(task.id, task.steps);
        if (gaps.missing.length > 0) {
          throw new ValidationError(
            `task ${shortId(task.id)} is completed, but ${gaps.missing.length} step record(s) cannot be found in the audit log (${gaps.missing.join(', ')}); the outcome cannot be verified from the records, so no feedback was recorded`,
          );
        }

        const scan = await ctx.operations.findTaskRuns(task.id, { limit: 20 });
        const run = verifiedRun(scan.runs, task.id);

        // Reuse the experience already recorded for this run instead of writing a second account
        // of the same event; `recordExperience` refuses a duplicate by design.
        const view = await ctx.experience.feedbackFor(run.id);
        let experience = view?.experience ?? null;
        let created = false;
        if (!experience) {
          const recorded = await ctx.experience.recordExperience({
            operationId: run.id,
            subject: `task ${shortId(task.id)}: ${truncate(task.goal, 200)}`,
            capture: CAPTURE_EXPLICIT,
            provenance: { operationId: ctx.operationId },
            origin: ctx.origin,
          });
          experience = recorded.record;
          created = true;
        }

        const feedback = await ctx.experience.recordFeedback({
          target: experience.id,
          assessment,
          guidance,
          reason,
          supersedes,
          provenance: { operationId: ctx.operationId },
          origin: ctx.origin,
        });

        const completedSteps = task.steps.filter((step) => step.status === StepStatus.COMPLETED).length;
        const correction = feedback.supersededIds.length > 0
          ? feedback.supersededIds.map(shortId).join(', ')
          : null;
        return {
          summary: `recorded your ${assessment} assessment of task ${shortId(task.id)} against verified run ${shortId(run.id)}`,
          data: {
            task: { id: task.id, shortId: shortId(task.id), goal: truncate(task.goal, 200), status: task.status },
            run: { id: run.id, status: run.status, decision: run.decision, finishedAt: run.finishedAt },
            steps: { completed: completedSteps, total: task.steps.length },
            experience: { id: experience.id, created, operationId: experience.operationId },
            feedback: {
              id: feedback.record.id,
              assessment: feedback.record.assessment,
              guidance: feedback.record.guidance ?? null,
              reason: feedback.record.reason ?? null,
              supersededIds: feedback.supersededIds,
            },
          },
          display: [
            `Recorded your feedback ${shortId(feedback.record.id)} on task ${shortId(task.id)}:`,
            `  task: ${truncate(task.goal, 160)} (${task.status})`,
            `  run: ${shortId(run.id)} is ${run.status}; ${completedSteps}/${task.steps.length} step(s) recorded completed and present in the audit log${run.finishedAt ? `; finished ${String(run.finishedAt).slice(0, 16).replace('T', ' ')} UTC` : ''}`,
            `  assessment: ${assessment}`,
            `  guidance: ${feedback.record.guidance ?? 'none given'}`,
            `  reason: ${feedback.record.reason ?? 'not given'}`,
            created
              ? `  experience: recorded now for this run (${shortId(experience.id)})`
              : `  experience: the existing record for this run (${shortId(experience.id)}) is used; no second account was written`,
            correction ? `  corrects: ${correction} (the earlier feedback stays in the log)` : '  earlier feedback on this experience is unchanged',
            'The verified run is evidence that the steps executed and were confirmed. Your assessment is a separate record of whether the result was the one you wanted.',
            'Nothing changes yet: a behaviour change needs a derived candidate and your explicit approval.',
          ].join('\n'),
        };
      },
      async verify(ctx, input, result) {
        const task = await ctx.taskStore.resolve(input.taskId);
        if (task.id !== result.data.task.id) return { ok: false, detail: 'the task resolved independently differs from the reported one' };
        if (task.status !== TaskStatus.COMPLETED) return { ok: false, detail: 'the task is no longer recorded as completed' };
        if (task.steps.some((step) => step.status !== StepStatus.COMPLETED)) {
          return { ok: false, detail: 'a step is no longer recorded as completed' };
        }
        const gaps = await ctx.operations.missingTaskStepRecords(task.id, task.steps);
        if (gaps.missing.length > 0) return { ok: false, detail: 'a step record is no longer present in the audit log' };

        const scan = await ctx.operations.findTaskRuns(task.id, { limit: 20 });
        const run = scan.runs.find((entry) => entry.id === result.data.run.id);
        if (!run) return { ok: false, detail: 'the cited run is not in an independent read of the audit log' };
        if (run.status !== Outcome.SUCCESS_VERIFIED || run.taskStatus !== TaskStatus.COMPLETED) {
          return { ok: false, detail: 'the cited run is not recorded as a verified completion' };
        }

        const view = await ctx.experience.feedbackFor(result.data.experience.id);
        if (!view) return { ok: false, detail: 'the experience this feedback was recorded on cannot be read back' };
        if (view.experience.operationId !== run.id) return { ok: false, detail: 'the experience does not cite the verified run' };
        if (result.data.experience.created && view.experience.provenance?.origin !== 'user_recorded') {
          return { ok: false, detail: 'the experience recorded for the run does not carry user-recorded provenance' };
        }
        const entry = view.current.find((record) => record.id === result.data.feedback.id);
        if (!entry) return { ok: false, detail: 'the feedback was not found among the current records of that experience' };
        if (entry.assessment !== input.assessment) return { ok: false, detail: 'the stored assessment differs from the request' };
        if ((entry.guidance ?? null) !== (input.guidance ?? null)) return { ok: false, detail: 'the stored guidance differs from the request' };
        if (entry.provenance?.origin !== 'user_feedback' || entry.provenance?.updateMode !== 'user_confirmed') {
          return { ok: false, detail: 'the stored feedback provenance is not the user\'s own' };
        }
        if (entry.operationId !== ctx.operationId) return { ok: false, detail: 'the stored feedback does not name the operation that recorded it' };
        for (const targetId of result.data.feedback.supersededIds) {
          if (!view.history.some((record) => record.id === targetId)) {
            return { ok: false, detail: `corrected feedback ${shortId(targetId)} is no longer readable` };
          }
          if (view.current.some((record) => record.id === targetId)) {
            return { ok: false, detail: `feedback ${shortId(targetId)} is still reported current` };
          }
        }
        return {
          ok: true,
          detail: `task ${shortId(task.id)} is completed, run ${shortId(run.id)} is verified, and your feedback is recorded as the user's own`,
        };
      },
    },
  ];
}