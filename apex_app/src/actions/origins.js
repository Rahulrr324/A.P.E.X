// Request origins. 'user' = typed by the person at the CLI. 'model' = proposed
// by model output, which is untrusted until the policy allows it.
export const ORIGIN_USER = 'user';
export const ORIGIN_MODEL = 'model';
export const ORIGINS_LIST = Object.freeze([ORIGIN_USER, ORIGIN_MODEL]);
