// Request origins. 'user' = typed by the person at the CLI. 'model' = proposed
// by model output, which is untrusted until the policy allows it.
export const ORIGIN_USER = 'user';
export const ORIGIN_MODEL = 'model';
// Agent origin is a future execution identity, not a synonym for model output. A write may declare
// it only with an explicit bounded ECP delegation contract; the current app registers no agent.
export const ORIGIN_AGENT = 'agent';
export const ORIGINS_LIST = Object.freeze([ORIGIN_USER, ORIGIN_MODEL, ORIGIN_AGENT]);
