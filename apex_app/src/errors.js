// Typed errors. Callers branch on `code`, never on message text.

export class ApexError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ApexError';
    this.code = code;
  }
}

export class ValidationError extends ApexError {
  constructor(message, code = 'INVALID_INPUT') {
    super(code, message);
    this.name = 'ValidationError';
  }
}

export class StoreError extends ApexError {
  constructor(message) {
    super('STORE_UNAVAILABLE', message);
    this.name = 'StoreError';
  }
}

export class ExecutionError extends ApexError {
  constructor(code, message) {
    super(code, message);
    this.name = 'ExecutionError';
  }
}
