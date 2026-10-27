// Deterministic arithmetic. No eval, no Function constructor: the model's or
// user's text is only ever tokenized and interpreted by these two functions.
//
//  - evaluateExpression: recursive-descent parser (the executor's method).
//  - evaluateRpn: shunting-yard to RPN, then stack evaluation (the verifier's
//    method). Two independent algorithms, so a bug in one is caught by the other.
import { ExecutionError, ValidationError } from '../errors.js';

const MAX_EXPRESSION_CHARS = 200;
const ALLOWED = /^[0-9+\-*/().\s]+$/;
const NUMBER = /^(?:\d+(?:\.\d+)?|\.\d+)/;
const OPERATORS = '+-*/()';

function syntax(message) {
  return new ValidationError(message, 'INVALID_EXPRESSION');
}

export function tokenize(text) {
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (OPERATORS.includes(ch)) {
      tokens.push(ch);
      i += 1;
      continue;
    }
    const m = NUMBER.exec(text.slice(i));
    if (!m) throw syntax(`unsupported character at position ${i + 1}`);
    tokens.push(m[0]);
    i += m[0].length;
  }
  return tokens;
}

export function validateExpression(text) {
  if (typeof text !== 'string') throw syntax('expression must be text');
  const e = text.trim();
  if (e.length === 0) throw syntax('expression is empty');
  if (e.length > MAX_EXPRESSION_CHARS) throw syntax(`expression exceeds ${MAX_EXPRESSION_CHARS} characters`);
  if (!ALLOWED.test(e) || !/\d/.test(e)) {
    throw syntax('expression may contain only digits, decimal points, spaces, parentheses and + - * /');
  }
  evaluateExpression(e, { syntaxOnly: true });
  return e;
}

export function evaluateExpression(text, { syntaxOnly = false } = {}) {
  const tokens = tokenize(text);
  let p = 0;
  const peek = () => tokens[p];

  function expr() {
    let v = term();
    while (peek() === '+' || peek() === '-') {
      const op = tokens[p];
      p += 1;
      const r = term();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  }

  function term() {
    let v = factor();
    while (peek() === '*' || peek() === '/') {
      const op = tokens[p];
      p += 1;
      const r = factor();
      if (op === '/') {
        if (r === 0 && !syntaxOnly) throw new ExecutionError('DIVISION_BY_ZERO', 'division by zero');
        v /= r;
      } else {
        v *= r;
      }
    }
    return v;
  }

  function factor() {
    const t = peek();
    if (t === '-') {
      p += 1;
      return -factor();
    }
    if (t === '+') {
      p += 1;
      return factor();
    }
    if (t === '(') {
      p += 1;
      const v = expr();
      if (peek() !== ')') throw syntax('missing closing parenthesis');
      p += 1;
      return v;
    }
    if (t !== undefined && NUMBER.test(t)) {
      p += 1;
      return Number(t);
    }
    throw syntax(t === undefined ? 'expression ends unexpectedly' : `unexpected token "${t}"`);
  }

  const value = expr();
  if (p !== tokens.length) throw syntax(`unexpected token "${tokens[p]}"`);
  if (!syntaxOnly && !Number.isFinite(value)) throw new ExecutionError('NON_FINITE', 'result is not a finite number');
  return value;
}

export function evaluateRpn(text) {
  const tokens = tokenize(text);
  const prec = { '+': 1, '-': 1, '*': 2, '/': 2, neg: 3 };
  const output = [];
  const stack = [];
  let expectValue = true;

  for (const t of tokens) {
    if (NUMBER.test(t)) {
      if (!expectValue) throw syntax('two values in a row');
      output.push(Number(t));
      expectValue = false;
    } else if (t === '(') {
      if (!expectValue) throw syntax('unexpected parenthesis');
      stack.push('(');
    } else if (t === ')') {
      if (expectValue) throw syntax('empty parentheses');
      while (stack.length && stack[stack.length - 1] !== '(') output.push(stack.pop());
      if (stack.length === 0) throw syntax('unbalanced parentheses');
      stack.pop();
      expectValue = false;
    } else if (expectValue && (t === '+' || t === '-')) {
      if (t === '-') stack.push('neg');
    } else if (!expectValue) {
      while (stack.length && stack[stack.length - 1] !== '(' && prec[stack[stack.length - 1]] >= prec[t]) {
        output.push(stack.pop());
      }
      stack.push(t);
      expectValue = true;
    } else {
      throw syntax(`unexpected operator "${t}"`);
    }
  }
  if (expectValue) throw syntax('expression ends unexpectedly');
  while (stack.length) {
    const op = stack.pop();
    if (op === '(') throw syntax('unbalanced parentheses');
    output.push(op);
  }

  const st = [];
  for (const item of output) {
    if (typeof item === 'number') {
      st.push(item);
    } else if (item === 'neg') {
      if (st.length < 1) throw syntax('malformed expression');
      st.push(-st.pop());
    } else {
      if (st.length < 2) throw syntax('malformed expression');
      const b = st.pop();
      const a = st.pop();
      if (item === '/') {
        if (b === 0) throw new ExecutionError('DIVISION_BY_ZERO', 'division by zero');
        st.push(a / b);
      } else if (item === '+') st.push(a + b);
      else if (item === '-') st.push(a - b);
      else st.push(a * b);
    }
  }
  if (st.length !== 1) throw syntax('malformed expression');
  return st[0];
}
