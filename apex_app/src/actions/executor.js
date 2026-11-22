// Executor: validates input and runs the action body. It reports what happened
// and nothing more. It never decides that the outcome is correct; that is the
// verifier's job.
import { ValidationError } from '../errors.js';

export async function executeAction(def, ctx, rawInput) {
  let input;
  try {
    input = def.validate(rawInput);
  } catch (err) {
    if (err instanceof ValidationError) {
      return { status: 'rejected', error: { code: err.code, message: err.message } };
    }
    return { status: 'failed', error: { code: 'VALIDATION_ERROR', message: String(err?.message ?? err) } };
  }
  try {
    const result = await def.execute(ctx, input);
    if (!result || typeof result !== 'object') {
      return { status: 'failed', error: { code: 'EXECUTION_ERROR', message: 'action returned no result object' } };
    }
    return { status: 'ok', input, result };
  } catch (err) {
    // A refusal may carry structured detail (T-39: the expected and actual digests on a drift
    // refusal). It is copied only when it is a plain object, so nothing exotic is propagated.
    const detail = err?.detail && typeof err.detail === 'object' && !Array.isArray(err.detail) ? err.detail : null;
    return {
      status: 'failed',
      error: {
        code: err?.code || 'EXECUTION_ERROR',
        message: String(err?.message ?? err),
        ...(detail ? detail : {}),
      },
    };
  }
}
