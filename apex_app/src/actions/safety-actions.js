// Owner-only ECP controls. These actions run through the same controller, operation audit and
// verifier as other changes. The switch itself is never an action proposed by a model or agent.
import { ValidationError } from '../errors.js';

function reasonField(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 240) {
    throw new ValidationError(`${label} must be 1-240 characters`);
  }
  return value.trim();
}

export function safetyActions(controlPlane) {
  if (!controlPlane || typeof controlPlane.activateKillSwitch !== 'function') {
    throw new TypeError('safetyActions requires the Executive Control Plane');
  }
  return [
    {
      name: 'safety.lockdown',
      description: 'Activate the ECP software kill switch: deny new writes/delegation and request cancellation of cooperative in-flight operations. Read-only inspection remains available. User origin only.',
      inputHint: '{"reason":"why the emergency stop is being activated"}',
      permission: 'write',
      origins: ['user'],
      plannable: false,
      validate(input) {
        if (!input || typeof input !== 'object' || Array.isArray(input)
          || Object.keys(input).some((key) => key !== 'reason')) throw new ValidationError('unexpected safety.lockdown input');
        return { reason: reasonField(input.reason, 'reason') };
      },
      async execute(_ctx, { reason }) {
        const state = controlPlane.activateKillSwitch({ origin: 'user', reason });
        return {
          summary: state.active ? 'ECP kill switch active' : 'ECP kill switch state unavailable',
          data: { active: state.active, policyUnavailable: state.policyUnavailable, reason: state.reason },
          display: [
            state.active ? 'APEX execution lockdown is active.' : 'APEX could not confirm the lockdown state.',
            'New write actions and delegation are refused; read-only inspection remains available.',
            'Cancellable in-flight operations receive an abort signal. Actions that do not cooperate may remain uncertain and are not reported as stopped.',
            `Reason: ${reason}`,
          ].join('\n'),
        };
      },
      async verify(_ctx, { reason }, result) {
        const state = controlPlane.killSwitchStatus();
        if (!state.active) return { ok: false, detail: 'the durable ECP kill-switch latch is not active' };
        if (state.policyUnavailable) return { ok: false, detail: 'kill-switch policy state is unavailable and has failed closed' };
        const last = state.events.at(-1);
        if (last?.event !== 'activated' || last.reason !== reason) return { ok: false, detail: 'the recorded activation does not match this user decision' };
        if (result.data.active !== true) return { ok: false, detail: 'the action result did not report an active latch' };
        return { ok: true, detail: `durable kill-switch latch active at ${state.activatedAt}; the operation remains in the audit log` };
      },
    },
    {
      name: 'safety.release',
      description: 'Clear the ECP software kill switch after an explicit user review. Requires a reason and, when step-up is configured, the step-up proof; this action does not automatically resume tasks or replay work. User origin only.',
      inputHint: '{"reason":"what was reviewed before clearing the emergency stop","stepUp":"the configured step-up secret, only when step-up is configured"}',
      permission: 'write',
      origins: ['user'],
      plannable: false,
      validate(input) {
        if (!input || typeof input !== 'object' || Array.isArray(input)
          || Object.keys(input).some((key) => key !== 'reason' && key !== 'stepUp')) throw new ValidationError('unexpected safety.release input');
        const stepUp = input.stepUp === undefined || input.stepUp === null ? null : input.stepUp;
        if (stepUp !== null && (typeof stepUp !== 'string' || stepUp.length === 0 || stepUp.length > 200)) {
          throw new ValidationError('stepUp must be the configured step-up secret');
        }
        return { reason: reasonField(input.reason, 'reason'), stepUp };
      },
      async execute(_ctx, { reason, stepUp }) {
        // Step-up is checked before the latch is touched: a refused release must leave the latch
        // exactly as it was, still active, with the refusal in the audit log.
        const gate = controlPlane.verifyStepUp(stepUp, { capability: 'safety.release' });
        if (!gate.ok) {
          throw new ValidationError(gate.reason === 'STEP_UP_REQUIRED'
            ? 'step-up is required to release the lockdown and no proof was given'
            : 'the step-up proof did not match; the lockdown remains active');
        }
        const state = controlPlane.clearKillSwitch({ origin: 'user', reason });
        return {
          summary: state.active ? 'ECP kill switch remains active' : 'ECP kill switch cleared by the user',
          data: { active: state.active, policyUnavailable: state.policyUnavailable, reason },
          display: [
            state.active ? 'The ECP kill switch remains active.' : 'The ECP kill switch was cleared by an explicit user decision.',
            'No task was resumed and no action was replayed. Inspect the audit, task and plan state before starting work again.',
            `Review: ${reason}`,
            gate.required ? 'Step-up was verified for this release.' : 'No step-up secret is configured; the reason and confirmation were the gate.',
          ].join('\n'),
        };
      },
      async verify(_ctx, { reason }, result) {
        const state = controlPlane.killSwitchStatus();
        if (state.active || state.policyUnavailable) return { ok: false, detail: 'the ECP kill-switch state is still active or unavailable' };
        const last = state.events.at(-1);
        if (last?.event !== 'cleared' || last.reason !== reason) return { ok: false, detail: 'the recorded clear does not match this user decision' };
        if (result.data.active !== false) return { ok: false, detail: 'the action result did not report a cleared latch' };
        return { ok: true, detail: `kill switch cleared at ${state.events.at(-1)?.at}; no task was resumed` };
      },
    },
  ];
}
