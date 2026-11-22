// Typed errors. Callers branch on `code`, never on message text.

export class ApexError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ApexError';
    this.code = code;
    // T-39: structured detail a refusal can carry to the caller. The executor copies it onto the
    // error it reports, so a refusal that names two digests does not lose them on the way out - a
    // caller cannot act on "it drifted" without being told from what to what. Additive: an error with
    // no detail reports none, and no existing consumer reads this field.
    this.detail = null;
  }
}

export class ValidationError extends ApexError {
  constructor(message, code = 'INVALID_INPUT') {
    super(code, message);
    this.name = 'ValidationError';
  }
}

export class StoreError extends ApexError {
  constructor(message, code = 'STORE_UNAVAILABLE') {
    super(code, message);
    this.name = 'StoreError';
  }
}

export class ExecutionError extends ApexError {
  constructor(code, message) {
    super(code, message);
    this.name = 'ExecutionError';
  }
}
