// Verifier: a separate component from the executor. It decides whether the
// postcondition of an action actually holds. Four possible answers:
//   SUCCESS_VERIFIED         the verifier confirmed the postcondition
//   VERIFICATION_FAILED      the verifier ran and the postcondition does not hold
//   VERIFICATION_UNAVAILABLE no verifier exists, it returned no decision, or it
//                            could not read its evidence (for example, the store is down)
import { Outcome } from '../outcomes.js';

export class Verifier {
  async check(def, ctx, input, result) {
    if (!def || typeof def.verify !== 'function') {
      return { outcome: Outcome.VERIFICATION_UNAVAILABLE, detail: 'action defines no verification procedure' };
    }
    let decision;
    try {
      decision = await def.verify(ctx, input, result);
    } catch (err) {
      return {
        outcome: Outcome.VERIFICATION_UNAVAILABLE,
        detail: `verification could not be completed: ${err?.code || err?.name || 'error'}: ${err?.message ?? err}`,
      };
    }
    if (!decision || typeof decision.ok !== 'boolean') {
      return { outcome: Outcome.VERIFICATION_UNAVAILABLE, detail: 'verifier produced no decision' };
    }
    return decision.ok
      ? { outcome: Outcome.SUCCESS_VERIFIED, detail: String(decision.detail ?? '') }
      : { outcome: Outcome.VERIFICATION_FAILED, detail: String(decision.detail ?? '') };
  }
}
