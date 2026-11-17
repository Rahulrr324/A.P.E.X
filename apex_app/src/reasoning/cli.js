// CLI surface for T-13. Every command goes through the controller and the audited action registry;
// nothing here starts a model or an inference server.
import { ValidationError } from '../errors.js';

function integer(flags, name, min, max) {
  if (flags[name] === undefined) return null;
  const value = Number(flags[name]);
  if (!Number.isInteger(value) || value < min || value > max) throw new ValidationError(`--${name} must be a whole number from ${min} to ${max}`, 'USAGE');
  return value;
}

export const REASONING_USAGE = [
  'reasoning start <question or objective>',
  'reasoning list [--limit N]',
  'reasoning show|evidence|hypotheses|contradictions|assumptions|unknowns|trace|decision <session-id>',
  'reasoning replay|compare <session-id>',
  'reasoning invalidate <session-id> --reason <text>',
  'reasoning status',
].join('\n');

export async function runReasoningCommand({ app, args, out, err, parseFlags, rejectUnexpected, emit }) {
  if (!app.reasoning) { err('the reasoning workspace is not available in this configuration'); return 1; }
  const [sub, ...rest] = args;
  if (sub === 'status') {
    const { rest: extra } = parseFlags(rest, []);
    rejectUnexpected(extra, 'reasoning status');
    const status = await app.reasoning.status();
    out([
      `Reasoning sessions: ${status.sessions} recorded, ${status.invalidated} invalidated${status.corrupt ? `, ${status.corrupt} corrupt record(s)` : ''}.`,
      `Bound: ${status.maxSessions} sessions; append-only, invalidation never deletes.`,
      'Retrieval is bounded and read-only; no model, inference process, or endpoint is used.',
    ].join('\n'));
    return 0;
  }
  if (sub === 'start' || sub === 'ask' || sub === 'reason') {
    const { rest: words } = parseFlags(rest, []);
    const request = words.join(' ').trim();
    if (!request) { err('usage: reasoning start <question or objective>'); return 2; }
    return emit(await app.controller.reasoningStart({ request }));
  }
  if (sub === 'list') {
    const { flags, rest: extra } = parseFlags(rest, ['limit']);
    rejectUnexpected(extra, 'reasoning list [--limit N]');
    const limit = integer(flags, 'limit', 1, 200) ?? 20;
    return emit(await app.controller.reasoningList({ limit }));
  }
  if (['show', 'evidence', 'hypotheses', 'contradictions', 'assumptions', 'unknowns', 'trace', 'decision', 'replay', 'compare'].includes(sub)) {
    const { rest: ids } = parseFlags(rest, []);
    if (ids.length !== 1) { err(`usage: reasoning ${sub} <session-id>`); return 2; }
    const session = ids[0];
    const method = {
      show: 'reasoningShow', evidence: 'reasoningEvidence', hypotheses: 'reasoningHypotheses',
      contradictions: 'reasoningContradictions', assumptions: 'reasoningAssumptions',
      unknowns: 'reasoningUnknowns', trace: 'reasoningTrace', decision: 'reasoningDecision',
      replay: 'reasoningReplay', compare: 'reasoningCompare',
    }[sub];
    return emit(await app.controller[method]({ session }));
  }
  if (sub === 'invalidate') {
    const { flags, rest: ids } = parseFlags(rest, ['reason']);
    if (ids.length !== 1 || !flags.reason) { err('usage: reasoning invalidate <session-id> --reason <text>'); return 2; }
    return emit(await app.controller.reasoningInvalidate({ session: ids[0], reason: flags.reason }));
  }
  err(`usage:\n${REASONING_USAGE}`);
  return 2;
}
