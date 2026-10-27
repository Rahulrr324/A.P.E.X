// Deterministic capability routing for the first version. Requests that match a
// known action pattern are routed to that action. Everything else goes to the
// model path, which is itself subject to the same authorization policy.
// This is a small, explicit table, not a substitute for the controller's
// retrieval, verification, and audit steps.

export function route(request) {
  const r = String(request).trim();
  let m;

  // "remember privately" must be tested first: it is never sent to a model.
  m = /^remember\s+privately\b(?:\s+that)?\s*:?\s*([\s\S]*)$/i.exec(r);
  if (m) return { kind: 'action', capability: 'memory.add', action: 'memory.add', input: { content: m[1], sensitivity: 'private' } };

  m = /^remember\b(?:\s+that)?\s*:?\s*([\s\S]*)$/i.exec(r);
  if (m) return { kind: 'action', capability: 'memory.add', action: 'memory.add', input: { content: m[1] } };

  m = /^(?:recall|search\s+memor(?:y|ies)(?:\s+for)?)\s*:?\s*([\s\S]*)$/i.exec(r);
  if (m) return { kind: 'action', capability: 'memory.search', action: 'memory.search', input: { query: m[1] } };

  m = /^what\s+do\s+you\s+(?:remember|know)\s+about\s+([\s\S]*?)\s*\??$/i.exec(r);
  if (m) return { kind: 'action', capability: 'memory.search', action: 'memory.search', input: { query: m[1] } };

  if (/^(?:list|show)\s+(?:my\s+)?(?:memory|memories)$/i.test(r)) {
    return { kind: 'action', capability: 'memory.list', action: 'memory.list', input: {} };
  }

  if (/^(?:status|who\s+are\s+you|what\s+can\s+you\s+do)\s*\??$/i.test(r)) {
    return { kind: 'action', capability: 'app.status', action: 'app.status', input: {} };
  }

  m = /^(?:calc|calculate|compute)\s*:?\s+([\s\S]+)$/i.exec(r);
  if (m) return { kind: 'action', capability: 'calc.evaluate', action: 'calc.evaluate', input: { expression: m[1] } };

  m = /^what\s+is\s+([0-9+\-*/().\s]*\d[0-9+\-*/().\s]*?)\s*\??$/i.exec(r);
  if (m) return { kind: 'action', capability: 'calc.evaluate', action: 'calc.evaluate', input: { expression: m[1] } };

  return { kind: 'model', capability: 'model.answer', action: null, input: null };
}
